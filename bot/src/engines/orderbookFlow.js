/**
 * Orderbook flow tracker — tracks imbalance changes over time.
 *
 * Instead of just a snapshot of current imbalance, this tracks:
 * 1. Imbalance delta (change over last N samples) — directional pressure
 * 2. Imbalance trend (accelerating or decelerating) — momentum of flow
 * 3. Bid/ask depth ratio trend — who's getting more aggressive
 *
 * These are more predictive than raw imbalance snapshots because they
 * capture the RATE OF CHANGE of order flow, not just the level.
 */

const HISTORY_SIZE = 30;    // ~60s at 2s poll interval
const DELTA_LOOKBACK = 10;  // compare current vs 10 samples ago (~20s)

// Ring buffers for imbalance history
const imbalanceHistory = new Float64Array(HISTORY_SIZE);
const depthRatioHistory = new Float64Array(HISTORY_SIZE);
let histIdx = 0;
let histCount = 0;

/**
 * Record a new orderbook snapshot.
 * @param {Object} orderbookSignal - from analyzeOrderbook()
 * @param {Object|null} orderbookUp - { bestBid, bestAsk, bidDepth, askDepth, spread }
 * @param {Object|null} orderbookDown
 */
export function recordOrderbookSnapshot(orderbookSignal, orderbookUp, orderbookDown) {
  // Imbalance: positive = more buying pressure on UP side
  const imbalance = orderbookSignal?.imbalance ?? 0;
  imbalanceHistory[histIdx] = imbalance;

  // Depth ratio: bidDepth / askDepth for UP side (>1 = buyers deeper)
  const bidDepth = orderbookUp?.bidDepth ?? 0;
  const askDepth = orderbookUp?.askDepth ?? 0;
  const depthRatio = askDepth > 0 ? bidDepth / askDepth : 1;
  depthRatioHistory[histIdx] = depthRatio;

  histIdx = (histIdx + 1) % HISTORY_SIZE;
  if (histCount < HISTORY_SIZE) histCount++;
}

/**
 * Get orderbook flow analysis.
 * @returns {{ imbalanceDelta, imbalanceTrend, depthRatioTrend, flowSignal, sampleCount }}
 */
export function getOrderbookFlow() {
  if (histCount < 3) {
    return {
      imbalanceDelta: 0,
      imbalanceTrend: 0,
      depthRatioTrend: 0,
      flowSignal: 'NEUTRAL',
      sampleCount: histCount,
    };
  }

  // Current imbalance (latest)
  const currentIdx = (histIdx - 1 + HISTORY_SIZE) % HISTORY_SIZE;
  const current = imbalanceHistory[currentIdx];

  // Past imbalance (DELTA_LOOKBACK ago)
  const lookback = Math.min(DELTA_LOOKBACK, histCount - 1);
  const pastIdx = (histIdx - 1 - lookback + HISTORY_SIZE) % HISTORY_SIZE;
  const past = imbalanceHistory[pastIdx];

  // Imbalance delta: positive = flow shifting toward buying
  const imbalanceDelta = current - past;

  // Imbalance trend: acceleration (is delta increasing or decreasing?)
  let imbalanceTrend = 0;
  if (histCount >= DELTA_LOOKBACK + 3) {
    const midIdx = (histIdx - 1 - Math.floor(lookback / 2) + HISTORY_SIZE) % HISTORY_SIZE;
    const mid = imbalanceHistory[midIdx];
    const firstHalf = mid - past;
    const secondHalf = current - mid;
    imbalanceTrend = secondHalf - firstHalf; // positive = accelerating toward buying
  }

  // Depth ratio trend
  const currentDepth = depthRatioHistory[currentIdx];
  const pastDepth = depthRatioHistory[pastIdx];
  const depthRatioTrend = currentDepth - pastDepth;

  // Flow signal: combine delta + trend
  let flowSignal = 'NEUTRAL';
  if (imbalanceDelta > 0.1 && imbalanceTrend > 0) flowSignal = 'STRONG_BUY';
  else if (imbalanceDelta > 0.05) flowSignal = 'BUY';
  else if (imbalanceDelta < -0.1 && imbalanceTrend < 0) flowSignal = 'STRONG_SELL';
  else if (imbalanceDelta < -0.05) flowSignal = 'SELL';

  return {
    imbalanceDelta: Math.round(imbalanceDelta * 1000) / 1000,
    imbalanceTrend: Math.round(imbalanceTrend * 1000) / 1000,
    depthRatioTrend: Math.round(depthRatioTrend * 1000) / 1000,
    flowSignal,
    sampleCount: histCount,
  };
}

/**
 * Check if orderbook flow AGREES with proposed trade side.
 * Used as additional confidence filter.
 * @param {string} side - 'UP' or 'DOWN'
 * @returns {{ agrees: boolean, signal: string, strength: number }}
 */
export function checkFlowAlignment(side) {
  const flow = getOrderbookFlow();

  if (flow.sampleCount < 5) {
    return { agrees: true, signal: 'INSUFFICIENT_DATA', strength: 0 };
  }

  const buyFlow = flow.imbalanceDelta > 0;
  const agrees = (side === 'UP' && buyFlow) || (side === 'DOWN' && !buyFlow);

  // Strength: 0-1 scale
  const strength = Math.min(Math.abs(flow.imbalanceDelta) * 5, 1);

  return {
    agrees,
    signal: flow.flowSignal,
    strength: Math.round(strength * 100) / 100,
  };
}

/**
 * Reset flow history (on market switch).
 */
export function resetFlow() {
  imbalanceHistory.fill(0);
  depthRatioHistory.fill(0);
  histIdx = 0;
  histCount = 0;
}
