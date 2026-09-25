/**
 * depthNearTop — liquidity near the top of a Polymarket CLOB book.
 *
 * Regression: both clobWs.ts and summarizeOrderBook summed the FIRST five levels,
 * but the CLOB lists both sides worst-first (seen in raw market-channel frames
 * captured on Railway, 2026-09-24): bids 0.01 → best, asks 0.99 → best. The
 * "top-5 liquidity" the dry-run FOK check and orderbookFlow read was the depth
 * at 1-5c and 95-99c.
 */
import { describe, test, expect } from 'vitest';
import { depthNearTop } from '../utils.ts';
import { summarizeOrderBook } from '../data/polymarket.ts';

// As the CLOB sends them: worst first on both sides.
const BIDS = [
  { price: '0.01', size: '1551' }, { price: '0.02', size: '3733' }, { price: '0.03', size: '900' },
  { price: '0.04', size: '800' }, { price: '0.05', size: '700' },
  { price: '0.54', size: '40' }, { price: '0.55', size: '30' }, { price: '0.56', size: '20' },
  { price: '0.57', size: '15' }, { price: '0.58', size: '10' },
];
const ASKS = [
  { price: '0.99', size: '1405' }, { price: '0.98', size: '1374' }, { price: '0.97', size: '600' },
  { price: '0.96', size: '500' }, { price: '0.95', size: '400' },
  { price: '0.63', size: '9' }, { price: '0.62', size: '8' }, { price: '0.61', size: '7' },
  { price: '0.60', size: '6' }, { price: '0.59', size: '5' },
];

describe('depthNearTop', () => {
  test('sums the best levels, not the first ones', () => {
    expect(depthNearTop(BIDS, 'bid')).toBe(40 + 30 + 20 + 15 + 10);
    expect(depthNearTop(ASKS, 'ask')).toBe(9 + 8 + 7 + 6 + 5);
  });

  test('order of arrival does not matter', () => {
    expect(depthNearTop([...BIDS].reverse(), 'bid')).toBe(115);
    expect(depthNearTop([...ASKS].reverse(), 'ask')).toBe(35);
  });

  test('depth, malformed levels and non-arrays', () => {
    expect(depthNearTop(ASKS, 'ask', 1)).toBe(5);
    expect(depthNearTop([{ price: 'x', size: 5 }, { price: 0.5, size: -1 }, { price: 0.5, size: 2 }], 'ask')).toBe(2);
    expect(depthNearTop(null, 'bid')).toBe(0);
    expect(depthNearTop(BIDS, 'bid', 0)).toBe(0);
  });

  test('summarizeOrderBook (REST path) reports the same near-top depth', () => {
    const s = summarizeOrderBook({ bids: BIDS, asks: ASKS });
    expect(s).toMatchObject({ bestBid: 0.58, bestAsk: 0.59, bidLiquidity: 115, askLiquidity: 35 });
    expect(s.spread).toBeCloseTo(0.01, 12);
  });
});
