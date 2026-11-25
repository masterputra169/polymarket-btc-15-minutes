import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  calibrateMlProbUp,
  computeConformalQHat,
  evaluateConformalSet,
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
    expect(ev.conformalQHat).toBeNull();
  });

  it('computes split-conformal qHat and separates singleton vs ambiguous prediction sets', () => {
    // 20 low residuals (0.10..0.48) -> qHat at alpha=0.15 is 18th smallest (index 17)
    const scores = Array.from({ length: 20 }, (_, i) => +(0.10 + i * 0.02).toFixed(2));
    const qHat = computeConformalQHat(scores, 0.15);
    expect(qHat).toBe(0.44);
    expect(computeConformalQHat([0.1, 0.2], 0.15)).toBeNull(); // < 10 samples

    // With qHat = 0.62: confident UP (0.80) -> singleton ['UP']; uncertain (0.52) -> ambiguous ['UP','DOWN']
    const sharpUp = evaluateConformalSet(0.80, 0.62);
    expect(sharpUp.singleton).toBe(true);
    expect(sharpUp.set).toEqual(['UP']);

    const sharpDown = evaluateConformalSet(0.20, 0.62);
    expect(sharpDown.singleton).toBe(true);
    expect(sharpDown.set).toEqual(['DOWN']);

    const ambig = evaluateConformalSet(0.52, 0.62);
    expect(ambig.ambiguous).toBe(true);
    expect(ambig.set).toEqual(['UP', 'DOWN']);
  });
});
