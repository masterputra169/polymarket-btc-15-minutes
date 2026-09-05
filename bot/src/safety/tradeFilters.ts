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
 * 10. Hour-of-day blackout
 * 11. Trending regime protection
 * 12. Wide spread gate
 * 13. ML accuracy degradation
 * 14. VPIN — informed flow opposing signal
 * 15. Spread widening — sudden spread increase
 * 16. Asia session hard gate
 * 17. Extreme sentiment — block during panic/euphoria (Fear & Greed API)
 * 18. Macro event guard — block around high-impact macro events (CPI, FOMC, NFP)
 * 19. LLM regime advisory — block when LLM regime conflicts with signal direction
 */

import { TRADE_FILTERS } from '../../../src/config.ts';
import { BOT_CONFIG } from '../config.ts';
import { envNum } from '../utils/env.ts';
import { createLogger } from '../logger.ts';
import { checkExtremeSentiment } from '../engines/sentimentSignal.ts';
import { checkMacroEvent } from '../monitoring/macroCalendar.ts';
import { checkLLMRegimeAdvisory } from '../ai/regimeClassifier.ts';

const log = createLogger('Filter');

// Dry-run-only entry-price cap override.
//
// In DRY_RUN the point of the run is evidence, and the 68c hard cap is by far
// the biggest single gate: over 2h of live polling it was the sole blocker on
// 4,824 of 7,559 one-rule-away polls, and the bot took zero entries in 46,629
// polls. A filter set that admits nothing produces nothing to measure, and the
// go-live decision needs >=30 resolved dry-run trades to compare against the
// 52% benchmark.
//
// Deliberately gated on BOT_CONFIG.dryRun so it can never loosen a live bot:
// with real money at stake the cap stays 68c no matter what the env says. The
// override only ever RAISES the cap (0.68 floor), so a typo cannot tighten the
// live path either. Cleared automatically the moment DRY_RUN goes false.
const DRY_RUN_HARD_ENTRY_CAP = BOT_CONFIG.dryRun
  ? (process.env.DRY_RUN_HARD_ENTRY_CAP != null
      ? envNum(process.env.DRY_RUN_HARD_ENTRY_CAP, 0.68, 0.68, 0.95)
      : null)
  : null;

if (DRY_RUN_HARD_ENTRY_CAP != null) {
  log.warn(`DRY-RUN ONLY: entry-price hard cap raised 68c -> ${(DRY_RUN_HARD_ENTRY_CAP * 100).toFixed(0)}c ` +
           'to collect entries for the go-live comparison. Has no effect when DRY_RUN=false.');
}

// Module state for cooldown tracking
let lastLossTimestamp = 0;
let tradesThisMarket = {};  // { [slug]: count }

// Spread baseline tracker (rolling ring buffer for spread widening detection)
// H5 audit fix: scale buffer to ~5s of data regardless of poll rate (50ms→100, 3s→10)
const _pollMs = parseInt(process.env.POLL_INTERVAL_MS, 10) || 3000;
const SPREAD_BUF_SIZE = Math.max(10, Math.min(200, Math.ceil(5000 / _pollMs)));
const spreadBuf = new Float64Array(SPREAD_BUF_SIZE);
let spreadBufIdx = 0;
let spreadBufCount = 0;

/** Record a spread observation for baseline computation. */
export function recordSpread(spread) {
  if (!Number.isFinite(spread) || spread <= 0) return;
  spreadBuf[spreadBufIdx] = spread;
  spreadBufIdx = (spreadBufIdx + 1) % SPREAD_BUF_SIZE;
  if (spreadBufCount < SPREAD_BUF_SIZE) spreadBufCount++;
}

function getSpreadBaseline() {
  if (spreadBufCount < 3) return null; // need ≥3 observations for meaningful baseline
  let sum = 0;
  for (let i = 0; i < spreadBufCount; i++) sum += spreadBuf[i];
  return sum / spreadBufCount;
}

