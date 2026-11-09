import { describe, it, expect } from 'vitest';
import { detectRegime } from '../regime.ts';

describe('detectRegime with Quant Math enhancements', () => {
  it('boosts trending confidence when Hurst > 0.58', () => {
    const resWithout = detectRegime({
      price: 85060,
      vwap: 85000,
      vwapSlope: 5,
      vwapCrossCount: 0,
      volumeRecent: 100,
      volumeAvg: 80,
      atrRatio: 1.25,
      hurst: null,
    });
    const resWith = detectRegime({
      price: 85060,
      vwap: 85000,
      vwapSlope: 5,
      vwapCrossCount: 0,
      volumeRecent: 100,
      volumeAvg: 80,
      atrRatio: 1.25,
      hurst: 0.68,
    });
    expect(resWith.regime).toBe('trending');
    expect(resWith.confidence).toBeGreaterThan(resWithout.confidence);
    expect(resWith.hurst).toBe(0.68);
  });

  it('boosts mean reverting confidence when Hurst < 0.45 and Half-Life is short', () => {
    const res = detectRegime({
      price: 85005,
      vwap: 85000,
      vwapSlope: 0.1,
      vwapCrossCount: 1,
      volumeRecent: 100,
      volumeAvg: 100,
      hurst: 0.35,
      halfLife: 5.2,
    });
    expect(res.regime).toBe('mean_reverting');
    expect(res.label).toContain('Hurst<0.45');
    expect(res.label).toContain('HL confirmed');
    expect(res.halfLife).toBe(5.2);
  });

  it('calculates hurst and halfLife from closes array automatically', () => {
    // Generate oscillating series
    const closes: number[] = [];
    for (let i = 0; i < 40; i++) {
      closes.push(100 + (i % 2 === 0 ? 5 : -5));
    }
    const res = detectRegime({
      price: 100,
      vwap: 100,
      vwapSlope: 0,
      vwapCrossCount: 1,
      volumeRecent: 50,
      volumeAvg: 50,
      closes,
    });
    expect(res.hurst).not.toBeNull();
    expect(typeof res.hurst).toBe('number');
  });
});
