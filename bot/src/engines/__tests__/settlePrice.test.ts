/**
 * What "distance to the price to beat" is measured from: Chainlink (Binance sat
 * ~$24 above it on the 2026-09-24/25 tape), and in the final minute the part of
 * the settlement TWAP that is already written.
 */
import { describe, test, expect } from 'vitest';
import { estimateSettlePrice, BasisTracker, TWAP_WINDOW_MS } from '../settlePrice.ts';

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
});
