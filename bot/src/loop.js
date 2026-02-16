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
 *
 * Module extraction (from original 1700-line monolith):
 *   signalStability.js  — anti-whipsaw signal confirmation + flip tracking
 *   tieredCache.js      — fetch interval management for all data sources
 *   usdcSync.js         — USDC on-chain balance reconciliation
 *   settlement.js       — position settlement (expiry, switch, stale)
 *   signalComputation.js — indicators + scoring + ML + edge pipeline
 *   tradePipeline.js    — arb + directional trade execution
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
} from './adapters/dataFetcher.js';

// ML (loaded from disk)
import { getMLPrediction, isMLReady } from './adapters/mlLoader.js';

// Feedback (JSON file persistence)
import {
  getAccuracyStats,
  getDetailedStats,
  recordPrediction,
  settlePrediction,
  autoSettle,
  onMarketSwitch,
  saveFeedbackToDisk,
} from './adapters/feedbackStore.js';

// Signal performance (JSON file persistence)
import { saveSignalPerfToDisk } from './adapters/signalPerfStore.js';

// Shared pure JS modules
import { computeBetSizing } from '../../src/engines/asymmetricBet.js';
import { decide } from '../../src/engines/edge.js';
import {
  getCandleWindowTiming,
  getSessionName,
  narrativeFromSign,
  narrativeFromSlope,
} from '../../src/utils.js';

// Fill tracking
import {
  trackOrderPlacement,
  checkPendingFill,
  getFillRate,
  hasPendingOrder,
  getFillTrackerStatus,
  registerPendingOrder,
} from './trading/fillTracker.js';

// Trading
import { placeBuyOrder, isClientReady, getUsdcBalance, getOpenOrders, cancelAllOrders, getTradeHistory } from './trading/clobClient.js';
import {
  recordTrade,
  settleTrade,
  settleTradeEarlyExit,
  hasOpenPosition,
  getBankroll,
  getAvailableBankroll,
  getDailyPnLPct,
  getConsecutiveLosses,
  getStats,
  getCurrentPosition,
  unwindPosition,
  confirmFill,
  setPendingCost,
  getPendingCost,
  recordArbTrade,
  acquireSellLock,
  releaseSellLock,
  setBankroll,
  getLastSettled,
  setLastSettled,
  getLastSettlementMs,
  getDrawdownPct,
  saveState as savePositionState,
  getMarketTradeCounts,
  setMarketTradeCounts,
  getLastLossTimestamp,
  setLastLossTimestamp,
} from './trading/positionTracker.js';
import { closePosition } from './trading/positionManager.js';
import { evaluateCutLoss, resetCutLossState, recordSellAttempt, resetCutConfirm, getCutLossStatus } from './trading/cutLoss.js';
import { captureEntrySnapshot, writeJournalEntry, clearEntrySnapshot, getRecentJournal } from './trading/tradeJournal.js';

// Safety
import { shouldHalt, validateTrade, validatePrice } from './safety/guards.js';
import {
  applyTradeFilters,
  recordLoss,
  recordTradeForMarket,
  resetMarketTradeCount,
  getFilterStatus,
  exportMarketTradeCounts,
  importMarketTradeCounts,
  getLastLossTimestamp as getFilterLastLoss,
  importLastLossTimestamp,
} from './safety/tradeFilters.js';

// Orderbook flow tracking
import { checkFlowAlignment, resetFlow } from './engines/orderbookFlow.js';

// Status broadcast (dashboard integration)
import { broadcast } from './statusServer.js';

// External notifications (Telegram/Discord)
import { notify } from './monitoring/notifier.js';

// Live Polymarket data logger
import { shouldLog as shouldLogPoly, logSnapshot as logPolySnapshot } from './polymarketLogger.js';

// ── Extracted modules ──
import {
  trackSignal,
  updateConfirmation,
  decayConfirmation,
  isSignalStable,
  getInstabilityReasons,
  getSignalStabilityStatus,
  resetSignalState,
  getConfirmCount,
  SIGNAL_CONFIRM_POLLS,
} from './engines/signalStability.js';
import {
  getRefreshNeeds,
  updateKlines5m,
  updateChainlink,
  updatePolySnapshot,
  getKlines5mCache,
  getChainlinkCache,
  getPolySnapshotCache,
  resetCaches,
} from './engines/tieredCache.js';
import {
  applyPendingSync,
  scheduleUsdcCheck,
  queueSync,
  invalidateSync,
  getUsdcBalanceData,
} from './engines/usdcSync.js';
import {
  handleExpiry,
  handleSwitch,
  handleStalePosition,
} from './engines/settlement.js';
import { computeSignals, resetMarketUpHistory } from './engines/signalComputation.js';
import { executeArbitrage, executeDirectionalTrade } from './engines/tradePipeline.js';

const log = createLogger('Loop');

// ── Pause/Resume control ──
let paused = false;

