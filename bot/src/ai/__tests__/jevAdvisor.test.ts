import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { rmSync, mkdtempSync, readFileSync, existsSync } from 'fs';
import {
  buildJevState,
  buildJevQuestions,
  parseJevAnswers,
  initJevAdvisor,
  getJevStatus,
  maybeJevAnalyze,
  resetJevAdvisorForTests,
  checkJevAdvisory,
  getJevPrimarySide,
  getJevSizingMultiplier,
  getJevSummary,
  getJevBrierSkill,
  recordJevWindowOutcome,
  __setJevDecisionForTests,
} from '../jevAdvisor.ts';
import { BOT_CONFIG } from '../../config.ts';
import type { JevSnapshot } from '../jevAdvisor.ts';

const snapshot: JevSnapshot = {
  t: 1_792_400_000_000, slug: 'btc-updown-15m-test', pollCounter: 123,
  action: 'ENTER', side: 'UP', confidence: 'HIGH', reason: 'test', phase: 'MID',
  timeLeftMin: 7.5, session: 'Asia', btcPrice: 82000, priceToBeat: 81950,
  ptbSource: 'chainlink_twap', ptbExact: true, settlePrice: 81978,
  basisUsd: 22, twapPhysicsZ: 0.45, twapProbUp: 0.6736,
  delta1m: 12, delta3m: 25, atrPct: 0.03, atrRatio: 0.9,
  rsi: 55, rsiSlope: 1.2, macdHist: 2.5, vwapDist: 0.001, vwapSlope: 0.5,
  bbPercentB: 0.6, bbWidth: 0.002, stochK: 55, stochD: 50,
  emaCrossSignal: 'NONE', emaDistPct: 0.01, volDeltaBuyRatio: 0.6,
  marketUp: 0.56, marketDown: 0.44, spread: 0.01, bidLiquidity: 420, askLiquidity: 380,
  mlProbUp: 0.62, mlConfidence: 0.4, mlSide: 'UP',
  mlAgreesWithRules: true, baseMlProbUp: 0.60, hybridDeltaProb: 0.02, hybridActive: true,
  ensembleUp: 0.61, edgeUp: 0.05, edgeDown: -0.04, bestEdge: 0.05,
  regime: 'moderate', regimeConfidence: 0.5, smartFlowSignal: 'NEUTRAL',
  signalConfirmCount: 3, recentFlips: 0, consecutiveLosses: 1, bankroll: 58,
  orderFlow: {
    ok: true, sampleCount: 15, updatedAt: 1_792_400_000_000, spread: 0.01, mid: 0.555,
    microprice: 0.557, micropriceEdgePct: 0.36, ofi: 12.5, depthImbalance: 0.14,
    topImbalance: 0.22, tradeImbalance: 0.35, vpin: 0.18, tradeCount: 24,
    buyVolume: 180, sellVolume: 90,
  },
};

