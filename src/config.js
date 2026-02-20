export const ML_CONFIDENCE = { HIGH: 0.60, MEDIUM: 0.20 };  // v4: HIGH raised back to 0.60 aligned with MIN_ML_CONFIDENCE

export const WS_DEFAULTS = { throttleMs: 500, reconnectMaxMs: 10_000, heartbeatCheckMs: 10_000 };
export const WS_BINANCE = { heartbeatDeadMs: 20_000, heartbeatCheckMs: 5_000 };
export const WS_CHAINLINK = { pingMs: 15_000, heartbeatDeadMs: 45_000 };
export const WS_POLYMARKET_LIVE = { pingMs: 15_000, heartbeatDeadMs: 30_000 };
export const WS_CLOB = { heartbeatDeadMs: 15_000, subWatchdogMs: 5_000, dataStaleMs: 20_000 };

export const BET_SIZING = {
  KELLY_FRACTION: 0.15,
  MAX_BET_PCT: 0.05,
  MIN_BET_PCT: 0.003,
  MIN_EDGE_FOR_BET: 0.02,
  DEFAULT_BANKROLL: 1000,
  BANKROLL_STORAGE_KEY: 'btc15m_bankroll',
};

export const ARBITRAGE = {
  MIN_NET_PROFIT: 0.005,       // 0.5% minimum net profit to trigger
  FEE_RATE: 0.02,              // Polymarket 2% fee on profit
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
  FOK_SLIPPAGE: 0.01,          // 1¢ slippage tolerance on FOK buy limit price
};

export const TRADE_FILTERS = {
  MIN_ML_CONFIDENCE: 0.58,       // 0.60→0.58 — model avg conf 58%, gate 0.60 blocked 74% of trades
  MARKET_5050_RANGE: [0.47, 0.53], // widened — 47-53c is genuinely uncertain/random-walk territory
  MARKET_PRICE_RANGE: [0.15, 0.85], // reject extreme contrarian entries
  MIN_ATR_RATIO: 0.3,           // minimum ATR ratio for volatility (below = no edge)
  MIN_TIME_LEFT_MIN: 2.0,       // minimum minutes before settlement
  MAX_TIME_LEFT_MIN: 14.5,      // relaxed from 14.0 — open 30s earlier for early signals
  MIN_BTC_DIST_PCT: 0.04,       // raised 0.015→0.04 — at $90k BTC, 0.015% = $13 from PTB = near coin-flip
  LOSS_COOLDOWN_MS: 60_000,     // restored to 60s — 30s too short, allows immediate reentry into next market
  MAX_TRADES_PER_MARKET: 1,     // lowered from 2 — multi-leg entries have 46% WR vs 60% single-leg
  MIN_ENTRY_PRICE: 0.55,        // skip entries below 55c — data shows cheap-side entries lose consistently
  MAX_ENTRY_PRICE: 0.72,        // entries above 72c have 40% WR — expensive + low upside
  MAX_EDGE: 0.15,               // lowered from 0.20 — edge 15-20% has poor WR, model diverges too much
};

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