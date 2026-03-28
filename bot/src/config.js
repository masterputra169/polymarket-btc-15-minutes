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
  maxConsecutiveLosses: envInt(process.env.MAX_CONSECUTIVE_LOSSES, 7, 1, 50),  // Audit v4 C4: 5→7 — P(7 losses at 56% WR) = 0.32%, avoids false halt ~4x/year
  maxDrawdownPct: envNum(process.env.MAX_DRAWDOWN_PCT, 25, 5, 80),  // Audit v2 H6: 20→25% — P(4 consec full loss)=3.7% at 56% WR; 20% too tight for normal variance
  circuitBreakerCooldownMs: envInt(process.env.CB_COOLDOWN_MS, 4 * 60 * 60 * 1000, 0, 24 * 60 * 60 * 1000), // Audit v4 C3: 30min→4hr — after consecutive losses, 30min too short; prevents 54% daily risk
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
  redeemIntervalMs: envInt(process.env.REDEEM_INTERVAL_MS, 5 * 60 * 1000, 60_000, 24 * 60 * 60 * 1000),
  redeemedFile: resolve(__dirname, '..', 'data', 'redeemed.json'),

  // Daily profit target — pause trading when on-chain profit reaches target (WIB timezone)
  dailyProfitTargetUsd: envNum(process.env.DAILY_PROFIT_TARGET_USD, 20, 0, 10_000),

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
  // v16 NUCLEAR HOLD: Data proves settlement WR 87.5% >> cut-loss WR 23.3%.
  // 180 cut-losses destroyed ~$40+ of edge. Cut-loss is now LAST RESORT only.
  // Only fires on absolute catastrophic crashes (70%+ drop, 90%+ capital loss).
  cutLoss: {
    enabled: process.env.CUT_LOSS_ENABLED !== 'false',
    minHoldSec: envInt(process.env.CUT_LOSS_MIN_HOLD_SEC, 720, 0, 900),        // 720s (12min) — only last 3min of 15min market allows cut
    minTokenPrice: envNum(process.env.CUT_LOSS_MIN_TOKEN_PRICE, 0.03, 0.01, 0.50), // lowered — if cutting, sell even cheap tokens
    cooldownMs: envInt(process.env.CUT_LOSS_COOLDOWN_MS, 10000, 1000, 120000),  // 10s cooldown — slow retry
    crashCooldownMs: envInt(process.env.CUT_LOSS_CRASH_COOLDOWN_MS, 3000, 500, 10000),
    maxAttempts: envInt(process.env.CUT_LOSS_MAX_ATTEMPTS, 3, 1, 20),           // 3 attempts max then give up
    minTokenDropPct: envNum(process.env.CUT_LOSS_MIN_TOKEN_DROP_PCT, 70, 1, 90), // 70% drop required — catastrophic only
    consecutivePolls: envInt(process.env.CUT_LOSS_CONSECUTIVE_POLLS, 20, 1, 50), // 20 polls @ 50ms = 1s sustained signal
    minBidLiquidity: envNum(process.env.CUT_LOSS_MIN_BID_LIQUIDITY, 2, 0, 1000),
    maxCutSpreadPct: envNum(process.env.CUT_LOSS_MAX_CUT_SPREAD_PCT, 15, 1, 50),
    crashDropPct: envNum(process.env.CUT_LOSS_CRASH_DROP_PCT, 70, 10, 90),      // 70% crash threshold
    crashBtcDistPct: envNum(process.env.CUT_LOSS_CRASH_BTC_DIST_PCT, 0.50, 0.01, 5.0), // BTC must move 0.5%+ against
    evBuffer: envNum(process.env.CUT_LOSS_EV_BUFFER, 0.50, 0.05, 1.50),        // model must say <50% of entry price = dead
    mlFlipConfidence: envNum(process.env.CUT_LOSS_ML_FLIP_CONF, 0.92, 0.40, 0.99), // ML must be 92%+ sure of flip
    persistentDropPct: envNum(process.env.CUT_LOSS_PERSISTENT_DROP_PCT, 65, 5, 90), // 65%+ for 10min = truly dead
    persistentDropMinutes: envNum(process.env.CUT_LOSS_PERSISTENT_DROP_MIN, 10, 1, 30),
    maxLossOfCostPct: envNum(process.env.CUT_LOSS_MAX_LOSS_OF_COST_PCT, 90, 20, 99), // only at 90% capital loss
    trailingStopActivationPct: envNum(process.env.CUT_LOSS_TRAILING_ACTIVATION_PCT, 30, 5, 50), // need 30%+ gain first
    trailingStopDropPct: envNum(process.env.CUT_LOSS_TRAILING_DROP_PCT, 70, 20, 90),            // 70% give-back from peak
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
    minTokenPrice: envNum(process.env.RECOVERY_MIN_TOKEN_PRICE, 0.55, 0.30, 0.95),     // Audit v5 M5: 0.70→0.55 — at 70¢ recovery never triggers (need 112% rally from 33¢ cut); 55¢ allows actual recovery at cheaper price
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
    riskPct: envNum(process.env.PREMARKET_LONG_RISK_PCT, 0.10, 0.01, 0.50),          // 10% portfolio — aggressive pre-market entry
    // take-profit removed — full hold to settlement
    maxEntryPrice: envNum(process.env.PREMARKET_LONG_MAX_ENTRY_PRICE, 0.60, 0.30, 0.80), // max 60c — don't buy expensive tokens
    windowStartH: envInt(process.env.PREMARKET_LONG_WINDOW_START_H, 9, 0, 23),       // 09:00 EST
    windowStartM: envInt(process.env.PREMARKET_LONG_WINDOW_START_M, 0, 0, 59),
    windowEndH: envInt(process.env.PREMARKET_LONG_WINDOW_END_H, 9, 0, 23),           // 09:15 EST
    windowEndM: envInt(process.env.PREMARKET_LONG_WINDOW_END_M, 15, 0, 59),
    // stop-loss removed — hold to settlement (settlement WR 87.5%)
  },

  // Limit order strategy — passive entry at optimal prices (GTD orders at 55-65¢)
  // Places limit orders early in market (0:30-5:00), cancels at 10 min if unfilled → FOK fallback
  // At 58¢ entry: only need 58% WR to break even (vs 75% at 75¢ FOK) → can be aggressive
  limitOrder: {
    enabled: process.env.LIMIT_ORDER_ENABLED === 'true',
    minElapsedMin: envNum(process.env.LIMIT_MIN_ELAPSED_MIN, 0.5, 0, 5),
    maxElapsedMin: envNum(process.env.LIMIT_MAX_ELAPSED_MIN, 9.0, 1, 12),         // v4: 7→9 min — wider LIMIT window, data: LIMIT 69.4% WR >> FOK, more opportunity
    maxEntryPrice: envNum(process.env.LIMIT_MAX_ENTRY_PRICE, 0.58, 0.40, 0.75),   // v4: 60→58¢ — data: 55-58c 73.3% WR, 59-62c drops to 60% WR
    minEntryPrice: envNum(process.env.LIMIT_MIN_ENTRY_PRICE, 0.50, 0.30, 0.60),
    priceTierHigh: envNum(process.env.LIMIT_PRICE_TIER_HIGH, 0.58, 0.50, 0.70),   // v4: 60→58¢ — even ML≥85% should not overpay; 58c needs 58% WR (easy)
    priceTierMid: envNum(process.env.LIMIT_PRICE_TIER_MID, 0.55, 0.45, 0.65),     // v4: 56→55¢ — ML 70-85%: tighter, need 55% WR
    priceTierLow: envNum(process.env.LIMIT_PRICE_TIER_LOW, 0.52, 0.40, 0.60),     // 52¢ — ML 60-70%: need 52% WR (unchanged)
    minMlConfidence: envNum(process.env.LIMIT_MIN_ML_CONF, 0.62, 0.40, 0.90),     // Audit v5 H2: 0.58→0.62 — at 58% entry, break-even WR ≈ 60.5% (after costs); 62% ML provides ~2% edge margin
    cancelAfterElapsedMin: envNum(process.env.LIMIT_CANCEL_AFTER_MIN, 9.0, 5, 14),  // v4: 7→9 min — let limit orders live longer before FOK fallback
    partialFillAcceptRatio: envNum(process.env.LIMIT_PARTIAL_ACCEPT, 0.60, 0.30, 1.0),
    expirationBufferSec: envInt(process.env.LIMIT_EXPIRATION_BUFFER_SEC, 120, 30, 300),
    minEvalPolls: envInt(process.env.LIMIT_MIN_EVAL_POLLS, 1, 1, 10),             // 3→1 — faster placement, ML is stable enough
    checkIntervalMs: envInt(process.env.LIMIT_CHECK_INTERVAL_MS, 2000, 500, 10000),
  },

  // Smart Order Router v2 — 7-rule decision tree with spread + relative momentum + regime
  orderRouter: {
    enabled:               process.env.ORDER_ROUTER_ENABLED !== 'false',
    fokMlThreshold:        envNum(process.env.ROUTER_FOK_ML, 0.88, 0.70, 0.95),          // v3: 0.80→0.88 — LIMIT 81% WR >> FOK 71%, reserve FOK for very-high ML only
    fokMaxPrice:           envNum(process.env.ROUTER_FOK_MAX_PRICE, 0.58, 0.50, 0.75),   // v3: 0.62→0.58 — tighter FOK price cap, push more to LIMIT
    fokMaxPriceTrending:   envNum(process.env.ROUTER_FOK_MAX_PRICE_TREND, 0.68, 0.60, 0.85),  // v3: 0.75→0.68 — even trending should prefer LIMIT unless very cheap
    cheapPriceThreshold:   envNum(process.env.ROUTER_CHEAP_PRICE, 0.52, 0.45, 0.65),     // v3: 0.55→0.52 — only truly cheap tokens get FOK
    cheapMlThreshold:      envNum(process.env.ROUTER_CHEAP_ML, 0.75, 0.55, 0.85),        // v3: 0.70→0.75 — raise ML bar for cheap FOK
    momentumRelThreshold:  envNum(process.env.ROUTER_MOMENTUM_REL, 0.0007, 0.0003, 0.003), // v2: $30 fixed→0.07% relative (~$47 at $67K)
    spreadNarrowThreshold: envNum(process.env.ROUTER_SPREAD_NARROW, 0.03, 0.01, 0.06),     // v2: <3% = narrow, limit gives no discount
    spreadWideThreshold:   envNum(process.env.ROUTER_SPREAD_WIDE, 0.03, 0.02, 0.10),       // v2: ≥3% = wide, real discount available
    upgradeMLThreshold:    envNum(process.env.ROUTER_UPGRADE_ML, 0.90, 0.80, 0.95),
    upgradeHoldSec:        envNum(process.env.ROUTER_UPGRADE_HOLD_SEC, 60, 20, 180),       // v2: 30→60s — prevent premature limit cancel
  },

  // Monte Carlo simulation (Quant risk assessment)
  // GBM price path simulation → independent P(UP) + tail risk + sizing multiplier
  monteCarlo: {
    enabled: process.env.MC_ENABLED !== 'false',
    numPaths: envInt(process.env.MC_NUM_PATHS, 1000, 100, 10000),
    numSteps: envInt(process.env.MC_NUM_STEPS, 20, 5, 100),
    // Gate: block when MC P(betSide) below this threshold
    minAgreementProb: envNum(process.env.MC_MIN_AGREEMENT, 0.35, 0.10, 0.50),
    // Tail risk: block when P(adverse extreme >0.5%) exceeds this
    maxTailRisk: envNum(process.env.MC_MAX_TAIL_RISK, 0.55, 0.01, 1.0),
  },

  // MetEngine smart money API (x402, Solana USDC payments)
  // F1: consensus ≥ blockConsensusStrength against us → BLOCK
  // F2: top insider score ≥ boostInsiderScore on opp side → BLOCK
  // F3: consensus ≥ convictionBlockStrength AND conviction wallet (score≥convictionScoreMin, USDC≥convictionMinUSDC, non-hedger) → BLOCK
  // F1b: consensus ≥ 85% of F1 threshold AND dumb money contrarian → BLOCK
  // Cost: ~$0.01–0.05/request, cached 90s per market → ~$0.50–1.00/day
  // AI Agent — OpenRouter-powered trade analysis + self-optimization
  // Uses OpenRouter API (supports Claude, Gemini, GPT, etc.) for:
  // 1. Post-trade analysis: journal pattern detection every analyzeIntervalMs
  // 2. Self-optimization: auto-tune .env params (requires AI_AUTO_OPTIMIZE=true)
  // 3. Sentiment signal: Fear & Greed + BTC Dominance (free APIs, no key needed)
  // Cost: ~$0.001/day with Gemini Flash on OpenRouter
  ai: {
    enabled: process.env.AI_AGENT_ENABLED === 'true',
    apiKey: process.env.OPENROUTER_API_KEY || '',
    model: process.env.AI_MODEL || 'google/gemini-2.0-flash-001',
    maxTokens: envInt(process.env.AI_MAX_TOKENS, 2000, 100, 8000),
    timeoutMs: envInt(process.env.AI_TIMEOUT_MS, 30000, 3000, 60000),
    rateLimitPerMin: envInt(process.env.AI_RATE_LIMIT, 10, 1, 60),
    analyzeIntervalMs: envInt(process.env.AI_ANALYZE_INTERVAL_MS, 4 * 60 * 60 * 1000, 60_000, 24 * 60 * 60 * 1000),
    autoOptimize: process.env.AI_AUTO_OPTIMIZE === 'true',
    sentimentEnabled: process.env.SENTIMENT_ENABLED !== 'false',  // on by default (free APIs)
    sentimentCacheMs: envInt(process.env.SENTIMENT_CACHE_MS, 5 * 60 * 1000, 60_000, 30 * 60 * 1000),
  },

  metEngine: {
    enabled: process.env.METENGINE_ENABLED === 'true',
    baseUrl: process.env.METENGINE_BASE_URL || 'https://agent.metengine.xyz',
    solanaPrivateKey: process.env.SOLANA_PRIVATE_KEY || '',
    cacheTtlMs: 90_000,       // 90s per conditionId — don't re-query mid-market
    timeoutMs: 5_000,         // 5s timeout — don't hold up trade loop
    blockConsensusStrength:  envNum(process.env.METENGINE_BLOCK_STRENGTH,      0.65, 0, 1),      // F1: strong consensus block
    boostInsiderScore:       envNum(process.env.METENGINE_BOOST_SCORE,        75, 0, 200),      // F2: insider score threshold
    convictionBlockStrength: envNum(process.env.METENGINE_CONVICTION_STRENGTH, 0.60, 0, 1),     // F3: medium consensus gate
    convictionScoreMin:      envNum(process.env.METENGINE_CONVICTION_SCORE,   90, 0, 200),      // F3: min wallet score
    convictionMinUSDC:       envNum(process.env.METENGINE_CONVICTION_USDC,    50, 0, 100000),   // F3: min USDC invested
  },
};

export { CONFIG, BET_SIZING, BOT_CONFIG, WS_DEFAULTS, WS_POLYMARKET_LIVE, WS_CHAINLINK };
