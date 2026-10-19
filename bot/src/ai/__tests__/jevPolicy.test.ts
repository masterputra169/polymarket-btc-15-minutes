import { describe, it, expect } from 'vitest';
import { evaluatePolicyCandidate } from '../jevPolicyShadow.ts';

const settings = { minConfidence: 0.60, maxAsk: 0.70, minEdge: 0.10 };
const base = {
  slug: 'btc-updown-15m-test', ts: Date.now(), iso: new Date().toISOString(),
  direction: 'UP' as const, directionConfidence: 0.70,
  directionProbabilities: { UP: 0.75, DOWN: 0.20, NO_EDGE: 0.05 },
  settleUpProbability: 0.70, regime: 'trending_up',
  marketUp: 0.55, marketDown: 0.45, timeLeftMin: 14.4,
  rulesSide: null, rulesAction: 'WAIT', callOn: 'policy',
};

describe('evaluatePolicyCandidate', () => {
  it('accepts a candidate that clears confidence, ask and edge gates', () => {
    const c = evaluatePolicyCandidate(base, settings);
    expect(c).not.toBeNull();
    expect(c?.direction).toBe('UP');
    expect(c?.ask).toBe(0.55);
    expect(c?.edge).toBeCloseTo(0.20, 6);
    expect(c?.status).toBe('open');
  });
  it('rejects confidence at/below the threshold', () => {
    expect(evaluatePolicyCandidate({ ...base, directionConfidence: 0.60 }, settings)).toBeNull();
    expect(evaluatePolicyCandidate({ ...base, directionConfidence: 0.59 }, settings)).toBeNull();
  });
  it('rejects ask above the cap', () => {
    expect(evaluatePolicyCandidate({ ...base, marketUp: 0.71 }, settings)).toBeNull();
  });
  it('rejects edge below the minimum', () => {
    expect(evaluatePolicyCandidate({ ...base, directionProbabilities: { UP: 0.60, DOWN: 0.35 } }, settings)).toBeNull();
  });
  it('rejects NO_EDGE and missing prices', () => {
    expect(evaluatePolicyCandidate({ ...base, direction: 'NO_EDGE' as any }, settings)).toBeNull();
    expect(evaluatePolicyCandidate({ ...base, marketUp: null as any }, settings)).toBeNull();
  });
});
