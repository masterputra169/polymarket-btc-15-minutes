import { describe, it, expect } from 'vitest';
import { setCache, markDirty } from '../state.ts';
import { reconcilePrediction } from '../store.ts';
import { getDetailedStats } from '../stats.ts';

const recent = (side: string, marketSlug: string, correct: boolean | null, actualResult: string | null) => ({
  timestamp: Date.now() - Math.random() * 1000, side, marketSlug, settled: true,
  correct, actualResult, regime: 'moderate', modelProb: 0.7,
});

describe('reconcilePrediction', () => {
  it('applies a verified outcome and fixes the streak/correctness', () => {
    setCache([
      recent('DOWN', 'm1', false, 'UP'),
      recent('DOWN', 'm2', false, 'UP'),
      recent('UP', 'm3', true, 'UP'),
    ]);
    markDirty();
    expect(reconcilePrediction('m2', 'DOWN')).toBe(1);
    const d = getDetailedStats();
    expect(d.totalSettled).toBe(3);
    expect(d.streak).toEqual({ type: 'win', count: 2 });
  });

  it('is a no-op for unknown slugs and unsettled predictions', () => {
    setCache([
      recent('DOWN', 'm1', false, 'UP'),
      { ...recent('UP', 'm2', null, null), settled: false, correct: null },
    ]);
    markDirty();
    expect(reconcilePrediction('nope', 'DOWN')).toBe(0);
    expect(reconcilePrediction('m2', 'DOWN')).toBe(0);
  });
});
