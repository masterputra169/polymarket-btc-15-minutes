/**
 * Deploy gate for retrained models (retrainGate.ts).
 *
 * 2026-09-23: the deployed model passed every gate at 78% / AUC 0.87 and still
 * predicted worse than the market price at the same instant. The gate now
 * requires skill against the market, and it no longer compares accuracy
 * across a feature-pipeline change, where the old number carried a 60s
 * look-ahead the new one cannot have.
 */

import { describe, test, expect } from 'vitest';
import { qualityGate, type GateConfig, type ModelMetrics } from '../retrainGate.ts';

const CFG: GateConfig = {
  minAccuracy: 0.70, minAuc: 0.80,
  minHighConfAccuracy: 0.78, minHighConfCoverage: 5, maxHighConfCoverage: 98,
  maxCalibrationEce: 0.08, maxCvTestAccGap: 0.04, maxTestHoldoutAccGap: 0.08,
  maxAccDrop: 0.02, maxAucDrop: 0.01,
  requireStrictHoldout: true,
  minMarketSkill: 0,
};

const GOOD_XGB = {
  high_conf_accuracy: 0.82, high_conf_ratio: 40, calibration_ece: 0.02,
  cv_test_acc_gap: 0.01, test_holdout_acc_gap: 0.01,
  validation: { strict_holdout: true },
  brier_skill_vs_market: 0.03,
};

function fresh(overrides: Partial<Record<string, unknown>> = {}, pipeline = 2): ModelMetrics {
  return {
    xgb: GOOD_XGB, lgb: {},
    ensemble: { accuracy: 0.76, auc: 0.84, brier_skill_vs_market: 0.03, ...overrides },
    featurePipeline: pipeline,
  };
}

const CURRENT_V1: ModelMetrics = {
  xgb: {}, lgb: {}, ensemble: { accuracy: 0.783, auc: 0.8715 }, featurePipeline: 1,
};

const byName = (r: ReturnType<typeof qualityGate>, name: string) => r.checks.find(c => c.name === name);

describe('market_skill', () => {
  test('a model that beats the same-instant market passes', () => {
    const r = qualityGate(CURRENT_V1, fresh(), CFG);
    expect(byName(r, 'market_skill')?.pass).toBe(true);
    expect(r.pass).toBe(true);
  });

  test('a model that only matches the market fails — zero skill adds nothing', () => {
    const r = qualityGate(CURRENT_V1, fresh({ brier_skill_vs_market: 0 }), CFG);
    expect(byName(r, 'market_skill')?.pass).toBe(false);
    expect(r.pass).toBe(false);
  });

  test('a model the market out-predicts fails, however good its accuracy', () => {
    const r = qualityGate(CURRENT_V1, fresh({ accuracy: 0.9, auc: 0.95, brier_skill_vs_market: -0.03 }), CFG);
    expect(byName(r, 'market_skill')?.pass).toBe(false);
    expect(r.pass).toBe(false);
  });

  test('a model without the metric fails and says why', () => {
    const r = qualityGate(CURRENT_V1, fresh({ brier_skill_vs_market: undefined }), CFG);
    const c = byName(r, 'market_skill')!;
    expect(c.pass).toBe(false);
    expect(c.detail).toContain('missing');
  });
});

describe('relative checks only compare like with like', () => {
  test('across a feature-pipeline change they are skipped, with the reason', () => {
    // The v1 model's 78.3% was measured on rows with a 60s look-ahead.
    const r = qualityGate(CURRENT_V1, fresh({ accuracy: 0.74 }), CFG);
    expect(byName(r, 'rel_accuracy')).toBeUndefined();
    const skip = byName(r, 'rel_skip')!;
    expect(skip.pass).toBe(true);
    expect(skip.detail).toContain('pipeline v1');
    expect(skip.detail).toContain('v2');
  });

  test('on the same pipeline an accuracy drop still blocks', () => {
    const current: ModelMetrics = { xgb: {}, lgb: {}, ensemble: { accuracy: 0.80, auc: 0.86 }, featurePipeline: 2 };
    const r = qualityGate(current, fresh({ accuracy: 0.75 }), CFG);
    expect(byName(r, 'rel_accuracy')?.pass).toBe(false);
    expect(r.pass).toBe(false);
  });

  test('a missing pipeline on either side means v1', () => {
    const current: ModelMetrics = { xgb: {}, lgb: {}, ensemble: { accuracy: 0.80, auc: 0.86 } };
    const r = qualityGate(current, { ...fresh({ accuracy: 0.75 }), featurePipeline: undefined }, CFG);
    expect(byName(r, 'rel_accuracy')?.pass).toBe(false);
  });
});

describe('absolute floors are unchanged', () => {
  test('accuracy under the floor blocks even with market skill', () => {
    const r = qualityGate(CURRENT_V1, fresh({ accuracy: 0.65 }), CFG);
    expect(byName(r, 'abs_accuracy')?.pass).toBe(false);
    expect(r.pass).toBe(false);
  });

  test('no ensemble metrics at all blocks', () => {
    const r = qualityGate(CURRENT_V1, { xgb: null, lgb: null, ensemble: null }, CFG);
    expect(r.pass).toBe(false);
    expect(r.checks[0].name).toBe('no_metrics');
  });
});