describe('buildJevState v4', () => {
  it('builds structured v4 state with Chainlink settle distance, order flow, hybrid fields, and optional recent_memory', () => {
    const mem = {
      sampleCount: 5,
      marketUpRate: 0.6,
      streakSide: 'UP' as const,
      streakLength: 2,
      whipsawRate: 0.5,
      jevUpCallRate: 0.2,
      jevDownCallRate: 0.6,
      jevDirectionHitRate: 0.5,
      jevProbBias: -0.14,
      recentMisses: [{ slug: 'btc-updown-15m-1', predicted: 'DOWN' as const, outcome: 'UP' as const, marketUp: 0.55, rawProbUp: 0.35, regime: 'moderate' }],
    };
    const state = buildJevState(snapshot, false, mem) as Record<string, any>;
    expect(state.market.asset).toBe('BTC/USD');
    expect(state.market.distance_to_ptb_usd).toBe(50);
    expect(state.market.settle_distance_to_ptb_usd).toBe(28);
    expect(state.market.binance_chainlink_basis_usd).toBe(22);
    expect(state.market.twap_physics_z).toBe(0.45);
    expect(state.market.price_to_beat_is_exact_twap).toBe(true);
    expect(state.market_odds).toEqual({ up: 0.56, down: 0.44 });
    expect(state.order_book).toEqual({ spread: 0.01, bid_liquidity_usd: 420, ask_liquidity_usd: 380, book_skew_ratio: 0.525 });
    expect(state.order_flow.vpin).toBe(0.18);
    expect(state.order_flow.microprice_edge_pct).toBe(0.36);
    expect(state.algo_view.provisional_side).toBe('UP');
    expect(state.algo_view.hybrid_delta_prob).toBe(0.02);
    expect(state.algo_view.hybrid_active).toBe(true);
    expect(state.recent_memory.window_count).toBe(5);
    expect(state.recent_memory.streak).toBe('UPx2');
    expect(state.recent_memory.jev_prob_bias).toBe(-0.14);
    expect(state.state_variant).toBe('collaborative_v5');
    expect(state.momentum.delta_1m_usd).toBe(12);
  });

  it('handles missing values without NaN and skips recent_memory under 3 samples', () => {
    const state = buildJevState({ ...snapshot, btcPrice: null, priceToBeat: null, settlePrice: null, basisUsd: null }, false, {
      sampleCount: 2, marketUpRate: 0.5, streakSide: 'UP', streakLength: 1, whipsawRate: 1,
      jevUpCallRate: 0.5, jevDownCallRate: 0.5, jevDirectionHitRate: 0.5, jevProbBias: 0, recentMisses: [],
    }) as Record<string, any>;
    expect(state.market.distance_to_ptb_usd).toBeNull();
    expect(state.market.settle_distance_to_ptb_usd).toBeNull();
    expect(state.market.binance_chainlink_basis_usd).toBeNull();
    expect(state.recent_memory).toBeUndefined();
  });
});

describe('independent state v5', () => {
  it('omits algo_view, preserves order_flow, and marks independent_v5', () => {
    const state = buildJevState(snapshot, true) as Record<string, any>;
    expect(state.algo_view).toBeUndefined();
    expect(state.state_variant).toBe('independent_v5');
    expect(state.order_flow.vpin).toBe(0.18);
    expect(state.market_odds.up).toBe(0.56);
  });

  it('asks for an independent view without the algo anchor', () => {
    const q = buildJevQuestions(true);
    expect(String(q.direction.instructions)).toContain('NO bot recommendation');
    expect(String(q.direction.instructions)).not.toContain('algo_view');
  });
});

describe('buildJevQuestions', () => {
  it('asks direction, settle, regime, Risk Desk scores, and parallel bull/bear debate dimensions', () => {
    const q = buildJevQuestions();
    expect(Object.keys(q).sort()).toEqual([
      'bear_case_strength',
      'bull_case_strength',
      'chop_hazard',
      'direction',
      'exhaustion_risk',
      'flow_contradiction',
      'regime',
      'settle_above_ptb',
    ]);
    expect(q.direction.type).toBe('choice');
    expect(Object.keys((q.direction as any).criteria).sort()).toEqual(['DOWN', 'NO_EDGE', 'UP']);
    expect(q.settle_above_ptb.type).toBe('noul');
    expect(String(q.settle_above_ptb.instructions)).toContain('recent_memory.jev_prob_bias');
    expect(q.regime.type).toBe('choice');
    expect(q.chop_hazard.type).toBe('score');
    expect(q.exhaustion_risk.type).toBe('score');
    expect(q.flow_contradiction.type).toBe('score');
    expect(q.bull_case_strength.type).toBe('score');
    expect(q.bear_case_strength.type).toBe('score');
    expect((q.chop_hazard as any).criteria).toHaveLength(5);
    expect((q.bull_case_strength as any).criteria).toHaveLength(5);
    expect((q.bear_case_strength as any).criteria).toHaveLength(5);
  });
});

