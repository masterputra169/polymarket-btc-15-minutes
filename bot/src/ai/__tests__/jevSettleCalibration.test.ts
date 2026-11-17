import { describe, it, expect } from 'vitest';
import {
  calibrateJevSettleUp,
  calibrateWithBins,
  fitLaplaceCalibrationBins,
  getJevCalibrationBlocks,
  JEV_SETTLE_CALIBRATION_VERSION,
} from '../jevSettleCalibration.ts';

describe('JEV settle calibration', () => {
  it('uses the 2026-11-17 10-bin Laplace + lerp calibration curve', () => {
    expect(JEV_SETTLE_CALIBRATION_VERSION).toBe('2026-11-17-laplace10-lerp');
    expect(calibrateJevSettleUp(0.04)).toBeCloseTo(0.3690, 4);
    expect(calibrateJevSettleUp(0.25)).toBeCloseTo(0.3893, 4);
    expect(calibrateJevSettleUp(0.50)).toBeCloseTo(0.4579, 4);
    // Midpoint between 0.65 (0.4579) and 0.75 (0.5670) -> smooth lerp
    expect(calibrateJevSettleUp(0.70)).toBeCloseTo((0.4579 + 0.5670) / 2, 4);
    expect(calibrateJevSettleUp(0.75)).toBeCloseTo(0.5670, 4);
    expect(calibrateJevSettleUp(0.95)).toBeCloseTo(0.6228, 4);
  });

  it('is monotone, continuous between centers, and handles out-of-range values', () => {
    expect(Number.isNaN(calibrateJevSettleUp(Number.NaN))).toBe(true);
    expect(calibrateJevSettleUp(-0.2)).toBeCloseTo(0.3690, 4);
    expect(calibrateJevSettleUp(1.4)).toBeCloseTo(0.6228, 4);

    const blocks = getJevCalibrationBlocks();
    expect(blocks.length).toBe(10);
    for (let i = 1; i < blocks.length; i++) {
      expect(blocks[i].mean).toBeGreaterThanOrEqual(blocks[i - 1].mean);
    }

    let prev = calibrateJevSettleUp(0);
    for (let x = 0.01; x <= 1.0; x += 0.01) {
      const cur = calibrateJevSettleUp(x);
      expect(cur).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = cur;
    }
  });

  it('fits Laplace + PAVA calibration bins on custom observations', () => {
    const samples = [
      ...Array.from({ length: 20 }, () => ({ rawProb: 0.15, outcomeUp: 0 as const })),
      ...Array.from({ length: 2 }, () => ({ rawProb: 0.15, outcomeUp: 1 as const })),
      ...Array.from({ length: 5 }, () => ({ rawProb: 0.85, outcomeUp: 0 as const })),
      ...Array.from({ length: 20 }, () => ({ rawProb: 0.85, outcomeUp: 1 as const })),
    ];
    const bins = fitLaplaceCalibrationBins(samples);
    expect(bins.length).toBe(10);
    for (let i = 1; i < bins.length; i++) {
      expect(bins[i].mean).toBeGreaterThanOrEqual(bins[i - 1].mean);
    }
    expect(calibrateWithBins(0.85, bins)).toBeGreaterThan(calibrateWithBins(0.15, bins));
  });
});
