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
  getLastMsgTime as getBinanceLastMsgTime,
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
  fetchChainlinkAtTimestamp,
  fetchPolymarketPtb,
} from './adapters/dataFetcher.js';

// ML (loaded from disk)
import { getMLPrediction, isMLReady, getCalibratedPhaseThresholds } from './adapters/mlLoader.js';
import { resetHysteresis } from '../../src/engines/ml/state.js';

// Feedback (JSON file persistence)
import {
  getAccuracyStats,
  getDetailedStats,
  getMLAccuracy,
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
  clearPendingOrders,
} from './trading/fillTracker.js';

// Trading
import { placeBuyOrder, placeLimitBuyOrder, getOrderById, getOrderStatus, cancelOrder, isClientReady, getUsdcBalance, getOpenOrders, cancelAllOrders, getTradeHistory, updateConditionalApproval, getConditionalTokenBalance } from './trading/clobClient.js';
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
  resetConsecutiveLosses,
  resetDailyBaseline,
  updatePositionMarketPrice,
  getTradeTimestamps,
  setTradeTimestamps,
  getPendingRedeemValue,
} from './trading/positionTracker.js';
import { closePosition } from './trading/positionManager.js';
import { evaluateCutLoss, resetCutLossState, recordSellAttempt, resetCutConfirm, getCutLossStatus } from './trading/cutLoss.js';
import { evaluateTakeProfit, resetTakeProfitState } from './trading/takeProfit.js';
import { onCutLoss as recoveryOnCutLoss, tick as recoveryTick, reset as resetRecovery, getRecoveryStatus, isRecoveryActive } from './trading/recoveryBuy.js';
import { captureEntrySnapshot, writeJournalEntry, clearEntrySnapshot, getEntrySnapshot, getRecentJournal } from './trading/tradeJournal.js';
import { getJournalAnalytics } from './trading/journalAnalytics.js';
import {
  evaluateLimitEntry, placeLimitOrder, monitorLimitOrder, cancelLimitOrder,
  resetLimitOrderState, resetLimitAttempts, getLimitOrderStatus, isLimitOrderActive,
  recordFillEvent,
} from './engines/limitOrderManager.js';
import { routeOrder } from './engines/orderRouter.js';

// Safety
import { shouldHalt, shouldEmergencyCut, validateTrade, validatePrice, recordTradeTimestamp, exportTradeTimestamps, importTradeTimestamps } from './safety/guards.js';
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

// Daily profit target (WIB timezone)
import { checkProfitTarget, getProfitTargetStatus, isTargetReached, initDayBaseline } from './safety/dailyProfitTarget.js';

// Orderbook flow tracking
import { checkFlowAlignment, resetFlow } from './engines/orderbookFlow.js';

// Smart money flow tracking (time-windowed CLOB flow analysis)
import { updateSmartFlow, getSmartFlowSignal, getEntryTimingScore, resetSmartFlow } from './engines/smartMoneyTracker.js';

// MetEngine smart money API gates (F1: consensus, F2: insider score, F3: conviction wallet)
import { initMetEngine, querySmartMoney, clearMetEngineCache, getMetEngineStats } from './engines/metEngineClient.js';

// Sentiment signal (free APIs: Fear & Greed, BTC Dominance)
import { fetchSentiment, getSentiment, getSentimentStats, checkExtremeSentiment } from './engines/sentimentSignal.js';

// Execution timing optimizer
import { evaluateExecutionTiming, getExecutionTimingStatus, resetExecutionTiming, recordSpreadTick, recordVolumeTick } from './engines/executionTiming.js';

// AI analysis (dashboard display)
import { getLastAnalysis } from './ai/postTradeAnalyst.js';
import { getOptimizerStatus } from './ai/selfOptimizer.js';
import { getOpenRouterStats } from './ai/openrouterClient.js';

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
  forceUsdcSync,
  isReconcileCooldownActive,
} from './engines/usdcSync.js';
import {
  handleExpiry,
  handleSwitch,
  handleStalePosition,
  getLastSettlementSource,
  clearLastSettlementSource,
} from './engines/settlement.js';
import { reconcileNow } from './trading/journalReconciler.js';
import { triggerRedeem } from './trading/redeemer.js';
import { computeSignals, resetMarketUpHistory } from './engines/signalComputation.js';
import { executeArbitrage, executeDirectionalTrade } from './engines/tradePipeline.js';
import {
  checkPreMarketEntry,
  getPreMarketSizing,
  onPreMarketEntry,
  clearPreMarketEntry,
  isPreMarketPosition,
  getPreMarketStatus,
} from './engines/preMarketLong.js';

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
let startupPtbFetched = false;  // Guards the one-shot startup PTB resolution on restart

// ── Pre-scheduled PTB capture ──
// Polymarket snapshots Chainlink Data Streams at eventStartTime for PTB.
// We schedule a WS price capture at the known next market start (= current endDate).
let ptbScheduleTimer = null;
let ptbScheduledPrice = null;  // { price, capturedAt }

function schedulePtbCapture(nextStartMs) {
  if (ptbScheduleTimer) { clearTimeout(ptbScheduleTimer); ptbScheduleTimer = null; }
  // Do NOT reset ptbScheduledPrice here — it may hold a pending value for the current new market.
  // Consumer (every-poll check below) clears it after applying.
  const delayMs = nextStartMs - Date.now();
  if (delayMs < 0 || delayMs > 20 * 60_000) return; // sanity: max 20min ahead
  ptbScheduleTimer = setTimeout(() => {
    const p = getPolyLivePrice() || getChainlinkWssPrice();
    if (p && p > 0) {
      ptbScheduledPrice = { price: p, capturedAt: Date.now() };
      log.info(`PTB pre-captured: $${p.toFixed(2)} (scheduled at eventStartTime)`);
    }
  }, delayMs);
}

// ── Market transition grace period ──
let marketTransitionMs = 0;
const MARKET_TRANSITION_GRACE_MS = 5_000; // M15: 2s→5s — WS reconnection measured at 3-4s; 2s grace caused stale data trades

// ── Settlement pending flag — prevents new trade entry while oracle waits in background ──
let settlementPending = false;
let settlementAbort = null; // AbortController: aborts oracle retries when market switches → instant price_fallback

// ── Tilt protection (post-cut-loss cooldown) ──
let tiltMarketsLeft = 0;
const TILT_ML_CONF_MIN = 0.60;
const TILT_MARKETS = 2;

// ── Entry regime tracking ──
let entryRegime = null;
export function resetEntryRegime() { entryRegime = null; }

// ── Limit order filter log throttle ──
let limitOrderFilterLogAt = 0;

let pollCounter = 0;
let polling = false;
let tokenIdsNotified = false;

// Circuit breaker cooldown tracking
let cbHaltStartMs = 0;        // when circuit breaker first triggered (0 = not halted)
let cbLastLogMs = 0;           // throttle halt log spam (log every 5min, not every poll)
let startupUsdcChecked = false;
let startupOrdersReconciled = false;
let startupTradeCountsLoaded = false;
let lastAutoForceSyncMs = 0; // Auto force-sync every 40 min

// ── MetEngine init (runs once at module load) ──
initMetEngine(BOT_CONFIG.metEngine);

