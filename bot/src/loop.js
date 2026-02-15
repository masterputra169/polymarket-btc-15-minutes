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
  settlePrediction,
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
import { placeBuyOrder, isClientReady, getUsdcBalance } from './trading/clobClient.js';
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
  saveState as savePositionState,
} from './trading/positionTracker.js';
import { closePosition } from './trading/positionManager.js';
import { evaluateCutLoss, resetCutLossState, recordSellAttempt, getCutLossStatus } from './trading/cutLoss.js';
import { captureEntrySnapshot, writeJournalEntry, clearEntrySnapshot, getRecentJournal } from './trading/tradeJournal.js';

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

/**
 * Safely parse a CLOB amount field (makingAmount / takingAmount).
 * Returns null if the value is missing, NaN, negative, or unreasonably large.
 * Prevents phantom bankroll adjustments from malformed API responses.
 */
function parseClobAmount(value, fallback = null) {
  if (value == null) return fallback;
  const n = typeof value === 'number' ? value : parseFloat(value);
  if (!Number.isFinite(n) || n < 0 || n > 1_000_000) return fallback;
  return n;
}

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
let currentConditionId = null;
let priceToBeat = { slug: null, value: null, updatedAt: 0 };

// ── Market transition grace period ──
// After market slug changes, WS needs ~2-5s to reconnect with new token IDs.
// During this window, token prices are from the OLD market but PTB is from the NEW market.
// Skip all prediction/trading during this grace period to prevent cross-market signals.
let marketTransitionMs = 0;
const MARKET_TRANSITION_GRACE_MS = 5_000;

// ── Tilt protection (post-cut-loss cooldown) ──
// After a cut-loss, raise ML confidence threshold for the next N markets.
// Prevents re-entering similar low-confidence trades immediately after a loss.
let tiltMarketsLeft = 0;
const TILT_ML_CONF_MIN = 0.60; // raised threshold during tilt (vs normal 0.50)
const TILT_MARKETS = 2;        // number of markets to stay cautious

// ── Entry regime tracking ──
// Stored at entry time, passed to cut-loss for regime-change detection.
let entryRegime = null;

let pollCounter = 0;
let polling = false;
let tokenIdsNotified = false;

// ── Double-settlement guard ──
// Persisted via positionTracker (getLastSettled/setLastSettled) to survive bot restarts.
// Prevents same market from being settled twice.

// Market price ring buffer (for momentum calculation)
const marketUpHistory = { buf: new Float64Array(24), idx: 0, count: 0 };

// ═══ Anti-Whipsaw: Signal Stability Engine ═══
// Only 2 mechanisms (EMA smoothing REMOVED — it adds harmful lag):
//   1. Signal confirmation: ENTER must persist N consecutive polls
//   2. Flip detector: block if market is flipping too rapidly (indecisive)
const SIGNAL_CONFIRM_POLLS = 3;      // Must see same ENTER side N polls in a row (3 × 500ms = 1.5s)
const FLIP_WINDOW_MS = 15_000;       // Track flips in last 15 seconds
const MAX_FLIPS_TO_ENTER = 3;        // Block entry if signal flipped > 3 times in window (relaxed from 1 — volatile markets naturally oscillate)

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

// Real USDC balance from Polymarket (every 30s — on-chain sync)
let usdcBalanceData = null;
let usdcBalanceLastFetchMs = 0;
const USDC_BALANCE_INTERVAL = 30_000;

