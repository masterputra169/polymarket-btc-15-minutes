/**
 * Fallback verifier — closes the loop on settlements decided by price_fallback.
 *
 * At expiry the market switch aborts the oracle retries, so the bot books the
 * result from "Chainlink spot vs price-to-beat". Polymarket resolves on a 60s
 * TWAP, and on a razor-thin gap the two disagree (2026-09-08: the Railway
 * PREMARKET row booked +6.87 for a market that resolved DOWN, and nothing ever
 * corrected the row, the bankroll or the win counter).
 *
 * This module re-checks each price_fallback row against the real resolution
 * (CLOB oracle, then Gamma), on a backoff after settlement and in a sweep at
 * startup, and rewrites the journal row when they differ. Dry-run rows also get
 * their bankroll and win/loss counters corrected; live rows leave the bankroll
 * to the on-chain reconciler and refresh the Postgres mirror instead.
 */

import { createLogger } from '../logger.ts';
import { readJournalRows, rewriteJournalRow } from './tradeJournal.ts';
import { correctSettlement } from './positionTracker.ts';
import { fetchResolvedOutcome } from '../engines/marketResolution.ts';
import { computeSettlementPnl, isProvisionalSource } from '../engines/settlementMath.ts';
import { notify } from '../monitoring/notifier.ts';
import { mirrorTradeJournalRecord } from '../services/runtimeIntegrations.ts';

const log = createLogger('FallbackVerify');

/** Oracle usually closes 1-2 min after expiry; ~47 min of retries covers a slow UMA round. */
const RETRY_DELAYS_MS = [90_000, 180_000, 360_000, 720_000, 1_500_000];
const DEFAULT_SWEEP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

type Resolution = { outcome: 'UP' | 'DOWN'; source: string };
type JournalRow = Record<string, any>;
type VerifyStatus = 'missing' | 'pending' | 'confirmed' | 'corrected';
type Applied = { status: 'confirmed' | 'corrected'; row: JournalRow; delta: number; wasWin: boolean; nowWin: boolean };

const inFlight = new Map<string, ReturnType<typeof setTimeout> | null>();

/** A regular WIN/LOSS row booked from a provisional source that has not been verified yet. */
function isUnverifiedFallbackRow(row: JournalRow | null | undefined): boolean {
  if (!row?.exit || !isProvisionalSource(row.exit.source) || row.exit.verifiedAt) return false;
  const outcome = row.analysis?.outcome;
  if (outcome !== 'WIN' && outcome !== 'LOSS') return false;
  const side = row.entry?.side;
  return side === 'UP' || side === 'DOWN';
}

/**
 * Pure: apply a real resolution to a journal row. Returns a new row (never
 * mutates the input) plus the P&L delta and the win/loss transition.
 */
export function applyResolution(row: JournalRow, resolved: Resolution, nowMs: number = Date.now()): Applied {
  const wasWin = row.analysis.outcome === 'WIN';
  const nowWin = row.entry.side === resolved.outcome;
  const stamp = { verifiedOutcome: resolved.outcome, verifiedSource: resolved.source, verifiedAt: nowMs };

  if (wasWin === nowWin) {
    return { status: 'confirmed', delta: 0, wasWin, nowWin, row: { ...row, exit: { ...row.exit, ...stamp } } };
  }

  const oldPnl = Number(row.analysis.pnl) || 0;
  const pnl = computeSettlementPnl({ won: nowWin, size: row.entry.size, cost: row.entry.cost, price: row.entry.tokenPrice });
  const analysis: JournalRow = {
    ...row.analysis,
    outcome: nowWin ? 'WIN' : 'LOSS',
    pnl,
    actualOutcome: resolved.outcome,
    edgeWasReal: nowWin,
  };
  if (row.entry.mlSide) analysis.mlWasRight = row.entry.mlSide === resolved.outcome;
  if (row.entry.ruleUp != null) analysis.ruleWasRight = (row.entry.ruleUp >= 0.5 ? 'UP' : 'DOWN') === resolved.outcome;

  const exit = {
    ...row.exit,
    ...stamp,
    outcome: resolved.outcome,
    correctedFrom: { outcome: row.analysis.outcome, pnl: oldPnl },
  };
  const delta = Math.round((pnl - oldPnl) * 100) / 100;
  return { status: 'corrected', delta, wasWin, nowWin, row: { ...row, exit, analysis } };
}

function describeCorrection(marketSlug: string, applied: Applied, resolved: Resolution): string {
  const { row, delta } = applied;
  const pnlStr = (v: number) => `${v >= 0 ? '+' : '-'}$${Math.abs(v).toFixed(2)}`;
  return [
    `🔁 <b>Settlement corrected</b>${row.entry?.dryRun ? ' [DRY]' : ''}`,
    `Booked <b>${row.exit.correctedFrom.outcome}</b> (${pnlStr(row.exit.correctedFrom.pnl)}) from price_fallback,`,
    `Polymarket resolved <b>${resolved.outcome}</b> (${resolved.source}) → <b>${row.analysis.outcome}</b> ${pnlStr(row.analysis.pnl)}`,
    `Bankroll delta: <b>${pnlStr(delta)}</b>`,
    `<a href="https://polymarket.com/event/${encodeURIComponent(marketSlug)}">View Market</a>`,
  ].join('\n');
}

/**
 * Verify one settlement. Finds the latest unverified price_fallback row for
 * the slug, asks the oracle, and rewrites the row when it has resolved.
 */
