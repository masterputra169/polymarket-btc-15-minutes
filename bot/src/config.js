/**
 * Bot configuration.
 * Imports shared CONFIG from frontend and overrides proxy URLs with direct API URLs.
 */

import { CONFIG as SHARED_CONFIG, BET_SIZING, WS_DEFAULTS, WS_POLYMARKET_LIVE, WS_CHAINLINK } from '../../src/config.js';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Override proxy paths with direct API URLs
const CONFIG = {
  ...SHARED_CONFIG,
  binanceBaseUrl: 'https://data-api.binance.vision',
  gammaBaseUrl: 'https://gamma-api.polymarket.com',
  clobBaseUrl: 'https://clob.polymarket.com',
};

/** Parse a number from env with min/max bounds. Returns default if invalid or out of range. */
function envNum(envVal, defaultVal, min = -Infinity, max = Infinity) {
  if (envVal == null) return defaultVal;
  const n = Number(envVal);
  if (!Number.isFinite(n) || n < min || n > max) return defaultVal;
  return n;
}
function envInt(envVal, defaultVal, min = 0, max = Infinity) {
  return Math.round(envNum(envVal, defaultVal, min, max));
}

const BOT_CONFIG = {
  dryRun: process.env.DRY_RUN !== 'false',
  bankroll: envNum(process.env.BANKROLL, 100, 1, 1_000_000),
  maxDailyLossPct: envNum(process.env.MAX_DAILY_LOSS_PCT, 15, 1, 100),  // Audit fix M: 20→15% — widen gap with maxDrawdown (25%)
  maxConsecutiveLosses: envInt(process.env.MAX_CONSECUTIVE_LOSSES, 5, 1, 50),
  maxDrawdownPct: envNum(process.env.MAX_DRAWDOWN_PCT, 25, 5, 80),
  logLevel: process.env.LOG_LEVEL || 'info',

  // External notifications (optional — no-ops if not set)
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
  discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL || '',
  telegramNotifyTrades: process.env.TELEGRAM_NOTIFY_TRADES === 'true',

  // File paths for persistence
  dataDir: resolve(__dirname, '..', 'data'),
  tradesFile: resolve(__dirname, '..', 'data', 'trades.json'),
  feedbackFile: resolve(__dirname, '..', 'data', 'feedback.json'),
  stateFile: resolve(__dirname, '..', 'data', 'state.json'),
  signalPerfFile: resolve(__dirname, '..', 'data', 'signal_perf.json'),

  // ML model paths (read from frontend public/)
  modelPath: resolve(__dirname, '..', '..', 'public', 'ml', 'xgboost_model.json'),
  normPath: resolve(__dirname, '..', '..', 'public', 'ml', 'norm_browser.json'),

  // Position management
  positionsFile: resolve(__dirname, '..', 'data', 'positions.json'),
  positionPollIntervalMs: 15_000,

  // Trader discovery
  trackedTradersFile: resolve(__dirname, '..', 'data', 'tracked_traders.json'),
  maxTrackedTraders: 20,

  // Trade journal (post-trade analysis)
  journalFile: resolve(__dirname, '..', 'data', 'trade_journal.jsonl'),

  // Verified journal (on-chain reconciliation via CLOB getTrades)
  verifiedJournalFile: resolve(__dirname, '..', 'data', 'verified_journal.jsonl'),
  reconcileIntervalMs: 30 * 60 * 1000,  // 30 minutes

  // Auto-redeem resolved positions
  redeemEnabled: process.env.REDEEM_ENABLED !== 'false',
  redeemIntervalMs: envInt(process.env.REDEEM_INTERVAL_MS, 60 * 60 * 1000, 60_000, 24 * 60 * 60 * 1000),
  redeemedFile: resolve(__dirname, '..', 'data', 'redeemed.json'),

  // Performance monitoring
  monitorIntervalMs: envInt(process.env.MONITOR_INTERVAL_MS, 15 * 60 * 1000, 60_000, 60 * 60 * 1000),
  dailyPnlFile: resolve(__dirname, '..', 'data', 'daily_pnl.jsonl'),
  winRateWarnThreshold: envNum(process.env.WIN_RATE_WARN, 0.40, 0.10, 0.90),
  winRatePauseThreshold: envNum(process.env.WIN_RATE_PAUSE, 0.30, 0.10, 0.90),

  // Cut-loss (stop-loss)
  cutLoss: {
    enabled: process.env.CUT_LOSS_ENABLED !== 'false',
    minHoldSec: envInt(process.env.CUT_LOSS_MIN_HOLD_SEC, 180, 0, 600),      // 90→180s: quant audit showed 68.8% settlement WR — give positions 3min to recover
    minTokenPrice: envNum(process.env.CUT_LOSS_MIN_TOKEN_PRICE, 0.05, 0.01, 0.50),
    cooldownMs: envInt(process.env.CUT_LOSS_COOLDOWN_MS, 5000, 1000, 120000),
    maxAttempts: envInt(process.env.CUT_LOSS_MAX_ATTEMPTS, 7, 1, 20),
    minTokenDropPct: envNum(process.env.CUT_LOSS_MIN_TOKEN_DROP_PCT, 30, 1, 90),  // 20→30%: quant audit — 52% positions cut before settlement destroys 68.8% WR edge
    consecutivePolls: envInt(process.env.CUT_LOSS_CONSECUTIVE_POLLS, 2, 1, 20),
    minBidLiquidity: envNum(process.env.CUT_LOSS_MIN_BID_LIQUIDITY, 2, 0, 1000),
    maxCutSpreadPct: envNum(process.env.CUT_LOSS_MAX_CUT_SPREAD_PCT, 15, 1, 50),
    crashDropPct: envNum(process.env.CUT_LOSS_CRASH_DROP_PCT, 30, 10, 90),
    crashBtcDistPct: envNum(process.env.CUT_LOSS_CRASH_BTC_DIST_PCT, 0.20, 0.01, 5.0),
    holdScoreThreshold: envNum(process.env.CUT_LOSS_HOLD_THRESHOLD, 7, 1, 20),  // Audit C6: weighted scoring threshold for soft gates 7-12d
  },

  // Take-profit (early exit when up but signal weakening)
  takeProfit: {
    enabled: process.env.TAKE_PROFIT_ENABLED !== 'false',
    minHoldSec: envInt(process.env.TAKE_PROFIT_MIN_HOLD_SEC, 60, 0, 600),
    minGainPct: envNum(process.env.TAKE_PROFIT_MIN_GAIN_PCT, 20, 5, 90),       // token must be up 20%+
    minProbDrop: envNum(process.env.TAKE_PROFIT_MIN_PROB_DROP, 0.55, 0.40, 0.70), // model prob below this = weakening
    minTimeLeftMin: envNum(process.env.TAKE_PROFIT_MIN_TIME_LEFT_MIN, 1.0, 0.5, 5.0), // don't sell if <1min (let settlement handle)
  },
};

export { CONFIG, BET_SIZING, BOT_CONFIG, WS_DEFAULTS, WS_POLYMARKET_LIVE, WS_CHAINLINK };