function resetMarketCache() {
  polySnapshotCache = null;
  polyLastFetchMs = 0;
  currentMarketEndMs = null;
  currentConditionId = null;
  priceToBeat = { slug: null, value: null, updatedAt: 0 };
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
 * Settle a position using Polymarket oracle resolution (CLOB /markets/{conditionId}).
 * Polls up to 6 times (30s total) for oracle to resolve, then falls back to BTC price comparison.
 *
 * @param {Object} pos - Current position from positionTracker
 * @param {string|null} conditionId - Polymarket condition ID for oracle query
 * @param {number|null} fallbackBtcPrice - BTC price for legacy fallback
 * @param {number|null} ptbValue - Price-to-beat for legacy fallback
 * @returns {{ won: boolean, outcome: string|null, source: string }}
 */
async function settleViaOracle(pos, conditionId, fallbackBtcPrice, ptbValue) {
  // 1. Try oracle first (poll up to 30s with retries)
  if (conditionId) {
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const url = `${CONFIG.clobBaseUrl}/markets/${conditionId}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
        if (res.ok) {
          const market = await res.json();
          if (market.closed) {
            const tokens = Array.isArray(market.tokens) ? market.tokens : [];
            const winner = tokens.find(t => t.winner === true);
            if (winner) {
              const outcome = winner.outcome.toUpperCase();
              const won = pos.side === outcome;
              return { won, outcome, source: 'oracle' };
            }
          }
        }
      } catch { /* retry */ }
      if (attempt < 5) await new Promise(r => setTimeout(r, 5000));
    }
    log.warn('Oracle settlement timed out after 30s — falling back to BTC price comparison');
  }

  // 2. Fallback: BTC price comparison (legacy behavior)
  if (fallbackBtcPrice != null && ptbValue != null) {
    const outcome = fallbackBtcPrice >= ptbValue ? 'UP' : 'DOWN';
    return { won: pos.side === outcome, outcome, source: 'price_fallback' };
  }

  // 3. Last resort: unknown — settle as loss
  return { won: false, outcome: null, source: 'unknown' };
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
      broadcast({ halted: true, haltReason: haltCheck.reason, ts: Date.now(), bankroll: getBankroll(), stats: getStats() });
      return;
    }

    // ── 1b. Check pending order fills (non-blocking) ──
    // M3: checkPendingFill now returns array of results for all pending orders
    const fillResults = await checkPendingFill();
    if (fillResults) {
      for (const fillResult of fillResults) {
        if (fillResult.filled) {
          // C4: Mark position as fill-confirmed on-chain
          confirmFill();
          log.info(`Fill confirmed (${(fillResult.timeToFill / 1000).toFixed(1)}s)${fillResult.adverseSelection ? ' [ADVERSE]' : ''}`);
        } else if (fillResult.cancelled) {
          log.warn('Stale order cancelled — fill timeout exceeded');
          // Unwind the pre-recorded position (bankroll was already deducted)
          const pos = getCurrentPosition();
          if (pos) {
            unwindPosition();
            writeJournalEntry({ outcome: 'UNWIND', pnl: 0, exitData: {} });
            clearEntrySnapshot();
            log.info('Position unwound after stale order cancel');
          }
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
      // Double-settlement guard: skip if this market was already settled recently
      const _ls1 = getLastSettled();
      if (pos && pos.marketSlug === currentMarketSlug && pos.marketSlug === _ls1.slug && (now - _ls1.ts) < 30_000) {
        log.warn(`Double settlement prevented for ${pos.marketSlug} (settled ${((now - _ls1.ts) / 1000).toFixed(0)}s ago)`);
        // Force-clear the stale position to prevent infinite retries
        if (!pos.settled) {
          unwindPosition();
        }
      } else if (pos && pos.marketSlug === currentMarketSlug) {
        // Prefer oracle prices (Chainlink/Polymarket) over Binance for settlement accuracy
        const oraclePrice = getPolyLivePrice() || getChainlinkWssPrice();
        const wsPrice = getBinancePrice();
        const currentBtcPrice = oraclePrice || wsPrice || pos.price;
        const priceSource = oraclePrice ? 'oracle' : wsPrice ? 'binance' : 'entry';
        const ptbValue = priceToBeat.value;
        // C5: PTB freshness check — only trust PTB if it belongs to current market
        const ptbFresh = ptbValue != null && priceToBeat.slug === currentMarketSlug;
        if (pos.side === 'ARB') {
          // Arb always wins — riskless guaranteed $1 per share pair
          const arbPnl = pos.size - pos.cost;
          log.info(`ARB position settled — guaranteed WIN | P&L: +$${arbPnl.toFixed(2)}`);
          settleTrade(true);
          writeJournalEntry({
            outcome: 'WIN', pnl: arbPnl,
            exitData: { btcPrice: currentBtcPrice, priceToBeat: ptbValue },
          });
        } else {
          // Oracle-based settlement: query CLOB for definitive resolution
          const oracleConditionId = pos.conditionId ?? currentConditionId;
          const { won, outcome, source } = await settleViaOracle(pos, oracleConditionId, currentBtcPrice, ptbFresh ? ptbValue : null);
          if (source === 'price_fallback') {
            const pctFromPtb = ptbValue != null && currentBtcPrice != null
              ? Math.abs(currentBtcPrice - ptbValue) / ptbValue : null;
            if (pctFromPtb != null && pctFromPtb < 0.001) {
              log.warn(`Settlement UNCERTAIN: BTC $${currentBtcPrice.toFixed(2)} within 0.1% of PTB $${ptbValue.toFixed(2)} (${priceSource})`);
            }
          }
          log.info(`Position expired — ${outcome ?? '?'} → ${won ? 'WIN' : 'LOSS'} (${source})`);
          settleTrade(won);
          writeJournalEntry({
            outcome: won ? 'WIN' : 'LOSS',
            pnl: won ? (pos.size - pos.cost) : -pos.cost,
            exitData: { outcome, source, btcPrice: currentBtcPrice, priceToBeat: ptbValue, priceSource },
          });
          if (!won) recordLoss();
          // Settle feedback predictions using oracle result (not Binance price)
          if (outcome) settlePrediction(pos.marketSlug, outcome);
        }
        // Record for double-settlement guard (persisted to state.json)
        setLastSettled(pos.marketSlug, Date.now());
      }
      resetCutLossState();
      resetMarketTradeCount(currentMarketSlug);
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

    const polyFetched = fetchMap.poly !== undefined ? results[fetchMap.poly] : null;
    if (polyFetched) {
      if (polyFetched.ok) {
        // Only cache successful results — don't overwrite good cache with errors
        polySnapshotCache = polyFetched;
        polyLastFetchMs = now;
        if (polyFetched.market?.endDate) {
          const endMs = new Date(polyFetched.market.endDate).getTime();
          if (Number.isFinite(endMs)) currentMarketEndMs = endMs;
        }
        // Store conditionId for oracle settlement
        if (polyFetched.market?.condition_id) {
          currentConditionId = polyFetched.market.condition_id;
        }
      } else {
        // Error — allow retry on next poll (don't set polyLastFetchMs)
        log.debug(`Polymarket fetch failed: ${polyFetched.reason} — will retry next poll`);
      }
    }
    const poly = polyFetched?.ok ? polyFetched : polySnapshotCache;

    // Funding rate — always null (blocked)
    const fundingRate = null;

    // ── 3b. USDC balance (every 30s — non-blocking) ──
    if (now - usdcBalanceLastFetchMs > USDC_BALANCE_INTERVAL && isClientReady()) {
      usdcBalanceLastFetchMs = now; // Set BEFORE fetch to prevent parallel fetches
      const snapshotBankroll = getBankroll(); // Capture BEFORE async fetch
      getUsdcBalance().then(result => {
        if (result) {
          const prev = usdcBalanceData;
          usdcBalanceData = result;
          const localBankroll = getBankroll();
          const onChain = result.balance;
          const drift = Math.abs(localBankroll - onChain);
          if (!prev) {
            log.info(`USDC balance: on-chain=$${onChain.toFixed(2)} | local=$${localBankroll.toFixed(2)} | drift=$${drift.toFixed(2)}`);
          }
          // Race guard: if bankroll changed between fetch start and callback,
          // a trade was recorded during the async gap — skip sync this cycle
          if (Math.abs(localBankroll - snapshotBankroll) > 0.01) {
            log.debug(`USDC sync skipped: bankroll changed during fetch ($${snapshotBankroll.toFixed(2)} -> $${localBankroll.toFixed(2)})`);
            return;
          }
          // Auto-sync: always match on-chain balance when idle (no position, no pending)
          const pos = getCurrentPosition();
          const hasPos = pos && !pos.settled;
          const hasPendingCost = getPendingCost() > 0;
          // Sanity check: reject obviously invalid API responses
          if (onChain < 0 || onChain > 100_000) {
            log.warn(`SYNC REJECTED: on-chain=$${onChain.toFixed(2)} looks invalid (out of range)`);
          } else if (drift > 0.01 && !hasPos && !hasPendingCost) {
            log.info(`AUTO-SYNC: local=$${localBankroll.toFixed(2)} -> on-chain=$${onChain.toFixed(2)} (drift $${drift.toFixed(2)})`);
            setBankroll(onChain);
          } else if (drift > 1.0 && (hasPos || hasPendingCost)) {
            log.warn(`DRIFT: local=$${localBankroll.toFixed(2)} vs on-chain=$${onChain.toFixed(2)} (drift $${drift.toFixed(2)}, ${hasPos ? 'position open' : 'pending cost'} — deferring sync)`);
          }
        }
      }).catch(err => { log.debug(`USDC balance error: ${err.message}`); });
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
      marketTransitionMs = now; // Start grace period — WS needs time to reconnect

      const pos = getCurrentPosition();
      // Double-settlement guard: skip if this market was already settled recently
      const _ls2 = getLastSettled();
      if (pos && pos.marketSlug === oldSlug && pos.marketSlug === _ls2.slug && (now - _ls2.ts) < 30_000) {
        log.warn(`Double settlement prevented on switch for ${pos.marketSlug} (settled ${((now - _ls2.ts) / 1000).toFixed(0)}s ago)`);
        if (!pos.settled) {
          unwindPosition();
        }
      } else if (pos && pos.marketSlug === oldSlug) {
        // Prefer oracle prices (Chainlink/Polymarket) over Binance for settlement accuracy
        const oraclePrice = getPolyLivePrice() || getChainlinkWssPrice();
        const wsPrice = getBinancePrice();
        const currentBtcPrice = oraclePrice || wsPrice || pos.price;
        const priceSource = oraclePrice ? 'oracle' : wsPrice ? 'binance' : 'entry';
        const ptbValue = priceToBeat.value;
        // C5: PTB freshness check — only trust PTB if it belongs to the old market
        const ptbFresh = ptbValue != null && priceToBeat.slug === oldSlug;
        if (pos.side === 'ARB') {
          // Arb always wins — riskless guaranteed $1 per share pair
          const arbPnl = pos.size - pos.cost;
          log.info(`ARB position settled on switch — guaranteed WIN | P&L: +$${arbPnl.toFixed(2)}`);
          settleTrade(true);
          writeJournalEntry({
            outcome: 'WIN', pnl: arbPnl,
            exitData: { btcPrice: currentBtcPrice, priceToBeat: ptbValue },
          });
        } else {
          // Oracle-based settlement: query CLOB for definitive resolution
          const oracleConditionId = pos.conditionId ?? currentConditionId;
          const { won, outcome, source } = await settleViaOracle(pos, oracleConditionId, currentBtcPrice, ptbFresh ? ptbValue : null);
          if (source === 'price_fallback') {
            const pctFromPtb = ptbValue != null && currentBtcPrice != null
              ? Math.abs(currentBtcPrice - ptbValue) / ptbValue : null;
            if (pctFromPtb != null && pctFromPtb < 0.001) {
              log.warn(`Settlement UNCERTAIN: BTC $${currentBtcPrice.toFixed(2)} within 0.1% of PTB $${ptbValue.toFixed(2)} (${priceSource})`);
            }
          }
          log.info(`Position settled on switch — ${outcome ?? '?'} → ${won ? 'WIN' : 'LOSS'} (${source})`);
          settleTrade(won);
          writeJournalEntry({
            outcome: won ? 'WIN' : 'LOSS',
            pnl: won ? (pos.size - pos.cost) : -pos.cost,
            exitData: { outcome, source, btcPrice: currentBtcPrice, priceToBeat: ptbValue, priceSource },
          });
          if (!won) recordLoss();
          // Settle feedback predictions using oracle result (not Binance price)
          if (outcome) settlePrediction(pos.marketSlug, outcome);
        }
        // Record for double-settlement guard (persisted to state.json)
        setLastSettled(pos.marketSlug, Date.now());
      }

      resetMarketCache();
      resetCutLossState();
      resetFlow();
      resetMarketTradeCount(oldSlug);
      onMarketSwitch(oldSlug, marketSlug);

      // Tilt protection: decrement counter on market switch
      if (tiltMarketsLeft > 0) {
        tiltMarketsLeft--;
        log.info(`Tilt protection: ${tiltMarketsLeft} markets remaining (ML conf >= ${TILT_ML_CONF_MIN * 100}%)`);
      }

      // Reset entry regime for next trade
      entryRegime = null;
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
      priceToBeat = { slug: marketSlug, value: ptb, updatedAt: ptb !== null ? now : 0 };
    } else if (ptb !== null) {
      priceToBeat.value = ptb;
      priceToBeat.updatedAt = now;
    }

    // ── Market prices: WS (instant) → REST (fallback) ──
    const clobConnected = isClobConnected();
    const clobLastUpdate = getClobLastUpdate();
    const clobStale = clobLastUpdate ? (now - clobLastUpdate > 15_000) : true; // Aligned: halfway between loop check and clobWs DATA_STALE_MS (20s)
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

    // Settlement timing (computed BEFORE scoring so minutesLeft is available)
    const settlementMs = poly.market?.endDate ? new Date(poly.market.endDate).getTime() : null;
    const settlementLeftMin = settlementMs ? (settlementMs - Date.now()) / 60_000 : null;
    const timeLeftMin = settlementLeftMin ?? timing.remainingMinutes;

    // ── 5d. Market transition guard ──
    // After slug change, WS needs ~2-5s to reconnect with new token IDs.
    // During this window, token prices are from OLD market but PTB is from NEW market.
    // Skip prediction/trading to prevent cross-market signals (e.g. UP@90c vs new PTB).
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

    // ── 6. Score direction ──
    const scored = scoreDirection({
      price: lastPrice, priceToBeat: priceToBeat.value,
      vwap: vwapNow, vwapSlope, rsi: rsiNow, rsiSlope,
      macd, heikenColor: consec.color, heikenCount: consec.count,
      failedVwapReclaim, delta1m, delta3m, regime: regimeInfo,
      orderbookSignal, volProfile, multiTfConfirm, feedbackStats,
      bb, atr,
      minutesLeft: timeLeftMin,
    });

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

    // ── Log real Polymarket data for ML training (every 5s, zero alloc when throttled) ──
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

    // ── 9c. Cut-loss check (skip ARB — guaranteed profit, never cut) ──
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

      // Log cut-loss gate status every 5th poll (debug visibility)
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
          `CutLoss v3: ${cutResult.reason} | ${pos.side} drop=${dropPct}% | ` +
          `BTC ${btcSide} dist=${btcDist}% | d1m=$${(delta1m ?? 0).toFixed(1)} | ` +
          `ATR=${(atr?.atrRatio ?? 0).toFixed(2)} | ${regimeInfo?.regime ?? '?'}${entryRegime && entryRegime !== regimeInfo?.regime ? `(was ${entryRegime})` : ''} | ` +
          `EV(hold)=${((pos.side === 'UP' ? ensembleUp : ensembleDown) * 100).toFixed(0)}% vs token=${(tokenPrice * 100).toFixed(0)}¢`
        );
      }

      if (cutResult.shouldCut) {
        // Sell lock: prevent dashboard sell and loop cut-loss from racing
        if (!acquireSellLock()) {
          log.info('Cut-loss skipped — sell already in progress (dashboard?)');
        } else {
        // v3: Always full cut (binary options are all-or-nothing)
        const sellSize = pos.size;

        log.warn(
          `CUT-LOSS v3: ${pos.side} drop ${cutResult.dropPct.toFixed(1)}% | ` +
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
          settleTradeEarlyExit(recovery);
          writeJournalEntry({ outcome: 'CUT_LOSS', pnl: recovery - pos.cost, exitData: { ...exitData, cutLossRecovered: recovery } });
          resetCutLossState();
          recordLoss();
          // Activate tilt protection (+1 because counter decrements on current market's switch too)
          tiltMarketsLeft = TILT_MARKETS + 1;
          log.info(`Tilt protection activated: ML conf >= ${TILT_ML_CONF_MIN * 100}% for next ${TILT_MARKETS} markets`);
        } else {
          recordSellAttempt();
          try {
            const sellResult = await closePosition(pos.tokenId, sellSize, cutResult.sellPrice);
            const actualRecovery = parseClobAmount(sellResult?.takingAmount, cutResult.sellPrice * sellSize);
            settleTradeEarlyExit(actualRecovery);
            writeJournalEntry({ outcome: 'CUT_LOSS', pnl: actualRecovery - pos.cost, exitData: { ...exitData, cutLossRecovered: actualRecovery } });
            resetCutLossState();
            recordLoss();
            // Activate tilt protection (+1 because counter decrements on current market's switch too)
            tiltMarketsLeft = TILT_MARKETS + 1;
            log.info(`Tilt protection activated: ML conf >= ${TILT_ML_CONF_MIN * 100}% for next ${TILT_MARKETS} markets`);
          } catch (err) {
            log.warn(`Cut-loss sell FAILED: ${err.message}`);
          }
        }
        releaseSellLock();
        } // end acquireSellLock
      }
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

    // ── 12. Feedback tracking (stale cleanup only — recording moved to after trade execution) ──
    try {
      autoSettle(marketSlug, lastPrice, priceToBeat.value, timeLeftMin);
    } catch { /* feedback should never break main loop */ }

    // ── 13. Trade execution ──
    const alreadyHasPosition = hasOpenPosition(marketSlug);
    const hasPending = hasPendingOrder();

    // 13a. Arbitrage execution (priority over directional — riskless profit)
    if (arb.found && arb.spreadHealthy && !alreadyHasPosition && !hasPending &&
        poly.tokens?.upTokenId && poly.tokens?.downTokenId) {
      const arbBudget = getAvailableBankroll() * 0.10; // 10% of available bankroll (not total)
      const arbShares = Math.floor(arbBudget / arb.totalCost);
      const estCost = Math.round(arbShares * arb.totalCost * 100) / 100;
      if (arbShares > 0) {
        if (BOT_CONFIG.dryRun) {
          log.info(
            `[DRY RUN] ARB: Would BUY ${arbShares} UP@${arb.askUp.toFixed(3)} + ${arbShares} DOWN@${arb.askDown.toFixed(3)} | ` +
            `Cost: $${estCost.toFixed(2)} | Net profit: $${(arbShares * arb.netProfit).toFixed(2)} (${arb.profitPct.toFixed(1)}%)`
          );
        } else {
          // Reserve capital before arb attempt (prevents concurrent overspend)
          setPendingCost(estCost);
          try {
            // Leg 1: Buy UP
            const upResult = await placeBuyOrder({
              tokenId: poly.tokens.upTokenId,
              price: arb.askUp,
              size: arbShares,
            });
            const upFillCost = parseClobAmount(upResult?.makingAmount, arbShares * arb.askUp);
            const upOrderId = upResult?.orderId ?? null;

            // Leg 2: Buy DOWN — if this fails, we have one-legged exposure
            let arbLeg2Failed = false;
            try {
              const downResult = await placeBuyOrder({
                tokenId: poly.tokens.downTokenId,
                price: arb.askDown,
                size: arbShares,
              });
              const downFillCost = parseClobAmount(downResult?.makingAmount, arbShares * arb.askDown);
              const downOrderId = downResult?.orderId ?? null;

              // Both legs succeeded — record arb with actual fill costs
              setPendingCost(0);
              recordArbTrade({
                upCost: upFillCost,
                downCost: downFillCost,
                shares: arbShares,
                marketSlug,
                orderId: upOrderId,
              });
              recordTradeForMarket(marketSlug);
              // Track fills for both orders (monitors execution, feeds fill rate stats)
              if (upOrderId) trackOrderPlacement(upOrderId, { tokenId: poly.tokens.upTokenId, price: arb.askUp, size: arbShares, side: 'ARB_UP' });
              if (downOrderId) trackOrderPlacement(downOrderId, { tokenId: poly.tokens.downTokenId, price: arb.askDown, size: arbShares, side: 'ARB_DOWN' });
            } catch (downErr) {
              // ONE-LEGGED: Only UP bought, DOWN failed — record as directional position
              arbLeg2Failed = true;
              setPendingCost(0);
              log.error(`ARB leg 2 (DOWN) failed: ${downErr.message} — recording one-legged UP position`);
              const actualPrice = upFillCost / arbShares;
              recordTrade({
                side: 'UP',
                tokenId: poly.tokens.upTokenId,
                conditionId: currentConditionId,
                price: actualPrice,
                size: arbShares,
                marketSlug,
                orderId: upOrderId,
                actualCost: upFillCost,
              });
              recordTradeForMarket(marketSlug);
              // Track fill for the UP order (monitors execution + enables stale cancel)
              if (upOrderId) trackOrderPlacement(upOrderId, { tokenId: poly.tokens.upTokenId, price: arb.askUp, size: arbShares, side: 'UP' });
              // Capture journal entry so settlement writes a post-trade record
              captureEntrySnapshot({
                side: 'UP', tokenPrice: arb.askUp, btcPrice: lastPrice,
                priceToBeat: priceToBeat.value, marketSlug,
                cost: upFillCost, size: arbShares,
                confidence: 'ARB_ONE_LEG', phase: rec?.phase, reason: 'arb_leg2_failed',
                timeLeftMin, session: getSessionName(),
              });
            }
            if (arbLeg2Failed) {
              log.warn('One-legged arb recorded as directional UP — continuing loop');
            }
          } catch (err) {
            setPendingCost(0); // Release reservation on leg 1 failure
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
        log.info(`Signal unstable, holding: ${reasons.join(' | ')}`);
      } else {
      // Signal confirmed — proceed with existing trade filters

      // Tilt protection: after cut-loss, temporarily raise ML confidence threshold
      // (actual blocking happens in applyTradeFilters via tiltMlConfMin param)
      const effectiveMlConf = mlResult.available ? mlResult.mlConfidence : null;
      if (tiltMarketsLeft > 0 && effectiveMlConf != null && effectiveMlConf < TILT_ML_CONF_MIN) {
        log.info(`Tilt protection active: ML conf ${(effectiveMlConf * 100).toFixed(0)}% < ${TILT_ML_CONF_MIN * 100}% (${tiltMarketsLeft} markets left) — will raise threshold in filters`);
      }

      // Smart trade filters (confidence gating, 50/50 filter, volatility, cooldown, session)
      const filterResult = applyTradeFilters({
        mlConfidence: effectiveMlConf,
        mlAvailable: mlResult.available,
        marketPrice: betMarketPrice,
        atrRatio: atr?.atrRatio ?? null,
        timeLeftMin,
        marketSlug,
        consecutiveLosses: getConsecutiveLosses(),
        session: getSessionName(),
        btcPrice: lastPrice,
        priceToBeat: priceToBeat.value,
        tiltMlConfMin: tiltMarketsLeft > 0 ? TILT_ML_CONF_MIN : null,
        bestEdge: edge.bestEdge,
        delta1m,
        signalSide: rec.side,
      });

      // Orderbook flow alignment check
      const flowAlign = checkFlowAlignment(betSide);

      if (!filterResult.pass) {
        log.info(`Smart filter blocked: ${filterResult.reasons.join(' | ')}`);
      } else {
      const priceCheck = validatePrice(betMarketPrice);
      // C6: Pass availableBankroll (minus pending allocations) to guard
      const tradeCheck = validateTrade({
        rec, betSizing, timeLeftMin, bankroll,
        availableBankroll: getAvailableBankroll(),
        hasPosition: alreadyHasPosition,
      });

      if (priceCheck.valid && tradeCheck.valid) {
        const tokenId = betSide === 'UP' ? poly.tokens.upTokenId : poly.tokens.downTokenId;
        const shares = Math.floor(betSizing.betAmount / betMarketPrice);

        // Flow alignment info for logging
        const flowTag = flowAlign.signal !== 'INSUFFICIENT_DATA'
          ? ` | Flow:${flowAlign.signal}${flowAlign.agrees ? '(agree)' : '(DISAGREE)'}`
          : '';

        // C6: Reserve bankroll for this pending order
        const orderCost = shares * betMarketPrice;
        setPendingCost(orderCost);

        // Build entry snapshot data for trade journal (shared by DRY_RUN + live paths)
        const entryData = {
          side: betSide, tokenPrice: betMarketPrice, btcPrice: lastPrice,
          priceToBeat: priceToBeat.value, marketSlug, cost: orderCost, size: shares,
          confidence: rec.confidence, phase: rec.phase, reason: rec.reason,
          edgeUp: edge.edgeUp, edgeDown: edge.edgeDown, bestEdge: edge.bestEdge,
          ensembleUp, ruleUp: timeAware.adjustedUp,
          mlProbUp: mlResult.mlProbUp, mlConfidence: mlResult.mlConfidence,
          mlSide: mlResult.mlSide, mlAgreesWithRules,
          rsiNow, rsiSlope, macdHist: macd?.hist, macdLine: macd?.line,
          vwapDist, vwapSlope,
          bbPercentB: bb?.percentB, bbWidth: bb?.width, bbSqueeze: bb?.squeeze,
          atrPct: atr?.atrPct, atrRatio: atr?.atrRatio,
          stochK: stochRsi?.k, stochD: stochRsi?.d,
          emaCrossSignal: emaCross?.cross, emaDistPct: emaCross?.distancePct,
          volDeltaBuyRatio: volDelta?.buyRatio,
          haColor: consec.color, haCount: consec.count,
          delta1m, delta3m,
          regime: regimeInfo.regime, regimeConfidence: regimeInfo.confidence,
          marketUp, marketDown,
          orderbookImbalance: orderbookSignal?.imbalance, spread: orderbookUp?.spread,
          timeLeftMin, session: getSessionName(),
          betAmount: betSizing.betAmount, kellyFraction: betSizing.kellyFraction,
          riskLevel: betSizing.riskLevel, expectedValue: betSizing.expectedValue,
          signalConfirmCount, recentFlips: recentFlipCount,
        };

        if (BOT_CONFIG.dryRun) {
          setPendingCost(0); // Release reservation in dry-run
          log.info(
            `[DRY RUN] Would BUY ${betSide}: ${shares} shares @ $${betMarketPrice.toFixed(3)} = $${(shares * betMarketPrice).toFixed(2)} | ` +
            `Edge: ${((edge.bestEdge ?? 0) * 100).toFixed(1)}% (spread: -${((edge.spreadPenaltyUp + edge.spreadPenaltyDown) * 50).toFixed(1)}%) | ` +
            `Conf: ${rec.confidence}${flowTag} | ${betSizing.rationale}`
          );
          // DRY_RUN: record prediction for accuracy tracking (only actual trades, not all ENTER signals)
          try {
            recordPrediction({
              side: betSide, modelProb: betEnsembleProb,
              marketPrice: betMarketPrice, btcPrice: lastPrice,
              priceToBeat: priceToBeat.value, marketSlug,
              regime: regimeInfo.regime,
              mlConfidence: mlResult.available ? mlResult.mlConfidence : null,
            });
          } catch { /* feedback should never break main loop */ }
        } else {
          try {
            const orderResult = await placeBuyOrder({
              tokenId,
              price: betMarketPrice,
              size: shares,
            });
            const orderId = orderResult?.orderId ?? orderResult?.orderID ?? orderResult?.id ?? null;

            // Use actual fill amounts from CLOB response when available
            // makingAmount = USDC actually spent, takingAmount = shares actually received
            const fillCost = parseClobAmount(orderResult?.makingAmount, null);
            const fillShares = parseClobAmount(orderResult?.takingAmount, null);
            const actualSize = (fillShares && fillShares > 0) ? fillShares : shares;
            const actualPrice = (fillCost && actualSize > 0) ? fillCost / actualSize : betMarketPrice;
            const actualCost = (fillCost && fillCost > 0) ? fillCost : null;

            recordTrade({
              side: betSide,
              tokenId,
              conditionId: currentConditionId,
              price: actualPrice,
              size: actualSize,
              marketSlug,
              orderId,
              actualCost,
            });
            // Track regime at entry for cut-loss regime-change detection
            entryRegime = regimeInfo?.regime ?? 'moderate';
            if (orderId) {
              trackOrderPlacement(orderId, { tokenId, price: actualPrice, size: actualSize, side: betSide });
            }
            // Only count as trade if order succeeded (not on failure)
            recordTradeForMarket(marketSlug);
            // Journal: capture entry snapshot (written at settlement)
            captureEntrySnapshot(entryData);
            // Record prediction for accuracy tracking (only actual trades, not all ENTER signals)
            try {
              recordPrediction({
                side: betSide, modelProb: betEnsembleProb,
                marketPrice: betMarketPrice, btcPrice: lastPrice,
                priceToBeat: priceToBeat.value, marketSlug,
                regime: regimeInfo.regime,
                mlConfidence: mlResult.available ? mlResult.mlConfidence : null,
              });
            } catch { /* feedback should never break main loop */ }
          } catch (err) {
            setPendingCost(0); // C6: Release pending reservation on failure
            log.error(`Order failed: ${err.message}`);
          }
        }
      } else {
        log.info(`Trade blocked: ${!priceCheck.valid ? priceCheck.reason : tradeCheck.reason}`);
      }
      } // end filterResult.pass
      } // end signal confirmed
    }

    // Reset confirmation when signal drops to WAIT
    // Tolerant reset: allow 1 gap poll (edge can flicker ENTER→WAIT→ENTER on borderline).
    // Only hard-reset if 2+ consecutive non-ENTER polls.
    if (rec.action !== 'ENTER') {
      if (signalConfirmCount > 0) {
        signalConfirmCount--; // Decay by 1 instead of hard reset (allows 1-poll gaps)
      }
      if (signalConfirmCount <= 0) {
        signalConfirmCount = 0;
        signalConfirmSide = null;
      }
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

    // Include positions every poll (lightweight: array + timestamp + botPosition)
    const positionsSummary = _getPositionsSummary
      ? _getPositionsSummary(getCurrentPosition())
      : { list: [], lastUpdate: null, botPosition: null };

    broadcast({
      // ═══ Bot-specific fields (for BotPanel) ═══
      paused: false,
      ts: Date.now(),
      pollCounter,
      btcPrice: lastPrice,
      dryRun: BOT_CONFIG.dryRun,
      stats: getStats(),
      positions: positionsSummary,
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
      tiltProtection: tiltMarketsLeft > 0 ? { active: true, marketsLeft: tiltMarketsLeft, minMlConf: TILT_ML_CONF_MIN } : { active: false },

      // Cut-loss status
      cutLoss: (() => {
        const clPos = getCurrentPosition();
        const clPrice = clPos && !clPos.settled ? (clPos.side === 'UP' ? marketUp : marketDown) : null;
        return getCutLossStatus(clPos, clPrice, {
          btcPrice: lastPrice,
          priceToBeat: priceToBeat.value,
          modelProbability: clPos ? (clPos.side === 'UP' ? ensembleUp : ensembleDown) : null,
          mlConfidence: mlResult.available ? mlResult.mlConfidence : null,
          mlSide: mlResult.available ? mlResult.mlSide : null,
          regime: regimeInfo?.regime ?? 'moderate',
          atrRatio: atr?.atrRatio ?? null,
          timeLeftMin,
        });
      })(),

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

      // Trade journal (recent entries for dashboard)
      recentJournal: getRecentJournal(5),

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

      // Real USDC balance from Polymarket (on-chain reconciliation)
      usdcBalance: usdcBalanceData ? {
        balance: usdcBalanceData.balance,
        allowance: usdcBalanceData.allowance,
        fetchedAt: usdcBalanceData.fetchedAt,
        drift: Math.abs(getBankroll() - usdcBalanceData.balance),
      } : null,
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
