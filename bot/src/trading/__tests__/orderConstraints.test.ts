/**
 * orderConstraints.ts — tick rounding and minimum order size for the live
 * CLOB V2 order path.
 *
 * Invariants: prices land on the tick grid, inward (BUY down, SELL up), so a
 * rounded order fills against exactly the book levels the raw one would; an
 * order under the market minimum is refused with a reason and never upsized;
 * constraints come from the book, then Gamma, then 5 shares / 0.01.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import {
  DEFAULT_ORDER_CONSTRAINTS,
  GTD_MIN_LEAD_SEC,
  checkGtdExpiration,
  clearOrderConstraints,
  floorShares,
  getOrderConstraints,
  marketBuyAmount,
  parseOrderConstraints,
  prepareOrder,
  recordOrderConstraints,
  roundPriceToTick,
  tickSizeString,
  worstCaseLimitLeadSec,
} from '../orderConstraints.ts';

const BTC15 = parseOrderConstraints({ tick_size: '0.01', min_order_size: '5' });

describe('roundPriceToTick', () => {
  test('BUY rounds down, SELL rounds up, on the 0.01 grid', () => {
    expect(roundPriceToTick(0.547, 0.01, 'BUY')).toBe(0.54);
    expect(roundPriceToTick(0.547, 0.01, 'SELL')).toBe(0.55);
    expect(roundPriceToTick(0.301, 0.01, 'SELL')).toBe(0.31);
    expect(roundPriceToTick(0.309, 0.01, 'BUY')).toBe(0.30);
  });

  test('a price already on the grid is unchanged despite float noise', () => {
    // 0.57 / 0.01 = 56.99999999999999 and 0.29 / 0.01 = 28.999999999999996 in IEEE doubles.
    for (const p of [0.07, 0.29, 0.57, 0.58, 0.99, 0.01]) {
      expect(roundPriceToTick(p, 0.01, 'BUY')).toBe(p);
      expect(roundPriceToTick(p, 0.01, 'SELL')).toBe(p);
    }
  });

  test('finer ticks keep their precision', () => {
    expect(roundPriceToTick(0.9876, 0.001, 'BUY')).toBe(0.987);
    expect(roundPriceToTick(0.9871, 0.001, 'SELL')).toBe(0.988);
    expect(roundPriceToTick(0.12345, 0.0001, 'BUY')).toBe(0.1234);
  });

  test('inward rounding loses no fill against on-grid asks / bids', () => {
    const asks = [0.53, 0.54, 0.55];
    for (const raw of [0.535, 0.5401, 0.549]) {
      const rounded = roundPriceToTick(raw, 0.01, 'BUY');
      expect(asks.filter(a => a <= raw)).toEqual(asks.filter(a => a <= rounded));
      expect(rounded).toBeLessThanOrEqual(raw);
    }
    const bids = [0.29, 0.30, 0.31];
    for (const raw of [0.295, 0.2999, 0.305]) {
      const rounded = roundPriceToTick(raw, 0.01, 'SELL');
      expect(bids.filter(b => b >= raw)).toEqual(bids.filter(b => b >= rounded));
      expect(rounded).toBeGreaterThanOrEqual(raw);
    }
  });
});

describe('size helpers', () => {
  test('floorShares keeps 2 decimals, rounding down', () => {
    expect(floorShares(7.883)).toBe(7.88);
    expect(floorShares(5)).toBe(5);
    expect(floorShares(4.999)).toBe(4.99);
  });

  test('marketBuyAmount is shares × price rounded down to cents, exact on float noise', () => {
    expect(marketBuyAmount(5, 0.57)).toBe(2.85); // 5 × 0.57 = 2.8499999999999996
    expect(marketBuyAmount(5, 0.53)).toBe(2.65); // 2.6500000000000004
    expect(marketBuyAmount(5.5, 0.53)).toBe(2.91);
  });
});

describe('parseOrderConstraints', () => {
  test('reads the CLOB /book fields', () => {
    expect(BTC15).toMatchObject({ tickSize: 0.01, minOrderSize: 5, tickSource: 'book', minSizeSource: 'book' });
  });

  test('falls back per field: book, then Gamma, then defaults', () => {
    const c = parseOrderConstraints({ tick_size: '0.001' }, { orderMinSize: 15, orderPriceMinTickSize: 0.01 });
    expect(c).toMatchObject({ tickSize: 0.001, tickSource: 'book', minOrderSize: 15, minSizeSource: 'gamma' });
    expect(parseOrderConstraints(null, null)).toMatchObject({
      tickSize: 0.01, minOrderSize: 5, tickSource: 'default', minSizeSource: 'default',
    });
  });

  test('ignores garbage and ticks the SDK cannot sign with', () => {
    const c = parseOrderConstraints({ tick_size: '0.03', min_order_size: '-1' }, { orderMinSize: 'abc' });
    expect(c).toMatchObject({ tickSize: 0.01, minOrderSize: 5, tickSource: 'default', minSizeSource: 'default' });
    expect(parseOrderConstraints('not a book', 42)).toMatchObject({ tickSize: 0.01, minOrderSize: 5 });
  });

  test('tickSizeString maps to the SDK union or null', () => {
    expect(tickSizeString(0.01)).toBe('0.01');
    expect(tickSizeString(0.0025)).toBe('0.0025');
    expect(tickSizeString(0.02)).toBeNull();
  });
});

describe('prepareOrder', () => {
  test('market BUY: tick-rounded price, dollar amount for the SDK', () => {
    const r = prepareOrder({ side: 'BUY', kind: 'market', price: 0.547, size: 5, constraints: BTC15 });
    expect(r).toEqual({ ok: true, price: 0.54, size: 5, buyAmountUsd: 2.7, tickSize: '0.01' });
  });

  test('market SELL: price rounded up, shares floored to 2 decimals', () => {
    const r = prepareOrder({ side: 'SELL', kind: 'market', price: 0.301, size: 7.883, constraints: BTC15 });
    expect(r).toEqual({ ok: true, price: 0.31, size: 7.88, buyAmountUsd: null, tickSize: '0.01' });
  });

  test('limit BUY keeps the share size', () => {
    const r = prepareOrder({ side: 'BUY', kind: 'limit', price: 0.55, size: 6, constraints: BTC15 });
    expect(r).toEqual({ ok: true, price: 0.55, size: 6, buyAmountUsd: null, tickSize: '0.01' });
  });

  test('refuses an order under the market minimum — never upsizes', () => {
    for (const kind of ['market', 'limit'] as const) {
      const r = prepareOrder({ side: 'BUY', kind, price: 0.6, size: 2, constraints: BTC15 });
      expect(r.ok).toBe(false);
      if (r.ok === false) expect(r.reason).toMatch(/below the market minimum of 5 \(book\).*not upsizing/);
    }
    const sell = prepareOrder({ side: 'SELL', kind: 'market', price: 0.3, size: 4.999, constraints: BTC15 });
    expect(sell.ok).toBe(false);
  });

  test('exactly the minimum passes, including a market BUY whose float product is below it', () => {
    expect(prepareOrder({ side: 'BUY', kind: 'market', price: 0.57, size: 5, constraints: BTC15 }).ok).toBe(true);
    expect(prepareOrder({ side: 'SELL', kind: 'market', price: 0.57, size: 5, constraints: BTC15 }).ok).toBe(true);
  });

  test('uses the recorded minimum, not the default', () => {
    const tenMin = parseOrderConstraints({ tick_size: '0.01', min_order_size: '10' });
    const r = prepareOrder({ side: 'BUY', kind: 'market', price: 0.5, size: 6, constraints: tenMin });
    expect(r.ok).toBe(false);
  });

  test('refuses prices that round off the grid or are not probabilities', () => {
    expect(prepareOrder({ side: 'BUY', kind: 'market', price: 0.005, size: 5, constraints: BTC15 }).ok).toBe(false);
    expect(prepareOrder({ side: 'SELL', kind: 'market', price: 0.995, size: 5, constraints: BTC15 }).ok).toBe(false);
    expect(prepareOrder({ side: 'BUY', kind: 'market', price: 1.2, size: 5, constraints: BTC15 }).ok).toBe(false);
    expect(prepareOrder({ side: 'BUY', kind: 'market', price: NaN, size: 5, constraints: BTC15 }).ok).toBe(false);
    expect(prepareOrder({ side: 'BUY', kind: 'market', price: 0.5, size: 0, constraints: BTC15 }).ok).toBe(false);
  });

  test('0.99 cap from fokBuyPrice stays placeable on a 0.01 tick', () => {
    const r = prepareOrder({ side: 'BUY', kind: 'market', price: 0.99, size: 5, constraints: BTC15 });
    expect(r).toMatchObject({ ok: true, price: 0.99 });
  });
});

describe('checkGtdExpiration', () => {
  test('requires at least 3 minutes of lead time', () => {
    const now = 1_790_000_000;
    expect(checkGtdExpiration(now + GTD_MIN_LEAD_SEC, now)).toBeNull();
    expect(checkGtdExpiration(now + 600, now)).toBeNull();
    expect(checkGtdExpiration(now + 120, now)).toMatch(/120s ahead.*at least 180s/);
    expect(checkGtdExpiration(NaN, now)).toMatch(/not a unix timestamp/);
  });
});

describe('worstCaseLimitLeadSec', () => {
  test('default limit config clears the 3-minute GTD lead; an in-bounds override does not', () => {
    expect(worstCaseLimitLeadSec(9, 120)).toBe(240);
    expect(worstCaseLimitLeadSec(9, 120)).toBeGreaterThanOrEqual(GTD_MIN_LEAD_SEC);
    expect(worstCaseLimitLeadSec(12, 200)).toBe(-20);
    expect(worstCaseLimitLeadSec(12, 200)).toBeLessThan(GTD_MIN_LEAD_SEC);
  });
});

describe('registry', () => {
  beforeEach(() => clearOrderConstraints());

  test('unknown tokens get the defaults (5 shares, 0.01)', () => {
    expect(getOrderConstraints('nope')).toBe(DEFAULT_ORDER_CONSTRAINTS);
    expect(DEFAULT_ORDER_CONSTRAINTS).toMatchObject({ tickSize: 0.01, minOrderSize: 5 });
  });

  test('records per token, ignores bad input, stays bounded', () => {
    recordOrderConstraints('tok-a', parseOrderConstraints({ min_order_size: '10' }));
    recordOrderConstraints(undefined, BTC15);
    recordOrderConstraints('tok-b', null);
    expect(getOrderConstraints('tok-a').minOrderSize).toBe(10);
    expect(getOrderConstraints('tok-b')).toBe(DEFAULT_ORDER_CONSTRAINTS);

    for (let i = 0; i < 40; i++) recordOrderConstraints(`t${i}`, BTC15);
    expect(getOrderConstraints('tok-a')).toBe(DEFAULT_ORDER_CONSTRAINTS); // evicted
    expect(getOrderConstraints('t39')).toBe(BTC15);
  });
});
