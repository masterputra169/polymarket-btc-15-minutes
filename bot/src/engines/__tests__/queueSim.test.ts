import { beforeEach, describe, expect, it } from 'vitest';
import {
  createQueueSimOrder,
  estimateQueueFillFeasibility,
  resetQueueSim,
  stepQueueOrder,
} from '../queueSim.ts';

describe('queueSim pessimistic FIFO maker queue', () => {
  beforeEach(() => {
    resetQueueSim();
  });

  it('requires queueAhead + own shares to be eaten by corroborated SELL trades at or below bid', () => {
    const order = createQueueSimOrder({
      marketSlug: 'btc-updown-15m-test',
      side: 'UP',
      targetPrice: 0.58,
      shares: 5,
      initialBookSizeAtBid: 20,
      nowMs: 1_000,
    });

    // Ignored: before placement, wrong token, BUY aggressor, or price above bid
    stepQueueOrder({
      order,
      lastBookQuoteMs: 1_100,
      nowMs: 1_200,
      trades: [
        { t: 900, token: 'up', side: 'SELL', price: 0.58, size: 50 },
        { t: 1_050, token: 'down', side: 'SELL', price: 0.58, size: 50 },
        { t: 1_100, token: 'up', side: 'BUY', price: 0.58, size: 50 },
        { t: 1_150, token: 'up', side: 'SELL', price: 0.59, size: 50 },
      ],
    });
    expect(order.status).toBe('RESTING');
    expect(order.queueAhead).toBe(20);
    expect(order.remainingShares).toBe(5);

    // Corroborated SELL consumes 18 of 20 queueAhead (bookDecreaseAtBid caps tradeSize 25 -> 18)
    stepQueueOrder({
      order,
      lastBookQuoteMs: 1_300,
      nowMs: 1_400,
      trades: [
        { t: 1_350, token: 'up', side: 'SELL', price: 0.58, size: 25, bookDecreaseAtBid: 18 },
      ],
    });
    expect(order.status).toBe('RESTING');
    expect(order.queueAhead).toBe(2);
    expect(order.remainingShares).toBe(5);

    // Remaining 2 queueAhead + all 5 shares eaten by SELL @ 0.57
    stepQueueOrder({
      order,
      lastBookQuoteMs: 1_500,
      nowMs: 1_600,
      trades: [
        { t: 1_550, token: 'up', side: 'SELL', price: 0.57, size: 7 },
      ],
    });
    expect(order.status).toBe('FILLED');
    expect(order.queueAhead).toBe(0);
    expect(order.remainingShares).toBe(0);
    expect(order.filledAtMs).toBe(1_550);
  });

  it('cancels on stale book (>500ms since genuine quote) BEFORE letting correlated trades fill', () => {
    const order = createQueueSimOrder({
      marketSlug: 'btc-updown-15m-test',
      side: 'DOWN',
      targetPrice: 0.60,
      shares: 5,
      initialBookSizeAtBid: 0,
      nowMs: 1_000,
    });

    // Book quote is 600ms old (> 500ms) even though a SELL trade arrives right at nowMs
    stepQueueOrder({
      order,
      lastBookQuoteMs: 1_400,
      nowMs: 2_000,
      trades: [
        { t: 1_990, token: 'down', side: 'SELL', price: 0.60, size: 10 },
      ],
    });
    expect(order.status).toBe('STALE_CANCELLED');
    expect(order.cancelReason).toBe('stale_book');
  });

  it('computes queue feasibility shadow metrics cleanly', () => {
    const est = estimateQueueFillFeasibility({
      initialBookSizeAtBid: 25,
      shares: 5,
      spread: 0.02,
      lastBookQuoteAgeMs: 120,
    });
    expect(est).toEqual({ queueAhead: 25, bookFresh: true, expectedQueuePressure: 2.5 });
  });

  it('supports unified CTF complementary BUY prints, L2 cross, and seq deduplication across polls', () => {
    const order = createQueueSimOrder({
      marketSlug: 'btc-updown-15m-unified',
      side: 'UP',
      targetPrice: 0.58,
      shares: 5,
      initialBookSizeAtBid: 10,
      nowMs: 1_000,
    });

    // Complement BUY below 1 - 0.58 = 0.42 does NOT hit our bid;
    // complement BUY at 0.42 (seq=1) hits our UP@0.58 bid for 8 shares (leaving 2 queueAhead).
    const cumTrades = [
      { t: 1_100, seq: 1, token: 'down' as const, side: 'BUY' as const, price: 0.41, size: 50 },
      { t: 1_200, seq: 2, token: 'down' as const, side: 'BUY' as const, price: 0.42, size: 8 },
    ];
    stepQueueOrder({
      order,
      trades: cumTrades,
      lastBookQuoteMs: 1_250,
      nowMs: 1_300,
      allowComplementaryBuys: true,
    });
    expect(order.status).toBe('RESTING');
    expect(order.queueAhead).toBe(2);
    expect(order.remainingShares).toBe(5);

    // Repeating exact same cumulative array on next poll MUST NOT double-count seq=2!
    stepQueueOrder({
      order,
      trades: cumTrades,
      lastBookQuoteMs: 1_350,
      nowMs: 1_400,
      allowComplementaryBuys: true,
    });
    expect(order.status).toBe('RESTING');
    expect(order.queueAhead).toBe(2);
    expect(order.remainingShares).toBe(5);

    // Conservative L2 cross (bestAsk dropped strictly below 0.58 -> 0.57) fills on fresh book.
    stepQueueOrder({
      order,
      trades: cumTrades,
      lastBookQuoteMs: 1_450,
      nowMs: 1_500,
      allowComplementaryBuys: true,
      currentBestAsk: 0.57,
    });
    expect(order.status).toBe('FILLED');
    expect(order.queueAhead).toBe(0);
    expect(order.remainingShares).toBe(0);
  });

  it('ignores trades arriving during order-entry wire latency (hftbacktest pattern)', () => {
    const order = createQueueSimOrder({
      marketSlug: 'btc-updown-15m-lat',
      side: 'UP',
      targetPrice: 0.60,
      shares: 5,
      initialBookSizeAtBid: 0,
      nowMs: 1_000,
      entryLatencyMs: 120,
    });
    expect(order.effectivePlacedAtMs).toBe(1_120);

    stepQueueOrder({
      order,
      trades: [{ t: 1_080, seq: 1, token: 'up', side: 'SELL', price: 0.60, size: 10 }],
      lastBookQuoteMs: 1_100,
      nowMs: 1_110,
    });
    expect(order.status).toBe('RESTING');

    stepQueueOrder({
      order,
      trades: [{ t: 1_150, seq: 2, token: 'up', side: 'SELL', price: 0.60, size: 10 }],
      lastBookQuoteMs: 1_160,
      nowMs: 1_180,
    });
    expect(order.status).toBe('FILLED');
  });
});
