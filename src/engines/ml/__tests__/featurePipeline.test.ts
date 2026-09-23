/**
 * The shared ML feature pipeline (featureInputs.ts + trainingRow.ts).
 *
 * 2026-09-23: the deployed model claimed 88% on live dry-run trades and won
 * 68%, and the market price at the same instant out-predicted it. The cause was
 * training rows that described an instant other than the one they claimed:
 *   - a 60s BTC look-ahead (candle close used, candle open timestamped),
 *   - a fake price-to-beat (close 15 candles back),
 *   - market features from the window-open price.
 * Each of these has a regression test below. The tests also pin the property
 * that makes the fix hold: one builder, a pure function of the snapshot.
 */

import { describe, test, expect, vi, afterEach } from 'vitest';
import {
  buildMlFeatureInputs, marketMomentum, FEATURE_PIPELINE_VERSION, type FeatureSnapshot,
} from '../featureInputs.ts';
import {
  priceAtOrBefore, aggregate5m, candidateIndices, buildTrainingSnapshot, buildTrainingFeatures,
  windowStartSecs, CANDLES_1M, type HistoricalCandle, type LookupMarket,
} from '../trainingRow.ts';
import { FI } from '../featureMap.ts';

const MIN = 60_000;

/** Deterministic random-walk candles, one per minute, 15-minute aligned. */
function makeCandles(n: number, startMs = Date.UTC(2026, 8, 1, 0, 0, 0), seed = 7): HistoricalCandle[] {
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  let price = 60_000;
  const out: HistoricalCandle[] = [];
  for (let i = 0; i < n; i++) {
    const open = price;
    const close = open * (1 + (rnd() - 0.5) * 0.002);
    const high = Math.max(open, close) * (1 + rnd() * 0.0005);
    const low = Math.min(open, close) * (1 - rnd() * 0.0005);
    const volume = 10 + rnd() * 20;
    out.push({ openTime: startMs + i * MIN, open, high, low, close, volume, takerBuyVolume: volume * rnd() });
    price = close;
  }
  return out;
}

const MARKET: LookupMarket = { label: 1, prices: [[27, 0.45], [82, 0.5], [142, 0.62], [203, 0.66], [600, 0.8]] };

function snapshotAt(candles: HistoricalCandle[], idx: number, market = MARKET) {
  const slugTs = windowStartSecs(candles[idx].openTime);
  return { slugTs, snap: buildTrainingSnapshot({ candles1m: candles, idx, slugTs, market }) };
}

afterEach(() => { vi.useRealTimers(); });

describe('priceAtOrBefore — no look-ahead', () => {
  const prices: Array<[number, number]> = [[27, 0.45], [82, 0.5], [142, 0.62]];
  test('returns the last print at or before the instant', () => {
    expect(priceAtOrBefore(prices, 100)).toBe(0.5);
    expect(priceAtOrBefore(prices, 142)).toBe(0.62);
  });
  test('never reads the next print, however close it is', () => {
    expect(priceAtOrBefore(prices, 141.999)).toBe(0.5);
  });
  test('null before the first print', () => {
    expect(priceAtOrBefore(prices, 10)).toBeNull();
  });
});

describe('aggregate5m', () => {
  test('matches a 5m candle built by hand, and keeps the last bucket partial', () => {
    const c = makeCandles(12);
    const agg = aggregate5m(c);
    expect(agg).toHaveLength(3);
    const first = c.slice(0, 5);
    expect(agg[0].open).toBe(first[0].open);
    expect(agg[0].close).toBe(first[4].close);
    expect(agg[0].high).toBe(Math.max(...first.map(x => x.high)));
    expect(agg[0].low).toBe(Math.min(...first.map(x => x.low)));
    expect(agg[0].volume).toBeCloseTo(first.reduce((a, x) => a + x.volume, 0), 9);
    expect(agg[2].close).toBe(c[11].close); // partial: minutes 10-11 only
  });
});

describe('candidateIndices', () => {
  test('covers closes from 60s to 840s into the window, 14 of them', () => {
    const c = makeCandles(400);
    const slugTs = windowStartSecs(c[300].openTime);
    const idx = candidateIndices(c, slugTs);
    expect(idx).toHaveLength(14);
    expect((c[idx[0]].openTime + MIN) / 1000 - slugTs).toBe(60);
    expect((c[idx[13]].openTime + MIN) / 1000 - slugTs).toBe(840);
  });
});

