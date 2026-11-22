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
  debateDisagreement?: RiskDimensionScore | null;
}

export interface CompositeRiskResult {
  compositeRisk: number | null;
  riskConfidence: number;
  dimensionsPresent: number;
}

export interface BullBearDebateResult {
  bullStrength: number | null;
  bearStrength: number | null;
  netConviction: number | null;
  disagreement: number | null;
  confidence: number;
}

export interface JevMemoryEntry {
  slug: string;
  ts: number;
  direction: 'UP' | 'DOWN' | 'NO_EDGE';
  rawProbUp: number;
  marketProbUp: number;
  outcomeUp: 0 | 1;
  regime?: string | null;
  compositeRisk?: number | null;
  stateVariant?: string | null;
}

export interface MultiSignalPosteriorResult {
  posterior: number;
  priorOdds: number;
  settleLr: number;
  debateLr: number;
  effectiveWeight: number;
  debateWeight: number;
}

export interface JevEpisodicMemorySummary {
  sampleCount: number;
  marketUpRate: number | null;
  streakSide: 'UP' | 'DOWN' | null;
  streakLength: number;
  whipsawRate: number | null;
  jevUpCallRate: number | null;
  jevDownCallRate: number | null;
  jevDirectionHitRate: number | null;
  jevProbBias: number | null;
  recentMisses: Array<{
    slug: string;
    predicted: 'UP' | 'DOWN';
    outcome: 'UP' | 'DOWN';
    marketUp: number;
    rawProbUp: number;
    regime: string | null;
  }>;
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
  if (scores.debateDisagreement && Number.isFinite(scores.debateDisagreement.normalized)) {
    dims.push({
      w: 0.20,
      val: clamp01(scores.debateDisagreement.normalized),
      conf: clamp01(scores.debateDisagreement.confidence),
    });
  }
  if (dims.length === 0) {
    return { compositeRisk: null, riskConfidence: 0, dimensionsPresent: 0 };
  }
  const totalW = dims.reduce((acc, d) => acc + d.w, 0);
  const compositeRisk = dims.reduce((acc, d) => acc + (d.w / totalW) * d.val, 0);
  const riskConfidence = dims.reduce((acc, d) => acc + (d.w / totalW) * d.conf, 0);
  return { compositeRisk: clamp01(compositeRisk), riskConfidence: clamp01(riskConfidence), dimensionsPresent: dims.length };
}

/** Combine opposing bull/bear scores into net conviction and symmetric debate disagreement. */
export function computeBullBearDebate(
  bull: RiskDimensionScore | null | undefined,
  bear: RiskDimensionScore | null | undefined,
): BullBearDebateResult {
  const b = bull && Number.isFinite(bull.normalized) ? clamp01(bull.normalized) : null;
  const r = bear && Number.isFinite(bear.normalized) ? clamp01(bear.normalized) : null;
  if (b == null || r == null) {
    return {
      bullStrength: b != null ? +b.toFixed(4) : null,
      bearStrength: r != null ? +r.toFixed(4) : null,
      netConviction: null,
      disagreement: null,
      confidence: 0,
    };
  }
  const bConf = bull && Number.isFinite(bull.confidence) ? clamp01(bull.confidence) : 0;
  const rConf = bear && Number.isFinite(bear.confidence) ? clamp01(bear.confidence) : 0;
  return {
    bullStrength: +b.toFixed(4),
    bearStrength: +r.toFixed(4),
    netConviction: +(b - r).toFixed(4),
    disagreement: +clamp01(2 * Math.min(b, r)).toFixed(4),
    confidence: +((bConf + rConf) / 2).toFixed(4),
  };
}

/** Scale Bayesian update weight continuously from rolling Brier skill against market mid. */
export function computeAdaptiveBayesianWeight(
  baseMaxWeight: number,
  skillReport: BrierSkillReport | null | undefined,
): number {
  const base = clamp01(baseMaxWeight);
  if (base <= 0) return 0;
  if (!skillReport || skillReport.status === 'warmup' || skillReport.skillScore == null || !Number.isFinite(skillReport.skillScore)) {
    return +(base * 0.5).toFixed(4);
  }
  if (skillReport.skillScore <= 0) {
    return +Math.min(base, Math.max(0.02, base * Math.exp(skillReport.skillScore * 12))).toFixed(4);
  }
  return +Math.min(0.45, base * (1 + skillReport.skillScore * 6)).toFixed(4);
}

