/**
 * Main analysis + trading loop — MAXIMUM SPEED edition.
 *
 * Speed optimizations vs original REST-only version:
 * 1. Binance WebSocket for real-time BTC price (~100ms vs 5s REST poll)
 * 2. CLOB WebSocket for real-time Polymarket prices + orderbook
 * 3. Tiered fetching: klines every 2s, market discovery every 30s, 5m klines every 10s
 * 4. WS price used for ML/edge when available (sub-second latency)
 * 5. Poll reduced to 2s (klines needed for indicators)
 *
 * Data source priority:
 *   BTC price:      Binance WS (instant)  → REST lastPrice (fallback)
 *   Market prices:  CLOB WS (instant)     → REST orderbook (fallback)
 *   Orderbook:      CLOB WS (instant)     → REST orderbook (fallback)
 *   Klines 1m:      REST (every 2s)       — no WS equivalent for historical
 *   Klines 5m:      REST (every 10s)      — cached between polls
 *   Market disc:    REST (every 30s)       — market changes every 15min
 */

import { CONFIG, BOT_CONFIG } from './config.js';
import { createLogger } from './logger.js';

// WebSocket streams (real-time)
import {
  getPrice as getBinancePrice,
  isConnected as isBinanceConnected,
} from './streams/binanceWs.js';
import {
  getUpPrice as getClobUpPrice,
  getDownPrice as getClobDownPrice,
  getOrderbook as getClobOrderbook,
  getLastUpdate as getClobLastUpdate,
  isClobConnected,
  setTokenIds,
} from './streams/clobWs.js';
import {
  getPrice as getPolyLivePrice,
  isConnected as isPolyLiveConnected,
  getLastUpdate as getPolyLiveLastUpdate,
} from './streams/polymarketLiveWs.js';
import {
  getPrice as getChainlinkWssPrice,
  isConnected as isChainlinkWssConnected,
  getLastUpdate as getChainlinkWssLastUpdate,
} from './streams/chainlinkWss.js';

// REST fetchers (fallback + klines)
import {
  fetchKlines,
  fetchLastPrice,
  fetchPolymarketSnapshot,
  fetchChainlinkBtcUsd,
  fetchFundingRate,
} from './adapters/dataFetcher.js';

// ML (loaded from disk)
import { getMLPrediction, isMLReady } from './adapters/mlLoader.js';

// Feedback (JSON file persistence)
import {
  getAccuracyStats,
  getDetailedStats,
  recordPrediction,
  autoSettle,
  onMarketSwitch,
  saveFeedbackToDisk,
} from './adapters/feedbackStore.js';

// Shared pure JS modules — 100% reusable
import { computeAllIndicators } from '../../src/hooks/computeIndicators.js';
import { scoreDirection, applyTimeAwareness } from '../../src/engines/probability.js';
import { computeEdge, decide } from '../../src/engines/edge.js';
import { computeBetSizing } from '../../src/engines/asymmetricBet.js';
import { analyzeOrderbook } from '../../src/engines/orderbook.js';
import {
  getCandleWindowTiming,
  extractPriceToBeat,
  getSessionName,
  narrativeFromSign,
  narrativeFromSlope,
} from '../../src/utils.js';

// Arbitrage detection
import { detectArbitrage } from './engines/arbitrage.js';

// Fill tracking
import {
  trackOrderPlacement,
  checkPendingFill,
  getFillRate,
  hasPendingOrder,
  getFillTrackerStatus,
} from './trading/fillTracker.js';

// Trading
import { placeBuyOrder, isClientReady } from './trading/clobClient.js';
import {
  recordTrade,
  settleTrade,
  hasOpenPosition,
  getBankroll,
  getDailyPnLPct,
  getConsecutiveLosses,
  getStats,
  getCurrentPosition,
  unwindPosition,
  saveState as savePositionState,
} from './trading/positionTracker.js';

// Safety
import { shouldHalt, validateTrade, validatePrice } from './safety/guards.js';

// Smart trade filters
import {
  applyTradeFilters,
  recordLoss,
  recordTradeForMarket,
  resetMarketTradeCount,
  getFilterStatus,
} from './safety/tradeFilters.js';

// Orderbook flow tracking
import {
  recordOrderbookSnapshot,
  getOrderbookFlow,
  checkFlowAlignment,
  resetFlow,
} from './engines/orderbookFlow.js';

// Status broadcast (dashboard integration)
import { broadcast } from './statusServer.js';

// Live Polymarket data logger (writes CSV to backtest/ml_training/)
import { shouldLog as shouldLogPoly, logSnapshot as logPolySnapshot } from './polymarketLogger.js';

const log = createLogger('Loop');

// ── Pause/Resume control ──
let paused = false;

export function pauseBot() { paused = true; log.info('Bot PAUSED by dashboard'); }
export function resumeBot() { paused = false; log.info('Bot RESUMED by dashboard'); }
export function isPaused() { return paused; }

// ── Position callback (injected from index.js to avoid circular imports) ──
let _getPositionsSummary = null;
export function registerPositionCallback(fn) { _getPositionsSummary = fn; }