describe('buildTrainingSnapshot — the instant is the candle close', () => {
  const candles = makeCandles(400);

  test('nowMs is the close of candle idx, and no candle in the row opens at or after it', () => {
    const idx = 305;
    const { snap } = snapshotAt(candles, idx);
    expect(snap).not.toBeNull();
    expect(snap!.nowMs).toBe(candles[idx].openTime + MIN);
    for (const c of snap!.candles1m) expect((c as HistoricalCandle).openTime + MIN).toBeLessThanOrEqual(snap!.nowMs);
    expect(snap!.lastPrice).toBe(candles[idx].close);
  });

  test('regression: minutesLeft describes the close, not the open (the 60s look-ahead)', () => {
    const idx = 305;
    const { slugTs, snap } = snapshotAt(candles, idx);
    const secsIntoAtClose = (candles[idx].openTime + MIN) / 1000 - slugTs;
    expect(snap!.minutesLeft).toBeCloseTo((900 - secsIntoAtClose) / 60, 9);
  });

  test('regression: price to beat is the open of the window, not the close 15 candles back', () => {
    const idx = 305;
    const { slugTs, snap } = snapshotAt(candles, idx);
    const windowOpen = candles.find(c => c.openTime === slugTs * 1000)!;
    expect(snap!.windowOpenPrice).toBe(windowOpen.open);
    expect(snap!.windowOpenPrice).not.toBe(candles[idx - 15].close);
  });

  test('regression: the token price is the one at the instant, not at window open', () => {
    const c = makeCandles(400);
    // Find a candle closing 240s into its window: the print at 203 (0.66) applies.
    const idx = c.findIndex((x, i) => i >= 300 && ((x.openTime + MIN) / 1000) % 900 === 240);
    const { snap } = snapshotAt(c, idx);
    expect(snap!.marketUp).toBe(0.66);
    expect(snap!.marketUpLag).toBe(0.62); // last print at or before 180s
  });

  test('a gap in the candles drops the row instead of mislabelling the PTB', () => {
    const c = makeCandles(400);
    const idx = c.findIndex((x, i) => i >= 300 && ((x.openTime + MIN) / 1000) % 900 === 300);
    const slugTs = windowStartSecs(c[idx].openTime);
    const gapped = c.filter(x => x.openTime !== slugTs * 1000); // window-open candle missing
    const gIdx = gapped.findIndex(x => x.openTime === c[idx].openTime);
    expect(buildTrainingSnapshot({ candles1m: gapped, idx: gIdx, slugTs, market: MARKET })).toBeNull();
  });

  test('no row before the market has printed', () => {
    const idx = candles.findIndex((x, i) => i >= 300 && ((x.openTime + MIN) / 1000) % 900 === 60);
    const late: LookupMarket = { label: 0, prices: [[120, 0.5]] };
    expect(snapshotAt(candles, idx, late).snap).toBeNull();
  });

  test('not enough history -> null', () => {
    const short = makeCandles(CANDLES_1M - 10);
    expect(buildTrainingSnapshot({ candles1m: short, idx: short.length - 1, slugTs: windowStartSecs(short[short.length - 1].openTime), market: MARKET })).toBeNull();
  });
});

describe('buildMlFeatureInputs — one pure builder', () => {
  const candles = makeCandles(400);
  const { snap } = snapshotAt(candles, 305);

  test('is a function of the snapshot only: the wall clock cannot move a feature', () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2020, 0, 1, 3, 0));
    const a = buildTrainingFeatures(snap!, 54);
    vi.setSystemTime(Date.UTC(2030, 5, 1, 18, 30));
    const b = buildTrainingFeatures(snap!, 54);
    expect(b).toEqual(a);
  });

  test('hour and session come from the snapshot instant', () => {
    const f = buildTrainingFeatures(snap!, 54);
    const d = new Date(snap!.nowMs);
    const h = d.getUTCHours() + d.getUTCMinutes() / 60;
    expect(f[FI.hour_sin]).toBeCloseTo(Math.sin(h / 24 * 2 * Math.PI), 12);
    expect(f[FI.hour_cos]).toBeCloseTo(Math.cos(h / 24 * 2 * Math.PI), 12);
  });

  test('ptb_dist_pct is measured from the window open on the same feed', () => {
    const f = buildTrainingFeatures(snap!, 54);
    expect(f[FI.ptb_dist_pct]).toBeCloseTo((snap!.lastPrice - snap!.windowOpenPrice!) / snap!.windowOpenPrice!, 12);
  });

  test('market features are the price at the instant and its 60s change', () => {
    const f = buildTrainingFeatures(snap!, 54);
    expect(f[FI.market_yes_price]).toBeCloseTo(snap!.marketUp!, 12);
    expect(f[FI.market_price_momentum]).toBeCloseTo(
      Math.max(-0.1, Math.min(0.1, snap!.marketUp! - (snap!.marketUpLag ?? snap!.marketUp!))), 12);
  });

  test('inputs no offline source can reproduce are neutral, so they cannot differ live', () => {
    const { marketState } = buildMlFeatureInputs(snap!);
    expect(marketState.orderbookImbalance).toBeNull();
    expect(marketState.spreadPct).toBeNull();
    const f = buildTrainingFeatures(snap!, 54);
    expect(f[FI.orderbook_imbalance]).toBe(0);
  });

  test('crowd_model_divergence uses the same rule probability as rule_prob_up', () => {
    const f = buildTrainingFeatures(snap!, 54);
    expect(f[FI.crowd_model_divergence]).toBeCloseTo(Math.abs(f[FI.rule_prob_up] - f[FI.market_yes_price]), 12);
  });

  test('marketMomentum is 0 when either end is unknown', () => {
    expect(marketMomentum(0.6, null)).toBe(0);
    expect(marketMomentum(null, 0.5)).toBe(0);
    expect(marketMomentum(0.6, 0.5)).toBeCloseTo(0.1, 12);
  });

  test('the pipeline version is 2', () => {
    expect(FEATURE_PIPELINE_VERSION).toBe(2);
  });
});

describe('a live snapshot and a training snapshot of the same instant give the same features', () => {
  test('parity through the one builder', () => {
    const candles = makeCandles(400);
    const { snap } = snapshotAt(candles, 305);
    // What the live bot would assemble at the same instant, field by field.
    const live: FeatureSnapshot = {
      candles1m: snap!.candles1m, candles5m: snap!.candles5m,
      lastPrice: snap!.lastPrice, windowOpenPrice: snap!.windowOpenPrice,
      minutesLeft: snap!.minutesLeft, nowMs: snap!.nowMs,
      marketUp: snap!.marketUp, marketUpLag: snap!.marketUpLag, fundingRate: null,
    };
    expect(buildTrainingFeatures(live, 54)).toEqual(buildTrainingFeatures(snap!, 54));
  });
});
