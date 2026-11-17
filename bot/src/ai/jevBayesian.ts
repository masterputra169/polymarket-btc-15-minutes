/**
 * JEV Bayesian anchoring, Composite Risk Desk scoring, and Rolling Brier Skill Guard.
 *
 * Adapted from:
 *   - skharchikov/polymarket-bot (trading-bot/src/bayesian.rs): log-odds prior anchoring +
 *     confidence-dampened likelihood ratio updates (LR^confidence).
 *   - thiagoadril/typesafe-docs (016-confidence-gated-routing, 017-composite-scoring):
 *     atomic `score` dimensions combined in code, with uncertain inputs passed through.
 *   - 1arley/jev-advisor-gateway: fail-safe pass-through when JEV lacks proven edge.
 */

export interface BayesianAnchorResult {
  posterior: number;
  priorOdds: number;
  likelihoodRatio: number;
  effectiveWeight: number;
}

export interface RiskDimensionScore {
  /** Normalized score in [0, 1], derived from TypeSafe `score / (criteriaCount - 1)`. */
  normalized: number;
  /** Confidence reported by TypeSafe for this dimension in [0, 1]. */
  confidence: number;
}

export interface RiskDeskScores {
  chopHazard?: RiskDimensionScore | null;
  exhaustionRisk?: RiskDimensionScore | null;
  flowContradiction?: RiskDimensionScore | null;
}

export interface CompositeRiskResult {
  compositeRisk: number | null;
  riskConfidence: number;
  dimensionsPresent: number;
}

export type ConfidenceRoute = 'risk_veto' | 'confident' | 'uncertain_passthrough';

export interface BrierObservation {
  slug: string;
  ts: number;
  marketProbUp: number;
  jevProbUp: number;
  outcomeUp: 0 | 1;
}

export interface BrierSkillReport {
  status: 'warmup' | 'pass' | 'demoted';
  allowActiveVeto: boolean;
  samples: number;
  minSamples: number;
  windowSize: number;
  jevBrier: number | null;
  marketBrier: number | null;
  /** Brier skill score: 1 - jevBrier / marketBrier (> 0 means JEV beats market). */
  skillScore: number | null;
}

const PROB_MIN = 1e-4;
const PROB_MAX = 1 - PROB_MIN;

export function clampProb(p: number): number {
  if (!Number.isFinite(p)) return 0.5;
  return Math.max(PROB_MIN, Math.min(PROB_MAX, p));
}

export function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

/** Convert probability p in (0, 1) to odds p / (1 - p). */
export function probToOdds(p: number): number {
  const c = clampProb(p);
  return c / (1 - c);
}

/** Convert positive odds back to probability odds / (1 + odds). */
export function oddsToProb(odds: number): number {
  if (!Number.isFinite(odds) || odds <= 0) return PROB_MIN;
  if (!Number.isFinite(odds / (1 + odds))) return PROB_MAX;
  return clampProb(odds / (1 + odds));
}

/**
 * Confidence-dampened likelihood ratio: LR^confidence.
 * Zero confidence gives LR=1 (no update to prior); full confidence gives full LR.
 */
export function dampenLr(lr: number, confidence: number): number {
  if (!Number.isFinite(lr) || lr <= 0) return 1;
  const c = clamp01(confidence);
  return Math.pow(lr, c);
}

/**
 * Anchor JEV's calibrated settle probability onto the live Polymarket market odds prior.
 * Computes LR = odds(jevCalibrated) / odds(marketPrior), dampened by `confidence * maxWeight`.
 * Mathematically equivalent to convex log-odds shrinkage toward the market prior.
 */
export function computeBayesianAnchor(
  marketPrior: number | null | undefined,
  jevCalibratedProb: number,
  confidence: number,
  maxWeight = 0.20,
): BayesianAnchorResult {
  const jevClean = clampProb(jevCalibratedProb);
  if (marketPrior == null || !Number.isFinite(marketPrior) || marketPrior <= 0 || marketPrior >= 1) {
    const odds = probToOdds(jevClean);
    return { posterior: jevClean, priorOdds: odds, likelihoodRatio: 1, effectiveWeight: 1 };
  }
  const prior = clampProb(marketPrior);
  const priorOdds = probToOdds(prior);
  const targetOdds = probToOdds(jevClean);
  const lr = targetOdds / priorOdds;
  const effectiveWeight = clamp01(clamp01(confidence) * clamp01(maxWeight));
  const dampened = dampenLr(lr, effectiveWeight);
  const posterior = oddsToProb(priorOdds * dampened);
  return { posterior, priorOdds, likelihoodRatio: lr, effectiveWeight };
}

/** Normalize a TypeSafe `score` response (0..levels-1 expected value) onto [0, 1]. */
export function normalizeTypesafeScore(rawScore: number, levelsCount: number): number | null {
  if (!Number.isFinite(rawScore) || !Number.isFinite(levelsCount) || levelsCount < 2) return null;
  return clamp01(rawScore / (levelsCount - 1));
}

