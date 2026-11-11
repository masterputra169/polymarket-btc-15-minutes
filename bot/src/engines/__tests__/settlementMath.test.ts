/**
 * Settlement P&L math, shared by the live settlement path and the fallback
 * verifier: the verifier must reproduce exactly what settlement wrote, or a
 * "correction" would introduce cent-level drift on every confirmed row.
 *
 * Fee model (CLOB V2, docs.polymarket.com/trading/fees): shares × 0.07 × p × (1−p),
 * charged to the taker at match on every fill — so a loss costs the fee too.
 */
import { describe, test, expect } from 'vitest';
import { computeSettlementPnl, fillCashNotional, sellFillFee, takerFee } from '../settlementMath.ts';

describe('takerFee', () => {
  test('shares × 0.07 × p × (1 − p), rounded to 0.00001', () => {
    expect(takerFee(100, 0.6)).toBe(1.68);
    // 2 × 0.07 × 0.605 × 0.395 = 0.0334565 → 0.03346
    expect(takerFee(2, 0.605)).toBe(0.03346);
  });
  test('2c a share when the price is unusable; nothing for no shares', () => {
    expect(takerFee(10, null)).toBe(0.2);
    expect(takerFee(0, 0.5)).toBe(0);
  });
});

describe('fillCashNotional', () => {
  test('gross price×size gets the taker fee once; a reported usdc is not charged again', () => {
    // 10 × 0.60 = 6; fee = 10 × 0.07 × 0.6 × 0.4 = 0.168
    expect(fillCashNotional({ side: 'BUY', size: 10, price: 0.6 })).toBe(6.168);
    expect(fillCashNotional({ side: 'SELL', size: 10, price: 0.6 })).toBe(5.832);
    expect(fillCashNotional({ side: 'BUY', size: 10, price: 0.6, usdc: 6 })).toBe(6);
    expect(fillCashNotional({ side: 'BUY', size: 10, price: 0.6, usdc: 6.168 })).toBe(6.168);
    expect(fillCashNotional({ side: 'SELL', size: 10, price: 0.6, usdc: 5.832 })).toBe(5.832);
  });
  test('makers pay nothing', () => {
    expect(fillCashNotional({ side: 'BUY', size: 10, price: 0.6, traderSide: 'MAKER' })).toBe(6);
    expect(fillCashNotional({ side: 'SELL', size: 10, price: 0.6, traderSide: 'MAKER', usdc: 6 })).toBe(6);
  });
});

describe('sellFillFee', () => {
  test('uses proceeds / shares, and the limit only when the fill is missing', () => {
    // 10 shares for 6 USDC is a 60c match: fee 0.168. The 25c limit would be 0.13125.
    expect(sellFillFee(6, 10, 0.25, 10)).toBe(0.168);
    expect(sellFillFee(4.8, 8, 0.25, 10)).toBe(0.1344);
    expect(sellFillFee(2.5, null, 0.25, 10)).toBe(0.13125);
    expect(sellFillFee(null, null, 0.25, 10)).toBe(0.13125);
    expect(sellFillFee(0, 10, 0.25, 10)).toBe(0);
  });
});

describe('computeSettlementPnl', () => {
  test('win: payout minus cost minus the entry fee', () => {
    // 2 × 0.07 × 0.605 × 0.395 = 0.0335 -> 0.03
    expect(computeSettlementPnl({ won: true, size: 2, cost: 1.21, price: 0.605 })).toBe(0.76);
  });

  test('win: 11 shares @ 0.365', () => {
    // 11 × 0.07 × 0.365 × 0.635 = 0.178 -> 0.18
    expect(computeSettlementPnl({ won: true, size: 11, cost: 4.01, price: 0.365 })).toBe(6.81);
  });

  test('loss: the cost AND the fee', () => {
    // 2 × 0.07 × 0.625 × 0.375 = 0.0328 -> 0.03
    expect(computeSettlementPnl({ won: false, size: 2, cost: 1.25, price: 0.625 })).toBe(-1.28);
  });

  test('falls back to 2c a share when the entry price is unusable', () => {
    expect(computeSettlementPnl({ won: true, size: 10, cost: 6, price: null })).toBe(3.8);
    expect(computeSettlementPnl({ won: false, size: 10, cost: 6, price: null })).toBe(-6.2);
  });
});