/** Summarize recent resolved outcomes and JEV prediction biases for episodic self-reflection. */
export function summarizeEpisodicMemory(
  entries: readonly JevMemoryEntry[],
  recentWindow = 12,
): JevEpisodicMemorySummary {
  const nWin = Math.max(1, Math.floor(recentWindow));
  const slice = entries.slice(-nWin);
  const sampleCount = slice.length;
  if (sampleCount === 0) {
    return {
      sampleCount: 0,
      marketUpRate: null,
      streakSide: null,
      streakLength: 0,
      whipsawRate: null,
      jevUpCallRate: null,
      jevDownCallRate: null,
      jevDirectionHitRate: null,
      jevProbBias: null,
      recentMisses: [],
    };
  }

  let upOutcomes = 0;
  let upCalls = 0;
  let downCalls = 0;
  let dirTotal = 0;
  let dirHits = 0;
  let biasSum = 0;
  let biasN = 0;
  let flips = 0;
  const misses: JevEpisodicMemorySummary['recentMisses'] = [];

  for (let i = 0; i < sampleCount; i++) {
    const e = slice[i];
    if (e.outcomeUp === 1) upOutcomes++;
    if (i > 0 && e.outcomeUp !== slice[i - 1].outcomeUp) flips++;
    if (e.direction === 'UP') {
      upCalls++;
      dirTotal++;
      if (e.outcomeUp === 1) dirHits++;
      else {
        misses.push({
          slug: e.slug,
          predicted: 'UP',
          outcome: 'DOWN',
          marketUp: +e.marketProbUp.toFixed(4),
          rawProbUp: Number.isFinite(e.rawProbUp) ? +e.rawProbUp.toFixed(4) : 0.5,
          regime: e.regime ?? null,
        });
      }
    } else if (e.direction === 'DOWN') {
      downCalls++;
      dirTotal++;
      if (e.outcomeUp === 0) dirHits++;
      else {
        misses.push({
          slug: e.slug,
          predicted: 'DOWN',
          outcome: 'UP',
          marketUp: +e.marketProbUp.toFixed(4),
          rawProbUp: Number.isFinite(e.rawProbUp) ? +e.rawProbUp.toFixed(4) : 0.5,
          regime: e.regime ?? null,
        });
      }
    }
    if (Number.isFinite(e.rawProbUp)) {
      biasSum += e.rawProbUp - e.outcomeUp;
      biasN++;
    }
  }

  const lastOut = slice[sampleCount - 1].outcomeUp;
  const streakSide: 'UP' | 'DOWN' = lastOut === 1 ? 'UP' : 'DOWN';
  let streakLength = 0;
  for (let i = sampleCount - 1; i >= 0; i--) {
    if (slice[i].outcomeUp === lastOut) streakLength++;
    else break;
  }

  return {
    sampleCount,
    marketUpRate: +(upOutcomes / sampleCount).toFixed(4),
    streakSide,
    streakLength,
    whipsawRate: sampleCount >= 2 ? +(flips / (sampleCount - 1)).toFixed(4) : null,
    jevUpCallRate: +(upCalls / sampleCount).toFixed(4),
    jevDownCallRate: +(downCalls / sampleCount).toFixed(4),
    jevDirectionHitRate: dirTotal > 0 ? +(dirHits / dirTotal).toFixed(4) : null,
    jevProbBias: biasN > 0 ? +(biasSum / biasN).toFixed(4) : null,
    recentMisses: misses.slice(-3).reverse(),
  };
}

/** Compute split-conformal empirical compositeRisk cutoff targeting `targetVetoRate` of historical windows. */
export function computeEmpiricalRiskThreshold(
  entries: readonly JevMemoryEntry[],
  opts: {
    targetVetoRate?: number;
    minSamples?: number;
    fallbackThreshold?: number;
    minThreshold?: number;
    maxThreshold?: number;
  } = {},
): number {
  const targetVetoRate = Math.max(0.01, Math.min(0.49, opts.targetVetoRate ?? 0.15));
  const minSamples = Math.max(5, opts.minSamples ?? 25);
  const fallbackThreshold = opts.fallbackThreshold ?? 0.78;
  const minThreshold = opts.minThreshold ?? 0.58;
  const maxThreshold = opts.maxThreshold ?? 0.85;

  const vals: number[] = [];
  for (const e of entries) {
    if (typeof e.compositeRisk === 'number' && Number.isFinite(e.compositeRisk)) {
      vals.push(e.compositeRisk);
    }
  }
  if (vals.length < minSamples) return fallbackThreshold;
  vals.sort((a, b) => a - b);
  const n = vals.length;
  const idx = Math.min(n - 1, Math.max(0, Math.ceil((1 - targetVetoRate) * (n + 1)) - 1));
  const clamped = Math.max(minThreshold, Math.min(maxThreshold, vals[idx]));
  return +clamped.toFixed(4);
}

