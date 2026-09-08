/**
 * Settlement P&L math, shared by the live settlement path and the fallback
 * verifier. The numbers are real rows from the Railway dry run (2026-09-07):
 * the verifier must reproduce exactly what settlement wrote, or a "correction"
 * would introduce cent-level drift on every confirmed row.
 */
import { describe, test, expect } from 'vitest';
import { computeSettlementPnl } from '../settlementMath.ts';

describe('computeSettlementPnl', () => {
  test('win: payout minus cost minus dynamic fee on profit (journal row 11:30Z)', () => {
    expect(computeSettlementPnl({ won: true, size: 2, cost: 1.21, price: 0.605 })).toBe(0.78);
  });

  test('win: PREMARKET row 13:15Z (11 shares @ 0.365)', () => {
    expect(computeSettlementPnl({ won: true, size: 11, cost: 4.01, price: 0.365 })).toBe(6.87);
  });

  test('loss: full cost, rounded to cents', () => {
    expect(computeSettlementPnl({ won: false, size: 2, cost: 1.25, price: 0.625 })).toBe(-1.25);
  });

  test('falls back to a 2% fee when the entry price is unusable', () => {
    // gross 4, 2% fee = 0.08
    expect(computeSettlementPnl({ won: true, size: 10, cost: 6, price: null })).toBe(3.92);
  });
});
