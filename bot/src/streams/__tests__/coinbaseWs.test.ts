import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.mock('../../logger.ts', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  ingestCoinbaseMessage,
  getPrice,
  getPrevPrice,
  getLastMsgTime,
  resetCoinbaseForTest,
} from '../coinbaseWs.ts';
import { ChainlinkNowcastTracker } from '../../engines/settlePrice.ts';

describe('coinbaseWs public BTC-USD stream & multi-venue ChainlinkNowcastTracker', () => {
  beforeEach(() => {
    resetCoinbaseForTest();
  });

  test('parses Coinbase ticker mid price, falls back to last trade, and ignores out-of-range frames', () => {
    const t0 = 1_795_000_000_000;
    ingestCoinbaseMessage(JSON.stringify({
      type: 'ticker',
      product_id: 'BTC-USD',
      price: '62710.00',
      best_bid: '62710.00',
      best_ask: '62712.00',
    }), t0);
    expect(getPrice()).toBeCloseTo(62_711, 6);
    expect(getLastMsgTime()).toBe(t0);

    // Falls back to last price when bid/ask missing
    ingestCoinbaseMessage(JSON.stringify({
      type: 'ticker',
      product_id: 'BTC-USD',
      price: '62720.50',
    }), t0 + 100);
    expect(getPrevPrice()).toBeCloseTo(62_711, 6);
    expect(getPrice()).toBeCloseTo(62_720.5, 6);

    // Rejects bogus/malformed prices while keeping last valid quote
    ingestCoinbaseMessage(JSON.stringify({
      type: 'ticker',
      product_id: 'BTC-USD',
      best_bid: '100',
      best_ask: '105',
      price: '102',
    }), t0 + 200);
    expect(getPrice()).toBeCloseTo(62_720.5, 6);
  });

  test('ChainlinkNowcastTracker blends 50/50 Coinbase USD + Binance USDT deltas and falls back gracefully', () => {
    const tracker = new ChainlinkNowcastTracker(15_000, 0.005);
    const now = Date.now();

    // Anchor on new Chainlink tick with both venues present
    expect(tracker.update(79_980, now - 200, 80_000, 79_985)).toBe(79_980);

    // Binance +20, Coinbase +10 -> mean +15 => 79_995
    expect(tracker.update(79_980, now - 200, 80_020, 79_995)).toBeCloseTo(79_995, 6);

    // Coinbase offline (null) -> falls back to Binance delta (+30 => 80_010)
    expect(tracker.update(79_980, now - 200, 80_030, null)).toBeCloseTo(80_010, 6);

    // Binance offline (null) -> falls back to Coinbase delta (+14 => 79_994)
    expect(tracker.update(79_980, now - 200, null, 79_999)).toBeCloseTo(79_994, 6);
  });
});
