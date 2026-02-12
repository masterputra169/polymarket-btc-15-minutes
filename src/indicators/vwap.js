/**
 * VWAP (Volume-Weighted Average Price) indicator.
 * Reworked: supports configurable lookback for 15-minute market windows.
 */

/**
 * Compute cumulative VWAP series over given candles.
 * @param {Array} candles - [{high, low, close, volume}, ...]
 * @param {number} [lookback] - optional: only use last N candles
 * @returns {number[]} VWAP series (same length as input)
 */
export function computeVwapSeries(candles, lookback) {
  const src = lookback && lookback < candles.length
    ? candles.slice(-lookback)
    : candles;

  const series = [];
  let cumPV = 0;
  let cumVol = 0;

  for (const c of src) {
    const tp = (c.high + c.low + c.close) / 3;
    cumPV += tp * c.volume;
    cumVol += c.volume;
    series.push(cumVol > 0 ? cumPV / cumVol : tp);
  }

  // If we sliced, pad the front with nulls to match original length
  if (lookback && lookback < candles.length) {
    const pad = new Array(candles.length - lookback).fill(null);
    return [...pad, ...series];
  }

  return series;
}

/**
 * Count how many times price crosses VWAP in the last `lookback` candles.
 * @param {number[]} closes
 * @param {number[]} vwapSeries
 * @param {number} lookback
 * @returns {number|null}
 */
export function countVwapCrosses(closes, vwapSeries, lookback) {
  if (!closes || !vwapSeries || closes.length < 2 || vwapSeries.length < 2) return null;
  const cLen = closes.length;
  const vLen = vwapSeries.length;
  // Align from end of each array to handle different lengths
  const count = Math.min(lookback, cLen, vLen);
  if (count < 2) return null;
  let crosses = 0;
  for (let k = 1; k < count; k++) {
    const ci = cLen - count + k;
    const vi = vLen - count + k;
    const vPrev = vwapSeries[vi - 1];
    const vCur = vwapSeries[vi];
    if (vPrev == null || vCur == null) continue;
    const prev = closes[ci - 1] - vPrev;
    const cur = closes[ci] - vCur;
    if (prev === 0) continue;
    if ((prev > 0 && cur < 0) || (prev < 0 && cur > 0)) crosses += 1;
  }
  return crosses;
}

/**
 * Get the current session VWAP value.
 * @param {Array} candles
 * @param {number} [lookback]
 * @returns {number|null}
 */
export function computeSessionVwap(candles, lookback) {
  const series = computeVwapSeries(candles, lookback);
  for (let i = series.length - 1; i >= 0; i--) {
    if (series[i] !== null) return series[i];
  }
  return null;
}