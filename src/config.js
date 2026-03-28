export const ML_CONFIDENCE = { HIGH: 0.58, MEDIUM: 0.20 };  // H3: aligned with MIN_ML_CONFIDENCE=0.58 — edge boost kicks in at same level as filter gate

export const WS_DEFAULTS = { throttleMs: 500, reconnectMaxMs: 10_000, heartbeatCheckMs: 10_000 };
export const WS_BINANCE = { heartbeatDeadMs: 20_000, heartbeatCheckMs: 5_000 };
export const WS_CHAINLINK = { pingMs: 15_000, heartbeatDeadMs: 45_000 };
export const WS_POLYMARKET_LIVE = { pingMs: 15_000, heartbeatDeadMs: 30_000 };
export const WS_CLOB = { heartbeatDeadMs: 15_000, subWatchdogMs: 5_000, dataStaleMs: 20_000 };

export const BET_SIZING = {
  KELLY_FRACTION: 0.15,           // Reduced 0.20→0.15 — portfolio $100+: lower base fraction, ~25% smaller typical bets
  MAX_BET_PCT: 0.05,              // Reduced 0.07→0.05 — hard 5% cap per trade at any bankroll size
  MIN_BET_PCT: 0.020,             // GC5a: 0.025→0.020 — allow smaller exploratory bets during uncertain conditions
  MIN_EDGE_FOR_BET: 0.02,
  DEFAULT_BANKROLL: 1000,
  BANKROLL_STORAGE_KEY: 'btc15m_bankroll',
};

export const ARBITRAGE = {
  MIN_NET_PROFIT: 0.005,       // 0.5% minimum net profit to trigger
  FEE_RATE: 0.018,             // Dynamic approx at p≈0.5: 0.072×0.5×0.5=0.018 (Mar-30-2026). Use polyFeeRate(p) for exact.
  MAX_SPREAD: 0.08,            // raised 0.05→0.08 — whale bots (PBot1/gabagool22) operate at 45-49c/side where spread is 5-10%
  MAX_SPREAD_HIGH_PROFIT: 0.12, // allow up to 12% spread when netProfit >3% (high margin justifies wide book)
};

export const EXECUTION = {
  SPREAD_TIGHT: 0.02,          // <2% = tight spread (mult 1.0)
  SPREAD_NORMAL: 0.03,         // 2-3% = normal (mult 0.85)
  SPREAD_WIDE: 0.05,           // 3-5% = wide (mult 0.75), >5% = very wide (0.60)
  LIQ_VERY_THIN: 50,           // <$50 depth (mult 0.50)
  LIQ_THIN: 200,               // $50-200 (mult 0.70)
  LIQ_MODERATE: 500,           // $200-500 (mult 0.85)
  FILL_POOR_RATE: 0.5,         // <50% fill rate (mult 0.70)
  FILL_TIMEOUT_MS: 30_000,     // 30s stale order timeout
  FOK_SLIPPAGE: 0.005,         // GC4: 1¢→0.5¢ slippage tolerance — saves ~$0.30/trade at 65c entry
};

