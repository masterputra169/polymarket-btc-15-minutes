export const ML_CONFIDENCE = { HIGH: 0.58, MEDIUM: 0.20 };  // H3: aligned with MIN_ML_CONFIDENCE=0.58 — edge boost kicks in at same level as filter gate

export const WS_DEFAULTS = { throttleMs: 500, reconnectMaxMs: 10_000, heartbeatCheckMs: 10_000 };
export const WS_BINANCE = { heartbeatDeadMs: 20_000, heartbeatCheckMs: 5_000 };
export const WS_CHAINLINK = { pingMs: 15_000, heartbeatDeadMs: 45_000 };
export const WS_POLYMARKET_LIVE = { pingMs: 15_000, heartbeatDeadMs: 30_000 };
export const WS_CLOB = { heartbeatDeadMs: 15_000, subWatchdogMs: 5_000, dataStaleMs: 20_000 };

export const BET_SIZING = {
  KELLY_FRACTION: 0.15,
  MAX_BET_PCT: 0.05,
  MIN_BET_PCT: 0.025,            // Quant fix M1: 0.01→0.025 — at $45 bankroll 1%=$0.45 < Polymarket $1 min; 2.5%=$1.13 safely above
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
  LOSS_COOLDOWN_MS: 60_000,     // Audit v2 M3: 120s→60s — 120s spans market boundaries in 15-min markets, causing missed entries
  MAX_TRADES_PER_MARKET: 2,     // Audit v2 C1: 3→2 — data shows multi-leg WR 46%; allow 1 re-entry only with conditional gate in tradeFilters
  REENTRY_MIN_EDGE: 0.12,       // Audit v2 C1: re-entry requires ≥12% edge (higher bar than first entry)
  MIN_ENTRY_PRICE: 0.58,        // user override to 58c (has edge ≥ 8% bypass for lower prices)
  MAX_ENTRY_PRICE: 0.72,        // entries above 72c have 40% WR — expensive + low upside
  MAX_EDGE: 0.25,               // Quant fix L4: 0.18→0.25 — spread/fee already penalize edge; blanket cap blocks genuine high-EV opportunities
  BLACKOUT_HOURS_ET: [3, 7, 8, 10, 18, 19], // data-driven (226 trades): block losing hours only. Opened 0-2,4-6,22-23 (+$35 profit). Blocked 8,10,18,19 (-$10 losses)
  MAX_ENTRY_SPREAD_PCT: 8,    // hard reject: spread > 8%
  SPREAD_EDGE_MIN: 8,         // soft: spread > 4% needs edge ≥ 8%
  VPIN_BLOCK_THRESHOLD: 0.70, // VPIN > 70% + opposing flow = informed trader, block entry
  SPREAD_WIDEN_RATIO: 2.0,    // spread > 2× baseline = sudden widening, block entry
};

/**
 * Polymarket dynamic taker fee rate (Feb 2026 update).
 * Formula: feeRate = 0.25 × (p × (1−p))²
 * Max ~1.56% at p=0.50, decreases toward extreme prices.
 * Old flat 2% was over-conservative at our entry range (58-72c → actual 1.0-1.5%).
 * @param {number} price - token price (0-1)
 * @returns {number} fee rate as decimal (0 to ~0.0156)
 */
export function polyFeeRate(price) {
  if (!Number.isFinite(price) || price <= 0 || price >= 1) return 0;
  const pq = price * (1 - price);
  return 0.25 * pq * pq;
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