/**
 * ═══ Orderbook Signal Engine ═══
 *
 * Uses Polymarket CLOB orderbook data to detect market sentiment.
 * The orderbook tells us what REAL MONEY thinks, not just indicators.
 *
 * Signals:
 * 1. Bid/Ask Imbalance — more bid liquidity on UP = market expects UP
 * 2. Spread analysis — tight spread = high confidence, wide = uncertainty
 * 3. Price movement direction — are traders pushing bid up or ask down?
 *
 * This is weight +2 in the scoring system.
 */

/**
 * Analyze orderbook for directional signal.
 *
 * @param {Object} params
 * @param {Object|null} params.orderbookUp - { bestBid, bestAsk, spread, bidLiquidity, askLiquidity }
 * @param {Object|null} params.orderbookDown - same structure
 * @param {number|null} params.marketUp - current UP token mid price
 * @param {number|null} params.marketDown - current DOWN token mid price
 * @returns {{ signal: string, weight: number, imbalance: number|null, spreadHealth: string, detail: string }}
 */
export function analyzeOrderbook({ orderbookUp, orderbookDown, marketUp, marketDown }) {
  const result = {
    signal: 'NEUTRAL',
    weight: 0,
    imbalance: null,
    spreadHealth: 'unknown',
    detail: 'No orderbook data',
  };

  if (!orderbookUp || !orderbookDown) return result;

  const upBidLiq = orderbookUp.bidLiquidity ?? 0;
  const upAskLiq = orderbookUp.askLiquidity ?? 0;
  const downBidLiq = orderbookDown.bidLiquidity ?? 0;
  const downAskLiq = orderbookDown.askLiquidity ?? 0;

  // ═══ 1. BID/ASK IMBALANCE ═══
  // If UP token has more bids than asks → people want to BUY UP → bullish
  // If DOWN token has more bids than asks → people want to BUY DOWN → bearish
  //
  // Imbalance = (UP bid pressure) - (DOWN bid pressure)
  // Where bid pressure = bidLiq / (bidLiq + askLiq)

  const upTotal = upBidLiq + upAskLiq;
  const downTotal = downBidLiq + downAskLiq;

  if (upTotal < 1 || downTotal < 1) {
    result.detail = upTotal < 1 && downTotal < 1 ? 'Orderbook empty' : 'One side empty';
    return result;
  }

  const upBidPressure = upTotal > 0 ? upBidLiq / upTotal : 0.5;
  const downBidPressure = downTotal > 0 ? downBidLiq / downTotal : 0.5;

  // Imbalance: positive = bullish, negative = bearish
  // Range: roughly -1 to +1
  const imbalance = upBidPressure - downBidPressure;
  result.imbalance = imbalance;

  // ═══ 2. SPREAD HEALTH ═══
  const upSpread = orderbookUp.spread ?? null;
  const downSpread = orderbookDown.spread ?? null;

  if (upSpread !== null && downSpread !== null) {
    const avgSpread = (upSpread + downSpread) / 2;
    if (avgSpread < 0.02) {
      result.spreadHealth = 'tight';  // High confidence market
    } else if (avgSpread < 0.05) {
      result.spreadHealth = 'normal';
    } else {
      result.spreadHealth = 'wide';   // Low confidence, uncertain
    }
  }

  // ═══ 3. PRICE-BASED SIGNAL ═══
  // If marketUp > 0.55, market already leans UP
  // Combined with orderbook imbalance for stronger signal
  let priceSignal = 0;
  if (marketUp !== null && marketDown !== null) {
    priceSignal = marketUp - marketDown;  // >0 = market leans UP
  }

  // ═══ COMBINE: Imbalance + Price Signal ═══
  // Both agree → strong signal
  // Disagree → weak/neutral
  // Use continuous price signal scaled to [-0.4, 0.4] instead of step function
  const clampedPriceSignal = Math.max(-0.4, Math.min(0.4, priceSignal * 0.8));
  const combinedScore = imbalance * 0.6 + clampedPriceSignal;

  if (combinedScore > 0.15) {
    result.signal = 'UP';
    result.weight = combinedScore > 0.3 ? 2 : 1;
    result.detail = `Bullish: imbalance ${(imbalance * 100).toFixed(1)}%, spread ${result.spreadHealth}`;
  } else if (combinedScore < -0.15) {
    result.signal = 'DOWN';
    result.weight = combinedScore < -0.3 ? 2 : 1;
    result.detail = `Bearish: imbalance ${(imbalance * 100).toFixed(1)}%, spread ${result.spreadHealth}`;
  } else {
    result.signal = 'NEUTRAL';
    result.weight = 0;
    result.detail = `Balanced: imbalance ${(imbalance * 100).toFixed(1)}%, spread ${result.spreadHealth}`;
  }

  // Wide spread reduces confidence
  if (result.spreadHealth === 'wide' && result.weight > 0) {
    result.weight = Math.max(0, result.weight - 1);
    result.detail += ' (spread penalty)';
  }

  return result;
}