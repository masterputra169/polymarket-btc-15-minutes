/**
 * filterThresholds — the numbers the entry filters compare against.
 *
 * Defaults must be the literals tradeFilters.ts had (the golden test proves the
 * move changed nothing); overrides must take effect, and a bad override must be
 * refused out loud rather than quietly replaced by the default.
 */
import { describe, test, expect, afterEach, vi } from 'vitest';
import { readFilterThresholds, FILTER_THRESHOLD_SPECS } from '../filterThresholds.ts';
import { TRADE_FILTERS } from '../../../../src/config.ts';

const ORIGINAL_ENV = { ...process.env };
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

describe('readFilterThresholds', () => {
  test('defaults are the former hard-coded values', () => {
    const { values, overrides, refused } = readFilterThresholds({});
    expect(overrides).toEqual([]);
    expect(refused).toEqual([]);
    expect(values).toMatchObject({
      mlConfMin: TRADE_FILTERS.MIN_ML_CONFIDENCE, mlConfRelaxed: 0.45, highEdgeBypass: 0.15,
      oracleLagMinTimeLeft: 5, oracleLagMaxPrice: 0.62, oracleLagMinBtcMove: 0.0007, oracleLagMlMin: 0.75,
      asiaMlMin: 0.8, asiaHardMlMin: 0.75, deadZoneLo: 0.75, deadZoneHi: 0.8, deadZoneEdgeMin: 0.1,
      extremePriceMlBypass: 0.85, entryFloor: TRADE_FILTERS.MIN_ENTRY_PRICE, entryFloorEdgeBypass: 0.08,
      softEntryCap: TRADE_FILTERS.MAX_ENTRY_PRICE, softCapMlBypass: 0.85, baseHardCap: 0.68,
      trendingHardCap: 0.72, ultraMlCap: 0.75, trendingPremiumMl: 0.8, ultraMl: 0.9,
      lateTimeLeft: 5, lateMlMin: 0.8, lateMlRelaxed: 0.55, lateEdgeBypass: 0.15,
      btcDistMinPct: TRADE_FILTERS.MIN_BTC_DIST_PCT, btcDistMlBypass: 0.8, btcDistEarlyTimeLeft: 10,
      btcDistEarlyFactor: 0.5, btcDistMidTimeLeft: 5, btcDistMidFactor: 0.75, weekendMlMin: 0.65,
      edgeCeilingExactPtb: 0.5, edgeCeilingHighMl: 0.35, edgeCeilingHighMlConf: 0.85, counterTrendPct: 0.002,
      trendingMaxTimeLeft: 10, trendingMinToken: 0.6, trendingMlWith: 0.55, trendingMlAgainst: 0.65,
      trendingEdgeBypass: 0.15, spreadThinEdgeAbove: 0.04, mlAccuracyMin: 0.45,
      sentimentMlBypass: 0.9, macroMlBypass: 0.95, llmMlBypassDefault: 0.9,
    });
  });

  test('every spec has an env name, a default inside its bounds, and a unique env variable', () => {
    const envs = new Set<string>();
    for (const [key, spec] of Object.entries(FILTER_THRESHOLD_SPECS)) {
      expect(spec.env, key).toMatch(/^FILTER_[A-Z0-9_]+$/);
      expect(spec.def, key).toBeGreaterThanOrEqual(spec.min);
      expect(spec.def, key).toBeLessThanOrEqual(spec.max);
      expect(envs.has(spec.env), `${spec.env} used twice`).toBe(false);
      envs.add(spec.env);
    }
  });

  test('a valid override takes effect and is reported', () => {
    const r = readFilterThresholds({ FILTER_ML_CONF_MIN: '0.55', FILTER_DEAD_ZONE_EDGE_MIN: ' 0.2 ' });
    expect(r.values.mlConfMin).toBe(0.55);
    expect(r.values.deadZoneEdgeMin).toBe(0.2);
    expect(r.overrides).toEqual([
      `FILTER_ML_CONF_MIN=0.55 (default ${TRADE_FILTERS.MIN_ML_CONFIDENCE})`,
      'FILTER_DEAD_ZONE_EDGE_MIN=0.2 (default 0.1)',
    ]);
  });

  test('a bad override is refused out loud and the default stays', () => {
    const r = readFilterThresholds({ FILTER_ML_CONF_MIN: 'high', FILTER_BASE_HARD_CAP: '1.5', FILTER_LATE_ML_MIN: '' });
    expect(r.values.mlConfMin).toBe(TRADE_FILTERS.MIN_ML_CONFIDENCE);
    expect(r.values.baseHardCap).toBe(0.68);
    expect(r.values.lateMlMin).toBe(0.8);
    expect(r.refused).toEqual([
      `FILTER_ML_CONF_MIN="high" is not a number — ignored, stays ${TRADE_FILTERS.MIN_ML_CONFIDENCE}`,
      'FILTER_BASE_HARD_CAP=1.5 is outside 0-1 — ignored, stays 0.68',
    ]);
    expect(r.overrides).toEqual([]);
  });

  test('an inverted pair is refused together, both back to defaults', () => {
    const r = readFilterThresholds({ FILTER_DEAD_ZONE_LO: '0.9', FILTER_DEAD_ZONE_HI: '0.5', FILTER_LATE_ML_RELAXED: '0.9' });
    expect([r.values.deadZoneLo, r.values.deadZoneHi]).toEqual([0.75, 0.8]);
    expect([r.values.lateMlRelaxed, r.values.lateMlMin]).toEqual([0.55, 0.8]);
    expect(r.refused).toEqual([
      'FILTER_DEAD_ZONE_LO=0.9 must be < FILTER_DEAD_ZONE_HI=0.5 — both ignored, stay 0.75 / 0.8',
      'FILTER_LATE_ML_RELAXED=0.9 must be <= FILTER_LATE_ML_MIN=0.8 — both ignored, stay 0.55 / 0.8',
    ]);
    expect(r.overrides).toEqual([]);
    // One side moved past the other's default counts too; an ordered pair passes.
    expect(readFilterThresholds({ FILTER_BTC_DIST_MID_TIME_LEFT: '12' }).refused).toHaveLength(1);
    const ok = readFilterThresholds({ FILTER_DEAD_ZONE_LO: '0.7', FILTER_DEAD_ZONE_HI: '0.85' });
    expect(ok.refused).toEqual([]);
    expect([ok.values.deadZoneLo, ok.values.deadZoneHi]).toEqual([0.7, 0.85]);
  });
});

