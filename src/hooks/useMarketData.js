import { useState, useEffect, useRef, useCallback } from 'react';
import { CONFIG } from '../config.js';
import { fetchKlines, fetchLastPrice } from '../data/binance.js';
import { fetchPolymarketSnapshot } from '../data/polymarket.js';
import { fetchChainlinkBtcUsd } from '../data/chainlinkRpc.js';
import { fetchFundingRate } from '../indicators/fundingrate.js';
import { scoreDirection, applyTimeAwareness } from '../engines/probability.js';
import { computeEdge, decide } from '../engines/edge.js';
import { computeBetSizing } from '../engines/asymmetricBet.js';
import { analyzeOrderbook } from '../engines/orderbook.js';
import { getAccuracyStats, getDetailedStats, recordPrediction, autoSettle, onMarketSwitch } from '../engines/feedback.js';
import { loadMLModel, getMLPrediction, getMLStatus } from '../engines/Mlpredictor.js';
import {
  getCandleWindowTiming,
  narrativeFromSign,
  narrativeFromSlope,
  extractPriceToBeat,
  getSessionName,
  shallowChanged,
} from '../utils.js';
import { computeAllIndicators } from './computeIndicators.js';

const IS_DEV = typeof process !== 'undefined' && process.env?.NODE_ENV === 'development';

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

  // Track first poll to skip CLOB REST on initial load
  const firstPollDoneRef = useRef(false);

  // ═══ Polymarket market price ring buffer (for momentum calculation) ═══
  const marketUpHistoryRef = useRef({ buf: new Float64Array(24), idx: 0, count: 0 });

  // ═══ Bankroll for bet sizing (persisted to localStorage) ═══
  const bankrollRef = useRef((() => {
    try {
      const stored = localStorage.getItem('btc15m_bankroll');
      return stored ? Number(stored) : 1000;
    } catch { return 1000; }
  })());

  // ═══ MEMORY FIX 1: Reuse previous data ref to enable shallow diff ═══
  const prevDataRef = useRef(null);

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

      // ── Pre-compute flags for parallel fetch ──
      const marketDiscoveryInterval = CONFIG.marketDiscoveryIntervalMs || 5_000;
      const needsFreshPoly =
        !polySnapshotRef.current ||
        now - polyLastFetchRef.current > marketDiscoveryInterval ||
        marketExpired;

      const isFirstPoll = !firstPollDoneRef.current;
      const wsLastUpdateForClob = clobWs?.lastUpdate;
      const wsClobStale = wsLastUpdateForClob ? (now - wsLastUpdateForClob > 10_000) : false;
      const skipClob = isFirstPoll || (wsConnected && !marketExpired && !wsClobStale);

      // ── ALL network calls in parallel ──
      const [binanceResult, poly, chainlinkRpc, fundingRate] = await Promise.all([
        Promise.all([
          fetchKlines({ interval: '1m', limit: 240 }),
          fetchKlines({ interval: '5m', limit: 48 }),
          fetchLastPrice(),
        ]).catch(err => { throw new Error(`Binance: ${err.message}`); }),
        needsFreshPoly
          ? fetchPolymarketSnapshot({ skipClob })
          : Promise.resolve(polySnapshotRef.current),
        fetchChainlinkBtcUsd().catch(() => ({ price: null, updatedAt: null, source: 'chainlink_rpc_error' })),
        fetchFundingRate().catch(() => null),
      ]);
      const [klines1m, klines5m, lastPrice] = binanceResult;

      const candles = klines1m;

      // Update poly cache after parallel fetch
      if (needsFreshPoly) {
        polySnapshotRef.current = poly;
        polyLastFetchRef.current = now;
        if (poly.ok && poly.market?.endDate) {
          const endMs = new Date(poly.market.endDate).getTime();
          if (Number.isFinite(endMs)) currentMarketEndMsRef.current = endMs;
        }
      }

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

        // 4. Reset market price ring buffer
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

      // ── TA Calculations (extracted to computeIndicators.js) ──
      const ind = computeAllIndicators({ candles, klines5m, lastPrice });
      const {
        closes, vwapSeries, vwapNow, vwapSlope, vwapDist,
        rsiNow, rsiSlope, macd, consec, vwapCrossCount,
        bb, atr, volDelta, emaCross, stochRsi,
        volumeRecent, volumeAvg, failedVwapReclaim,
        regimeInfo, lastClose, delta1m, delta3m,
        volProfile, realizedVol, multiTfConfirm,
      } = ind;

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
      const wsStale = wsLastUpdate ? (now - wsLastUpdate > 10_000) : (wsUpPrice === null);
      const wsDataFresh = wsConnected && !slugChanged && !wsStale;

      const earlyMarketUp = wsDataFresh && wsUpPrice !== null ? wsUpPrice : (poly.ok ? poly.prices.up : null);
      const earlyMarketDown = wsDataFresh && wsDownPrice !== null ? wsDownPrice : (poly.ok ? poly.prices.down : null);

      const orderbookSignal = analyzeOrderbook({
        orderbookUp: wsDataFresh ? (wsOrderbook?.up ?? null) : (poly.ok ? poly.orderbook?.up : null),
        orderbookDown: wsDataFresh ? (wsOrderbook?.down ?? null) : (poly.ok ? poly.orderbook?.down : null),
        marketUp: earlyMarketUp,
        marketDown: earlyMarketDown,
      });

      const feedbackStats = getAccuracyStats();
      const detailedFeedback = getDetailedStats();

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
        orderbookUp, orderbookDown,
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
        orderbookUp, orderbookDown,
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
        regimeInfo,
      });
      // Map strength + edge onto rec for UI consumption
      rec.strength = rec.confidence;
      rec.edge = edge.bestEdge;

      // ═══ Asymmetric Bet Sizing ═══
      const betSide = rec.side;
      const betEnsembleProb = betSide === 'UP' ? ensembleUp
        : betSide === 'DOWN' ? ensembleDown : null;
      const betMarketPrice = betSide === 'UP' ? marketUp
        : betSide === 'DOWN' ? marketDown : null;

      const betSizing = computeBetSizing({
        action: rec.action, side: betSide,
        ensembleProb: betEnsembleProb, marketPrice: betMarketPrice,
        edge: edge.bestEdge, confidence: rec.confidence,
        regimeInfo, feedbackStats,
        ml: mlResult.available ? { status: 'ready', side: mlResult.mlSide, confidence: mlResult.mlConfidence } : null,
        bankroll: bankrollRef.current,
      });

      // Feedback
      try {
        autoSettle(marketSlug, lastPrice, priceToBeatRef.current.value, timeLeftMin);
        if (rec.action === 'ENTER' && rec.side && marketSlug) {
          recordPrediction({
            side: rec.side,
            modelProb: rec.side === 'UP' ? ensembleUp : ensembleDown,
            marketPrice: rec.side === 'UP' ? marketUp : marketDown,
            btcPrice: lastPrice, priceToBeat: priceToBeatRef.current.value, marketSlug,
            regime: regimeInfo.regime,
            mlConfidence: mlResult.available ? mlResult.mlConfidence : null,
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
        detailedFeedback,
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
        betSizing,
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
      if (shallowChanged(prevDataRef.current, nextData)) {
        prevDataRef.current = nextData;
        setData(nextData);
      }
      setLastUpdated(now);
      setLoading(false);
      setError(null);
      firstPollDoneRef.current = true;

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

  return {
    data, loading, error, lastUpdated,
    setBankroll: (v) => {
      bankrollRef.current = v;
      try { localStorage.setItem('btc15m_bankroll', String(v)); } catch {}
    },
  };
}