/**
 * Property-based tests (`fast-check`) & fault-injection chaos tests over
 * money-critical paths: CLOB parsing, entry invariants, UserWS fill dedup,
 * tick/min order constraints + settlement math, timestamp parsing, and
 * fail-closed limit order lifecycle under REST errors.
 */

import fc from 'fast-check';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

const { sockets } = vi.hoisted(() => ({ sockets: [] as any[] }));

vi.mock('ws', () => {
  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;
    url: string;
    readyState = FakeWebSocket.CONNECTING;
    sent: string[] = [];
    handlers = new Map<string, ((...a: any[]) => void)[]>();
    constructor(url: string) {
      this.url = url;
      sockets.push(this);
    }
    on(event: string, fn: (...a: any[]) => void) {
      if (!this.handlers.has(event)) this.handlers.set(event, []);
      this.handlers.get(event)!.push(fn);
      return this;
    }
    send(data: string) {
      if (this.readyState !== FakeWebSocket.OPEN) throw new Error('not open');
      this.sent.push(data);
    }
    close() {
      if (this.readyState === FakeWebSocket.CLOSED) return;
      this.readyState = FakeWebSocket.CLOSED;
      this.emit('close');
    }
    emit(event: string, ...args: any[]) {
      for (const fn of this.handlers.get(event) ?? []) fn(...args);
    }
    accept() {
      this.readyState = FakeWebSocket.OPEN;
      this.emit('open');
    }
    deliver(msg: unknown) {
      this.emit('message', JSON.stringify(msg));
    }
  }
  return { WebSocket: FakeWebSocket };
});

vi.mock('../logger.ts', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../ml/modelProfiles.ts', () => ({
  getEffectiveLimitOrderConfig: () => ({
    enabled: true,
    minMlConfidence: 0.30,
    minEntryPrice: 0.50,
    maxEntryPrice: 0.67,
    maxUnfilledSec: 60,
    minRemainingEdge: 0.03,
    maxSpread: 0.08,
    maxAttemptsPerMarket: 2,
    cancelCooldownSec: 60,
    minElapsedMin: 1,
    maxElapsedMin: 12,
    expirationBufferSec: 120,
    postOnly: true,
    checkIntervalMs: 0,
    partialFillAcceptRatio: 0.60,
  }),
  getEffectiveMaxBetAmountUsd: () => 5,
}));

vi.mock('../engines/executionTiming.ts', () => ({
  getSpreadTrend: () => 'STABLE',
}));

import { toNumber } from '../../../src/utils.ts';
import * as clobWs from '../streams/clobWs.ts';
import { ingestClobUserMessage, getUserOrderEvent, resetClobUserWsForTest } from '../streams/clobUserWs.ts';
import { checkEntryInvariants } from '../safety/entryInvariants.ts';
import { parseOrderConstraints, prepareOrder, roundPriceToTick } from '../trading/orderConstraints.ts';
import { computeSettlementPnl } from '../engines/settlementMath.ts';
import { parseTradeTimestampMs } from '../trading/fillTracker.ts';
import {
  cancelLimitOrder,
  monitorLimitOrder,
  placeLimitOrder,
  resetLimitAttempts,
  resetLimitOrderState,
} from '../engines/limitOrderManager.ts';

const UP = 'pbt-up-token';
const DOWN = 'pbt-down-token';

const arbitraryRawPrice = fc.oneof(
  fc.double({ min: 0.01, max: 0.99, noNaN: true }).map(n => n.toFixed(3)),
  fc.constantFrom('0', '1', '', '   ', 'NaN', '-0.5', '1.2', '0.01', '0.99'),
  fc.constant(null as unknown as string),
  fc.constant(undefined as unknown as string),
);

const arbitraryRawSize = fc.oneof(
  fc.double({ min: 0, max: 5000, noNaN: true }).map(n => n.toFixed(2)),
  fc.constantFrom('0', '-10', '', 'NaN', '100'),
);

const arbitraryLevels = fc.array(
  fc.record({ price: arbitraryRawPrice, size: arbitraryRawSize }),
  { minLength: 0, maxLength: 10 },
);