function resetMarketCache() {
  resetCaches();
  resetSignalState();
  resetMarketUpHistory();
  resetHysteresis(); // Clear ML side hysteresis on market switch
  clearMetEngineCache(); // Clear smart money cache on market switch
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
    clearEntrySnapshot: () => { clearEntrySnapshot(); clearPreMarketEntry(); },
    writeJournalEntry,
    recordLoss,
    settlePrediction,
    setLastSettled,
    getBankroll,
    notifyTrade: process.env.TELEGRAM_NOTIFY_TRADES === 'true'
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
  const _pollStart = performance.now();

  try {
    // H4 audit fix: applyPendingSync inside try block — if it throws, polling guard still releases in finally
    applyPendingSync(getBankroll, setBankroll);
    pollCounter++;

    // H7: Restore per-market trade counts + loss cooldown from persisted state on first poll
    if (!startupTradeCountsLoaded) {
      startupTradeCountsLoaded = true;
      importMarketTradeCounts(getMarketTradeCounts());
      importLastLossTimestamp(getLastLossTimestamp()); // FINTECH: restore cooldown across restart
      importTradeTimestamps(getTradeTimestamps()); // M2 audit fix: restore hourly trade limit across restart
    }
    // ── 1. Circuit Breaker ──
    // Audit v2 H4: Reset consecutiveLosses after 4hr inactivity — stale streak from different
    // regime is not informative. lastLossTimestamp tracks when the streak started.
    {
      const lastLoss = getLastLossTimestamp();
      const INACTIVITY_RESET_MS = 4 * 60 * 60 * 1000; // 4 hours
      if (lastLoss > 0 && getConsecutiveLosses() > 0 && (Date.now() - lastLoss) > INACTIVITY_RESET_MS) {
        log.info(`Audit v2 H4: Resetting consecutiveLosses (${getConsecutiveLosses()}) after ${((Date.now() - lastLoss) / 3600_000).toFixed(1)}hr inactivity`);
        resetConsecutiveLosses();
        setLastLossTimestamp(0);
      }
    }
    const haltCheck = shouldHalt({
      dailyPnLPct: getDailyPnLPct(),
      bankroll: getBankroll(),
      consecutiveLosses: getConsecutiveLosses(),
      drawdownPct: getDrawdownPct(),
    });
    if (haltCheck.halt) {
      const now = Date.now();
      // Track when halt first started
      if (cbHaltStartMs === 0) {
        cbHaltStartMs = now;
        cbLastLogMs = 0; // force first log immediately
      }

      const elapsed = now - cbHaltStartMs;
      const cooldownMs = BOT_CONFIG.circuitBreakerCooldownMs;

      // Auto-recover after cooldown period (0 = disabled, stay halted forever)
      if (cooldownMs > 0 && elapsed >= cooldownMs) {
        log.info(`Circuit breaker cooldown expired (${(elapsed / 60_000).toFixed(0)}min) — resetting baseline and resuming`);
        notify('info', `Circuit breaker cooldown expired — resuming trading | Bankroll: $${getBankroll().toFixed(2)}`);
        resetDailyBaseline();
        cbHaltStartMs = 0;
        cbLastLogMs = 0;
        // Fall through to continue trading
      } else {
        // Still in cooldown — throttle log to every 5 minutes
        const LOG_THROTTLE_MS = 5 * 60 * 1000;
        if (now - cbLastLogMs >= LOG_THROTTLE_MS) {
          const remainMin = Math.ceil((cooldownMs - elapsed) / 60_000);
          if (cbLastLogMs === 0) {
            // First time — log error + send notification
            log.error(`CIRCUIT BREAKER: ${haltCheck.reason} | Cooldown: ${remainMin}min | Bankroll: $${getBankroll().toFixed(2)}`);
            notify('critical', `CIRCUIT BREAKER: ${haltCheck.reason} | Cooldown: ${remainMin}min | Bankroll: $${getBankroll().toFixed(2)}`);
          } else {
            log.warn(`HALTED: ${haltCheck.reason} | Cooldown: ${remainMin}min remaining`);
          }
          cbLastLogMs = now;
        }
        broadcast({ halted: true, haltReason: haltCheck.reason, cooldownRemainMin: Math.ceil((cooldownMs - elapsed) / 60_000), ts: now, bankroll: getBankroll(), stats: getStats() });
        return;
      }
    } else {
      // Not halted — reset cooldown tracker
      if (cbHaltStartMs > 0) {
        cbHaltStartMs = 0;
        cbLastLogMs = 0;
      }
    }

    // ── 1a2. Daily profit target check (WIB timezone) ──
    // NOTE: Does NOT return early — position management (fill tracking, settlement,
    // cut-loss) must still run. Only blocks new trade entries (checked in section 7+).
    // STICKY: once target reached, stays paused for the rest of the WIB day.
    // Use resetProfitTarget() (via dashboard RPC) to manually resume.
    // Uses on-chain USDC when available, falls back to internal bankroll.
    let profitTargetPaused = isTargetReached(); // sticky — persisted across polls & restarts
    if (BOT_CONFIG.dailyProfitTargetUsd > 0) {
      const pos = getCurrentPosition();
      const deployedCost = (pos && !pos.settled) ? (pos.cost ?? 0) : 0;
      const unredeemedValue = getPendingRedeemValue();

      // Prefer on-chain USDC; fallback to internal bankroll + deployed cost
      const usdcBal = getUsdcBalanceData();
      const balanceForCheck = (usdcBal && Number.isFinite(usdcBal.balance))
        ? usdcBal.balance
        : getBankroll() + deployedCost; // bankroll already deducted position cost, add it back

      const wasReached = isTargetReached();
      const ptCheck = checkProfitTarget(balanceForCheck, deployedCost, unredeemedValue);
      if (ptCheck.reached && !wasReached) {
        const source = usdcBal ? 'on-chain' : 'internal';
        notify('info',
          `PROFIT TARGET REACHED! +$${ptCheck.profit.toFixed(2)} / $${ptCheck.target.toFixed(2)} target (${source}) | ` +
          `Bot paused for the rest of the day (WIB) | Bankroll: $${getBankroll().toFixed(2)}`
        );
      }
      profitTargetPaused = isTargetReached(); // update after checkProfitTarget may set it
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
          notify('warn', `FOK order rejected — position unwound | Bankroll: $${getBankroll().toFixed(2)}`);
        } else if (fillResult.uncertain) {
          // Sell order couldn't be verified — release sell lock so cut-loss can retry
          log.warn(`UNCERTAIN FILL: sell order ${fillResult.orderId} unverified after ${(fillResult.timeToFill / 1000).toFixed(1)}s — releasing sell lock for retry`);
          releaseSellLock();
          notify('warn', `Uncertain sell fill: ${fillResult.orderId} — cut-loss can retry`);
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
          // Initialize daily profit target baseline from on-chain balance + deployed capital + unredeemed.
          // CRITICAL: unredeemed must be in baseline so it's not counted as today's profit when
          // bot restarts after winning positions from a previous session haven't been redeemed yet.
          if (BOT_CONFIG.dailyProfitTargetUsd > 0) {
            const deployedCost = hasPos ? (pos.cost ?? 0) : 0;
            const startupUnredeemed = getPendingRedeemValue();
            initDayBaseline(onChain, deployedCost, startupUnredeemed);
          }
          // M17: Use 5% relative threshold instead of fixed $5 — $5 doesn't scale with bankroll
          const driftPct = localBankroll > 0 ? (drift / localBankroll) * 100 : 0;
          const driftSignificant = driftPct > 5;
          if (driftSignificant && !hasPos) {
            log.warn(`Startup USDC auto-sync: drift $${drift.toFixed(2)} (${driftPct.toFixed(1)}%) > 5% (no position) — syncing`);
            queueSync(onChain);
          } else if (driftSignificant && hasPos) {
            log.error(`Startup USDC DRIFT: $${drift.toFixed(2)} (${driftPct.toFixed(1)}%) with open position — manual intervention may be needed`);
            notify('warn', `Startup USDC drift: $${drift.toFixed(2)} (${driftPct.toFixed(1)}%) (local=$${localBankroll.toFixed(2)} vs on-chain=$${onChain.toFixed(2)}) with open position`);
          } else if (driftPct > 1) {
            log.warn(`Startup USDC drift: $${drift.toFixed(2)} (${driftPct.toFixed(1)}%, minor, will sync on next idle cycle)`);
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
      if (pos && pos.marketSlug === currentMarketSlug && !settlementPending) {
        // Non-blocking: oracle can take up to 83s — don't freeze the poll loop.
        // settlementPending blocks new trade entry until oracle resolves.
        // AbortController: market switch aborts oracle retries → instant price_fallback.
        settlementPending = true;
        settlementAbort = new AbortController();
        handleExpiry(
          { pos, currentMarketSlug, currentConditionId, priceToBeat, now },
          {
            getLastSettled, setLastSettled,
            getOraclePrice: () => getPolyLivePrice() || getChainlinkWssPrice(),
            getBinancePrice,
          },
          makeSettlementActions(),
          { signal: settlementAbort.signal },
        ).finally(() => {
          settlementPending = false; settlementAbort = null;
          triggerRedeem(15_000, currentConditionId); // Auto-redeem after oracle settlement
          // RC5: If settlement used price_fallback, schedule fast reconcile to correct bankroll
          if (getLastSettlementSource() === 'price_fallback') {
            clearLastSettlementSource();
            setTimeout(() => reconcileNow().catch(e => log.debug(`Fast reconcile (expiry): ${e.message}`)), 60_000);
          }
        });
      }
      resetCutLossState();
      resetTakeProfitState();
      resetRecovery(); // Cancel any pending recovery on market expiry
      clearPendingOrders(); // H2 audit fix: stale orders from expired market
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

    // Audit fix H: Validate Binance WS price is fresh (< 5s old).
    // During WS outage (up to 20s before heartbeat fires), stale price could cause
    // bad trade decisions. BTC can move $50-200 in 20s during volatile markets.
    // M16: Matches WS_BINANCE.heartbeatCheckMs (5s) — both use 5s as staleness boundary.
    const BINANCE_STALE_MS = 5_000;
    const wsPrice = getBinancePrice();
    const wsFresh = wsPrice && isBinanceConnected() && (Date.now() - getBinanceLastMsgTime() < BINANCE_STALE_MS);
    if (!wsFresh) {
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
    const lastPrice = (wsFresh ? wsPrice : null) || (fetchMap.lastPrice !== undefined ? results[fetchMap.lastPrice] : klines1m[klines1m.length - 1]?.close);

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
          if (Number.isFinite(endMs)) {
            // Schedule PTB capture at endDate (= next market's eventStartTime)
            if (endMs !== currentMarketEndMs) schedulePtbCapture(endMs);
            currentMarketEndMs = endMs;
          }
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

    // ── 3a2. Sentiment signal (every 5 min, non-blocking) ──
    if (BOT_CONFIG.ai?.sentimentEnabled !== false && pollCounter % 100 === 0) {
      fetchSentiment().catch(() => {}); // fire-and-forget, cached
    }

    // ── 3b. USDC balance (every 30s — non-blocking) ──
    // Cooldown prevents stale on-chain USDC from overwriting internal bankroll after settlement.
    // Redeem takes ~60-90s (45s delay + tx), so 2 min is sufficient.
    // Previously 15min — way too long, bankroll stayed stale for 15 min after every settle.
    const SETTLEMENT_SYNC_COOLDOWN_MS = 2 * 60_000;
    const settlementCooldownActive = (now - getLastSettlementMs()) < SETTLEMENT_SYNC_COOLDOWN_MS;
    scheduleUsdcCheck({
      now, settlementCooldownActive, clientReady: isClientReady(),
      fetchBalance: getUsdcBalance, getBankroll, getCurrentPosition, getPendingCost,
    });

    // ── 3c. Auto force-sync every 10 min (bypasses cooldown, but guards open positions) ──
    // C1 FIX: Skip auto force-sync when a position is open to prevent overwriting bankroll
    // mid-trade. forceUsdcSync() calls setBankroll(onChain) without checking if a trade just
    // deducted from bankroll — this can restore the pre-trade amount and inflate the bankroll.
    const AUTO_FORCE_SYNC_INTERVAL_MS = 10 * 60_000;
    const _autoSyncPos = getCurrentPosition();
    const _autoSyncHasPos = _autoSyncPos != null && !_autoSyncPos.settled;
    if (isClientReady() && !_autoSyncHasPos && !isReconcileCooldownActive() && now - lastAutoForceSyncMs >= AUTO_FORCE_SYNC_INTERVAL_MS) {
      lastAutoForceSyncMs = now;
      forceUsdcSync(getUsdcBalance, getBankroll, setBankroll)
        .then(r => {
          if (r.ok && r.action === 'synced') {
            log.info(`Auto force-sync (10min): $${r.prev.toFixed(2)} → $${r.onChain.toFixed(2)} (drift $${r.drift.toFixed(2)})`);
          }
        })
        .catch(err => log.debug(`Auto force-sync error: ${err.message}`));
    }

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

      // Abort any pending settlement (e.g. handleExpiry oracle retries) → instant price_fallback.
      // Without this, oracle retries block trading for up to 83s on the new market.
      if (settlementPending && settlementAbort) {
        log.info('Aborting pending settlement — market switched, forcing price_fallback');
        settlementAbort.abort();
      }

      const pos = getCurrentPosition();
      if (pos && !settlementPending) {
        // Non-blocking: settlement runs in background while loop continues on new market.
        settlementPending = true;
        settlementAbort = new AbortController();
        handleSwitch(
          { pos, oldSlug, currentConditionId, priceToBeat, now },
          {
            getLastSettled, setLastSettled,
            getOraclePrice: () => getPolyLivePrice() || getChainlinkWssPrice(),
            getBinancePrice,
          },
          makeSettlementActions(),
          { signal: settlementAbort.signal },
        ).finally(() => {
          settlementPending = false; settlementAbort = null;
          triggerRedeem(15_000, currentConditionId); // Auto-redeem after oracle settlement
          // RC5: If settlement used price_fallback, schedule fast reconcile to correct bankroll
          if (getLastSettlementSource() === 'price_fallback') {
            clearLastSettlementSource();
            setTimeout(() => reconcileNow().catch(e => log.debug(`Fast reconcile (switch): ${e.message}`)), 60_000);
          }
        });
      }

      resetMarketCache();
      resetCutLossState();
      resetTakeProfitState();
      resetRecovery(); // Cancel any pending recovery on market switch
      clearPendingOrders(); // H2 audit fix: stale orders from previous market
      if (isLimitOrderActive()) {
        const limStatus = getLimitOrderStatus();
        try {
          const switchCancelResult = await cancelLimitOrder('market_switch', { cancelOrder, setPendingCost, getOrderById, getOrderStatus });
          if (switchCancelResult?.filledInstead && switchCancelResult.fillData) {
            const fd = switchCancelResult.fillData;
            log.warn(`PHANTOM FILL on market switch — recording position: ${fd.side} ${fd.size}@${(fd.price * 100).toFixed(1)}c`);
            recordTrade({
              side: fd.side, tokenId: fd.tokenId,
              conditionId: fd.conditionId,
              price: fd.price, size: fd.size,
              marketSlug: fd.marketSlug, orderId: fd.orderId,
              actualCost: fd.price * fd.size,
            });
            confirmFill();
            captureEntrySnapshot({
              side: fd.side, tokenPrice: fd.price, btcPrice: lastPrice,
              priceToBeat: priceToBeat?.value, marketSlug: fd.marketSlug,
              cost: fd.price * fd.size, size: fd.size,
              confidence: 'LIMIT_PHANTOM', phase: 'market_switch', reason: 'phantom_fill_market_switch',
              timeLeftMin, session: getSessionName(),
            });
            notify('warn',
              `🔴 PHANTOM FILL on market switch\n` +
              `Side: ${fd.side} | ${fd.size} shares @ ${(fd.price * 100).toFixed(1)}¢\n` +
              `Cost: $${(fd.price * fd.size).toFixed(2)}\n` +
              `Order was filled before cancel — position recorded`,
              { key: 'trade:limit:phantom' }).catch(e => log.debug(`Notify phantom: ${e.message}`));
          } else {
            // Notify user about market switch cancel (was silently dropped before)
            notify('info',
              `⏰ LIMIT ORDER EXPIRED (market switch)\n` +
              `Side: ${limStatus.side ?? '?'} | Was @ ${limStatus.targetPrice ? (limStatus.targetPrice * 100).toFixed(1) + '¢' : '?'}\n` +
              `Market ended — order cancelled\n` +
              `Bankroll: $${getBankroll().toFixed(2)}`,
              { key: 'trade:limit:cancel' }).catch(e => log.debug(`Notify limit switch cancel: ${e.message}`));
          }
        } catch (err) {
          log.warn(`Limit cancel on switch: ${err.message}`);
        }
      }
      resetLimitOrderState();
      resetLimitAttempts(); // New market = fresh limit order attempts
      resetFlow();
      resetSmartFlow();
      resetExecutionTiming();
      resetMarketTradeCount(oldSlug);
      onMarketSwitch(oldSlug, marketSlug);

      if (tiltMarketsLeft > 0) {
        tiltMarketsLeft--;
        log.info(`Tilt protection: ${tiltMarketsLeft} markets remaining (ML conf >= ${TILT_ML_CONF_MIN * 100}%)`);
      }
      entryRegime = null;

      // ── PTB resolution (async, parallel — first to resolve wins) ──
      // Priority: polymarket_page (exact) > scheduled_ws > chainlink_round > oracle
      // All run async; whichever resolves first with a valid price sets PTB.
      // Higher-priority sources overwrite lower-priority ones.
      const eventSlug = poly.market?.slug ?? marketSlug;
      const eventStartTime = poly.market?.eventStartTime;

      // 1. Scrape PTB from Polymarket page (eventMetadata)
      // polymarket_page / polymarket_page_prev = exact → overwrite anything
      // polymarket_page_approx = rough estimate → only overwrite oracle/pending
      fetchPolymarketPtb(eventSlug).then(result => {
        if (result?.priceToBeat > 0 && priceToBeat.slug === marketSlug) {
          const isExact = ['polymarket_page', 'polymarket_page_prev'].includes(result.source);
          const currentIsLowPriority = ['oracle', 'pending', 'polymarket_page_approx'].includes(priceToBeat.source);
          if (isExact || currentIsLowPriority) {
            const prev = priceToBeat.value;
            priceToBeat = { slug: marketSlug, value: result.priceToBeat, source: result.source, updatedAt: Date.now() };
            if (prev !== result.priceToBeat) {
              log.info(`PTB: $${prev?.toFixed(2) ?? 'null'} → $${result.priceToBeat.toFixed(2)} (${result.source})`);
            }
          }
        }
      }).catch(err => log.debug(`Polymarket PTB scrape failed: ${err.message}`));

      // 2. scheduled_ws capture: handled every poll (see below market-switch block) to avoid race condition

      // 3. Chainlink on-chain round query (fallback)
      if (eventStartTime) {
        const targetSec = Math.floor(new Date(eventStartTime).getTime() / 1000);
        fetchChainlinkAtTimestamp(targetSec).then(result => {
          if (result?.price > 0 && priceToBeat.slug === marketSlug
              && !['polymarket_page', 'polymarket_page_prev', 'scheduled_ws'].includes(priceToBeat.source)) {
            const prev = priceToBeat.value;
            priceToBeat = { slug: marketSlug, value: result.price, source: 'chainlink_round', updatedAt: Date.now() };
            log.info(`PTB: $${prev?.toFixed(2) ?? 'null'} → $${result.price.toFixed(2)} (chainlink_round, ${result.diff}s from start)`);
          }
        }).catch(err => log.debug(`Chainlink PTB fetch failed: ${err.message}`));
      }
    }

    // ── 4a2. Startup PTB resolution (first poll after restart) ──
    // slugChanged requires currentMarketSlug !== null — so it never fires on startup.
    // Without this, priceToBeat stays as 'oracle' (current live BTC price, not market-open price)
    // for the entire session after restart.
    if (!startupPtbFetched && marketSlug && currentMarketSlug === null) {
      startupPtbFetched = true;
      const startupEventSlug = poly.market?.slug ?? marketSlug;
      const startupEventStartTime = poly.market?.eventStartTime;
      log.info(`Startup PTB resolution for market: ${startupEventSlug}`);

      fetchPolymarketPtb(startupEventSlug).then(result => {
        if (result?.priceToBeat > 0 && priceToBeat.slug === marketSlug) {
          const isExact = ['polymarket_page', 'polymarket_page_prev'].includes(result.source);
          const currentIsLowPriority = ['oracle', 'pending', 'polymarket_page_approx'].includes(priceToBeat.source);
          if (isExact || currentIsLowPriority) {
            const prev = priceToBeat.value;
            priceToBeat = { slug: marketSlug, value: result.priceToBeat, source: result.source, updatedAt: Date.now() };
            if (prev !== result.priceToBeat) {
              log.info(`PTB startup: $${prev?.toFixed(2) ?? 'null'} → $${result.priceToBeat.toFixed(2)} (${result.source})`);
            }
          }
        }
      }).catch(err => log.debug(`Startup PTB scrape failed: ${err.message}`));

      if (startupEventStartTime) {
        const targetSec = Math.floor(new Date(startupEventStartTime).getTime() / 1000);
        fetchChainlinkAtTimestamp(targetSec).then(result => {
          if (result?.price > 0 && priceToBeat.slug === marketSlug
              && !['polymarket_page', 'polymarket_page_prev', 'scheduled_ws'].includes(priceToBeat.source)) {
            const prev = priceToBeat.value;
            priceToBeat = { slug: marketSlug, value: result.price, source: 'chainlink_round', updatedAt: Date.now() };
            log.info(`PTB startup: $${prev?.toFixed(2) ?? 'null'} → $${result.price.toFixed(2)} (chainlink_round, ${result.diff}s from start)`);
          }
        }).catch(err => log.debug(`Startup Chainlink PTB failed: ${err.message}`));
      }
    }

    if (marketSlug) currentMarketSlug = marketSlug;

    // ── 4b. Stale position recovery (bot restart with position from past market) ──
    const stalePos = getCurrentPosition();
    if (stalePos && !stalePos.settled && currentMarketSlug && stalePos.marketSlug !== currentMarketSlug && !settlementPending) {
      // Non-blocking: stale position recovery runs in background.
      settlementPending = true;
      settlementAbort = new AbortController();
      handleStalePosition(
        { pos: stalePos, currentMarketSlug, now },
        {
          getLastSettled,
          getOraclePrice: () => getPolyLivePrice() || getChainlinkWssPrice(),
          getBinancePrice,
        },
        makeSettlementActions(),
        { signal: settlementAbort.signal },
      ).finally(() => {
        settlementPending = false;
        settlementAbort = null;
        triggerRedeem(15_000, stalePos?.conditionId); // Auto-redeem after stale position settlement
        resetCutLossState();
        resetTakeProfitState();
        resetRecovery(); // Cancel any pending recovery on stale position recovery
        resetLimitOrderState();
      });
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

    // Get smart flow signal from PREVIOUS poll cycle (point-in-time correct for ML features)
    const smartFlowSignalForML = getSmartFlowSignal();

    // Apply scheduled WS capture every poll (handles race condition: setTimeout fires after market switch check)
    // The scheduled price is FOR the new market (captured at endDate = next market's startTime).
    // Only apply when the NEW market is detected (priceToBeat.slug !== marketSlug) — i.e. on first polls of new market.
    if (ptbScheduledPrice?.price > 0 && marketSlug && priceToBeat.slug !== marketSlug) {
      const age = Date.now() - ptbScheduledPrice.capturedAt;
      if (age < 60_000) {
        priceToBeat = { slug: marketSlug, value: ptbScheduledPrice.price, source: 'scheduled_ws', updatedAt: ptbScheduledPrice.capturedAt };
        log.info(`PTB from scheduled capture: $${ptbScheduledPrice.price.toFixed(2)} (${(age / 1000).toFixed(1)}s ago)`);
      }
      ptbScheduledPrice = null;
    }

    const sig = computeSignals({
      klines1m, klines5m, lastPrice, poly, priceToBeat, marketSlug, now,
      clobConnected: isClobConnected(), clobStale,
      getClobUpPrice, getClobDownPrice, getClobOrderbook,
      feedbackStats, timeLeftMin,
      candleWindowMinutes: CONFIG.candleWindowMinutes,
      getMLPrediction, fundingRate,
      smartFlowSignal: smartFlowSignalForML,
      oraclePrice: getPolyLivePrice() || getChainlinkWssPrice(),
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
      mcResult: mcResultRaw,
    } = sig;

    // Null out MC when disabled — prevents noise from GBM random walk affecting sizing/gates
    const mcResult = BOT_CONFIG.monteCarlo.enabled ? mcResultRaw : null;

    // ── 5a. Smart money flow update (time-windowed CLOB flow) ──
    updateSmartFlow({
      marketSlug,
      timeLeftMin,
      imbalanceDelta: obFlow.imbalanceDelta ?? 0,
      flowSignal: obFlow.flowSignal ?? 'NEUTRAL',
      marketUpPrice: marketUp,
    });
    const smartFlowSignal = getSmartFlowSignal();
    const entryTimingScore = getEntryTimingScore(timeLeftMin);

    // ── 5a2. Execution timing tick recording ──
    if (orderbookUp?.spread != null) recordSpreadTick(orderbookUp.spread);
    if (volumeRecent != null) recordVolumeTick(volumeRecent);

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
        smartFlowDirection: smartFlowSignal.direction,
        smartFlowStrength: smartFlowSignal.strength,
        smartFlowEarlyFlow: smartFlowSignal.earlyFlow,
        smartFlowWindow: smartFlowSignal.window,
      });
    }

    // ── 6. Emergency circuit breaker re-evaluation with open position ──
    // Audit fix M: Check if approaching circuit breaker thresholds while holding a position.
    // Triggers emergency cut-loss at 90% of thresholds to ensure we can actually exit before halt.
    const emergencyPos = getCurrentPosition();
    if (emergencyPos && !emergencyPos.settled && emergencyPos.side !== 'ARB') {
      const emergencyCheck = shouldEmergencyCut({
        dailyPnLPct: getDailyPnLPct(),
        drawdownPct: getDrawdownPct(),
      });
      if (emergencyCheck.shouldCut) {
        log.warn(`EMERGENCY CUT triggered: ${emergencyCheck.reason}`);
        const emTokenBook = emergencyPos.side === 'UP' ? orderbookUp : orderbookDown;
        const emBestBid = emTokenBook?.bids?.[0]?.price ?? null;
        if (emBestBid && acquireSellLock('emergency_cut')) {
          try {
            // Fix C1+C2: correct args — closePosition(tokenId, size, price) not (position, bid, slippage)
            // Apply 3% slippage to bestBid price for aggressive emergency fill
            const emSellPrice = Math.max(0.01, Math.round(emBestBid * 0.97 * 1000) / 1000);
            const result = await closePosition(emergencyPos.tokenId, emergencyPos.size, emSellPrice);
            // closePosition returns takingAmount (USDC received), not .success flag
            const emRecovery = parseClobAmount(result?.takingAmount, emSellPrice * emergencyPos.size);
            if (emRecovery !== null) {
              settleTradeEarlyExit(emRecovery);
              writeJournalEntry({ outcome: 'EMERGENCY_CUT', pnl: emRecovery - emergencyPos.cost, exitData: { reason: emergencyCheck.reason } });
              clearEntrySnapshot();
              resetCutLossState();
              resetTakeProfitState();
              resetRecovery(); // Emergency cut cancels any pending recovery
              resetLimitOrderState();
              notify('critical', `EMERGENCY CUT: ${emergencyCheck.reason} | Recovered $${emRecovery.toFixed(2)} | Bankroll: $${getBankroll().toFixed(2)}\n<a href="https://polymarket.com/event/${emergencyPos.marketSlug}">View Market</a>`);
            }
          } finally { releaseSellLock(); }
        }
      }
    }

    // ── 6b. Smart money sell-first check ──
    // DISABLED by default — data 2026-02-24: -$2.68 loss from 3 trades.
    // Smart flow accuracy only 56% in late window. Settlement WR 71.1% beats early sell at loss.
    // Enable with SMART_SELL_FIRST_ENABLED=true in .env if flow model improves.
    let smartSellTriggered = false;
    const sfPos = getCurrentPosition();
    const smartSellFirstEnabled = process.env.SMART_SELL_FIRST_ENABLED === 'true';
    // Bug 1 fix: require fillConfirmed — don't try to sell tokens not yet confirmed on-chain
    if (smartSellFirstEnabled && sfPos && !sfPos.settled && sfPos.fillConfirmed && sfPos.side !== 'ARB') {
      const sfFlowAgrees = smartFlowSignal.agreesWithSide?.(sfPos.side) ?? true;
      const sfTokenPrice = sfPos.side === 'UP' ? marketUp : marketDown;
      const sfTokenBook = sfPos.side === 'UP' ? orderbookUp : orderbookDown;
      const sfBestBid = sfTokenBook?.bestBid ?? sfTokenPrice;
      const sfHoldSec = (Date.now() - (sfPos.enteredAt ?? 0)) / 1000;

      // Trigger conditions: strong early flow disagrees + held for at least 60s + token not deeply profitable
      const sfGainPct = sfPos.price > 0 && sfTokenPrice ? ((sfTokenPrice - sfPos.price) / sfPos.price) * 100 : 0;
      if (
        !sfFlowAgrees &&
        smartFlowSignal.window === 'EARLY' &&
        smartFlowSignal.confidence > 0.5 &&
        smartFlowSignal.strength > 0.4 &&
        sfHoldSec > 60 &&
        sfGainPct < 15 // Don't sell if already deep in profit (let take-profit handle)
      ) {
        if (!acquireSellLock('smart_sell_first')) {
          log.info('Smart sell-first skipped — sell already in progress');
        } else {
          try {
            // Bug 4 fix: guard null price before proceeding (CLOB WS may be disconnected)
            const sfRawPrice = sfBestBid ?? sfTokenPrice;
            if (!sfRawPrice || !Number.isFinite(sfRawPrice)) {
              log.info('Smart sell-first skipped — no valid token price available');
              // H1 FIX: Do NOT throw here — throwing aborts the entire poll (steps 7-13 skipped,
              // no broadcast). Use early return via else-block; finally still releases sell lock.
            } else {
            smartSellTriggered = true;
            // Bug 3 fix: apply 1% slippage (same as take-profit) to improve FOK fill rate
            const sfSellPrice = Math.max(0.01, Math.round(sfRawPrice * 0.99 * 1000) / 1000);
            const sfSellSize = sfPos.size;
            const sfRecovery = sfSellPrice * sfSellSize;
            log.warn(
              `SMART SELL-FIRST: ${sfPos.side} position vs early flow ${smartFlowSignal.direction} ` +
              `(str=${smartFlowSignal.strength} conf=${smartFlowSignal.confidence}) | ` +
              `sell ${sfSellSize} @$${sfSellPrice.toFixed(3)} → recover $${sfRecovery.toFixed(2)}`
            );
            const sfExitData = {
              btcPrice: lastPrice, priceToBeat: priceToBeat.value,
              marketUp, marketDown, tokenPrice: sfTokenPrice,
              regime: regimeInfo?.regime, timeLeftMin,
              smartFlowDirection: smartFlowSignal.direction,
              smartFlowStrength: smartFlowSignal.strength,
            };
            if (BOT_CONFIG.dryRun) {
              const sfPnl = sfRecovery - sfPos.cost;
              settleTradeEarlyExit(sfRecovery);
              invalidateSync();
              writeJournalEntry({ outcome: 'SMART_SELL_FIRST', pnl: sfPnl, exitData: sfExitData });
              clearEntrySnapshot();
              resetCutLossState();
              resetTakeProfitState();
              resetRecovery(); // Smart sell cancels any pending recovery
              resetLimitOrderState();
              if (sfPnl < 0) recordLoss();
              notify('info', `SMART SELL-FIRST: ${sfPos.side} vs flow ${smartFlowSignal.direction} | P&L $${sfPnl.toFixed(2)} | $${getBankroll().toFixed(2)}\n<a href="https://polymarket.com/event/${sfPos.marketSlug}">View Market</a>`);
            } else {
              try {
                const sfResult = await closePosition(sfPos.tokenId, sfSellSize, sfSellPrice);
                const sfActualRecovery = parseClobAmount(sfResult?.takingAmount, sfRecovery);
                const sfPnl = sfActualRecovery - sfPos.cost;
                settleTradeEarlyExit(sfActualRecovery);
                invalidateSync();
                writeJournalEntry({ outcome: 'SMART_SELL_FIRST', pnl: sfPnl, exitData: { ...sfExitData, recovered: sfActualRecovery } });
                clearEntrySnapshot();
                resetCutLossState();
                resetTakeProfitState();
                resetRecovery(); // Smart sell cancels any pending recovery
                resetLimitOrderState();
                if (sfPnl < 0) recordLoss();
                notify('info', `SMART SELL-FIRST: ${sfPos.side} vs flow ${smartFlowSignal.direction} | P&L $${sfPnl.toFixed(2)} | $${getBankroll().toFixed(2)}\n<a href="https://polymarket.com/event/${sfPos.marketSlug}">View Market</a>`);
              } catch (err) {
                log.warn(`Smart sell-first FAILED: ${err.stack || err.message}`);
                smartSellTriggered = false;
              }
            }
            } // close else { smartSellTriggered = true; ... } (H1 FIX)
          } finally { releaseSellLock(); }
        }
      }
    }

    // ── Fix C1: Auto-confirm fill if position held >= 90s — now with on-chain verification ──
    // Covers: fill tracker timeout, bot restart with unconfirmed position, CLOB API errors.
    // 90s < minHoldSec (240s) so cut-loss can evaluate immediately after auto-confirmation.
    // C1 FIX: Verify tokens exist on-chain before confirming — prevents phantom positions.
    {
      const autoPos = getCurrentPosition();
      if (autoPos && !autoPos.settled && !autoPos.fillConfirmed && autoPos.side !== 'ARB') {
        const holdSec = (Date.now() - (autoPos.enteredAt ?? 0)) / 1000;
        if (holdSec >= 90) {
          let onChainVerified = false;
          if (isClientReady() && autoPos.tokenId) {
            try {
              const balInfo = await getConditionalTokenBalance(autoPos.tokenId);
              if (balInfo && balInfo.balance > 0) {
                onChainVerified = true;
                log.info(`Auto-confirm: on-chain balance verified (${balInfo.balance.toFixed(4)} tokens)`);
              } else {
                log.warn(`Auto-confirm BLOCKED: no tokens on-chain for ${autoPos.tokenId.slice(0, 12)}... — phantom position, unwinding`);
                unwindPosition();
                writeJournalEntry({ outcome: 'UNWIND', pnl: 0, exitData: { reason: 'auto_confirm_no_tokens' } });
                clearEntrySnapshot();
              }
            } catch (err) {
              onChainVerified = true; // Balance check failed — confirm conservatively
              log.warn(`Auto-confirm: on-chain check failed (${err.message}) — confirming conservatively`);
            }
          } else {
            onChainVerified = true; // Client not ready — confirm conservatively
          }
          if (onChainVerified) {
            log.warn(`Auto-confirm fill: ${autoPos.side} held ${holdSec.toFixed(0)}s without CLOB verification — confirmed${isClientReady() ? ' (on-chain verified)' : ' (conservative)'}`);
            confirmFill();
          }
        }
      }
    }

    // ── 6c. Cut-loss check (skip ARB — guaranteed profit, never cut) ──
    const pos = getCurrentPosition();
    const isPreMarketPos = pos && isPreMarketPosition(marketSlug);
    if (pos && !pos.settled) {
      const tokenPrice = pos.side === 'UP' ? marketUp : marketDown;
      updatePositionMarketPrice(tokenPrice); // Fix M: keep mark-to-market drawdown current
    }
    if (pos && !pos.settled && pos.side !== 'ARB' && !smartSellTriggered && !isPreMarketPos) {
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
      // Fix A: Naikkan ke info level + interval lebih sering (setiap 3 poll ~6s) agar diagnostics visible di production
      if (pollCounter % 3 === 0) {
        const ep = pos.price;
        const dropPct = ep > 0 && tokenPrice != null
          ? (((ep - tokenPrice) / ep) * 100).toFixed(1) : '?';
        const btcDist = lastPrice && priceToBeat.value
          ? (Math.abs((lastPrice - priceToBeat.value) / priceToBeat.value) * 100).toFixed(3) : '?';
        const btcSide = lastPrice && priceToBeat.value
          ? (pos.side === 'UP' ? lastPrice >= priceToBeat.value : lastPrice < priceToBeat.value) ? 'WIN' : 'LOSE'
          : '?';
        log.info(
          `CutLoss: ${cutResult.reason} | ${pos.side} drop=${dropPct}% | ` +
          `BTC ${btcSide} dist=${btcDist}% | d1m=$${(delta1m ?? 0).toFixed(1)} | ` +
          `ATR=${(atr?.atrRatio ?? 0).toFixed(2)} | ${regimeInfo?.regime ?? '?'}${entryRegime && entryRegime !== regimeInfo?.regime ? `(was ${entryRegime})` : ''} | ` +
          `EV(hold)=${((pos.side === 'UP' ? ensembleUp : ensembleDown) * 100).toFixed(0)}% vs token=${(tokenPrice * 100).toFixed(0)}¢`
        );
      }

      if (cutResult.shouldCut) {
        if (!acquireSellLock('cut_loss')) {
          log.info('Cut-loss skipped — sell already in progress (dashboard?)');
        } else {
          try {
            const sellSize = pos.size;
            log.warn(
              `CUT-LOSS v4: ${pos.side} drop ${cutResult.dropPct.toFixed(1)}% | ` +
              `sell ${sellSize} shares @$${cutResult.sellPrice.toFixed(3)} | ` +
              `recover $${cutResult.recoveryAmount.toFixed(2)} of $${pos.cost.toFixed(2)}` +
              `${cutResult.urgency === 'crash' ? ` [${cutResult.reason}]` : ''}`
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
              writeJournalEntry({ outcome: 'CUT_LOSS', pnl: cutPnl, exitData: { ...exitData, cutLossRecovered: recovery } });
              clearEntrySnapshot();
              resetCutLossState();
              resetTakeProfitState();
              resetLimitOrderState();
              // Trigger recovery buy sampling (captures side/token before pos is cleared)
              recoveryOnCutLoss({ side: pos.side, tokenId: pos.tokenId, conditionId: pos.conditionId, marketSlug: pos.marketSlug });
              if (cutPnl < 0) {
                recordLoss();
                tiltMarketsLeft = TILT_MARKETS + 1;
                log.info(`Tilt protection activated: ML conf >= ${TILT_ML_CONF_MIN * 100}% for next ${TILT_MARKETS} markets`);
                notify('warn', `CUT-LOSS: ${pos.side} P&L $${cutPnl.toFixed(2)} | Bankroll: $${getBankroll().toFixed(2)}\n<a href="https://polymarket.com/event/${pos.marketSlug}">View Market</a>`);
              }
            } else {
              recordSellAttempt();
              try {
                const sellResult = await closePosition(pos.tokenId, sellSize, cutResult.sellPrice);
                const actualRecovery = parseClobAmount(sellResult?.takingAmount, cutResult.sellPrice * sellSize);
                const cutPnl = actualRecovery - pos.cost;
                settleTradeEarlyExit(actualRecovery);
                invalidateSync();
                writeJournalEntry({ outcome: 'CUT_LOSS', pnl: cutPnl, exitData: { ...exitData, cutLossRecovered: actualRecovery } });
                clearEntrySnapshot();
                resetCutLossState();
                resetTakeProfitState();
                resetLimitOrderState();
                // Trigger recovery buy sampling (captures side/token before pos is cleared)
                recoveryOnCutLoss({ side: pos.side, tokenId: pos.tokenId, conditionId: pos.conditionId, marketSlug: pos.marketSlug });
                if (cutPnl < 0) {
                  recordLoss();
                  tiltMarketsLeft = TILT_MARKETS + 1;
                  log.info(`Tilt protection activated: ML conf >= ${TILT_ML_CONF_MIN * 100}% for next ${TILT_MARKETS} markets`);
                  notify('warn', `CUT-LOSS: ${pos.side} P&L $${cutPnl.toFixed(2)} | Bankroll: $${getBankroll().toFixed(2)}\n<a href="https://polymarket.com/event/${pos.marketSlug}">View Market</a>`);
                }
              } catch (err) {
                if (err.message === 'no_tokens_on_chain') {
                  // Phantom position: tokens never received or already redeemed on-chain.
                  // Unwind state to prevent infinite cut-loss retry loops.
                  log.error(`CUT-LOSS: Phantom position — no tokens found on-chain. Unwinding position state (loss=$${pos.cost.toFixed(2)})`);
                  settleTradeEarlyExit(0); // 0 recovery
                  invalidateSync();
                  writeJournalEntry({ outcome: 'PHANTOM_LOSS', pnl: -pos.cost, exitData: { ...exitData, reason: 'no_tokens_on_chain' } });
                  clearEntrySnapshot();
                  resetCutLossState();
                  resetTakeProfitState();
                  resetLimitOrderState();
                  recordLoss();
                  tiltMarketsLeft = TILT_MARKETS + 1;
                  notify('critical', `PHANTOM POSITION: tokens not found on-chain. State unwound. Loss -$${pos.cost.toFixed(2)}\n<a href="https://polymarket.com/event/${pos.marketSlug}">View Market</a>`);
                } else {
                  log.warn(`Cut-loss sell FAILED: ${err.stack || err.message}`);
                  resetCutConfirm();
                }
              }
            }
          } finally { releaseSellLock(); }
        }
      }
    }

    // ── 6d. Take-profit check (C5 fix: uses same sell lock as cut-loss/dashboard) ──
    // evaluateTakeProfit() returns no('disabled') immediately when takeProfit.enabled=false.
    // Wired here so if ever enabled, race safety is already guaranteed via acquireSellLock.
    const tpPos = getCurrentPosition();
    if (tpPos && !tpPos.settled && tpPos.side !== 'ARB' && !smartSellTriggered) {
      const tpTokenPrice = tpPos.side === 'UP' ? marketUp : marketDown;
      const tpTokenBook = tpPos.side === 'UP' ? orderbookUp : orderbookDown;
      // v2: Pass entry snapshot data for entry-relative comparison
      const tpSnap = getEntrySnapshot();
      const tpEntryProb = tpSnap
        ? (tpPos.side === 'UP' ? tpSnap.ensembleUp : (1 - (tpSnap.ensembleUp ?? 0.5)))
        : null;
      const tpBestEdge = tpPos.side === 'UP' ? (edge.edgeUp ?? null) : (edge.edgeDown ?? null);
      const tpResult = evaluateTakeProfit({
        position: tpPos, currentTokenPrice: tpTokenPrice,
        orderbook: tpTokenBook, timeLeftMin,
        modelProbability: tpPos.side === 'UP' ? ensembleUp : ensembleDown,
        mlConfidence: mlResult.available ? mlResult.mlConfidence : null,
        mlSide: mlResult.available ? mlResult.mlSide : null,
        regime: regimeInfo?.regime ?? 'moderate',
        entryRegime,
        btcDelta1m: delta1m,
        entryEnsembleProb: tpEntryProb,
        bestEdge: tpBestEdge,
      });

      if (tpResult.shouldTakeProfit) {
        if (!acquireSellLock('take_profit')) {
          log.info('Take-profit skipped — sell already in progress');
        } else {
          try {
            const tpSellSize = tpPos.size;
            log.info(
              `TAKE-PROFIT: ${tpPos.side} gain ${tpResult.gainPct.toFixed(1)}% | ` +
              `sell ${tpSellSize} shares @$${tpResult.sellPrice.toFixed(3)} | ` +
              `recover $${tpResult.recoveryAmount.toFixed(2)} | ${tpResult.reason}`
            );
            const tpExitData = { gainPct: tpResult.gainPct, weakeners: tpResult.weakeners, timeLeftMin };

            if (BOT_CONFIG.dryRun) {
              const tpPnl = tpResult.recoveryAmount - tpPos.cost;
              settleTradeEarlyExit(tpResult.recoveryAmount);
              invalidateSync();
              writeJournalEntry({ outcome: 'TAKE_PROFIT', pnl: tpPnl, exitData: tpExitData });
              clearEntrySnapshot();
              resetCutLossState();
              resetTakeProfitState();
              resetRecovery(); // Take-profit cancels any pending recovery
              resetLimitOrderState();
              notify('info', `TAKE-PROFIT (dry): ${tpPos.side} +${tpResult.gainPct.toFixed(1)}% | P&L $${tpPnl.toFixed(2)} | Bankroll: $${getBankroll().toFixed(2)}\n<a href="https://polymarket.com/event/${tpPos.marketSlug}">View Market</a>`);
            } else {
              try {
                const tpSellResult = await closePosition(tpPos.tokenId, tpSellSize, tpResult.sellPrice);
                const tpActualRecovery = parseClobAmount(tpSellResult?.takingAmount, tpResult.sellPrice * tpSellSize);
                const tpPnl = tpActualRecovery - tpPos.cost;
                settleTradeEarlyExit(tpActualRecovery);
                invalidateSync();
                writeJournalEntry({ outcome: 'TAKE_PROFIT', pnl: tpPnl, exitData: { ...tpExitData, recovered: tpActualRecovery } });
                clearEntrySnapshot();
                resetCutLossState();
                resetTakeProfitState();
                resetRecovery(); // Take-profit cancels any pending recovery
                resetLimitOrderState();
                notify('info', `TAKE-PROFIT: ${tpPos.side} +${tpResult.gainPct.toFixed(1)}% | P&L $${tpPnl.toFixed(2)} | Bankroll: $${getBankroll().toFixed(2)}\n<a href="https://polymarket.com/event/${tpPos.marketSlug}">View Market</a>`);
              } catch (err) {
                log.warn(`Take-profit sell FAILED: ${err.stack || err.message}`);
                resetTakeProfitState();
              }
            }
          } finally { releaseSellLock(); }
        }
      }
    }

    // Pre-market TP & SL REMOVED — full hold to settlement (settlement WR 87.5% beats early exit)

    // ── 6e. Recovery buy tick (after cut-loss, re-enter if signal stabilizes) ──
    if (isRecoveryActive()) {
      const recoveryPos = getCurrentPosition();
      const haltCheck2 = shouldHalt({
        dailyPnLPct: getDailyPnLPct(),
        bankroll: getBankroll(),
        consecutiveLosses: getConsecutiveLosses(),
        drawdownPct: getDrawdownPct(),
      });
      const recoveryResult = recoveryTick({
        tokenPrice: isRecoveryActive() ? (getRecoveryStatus().side === 'UP' ? marketUp : marketDown) : null,
        timeLeftMin,
        mlConfidence: mlResult.available ? mlResult.mlConfidence : null,
        mlSide: mlResult.available ? mlResult.mlSide : null,
        ensembleProb: isRecoveryActive()
          ? (getRecoveryStatus().side === 'UP' ? ensembleUp : ensembleDown) : null,
        hasPosition: recoveryPos != null && !recoveryPos.settled,
        isHalted: haltCheck2.halt,
        bankroll: getAvailableBankroll(),
        marketSlug,
        smartFlowSignal: smartFlowSignal ?? null, // C3 audit fix: block recovery against smart money
      });

      if (recoveryResult.shouldBuy && !settlementPending) {
        const rcvSide = recoveryResult.side;
        const rcvTokenId = recoveryResult.tokenId;
        const rcvPrice = rcvSide === 'UP' ? marketUp : marketDown;
        // Recovery sizing: maxRecoveryPct of normal bet, capped by maxBetAmountUsd
        const rcvBankroll = getAvailableBankroll();
        const rcvMaxBet = BOT_CONFIG.maxBetAmountUsd ?? 2.50;
        const rcvBet = Math.min(rcvBankroll * (recoveryResult.sizePct ?? 0.50), rcvMaxBet);
        const rcvSize = rcvPrice > 0 ? Math.floor(rcvBet / rcvPrice) : 0;

        if (rcvSize >= 1 && rcvPrice > 0 && rcvPrice < 0.99) {
          log.info(`RECOVERY BUY: ${rcvSide} ${rcvSize} shares @ $${rcvPrice.toFixed(3)} ($${(rcvSize * rcvPrice).toFixed(2)})`);
          try {
            if (BOT_CONFIG.dryRun) {
              recordTrade({ side: rcvSide, tokenId: rcvTokenId, conditionId: recoveryResult.conditionId, price: rcvPrice, size: rcvSize, marketSlug });
              confirmFill();
              captureEntrySnapshot({ btcPrice: lastPrice, priceToBeat: priceToBeat.value, marketUp, marketDown, ensembleUp, rsiNow, timeLeftMin, regime: regimeInfo?.regime });
              entryRegime = regimeInfo?.regime ?? null;
              notify('info', `RECOVERY BUY (dry): ${rcvSide} ${rcvSize}@${rcvPrice.toFixed(3)} | $${getBankroll().toFixed(2)}\n<a href="https://polymarket.com/event/${marketSlug}">View Market</a>`);
            } else {
              const rcvResult = await placeBuyOrder({ tokenId: rcvTokenId, price: rcvPrice, size: rcvSize });
              const rcvOrderId = rcvResult?.orderId ?? null;
              recordTrade({ side: rcvSide, tokenId: rcvTokenId, conditionId: recoveryResult.conditionId, price: rcvPrice, size: rcvSize, marketSlug, orderId: rcvOrderId });
              trackOrderPlacement(rcvOrderId);
              captureEntrySnapshot({ btcPrice: lastPrice, priceToBeat: priceToBeat.value, marketUp, marketDown, ensembleUp, rsiNow, timeLeftMin, regime: regimeInfo?.regime });
              entryRegime = regimeInfo?.regime ?? null;
              if (!BOT_CONFIG.dryRun && rcvTokenId) {
                updateConditionalApproval(rcvTokenId).catch(e => log.warn(`Recovery approval skip: ${e.message}`));
              }
              notify('info', `RECOVERY BUY: ${rcvSide} ${rcvSize}@${rcvPrice.toFixed(3)} | $${getBankroll().toFixed(2)}\n<a href="https://polymarket.com/event/${marketSlug}">View Market</a>`);
            }
          } catch (err) {
            log.warn(`Recovery buy FAILED: ${err.stack || err.message}`);
          }
        } else {
          log.info(`Recovery buy skipped: size=${rcvSize} price=${rcvPrice?.toFixed(3)} — insufficient`);
        }
      } else if (pollCounter % 10 === 0 && isRecoveryActive()) {
        log.debug(`Recovery: ${recoveryResult.reason}`);
      }
    }

    // ── 7. Decision ──
    const rec = decide({
      remainingMinutes: timeLeftMin,
      edgeUp: edge.edgeUp, edgeDown: edge.edgeDown,
      modelUp: ensembleUp, modelDown: ensembleDown,
      effectiveUp: edge.effectiveUp, effectiveDown: edge.effectiveDown,
      breakdown: scored.breakdown,
      multiTfConfirmed: multiTfConfirm?.agreement ?? false,
      mlConfidence: mlResult.available ? mlResult.mlConfidence : null,
      mlAgreesWithRules,
      regimeInfo,
      session: getSessionName(),
      calibratedThresholds: getCalibratedPhaseThresholds(),
      smartFlowSignal,
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
      smartFlowSignal,
      entryTimingScore,
      mcResult,
    });

    // ── 9. Feedback tracking (stale cleanup) ──
    try {
      autoSettle(marketSlug, lastPrice, priceToBeat.value, timeLeftMin);
    } catch (feedbackErr) { log.debug(`Feedback error: ${feedbackErr.message}`); }

    // ── 9b. Limit Order Strategy (passive entry at optimal prices) ──
    // Places GTD limit orders at 55-62¢ during first 0:30-3:00 of market.
    // Monitors fill status; cancels on signal flip or 10 min timeout → FOK fallback.
    let limitOrderBlocksFOK = false;
    let smartRouteFOK = false;
    if (BOT_CONFIG.limitOrder.enabled && !settlementPending && !profitTargetPaused) {
      const limitActive = isLimitOrderActive();
      // Compute elapsed minutes since market opened (15 min markets)
      const elapsedMin = timeLeftMin != null ? Math.max(0, 15 - timeLeftMin) : null;
      const limAlreadyHasPos = hasOpenPosition(marketSlug);
      const limHasPending = hasPendingOrder();

      if (!limitActive && !limAlreadyHasPos && !limHasPending && elapsedMin != null) {
        // ── Smart Order Router ──
        const limMlConf = mlResult.available ? mlResult.mlConfidence : null;
        const limMlSide = mlResult.available ? mlResult.mlSide : null;
        const bestAskForSide = limMlSide === 'UP'
          ? (orderbookUp?.bestAsk ?? marketUp ?? null)
          : (orderbookDown?.bestAsk ?? marketDown ?? null);

        const spreadForSide = limMlSide === 'UP'
          ? (orderbookUp?.spread ?? null)
          : (orderbookDown?.spread ?? null);

        const routeDecision = routeOrder({
          bestAsk: bestAskForSide,
          mlConf: limMlConf,
          elapsedMin,
          delta1m,
          mlSide: limMlSide,
          regime: regimeInfo?.regime ?? 'moderate',
          spread: spreadForSide,
          btcPrice: lastPrice ?? 0,
        });

        if (routeDecision.route === 'FOK') {
          smartRouteFOK = true;
          log.info(`SMART_ROUTE→FOK: ${routeDecision.reason}`);
          // Skip limit order evaluation, let step 10b handle FOK entry
        } else if (routeDecision.route === 'LIMIT') {
        // ── Apply trade filters to limit orders (relaxed vs FOK) ──
        // Limit orders enter at 55-62¢ (vs FOK 65-75¢) during first 0:30-3:00 of market.
        // evaluateLimitEntry() has its own gates: ML ≥ 60%, edge ≥ 5%, BTC-PTB consensus.
        // Skip FOK-specific filters that don't apply to early-market limit context:
        //   mlConfidence=null  → skip ML conf gate (#1), dead zone (#1b), trending ML (#11c)
        //                        (limitOrderManager has own 60% gate — cheaper price compensates)
        //   marketPrice=null   → skip price floor/ceiling (limit targets 50-62¢)
        //   timeLeftMin=null   → skip time gates (limit has own window: 0:30-3:00)
        //   bestEdge=null      → skip edge ceiling (#8) — early tokens are cheap, edge naturally high
        //                        (limitOrderManager has own 5% edge gate)
        //   spread=null        → skip wide spread (#12) + spread widening (#15)
        //                        (spreads naturally wider in first 3 min as orderbook forms)
        //   priceToBeat=null   → skip BTC distance from PTB (#4c) — BTC naturally near PTB early
        //                        (limitOrderManager has own BTC-PTB consensus gate)
        // Kept safety filters: blackout (#10), loss cooldown (#5), max trades (#6),
        //   counter-trend (#9, uses btcPrice+delta1m), low vol (#3), ML degradation (#13), VPIN (#14)
        const limEtHour = parseInt(new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }), 10);

        const limFilterResult = applyTradeFilters({
          mlConfidence: null,                        // Skip — limitOrderManager has own 60% ML gate
          mlAvailable: mlResult.available,
          marketPrice: null,                         // Skip price floor/ceiling (limit orders target 50-62¢)
          atrRatio: atr?.atrRatio ?? null,
          timeLeftMin: null,                         // Skip time gates (limit has own window: 0:30-3:00)
          marketSlug,
          consecutiveLosses: getConsecutiveLosses(),
          session: getSessionName(),
          btcPrice: lastPrice,
          priceToBeat: null,                         // Skip BTC distance — own BTC-PTB consensus gate
          tiltMlConfMin: null,                       // Skip — limit has own gates
          bestEdge: null,                            // Skip edge ceiling — own 5% edge gate
          delta1m,
          signalSide: limMlSide,
          regime: regimeInfo?.regime ?? 'moderate',
          etHour: limEtHour,
          spread: null,                              // Skip — spreads naturally wider early
          mlAccuracy: getMLAccuracy?.() ?? null,
          buyRatio: volDelta?.buyRatio ?? null,
        });

        if (!limFilterResult.pass) {
          // Log filter rejection (throttled to avoid spam — every 30s)
          if (!limitOrderFilterLogAt || Date.now() - limitOrderFilterLogAt > 30_000) {
            log.info(`LIMIT_FILTERED: ${limFilterResult.reasons.join(' | ')}`);
            limitOrderFilterLogAt = Date.now();
          }
        }

        // ── Signal stability gate for limit orders ──
        // Relaxed: half of FOK required polls (discount price compensates for less confirmation).
        // Prevents placing limit orders on flip-flopping signals that haven't stabilized.
        const limStabPolls = Math.max(2, Math.ceil(SIGNAL_CONFIRM_POLLS / 2));
        const limSignalStable = isSignalStable(limStabPolls);
        if (!limSignalStable && limFilterResult.pass) {
          const stabReasons = getInstabilityReasons(limStabPolls);
          if (!limitOrderFilterLogAt || Date.now() - limitOrderFilterLogAt > 30_000) {
            log.info(`LIMIT_STAB_WAIT: ${stabReasons.join(' | ')}`);
            limitOrderFilterLogAt = Date.now();
          }
        }

        // Evaluate whether to place a limit order (during 0:30-3:00 window)
        const haltForLimit = shouldHalt({
          dailyPnLPct: getDailyPnLPct(),
          bankroll: getBankroll(),
          consecutiveLosses: getConsecutiveLosses(),
          drawdownPct: getDrawdownPct(),
        });
        const limitEval = (limFilterResult.pass && limSignalStable) ? evaluateLimitEntry({
          mlConfidence: mlResult.available ? mlResult.mlConfidence : null,
          mlSide: mlResult.available ? mlResult.mlSide : null,
          btcPrice: lastPrice,
          priceToBeat: priceToBeat.value,
          bestBidUp: orderbookUp?.bestBid ?? null,
          bestBidDown: orderbookDown?.bestBid ?? null,
          hasPosition: limAlreadyHasPos,
          isHalted: haltForLimit.halt,
          marketSlug,
          elapsedMin,
          btcDelta1m: delta1m,
          spread: spreadForSide,
        }) : { shouldPlace: false, side: null, targetPrice: null, reason: !limFilterResult.pass ? `filtered: ${limFilterResult.reasons[0] ?? 'unknown'}` : `unstable: ${getInstabilityReasons(limStabPolls).join(', ')}` };

        if (limitEval.shouldPlace && poly.tokens) {
          const limitTokenId = limitEval.side === 'UP' ? poly.tokens.upTokenId : poly.tokens.downTokenId;
          if (limitTokenId && settlementMs) {
            try {
              const placeResult = await placeLimitOrder({
                side: limitEval.side,
                targetPrice: limitEval.targetPrice,
                tokenId: limitTokenId,
                marketSlug,
                conditionId: currentConditionId ?? poly?.market?.conditionId ?? poly?.market?.condition_id ?? null,
                marketEndMs: settlementMs,
                bankroll: getAvailableBankroll(),
                mlConfidence: mlResult.available ? mlResult.mlConfidence : null,
                sessionQuality: limFilterResult.sessionQuality ?? 1.0, // Fix #7: session quality scaling
              }, { placeLimitBuyOrder, setPendingCost });

              if (placeResult.placed) {
                limitOrderBlocksFOK = true;
                // Fix #8: Use actual placed data from getLimitOrderStatus() instead of recalculating
                const limSt = getLimitOrderStatus();
                notify('info',
                  `📋 LIMIT ORDER PLACED\n` +
                  `Side: ${limitEval.side} | Price: ${(limitEval.targetPrice * 100).toFixed(1)}¢\n` +
                  `Size: ${limSt.size ?? '?'} shares ($${limSt.size && limSt.targetPrice ? (limSt.size * limSt.targetPrice).toFixed(2) : '?'})\n` +
                  `ML: ${mlResult.available ? (mlResult.mlConfidence * 100).toFixed(0) + '%' : 'off'} | Bankroll: $${getBankroll().toFixed(2)}\n` +
                  `Waiting for fill (max ${BOT_CONFIG.limitOrder.cancelAfterElapsedMin}min)...\n` +
                  `<a href="https://polymarket.com/event/${marketSlug}">View Market</a>`,
                  { key: 'trade:limit' }).catch(e => log.debug(`Notify limit placed: ${e.message}`));
              }
            } catch (err) {
              log.error(`Limit order placement failed (bot kept alive): ${err.message}`);
              notify('warn',
                `⚠️ LIMIT ORDER FAILED\n` +
                `Side: ${limitEval.side} | Price: ${(limitEval.targetPrice * 100).toFixed(1)}¢\n` +
                `Error: ${err.message.slice(0, 100)}\n` +
                `FOK fallback active`,
                { key: 'trade:limit:fail' }).catch(e => log.debug(`Notify limit fail: ${e.message}`));
            }
          }
        }
        } // end routeDecision === 'LIMIT'
        // WAIT → neither limit nor FOK fires this poll
      } else if (limitActive) {
        // Monitor active limit order
        limitOrderBlocksFOK = true;

        // ── Dynamic ML Upgrade: cancel limit → FOK when ML rises significantly ──
        const upgradeMlConf = mlResult.available ? mlResult.mlConfidence : null;
        if (upgradeMlConf != null && upgradeMlConf >= BOT_CONFIG.orderRouter.upgradeMLThreshold) {
          const limStatus = getLimitOrderStatus();
          const holdingSec = limStatus.placedAt ? (Date.now() - limStatus.placedAt) / 1000 : 0;
          if (holdingSec > (BOT_CONFIG.orderRouter.upgradeHoldSec ?? 60)) {
            log.info(`SMART_ROUTE→UPGRADE: ML ${(upgradeMlConf * 100).toFixed(0)}% ≥ ${(BOT_CONFIG.orderRouter.upgradeMLThreshold * 100).toFixed(0)}% — cancel limit → FOK`);
            try {
              const upgradeResult = await cancelLimitOrder('smart_upgrade_fok', { cancelOrder, setPendingCost, getOrderById, getOrderStatus });
              if (upgradeResult?.filledInstead && upgradeResult.fillData) {
                // Limit order was already filled — record position, skip FOK
                const fd = upgradeResult.fillData;
                log.warn(`PHANTOM FILL during upgrade — limit was already filled: ${fd.side} ${fd.size}@${(fd.price * 100).toFixed(1)}c`);
                recordTrade({
                  side: fd.side, tokenId: fd.tokenId,
                  conditionId: fd.conditionId,
                  price: fd.price, size: fd.size,
                  marketSlug: fd.marketSlug, orderId: fd.orderId,
                  actualCost: fd.price * fd.size,
                });
                confirmFill();
                entryRegime = regimeInfo?.regime ?? 'moderate';
                recordTradeForMarket(fd.marketSlug);
                captureEntrySnapshot({
                  side: fd.side, tokenPrice: fd.price, btcPrice: lastPrice,
                  priceToBeat: priceToBeat.value, marketSlug: fd.marketSlug,
                  cost: fd.price * fd.size, size: fd.size,
                  confidence: 'LIMIT_PHANTOM', phase: rec?.phase, reason: 'phantom_fill_upgrade',
                  timeLeftMin, session: getSessionName(),
                });
                notify('warn',
                  `🔴 PHANTOM FILL during upgrade\n` +
                  `Limit was already filled: ${fd.side} ${fd.size}@${(fd.price * 100).toFixed(1)}¢\n` +
                  `Position recorded — skipping FOK`,
                  { key: 'trade:limit:phantom' }).catch(e => log.debug(`Notify phantom: ${e.message}`));
                // DON'T set smartRouteFOK — limit already filled, don't double-buy
              } else {
                limitOrderBlocksFOK = false;
                smartRouteFOK = true;
              }
            } catch (upgradeErr) {
              log.error(`Smart upgrade cancel failed: ${upgradeErr.message}`);
            }
          }
        }

        // Skip monitoring if upgrade cancelled the limit order
        if (!smartRouteFOK) {
        const elapsedMinForMonitor = timeLeftMin != null ? Math.max(0, 15 - timeLeftMin) : null;
        try {
          const monResult = await monitorLimitOrder({
            mlConfidence: mlResult.available ? mlResult.mlConfidence : null,
            mlSide: mlResult.available ? mlResult.mlSide : null,
            ensembleProb: getLimitOrderStatus().side === 'UP' ? ensembleUp : ensembleDown,
            btcPrice: lastPrice,
            priceToBeat: priceToBeat.value,
            elapsedMin: elapsedMinForMonitor,
            marketSlug,
          }, { getOrderById, getOrderStatus, cancelOrder, setPendingCost });

          if (monResult.action === 'FILLED' && monResult.fillData) {
            // Order filled — record position
            const fd = monResult.fillData;
            setPendingCost(0);
            recordTrade({
              side: fd.side, tokenId: fd.tokenId,
              conditionId: fd.conditionId,
              price: fd.price, size: fd.size,
              marketSlug: fd.marketSlug, orderId: fd.orderId,
              actualCost: fd.price * fd.size,
            });
            confirmFill(); // Fix #1: limit order fills are confirmed (order gone from book = filled)
            entryRegime = regimeInfo?.regime ?? 'moderate';
            recordTradeForMarket(fd.marketSlug);
            captureEntrySnapshot({
              side: fd.side, tokenPrice: fd.price, btcPrice: lastPrice,
              priceToBeat: priceToBeat.value, marketSlug: fd.marketSlug,
              cost: fd.price * fd.size, size: fd.size,
              confidence: 'LIMIT', phase: rec?.phase, reason: 'limit_order_filled',
              timeLeftMin, session: getSessionName(),
            });
            if (updateConditionalApproval && !BOT_CONFIG.dryRun) {
              updateConditionalApproval(fd.tokenId).catch(e => log.debug(`Limit fill approval: ${e.message}`));
            }
            notify('info',
              `✅ LIMIT ORDER FILLED\n` +
              `Side: ${fd.side} | ${fd.size} shares @ ${(fd.price * 100).toFixed(1)}¢\n` +
              `Cost: $${(fd.price * fd.size).toFixed(2)} | Bankroll: $${getBankroll().toFixed(2)}\n` +
              `Now holding → settlement\n` +
              `<a href="https://polymarket.com/event/${fd.marketSlug}">View Market</a>`,
              { key: 'trade:limit:fill' }).catch(e => log.debug(`Notify limit fill: ${e.message}`));
            recordFillEvent(fd);  // Persist fill event for frontend transition display
            resetLimitOrderState();
            limitOrderBlocksFOK = false;
            alreadyHasPosition = true;  // Fix: prevent FOK double-buy in same poll after limit fill
          } else if (monResult.action === 'PARTIAL_ACCEPT' && monResult.fillData) {
            // Partial fill accepted — cancel remainder, record position
            const fd = monResult.fillData;
            recordFillEvent(fd);  // Persist fill event for frontend transition display
            await cancelLimitOrder('partial_accept_remainder', { cancelOrder, setPendingCost, getOrderById, getOrderStatus });
            recordTrade({
              side: fd.side, tokenId: fd.tokenId,
              conditionId: fd.conditionId,
              price: fd.price, size: fd.size,
              marketSlug: fd.marketSlug, orderId: fd.orderId,
              actualCost: fd.price * fd.size,
            });
            confirmFill(); // Fix #1: partial fill confirmed (tokens on-chain from matched portion)
            entryRegime = regimeInfo?.regime ?? 'moderate';
            recordTradeForMarket(fd.marketSlug);
            captureEntrySnapshot({
              side: fd.side, tokenPrice: fd.price, btcPrice: lastPrice,
              priceToBeat: priceToBeat.value, marketSlug: fd.marketSlug,
              cost: fd.price * fd.size, size: fd.size,
              confidence: 'LIMIT_PARTIAL', phase: rec?.phase, reason: 'limit_order_partial',
              timeLeftMin, session: getSessionName(),
            });
            if (updateConditionalApproval && !BOT_CONFIG.dryRun) {
              updateConditionalApproval(fd.tokenId).catch(e => log.debug(`Limit partial approval: ${e.message}`));
            }
            notify('info',
              `⚡ LIMIT PARTIAL FILL\n` +
              `Side: ${fd.side} | ${fd.size} shares @ ${(fd.price * 100).toFixed(1)}¢\n` +
              `Cost: $${(fd.price * fd.size).toFixed(2)} | Bankroll: $${getBankroll().toFixed(2)}\n` +
              `Remainder cancelled — holding partial position\n` +
              `<a href="https://polymarket.com/event/${fd.marketSlug}">View Market</a>`,
              { key: 'trade:limit:partial' }).catch(e => log.debug(`Notify limit partial: ${e.message}`));
            limitOrderBlocksFOK = false;
            alreadyHasPosition = true;  // Fix: prevent FOK double-buy in same poll after partial fill
          } else if (monResult.action === 'CANCEL_EXPIRED') {
            // GTD expired on-chain — state already reset in monitorLimitOrder
            log.info(`LIMIT ORDER expired (GTD) — not filled`);
            notify('info',
              `⏰ LIMIT ORDER EXPIRED\n` +
              `Order expired on CLOB (GTD timeout)\n` +
              `→ May retry limit order (cooldown 1min)\n` +
              `Bankroll: $${getBankroll().toFixed(2)}`,
              { key: 'trade:limit:cancel' }).catch(e => log.debug(`Notify limit expired: ${e.message}`));
            limitOrderBlocksFOK = false;
          } else if (monResult.action.startsWith('CANCEL_') || monResult.action === 'PARTIAL_REJECT') {
            // Signal flip, time cutoff, market switch, or partial reject — cancel
            const cancelReason = monResult.action === 'PARTIAL_REJECT' ? 'partial_reject' : monResult.detail;
            const limStatus = getLimitOrderStatus();
            const cancelResult = await cancelLimitOrder(cancelReason, { cancelOrder, setPendingCost, getOrderById, getOrderStatus });

            // Notify: cancelled — with human-readable reason
            if (cancelResult && !cancelResult.filledInstead) {
              const isTimeCutoff = monResult.action === 'CANCEL_TIME_CUTOFF';
              const cancelEmoji = isTimeCutoff ? '⏰' : '❌';
              const readableReason = cancelReason.replace(/_/g, ' ').replace(/\b\w/g, c => c);
              notify('info',
                `${cancelEmoji} LIMIT ORDER CANCELLED\n` +
                `Side: ${limStatus.side ?? '?'} | Was @ ${limStatus.targetPrice ? (limStatus.targetPrice * 100).toFixed(1) + '¢' : '?'}\n` +
                `Reason: ${readableReason}\n` +
                (isTimeCutoff ? `→ FOK fallback now active\n` : `→ May retry limit order (cooldown 1min)\n`) +
                `Bankroll: $${getBankroll().toFixed(2)}`,
                { key: 'trade:limit:cancel' }).catch(e => log.debug(`Notify limit cancel: ${e.message}`));
            }

            // Phantom fill detection: if cancel failed because order was already filled
            if (cancelResult?.filledInstead && cancelResult.fillData) {
              const fd = cancelResult.fillData;
              log.warn(`PHANTOM FILL detected during cancel (${cancelReason}) — recording position`);
              recordTrade({
                side: fd.side, tokenId: fd.tokenId,
                conditionId: fd.conditionId,
                price: fd.price, size: fd.size,
                marketSlug: fd.marketSlug, orderId: fd.orderId,
                actualCost: fd.price * fd.size,
              });
              confirmFill(); // Fix #1: phantom fill = tokens already on-chain (order was filled before cancel)
              entryRegime = regimeInfo?.regime ?? 'moderate';
              recordTradeForMarket(fd.marketSlug);
              captureEntrySnapshot({
                side: fd.side, tokenPrice: fd.price, btcPrice: lastPrice,
                priceToBeat: priceToBeat.value, marketSlug: fd.marketSlug,
                cost: fd.price * fd.size, size: fd.size,
                confidence: 'LIMIT_PHANTOM', phase: rec?.phase, reason: `phantom_fill_${cancelReason}`,
                timeLeftMin, session: getSessionName(),
              });
              if (updateConditionalApproval && !BOT_CONFIG.dryRun) {
                updateConditionalApproval(fd.tokenId).catch(e => log.debug(`Phantom fill approval: ${e.message}`));
              }
              notify('warn',
                `🔴 PHANTOM FILL DETECTED\n` +
                `Side: ${fd.side} | ${fd.size} shares @ ${(fd.price * 100).toFixed(1)}¢\n` +
                `Cost: $${(fd.price * fd.size).toFixed(2)} | Bankroll: $${getBankroll().toFixed(2)}\n` +
                `Cancel failed — order was filled on-book\n` +
                `Position auto-recorded → holding to settlement\n` +
                `<a href="https://polymarket.com/event/${fd.marketSlug}">View Market</a>`,
                { key: 'trade:limit:phantom' }).catch(e => log.debug(`Notify limit phantom: ${e.message}`));
            }
            limitOrderBlocksFOK = false;
          }
          // HOLD — keep waiting
        } catch (err) {
          log.error(`Limit order monitor failed (bot kept alive): ${err.message}`);
        }
        } // end !smartRouteFOK guard
      }
    }

    // ── 10. Trade execution ──
    // H8: settlementPending only blocks trade entry (steps 10a/10b), not signal computation or broadcast.
    // Previously returned early here, which skipped status log + dashboard broadcast for up to 83s.
    if (settlementPending) {
      log.debug('Settlement in progress — skipping trade entry this poll (signal/broadcast still active)');
    }
    if (profitTargetPaused) {
      log.debug('Profit target reached — skipping trade entry this poll (position management still active)');
    }
    let alreadyHasPosition = hasOpenPosition(marketSlug);
    const hasPending = hasPendingOrder();

    const notifyTradeFn = process.env.TELEGRAM_NOTIFY_TRADES === 'true'
      ? (msg) => notify('info', msg, { key: 'trade:entry' })
      : null;

    // Signal staleness check — if too much time passed between signal computation and now,
    // the signal is stale (market may have moved). Skip the trade.
    const SIGNAL_STALE_MS = 2000; // 2 seconds
    const signalAge = sig.computedAt ? Date.now() - sig.computedAt : 0;
    const signalStale = signalAge > SIGNAL_STALE_MS;
    if (signalStale) {
      log.warn(`Signal stale: computed ${signalAge}ms ago (threshold: ${SIGNAL_STALE_MS}ms) — skipping trade execution this poll`);
    }

    // C5 FIX: Guard against trading too close to or after market expiry.
    // timeLeftMin can be null if timing data unavailable — treat as unsafe.
    const MIN_TIME_LEFT_FOR_ENTRY = 0.5; // 30 seconds minimum
    const tooCloseToExpiry = timeLeftMin == null || timeLeftMin < MIN_TIME_LEFT_FOR_ENTRY;
    if (tooCloseToExpiry && !signalStale) {
      log.debug(`Trade entry blocked: timeLeftMin=${timeLeftMin ?? 'null'} < ${MIN_TIME_LEFT_FOR_ENTRY}min — too close to expiry`);
    }

    // ── 10pre. Pre-market LONG strategy (priority over normal signals) ──
    // Bypasses ML, edge, signal stability gates — pure time-window momentum play.
    let preMarketEnteredThisPoll = false;
    // Check if we're inside pre-market window and already traded — blocks regular entries after pre-market TP
    const preMarketEnabled = process.env.PREMARKET_LONG_ENABLED === 'true';
    const pmStatus = preMarketEnabled ? getPreMarketStatus(BOT_CONFIG.preMarketLong) : null;
    const preMarketWindowActive = pmStatus?.inWindow && pmStatus?.tradedToday;
    if (preMarketEnabled && !profitTargetPaused && !alreadyHasPosition && !hasPending && !settlementPending && !signalStale) {
      const pmCheck = checkPreMarketEntry({
        hasPosition: alreadyHasPosition,
        bankroll,
        settlementPending,
        marketUpPrice: marketUp,
        config: BOT_CONFIG.preMarketLong,
      });

      if (pmCheck.shouldEnter && poly.tokens?.upTokenId && marketUp > 0.01 && marketUp < 0.99) {
        const pmSizing = getPreMarketSizing(bankroll, marketUp, BOT_CONFIG.preMarketLong);
        if (pmSizing.valid) {
          const pmTokenId = poly.tokens.upTokenId;
          const pmShares = pmSizing.shares;
          const pmPrice = marketUp;
          const pmOrderCost = Math.round(pmShares * pmPrice * 100) / 100;

          // Polymarket minimum order $1.00
          if (pmOrderCost >= 1.00) {
            log.info(
              `PRE-MARKET LONG: GTD BUY UP ~${pmShares} shares @ ~$${pmPrice.toFixed(3)} ($${pmOrderCost.toFixed(2)}) | ` +
              `Risk: ${(BOT_CONFIG.preMarketLong.riskPct * 100).toFixed(0)}% of $${bankroll.toFixed(2)} | ` +
              `Strategy: BEST ENTRY (limit @ bestBid) → HOLD to settlement`
            );

            if (BOT_CONFIG.dryRun) {
              recordTrade({ side: 'UP', tokenId: pmTokenId, conditionId: currentConditionId, price: pmPrice, size: pmShares, marketSlug });
              confirmFill();
              captureEntrySnapshot({ side: 'UP', tokenPrice: pmPrice, btcPrice: lastPrice, priceToBeat: priceToBeat.value, marketSlug, cost: pmOrderCost, size: pmShares, confidence: 'PREMARKET', phase: rec?.phase, reason: 'premarket_long', timeLeftMin, session: getSessionName() });
              entryRegime = regimeInfo?.regime ?? null;
              onPreMarketEntry(pmPrice, marketSlug);
              preMarketEnteredThisPoll = true;
              notify('info', `PRE-MARKET LONG (dry): UP ${pmShares}@$${pmPrice.toFixed(3)} ($${pmOrderCost.toFixed(2)}) | $${getBankroll().toFixed(2)}\n<a href="https://polymarket.com/event/${marketSlug}">View Market</a>`);
            } else {
              try {
                setPendingCost(pmOrderCost);

                // Best entry: use orderbook bestBid for cheapest passive fill
                const bestBid = orderbookUp?.bestBid ?? null;
                // Entry price priority: bestBid (cheapest) → 2% discount from market → market
                const limitPrice = bestBid != null && bestBid > 0.01 && bestBid < pmPrice
                  ? Math.round(bestBid * 1000) / 1000
                  : Math.round(Math.max(0.01, pmPrice - 0.02) * 1000) / 1000;

                // GTD expiration: remaining time until pre-market window end
                // Use Intl to get current ET time reliably, then compute remaining seconds
                const _etParts = new Intl.DateTimeFormat('en-US', {
                  timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hour12: false,
                }).formatToParts(new Date());
                const _etH = parseInt(_etParts.find(p => p.type === 'hour').value, 10);
                const _etM = parseInt(_etParts.find(p => p.type === 'minute').value, 10);
                const _windowEndMin = BOT_CONFIG.preMarketLong.windowEndH * 60 + BOT_CONFIG.preMarketLong.windowEndM;
                const _remainingSec = Math.max(60, (_windowEndMin - (_etH * 60 + _etM)) * 60);
                const pmExpirySec = Math.floor(Date.now() / 1000) + _remainingSec;

                // Recalculate shares at the limit price (lower price = more shares for same cost)
                const pmLimitShares = Math.floor(pmOrderCost / limitPrice);
                const pmLimitCost = Math.round(pmLimitShares * limitPrice * 100) / 100;

                log.info(`PRE-MARKET GTD: bestBid=${bestBid?.toFixed(3) ?? 'N/A'} market=${pmPrice.toFixed(3)} → limit=${limitPrice.toFixed(3)} | ${pmLimitShares} shares ($${pmLimitCost.toFixed(2)}) | exp=${new Date(pmExpirySec * 1000).toISOString()} (${Math.round(_remainingSec / 60)}min)`);

                const pmResult = await placeLimitBuyOrder({ tokenId: pmTokenId, price: limitPrice, size: pmLimitShares, expiration: pmExpirySec });
                const pmOrderId = pmResult?.orderId ?? null;

                setPendingCost(0);
                if (pmOrderId) trackOrderPlacement(pmOrderId, { tokenId: pmTokenId, price: limitPrice, size: pmLimitShares, side: 'UP', confirmed: false, gtd: true });
                recordTrade({ side: 'UP', tokenId: pmTokenId, conditionId: currentConditionId, price: limitPrice, size: pmLimitShares, marketSlug, orderId: pmOrderId });
                entryRegime = regimeInfo?.regime ?? null;
                captureEntrySnapshot({ side: 'UP', tokenPrice: limitPrice, btcPrice: lastPrice, priceToBeat: priceToBeat.value, marketSlug, cost: pmLimitCost, size: pmLimitShares, confidence: 'PREMARKET', phase: rec?.phase, reason: 'premarket_long_gtd', timeLeftMin, session: getSessionName() });
                onPreMarketEntry(limitPrice, marketSlug);
                preMarketEnteredThisPoll = true;
                // ERC-1155 approval for subsequent sells
                updateConditionalApproval(pmTokenId).catch(e => log.debug(`PreMarket approval: ${e.message}`));
                notify('info', `PRE-MARKET GTD: UP ${pmLimitShares}@${(limitPrice * 100).toFixed(1)}c ($${pmLimitCost.toFixed(2)}) | bestBid=${bestBid?.toFixed(3) ?? 'N/A'} | HOLD→settlement | $${getBankroll().toFixed(2)}\n<a href="https://polymarket.com/event/${marketSlug}">View Market</a>`);
              } catch (err) {
                setPendingCost(0);
                log.error(`Pre-market LONG GTD order FAILED: ${err.message}`);
              }
            }
          }
        }
      } else if (pmCheck.shouldEnter === false && pollCounter % 200 === 0 && BOT_CONFIG.preMarketLong.enabled) {
        // Periodic log (every ~200 polls) for pre-market status
        const pmStatus = getPreMarketStatus(BOT_CONFIG.preMarketLong);
        if (pmStatus.isWeekday) {
          log.debug(`PreMarket: ${pmCheck.reason} | ${pmStatus.etTime} | traded=${pmStatus.tradedToday}`);
        }
      }
    }

    // 10a. Arbitrage execution (priority over directional)
    if (!preMarketEnteredThisPoll && !preMarketWindowActive && !profitTargetPaused && !settlementPending && !signalStale && !tooCloseToExpiry && arb.found && arb.spreadHealthy && !alreadyHasPosition && !hasPending &&
        poly.tokens?.upTokenId && poly.tokens?.downTokenId) {
      // try/catch required: unhandled throw from executeArbitrage crashes the entire bot process
      try {
        await executeArbitrage({
          arb, poly, marketSlug, currentConditionId, regimeInfo, rec, priceToBeat, lastPrice,
          orderbookUp, orderbookDown,
          dryRun: BOT_CONFIG.dryRun,
        }, {
          getAvailableBankroll, setPendingCost, placeBuyOrder,
          // M11 FIX: Pass placeSellOrder so one-legged ARB can unwind leg 1.
          // Without this, deps.placeSellOrder?.() always returns undefined and
          // unwindSucceeded stays false → one-legged ARB silently falls back to directional.
          placeSellOrder: ({ tokenId, price, size }) => closePosition(tokenId, size, price),
          recordArbTrade, recordTradeForMarket, recordTrade, trackOrderPlacement,
          captureEntrySnapshot,
          recordTradeTimestamp: () => { recordTradeTimestamp(() => setTradeTimestamps(exportTradeTimestamps())); },
          setEntryRegime: (r) => { entryRegime = r; },
          // RC3 Fix (ARB): ERC-1155 approval after BUY legs for subsequent SELL
          updateConditionalApproval: BOT_CONFIG.dryRun ? null : updateConditionalApproval,
        });
      } catch (arbErr) {
        log.error(`executeArbitrage failed (bot kept alive): ${arbErr.stack || arbErr.message}`);
      }
    }
    // 10b. Directional trade
    // Bug 2 fix: !smartSellTriggered — prevent immediate rebuy after smart sell in same poll.
    // After smart sell, position is cleared but signal may still say ENTER → circular buy-sell loop.
    else if (!preMarketEnteredThisPoll && !preMarketWindowActive && !profitTargetPaused && !settlementPending && !signalStale && !tooCloseToExpiry && rec.action === 'ENTER' && !hasPending && !smartSellTriggered && !alreadyHasPosition && (!limitOrderBlocksFOK || smartRouteFOK)) {
      // try/catch required: unhandled throw from executeDirectionalTrade crashes the entire bot process
      try {
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
          smartFlowSignal,
          mcResult,
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
          recordTradeTimestamp: () => { recordTradeTimestamp(() => setTradeTimestamps(exportTradeTimestamps())); },
          setEntryRegime: (r) => { entryRegime = r; },
          notifyTrade: notifyTradeFn,
          // RC3 Fix: ERC-1155 approval immediately after BUY fill
          updateConditionalApproval: BOT_CONFIG.dryRun ? null : updateConditionalApproval,
          // MetEngine smart money gate (Feature 1+2) — null if disabled
          querySmartMoney: BOT_CONFIG.metEngine?.enabled ? querySmartMoney : null,
        });
      } catch (tradeErr) {
        log.error(`executeDirectionalTrade failed (bot kept alive): ${tradeErr.stack || tradeErr.message}`);
      }
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
    const sfTag = smartFlowSignal.sampleCount >= 3 ? `SF:${smartFlowSignal.direction}(${smartFlowSignal.strength})` : '';
    const mcTag = mcResult ? `MC:${(mcResult.pUp * 100).toFixed(0)}%` : '';
    const clSrc = chainlinkResolved.source === 'polymarket_ws' ? 'PolyWS'
      : chainlinkResolved.source === 'chainlink_wss' ? 'CLWSS' : 'RPC';
    const srcTag = `${isBinanceConnected() ? 'WS' : 'REST'}+${useClobWs ? 'WS' : 'REST'}+CL:${clSrc}`;

    const _pollMs = (performance.now() - _pollStart).toFixed(0);
    const stabTag = `Stab:${getConfirmCount()}/${SIGNAL_CONFIRM_POLLS}${recentFlipCount > 0 ? ` F${recentFlipCount}` : ''}`;
    const recTag = rec.action === 'WAIT' && rec.reason
      ? `${rec.action} [${rec.confidence}] ${rec.phase} (${rec.reason})`
      : `${rec.action}${rec.side ? ' ' + rec.side : ''} [${rec.confidence}] ${rec.phase}`;
    log.info(
      `#${pollCounter} [${_pollMs}ms] | BTC $${lastPrice.toFixed(0)} | PTB $${(priceToBeat.value ?? 0).toFixed(0)} | ` +
      `P:${(ensembleUp * 100).toFixed(0)}% E:${edgeTag} ${mlTag} | ` +
      `${recTag} | ` +
      `T:${timeLeftMin?.toFixed(1) ?? '?'}m | $${bankroll.toFixed(0)} | ` +
      `${regimeInfo.regime} | ${stabTag} ${arbTag} ${fillTag} ${flowTag} ${sfTag} ${mcTag} | ${srcTag}`
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
      smartFlow: smartFlowSignal,
      entryTiming: entryTimingScore,
      monteCarlo: mcResult ? {
        pUp: mcResult.pUp, pDown: mcResult.pDown,
        mcConfidence: mcResult.mcConfidence,
        tailRisk: mcResult.tailRisk,
        priceEfficiency: mcResult.priceEfficiency,
        sigma: mcResult.totalSigma,
      } : null,
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

      // Journal time-series analytics (cached, recomputes on new trade)
      journalAnalytics: getJournalAnalytics(getStats().totalTrades),

      // AI Agent status
      aiAnalysis: getLastAnalysis(),
      aiOptimizer: getOptimizerStatus(),
      aiStats: getOpenRouterStats(),
      sentiment: getSentimentStats(),
      executionTiming: getExecutionTimingStatus(),

      // Volume features
      volumeRecent, volumeAvg,
      volumeRatio: volumeAvg > 0 ? volumeRecent / volumeAvg : 1,
      vwapCrossCount, failedVwapReclaim,

      // Pre-market LONG strategy
      preMarketLong: BOT_CONFIG.preMarketLong.enabled ? getPreMarketStatus(BOT_CONFIG.preMarketLong) : { enabled: false },

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

      // MetEngine smart money gate status (for BotPanel display)
      metEngine: getMetEngineStats(),

      // Recovery buy status
      recoveryBuy: getRecoveryStatus(),

      // Limit order status
      limitOrder: BOT_CONFIG.limitOrder.enabled ? getLimitOrderStatus() : { enabled: false },

      // Daily profit target (WIB timezone)
      profitTarget: getProfitTargetStatus(),
      profitTargetPaused,
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
