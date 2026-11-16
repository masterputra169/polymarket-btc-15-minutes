/**
 * Unit + artifact verification tests for Pipeline v4 Hybrid Residual overlay.
 *
 * Covers:
 *   1. Exact logit residual evaluation (`sigmoid(logit(base) + sum(leaves))`).
 *   2. Strict base model anchoring (`requires_base_model_id`) & runtime disable flag.
 *   3. Real exported artifact `public/ml/hybrid_residual_v4.json` + live `mlLoader` startup.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, test, expect, afterEach } from 'vitest';
import {
  applyHybridResidual,
  getHybridResidualInfo,
  isHybridResidualReady,
  loadHybridResidualFromData,
  setHybridResidualEnabled,
  unloadHybridResidual,
  type HybridResidualInputs,
} from '../../../../src/engines/ml/hybridResidual.ts';
import { loadMLModelFromDisk, getModelId, getMLPrediction } from '../../adapters/mlLoader.ts';
import { unloadMLModel } from '../../../../src/engines/Mlpredictor.ts';
import { aggregate5m, CANDLES_5M } from '../../../../src/engines/ml/trainingRow.ts';
import { buildMlFeatureInputs } from '../../../../src/engines/ml/featureInputs.ts';

const SAMPLE_INPUTS: HybridResidualInputs = {
  oraclePtbDistPct: -0.00025,
  twapPhysicsZ: -0.35,
  basisPct: 0.001,
  basisDriftPct: 0.00045,
  crossFeedLead: 0.00015,
  orderbookImbalance: -0.25,
  spreadPct: 0.01,
  imb1: 0.4,
  imb5: 0.35,
  minutesLeftNorm: 0.5,
  marketYesPrice: 0.49,
  crowdModelDivergence: 0.14,
};

afterEach(() => {
  unloadHybridResidual();
  setHybridResidualEnabled(true);
});

describe('hybridResidual overlay module', () => {
  test('evaluates logit(base) + leaf sum accurately and enforces requires_base_model_id', () => {
    const ok = loadHybridResidualFromData({
      id: 'unit-hyb',
      requires_base_model_id: '20261116-p2-ef8dfd',
      feature_names: ['basis_drift_pct', 'v2_minus_mkt_logit'],
      best_iteration: 0,
      trees: [
        {
          nodeid: 0,
          split: 'basis_drift_pct',
          split_condition: 0.0003,
          yes: 1,
          no: 2,
          missing: 2,
          children: [
            { nodeid: 1, leaf: 0.25 },
            { nodeid: 2, leaf: -0.5 },
          ],
        },
      ],
    });
    expect(ok).toBe(true);
    expect(isHybridResidualReady('20261116-p2-ef8dfd')).toBe(true);
    expect(isHybridResidualReady('20261114-p2-9384fe')).toBe(false);

    // Mismatched base model must stand down and return exact base probability
    const standDown = applyHybridResidual(0.62, SAMPLE_INPUTS, '20261114-p2-9384fe');
    expect(standDown).toEqual({ probUp: 0.62, deltaProb: 0, active: false, id: null });

    // Matching base model shifts logit(0.62) by -0.5 (basisDriftPct 0.00045 >= 0.0003)
    const applied = applyHybridResidual(0.62, SAMPLE_INPUTS, '20261116-p2-ef8dfd');
    const expectedLogit = Math.log(0.62 / 0.38) - 0.5;
    const expectedProb = 1 / (1 + Math.exp(-expectedLogit));
    expect(applied.active).toBe(true);
    expect(applied.id).toBe('unit-hyb');
    expect(applied.probUp).toBeCloseTo(expectedProb, 8);
    expect(applied.deltaProb).toBeCloseTo(expectedProb - 0.62, 8);

    // Runtime disable switch works cleanly
    setHybridResidualEnabled(false);
    expect(applyHybridResidual(0.62, SAMPLE_INPUTS, '20261116-p2-ef8dfd').active).toBe(false);
  });

  test('loads exported public/ml/hybrid_residual_v4.json and applies cleanly on top of live 395d v2 model', () => {
    const root = resolve(__dirname, '..', '..', '..', '..');
    const rawJson = JSON.parse(readFileSync(resolve(root, 'public', 'ml', 'hybrid_residual_v4.json'), 'utf-8'));
    expect(rawJson.requires_base_model_id).toBe('20261116-p2-ef8dfd');
    expect(rawJson.metrics?.max_inference_diff).toBeLessThan(1e-5);

    unloadMLModel();
    expect(loadMLModelFromDisk(true)).toBe(true);
    expect(getModelId()).toBe('20261116-p2-ef8dfd');

    const info = getHybridResidualInfo(getModelId());
    expect(info.loaded).toBe(true);
    expect(info.active).toBe(true);
    expect(info.trees).toBeGreaterThan(50);

    const minMs = 60_000;
    const nowMs = Date.UTC(2026, 10, 16, 13, 0, 0);
    const endOpen = Math.floor(nowMs / minMs) * minMs;
    const k1 = Array.from({ length: 240 }, (_, i) => {
      const openTime = endOpen - (239 - i) * minMs;
      const p = 90_000 + i * 2;
      return { openTime, open: p, high: p + 8, low: p - 8, close: p + 2, volume: 100, takerBuyVolume: 55 };
    });
    const k5 = aggregate5m(k1).slice(-CANDLES_5M);
    const windowOpen = k1[k1.length - 8].open;

    const shared = buildMlFeatureInputs({
      candles1m: k1,
      candles5m: k5,
      lastPrice: 90_520,
      windowOpenPrice: windowOpen,
      minutesLeft: 7.5,
      nowMs,
      marketUp: 0.49,
      marketUpLag: 0.48,
    });

    const baseOnly = getMLPrediction(shared.marketState, shared.ruleProbUp, 'moderate', {
      featureRuleProbUp: shared.ruleProbUp,
    });
    const withHybrid = getMLPrediction(shared.marketState, shared.ruleProbUp, 'moderate', {
      featureRuleProbUp: shared.ruleProbUp,
      hybridInputs: SAMPLE_INPUTS,
    });

    expect(baseOnly.available).toBe(true);
    expect(baseOnly.hybridActive).toBe(false);
    expect(withHybrid.available).toBe(true);
    expect(withHybrid.hybridActive).toBe(true);
    expect(withHybrid.baseMlProbUp).toBeCloseTo(baseOnly.mlProbUp!, 6);
    expect(withHybrid.mlProbUp).toBeGreaterThan(0.01);
    expect(withHybrid.mlProbUp).toBeLessThan(0.99);
    expect(withHybrid.source).toContain('+v4Hyb');

    unloadMLModel();
  });
});