// ── Module-level state ──
let currentMarketSlug = null;
let currentMarketEndMs = null;
let priceToBeat = { slug: null, value: null };
let pollCounter = 0;
let polling = false;
let tokenIdsNotified = false;

// Market price ring buffer (for momentum calculation)
const marketUpHistory = { buf: new Float64Array(24), idx: 0, count: 0 };

// ═══ Anti-Whipsaw: Signal Stability Engine ═══
// Only 2 mechanisms (EMA smoothing REMOVED — it adds harmful lag):
//   1. Signal confirmation: ENTER must persist N consecutive polls
//   2. Flip detector: block if market is flipping too rapidly (indecisive)
const SIGNAL_CONFIRM_POLLS = 3;      // Must see same ENTER side N polls in a row (3 × 500ms = 1.5s)
const FLIP_WINDOW_MS = 15_000;       // Track flips in last 15 seconds
const MAX_FLIPS_TO_ENTER = 4;        // Block entry if signal flipped > N times in window (4 = very unstable)

let signalConfirmCount = 0;           // Consecutive polls with same ENTER+side
let signalConfirmSide = null;         // Which side is being confirmed ('UP'|'DOWN'|null)
const signalFlipHistory = [];         // Array of { ts, side } for flip tracking
let lastSignalSide = null;            // Previous poll's decided side (for flip detection)

// ── Tiered cache ──
// Polymarket market discovery (slow: every 30s, market changes every 15min)
let polySnapshotCache = null;
let polyLastFetchMs = 0;
const MARKET_DISCOVERY_INTERVAL = 30_000;

// 5-minute klines (slow: every 10s, only needed for multi-TF)
let klines5mCache = null;
let klines5mLastFetchMs = 0;
const KLINES_5M_INTERVAL = 10_000;

// Chainlink RPC (slow: every 30s, supplementary price source)
let chainlinkCache = { price: null, updatedAt: null, source: 'chainlink_rpc' };
let chainlinkLastFetchMs = 0;
const CHAINLINK_INTERVAL = 30_000;


function resetMarketCache() {
  polySnapshotCache = null;
  polyLastFetchMs = 0;
  currentMarketEndMs = null;
  priceToBeat = { slug: null, value: null };
  tokenIdsNotified = false;
  marketUpHistory.buf.fill(0);
  marketUpHistory.idx = 0;
  marketUpHistory.count = 0;
  // Reset signal stability state for new market
  signalConfirmCount = 0;
  signalConfirmSide = null;
  signalFlipHistory.length = 0;
  lastSignalSide = null;
}

/**
 * Single poll iteration — full analysis + trading pipeline.
 * Optimized: uses WebSocket data where available, tiered REST caching.
 */
