/**
 * Settlement P&L math, shared by the live settlement path and the fallback
 * verifier: the verifier must reproduce exactly what settlement wrote, or a
 * "correction" would introduce cent-level drift on every confirmed row.
 *
 * Fee model (CLOB V2, docs.polymarket.com/trading/fees): shares × 0.07 × p × (1−p),
 * charged to the taker at match on every fill — so a loss costs the fee too.
 */
import { describe, test, expect } from 'vitest';
import { computeSettlementPnl, takerFee } from '../settlementMath.ts';

describe('takerFee', () => {
  test('shares × 0.07 × p × (1 − p): $1.68 per 100 shares at 60c, the docs table', () => {
    expect(takerFee(100, 0.6)).toBe(1.68);
    expect(takerFee(2, 0.605)).toBe(0.03);
  });
  test('2c a share when the price is unusable; nothing for no shares', () => {
    expect(takerFee(10, null)).toBe(0.2);
    expect(takerFee(0, 0.5)).toBe(0);
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
