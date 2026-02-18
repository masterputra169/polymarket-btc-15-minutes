/**
 * RSI (Relative Strength Index) indicator.
 * Reworked: period 8 for faster 15-minute responsiveness.
 */

// Re-export shared math from single source of truth
export { sma, slopeLast } from './math.js';

/**
 * Compute RSI using Wilder's smoothing method.
 *
 * RSI SMOOTHING FIX: Previously only used the last (period+1) closes with SMA
 * (no exponential smoothing), while computeRsiSeries() applied full Wilder
 * smoothing — causing a spot vs series mismatch. Now uses all available data
 * with Wilder's smoothing to match the series calculation exactly.
 *
 * @param {number[]} closes - array of close prices
 * @param {number} period - RSI period (default 8)
 * @returns {number|null} RSI value 0-100, or null if insufficient data
 */
export function computeRsi(closes, period = 8) {
  if (!closes || closes.length < period + 1) return null;

  let avgGain = 0;
  let avgLoss = 0;

  // Initial SMA seed over first `period` changes
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) avgGain += change;
    else avgLoss += Math.abs(change);
  }

  avgGain /= period;
  avgLoss /= period;

  // Apply Wilder's exponential smoothing for all subsequent data points
  // (matching computeRsiSeries exactly)
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgGain === 0 && avgLoss === 0) return 50;
  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * Compute full RSI series for an array of closes.
 * Uses Wilder's smoothing (exponential).
 * @param {number[]} closes
 * @param {number} period
 * @returns {number[]} RSI series (shorter than input by `period`)
 */
export function computeRsiSeries(closes, period = 8) {
  if (!closes || closes.length < period + 1) return [];

  const series = [];
  let avgGain = 0;
  let avgLoss = 0;

  // Seed
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) avgGain += change;
    else avgLoss += Math.abs(change);
  }
  avgGain /= period;
  avgLoss /= period;

  series.push(avgGain === 0 && avgLoss === 0 ? 50 : avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));

  // Wilder smoothing
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;

    series.push(avgGain === 0 && avgLoss === 0 ? 50 : avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  }

  return series;
}