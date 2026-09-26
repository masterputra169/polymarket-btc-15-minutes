/**
 * Settlement P&L math shared by settlement.ts (booking a result) and the
 * fallback verifier (re-booking it once Polymarket resolves). One function so
 * a correction never drifts by a cent from what the original path would have
 * written.
 */

import { polyTakerFeePerShare } from '../../../src/config.ts';

/** Fee per share when the entry price is unusable: 2c, above the 1.75c maximum at 50c. */
const FALLBACK_FEE_PER_SHARE = 0.02;

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

function usable(price: number | null | undefined): price is number {
  return Number.isFinite(price) && (price as number) > 0 && (price as number) < 1;
}

/**
 * Taker fee on a fill of `shares` at `price`, in dollars, rounded to cents:
 * shares × 0.07 × p × (1 − p) (CLOB V2 `crypto_fees_v2`). Charged at match on
 * every taker fill, win or lose. 2c a share when the price is unusable.
 */
export function takerFee(shares: number, price: number | null | undefined): number {
  if (!Number.isFinite(shares) || shares <= 0) return 0;
  if (!usable(price)) return roundCents(shares * FALLBACK_FEE_PER_SHARE);
  return roundCents(shares * polyTakerFeePerShare(price));
}

/**
 * Net P&L of a binary position bought as a taker: a win pays $1/share, a loss
 * pays nothing, and the entry fee is paid either way. Until 2026-09-26 the fee
 * was modelled as 0.072·p·(1−p) of the winning profit only — about a quarter of
 * what Polymarket charges, so every booked P&L and breakeven was optimistic.
 */
export function computeSettlementPnl({ won, size, cost, price }: {
  won: boolean; size: number; cost: number; price: number | null | undefined;
}): number {
  const fee = takerFee(size, price);
  return roundCents((won ? size : 0) - cost - fee);
}
