import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildJevState, buildJevQuestions, parseJevAnswers, getJevStatus, maybeJevAnalyze, resetJevAdvisorForTests,
  checkJevAdvisory, getJevPrimarySide, getJevSizingMultiplier, getJevSummary, __setJevDecisionForTests } from '../jevAdvisor.ts';
import { BOT_CONFIG } from '../../config.ts';
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

describe('independent state v2', () => {
  it('omits algo_view and marks the variant', () => {
    const state = buildJevState(snapshot, true) as Record<string, any>;
    expect(state.algo_view).toBeUndefined();
    expect(state.state_variant).toBe('independent_v2');
    expect(state.market_odds.up).toBe(0.56);
  });
  it('asks for an independent view without the algo anchor', () => {
    const q = buildJevQuestions(true);
    expect(String(q.direction.instructions)).toContain('NO bot recommendation');
    expect(String(q.direction.instructions)).not.toContain('algo view are included');
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

describe('JEV mode collaboration', () => {
  const cfg = BOT_CONFIG.jev;
  const saved = { enabled: cfg.enabled, mode: cfg.mode, minConfidence: cfg.minConfidence, primaryMinConfidence: cfg.primaryMinConfidence, sizingWeight: cfg.sizingWeight, settleMargin: cfg.settleMargin };
  beforeEach(() => {
    resetJevAdvisorForTests();
    cfg.enabled = true;
    cfg.mode = 'shadow';
    cfg.minConfidence = 0.60;
    cfg.primaryMinConfidence = 0.70;
    cfg.sizingWeight = 0.15;
    cfg.settleMargin = 0.05;
  });
  afterEach(() => {
    Object.assign(cfg, saved);
    resetJevAdvisorForTests();
  });

  it('veto blocks an opposite confident direction and allows agreement', () => {
    cfg.mode = 'veto';
    __setJevDecisionForTests({ direction: 'DOWN', directionConfidence: 0.72, settleUpProbability: 0.2, regime: 'trending_down' });
    expect(checkJevAdvisory('UP', 'btc-updown-15m-test')).toMatchObject({ action: 'block' });
    expect(checkJevAdvisory('DOWN', 'btc-updown-15m-test')).toBeNull();
  });

  it('veto ignores NO_EDGE and low confidence', () => {
    cfg.mode = 'veto';
    __setJevDecisionForTests({ direction: 'NO_EDGE', directionConfidence: 0.8, settleUpProbability: 0.5, regime: 'choppy' });
    expect(checkJevAdvisory('UP', 'btc-updown-15m-test')).toBeNull();
    __setJevDecisionForTests({ direction: 'DOWN', directionConfidence: 0.55, settleUpProbability: 0.3, regime: 'choppy' });
    expect(checkJevAdvisory('UP', 'btc-updown-15m-test')).toBeNull();
  });

  it('gate requires a confident agreement', () => {
    cfg.mode = 'gate';
    __setJevDecisionForTests({ direction: 'UP', directionConfidence: 0.75, settleUpProbability: 0.7, regime: 'trending_up' });
    expect(checkJevAdvisory('UP', 'btc-updown-15m-test')).toBeNull();
    expect(checkJevAdvisory('DOWN', 'btc-updown-15m-test')).toMatchObject({ action: 'block' });
    __setJevDecisionForTests({ direction: 'UP', directionConfidence: 0.50, settleUpProbability: 0.6, regime: 'trending_up' });
    expect(checkJevAdvisory('UP', 'btc-updown-15m-test')).toMatchObject({ action: 'block' });
  });

  it('shadow and primary modes never veto at the filter layer', () => {
    __setJevDecisionForTests({ direction: 'DOWN', directionConfidence: 0.95, settleUpProbability: 0.1, regime: 'trending_down' });
    cfg.mode = 'shadow';
    expect(checkJevAdvisory('UP', 'btc-updown-15m-test')).toBeNull();
    cfg.mode = 'primary';
    expect(checkJevAdvisory('UP', 'btc-updown-15m-test')).toBeNull();
  });

  it('primary exposes only confident directions', () => {
    cfg.mode = 'primary';
    __setJevDecisionForTests({ direction: 'DOWN', directionConfidence: 0.85, settleUpProbability: 0.1, regime: 'trending_down' });
    expect(getJevPrimarySide('btc-updown-15m-test')).toBe('DOWN');
    __setJevDecisionForTests({ direction: 'DOWN', directionConfidence: 0.66, settleUpProbability: 0.3, regime: 'trending_down' });
    expect(getJevPrimarySide('btc-updown-15m-test')).toBeNull();
    cfg.mode = 'shadow';
    expect(getJevPrimarySide('btc-updown-15m-test')).toBeNull();
  });

  it('sizing multiplier rewards agreement and is neutral in shadow', () => {
    cfg.mode = 'veto';
    __setJevDecisionForTests({ direction: 'UP', directionConfidence: 0.80, settleUpProbability: 0.75, regime: 'trending_up' });
    const m = getJevSizingMultiplier('UP', 'btc-updown-15m-test');
    expect(m).toBeGreaterThan(1);
    expect(m).toBeLessThanOrEqual(1 + cfg.sizingWeight);
    expect(getJevSizingMultiplier('DOWN', 'btc-updown-15m-test')).toBe(1);
    cfg.mode = 'shadow';
    expect(getJevSizingMultiplier('UP', 'btc-updown-15m-test')).toBe(1);
  });

  it('formats a compact summary for alerts', () => {
    __setJevDecisionForTests({ direction: 'UP', directionConfidence: 0.7, settleUpProbability: 0.66, settleUpCalibrated: 0.45, regime: 'trending_up' });
    expect(getJevSummary('btc-updown-15m-test')).toBe('JEV: UP 70% | settle 45% | trending_up');
  });

  it('veto ignores a direction whose settle probability contradicts it', () => {
    cfg.mode = 'veto';
    __setJevDecisionForTests({ direction: 'DOWN', directionConfidence: 0.85, settleUpProbability: 0.90, regime: 'choppy' });
    expect(checkJevAdvisory('UP', 'btc-updown-15m-test')).toBeNull();
  });

  it('gate blocks a direction whose settle probability contradicts it', () => {
    cfg.mode = 'gate';
    __setJevDecisionForTests({ direction: 'UP', directionConfidence: 0.85, settleUpProbability: 0.30, regime: 'trending_up' });
    expect(checkJevAdvisory('UP', 'btc-updown-15m-test')).toMatchObject({ action: 'block' });
  });

  it('primary refuses a direction whose settle probability contradicts it', () => {
    cfg.mode = 'primary';
    __setJevDecisionForTests({ direction: 'DOWN', directionConfidence: 0.90, settleUpProbability: 0.90, regime: 'trending_down' });
    expect(getJevPrimarySide('btc-updown-15m-test')).toBeNull();
  });
});