describe('tradeFilters honours the thresholds', () => {
  async function load(env: Record<string, string>) {
    vi.resetModules();
    Object.assign(process.env, env);
    return (await import('../tradeFilters.ts'));
  }
  const input = {
    mlConfidence: 0.77, mlAvailable: true, marketPrice: 0.6, atrRatio: 1, timeLeftMin: 7,
    marketSlug: 'btc-updown-15m-1', consecutiveLosses: 0, session: 'US', btcPrice: 80_000, priceToBeat: 79_900,
    tiltMlConfMin: null, bestEdge: 0.12, delta1m: 5, signalSide: 'UP', regime: 'moderate', etHour: 14,
    spread: 0.01, ptbSource: 'scheduled_ws',
  };
  const deadZone = (reasons: string[]) => reasons.filter(r => r.startsWith('ML dead zone'));

  test('default: an ML 77% signal with 12% edge clears the dead zone', async () => {
    const f = await load({});
    expect(deadZone(f.applyTradeFilters(input).reasons)).toEqual([]);
    expect(f.getFilterThresholds().deadZoneEdgeMin).toBe(0.1);
  });

  test('FILTER_DEAD_ZONE_EDGE_MIN=0.2: the same signal is held, and the reason names the new number', async () => {
    const f = await load({ FILTER_DEAD_ZONE_EDGE_MIN: '0.2' });
    expect(deadZone(f.applyTradeFilters(input).reasons)).toEqual([
      'ML dead zone: conf 77% in 75-80% band, edge 12.0% < 20% required',
    ]);
  });

  test('FILTER_ML_CONF_MIN lowers the main ML gate', async () => {
    const weak = { ...input, mlConfidence: 0.5, bestEdge: 0.05 };
    const mlGate = (rs: string[]) => rs.filter(r => r.startsWith('ML conf'));
    expect(mlGate((await load({})).applyTradeFilters(weak).reasons)).toEqual([`ML conf 50% < ${(TRADE_FILTERS.MIN_ML_CONFIDENCE * 100).toFixed(0)}%`]);
    expect(mlGate((await load({ FILTER_ML_CONF_MIN: '0.45' })).applyTradeFilters(weak).reasons)).toEqual([]);
  });
});
