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

  test('FILTER_MIN_PATH_EFFICIENCY and FILTER_MIN_PEAK_GAP_RATIO enforce microstructure gates 20a and 20b', async () => {
    const f = await load({
      FILTER_MIN_PATH_EFFICIENCY: '0.08',
      FILTER_MIN_PEAK_GAP_RATIO: '0.75',
    });
    const chopAndFading = f.applyTradeFilters({
      ...input,
      pathEfficiency: 0.05,
      peakGapRatio: 0.60,
    });
    expect(chopAndFading.reasons.filter(r => r.startsWith('Chop regime') || r.startsWith('Momentum fading'))).toEqual([
      'Chop regime: path efficiency 5.0% < 8% min',
      'Momentum fading: peak gap ratio 60% < 75% min',
    ]);

    const cleanAndStrong = f.applyTradeFilters({
      ...input,
      pathEfficiency: 0.14,
      peakGapRatio: 0.90,
    });
    expect(cleanAndStrong.reasons.filter(r => r.startsWith('Chop regime') || r.startsWith('Momentum fading'))).toEqual([]);
  });

  test('FILTER_MAX_OPPOSING_OB_IMBALANCE enforces gate 20c against opposing flow only', async () => {
    const obReason = (rs: string[]) => rs.filter(r => r.startsWith('Opposing L2 orderbook imbalance'));

    // Disabled by default (def=0) so golden defaults stay untouched
    const defFilters = await load({});
    expect(defFilters.getFilterThresholds().maxOpposingObImbalance).toBe(0);
    expect(obReason(defFilters.applyTradeFilters({ ...input, signalSide: 'UP', orderbookImbalance: -0.80 }).reasons)).toEqual([]);

    // Active threshold 0.30 blocks opposing flow on both UP and DOWN
    const active = await load({ FILTER_MAX_OPPOSING_OB_IMBALANCE: '0.30' });
    expect(obReason(active.applyTradeFilters({ ...input, signalSide: 'UP', orderbookImbalance: -0.36 }).reasons)).toEqual([
      'Opposing L2 orderbook imbalance -36% against UP (> 30% limit)',
    ]);
    expect(obReason(active.applyTradeFilters({ ...input, signalSide: 'UP', orderbookImbalance: -0.15 }).reasons)).toEqual([]);
    expect(obReason(active.applyTradeFilters({ ...input, signalSide: 'UP', orderbookImbalance: 0.45 }).reasons)).toEqual([]);

    expect(obReason(active.applyTradeFilters({ ...input, signalSide: 'DOWN', orderbookImbalance: 0.36 }).reasons)).toEqual([
      'Opposing L2 orderbook imbalance 36% against DOWN (> 30% limit)',
    ]);
    expect(obReason(active.applyTradeFilters({ ...input, signalSide: 'DOWN', orderbookImbalance: -0.44 }).reasons)).toEqual([]);
    expect(obReason(active.applyTradeFilters({ ...input, signalSide: 'UP', orderbookImbalance: null }).reasons)).toEqual([]);
  });

  test('FILTER_CROSS_FEED_SKEW_PCT blocks Binance-vs-Chainlink PTB flips & inflated coin flips while allowing aligned leads', async () => {
    const cfReason = (rs: string[]) => rs.filter(r => r.startsWith('Cross-feed '));

    const def = await load({});
    expect(def.getFilterThresholds().crossFeedSkewPct).toBe(0.035);

    // 1. Cross-feed PTB flip: Binance thinks UP (+0.04%), Chainlink actually DOWN (-0.015%) -> skew 0.055% >= 0.035%
    expect(cfReason(def.applyTradeFilters({
      ...input, signalSide: 'UP', binanceDistPct: 0.04, oracleDistPct: -0.015,
    }).reasons)).toHaveLength(1);

    // 2. Phantom near-PTB lead: Binance +0.06%, Chainlink barely +0.01% (< 0.035%), skew 0.050% -> BLOCKED
    expect(cfReason(def.applyTradeFilters({
      ...input, signalSide: 'UP', binanceDistPct: 0.06, oracleDistPct: 0.01,
    }).reasons)).toHaveLength(1);

    // 3. Symmetry on DOWN side: Binance -0.04% vs Chainlink +0.01% -> BLOCKED
    expect(cfReason(def.applyTradeFilters({
      ...input, signalSide: 'DOWN', binanceDistPct: -0.04, oracleDistPct: 0.01,
    }).reasons)).toHaveLength(1);

    // 4. Screenshot scenario: wide steady/aligned lead where Oracle is ALREADY strongly UP (+0.199%) -> PASS
    expect(cfReason(def.applyTradeFilters({
      ...input, signalSide: 'UP', binanceDistPct: 0.294, oracleDistPct: 0.199,
    }).reasons)).toEqual([]);

    // 5. Constant basis (skew 0.005%) near PTB -> PASS
    expect(cfReason(def.applyTradeFilters({
      ...input, signalSide: 'UP', binanceDistPct: 0.03, oracleDistPct: 0.025,
    }).reasons)).toEqual([]);

    // 6. Disabled via FILTER_CROSS_FEED_SKEW_PCT=0 -> PASS
    const off = await load({ FILTER_CROSS_FEED_SKEW_PCT: '0' });
    expect(cfReason(off.applyTradeFilters({
      ...input, signalSide: 'UP', binanceDistPct: 0.04, oracleDistPct: -0.015,
    }).reasons)).toEqual([]);

    // 7. Extreme phantom lead replay: Trade #50 (UP, Binance +0.279% vs Oracle +0.054%, skew +0.225% >= 0.140%, z=0.28)
    const trade50Reasons = cfReason(def.applyTradeFilters({
      ...input, signalSide: 'UP', binanceDistPct: 0.279, oracleDistPct: 0.054, twapPhysicsZ: 0.28,
    }).reasons);
    expect(trade50Reasons).toHaveLength(1);
    expect(trade50Reasons[0].startsWith('Cross-feed phantom lead:')).toBe(true);

    // 8. Extreme phantom lead replay: Trade #49 (UP, Binance +0.378% vs Oracle +0.043%, skew +0.335% >= 0.140%, z=0.17)
    const trade49Reasons = cfReason(def.applyTradeFilters({
      ...input, signalSide: 'UP', binanceDistPct: 0.378, oracleDistPct: 0.043, twapPhysicsZ: 0.17,
    }).reasons);
    expect(trade49Reasons).toHaveLength(1);
    expect(trade49Reasons[0].startsWith('Cross-feed phantom lead:')).toBe(true);

    // 9. Moderate skew (Trade #7: skew 0.108% < 0.140%) -> PASS
    expect(cfReason(def.applyTradeFilters({
      ...input, signalSide: 'UP', binanceDistPct: 0.152, oracleDistPct: 0.044,
    }).reasons)).toEqual([]);

    // 10. Strong TWAP physics lead (|z| >= 0.50) exempts extreme phantom lead -> PASS
    expect(cfReason(def.applyTradeFilters({
      ...input, signalSide: 'UP', binanceDistPct: 0.279, oracleDistPct: 0.054, twapPhysicsZ: 0.65,
    }).reasons)).toEqual([]);

    // 11. Disabled via FILTER_CROSS_FEED_SKEW_PCT=0 also disables extreme phantom lead -> PASS
    expect(cfReason(off.applyTradeFilters({
      ...input, signalSide: 'UP', binanceDistPct: 0.279, oracleDistPct: 0.054, twapPhysicsZ: 0.28,
    }).reasons)).toEqual([]);
  });

  test('normalizeFilterLogKey collapses oscillating EARLY phase anti-pucuk sub-variants to a single throttle key', async () => {
    const mod = await load({});
    const k1 = mod.normalizeFilterLogKey([
      'EARLY phase anti-pucuk: price 71c > 61c with rule-ML divergence +25pp ≥ 25pp (ML conf 37%)',
    ]);
    const k2 = mod.normalizeFilterLogKey([
      'EARLY phase anti-pucuk: price 71c > 61c with thin ML edge -1.9% < 3.5%',
    ]);
    expect(k1).toBe(k2);
    expect(k1).toBe('EARLY phase anti-pucuk');
  });

  test('FILTER_CHOPPY_ML_MIN blocks low ML in choppy regime and FILTER_MID_PHASE_MAX_PRICE honours 63c ceiling', async () => {
    const mod = await load({
      FILTER_CHOPPY_ML_MIN: '0.40',
      FILTER_MID_PHASE_MAX_PRICE: '0.63',
      FILTER_BASE_HARD_CAP: '0.65',
    });

    const choppyBlock = mod.applyTradeFilters({ ...input, regime: 'choppy', mlConfidence: 0.36 });
    expect(choppyBlock.reasons).toContain('Choppy regime: ML conf 36% < 40% min');

    const choppyOk = mod.applyTradeFilters({ ...input, regime: 'choppy', mlConfidence: 0.40 });
    expect(choppyOk.reasons.filter(r => r.startsWith('Choppy regime:'))).toEqual([]);

    const midAllowed = mod.applyTradeFilters({ ...input, marketPrice: 0.63, timeLeftMin: 7, bestEdge: 0.12 });
    expect(midAllowed.reasons.filter(r => r.startsWith('MID phase price'))).toEqual([]);

    const midBlockedHighEdge = mod.applyTradeFilters({ ...input, marketPrice: 0.64, timeLeftMin: 7, bestEdge: 0.12 });
    expect(midBlockedHighEdge.reasons).toContain('MID phase price 64c > 63c ceiling');
  });

  test('FILTER_MIN_TWAP_Z enforces normalized lead floor unless ML >= btcDistMlBypass', async () => {
    const mod = await load({ FILTER_MIN_TWAP_Z: '0.20' });
    const weak = mod.applyTradeFilters({ ...input, mlConfidence: 0.45, twapPhysicsZ: 0.12 });
    expect(weak.reasons).toContain('TWAP lead too weak: |z|=0.12 < 0.20');

    const okLead = mod.applyTradeFilters({ ...input, mlConfidence: 0.45, twapPhysicsZ: -0.25 });
    expect(okLead.reasons.filter(r => r.startsWith('TWAP lead too weak:'))).toEqual([]);

    const mlBypass = mod.applyTradeFilters({ ...input, mlConfidence: 0.85, twapPhysicsZ: 0.05 });
    expect(mlBypass.reasons.filter(r => r.startsWith('TWAP lead too weak:'))).toEqual([]);
  });

  test('3-part anti-pucuk & anti-bottom-chase guard blocks Trade #44 (DOWN @ 62.5c V-bottom) while passing genuine ML edge', async () => {
    const mod = await load({
      FILTER_BYPASS_MIN_ML_EDGE: '0.035',
      FILTER_EARLY_PHASE_MAX_PRICE: '0.61',
      FILTER_EARLY_MAX_RULE_ML_GAP: '0.25',
      FILTER_RSI_EXTREME_MAX_PRICE: '0.59',
      FILTER_RSI_OVERSOLD: '22',
      FILTER_RSI_OVERBOUGHT: '78',
      FILTER_TRENDING_MAX_TIME_LEFT: '13.5',
      FILTER_TRENDING_MIN_TOKEN: '0.52',
      FILTER_TRENDING_ML_WITH: '0.32',
      FILTER_ML_CONF_MIN: '0.30',
      FILTER_ML_CONF_RELAXED: '0.30',
      FILTER_HARD_ML_FLOOR: '0.30',
    });

    // Exact replay of Trade #44 (btc-updown-15m-1795103100):
    // DOWN @ 0.625, tl=13.47m, regime='trending', mlConf=0.3139 (mlSideProb=0.65695 -> rawMlEdge=+0.03195 < 0.035),
    // ruleSideProb=0.955 (gap +0.298 >= 0.25), bestEdge=0.160 (>= 0.15), rsiNow=19.6, stochK=18.3.
    const trade44 = mod.applyTradeFilters({
      ...input,
      signalSide: 'DOWN',
      mlSide: 'DOWN',
      mlConfidence: 0.3139,
      marketPrice: 0.625,
      timeLeftMin: 13.47,
      regime: 'trending',
      btcPrice: 62784.22,
      priceToBeat: 62858.76,
      bestEdge: 0.160,
      ruleSideProb: 0.955,
      rsiNow: 19.6,
      stochK: 18.3,
    });
    expect(trade44.pass).toBe(false);
    // All 3 anti-pucuk protections trigger on Trade #44:
    expect(trade44.reasons.some((r: string) => r.startsWith('Trending+low ML blocked:'))).toBe(true);
    expect(trade44.reasons.some((r: string) => r.startsWith('EARLY phase anti-pucuk:'))).toBe(true);
    expect(trade44.reasons.some((r: string) => r.startsWith('Anti-chase oversold:'))).toBe(true);

    // Genuine ML conviction (mlConfidence=0.38 -> mlSideProb=0.69 -> rawMlEdge=+0.065 >= 0.035,
    // ruleSideProb=0.78 -> gap +0.09 < 0.25, RSI=34 -> not extreme oversold) passes cleanly:
    const genuine = mod.applyTradeFilters({
      ...input,
      signalSide: 'DOWN',
      mlSide: 'DOWN',
      mlConfidence: 0.38,
      marketPrice: 0.625,
      timeLeftMin: 12.0,
      regime: 'trending',
      btcPrice: 62784.22,
      priceToBeat: 62858.76,
      bestEdge: 0.11,
      ruleSideProb: 0.78,
      rsiNow: 34.0,
      stochK: 38.0,
    });
    expect(genuine.reasons.filter((r: string) =>
      r.startsWith('Trending+low ML blocked:')
      || r.startsWith('EARLY phase anti-pucuk:')
      || r.startsWith('Anti-chase '),
    )).toEqual([]);

    // Symmetry check: UP @ 0.61 with RSI 81 > 78 & StochK 84 > 75 is blocked by Anti-chase overbought
    const overboughtUp = mod.applyTradeFilters({
      ...input,
      signalSide: 'UP',
      mlSide: 'UP',
      mlConfidence: 0.34,
      marketPrice: 0.61,
      timeLeftMin: 9.5,
      regime: 'moderate',
      bestEdge: 0.10,
      rsiNow: 81.2,
      stochK: 84.0,
    });
    expect(overboughtUp.reasons.some((r: string) => r.startsWith('Anti-chase overbought:'))).toBe(true);
  });

  test('FILTER_MODERATE_MIN_ML_EDGE blocks thin raw ML edge in moderate/choppy regimes while sparing trending/mean_reverting', async () => {
    const mod = await load({
      FILTER_MODERATE_MIN_ML_EDGE: '0.035',
      FILTER_ML_CONF_MIN: '0.30',
      FILTER_HARD_ML_FLOOR: '0.30',
    });

    // Trade #51 replay (moderate, DOWN @ 64c, ML conf 31.4% -> mlSideProb 65.7%, rawMlEdge +1.7% < 3.5%)
    const trade51 = mod.applyTradeFilters({
      ...input,
      regime: 'moderate',
      timeLeftMin: 6.0,
      signalSide: 'DOWN',
      mlSide: 'DOWN',
      mlConfidence: 0.314,
      marketPrice: 0.64,
    });
    expect(trade51.reasons).toContain('Moderate regime thin ML edge: 1.7% < 3.5% min');

    // Trade #55 replay (moderate, DOWN @ 64c, ML conf 32.3% -> rawMlEdge +2.15% < 3.5%)
    const trade55 = mod.applyTradeFilters({
      ...input,
      regime: 'moderate',
      timeLeftMin: 6.5,
      signalSide: 'DOWN',
      mlSide: 'DOWN',
      mlConfidence: 0.323,
      marketPrice: 0.64,
    });
    expect(trade55.reasons.some((r: string) => r.startsWith('Moderate regime thin ML edge:'))).toBe(true);

    // Trade #52 replay (moderate, DOWN @ 62c, ML conf 31.4% -> rawMlEdge +3.7% >= 3.5%) passes Gate 11c
    const trade52 = mod.applyTradeFilters({
      ...input,
      regime: 'moderate',
      timeLeftMin: 5.8,
      signalSide: 'DOWN',
      mlSide: 'DOWN',
      mlConfidence: 0.314,
      marketPrice: 0.62,
    });
    expect(trade52.reasons.filter((r: string) => r.includes('regime thin ML edge:'))).toEqual([]);

    // Choppy regime with +2.0% rawMlEdge < 3.5% is blocked with Choppy prefix
    const choppyThin = mod.applyTradeFilters({
      ...input,
      regime: 'choppy',
      timeLeftMin: 8.0,
      signalSide: 'DOWN',
      mlSide: 'DOWN',
      mlConfidence: 0.32,
      marketPrice: 0.64,
    });
    expect(choppyThin.reasons.some((r: string) => r.startsWith('Choppy regime thin ML edge:'))).toBe(true);

    // Trending and mean_reverting remain unaffected by moderateMinMlEdge
    for (const r of ['trending', 'mean_reverting']) {
      const ok = mod.applyTradeFilters({
        ...input,
        regime: r,
        timeLeftMin: 8.0,
        signalSide: 'DOWN',
        mlSide: 'DOWN',
        mlConfidence: 0.314,
        marketPrice: 0.64,
      });
      expect(ok.reasons.filter((x: string) => x.includes('regime thin ML edge:'))).toEqual([]);
    }

    // Default (unset / 0) disables Gate 11c
    expect(readFilterThresholds({}).values.moderateMinMlEdge).toBe(0);
    const off = await load({ FILTER_MODERATE_MIN_ML_EDGE: '0', FILTER_ML_CONF_MIN: '0.30' });
    expect(off.getFilterThresholds().moderateMinMlEdge).toBe(0);
    const offRes = off.applyTradeFilters({
      ...input,
      regime: 'moderate',
      signalSide: 'DOWN',
      mlSide: 'DOWN',
      mlConfidence: 0.314,
      marketPrice: 0.64,
    });
    expect(offRes.reasons.filter((x: string) => x.includes('regime thin ML edge:'))).toEqual([]);
  });

  test('Gates 20h, 20i, 20j block compound anomalies (#19L, #45L, #50L, #66L, #67L) while sparing winners (#39W, #48W, #59W, #63W)', async () => {
    const mod = await load({
      FILTER_CROSS_FEED_SKEW_PCT: '0.035',
      FILTER_ML_CONF_MIN: '0.30',
      FILTER_HARD_ML_FLOOR: '0.30',
    });

    // Trade #67L replay (DOWN @ 63c, tl=9.99m, mlConf=32.6%, inf=0.084%, ora=0.055%, flips=2, sq=true, jevConflict=true, hybDelta=+0.1018)
    // Hits all 3 compound anomaly gates (20h, 20i, 20j)
    const trade67L = mod.applyTradeFilters({
      ...input,
      signalSide: 'DOWN',
      mlSide: 'DOWN',
      mlConfidence: 0.326,
      marketPrice: 0.63,
      timeLeftMin: 9.99,
      regime: 'trending',
      binanceDistPct: -0.140,
      oracleDistPct: -0.055,
      recentFlips: 2,
      bbSqueeze: true,
      hybridDeltaProb: 0.1018,
      jevConflict: true,
    });
    expect(trade67L.pass).toBe(false);
    expect(trade67L.reasons.some((r: string) => r.startsWith('Squeeze flip whipsaw:'))).toBe(true);
    expect(trade67L.reasons.some((r: string) => r.startsWith('Cross-feed skew + squeeze/flip:'))).toBe(true);
    expect(trade67L.reasons.some((r: string) => r.startsWith('Compound JEV + hybrid + skew conflict:'))).toBe(true);

    // Trade #66L replay (DOWN @ 64c, tl=9.99m, mlConf=35.0%, inf=0.074%, ora=0.086%, flips=0, sq=false, jevConflict=true, hybDelta=+0.103)
    const trade66L = mod.applyTradeFilters({
      ...input,
      signalSide: 'DOWN',
      mlSide: 'DOWN',
      mlConfidence: 0.350,
      marketPrice: 0.64,
      timeLeftMin: 9.99,
      regime: 'trending',
      binanceDistPct: -0.160,
      oracleDistPct: -0.086,
      recentFlips: 0,
      bbSqueeze: false,
      hybridDeltaProb: 0.103,
      jevConflict: true,
    });
    expect(trade66L.pass).toBe(false);
    expect(trade66L.reasons.some((r: string) => r.startsWith('Compound JEV + hybrid + skew conflict:'))).toBe(true);

    // Trade #39W replay (winner with flips=2, sq=false, inf=-0.040%) -> spared
    const trade39W = mod.applyTradeFilters({
      ...input,
      signalSide: 'DOWN',
      mlSide: 'DOWN',
      mlConfidence: 0.35,
      marketPrice: 0.63,
      timeLeftMin: 12.78,
      regime: 'trending',
      binanceDistPct: -0.033,
      oracleDistPct: -0.073,
      recentFlips: 2,
      bbSqueeze: false,
      hybridDeltaProb: 0,
      jevConflict: false,
    });
    expect(trade39W.reasons.filter((r: string) =>
      r.startsWith('Squeeze flip whipsaw:')
      || r.startsWith('Cross-feed skew + squeeze/flip:')
      || r.startsWith('Compound JEV + hybrid + skew conflict:'),
    )).toEqual([]);

    // Trade #48W replay (winner with inf=0.082%, flips=0, sq=false, jevConflict=false) -> spared
    const trade48W = mod.applyTradeFilters({
      ...input,
      signalSide: 'DOWN',
      mlSide: 'DOWN',
      mlConfidence: 0.35,
      marketPrice: 0.64,
      timeLeftMin: 10.06,
      regime: 'trending',
      binanceDistPct: -0.130,
      oracleDistPct: -0.048,
      recentFlips: 0,
      bbSqueeze: false,
      hybridDeltaProb: 0.100,
      jevConflict: false,
    });
    expect(trade48W.reasons.filter((r: string) =>
      r.startsWith('Squeeze flip whipsaw:')
      || r.startsWith('Cross-feed skew + squeeze/flip:')
      || r.startsWith('Compound JEV + hybrid + skew conflict:'),
    )).toEqual([]);
  });

  test('Gate 1e blocks entries where hybrid residual flipped baseMlProbUp to opposite side', async () => {
    const mod = await load({});

    // Replay btc-updown-15m-1795525200 (UP LOSS -$3.20): baseMlProbUp=0.465 (<0.5 -> DOWN), hybrid flipped to 68.3% UP
    const flippedUp = mod.applyTradeFilters({
      ...input,
      signalSide: 'UP',
      mlSide: 'UP',
      mlConfidence: 0.367,
      baseMlProbUp: 0.465,
      hybridDeltaProb: 0.218,
    });
    expect(flippedUp.pass).toBe(false);
    expect(flippedUp.reasons.some((r: string) => r.startsWith('Base-ML direction conflict:'))).toBe(true);

    // Replay btc-updown-15m-1795205700 (DOWN LOSS -$2.95): baseMlProbUp=0.578 (>0.5 -> UP), hybrid flipped to 34.4% DOWN
    const flippedDown = mod.applyTradeFilters({
      ...input,
      signalSide: 'DOWN',
      mlSide: 'DOWN',
      mlConfidence: 0.312,
      baseMlProbUp: 0.578,
      hybridDeltaProb: -0.234,
    });
    expect(flippedDown.pass).toBe(false);
    expect(flippedDown.reasons.some((r: string) => r.startsWith('Base-ML direction conflict:'))).toBe(true);

    // Aligned base ML passes Gate 1e cleanly
    const alignedUp = mod.applyTradeFilters({
      ...input,
      signalSide: 'UP',
      mlSide: 'UP',
      baseMlProbUp: 0.62,
    });
    expect(alignedUp.reasons.filter((r: string) => r.startsWith('Base-ML direction conflict:'))).toEqual([]);

    const alignedDown = mod.applyTradeFilters({
      ...input,
      signalSide: 'DOWN',
      mlSide: 'DOWN',
      baseMlProbUp: 0.38,
    });
    expect(alignedDown.reasons.filter((r: string) => r.startsWith('Base-ML direction conflict:'))).toEqual([]);

    // Null baseMlProbUp (legacy/golden callers) is a strict no-op
    const nullBase = mod.applyTradeFilters({
      ...input,
      signalSide: 'UP',
      mlSide: 'UP',
      baseMlProbUp: null,
    });
    expect(nullBase.reasons.filter((r: string) => r.startsWith('Base-ML direction conflict:'))).toEqual([]);
  });

  test('Gate 1e baseMlConfMin blocks near-50/50 hybrid-carried entries when configured', async () => {
    const mod = await load({ FILTER_BASE_ML_CONF_MIN: '0.16', FILTER_ML_CONF_MIN: '0.3' });
    const base = {
      ...input,
      signalSide: 'DOWN',
      mlSide: 'DOWN',
      mlConfidence: 0.32,
      bestEdge: 0.12,
      marketPrice: 0.64,
      timeLeftMin: 10.7,
    };

    // Replay 2026-11-26 23:45 (DOWN LOSS -$3.20): baseMlProbUp=0.47 -> baseMlConf=6% < 16%
    const unsure = mod.applyTradeFilters({ ...base, baseMlProbUp: 0.47, hybridDeltaProb: -0.13 });
    expect(unsure.pass).toBe(false);
    expect(unsure.reasons.some((r: string) => r.startsWith('Base-ML unsure:'))).toBe(true);

    // Confident aligned base ML (baseMlProbUp=0.38 -> baseMlConf=24% >= 16%) passes Gate 1e
    const confident = mod.applyTradeFilters({ ...base, baseMlProbUp: 0.38, hybridDeltaProb: -0.04 });
    expect(confident.reasons.filter((r: string) => r.startsWith('Base-ML unsure:'))).toEqual([]);
  });
});


