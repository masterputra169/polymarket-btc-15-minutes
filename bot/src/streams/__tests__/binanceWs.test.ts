import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.mock('../../logger.ts', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  ingestBinanceMessage,
  getPrice,
  getPrevPrice,
  getRecentPriceWindow,
  recordBinanceTickForTest,
  clearBinanceTicksForTest,
  seedKlines1m,
  getKlines1m,
  getLastKlineMsgTime,
  needsKlinesResync,
  resetBinanceKlinesForTest,
  setBinanceConnectedForTest,
  type BinanceKlineBar,
} from '../binanceWs.ts';
import { aggregate5m, CANDLES_5M } from '../../../../src/engines/ml/trainingRow.ts';

function makeBars(count: number, startOpenTime = 1_795_000_020_000): BinanceKlineBar[] {
  const out: BinanceKlineBar[] = [];
  for (let i = 0; i < count; i++) {
    const openTime = startOpenTime + i * 60_000;
    const base = 62_500 + i;
    out.push({
      openTime,
      open: base,
      high: base + 12,
      low: base - 8,
      close: base + 4,
      volume: 10 + (i % 5),
      closeTime: openTime + 59_999,
      takerBuyVolume: 6 + (i % 3),
    });
  }
  return out;
}

function klineFrame(bar: BinanceKlineBar, closed = false): string {
  return JSON.stringify({
    stream: 'btcusdt@kline_1m',
    data: {
      e: 'kline',
      E: bar.openTime + 30_000,
      s: 'BTCUSDT',
      k: {
        t: bar.openTime,
        T: bar.closeTime,
        s: 'BTCUSDT',
        i: '1m',
        o: String(bar.open),
        c: String(bar.close),
        h: String(bar.high),
        l: String(bar.low),
        v: String(bar.volume),
        V: String(bar.takerBuyVolume),
        x: closed,
      },
    },
  });
}

describe('binanceWs combined bookTicker + kline_1m stream', () => {
  beforeEach(() => {
    resetBinanceKlinesForTest();
  });

  test('combined bookTicker updates mid price and throttles _recentTicks to >=50ms while recordBinanceTickForTest stays exact', () => {
    const t0 = 1_795_052_700_000;
    ingestBinanceMessage(
      JSON.stringify({ stream: 'btcusdt@bookTicker', data: { b: '62700.00', a: '62700.10' } }),
      t0,
    );
    expect(getPrice()).toBeCloseTo(62_700.05, 6);
    expect(getPrevPrice()).toBeNull();

    // 10ms later -> price updates, tick buffer sample throttled (<50ms)
    ingestBinanceMessage(
      JSON.stringify({ stream: 'btcusdt@bookTicker', data: { b: '62702.00', a: '62702.20' } }),
      t0 + 10,
    );
    expect(getPrevPrice()).toBeCloseTo(62_700.05, 6);
    expect(getPrice()).toBeCloseTo(62_702.10, 6);
    expect(getRecentPriceWindow(3_000, t0 + 10).tickCount).toBe(1);

    // 55ms after first sample -> pushed into _recentTicks
    ingestBinanceMessage(
      JSON.stringify({ stream: 'btcusdt@bookTicker', data: { b: '62705.00', a: '62705.00' } }),
      t0 + 55,
    );
    const win = getRecentPriceWindow(3_000, t0 + 55);
    expect(win.tickCount).toBe(2);
    expect(win.deltaUsd).toBeCloseTo(4.95, 4);

    // Deterministic test helper remains unthrottled even inside 50ms
    clearBinanceTicksForTest();
    recordBinanceTickForTest(62_800, t0);
    recordBinanceTickForTest(62_810, t0 + 5);
    recordBinanceTickForTest(62_820, t0 + 10);
    expect(getRecentPriceWindow(3_000, t0 + 10).tickCount).toBe(3);
  });

  test('seedKlines1m preserves newer/higher-volume WS bar, clears resync flag, and aggregates 48x5m in RAM', () => {
    // Seed must start aligned to a 5m boundary so 240 1m bars collapse into 48 complete 5m bars
    const startAligned = 1_795_000_200_000; // divisible by 300_000
    const bars = makeBars(240, startAligned);
    const t0 = startAligned + 239 * 60_000 + 25_000;

    setBinanceConnectedForTest(true);
    seedKlines1m(bars, t0);
    expect(needsKlinesResync(t0 + 1_000)).toBe(false);

    const k1 = getKlines1m();
    expect(k1).not.toBeNull();
    expect(k1!.length).toBe(240);

    const k5 = aggregate5m(k1!).slice(-CANDLES_5M);
    expect(k5.length).toBe(48);
    expect(k5[k5.length - 1].takerBuyVolume).toBeGreaterThan(0);

    // Live kline_1m updates the forming bar with higher volume
    const lastBar = bars[bars.length - 1];
    const hotterLast: BinanceKlineBar = {
      ...lastBar,
      close: lastBar.close + 25,
      high: Math.max(lastBar.high, lastBar.close + 25),
      volume: lastBar.volume + 42,
      takerBuyVolume: lastBar.takerBuyVolume + 30,
    };
    ingestBinanceMessage(klineFrame(hotterLast), t0 + 2_000);
    expect(getLastKlineMsgTime()).toBe(t0 + 2_000);

    // Re-seeding stale snapshot preserves the hotter WS bar
    seedKlines1m(bars, t0 + 2_100);
    const afterReseed = getKlines1m()!;
    expect(afterReseed[afterReseed.length - 1].volume).toBeCloseTo(hotterLast.volume, 6);
    expect(afterReseed[afterReseed.length - 1].takerBuyVolume).toBeCloseTo(hotterLast.takerBuyVolume, 6);

    // Contiguous next minute appends and caps buffer at 240 bars
    const nextBar: BinanceKlineBar = {
      openTime: lastBar.openTime + 60_000,
      open: hotterLast.close,
      high: hotterLast.close + 10,
      low: hotterLast.close - 5,
      close: hotterLast.close + 7,
      volume: 3.5,
      closeTime: lastBar.closeTime + 60_000,
      takerBuyVolume: 2.1,
    };
    ingestBinanceMessage(klineFrame(nextBar), t0 + 36_000);
    const afterNext = getKlines1m()!;
    expect(afterNext.length).toBe(240);
    expect(afterNext[afterNext.length - 1].openTime).toBe(nextBar.openTime);
    expect(needsKlinesResync(t0 + 37_000)).toBe(false);

    // Stale out-of-order bar (< last.openTime) is ignored
    ingestBinanceMessage(klineFrame(bars[0]), t0 + 38_000);
    expect(getKlines1m()![239].openTime).toBe(nextBar.openTime);

    // >60s gap flags resync needed
    const gapBar: BinanceKlineBar = {
      ...nextBar,
      openTime: nextBar.openTime + 120_000,
      closeTime: nextBar.closeTime + 120_000,
    };
    ingestBinanceMessage(klineFrame(gapBar), t0 + 156_000);
    expect(needsKlinesResync(t0 + 157_000)).toBe(true);
    expect(getKlines1m()!.length).toBe(240);
  });
});
