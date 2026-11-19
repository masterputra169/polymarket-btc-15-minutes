import { describe, it, expect } from 'vitest';
import {
  buildTimeTicks,
  computeMonotoneSegments,
  computeYDomain,
  decodeSnapshotPoints,
  findNearestPointIndex,
  mergeChartSeries,
  resolvePillY,
  shouldHideAxisTick,
} from '../priceChartMath.ts';

function evalCubic(p0: number, c1: number, c2: number, p1: number, t: number): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * c1 + 3 * u * t * t * c2 + t * t * t * p1;
}

describe('priceChartMath', () => {
  it('decodes, sorts, and merges live trail strictly newer than snapshot', () => {
    const snap = {
      slug: 'btc-updown-15m-1000',
      startMs: 1_000_000,
      endMs: 1_900_000,
      ptb: 90_000,
      points: [
        [1005, 90_010, 90_002],
        [1000, 90_000, 89_998],
        [1005, 90_012, null], // duplicate sec fills missing fields / keeps sorted order
      ] as [number, number | null, number | null][],
    };

    const decoded = decodeSnapshotPoints(snap);
    expect(decoded.map(p => p.tsMs)).toEqual([1_000_000, 1_005_000]);
    expect(decoded[1].spot).toBe(90_012);
    expect(decoded[1].twap).toBe(90_002);

    const merged = mergeChartSeries(snap, [
      { tsMs: 1_004_500, spot: 90_005, twap: 90_000 }, // stale vs snapshot last ts -> ignored
      { tsMs: 1_005_000, spot: 90_099, twap: 90_050 }, // equal to last snap ts -> ignored
      { tsMs: 1_006_200, spot: 90_025, twap: 90_004 }, // strictly newer -> kept
      { tsMs: 1_905_000, spot: 90_100, twap: 90_050 }, // beyond endMs -> ignored
    ]);
    expect(merged.map(p => p.tsMs)).toEqual([1_000_000, 1_005_000, 1_006_200]);
    expect(merged[2].spot).toBe(90_025);
  });

  it('keeps PTB inside Y domain with padding and enforces min vertical span', () => {
    const domCalm = computeYDomain([90_001, 90_004, 90_002], 90_000, 40);
    expect(domCalm.max - domCalm.min).toBeGreaterThanOrEqual(40);
    expect(domCalm.min).toBeLessThan(90_000);
    expect(domCalm.max).toBeGreaterThan(90_004);
    expect(domCalm.ticks.length).toBeGreaterThanOrEqual(2);

    const domWide = computeYDomain([89_800, 90_350], 90_500, 40);
    expect(domWide.min).toBeLessThan(89_800);
    expect(domWide.max).toBeGreaterThan(90_500);
  });

  it('produces Fritsch-Carlson monotone segments with zero overshoot across step changes', () => {
    const pts = [
      { x: 0, y: 100 },
      { x: 40, y: 100 },
      { x: 80, y: 20 },
      { x: 120, y: 20 },
      { x: 160, y: 90 },
    ];
    const segs = computeMonotoneSegments(pts);
    expect(segs).toHaveLength(pts.length - 1);

    for (let i = 0; i < segs.length; i++) {
      const y0 = pts[i].y;
      const y1 = pts[i + 1].y;
      const lo = Math.min(y0, y1) - 1e-6;
      const hi = Math.max(y0, y1) + 1e-6;
      const s = segs[i];
      for (let step = 0; step <= 20; step++) {
        const t = step / 20;
        const y = evalCubic(y0, s.cp1y, s.cp2y, s.y, t);
        expect(y).toBeGreaterThanOrEqual(lo);
        expect(y).toBeLessThanOrEqual(hi);
      }
    }
  });

  it('finds nearest timestamp by binary search and generates 3m window ticks', () => {
    const pts = [
      { tsMs: 1_000 },
      { tsMs: 4_000 },
      { tsMs: 10_000 },
      { tsMs: 15_000 },
    ];
    expect(findNearestPointIndex(pts, 500)).toBe(0);
    expect(findNearestPointIndex(pts, 3_600)).toBe(1);
    expect(findNearestPointIndex(pts, 12_400)).toBe(2);
    expect(findNearestPointIndex(pts, 20_000)).toBe(3);

    const ticks = buildTimeTicks(0, 15 * 60_000, 3);
    expect(ticks.map(t => t.offsetMin)).toEqual([0, 3, 6, 9, 12, 15]);
  });

  it('separates colliding right-axis live pill from PTB pill cleanly within bounds', () => {
    // Live price right on top of PTB -> nudges cleanly by minGap
    const pushedAbove = resolvePillY(98, 100, 20, 200, 20);
    expect(Math.abs(pushedAbove - 100)).toBeGreaterThanOrEqual(20);
    expect(pushedAbove).toBe(80);

    // If nudging above exceeds top bound, flips below cleanly
    const flippedBelow = resolvePillY(22, 24, 20, 200, 20);
    expect(flippedBelow).toBe(44);

    // No collision -> untouched
    expect(resolvePillY(150, 100, 20, 200, 20)).toBe(150);
  });

  it('hides right-axis grid tick labels within pill clearance', () => {
    expect(shouldHideAxisTick(95, [100, 180], 16)).toBe(true);
    expect(shouldHideAxisTick(165, [100, 180], 16)).toBe(true);
    expect(shouldHideAxisTick(140, [100, 180], 16)).toBe(false);
    expect(shouldHideAxisTick(100, [null, undefined], 16)).toBe(false);
  });
});
