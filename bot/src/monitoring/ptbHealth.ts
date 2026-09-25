/**
 * PTB source health — durable record of how often the price-to-beat is usable.
 *
 * Why this exists: the PTB-source gate (tradeFilters filter 1c) blocks entries
 * outright with no ML or edge override, by design. That makes it the one filter
 * that can silently end an observation period: if the exact source degrades from
 * ~1.5% of polls to 30%, the dry run collects nothing and the only symptom is a
 * report full of zeros, days later. Nothing durable recorded the source before
 * this (feature_capture.jsonl has `ptb` but not its source, and has not been
 * written since 2026-05-14), so "why zero trades?" meant grepping container logs
 * that vanish on restart.
 *
 * Design: count in memory, append one rollup line per flush interval. At ~4
 * polls/sec a per-poll write would be 350k lines/day; one line per minute is
 * 1,440 and answers the same question.
 *
 * "Exact" used to mean "the source is on the exact list" — and that list held
 * the scheduled SPOT capture, which matched Polymarket's price to beat in 0 of
 * 130 markets while this file reported 99.5% exact. Since 2026-09-25 each line
 * also carries `verified`: for every market that closed in the window, the PTB
 * the bot used compared with Gamma's eventMetadata.priceToBeat (recorded by
 * recordPtbVerification). That is the number to trust.
 */

import { appendFileSync, existsSync, mkdirSync, statSync, renameSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { envNum } from '../utils/env.ts';
import { EXACT_PTB_SOURCES as EXACT_LIST } from '../engines/ptbSources.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Redirectable so tests never append to the production data file.
const HEALTH_PATH = process.env.PTB_HEALTH_PATH
  ? resolve(process.env.PTB_HEALTH_PATH)
  : resolve(__dirname, '..', '..', 'data', 'ptb_health.jsonl');
const DATA_DIR = dirname(HEALTH_PATH);

/** Sources the entry gate accepts — the single list in engines/ptbSources.ts. */
export const EXACT_PTB_SOURCES: readonly string[] = EXACT_LIST;

const FLUSH_MS = envNum(process.env.PTB_HEALTH_FLUSH_MS, 60_000, 1_000, 3_600_000);
const MAX_BYTES = envNum(process.env.PTB_HEALTH_MAX_BYTES, 5_000_000, 100_000, 100_000_000);

let counts: Record<string, number> = {};
let verified = freshVerified();

interface Verified { checked: number; exact: number; mismatch: number; maxAbsDiff: number; bySource: Record<string, { checked: number; exact: number }> }

function freshVerified(): Verified {
  return { checked: 0, exact: 0, mismatch: 0, maxAbsDiff: 0, bySource: {} };
}

/**
 * One closed market: the PTB the bot used against Polymarket's published one.
 * Returns the absolute difference. Never throws.
 */
export function recordPtbVerification(used: number | null, usedSource: string | null, official: number): number | null {
  if (!Number.isFinite(official) || used == null || !Number.isFinite(used)) return null;
  const diff = Math.abs(used - official);
  const exact = diff < 1e-6;
  verified.checked++;
  if (exact) verified.exact++; else verified.mismatch++;
  verified.maxAbsDiff = Math.max(verified.maxAbsDiff, diff);
  const key = usedSource || 'missing';
  const b = verified.bySource[key] ?? (verified.bySource[key] = { checked: 0, exact: 0 });
  b.checked++;
  if (exact) b.exact++;
  return diff;
}
let windowStart = Date.now();
let lastFlush = Date.now();

/**
 * Record the PTB source seen on one filter evaluation.
 * Safe to call on every poll — it only touches an in-memory counter until the
 * flush interval elapses, and never throws into the trading path.
 */
export function recordPtbSource(source: string | null | undefined): void {
  const key = source || 'missing';
  counts[key] = (counts[key] || 0) + 1;
  if (Date.now() - lastFlush >= FLUSH_MS) flush();
}

/** Append the current window as one line and start a new window. */
export function flush(): void {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total === 0 && verified.checked === 0) { lastFlush = Date.now(); return; }

  const exact = Object.entries(counts)
    .filter(([src]) => EXACT_PTB_SOURCES.includes(src))
    .reduce((a, [, n]) => a + n, 0);

  const line = {
    from: windowStart,
    to: Date.now(),
    total,
    exact,
    exactPct: total ? Number(((exact / total) * 100).toFixed(2)) : null,
    bySource: counts,
    ...(verified.checked ? { verified: { ...verified, maxAbsDiff: Number(verified.maxAbsDiff.toFixed(2)) } } : {}),
  };

  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    // Rotate before the file grows without bound (same policy as state_audit).
    if (existsSync(HEALTH_PATH) && statSync(HEALTH_PATH).size > MAX_BYTES) {
      renameSync(HEALTH_PATH, `${HEALTH_PATH}.1`);
    }
    appendFileSync(HEALTH_PATH, JSON.stringify(line) + '\n');
  } catch {
    // Monitoring must never break trading. A lost health line is acceptable;
    // a thrown exception inside the filter path is not.
  }

  counts = {};
  verified = freshVerified();
  windowStart = Date.now();
  lastFlush = windowStart;
}

/** Current unflushed window — for tests and for the status broadcast. */
export function getPendingCounts(): Readonly<Record<string, number>> {
  return { ...counts };
}

/** Verification counts not yet flushed — for tests and the status broadcast. */
export function getPendingVerification(): Readonly<Verified> {
  return { ...verified, bySource: { ...verified.bySource } };
}

/** Reset module state. Tests only. */
export function _reset(): void {
  counts = {};
  verified = freshVerified();
  windowStart = Date.now();
  lastFlush = windowStart;
}
