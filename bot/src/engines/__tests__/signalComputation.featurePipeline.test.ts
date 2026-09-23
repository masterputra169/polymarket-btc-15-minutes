/**
 * computeSignals feeds the ML model the way that model was trained.
 *
 * A model trained on featureInputs.ts rows (feature pipeline v2) must get its
 * features from the same builder live; a legacy model must keep getting the
 * legacy vector, or deploying this code alongside the old model would create
 * a new train/serve skew instead of removing one.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import {
  computeSignals, resetMarketUpHistory, recordMarketUp, marketUpAtOrBefore, windowStartMs,
} from '../signalComputation.ts';
import { buildMlFeatureInputs } from '../../../../src/engines/ml/featureInputs.ts';

const MIN = 60_000;
const WINDOW_START = Date.UTC(2026, 8, 23, 12, 0, 0);
const SLUG = `btc-updown-15m-${WINDOW_START / 1000}`;
const NOW = WINDOW_START + 6 * MIN + 20_000; // 6m20s into the window

function candles(n: number, endOpenTime: number) {
  return Array.from({ length: n }, (_, i) => {
    const openTime = endOpenTime - (n - 1 - i) * MIN;
    const base = 81_000 + Math.sin(i / 7) * 40;
    return { openTime, open: base, high: base + 6, low: base - 6, close: base + 2, volume: 100 + (i % 5), takerBuyVolume: 55 };
  });
}

const k1 = candles(240, Math.floor(NOW / MIN) * MIN);
const k5 = candles(48, Math.floor(NOW / (5 * MIN)) * 5 * MIN).map(c => ({ ...c, openTime: c.openTime }));

function run(featurePipeline: number | undefined, capture: { args?: any[] }) {
  return computeSignals({
    klines1m: k1, klines5m: k5, lastPrice: 81_010,
    poly: { prices: { up: 0.61, down: 0.39 }, orderbook: null },
    priceToBeat: { slug: SLUG, value: 80_950, source: 'scheduled_ws', updatedAt: WINDOW_START },
    marketSlug: SLUG, now: NOW,
    clobUsable: true,
    getClobUpPrice: () => 0.61, getClobDownPrice: () => 0.39, getClobOrderbook: () => null,
    feedbackStats: null, timeLeftMin: (WINDOW_START + 15 * MIN - NOW) / MIN, candleWindowMinutes: 15,
    getMLPrediction: (...args: any[]) => { capture.args = args; return { available: false }; },
    fundingRate: null, smartFlowSignal: null, oraclePrice: 80_950,
    ...(featurePipeline === undefined ? {} : { featurePipeline }),
  });
}

beforeEach(() => resetMarketUpHistory());

describe('feature pipeline v2', () => {
  test('the model gets exactly the shared builder\'s inputs', () => {
    recordMarketUp(SLUG, NOW - 65_000, 0.55); // older than 60s: the momentum baseline
    const cap: { args?: any[] } = {};
    run(2, cap);
    const [marketState, ruleForBlend, , opts] = cap.args!;
    const expected = buildMlFeatureInputs({
      candles1m: k1, candles5m: k5, lastPrice: 81_010,
      windowOpenPrice: k1.find(c => c.openTime === WINDOW_START)!.open,
      minutesLeft: (WINDOW_START + 15 * MIN - NOW) / MIN, nowMs: NOW,
      marketUp: 0.61, marketUpLag: 0.55, fundingRate: null,
    });
    expect(marketState).toEqual(expected.marketState);
    expect(opts).toEqual({ featureRuleProbUp: expected.ruleProbUp });
    expect(typeof ruleForBlend).toBe('number');
  });

  test('price to beat for the features is the Binance window open, not the Chainlink PTB', () => {
    const cap: { args?: any[] } = {};
    run(2, cap);
    const windowOpen = k1.find(c => c.openTime === WINDOW_START)!.open;
    expect(cap.args![0].priceToBeat).toBe(windowOpen);
    expect(cap.args![0].priceToBeat).not.toBe(80_950);
  });
});

describe('legacy models keep the legacy vector', () => {
  test('default pipeline is 1 and uses the Chainlink PTB, no feature override', () => {
    const cap: { args?: any[] } = {};
    run(undefined, cap);
    expect(cap.args![0].priceToBeat).toBe(80_950);
    expect(cap.args![3]).toBeUndefined();
  });
});

describe('timestamped market history', () => {
  test('returns the price as of 60s ago, in this market only', () => {
    recordMarketUp(SLUG, 1_000_000, 0.50);
    recordMarketUp(SLUG, 1_030_000, 0.55);
    recordMarketUp(SLUG, 1_061_000, 0.60);
    expect(marketUpAtOrBefore(1_061_000 - 60_000)).toBe(0.50);
    expect(marketUpAtOrBefore(1_095_000 - 60_000)).toBe(0.55);
  });

  test('a new market starts a new history', () => {
    recordMarketUp(SLUG, 1_000_000, 0.50);
    recordMarketUp('btc-updown-15m-9999999999', 1_070_000, 0.40);
    expect(marketUpAtOrBefore(1_010_000)).toBeNull();
  });

  test('null before anything was recorded long enough ago', () => {
    recordMarketUp(SLUG, 1_000_000, 0.50);
    expect(marketUpAtOrBefore(999_000)).toBeNull();
  });
});

describe('windowStartMs', () => {
  test('reads the slug timestamp', () => {
    expect(windowStartMs(SLUG, NOW, 3)).toBe(WINDOW_START);
  });
  test('falls back to time left, rounded to the minute', () => {
    expect(windowStartMs('btc-15m', NOW, (WINDOW_START + 15 * MIN - NOW) / MIN)).toBe(WINDOW_START);
  });
});
