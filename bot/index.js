/**
 * Polymarket BTC 15-Minute Auto-Trading Bot — MAXIMUM SPEED
 *
 * Architecture:
 *   4 WebSocket streams (Binance price + CLOB orderbook + Polymarket LiveData + Chainlink WSS)
 *   + Tiered REST polling (1m klines every 2s, 5m every 10s, market discovery every 30s)
 *   + XGBoost ML inference + 10 TA indicators + Kelly bet sizing
 *
 * Entry point: polyfills → init services → start WS streams → start poll loop → handle shutdown.
 */

import 'dotenv/config';

// ── Node.js polyfills for browser APIs used by shared modules ──
if (typeof globalThis.localStorage === 'undefined') {
  globalThis.localStorage = {
    _data: {},
    getItem(key) { return this._data[key] ?? null; },
    setItem(key, val) { this._data[key] = String(val); },
    removeItem(key) { delete this._data[key]; },
  };
}
if (typeof globalThis.window === 'undefined') {
  globalThis.window = {
    addEventListener() {},
    removeEventListener() {},
  };
}

import { BOT_CONFIG, CONFIG } from './src/config.js';
import { setLogLevel, log } from './src/logger.js';
import { loadMLModelFromDisk } from './src/adapters/mlLoader.js';
import { loadFeedbackFromDisk, saveFeedbackToDisk } from './src/adapters/feedbackStore.js';
import { loadState, saveState as savePositionState, getStats, getCurrentPosition } from './src/trading/positionTracker.js';
import { initClobClient, cancelAllOrders } from './src/trading/clobClient.js';
import { connect as connectBinanceWs, disconnect as disconnectBinanceWs } from './src/streams/binanceWs.js';
import { connect as connectClobWs, disconnect as disconnectClobWs } from './src/streams/clobWs.js';
import { connect as connectPolyLiveWs, disconnect as disconnectPolyLiveWs } from './src/streams/polymarketLiveWs.js';
import { connect as connectChainlinkWss, disconnect as disconnectChainlinkWss } from './src/streams/chainlinkWss.js';
import { pollOnce, pauseBot, resumeBot, registerPositionCallback } from './src/loop.js';
import { startStatusServer, stopStatusServer, registerBotControl, registerPositionManager, registerTraderDiscovery } from './src/statusServer.js';
import { loadPositions, startPolling as startPositionPolling, stopPolling as stopPositionPolling, getMergedPositions, closePosition } from './src/trading/positionManager.js';
import { loadTrackedTraders, fullScan, getTrackedTraders, getDiscoveredTraders, addTrackedTrader, removeTrackedTrader, simulateTrader } from './src/discovery/traderDiscovery.js';
import { startReconciler, stopReconciler } from './src/trading/journalReconciler.js';
import { startRedeemer, stopRedeemer } from './src/trading/redeemer.js';

// Poll interval: 500ms — actual execution ~150ms, well within Binance rate limits
const POLL_MS = parseInt(process.env.POLL_INTERVAL_MS || '500', 10);

// ── Configure logging ──
setLogLevel(BOT_CONFIG.logLevel);

log.info('='.repeat(60));
log.info('  Polymarket BTC 15m Auto-Trading Bot (MAX SPEED)');
log.info('='.repeat(60));
log.info(`Mode: ${BOT_CONFIG.dryRun ? 'DRY RUN (no real orders)' : 'LIVE TRADING'}`);
log.info(`Bankroll: $${BOT_CONFIG.bankroll}`);
log.info(`Poll interval: ${POLL_MS}ms (+ real-time WS streams)`);
log.info(`Max daily loss: ${BOT_CONFIG.maxDailyLossPct}%`);
log.info(`Max consecutive losses: ${BOT_CONFIG.maxConsecutiveLosses}`);

