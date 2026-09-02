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

import { config as dotenvConfig } from 'dotenv';
import { dirname as _dotenvDirname, resolve as _dotenvResolve } from 'path';
import { fileURLToPath as _dotenvFtu } from 'url';
// ENV LOADING NOTE:
// Primary: --env-file=./bot/.env in ecosystem.config.cts (Node.js native, loads before TS)
// Backup: dotenvConfig() below (for manual `node bot/index.ts` without --env-file flag)
// ES module imports are hoisted above this call, so BOT_CONFIG reads process.env during import.
// With --env-file, env is already set → BOT_CONFIG correct. Without it, some === 'true' checks
// default to false (safe). Critical paths (Telegram, pre-market) read process.env directly.
dotenvConfig({ path: _dotenvResolve(_dotenvDirname(_dotenvFtu(import.meta.url)), '.env') });

// ── Node.js polyfills for browser APIs used by shared modules ──
if (typeof globalThis.localStorage === 'undefined') {
  const storage = new Map<string, string>();
  globalThis.localStorage = {
    get length() { return storage.size; },
    clear() { storage.clear(); },
    getItem(key: string) { return storage.get(key) ?? null; },
    key(index: number) { return Array.from(storage.keys())[index] ?? null; },
    removeItem(key: string) { storage.delete(key); },
    setItem(key: string, val: string) { storage.set(key, String(val)); },
  };
}
if (typeof globalThis.window === 'undefined') {
  globalThis.window = {
    addEventListener() {},
    removeEventListener() {},
  };
}

import { BOT_CONFIG, CONFIG } from './src/config.ts';
import { setLogLevel, log } from './src/logger.ts';
import { loadMLModelFromDisk } from './src/adapters/mlLoader.ts';
import { loadFeedbackFromDisk, saveFeedbackToDisk } from './src/adapters/feedbackStore.ts';
import { loadSignalPerfFromDisk, saveSignalPerfToDisk } from './src/adapters/signalPerfStore.ts';
import { loadState, saveState as savePositionState, getStats, getCurrentPosition } from './src/trading/positionTracker.ts';
import { initClobClient, cancelAllOrders, getOpenOrders, getUsdcBalance, updateConditionalApproval } from './src/trading/clobClient.ts';
import { initDataStreams, shutdownDataStreams, isDataStreamsConfigured } from './src/adapters/chainlinkDataStreams.ts';
import { connect as connectBinanceWs, disconnect as disconnectBinanceWs } from './src/streams/binanceWs.ts';
import { connect as connectClobWs, disconnect as disconnectClobWs } from './src/streams/clobWs.ts';
import { connect as connectPolyLiveWs, disconnect as disconnectPolyLiveWs } from './src/streams/polymarketLiveWs.ts';
import { connect as connectChainlinkWss, disconnect as disconnectChainlinkWss } from './src/streams/chainlinkWss.ts';
import { pollOnce, pauseBot, resumeBot, registerPositionCallback, resetEntryRegime } from './src/loop.ts';
import { startStatusServer, stopStatusServer, registerBotControl, registerPositionManager, registerTraderDiscovery, registerUsdcSync } from './src/statusServer.ts';
import { initRuntimeIntegrations, recordRuntimeEvent, shutdownRuntimeIntegrations } from './src/services/runtimeIntegrations.ts';
import { startReportServer, stopReportServer } from './src/services/reportServer.ts';
import { loadPositions, startPolling as startPositionPolling, stopPolling as stopPositionPolling, getMergedPositions, closePosition } from './src/trading/positionManager.ts';
import { loadTrackedTraders, fullScan, getTrackedTraders, getDiscoveredTraders, addTrackedTrader, removeTrackedTrader, simulateTrader } from './src/discovery/traderDiscovery.ts';
import { startReconciler, stopReconciler } from './src/trading/journalReconciler.ts';
import { startRedeemer, stopRedeemer } from './src/trading/redeemer.ts';
import { startMonitor, stopMonitor } from './src/monitoring/perfMonitor.ts';
import { scheduleDailySummary, stopDailySummary, loadEntrySnapshotFromDisk } from './src/trading/tradeJournal.ts';

