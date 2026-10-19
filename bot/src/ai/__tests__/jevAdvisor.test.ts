import { describe, it, expect } from 'vitest';
import { buildJevState, buildJevQuestions, parseJevAnswers, getJevStatus, maybeJevAnalyze, resetJevAdvisorForTests } from '../jevAdvisor.ts';
import type { JevSnapshot } from '../jevAdvisor.ts';

const snapshot: JevSnapshot = {
  t: 1_792_400_000_000, slug: 'btc-updown-15m-test', pollCounter: 123,
  action: 'ENTER', side: 'UP', confidence: 'HIGH', reason: 'test', phase: 'MID',
  timeLeftMin: 7.5, session: 'Asia', btcPrice: 82000, priceToBeat: 81950,
  ptbSource: 'chainlink_twap', ptbExact: true, settlePrice: 82012,
  delta1m: 12, delta3m: 25, atrPct: 0.03, atrRatio: 0.9,
  rsi: 55, rsiSlope: 1.2, macdHist: 2.5, vwapDist: 0.001, vwapSlope: 0.5,
  bbPercentB: 0.6, bbWidth: 0.002, stochK: 55, stochD: 50,
  emaCrossSignal: 'NONE', emaDistPct: 0.01, volDeltaBuyRatio: 0.6,
  marketUp: 0.56, marketDown: 0.44, mlProbUp: 0.62, mlConfidence: 0.4, mlSide: 'UP',
  mlAgreesWithRules: true, ensembleUp: 0.61, edgeUp: 0.05, edgeDown: -0.04, bestEdge: 0.05,
  regime: 'moderate', regimeConfidence: 0.5, smartFlowSignal: 'NEUTRAL',
  signalConfirmCount: 3, recentFlips: 0, consecutiveLosses: 1, bankroll: 58,
};

describe('buildJevState', () => {
  it('builds a compact structured state with derived fields', () => {
    const state = buildJevState(snapshot) as Record<string, any>;
    expect(state.market.asset).toBe('BTC/USD');
    expect(state.market.distance_to_ptb_usd).toBe(50);
    expect(state.market.price_to_beat_is_exact_twap).toBe(true);
    expect(state.market_odds).toEqual({ up: 0.56, down: 0.44 });
    expect(state.algo_view.provisional_side).toBe('UP');
    expect(state.momentum.delta_1m_usd).toBe(12);
  });
  it('handles missing values without NaN', () => {
    const state = buildJevState({ ...snapshot, btcPrice: null, priceToBeat: null }) as Record<string, any>;
    expect(state.market.distance_to_ptb_usd).toBeNull();
  });
});

describe('buildJevQuestions', () => {
  it('asks direction, settle and regime with correct primitive types', () => {
    const q = buildJevQuestions();
    expect(Object.keys(q).sort()).toEqual(['direction', 'regime', 'settle_above_ptb']);
    expect(q.direction.type).toBe('choice');
    expect(Object.keys((q.direction as any).criteria).sort()).toEqual(['DOWN', 'NO_EDGE', 'UP']);
    expect(q.settle_above_ptb.type).toBe('noul');
    expect(q.regime.type).toBe('choice');
  });
});

describe('parseJevAnswers', () => {
  it('parses choice + noul answers into a decision', () => {
    const decision = parseJevAnswers('jev-1.14.0', {
      direction: { type: 'choice', choice: 'UP', probabilities: { UP: 0.7, DOWN: 0.2, NO_EDGE: 0.1 }, confidence: 0.55 },
      settle_above_ptb: { type: 'noul', noul: 0.68 },
      regime: { type: 'choice', choice: 'trending_up', probabilities: { trending_up: 0.8, choppy: 0.2 }, confidence: 0.6 },
    });
    expect(decision.direction).toBe('UP');
    expect(decision.settleUpProbability).toBeCloseTo(0.68);
    expect(decision.regime).toBe('trending_up');
  });
  it('maps unknown choice to NO_EDGE and rejects missing answers', () => {
    const decision = parseJevAnswers('m', {
      direction: { type: 'choice', choice: 'SOMETHING', probabilities: {}, confidence: 0.1 },
      settle_above_ptb: { type: 'noul', noul: 0.5 },
      regime: { type: 'choice', choice: 'neutral', probabilities: {}, confidence: 0.1 },
    });
    expect(decision.direction).toBe('NO_EDGE');
    expect(() => parseJevAnswers('m', {})).toThrow();
  });
});

describe('maybeJevAnalyze when disabled', () => {
  it('does nothing and never throws', () => {
    resetJevAdvisorForTests();
    maybeJevAnalyze(snapshot);
    const status = getJevStatus();
    expect(status.calls).toBe(0);
    expect(status.enabled).toBe(false);
  });
});
