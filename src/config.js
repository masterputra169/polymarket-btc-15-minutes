export const ML_CONFIDENCE = { HIGH: 0.55, MEDIUM: 0.20 };  // v3: HIGH 0.60→0.55 aligned with MIN_ML_CONFIDENCE

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
  FOK_SLIPPAGE: 0.01,          // 1¢ slippage tolerance on FOK buy limit price
};

export const TRADE_FILTERS = {
  MIN_ML_CONFIDENCE: 0.55,       // lowered from 0.60 — ML 55-60% still profitable, opens more trade opportunities
  MARKET_5050_RANGE: [0.49, 0.51], // narrowed from [0.48,0.52] — 47-53c still has tradeable edge
  MARKET_PRICE_RANGE: [0.15, 0.85], // reject extreme contrarian entries
  MIN_ATR_RATIO: 0.3,           // minimum ATR ratio for volatility (below = no edge)
  MIN_TIME_LEFT_MIN: 2.0,       // minimum minutes before settlement
  MAX_TIME_LEFT_MIN: 14.5,      // relaxed from 14.0 — open 30s earlier for early signals
  MIN_BTC_DIST_PCT: 0.015,      // lowered from 0.02 — redundant with 50/50 filter + edge threshold
  LOSS_COOLDOWN_MS: 30_000,     // halved from 60s — 30s enough for anti-tilt, 60s skips entire market
  MAX_TRADES_PER_MARKET: 2,     // raised from 1 — allow re-entry on signal change within same market
  MIN_ENTRY_PRICE: 0.55,        // skip entries below 55c — data shows cheap-side entries lose consistently
  BLACKOUT_HOURS_ET: [3, 7, 9, 10], // skip these ET hours — consistently negative P&L in 94-trade dataset
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