export async function verifyFallbackSettlement(
  { marketSlug, conditionId }: { marketSlug: string; conditionId?: string | null },
  nowMs: number = Date.now(),
): Promise<VerifyStatus> {
  const rows = readJournalRows();
  const row = [...rows].reverse().find(r => r?.entry?.marketSlug === marketSlug && isUnverifiedFallbackRow(r));
  if (!row) return 'missing';

  const resolved = await fetchResolvedOutcome({ conditionId: conditionId ?? row.entry.conditionId ?? null, marketSlug });
  if (!resolved) return 'pending';

  const applied = applyResolution(row, resolved, nowMs);
  // The match re-checks `verifiedAt` on the fresh read: if another verification
  // (startup sweep vs. scheduled retry) stamped this row meanwhile, nothing is
  // written and — crucially — nothing below touches the bankroll twice.
  const written = rewriteJournalRow(
    r => r?._ts === row._ts && r?.entry?.marketSlug === marketSlug && !r?.exit?.verifiedAt,
    () => applied.row,
  );
  if (!written) {
    log.warn(`Journal row for ${marketSlug} could not be rewritten (already verified, or write failed) — will retry`);
    return 'pending';
  }

  const isDryRun = row.entry.dryRun === true;
  if (!isDryRun) {
    // Keep the Postgres copy in step with the stamped/corrected local row.
    mirrorTradeJournalRecord(applied.row).catch(e => log.debug(`Mirror of verified row skipped: ${e.message}`));
  }

  if (applied.status === 'confirmed') {
    log.info(`${row.exit.source} confirmed by ${resolved.source}: ${marketSlug} → ${resolved.outcome}`);
    return 'confirmed';
  }

  log.warn(
    `${row.exit.source} WRONG for ${marketSlug}: booked ${applied.row.exit.correctedFrom.outcome} ` +
    `(${applied.row.exit.correctedFrom.pnl}), ${resolved.source} says ${resolved.outcome} → ` +
    `${applied.row.analysis.outcome} (${applied.row.analysis.pnl}), delta ${applied.delta}`,
  );
  // Counters (wins/losses/consecutiveLosses) feed the circuit breakers in both
  // modes. The bankroll moves only for dry-run rows: live money is reconciled
  // from on-chain USDC by journalReconciler.
  correctSettlement({
    delta: applied.delta, wasWin: applied.wasWin, nowWin: applied.nowWin,
    slug: marketSlug, reason: `fallback_verified:${resolved.source}`,
    adjustBankroll: isDryRun,
    settledAtMs: row.exit?.exitedAt ?? row._ts ?? null, // so a stale correction does not read as today's loss
  });
  notify('warn', describeCorrection(marketSlug, applied, resolved), { key: `fallback-corrected:${marketSlug}` })
    .catch(e => log.debug(`Notify correction: ${e.message}`));
  return 'corrected';
}

/**
 * Re-check a fresh price_fallback settlement on a backoff until the market
 * resolves. One schedule per market; a second call while in flight is a no-op.
 */
export function scheduleFallbackVerification({ marketSlug, conditionId }: { marketSlug: string; conditionId?: string | null }): void {
  if (!marketSlug || inFlight.has(marketSlug)) return;
  inFlight.set(marketSlug, null);

  const attempt = (i: number) => {
    const timer = setTimeout(async () => {
      let status: VerifyStatus = 'pending';
      try {
        status = await verifyFallbackSettlement({ marketSlug, conditionId });
      } catch (err) {
        log.warn(`Verification attempt ${i + 1} for ${marketSlug} failed: ${err.message}`);
      }
      if (status !== 'pending') { inFlight.delete(marketSlug); return; }
      if (i + 1 < RETRY_DELAYS_MS.length) { attempt(i + 1); return; }
      inFlight.delete(marketSlug);
      log.warn(`Gave up verifying ${marketSlug} after ${RETRY_DELAYS_MS.length} attempts — still unresolved; the startup sweep will retry`);
      notify('warn', `⚠️ Could not verify price_fallback settlement for ${marketSlug} — market still unresolved after ~47 min`,
        { key: `fallback-unverified:${marketSlug}` }).catch(e => log.debug(`Notify unverified: ${e.message}`));
    }, RETRY_DELAYS_MS[i]);
    (timer as any).unref?.();
    inFlight.set(marketSlug, timer);
  };
  attempt(0);
}

/**
 * Startup sweep: verify every unverified price_fallback row from the last
 * `maxAgeMs`. Sequential, so a long journal does not hammer the APIs.
 */
export async function verifyPendingFallbacks(
  { now = Date.now(), maxAgeMs = DEFAULT_SWEEP_MAX_AGE_MS }: { now?: number; maxAgeMs?: number } = {},
): Promise<{ checked: number; confirmed: number; corrected: number; pending: number }> {
  const candidates = readJournalRows().filter(r =>
    isUnverifiedFallbackRow(r) && (now - (r._ts ?? 0)) <= maxAgeMs && !inFlight.has(r.entry?.marketSlug));
  const summary = { checked: 0, confirmed: 0, corrected: 0, pending: 0 };
  for (const row of candidates) {
    summary.checked++;
    let status: VerifyStatus = 'pending';
    try {
      status = await verifyFallbackSettlement({ marketSlug: row.entry.marketSlug, conditionId: row.entry.conditionId ?? null }, now);
    } catch (err) {
      log.warn(`Sweep: ${row.entry.marketSlug} failed: ${err.message}`);
    }
    if (status === 'confirmed') summary.confirmed++;
    else if (status === 'corrected') summary.corrected++;
    else summary.pending++;
  }
  if (summary.checked > 0) {
    log.info(`Fallback sweep: ${summary.checked} checked, ${summary.confirmed} confirmed, ${summary.corrected} corrected, ${summary.pending} still pending`);
  }
  return summary;
}

/** Test hook: clear schedules between tests. */
export function _resetForTest(): void {
  for (const timer of inFlight.values()) if (timer) clearTimeout(timer);
  inFlight.clear();
}
