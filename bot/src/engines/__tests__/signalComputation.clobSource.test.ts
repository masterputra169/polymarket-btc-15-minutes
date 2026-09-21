/**
 * Which book does the signal pipeline price off?
 *
 * The old rule asked two questions as one — "is the CLOB connected AND has a
 * quote moved in the last 15s" — and on a no, fell back to `poly.prices`. That
 * fallback is a 30s Gamma cache (tieredCache MARKET_DISCOVERY_INTERVAL), so a
 * quiet-but-live book was swapped for strictly older data, and low-margin arbs
 * were suppressed along with it.
 *
 * computeSignals no longer makes that judgement: it is handed a decided
 * `clobUsable` (see clobFreshness.ts) and must simply honour it. These tests
 * pin that it does, in both directions.
 */

import { describe, test, expect } from 'vitest';
import { computeSignals, resetMarketUpHistory } from '../signalComputation.ts';

const WS_UP = 0.62;
const WS_DOWN = 0.38;
const REST_UP = 0.40;
const REST_DOWN = 0.60;

/** Flat synthetic candles — indicators need history, this test does not care what they say. */
function candles(n: number, price = 81_000) {
  return Array.from({ length: n }, (_, i) => ({
    open: price + (i % 3),
    high: price + 5,
    low: price - 5,
    close: price + (i % 3),
    volume: 100,
    takerBuyVolume: 50,
  }));
}

const wsBook = {
  up: { bestBid: 0.60, bestAsk: 0.64, spread: 0.04, bidLiquidity: 500, askLiquidity: 500 },
  down: { bestBid: 0.36, bestAsk: 0.40, spread: 0.04, bidLiquidity: 500, askLiquidity: 500 },
};

const restBook = {
  up: { bestBid: 0.38, bestAsk: 0.42, spread: 0.04, bidLiquidity: 100, askLiquidity: 100 },
  down: { bestBid: 0.58, bestAsk: 0.62, spread: 0.04, bidLiquidity: 100, askLiquidity: 100 },
};

function run(clobUsable: boolean) {
  resetMarketUpHistory();
  return computeSignals({
    klines1m: candles(240),
    klines5m: candles(48),
    lastPrice: 81_000,
    poly: {
      prices: { up: REST_UP, down: REST_DOWN },
      orderbook: restBook,
    },
    priceToBeat: { slug: 'btc-15m', value: 80_900, source: 'scheduled_ws', updatedAt: Date.now() },
    marketSlug: 'btc-15m',
    now: Date.now(),
    clobUsable,
    getClobUpPrice: () => WS_UP,
    getClobDownPrice: () => WS_DOWN,
    getClobOrderbook: () => wsBook,
    feedbackStats: null,
    timeLeftMin: 8,
    candleWindowMinutes: 15,
    getMLPrediction: () => ({ available: false }),
    fundingRate: null,
    smartFlowSignal: null,
    oraclePrice: 80_900,
  });
}

describe('computeSignals — CLOB price source', () => {
  test('uses the live WS book when the feed is usable', () => {
    const sig = run(true);
    expect(sig.useClobWs).toBe(true);
    expect(sig.marketUp).toBe(WS_UP);
    expect(sig.marketDown).toBe(WS_DOWN);
    expect(sig.orderbookUp.bestBid).toBe(wsBook.up.bestBid);
  });

  test('falls back to the REST snapshot only when the feed is not usable', () => {
    const sig = run(false);
    expect(sig.useClobWs).toBe(false);
    expect(sig.marketUp).toBe(REST_UP);
    expect(sig.marketDown).toBe(REST_DOWN);
    expect(sig.orderbookUp.bestBid).toBe(restBook.up.bestBid);
  });
});
