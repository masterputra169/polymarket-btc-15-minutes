/**
 * Average True Range (ATR)
 *
 * Measures volatility context — normalizes price movements.
 * A $100 move means very different things when ATR=$50 vs ATR=$300.
 *
 * - ATR: absolute value in dollars
 * - ATR%: normalized (ATR / price) for cross-timeframe comparison
 * - ATR Ratio: current ATR vs longer-term average → expanding or contracting vol
 */

/**
 * Compute ATR for the last period.
 * @param {Array<{high:number, low:number, close:number}>} candles - OHLC candles
 * @param {number} period - ATR period (default 14)
 * @returns {{ atr, atrPct, atrRatio, expanding } | null}
 */
export function computeATR(candles, period = 14) {
  if (!candles || candles.length < period + 1) return null;

  const len = candles.length;

  // True Range for each candle
  const trValues = [];
  for (let i = 1; i < len; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;

    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    trValues.push(tr);
  }

  if (trValues.length < period) return null;

  // ATR: simple average of last `period` TRs
  // NOTE: This is SMA, not Wilder's smoothing. Training data uses the same SMA,
  // so both are consistent. Changing to Wilder's requires retraining the model.
  const trLen = trValues.length;
  let atr = 0;
  for (let i = trLen - period; i < trLen; i++) atr += trValues[i];
  atr /= period;

  const price = candles[len - 1].close;

  // ATR as percentage of price
  const atrPct = price > 0 ? (atr / price) * 100 : 0;

  // ATR Ratio: current ATR vs longer-term ATR (2x period)
  const longPeriod = Math.min(period * 2, trValues.length);
  let longAtr = 0;
  for (let i = trLen - longPeriod; i < trLen; i++) longAtr += trValues[i];
  longAtr /= longPeriod;

  const atrRatio = longAtr > 0 ? atr / longAtr : 1;
  const expanding = atrRatio > 1.1; // Volatility expanding if 10% above average

  return {
    atr,                  // Absolute ATR in dollars
    atrPct,               // ATR as % of price (e.g. 0.15 = 0.15%)
    atrRatio,             // Current vs long-term (>1 = expanding, <1 = contracting)
    expanding,            // Boolean: volatility is expanding
  };
}