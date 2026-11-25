import { describe, test, expect } from 'vitest';
import {
  feeAdjustedEdge,
  limitRemainingEdge,
  shouldCancelUnfilled,
  shouldCancelEdgeErosion,
  shouldCancelTwapAdverse,
  shouldCancelToxicFlow,
  shouldAllowFokFallback,
  makerJoinPrice,
  dryRunMakerWouldFill,
  classifyCancelReason,
} from '../makerFillGate.ts';

describe('feeAdjustedEdge', () => {
  test('subtracts CLOB V2 taker fee at 60c', () => {
    // fee/share = 0.07 * 0.6 * 0.4 = 0.0168
    const edge = feeAdjustedEdge(0.70, 0.60);
    expect(edge).toBeCloseTo(0.70 - 0.60 - 0.0168, 5);
  });

  test('null on bad inputs', () => {
    expect(feeAdjustedEdge(null, 0.5)).toBeNull();
    expect(feeAdjustedEdge(0.5, null)).toBeNull();
    expect(feeAdjustedEdge(0, 0.5)).toBeNull();
  });
});

describe('limitRemainingEdge / erosion', () => {
  test('makers pay 0 — edge is P − limit', () => {
    expect(limitRemainingEdge(0.65, 0.55)).toBeCloseTo(0.10, 6);
  });

  test('cancels when edge below floor', () => {
    expect(shouldCancelEdgeErosion(0.56, 0.55, 0.03)).toBe(true);
    expect(shouldCancelEdgeErosion(0.65, 0.55, 0.03)).toBe(false);
  });

  test('shouldCancelTwapAdverse pulls on late erosion/mid drop while tolerating mild EARLY Brownian variance', () => {
    // Inside last 180s with edge < 3pp -> pull immediately
    const latePull = shouldCancelTwapAdverse({ twapProbUp: 0.56, side: 'UP', limitPrice: 0.55, secsLeft: 120 });
    expect(latePull.cancel).toBe(true);
    expect(latePull.reason).toContain('twap_late_erosion');

    // Inside last 300s with -7pp (< -5pp hardDeficit) -> pull immediately (DOWN side)
    const midPullDown = shouldCancelTwapAdverse({ twapProbUp: 0.52, side: 'DOWN', limitPrice: 0.55, secsLeft: 250 });
    expect(midPullDown.cancel).toBe(true);
    expect(midPullDown.reason).toBe('twap_adverse_-7.0pp<-5pp');

    // 07:31 regression: EARLY (816s left) pFatTail=58.1% vs 64c (-5.9pp) -> holds above -15pp early floor
    const early0731Hold = shouldCancelTwapAdverse({ twapProbUp: 0.581, side: 'UP', limitPrice: 0.64, secsLeft: 816 });
    expect(early0731Hold.cancel).toBe(false);

    // EARLY collapse (-18pp < -15pp earlyHardDeficit) -> still pulls immediately
    const earlyCollapse = shouldCancelTwapAdverse({ twapProbUp: 0.63, side: 'DOWN', limitPrice: 0.55, secsLeft: 600 });
    expect(earlyCollapse.cancel).toBe(true);
    expect(earlyCollapse.reason).toBe('twap_adverse_-18.0pp<-15pp');
  });
});

describe('shouldCancelUnfilled', () => {
  test('fires at/after maxUnfilledSec', () => {
    expect(shouldCancelUnfilled(44, 45)).toBe(false);
    expect(shouldCancelUnfilled(45, 45)).toBe(true);
    expect(shouldCancelUnfilled(10, 0)).toBe(false);
  });
});

describe('shouldAllowFokFallback', () => {
  test('blocks after signal flip', () => {
    const r = shouldAllowFokFallback({
      cancelReason: 'signal_flip',
      sideProb: 0.80,
      ask: 0.55,
      minEdge: 0.05,
    });
    expect(r.allow).toBe(false);
  });

  test('allows after unfilled when fee-adjusted edge clears floor', () => {
    // P=0.72 ask=0.55 fee≈0.0173 → edge≈0.1527 > 0.05
    const r = shouldAllowFokFallback({
      cancelReason: 'unfilled_timeout',
      sideProb: 0.72,
      ask: 0.55,
      minEdge: 0.05,
    });
    expect(r.allow).toBe(true);
  });

  test('blocks after unfilled when edge thin', () => {
    // P=0.58 ask=0.55 fee≈0.0173 → edge≈0.0127 < 0.05
    const r = shouldAllowFokFallback({
      cancelReason: 'time_cutoff',
      sideProb: 0.58,
      ask: 0.55,
      minEdge: 0.05,
    });
    expect(r.allow).toBe(false);
  });

  test('blocks after market switch', () => {
    const r = shouldAllowFokFallback({
      cancelReason: 'market_switched_a_to_b',
      sideProb: 0.90,
      ask: 0.50,
      minEdge: 0.05,
    });
    expect(r.allow).toBe(false);
  });

  test('blocks low ML confidence below minMlConfidence and allows >= minMlConfidence', () => {
    const blocked = shouldAllowFokFallback({
      cancelReason: 'unfilled_timeout',
      sideProb: 0.72,
      ask: 0.55,
      minEdge: 0.05,
      mlConfidence: 0.30,
      minMlConfidence: 0.32,
    });
    expect(blocked.allow).toBe(false);
    expect(blocked.reason).toBe('no_fok_ml_30%<32%');

    const allowed = shouldAllowFokFallback({
      cancelReason: 'unfilled_timeout',
      sideProb: 0.72,
      ask: 0.55,
      minEdge: 0.05,
      mlConfidence: 0.32,
      minMlConfidence: 0.32,
    });
    expect(allowed.allow).toBe(true);
  });
});