export const RISK_DESK_WEIGHTS = {
  chopHazard: 0.40,
  exhaustionRisk: 0.35,
  flowContradiction: 0.25,
} as const;

/**
 * Combine independent TypeSafe Risk Desk `score` dimensions with deterministic weights.
 * Re-normalizes weights if one or more dimensions are absent (backward-compatible logs).
 */
export function computeCompositeRiskScore(scores: RiskDeskScores | null | undefined): CompositeRiskResult {
  if (!scores) return { compositeRisk: null, riskConfidence: 0, dimensionsPresent: 0 };
  const dims: Array<{ w: number; val: number; conf: number }> = [];
  const entries: Array<[keyof typeof RISK_DESK_WEIGHTS, RiskDimensionScore | null | undefined]> = [
    ['chopHazard', scores.chopHazard],
    ['exhaustionRisk', scores.exhaustionRisk],
    ['flowContradiction', scores.flowContradiction],
  ];
  for (const [key, item] of entries) {
    if (item && Number.isFinite(item.normalized)) {
      dims.push({
        w: RISK_DESK_WEIGHTS[key],
        val: clamp01(item.normalized),
        conf: clamp01(item.confidence),
      });
    }
  }
  if (dims.length === 0) {
    return { compositeRisk: null, riskConfidence: 0, dimensionsPresent: 0 };
  }
  const totalW = dims.reduce((acc, d) => acc + d.w, 0);
  const compositeRisk = dims.reduce((acc, d) => acc + (d.w / totalW) * d.val, 0);
  const riskConfidence = dims.reduce((acc, d) => acc + (d.w / totalW) * d.conf, 0);
  return { compositeRisk: clamp01(compositeRisk), riskConfidence: clamp01(riskConfidence), dimensionsPresent: dims.length };
}

/**
 * 3-zone confidence routing:
 *  1) Risk Desk override when composite risk >= threshold with sufficient confidence.
 *  2) High directional confidence -> eligible for veto / gate / sizing.
 *  3) Uncertain -> pass-through unchanged.
 */
export function routeJevDecision(params: {
  direction: 'UP' | 'DOWN' | 'NO_EDGE';
  directionConfidence: number;
  compositeRisk: number | null;
  riskConfidence: number;
  minConfidence: number;
  riskVetoThreshold?: number;
  minRiskConfidence?: number;
}): ConfidenceRoute {
  const riskThresh = params.riskVetoThreshold ?? 0.78;
  const minRiskConf = params.minRiskConfidence ?? 0.60;
  if (
    params.compositeRisk != null &&
    Number.isFinite(params.compositeRisk) &&
    params.compositeRisk >= riskThresh &&
    params.riskConfidence >= minRiskConf
  ) {
    return 'risk_veto';
  }
  if (params.direction !== 'NO_EDGE' && params.directionConfidence >= params.minConfidence) {
    return 'confident';
  }
  return 'uncertain_passthrough';
}

/**
 * Evaluate JEV rolling Brier skill against market odds on resolved windows.
 * Auto-demotes active veto once >= `minSamples` are observed and JEV trails market Brier.
 */
export function evaluateBrierSkillGate(
  observations: readonly BrierObservation[],
  opts: { windowSize?: number; minSamples?: number; tolerance?: number; enabled?: boolean } = {},
): BrierSkillReport {
  const windowSize = Math.max(10, opts.windowSize ?? 100);
  const minSamples = Math.max(5, opts.minSamples ?? 30);
  const tolerance = opts.tolerance ?? 0.002;
  const enabled = opts.enabled ?? true;
  const recent = observations.slice(-windowSize);
  const samples = recent.length;
  if (samples === 0) {
    return {
      status: 'warmup',
      allowActiveVeto: true,
      samples: 0,
      minSamples,
      windowSize,
      jevBrier: null,
      marketBrier: null,
      skillScore: null,
    };
  }
  let jevSum = 0;
  let mktSum = 0;
  for (const obs of recent) {
    const jErr = obs.jevProbUp - obs.outcomeUp;
    const mErr = obs.marketProbUp - obs.outcomeUp;
    jevSum += jErr * jErr;
    mktSum += mErr * mErr;
  }
  const jevBrier = jevSum / samples;
  const marketBrier = mktSum / samples;
  const skillScore = marketBrier > 1e-9 ? 1 - jevBrier / marketBrier : 0;
  if (samples < minSamples) {
    return { status: 'warmup', allowActiveVeto: true, samples, minSamples, windowSize, jevBrier, marketBrier, skillScore };
  }
  const pass = !enabled || jevBrier <= marketBrier + tolerance;
  return {
    status: pass ? 'pass' : 'demoted',
    allowActiveVeto: pass,
    samples,
    minSamples,
    windowSize,
    jevBrier,
    marketBrier,
    skillScore,
  };
}
