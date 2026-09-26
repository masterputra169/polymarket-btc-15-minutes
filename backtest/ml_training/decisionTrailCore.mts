/**
 * Pure logic behind decisionTrailStudy.mts — categorising filter reasons,
 * choosing one simulated entry per market, and the settlement arithmetic.
 *
 * No I/O, no clocks, nothing module-level that changes. Tested in
 * bot/tests/decisionTrailStudy.test.ts (vitest only collects bot/ and src/).
 *
 * Every simulated trade here is "what if the bot had entered on this d line":
 * side = the line's `sd`, price = the market price decide() used for that side
 * (`pu` / `pd`) plus a slippage allowance. Fills, book depth and the gates that
 * run after applyTradeFilters() (Monte Carlo, smart flow, validateTrade) are not
 * modelled, so a simulated set is an upper bound on what the bot could have
 * taken, not a forecast of it.
 */

import { polyFeeRate } from '../../src/config.ts';
import type { DecisionLine } from '../../bot/src/tape/tapeFormat.ts';

/** Report order. 'other' = a reason no rule recognises; extend RULES when one appears. */
export const GATE_IDS = [
  'ml_conf', 'dead_zone', 'late_ml', 'trending_ml', 'ml_degraded',
  'entry_ceiling', 'entry_soft_ceiling', 'entry_floor', 'extreme_price', 'near_5050',
  'too_early', 'too_late', 'time_unknown', 'btc_dist', 'edge_ceiling', 'counter_trend',
  'trending_early', 'trending_price', 'spread', 'spread_widening', 'vpin', 'low_vol',
  'cooldown', 'max_trades', 'session_block', 'time_gate', 'ptb_source',
  'sentiment', 'macro', 'llm', 'other',
] as const;

export type GateId = typeof GATE_IDS[number];

export function isGateId(x: string): x is GateId {
  return (GATE_IDS as readonly string[]).includes(x);
}

/**
 * One rule per reason string pushed by bot/src/safety/tradeFilters.ts. Anchored
 * on the leading words only, so a changed number or tag does not break the match,
 * and robust to decisionTrail.ts truncating a reason at 120 chars.
 *
 * Order matters where prefixes overlap: the Asia-session ML floor must win over
 * the plain ML gate, and the entry-price hard cap over the soft ceiling.
 */
const RULES: ReadonlyArray<{ gate: GateId; re: RegExp }> = [
  { gate: 'session_block', re: /session blocked \(BLOCKED_SESSIONS\)/ },     // filter 0
  { gate: 'time_gate', re: /^Asia session: ML/ },                            // 1a, 16
  { gate: 'time_gate', re: /^Weekend \+ / },                                 // 7
  { gate: 'time_gate', re: /^Blackout hour: / },                             // 10
  { gate: 'ml_conf', re: /^ML conf / },                                      // 1 (incl. [tilt], [edge→relaxed], [oracle-lag])
  { gate: 'dead_zone', re: /^ML dead zone: / },                              // 1b
  { gate: 'ptb_source', re: /^PTB source / },                                // 1c
  { gate: 'near_5050', re: /^Market \S+ near 50\/50/ },                      // 2
  { gate: 'extreme_price', re: /^Extreme price / },                          // 2b
  { gate: 'entry_floor', re: /^Entry price .*\bfloor\b/ },                   // 2c
  { gate: 'entry_ceiling', re: /^Entry price .*\bhard cap\b/ },              // 2d hard cap (68c / dry-run cap / trending / ultra-ML)
  { gate: 'entry_soft_ceiling', re: /^Entry price .*\bceiling\b/ },          // 2d soft ceiling (MAX_ENTRY_PRICE, ML < 85%)
  { gate: 'low_vol', re: /^Low vol: / },                                     // 3
  { gate: 'time_unknown', re: /^timeLeftMin is NaN/ },                       // 4
  { gate: 'too_late', re: /^Too close: / },                                  // 4
  { gate: 'too_early', re: /^Too early: / },                                 // 4b
  { gate: 'late_ml', re: /^LATE phase ML gate: / },                          // 4c
  { gate: 'btc_dist', re: /^BTC too close to PTB: / },                       // 4c
  { gate: 'cooldown', re: /^Loss cooldown: / },                              // 5
  { gate: 'max_trades', re: /^Max \d+ trade\(s\) per market/ },              // 6
  { gate: 'max_trades', re: /^Re-entry blocked: / },                         // 6
  { gate: 'edge_ceiling', re: /^Edge ceiling: / },                           // 8
  { gate: 'counter_trend', re: /^Counter-trend: / },                         // 9
  { gate: 'trending_early', re: /^Trending\+EARLY blocked/ },                // 11a
  { gate: 'trending_price', re: /^Trending\+low price blocked/ },            // 11b
  { gate: 'trending_ml', re: /^Trending\+low ML blocked/ },                  // 11c
  { gate: 'spread', re: /^Wide spread: / },                                  // 12
  { gate: 'spread', re: /^Spread \S+ w\/ thin edge/ },                       // 12
  { gate: 'ml_degraded', re: /^ML degraded: / },                             // 13
  { gate: 'vpin', re: /^VPIN / },                                            // 14
  { gate: 'spread_widening', re: /^Spread widening: / },                     // 15
  { gate: 'sentiment', re: /^Sentiment: / },                                 // 17
  { gate: 'macro', re: /^Macro: / },                                         // 18
  { gate: 'llm', re: /^LLM regime: / },                                      // 19
];