// Session quality: US session and EU/US overlap are highest quality
// Off-hours and weekends have lower liquidity → lower reliability
const SESSION_QUALITY = {
  'US':           1.0,
  'EU/US Overlap': 0.85,  // v4: 1.0→0.85 — data: 69% WR (worst session), reduce bet sizing
  'Europe':       1.0,    // 86% WR — best session, no penalty
  'Asia':         0.70,   // 77% WR — tighten significantly (was 0.85)
  'Off-hours':    0.60,   // further tightened
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
  buyRatio,        // volume delta buy ratio (0-1, >0.5 = buyers dominating)
  ptbSource,       // PTB source tier ('data_streams'|'polymarket_gamma'|'polymarket_page'|'polymarket_page_prev'|'scheduled_ws'|'chainlink_round'|'polymarket_page_approx'|'oracle'|'pending'|null)
}: Record<string, any>) {
  const reasons = [];

  // Oracle Lag Sniper bypass — concept from JonathanPetersonn/oracle-lag-sniper (60.7% OOS WR).
  // When PTB is EXACT (data_streams or polymarket_gamma) AND we have ≥5min for repricing
  // AND BTC moved ≥0.07% AND token is cheap (≤62c), the empirical edge comes from oracle/gamma
  // leading CLOB repricing by ~55s. Relax ML threshold (75% vs default 80%) — the price feed
  // IS the signal. Gated by env LATE_SNIPER_ENABLED so user can A/B-test impact.
  const lateSniperEnabled = process.env.LATE_SNIPER_ENABLED === 'true';
  const isExactPtbForSniper = ['data_streams', 'polymarket_gamma'].includes(ptbSource);
  const oracleLagBypass = lateSniperEnabled
    && isExactPtbForSniper
    && timeLeftMin != null && timeLeftMin >= 5.0
    && marketPrice != null && marketPrice <= 0.62
    && delta1m != null && btcPrice != null
    && Math.abs(delta1m / btcPrice) >= 0.0007  // 0.07% BTC movement threshold
    && mlAvailable && mlConfidence != null && mlConfidence >= 0.75;

  // 1. ML Confidence gate
  // During tilt protection (post-cut-loss), use the higher threshold.
  // Edge bypass (Audit v5 A+B): When edge ≥ 15%, the price-based signal is strong enough
  // that moderate ML uncertainty shouldn't block. Relax ML threshold from 65% → 45%.
  // Rationale: edge = modelProb - marketPrice. At 15%+ edge, ensemble strongly favors the side
  // even if ML specifically is uncertain (rule-based indicators still contribute).
  const highEdgeBypass = bestEdge != null && bestEdge >= 0.15;
  const baseMLMin = (highEdgeBypass || oracleLagBypass)
    ? Math.min(TRADE_FILTERS.MIN_ML_CONFIDENCE, 0.45) // relax to 45% when edge or oracle-lag triggers
    : TRADE_FILTERS.MIN_ML_CONFIDENCE;
  const mlConfMin = (tiltMlConfMin != null && tiltMlConfMin > baseMLMin)
    ? tiltMlConfMin
    : baseMLMin;
  if (mlAvailable && mlConfidence != null) {
    if (mlConfidence < mlConfMin) {
      const tiltTag = tiltMlConfMin != null ? ' [tilt]' : '';
      const edgeTag = highEdgeBypass ? ` [edge ${(bestEdge * 100).toFixed(0)}%≥15%→relaxed]` : '';
      const lagTag = oracleLagBypass ? ' [oracle-lag→relaxed]' : '';
      reasons.push(`ML conf ${(mlConfidence * 100).toFixed(0)}% < ${(mlConfMin * 100).toFixed(0)}%${tiltTag}${edgeTag}${lagTag}`);
    }
  }

  // 1a. Asia session ML minimum — Asia WR 77% vs US 85%. Low liquidity + manipulation risk.
  // Require ML ≥80% to trade during Asia hours (21:00-04:00 ET).
  const ASIA_ML_MIN = 0.80;
  if (session === 'Asia' && mlAvailable && mlConfidence != null && mlConfidence < ASIA_ML_MIN) {
    if (!highEdgeBypass) {
      reasons.push(`Asia session: ML conf ${(mlConfidence * 100).toFixed(0)}% < ${(ASIA_ML_MIN * 100).toFixed(0)}% minimum`);
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

  // 1c. PTB source quality gate (Lapis 0 safety — hardened 2026-05-16).
  //
  // ROOT CAUSE (proven): Polymarket removed eventMetadata.priceToBeat from the
  // Gamma API → polymarket_gamma / polymarket_page / polymarket_page_prev all
  // silently died → PTB collapsed to chainlink_round (on-chain Data Feeds,
  // ±8-15s from eventStartTime = $75-225 error at BTC ~$79k). The old gate only
  // *degraded* chainlink_round (require ML≥75%), so the bot kept trading on a
  // PTB that was $75-225 wrong → BTC-distance gate misfired, edge calc skewed,
  // wrong UP/DOWN side → systematic losses.
  //
  // Without an EXACT market-open PTB the bot cannot know which side wins —
  // that is gambling, not trading. Strict allowlist: trade ONLY on an exact
  // source. No ML/edge override (any override is how money leaked before).
  // Re-widening this list is a money-losing regression — see
  // tradeFilters.ptbSource.test.js.
  const EXACT_PTB_TRUST = ['data_streams', 'polymarket_gamma', 'polymarket_page', 'polymarket_page_prev', 'scheduled_ws'];
  if (!EXACT_PTB_TRUST.includes(ptbSource)) {
    const label = ptbSource ? `'${ptbSource}' not exact` : 'unknown/missing';
    reasons.push(`PTB source ${label} — entry BLOCKED (Lapis0 safety: Polymarket gamma removed 2026-05-16; need exact scheduled_ws/data_streams PTB)`);
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

  // 2d. Entry price ceiling — binary option math: at Xc entry, need X% WR to break even.
  // v4: Data shows >75c entries: 70% WR, -$3.48 PnL. Tightened caps.
  // BASE_HARD_CAP: 68c normal, TRENDING_HARD_CAP: 72c (was 75c) with ML ≥80%.
  // ULTRA ML bypass: ML ≥90% can go up to 75c (v16 ≥90% = near-certain).
  const BASE_HARD_CAP = DRY_RUN_HARD_ENTRY_CAP ?? 0.68;
  const TRENDING_HARD_CAP = Math.max(0.72, BASE_HARD_CAP);   // v4: 0.75→0.72 — >75c is negative EV bucket
  const ULTRA_ML_CAP = Math.max(0.75, BASE_HARD_CAP);        // v4: only ML ≥90% can reach 75c
  const trendingPremium = regime === 'trending' && mlConfidence != null && mlConfidence >= 0.80;
  const ultraMl = mlConfidence != null && mlConfidence >= 0.90;
  const HARD_ENTRY_CAP = ultraMl ? ULTRA_ML_CAP : (trendingPremium ? TRENDING_HARD_CAP : BASE_HARD_CAP);
  if (marketPrice != null && marketPrice > HARD_ENTRY_CAP) {
    const trendTag = trendingPremium ? ' [trending premium active]' : '';
    const mlTag = ultraMl ? ' [ultra ML active]' : '';
    const dryTag = DRY_RUN_HARD_ENTRY_CAP != null ? ' [dry-run cap]' : '';
    reasons.push(`Entry price ${(marketPrice * 100).toFixed(0)}c > ${(HARD_ENTRY_CAP * 100).toFixed(0)}c hard cap (need ${(marketPrice * 100).toFixed(0)}% WR)${trendTag}${mlTag}${dryTag}`);
  } else if (TRADE_FILTERS.MAX_ENTRY_PRICE && marketPrice != null && marketPrice > TRADE_FILTERS.MAX_ENTRY_PRICE) {
    // Soft cap bypass: ML ≥85% OR trending + ML ≥80%
    const mlBypass = mlConfidence != null && (mlConfidence >= 0.85 || trendingPremium);
    if (!mlBypass) {
      reasons.push(`Entry price ${(marketPrice * 100).toFixed(0)}c > ${(TRADE_FILTERS.MAX_ENTRY_PRICE * 100).toFixed(0)}c ceiling (ML ${mlConfidence != null ? (mlConfidence * 100).toFixed(0) + '%' : 'N/A'} < 85%)`);
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
  // Edge bypass (Audit v5 A+B): edge ≥ 15% → relax from 80% to 55% (price advantage compensates time pressure)
  if (Number.isFinite(timeLeftMin) && timeLeftMin < 5) {
    const lateEdgeBypass = bestEdge != null && bestEdge >= 0.15;
    const LATE_ML_MIN = lateEdgeBypass ? 0.55 : 0.80;
    if (mlAvailable && mlConfidence != null && mlConfidence < LATE_ML_MIN) {
      const edgeTag = lateEdgeBypass ? ` [edge ${(bestEdge * 100).toFixed(0)}%≥15%→relaxed]` : '';
      reasons.push(`LATE phase ML gate: conf ${(mlConfidence * 100).toFixed(0)}% < ${LATE_ML_MIN * 100}% (${timeLeftMin.toFixed(1)}min left)${edgeTag}`);
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
  // Block when ML truly unavailable (can't assess confidence) or confidence too low.
  // Note: mlConfidence=null is intentionally passed for limit order calls (limitOrderManager
  // has its own 60% ML gate). Only block when mlAvailable=false (model not loaded).
  const dayOfWeek = new Date().getUTCDay();
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
  if (isWeekend) {
    if (!mlAvailable) {
      reasons.push('Weekend + ML unavailable — cannot assess confidence');
    } else if (mlConfidence != null && mlConfidence < 0.65) {
      // v5: 0.35→0.65 — old threshold was below MIN_ML_CONFIDENCE (0.60), never triggered
      reasons.push(`Weekend + low ML conf ${(mlConfidence * 100).toFixed(0)}% < 65%`);
    }
  }

  // 8. Edge ceiling — configurable cap (default 15%) for ALL regimes.
  // Quant analysis (94 trades): edge 10-15% is sweet spot, edge 15-20% has poor WR.
  // CAVEAT: that journal data was collected when PTB was approximate (chainlink_round /
  // polymarket_page) — high edge then often = measurement error, not real divergence.
  // With EXACT PTB sources (data_streams / polymarket_gamma) high edge = real model
  // divergence = legitimate sniper signal (per oracle-lag-sniper 60.7% OOS WR research).
  // ML ≥85% raises ceiling to 35% — v16 model trusted at high confidence.
  // NOTE: this list is INTENTIONALLY NARROWER than filter 1c's EXACT_PTB_TRUST.
  // 1c gates whether to trade AT ALL (any exact source is safe). This gates only
  // the edge-ceiling relaxation, which is research-backed (oracle-lag-sniper)
  // ONLY for data_streams/polymarket_gamma. Do NOT sync the two lists.
  const EXACT_PTB_SOURCES = ['data_streams', 'polymarket_gamma'];
  const isExactPtb = EXACT_PTB_SOURCES.includes(ptbSource);
  const baseMaxEdge = TRADE_FILTERS.MAX_EDGE ?? 0.15;
  let maxEdge;
  if (isExactPtb) {
    maxEdge = 0.50;  // exact oracle PTB — trust real divergence up to 50%
  } else if (mlConfidence != null && mlConfidence >= 0.85) {
    maxEdge = 0.35;  // approximate PTB but ML very confident
  } else {
    maxEdge = baseMaxEdge;  // approximate PTB + low ML — keep tight cap
  }
  if (bestEdge != null && bestEdge > maxEdge) {
    const note = isExactPtb ? 'extreme divergence' : 'high edge = poor WR in journal';
    reasons.push(`Edge ceiling: ${(bestEdge * 100).toFixed(0)}% > ${(maxEdge * 100).toFixed(0)}% (${note})`);
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
  //   c) ML confidence — direction-aware + edge bypass (Audit v5 A+B):
  //      Signal aligned with BTC direction → 55% (relaxed, trend supports us)
  //      Signal against BTC direction → 65% (strict, fighting trend)
  //      Edge ≥ 15% → bypass ML gate entirely (strong price signal)
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
    // Gate c: ML confidence in trending — direction-aware with edge bypass
    const TRENDING_ML_WITH = 0.55;    // signal aligns with BTC direction (trend supports us)
    const TRENDING_ML_AGAINST = 0.65; // signal fights BTC direction (riskier)
    const TRENDING_EDGE_BYPASS = 0.15; // edge ≥ 15% → price signal strong enough, bypass ML gate
    const trendEdgeBypass = bestEdge != null && bestEdge >= TRENDING_EDGE_BYPASS;
    if (!trendEdgeBypass && mlAvailable && mlConfidence != null) {
      // Direction alignment: does our signal match where BTC sits relative to PTB?
      const btcFavorsUp = btcPrice != null && priceToBeat != null && btcPrice > priceToBeat;
      const btcFavorsDown = btcPrice != null && priceToBeat != null && btcPrice < priceToBeat;
      const signalAligned = (signalSide === 'UP' && btcFavorsUp) || (signalSide === 'DOWN' && btcFavorsDown);
      const trendMlMin = signalAligned ? TRENDING_ML_WITH : TRENDING_ML_AGAINST;
      if (mlConfidence < trendMlMin) {
        const alignTag = signalAligned ? 'aligned' : 'against';
        reasons.push(`Trending+low ML blocked: ${(mlConfidence * 100).toFixed(0)}% < ${(trendMlMin * 100).toFixed(0)}% (${alignTag} trend, ML unsure)`);
      }
    } else if (trendEdgeBypass) {
      // Log bypass for transparency (not a blocking reason)
      // Logged at info level in the filter summary, not added to reasons[]
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

  // 14. VPIN — Volume-synchronized Probability of Informed Trading
  // VPIN = |buyRatio×2 - 1| (0=balanced, 1=fully one-sided).
  // High VPIN opposing our signal = informed trader pushing against us → block entry.
  // High VPIN agreeing = confirmation → no block.
  if (buyRatio != null && Number.isFinite(buyRatio) && signalSide != null) {
    const vpin = Math.abs(buyRatio * 2 - 1);
    const vpinThreshold = TRADE_FILTERS.VPIN_BLOCK_THRESHOLD != null
      ? TRADE_FILTERS.VPIN_BLOCK_THRESHOLD : 0.70;
    if (vpin >= vpinThreshold) {
      // Determine if volume flow opposes our signal
      const flowBullish = buyRatio > 0.5;
      const signalBullish = signalSide === 'UP';
      if (flowBullish !== signalBullish) {
        reasons.push(`VPIN ${(vpin*100).toFixed(0)}% opposing: flow=${flowBullish ? 'BUY' : 'SELL'} vs signal=${signalSide} (informed flow)`);
      }
    }
  }

  // 15. Spread widening detection — sudden spread increase = informed trader arrival
  // Compare current spread to rolling baseline. If spread > 2× baseline, block.
  if (spread != null && Number.isFinite(spread)) {
    const baseline = getSpreadBaseline();
    const widenRatio = TRADE_FILTERS.SPREAD_WIDEN_RATIO != null
      ? TRADE_FILTERS.SPREAD_WIDEN_RATIO : 2.0;
    if (baseline != null && baseline > 0 && spread > baseline * widenRatio) {
      reasons.push(`Spread widening: ${(spread*100).toFixed(1)}% > ${widenRatio}× baseline ${(baseline*100).toFixed(1)}% (informed flow)`);
    }
    // Always record spread for baseline tracking (after check to avoid self-reference)
    recordSpread(spread);
  }

  // 16. Asia session hard gate — require higher ML confidence (data: 69% WR vs 92% Europe)
  if (session === 'Asia' && mlAvailable && mlConfidence != null && mlConfidence < 0.75) {
    reasons.push(`Asia session: ML ${(mlConfidence * 100).toFixed(0)}% < 75% required`);
  }

  // 17. Extreme sentiment gate — block during market panic/euphoria
  const extremeSentiment = checkExtremeSentiment();
  if (extremeSentiment && extremeSentiment.block) {
    // ML ≥90% bypass: very high ML confidence can override sentiment
    const mlSentimentBypass = mlConfidence != null && mlConfidence >= 0.90;
    if (!mlSentimentBypass) {
      reasons.push(`Sentiment: ${extremeSentiment.reason}`);
    }
  }

  // 18. Macro Event Guard — block around high-impact CPI/FOMC/NFP events.
  // Binary 15-min markets become coin flips during macro releases.
  // Ultra-ML (≥95%) bypass only — truly exceptional signal required to trade through the event.
  const macroEvent = checkMacroEvent();
  if (macroEvent && macroEvent.block) {
    const mlMacroBypass = mlConfidence != null && mlConfidence >= 0.95;
    if (!mlMacroBypass) {
      reasons.push(`Macro: ${macroEvent.reason}`);
    }
  }

  // 19. LLM regime advisory — slow-loop regime classification (5-min cadence).
  // Shadow mode returns null from checkLLMRegimeAdvisory(), so this is a no-op
  // until LLM_REGIME_SHADOW=false. ML bypass threshold configurable (default 0.90).
  if (signalSide) {
    const llmAdvisory = checkLLMRegimeAdvisory(signalSide);
    if (llmAdvisory && llmAdvisory.block) {
      const bypass = llmAdvisory.mlBypassAbove ?? 0.90;
      const mlLlmBypass = mlConfidence != null && mlConfidence >= bypass;
      if (!mlLlmBypass) {
        reasons.push(`LLM regime: ${llmAdvisory.reason}`);
      }
    }
  }

  // Session quality score (used as multiplier downstream, not a hard filter)
  const sessionQuality = SESSION_QUALITY[session] ?? 0.70;

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
