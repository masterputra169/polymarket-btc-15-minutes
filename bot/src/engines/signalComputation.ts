/**
 * Signal computation pipeline — takes raw fetched data, returns all signal state.
 *
 * Owns: marketUpHistory ring buffer
 * Exports: computeSignals()
 *
 * Extracted from loop.js lines 821-1011 (indicators, scoring, ML, edge, etc.).
 */

import { computeAllIndicators } from '../../../src/hooks/computeIndicators.ts';
import { scoreDirection, applyTimeAwareness } from '../../../src/engines/probability.ts';
import { computeEdge } from '../../../src/engines/edge.ts';
import { analyzeOrderbook } from '../../../src/engines/orderbook.ts';
import { getSessionName } from '../../../src/utils.ts';
import { detectArbitrage } from './arbitrage.ts';
import { recordOrderbookSnapshot, getOrderbookFlow } from './orderbookFlow.ts';
import { getSignalModifiers } from '../adapters/signalPerfStore.ts';
import { getTrainedSignalModifiers } from '../adapters/mlLoader.ts';
import { simulateBTCPaths } from './monteCarlo.ts';
import { buildMlFeatureInputs, MARKET_MOMENTUM_WINDOW_MS } from '../../../src/engines/ml/featureInputs.ts';
import { aggregate5m, CANDLES_5M } from '../../../src/engines/ml/trainingRow.ts';

// ── Module state: market price ring buffer (for momentum calculation) ──
const marketUpHistory = { buf: new Float64Array(24), idx: 0, count: 0 };

// ── Timestamped UP-price history (feature pipeline v2) ──
// market_price_momentum has to mean "change over the last 60s" here exactly as
// it does in training. The ring buffer above counts polls, which at the 50ms
// poll interval is 0.6s. One market at a time: a new slug starts a new history.
const marketUpTimed: { slug: string | null; points: Array<{ t: number; p: number }> } = { slug: null, points: [] };
const MARKET_HISTORY_KEEP_MS = MARKET_MOMENTUM_WINDOW_MS + 30_000;
const MARKET_HISTORY_MIN_STEP_MS = 1_000;

export function resetMarketUpHistory() {
  marketUpHistory.buf.fill(0);
  marketUpHistory.idx = 0;
  marketUpHistory.count = 0;
  marketUpTimed.slug = null;
  marketUpTimed.points = [];
}

/** Record the UP price seen at `t` for `slug` (at most one point per second). */
export function recordMarketUp(slug: string | null | undefined, t: number, p: number | null | undefined): void {
  if (p == null || !Number.isFinite(p) || !Number.isFinite(t)) return;
  if ((slug ?? null) !== marketUpTimed.slug) {
    marketUpTimed.slug = slug ?? null;
    marketUpTimed.points = [];
  }
  const pts = marketUpTimed.points;
  const last = pts[pts.length - 1];
  if (last && t - last.t < MARKET_HISTORY_MIN_STEP_MS) {
    pts[pts.length - 1] = { t: last.t, p };  // keep the second's first timestamp, latest price
  } else {
    pts.push({ t, p });
  }
  const cutoff = t - MARKET_HISTORY_KEEP_MS;
  while (pts.length > 1 && pts[1].t <= cutoff) pts.shift();
}

/** Last recorded UP price at or before `t` in the current market, or null. */
export function marketUpAtOrBefore(t: number): number | null {
  let found: number | null = null;
  for (const pt of marketUpTimed.points) {
    if (pt.t > t) break;
    found = pt.p;
  }
  return found;
}

/**
 * Start of the market window, epoch ms: from the slug's timestamp suffix
 * (btc-updown-15m-<unix>), else derived from the time left.
 */
export function windowStartMs(marketSlug: string | null | undefined, now: number, timeLeftMin: number | null): number | null {
  const m = /-(\d{9,11})$/.exec(marketSlug ?? '');
  if (m) return Number(m[1]) * 1000;
  if (timeLeftMin != null && Number.isFinite(timeLeftMin)) {
    return Math.round((now + timeLeftMin * 60_000 - 15 * 60_000) / 60_000) * 60_000;
  }
  return null;
}

