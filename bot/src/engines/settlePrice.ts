/**
 * The price a BTC 15m window will be judged on, as well as it can be known now.
 *
 * A window settles UP when Chainlink's 60-second TWAP stamped at its last second
 * is >= its price to beat. Two corrections follow for anything that measures
 * "how far is BTC from the price to beat":
 *
 *  1. Use Chainlink, not Binance. Over 116k tape snapshots (2026-09-24/25)
 *     Binance BTC/USDT sat $23.76 ABOVE Chainlink's BTC/USD (median; p5 $9.91,
 *     p95 $35.61), so Binance-minus-PTB read every window ~$24 more bullish than
 *     it was.
 *  2. In the last 60 s the answer is partly written already. The final TWAP
 *     averages the last minute, so with k seconds of it observed the expected
 *     final value is (sum of those k one-second prices + current price × the
 *     60 − k seconds still to come) / 60. Earlier than that, the best estimate of
 *     a future average of a martingale is simply the current price.
 *
 * When Chainlink spot is unavailable the Binance price is shifted by a slowly
 * tracked basis (Binance − Chainlink), never used raw.
 */

import type { Tick } from '../streams/tickStore.ts';

export const TWAP_WINDOW_MS = 60_000;

export interface SettleEstimateInput {
  nowMs: number;
  endMs: number | null;
  /** Latest Chainlink spot, or null. */
  spot: number | null;
  /** Chainlink spot ticks (timestamped by the source) covering the last minute. */
  spotTicks: readonly Tick[];
  /** Binance price, used only when spot is null. */
  binance: number | null;
  /** Tracked Binance − Chainlink basis, or null if never observed. */
  basis: number | null;
}

export interface SettleEstimate {
  price: number | null;
  source: 'chainlink' | 'chainlink_final_minute' | 'binance_minus_basis' | 'binance_raw' | 'none';
}

/** Expected final TWAP, or the current price when more than a minute remains. */
export function estimateSettlePrice(i: SettleEstimateInput): SettleEstimate {
  if (i.spot == null || !(i.spot > 0)) {
    if (i.binance != null && i.binance > 0) {
      return i.basis != null
        ? { price: i.binance - i.basis, source: 'binance_minus_basis' }
        : { price: i.binance, source: 'binance_raw' };
    }
    return { price: null, source: 'none' };
  }
  if (i.endMs == null || i.nowMs <= i.endMs - TWAP_WINDOW_MS || i.nowMs >= i.endMs + 5_000) {
    return { price: i.spot, source: 'chainlink' };
  }
  const windowStart = i.endMs - TWAP_WINDOW_MS;
  const upto = Math.min(i.nowMs, i.endMs);
  // One sample per whole second of the TWAP window; a second with no tick holds
  // the previous one (the last tick before the window seeds it).
  const ticks = [...i.spotTicks].filter(t => t.ts <= upto).sort((a, b) => a.ts - b.ts);
  let held: number | null = null;
  let j = 0;
  let sum = 0;
  let seen = 0;
  for (let s = windowStart + 1_000; s <= i.endMs; s += 1_000) {
    if (s > upto) break;
    while (j < ticks.length && ticks[j].ts <= s) held = ticks[j++].value;
    sum += held ?? i.spot;
    seen++;
  }
  const remaining = TWAP_WINDOW_MS / 1_000 - seen;
  return { price: (sum + i.spot * remaining) / (TWAP_WINDOW_MS / 1_000), source: 'chainlink_final_minute' };
}

/**
 * Binance − Chainlink, smoothed. Updated only when both prices are fresh; an
 * outlier (a stale side) is clipped so one bad poll cannot move it far.
 */
export class BasisTracker {
  private value: number | null = null;
  private readonly alpha: number;
  private readonly maxStep: number;

  constructor(alpha = 0.02, maxStep = 5) {
    this.alpha = alpha;
    this.maxStep = maxStep;
  }

  update(binance: number | null, chainlink: number | null): void {
    if (binance == null || chainlink == null || !(binance > 0) || !(chainlink > 0)) return;
    const d = binance - chainlink;
    if (!Number.isFinite(d) || Math.abs(d) > 500) return;
    if (this.value == null) { this.value = d; return; }
    const step = Math.max(-this.maxStep, Math.min(this.maxStep, this.alpha * (d - this.value)));
    this.value += step;
  }

  get(): number | null {
    return this.value;
  }
}