describe('Money & microstructure property-based invariants (fast-check)', () => {
  let sock: any;

  beforeAll(() => {
    clobWs.setTokenIds(UP, DOWN);
    clobWs.connect();
    sock = sockets[sockets.length - 1];
    sock.accept();
  });

  afterAll(() => {
    clobWs.disconnect();
  });

  beforeEach(() => {
    resetClobUserWsForTest();
    resetLimitOrderState();
    resetLimitAttempts();
  });

  test('Property 1: clobWs + toNumber preserve (0, 1) price bounds, non-negative spread, and zero liquidity on empty sides', () => {
    expect(toNumber('')).toBeNull();
    expect(toNumber(null)).toBeNull();
    expect(toNumber(false)).toBeNull();

    fc.assert(
      fc.property(
        arbitraryLevels,
        arbitraryLevels,
        arbitraryRawPrice,
        arbitraryRawPrice,
        fc.constantFrom(UP, DOWN),
        (bids, asks, pcBid, pcAsk, assetId) => {
          sock.deliver({ event_type: 'book', asset_id: assetId, bids, asks });
          checkBookInvariants(clobWs.getOrderbook(), clobWs.getUpPrice(), clobWs.getDownPrice());

          sock.deliver({
            event_type: 'price_change',
            price_changes: [{ asset_id: assetId, best_bid: pcBid, best_ask: pcAsk }],
          });
          checkBookInvariants(clobWs.getOrderbook(), clobWs.getUpPrice(), clobWs.getDownPrice());
        },
      ),
      { numRuns: 150 },
    );
  });

  test('Property 2: checkEntryInvariants always rejects one-sided books, negative spreads, sum anomalies, and ask divergence', () => {
    const validPriceArb = fc.integer({ min: 5, max: 95 }).map(c => c / 100);
    const nullablePriceArb = fc.option(fc.integer({ min: 1, max: 99 }).map(c => c / 100), { nil: null });

    fc.assert(
      fc.property(
        validPriceArb,
        nullablePriceArb,
        nullablePriceArb,
        validPriceArb,
        validPriceArb,
        (entryPrice, bestBid, bestAsk, marketUp, marketDown) => {
          const spread = bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null;
          const res = checkEntryInvariants({
            side: 'UP',
            entryPrice,
            sideBook: { bestBid, bestAsk, spread },
            marketUp,
            marketDown,
          });

          const mustFail =
            bestBid === null ||
            bestAsk === null ||
            spread === null ||
            spread < -1e-9 ||
            Math.abs(marketUp + marketDown - 1.0) > 0.15 ||
            Math.abs(entryPrice - bestAsk) > 0.05;

          if (mustFail) {
            expect(res.ok).toBe(false);
          } else {
            expect(res.ok).toBe(true);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  test('Property 3: clobUserWs sizeMatched is monotonic, never double-counts identical trade IDs, and MATCHED never downgrades', () => {
    const stepArb = fc.oneof(
      fc.record({
        kind: fc.constant('order' as const),
        evType: fc.constantFrom('PLACEMENT', 'UPDATE', 'CANCELLATION'),
        matched: fc.double({ min: 0, max: 20, noNaN: true }),
      }),
      fc.record({
        kind: fc.constant('trade' as const),
        tradeId: fc.constantFrom('tr-1', 'tr-2', 'tr-3'),
        status: fc.constantFrom('MATCHED', 'MINED', 'CONFIRMED', 'RETRYING'),
        matchedAmount: fc.double({ min: 0.1, max: 5, noNaN: true }),
      }),
    );

    fc.assert(
      fc.property(fc.array(stepArb, { minLength: 1, maxLength: 15 }), (steps) => {
        resetClobUserWsForTest();
        const orderId = 'ord-pbt-1';
        const seenTrades = new Map<string, number>();
        let maxOrderReported = 0;
        let prevMatched = 0;
        let seenTerminalMatched = false;

        ingestClobUserMessage(JSON.stringify({
          event_type: 'order',
          type: 'PLACEMENT',
          id: orderId,
          original_size: '15',
          size_matched: '0',
          price: '0.60',
          side: 'BUY',
          asset_id: 'tok-pbt',
        }), 1_000);

        steps.forEach((step, idx) => {
          const ts = 2_000 + idx * 100;
          if (step.kind === 'order') {
            ingestClobUserMessage(JSON.stringify({
              event_type: 'order',
              type: step.evType,
              id: orderId,
              original_size: '15',
              size_matched: step.matched.toFixed(4),
              price: '0.60',
            }), ts);
            maxOrderReported = Math.max(maxOrderReported, Number(step.matched.toFixed(4)));
          } else {
            ingestClobUserMessage(JSON.stringify({
              event_type: 'trade',
              id: step.tradeId,
              status: step.status,
              price: '0.60',
              size: '15',
              maker_orders: [{ order_id: orderId, matched_amount: step.matchedAmount.toFixed(4), price: '0.60' }],
            }), ts);
            if (step.status !== 'RETRYING') {
              const key = `${step.tradeId}:maker:${orderId}`;
              seenTrades.set(key, Math.max(seenTrades.get(key) ?? 0, Number(step.matchedAmount.toFixed(4))));
            }
          }

          const state = getUserOrderEvent(orderId)!;
          expect(Number.isFinite(state.sizeMatched)).toBe(true);
          expect(state.sizeMatched).toBeGreaterThanOrEqual(prevMatched - 1e-12);
          prevMatched = state.sizeMatched;

          let uniqueTradeSum = 0;
          for (const v of seenTrades.values()) uniqueTradeSum += v;
          expect(state.sizeMatched).toBeLessThanOrEqual(Math.max(maxOrderReported, uniqueTradeSum) + 1e-6);

          if (seenTerminalMatched) {
            expect(state.status).toBe('MATCHED');
          }
          if (state.status === 'MATCHED') {
            seenTerminalMatched = true;
          }
        });
      }),
      { numRuns: 100 },
    );
  });

  test('Property 4: orderConstraints tick rounding & settlementMath win-loss spread invariants', () => {
    const constraints = parseOrderConstraints({ tick_size: '0.01', min_order_size: '5' });

    fc.assert(
      fc.property(
        fc.constantFrom<'BUY' | 'SELL'>('BUY', 'SELL'),
        fc.constantFrom<'market' | 'limit'>('market', 'limit'),
        fc.double({ min: 0.02, max: 0.98, noNaN: true }),
        fc.double({ min: 0.1, max: 50, noNaN: true }),
        (side, kind, price, size) => {
          const rounded = roundPriceToTick(price, constraints.tickSize, side);
          if (side === 'BUY') expect(rounded).toBeLessThanOrEqual(price + 1e-9);
          else expect(rounded).toBeGreaterThanOrEqual(price - 1e-9);

          const prepared = prepareOrder({ side, kind, price, size, constraints });
          if (prepared.ok) {
            const effShares = side === 'BUY' && kind === 'market' && prepared.buyAmountUsd != null
              ? prepared.buyAmountUsd / prepared.price
              : prepared.size;
            expect(effShares + 1e-9).toBeGreaterThanOrEqual(constraints.minOrderSize);
            expect(prepared.size).toBeLessThanOrEqual(size + 1e-9);
          }

          const winTaker = computeSettlementPnl({ won: true, size: Math.max(1, size), cost: size * price, price, isMaker: false });
          const lossTaker = computeSettlementPnl({ won: false, size: Math.max(1, size), cost: size * price, price, isMaker: false });
          const winMaker = computeSettlementPnl({ won: true, size: Math.max(1, size), cost: size * price, price, isMaker: true });
          expect(Number.isFinite(winTaker)).toBe(true);
          expect(Number.isFinite(lossTaker)).toBe(true);
          expect(winMaker).toBeGreaterThanOrEqual(winTaker);
          expect(winTaker - lossTaker).toBeCloseTo(Math.max(1, size), 1);
        },
      ),
      { numRuns: 150 },
    );
  });

  test('Property 5 & Chaos: parseTradeTimestampMs normalizes formats identically & limitOrderManager fails closed under REST errors', async () => {
    fc.assert(
      fc.property(fc.integer({ min: 1_600_000_000, max: 2_000_000_000 }), (sec) => {
        const expectedMs = sec * 1000;
        const iso = new Date(expectedMs).toISOString();
        expect(parseTradeTimestampMs({ match_time: String(sec) })).toBe(expectedMs);
        expect(parseTradeTimestampMs({ match_time: sec })).toBe(expectedMs);
        expect(parseTradeTimestampMs({ match_time: expectedMs })).toBe(expectedMs);
        expect(parseTradeTimestampMs({ match_time: expectedMs * 1000 })).toBe(expectedMs);
        expect(parseTradeTimestampMs({ match_time: iso })).toBe(expectedMs);
      }),
      { numRuns: 100 },
    );

    // Fault-injection chaos: REST 429 / 500 / timeout across monitorLimitOrder & cancelLimitOrder
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_795_000_000_000);
      const setPendingCost = vi.fn();
      const placed = await placeLimitOrder({
        side: 'UP',
        targetPrice: 0.56,
        tokenId: 'tok-chaos',
        marketSlug: 'btc-updown-15m-chaos',
        conditionId: '0xchaos',
        marketEndMs: Date.now() + 10 * 60_000,
        bankroll: 100,
        mlConfidence: 0.75,
        sessionQuality: 1.0,
      }, {
        placeLimitBuyOrder: vi.fn(async () => ({ orderId: 'ord-chaos-1' })),
        setPendingCost,
      });
      expect(placed.placed).toBe(true);

      // Advance past FILL_GRACE_MS (8s) + 3 null open-order polls while Layer-2 throws 429/500
      vi.advanceTimersByTime(10_000);
      for (const errMsg of ['HTTP 429 Too Many Requests', 'HTTP 500 Internal Server Error', 'timeout']) {
        const mon = await monitorLimitOrder({
          mlConfidence: 0.75, mlSide: 'UP', ensembleProb: 0.85, btcPrice: 100_050,
          priceToBeat: 100_000, elapsedMin: 4, marketSlug: 'btc-updown-15m-chaos',
        }, {
          getOrderById: vi.fn(async () => null),
          getOrderStatus: vi.fn(async () => { throw new Error(errMsg); }),
          cancelOrder: vi.fn(),
          setPendingCost,
        });
        expect(mon.action).toBe('HOLD');
      }

      // 4th attempt where Layer-2 recovers -> reports MATCHED cleanly
      // Test cancel race under timeout + cancel error while Layer-2 proves MATCHED
      const can = await cancelLimitOrder('unfilled_timeout', {
        cancelOrder: vi.fn(async () => { throw new Error('ETIMEDOUT'); }),
        getOrderById: vi.fn(async () => null),
        getOrderStatus: vi.fn(async () => ({ status: 'MATCHED' })),
        setPendingCost,
      });
      expect(can).toMatchObject({ cancelled: false, filledInstead: true });
    } finally {
      vi.useRealTimers();
    }
  });
});

function checkBookInvariants(ob: ReturnType<typeof clobWs.getOrderbook>, upPx: number | null, downPx: number | null) {
  for (const side of [ob.up, ob.down]) {
    if (side.bestBid !== null) {
      expect(Number.isFinite(side.bestBid)).toBe(true);
      expect(side.bestBid).toBeGreaterThan(0);
      expect(side.bestBid).toBeLessThan(1);
    } else {
      expect(side.bidLiquidity).toBe(0);
      expect(side.bidSize).toBe(0);
    }
    if (side.bestAsk !== null) {
      expect(Number.isFinite(side.bestAsk)).toBe(true);
      expect(side.bestAsk).toBeGreaterThan(0);
      expect(side.bestAsk).toBeLessThan(1);
    } else {
      expect(side.askLiquidity).toBe(0);
      expect(side.askSize).toBe(0);
    }
    if (side.spread !== null) {
      expect(Number.isFinite(side.spread)).toBe(true);
      expect(side.spread).toBeGreaterThanOrEqual(0);
    }
    expect(Number.isFinite(side.bidLiquidity)).toBe(true);
    expect(side.bidLiquidity).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(side.askLiquidity)).toBe(true);
    expect(side.askLiquidity).toBeGreaterThanOrEqual(0);
  }
  for (const px of [upPx, downPx]) {
    if (px !== null) {
      expect(Number.isFinite(px)).toBe(true);
      expect(px).toBeGreaterThan(0);
      expect(px).toBeLessThan(1);
    }
  }
}