/**
 * Fuse calibrated settle probability AND high-conviction bull/bear debate into a single
 * market-anchored Bayesian log-odds posterior. Debate only updates when |netConviction| >= 0.15
 * and disagreement < 0.65 (clean one-sided thesis).
 */
export function computeMultiSignalBayesianPosterior(params: {
  marketPrior: number | null | undefined;
  jevCalibratedProb: number;
  directionConfidence: number;
  maxWeight?: number;
  debate?: BullBearDebateResult | null;
  debateMaxWeight?: number;
}): MultiSignalPosteriorResult {
  const base = computeBayesianAnchor(
    params.marketPrior,
    params.jevCalibratedProb,
    params.directionConfidence,
    params.maxWeight ?? 0.20,
  );
  const debate = params.debate;
  if (
    !debate ||
    debate.netConviction == null ||
    !Number.isFinite(debate.netConviction) ||
    Math.abs(debate.netConviction) < 0.15 ||
    (debate.disagreement != null && debate.disagreement >= 0.65)
  ) {
    return {
      posterior: base.posterior,
      priorOdds: base.priorOdds,
      settleLr: base.likelihoodRatio,
      debateLr: 1,
      effectiveWeight: base.effectiveWeight,
      debateWeight: 0,
    };
  }
  const debateProb = clampProb(0.5 + 0.40 * debate.netConviction);
  const debateOdds = probToOdds(debateProb);
  const debateLr = debateOdds / base.priorOdds;
  const debateWeight = clamp01(clamp01(debate.confidence) * clamp01(params.debateMaxWeight ?? 0.12));
  const combinedOdds = probToOdds(base.posterior) * dampenLr(debateLr, debateWeight);
  return {
    posterior: oddsToProb(combinedOdds),
    priorOdds: base.priorOdds,
    settleLr: base.likelihoodRatio,
    debateLr,
    effectiveWeight: base.effectiveWeight,
    debateWeight,
  };
}

/** Check whether JEV's directional call agrees with its parallel bull/bear debate netConviction. */
export function isDirectionDebateConsistent(
  direction: 'UP' | 'DOWN' | 'NO_EDGE',
  netConviction: number | null | undefined,
  contradictionMargin = 0.10,
): boolean {
  if (netConviction == null || !Number.isFinite(netConviction)) return true;
  if (direction === 'UP' && netConviction < -contradictionMargin) return false;
  if (direction === 'DOWN' && netConviction > contradictionMargin) return false;
  return true;
}

/**
 * 3-zone confidence routing with self-consistency guard:
 *  1) Risk Desk override when composite risk >= threshold with sufficient confidence.
 *  2) High directional confidence (and consistent with parallel bull/bear debate) -> confident.
 *  3) Uncertain or internally contradicted -> pass-through unchanged.
 */
export function routeJevDecision(params: {
  direction: 'UP' | 'DOWN' | 'NO_EDGE';
  directionConfidence: number;
  compositeRisk: number | null;
  riskConfidence: number;
  minConfidence: number;
  riskVetoThreshold?: number;
  minRiskConfidence?: number;
  netConviction?: number | null;
}): ConfidenceRoute {
  const riskThresh = params.riskVetoThreshold ?? 0.78;
  const minRiskConf = params.minRiskConfidence ?? 0.45;
  if (
    params.compositeRisk != null &&
    Number.isFinite(params.compositeRisk) &&
    params.compositeRisk >= riskThresh &&
    params.riskConfidence >= minRiskConf
  ) {
    return 'risk_veto';
  }
  if (
    params.direction !== 'NO_EDGE' &&
    params.directionConfidence >= params.minConfidence &&
    isDirectionDebateConsistent(params.direction, params.netConviction)
  ) {
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
