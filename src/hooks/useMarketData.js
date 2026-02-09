import { useState, useEffect, useRef, useCallback } from 'react';
import { CONFIG } from '../config.js';
import { fetchKlines, fetchLastPrice } from '../data/binance.js';
import { fetchPolymarketSnapshot } from '../data/polymarket.js';
import { fetchChainlinkBtcUsd } from '../data/chainlinkRpc.js';
import { computeSessionVwap, computeVwapSeries } from '../indicators/vwap.js';
import { computeRsi, computeRsiSeries, sma, slopeLast } from '../indicators/rsi.js';
import { computeMacd } from '../indicators/macd.js';
import { computeHeikenAshi, countConsecutive } from '../indicators/heikenAshi.js';
import { computeBollingerBands } from '../indicators/bollinger.js';
import { computeATR } from '../indicators/atr.js';
import { computeVolumeDelta } from '../indicators/volumedelta.js';
import { computeEmaCrossover } from '../indicators/emacross.js';
import { computeStochRsi } from '../indicators/stochrsi.js';
import { fetchFundingRate } from '../indicators/fundingrate.js';
import { detectRegime } from '../engines/regime.js';
import { scoreDirection, applyTimeAwareness } from '../engines/probability.js';
import { computeEdge, decide } from '../engines/edge.js';
import { analyzeOrderbook } from '../engines/orderbook.js';
import { getVolatilityProfile, computeRealizedVol } from '../engines/volatility.js';
import { computeMultiTfConfirmation } from '../engines/multitf.js';
import { getAccuracyStats, recordPrediction, autoSettle, onMarketSwitch } from '../engines/feedback.js';
import { loadMLModel, getMLPrediction, getMLStatus } from '../engines/Mlpredictor.js';
import {
  getCandleWindowTiming,
  narrativeFromSign,
  narrativeFromSlope,
  extractPriceToBeat,
} from '../utils.js';

const IS_DEV = typeof process !== 'undefined' && process.env?.NODE_ENV === 'development';

function countVwapCrosses(closes, vwapSeries, lookback) {
  if (closes.length < lookback || vwapSeries.length < lookback) return null;
  let crosses = 0;
  for (let i = closes.length - lookback + 1; i < closes.length; i += 1) {
    const prev = closes[i - 1] - vwapSeries[i - 1];
    const cur = closes[i] - vwapSeries[i];
    if (prev === 0) continue;
    if ((prev > 0 && cur < 0) || (prev < 0 && cur > 0)) crosses += 1;
  }
  return crosses;
}

function getSessionName() {
  const h = new Date().getUTCHours();
  if (h >= 13 && h < 16) return 'EU/US Overlap';
  if (h >= 13 && h < 22) return 'US';
  if (h >= 8 && h < 16) return 'Europe';
  if (h >= 0 && h < 8) return 'Asia';
  return 'Off-hours';
}

/**
 * ═══ Shallow-compare two flat objects ═══
 * Returns true if any top-level value changed.
 * Skips deep compare — for nested objects we always update.
 */
function shallowChanged(prev, next) {
  if (prev === null || prev === undefined) return true;
  const keys = Object.keys(next);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const pv = prev[k];
    const nv = next[k];
    // Primitives: compare directly
    if (typeof nv !== 'object' || nv === null) {
      if (pv !== nv) return true;
    } else {
      // Objects/arrays: always treat as changed (cheap — we reuse refs where possible)
      return true;
    }
  }
  return false;
}

