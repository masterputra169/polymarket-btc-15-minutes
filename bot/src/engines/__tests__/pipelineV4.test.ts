/**
 * Pipeline v4 (Tahap 2 — Chainlink-Native + 1 Hz L2 Book) unit tests.
 *
 * Verifies:
 *   1. computeChainlinkNativeFeatures units (fractional ratios, matching ptb_dist_pct)
 *      and clamping for twapPhysicsZ / basisPct / basisDriftPct / crossFeedLead.
 *   2. computeOracleDeltaWindowRatio on timestamped Chainlink spot ticks.
 *   3. buildMlFeatureInputs preserves neutral orderbook for v2/v3 while injecting
 *      live L2 book + all 5 Chainlink-native fields for Pipeline v4.
 *   4. extractLiveFeaturesInPlace populates [54..57] quant features + [58..62]
 *      Pipeline v4 features without colliding with legacy [54..58] SM indices.
 */

import { describe, test, expect, vi } from 'vitest';

vi.mock('../../../../src/engines/ml/state.ts', () => ({
  BASE_FEATURES: 63,
  ENGINEERED_FEATURES: 25,
  MAX_FEATURES: 88,
  modelVersion: 2,
  featurePipeline: 4,
  featureNameToIdx: null,
}));

import {
  FEATURE_PIPELINE_V4,
  computeChainlinkNativeFeatures,
  buildMlFeatureInputs,
} from '../../../../src/engines/ml/featureInputs.ts';
import { extractLiveFeaturesInPlace, featureBuf } from '../../../../src/engines/ml/featureExtract.ts';
import { V4_CHAINLINK_FI } from '../../../../src/engines/ml/featureMap.ts';
import { aggregate5m, CANDLES_5M } from '../../../../src/engines/ml/trainingRow.ts';
import { computeOracleDeltaWindowRatio } from '../settlePrice.ts';

const MIN = 60_000;

function makeCandles(n: number, endOpenTime: number, startPrice = 90_000) {
  return Array.from({ length: n }, (_, i) => {
    const openTime = endOpenTime - (n - 1 - i) * MIN;
    const base = startPrice + i * 1.5;
    return {
      openTime,
      open: base,
      high: base + 12,
      low: base - 10,
      close: base + 3,
      volume: 120 + (i % 7),
      takerBuyVolume: 68,
    };
  });
}

describe('computeChainlinkNativeFeatures', () => {
  test('computes fractional Chainlink-native telemetry and basis drift accurately', () => {
    const r = computeChainlinkNativeFeatures({
      binancePrice: 90_120,
      binanceWindowOpen: 90_000, // +0.1333%
      oraclePrice: 90_030,       // +$90 basis (~+0.10%)
      settlePrice: 90_020,
      exactPtb: 90_040,          // oracle behind PTB (-$20 = -0.0222%) despite Binance green!
      twapPhysicsZ: -1.45,
      binanceDelta3s: 0.0004,
      oracleDelta3s: 0.0001,
    });

    const expectedOraDist = (90_020 - 90_040) / 90_040;
    const expectedBinDist = (90_120 - 90_000) / 90_000;
    expect(r.oraclePtbDistPct).toBeCloseTo(expectedOraDist, 8);
    expect(r.twapPhysicsZ).toBeCloseTo(-1.45, 8);
    expect(r.basisPct).toBeCloseTo((90_120 - 90_030) / 90_030, 8);
    expect(r.basisDriftPct).toBeCloseTo(expectedBinDist - expectedOraDist, 8);
    expect(r.crossFeedLead).toBeCloseTo(0.0003, 8);
  });

  test('clamps extreme values and falls back cleanly when exact PTB is missing', () => {
    const r = computeChainlinkNativeFeatures({
      binancePrice: 90_090,
      binanceWindowOpen: 90_000,
      oraclePrice: null,
      settlePrice: null,
      exactPtb: null,
      twapPhysicsZ: 42,
      binanceDelta3s: 0.09,
      oracleDelta3s: -0.05,
    });

    expect(r.oraclePtbDistPct).toBeCloseTo(90 / 90_000, 8);
    expect(r.twapPhysicsZ).toBe(8);
    expect(r.basisPct).toBe(0);
    expect(r.basisDriftPct).toBe(0);
    expect(r.crossFeedLead).toBe(0.02);
  });
});

