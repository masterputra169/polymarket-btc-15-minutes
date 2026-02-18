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
 * 4. Spoofing detection — time-weighted orderbook persistence analysis
 *
 * This is weight +2 in the scoring system.
 */

// ── Orderbook snapshot ring buffer for spoofing detection ──
const SPOOF_SNAPSHOT_COUNT = 5;   // Track last 5 snapshots (~3-5 seconds at 2s poll + WS updates)
const SPOOF_PERSISTENCE_THRESHOLD = 0.50; // If <50% of size persists, flag as potential spoof

const snapshotBuf = [];  // Array of { ts, upBidLiq, upAskLiq, downBidLiq, downAskLiq, upBestBid, upBestAsk, downBestBid, downBestAsk }

/**
 * Record a snapshot for spoofing detection.
 * Called internally from analyzeOrderbook on each evaluation.
 */
function recordSnapshot(orderbookUp, orderbookDown) {
  snapshotBuf.push({
    ts: Date.now(),
    upBidLiq: orderbookUp?.bidLiquidity ?? 0,
    upAskLiq: orderbookUp?.askLiquidity ?? 0,
    downBidLiq: orderbookDown?.bidLiquidity ?? 0,
    downAskLiq: orderbookDown?.askLiquidity ?? 0,
    upBestBid: orderbookUp?.bestBid ?? null,
    upBestAsk: orderbookUp?.bestAsk ?? null,
    downBestBid: orderbookDown?.bestBid ?? null,
    downBestAsk: orderbookDown?.bestAsk ?? null,
  });
  // Keep only last N snapshots
  if (snapshotBuf.length > SPOOF_SNAPSHOT_COUNT) {
    snapshotBuf.splice(0, snapshotBuf.length - SPOOF_SNAPSHOT_COUNT);
  }
}

/**
 * Compute spoofing risk score (0-1) based on orderbook persistence.
 * Compares current snapshot to recent history:
 * - If liquidity at best bid/ask is stable across snapshots → low spoof risk
 * - If liquidity appears and disappears rapidly → high spoof risk
 *
 * @returns {{ spoofRisk: number, persistence: number, detail: string }}
 */
function computeSpoofRisk() {
  if (snapshotBuf.length < 3) {
    return { spoofRisk: 0, persistence: 1.0, detail: 'insufficient_snapshots' };
  }

  const current = snapshotBuf[snapshotBuf.length - 1];
  let totalPersistence = 0;
  let comparisons = 0;

  // Compare current snapshot to each previous snapshot
  for (let i = 0; i < snapshotBuf.length - 1; i++) {
    const prev = snapshotBuf[i];

    // For each side (up bid, up ask, down bid, down ask), compute persistence ratio
    // Persistence = min(current, prev) / max(current, prev)
    // If sizes are similar → persistence ~1. If one was large and disappeared → persistence ~0.
    const pairs = [
      [current.upBidLiq, prev.upBidLiq],
      [current.upAskLiq, prev.upAskLiq],
      [current.downBidLiq, prev.downBidLiq],
      [current.downAskLiq, prev.downAskLiq],
    ];

    for (const [curr, pre] of pairs) {
      const maxVal = Math.max(curr, pre);
      if (maxVal > 0) {
        totalPersistence += Math.min(curr, pre) / maxVal;
        comparisons++;
      }
    }
  }

  const persistence = comparisons > 0 ? totalPersistence / comparisons : 1.0;
  // spoofRisk: 0 = no spoofing, 1 = high spoofing
  // Below threshold = risky. Map persistence linearly to risk.
  const spoofRisk = Math.max(0, Math.min(1, 1 - persistence));

  const detail = persistence < SPOOF_PERSISTENCE_THRESHOLD
    ? `spoof_detected_${(persistence * 100).toFixed(0)}%`
    : `normal_${(persistence * 100).toFixed(0)}%`;

  return { spoofRisk, persistence, detail };
}

/**
 * Analyze orderbook for directional signal.
 *
 * @param {Object} params
 * @param {Object|null} params.orderbookUp - { bestBid, bestAsk, spread, bidLiquidity, askLiquidity }
 * @param {Object|null} params.orderbookDown - same structure
 * @param {number|null} params.marketUp - current UP token mid price
 * @param {number|null} params.marketDown - current DOWN token mid price
 * @returns {{ signal: string, weight: number, imbalance: number|null, spreadHealth: string, detail: string, spoofRisk: number }}
 */
export function analyzeOrderbook({ orderbookUp, orderbookDown, marketUp, marketDown }) {
  const result = {
    signal: 'NEUTRAL',
    weight: 0,
    imbalance: null,
    spreadHealth: 'unknown',
    detail: 'No orderbook data',
    spoofRisk: 0,
  };

  if (!orderbookUp || !orderbookDown) return result;

  // Record snapshot for spoofing detection
  recordSnapshot(orderbookUp, orderbookDown);

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

  const upBidPressure = upBidLiq / upTotal;
  const downBidPressure = downBidLiq / downTotal;

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

  // ═══ 4. SPOOFING DETECTION ═══
  // Check if orderbook sizes persist across snapshots
  const spoof = computeSpoofRisk();
  result.spoofRisk = spoof.spoofRisk;

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

  // Spoofing penalty — reduce signal weight when persistence is low
  if (spoof.spoofRisk > 0.5 && result.weight > 0) {
    result.weight = Math.max(0, result.weight - 1);
    result.detail += ` (spoof risk ${(spoof.spoofRisk * 100).toFixed(0)}%)`;
  }

  return result;
}