async function main() {
  // 1. Init CLOB client (only if live trading)
  if (!BOT_CONFIG.dryRun) {
    try {
      await initClobClient();
    } catch (err) {
      log.error(`Failed to init CLOB client: ${err.message}`);
      log.error('Cannot trade without CLOB client. Exiting.');
      process.exit(1);
    }
    // Start verified journal reconciler (on-chain trade history)
    startReconciler();

    // Start auto-redeemer for resolved positions
    if (BOT_CONFIG.redeemEnabled) startRedeemer();
  } else {
    log.info('DRY RUN mode — CLOB client not initialized');
  }

  // 2. Load ML model from disk
  const mlOk = loadMLModelFromDisk();
  if (!mlOk) {
    log.warn('ML model not loaded — running rule-based only');
  }

  // 3. Load feedback history
  loadFeedbackFromDisk();

  // 4. Load position state
  loadState();

  const stats = getStats();
  log.info(`Position state: bankroll=$${stats.bankroll.toFixed(2)}, trades=${stats.totalTrades}, W/L=${stats.wins}/${stats.losses}`);

  // 5. Start WebSocket streams (real-time data)
  log.info('Connecting WebSocket streams...');
  connectBinanceWs();
  connectClobWs();
  connectPolyLiveWs();
  connectChainlinkWss();

  // 5b. Position manager + trader discovery (load BEFORE server starts)
  loadPositions();
  loadTrackedTraders();
  startPositionPolling();
  registerPositionCallback(getMergedPositions);

  // W2: Register ALL callbacks BEFORE starting server — prevents race where
  // dashboard connects and sends commands before callbacks are set
  registerBotControl(pauseBot, resumeBot);
  registerPositionManager({ getPositions: () => getMergedPositions(getCurrentPosition()), closePosition });
  registerTraderDiscovery({
    scan: fullScan,
    getTracked: getTrackedTraders,
    getDiscovered: getDiscoveredTraders,
    addTracker: addTrackedTrader,
    removeTracker: removeTrackedTrader,
    simulate: simulateTrader,
  });

  // 5c. Start status broadcast server (dashboard integration)
  startStatusServer();

  // 6. Start poll loop
  log.info(`Starting poll loop (every ${POLL_MS}ms)...`);
  log.info('-'.repeat(60));

  // Small delay for WS to connect before first poll
  await new Promise(r => setTimeout(r, 1500));

  await pollOnce();
  const intervalId = setInterval(pollOnce, POLL_MS);

  // 7. Graceful shutdown handler
  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;

    log.info(`\n${signal} received — shutting down gracefully...`);
    clearInterval(intervalId);

    // Disconnect WebSockets
    disconnectBinanceWs();
    disconnectClobWs();
    disconnectPolyLiveWs();
    disconnectChainlinkWss();

    // Stop status server + position polling + reconciler + redeemer
    stopStatusServer();
    stopPositionPolling();
    stopReconciler();
    stopRedeemer();

    // Cancel open orders (live mode only)
    if (!BOT_CONFIG.dryRun) {
      try {
        await cancelAllOrders();
      } catch (err) {
        log.warn(`Could not cancel orders: ${err.message}`);
      }
    }

    // Save all state
    saveFeedbackToDisk();
    savePositionState();

    const finalStats = getStats();
    log.info('='.repeat(60));
    log.info('  Session Summary');
    log.info('='.repeat(60));
    log.info(`Bankroll: $${finalStats.bankroll.toFixed(2)}`);
    log.info(`Daily P&L: ${finalStats.dailyPnL >= 0 ? '+' : ''}$${finalStats.dailyPnL.toFixed(2)} (${finalStats.dailyPnLPct.toFixed(1)}%)`);
    log.info(`Trades: ${finalStats.totalTrades} (${finalStats.wins}W/${finalStats.losses}L = ${(finalStats.winRate * 100).toFixed(0)}%)`);
    log.info('State saved. Goodbye.');

    process.exit(0);
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(err => {
  log.error(`Fatal: ${err.message}`);
  console.error(err);
  process.exit(1);
});
