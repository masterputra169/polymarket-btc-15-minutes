/**
 * Volume Delta — Buy/Sell Pressure Analysis
 *
 * Uses Binance's `takerBuyBaseAssetVolume` from kline data.
 * Taker buy = aggressive buyers lifting asks → bullish pressure
 * Taker sell = total volume - taker buy → bearish pressure
 *
 * Metrics:
 * - buyRatio: taker buy / total volume (0-1, >0.5 = buy-dominant)
 * - netDeltaPct: (buy - sell) / total as percentage
 * - deltaAccel: rate of change of buy ratio (momentum of pressure shift)
 * - cumDelta: cumulative delta over lookback (persistent pressure direction)
 */

export interface VolumeCandle {
  volume: number;
  takerBuyVolume?: number | null;
}

export interface VolumeDeltaResult {
  buyRatio: number;
  sellRatio: number;
  netDeltaPct: number;
  deltaAccel: number;
  cumDelta: number;
  buyDominant: boolean;
}

/**
 * Compute volume delta metrics from candles.
 * @param {Array<{volume:number, takerBuyVolume?:number}>} candles - OHLCV candles
 * @param {number} recentLookback - Candles for recent metrics (default 10)
 * @param {number} accelLookback - Candles for acceleration calc (default 20)
 * @returns {{ buyRatio, sellRatio, netDeltaPct, deltaAccel, cumDelta, buyDominant } | null}
 */
export function computeVolumeDelta(
  candles: VolumeCandle[] | null | undefined,
  recentLookback = 10,
  accelLookback = 20
): VolumeDeltaResult | null {
  if (!candles || candles.length < recentLookback) return null;

  // Check if takerBuyVolume is available
  const len = candles.length;
  const lastCandle = candles[len - 1];
  if (lastCandle.takerBuyVolume === undefined || lastCandle.takerBuyVolume === null) {
    return null; // Data not available — binance.ts needs to parse field [9]
  }

  // Recent buy ratio (last `recentLookback` candles)
  let recentBuyVol = 0;
  let recentTotalVol = 0;
  const rStart = len - recentLookback;
  for (let i = rStart; i < len; i++) {
    recentBuyVol += candles[i].takerBuyVolume || 0;
    recentTotalVol += candles[i].volume || 0;
  }

  const buyRatio = recentTotalVol > 0 ? recentBuyVol / recentTotalVol : 0.5;
  const sellRatio = 1 - buyRatio;

  // Net delta as percentage: (buy - sell) / total × 100
  const netDeltaPct = recentTotalVol > 0
    ? ((recentBuyVol - (recentTotalVol - recentBuyVol)) / recentTotalVol) * 100
    : 0;

  // Delta acceleration: compare recent buyRatio vs older buyRatio
  let deltaAccel = 0;
  if (len >= accelLookback) {
    let olderBuyVol = 0;
    let olderTotalVol = 0;
    const oStart = len - accelLookback;
    const oEnd = len - recentLookback;
    for (let i = oStart; i < oEnd; i++) {
      olderBuyVol += candles[i].takerBuyVolume || 0;
      olderTotalVol += candles[i].volume || 0;
    }
    const olderBuyRatio = olderTotalVol > 0 ? olderBuyVol / olderTotalVol : 0.5;
    deltaAccel = buyRatio - olderBuyRatio; // positive = buying accelerating
  }

  // Cumulative delta (last accelLookback candles) — net BTC bought
  let cumDelta = 0;
  const cStart = Math.max(0, len - accelLookback);
  for (let i = cStart; i < len; i++) {
    const buy = candles[i].takerBuyVolume || 0;
    const sell = (candles[i].volume || 0) - buy;
    cumDelta += (buy - sell);
  }

  return {
    buyRatio,        // 0-1 (>0.5 = buyers dominating)
    sellRatio,       // 0-1 (>0.5 = sellers dominating)
    netDeltaPct,     // -100 to +100 (net pressure %)
    deltaAccel,      // Change in buy ratio (momentum)
    cumDelta,        // Cumulative net BTC delta
    buyDominant: buyRatio > 0.52, // Slight threshold for significance
  };
}
