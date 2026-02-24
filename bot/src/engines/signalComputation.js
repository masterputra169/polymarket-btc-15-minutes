/**
 * Signal computation pipeline — takes raw fetched data, returns all signal state.
 *
 * Owns: marketUpHistory ring buffer
 * Exports: computeSignals()
 *
 * Extracted from loop.js lines 821-1011 (indicators, scoring, ML, edge, etc.).
 */

import { computeAllIndicators } from '../../../src/hooks/computeIndicators.js';
import { scoreDirection, applyTimeAwareness } from '../../../src/engines/probability.js';
import { computeEdge } from '../../../src/engines/edge.js';
import { analyzeOrderbook } from '../../../src/engines/orderbook.js';
import { extractPriceToBeat, getSessionName } from '../../../src/utils.js';
import { detectArbitrage } from './arbitrage.js';
import { recordOrderbookSnapshot, getOrderbookFlow } from './orderbookFlow.js';
import { getSignalModifiers } from '../adapters/signalPerfStore.js';
import { getTrainedSignalModifiers } from '../adapters/mlLoader.js';

// ── Module state: market price ring buffer (for momentum calculation) ──
const marketUpHistory = { buf: new Float64Array(24), idx: 0, count: 0 };

export function resetMarketUpHistory() {
  marketUpHistory.buf.fill(0);
  marketUpHistory.idx = 0;
  marketUpHistory.count = 0;
}

/**
 * Full signal computation pipeline.
 *
 * Takes raw fetched data and returns all computed values needed by
 * the decision engine, trade pipeline, cut-loss, and broadcast.
 *
 * @param {Object} params
 * @param {Array} params.klines1m - 1-minute klines
 * @param {Array} params.klines5m - 5-minute klines
 * @param {number} params.lastPrice - Current BTC price
 * @param {Object} params.poly - Polymarket snapshot
 * @param {Object} params.priceToBeat - { slug, value, updatedAt }
 * @param {string} params.marketSlug - Current market slug
 * @param {number} params.now - Current timestamp
 * @param {boolean} params.clobConnected - Whether CLOB WS is connected
 * @param {boolean} params.clobStale - Whether CLOB WS data is stale
 * @param {Function} params.getClobUpPrice - Get CLOB WS UP price
 * @param {Function} params.getClobDownPrice - Get CLOB WS DOWN price
 * @param {Function} params.getClobOrderbook - Get CLOB WS orderbook
 * @param {Object} params.feedbackStats - Accuracy stats from feedback engine
 * @param {number|null} params.timeLeftMin - Minutes until market settlement
 * @param {number} params.candleWindowMinutes - Candle window config
 * @param {Function} params.getMLPrediction - ML prediction function
 * @param {number|null} params.fundingRate - Funding rate (null if blocked)
 * @returns {Object} All computed signal data
 */
