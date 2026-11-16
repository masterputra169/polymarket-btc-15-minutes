import { describe, it, expect, beforeEach } from 'vitest';
import * as S from '../state.ts';
import {
  calibrateLogit,
  calibrateLogitWith,
  getCalibrationPhase,
  getPlattByPhase,
  parsePlattByPhase,
  setPlattByPhase,
} from '../calibration.ts';
import { loadLgbModelFromData, predictLgb, unloadLgbModel } from '../lgbPredictor.ts';
import { FI } from '../featureMap.ts';

describe('per-phase Platt calibration', () => {
  beforeEach(() => {
    S.setState({ plattA: 1.0, plattB: 0.0, plattOnLogits: true });
    setPlattByPhase(null);
    unloadLgbModel();
  });

  it('buckets minutes_left_norm into matching 4 phases', () => {
    expect(getCalibrationPhase(12 / 15)).toBe('EARLY');
    expect(getCalibrationPhase(10 / 15)).toBe('MID');
    expect(getCalibrationPhase(5 / 15)).toBe('LATE');
    expect(getCalibrationPhase(2 / 15)).toBe('VERY_LATE');
  });

  it('parsePlattByPhase rejects empty/invalid inputs and validates finite entries', () => {
    expect(parsePlattByPhase(null)).toBeNull();
    expect(parsePlattByPhase({ EARLY: { a: -1, b: 0 } })).toBeNull();
    const parsed = parsePlattByPhase({
      EARLY: { a: 0.9, b: -0.02, theta: 0.88 },
      VERY_LATE: { a: 1.3, b: 0.05 },
    });
    expect(parsed).toEqual({
      EARLY: { a: 0.9, b: -0.02, theta: 0.88 },
      VERY_LATE: { a: 1.3, b: 0.05 },
    });
  });

  it('applies phase-specific scaling when active, and falls back to global when unset or NaN', () => {
    S.setState({ plattA: 1.05, plattB: 0.02, plattOnLogits: true });
    const globalP = calibrateLogit(1.0, 12 / 15);
    expect(globalP).toBeCloseTo(1 / (1 + Math.exp(-(1.05 * 1.0 + 0.02))), 9);

    setPlattByPhase({
      EARLY: { a: 0.85, b: 0.0 },
      VERY_LATE: { a: 1.4, b: 0.1 },
    });
    expect(getPlattByPhase()?.EARLY?.a).toBe(0.85);
    expect(calibrateLogit(1.0, 12 / 15)).toBeCloseTo(1 / (1 + Math.exp(-0.85)), 9);
    expect(calibrateLogit(1.0, 1 / 15)).toBeCloseTo(1 / (1 + Math.exp(-(1.4 * 1.0 + 0.1))), 9);
    expect(calibrateLogit(1.0, 7 / 15)).toBeCloseTo(globalP, 9);
    expect(calibrateLogit(1.0, Number.NaN)).toBeCloseTo(globalP, 9);
    expect(calibrateLogitWith(0.0, 1.0, 0.0, null)).toBe(0.5);
  });

  it('LightGBM predictor uses platt_by_phase when present on model JSON', () => {
    const rawLgb = {
      format: 'lightgbm_json_v2',
      version: 2,
      num_features: 54,
      num_trees: 1,
      feature_names: [],
      init_score: 0.5,
      platt_a: 1.0,
      platt_b: 0.0,
      platt_on_logits: true,
      platt_by_phase: {
        EARLY: { a: 0.8, b: 0.0 },
        VERY_LATE: { a: 1.4, b: 0.0 },
      },
      tree_info: [{ tree_structure: { leaf_value: 0.5 } }],
    };
    loadLgbModelFromData(rawLgb);
    const featsEarly = new Float64Array(54);
    featsEarly[FI.minutes_left_norm] = 12 / 15;
    expect(predictLgb(featsEarly)).toBeCloseTo(1 / (1 + Math.exp(-0.8)), 9);

    const featsVeryLate = new Float64Array(54);
    featsVeryLate[FI.minutes_left_norm] = 1 / 15;
    expect(predictLgb(featsVeryLate)).toBeCloseTo(1 / (1 + Math.exp(-1.4)), 9);
  });
});
