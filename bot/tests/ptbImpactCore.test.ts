/**
 * The replay behind backtest/ml_training/ptbImpactStudy.mts: the PTB-dependent
 * gates must match tradeFilters.ts, and only those gates may change.
 */
import { describe, test, expect } from 'vitest';
import {
  officialOutcome, btcDistBlocks, trendingMlBlocks, ptbIndicator, replayGates, settleFromTape,
} from '../../backtest/ml_training/ptbImpactCore.mts';

describe('officialOutcome', () => {
  test('UP when the closing TWAP is >= the price to beat, ties included', () => {
    expect(officialOutcome(84_000, 84_000)).toBe('UP');
    expect(officialOutcome(84_000, 83_999.99)).toBe('DOWN');
    expect(officialOutcome(null, 1)).toBeNull();
  });
});

describe('btcDistBlocks (filter 4c)', () => {
  // 0.04% at the late threshold, 0.03% mid (×0.75), 0.02% early (×0.5); ML >= 80% waives
  test('the time-adapted threshold and the ML waiver', () => {
    expect(btcDistBlocks(84_020, 84_000, 0.7, 3)).toBe(true);    // 0.024% < 0.04%
    expect(btcDistBlocks(84_020, 84_000, 0.7, 7)).toBe(true);    // < 0.03%
    expect(btcDistBlocks(84_020, 84_000, 0.7, 12)).toBe(false);  // >= 0.02%
    expect(btcDistBlocks(84_020, 84_000, 0.8, 3)).toBe(false);   // waived
    expect(btcDistBlocks(null, 84_000, 0.7, 3)).toBe(false);
  });
});

describe('trendingMlBlocks (filter 11c)', () => {
  test('55% aligned with where BTC sits, 65% against; only in a trending regime; edge bypass', () => {
    expect(trendingMlBlocks('trending', 'UP', 84_010, 84_000, 0.6, 0.05)).toBe(false); // aligned, 60% >= 55%
    expect(trendingMlBlocks('trending', 'UP', 83_990, 84_000, 0.6, 0.05)).toBe(true);  // against, 60% < 65%
    expect(trendingMlBlocks('trending', 'UP', 83_990, 84_000, 0.6, 0.2)).toBe(false);  // edge >= 15%
    expect(trendingMlBlocks('moderate', 'UP', 83_990, 84_000, 0.1, 0)).toBe(false);
  });
});

describe('replayGates', () => {
  test('only 4c and 11c are recomputed; every other reason stays', () => {
    const fr = ['BTC too close to PTB: 0.010% < 0.020% (coin flip)', 'Entry price 79c > 75c hard cap (x)'];
    const r = replayGates(fr, { price: 84_050, ptb: 84_000 }, { side: 'UP', mlConf: 0.7, timeLeftMin: 12, regime: 'moderate', bestEdge: 0.05 });
    expect(r.oldGates).toEqual(['btc_dist', 'entry_ceiling']);
    expect(r.newGates).toEqual(['entry_ceiling']);
    expect(r.newPass).toBe(false);
    const clear = replayGates([], { price: 84_001, ptb: 84_000 }, { side: 'UP', mlConf: 0.7, timeLeftMin: 3, regime: 'moderate', bestEdge: 0.05 });
    expect(clear).toMatchObject({ oldPass: true, newPass: false, newGates: ['btc_dist'] });
  });
});

describe('ptbIndicator and settleFromTape', () => {
  test('indicator direction with the ±0.05% neutral band', () => {
    expect(ptbIndicator(84_050, 84_000)).toBe('UP');
    expect(ptbIndicator(84_030, 84_000)).toBe('NEUTRAL');
    expect(ptbIndicator(83_950, 84_000)).toBe('DOWN');
  });
  test('settle estimate: spot before the last minute, partial average inside it', () => {
    const end = 1_000_000_000_000;
    const samples = Array.from({ length: 90 }, (_, i) => ({ t: end - 89_000 + i * 1000, pl: i < 60 ? 84_000 : 84_060 }));
    expect(settleFromTape(samples, end - 70_000, end)).toBe(84_000);
    // 10 s before the end: 30 seconds seen at 84,000 and 20 at 84,060, the last 10 at the current 84,060
    expect(settleFromTape(samples, end - 10_000, end)).toBeCloseTo((30 * 84_000 + 30 * 84_060) / 60, 6);
    expect(settleFromTape([], end, end)).toBeNull();
  });
});