describe('parseJevAnswers', () => {
  it('parses choice + noul + score Risk Desk answers with Bayesian prior anchoring', () => {
    const decision = parseJevAnswers('jev-1.14.0', {
      direction: { type: 'choice', choice: 'UP', probabilities: { UP: 0.7, DOWN: 0.2, NO_EDGE: 0.1 }, confidence: 0.75 },
      settle_above_ptb: { type: 'noul', noul: 0.75 },
      regime: { type: 'choice', choice: 'trending_up', probabilities: { trending_up: 0.8, choppy: 0.2 }, confidence: 0.6 },
      chop_hazard: { type: 'score', score: 0.8, legend: {}, probabilities: {}, confidence: 0.85 },
      exhaustion_risk: { type: 'score', score: 1.6, legend: {}, probabilities: {}, confidence: 0.80 },
      flow_contradiction: { type: 'score', score: 0.4, legend: {}, probabilities: {}, confidence: 0.75 },
    }, { marketUp: 0.55 });
    expect(decision.direction).toBe('UP');
    expect(decision.settleUpProbability).toBeCloseTo(0.75);
    expect(decision.settleUpCalibrated).toBeCloseTo(0.5670, 4);
    expect(decision.bayesianProbUp!).toBeGreaterThan(0.55);
    expect(decision.bayesianProbUp!).toBeLessThan(0.5670);
    expect(decision.chopHazard).toBeCloseTo(0.20, 4);
    expect(decision.exhaustionRisk).toBeCloseTo(0.40, 4);
    expect(decision.flowContradiction).toBeCloseTo(0.10, 4);
    expect(decision.compositeRisk).toBeCloseTo(0.40 * 0.20 + 0.35 * 0.40 + 0.25 * 0.10, 4);
    expect(decision.onlineCalibrated).toBe(false);
    expect(decision.route).toBe('confident');
    expect(decision.regime).toBe('trending_up');
  });

  it('parses v4 bull/bear debate, online Platt calibration, adaptive Bayesian weight & empirical risk threshold', () => {
    const memoryHistory = Array.from({ length: 30 }, (_, i) => ({
      slug: `m-${i}`, ts: i, direction: 'UP' as const, rawProbUp: 0.6, marketProbUp: 0.55, outcomeUp: 1 as const,
      compositeRisk: 0.50 + (i / 29) * 0.12, // 0.50 .. 0.62 -> empirical threshold ~ 0.61..0.62
    }));
    const decision = parseJevAnswers('jev-1.14.0', {
      direction: { type: 'choice', choice: 'UP', probabilities: { UP: 0.7, DOWN: 0.2, NO_EDGE: 0.1 }, confidence: 0.75 },
      settle_above_ptb: { type: 'noul', noul: 0.70 },
      regime: { type: 'choice', choice: 'trending_up', probabilities: { trending_up: 0.8 }, confidence: 0.7 },
      chop_hazard: { type: 'score', score: 2.8, legend: {}, probabilities: {}, confidence: 0.85 },
      exhaustion_risk: { type: 'score', score: 2.0, legend: {}, probabilities: {}, confidence: 0.85 },
      flow_contradiction: { type: 'score', score: 2.0, legend: {}, probabilities: {}, confidence: 0.85 },
      bull_case_strength: { type: 'score', score: 3.2, legend: {}, probabilities: {}, confidence: 0.9 },
      bear_case_strength: { type: 'score', score: 2.8, legend: {}, probabilities: {}, confidence: 0.9 },
    }, {
      marketUp: 0.52,
      plattParams: { a: 0.8, b: 0.4, samples: 80, version: 'online-platt-v4' },
      skillReport: { status: 'pass', allowActiveVeto: true, samples: 60, minSamples: 30, windowSize: 100, jevBrier: 0.21, marketBrier: 0.23, skillScore: 0.087 },
      memoryHistory,
    });
    expect(decision.onlineCalibrated).toBe(true);
    expect(decision.bullStrength).toBeCloseTo(0.80, 4);
    expect(decision.bearStrength).toBeCloseTo(0.70, 4);
    expect(decision.netConviction).toBeCloseTo(0.10, 4);
    expect(decision.debateDisagreement).toBeCloseTo(1.0, 4);
    expect(decision.effectiveBayesianWeight!).toBeGreaterThan(0.20);
    expect(decision.effectiveRiskThreshold!).toBeLessThanOrEqual(0.62);
    expect(decision.selfConsistent).toBe(true);
    expect(decision.route).toBe('risk_veto'); // compositeRisk >= empirical ~0.61 and riskConf >= 0.45
  });

  it('downgrades route to uncertain_passthrough when direction contradicts parallel bull/bear debate', () => {
    const decision = parseJevAnswers('jev-1.14.0', {
      direction: { type: 'choice', choice: 'UP', probabilities: { UP: 0.75, DOWN: 0.15, NO_EDGE: 0.10 }, confidence: 0.75 },
      settle_above_ptb: { type: 'noul', noul: 0.65 },
      regime: { type: 'choice', choice: 'neutral', probabilities: { neutral: 0.7 }, confidence: 0.7 },
      chop_hazard: { type: 'score', score: 1.0, legend: {}, probabilities: {}, confidence: 0.8 },
      exhaustion_risk: { type: 'score', score: 1.0, legend: {}, probabilities: {}, confidence: 0.8 },
      flow_contradiction: { type: 'score', score: 1.0, legend: {}, probabilities: {}, confidence: 0.8 },
      bull_case_strength: { type: 'score', score: 0.8, legend: {}, probabilities: {}, confidence: 0.85 },
      bear_case_strength: { type: 'score', score: 3.2, legend: {}, probabilities: {}, confidence: 0.85 },
    }, { marketUp: 0.55 });
    expect(decision.netConviction).toBeLessThan(-0.10);
    expect(decision.selfConsistent).toBe(false);
    expect(decision.route).toBe('uncertain_passthrough');
  });

  it('gracefully handles answers omitting optional score dimensions and rejects missing core fields', () => {
    const decision = parseJevAnswers('m', {
      direction: { type: 'choice', choice: 'SOMETHING', probabilities: {}, confidence: 0.1 },
      settle_above_ptb: { type: 'noul', noul: 0.5 },
      regime: { type: 'choice', choice: 'neutral', probabilities: {}, confidence: 0.1 },
    });
    expect(decision.direction).toBe('NO_EDGE');
    expect(decision.compositeRisk).toBeNull();
    expect(decision.route).toBe('uncertain_passthrough');
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
    expect(getJevBrierSkill().status).toBe('warmup');
  });
});

