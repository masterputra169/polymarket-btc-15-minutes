import { describe, test, expect } from 'vitest';
import {
  feeAdjustedEdge,
  limitRemainingEdge,
  shouldCancelUnfilled,
  shouldCancelEdgeErosion,
  shouldCancelTwapAdverse,
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
    expect(classifyCancelReason('CANCEL_EDGE_EROSION edge_erosion')).toBe('edge_erosion');
    expect(classifyCancelReason('CANCEL_SIGNAL_FLIP ml_flip_UP_90%')).toBe('signal_flip');
    expect(classifyCancelReason('CANCEL_TIME_CUTOFF elapsed_9.1m')).toBe('time_cutoff');
  });
});
