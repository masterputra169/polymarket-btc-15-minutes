/**
 * MACD (Moving Average Convergence Divergence) indicator.
 * Reworked: 6/13/5 for 15-minute market windows on 1m candles.
 * Fast EMA responds in ~6 min, slow in ~13 min — both within market window.
 */

import { emaFull as ema } from './math.js';

/**
 * Compute MACD values.
 * @param {number[]} closes
 * @param {number} fast - fast EMA period (default 6)
 * @param {number} slow - slow EMA period (default 13)
 * @param {number} signal - signal period (default 5)
 * @returns {{ line: number, signal: number, hist: number, histDelta: number|null } | null}
 */
export function computeMacd(closes, fast = 6, slow = 13, signal = 5) {
  if (!closes || closes.length < slow + signal) return null;

  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);

  // MACD line = fastEMA - slowEMA
  const macdLine = emaFast.map((v, i) => v - emaSlow[i]);

  // Signal line = EMA of MACD line
  const signalLine = ema(macdLine, signal);

  const lastIdx = closes.length - 1;
  const prevIdx = lastIdx - 1;

  const line = macdLine[lastIdx];
  const sig = signalLine[lastIdx];
  const hist = line - sig;

  // Histogram delta (acceleration)
  const prevHist = prevIdx >= 0 ? macdLine[prevIdx] - signalLine[prevIdx] : null;
  const histDelta = prevHist !== null ? hist - prevHist : null;

  return { line, signal: sig, hist, histDelta };
}