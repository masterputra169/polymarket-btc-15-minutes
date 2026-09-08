/**
 * Settlement P&L math shared by settlement.ts (booking a result) and the
 * fallback verifier (re-booking it once Polymarket resolves). One function so
 * a correction never drifts by a cent from what the original path would have
 * written.
 */

import { polyFeeRate } from '../../../src/config.ts';

const FALLBACK_FEE_RATE = 0.02;

/**
 * Settlement sources that are not Polymarket's resolution: 'price_fallback'
 * (Chainlink spot vs PTB) and 'unknown' (no PTB, booked as a loss). Both are
 * provisional and get re-checked by the fallback verifier.
 */
export function isProvisionalSource(source: string | null | undefined): boolean {
  return source === 'price_fallback' || source === 'unknown';
}

function roundCents(v: number): number {
  return Math.round(v * 100) / 100;
}

/** Dynamic Polymarket fee on profit (0.072 × p × (1−p)); 2% if the entry price is unusable. */
export function settlementFeeRate(entryPrice: number | null | undefined): number {
  if (!Number.isFinite(entryPrice) || (entryPrice as number) <= 0 || (entryPrice as number) >= 1) return FALLBACK_FEE_RATE;
  const rate = polyFeeRate(entryPrice as number);
  return rate > 0 ? rate : FALLBACK_FEE_RATE;
}

/**
 * Net P&L of a binary position: a win pays $1/share minus the fee on profit,
 * a loss forfeits the cost. Rounded to cents at each step, like positionTracker.
 */
export function computeSettlementPnl({ won, size, cost, price }: {
  won: boolean; size: number; cost: number; price: number | null | undefined;
}): number {
  if (!won) return roundCents(-cost);
  const grossProfit = Math.max(0, size - cost);
  const fee = roundCents(grossProfit * settlementFeeRate(price));
  return roundCents(size - cost - fee);
}