describe('JEV mode collaboration & Risk Desk gating', () => {
  const cfg = BOT_CONFIG.jev;
  const saved = {
    enabled: cfg.enabled,
    mode: cfg.mode,
    minConfidence: cfg.minConfidence,
    primaryMinConfidence: cfg.primaryMinConfidence,
    sizingWeight: cfg.sizingWeight,
    settleMargin: cfg.settleMargin,
    riskVetoThreshold: cfg.riskVetoThreshold,
    brierGateEnabled: cfg.brierGateEnabled,
  };
  beforeEach(() => {
    resetJevAdvisorForTests();
    cfg.enabled = true;
    cfg.mode = 'shadow';
    cfg.minConfidence = 0.60;
    cfg.primaryMinConfidence = 0.70;
    cfg.sizingWeight = 0.15;
    cfg.settleMargin = 0.05;
    cfg.riskVetoThreshold = 0.78;
    cfg.brierGateEnabled = true;
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

  it('Risk Desk blocks high composite risk entries in veto mode regardless of side', () => {
    cfg.mode = 'veto';
    __setJevDecisionForTests({
      direction: 'UP',
      directionConfidence: 0.72,
      settleUpProbability: 0.7,
      regime: 'choppy',
      compositeRisk: 0.85,
      riskConfidence: 0.80,
      chopHazard: 0.90,
      flowContradiction: 0.75,
    });
    const res = checkJevAdvisory('UP', 'btc-updown-15m-test');
    expect(res).toMatchObject({ action: 'block' });
    expect(res?.reason).toContain('Risk Desk');
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

  it('auto-demotes active veto via Rolling Brier Skill Guard when recent resolved windows trail market odds', async () => {
    const savedKey = process.env.OPENROUTER_API_KEY;
    const savedMin = cfg.brierGateMinSamples;
    const savedTime = cfg.maxTimeLeftMin;
    const savedLogFile = cfg.logFile;
    const savedCallOn = cfg.callOn;
    const tmpLog = join(tmpdir(), `jev-test-${Date.now()}.jsonl`);
    process.env.OPENROUTER_API_KEY = 'or-test-key';
    cfg.mode = 'veto';
    cfg.callOn = 'entry';
    cfg.brierGateMinSamples = 5;
    cfg.maxTimeLeftMin = 14.4;
    cfg.logFile = tmpLog;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      model: 'typesafe/jev-1.14',
      answers: {
        direction: { type: 'choice', choice: 'UP', probabilities: { UP: 0.85, DOWN: 0.10, NO_EDGE: 0.05 }, confidence: 0.85 },
        settle_above_ptb: { type: 'noul', noul: 0.95 },
        regime: { type: 'choice', choice: 'trending_up', probabilities: { trending_up: 0.85 }, confidence: 0.7 },
        chop_hazard: { type: 'score', score: 0.4, legend: {}, probabilities: {}, confidence: 0.8 },
        exhaustion_risk: { type: 'score', score: 0.4, legend: {}, probabilities: {}, confidence: 0.8 },
        flow_contradiction: { type: 'score', score: 0.4, legend: {}, probabilities: {}, confidence: 0.8 },
      },
      usage: { input_tokens: 100, output_tokens: 10, cost: 0.00001 },
    }), { status: 200, headers: { 'content-type': 'application/json' } })));

    try {
      for (let i = 0; i < 5; i++) {
        const slug = `btc-updown-15m-brier-${i}`;
        maybeJevAnalyze({ ...snapshot, slug, marketUp: 0.50, marketDown: 0.50 });
        await new Promise((r) => setTimeout(r, 15));
        expect(recordJevWindowOutcome(slug, 'DOWN')).toBe(true);
      }
      const skill = getJevBrierSkill();
      expect(skill.status).toBe('demoted');
      expect(skill.allowActiveVeto).toBe(false);
      // Even though cached decision strongly says UP (85%), veto is safely auto-demoted on opposing DOWN entry
      expect(checkJevAdvisory('DOWN', 'btc-updown-15m-brier-4')).toBeNull();
    } finally {
      vi.unstubAllGlobals();
      cfg.brierGateMinSamples = savedMin;
      cfg.maxTimeLeftMin = savedTime;
      cfg.logFile = savedLogFile;
      cfg.callOn = savedCallOn;
      if (savedKey == null) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = savedKey;
      try { rmSync(tmpLog, { force: true }); } catch {}
    }
  });

  it('persists live window outcomes to jev_outcomes.json once initialized', () => {
    const savedLogFile = cfg.logFile;
    const tmpDir = mkdtempSync(join(tmpdir(), 'jev-out-'));
    cfg.logFile = join(tmpDir, 'jev_log.jsonl');
    try {
      initJevAdvisor();
      recordJevWindowOutcome('btc-updown-15m-persist-1', 'UP');
      const outPath = join(tmpDir, 'jev_outcomes.json');
      expect(existsSync(outPath)).toBe(true);
      expect(JSON.parse(readFileSync(outPath, 'utf8'))).toEqual({ 'btc-updown-15m-persist-1': 'UP' });
    } finally {
      cfg.logFile = savedLogFile;
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  });
});
