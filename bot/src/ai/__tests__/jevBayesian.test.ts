import { describe, it, expect } from 'vitest';
import {
  probToOdds,
  oddsToProb,
  dampenLr,
  computeBayesianAnchor,
  normalizeTypesafeScore,
  computeCompositeRiskScore,
  computeBullBearDebate,
  computeAdaptiveBayesianWeight,
  summarizeEpisodicMemory,
  computeEmpiricalRiskThreshold,
  routeJevDecision,
  evaluateBrierSkillGate,
} from '../jevBayesian.ts';

describe('Bayesian log-odds anchoring', () => {
  it('round-trips odds conversions with safe boundary clamping', () => {
    expect(oddsToProb(probToOdds(0.65))).toBeCloseTo(0.65, 6);
    expect(oddsToProb(probToOdds(0.25))).toBeCloseTo(0.25, 6);
    expect(oddsToProb(probToOdds(0))).toBeGreaterThan(0);
    expect(oddsToProb(probToOdds(1))).toBeLessThan(1);
    expect(dampenLr(4, 0)).toBe(1);
    expect(dampenLr(4, 0.5)).toBeCloseTo(2, 6);
  });

  it('anchors JEV probability toward market prior proportional to confidence', () => {
    const lowConf = computeBayesianAnchor(0.50, 0.80, 0.0, 0.25);
    expect(lowConf.posterior).toBeCloseTo(0.50, 5);

    const midConf = computeBayesianAnchor(0.50, 0.80, 0.5, 0.25);
    const highConf = computeBayesianAnchor(0.50, 0.80, 1.0, 0.25);
    expect(midConf.posterior).toBeGreaterThan(0.50);
    expect(highConf.posterior).toBeGreaterThan(midConf.posterior);
    expect(highConf.posterior).toBeLessThan(0.80);
  });

  it('falls back cleanly when market prior is absent', () => {
    const res = computeBayesianAnchor(null, 0.62, 0.8, 0.25);
    expect(res.posterior).toBeCloseTo(0.62, 5);
  });
});

describe('Composite Risk Desk & 3-zone routing', () => {
  it('normalizes 5-level TypeSafe scores and aggregates weights', () => {
    expect(normalizeTypesafeScore(0, 5)).toBe(0);
    expect(normalizeTypesafeScore(2, 5)).toBeCloseTo(0.5, 6);
    expect(normalizeTypesafeScore(4, 5)).toBe(1);
    expect(normalizeTypesafeScore(5, 5)).toBe(1);

    const res = computeCompositeRiskScore({
      chopHazard: { normalized: 0.8, confidence: 0.9 },
      exhaustionRisk: { normalized: 0.6, confidence: 0.7 },
      flowContradiction: { normalized: 0.4, confidence: 0.8 },
    });
    // 0.40*0.8 + 0.35*0.6 + 0.25*0.4 = 0.32 + 0.21 + 0.10 = 0.63
    expect(res.compositeRisk).toBeCloseTo(0.63, 6);
    expect(res.dimensionsPresent).toBe(3);
    expect(res.riskConfidence).toBeCloseTo(0.40 * 0.9 + 0.35 * 0.7 + 0.25 * 0.8, 6);
  });

  it('re-normalizes partial risk dimensions cleanly', () => {
    const partial = computeCompositeRiskScore({
      chopHazard: { normalized: 1.0, confidence: 0.8 },
    });
    expect(partial.compositeRisk).toBeCloseTo(1.0, 6);
    expect(partial.dimensionsPresent).toBe(1);

    const empty = computeCompositeRiskScore({});
    expect(empty.compositeRisk).toBeNull();
  });

  it('routes high risk to risk_veto, high dir conf to confident, low to passthrough', () => {
    expect(routeJevDecision({
      direction: 'UP',
      directionConfidence: 0.8,
      compositeRisk: 0.82,
      riskConfidence: 0.70,
      minConfidence: 0.60,
    })).toBe('risk_veto');

    expect(routeJevDecision({
      direction: 'DOWN',
      directionConfidence: 0.70,
      compositeRisk: 0.30,
      riskConfidence: 0.80,
      minConfidence: 0.60,
    })).toBe('confident');

    expect(routeJevDecision({
      direction: 'UP',
      directionConfidence: 0.45,
      compositeRisk: 0.85,
      riskConfidence: 0.30, // below minRiskConfidence
      minConfidence: 0.60,
    })).toBe('uncertain_passthrough');
  });
});

