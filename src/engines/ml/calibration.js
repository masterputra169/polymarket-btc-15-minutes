/**
 * Platt sigmoid calibration for XGBoost raw probabilities.
 *
 * NOTE (Bug 2): Currently applies sigmoid(A * prob + B) where prob is already
 * post-sigmoid. Mathematically, Platt scaling should be sigmoid(A * logit + B)
 * on the raw logit. However, the training code (trainXGBoost_v3.py) also fits
 * LogisticRegression on post-sigmoid probabilities, so training and inference
 * are consistent → predictions are correct.
 *
 * TODO on next retrain: fit Platt on raw logits for optimal calibration.
 * This requires saving pre-sigmoid predictions during CV in the training script,
 * then passing raw logit (not prob) here.
 */

import * as S from './state.js';

export function calibrate(rawProb) {
  if (S.plattA !== 1.0 || S.plattB !== 0.0) {
    return 1 / (1 + Math.exp(-(S.plattA * rawProb + S.plattB)));
  }
  return rawProb;
}