describe('makerJoinPrice', () => {
  test('joins the bid, stays under the ask', () => {
    expect(makerJoinPrice(0.54, 0.56)).toBe(0.54);
    expect(makerJoinPrice(0.56, 0.56)).toBe(0.55); // capped ask-tick
  });

  test('respects min entry', () => {
    expect(makerJoinPrice(0.40, 0.55, 0.50)).toBe(0.50);
  });
});

describe('dryRunMakerWouldFill', () => {
  test('deterministic per slug', () => {
    const a = dryRunMakerWouldFill('btc-updown-15m-test', 0.60);
    const b = dryRunMakerWouldFill('btc-updown-15m-test', 0.60);
    expect(a).toBe(b);
  });

  test('rate 0 never fills, rate 1 always', () => {
    expect(dryRunMakerWouldFill('any', 0)).toBe(false);
    expect(dryRunMakerWouldFill('any', 1)).toBe(true);
  });

  test('rate 0.6 fills some slugs not others', () => {
    const hits = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9', 'm10']
      .map((s) => dryRunMakerWouldFill(s, 0.60))
      .filter(Boolean).length;
    expect(hits).toBeGreaterThan(0);
    expect(hits).toBeLessThan(10);
  });
});

describe('classifyCancelReason', () => {
  test('maps monitor actions', () => {
    expect(classifyCancelReason('CANCEL_UNFILLED_TIMEOUT unfilled_timeout')).toBe('unfilled_timeout');
    expect(classifyCancelReason('CANCEL_TOXIC_FLOW toxic_lead_lag_DOWN')).toBe('toxic_flow');
    expect(classifyCancelReason('CANCEL_EDGE_EROSION edge_erosion')).toBe('edge_erosion');
    expect(classifyCancelReason('CANCEL_SIGNAL_FLIP ml_flip_UP_90%')).toBe('signal_flip');
    expect(classifyCancelReason('CANCEL_TIME_CUTOFF elapsed_9.1m')).toBe('time_cutoff');
  });
});

describe('shouldCancelToxicFlow', () => {
  test('pulls on opposing 3s lead-lag impulse and spares aligned impulse', () => {
    const opp = shouldCancelToxicFlow({ side: 'UP', leadLagDirection: 'DOWN' });
    expect(opp.cancel).toBe(true);
    expect(opp.reason).toBe('toxic_lead_lag_DOWN');

    expect(shouldCancelToxicFlow({ side: 'UP', leadLagDirection: 'UP' }).cancel).toBe(false);
    expect(shouldCancelToxicFlow({ side: 'DOWN', leadLagDirection: 'DOWN' }).cancel).toBe(false);
  });

  test('pulls on sharp opposing Kalman velocity and ignores calm or favorable drift', () => {
    const oppUp = shouldCancelToxicFlow({ side: 'UP', kalmanVelocityUsdPerSec: -5.5 });
    expect(oppUp.cancel).toBe(true);
    expect(oppUp.reason).toContain('toxic_kalman_vel_-5.5');

    const oppDown = shouldCancelToxicFlow({ side: 'DOWN', kalmanVelocityUsdPerSec: 6.2 });
    expect(oppDown.cancel).toBe(true);
    expect(oppDown.reason).toContain('toxic_kalman_vel_+6.2');

    expect(shouldCancelToxicFlow({ side: 'UP', kalmanVelocityUsdPerSec: -2.0 }).cancel).toBe(false);
    expect(shouldCancelToxicFlow({ side: 'UP', kalmanVelocityUsdPerSec: 8.0 }).cancel).toBe(false);
  });

  test('pulls on opposing flow + elevated VPIN or Kyle lambda (R2 guarded), no-op on favorable/null', () => {
    const vpinPull = shouldCancelToxicFlow({ side: 'UP', tradeImbalance: -0.45, vpin: 0.82 });
    expect(vpinPull.cancel).toBe(true);
    expect(vpinPull.reason).toContain('toxic_vpin_0.82');

    // Favorable imbalance with high VPIN must NOT cancel
    expect(shouldCancelToxicFlow({ side: 'UP', tradeImbalance: 0.60, vpin: 0.90 }).cancel).toBe(false);

    // Kyle's lambda with sufficient R2 + opposing flow pulls; noisy low-R2 does not
    const lamPull = shouldCancelToxicFlow({ side: 'DOWN', tradeImbalance: 0.40, kylesLambda: 2.1, kylesLambdaR2: 0.25 });
    expect(lamPull.cancel).toBe(true);
    expect(lamPull.reason).toContain('toxic_lambda_2.10c');
    expect(shouldCancelToxicFlow({ side: 'DOWN', tradeImbalance: 0.40, kylesLambda: 2.1, kylesLambdaR2: 0.05 }).cancel).toBe(false);

    // Null/default inputs are a strict no-op
    expect(shouldCancelToxicFlow({ side: 'UP' }).cancel).toBe(false);

    // FOK fallback is blocked after toxic_flow cancel
    const fok = shouldAllowFokFallback({ cancelReason: 'toxic_flow', sideProb: 0.80, ask: 0.55, minEdge: 0.03 });
    expect(fok.allow).toBe(false);
    expect(fok.reason).toBe('no_fok_after_toxic_flow');
  });
});
