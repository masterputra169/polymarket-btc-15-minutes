import { describe, test, expect } from 'vitest';
import { BookState } from '../bookState.ts';

// Polymarket sends bids ascending (best LAST) and asks ascending (best first).
const BIDS = [{ price: '0.48', size: '30' }, { price: '0.49', size: '20' }, { price: '0.50', size: '15' }];
const ASKS = [{ price: '0.52', size: '25' }, { price: '0.53', size: '60' }, { price: '0.54', size: '10' }];

describe('BookState', () => {
  test('a snapshot sorts best-first regardless of the order it arrived in', () => {
    const b = new BookState();
    b.applySnapshot(BIDS, ASKS, 1000);
    expect(b.valid).toBe(true);
    expect(b.bestBid()).toBe(0.5);
    expect(b.bestAsk()).toBe(0.52);
    expect(b.top(2)).toEqual({ b: [[0.5, 15], [0.49, 20]], a: [[0.52, 25], [0.53, 60]] });
  });

  test('price_change sets the absolute size, 0 removes the level, and repeating it is harmless', () => {
    const b = new BookState();
    b.applySnapshot(BIDS, ASKS, 1000);
    expect(b.applyChange('BUY', '0.51', '40', 2000)).toBe(true);
    expect(b.applyChange('BUY', '0.51', '40', 2001)).toBe(true); // duplicate frame
    expect(b.bestBid()).toBe(0.51);
    expect(b.top(1).b).toEqual([[0.51, 40]]);
    b.applyChange('SELL', '0.52', '0', 2002);
    expect(b.bestAsk()).toBe(0.53);
    expect(b.updatedMs).toBe(2002);
  });

  test('float noise in prices lands on the same level', () => {
    const b = new BookState();
    b.applySnapshot([{ price: 0.1 + 0.2, size: 5 }], [], 1);
    b.applyChange('BUY', '0.3', '7', 2);
    expect(b.top(5).b).toEqual([[0.3, 7]]);
  });

  test('malformed levels and changes are skipped, not fatal', () => {
    const b = new BookState();
    b.applySnapshot([{ price: 'x', size: '1' }, { price: '0.4', size: '-3' }, null, { price: '0.41', size: '2' }], 'nope', 1);
    expect(b.top(5)).toEqual({ b: [[0.41, 2]], a: [] });
    expect(b.applyChange('HOLD', '0.4', '1', 2)).toBe(false);
    expect(b.applyChange('BUY', '', '1', 2)).toBe(false);
    expect(b.applyChange('SELL', '0.6', 'NaN', 2)).toBe(false);
    expect(b.updatedMs).toBe(1);
  });

  test('clear() makes the book invalid until the next frame', () => {
    const b = new BookState();
    expect(b.valid).toBe(false);
    b.applySnapshot(BIDS, ASKS, 5);
    b.clear();
    expect(b.valid).toBe(false);
    expect(b.bestBid()).toBeNull();
    expect(b.bestAsk()).toBeNull();
  });
});