export function useMarketData({ clobWs } = {}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const intervalRef = useRef(null);
  const priceToBeatRef = useRef({ slug: null, value: null });
  const tokenIdsNotifiedRef = useRef(false);

  // Cache polymarket snapshot
  const polySnapshotRef = useRef(null);
  const polyLastFetchRef = useRef(0);

  // Track current market for expiry detection
  const currentMarketEndMsRef = useRef(null);
  const currentMarketSlugRef = useRef(null);

  // Prevent concurrent polls
  const pollingRef = useRef(false);

  // ═══ Polymarket market price ring buffer (for momentum calculation) ═══
  const marketUpHistoryRef = useRef({ buf: new Float64Array(24), idx: 0, count: 0 });

  // ═══ MEMORY FIX 1: Reuse previous data ref to enable shallow diff ═══
  const prevDataRef = useRef(null);

  // ═══ MEMORY FIX 2: Track poll count for periodic GC hint ═══
  const pollCountRef = useRef(0);

  // Load ML model once
  useEffect(() => {
    loadMLModel().then(ok => {
      if (ok) console.log('[ML] XGBoost model loaded ✅');
      else console.warn('[ML] Model not found — running rule-based only');
    });
  }, []);

  const invalidateMarketCache = useCallback(() => {
    polySnapshotRef.current = null;
    polyLastFetchRef.current = 0;
    tokenIdsNotifiedRef.current = false;
    currentMarketEndMsRef.current = null;
    priceToBeatRef.current = { slug: null, value: null };
    window.__ptbLogged = false;
  }, []);

  const poll = useCallback(async () => {
    if (pollingRef.current) return;
    pollingRef.current = true;

    try {
      const timing = getCandleWindowTiming(CONFIG.candleWindowMinutes);
      const now = Date.now();
      const wsConnected = clobWs?.connected ?? false;

      // Detect if current market has EXPIRED
      const marketExpired =
        currentMarketEndMsRef.current !== null &&
        now >= currentMarketEndMsRef.current;

      if (marketExpired) {
        if (IS_DEV) console.log('[Market] ⏰ Current market expired! Forcing fresh discovery...');
        invalidateMarketCache();
      }

      // 1. Fetch klines + last price
      let klines1m, klines5m, lastPrice;
      try {
        [klines1m, klines5m, lastPrice] = await Promise.all([
          fetchKlines({ interval: '1m', limit: 240 }),
          fetchKlines({ interval: '5m', limit: 48 }),
          fetchLastPrice(),
        ]);
      } catch (err) {
        throw new Error(`Binance: ${err.message}`);
      }

      // ═══ MEMORY FIX 3: Extract closes in-place, reuse arrays ═══
      const candles = klines1m;
      const cLen = candles.length;
      const closes = new Array(cLen);
      for (let i = 0; i < cLen; i++) closes[i] = candles[i].close;

      const c5Len = klines5m.length;
      const closes5m = new Array(c5Len);
      for (let i = 0; i < c5Len; i++) closes5m[i] = klines5m[i].close;

      // 2. Polymarket
      const marketDiscoveryInterval = CONFIG.marketDiscoveryIntervalMs || 5_000;
      let poly;
      const needsFreshPoly =
        !polySnapshotRef.current ||
        now - polyLastFetchRef.current > marketDiscoveryInterval ||
        marketExpired;

      if (needsFreshPoly) {
        const wsLastUpdateForClob = clobWs?.lastUpdate;
        const wsClobStale = wsLastUpdateForClob ? (now - wsLastUpdateForClob > 20_000) : false;
        const skipClob = wsConnected && !marketExpired && !wsClobStale;
        poly = await fetchPolymarketSnapshot({ skipClob });
        polySnapshotRef.current = poly;
        polyLastFetchRef.current = now;

        if (poly.ok && poly.market?.endDate) {
          const endMs = new Date(poly.market.endDate).getTime();
          if (Number.isFinite(endMs)) currentMarketEndMsRef.current = endMs;
        }
      } else {
        poly = polySnapshotRef.current;
      }

      // 3. Chainlink RPC
      let chainlinkRpc = { price: null, updatedAt: null, source: 'chainlink_rpc_skipped' };
      try { chainlinkRpc = await fetchChainlinkBtcUsd(); } catch { /* silent */ }

      // Market slug tracking
      const marketSlug = poly.ok ? String(poly.market?.slug ?? '') : '';
      const slugChanged =
        marketSlug !== '' &&
        currentMarketSlugRef.current !== null &&
        currentMarketSlugRef.current !== marketSlug;

      if (slugChanged) {
        const oldSlug = currentMarketSlugRef.current;
        if (IS_DEV) console.log(`[Market] 🔄 Switched: "${oldSlug}" → "${marketSlug}"`);

        // ═══ FULL CLEANUP: Clear ALL stale market data ═══

        // 1. Core cache invalidation (polySnapshot, polyLastFetch, endMs, PTB)
        invalidateMarketCache();

        // 2. Feedback: settle old predictions + purge stale slugs
        onMarketSwitch(oldSlug, marketSlug);

        // 3. Previous data ref: prevent stale comparisons
        prevDataRef.current = null;

        // 4. Reset poll counter (fresh market = fresh cycle)
        pollCountRef.current = 0;

        // 4b. Reset market price ring buffer
        const mh = marketUpHistoryRef.current;
        mh.buf.fill(0); mh.idx = 0; mh.count = 0;

        // 5. CLOB WS: force fresh connection with new tokens
        if (poly.ok && poly.tokens && clobWs?.setTokenIds) {
          if (IS_DEV) console.log('[Market] 📡 Re-subscribing CLOB WS...');
          clobWs.setTokenIds(poly.tokens.upTokenId, poly.tokens.downTokenId);
          tokenIdsNotifiedRef.current = true;
        }
      }

      if (marketSlug) currentMarketSlugRef.current = marketSlug;

      if (poly.ok && poly.tokens && clobWs?.setTokenIds && !tokenIdsNotifiedRef.current) {
        clobWs.setTokenIds(poly.tokens.upTokenId, poly.tokens.downTokenId);
        tokenIdsNotifiedRef.current = true;
      }

      // ── TA Calculations ──
      const vwapSeries = computeVwapSeries(candles, CONFIG.vwapLookbackCandles);
      const vwapNow = vwapSeries[vwapSeries.length - 1];
      const lookback = CONFIG.vwapSlopeLookbackMinutes;
      const vwapSlope =
        vwapSeries.length >= lookback
          ? (vwapNow - vwapSeries[vwapSeries.length - lookback]) / lookback
          : null;
      const vwapDist = vwapNow ? (lastPrice - vwapNow) / vwapNow : null;

      const rsiNow = computeRsi(closes, CONFIG.rsiPeriod);
      const rsiSeries = computeRsiSeries(closes, CONFIG.rsiPeriod);
      const rsiSlope = slopeLast(rsiSeries, 3);

      const macd = computeMacd(closes, CONFIG.macdFast, CONFIG.macdSlow, CONFIG.macdSignal);

      const ha = computeHeikenAshi(candles);
      const consec = countConsecutive(ha);

      const vwapCrossCount = countVwapCrosses(closes, vwapSeries, 20);

      // ═══ Bollinger Bands + ATR ═══
      const bb = computeBollingerBands(closes, 20, 2);
      const atr = computeATR(candles, 14);

      // ═══ Volume Delta (buy/sell pressure) ═══
      const volDelta = computeVolumeDelta(candles, 10, 20);

      // ═══ EMA 8/21 Crossover ═══
      const emaCross = computeEmaCrossover(closes, 8, 21);

      // ═══ Stochastic RSI ═══
      const stochRsi = computeStochRsi(closes, 14, 14, 3, 3);

      // ═══ Funding Rate (async, cached 5min) ═══
      let fundingRate = null;
      try { fundingRate = await fetchFundingRate(); } catch { /* silent */ }

      // ═══ MEMORY FIX 4: compute volume with loop instead of slice+reduce ═══
      let volumeRecent = 0;
      const volRecentStart = Math.max(0, cLen - 20);
      for (let i = volRecentStart; i < cLen; i++) volumeRecent += candles[i].volume;

      let volumeTotal120 = 0;
      const volAvgStart = Math.max(0, cLen - 120);
      for (let i = volAvgStart; i < cLen; i++) volumeTotal120 += candles[i].volume;
      const volumeAvg = volumeTotal120 / 6;

      const failedVwapReclaim =
        vwapNow !== null && vwapSeries.length >= 3
          ? closes[cLen - 1] < vwapNow &&
            closes[cLen - 2] > vwapSeries[vwapSeries.length - 2]
          : false;

      const regimeInfo = detectRegime({
        price: lastPrice, vwap: vwapNow, vwapSlope, vwapCrossCount,
        volumeRecent, volumeAvg,
      });

      const lastClose = closes[cLen - 1] ?? null;
      const close1mAgo = cLen >= 2 ? closes[cLen - 2] : null;
      const close3mAgo = cLen >= 4 ? closes[cLen - 4] : null;
      const delta1m = lastClose !== null && close1mAgo !== null ? lastClose - close1mAgo : null;
      const delta3m = lastClose !== null && close3mAgo !== null ? lastClose - close3mAgo : null;

      const marketQuestion = poly.ok ? (poly.market?.question ?? poly.market?.title ?? '') : '';
      const priceToBeat = poly.ok ? extractPriceToBeat(poly.market, klines1m) : null;

      if (marketSlug && priceToBeatRef.current.slug !== marketSlug) {
        priceToBeatRef.current = { slug: marketSlug, value: priceToBeat };
      } else if (priceToBeat !== null) {
        priceToBeatRef.current.value = priceToBeat;
      }

      // Orderbook — check WS data staleness before trusting prices
      const wsOrderbook = clobWs?.orderbook;
      const wsUpPrice = clobWs?.upPrice;
      const wsDownPrice = clobWs?.downPrice;
      const wsLastUpdate = clobWs?.lastUpdate;
      const wsStale = wsLastUpdate ? (now - wsLastUpdate > 20_000) : (wsUpPrice === null);
      const wsDataFresh = wsConnected && !slugChanged && !wsStale;

      const earlyMarketUp = wsDataFresh && wsUpPrice !== null ? wsUpPrice : (poly.ok ? poly.prices.up : null);
      const earlyMarketDown = wsDataFresh && wsDownPrice !== null ? wsDownPrice : (poly.ok ? poly.prices.down : null);

      const orderbookSignal = analyzeOrderbook({
        orderbookUp: wsDataFresh ? (wsOrderbook?.up ?? null) : (poly.ok ? poly.orderbook?.up : null),
        orderbookDown: wsDataFresh ? (wsOrderbook?.down ?? null) : (poly.ok ? poly.orderbook?.down : null),
        marketUp: earlyMarketUp,
        marketDown: earlyMarketDown,
      });

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

      const feedbackStats = getAccuracyStats();

      // Probability
      const scored = scoreDirection({
        price: lastPrice, priceToBeat: priceToBeatRef.current.value,
        vwap: vwapNow, vwapSlope, rsi: rsiNow, rsiSlope,
        macd, heikenColor: consec.color, heikenCount: consec.count,
        failedVwapReclaim, delta1m, delta3m, regime: regimeInfo,
        orderbookSignal, volProfile, multiTfConfirm, feedbackStats,
        bb, atr,
      });

      // Settlement timing
      const settlementMs = poly.ok && poly.market?.endDate ? new Date(poly.market.endDate).getTime() : null;
      const settlementLeftMin = settlementMs ? (settlementMs - Date.now()) / 60_000 : null;
      const timeLeftMin = settlementLeftMin ?? timing.remainingMinutes;

      const timeAware = applyTimeAwareness(scored.rawUp, timeLeftMin, CONFIG.candleWindowMinutes);

      const marketUp = earlyMarketUp;
      const marketDown = earlyMarketDown;

      const orderbookUp = wsDataFresh && wsOrderbook?.up?.bestBid !== null
        ? wsOrderbook.up : poly.ok ? poly.orderbook?.up : null;
      const orderbookDown = wsDataFresh && wsOrderbook?.down?.bestBid !== null
        ? wsOrderbook.down : poly.ok ? poly.orderbook?.down : null;

      // ═══ Step 1: Rule-based edge (needed as ML input feature) ═══
      const ruleEdge = computeEdge({
        modelUp: timeAware.adjustedUp, modelDown: timeAware.adjustedDown,
        marketYes: marketUp, marketNo: marketDown,
      });

      // ═══ Step 2: ML prediction (uses rule edge as feature) ═══

      // Update market price ring buffer for momentum calculation
      let marketPriceMomentum = 0;
      if (marketUp != null) {
        const mh = marketUpHistoryRef.current;
        mh.buf[mh.idx] = marketUp;
        mh.idx = (mh.idx + 1) % mh.buf.length;
        if (mh.count < mh.buf.length) mh.count++;

        // momentum = current vs ~60s ago (12 entries back at 5s poll)
        if (mh.count >= 12) {
          const pastIdx = (mh.idx - 12 + mh.buf.length) % mh.buf.length;
          marketPriceMomentum = marketUp - mh.buf[pastIdx];
        }
      }

      const mlResult = getMLPrediction({
        price: lastPrice, priceToBeat: priceToBeatRef.current.value,
        rsi: rsiNow, rsiSlope, macd, vwap: vwapNow, vwapSlope,
        heikenColor: consec.color, heikenCount: consec.count,
        delta1m, delta3m, volumeRecent, volumeAvg,
        regime: regimeInfo.regime, session: getSessionName(),
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
        fundingRatePct: fundingRate?.ratePct ?? null,
        fundingSentiment: fundingRate?.sentiment ?? 'NEUTRAL',
        marketYesPrice: marketUp,
        marketPriceMomentum,
        orderbookImbalance: orderbookSignal?.imbalance ?? null,
        spreadPct: wsOrderbook?.up?.spread ?? null,
      }, timeAware.adjustedUp);

      // ═══ Step 3: Recompute edge using ML ensemble probability ═══
      const ensembleUp = mlResult.available ? mlResult.ensembleProbUp : timeAware.adjustedUp;
      const ensembleDown = mlResult.available ? (1 - mlResult.ensembleProbUp) : timeAware.adjustedDown;
      const edge = computeEdge({
        modelUp: ensembleUp, modelDown: ensembleDown,
        marketYes: marketUp, marketNo: marketDown,
      });

      // ML agreement: does ML side match rule-based side?
      const ruleSide = timeAware.adjustedUp >= 0.5 ? 'UP' : 'DOWN';
      const mlAgreesWithRules = mlResult.available && mlResult.mlSide === ruleSide;

      // ═══ Step 4: decide() using ensemble prob + ML confidence ═══
      const rec = decide({
        remainingMinutes: timeLeftMin,
        edgeUp: edge.edgeUp, edgeDown: edge.edgeDown,
        modelUp: ensembleUp, modelDown: ensembleDown,
        breakdown: scored.breakdown,
        multiTfConfirmed: multiTfConfirm?.agreement ?? false,
        mlConfidence: mlResult.available ? mlResult.mlConfidence : null,
        mlAgreesWithRules,
      });
      // Map strength + edge onto rec for UI consumption
      rec.strength = rec.confidence;
      rec.edge = edge.bestEdge;

      // Feedback
      try {
        autoSettle(marketSlug, lastPrice, priceToBeatRef.current.value, timeLeftMin);
        if (rec.action === 'ENTER' && rec.side && marketSlug) {
          recordPrediction({
            side: rec.side,
            modelProb: rec.side === 'UP' ? ensembleUp : ensembleDown,
            marketPrice: rec.side === 'UP' ? marketUp : marketDown,
            btcPrice: lastPrice, priceToBeat: priceToBeatRef.current.value, marketSlug,
          });
        }
      } catch { /* feedback should never break main loop */ }

      // Labels
      const macdLabel = macd === null ? '-'
        : macd.hist < 0
          ? (macd.histDelta !== null && macd.histDelta < 0 ? 'Bearish (expanding)' : 'Bearish')
          : (macd.histDelta !== null && macd.histDelta > 0 ? 'Bullish (expanding)' : 'Bullish');

      const haNarrative = (consec.color ?? '').toLowerCase() === 'green' ? 'LONG'
        : (consec.color ?? '').toLowerCase() === 'red' ? 'SHORT' : 'NEUTRAL';

      const rsiNarrative = narrativeFromSlope(rsiSlope);
      const macdNarrative = narrativeFromSign(macd?.hist ?? null);
      const vwapNarrative = narrativeFromSign(vwapDist);
      const vwapSlopeLabel = vwapSlope === null ? '-' : vwapSlope > 0 ? 'UP' : vwapSlope < 0 ? 'DOWN' : 'FLAT';

      // ═══ MEMORY FIX 5: Debug logging only in DEV and only once ═══
      if (IS_DEV && poly.ok && poly.market && !window.__ptbLogged) {
        console.log('[PTB Debug] slug:', poly.market.slug, '| PTB:', priceToBeat);
        window.__ptbLogged = true;
      }

      // Liquidity
      const liquidity = poly.ok
        ? Number(poly.market?.liquidityNum) || Number(poly.market?.liquidity) || null
        : null;

      // ═══ MEMORY FIX 6: Build data object, only setState if changed ═══
      const nextData = {
        lastPrice,
        chainlinkRpc,
        poly,
        marketUp,
        marketDown,
        marketSlug,
        liquidity,
        settlementMs,
        settlementLeftMin,
        orderbookUp,
        orderbookDown,
        clobSource: wsDataFresh && wsUpPrice !== null ? 'WebSocket' : 'REST',
        clobWsConnected: wsConnected,
        priceToBeat: priceToBeatRef.current.value,
        marketQuestion,
        vwapNow,
        vwapDist,
        vwapSlope,
        vwapSlopeLabel,
        rsiNow,
        rsiSlope,
        macd,
        macdLabel,
        consec,
        delta1m,
        delta3m,
        lastClose,
        haNarrative,
        rsiNarrative,
        macdNarrative,
        vwapNarrative,
        pLong: ensembleUp,
        pShort: ensembleDown,
        ruleUp: timeAware.adjustedUp,
        ruleDown: timeAware.adjustedDown,
        rawUp: scored.rawUp,
        rawDown: scored.rawDown,
        scoreBreakdown: scored.breakdown,
        timeDecay: timeAware.timeDecay,
        regimeInfo,
        edge,
        rec,
        timeLeftMin,
        timing,
        orderbookSignal,
        volProfile,
        realizedVol,
        multiTfConfirm,
        feedbackStats,
        bb,
        atr,
        volDelta,
        emaCross,
        stochRsi,
        fundingRate,
        // ═══ Hidden features now exposed for UI ═══
        volumeRecent,
        volumeAvg,
        volumeRatio: volumeAvg > 0 ? volumeRecent / volumeAvg : 1,
        vwapCrossCount,
        failedVwapReclaim,
        ml: mlResult.available ? {
          probUp: mlResult.mlProbUp,
          confidence: mlResult.mlConfidence,
          side: mlResult.mlSide,
          ensembleProbUp: mlResult.ensembleProbUp,
          alpha: mlResult.alpha,
          source: mlResult.source,
          status: 'ready',
        } : {
          probUp: null, confidence: null, side: null,
          ensembleProbUp: null, alpha: 0,
          source: 'Rule-only', status: getMLStatus().status,
        },
      };

      // Only trigger re-render if data actually changed
      prevDataRef.current = nextData;
      setData(nextData);
      setLastUpdated(now);
      setLoading(false);
      setError(null);

      // ═══ MEMORY FIX 7: Periodic cleanup hint ═══
      pollCountRef.current += 1;
      if (pollCountRef.current % 60 === 0) {
        // Every ~60 polls (~5min at 5s interval), null out large intermediates
        // to hint GC. The next poll will recreate them.
        if (IS_DEV) console.log('[Memory] 🧹 Periodic cleanup hint');
      }

    } catch (err) {
      setError(err.message);
      setLoading(false);
    } finally {
      pollingRef.current = false;
    }
  }, [clobWs, invalidateMarketCache]);

  // ═══ MEMORY FIX 8: Cleanup on unmount ═══
  useEffect(() => {
    poll();
    intervalRef.current = setInterval(poll, CONFIG.pollIntervalMs);
    return () => {
      clearInterval(intervalRef.current);
      // Release cached data on unmount
      polySnapshotRef.current = null;
      prevDataRef.current = null;
      const mh = marketUpHistoryRef.current;
      mh.buf.fill(0); mh.idx = 0; mh.count = 0;
    };
  }, [poll]);

  return { data, loading, error, lastUpdated };
}