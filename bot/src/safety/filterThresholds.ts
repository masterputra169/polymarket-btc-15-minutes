/**
 * Every number the entry filters compare against, in one place.
 *
 * Defaults are the values tradeFilters.ts had hard-coded (or read from
 * TRADE_FILTERS in src/config.ts) on 2026-09-25 — tradeFilters.golden.test.ts
 * proves the move changed no decision and no reason text. Each value can be
 * overridden from the environment (`FILTER_*`, read once at load; restart to
 * apply), so a threshold study's result can be applied as a Railway variable
 * instead of a code change.
 *
 * An override that is not a number or falls outside its bounds is REFUSED and
 * reported at startup — never silently replaced by the default, which would
 * leave an operator believing a value is in force that is not (the reason
 * DRY_RUN_HARD_ENTRY_CAP works the same way).
 *
 * The dashboard still reads TRADE_FILTERS directly; an override here changes
 * what the bot enforces, not what the frontend displays.
 */

import { TRADE_FILTERS } from '../../../src/config.ts';

interface ThresholdSpec {
  env: string;
  def: number;
  min: number;
  max: number;
  doc: string;
}

export const FILTER_THRESHOLD_SPECS: Record<string, ThresholdSpec> = {
  // 1. ML confidence gate (confidence = |P(UP) − 0.5| × 2)
  mlConfMin: { env: 'FILTER_ML_CONF_MIN', def: TRADE_FILTERS.MIN_ML_CONFIDENCE, min: 0, max: 1, doc: 'minimum ML confidence' },
  mlConfRelaxed: { env: 'FILTER_ML_CONF_RELAXED', def: 0.45, min: 0, max: 1, doc: 'ML confidence floor when edge ≥ highEdgeBypass or oracle-lag' },
  highEdgeBypass: { env: 'FILTER_HIGH_EDGE_BYPASS', def: 0.15, min: 0, max: 1, doc: 'edge that relaxes the ML gate (and waives the Asia floor)' },
  // Oracle-lag sniper (only with LATE_SNIPER_ENABLED=true)
  oracleLagMinTimeLeft: { env: 'FILTER_ORACLE_LAG_MIN_TIME_LEFT', def: 5.0, min: 0, max: 15, doc: 'minutes left required' },
  oracleLagMaxPrice: { env: 'FILTER_ORACLE_LAG_MAX_PRICE', def: 0.62, min: 0, max: 1, doc: 'token price ceiling' },
  oracleLagMinBtcMove: { env: 'FILTER_ORACLE_LAG_MIN_BTC_MOVE', def: 0.0007, min: 0, max: 0.05, doc: '|Δ1m| / BTC price' },
  oracleLagMlMin: { env: 'FILTER_ORACLE_LAG_ML_MIN', def: 0.75, min: 0, max: 1, doc: 'ML confidence required' },
  // 1a / 16. Asia floors (only with TIME_GATES_ENABLED=true)
  asiaMlMin: { env: 'FILTER_ASIA_ML_MIN', def: 0.8, min: 0, max: 1, doc: 'Asia ML floor (waived at high edge)' },
  asiaHardMlMin: { env: 'FILTER_ASIA_HARD_ML_MIN', def: 0.75, min: 0, max: 1, doc: 'Asia hard ML floor' },
  // 1b. ML dead zone
  deadZoneLo: { env: 'FILTER_DEAD_ZONE_LO', def: 0.75, min: 0, max: 1, doc: 'dead-zone lower bound (inclusive)' },
  deadZoneHi: { env: 'FILTER_DEAD_ZONE_HI', def: 0.8, min: 0, max: 1, doc: 'dead-zone upper bound (exclusive)' },
  deadZoneEdgeMin: { env: 'FILTER_DEAD_ZONE_EDGE_MIN', def: 0.1, min: 0, max: 1, doc: 'edge required inside the dead zone' },
  // 2b / 2c / 2d. Entry price
  extremePriceMlBypass: { env: 'FILTER_EXTREME_PRICE_ML_BYPASS', def: 0.85, min: 0, max: 1, doc: 'ML confidence that allows a price outside MARKET_PRICE_RANGE' },
  entryFloor: { env: 'FILTER_ENTRY_FLOOR', def: TRADE_FILTERS.MIN_ENTRY_PRICE, min: 0, max: 1, doc: 'entry price floor (0 disables)' },
  entryFloorEdgeBypass: { env: 'FILTER_ENTRY_FLOOR_EDGE_BYPASS', def: 0.08, min: 0, max: 1, doc: 'edge that waives the floor' },
  softEntryCap: { env: 'FILTER_SOFT_ENTRY_CAP', def: TRADE_FILTERS.MAX_ENTRY_PRICE, min: 0, max: 1, doc: 'soft entry ceiling (0 disables)' },
  softCapMlBypass: { env: 'FILTER_SOFT_CAP_ML_BYPASS', def: 0.85, min: 0, max: 1, doc: 'ML confidence that waives the soft ceiling' },
  baseHardCap: { env: 'FILTER_BASE_HARD_CAP', def: 0.68, min: 0, max: 1, doc: 'hard entry cap (also the floor of DRY_RUN_HARD_ENTRY_CAP)' },
  trendingHardCap: { env: 'FILTER_TRENDING_HARD_CAP', def: 0.72, min: 0, max: 1, doc: 'hard cap with the trending premium' },
  ultraMlCap: { env: 'FILTER_ULTRA_ML_CAP', def: 0.75, min: 0, max: 1, doc: 'hard cap at ultra ML confidence' },
  trendingPremiumMl: { env: 'FILTER_TRENDING_PREMIUM_ML', def: 0.8, min: 0, max: 1, doc: 'ML confidence for the trending premium' },
  ultraMl: { env: 'FILTER_ULTRA_ML', def: 0.9, min: 0, max: 1, doc: 'ultra ML confidence' },
  // 4c. Late phase
  lateTimeLeft: { env: 'FILTER_LATE_TIME_LEFT', def: 5, min: 0, max: 15, doc: 'minutes left below which the late gate applies' },
  lateMlMin: { env: 'FILTER_LATE_ML_MIN', def: 0.8, min: 0, max: 1, doc: 'late-phase ML floor' },
  lateMlRelaxed: { env: 'FILTER_LATE_ML_RELAXED', def: 0.55, min: 0, max: 1, doc: 'late-phase ML floor at high edge' },
  lateEdgeBypass: { env: 'FILTER_LATE_EDGE_BYPASS', def: 0.15, min: 0, max: 1, doc: 'edge that relaxes the late gate' },
  // 4c. BTC distance from PTB
  btcDistMinPct: { env: 'FILTER_BTC_DIST_MIN_PCT', def: TRADE_FILTERS.MIN_BTC_DIST_PCT, min: 0, max: 5, doc: 'minimum |BTC − PTB| in % (0 disables)' },
  btcDistMlBypass: { env: 'FILTER_BTC_DIST_ML_BYPASS', def: 0.8, min: 0, max: 1, doc: 'ML confidence that waives it' },
  btcDistEarlyTimeLeft: { env: 'FILTER_BTC_DIST_EARLY_TIME_LEFT', def: 10, min: 0, max: 15, doc: 'above this many minutes: early factor' },
  btcDistEarlyFactor: { env: 'FILTER_BTC_DIST_EARLY_FACTOR', def: 0.5, min: 0, max: 1, doc: 'share of the distance required early' },
  btcDistMidTimeLeft: { env: 'FILTER_BTC_DIST_MID_TIME_LEFT', def: 5, min: 0, max: 15, doc: 'above this many minutes: mid factor' },
  btcDistMidFactor: { env: 'FILTER_BTC_DIST_MID_FACTOR', def: 0.75, min: 0, max: 1, doc: 'share of the distance required mid-market' },
  // 7. Weekend (only with TIME_GATES_ENABLED=true)
  weekendMlMin: { env: 'FILTER_WEEKEND_ML_MIN', def: 0.65, min: 0, max: 1, doc: 'weekend ML floor' },
  // 8. Edge ceiling
  edgeCeiling: { env: 'FILTER_EDGE_CEILING', def: TRADE_FILTERS.MAX_EDGE, min: 0, max: 1, doc: 'edge ceiling (approximate PTB, ordinary ML)' },
  edgeCeilingExactPtb: { env: 'FILTER_EDGE_CEILING_EXACT_PTB', def: 0.5, min: 0, max: 1, doc: 'edge ceiling with a data_streams / polymarket_gamma PTB' },
  edgeCeilingHighMl: { env: 'FILTER_EDGE_CEILING_HIGH_ML', def: 0.35, min: 0, max: 1, doc: 'edge ceiling at high ML confidence' },
  edgeCeilingHighMlConf: { env: 'FILTER_EDGE_CEILING_HIGH_ML_CONF', def: 0.85, min: 0, max: 1, doc: 'ML confidence for the high-ML ceiling' },
  // 9. Counter-trend
  counterTrendPct: { env: 'FILTER_COUNTER_TREND_PCT', def: 0.002, min: 0, max: 0.05, doc: '1-minute BTC move against the signal, as a fraction of price' },
  // 11. Trending regime
  trendingMaxTimeLeft: { env: 'FILTER_TRENDING_MAX_TIME_LEFT', def: 10, min: 0, max: 15, doc: 'no trending entry with more minutes left' },
  trendingMinToken: { env: 'FILTER_TRENDING_MIN_TOKEN', def: 0.6, min: 0, max: 1, doc: 'trending token price floor' },
  trendingMlWith: { env: 'FILTER_TRENDING_ML_WITH', def: 0.55, min: 0, max: 1, doc: 'trending ML floor, signal with BTC' },
  trendingMlAgainst: { env: 'FILTER_TRENDING_ML_AGAINST', def: 0.65, min: 0, max: 1, doc: 'trending ML floor, signal against BTC' },
  trendingEdgeBypass: { env: 'FILTER_TRENDING_EDGE_BYPASS', def: 0.15, min: 0, max: 1, doc: 'edge that waives the trending ML floor' },
  // 12. Spread
  spreadThinEdgeAbove: { env: 'FILTER_SPREAD_THIN_EDGE_ABOVE', def: 0.04, min: 0, max: 1, doc: 'spread above which a thin edge is refused' },
  // 13. ML rolling accuracy
  mlAccuracyMin: { env: 'FILTER_ML_ACCURACY_MIN', def: 0.45, min: 0, max: 1, doc: 'last-20 ML accuracy floor' },
  // 17-19. External gates' ML bypasses
  sentimentMlBypass: { env: 'FILTER_SENTIMENT_ML_BYPASS', def: 0.9, min: 0, max: 1, doc: 'ML confidence that overrides extreme sentiment' },
  macroMlBypass: { env: 'FILTER_MACRO_ML_BYPASS', def: 0.95, min: 0, max: 1, doc: 'ML confidence that trades through a macro event' },
  llmMlBypassDefault: { env: 'FILTER_LLM_ML_BYPASS', def: 0.9, min: 0, max: 1, doc: 'ML bypass for an LLM block that names none' },
};