describe('Rolling Brier Skill Gate', () => {
  it('stays in warmup under minSamples, passes when JEV beats market, demotes when worse', () => {
    const few = Array.from({ length: 10 }, (_, i) => ({
      slug: `m-${i}`, ts: i, marketProbUp: 0.5, jevProbUp: 0.8, outcomeUp: 0 as const,
    }));
    const warm = evaluateBrierSkillGate(few, { minSamples: 30 });
    expect(warm.status).toBe('warmup');
    expect(warm.allowActiveVeto).toBe(true);

    const good = Array.from({ length: 40 }, (_, i) => ({
      slug: `g-${i}`, ts: i, marketProbUp: 0.50, jevProbUp: i % 2 === 0 ? 0.70 : 0.30, outcomeUp: (i % 2 === 0 ? 1 : 0) as 0 | 1,
    }));
    const pass = evaluateBrierSkillGate(good, { minSamples: 30 });
    expect(pass.status).toBe('pass');
    expect(pass.allowActiveVeto).toBe(true);
    expect(pass.skillScore!).toBeGreaterThan(0);

    const bad = Array.from({ length: 40 }, (_, i) => ({
      slug: `b-${i}`, ts: i, marketProbUp: 0.50, jevProbUp: i % 2 === 0 ? 0.25 : 0.75, outcomeUp: (i % 2 === 0 ? 1 : 0) as 0 | 1,
    }));
    const demoted = evaluateBrierSkillGate(bad, { minSamples: 30 });
    expect(demoted.status).toBe('demoted');
    expect(demoted.allowActiveVeto).toBe(false);
    expect(demoted.skillScore!).toBeLessThan(0);
  });
});

