/**
 * Platt sigmoid calibration for XGBoost raw probabilities.
 */

import * as S from './state.js';

export function calibrate(rawProb) {
  if (S.plattA !== 1.0 || S.plattB !== 0.0) {
    return 1 / (1 + Math.exp(-(S.plattA * rawProb + S.plattB)));
  }
  return rawProb;
}