describe('computeOracleDeltaWindowRatio', () => {
  test('computes fractional return over trailing 3s window and ignores bad/out-of-window ticks', () => {
    const now = 1_794_000_000_000;
    const res = computeOracleDeltaWindowRatio(
      [
        { ts: now - 10_000, value: 89_500 }, // stale
        { ts: now - 2_800, value: 90_000 },  // oldest in 3s
        { ts: now - 1_500, value: 90_018 },
        { ts: now - 200, value: 90_045 },    // latest (+0.05%)
        { ts: now - 100, value: 0 },         // ignored invalid price
      ],
      now,
      3_000,
    );

    expect(res.tickCount).toBe(3);
    expect(res.deltaRatio).toBeCloseTo(45 / 90_000, 8);
  });

  test('returns zero delta when fewer than 2 valid ticks exist', () => {
    const now = 1_794_000_000_000;
    expect(computeOracleDeltaWindowRatio([{ ts: now - 500, value: 90_000 }], now)).toEqual({
      deltaRatio: 0,
      tickCount: 1,
    });
  });
});

describe('buildMlFeatureInputs + extractLiveFeaturesInPlace for Pipeline v4', () => {
  const nowMs = Date.UTC(2026, 10, 15, 14, 7, 30);
  const candles1m = makeCandles(240, Math.floor(nowMs / MIN) * MIN);
  const candles5m = aggregate5m(candles1m).slice(-CANDLES_5M);
  const windowOpen = candles1m[candles1m.length - 8].open;

  test('v2 keeps L2 orderbook neutral whereas v4 populates L2 + 5 Chainlink-native features', () => {
    const common = {
      candles1m,
      candles5m,
      lastPrice: 90_400,
      windowOpenPrice: windowOpen,
      minutesLeft: 7.5,
      nowMs,
      marketUp: 0.56,
      marketUpLag: 0.53,
      orderbookImbalance: 0.42,
      spreadPct: 0.01,
      oraclePrice: 90_310,
      settlePrice: 90_305,
      exactPtb: 90_280,
      twapPhysicsZ: 0.95,
      binanceDelta3s: 0.00025,
      oracleDelta3s: 0.00010,
    };

    const v2Out = buildMlFeatureInputs({ ...common, featurePipeline: 2 });
    expect(v2Out.marketState.orderbookImbalance).toBeNull();
    expect(v2Out.marketState.spreadPct).toBeNull();
    expect(v2Out.marketState.oraclePtbDistPct).toBeUndefined();

    const v4Out = buildMlFeatureInputs({ ...common, featurePipeline: FEATURE_PIPELINE_V4 });
    expect(v4Out.marketState.orderbookImbalance).toBe(0.42);
    expect(v4Out.marketState.spreadPct).toBe(0.01);
    expect(v4Out.marketState.oraclePtbDistPct).toBeCloseTo((90_305 - 90_280) / 90_280, 8);
    expect(v4Out.marketState.twapPhysicsZ).toBeCloseTo(0.95, 8);
    expect(v4Out.marketState.basisPct).toBeCloseTo((90_400 - 90_310) / 90_310, 8);
    expect(v4Out.marketState.crossFeedLead).toBeCloseTo(0.00015, 8);

    // Run full 88-feature extraction and check exact slots [54..62]
    extractLiveFeaturesInPlace({
      ...(v4Out.marketState as any),
      ruleProbUp: v4Out.ruleProbUp,
    });

    // Indices [54..57] remain Quant features (not overwritten by legacy SM)
    expect(featureBuf[54]).toBeCloseTo(v4Out.marketState.volDeltaBuyRatio300s as number, 6);
    expect(featureBuf[56]).toBeCloseTo(v4Out.marketState.hurstExponent as number, 6);

    // Indices [58..62] match V4_CHAINLINK_FI exactly (no collision with legacy sm_activity at 58)
    expect(featureBuf[V4_CHAINLINK_FI.oracle_ptb_dist_pct]).toBeCloseTo(
      v4Out.marketState.oraclePtbDistPct as number,
      8,
    );
    expect(featureBuf[V4_CHAINLINK_FI.twap_physics_z]).toBeCloseTo(0.95, 8);
    expect(featureBuf[V4_CHAINLINK_FI.basis_pct]).toBeCloseTo(
      v4Out.marketState.basisPct as number,
      8,
    );
    expect(featureBuf[V4_CHAINLINK_FI.basis_drift_pct]).toBeCloseTo(
      v4Out.marketState.basisDriftPct as number,
      8,
    );
    expect(featureBuf[V4_CHAINLINK_FI.cross_feed_lead]).toBeCloseTo(0.00015, 8);

    // Every 88-feature slot (63 base + 25 engineered) must be finite
    for (let i = 0; i < 88; i++) {
      expect(Number.isFinite(featureBuf[i])).toBe(true);
    }
  });
});
