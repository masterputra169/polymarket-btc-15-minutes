/**
 * EMA 8/21 Crossover Signal
 *
 * Fast EMA crossover for short-timeframe trading.
 * - EMA 8 (fast) crossing above EMA 21 (slow) → bullish
 * - EMA 8 crossing below EMA 21 → bearish
 * - Distance between EMAs → trend strength
 *
 * More responsive than SMA for 15-min prediction windows.
 */

import { emaSeries as ema } from './math.js';

/**
 * Compute EMA 8/21 crossover metrics.
 * @param {number[]} closes - Array of closing prices
 * @param {number} fastPeriod - Fast EMA period (default 8)
 * @param {number} slowPeriod - Slow EMA period (default 21)
 * @returns {{ ema8, ema21, distance, distancePct, cross, crossBars, bullish } | null}
 */
export function computeEmaCrossover(closes, fastPeriod = 8, slowPeriod = 21) {
  if (!closes || closes.length < slowPeriod + 2) return null;

  const len = closes.length;
  const ema8 = ema(closes, fastPeriod);
  const ema21 = ema(closes, slowPeriod);

  const fast = ema8[len - 1];
  const slow = ema21[len - 1];
  const prevFast = ema8[len - 2];
  const prevSlow = ema21[len - 2];

  if (fast === null || slow === null || prevFast === null || prevSlow === null) return null;

  // Distance: EMA8 - EMA21 (positive = bullish, negative = bearish)
  const distance = fast - slow;
  const price = closes[len - 1];
  const distancePct = price > 0 ? (distance / price) * 100 : 0;

  // Crossover detection
  const prevDiff = prevFast - prevSlow;
  const currDiff = fast - slow;

  let cross = 'NONE'; // NONE | BULL_CROSS | BEAR_CROSS
  if (prevDiff <= 0 && currDiff > 0) cross = 'BULL_CROSS';
  else if (prevDiff >= 0 && currDiff < 0) cross = 'BEAR_CROSS';

  // Count bars since last crossover (lookback up to 30)
  let crossBars = 30; // default: no recent cross
  for (let i = len - 2; i >= Math.max(slowPeriod, len - 30); i--) {
    const pf = ema8[i - 1];
    const ps = ema21[i - 1];
    const cf = ema8[i];
    const cs = ema21[i];
    if (pf === null || ps === null || cf === null || cs === null) continue;

    const pd = pf - ps;
    const cd = cf - cs;
    if ((pd <= 0 && cd > 0) || (pd >= 0 && cd < 0)) {
      crossBars = len - 1 - i;
      break;
    }
  }

  return {
    ema8: fast,
    ema21: slow,
    distance,          // Absolute: EMA8 - EMA21
    distancePct,       // As % of price (e.g. 0.05 = 0.05%)
    cross,             // 'NONE' | 'BULL_CROSS' | 'BEAR_CROSS'
    crossBars,         // Bars since last crossover
    bullish: fast > slow, // Simple trend direction
  };
}