/** Gate id of one applyTradeFilters() reason string; 'other' when no rule matches. */
export function categorizeReason(reason: unknown): GateId {
  if (typeof reason !== 'string') return 'other';
  const s = reason.trim();
  if (s === '') return 'other';
  for (const rule of RULES) {
    if (rule.re.test(s)) return rule.gate;
  }
  return 'other';
}

/** Numbers → '#', so unrecognised reasons group by wording rather than by value. */
export function reasonShape(reason: string): string {
  return reason.replace(/\d+(?:\.\d+)?/g, '#');
}

// ── Lines ────────────────────────────────────────────────────────────────────

/** The d-line fields this module reads. */
export type TrailLine = Pick<DecisionLine, 't' | 'm' | 'a' | 'sd' | 'mc' | 'pu' | 'pd' | 'st' | 'fr'>;

/** A d line with its reasons categorised once (distinct gate ids, first-seen order). */
export interface ScoredLine<L extends TrailLine = TrailLine> {
  readonly line: L;
  readonly gates: readonly GateId[];
}

export function scoreLine<L extends TrailLine>(line: L): ScoredLine<L> {
  const gates: GateId[] = [];
  for (const r of line.fr ?? []) {
    const g = categorizeReason(r);
    if (!gates.includes(g)) gates.push(g);
  }
  return { line, gates };
}

/** applyTradeFilters() ran on this poll, so `fr` is the complete list of reasons. */
export function filtersRan(line: Pick<TrailLine, 'st'>): boolean {
  return line.st === 'filtered' || line.st === 'passed' || line.st === 'entered';
}

/** decide() said ENTER and the filters ran — the only lines a gate can be judged on. */
export function isEvaluableEnter(line: Pick<TrailLine, 'a' | 'st'>): boolean {
  return line.a === 'E' && filtersRan(line);
}

/** The single gate that held this ENTER (all its reasons in one category), else null. */
export function soleGate(s: ScoredLine): GateId | null {
  if (!isEvaluableEnter(s.line)) return null;
  return s.gates.length === 1 ? s.gates[0] : null;
}

/** ENTER that clears the filters once every gate in `relaxed` is removed. Empty set = as recorded. */
export function passesWithRelaxed(s: ScoredLine, relaxed: ReadonlySet<GateId>): boolean {
  if (!isEvaluableEnter(s.line)) return false;
  return s.gates.every((g) => relaxed.has(g));
}

/**
 * ENTER that clears the filters when the ml_conf gate is replaced by a flat
 * `mc >= threshold` and every other recorded reason is absent. Other ML gates
 * (dead zone, LATE, trending ML) stay as recorded. A line without an ML
 * confidence passes, as in the bot (the gate needs mlAvailable).
 */
/** The bot's ML gate (tradeFilters.ts filter 1) with its three thresholds. */
export interface MlRule { label: string; min: number; relaxed: number; bypass: number }

