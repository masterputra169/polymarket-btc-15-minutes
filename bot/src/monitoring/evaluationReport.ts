/**
 * Daily Telegram report on the dry-run evaluation window.
 *
 * The go-live question is not "did we win today" but "is the win rate above
 * the win rate the entry prices need to break even, on enough trades to mean
 * it". This report answers exactly that for the trades since EVAL_WINDOW_START
 * (the moment the current strategy was deployed): realistic-fill margin over
 * breakeven (trading/breakevenMargin.ts — never re-derived), a Wilson 95%
 * interval on the win rate so a small sample is not read as a verdict, the split
 * by session, the last 24 h, and progress toward EVAL_TARGET_TRADES.
 *
 * Record-only: reads the journal once a day and sends one message. Disabled
 * (with a startup line saying so) when EVAL_WINDOW_START is not set.
 */

import { readFile } from 'fs/promises';
import { BOT_CONFIG } from '../config.ts';
import { createLogger } from '../logger.ts';
import { envInt } from '../utils/env.ts';
import { notify } from './notifier.ts';
import { marginReport, type MarginSummary, type ScorableRow } from '../trading/breakevenMargin.ts';

const log = createLogger('EvalReport');

type Env = Record<string, string | undefined>;

export interface EvalConfig {
  since: number | null;
  targetTrades: number;
  hourUtc: number;
  problem: string | null;
}

export function readEvalConfig(env: Env): EvalConfig {
  const raw = env.EVAL_WINDOW_START?.trim();
  let since: number | null = null;
  let problem: string | null = null;
  if (raw) {
    const t = Date.parse(raw);
    if (Number.isFinite(t)) since = t;
    else problem = `EVAL_WINDOW_START="${raw}" is not an ISO date — report disabled`;
  }
  return {
    since,
    targetTrades: envInt(env.EVAL_TARGET_TRADES, 150, 10, 100_000),
    hourUtc: envInt(env.EVAL_REPORT_HOUR_UTC, 0, 0, 23),
    problem,
  };
}

export interface EvalRow extends ScorableRow {
  entry?: ScorableRow['entry'] & { enteredAt?: number | null; session?: string | null; modelId?: string | null };
}

export interface WinRateInterval { lo: number; hi: number }

/** Wilson score interval for a win rate, 95%, as percentages. */
export function wilson95(wins: number, n: number): WinRateInterval | null {
  if (n <= 0) return null;
  const z = 1.96;
  const p = wins / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { lo: Math.max(0, centre - half) * 100, hi: Math.min(1, centre + half) * 100 };
}

export type Verdict = 'no_trades' | 'too_early' | 'above_breakeven' | 'below_breakeven' | 'inconclusive';

export interface EvaluationSummary {
  since: number;
  now: number;
  target: number;
  models: string[];
  realistic: MarginSummary;
  interval: WinRateInterval | null;
  verdict: Verdict;
  bySession: Array<{ session: string; summary: MarginSummary }>;
  last24h: MarginSummary;
  excludedNotRealistic: number;
}

const RESOLVED = new Set(['WIN', 'LOSS']);
const MIN_FOR_VERDICT = 30;

function inWindow(r: EvalRow, since: number, now: number): boolean {
  const t = Number(r.entry?.enteredAt);
  return Number.isFinite(t) && t >= since && t <= now && RESOLVED.has(String(r.analysis?.outcome));
}

