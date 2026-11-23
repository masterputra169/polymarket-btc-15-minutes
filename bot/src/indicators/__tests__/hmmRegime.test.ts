import { describe, it, expect } from 'vitest';
import { computeHmmRegime } from '../../../../src/indicators/hmmRegime.ts';
import { detectRegime } from '../../../../src/engines/regime.ts';

describe('Causal 3-State Gaussian HMM Regime Detector', () => {
  it('returns null when fewer than 10 closes are provided', () => {
    expect(computeHmmRegime(null)).toBeNull();
    expect(computeHmmRegime([60000, 60010, 60020])).toBeNull();
  });

  it('classifies persistent directional drift as trending with high pTrending', () => {
    // 25 bars of steady upward drift with mild variation
    const trendingCloses = Array.from({ length: 25 }, (_, i) => 60000 + i * 35 + (i % 2 === 0 ? 5 : 2));
    const res = computeHmmRegime(trendingCloses);
    expect(res).not.toBeNull();
    expect(res!.pTrending + res!.pChoppy + res!.pMeanReverting).toBeCloseTo(1, 3);
    expect(res!.pTrending).toBeGreaterThan(0.60);
    expect(res!.dominantState).toBe('trending');
    expect(res!.entropy).toBeGreaterThanOrEqual(0);
    expect(res!.entropy).toBeLessThanOrEqual(1);
  });

  it('classifies violent back-and-forth whipsaw as choppy with high pChoppy', () => {
    // Alternating +120 / -118 whipsaw bars (high magnitude, near-zero 3-bar net efficiency)
    const choppyCloses: number[] = [60000];
    for (let i = 1; i < 30; i++) {
      choppyCloses.push(choppyCloses[i - 1] + (i % 2 === 0 ? 120 : -118));
    }
    const res = computeHmmRegime(choppyCloses);
    expect(res).not.toBeNull();
    expect(res!.pChoppy).toBeGreaterThan(res!.pTrending);
    expect(res!.dominantState).toBe('choppy');
  });

  it('attaches hmm posterior onto detectRegime() output when closes are provided', () => {
    const closes = Array.from({ length: 25 }, (_, i) => 60000 + i * 30);
    const info = detectRegime({
      price: 60720,
      vwap: 60350,
      vwapSlope: 30,
      vwapCrossCount: 0,
      volumeRecent: 120,
      volumeAvg: 100,
      closes,
    });
    expect(info.regime).toBe('trending');
    expect(info.hmm).not.toBeNull();
    expect(info.hmm!.dominantState).toBe('trending');
  });
});
