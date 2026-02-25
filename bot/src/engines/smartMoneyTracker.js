/**
 * Smart Money Flow Tracker — time-windowed CLOB flow analysis.
 *
 * Based on analysis of 11,665 Polymarket BTC 15m markets:
 * - EARLY flow (0-5 min elapsed) has 82.8% predictive accuracy
 * - Volume-filtered ($500+) flow has 79.4% accuracy
 * - LATE flow (10-15 min elapsed) is near random (56.3%)
 * - Smart money is 70% sellers (sell UP token early, buy late)
 *
 * Tracks real-time orderbook imbalance changes segmented by time window,
 * weighting early flow heavily and discounting late flow.
 *
 * Integration: called each poll from loop.js with orderbookFlow data.
 * Output consumed by edge.js, tradePipeline.js, and asymmetricBet.js.
 */

import { createLogger } from '../logger.js';

const log = createLogger('SmartFlow');

// Window weights derived from historical accuracy:
// EARLY: 82.8% → weight 3.0 (dominant signal)
// MID:   ~70%  → weight 1.0 (moderate)
// LATE:  56.3% → weight 0.3 (near random, mostly noise)
const WINDOW_WEIGHTS = {
  EARLY: 3.0,
  MID: 1.0,
  LATE: 0.3,
};

// Minimum accumulated magnitude to trust the signal
const MIN_FLOW_MAGNITUDE = 0.08;

// Minimum early samples before signal is considered valid
const MIN_EARLY_SAMPLES = 3;

// State per market (reset on slug change)
let state = {
  marketSlug: null,
  earlyFlow: 0,       // accumulated imbalance delta in EARLY window
  midFlow: 0,         // accumulated in MID window
  lateFlow: 0,        // accumulated in LATE window
  sampleCount: 0,
  earlyCount: 0,
  midCount: 0,
  lateCount: 0,
  // Price-based flow: track market price movement direction
  priceFlowUp: 0,     // count of polls where UP price increased
  priceFlowDown: 0,   // count of polls where UP price decreased
  lastUpPrice: null,   // previous UP token price
};

/**
 * Determine time window from remaining minutes.
 * timeLeftMin: countdown from ~15 to 0.
 *   > 10 min left = 0-5 min elapsed = EARLY
 *   5-10 min left = 5-10 min elapsed = MID
 *   < 5 min left  = 10-15 min elapsed = LATE
 */
function getTimeWindow(timeLeftMin) {
  if (timeLeftMin > 10) return 'EARLY';
  if (timeLeftMin > 5) return 'MID';
  return 'LATE';
}

/**
 * Update smart money flow with current poll data.
 *
 * @param {Object} params
 * @param {string} params.marketSlug - Current market slug
 * @param {number} params.timeLeftMin - Minutes remaining in market
 * @param {number} params.imbalanceDelta - From orderbookFlow (change in imbalance)
 * @param {string} params.flowSignal - From orderbookFlow (BUY/SELL/NEUTRAL)
 * @param {number|null} params.marketUpPrice - Current UP token price
 */
export function updateSmartFlow({ marketSlug, timeLeftMin, imbalanceDelta, flowSignal, marketUpPrice }) {
  // Reset on market switch
  if (marketSlug !== state.marketSlug) {
    if (state.marketSlug) {
      log.debug(
        `Market switch: ${state.marketSlug} → ${marketSlug} | ` +
        `Final flow: E=${state.earlyFlow.toFixed(3)}(${state.earlyCount}) ` +
        `M=${state.midFlow.toFixed(3)}(${state.midCount}) ` +
        `L=${state.lateFlow.toFixed(3)}(${state.lateCount})`
      );
    }
    state = {
      marketSlug,
      earlyFlow: 0,
      midFlow: 0,
      lateFlow: 0,
      sampleCount: 0,
      earlyCount: 0,
      midCount: 0,
      lateCount: 0,
      priceFlowUp: 0,
      priceFlowDown: 0,
      lastUpPrice: null,
    };
  }

  // Track price-based flow direction
  if (marketUpPrice != null && Number.isFinite(marketUpPrice)) {
    if (state.lastUpPrice !== null) {
      const priceDelta = marketUpPrice - state.lastUpPrice;
      if (priceDelta > 0.001) state.priceFlowUp++;
      else if (priceDelta < -0.001) state.priceFlowDown++;
    }
    state.lastUpPrice = marketUpPrice;
  }

  if (!Number.isFinite(imbalanceDelta)) return;

  const window = getTimeWindow(timeLeftMin);
  state.sampleCount++;

  switch (window) {
    case 'EARLY':
      state.earlyFlow += imbalanceDelta;
      state.earlyCount++;
      break;
    case 'MID':
      state.midFlow += imbalanceDelta;
      state.midCount++;
      break;
    case 'LATE':
      state.lateFlow += imbalanceDelta;
      state.lateCount++;
      break;
  }
}

/**
 * Get smart money flow signal for current market.
 *
 * @returns {{
 *   direction: 'UP'|'DOWN'|'NEUTRAL',
 *   strength: number,       // 0-1
 *   confidence: number,     // 0-1
 *   earlyFlow: number,
 *   midFlow: number,
 *   lateFlow: number,
 *   weightedFlow: number,
 *   window: string,
 *   sampleCount: number,
 *   agreesWithSide: function(string): boolean,
 * }}
 */
