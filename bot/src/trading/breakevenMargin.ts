/**
 * Margin over breakeven — the number a win rate alone cannot tell you.
 *
 * A 66.6% win rate reads as healthy and says almost nothing on its own: buying
 * at an average of 63c, breakeven is already 63.6%, so the same book is worth
 * +3.0pp, not +66.6%. Which side of breakeven a strategy sits on, and by how
 * much, is the only form of the number worth putting in front of an operator.
 *
 * Breakeven is NOT re-derived here. It is solved from computeSettlementPnl —
 * the same function that books the trade and the same one the fallback verifier
 * re-books it with — so the dashboard can never drift from the bot's own
 * accounting. That matters concretely: on 2026-09-22 an analysis of 410 dry-run
 * rows used "breakeven = p + fee(p)", which charges the fee on the stake. The
 * bot charges it on the winning profit. The difference is 1.0-1.3pp across the
 * traded range — enough to make a band that is exactly breakeven look like a
 * 1.5pp loser, and enough to nearly ship a filter change for a result that was
 * not there.
 */

import { computeSettlementPnl } from '../engines/settlementMath.ts';

/**
 * Notional used to solve for breakeven. computeSettlementPnl rounds to cents at
 * each step, which would dominate a $1 position; a large notional pushes that
 * rounding below the precision anyone reads off a dashboard. Breakeven itself
 * is scale-invariant, so the choice affects nothing else.
 */
const SOLVE_NOTIONAL = 1_000_000;

/** A resolved journal row, as far as this module is concerned. */
export interface ScorableRow {
  entry?: {
    tokenPrice?: number | null;
    dryRun?: boolean;
    fillModel?: string;
  } | null;
  analysis?: {
    outcome?: string;
    pnl?: number | null;
  } | null;
}

export interface MarginSummary {
  trades: number;
  wins: number;
  losses: number;
  /** Realised win rate, 0-100. Null when there is nothing to divide by. */
  winRatePct: number | null;
  /** Mean entry price across the set, 0-1. */
  avgEntryPrice: number | null;
  /** Win rate this set would need just to break even, 0-100. */
  breakevenPct: number | null;
  /** winRatePct - breakevenPct, in percentage points. Negative = losing. */
  marginPp: number | null;
  /** Summed P&L over the set. */
  pnl: number;
}

const EMPTY: MarginSummary = {
  trades: 0, wins: 0, losses: 0,
  winRatePct: null, avgEntryPrice: null, breakevenPct: null, marginPp: null,
  pnl: 0,
};

function usablePrice(price: unknown): price is number {
  return typeof price === 'number' && Number.isFinite(price) && price > 0 && price < 1;
}

/**
 * The win rate at which a position bought at `price` has zero expected value,
 * as a fraction. Null when the price cannot be scored.
 *
 * Solved rather than derived: EV = w·winPnl + (1-w)·lossPnl = 0.
 */
export function breakevenWinRate(price: number | null | undefined): number | null {
  if (!usablePrice(price)) return null;
  const cost = SOLVE_NOTIONAL * price;
  const winPnl = computeSettlementPnl({ won: true, size: SOLVE_NOTIONAL, cost, price });
  const lossPnl = computeSettlementPnl({ won: false, size: SOLVE_NOTIONAL, cost, price });
  const span = winPnl - lossPnl;
  if (!(span > 0)) return null;
  return -lossPnl / span;
}

/**
 * Whether a row's entry price reflects what would actually have been paid.
 *
 * A live row always does — the fill was real. A dry-run row only does once the
 * simulated fill was charged at the limit a live FOK would have submitted,
 * which tradePipeline marks with `fillModel: 'fok_limit'`. Earlier dry-run rows
 * booked at the quote with zero slippage: the optimistic bound, not a forecast.
 *
 * The marker travels with the row, so the window needs no deploy timestamp to
 * keep up with — unlike a hardcoded boundary, which goes stale silently.
 *
 * Scope, and it is narrower than the name suggests: this answers "was the entry
 * priced like a live order", nothing else. It is NOT the go-live evaluation
 * window. That window restarts whenever a change alters which trades are taken
 * — 25499e7 did, by changing the CLOB freshness gate — and rows either side of
 * such a change are not one sample however they were filled. Use
 * bot/scripts/reportWindow.mts for that question.
 */
export function isRealisticFill(row: ScorableRow | null | undefined): boolean {
  if (row?.entry?.dryRun !== true) return true;
  return row?.entry?.fillModel === 'fok_limit';
}

function isResolved(row: ScorableRow | null | undefined): boolean {
  const outcome = row?.analysis?.outcome;
  return (outcome === 'WIN' || outcome === 'LOSS') && usablePrice(row?.entry?.tokenPrice);
}

/**
 * Score a set of resolved rows against its own breakeven.
 *
 * Rows that are unresolved, or carry no usable entry price, are excluded rather
 * than counted as losses — a row we cannot score is not evidence of anything.
 *
 * The set's breakeven is the notional-weighted one: with each trade taking the
 * same share count, w = Σcost / (Σwin payout + Σcost). For a single price this
 * reduces to breakevenWinRate(price); for a mixed book it is exact, where
 * breakeven-of-the-average-price would only be close.
 */
export function summarizeMargin(rows: readonly ScorableRow[]): MarginSummary {
  const scorable = (rows ?? []).filter(isResolved);
  if (scorable.length === 0) return { ...EMPTY };

  let wins = 0;
  let losses = 0;
  let pnl = 0;
  let priceSum = 0;
  let costSum = 0;
  let winPayoutSum = 0;

  for (const r of scorable) {
    const price = r.entry!.tokenPrice as number;
    if (r.analysis!.outcome === 'WIN') wins++;
    else losses++;

    const rowPnl = r.analysis!.pnl;
    if (typeof rowPnl === 'number' && Number.isFinite(rowPnl)) pnl += rowPnl;

    priceSum += price;
    const cost = SOLVE_NOTIONAL * price;
    costSum += cost;
    winPayoutSum += computeSettlementPnl({ won: true, size: SOLVE_NOTIONAL, cost, price });
  }

  const trades = scorable.length;
  const winRatePct = (wins / trades) * 100;
  const denom = winPayoutSum + costSum;
  const breakevenPct = denom > 0 ? (costSum / denom) * 100 : null;

  return {
    trades,
    wins,
    losses,
    winRatePct,
    avgEntryPrice: priceSum / trades,
    breakevenPct,
    marginPp: breakevenPct === null ? null : winRatePct - breakevenPct,
    pnl: Math.round(pnl * 100) / 100,
  };
}

export interface MarginReport {
  /** Every resolved row, whatever fill model booked it. */
  lifetime: MarginSummary;
  /** Only rows whose entry price reflects a realistic fill. The number to judge on. */
  realistic: MarginSummary;
}

/**
 * Both views at once: the lifetime figure an operator recognises, and the
 * realistic-fill subset that is actually decision-grade. Showing only the first
 * is how a blended, optimistically-filled 66.6% came to look like a verdict.
 */
export function marginReport(rows: readonly ScorableRow[]): MarginReport {
  const all = rows ?? [];
  return {
    lifetime: summarizeMargin(all),
    realistic: summarizeMargin(all.filter(isRealisticFill)),
  };
}
