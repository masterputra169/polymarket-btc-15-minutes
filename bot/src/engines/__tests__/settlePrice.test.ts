/**
 * What "distance to the price to beat" is measured from: Chainlink (Binance sat
 * ~$24 above it on the 2026-09-24/25 tape), and in the final minute the part of
 * the settlement TWAP that is already written.
 */
import { describe, test, expect } from 'vitest';
import { estimateSettlePrice, BasisTracker, computeCrossFeedMetrics, TWAP_WINDOW_MS } from '../settlePrice.ts';

const END = 1790352900000;
const secs = (from: number, n: number, value: (i: number) => number) =>
  Array.from({ length: n }, (_, i) => ({ ts: from + i * 1000, value: value(i) }));

describe('estimateSettlePrice', () => {
  test('more than a minute left: the current Chainlink price', () => {
    const r = estimateSettlePrice({ nowMs: END - 5 * 60_000, endMs: END, spot: 84_000, spotTicks: [], binance: 84_024, basis: 24 });
    expect(r).toEqual({ price: 84_000, source: 'chainlink' });
  });

  test('final minute: seconds already seen count as written, the rest at the current price', () => {
    // 30 of 60 seconds seen at 84,000, price now 84,060: expected TWAP = (30×84,000 + 30×84,060)/60
    const ticks = secs(END - TWAP_WINDOW_MS + 1000, 30, () => 84_000);
    const r = estimateSettlePrice({ nowMs: END - 30_000, endMs: END, spot: 84_060, spotTicks: ticks, binance: null, basis: null });
    expect(r.source).toBe('chainlink_final_minute');
    expect(r.price).toBeCloseTo(84_030, 6);
  });

  test('final minute with a gap: a missing second holds the previous tick', () => {
    const ticks = [
      { ts: END - 61_000, value: 83_990 },            // seeds the first seconds
      ...secs(END - 40_000, 10, () => 84_010),         // seconds 20..29
    ];
    // seconds 1..19 hold 83,990 (19), 20..29 are 84,010 (10), 30 holds 84,010 (1); 30 remaining at 84,050
    const r = estimateSettlePrice({ nowMs: END - 30_000, endMs: END, spot: 84_050, spotTicks: ticks, binance: null, basis: null });
    expect(r.price).toBeCloseTo((19 * 83_990 + 11 * 84_010 + 30 * 84_050) / 60, 6);
  });

  test('at the end every second is written: the estimate is the plain average', () => {
    const ticks = secs(END - TWAP_WINDOW_MS + 1000, 60, i => 84_000 + i);
    const r = estimateSettlePrice({ nowMs: END + 500, endMs: END, spot: 99_999, spotTicks: ticks, binance: null, basis: null });
    expect(r.price).toBeCloseTo(84_029.5, 6);
  });

  test('no Chainlink: Binance shifted by the tracked basis, raw only if no basis was ever seen', () => {
    expect(estimateSettlePrice({ nowMs: 0, endMs: END, spot: null, spotTicks: [], binance: 84_024, basis: 23.76 }))
      .toEqual({ price: 84_024 - 23.76, source: 'binance_minus_basis' });
    expect(estimateSettlePrice({ nowMs: 0, endMs: END, spot: null, spotTicks: [], binance: 84_024, basis: null }).source).toBe('binance_raw');
    expect(estimateSettlePrice({ nowMs: 0, endMs: END, spot: null, spotTicks: [], binance: null, basis: null })).toEqual({ price: null, source: 'none' });
  });

  test('final minute ignores anomalous outlier bad ticks (> 6 sigma)', () => {
    const normalTicks = secs(END - TWAP_WINDOW_MS + 1000, 29, () => 84_000);
    const glitchTick = { ts: END - TWAP_WINDOW_MS + 15000, value: 99_999 };
    const allTicks = [...normalTicks, glitchTick];
    const r = estimateSettlePrice({ nowMs: END - 30_000, endMs: END, spot: 84_060, spotTicks: allTicks, binance: null, basis: null });
    expect(r.source).toBe('chainlink_final_minute');
    expect(r.price).toBeCloseTo(84_030, 6);
  });
});

describe('BasisTracker', () => {
  test('starts at the first observation, moves slowly and clips a bad poll', () => {
    const b = new BasisTracker(0.1, 2);
    expect(b.get()).toBeNull();
    b.update(84_024, 84_000);
    expect(b.get()).toBe(24);
    b.update(84_100, 84_000);          // a 100 jump: clipped to +2
    expect(b.get()).toBe(26);
    b.update(84_000, null);            // ignored
    b.update(90_000, 84_000);          // absurd: ignored
    expect(b.get()).toBe(26);
  });

  test('median-window mode ignores a single outlier spike while converging smoothly on sustained shifts', () => {
    const b = new BasisTracker(0.15, 10, 5);
    for (let i = 0; i < 5; i++) b.update(65_024, 65_000);
    expect(b.get()).toBeCloseTo(24, 6);

    // Single poll spike (+$150 basis): median stays 24 -> unmoved.
    b.update(65_150, 65_000);
    expect(b.get()).toBeCloseTo(24, 6);

    // Sustained shift to +$62 USDT basis across >= 3 of 5 polls moves tracker toward 62.
    for (let i = 0; i < 20; i++) b.update(65_062, 65_000);
    expect(b.get()!).toBeGreaterThan(58);
    expect(b.get()!).toBeLessThanOrEqual(62);
  });
});

describe('computeCrossFeedMetrics', () => {
  test('steady exchange basis cancels out across Binance window open and now', () => {
    const m = computeCrossFeedMetrics({
      lastPrice: 65_062,
      binanceWindowOpen: 64_962,
      settlePrice: 65_000,
      exactPtb: 64_900,
      clSpot: 65_000,
    });
    expect(m.liveBasisUsd).toBe(62);
    expect(m.binanceDistUsd).toBe(100);
    expect(m.oracleDistUsd).toBe(100);
    expect(m.crossFeedSkewUsd).toBe(0);
    expect(m.crossFeedSkewPct).toBeCloseTo(0, 3);
  });

  test('detects cross-feed skew when Binance is above open while Chainlink settles below PTB', () => {
    const m = computeCrossFeedMetrics({
      lastPrice: 65_062,
      binanceWindowOpen: 65_022,
      settlePrice: 65_000,
      exactPtb: 65_015,
      clSpot: 65_000,
    });
    expect(m.binanceDistUsd).toBe(40);
    expect(m.oracleDistUsd).toBe(-15);
    expect(m.crossFeedSkewUsd).toBe(55);
    expect(m.crossFeedSkewPct!).toBeGreaterThan(0.08);
  });

  test('returns nulls safely when inputs are missing', () => {
    const m = computeCrossFeedMetrics({
      lastPrice: null,
      binanceWindowOpen: null,
      settlePrice: 65_000,
      exactPtb: null,
    });
    expect(m.binanceDistPct).toBeNull();
    expect(m.oracleDistPct).toBeNull();
    expect(m.crossFeedSkewPct).toBeNull();
  });
});
