/**
 * Shared indicator math utilities.
 * Single source of truth for SMA, EMA, and slope calculations.
 */

/**
 * Simple moving average of last N values.
 */
export function sma(arr, period) {
  if (!arr || arr.length < period) return null;
  const slice = arr.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

/**
 * Slope of the last N values (linear regression-ish).
 * Returns change per step. Positive = rising.
 */
export function slopeLast(arr, n = 3) {
  if (!arr || arr.length < n) return null;
  const slice = arr.slice(-n);
  return (slice[slice.length - 1] - slice[0]) / (n - 1);
}

/**
 * Full EMA series, seeded from data[0] (no null padding).
 * Used by MACD where we need EMA from the very first value.
 */
export function emaFull(data, period) {
  if (!data || data.length === 0) return [];
  const k = 2 / (period + 1);
  const result = [data[0]];
  for (let i = 1; i < data.length; i++) {
    result.push(data[i] * k + result[i - 1] * (1 - k));
  }
  return result;
}

/**
 * EMA series, SMA-seeded with null padding for initial values.
 * Used by EMA crossover where alignment with price array matters.
 */
export function emaSeries(data, period) {
  if (!data || data.length < period) return [];

  const k = 2 / (period + 1);
  const result = new Array(data.length);

  // Seed with SMA of first `period` values
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += data[i];
    result[i] = null;
  }
  result[period - 1] = sum / period;

  // EMA from period onwards
  for (let i = period; i < data.length; i++) {
    result[i] = data[i] * k + result[i - 1] * (1 - k);
  }

  return result;
}