export function pauseBot(source = 'dashboard') { paused = true; log.info(`Bot PAUSED (${source})`); }
export function resumeBot(source = 'dashboard') { paused = false; log.info(`Bot RESUMED (${source})`); }
export function isPaused() { return paused; }

// ── Position callback (injected from index.js to avoid circular imports) ──
let _getPositionsSummary = null;
export function registerPositionCallback(fn) { _getPositionsSummary = fn; }

// ── Module-level state (stays in loop.js — lifecycle/identity) ──
let currentMarketSlug = null;
let currentMarketEndMs = null;
let currentConditionId = null;
let priceToBeat = { slug: null, value: null, updatedAt: 0 };

// ── Market transition grace period ──
let marketTransitionMs = 0;
const MARKET_TRANSITION_GRACE_MS = 5_000;

// ── Tilt protection (post-cut-loss cooldown) ──
let tiltMarketsLeft = 0;
const TILT_ML_CONF_MIN = 0.60;
const TILT_MARKETS = 2;

// ── Entry regime tracking ──
let entryRegime = null;
export function resetEntryRegime() { entryRegime = null; }

let pollCounter = 0;
let polling = false;
let tokenIdsNotified = false;
let startupUsdcChecked = false;
let startupOrdersReconciled = false;
let startupTradeCountsLoaded = false;

function resetMarketCache() {
  resetCaches();
  resetSignalState();
  resetMarketUpHistory();
  currentMarketEndMs = null;
  currentConditionId = null;
  priceToBeat = { slug: null, value: null, updatedAt: 0 };
  tokenIdsNotified = false;
}

// ── Shared settlement actions (DRY — used by expiry, switch, stale) ──
function makeSettlementActions() {
  return {
    settleTrade,
    unwindPosition,
    invalidateUsdcSync: invalidateSync,
    clearEntrySnapshot,
    writeJournalEntry,
    recordLoss,
    settlePrediction,
    setLastSettled,
    getBankroll,
    notifyTrade: BOT_CONFIG.telegramNotifyTrades
      ? (msg) => notify('info', msg, { key: 'trade:settle' })
      : null,
  };
}

/**
 * Single poll iteration — full analysis + trading pipeline.
 */
