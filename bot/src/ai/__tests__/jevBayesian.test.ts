import { describe, it, expect } from 'vitest';
import {
  probToOdds,
  oddsToProb,
  dampenLr,
  computeBayesianAnchor,
  normalizeTypesafeScore,
  computeCompositeRiskScore,
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
