/**
 * ML + Rule-based ensemble prediction.
 */

import { ML_CONFIDENCE } from '../../config.js';

export function ensemblePrediction(mlProbUp, mlConfidence, ruleProbUp, isHighConfidence) {
  let alpha, source;

  if (isHighConfidence && mlConfidence >= ML_CONFIDENCE.HIGH) {
    alpha = 0.80;
    source = 'ML-high-conf';
  } else if (mlConfidence >= ML_CONFIDENCE.HIGH) {
    alpha = 0.70;
    source = 'ML-dominant';
  } else if (mlConfidence >= ML_CONFIDENCE.MEDIUM) {
    alpha = 0.50;
    source = 'Equal blend';
  } else {
    alpha = 0.30;
    source = 'Rule-dominant';
  }

  const mlSide = mlProbUp >= 0.5;
  const ruleSide = ruleProbUp >= 0.5;

  // Audit fix C5: Removed non-Bayesian agreement bonus (+3%) and conflict shrinkage (0.75x).
  // The rule_prob_up is already an ML feature — boosting when both agree double-counts
  // shared biases. The weighted blend via alpha already handles confidence weighting.
  let ensembleProbUp = alpha * mlProbUp + (1 - alpha) * ruleProbUp;

  if (mlSide === ruleSide) {
    source += '+agree';
  } else {
    source += '+conflict';
  }

  ensembleProbUp = Math.max(0.01, Math.min(0.99, ensembleProbUp));

  return { ensembleProbUp, alpha, source };
}