// AI Agent modules
import { initOpenRouter } from './src/ai/openrouterClient.ts';
import { loadAnalysisFromDisk, maybeAnalyze, getLastAnalysis } from './src/ai/postTradeAnalyst.ts';
import { maybeOptimize } from './src/ai/selfOptimizer.ts';
import { loadRLNarrativeFromDisk, maybeGenerateRLNarrative } from './src/ai/rlNarrative.ts';
import { initLLMRegime, maybeClassify as maybeClassifyRegime } from './src/ai/regimeClassifier.ts';

// Monitoring / guards
import { initMacroCalendar, fetchMacroEvents } from './src/monitoring/macroCalendar.ts';

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
  startReportServer();

  // 1. Init CLOB client (only if live trading)
  if (!BOT_CONFIG.dryRun) {
    try {
      await initClobClient();
    } catch (err) {
      log.error(`Failed to init CLOB client: ${err.message}`);
      log.error('Cannot trade without CLOB client. Exiting.');
      process.exit(1);
    }

    // 1a. Cancel orphan orders from previous session BEFORE first poll.
    // Stale orders may execute during the ~700ms startup window, causing
    // phantom positions (tokens received but no position state tracked).
    try {
      const openOrders = await getOpenOrders();
      if (openOrders.length > 0) {
        log.warn(`Startup cleanup: ${openOrders.length} orphan order(s) found — cancelling`);
        await cancelAllOrders();
        log.info('Startup cleanup: orphan orders cancelled');
      } else {
        log.info('Startup cleanup: no orphan orders');
      }
    } catch (err) {
      log.warn(`Startup cleanup failed (non-fatal): ${err.message}`);
    }

    // 1b. Auto-activate deposits — wrap proxy USDC.e into pUSD if any.
    // Gated by AUTO_ACTIVATE_DEPOSITS env var; respects DRY_RUN. Non-fatal.
    // Runs on STARTUP + periodically every AUTO_ACTIVATE_INTERVAL_MIN minutes
    // (default 60 min). Prevents ghost-drawdown from settlement-returned USDC.e.
    if (process.env.AUTO_ACTIVATE_DEPOSITS === 'true') {
      const { autoActivateOnStartup } = await import('./src/trading/depositActivator.ts');

      const runActivate = async (label) => {
        try {
          const r = await autoActivateOnStartup();
          if (r.executed) {
            log.info(`Auto-activate (${label}): ${r.pusdAdded.toFixed(4)} pUSD added (${r.txs.length} txs)`);
          } else if (r.reason && r.reason !== 'disabled') {
            log.debug(`Auto-activate (${label}) skipped: ${r.reason}`);
          }
        } catch (err) {
          log.warn(`Auto-activate (${label}) failed (non-fatal): ${err.message}`);
        }
      };

      // Startup run
      await runActivate('startup');

      // Periodic run — default 60 min, configurable via AUTO_ACTIVATE_INTERVAL_MIN.
      // Set to 0 to disable periodic (startup-only).
      const intervalMin = Math.max(0, parseInt(process.env.AUTO_ACTIVATE_INTERVAL_MIN ?? '60', 10));
      if (intervalMin > 0) {
        const intervalMs = intervalMin * 60 * 1000;
        log.info(`Auto-activate periodic enabled: every ${intervalMin} minutes`);
        setInterval(() => runActivate('periodic').catch(() => {}), intervalMs);
      }
    }

    // Start verified journal reconciler (on-chain trade history)
    startReconciler();

    // Start auto-redeemer for resolved positions
    if (BOT_CONFIG.redeemEnabled) startRedeemer();
  } else {
    log.info('DRY RUN mode — CLOB client not initialized');
  }

  // 1c. Postgres/Redis mirrors — AFTER orphan-order cleanup (connect retries can
  // take ~40s and must not widen the window where a stale resting order fills
  // untracked). Non-blocking: mirror functions no-op until connections are ready.
  void initRuntimeIntegrations()
    .then(() => recordRuntimeEvent('bot_startup', {
      dryRun: BOT_CONFIG.dryRun,
      pollMs: POLL_MS,
      statusPort: process.env.STATUS_PORT || '3099',
      reportPort: process.env.REPORT_PORT || '3101',
    }))
    .catch(err => log.warn(`Runtime integrations init failed (non-fatal): ${err.message}`));

  // 1b. Init Chainlink Data Streams WS (dormant if API key not configured)
  if (isDataStreamsConfigured()) {
    try {
      const connected = await initDataStreams();
      if (connected) log.info('Chainlink Data Streams: WS stream connected');
    } catch (err) {
      log.warn(`Chainlink Data Streams init failed (non-fatal): ${err.message}`);
    }
  } else {
    log.info('Chainlink Data Streams: dormant (CHAINLINK_DS_API_KEY not set — PTB falls back to polymarket_page/chainlink_round)');
  }

  // 2. Load ML model from disk
  const mlOk = loadMLModelFromDisk();
  if (!mlOk) {
    log.warn('ML model not loaded — running rule-based only');
  }

  // 3. Load feedback history + signal performance
  loadFeedbackFromDisk();
  loadSignalPerfFromDisk();

  // 4. Load position state
  loadState();

  // RC1 Fix: restore entry snapshot from disk (survives restarts)
  loadEntrySnapshotFromDisk();

  const stats = getStats();
  log.info(`Position state: bankroll=$${stats.bankroll.toFixed(2)}, trades=${stats.totalTrades}, W/L=${stats.wins}/${stats.losses}`);

  // 4a. If there's an existing open position, pre-approve its conditional token.
  // This ensures ERC1155 setApprovalForAll is set so cut-loss sells don't fail.
  if (!BOT_CONFIG.dryRun) {
    const openPos = getCurrentPosition();
    if (openPos && !openPos.settled && openPos.tokenId) {
      log.info(`Open position found at startup — ensuring conditional token approval for ${openPos.tokenId.slice(0, 12)}...`);
      updateConditionalApproval(openPos.tokenId).catch(err =>
        log.warn(`Startup conditional approval skipped: ${err.message}`)
      );
    }
  }

  // 4b. Start performance monitor (read-only — safe in both live + dry-run)
  // Must come AFTER loadState() so getStats() reads initialized bankroll/trades
  startMonitor();

  // 4c. Schedule daily trade summary (Telegram alert at midnight ET)
  scheduleDailySummary();

  // 4d. Initialize AI agent (OpenRouter + post-trade analysis)
  if (BOT_CONFIG.ai.enabled) {
    initOpenRouter(BOT_CONFIG.ai);
    loadAnalysisFromDisk();
    log.info(`AI Agent: model=${BOT_CONFIG.ai.model}, interval=${Math.round(BOT_CONFIG.ai.analyzeIntervalMs / 60_000)}min, autoOptimize=${BOT_CONFIG.ai.autoOptimize}`);
  } else {
    log.info('AI Agent: disabled (set AI_AGENT_ENABLED=true to enable)');
  }

  // 4d2. Initialize Macro Event Guard (free FF calendar, runs regardless of AI agent).
  initMacroCalendar();

  // 4d3. Initialize LLM Regime Classifier (requires AI agent + OpenRouter).
  if (BOT_CONFIG.ai.enabled) {
    initLLMRegime();
  } else if (BOT_CONFIG.llmRegime?.enabled) {
    log.warn('LLM Regime enabled but AI_AGENT_ENABLED=false — classifier will not run');
  }

  // 4e. Load RL narrative cache from disk
  if (BOT_CONFIG.rl?.enabled) {
    loadRLNarrativeFromDisk();
  }

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
  registerBotControl(pauseBot, resumeBot, resetEntryRegime);
  registerPositionManager({ getPositions: () => getMergedPositions(getCurrentPosition()), closePosition });
  registerTraderDiscovery({
    scan: fullScan,
    getTracked: getTrackedTraders,
    getDiscovered: getDiscoveredTraders,
    addTracker: addTrackedTrader,
    removeTracker: removeTrackedTrader,
    simulate: simulateTrader,
  });
  registerUsdcSync(getUsdcBalance);

  // 5c. Start status broadcast server (dashboard integration)
  startStatusServer();

  // 6. Start poll loop
  log.info(`Starting poll loop (every ${POLL_MS}ms)...`);
  log.info('-'.repeat(60));

  // Small delay for WS to connect before first poll
  await new Promise(r => setTimeout(r, 500));

  await pollOnce();
  const intervalId = setInterval(pollOnce, POLL_MS);

  // 6b. AI analysis interval (runs alongside poll loop)
  let aiIntervalId = null;
  if (BOT_CONFIG.ai.enabled) {
    aiIntervalId = setInterval(async () => {
      try {
        const stats = getStats();
        await maybeAnalyze(stats.totalTrades);
        await maybeOptimize();
        await maybeGenerateRLNarrative();
        // LLM Regime classifier (P2) — internally throttled by intervalMs
        if (BOT_CONFIG.llmRegime?.enabled) {
          await maybeClassifyRegime();
        }
      } catch (err) {
        log.debug(`AI interval error: ${err.message}`);
      }
    }, 60_000); // Check every minute (actual analysis throttled by analyzeIntervalMs)
  }

  // 6c. Macro calendar refresh interval (independent of AI agent)
  let macroIntervalId = null;
  if (BOT_CONFIG.macro?.enabled) {
    macroIntervalId = setInterval(() => {
      fetchMacroEvents().catch(err => log.debug(`Macro refresh: ${err.message}`));
    }, Math.min(BOT_CONFIG.macro.fetchIntervalMs ?? 6 * 60 * 60 * 1000, 6 * 60 * 60 * 1000));
  }

  // 7. Graceful shutdown handler
  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;

    log.info(`\n${signal} received — shutting down gracefully...`);
    clearInterval(intervalId);
    if (aiIntervalId) clearInterval(aiIntervalId);
    if (macroIntervalId) clearInterval(macroIntervalId);

    // Disconnect WebSockets
    disconnectBinanceWs();
    disconnectClobWs();
    disconnectPolyLiveWs();
    disconnectChainlinkWss();

    // Stop status server + position polling + reconciler + redeemer + monitor + daily summary
    stopStatusServer();
    await stopReportServer();
    stopPositionPolling();
    stopReconciler();
    stopRedeemer();
    stopMonitor();
    stopDailySummary();
    try { await shutdownDataStreams(); } catch { /* ignore */ }

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
    saveSignalPerfToDisk();
    savePositionState();

    const finalStats = getStats();
    log.info('='.repeat(60));
    log.info('  Session Summary');
    log.info('='.repeat(60));
    log.info(`Bankroll: $${finalStats.bankroll.toFixed(2)}`);
    log.info(`Daily P&L: ${finalStats.dailyPnL >= 0 ? '+' : ''}$${finalStats.dailyPnL.toFixed(2)} (${finalStats.dailyPnLPct.toFixed(1)}%)`);
    log.info(`Trades: ${finalStats.totalTrades} (${finalStats.wins}W/${finalStats.losses}L = ${(finalStats.winRate * 100).toFixed(0)}%)`);
    log.info('State saved. Goodbye.');

    await recordRuntimeEvent('bot_session_summary', {
      bankroll: finalStats.bankroll,
      dailyPnL: finalStats.dailyPnL,
      totalTrades: finalStats.totalTrades,
      wins: finalStats.wins,
      losses: finalStats.losses,
      winRate: finalStats.winRate,
    });
    await shutdownRuntimeIntegrations();

    process.exit(0);
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// ── Global crash guards ──
// These catch errors that escape all try/catch blocks and would otherwise
// kill the process silently. Log the full stack trace before exiting so
// post-mortem debugging is possible.
function formatError(value: unknown): string {
  if (value instanceof Error) return value.stack || value.message;
  return String(value);
}

process.on('uncaughtException', (err) => {
  // Use console.error as fallback — logger itself might be broken
  const msg = `UNCAUGHT EXCEPTION — bot will restart: ${formatError(err)}`;
  try { log.error(msg); } catch (_) { console.error(msg); }
  process.exit(1); // Exit so process manager (pm2 / systemd) can restart
});

process.on('unhandledRejection', (reason, promise) => {
  const msg = `UNHANDLED REJECTION at ${promise}: ${formatError(reason)}`;
  try { log.error(msg); } catch (_) { console.error(msg); }
  process.exit(1); // Exit so process manager can restart
});

main().catch(err => {
  log.error(`Fatal startup error: ${formatError(err)}`);
  console.error(err);
  process.exit(1);
});