export const TRADE_FILTERS = {
  MIN_ML_CONFIDENCE: 0.65,       // 0.58→0.65 — fewer but higher-quality entries; 58% let too many uncertain trades through
  MARKET_5050_RANGE: [0.47, 0.53], // widened — 47-53c is genuinely uncertain/random-walk territory
  MARKET_PRICE_RANGE: [0.15, 0.85], // reject extreme contrarian entries
  MIN_ATR_RATIO: 0.3,           // minimum ATR ratio for volatility (below = no edge)
  MIN_TIME_LEFT_MIN: 2.0,       // minimum minutes before settlement
  MAX_TIME_LEFT_MIN: 12.0,      // GC3: 14.5→12.0 — block entries before 3min elapsed (early entries have lower WR)
  MIN_BTC_DIST_PCT: 0.04,       // raised 0.015→0.04 — at $90k BTC, 0.015% = $13 from PTB = near coin-flip
  LOSS_COOLDOWN_MS: 60_000,     // Audit v2 M3: 120s→60s — 120s spans market boundaries in 15-min markets, causing missed entries
  MAX_TRADES_PER_MARKET: 2,     // Audit v2 C1: 3→2 — data shows multi-leg WR 46%; allow 1 re-entry only with conditional gate in tradeFilters
  REENTRY_MIN_EDGE: 0.12,       // Audit v2 C1: re-entry requires ≥12% edge (higher bar than first entry)
  MIN_ENTRY_PRICE: 0.50,        // 58→50c — allow cheaper entries with better risk/reward (win 50c vs lose 50c = 50% WR break-even)
  MAX_ENTRY_PRICE: 0.63,        // 68→63c — at 63c: win 37c lose 63c, need 63% WR (achievable). 68c needed 68% WR (too hard)
  MAX_EDGE: 0.25,               // Quant fix L4: 0.18→0.25 — spread/fee already penalize edge; blanket cap blocks genuine high-EV opportunities
  BLACKOUT_HOURS_ET: [16, 17, 18, 19, 20, 21, 22, 23], // RE-ENABLED — data shows 31.6% WR during 16-23 ET
  MAX_ENTRY_SPREAD_PCT: 8,    // hard reject: spread > 8%
  SPREAD_EDGE_MIN: 8,         // soft: spread > 4% needs edge ≥ 8%
  VPIN_BLOCK_THRESHOLD: 0.70, // VPIN > 70% + opposing flow = informed trader, block entry
  SPREAD_WIDEN_RATIO: 2.0,    // spread > 2× baseline = sudden widening, block entry
};

/**
 * Polymarket dynamic taker fee rate (March 30, 2026 update).
 * Formula: feeRate = 0.072 × p × (1−p)  [exponent changed 2→1, feeRate 0.25→0.072]
 * Max ~1.80% at p=0.50; at typical entry 60-75c → actual 1.1-1.4%.
 * Maker (limit) orders: 20% rebate for Crypto category → effective 0.0576×p×(1-p).
 * Old formula (pre-Mar 30): 0.25 × (p×(1−p))² — max 1.56% at p=0.50.
 * @param {number} price - token price (0-1)
 * @returns {number} taker fee rate as decimal (0 to ~0.018)
 */
export function polyFeeRate(price) {
  if (!Number.isFinite(price) || price <= 0 || price >= 1) return 0;
  return 0.072 * price * (1 - price);
}

export const CONFIG = {
  symbol: 'BTCUSDT',
  binanceWsUrl: 'wss://data-stream.binance.vision/ws/btcusdt@trade',
  binanceBaseUrl: '/binance-api',
  gammaBaseUrl: '/gamma-api',
  clobBaseUrl: '/clob-api',

  // ═══ Reverted to 5s — safe now because CLOB REST is skipped when WS connected ═══
  pollIntervalMs: 3_000,
  candleWindowMinutes: 15,

  // ═══ Market discovery also 5s ═══
  marketDiscoveryIntervalMs: 5_000,

  // ═══ REWORKED: Tuned for 15-minute Polymarket window ═══
  vwapLookbackCandles: 60,      // 60 × 1m = 1 hour (was 240 = 4hr)
  vwapSlopeLookbackMinutes: 5,
  rsiPeriod: 8,                 // faster response (was 14)
  rsiMaPeriod: 8,

  macdFast: 6,                  // fast EMA 6 min (was 12)
  macdSlow: 13,                 // slow EMA 13 min (was 26)
  macdSignal: 5,                // signal 5 (was 9)

  polymarket: {
    seriesId: '10192',
    seriesSlug: 'btc-updown-15m',
    autoSelectLatest: true,
    liveDataWsUrl: 'wss://ws-live-data.polymarket.com',
    clobWsUrl: 'wss://ws-subscriptions-clob.polymarket.com/ws/market',
    clobPingIntervalMs: 10_000,
    upOutcomeLabel: 'Up',
    downOutcomeLabel: 'Down',
  },

  chainlink: {
    // ═══ FIX: Only 1 RPC to avoid hammering multiple endpoints ═══
    polygonRpcUrls: [
      'https://polygon-rpc.com',
    ],
    polygonWssUrls: [
      'wss://polygon-bor-rpc.publicnode.com',
    ],
    btcUsdAggregator: '0xc907E116054Ad103354f2D350FD2514433D57F6f',
    decimals: 8,
    // ═══ FIX: Cache RPC results longer since WSS is primary ═══
    rpcCacheMs: 30_000,
  },
};