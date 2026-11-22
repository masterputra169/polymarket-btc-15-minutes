import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  calibrateMlProbUp,
  evaluateMlCalibration,
  getMlOnlineCalibrationStatus,
  noteMlWindowPrediction,
  recordMlWindowOutcome,
  resetMlOnlineCalibrationForTests,
} from '../onlineCalibration.ts';
import { BOT_CONFIG } from '../../config.ts';

describe('Online Recency ML Calibration', () => {
  const savedMode = BOT_CONFIG.mlOnlineCalibration.mode;
  const savedMin = BOT_CONFIG.mlOnlineCalibration.minSamples;

  beforeEach(() => {
    resetMlOnlineCalibrationForTests();
    BOT_CONFIG.mlOnlineCalibration.mode = 'shadow';
    BOT_CONFIG.mlOnlineCalibration.minSamples = 40;
  });

  afterEach(() => {
    BOT_CONFIG.mlOnlineCalibration.mode = savedMode;
    BOT_CONFIG.mlOnlineCalibration.minSamples = savedMin;
    resetMlOnlineCalibrationForTests();
  });

  it('stays in shadow passthrough by default and improves Brier on overconfident ML predictions', () => {
    // Synthetic overconfident ML: predicts 0.90 when true rate is 0.65, and 0.10 when true rate is 0.35
    for (let i = 0; i < 60; i++) {
      const slug = `btc-updown-15m-ml-${i}`;
      const isHigh = i % 2 === 0;
      const rawMl = isHigh ? 0.90 : 0.10;
      const outcome: 'UP' | 'DOWN' = isHigh
        ? (i % 6 === 0 ? 'DOWN' : 'UP')   // ~67% UP
        : (i % 6 === 1 ? 'UP' : 'DOWN');  // ~33% UP
      noteMlWindowPrediction(slug, rawMl, 0.55);
      expect(recordMlWindowOutcome(slug, outcome)).toBe(true);
    }

    const st = getMlOnlineCalibrationStatus();
    expect(st.historySize).toBe(60);
    expect(st.platt).not.toBeNull();
    expect(st.calMlBrier!).toBeLessThan(st.rawMlBrier!);
    expect(st.allowActive).toBe(true);

    // Shadow mode computes calibrated prob but keeps appliedProbUp === rawProbUp
    const shadowRes = calibrateMlProbUp(0.90);
    expect(shadowRes.applied).toBe(false);
    expect(shadowRes.appliedProbUp).toBe(0.90);
    expect(shadowRes.calibratedProbUp).toBeLessThan(0.90);

    // Active mode applies calibrated prob because rolling Brier guard passes
    BOT_CONFIG.mlOnlineCalibration.mode = 'active';
    const activeRes = calibrateMlProbUp(0.90);
    expect(activeRes.applied).toBe(true);
    expect(activeRes.appliedProbUp).toBe(activeRes.calibratedProbUp);
  });

  it('returns neutral evaluation on empty history', () => {
    const ev = evaluateMlCalibration([], null);
    expect(ev.samples).toBe(0);
    expect(ev.allowActive).toBe(false);
    expect(ev.rawMlBrier).toBeNull();
  });
});