export function computeSignals({
  klines1m, klines5m, lastPrice, poly, priceToBeat, marketSlug, now,
  clobConnected, clobStale, getClobUpPrice, getClobDownPrice, getClobOrderbook,
  feedbackStats, timeLeftMin, candleWindowMinutes,
  getMLPrediction, fundingRate, smartFlowSignal,
}) {
  // ── Compute all indicators ──
  const ind = computeAllIndicators({ candles: klines1m, klines5m, lastPrice });
  const {
    closes, vwapSeries, vwapNow, vwapSlope, vwapDist,
    rsiNow, rsiSlope, macd, consec, vwapCrossCount,
    bb, atr, volDelta, emaCross, stochRsi,
    volumeRecent, volumeAvg, failedVwapReclaim,
    regimeInfo, lastClose, delta1m, delta3m,
    volProfile, realizedVol, multiTfConfirm,
    momentum5CandleSlope, volatilityChangeRatio, priceConsistency,
  } = ind;

  // ── Price to beat ──
  const ptb = extractPriceToBeat(poly.market, klines1m);
  let updatedPriceToBeat = priceToBeat;
  if (marketSlug && priceToBeat.slug !== marketSlug) {
    updatedPriceToBeat = { slug: marketSlug, value: ptb, updatedAt: ptb !== null ? now : 0 };
  } else if (ptb !== null) {
    updatedPriceToBeat = { ...priceToBeat, value: ptb, updatedAt: now };
  }

  // ── Market prices: WS (instant) → REST (fallback) ──
  const useClobWs = clobConnected && !clobStale;
  const marketUp = useClobWs ? (getClobUpPrice() ?? poly.prices.up) : poly.prices.up;
  const marketDown = useClobWs ? (getClobDownPrice() ?? poly.prices.down) : poly.prices.down;

  // ── Orderbook: WS (instant) → REST (fallback) ──
  const wsBook = useClobWs ? getClobOrderbook() : null;
  const orderbookUp = (wsBook?.up?.bestBid != null) ? wsBook.up : (poly?.orderbook?.up ?? null);
  const orderbookDown = (wsBook?.down?.bestBid != null) ? wsBook.down : (poly?.orderbook?.down ?? null);

  const orderbookSignal = analyzeOrderbook({ orderbookUp, orderbookDown, marketUp, marketDown });

  // ── Arbitrage detection (BEFORE directional logic) ──
  // H11: Allow REST-based arbs but with higher min profit (1% vs 0.5%) to compensate for stale mid-prices.
  // REST mid-prices systematically understate ask prices, so require larger margin of safety.
  let arb = detectArbitrage({ orderbookUp, orderbookDown, marketUp, marketDown });
  if (!useClobWs && arb.found && arb.netProfit < 0.01) {
    arb = { ...arb, found: false, reason: 'rest_min_profit_insufficient' };
  }

  // ── Orderbook flow tracking ──
  recordOrderbookSnapshot(orderbookSignal, orderbookUp, orderbookDown);
  const obFlow = getOrderbookFlow();

  // ── Market price momentum (ring buffer) ──
  // M18: Ring buffer uses fixed candle count (12 polls), not time-based.
  // At 3s polls = 36s window; at 5s polls = 60s window. Consider timestamped entries for consistency.
  let marketPriceMomentum = 0;
  if (marketUp != null) {
    marketUpHistory.buf[marketUpHistory.idx] = marketUp;
    marketUpHistory.idx = (marketUpHistory.idx + 1) % marketUpHistory.buf.length;
    if (marketUpHistory.count < marketUpHistory.buf.length) marketUpHistory.count++;

    if (marketUpHistory.count >= 12) {
      const pastIdx = (marketUpHistory.idx - 12 + marketUpHistory.buf.length) % marketUpHistory.buf.length;
      marketPriceMomentum = marketUp - marketUpHistory.buf[pastIdx];
    }
  }

  // ── Score direction (merge trained + live signal modifiers) ──
  // M19: Trained × live multiplication may double-correct if both respond to same signal.
  // E.g. if RSI accuracy drops, trained mod → 0.8 AND live mod → 0.8, net = 0.64 (over-dampened).
  // Current approach is acceptable with the [0.3, 3.0] clamp but consider averaging instead.
  const liveModifiers = getSignalModifiers();
  const trainedMods = getTrainedSignalModifiers();
  let mergedModifiers;
  if (trainedMods) {
    mergedModifiers = {};
    for (const key of Object.keys(liveModifiers)) {
      const t = trainedMods[key] ?? 1.0;
      const l = liveModifiers[key] ?? 1.0;
      mergedModifiers[key] = Math.max(0.3, Math.min(3.0, t * l));
    }
  } else {
    mergedModifiers = liveModifiers;
  }

  const scored = scoreDirection({
    price: lastPrice, priceToBeat: updatedPriceToBeat.value,
    vwap: vwapNow, vwapSlope, rsi: rsiNow, rsiSlope,
    macd, heikenColor: consec.color, heikenCount: consec.count,
    failedVwapReclaim, delta1m, delta3m, regime: regimeInfo,
    orderbookSignal, volProfile, multiTfConfirm, feedbackStats,
    bb, atr,
    minutesLeft: timeLeftMin,
    signalModifiers: mergedModifiers,
  });

  const timeAware = applyTimeAwareness(scored.rawUp, timeLeftMin, candleWindowMinutes);

  // ── Rule-based edge (spread-aware) ──
  const ruleEdge = computeEdge({
    modelUp: timeAware.adjustedUp, modelDown: timeAware.adjustedDown,
    marketYes: marketUp, marketNo: marketDown,
    orderbookUp, orderbookDown,
  });

  // ── Smart money features (from MetEngine → ML feature vector) ──
  const sf = smartFlowSignal ?? {};
  const sfHasData = sf.sampleCount >= 3 && sf.direction !== 'NEUTRAL' && sf.direction !== 'INSUFFICIENT';
  const smBullRatio = sfHasData
    ? (sf.direction === 'UP' ? 0.5 + sf.strength * 0.5 : 0.5 - sf.strength * 0.5)
    : 0.5;
  const smFlowIntensity = sfHasData ? Math.min(sf.confidence, 1) : 0;
  const smEarlySignal = sfHasData && sf.earlyFlow !== 0
    ? (sf.earlyFlow > 0 ? 0.5 + Math.min(Math.abs(sf.earlyFlow), 0.5) : 0.5 - Math.min(Math.abs(sf.earlyFlow), 0.5))
    : 0.5;
  const smFlowAccel = sfHasData
    ? Math.max(-1, Math.min(1, (sf.lateFlow || sf.midFlow || 0) - (sf.earlyFlow || 0)))
    : 0;
  const smActivity = sfHasData ? 1 : 0;

  // ── ML prediction ──
  const session = getSessionName();
  const mlResult = getMLPrediction({
    price: lastPrice, priceToBeat: updatedPriceToBeat.value,
    rsi: rsiNow, rsiSlope, macd, vwap: vwapNow, vwapSlope,
    heikenColor: consec.color, heikenCount: consec.count,
    delta1m, delta3m, volumeRecent, volumeAvg,
    regime: regimeInfo.regime, regimeConfidence: regimeInfo.confidence, session,
    minutesLeft: timeLeftMin,
    bestEdge: Math.max(ruleEdge.edgeUp ?? 0, ruleEdge.edgeDown ?? 0),
    vwapCrossCount, multiTfAgreement: multiTfConfirm?.agreement ?? false,
    failedVwapReclaim,
    bbWidth: bb?.width ?? null, bbPercentB: bb?.percentB ?? null,
    bbSqueeze: bb?.squeeze ?? false, bbSqueezeIntensity: bb?.squeezeIntensity ?? 0,
    atrPct: atr?.atrPct ?? null, atrRatio: atr?.atrRatio ?? null,
    volDeltaBuyRatio: volDelta?.buyRatio ?? null,
    volDeltaAccel: volDelta?.deltaAccel ?? null,
    emaDistPct: emaCross?.distancePct ?? null,
    emaCrossSignal: emaCross?.cross === 'BULL_CROSS' ? 1 : emaCross?.cross === 'BEAR_CROSS' ? -1 : 0,
    stochK: stochRsi?.k ?? null,
    stochKD: stochRsi ? (stochRsi.k - stochRsi.d) : null,
    fundingRate,
    marketYesPrice: marketUp,
    marketPriceMomentum,
    orderbookImbalance: orderbookSignal?.imbalance ?? null,
    spreadPct: orderbookUp?.spread ?? null,
    momentum5CandleSlope, volatilityChangeRatio, priceConsistency,
    smBullRatio, smFlowIntensity, smEarlySignal, smFlowAccel, smActivity,
  }, timeAware.adjustedUp);

  // ── Ensemble edge (spread-aware) ──
  const ensembleUp = mlResult.available ? mlResult.ensembleProbUp : timeAware.adjustedUp;
  const ensembleDown = 1 - ensembleUp;

  const edge = computeEdge({
    modelUp: ensembleUp, modelDown: ensembleDown,
    marketYes: marketUp, marketNo: marketDown,
    orderbookUp, orderbookDown,
  });

  const ruleSide = timeAware.adjustedUp >= 0.5 ? 'UP' : 'DOWN';
  const mlAgreesWithRules = mlResult.available && mlResult.mlSide === ruleSide;

  return {
    // Indicators (full objects)
    ind, vwapNow, vwapDist, vwapSlope, rsiNow, rsiSlope,
    macd, consec, vwapCrossCount,
    bb, atr, volDelta, emaCross, stochRsi,
    volumeRecent, volumeAvg, failedVwapReclaim,
    regimeInfo, lastClose, delta1m, delta3m,
    volProfile, realizedVol, multiTfConfirm,
    momentum5CandleSlope, volatilityChangeRatio, priceConsistency,

    // Market prices
    useClobWs, marketUp, marketDown,
    orderbookUp, orderbookDown, orderbookSignal,
    arb, obFlow, marketPriceMomentum,

    // Price to beat (potentially updated)
    updatedPriceToBeat,

    // Scoring
    scored, timeAware, ruleEdge,

    // ML
    mlResult, ensembleUp, ensembleDown, mlAgreesWithRules, ruleSide,

    // Edge
    edge,

    // Metadata
    session, fundingRate,

    // Signal freshness timestamp — used to detect stale signals before execution
    computedAt: Date.now(),
  };
}
