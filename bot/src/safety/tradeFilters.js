/**
 * Smart trade filters — reject trades in historically losing conditions.
 *
 * Filters (each returns { pass, reason }):
 * 1. ML Confidence gate — only trade when ML is confident
 * 2. Market near 50/50 — random walk territory, no edge
 * 3. Low volatility — price won't move enough to resolve
 * 4. Cooldown after loss — avoid tilt/revenge trading
 * 5. Min time remaining — too close to settlement = noise
 * 6. Session quality — weekend/off-hours penalty
 */

import { TRADE_FILTERS } from '../../../src/config.js';
import { createLogger } from '../logger.js';

const log = createLogger('Filter');

// Module state for cooldown tracking
let lastLossTimestamp = 0;
let tradesThisMarket = {};  // { [slug]: count }

// Session quality: US session and EU/US overlap are highest quality
// Off-hours and weekends have lower liquidity → lower reliability
const SESSION_QUALITY = {
  'US':           1.0,
  'EU/US Overlap': 1.0,
  'Europe':       0.9,
  'Asia':         0.85,
  'Off-hours':    0.7,
};

/**
 * Run all trade filters. Returns { pass: boolean, reasons: string[], sessionQuality: number }
 */
export function applyTradeFilters({
  mlConfidence,
  mlAvailable,
  marketPrice,     // the side's market price (e.g. marketUp if buying UP)
  atrRatio,
  timeLeftMin,
  marketSlug,
  consecutiveLosses,
  session,         // trading session name from getSessionName()
  btcPrice,        // current BTC price (for distance check)
  priceToBeat,     // PTB for current market (for distance check)
}) {
  const reasons = [];

  // 1. ML Confidence gate
  if (mlAvailable && mlConfidence != null) {
    if (mlConfidence < TRADE_FILTERS.MIN_ML_CONFIDENCE) {
      reasons.push(`ML conf ${(mlConfidence * 100).toFixed(0)}% < ${(TRADE_FILTERS.MIN_ML_CONFIDENCE * 100).toFixed(0)}%`);
    }
  }

  // 2. Market near 50/50 (random walk — no edge)
  const [lo, hi] = TRADE_FILTERS.MARKET_5050_RANGE;
  if (marketPrice != null && marketPrice >= lo && marketPrice <= hi) {
    reasons.push(`Market ${(marketPrice * 100).toFixed(0)}c near 50/50 (${(lo*100).toFixed(0)}-${(hi*100).toFixed(0)}c)`);
  }

  // 2b. Extreme contrarian filter — reject entries where market price is very low/high
  // Buying at <25c or >75c means the market strongly disagrees with the model.
  // The model needs to be MUCH more accurate than the market to profit on these.
  const priceRange = TRADE_FILTERS.MARKET_PRICE_RANGE;
  if (priceRange && marketPrice != null && (marketPrice < priceRange[0] || marketPrice > priceRange[1])) {
    reasons.push(`Extreme price ${(marketPrice * 100).toFixed(0)}c outside ${(priceRange[0]*100).toFixed(0)}-${(priceRange[1]*100).toFixed(0)}c range`);
  }

  // 3. Low volatility
  if (atrRatio != null && atrRatio < TRADE_FILTERS.MIN_ATR_RATIO) {
    reasons.push(`Low vol: ATR ratio ${atrRatio.toFixed(2)} < ${TRADE_FILTERS.MIN_ATR_RATIO}`);
  }

  // 4. Min time remaining
  if (timeLeftMin != null && timeLeftMin < TRADE_FILTERS.MIN_TIME_LEFT_MIN) {
    reasons.push(`Too close: ${timeLeftMin.toFixed(1)}min < ${TRADE_FILTERS.MIN_TIME_LEFT_MIN}min`);
  }

  // 4b. Max time remaining (early bird filter — indicators stale, BTC near PTB)
  if (TRADE_FILTERS.MAX_TIME_LEFT_MIN && timeLeftMin != null && timeLeftMin > TRADE_FILTERS.MAX_TIME_LEFT_MIN) {
    reasons.push(`Too early: ${timeLeftMin.toFixed(1)}min left > ${TRADE_FILTERS.MAX_TIME_LEFT_MIN}min (wait for price discovery)`);
  }

  // 4c. BTC distance from PTB minimum (below = coin flip, no directional edge)
  if (TRADE_FILTERS.MIN_BTC_DIST_PCT && btcPrice != null && priceToBeat != null && priceToBeat > 0) {
    const btcDistPct = Math.abs(btcPrice - priceToBeat) / priceToBeat * 100;
    if (btcDistPct < TRADE_FILTERS.MIN_BTC_DIST_PCT) {
      reasons.push(`BTC too close to PTB: ${btcDistPct.toFixed(3)}% < ${TRADE_FILTERS.MIN_BTC_DIST_PCT}% (coin flip)`);
    }
  }

  // 5. Cooldown after loss
  if (lastLossTimestamp > 0) {
    const elapsed = Date.now() - lastLossTimestamp;
    if (elapsed < TRADE_FILTERS.LOSS_COOLDOWN_MS) {
      const remaining = ((TRADE_FILTERS.LOSS_COOLDOWN_MS - elapsed) / 1000).toFixed(0);
      reasons.push(`Loss cooldown: ${remaining}s remaining`);
    }
  }

  // 6. Max trades per market
  const marketCount = tradesThisMarket[marketSlug] ?? 0;
  if (marketCount >= TRADE_FILTERS.MAX_TRADES_PER_MARKET) {
    reasons.push(`Max ${TRADE_FILTERS.MAX_TRADES_PER_MARKET} trade(s) per market reached`);
  }

  // 7. Weekend low-liquidity filter (Saturday/Sunday UTC)
  // Relaxed: require ML confidence >= 0.35 on weekends (was 0.50 — too aggressive,
  // blocked most entries since ML confidence typically hovers 40-55%)
  const dayOfWeek = new Date().getUTCDay();
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
  if (isWeekend && Number.isFinite(mlConfidence) && mlConfidence < 0.35) {
    reasons.push(`Weekend + low ML conf ${(mlConfidence * 100).toFixed(0)}%`);
  }

  // Session quality score (used as multiplier downstream, not a hard filter)
  const sessionQuality = SESSION_QUALITY[session] ?? 0.85;

  const pass = reasons.length === 0;
  if (!pass) {
    log.info(`Filtered: ${reasons.join(' | ')}`);
  }

  return { pass, reasons, sessionQuality };
}

/**
 * Record a loss event (triggers cooldown).
 */
export function recordLoss() {
  lastLossTimestamp = Date.now();
}

/**
 * Record a trade for per-market limit tracking.
 */
export function recordTradeForMarket(slug) {
  tradesThisMarket[slug] = (tradesThisMarket[slug] ?? 0) + 1;
}

/**
 * Reset per-market trade count (on market switch).
 */
export function resetMarketTradeCount(slug) {
  if (slug) {
    delete tradesThisMarket[slug];
  } else {
    tradesThisMarket = {};
  }
}

/**
 * Get filter status for dashboard broadcast.
 */
export function getFilterStatus() {
  const cooldownActive = lastLossTimestamp > 0 &&
    (Date.now() - lastLossTimestamp) < TRADE_FILTERS.LOSS_COOLDOWN_MS;
  return {
    cooldownActive,
    cooldownRemainingMs: cooldownActive
      ? TRADE_FILTERS.LOSS_COOLDOWN_MS - (Date.now() - lastLossTimestamp)
      : 0,
    marketTradeCounts: { ...tradesThisMarket },
  };
}
