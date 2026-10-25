import { describe, it, expect } from 'vitest';
import { calibrateJevSettleUp, getJevCalibrationBlocks } from '../jevSettleCalibration.ts';

describe('JEV settle calibration', () => {
  it('maps low and high raw probabilities toward the empirical rates', () => {
    expect(calibrateJevSettleUp(0.04)).toBe(0);
    expect(calibrateJevSettleUp(0.06)).toBeCloseTo(0.2727, 4);
    expect(calibrateJevSettleUp(0.5)).toBeCloseTo(0.4462, 4);
    expect(calibrateJevSettleUp(0.9)).toBeCloseTo(0.5333, 4);
    expect(calibrateJevSettleUp(0.93)).toBeCloseTo(0.6712, 4);
  });
  it('is monotone and handles out-of-range values', () => {
    expect(calibrateJevSettleUp(-0.1)).toBe(0);
    expect(calibrateJevSettleUp(1.2)).toBeCloseTo(0.6712, 4);
    const blocks = getJevCalibrationBlocks();
    for (let i = 1; i < blocks.length; i++) expect(blocks[i].mean).toBeGreaterThanOrEqual(blocks[i - 1].mean);
  });
});