/** Pure: everything the report says, from journal rows. */
export function buildEvaluation(rows: readonly EvalRow[], since: number, now: number, target: number): EvaluationSummary {
  const win = rows.filter(r => inWindow(r, since, now));
  const report = marginReport(win);
  const realistic = report.realistic;
  const interval = wilson95(realistic.wins, realistic.trades);

  let verdict: Verdict;
  if (realistic.trades === 0) verdict = 'no_trades';
  else if (realistic.trades < MIN_FOR_VERDICT || interval == null || realistic.breakevenPct == null) verdict = 'too_early';
  else if (interval.lo > realistic.breakevenPct) verdict = 'above_breakeven';
  else if (interval.hi < realistic.breakevenPct) verdict = 'below_breakeven';
  else verdict = 'inconclusive';

  const sessions = new Map<string, EvalRow[]>();
  for (const r of win) {
    const s = r.entry?.session || 'unknown';
    const list = sessions.get(s) ?? [];
    list.push(r);
    sessions.set(s, list);
  }
  const bySession = [...sessions.entries()]
    .map(([session, list]) => ({ session, summary: marginReport(list).realistic }))
    .filter(x => x.summary.trades > 0)
    .sort((a, b) => b.summary.trades - a.summary.trades);

  return {
    since,
    now,
    target,
    models: [...new Set(win.map(r => r.entry?.modelId).filter((m): m is string => typeof m === 'string'))].sort(),
    realistic,
    interval,
    verdict,
    bySession,
    last24h: marginReport(win.filter(r => Number(r.entry?.enteredAt) >= now - 86_400_000)).realistic,
    excludedNotRealistic: report.lifetime.trades - realistic.trades,
  };
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function pct(x: number | null, dp = 1): string {
  return x == null ? '—' : `${x.toFixed(dp)}%`;
}

function pp(x: number | null): string {
  return x == null ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(1)}pp`;
}

function usd(x: number): string {
  return `${x >= 0 ? '+' : '-'}$${Math.abs(x).toFixed(2)}`;
}

function line(label: string, s: MarginSummary): string {
  return `${label}: ${s.trades} trades · WR ${pct(s.winRatePct)} vs BE ${pct(s.breakevenPct)} (${pp(s.marginPp)}) · ${usd(s.pnl)}`;
}

const VERDICT_TEXT: Record<Verdict, string> = {
  no_trades: '⏳ No resolved trades in the window yet.',
  too_early: `⏳ Too early to judge (fewer than ${MIN_FOR_VERDICT} trades) — do not change anything on this.`,
  above_breakeven: '✅ Win rate is above breakeven with 95% confidence.',
  below_breakeven: '🛑 Win rate is below breakeven with 95% confidence — review before going live.',
  inconclusive: '🟡 Breakeven lies inside the 95% interval — keep collecting.',
};

/** Pure: the Telegram message (HTML parse mode). */
export function formatEvaluation(s: EvaluationSummary): string {
  const r = s.realistic;
  const days = Math.max(0, (s.now - s.since) / 86_400_000);
  const progress = Math.min(100, (r.trades / s.target) * 100);
  const out = [
    `📋 <b>Dry-run evaluation</b> — day ${days.toFixed(1)} since ${esc(new Date(s.since).toISOString().slice(0, 16).replace('T', ' '))} UTC`,
    s.models.length ? `Model: ${esc(s.models.join(', '))}` : 'Model: —',
    '',
    `Trades: <b>${r.trades}</b> / ${s.target} target (${progress.toFixed(0)}%)`,
    `WR <b>${pct(r.winRatePct)}</b>${s.interval ? ` (95% ${s.interval.lo.toFixed(0)}–${s.interval.hi.toFixed(0)}%)` : ''} vs breakeven ${pct(r.breakevenPct)} → margin <b>${pp(r.marginPp)}</b>`,
    `P&amp;L: <b>${usd(r.pnl)}</b>${r.avgEntryPrice != null ? ` · avg entry ${(r.avgEntryPrice * 100).toFixed(1)}c` : ''}`,
    VERDICT_TEXT[s.verdict],
  ];
  if (s.bySession.length) {
    out.push('', '<b>By session</b>');
    for (const { session, summary } of s.bySession) out.push(line(esc(session), summary));
  }
  out.push('', line('Last 24h', s.last24h));
  if (s.excludedNotRealistic > 0) {
    out.push(`(${s.excludedNotRealistic} trade(s) without a realistic fill excluded)`);
  }
  return out.join('\n');
}

/**
 * Journal rows that could be in the window. The read is async (the poll loop
 * keeps running while the file loads), and a line whose enteredAt is before
 * `since` is skipped before parsing — the journal grows for the bot's whole
 * life, the window does not.
 */
export async function readJournalRows(path: string, since: number): Promise<EvalRow[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw err;
  }
  const rows: EvalRow[] = [];
  for (const l of text.split('\n')) {
    if (!l.trim()) continue;
    const m = /"enteredAt":\s*(\d+)/.exec(l);
    if (m && Number(m[1]) < since) continue;
    try { rows.push(JSON.parse(l)); } catch { /* a torn line never stops the report */ }
  }
  return rows;
}

const CFG = readEvalConfig(process.env);
let timer: ReturnType<typeof setTimeout> | null = null;

/** Build and send the report now. Never throws. */
export async function sendEvaluationReport(now: number = Date.now()): Promise<void> {
  if (CFG.since == null) return;
  try {
    const rows = await readJournalRows(BOT_CONFIG.journalFile, CFG.since);
    const summary = buildEvaluation(rows, CFG.since, now, CFG.targetTrades);
    await notify('info', formatEvaluation(summary), { key: `eval_report:${new Date(now).toISOString().slice(0, 10)}` });
    log.info(`Evaluation report sent: ${summary.realistic.trades} trades, verdict ${summary.verdict}`);
  } catch (err) {
    log.warn(`Evaluation report failed (non-fatal): ${(err as Error)?.message ?? err}`);
  }
}

/** Milliseconds until the next `hourUtc`:00 UTC. */
export function msUntilHourUtc(now: number, hourUtc: number): number {
  const d = new Date(now);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hourUtc, 0, 0);
  return next > now ? next - now : next + 86_400_000 - now;
}

export function scheduleEvaluationReport(): void {
  if (CFG.problem) log.warn(CFG.problem);
  if (CFG.since == null) {
    log.info('Evaluation report off (set EVAL_WINDOW_START to the strategy deploy time to enable).');
    return;
  }
  const arm = () => {
    const ms = msUntilHourUtc(Date.now(), CFG.hourUtc);
    timer = setTimeout(async () => {
      await sendEvaluationReport();
      arm();
    }, ms);
    timer.unref?.();
  };
  arm();
  log.info(`Evaluation report: window since ${new Date(CFG.since).toISOString()}, target ${CFG.targetTrades} trades, daily at ${String(CFG.hourUtc).padStart(2, '0')}:00 UTC`);
}

export function stopEvaluationReport(): void {
  if (timer) { clearTimeout(timer); timer = null; }
}
