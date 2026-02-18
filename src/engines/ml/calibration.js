/**
 * Platt sigmoid calibration for XGBoost predictions.
 *
 * v9: Two calibration paths:
 *   - calibrateLogit(logit): sigmoid(A*logit + B) — correct Platt scaling on raw logits
 *   - calibrate(rawProb): sigmoid(A*prob + B) — legacy double-sigmoid for old models
 *
 * The model's platt_on_logits flag determines which path is used.
 */

import * as S from './state.js';

/**
 * Platt calibration on raw logit (v9+).
 * Applies sigmoid(A*logit + B) to convert raw logit to calibrated probability.
 */
export function calibrateLogit(logit) {
  if (S.plattA !== 1.0 || S.plattB !== 0.0) {
    return 1 / (1 + Math.exp(-(S.plattA * logit + S.plattB)));
  }
  // Default: standard sigmoid (no Platt adjustment)
  return 1 / (1 + Math.exp(-logit));
}

/**
 * Legacy Platt calibration on post-sigmoid probability (v2 models).
 * Applies sigmoid(A*prob + B) — double-sigmoid, consistent with old training.
 */
export function calibrate(rawProb) {
  if (S.plattA !== 1.0 || S.plattB !== 0.0) {
    return 1 / (1 + Math.exp(-(S.plattA * rawProb + S.plattB)));
  }
  return rawProb;
}
