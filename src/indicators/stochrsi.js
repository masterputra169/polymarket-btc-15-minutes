/**
 * Stochastic RSI (StochRSI) Indicator
 *
 * StochRSI applies Stochastic oscillator formula to RSI values.
 * More sensitive than regular RSI — catches overbought/oversold faster.
 *
 * Formula:
 *   RSI series → find min/max over lookback → normalize to 0-100
 *   %K = SMA(StochRSI, smoothK)
 *   %D = SMA(%K, smoothD)
 *
 * Signals for 15-min BTC:
 *   %K > 80: overbought → potential reversal DOWN
 *   %K < 20: oversold → potential reversal UP
 *   %K crosses above %D: bullish
 *   %K crosses below %D: bearish
 *
 * Parameters: RSI period=14, Stoch lookback=14, smoothK=3, smoothD=3
 */

import { computeRsiSeries } from './rsi.js';

/**
 * Compute Stochastic RSI.
 * @param {number[]} closes - Array of closing prices
 * @param {number} rsiPeriod - RSI calculation period (default 14)
 * @param {number} stochPeriod - Stochastic lookback on RSI (default 14)
 * @param {number} smoothK - %K smoothing period (default 3)
 * @param {number} smoothD - %D smoothing period (default 3)
 * @returns {{ k: number, d: number, kPrev: number|null, crossUp: boolean, crossDown: boolean, zone: string } | null}
 */
export function computeStochRsi(closes, rsiPeriod = 14, stochPeriod = 14, smoothK = 3, smoothD = 3) {
  if (!closes || closes.length < rsiPeriod + stochPeriod + smoothK + smoothD) return null;

  // Step 1: Compute full RSI series
  const rsiSeries = computeRsiSeries(closes, rsiPeriod);
  if (rsiSeries.length < stochPeriod + smoothK + smoothD) return null;

  // Step 2: Apply Stochastic formula to RSI values
  const stochRaw = [];
  for (let i = stochPeriod - 1; i < rsiSeries.length; i++) {
    let minRsi = Infinity;
    let maxRsi = -Infinity;
    for (let j = i - stochPeriod + 1; j <= i; j++) {
      if (rsiSeries[j] < minRsi) minRsi = rsiSeries[j];
      if (rsiSeries[j] > maxRsi) maxRsi = rsiSeries[j];
    }
    const range = maxRsi - minRsi;
    const stochVal = range > 0 ? ((rsiSeries[i] - minRsi) / range) * 100 : 50;
    stochRaw.push(stochVal);
  }

  if (stochRaw.length < smoothK + smoothD) return null;

  // Step 3: Smooth %K = SMA of raw StochRSI
  const kValues = [];
  for (let i = smoothK - 1; i < stochRaw.length; i++) {
    let sum = 0;
    for (let j = i - smoothK + 1; j <= i; j++) sum += stochRaw[j];
    kValues.push(sum / smoothK);
  }

  if (kValues.length < smoothD + 1) return null;

  // Step 4: %D = SMA of %K
  const dValues = [];
  for (let i = smoothD - 1; i < kValues.length; i++) {
    let sum = 0;
    for (let j = i - smoothD + 1; j <= i; j++) sum += kValues[j];
    dValues.push(sum / smoothD);
  }

  if (dValues.length < 2) return null;

  // Current and previous values
  const kLen = kValues.length;
  const dLen = dValues.length;

  const k = kValues[kLen - 1];
  const d = dValues[dLen - 1];
  const kPrev = kLen >= 2 ? kValues[kLen - 2] : null;
  const dPrev = dLen >= 2 ? dValues[dLen - 2] : null;

  // Crossover detection
  let crossUp = false;
  let crossDown = false;
  if (kPrev !== null && dPrev !== null) {
    crossUp = kPrev <= dPrev && k > d;    // %K crosses above %D → bullish
    crossDown = kPrev >= dPrev && k < d;  // %K crosses below %D → bearish
  }

  // Zone detection
  let zone = 'NEUTRAL';
  if (k > 80) zone = 'OVERBOUGHT';
  else if (k < 20) zone = 'OVERSOLD';

  return {
    k,            // %K value (0-100)
    d,            // %D value (0-100)
    kPrev,        // Previous %K (for crossover)
    crossUp,      // %K crossed above %D
    crossDown,    // %K crossed below %D
    zone,         // OVERBOUGHT | OVERSOLD | NEUTRAL
  };
}

/**
 * Get StochRSI signal for scoring.
 * @param {number[]} closes
 * @returns {{ signal: string, k: number, d: number } | null}
 */
export function getStochRSISignal(closes) {
  const result = computeStochRsi(closes);
  if (!result) return null;

  let signal = 'NEUTRAL';
  if (result.k < 20 || result.crossUp) signal = 'BULLISH';
  else if (result.k > 80 || result.crossDown) signal = 'BEARISH';
  else if (result.k > 60) signal = 'LEAN_BULLISH';
  else if (result.k < 40) signal = 'LEAN_BEARISH';

  return { signal, k: result.k, d: result.d };
}