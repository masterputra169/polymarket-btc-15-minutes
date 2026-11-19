import { describe, it, expect } from 'vitest';
import { buildPriceChartSnapshot } from '../engines/priceChartSnapshot.ts';

describe('buildPriceChartSnapshot', () => {
  it('merges spot and TWAP ticks by second, rounds to 2dp, and filters to window bounds', () => {
    const startMs = 1_700_000_000_000;
    const endMs = startMs + 900_000;

    const snap = buildPriceChartSnapshot({
      slug: 'btc-updown-15m-1700000000',
      startMs,
      endMs,
      nowMs: startMs + 10_000,
      ptb: 91_234.567,
      ptbExact: true,
      ptbSource: 'chainlink_twap',
      spotTicks: [
        { ts: startMs - 5_000, value: 90_000 }, // out of bounds
        { ts: startMs + 1_000, value: 91_235.126 },
        { ts: startMs + 2_000, value: 91_240.001 },
      ],
      twapTicks: [
        { ts: startMs + 1_000, value: 91_230.994 },
        { ts: startMs + 3_000, value: 91_232.5 },
      ],
      liveSpot: 91_245.555,
      liveTwap: 91_234.123,
    });

    expect(snap.ptb).toBe(91_234.57);
    expect(snap.ptbExact).toBe(true);
    expect(snap.points).toEqual([
      [1_700_000_001, 91_235.13, 91_230.99],
      [1_700_000_002, 91_240, null],
      [1_700_000_003, null, 91_232.5],
      [1_700_000_010, 91_245.56, 91_234.12],
    ]);
  });

  it('downsamples dense 900s series to <= maxPoints while keeping first, last, and lossless trailing 90s', () => {
    const startMs = 1_700_000_000_000;
    const endMs = startMs + 900_000;
    const spotTicks = Array.from({ length: 850 }, (_, s) => ({
      ts: startMs + s * 1000,
      value: 90_000 + Math.sin(s / 20) * 50,
    }));

    const snap = buildPriceChartSnapshot({
      slug: 'btc-updown-15m-test',
      startMs,
      endMs,
      nowMs: startMs + 849_000,
      ptb: 90_000,
      ptbExact: true,
      ptbSource: 'chainlink_twap',
      spotTicks,
      twapTicks: [],
      maxPoints: 300,
      fullResTailSec: 90,
    });

    const firstSec = Math.round(startMs / 1000);
    const lastSec = firstSec + 849;
    expect(snap.points.length).toBeLessThanOrEqual(300);
    expect(snap.points[0][0]).toBe(firstSec);
    expect(snap.points[snap.points.length - 1][0]).toBe(lastSec);

    // Every single second inside trailing 90s is preserved losslessly
    const tailCutoff = lastSec - 90;
    const tailSecs = snap.points.filter(p => p[0] >= tailCutoff).map(p => p[0]);
    expect(tailSecs).toHaveLength(91);
    expect(tailSecs[0]).toBe(tailCutoff);
    expect(tailSecs[tailSecs.length - 1]).toBe(lastSec);
  });

  it('resolves open position entry marker to nearest spot tick for active slug only', () => {
    const startMs = 1_700_000_000_000;
    const endMs = startMs + 900_000;

    const active = buildPriceChartSnapshot({
      slug: 'btc-updown-15m-open',
      startMs,
      endMs,
      nowMs: startMs + 120_000,
      ptb: 90_000,
      ptbExact: true,
      ptbSource: 'chainlink_twap',
      spotTicks: [
        { ts: startMs + 50_000, value: 90_010 },
        { ts: startMs + 60_000, value: 90_042.5 },
        { ts: startMs + 70_000, value: 90_080 },
      ],
      twapTicks: [],
      position: {
        marketSlug: 'btc-updown-15m-open',
        settled: false,
        side: 'UP',
        price: 0.58,
        enteredAt: startMs + 59_000,
      },
    });

    expect(active.entry).toEqual({
      ts: startMs + 59_000,
      btcPrice: 90_042.5,
      side: 'UP',
      tokenPrice: 0.58,
    });

    const wrongSlug = buildPriceChartSnapshot({
      slug: 'btc-updown-15m-next',
      startMs,
      endMs,
      nowMs: startMs + 10_000,
      ptb: 90_000,
      ptbExact: true,
      ptbSource: 'chainlink_twap',
      spotTicks: [],
      twapTicks: [],
      position: {
        marketSlug: 'btc-updown-15m-open',
        settled: false,
        side: 'UP',
        price: 0.58,
        enteredAt: startMs + 59_000,
      },
    });
    expect(wrongSlug.entry).toBeNull();
  });
});