export type FilterThresholdKey = keyof typeof FILTER_THRESHOLD_SPECS;
export type FilterThresholds = Record<FilterThresholdKey, number>;

export interface ThresholdResolution {
  values: FilterThresholds;
  /** `KEY=value (default d)` for every override in force. */
  overrides: string[];
  /** Why a set variable was ignored. */
  refused: string[];
}

type Env = Record<string, string | undefined>;

/**
 * Pairs whose order a gate relies on. Each value passes its own bounds, so an
 * inverted pair (FILTER_DEAD_ZONE_LO=0.9 with HI=0.5) would slip through and
 * quietly empty a band — refused together instead, both back to defaults.
 */
const ORDERED_PAIRS: ReadonlyArray<{ lo: string; hi: string; strict: boolean }> = [
  { lo: 'deadZoneLo', hi: 'deadZoneHi', strict: true },
  { lo: 'lateMlRelaxed', hi: 'lateMlMin', strict: false },
  { lo: 'btcDistMidTimeLeft', hi: 'btcDistEarlyTimeLeft', strict: false },
];

/** Resolve every threshold from its default and the environment. Pure; no logging. */
export function readFilterThresholds(env: Env): ThresholdResolution {
  const values = {} as FilterThresholds;
  let overrides: string[] = [];
  const refused: string[] = [];
  for (const [key, spec] of Object.entries(FILTER_THRESHOLD_SPECS)) {
    values[key] = spec.def;
    const raw = env[spec.env];
    if (raw == null || raw.trim() === '') continue;
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      refused.push(`${spec.env}="${raw}" is not a number — ignored, stays ${spec.def}`);
    } else if (n < spec.min || n > spec.max) {
      refused.push(`${spec.env}=${raw} is outside ${spec.min}-${spec.max} — ignored, stays ${spec.def}`);
    } else if (n !== spec.def) {
      values[key] = n;
      overrides.push(`${spec.env}=${n} (default ${spec.def})`);
    }
  }
  for (const { lo, hi, strict } of ORDERED_PAIRS) {
    const a = values[lo];
    const b = values[hi];
    if (strict ? a < b : a <= b) continue;
    const sLo = FILTER_THRESHOLD_SPECS[lo];
    const sHi = FILTER_THRESHOLD_SPECS[hi];
    refused.push(`${sLo.env}=${a} must be ${strict ? '<' : '<='} ${sHi.env}=${b} — both ignored, stay ${sLo.def} / ${sHi.def}`);
    values[lo] = sLo.def;
    values[hi] = sHi.def;
    overrides = overrides.filter(o => !o.startsWith(`${sLo.env}=`) && !o.startsWith(`${sHi.env}=`));
  }
  return { values, overrides, refused };
}
