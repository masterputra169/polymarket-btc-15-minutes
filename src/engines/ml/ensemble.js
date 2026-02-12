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

  let ensembleProbUp = alpha * mlProbUp + (1 - alpha) * ruleProbUp;

  if (mlSide === ruleSide) {
    ensembleProbUp += (mlSide ? 1 : -1) * 0.03;
    source += '+agree';
  } else {
    ensembleProbUp = 0.5 + (ensembleProbUp - 0.5) * 0.75;
    source += '+conflict';
  }

  ensembleProbUp = Math.max(0.01, Math.min(0.99, ensembleProbUp));

  return { ensembleProbUp, alpha, source };
}
