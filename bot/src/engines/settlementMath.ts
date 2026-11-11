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

/** Fee dollars: 5 decimal places (0.00001), finer than the cent ledger. */
function roundFee(v: number): number {
  return Math.round(v * 100000) / 100000;
}

function usable(price: number | null | undefined): price is number {
  return Number.isFinite(price) && (price as number) > 0 && (price as number) < 1;
}

/**
 * Taker fee on a fill of `shares` at `price`, in dollars, rounded to 0.00001:
 * shares × 0.07 × p × (1 − p) (CLOB V2 `crypto_fees_v2`). Charged at match on
 * every taker fill, win or lose. 2c a share when the price is unusable.
 */
export function takerFee(shares: number, price: number | null | undefined): number {
  if (!Number.isFinite(shares) || shares <= 0) return 0;
  if (!usable(price)) return roundFee(shares * FALLBACK_FEE_PER_SHARE);
  return roundFee(shares * polyTakerFeePerShare(price));
}

/**
 * Cash for one fill after the V2 taker fee, applied once.
 * A positive `usdc` is the cash the API already booked (data-api usdcSize
 * includes the protocol fee; a maker's is the gross notional). Kept as-is.
 * With no `usdc`, price×size is gross: takers pay the fee (BUY adds it, SELL
 * removes it) and makers pay nothing.
 */
export function fillCashNotional({ side, size, price, usdc, traderSide }: {
  side: string;
  size: number;
  price: number;
  usdc?: number | null;
  traderSide?: string | null;
}): number {
  const reported = Number(usdc);
  if (Number.isFinite(reported) && reported > 0) return roundFee(reported);
  const shares = Number(size);
  const px = Number(price);
  const gross = Number.isFinite(shares) && Number.isFinite(px) ? shares * px : 0;
  const isMaker = String(traderSide ?? '').toUpperCase() === 'MAKER';
  const fee = isMaker ? 0 : takerFee(shares, px);
  const net = String(side).toUpperCase() === 'BUY' ? gross + fee : Math.max(0, gross - fee);
  return roundFee(net);
}

/**
 * Taker fee on a sell from the fill, not the limit.
 * A FOK sell price is a minimum; the match can be higher. Gross USDC
 * (`takingAmount`) divided by shares sold (`makingAmount`, else the size
 * sent) is that match price. The limit is only the fallback when the
 * proceeds are missing. The order response has no per-fill prices, so one
 * aggregate price is the fee price. No proceeds means no sell fee.
 */
export function sellFillFee(
  recovered: number | null | undefined,
  filledShares: number | null | undefined,
  limitPrice: number,
  sentSize: number,
): number {
  const shares = Number.isFinite(filledShares) && (filledShares as number) > 0
    ? (filledShares as number)
    : sentSize;
  if (!Number.isFinite(shares) || shares <= 0) return 0;
  // Number(null) is 0, so a missing fill must be told apart from zero proceeds.
  if (recovered == null || !Number.isFinite(recovered)) {
    if (Number.isFinite(limitPrice) && limitPrice > 0 && limitPrice < 1) return takerFee(shares, limitPrice);
    return 0;
  }
  if (recovered <= 0) return 0;
  return takerFee(shares, recovered / shares);
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