export async function pollOnce() {
  if (polling) return;
  if (paused) {
    broadcast({ paused: true, ts: Date.now(), bankroll: getBankroll(), stats: getStats() });
    return;
  }
  polling = true;
  applyPendingSync(getBankroll, setBankroll);
  pollCounter++;

  // H7: Restore per-market trade counts + loss cooldown from persisted state on first poll
  if (!startupTradeCountsLoaded) {
    startupTradeCountsLoaded = true;
    importMarketTradeCounts(getMarketTradeCounts());
    importLastLossTimestamp(getLastLossTimestamp()); // FINTECH: restore cooldown across restart
  }
  const _pollStart = performance.now();

  try {
    // ── 1. Circuit Breaker ──
    const haltCheck = shouldHalt({
      dailyPnLPct: getDailyPnLPct(),
      bankroll: getBankroll(),
      consecutiveLosses: getConsecutiveLosses(),
      drawdownPct: getDrawdownPct(),
    });
    if (haltCheck.halt) {
      log.warn(`HALTED: ${haltCheck.reason}`);
      notify('critical', `CIRCUIT BREAKER: ${haltCheck.reason} | Bankroll: $${getBankroll().toFixed(2)}`);
      broadcast({ halted: true, haltReason: haltCheck.reason, ts: Date.now(), bankroll: getBankroll(), stats: getStats() });
      return;
    }

    // ── 1b. Check pending order fills (non-blocking) ──
    const fillResults = await checkPendingFill();
    if (fillResults) {
      for (const fillResult of fillResults) {
        if (fillResult.rejected) {
          // FOK order was rejected (not filled) — unwind phantom position
          log.warn(`FOK REJECTED: order ${fillResult.orderId} — unwinding phantom position`);
          const pos = getCurrentPosition();
          if (pos && !pos.settled) {
            unwindPosition();
            writeJournalEntry({ outcome: 'REJECTED', pnl: 0, exitData: { reason: 'FOK rejection — no matching trade in history' } });
            clearEntrySnapshot();
          }
          notify('warning', `FOK order rejected — position unwound | Bankroll: $${getBankroll().toFixed(2)}`);
        } else if (fillResult.filled) {
          confirmFill();
          log.info(`Fill ${fillResult.verified ? 'verified' : 'assumed'} (${(fillResult.timeToFill / 1000).toFixed(1)}s)${fillResult.adverseSelection ? ' [ADVERSE]' : ''}`);
        } else if (fillResult.cancelled) {
          log.warn('Stale order cancelled — fill timeout exceeded');
          const pos = getCurrentPosition();
          if (pos && pos.side === 'ARB') {
            log.warn('Stale cancel for ARB position — NOT unwinding (on-chain settlement handles it)');
          } else if (pos) {
            unwindPosition();
            writeJournalEntry({ outcome: 'UNWIND', pnl: 0, exitData: {} });
            clearEntrySnapshot();
            log.info('Position unwound after stale order cancel');
          }
        }
      }
    }

    // ── 1c. Startup USDC balance reconciliation (runs once) ──
    if (!startupUsdcChecked && isClientReady()) {
      startupUsdcChecked = true;
      try {
        const result = await getUsdcBalance();
        if (result) {
          const localBankroll = getBankroll();
          const onChain = result.balance;
          const drift = Math.abs(localBankroll - onChain);
          log.info(`Startup USDC check: on-chain=$${onChain.toFixed(2)} | local=$${localBankroll.toFixed(2)} | drift=$${drift.toFixed(2)}`);
          const pos = getCurrentPosition();
          const hasPos = pos && !pos.settled;
          if (drift > 5 && !hasPos) {
            log.warn(`Startup USDC auto-sync: drift $${drift.toFixed(2)} > $5 (no position) — syncing`);
            queueSync(onChain);
          } else if (drift > 5 && hasPos) {
            log.error(`Startup USDC DRIFT: $${drift.toFixed(2)} with open position — manual intervention may be needed`);
            notify('warn', `Startup USDC drift: $${drift.toFixed(2)} (local=$${localBankroll.toFixed(2)} vs on-chain=$${onChain.toFixed(2)}) with open position`);
          } else if (drift > 1) {
            log.warn(`Startup USDC drift: $${drift.toFixed(2)} (minor, will sync on next idle cycle)`);
          }
        }
      } catch (err) {
        log.debug(`Startup USDC check failed: ${err.message}`);
      }
    }

    // ── 1d. Startup open order reconciliation (runs once) ──
    if (!startupOrdersReconciled && isClientReady()) {
      startupOrdersReconciled = true;
      try {
        const openOrders = await getOpenOrders();
        const pos = getCurrentPosition();
        const hasPos = pos && !pos.settled;

        if (openOrders.length > 0 && !hasPos) {
          // Orphan orders on CLOB, no local position — cancel all
          log.warn(`Startup reconciliation: ${openOrders.length} orphan order(s) found with no local position — cancelling all`);
          try { await cancelAllOrders(); } catch (e) { log.warn(`Cancel orphans failed: ${e.message}`); }
          notify('warn', `Startup: cancelled ${openOrders.length} orphan order(s) (no local position)`);
        } else if (openOrders.length > 0 && hasPos) {
          // Orders exist + local position exists → register in fillTracker for monitoring
          log.info(`Startup reconciliation: ${openOrders.length} open order(s) found with local position — registering for fill tracking`);
          for (const order of openOrders) {
            const orderId = order.id ?? order.orderID ?? order.order_id;
            if (orderId) {
              registerPendingOrder(orderId, {
                tokenId: order.asset_id ?? order.tokenID ?? '',
                price: parseFloat(order.price) || 0,
                size: parseFloat(order.original_size ?? order.size) || 0,
                side: order.side ?? pos.side ?? 'UNKNOWN',
              });
            }
          }
        } else if (openOrders.length === 0 && hasPos && !pos.fillConfirmed) {
          // No orders + local position with unconfirmed fill → check trade history
          log.info('Startup reconciliation: no open orders, unconfirmed position — checking trade history');
          try {
            const trades = await getTradeHistory({ assetId: pos.tokenId, after: pos.entryTime || (Date.now() - 30 * 60_000) });
            if (trades.length > 0) {
              // Trades found → order was filled, flag was lost
              confirmFill();
              log.info(`Startup reconciliation: trade history confirms fill — position marked as filled (${trades.length} trade(s))`);
            } else {
              // No trades → phantom position (order never filled)
              log.warn(`Startup reconciliation: no trades found for position ${pos.side} on ${pos.marketSlug} — unwinding phantom position (returning $${pos.cost.toFixed(2)})`);
              unwindPosition();
              writeJournalEntry({ outcome: 'UNWIND', pnl: 0, exitData: { startupReconciliation: true, reason: 'phantom_position' } });
              clearEntrySnapshot();
              notify('warn', `Startup: unwound phantom position ${pos.side} on ${pos.marketSlug} ($${pos.cost.toFixed(2)} returned)`);
            }
          } catch (histErr) {
            // Trade history check failed — don't unwind (conservative)
            log.warn(`Startup reconciliation: trade history check failed: ${histErr.message} — keeping position (conservative)`);
          }
        } else if (openOrders.length === 0 && !hasPos) {
          log.info('Startup order reconciliation: clean state (no orders, no position)');
        } else {
          log.info('Startup order reconciliation: position fill already confirmed');
        }
      } catch (err) {
        log.warn(`Startup order reconciliation failed: ${err.message} — will retry next poll`);
        startupOrdersReconciled = false; // Retry next poll
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
        await handleExpiry(
          { pos, currentMarketSlug, currentConditionId, priceToBeat, now },
          {
            getLastSettled, setLastSettled,
            getOraclePrice: () => getPolyLivePrice() || getChainlinkWssPrice(),
            getBinancePrice,
          },
          makeSettlementActions(),
        );
      }
      resetCutLossState();
      resetMarketTradeCount(currentMarketSlug);
      resetMarketCache();
      entryRegime = null;
    }

    // ── 3. Tiered data fetch ──
    const { needsFreshPoly, needsFresh5m, needsChainlink } = getRefreshNeeds(now, marketExpired);

    const fetches = [fetchKlines({ interval: '1m', limit: 240 })];
    const fetchMap = { klines1m: 0 };

    if (needsFresh5m) {
      fetchMap.klines5m = fetches.length;
      fetches.push(fetchKlines({ interval: '5m', limit: 48 }));
    }

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
      fetches.push(fetchChainlinkBtcUsd().catch(() => getChainlinkCache()));
    }

    const settled = await Promise.allSettled(fetches.map(p =>
      p instanceof Promise ? p : Promise.resolve(p)
    ));
    const results = settled.map(r => r.status === 'fulfilled' ? r.value : null);

    for (const [key, idx] of Object.entries(fetchMap)) {
      if (settled[idx].status === 'rejected') {
        log.warn(`Fetch ${key} failed: ${settled[idx].reason?.message || settled[idx].reason}`);
      }
    }

    // Unpack results
    const klines1m = results[fetchMap.klines1m];
    if (!klines1m || !Array.isArray(klines1m) || klines1m.length === 0) {
      log.warn('1m klines fetch failed — skipping poll');
      return;
    }
    const klines5m = fetchMap.klines5m !== undefined ? results[fetchMap.klines5m] : getKlines5mCache();
    const lastPrice = wsPrice || (fetchMap.lastPrice !== undefined ? results[fetchMap.lastPrice] : klines1m[klines1m.length - 1]?.close);

    if (lastPrice == null || !Number.isFinite(lastPrice)) {
      log.warn('No BTC price available from any source — skipping poll');
      return;
    }

    if (!klines5m) {
      log.warn('No 5m klines available yet');
      return;
    }

    // Update caches
    if (fetchMap.klines5m !== undefined) updateKlines5m(results[fetchMap.klines5m], now);
    if (fetchMap.chainlink !== undefined) updateChainlink(results[fetchMap.chainlink], now);

    const polyFetched = fetchMap.poly !== undefined ? results[fetchMap.poly] : null;
    if (polyFetched) {
      if (polyFetched.ok) {
        updatePolySnapshot(polyFetched, now);
        if (polyFetched.market?.endDate) {
          const endMs = new Date(polyFetched.market.endDate).getTime();
          if (Number.isFinite(endMs)) currentMarketEndMs = endMs;
        }
        const mktCondId = polyFetched.market?.conditionId ?? polyFetched.market?.condition_id;
        if (mktCondId) currentConditionId = mktCondId;
      } else {
        log.debug(`Polymarket fetch failed: ${polyFetched.reason} — will retry next poll`);
      }
    }
    const poly = polyFetched?.ok ? polyFetched : getPolySnapshotCache();

    // Funding rate — always null (blocked in user's region)
    const fundingRate = null;

    // ── 3b. USDC balance (every 30s — non-blocking) ──
    const SETTLEMENT_SYNC_COOLDOWN_MS = (BOT_CONFIG.redeemIntervalMs || 3_600_000) + 5 * 60_000;
    const settlementCooldownActive = (now - getLastSettlementMs()) < SETTLEMENT_SYNC_COOLDOWN_MS;
    scheduleUsdcCheck({
      now, settlementCooldownActive, clientReady: isClientReady(),
      fetchBalance: getUsdcBalance, getBankroll, getCurrentPosition, getPendingCost,
    });

    // ── 4. Market slug tracking + switch detection ──
    const marketSlug = poly?.ok ? String(poly.market?.slug ?? '') : '';
    const slugChanged =
      marketSlug !== '' &&
      currentMarketSlug !== null &&
      currentMarketSlug !== marketSlug;

    if (slugChanged) {
      const oldSlug = currentMarketSlug;
      log.info(`Market switched: "${oldSlug}" -> "${marketSlug}"`);
      marketTransitionMs = now;

      const pos = getCurrentPosition();
      if (pos) {
        await handleSwitch(
          { pos, oldSlug, currentConditionId, priceToBeat, now },
          {
            getLastSettled, setLastSettled,
            getOraclePrice: () => getPolyLivePrice() || getChainlinkWssPrice(),
            getBinancePrice,
          },
          makeSettlementActions(),
        );
      }

      resetMarketCache();
      resetCutLossState();
      resetFlow();
      resetMarketTradeCount(oldSlug);
      onMarketSwitch(oldSlug, marketSlug);

      if (tiltMarketsLeft > 0) {
        tiltMarketsLeft--;
        log.info(`Tilt protection: ${tiltMarketsLeft} markets remaining (ML conf >= ${TILT_ML_CONF_MIN * 100}%)`);
      }
      entryRegime = null;
    }

    if (marketSlug) currentMarketSlug = marketSlug;

    // ── 4b. Stale position recovery (bot restart with position from past market) ──
    const stalePos = getCurrentPosition();
    if (stalePos && !stalePos.settled && currentMarketSlug && stalePos.marketSlug !== currentMarketSlug) {
      await handleStalePosition(
        { pos: stalePos, currentMarketSlug, now },
        {
          getLastSettled,
          getOraclePrice: () => getPolyLivePrice() || getChainlinkWssPrice(),
          getBinancePrice,
        },
        makeSettlementActions(),
      );
      resetCutLossState();
    }

    if (!poly?.ok) {
      log.warn(`Polymarket: ${poly?.reason ?? 'no snapshot'}`);
      return;
    }

    // Notify CLOB WS of token IDs
    if (poly.tokens && !tokenIdsNotified) {
      setTokenIds(poly.tokens.upTokenId, poly.tokens.downTokenId);
      tokenIdsNotified = true;
    }

    // ── 5. Compute all signals ──
    const feedbackStats = getAccuracyStats();
    const settlementMs = poly.market?.endDate ? new Date(poly.market.endDate).getTime() : null;
    const settlementLeftMin = settlementMs ? (settlementMs - Date.now()) / 60_000 : null;
    const timeLeftMin = settlementLeftMin ?? timing.remainingMinutes;

    // Market transition guard
    const inTransition = marketTransitionMs > 0 && (now - marketTransitionMs) < MARKET_TRANSITION_GRACE_MS;
    if (inTransition) {
      const elapsed = ((now - marketTransitionMs) / 1000).toFixed(1);
      log.info(`Market transition grace: ${elapsed}s / ${MARKET_TRANSITION_GRACE_MS / 1000}s — skipping prediction (WS syncing)`);
      broadcast({
        paused: false, ts: now, pollCounter, btcPrice: lastPrice, dryRun: BOT_CONFIG.dryRun,
        stats: getStats(), bankroll: getBankroll(), marketSlug, marketTransition: true,
        transitionElapsedMs: now - marketTransitionMs,
      });
      return;
    }

    const clobLastUpdate = getClobLastUpdate();
    const clobStale = clobLastUpdate ? (now - clobLastUpdate > 15_000) : true;

    const sig = computeSignals({
      klines1m, klines5m, lastPrice, poly, priceToBeat, marketSlug, now,
      clobConnected: isClobConnected(), clobStale,
      getClobUpPrice, getClobDownPrice, getClobOrderbook,
      feedbackStats, timeLeftMin,
      candleWindowMinutes: CONFIG.candleWindowMinutes,
      getMLPrediction, fundingRate,
    });

    // Update priceToBeat from signal computation
    priceToBeat = sig.updatedPriceToBeat;

    const {
      vwapNow, vwapDist, vwapSlope, rsiNow, rsiSlope,
      macd, consec, vwapCrossCount,
      bb, atr, volDelta, emaCross, stochRsi,
      volumeRecent, volumeAvg, failedVwapReclaim,
      regimeInfo, lastClose, delta1m, delta3m,
      volProfile, realizedVol, multiTfConfirm,
      momentum5CandleSlope, volatilityChangeRatio, priceConsistency,
      useClobWs, marketUp, marketDown,
      orderbookUp, orderbookDown, orderbookSignal,
      arb, obFlow, marketPriceMomentum,
      scored, timeAware, ruleEdge,
      mlResult, ensembleUp, ensembleDown, mlAgreesWithRules,
      edge, session,
    } = sig;

    // ── 5b. Signal flip tracking (anti-whipsaw) ──
    const currentSide = ensembleUp >= 0.5 ? 'UP' : 'DOWN';
    const recentFlipCount = trackSignal(currentSide, now);

    if (arb.found) {
      log.info(
        `ARB DETECTED: buy UP@${arb.askUp.toFixed(3)} + DOWN@${arb.askDown.toFixed(3)} ` +
        `= $${arb.totalCost.toFixed(4)} -> profit $${arb.netProfit.toFixed(4)} (${arb.profitPct.toFixed(1)}%)` +
        (arb.spreadHealthy ? '' : ' [SPREAD UNHEALTHY]')
      );
    }

    // ── Log real Polymarket data for ML training ──
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

    // ── 6. Cut-loss check (skip ARB — guaranteed profit, never cut) ──
    const pos = getCurrentPosition();
    if (pos && !pos.settled && pos.side !== 'ARB') {
      const tokenPrice = pos.side === 'UP' ? marketUp : marketDown;
      const tokenBook = pos.side === 'UP' ? orderbookUp : orderbookDown;

      const cutResult = evaluateCutLoss({
        position: pos, currentTokenPrice: tokenPrice,
        orderbook: tokenBook, timeLeftMin,
        btcPrice: lastPrice,
        priceToBeat: priceToBeat.value,
        modelProbability: pos.side === 'UP' ? ensembleUp : ensembleDown,
        mlConfidence: mlResult.available ? mlResult.mlConfidence : null,
        mlSide: mlResult.available ? mlResult.mlSide : null,
        regime: regimeInfo?.regime ?? 'moderate',
        entryRegime,
        btcDelta1m: delta1m,
        atrRatio: atr?.atrRatio ?? null,
      });

      // Log cut-loss gate status every 5th poll
      if (pollCounter % 5 === 0) {
        const ep = pos.price;
        const dropPct = ep > 0 && tokenPrice != null
          ? (((ep - tokenPrice) / ep) * 100).toFixed(1) : '?';
        const btcDist = lastPrice && priceToBeat.value
          ? (Math.abs((lastPrice - priceToBeat.value) / priceToBeat.value) * 100).toFixed(3) : '?';
        const btcSide = lastPrice && priceToBeat.value
          ? (pos.side === 'UP' ? lastPrice >= priceToBeat.value : lastPrice < priceToBeat.value) ? 'WIN' : 'LOSE'
          : '?';
        log.debug(
          `CutLoss v4: ${cutResult.reason} | ${pos.side} drop=${dropPct}% | ` +
          `BTC ${btcSide} dist=${btcDist}% | d1m=$${(delta1m ?? 0).toFixed(1)} | ` +
          `ATR=${(atr?.atrRatio ?? 0).toFixed(2)} | ${regimeInfo?.regime ?? '?'}${entryRegime && entryRegime !== regimeInfo?.regime ? `(was ${entryRegime})` : ''} | ` +
          `EV(hold)=${((pos.side === 'UP' ? ensembleUp : ensembleDown) * 100).toFixed(0)}% vs token=${(tokenPrice * 100).toFixed(0)}¢`
        );
      }

      if (cutResult.shouldCut) {
        if (!acquireSellLock()) {
          log.info('Cut-loss skipped — sell already in progress (dashboard?)');
        } else {
          try {
            const sellSize = pos.size;
            log.warn(
              `CUT-LOSS v4: ${pos.side} drop ${cutResult.dropPct.toFixed(1)}% | ` +
              `sell ${sellSize} shares @$${cutResult.sellPrice.toFixed(3)} | ` +
              `recover $${cutResult.recoveryAmount.toFixed(2)} of $${pos.cost.toFixed(2)}` +
              `${cutResult.reason === 'CRASH' ? ' [CRASH]' : ''}`
            );
            const exitData = {
              btcPrice: lastPrice, priceToBeat: priceToBeat.value,
              marketUp, marketDown, tokenPrice,
              regime: regimeInfo?.regime, regimeConfidence: regimeInfo?.confidence,
              entryRegime,
              rsiNow, vwapDist, timeLeftMin,
              cutLossDropPct: cutResult.dropPct,
              diagnostics: cutResult.diagnostics,
            };

            if (BOT_CONFIG.dryRun) {
              const recovery = cutResult.sellPrice * sellSize;
              const cutPnl = recovery - pos.cost;
              settleTradeEarlyExit(recovery);
              invalidateSync();
              clearEntrySnapshot();
              writeJournalEntry({ outcome: 'CUT_LOSS', pnl: cutPnl, exitData: { ...exitData, cutLossRecovered: recovery } });
              resetCutLossState();
              if (cutPnl < 0) {
                recordLoss();
                tiltMarketsLeft = TILT_MARKETS + 1;
                log.info(`Tilt protection activated: ML conf >= ${TILT_ML_CONF_MIN * 100}% for next ${TILT_MARKETS} markets`);
                notify('warn', `CUT-LOSS: ${pos.side} P&L $${cutPnl.toFixed(2)} | Bankroll: $${getBankroll().toFixed(2)}`);
              }
            } else {
              recordSellAttempt();
              try {
                const sellResult = await closePosition(pos.tokenId, sellSize, cutResult.sellPrice);
                const actualRecovery = parseClobAmount(sellResult?.takingAmount, cutResult.sellPrice * sellSize);
                const cutPnl = actualRecovery - pos.cost;
                settleTradeEarlyExit(actualRecovery);
                invalidateSync();
                clearEntrySnapshot();
                writeJournalEntry({ outcome: 'CUT_LOSS', pnl: cutPnl, exitData: { ...exitData, cutLossRecovered: actualRecovery } });
                resetCutLossState();
                if (cutPnl < 0) {
                  recordLoss();
                  tiltMarketsLeft = TILT_MARKETS + 1;
                  log.info(`Tilt protection activated: ML conf >= ${TILT_ML_CONF_MIN * 100}% for next ${TILT_MARKETS} markets`);
                  notify('warn', `CUT-LOSS: ${pos.side} P&L $${cutPnl.toFixed(2)} | Bankroll: $${getBankroll().toFixed(2)}`);
                }
              } catch (err) {
                log.warn(`Cut-loss sell FAILED: ${err.stack || err.message}`);
                resetCutConfirm();
              }
            }
          } finally { releaseSellLock(); }
        }
      }
    }

    // ── 7. Decision ──
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

    // ── 8. Bet sizing ──
    const betSide = rec.side;
    const betEnsembleProb = betSide === 'UP' ? ensembleUp
      : betSide === 'DOWN' ? ensembleDown : null;
    const betMarketPrice = betSide === 'UP' ? marketUp
      : betSide === 'DOWN' ? marketDown : null;
    const bankroll = getBankroll();

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

    // ── 9. Feedback tracking (stale cleanup) ──
    try {
      autoSettle(marketSlug, lastPrice, priceToBeat.value, timeLeftMin);
    } catch (feedbackErr) { log.debug(`Feedback error: ${feedbackErr.message}`); }

    // ── 10. Trade execution ──
    const alreadyHasPosition = hasOpenPosition(marketSlug);
    const hasPending = hasPendingOrder();

    const notifyTradeFn = BOT_CONFIG.telegramNotifyTrades
      ? (msg) => notify('info', msg, { key: 'trade:entry' })
      : null;

    // 10a. Arbitrage execution (priority over directional)
    if (arb.found && arb.spreadHealthy && !alreadyHasPosition && !hasPending &&
        poly.tokens?.upTokenId && poly.tokens?.downTokenId) {
      await executeArbitrage({
        arb, poly, marketSlug, currentConditionId, regimeInfo, rec, priceToBeat, lastPrice,
        dryRun: BOT_CONFIG.dryRun,
      }, {
        getAvailableBankroll, setPendingCost, placeBuyOrder,
        recordArbTrade, recordTradeForMarket, recordTrade, trackOrderPlacement,
        captureEntrySnapshot,
        setEntryRegime: (r) => { entryRegime = r; },
      });
    }
    // 10b. Directional trade
    else if (rec.action === 'ENTER' && !hasPending) {
      await executeDirectionalTrade({
        rec, betSide, betMarketPrice, betEnsembleProb, betSizing, edge,
        ensembleUp, timeAware, mlResult, mlAgreesWithRules,
        regimeInfo, poly, marketSlug, currentConditionId, priceToBeat,
        lastPrice, timeLeftMin, dryRun: BOT_CONFIG.dryRun,
        signalConfirmCount: getConfirmCount(), recentFlipCount,
        tiltMarketsLeft, tiltMlConfMin: TILT_ML_CONF_MIN,
        rsiNow, rsiSlope, macd, vwapDist, vwapSlope,
        bb, atr, stochRsi, emaCross, volDelta,
        consec, delta1m, delta3m, orderbookSignal, orderbookUp,
        marketUp, marketDown, obFlow,
      }, {
        updateConfirmation,
        isSignalStable,
        getInstabilityReasons,
        applyTradeFilters,
        checkFlowAlignment,
        validatePrice,
        validateTrade,
        getBankroll,
        getAvailableBankroll,
        getConsecutiveLosses,
        hasOpenPosition,
        setPendingCost,
        placeBuyOrder,
        recordTrade,
        trackOrderPlacement,
        recordTradeForMarket,
        captureEntrySnapshot,
        recordPrediction,
        setEntryRegime: (r) => { entryRegime = r; },
        notifyTrade: notifyTradeFn,
      });
    }

    // Reset confirmation when signal drops to WAIT
    if (rec.action !== 'ENTER') {
      decayConfirmation();
    }

    // ── 11. Resolve Chainlink price ──
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
      chainlinkResolved = getChainlinkCache();
    }

    // ── 12. Status log ──
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
    const stabTag = `Stab:${getConfirmCount()}/${SIGNAL_CONFIRM_POLLS}${recentFlipCount > 0 ? ` F${recentFlipCount}` : ''}`;
    log.info(
      `#${pollCounter} [${_pollMs}ms] | BTC $${lastPrice.toFixed(0)} | PTB $${(priceToBeat.value ?? 0).toFixed(0)} | ` +
      `P:${(ensembleUp * 100).toFixed(0)}% E:${edgeTag} ${mlTag} | ` +
      `${rec.action}${rec.side ? ' ' + rec.side : ''} [${rec.confidence}] ${rec.phase} | ` +
      `T:${timeLeftMin?.toFixed(1) ?? '?'}m | $${bankroll.toFixed(0)} | ` +
      `${regimeInfo.regime} | ${stabTag} ${arbTag} ${fillTag} ${flowTag} | ${srcTag}`
    );

    // ── 13. Compute narratives + broadcast full state to dashboard ──
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

    const positionsSummary = _getPositionsSummary
      ? _getPositionsSummary(getCurrentPosition())
      : { list: [], lastUpdate: null, botPosition: null };

    const usdcBalData = getUsdcBalanceData();

    broadcast({
      paused: false, ts: Date.now(), pollCounter,
      btcPrice: lastPrice, dryRun: BOT_CONFIG.dryRun,
      stats: getStats(), positions: positionsSummary,
      indicators: {
        rsi: rsiNow, macd: macd?.hist, vwapDist, delta1m,
        consec: consec.count, consecColor: consec.color,
      },
      sources: { binanceWs: isBinanceConnected(), clobWs: useClobWs },
      regime: regimeInfo.regime, regimeConfidence: regimeInfo.confidence,
      bankroll, ensembleUp, ensembleDown,

      // useMarketData-compatible fields
      lastPrice, chainlinkRpc: chainlinkResolved, poly,
      marketUp, marketDown, marketSlug, liquidity,
      settlementMs, settlementLeftMin,
      orderbookUp, orderbookDown,
      clobSource: useClobWs ? 'WebSocket' : 'REST',
      clobWsConnected: isClobConnected(),
      priceToBeat: priceToBeat.value, marketQuestion,

      // Indicators (full objects)
      vwapNow, vwapDist, vwapSlope, vwapSlopeLabel,
      rsiNow, rsiSlope, macd, macdLabel, consec,
      delta1m, delta3m, lastClose,
      bb, atr, volDelta, emaCross, stochRsi, fundingRate,

      // Narratives
      haNarrative, rsiNarrative, macdNarrative, vwapNarrative,

      // Probability
      pLong: ensembleUp, pShort: ensembleDown,
      ruleUp: timeAware.adjustedUp, ruleDown: timeAware.adjustedDown,
      rawUp: scored.rawUp, rawDown: scored.rawDown,
      scoreBreakdown: scored.breakdown,
      timeDecay: timeAware.timeDecay,

      // Regime + Edge + Decision
      regimeInfo, edge, rec, timeLeftMin, timing, orderbookSignal,

      // Arbitrage + Execution + Flow
      arbitrage: arb,
      fillTracker: getFillTrackerStatus(),
      orderbookFlow: obFlow,
      tradeFilters: getFilterStatus(),
      tiltProtection: tiltMarketsLeft > 0 ? { active: true, marketsLeft: tiltMarketsLeft, minMlConf: TILT_ML_CONF_MIN } : { active: false },

      // Cut-loss status
      cutLoss: (() => {
        const clPos = getCurrentPosition();
        const clPrice = clPos && !clPos.settled ? (clPos.side === 'UP' ? marketUp : marketDown) : null;
        return getCutLossStatus(clPos, clPrice, {
          btcPrice: lastPrice, priceToBeat: priceToBeat.value,
          modelProbability: clPos ? (clPos.side === 'UP' ? ensembleUp : ensembleDown) : null,
          mlConfidence: mlResult.available ? mlResult.mlConfidence : null,
          mlSide: mlResult.available ? mlResult.mlSide : null,
          regime: regimeInfo?.regime ?? 'moderate',
          atrRatio: atr?.atrRatio ?? null, timeLeftMin,
        });
      })(),

      // Signal stability (anti-whipsaw)
      signalStability: getSignalStabilityStatus(),

      // Volatility + Multi-TF
      volProfile, realizedVol, multiTfConfirm,

      // Feedback
      feedbackStats, detailedFeedback,

      // Trade journal
      recentJournal: getRecentJournal(5),

      // Volume features
      volumeRecent, volumeAvg,
      volumeRatio: volumeAvg > 0 ? volumeRecent / volumeAvg : 1,
      vwapCrossCount, failedVwapReclaim,

      // Bet sizing
      betSizing,

      // ML (full object matching useMarketData shape)
      ml: mlResult.available ? {
        probUp: mlResult.mlProbUp, confidence: mlResult.mlConfidence,
        side: mlResult.mlSide, ensembleProbUp: mlResult.ensembleProbUp,
        alpha: mlResult.alpha, source: mlResult.source,
        status: 'ready', available: true,
      } : {
        probUp: null, confidence: null, side: null,
        ensembleProbUp: null, alpha: 0,
        source: 'Rule-only', status: isMLReady() ? 'ready' : 'not_loaded',
        available: false,
      },

      // Connection statuses
      binanceConnected: isBinanceConnected(),
      binancePrice: lastPrice,
      polyLiveConnected, chainlinkWssConnected,
      chainlinkSource: chainlinkResolved.source,

      // Real USDC balance
      usdcBalance: usdcBalData ? {
        balance: usdcBalData.balance, allowance: usdcBalData.allowance,
        fetchedAt: usdcBalData.fetchedAt,
        drift: Math.abs(getBankroll() - usdcBalData.balance),
      } : null,
    });

    // Periodic save
    if (pollCounter % 120 === 0) {
      setMarketTradeCounts(exportMarketTradeCounts()); // H7: persist trade counts
      setLastLossTimestamp(getFilterLastLoss());         // FINTECH: persist loss cooldown
      saveFeedbackToDisk();
      saveSignalPerfToDisk();
      savePositionState();
    }

  } catch (err) {
    log.error(`Poll error: ${err.stack || err.message}`);
  } finally {
    polling = false;
  }
}

/**
 * Safely parse a CLOB amount field (makingAmount / takingAmount).
 * Returns null if the value is missing, NaN, negative, or unreasonably large.
 */
function parseClobAmount(value, fallback = null) {
  if (value == null) return fallback;
  const n = typeof value === 'number' ? value : parseFloat(value);
  if (!Number.isFinite(n) || n < 0 || n > 1_000_000) return fallback;
  return n;
}
