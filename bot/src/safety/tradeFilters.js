/**
 * Smart trade filters — reject trades in historically losing conditions.
 *
 * Filters (each returns { pass, reason }):
 * 1. ML Confidence gate — only trade when ML is confident
 * 2. Market near 50/50 — random walk territory, no edge
 * 2b. Extreme contrarian — market price outside safe range
 * 3. Low volatility — price won't move enough to resolve
 * 4. Min/max time remaining — too close/early for settlement
 * 4c. BTC distance from PTB — coin flip territory
 * 5. Cooldown after loss — avoid tilt/revenge trading
 * 6. Max trades per market
 * 7. Weekend low-liquidity
 * 8. Edge ceiling — hard cap at 20% for all regimes (high edge = 0-14% WR)
 * 9. Counter-trend momentum — don't fight strong BTC moves
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
  tiltMlConfMin,   // raised ML confidence threshold during tilt protection (null = inactive)
  bestEdge,        // best edge from edge engine (model prob - market price)
  delta1m,         // BTC 1-minute price delta ($)
  signalSide,      // the side we want to enter ('UP'|'DOWN')
  regime,          // market regime ('trending'|'choppy'|'mean_reverting'|'moderate')
  etHour,          // current ET hour (0-23) for blackout filter
  spread,          // orderbook spread for bet-side token (decimal, e.g. 0.05 = 5%)
  mlAccuracy,      // ML-specific accuracy from getMLAccuracy() (0-1 or null)
}) {
  const reasons = [];

  // 1. ML Confidence gate
  // During tilt protection (post-cut-loss), use the higher threshold
  const mlConfMin = (tiltMlConfMin != null && tiltMlConfMin > TRADE_FILTERS.MIN_ML_CONFIDENCE)
    ? tiltMlConfMin
    : TRADE_FILTERS.MIN_ML_CONFIDENCE;
  if (mlAvailable && mlConfidence != null) {
    if (mlConfidence < mlConfMin) {
      const tiltTag = tiltMlConfMin != null ? ' [tilt]' : '';
      reasons.push(`ML conf ${(mlConfidence * 100).toFixed(0)}% < ${(mlConfMin * 100).toFixed(0)}%${tiltTag}`);
    }
  }

  // 1b. ML 75-80% dead zone — data (15 trades): 53.3% WR, -$4.54
  // This confidence band is unreliable; require strong edge to compensate.
  // 80%+ ML unaffected (90.9% WR, no extra gate needed).
  if (mlAvailable && mlConfidence != null && mlConfidence >= 0.75 && mlConfidence < 0.80) {
    if (bestEdge == null || bestEdge < 0.10) {
      reasons.push(`ML dead zone: conf ${(mlConfidence * 100).toFixed(0)}% in 75-80% band, edge ${bestEdge != null ? (bestEdge * 100).toFixed(1) + '%' : 'N/A'} < 10% required`);
    }
  }

  // 2. Market near 50/50 (random walk — no edge)
  const [lo, hi] = TRADE_FILTERS.MARKET_5050_RANGE;
  if (marketPrice != null && marketPrice >= lo && marketPrice <= hi) {
    reasons.push(`Market ${(marketPrice * 100).toFixed(0)}c near 50/50 (${(lo*100).toFixed(0)}-${(hi*100).toFixed(0)}c)`);
  }

  // 2b. Extreme contrarian filter — reject entries where market price is very low/high
  // Buying at <15c or >85c means the market strongly disagrees with the model.
  // The model needs to be MUCH more accurate than the market to profit on these.
  // ML bypass: ≥85% confidence = high-conviction signal, allow extreme-price entries.
  // At 92c UP with ML 100%: EV = 0.96×$0.08 - 0.04×$0.92 = +$0.04/dollar (positive).
  const priceRange = TRADE_FILTERS.MARKET_PRICE_RANGE;
  if (priceRange && marketPrice != null && (marketPrice < priceRange[0] || marketPrice > priceRange[1])) {
    const mlBypass = mlConfidence != null && mlConfidence >= 0.85;
    if (!mlBypass) {
      reasons.push(`Extreme price ${(marketPrice * 100).toFixed(0)}c outside ${(priceRange[0]*100).toFixed(0)}-${(priceRange[1]*100).toFixed(0)}c range`);
    }
  }

  // 2c. Entry price floor — data shows entries below 55c are consistently unprofitable
  // H1: Allow low-price entries when edge >= 8% (strong model conviction overrides price filter)
  if (TRADE_FILTERS.MIN_ENTRY_PRICE && marketPrice != null && marketPrice < TRADE_FILTERS.MIN_ENTRY_PRICE) {
    const edgeBypass = bestEdge != null && bestEdge >= 0.08;
    if (!edgeBypass) {
      reasons.push(`Entry price ${(marketPrice * 100).toFixed(0)}c < ${(TRADE_FILTERS.MIN_ENTRY_PRICE * 100).toFixed(0)}c floor`);
    }
  }

  // 2d. Entry price ceiling — data shows entries above 72c have 40% WR (expensive + low upside)
  // H2: Allow expensive entries when ML confidence >= 75% (strong ML conviction overrides price filter)
  if (TRADE_FILTERS.MAX_ENTRY_PRICE && marketPrice != null && marketPrice > TRADE_FILTERS.MAX_ENTRY_PRICE) {
    const mlBypass = mlConfidence != null && mlConfidence >= 0.75;
    if (!mlBypass) {
      reasons.push(`Entry price ${(marketPrice * 100).toFixed(0)}c > ${(TRADE_FILTERS.MAX_ENTRY_PRICE * 100).toFixed(0)}c ceiling`);
    }
  }

  // 3. Low volatility
  if (atrRatio != null && atrRatio < TRADE_FILTERS.MIN_ATR_RATIO) {
    reasons.push(`Low vol: ATR ratio ${atrRatio.toFixed(2)} < ${TRADE_FILTERS.MIN_ATR_RATIO}`);
  }

  // 4. Min time remaining (NaN timeLeftMin = unknown → block entry for safety)
  if (timeLeftMin != null && !Number.isFinite(timeLeftMin)) {
    reasons.push('timeLeftMin is NaN — cannot verify timing');
  } else if (timeLeftMin != null && timeLeftMin < TRADE_FILTERS.MIN_TIME_LEFT_MIN) {
    reasons.push(`Too close: ${timeLeftMin.toFixed(1)}min < ${TRADE_FILTERS.MIN_TIME_LEFT_MIN}min`);
  }

  // 4b. Max time remaining (early bird filter — indicators stale, BTC near PTB)
  if (TRADE_FILTERS.MAX_TIME_LEFT_MIN && Number.isFinite(timeLeftMin) && timeLeftMin > TRADE_FILTERS.MAX_TIME_LEFT_MIN) {
    reasons.push(`Too early: ${timeLeftMin.toFixed(1)}min left > ${TRADE_FILTERS.MAX_TIME_LEFT_MIN}min (wait for price discovery)`);
  }

  // 4c. LATE/VERY_LATE phase ML gate — data: LATE 50% WR, -$1.63
  // Late entries need high ML confidence to justify reduced time for resolution.
  // EARLY/MID unaffected (76%/74% WR, working well).
  if (Number.isFinite(timeLeftMin) && timeLeftMin < 5) {
    const LATE_ML_MIN = 0.80;
    if (mlAvailable && mlConfidence != null && mlConfidence < LATE_ML_MIN) {
      reasons.push(`LATE phase ML gate: conf ${(mlConfidence * 100).toFixed(0)}% < ${LATE_ML_MIN * 100}% (${timeLeftMin.toFixed(1)}min left)`);
    }
  }

  // 4c. BTC distance from PTB minimum (below = coin flip, no directional edge)
  // Audit v2 H5: Time-adaptive — EARLY phase (>10min) uses 0.02% (more time for BTC to move),
  // LATE phase uses full 0.04%. Bypass when ML is very high confidence (>=80%).
  if (TRADE_FILTERS.MIN_BTC_DIST_PCT && btcPrice != null && priceToBeat != null && priceToBeat > 0) {
    const btcDistPct = Math.abs(btcPrice - priceToBeat) / priceToBeat * 100;
    const mlBypass = mlConfidence != null && mlConfidence >= 0.80;
    const timeAdaptedDist = (timeLeftMin != null && timeLeftMin > 10)
      ? TRADE_FILTERS.MIN_BTC_DIST_PCT * 0.5   // EARLY: halve threshold
      : (timeLeftMin != null && timeLeftMin > 5)
        ? TRADE_FILTERS.MIN_BTC_DIST_PCT * 0.75 // MID: 75% threshold
        : TRADE_FILTERS.MIN_BTC_DIST_PCT;        // LATE/VERY_LATE: full threshold
    if (!mlBypass && btcDistPct < timeAdaptedDist) {
      reasons.push(`BTC too close to PTB: ${btcDistPct.toFixed(3)}% < ${timeAdaptedDist.toFixed(3)}% (coin flip)`);
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

  // 6. Max trades per market + re-entry edge gate (Audit v2 C1)
  // First entry: normal edge threshold. Re-entry: requires REENTRY_MIN_EDGE (12%) to avoid revenge trading.
  const marketCount = tradesThisMarket[marketSlug] ?? 0;
  if (marketCount >= TRADE_FILTERS.MAX_TRADES_PER_MARKET) {
    reasons.push(`Max ${TRADE_FILTERS.MAX_TRADES_PER_MARKET} trade(s) per market reached`);
  } else if (marketCount >= 1 && bestEdge != null) {
    const reentryMinEdge = TRADE_FILTERS.REENTRY_MIN_EDGE ?? 0.12;
    if (bestEdge < reentryMinEdge) {
      reasons.push(`Re-entry blocked: edge ${(bestEdge * 100).toFixed(1)}% < ${(reentryMinEdge * 100).toFixed(0)}% (anti-revenge gate)`);
    }
  }

  // 7. Weekend low-liquidity filter (Saturday/Sunday UTC)
  // Block when ML unavailable (can't assess confidence) or confidence too low.
  const dayOfWeek = new Date().getUTCDay();
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
  if (isWeekend) {
    if (!mlAvailable || mlConfidence == null) {
      reasons.push('Weekend + ML unavailable — cannot assess confidence');
    } else if (mlConfidence < 0.65) {
      // v5: 0.35→0.65 — old threshold was below MIN_ML_CONFIDENCE (0.60), never triggered
      reasons.push(`Weekend + low ML conf ${(mlConfidence * 100).toFixed(0)}% < 65%`);
    }
  }

  // 8. Edge ceiling — configurable cap (default 15%) for ALL regimes.
  // Quant analysis (94 trades): edge 10-15% is sweet spot,
  // edge 15-20% has poor WR, edge 20%+ had 0-14% WR.
  // High edge = model diverges from market = model is usually wrong.
  // Hard block regardless of ML confidence or regime.
  const maxEdge = TRADE_FILTERS.MAX_EDGE ?? 0.15;
  if (bestEdge != null && bestEdge > maxEdge) {
    reasons.push(`Edge ceiling: ${(bestEdge * 100).toFixed(0)}% > ${(maxEdge * 100).toFixed(0)}% (high edge = poor WR in journal)`);
  }

  // 9. Counter-trend momentum guard — don't fight strong BTC moves.
  // Audit v2 H1: 0.10%→0.20% — old threshold ($63 at $63k) blocked valid entries; BTC 1min vol ≈ 0.05-0.15%
  const COUNTER_TREND_THRESHOLD = btcPrice != null && Number.isFinite(btcPrice) ? btcPrice * 0.002 : 100;
  if (delta1m != null && signalSide != null) {
    if (signalSide === 'UP' && delta1m < -COUNTER_TREND_THRESHOLD) {
      reasons.push(`Counter-trend: BTC dropped $${Math.abs(delta1m).toFixed(0)} in 1m vs UP signal`);
    }
    if (signalSide === 'DOWN' && delta1m > COUNTER_TREND_THRESHOLD) {
      reasons.push(`Counter-trend: BTC rose $${delta1m.toFixed(0)} in 1m vs DOWN signal`);
    }
  }

  // 10. Hour-of-day blackout — data shows certain ET hours are consistently unprofitable
  const blackout = TRADE_FILTERS.BLACKOUT_HOURS_ET;
  if (blackout && etHour != null && blackout.includes(etHour)) {
    reasons.push(`Blackout hour: ${etHour}:00 ET (historically unprofitable)`);
  }

  // 11. Trending regime protection — data (10 trades): 10% WR, -$0.79 avg P&L
  // Three gates that ALL must pass when regime = 'trending':
  //   a) Require MID/LATE phase only — EARLY entries (>10m) had 7/9 losses
  //   b) Token price ≥ 0.60 — losses avg 0.509 (market says 50/50, not trending)
  //   c) ML confidence ≥ 0.65 — losses avg ML 53.82% (ML unsure = trust trend less)
  if (regime === 'trending') {
    // Gate a: Block EARLY phase — losses entered avg 11.87 min left, win at 4.47 min
    const TRENDING_MAX_TIME_LEFT = 10; // min — require MID or LATE phase
    if (Number.isFinite(timeLeftMin) && timeLeftMin > TRENDING_MAX_TIME_LEFT) {
      reasons.push(`Trending+EARLY blocked: ${timeLeftMin.toFixed(1)}m left > ${TRENDING_MAX_TIME_LEFT}m (data: 7/9 EARLY losses)`);
    }
    // Gate b: Token price consensus — trending losses avg 0.509 (market disagrees)
    const TRENDING_MIN_TOKEN = 0.60;
    if (marketPrice != null && marketPrice < TRENDING_MIN_TOKEN) {
      reasons.push(`Trending+low price blocked: ${(marketPrice * 100).toFixed(0)}c < ${TRENDING_MIN_TOKEN * 100}c (market says 50/50, not trending)`);
    }
    // Gate c: ML must be confident in Trending — losses avg ML conf 53.82%
    const TRENDING_MIN_ML = 0.65;
    if (mlAvailable && mlConfidence != null && mlConfidence < TRENDING_MIN_ML) {
      reasons.push(`Trending+low ML blocked: ${(mlConfidence * 100).toFixed(0)}% < ${TRENDING_MIN_ML * 100}% (ML unsure in trending = high loss rate)`);
    }
  }

  // 12. Wide spread gate — illiquid market = slippage eats edge
  if (spread != null && Number.isFinite(spread)) {
    const maxSpread = TRADE_FILTERS.MAX_ENTRY_SPREAD_PCT != null
      ? TRADE_FILTERS.MAX_ENTRY_SPREAD_PCT / 100 : 0.08;
    if (spread > maxSpread) {
      reasons.push(`Wide spread: ${(spread*100).toFixed(1)}% > ${(maxSpread*100).toFixed(0)}% max`);
    } else if (spread > 0.04 && bestEdge != null) {
      const spreadEdgeMin = TRADE_FILTERS.SPREAD_EDGE_MIN != null
        ? TRADE_FILTERS.SPREAD_EDGE_MIN / 100 : 0.08;
      if (bestEdge < spreadEdgeMin) {
        reasons.push(`Spread ${(spread*100).toFixed(1)}% w/ thin edge ${(bestEdge*100).toFixed(1)}% < ${(spreadEdgeMin*100).toFixed(0)}%`);
      }
    }
  }

  // 13. ML accuracy degradation gate
  // If ML has been wrong > 55% of last 20 predictions, stop trusting it for entry
  if (mlAccuracy != null && mlAccuracy < 0.45) {
    reasons.push(`ML degraded: ${(mlAccuracy*100).toFixed(0)}% acc (last 20) < 45%`);
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
 * FINTECH: Get loss timestamp for persistence.
 */
export function getLastLossTimestamp() {
  return lastLossTimestamp;
}

/**
 * FINTECH: Import loss timestamp from persisted state (survives restart).
 */
export function importLastLossTimestamp(ts) {
  if (Number.isFinite(ts) && ts > 0) lastLossTimestamp = ts;
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
  // Prevent unbounded growth — keep only the 20 most recent slugs
  const keys = Object.keys(tradesThisMarket);
  if (keys.length > 20) {
    for (const k of keys.slice(0, keys.length - 20)) {
      delete tradesThisMarket[k];
    }
  }
}

/**
 * Export per-market trade counts for persistence.
 * Called by loop.js periodic save to include in state.json.
 */
export function exportMarketTradeCounts() {
  return { ...tradesThisMarket };
}

/**
 * Import per-market trade counts from persisted state.
 * Called by loop.js on startup to restore counts across restarts.
 */
export function importMarketTradeCounts(data) {
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    tradesThisMarket = { ...data };
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