/** Open of the 1m candle that starts at `startMs`, or null if it is not in the fetch. */
function candleOpenAt(klines: Array<{ openTime?: number; open: number }> | null | undefined, startMs: number | null): number | null {
  if (startMs == null || !Array.isArray(klines)) return null;
  for (let i = klines.length - 1; i >= 0; i--) {
    if (klines[i].openTime === startMs) return klines[i].open;
    if ((klines[i].openTime ?? Infinity) < startMs) break;
  }
  return null;
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
 * @param {Object} params.priceToBeat - { slug, value, updatedAt, source }
 * @param {string} params.marketSlug - Current market slug
 * @param {number} params.now - Current timestamp
 * @param {boolean} params.clobUsable - Whether the CLOB WS feed may be priced off (see clobFreshness.ts)
 * @param {Function} params.getClobUpPrice - Get CLOB WS UP price
 * @param {Function} params.getClobDownPrice - Get CLOB WS DOWN price
 * @param {Function} params.getClobOrderbook - Get CLOB WS orderbook
 * @param {Object} params.feedbackStats - Accuracy stats from feedback engine
 * @param {number|null} params.timeLeftMin - Minutes until market settlement
 * @param {number} params.candleWindowMinutes - Candle window config
 * @param {Function} params.getMLPrediction - ML prediction function
 * @param {number|null} params.fundingRate - Funding rate (null if blocked)
 * @param {Object|null} [params.smartFlowSignal] - Smart-money flow signal {direction, strength, ...} or null
 * @param {number|null} params.oraclePrice - Live Chainlink price (PolyLive WS → same source as resolution)
 * @param {number} [params.featurePipeline=1] - Feature pipeline of the loaded model; >= 2 builds the ML
 *   features through featureInputs.ts, the same builder the training rows came from.
 * @returns {Object} All computed signal data
 */
export function computeSignals({
  klines1m, klines5m, lastPrice, poly, priceToBeat, marketSlug, now,
  clobUsable, getClobUpPrice, getClobDownPrice, getClobOrderbook,
  feedbackStats, timeLeftMin, candleWindowMinutes,
  getMLPrediction, fundingRate, smartFlowSignal, oraclePrice,
  featurePipeline = 1,
  // Chainlink-based estimate of the price the window settles on (engines/settlePrice.ts);
  // used wherever BTC is compared with the price to beat. Falls back to lastPrice.
  settlePrice = null,
}: any) {
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
  // Ranking lives in engines/ptbSources.ts; loop.ts sets every real source
  // (the 60 s TWAP tick first). Here only a placeholder for a brand-new market.
  let updatedPriceToBeat = priceToBeat;

  if (marketSlug && priceToBeat.slug !== marketSlug) {
    // New market detected — use live Chainlink WS as interim
    // (loop.js will overwrite with scheduled_ws or chainlink_round shortly after)
    updatedPriceToBeat = {
      slug: marketSlug,
      value: oraclePrice ?? null,
      source: oraclePrice ? 'oracle' : 'pending',
      updatedAt: oraclePrice ? now : 0,
    };
  }
  // scheduled_ws / chainlink_round: locked in — never overwritten by subsequent polls

  // ── Market prices: WS (instant) → REST (fallback) ──
  // The freshness judgement is made in clobFreshness.ts and handed in decided.
  // Note what the fallback costs: poly.prices is a 30s Gamma cache, so every
  // false here trades a live book for strictly older data.
  const useClobWs = clobUsable === true;
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
  let arb: ReturnType<typeof detectArbitrage> & { reason?: string } = detectArbitrage({ orderbookUp, orderbookDown, marketUp, marketDown });
  if (!useClobWs && arb.found && arb.netProfit < 0.01) {
    arb = { ...arb, found: false, reason: 'rest_min_profit_insufficient' };
  }

  // ── Orderbook flow tracking ──
  recordOrderbookSnapshot(orderbookSignal, orderbookUp, orderbookDown);
  const obFlow = getOrderbookFlow();

  recordMarketUp(marketSlug, now, marketUp);

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
    ptbComparePrice: settlePrice ?? lastPrice,
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
  const mlResult = featurePipeline >= 2
    ? predictWithSharedBuilder()
    : getMLPrediction({
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
  }, timeAware.adjustedUp, regimeInfo.regime);

  /**
   * Feature pipeline v2: the model was trained on rows from featureInputs.ts,
   * so it is fed from the same builder: Binance window-open as the price to
   * beat (not the Chainlink PTB), the token price 60s ago from the timestamped
   * history, and a rule probability with neutral live-only inputs. The live
   * rule probability (with modifiers) is still what the ML output is blended
   * with; only the feature vector changes.
   *
   * 5m candles are aggregated from this poll's 1m candles, exactly as training
   * does, not taken from the separately cached 5m fetch (up to 10s staler).
   */
  function predictWithSharedBuilder() {
    const inputs = buildMlFeatureInputs({
      candles1m: klines1m,
      candles5m: aggregate5m(klines1m).slice(-CANDLES_5M),
      lastPrice,
      windowOpenPrice: candleOpenAt(klines1m, windowStartMs(marketSlug, now, timeLeftMin)),
      minutesLeft: timeLeftMin,
      nowMs: now,
      marketUp,
      marketUpLag: marketUpAtOrBefore(now - MARKET_MOMENTUM_WINDOW_MS),
      fundingRate,
    });
    return getMLPrediction(inputs.marketState, timeAware.adjustedUp, regimeInfo.regime,
      { featureRuleProbUp: inputs.ruleProbUp });
  }

  // ── Monte Carlo simulation (independent probability from GBM price paths) ──
  const mcResult = simulateBTCPaths({
    currentBTC: settlePrice ?? lastPrice,
    targetPrice: updatedPriceToBeat.value,
    timeLeftSec: (timeLeftMin ?? 0) * 60,
    atrPct: atr?.atrPct ?? null,
    tokenPrice: marketUp,
  });

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

    // Monte Carlo
    mcResult,

    // Metadata
    session, fundingRate,

    // Signal freshness timestamp — used to detect stale signals before execution
    computedAt: Date.now(),
  };
}
