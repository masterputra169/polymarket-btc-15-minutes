/**
 * Pure function that computes all technical indicators from candle data.
 * Extracted from useMarketData.js to reduce its size.
 */

import { CONFIG } from '../config.js';
import { sma, slopeLast } from '../indicators/math.js';
import { computeVwapSeries, countVwapCrosses } from '../indicators/vwap.js';
import { computeRsi, computeRsiSeries } from '../indicators/rsi.js';
import { computeMacd } from '../indicators/macd.js';
import { computeHeikenAshi, countConsecutive } from '../indicators/heikenAshi.js';
import { computeBollingerBands } from '../indicators/bollinger.js';
import { computeATR } from '../indicators/atr.js';
import { computeVolumeDelta } from '../indicators/volumedelta.js';
import { computeEmaCrossover } from '../indicators/emacross.js';
import { computeStochRsi } from '../indicators/stochrsi.js';
import { detectRegime } from '../engines/regime.js';
import { computeMultiTfConfirmation } from '../engines/multitf.js';
import { getVolatilityProfile, computeRealizedVol } from '../engines/volatility.js';

/**
 * Compute all technical indicators from candle data.
 *
 * @param {Object} params
 * @param {Array} params.candles - 1m candles
 * @param {Array} params.klines5m - 5m candles
 * @param {number} params.lastPrice - Current BTC price
 * @returns {Object} All indicator results
 */
export function computeAllIndicators({ candles, klines5m, lastPrice }) {
  const cLen = candles.length;
  const closes = new Array(cLen);
  for (let i = 0; i < cLen; i++) closes[i] = candles[i].close;

  const c5Len = klines5m.length;
  const closes5m = new Array(c5Len);
  for (let i = 0; i < c5Len; i++) closes5m[i] = klines5m[i].close;

  // VWAP
  const vwapSeries = computeVwapSeries(candles, CONFIG.vwapLookbackCandles);
  const vwapNow = vwapSeries[vwapSeries.length - 1];
  const lookback = CONFIG.vwapSlopeLookbackMinutes;
  const vwapSlope =
    vwapSeries.length >= lookback
      ? (vwapNow - vwapSeries[vwapSeries.length - lookback]) / lookback
      : null;
  const vwapDist = vwapNow ? (lastPrice - vwapNow) / vwapNow : null;

  // RSI
  const rsiNow = computeRsi(closes, CONFIG.rsiPeriod);
  const rsiSeries = computeRsiSeries(closes, CONFIG.rsiPeriod);
  const rsiSlope = slopeLast(rsiSeries, 3);

  // MACD
  const macd = computeMacd(closes, CONFIG.macdFast, CONFIG.macdSlow, CONFIG.macdSignal);

  // Heiken Ashi
  const ha = computeHeikenAshi(candles);
  const consec = countConsecutive(ha);

  // VWAP crosses
  const vwapCrossCount = countVwapCrosses(closes, vwapSeries, 20);

  // Bollinger Bands + ATR
  const bb = computeBollingerBands(closes, 20, 2);
  const atr = computeATR(candles, 14);

  // Volume Delta
  const volDelta = computeVolumeDelta(candles, 10, 20);

  // EMA Crossover
  const emaCross = computeEmaCrossover(closes, 8, 21);

  // Stochastic RSI
  const stochRsi = computeStochRsi(closes, 14, 14, 3, 3);

  // Volume
  let volumeRecent = 0;
  const volRecentStart = Math.max(0, cLen - 20);
  for (let i = volRecentStart; i < cLen; i++) volumeRecent += candles[i].volume;

  let volumeTotal120 = 0;
  const volAvgStart = Math.max(0, cLen - 120);
  for (let i = volAvgStart; i < cLen; i++) volumeTotal120 += candles[i].volume;
  const volumeAvg = volumeTotal120 / 6;

  // Failed VWAP reclaim
  const failedVwapReclaim =
    vwapNow !== null && vwapSeries.length >= 3
      ? closes[cLen - 1] < vwapNow &&
        closes[cLen - 2] > vwapSeries[vwapSeries.length - 2]
      : false;

  // Regime
  const regimeInfo = detectRegime({
    price: lastPrice, vwap: vwapNow, vwapSlope, vwapCrossCount,
    volumeRecent, volumeAvg,
  });

  // Deltas
  const lastClose = closes[cLen - 1] ?? null;
  const close1mAgo = cLen >= 2 ? closes[cLen - 2] : null;
  const close3mAgo = cLen >= 4 ? closes[cLen - 4] : null;
  const delta1m = lastClose !== null && close1mAgo !== null ? lastClose - close1mAgo : null;
  const delta3m = lastClose !== null && close3mAgo !== null ? lastClose - close3mAgo : null;

  // Volatility
  const volProfile = getVolatilityProfile();
  const realizedVol = computeRealizedVol(closes, 15);

  // Multi-TF
  const delta5m = c5Len >= 2 ? closes5m[c5Len - 1] - closes5m[c5Len - 2] : null;
  const ha5m = computeHeikenAshi(klines5m);
  const consec5m = countConsecutive(ha5m);
  const rsi5m = computeRsi(closes5m, 8);

  const multiTfConfirm = computeMultiTfConfirmation({
    delta1m, delta3m, delta5m,
    ha1mColor: consec.color, ha5mColor: consec5m.color,
    rsi1m: rsiNow, rsi5m,
  });

  return {
    closes, vwapSeries, vwapNow, vwapSlope, vwapDist,
    rsiNow, rsiSlope, macd, consec, vwapCrossCount,
    bb, atr, volDelta, emaCross, stochRsi,
    volumeRecent, volumeAvg, failedVwapReclaim,
    regimeInfo, lastClose, delta1m, delta3m,
    volProfile, realizedVol, multiTfConfirm,
  };
}