/**
 * ML gates scored forward on the tape. Since 2026-09-26 the live gate is the edge
 * bypass (FILTER_ML_CONF_RELAXED=0.20, FILTER_HIGH_EDGE_BYPASS=0.10 on the bot's
 * fee- and ask-adjusted edge); the first row is the gate it replaced.
 */
export const ML_RULE_CANDIDATES: readonly MlRule[] = [
  { label: 'before 09-26: 0.65 (0.45 at edge>=15%)', min: 0.65, relaxed: 0.45, bypass: 0.15 },
  { label: 'live since 09-26: 0.65 (0.20 at edge>=10%)', min: 0.65, relaxed: 0.20, bypass: 0.10 },
  { label: 'conf>=0.45 flat', min: 0.45, relaxed: 0.45, bypass: 1 },
];

/**
 * Would this line pass the ML gate under `rule`, every other recorded reason absent?
 * The edge is the bot's own for the line's side (d.eu / d.ed: ensemble probability
 * minus ask and fee), so the replay measures edge exactly as tradeFilters.ts does.
 */
export function passesMlRule(s: ScoredLine<TrailLine & { eu?: number | null; ed?: number | null }>, rule: MlRule): boolean {
  if (!isEvaluableEnter(s.line)) return false;
  if (!s.gates.every((g) => g === 'ml_conf')) return false;
  const mc = s.line.mc;
  if (mc == null) return true;
  const edge = s.line.sd === 'U' ? s.line.eu : s.line.sd === 'D' ? s.line.ed : null;
  const threshold = edge != null && edge >= rule.bypass ? Math.min(rule.min, rule.relaxed) : rule.min;
  return mc >= threshold;
}

export function passesAtMlThreshold(s: ScoredLine, threshold: number): boolean {
  if (!isEvaluableEnter(s.line)) return false;
  if (!s.gates.every((g) => g === 'ml_conf')) return false;
  const mc = s.line.mc;
  return mc == null || mc >= threshold;
}

function sortedByT<L extends TrailLine>(xs: readonly ScoredLine<L>[]): readonly ScoredLine<L>[] {
  for (let i = 1; i < xs.length; i++) {
    if (xs[i].line.t < xs[i - 1].line.t) return [...xs].sort((a, b) => a.line.t - b.line.t);
  }
  return xs;
}

/** Earliest line per market (slug) satisfying `pred` — one simulated trade per market. */
export function firstPerMarket<L extends TrailLine>(
  lines: readonly ScoredLine<L>[],
  pred: (s: ScoredLine<L>) => boolean,
): Map<string, ScoredLine<L>> {
  const out = new Map<string, ScoredLine<L>>();
  for (const s of sortedByT(lines)) {
    const slug = s.line.m;
    if (!slug || out.has(slug)) continue;
    if (pred(s)) out.set(slug, s);
  }
  return out;
}

// ── Trades and settlement math ───────────────────────────────────────────────

export type Side = 'UP' | 'DOWN';

export const DEFAULT_SLIPPAGE = 0.01;
const MAX_ENTRY = 0.99;

export function sideOf(line: Pick<TrailLine, 'sd'>): Side | null {
  return line.sd === 'U' ? 'UP' : line.sd === 'D' ? 'DOWN' : null;
}

/** Simulated fill: the side's price as decide() saw it plus `slip`, capped at 99c; null if unusable. */
export function entryPrice(line: Pick<TrailLine, 'sd' | 'pu' | 'pd'>, slip = DEFAULT_SLIPPAGE): number | null {
  const side = sideOf(line);
  if (!side) return null;
  const p = side === 'UP' ? line.pu : line.pd;
  if (typeof p !== 'number' || !Number.isFinite(p) || p <= 0 || p >= 1) return null;
  return Math.min(MAX_ENTRY, Math.round((p + slip) * 10_000) / 10_000);
}

/** Net profit of a winning $1 stake bought at `c`: payout 1/c shares, fee 0.072·c·(1−c) on the profit. */
export function winPnlPerDollar(c: number): number {
  return (1 / c - 1) * (1 - polyFeeRate(c));
}

export function pnlPerDollar(c: number, won: boolean): number {
  return won ? winPnlPerDollar(c) : -1;
}

