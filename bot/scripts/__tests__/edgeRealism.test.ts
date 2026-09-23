/**
 * edgeRealism: claimed vs realised edge, and the model against the price.
 * The numbers the 2026-09-23 analysis had to compute by hand.
 */

import { describe, test, expect } from 'vitest';
import { edgeRealism, suggestedShrink, MIN_ROWS_FOR_SHRINK, type EdgeRow } from '../edgeRealism.mts';

const row = (side: 'UP' | 'DOWN', price: number, probUp: number, marketUp: number, upWon: boolean): EdgeRow =>
  ({ side, price, probUp, marketUp, upWon });

describe('edgeRealism', () => {
  test('claimed and realised edge on the side bought', () => {
    // Bought UP at 0.60 with the model at 0.90: claimed +30pp. Won: realised +40pp.
    const e = edgeRealism([row('UP', 0.6, 0.9, 0.6, true)]);
    expect(e.claimedEdgePp).toBeCloseTo(30, 9);
    expect(e.realisedEdgePp).toBeCloseTo(40, 9);
  });

  test('a DOWN buy is scored from the DOWN side', () => {
    // Bought DOWN at 0.40 (UP at 0.60), model UP 0.20 -> DOWN 0.80: claimed +40pp. UP won: realised -40pp.
    const e = edgeRealism([row('DOWN', 0.4, 0.2, 0.6, true)]);
    expect(e.claimedEdgePp).toBeCloseTo(40, 9);
    expect(e.realisedEdgePp).toBeCloseTo(-40, 9);
  });

  test('reproduces the 2026-09-23 shape: big claimed edge, small realised edge, market beats model', () => {
    const rows: EdgeRow[] = [];
    // 100 UP buys at 0.64, model says 0.88, 68 win.
    for (let i = 0; i < 100; i++) rows.push(row('UP', 0.64, 0.88, 0.64, i < 68));
    const e = edgeRealism(rows);
    expect(e.claimedEdgePp).toBeCloseTo(24, 6);
    expect(e.realisedEdgePp).toBeCloseTo(4, 6);
    expect(e.ratio).toBeCloseTo(4 / 24, 6);
    expect(e.skillVsMarket!).toBeLessThan(0);
  });

  test('rows with a missing or impossible price are dropped', () => {
    const e = edgeRealism([row('UP', 0, 0.9, 0.6, true), row('UP', 0.6, Number.NaN, 0.6, true), row('UP', 0.6, 0.7, 0.6, true)]);
    expect(e.n).toBe(1);
  });

  test('empty input is all nulls, not zeros', () => {
    const e = edgeRealism([]);
    expect(e.n).toBe(0);
    expect(e.ratio).toBeNull();
  });
});

describe('suggestedShrink', () => {
  const many = (won: number, total: number) =>
    Array.from({ length: total }, (_, i) => row('UP', 0.64, 0.88, 0.64, i < won));

  test('is the realised/claimed ratio once there is enough data', () => {
    const e = edgeRealism(many(68, 100));
    expect(suggestedShrink(e)).toBeCloseTo(4 / 24, 6);
  });

  test('is null below the sample floor', () => {
    const e = edgeRealism(many(10, MIN_ROWS_FOR_SHRINK - 1));
    expect(suggestedShrink(e)).toBeNull();
  });

  test('is clamped to [0, 1] — a losing book suggests 0, never a negative', () => {
    const e = edgeRealism(many(40, 100));
    expect(suggestedShrink(e)).toBe(0);
  });
});
