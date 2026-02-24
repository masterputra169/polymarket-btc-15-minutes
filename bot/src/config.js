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
  maxDrawdownPct: envNum(process.env.MAX_DRAWDOWN_PCT, 25, 5, 80),  // Audit v2 H6: 20→25% — P(4 consec full loss)=3.7% at 56% WR; 20% too tight for normal variance
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
  // RC1 Fix: entry snapshot persisted to disk so bot restart doesn't lose it
  entrySnapshotFile: resolve(__dirname, '..', 'data', 'entry_snapshot.json'),

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
  redeemIntervalMs: envInt(process.env.REDEEM_INTERVAL_MS, 37 * 60 * 1000, 60_000, 24 * 60 * 60 * 1000),
  redeemedFile: resolve(__dirname, '..', 'data', 'redeemed.json'),

  // Performance monitoring
  monitorIntervalMs: envInt(process.env.MONITOR_INTERVAL_MS, 15 * 60 * 1000, 60_000, 60 * 60 * 1000),
  dailyPnlFile: resolve(__dirname, '..', 'data', 'daily_pnl.jsonl'),
  winRateWarnThreshold: envNum(process.env.WIN_RATE_WARN, 0.40, 0.10, 0.90),
  winRatePauseThreshold: envNum(process.env.WIN_RATE_PAUSE, 0.30, 0.10, 0.90),

  // Cut-loss — v11 Last Resort Only
  // Philosophy: HOLD conviction positions. Cut ONLY when situation is clearly unrecoverable.
  // Evidence: Settlement WR 71.1% — holding wins 71% of time. Cut-loss destroyed $28.77 edge.
  // Triggers (only when truly "penting"):
  //   1. ML reverses with >=80% confidence + drop >=25% (strong signal + confirmed loss)
  //   2. EV near-disabled: model needs <7.5% prob on 50c token (essentially never fires)
  //   3. True crash: >=42% token drop with BTC confirming
  //   4. Extreme persistent: >=42% drop for 15+ minutes (position clearly dead)
  //   5. Late rescue: <1.5min left + >=30% drop (handled in cutLoss.js)
  cutLoss: {
    enabled: process.env.CUT_LOSS_ENABLED !== 'false',
    minHoldSec: envInt(process.env.CUT_LOSS_MIN_HOLD_SEC, 240, 0, 600),        // v11: 180→240s (4min) before evaluating
    minTokenPrice: envNum(process.env.CUT_LOSS_MIN_TOKEN_PRICE, 0.05, 0.01, 0.50),
    cooldownMs: envInt(process.env.CUT_LOSS_COOLDOWN_MS, 5000, 1000, 120000),
    maxAttempts: envInt(process.env.CUT_LOSS_MAX_ATTEMPTS, 7, 1, 20),
    minTokenDropPct: envNum(process.env.CUT_LOSS_MIN_TOKEN_DROP_PCT, 45, 1, 90), // Audit v2 C2: 35→45% — 33% of all trades are cuts with 42% FP rate; settlement WR 71% > cut-loss WR
    consecutivePolls: envInt(process.env.CUT_LOSS_CONSECUTIVE_POLLS, 3, 1, 20), // v11: 2→3 polls to confirm (not a fluke)
    minBidLiquidity: envNum(process.env.CUT_LOSS_MIN_BID_LIQUIDITY, 2, 0, 1000),
    maxCutSpreadPct: envNum(process.env.CUT_LOSS_MAX_CUT_SPREAD_PCT, 15, 1, 50),
    crashDropPct: envNum(process.env.CUT_LOSS_CRASH_DROP_PCT, 42, 10, 90),      // v11: 35→42% — only true crashes
    crashBtcDistPct: envNum(process.env.CUT_LOSS_CRASH_BTC_DIST_PCT, 0.20, 0.01, 5.0),
    evBuffer: envNum(process.env.CUT_LOSS_EV_BUFFER, 0.80, 0.05, 1.50),        // C2: 0.85→0.80 with floor 0.40 — uniform 80% threshold across price levels
    mlFlipConfidence: envNum(process.env.CUT_LOSS_ML_FLIP_CONF, 0.65, 0.40, 0.99), // ML must flip to opposite side with >=65% confidence
    persistentDropPct: envNum(process.env.CUT_LOSS_PERSISTENT_DROP_PCT, 42, 5, 90),   // v11: 35→42% — truly dead position
    persistentDropMinutes: envNum(process.env.CUT_LOSS_PERSISTENT_DROP_MIN, 15, 1, 30), // v11: 12→15min — wait even longer
  },

  // Bet sizing hard cap (data shows ~$1.30 avg is most consistent)
  maxBetAmountUsd: envNum(process.env.MAX_BET_AMOUNT_USD, 2.50, 1.00, 100),  // Audit fix: 2.00→2.50 — allow Kelly asymmetry for high-conf signals

  // Take-profit — Quant fix C4: fixed minProbDrop absolute→relative (entry-based), still disabled by default
  // Enable when data confirms take-profit improves EV vs holding to settlement (WR 71.1%)
  takeProfit: {
    enabled: process.env.TAKE_PROFIT_ENABLED === 'true',  // Audit v2 M1: enable via env — 29% losing settlements can be captured early
    minHoldSec: 60,
    minGainPct: 18,               // Audit v2 M1: 12→18% — conservative: only take profit on large gains to avoid cutting winners short
    minProbDrop: 0.50,           // Audit v2 M1: 0.55→0.50 — clear signal erosion when model drops below entry threshold
    minTimeLeftMin: 1.0,
  },

  // Recovery buy — re-enter same side after cut-loss if signal stabilizes
  // State machine: IDLE → SAMPLING (10s, capture baseline) → MONITORING (30s, wait for stable/rising) → BUY or IDLE
  // Only triggers after cut-loss, not after settlement or take-profit.
  recoveryBuy: {
    enabled: process.env.RECOVERY_BUY_ENABLED === 'true',
    samplingMs: envInt(process.env.RECOVERY_SAMPLING_MS, 10_000, 3_000, 30_000),       // 10s baseline capture
    monitoringMs: envInt(process.env.RECOVERY_MONITORING_MS, 30_000, 10_000, 120_000),  // 30s max monitoring window
    minTokenPrice: envNum(process.env.RECOVERY_MIN_TOKEN_PRICE, 0.70, 0.30, 0.95),     // >= 70c — high-prob only
    minTimeLeftMin: envNum(process.env.RECOVERY_MIN_TIME_LEFT, 3.0, 1.0, 10.0),        // >= 3 min to settlement
    minBankroll: envNum(process.env.RECOVERY_MIN_BANKROLL, 1.0, 0.50, 100.0),          // >= $1 available
    maxRecoveryPct: envNum(process.env.RECOVERY_MAX_PCT, 0.50, 0.10, 1.00),            // max 50% of normal bet size
    minMlConfidence: envNum(process.env.RECOVERY_MIN_ML_CONF, 0.65, 0.50, 0.95),       // ML must still agree
    minEnsembleProb: envNum(process.env.RECOVERY_MIN_PROB, 0.60, 0.50, 0.90),          // model prob must be decent
  },

  // Pre-market LONG strategy — one UP trade per day during US pre-market (09:00-09:15 EST)
  // Leverages pre-market volatility before NYSE open. 20% risk, 50% profit target.
  // Expected: ~10% compounding per win → +700% monthly at high win rate.
  preMarketLong: {
    enabled: process.env.PREMARKET_LONG_ENABLED === 'true',
    riskPct: envNum(process.env.PREMARKET_LONG_RISK_PCT, 0.20, 0.05, 0.50),          // 20% of bankroll
    profitTargetPct: envNum(process.env.PREMARKET_LONG_PROFIT_TARGET_PCT, 0.50, 0.10, 2.00), // 50% take-profit
    windowStartH: envInt(process.env.PREMARKET_LONG_WINDOW_START_H, 9, 0, 23),       // 09:00 EST
    windowStartM: envInt(process.env.PREMARKET_LONG_WINDOW_START_M, 0, 0, 59),
    windowEndH: envInt(process.env.PREMARKET_LONG_WINDOW_END_H, 9, 0, 23),           // 09:15 EST
    windowEndM: envInt(process.env.PREMARKET_LONG_WINDOW_END_M, 15, 0, 59),
  },

  // MetEngine smart money API (x402, Solana USDC payments)
  // F1: consensus ≥ blockConsensusStrength against us → BLOCK
  // F2: top insider score ≥ boostInsiderScore on opp side → BLOCK
  // F3: consensus ≥ convictionBlockStrength AND conviction wallet (score≥convictionScoreMin, USDC≥convictionMinUSDC, non-hedger) → BLOCK
  // F1b: consensus ≥ 85% of F1 threshold AND dumb money contrarian → BLOCK
  // Cost: ~$0.01–0.05/request, cached 90s per market → ~$0.50–1.00/day
  metEngine: {
    enabled: process.env.METENGINE_ENABLED === 'true',
    baseUrl: process.env.METENGINE_BASE_URL || 'https://agent.metengine.xyz',
    solanaPrivateKey: process.env.SOLANA_PRIVATE_KEY || '',
    cacheTtlMs: 90_000,       // 90s per conditionId — don't re-query mid-market
    timeoutMs: 5_000,         // 5s timeout — don't hold up trade loop
    blockConsensusStrength:  parseFloat(process.env.METENGINE_BLOCK_STRENGTH        || '0.65'), // F1: strong consensus block
    boostInsiderScore:       parseFloat(process.env.METENGINE_BOOST_SCORE           || '75'),   // F2: insider score threshold
    convictionBlockStrength: parseFloat(process.env.METENGINE_CONVICTION_STRENGTH   || '0.60'), // F3: medium consensus gate
    convictionScoreMin:      parseFloat(process.env.METENGINE_CONVICTION_SCORE      || '90'),   // F3: min wallet score
    convictionMinUSDC:       parseFloat(process.env.METENGINE_CONVICTION_USDC       || '50'),   // F3: min USDC invested
  },
};

export { CONFIG, BET_SIZING, BOT_CONFIG, WS_DEFAULTS, WS_POLYMARKET_LIVE, WS_CHAINLINK };