export function getSmartFlowSignal() {
  const insufficientResult = {
    direction: 'NEUTRAL',
    strength: 0,
    confidence: 0,
    earlyFlow: 0,
    midFlow: 0,
    lateFlow: 0,
    weightedFlow: 0,
    window: 'INSUFFICIENT',
    sampleCount: state.sampleCount,
    agreesWithSide: () => true, // insufficient data = don't block
  };

  // Need minimum samples to make a call
  if (state.sampleCount < MIN_EARLY_SAMPLES) {
    return insufficientResult;
  }

  // M1 audit fix: Normalize by sample count per window before weighting.
  // Previously earlyFlow accumulated per-poll — at 50ms vs 700ms poll, magnitude changed ~14x.
  // Now we compute average flow per sample per window, then weight by accuracy-based weights.
  const avgEarly = state.earlyCount > 0 ? state.earlyFlow / state.earlyCount : 0;
  const avgMid = state.midCount > 0 ? state.midFlow / state.midCount : 0;
  const avgLate = state.lateCount > 0 ? state.lateFlow / state.lateCount : 0;

  const weighted =
    avgEarly * WINDOW_WEIGHTS.EARLY +
    avgMid * WINDOW_WEIGHTS.MID +
    avgLate * WINDOW_WEIGHTS.LATE;

  const totalWeight =
    (state.earlyCount > 0 ? WINDOW_WEIGHTS.EARLY : 0) +
    (state.midCount > 0 ? WINDOW_WEIGHTS.MID : 0) +
    (state.lateCount > 0 ? WINDOW_WEIGHTS.LATE : 0);

  const normalizedFlow = totalWeight > 0 ? weighted / totalWeight : 0;

  // Strength: 0-1 based on absolute magnitude of normalized flow
  const strength = Math.min(Math.abs(normalizedFlow) / 0.30, 1.0);

  // Confidence: higher when more early data and stronger signal
  const earlyConfidence = Math.min(state.earlyCount / 5, 1.0);
  const confidence = Math.round(earlyConfidence * Math.max(strength, 0.1) * 100) / 100;

  // Direction: only declare if above minimum magnitude
  let direction = 'NEUTRAL';
  if (Math.abs(normalizedFlow) >= MIN_FLOW_MAGNITUDE) {
    direction = normalizedFlow > 0 ? 'UP' : 'DOWN';
  }

  // Combine with price flow for validation
  // If orderbook flow and price flow agree, boost confidence
  const priceDirection = state.priceFlowUp > state.priceFlowDown ? 'UP'
    : state.priceFlowDown > state.priceFlowUp ? 'DOWN' : 'NEUTRAL';
  const priceAgrees = direction !== 'NEUTRAL' && direction === priceDirection;

  // Current active window
  const window = state.lateCount > 0 ? 'LATE'
    : state.midCount > 0 ? 'MID' : 'EARLY';

  const finalConfidence = priceAgrees ? Math.min(confidence * 1.3, 1.0) : confidence;

  const result = {
    direction,
    strength: Math.round(strength * 100) / 100,
    confidence: Math.round(finalConfidence * 100) / 100,
    earlyFlow: Math.round(state.earlyFlow * 1000) / 1000,
    midFlow: Math.round(state.midFlow * 1000) / 1000,
    lateFlow: Math.round(state.lateFlow * 1000) / 1000,
    weightedFlow: Math.round(normalizedFlow * 1000) / 1000,
    window,
    sampleCount: state.sampleCount,
    priceFlowAgrees: priceAgrees,
    agreesWithSide: (side) => {
      if (direction === 'NEUTRAL') return true; // neutral = don't block
      return direction === side;
    },
  };

  return result;
}

/**
 * Get the optimal entry timing score based on elapsed time.
 * Smart money data shows 3-7 min elapsed is the sweet spot.
 *
 * @param {number} timeLeftMin - Minutes remaining
 * @returns {{ score: number, label: string, inSweetSpot: boolean }}
 */
export function getEntryTimingScore(timeLeftMin) {
  const elapsed = 15 - timeLeftMin;

  // Sweet spot: 3-7 min elapsed (timeLeftMin 8-12)
  if (elapsed >= 3 && elapsed <= 7) {
    return { score: 1.15, label: 'sweet_spot', inSweetSpot: true };
  }
  // Good: 2-3 min or 7-10 min elapsed
  if (elapsed >= 2 && elapsed <= 10) {
    return { score: 1.0, label: 'normal', inSweetSpot: false };
  }
  // Too early: < 2 min elapsed (prices still settling)
  if (elapsed < 2) {
    return { score: 0.85, label: 'too_early', inSweetSpot: false };
  }
  // Late: > 10 min elapsed (signal degraded, prices expensive)
  if (elapsed > 12) {
    return { score: 0.70, label: 'very_late', inSweetSpot: false };
  }
  return { score: 0.80, label: 'late', inSweetSpot: false };
}

/**
 * Reset tracker state (on market switch from external caller).
 */
export function resetSmartFlow() {
  state = {
    marketSlug: null,
    earlyFlow: 0,
    midFlow: 0,
    lateFlow: 0,
    sampleCount: 0,
    earlyCount: 0,
    midCount: 0,
    lateCount: 0,
    priceFlowUp: 0,
    priceFlowDown: 0,
    lastUpPrice: null,
  };
}
