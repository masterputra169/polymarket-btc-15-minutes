export const ML_CONFIDENCE = { HIGH: 0.40, MEDIUM: 0.20 };

export const WS_DEFAULTS = { throttleMs: 500, reconnectMaxMs: 10_000, heartbeatCheckMs: 10_000 };
export const WS_BINANCE = { heartbeatDeadMs: 20_000, heartbeatCheckMs: 5_000 };
export const WS_CHAINLINK = { pingMs: 15_000, heartbeatDeadMs: 45_000 };
export const WS_POLYMARKET_LIVE = { pingMs: 15_000, heartbeatDeadMs: 30_000 };
export const WS_CLOB = { heartbeatDeadMs: 15_000, subWatchdogMs: 5_000, dataStaleMs: 20_000 };

export const BET_SIZING = {
  KELLY_FRACTION: 0.25,
  MAX_BET_PCT: 0.08,
  MIN_BET_PCT: 0.005,
  MIN_EDGE_FOR_BET: 0.03,
  DEFAULT_BANKROLL: 1000,
  BANKROLL_STORAGE_KEY: 'btc15m_bankroll',
};

export const ARBITRAGE = {
  MIN_NET_PROFIT: 0.005,       // 0.5% minimum net profit to trigger
  FEE_RATE: 0.02,              // Polymarket 2% fee on profit
  MAX_SPREAD: 0.05,            // max 5% spread for reliable arb
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
};

export const TRADE_FILTERS = {
  MIN_ML_CONFIDENCE: 0.50,       // minimum ML confidence to trade (raised from 0.40 — below 50% means model is literally unsure)
  MARKET_5050_RANGE: [0.45, 0.55], // market price in this range = near 50/50, skip
  MARKET_PRICE_RANGE: [0.15, 0.85], // reject extreme contrarian entries (widened from 0.25-0.75 — 15-min markets naturally have extreme prices)
  MIN_ATR_RATIO: 0.3,           // minimum ATR ratio for volatility (below = no edge)
  MIN_TIME_LEFT_MIN: 2.0,       // minimum minutes before settlement
  MAX_TIME_LEFT_MIN: 13.0,      // maximum minutes before settlement (block first 2 min — PTB just set, indicators stale)
  MIN_BTC_DIST_PCT: 0.05,       // minimum BTC distance from PTB to enter (below = coin flip, no directional edge)
  LOSS_COOLDOWN_MS: 60_000,     // 60s cooldown after a loss before next trade
  MAX_TRADES_PER_MARKET: 1,     // max directional trades per 15-min market
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