export async function pollOnce() {
  if (polling) return;
  if (paused) {
    // Still broadcast so dashboard knows bot is alive but paused
    broadcast({ paused: true, ts: Date.now(), bankroll: getBankroll(), stats: getStats() });
    return;
  }
  polling = true;
  pollCounter++;
  const _pollStart = performance.now();

  try {
    // ── 1. Circuit Breaker ──
    const haltCheck = shouldHalt({
      dailyPnLPct: getDailyPnLPct(),
      bankroll: getBankroll(),
      consecutiveLosses: getConsecutiveLosses(),
    });
    if (haltCheck.halt) {
      log.warn(`HALTED: ${haltCheck.reason}`);
      return;
    }

    // ── 1b. Check pending order fills (non-blocking) ──
    const fillResult = await checkPendingFill();
    if (fillResult) {
      if (fillResult.filled) {
        log.info(`Fill confirmed (${(fillResult.timeToFill / 1000).toFixed(1)}s)${fillResult.adverseSelection ? ' [ADVERSE]' : ''}`);
      } else if (fillResult.cancelled) {
        log.warn('Stale order cancelled — fill timeout exceeded');
        // Unwind the pre-recorded position (bankroll was already deducted)
        const pos = getCurrentPosition();
        if (pos) {
          unwindPosition();
          log.info('Position unwound after stale order cancel');
        }
      }
    }

    const now = Date.now();
    const timing = getCandleWindowTiming(CONFIG.candleWindowMinutes);

    // ── 2. Market expiry detection ──
    const marketExpired = currentMarketEndMs !== null && now >= currentMarketEndMs;
    if (marketExpired) {
      log.info('Market expired! Forcing fresh discovery...');
      const pos = getCurrentPosition();
      if (pos && pos.marketSlug === currentMarketSlug) {
        // Determine actual outcome: compare current BTC price to PTB
        const wsPrice = getBinancePrice();
        const currentBtcPrice = wsPrice || pos.price; // best available price
        const ptbValue = priceToBeat.value;
        if (ptbValue != null && currentBtcPrice != null) {
          const actualResult = currentBtcPrice >= ptbValue ? 'UP' : 'DOWN';
          const won = pos.side === actualResult;
          log.info(`Position expired — BTC $${currentBtcPrice.toFixed(0)} vs PTB $${ptbValue.toFixed(0)} → ${actualResult} → ${won ? 'WIN' : 'LOSS'}`);
          settleTrade(won);
          if (!won) recordLoss();
        } else {
          log.warn('Position expired — no PTB data, settling as loss');
          settleTrade(false);
          recordLoss();
        }
      }
      resetMarketCache();
    }

    // ── 3. Tiered data fetch ──
    // Tier 1 (every poll): 1m klines + BTC price (WS or REST fallback)
    // Tier 2 (every 10s): 5m klines
    // Tier 3 (every 30s): Polymarket market discovery, Chainlink RPC

    const needsFreshPoly =
      !polySnapshotCache ||
      now - polyLastFetchMs > MARKET_DISCOVERY_INTERVAL ||
      marketExpired;

    const needsFresh5m =
      !klines5mCache ||
      now - klines5mLastFetchMs > KLINES_5M_INTERVAL;

    const needsChainlink =
      now - chainlinkLastFetchMs > CHAINLINK_INTERVAL;

    // Build parallel fetch array (only what's needed)
    const fetches = [
      // Always: 1m klines (needed for all indicators)
      fetchKlines({ interval: '1m', limit: 240 }),
    ];
    const fetchMap = { klines1m: 0 };

    if (needsFresh5m) {
      fetchMap.klines5m = fetches.length;
      fetches.push(fetchKlines({ interval: '5m', limit: 48 }));
    }

    // BTC price: prefer WS, only fetch REST if WS is down
    const wsPrice = getBinancePrice();
    if (!wsPrice) {
      fetchMap.lastPrice = fetches.length;
      fetches.push(fetchLastPrice());
    }

    if (needsFreshPoly) {
      fetchMap.poly = fetches.length;
      fetches.push(fetchPolymarketSnapshot());
    }

    if (needsChainlink) {
      fetchMap.chainlink = fetches.length;
      fetches.push(fetchChainlinkBtcUsd().catch(() => chainlinkCache));
    }

    // Execute all in parallel
    const results = await Promise.all(fetches.map(p =>
      p instanceof Promise ? p : Promise.resolve(p)
    ));

    // Unpack results
    const klines1m = results[fetchMap.klines1m];
    const klines5m = fetchMap.klines5m !== undefined ? results[fetchMap.klines5m] : klines5mCache;
    const lastPrice = wsPrice || (fetchMap.lastPrice !== undefined ? results[fetchMap.lastPrice] : klines1m[klines1m.length - 1]?.close);

    if (!klines5m) {
      log.warn('No 5m klines available yet');
      return;
    }

    // Update caches
    if (fetchMap.klines5m !== undefined) { klines5mCache = klines5m; klines5mLastFetchMs = now; }
    if (fetchMap.chainlink !== undefined) { chainlinkCache = results[fetchMap.chainlink]; chainlinkLastFetchMs = now; }

    const poly = fetchMap.poly !== undefined ? results[fetchMap.poly] : polySnapshotCache;
    if (fetchMap.poly !== undefined) {
      polySnapshotCache = poly;
      polyLastFetchMs = now;
      if (poly.ok && poly.market?.endDate) {
        const endMs = new Date(poly.market.endDate).getTime();
        if (Number.isFinite(endMs)) currentMarketEndMs = endMs;
      }
    }

    // Funding rate — always null (blocked)
    const fundingRate = null;

    // ── 4. Market slug tracking + switch detection ──
    const marketSlug = poly?.ok ? String(poly.market?.slug ?? '') : '';
    const slugChanged =
      marketSlug !== '' &&
      currentMarketSlug !== null &&
      currentMarketSlug !== marketSlug;

    if (slugChanged) {
      const oldSlug = currentMarketSlug;
      log.info(`Market switched: "${oldSlug}" -> "${marketSlug}"`);

      const pos = getCurrentPosition();
      if (pos && pos.marketSlug === oldSlug) {
        // Determine actual outcome: market resolved, check BTC vs PTB
        const wsPrice = getBinancePrice();
        const currentBtcPrice = wsPrice || pos.price;
        const ptbValue = priceToBeat.value;
        if (ptbValue != null && currentBtcPrice != null) {
          const actualResult = currentBtcPrice >= ptbValue ? 'UP' : 'DOWN';
          const won = pos.side === actualResult;
          log.info(`Position settled on market switch — BTC $${currentBtcPrice.toFixed(0)} vs PTB $${ptbValue.toFixed(0)} → ${actualResult} → ${won ? 'WIN' : 'LOSS'}`);
          settleTrade(won);
          if (!won) recordLoss();
        } else {
          log.warn('Position expired on market switch — no PTB data, settling as loss');
          settleTrade(false);
          recordLoss();
        }
      }

      resetMarketCache();
      resetFlow();
      resetMarketTradeCount(oldSlug);
      onMarketSwitch(oldSlug, marketSlug);
    }

    if (marketSlug) currentMarketSlug = marketSlug;

    if (!poly?.ok) {
      log.warn(`Polymarket: ${poly?.reason ?? 'no snapshot'}`);
      return;
    }

    // Notify CLOB WS of token IDs
    if (poly.tokens && !tokenIdsNotified) {
      setTokenIds(poly.tokens.upTokenId, poly.tokens.downTokenId);
      tokenIdsNotified = true;
    }

    // ── 5. Compute all indicators ──
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

    // Price to beat
    const ptb = extractPriceToBeat(poly.market, klines1m);
    if (marketSlug && priceToBeat.slug !== marketSlug) {
      priceToBeat = { slug: marketSlug, value: ptb };
    } else if (ptb !== null) {
      priceToBeat.value = ptb;
    }

    // ── Market prices: WS (instant) → REST (fallback) ──
    const clobConnected = isClobConnected();
    const clobLastUpdate = getClobLastUpdate();
    const clobStale = clobLastUpdate ? (now - clobLastUpdate > 10_000) : true;
    const useClobWs = clobConnected && !clobStale;

    const marketUp = useClobWs ? (getClobUpPrice() ?? poly.prices.up) : poly.prices.up;
    const marketDown = useClobWs ? (getClobDownPrice() ?? poly.prices.down) : poly.prices.down;

    // Orderbook: WS (instant) → REST (fallback)
    const wsBook = useClobWs ? getClobOrderbook() : null;
    const orderbookUp = (wsBook?.up?.bestBid != null) ? wsBook.up : (poly?.orderbook?.up ?? null);
    const orderbookDown = (wsBook?.down?.bestBid != null) ? wsBook.down : (poly?.orderbook?.down ?? null);

    const orderbookSignal = analyzeOrderbook({
      orderbookUp, orderbookDown, marketUp, marketDown,
    });

    // ── 5b. Arbitrage detection (BEFORE directional logic) ──
    const arb = detectArbitrage({ orderbookUp, orderbookDown, marketUp, marketDown });
    if (arb.found) {
      log.info(
        `ARB DETECTED: buy UP@${arb.askUp.toFixed(3)} + DOWN@${arb.askDown.toFixed(3)} ` +
        `= $${arb.totalCost.toFixed(4)} -> profit $${arb.netProfit.toFixed(4)} (${arb.profitPct.toFixed(1)}%)` +
        (arb.spreadHealthy ? '' : ' [SPREAD UNHEALTHY]')
      );
    }

    // ── 5c. Orderbook flow tracking ──
    recordOrderbookSnapshot(orderbookSignal, orderbookUp, orderbookDown);
    const obFlow = getOrderbookFlow();

    const feedbackStats = getAccuracyStats();

    // ── 6. Score direction ──
    const scored = scoreDirection({
      price: lastPrice, priceToBeat: priceToBeat.value,
      vwap: vwapNow, vwapSlope, rsi: rsiNow, rsiSlope,
      macd, heikenColor: consec.color, heikenCount: consec.count,
      failedVwapReclaim, delta1m, delta3m, regime: regimeInfo,
      orderbookSignal, volProfile, multiTfConfirm, feedbackStats,
      bb, atr,
    });

    // Settlement timing
    const settlementMs = poly.market?.endDate ? new Date(poly.market.endDate).getTime() : null;
    const settlementLeftMin = settlementMs ? (settlementMs - Date.now()) / 60_000 : null;
    const timeLeftMin = settlementLeftMin ?? timing.remainingMinutes;

    const timeAware = applyTimeAwareness(scored.rawUp, timeLeftMin, CONFIG.candleWindowMinutes);

    // ── 7. Rule-based edge (spread-aware) ──
    const ruleEdge = computeEdge({
      modelUp: timeAware.adjustedUp, modelDown: timeAware.adjustedDown,
      marketYes: marketUp, marketNo: marketDown,
      orderbookUp, orderbookDown,
    });

    // ── 8. ML prediction ──
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

    const mlResult = getMLPrediction({
      price: lastPrice, priceToBeat: priceToBeat.value,
      rsi: rsiNow, rsiSlope, macd, vwap: vwapNow, vwapSlope,
      heikenColor: consec.color, heikenCount: consec.count,
      delta1m, delta3m, volumeRecent, volumeAvg,
      regime: regimeInfo.regime, regimeConfidence: regimeInfo.confidence, session: getSessionName(),
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
    }, timeAware.adjustedUp);

    // ── 9. Ensemble edge (spread-aware) ──
    // No EMA smoothing — raw prob used directly. Smoothing adds lag that hurts
    // genuine breakout entries. Signal confirmation counter handles noise instead.
    const ensembleUp = mlResult.available ? mlResult.ensembleProbUp : timeAware.adjustedUp;
    const ensembleDown = 1 - ensembleUp;

    const edge = computeEdge({
      modelUp: ensembleUp, modelDown: ensembleDown,
      marketYes: marketUp, marketNo: marketDown,
      orderbookUp, orderbookDown,
    });

    const ruleSide = timeAware.adjustedUp >= 0.5 ? 'UP' : 'DOWN';
    const mlAgreesWithRules = mlResult.available && mlResult.mlSide === ruleSide;

    // ── 9b. Signal flip tracking (anti-whipsaw) ──
    const currentSide = ensembleUp >= 0.5 ? 'UP' : 'DOWN';
    if (lastSignalSide !== null && currentSide !== lastSignalSide) {
      signalFlipHistory.push({ ts: now, from: lastSignalSide, to: currentSide });
    }
    lastSignalSide = currentSide;
    // Purge old flips outside the window
    while (signalFlipHistory.length > 0 && now - signalFlipHistory[0].ts > FLIP_WINDOW_MS) {
      signalFlipHistory.shift();
    }
    const recentFlipCount = signalFlipHistory.length;

    // ── Log real Polymarket data for ML training (every 30s, zero alloc when throttled) ──
    if (shouldLogPoly() && lastPrice && marketSlug) {
      logPolySnapshot({
        btcPrice: lastPrice, priceToBeat: priceToBeat.value, marketSlug,
        marketUp, marketDown, marketPriceMomentum,
        orderbookImbalance: orderbookSignal?.imbalance,
        spreadPct: orderbookUp?.spread,
        rsi: rsiNow, rsiSlope, macdHist: macd?.hist, macdLine: macd?.line,
        vwapNow, vwapSlope, haColor: consec.color, haCount: consec.count,
        delta1m, delta3m, volumeRecent, volumeAvg,
        regime: regimeInfo.regime, regimeConfidence: regimeInfo.confidence,
        timeLeftMin,
        bbWidth: bb?.width, bbPercentB: bb?.percentB,
        bbSqueeze: bb?.squeeze, bbSqueezeIntensity: bb?.squeezeIntensity,
        atrPct: atr?.atrPct, atrRatio: atr?.atrRatio,
        volDeltaBuyRatio: volDelta?.buyRatio, volDeltaAccel: volDelta?.deltaAccel,
        emaDistPct: emaCross?.distancePct,
        emaCrossSignal: emaCross?.cross === 'BULL_CROSS' ? 1 : emaCross?.cross === 'BEAR_CROSS' ? -1 : 0,
        stochK: stochRsi?.k, stochKD: stochRsi ? (stochRsi.k - stochRsi.d) : null,
        vwapCrossCount, multiTfAgreement: multiTfConfirm?.agreement,
        failedVwapReclaim, fundingRate: null,
        momentum5CandleSlope, volatilityChangeRatio, priceConsistency,
        ruleEdge: Math.max(ruleEdge.edgeUp ?? 0, ruleEdge.edgeDown ?? 0),
        ensembleUp, mlProbUp: mlResult.mlProbUp, mlConfidence: mlResult.mlConfidence,
      });
    }

    // ── 10. Decision ──
    const rec = decide({
      remainingMinutes: timeLeftMin,
      edgeUp: edge.edgeUp, edgeDown: edge.edgeDown,
      modelUp: ensembleUp, modelDown: ensembleDown,
      breakdown: scored.breakdown,
      multiTfConfirmed: multiTfConfirm?.agreement ?? false,
      mlConfidence: mlResult.available ? mlResult.mlConfidence : null,
      mlAgreesWithRules,
      regimeInfo,
      session: getSessionName(),
    });
    rec.strength = rec.confidence;
    rec.edge = edge.bestEdge;

    // ── 11. Bet sizing ──
    const betSide = rec.side;
    const betEnsembleProb = betSide === 'UP' ? ensembleUp
      : betSide === 'DOWN' ? ensembleDown : null;
    const betMarketPrice = betSide === 'UP' ? marketUp
      : betSide === 'DOWN' ? marketDown : null;

    const bankroll = getBankroll();

    // Build execution context for Kelly multiplier
    const betOrderbook = betSide === 'UP' ? orderbookUp : betSide === 'DOWN' ? orderbookDown : null;
    const executionContext = betOrderbook ? {
      spread: betOrderbook.spread ?? 0,
      askLiquidity: betOrderbook.askLiquidity ?? 0,
      fillRate: getFillRate(),
    } : null;

    const betSizing = computeBetSizing({
      action: rec.action, side: betSide,
      ensembleProb: betEnsembleProb, marketPrice: betMarketPrice,
      edge: edge.bestEdge, confidence: rec.confidence,
      regimeInfo, feedbackStats,
      ml: mlResult.available ? { status: 'ready', side: mlResult.mlSide, confidence: mlResult.mlConfidence } : null,
      bankroll,
      executionContext,
    });

    // ── 12. Feedback tracking ──
    try {
      autoSettle(marketSlug, lastPrice, priceToBeat.value, timeLeftMin);
      if (rec.action === 'ENTER' && rec.side && marketSlug) {
        recordPrediction({
          side: rec.side,
          modelProb: rec.side === 'UP' ? ensembleUp : ensembleDown,
          marketPrice: rec.side === 'UP' ? marketUp : marketDown,
          btcPrice: lastPrice, priceToBeat: priceToBeat.value, marketSlug,
          regime: regimeInfo.regime,
          mlConfidence: mlResult.available ? mlResult.mlConfidence : null,
        });
      }
    } catch { /* feedback should never break main loop */ }

    // ── 13. Trade execution ──
    const alreadyHasPosition = hasOpenPosition(marketSlug);
    const hasPending = hasPendingOrder();

    // 13a. Arbitrage execution (priority over directional — riskless profit)
    if (arb.found && arb.spreadHealthy && !alreadyHasPosition && !hasPending &&
        poly.tokens?.upTokenId && poly.tokens?.downTokenId) {
      const arbShares = Math.floor(bankroll * 0.10 / arb.totalCost); // 10% of bankroll
      if (arbShares > 0) {
        if (BOT_CONFIG.dryRun) {
          log.info(
            `[DRY RUN] ARB: Would BUY ${arbShares} UP@${arb.askUp.toFixed(3)} + ${arbShares} DOWN@${arb.askDown.toFixed(3)} | ` +
            `Cost: $${(arbShares * arb.totalCost).toFixed(2)} | Net profit: $${(arbShares * arb.netProfit).toFixed(2)} (${arb.profitPct.toFixed(1)}%)`
          );
        } else {
          try {
            // Leg 1: Buy UP
            const upResult = await placeBuyOrder({
              tokenId: poly.tokens.upTokenId,
              price: arb.askUp,
              size: arbShares,
            });
            // Leg 2: Buy DOWN — if this fails, we have one-legged exposure
            try {
              await placeBuyOrder({
                tokenId: poly.tokens.downTokenId,
                price: arb.askDown,
                size: arbShares,
              });
            } catch (downErr) {
              // ONE-LEGGED: Only UP bought, DOWN failed — record as directional position
              log.error(`ARB leg 2 (DOWN) failed: ${downErr.message} — recording one-legged UP position`);
              recordTrade({
                side: 'UP',
                tokenId: poly.tokens.upTokenId,
                price: arb.askUp,
                size: arbShares,
                marketSlug,
                orderId: upResult?.id ?? upResult?.orderID ?? null,
              });
              return; // Don't count as successful arb
            }
            const arbCost = arbShares * arb.totalCost;
            log.info(`ARB executed: ${arbShares} pairs @ cost $${arbCost.toFixed(2)} | Expected profit: $${(arbShares * arb.netProfit).toFixed(2)}`);
          } catch (err) {
            log.error(`ARB leg 1 (UP) failed: ${err.message}`);
          }
        }
      }
    }
    // 13b. Directional trade (when no arb and no pending fill)
    else if (rec.action === 'ENTER' && !hasPending) {
      // ── Signal Confirmation Gate (anti-whipsaw) ──
      // Track consecutive polls with same ENTER+side
      if (signalConfirmSide === rec.side) {
        signalConfirmCount++;
      } else {
        signalConfirmSide = rec.side;
        signalConfirmCount = 1;
      }

      // Check if signal is stable enough to act on
      const signalUnconfirmed = signalConfirmCount < SIGNAL_CONFIRM_POLLS;
      const tooManyFlips = recentFlipCount > MAX_FLIPS_TO_ENTER;

      if (signalUnconfirmed || tooManyFlips) {
        const reasons = [];
        if (signalUnconfirmed) reasons.push(`confirm ${signalConfirmCount}/${SIGNAL_CONFIRM_POLLS}`);
        if (tooManyFlips) reasons.push(`${recentFlipCount} flips in ${FLIP_WINDOW_MS / 1000}s`);
        log.debug(`Signal unstable, holding: ${reasons.join(' | ')}`);
      } else {
      // Signal confirmed — proceed with existing trade filters

      // Smart trade filters (confidence gating, 50/50 filter, volatility, cooldown, session)
      const filterResult = applyTradeFilters({
        mlConfidence: mlResult.available ? mlResult.mlConfidence : null,
        mlAvailable: mlResult.available,
        marketPrice: betMarketPrice,
        atrRatio: atr?.atrRatio ?? null,
        timeLeftMin,
        marketSlug,
        consecutiveLosses: getConsecutiveLosses(),
        session: getSessionName(),
      });

      // Orderbook flow alignment check
      const flowAlign = checkFlowAlignment(betSide);

      if (!filterResult.pass) {
        log.debug(`Smart filter blocked: ${filterResult.reasons.join(' | ')}`);
      } else {
      const priceCheck = validatePrice(betMarketPrice);
      const tradeCheck = validateTrade({
        rec, betSizing, timeLeftMin, bankroll,
        hasPosition: alreadyHasPosition,
      });

      if (priceCheck.valid && tradeCheck.valid) {
        const tokenId = betSide === 'UP' ? poly.tokens.upTokenId : poly.tokens.downTokenId;
        const shares = Math.floor(betSizing.betAmount / betMarketPrice);

        // Flow alignment info for logging
        const flowTag = flowAlign.signal !== 'INSUFFICIENT_DATA'
          ? ` | Flow:${flowAlign.signal}${flowAlign.agrees ? '(agree)' : '(DISAGREE)'}`
          : '';

        if (BOT_CONFIG.dryRun) {
          log.info(
            `[DRY RUN] Would BUY ${betSide}: ${shares} shares @ $${betMarketPrice.toFixed(3)} = $${(shares * betMarketPrice).toFixed(2)} | ` +
            `Edge: ${((edge.bestEdge ?? 0) * 100).toFixed(1)}% (spread: -${((edge.spreadPenaltyUp + edge.spreadPenaltyDown) * 50).toFixed(1)}%) | ` +
            `Conf: ${rec.confidence}${flowTag} | ${betSizing.rationale}`
          );
        } else {
          try {
            const orderResult = await placeBuyOrder({
              tokenId,
              price: betMarketPrice,
              size: shares,
            });
            const orderId = orderResult?.id ?? orderResult?.orderID ?? null;
            recordTrade({
              side: betSide,
              tokenId,
              price: betMarketPrice,
              size: shares,
              marketSlug,
              orderId,
            });
            if (orderId) {
              trackOrderPlacement(orderId, { tokenId, price: betMarketPrice, size: shares, side: betSide });
            }
            // Only count as trade if order succeeded (not on failure)
            recordTradeForMarket(marketSlug);
          } catch (err) {
            log.error(`Order failed: ${err.message}`);
          }
        }
      } else {
        log.debug(`Trade blocked: ${!priceCheck.valid ? priceCheck.reason : tradeCheck.reason}`);
      }
      } // end filterResult.pass
      } // end signal confirmed
    }

    // Reset confirmation when signal drops to WAIT (side changed or no longer ENTER)
    if (rec.action !== 'ENTER') {
      signalConfirmCount = 0;
      signalConfirmSide = null;
    }

    // ── 14. Resolve Chainlink price: Polymarket WS > Chainlink WSS > RPC ──
    const polyLivePrice = getPolyLivePrice();
    const polyLiveConnected = isPolyLiveConnected();
    const polyLiveStale = getPolyLiveLastUpdate() ? (now - getPolyLiveLastUpdate() > 30_000) : true;

    const chainlinkWssPrice = getChainlinkWssPrice();
    const chainlinkWssConnected = isChainlinkWssConnected();
    const chainlinkWssStale = getChainlinkWssLastUpdate() ? (now - getChainlinkWssLastUpdate() > 60_000) : true;

    let chainlinkResolved;
    if (polyLiveConnected && polyLivePrice && !polyLiveStale) {
      chainlinkResolved = { price: polyLivePrice, updatedAt: getPolyLiveLastUpdate(), source: 'polymarket_ws' };
    } else if (chainlinkWssConnected && chainlinkWssPrice && !chainlinkWssStale) {
      chainlinkResolved = { price: chainlinkWssPrice, updatedAt: getChainlinkWssLastUpdate(), source: 'chainlink_wss' };
    } else {
      chainlinkResolved = chainlinkCache;
    }

    // ── 15. Status log ──
    const mlTag = mlResult.available
      ? `ML:${(mlResult.mlProbUp * 100).toFixed(0)}%/${(mlResult.mlConfidence * 100).toFixed(0)}%`
      : 'ML:off';
    const edgeTag = edge.bestEdge !== null ? `${(edge.bestEdge * 100).toFixed(1)}%` : 'N/A';
    const arbTag = arb.found ? `ARB:${arb.profitPct.toFixed(1)}%` : 'ARB:no';
    const fillTag = `Fill:${(getFillRate() * 100).toFixed(0)}%`;
    const flowTag = obFlow.sampleCount >= 5 ? `Flow:${obFlow.flowSignal}` : '';
    const clSrc = chainlinkResolved.source === 'polymarket_ws' ? 'PolyWS'
      : chainlinkResolved.source === 'chainlink_wss' ? 'CLWSS' : 'RPC';
    const srcTag = `${isBinanceConnected() ? 'WS' : 'REST'}+${useClobWs ? 'WS' : 'REST'}+CL:${clSrc}`;

    const _pollMs = (performance.now() - _pollStart).toFixed(0);
    const stabTag = `Stab:${signalConfirmCount}/${SIGNAL_CONFIRM_POLLS}${recentFlipCount > 0 ? ` F${recentFlipCount}` : ''}`;
    log.info(
      `#${pollCounter} [${_pollMs}ms] | BTC $${lastPrice.toFixed(0)} | PTB $${(priceToBeat.value ?? 0).toFixed(0)} | ` +
      `P:${(ensembleUp * 100).toFixed(0)}% E:${edgeTag} ${mlTag} | ` +
      `${rec.action}${rec.side ? ' ' + rec.side : ''} [${rec.confidence}] ${rec.phase} | ` +
      `T:${timeLeftMin?.toFixed(1) ?? '?'}m | $${bankroll.toFixed(0)} | ` +
      `${regimeInfo.regime} | ${stabTag} ${arbTag} ${fillTag} ${flowTag} | ${srcTag}`
    );

    // ── 16. Compute narratives + broadcast full state to dashboard ──
    const macdLabel = macd === null ? '-' : macd.hist < 0
      ? (macd.histDelta != null && macd.histDelta < 0 ? 'Bearish (expanding)' : 'Bearish')
      : (macd.histDelta != null && macd.histDelta > 0 ? 'Bullish (expanding)' : 'Bullish');
    const haNarrative = (consec.color ?? '').toLowerCase() === 'green' ? 'LONG'
      : (consec.color ?? '').toLowerCase() === 'red' ? 'SHORT' : 'NEUTRAL';
    const rsiNarrative = narrativeFromSlope(rsiSlope);
    const macdNarrative = narrativeFromSign(macd?.hist ?? null);
    const vwapNarrative = narrativeFromSign(vwapDist);
    const vwapSlopeLabel = vwapSlope == null ? '-' : vwapSlope > 0 ? 'UP' : vwapSlope < 0 ? 'DOWN' : 'FLAT';

    const marketQuestion = poly.ok ? (poly.market?.question ?? poly.market?.title ?? '') : '';
    const liquidity = poly.ok
      ? Number(poly.market?.liquidityNum) || Number(poly.market?.liquidity) || null
      : null;

    const detailedFeedback = getDetailedStats();

    // Include positions every 60th poll (~30s at 500ms)
    const positionsSummary = (pollCounter % 60 === 0 && _getPositionsSummary)
      ? _getPositionsSummary()
      : undefined;

    broadcast({
      // ═══ Bot-specific fields (for BotPanel) ═══
      paused: false,
      ts: Date.now(),
      pollCounter,
      btcPrice: lastPrice,
      dryRun: BOT_CONFIG.dryRun,
      stats: getStats(),
      ...(positionsSummary ? { positions: positionsSummary } : {}),
      indicators: {
        rsi: rsiNow,
        macd: macd?.hist,
        vwapDist,
        delta1m,
        consec: consec.count,
        consecColor: consec.color,
      },
      sources: { binanceWs: isBinanceConnected(), clobWs: useClobWs },
      regime: regimeInfo.regime,
      regimeConfidence: regimeInfo.confidence,
      bankroll,
      ensembleUp,
      ensembleDown,

      // ═══ useMarketData-compatible fields (dashboard panels) ═══
      lastPrice,
      chainlinkRpc: chainlinkResolved,
      poly,
      marketUp,
      marketDown,
      marketSlug,
      liquidity,
      settlementMs,
      settlementLeftMin,
      orderbookUp,
      orderbookDown,
      clobSource: useClobWs ? 'WebSocket' : 'REST',
      clobWsConnected: clobConnected,
      priceToBeat: priceToBeat.value,
      marketQuestion,

      // Indicators (full objects)
      vwapNow, vwapDist, vwapSlope, vwapSlopeLabel,
      rsiNow, rsiSlope,
      macd,
      macdLabel,
      consec,
      delta1m, delta3m, lastClose,
      bb, atr, volDelta, emaCross, stochRsi,
      fundingRate,

      // Narratives
      haNarrative, rsiNarrative, macdNarrative, vwapNarrative,

      // Probability
      pLong: ensembleUp,
      pShort: ensembleDown,
      ruleUp: timeAware.adjustedUp,
      ruleDown: timeAware.adjustedDown,
      rawUp: scored.rawUp,
      rawDown: scored.rawDown,
      scoreBreakdown: scored.breakdown,
      timeDecay: timeAware.timeDecay,

      // Regime + Edge + Decision
      regimeInfo,
      edge,
      rec,
      timeLeftMin,
      timing,
      orderbookSignal,

      // Arbitrage + Execution + Flow (math-based features)
      arbitrage: arb,
      fillTracker: getFillTrackerStatus(),
      orderbookFlow: obFlow,
      tradeFilters: getFilterStatus(),

      // Signal stability (anti-whipsaw)
      signalStability: {
        confirmCount: signalConfirmCount,
        confirmNeeded: SIGNAL_CONFIRM_POLLS,
        confirmSide: signalConfirmSide,
        recentFlips: recentFlipCount,
        maxFlips: MAX_FLIPS_TO_ENTER,
        stable: signalConfirmCount >= SIGNAL_CONFIRM_POLLS && recentFlipCount <= MAX_FLIPS_TO_ENTER,
      },

      // Volatility + Multi-TF
      volProfile,
      realizedVol,
      multiTfConfirm,

      // Feedback
      feedbackStats,
      detailedFeedback,

      // Volume features
      volumeRecent, volumeAvg,
      volumeRatio: volumeAvg > 0 ? volumeRecent / volumeAvg : 1,
      vwapCrossCount,
      failedVwapReclaim,

      // Bet sizing (full object)
      betSizing,

      // ML (full object matching useMarketData shape)
      ml: mlResult.available ? {
        probUp: mlResult.mlProbUp,
        confidence: mlResult.mlConfidence,
        side: mlResult.mlSide,
        ensembleProbUp: mlResult.ensembleProbUp,
        alpha: mlResult.alpha,
        source: mlResult.source,
        status: 'ready',
        available: true,
      } : {
        probUp: null, confidence: null, side: null,
        ensembleProbUp: null, alpha: 0,
        source: 'Rule-only', status: isMLReady() ? 'ready' : 'not_loaded',
        available: false,
      },

      // Connection statuses for dashboard header
      binanceConnected: isBinanceConnected(),
      binancePrice: lastPrice,
      polyLiveConnected,
      chainlinkWssConnected,
      chainlinkSource: chainlinkResolved.source,
    });

    // Periodic save (every ~120 polls at 2s = ~4min)
    if (pollCounter % 120 === 0) {
      saveFeedbackToDisk();
      savePositionState();
    }

  } catch (err) {
    log.error(`Poll error: ${err.message}`);
  } finally {
    polling = false;
  }
}