/**
 * Win rate at which a position bought at `c` has zero expected value. The fee is
 * charged on the winning profit (engines/settlementMath.ts), so this is
 * c / ((1−c)(1−r) + c), not c + r.
 */
export function breakevenWinRate(c: number): number {
  const r = polyFeeRate(c);
  return c / ((1 - c) * (1 - r) + c);
}

export interface SimTrade {
  slug: string;
  t: number;
  side: Side;
  price: number;
  won: boolean;
}

/** The trade this line would have been, given the market's outcome; null if unresolved or unpriced. */
export function simulateTrade(line: TrailLine, outcome: Side | null | undefined, slip = DEFAULT_SLIPPAGE): SimTrade | null {
  const side = sideOf(line);
  const price = entryPrice(line, slip);
  if (!side || price == null || !line.m || (outcome !== 'UP' && outcome !== 'DOWN')) return null;
  return { slug: line.m, t: line.t, side, price, won: side === outcome };
}

/** 95% Wilson score interval for k wins out of n; null for n = 0. */
export function wilsonInterval(k: number, n: number, z = 1.96): [number, number] | null {
  if (!(n > 0)) return null;
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

export interface TradeSummary {
  n: number;
  wins: number;
  winRate: number | null;
  ci: [number, number] | null;
  /** Win rate at which these $1 stakes at these prices break even: n / (n + Σ win-profit). */
  breakeven: number | null;
  /** winRate − breakeven, percentage points. */
  marginPp: number | null;
  /** Mean P&L per $1 staked. */
  roi: number | null;
  pnl: number;
  avgPrice: number | null;
}

export function summarizeTrades(trades: readonly SimTrade[]): TradeSummary {
  const n = trades.length;
  if (n === 0) {
    return { n: 0, wins: 0, winRate: null, ci: null, breakeven: null, marginPp: null, roi: null, pnl: 0, avgPrice: null };
  }
  let wins = 0;
  let pnl = 0;
  let winProfitSum = 0;
  let priceSum = 0;
  for (const tr of trades) {
    if (tr.won) wins++;
    pnl += pnlPerDollar(tr.price, tr.won);
    winProfitSum += winPnlPerDollar(tr.price);
    priceSum += tr.price;
  }
  const winRate = wins / n;
  const breakeven = n / (n + winProfitSum);
  return {
    n,
    wins,
    winRate,
    ci: wilsonInterval(wins, n),
    breakeven,
    marginPp: (winRate - breakeven) * 100,
    roi: pnl / n,
    pnl,
    avgPrice: priceSum / n,
  };
}

// ── Markets ──────────────────────────────────────────────────────────────────

/** Close time of a BTC 15-minute market: the m line's `end`, else slug start (epoch s) + 15 min. */
export function marketEndMs(slug: string, endFromTape?: number | null): number | null {
  if (typeof endFromTape === 'number' && Number.isFinite(endFromTape) && endFromTape > 0) return endFromTape;
  const m = /-(\d{9,11})$/.exec(slug);
  return m ? Number(m[1]) * 1000 + 15 * 60_000 : null;
}

// ── Stage mix ────────────────────────────────────────────────────────────────

export const STAGES = ['wait', 'pre', 'arb', 'unstable', 'filtered', 'passed', 'entered'] as const;
export type StageName = typeof STAGES[number];

export interface StageCounts {
  total: number;
  enter: number;
  stages: Record<StageName, number>;
}

function emptyStageCounts(): StageCounts {
  return { total: 0, enter: 0, stages: { wait: 0, pre: 0, arb: 0, unstable: 0, filtered: 0, passed: 0, entered: 0 } };
}

/** Stage counts per group key (session, hour, ...); `key` returning null groups under '?'. */
export function stageMix<L extends Pick<TrailLine, 'a' | 'st'>>(lines: readonly L[], key: (l: L) => string | null): Map<string, StageCounts> {
  const out = new Map<string, StageCounts>();
  for (const l of lines) {
    const k = key(l) ?? '?';
    const c = out.get(k) ?? emptyStageCounts();
    c.total++;
    if (l.a === 'E') c.enter++;
    if ((STAGES as readonly string[]).includes(l.st)) c.stages[l.st as StageName]++;
    out.set(k, c);
  }
  return out;
}
