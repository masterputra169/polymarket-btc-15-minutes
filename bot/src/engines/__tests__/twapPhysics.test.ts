/**
 * The TWAP arithmetic the tape records (record-only): the variance horizon, the
 * per-second volatility, and P(UP) = Φ(z).
 */
import { describe, test, expect } from 'vitest';
import { twapVarianceSeconds, spotVolPerSecond, normCdf, twapPhysics, SettleHistory } from '../twapPhysics.ts';
import { DecisionTrail } from '../../tape/decisionTrail.ts';

const END = 1_790_400_000_000;
const walk = (from: number, n: number, step: (i: number) => number) =>
  Array.from({ length: n }, (_, i) => ({ ts: from + i * 1000, value: 84_000 + step(i) }));

describe('twapVarianceSeconds', () => {
  test('a walk to the window plus the 60-sample mean; inside the window only the unseen part', () => {
    expect(twapVarianceSeconds(300)).toBeCloseTo(240 + 20.5, 9);
    expect(twapVarianceSeconds(61)).toBeCloseTo(1 + 20.5, 9);
    expect(twapVarianceSeconds(60)).toBeCloseTo((60 * 61 * 121) / 21600, 9); // = 20.5: continuous at 60 s
    expect(twapVarianceSeconds(1)).toBeCloseTo(6 / 21600, 12);
    expect(twapVarianceSeconds(0)).toBe(0);
  });
});

describe('spotVolPerSecond and normCdf', () => {
  test('alternating ±$2 moves give σ = $2 per second; too little history gives null', () => {
    expect(spotVolPerSecond(walk(END - 120_000, 121, i => (i % 2 ? 2 : 0)))).toBeCloseTo(2, 9);
    expect(spotVolPerSecond(walk(END - 10_000, 10, () => 0))).toBeNull();
  });
  test('Φ at known points', () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 7);
    expect(normCdf(1.96)).toBeCloseTo(0.975, 3);
    expect(normCdf(-1)).toBeCloseTo(0.1587, 3);
  });
});

describe('twapPhysics', () => {
  const ticks = walk(END - 150_000, 121, i => (i % 2 ? 2 : 0)); // σ = $2/s
  test('P(UP) from the lead over the PTB in units of σ·√T_eff', () => {
    const now = END - 100_000; // 100 s left: T_eff = 40 + 20.5 = 60.5
    const r = twapPhysics({ settle: 84_020, settle30sAgo: 84_010, ptb: 84_000, spotTicks: ticks, nowMs: now, endMs: END })!;
    expect(r.z).toBeCloseTo(20 / (2 * Math.sqrt(60.5)), 9);
    expect(r.p).toBeCloseTo(normCdf(r.z), 12);
    expect(r.drift30).toBe(10);
  });
  test('the same lead is near-certain with seconds left', () => {
    const r = twapPhysics({ settle: 84_020, settle30sAgo: null, ptb: 84_000, spotTicks: ticks, nowMs: END - 5_000, endMs: END })!;
    expect(r.p).toBeGreaterThan(0.999);
    expect(r.drift30).toBeNull();
  });
  test('null without a PTB, an end, a settlement estimate or enough spot history', () => {
    const base = { settle: 84_020, settle30sAgo: null, ptb: 84_000, spotTicks: ticks, nowMs: END - 100_000, endMs: END };
    expect(twapPhysics({ ...base, ptb: null })).toBeNull();
    expect(twapPhysics({ ...base, endMs: null })).toBeNull();
    expect(twapPhysics({ ...base, settle: null })).toBeNull();
    expect(twapPhysics({ ...base, spotTicks: [] })).toBeNull();
    expect(twapPhysics({ ...base, nowMs: END + 1 })).toBeNull();
  });
});

describe('SettleHistory', () => {
  test('reads the value at or before a time and forgets old points', () => {
    const h = new SettleHistory(60_000);
    h.add(1_000, 1);
    h.add(31_000, 2);
    h.add(61_000, 3);
    expect(h.at(30_999)).toBe(1);
    expect(h.at(31_000)).toBe(2);
    expect(h.at(0)).toBeNull();
    h.add(125_000, 4); // drops everything before 65,000
    expect(h.at(64_000)).toBeNull();
  });
});

describe('decision line fields', () => {
  test('tp / tz / dr are written when present and omitted otherwise', () => {
    const tr = new DecisionTrail();
    const base = { t: 1, slug: 'm', action: 'ENTER', side: 'UP', phase: 'LATE', reason: null, mlUp: 0.8, mlConf: 0.6, ensembleUp: 0.8, edgeUp: 0.1, edgeDown: -0.1, marketUp: 0.7, marketDown: 0.3, timeLeftMin: 1, regime: 'moderate', session: 'US' };
    tr.begin({ ...base, twapP: 0.912345, twapZ: 1.35678, drift30: 12.3456 });
    tr.begin({ ...base, t: 2 });
    const first = tr.takeSample()!;
    expect(first).toMatchObject({ tp: 0.9123, tz: 1.357, dr: 12.35 });
    tr.begin({ ...base, t: 3 });
    const second = tr.takeSample()!;
    expect('tp' in second).toBe(false);
  });
});