describe('JEV v4 debate, adaptive Bayesian weight, episodic memory & conformal threshold', () => {
  it('computes symmetric bull/bear debate conviction and disagreement, and folds optional disagreement into compositeRisk', () => {
    const bullDom = computeBullBearDebate({ normalized: 0.85, confidence: 0.8 }, { normalized: 0.15, confidence: 0.6 });
    expect(bullDom.netConviction).toBeCloseTo(0.70, 4);
    expect(bullDom.disagreement).toBeCloseTo(0.30, 4);
    expect(bullDom.confidence).toBeCloseTo(0.70, 4);

    const deadlock = computeBullBearDebate({ normalized: 0.8, confidence: 0.9 }, { normalized: 0.8, confidence: 0.9 });
    expect(deadlock.netConviction).toBeCloseTo(0, 4);
    expect(deadlock.disagreement).toBeCloseTo(1.0, 4);

    const partialDebate = computeBullBearDebate({ normalized: 0.6, confidence: 0.7 }, null);
    expect(partialDebate.bullStrength).toBeCloseTo(0.6, 4);
    expect(partialDebate.disagreement).toBeNull();

    const withDebate = computeCompositeRiskScore({
      chopHazard: { normalized: 0.5, confidence: 0.8 },
      exhaustionRisk: { normalized: 0.5, confidence: 0.8 },
      flowContradiction: { normalized: 0.5, confidence: 0.8 },
      debateDisagreement: { normalized: 1.0, confidence: 0.8 },
    });
    // (0.40*0.5 + 0.35*0.5 + 0.25*0.5 + 0.20*1.0) / 1.20 = 0.70 / 1.20 = 0.583333
    expect(withDebate.dimensionsPresent).toBe(4);
    expect(withDebate.compositeRisk).toBeCloseTo(0.70 / 1.20, 4);
  });

  it('scales Bayesian weight adaptively with rolling Brier skill', () => {
    expect(computeAdaptiveBayesianWeight(0, null)).toBe(0);
    expect(computeAdaptiveBayesianWeight(0.20, { status: 'warmup', allowActiveVeto: true, samples: 5, minSamples: 30, windowSize: 100, jevBrier: null, marketBrier: null, skillScore: null })).toBeCloseTo(0.10, 4);
    const negWeight = computeAdaptiveBayesianWeight(0.20, { status: 'demoted', allowActiveVeto: false, samples: 50, minSamples: 30, windowSize: 100, jevBrier: 0.25, marketBrier: 0.23, skillScore: -0.08 });
    expect(negWeight).toBeLessThan(0.10);
    expect(negWeight).toBeGreaterThanOrEqual(0.02);
    const posWeight = computeAdaptiveBayesianWeight(0.20, { status: 'pass', allowActiveVeto: true, samples: 50, minSamples: 30, windowSize: 100, jevBrier: 0.21, marketBrier: 0.24, skillScore: 0.125 });
    expect(posWeight).toBeGreaterThan(0.20);
    expect(posWeight).toBeLessThanOrEqual(0.45);
  });

  it('summarizes episodic memory (streak, whipsaw, hit rate, bias, recent misses) and conformal risk threshold', () => {
    const entries = [
      { slug: 'm-1', ts: 1, direction: 'DOWN' as const, rawProbUp: 0.30, marketProbUp: 0.55, outcomeUp: 1 as const, regime: 'trending_up', compositeRisk: 0.50 },
      { slug: 'm-2', ts: 2, direction: 'DOWN' as const, rawProbUp: 0.35, marketProbUp: 0.52, outcomeUp: 0 as const, regime: 'trending_down', compositeRisk: 0.60 },
      { slug: 'm-3', ts: 3, direction: 'UP' as const, rawProbUp: 0.60, marketProbUp: 0.50, outcomeUp: 1 as const, regime: 'trending_up', compositeRisk: 0.45 },
      { slug: 'm-4', ts: 4, direction: 'DOWN' as const, rawProbUp: 0.25, marketProbUp: 0.48, outcomeUp: 1 as const, regime: 'mean_reverting', compositeRisk: 0.72 },
    ];
    const sum = summarizeEpisodicMemory(entries, 12);
    expect(sum.sampleCount).toBe(4);
    expect(sum.marketUpRate).toBeCloseTo(0.75, 4);
    expect(sum.streakSide).toBe('UP');
    expect(sum.streakLength).toBe(2); // m-3 and m-4 both outcomeUp=1
    expect(sum.whipsawRate).toBeCloseTo(2 / 3, 4); // 1->0, 0->1, 1->1 => 2 flips / 3
    expect(sum.jevDownCallRate).toBeCloseTo(0.75, 4);
    expect(sum.jevDirectionHitRate).toBeCloseTo(0.50, 4);
    expect(sum.jevProbBias!).toBeLessThan(0); // negative bias when under-predicting UP
    expect(sum.recentMisses.map((m) => m.slug)).toEqual(['m-4', 'm-1']);

    // Empirical risk threshold: fallback below minSamples, quantile >= minSamples clamped to [0.58, 0.85]
    expect(computeEmpiricalRiskThreshold(entries, { minSamples: 25, fallbackThreshold: 0.78 })).toBe(0.78);
    const many = Array.from({ length: 40 }, (_, i) => ({
      slug: `r-${i}`, ts: i, direction: 'NO_EDGE' as const, rawProbUp: 0.5, marketProbUp: 0.5, outcomeUp: (i % 2) as 0 | 1,
      compositeRisk: 0.40 + (i / 39) * 0.30, // 0.40 .. 0.70
    }));
    const thresh = computeEmpiricalRiskThreshold(many, { targetVetoRate: 0.15, minSamples: 25 });
    expect(thresh).toBeGreaterThanOrEqual(0.58);
    expect(thresh).toBeLessThanOrEqual(0.70);
  });
});
