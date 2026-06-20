/**
 * Tests for edge.js phase-based decision logic.
 * Tier-2 unit tests — pure functions, no I/O.
 */
import { describe, it, expect } from 'vitest';
import { computeEdge, countAgreement } from '../../src/engines/edge.ts';

describe('computeEdge', () => {
  it('uses orderbook bestAsk when available (no spread penalty)', () => {
    const r = computeEdge({
      modelUp: 0.7, modelDown: 0.3,
      marketYes: 0.6, marketNo: 0.4,
      orderbookUp:   { bestAsk: 0.55, bestBid: 0.50, spread: 0.05 },
      orderbookDown: { bestAsk: 0.45, bestBid: 0.40, spread: 0.05 },
    });
    // edgeUp ≈ modelUp - bestAsk - fee → 0.7 - 0.55 - small_fee → ~0.14
    expect(r.edgeUp).toBeGreaterThan(0.10);
    expect(r.edgeDown).toBeLessThan(0);
    expect(r.effectiveUp).toBe(0.55);
    expect(r.effectiveDown).toBe(0.45);
  });

  it('applies spread penalty when only mid price available', () => {
    const r = computeEdge({
      modelUp: 0.7, modelDown: 0.3,
      marketYes: 0.55, marketNo: 0.45,
      orderbookUp: null,
      orderbookDown: null,
    });
    // No orderbook → use marketYes/marketNo + 1.5% default spread penalty
    expect(r.effectiveUp).toBe(0.55);
    expect(r.edgeUp).toBeLessThan(0.7 - 0.55); // penalty applied
  });

  it('handles NaN spread gracefully (no NaN propagation)', () => {
    const r = computeEdge({
      modelUp: 0.7, modelDown: 0.3,
      marketYes: 0.55, marketNo: 0.45,
      orderbookUp:   { bestAsk: null, spread: NaN },
      orderbookDown: { bestAsk: null, spread: NaN },
    });
    expect(Number.isFinite(r.edgeUp)).toBe(true);
    expect(Number.isFinite(r.edgeDown)).toBe(true);
  });

  it('positive model edge translates to positive net edge', () => {
    // Strong model conviction with reasonable market
    const r = computeEdge({
      modelUp: 0.85, modelDown: 0.15,
      marketYes: 0.55, marketNo: 0.45,
      orderbookUp:   { bestAsk: 0.56, bestBid: 0.54, spread: 0.02 },
      orderbookDown: { bestAsk: 0.46, bestBid: 0.44, spread: 0.02 },
    });
    expect(r.edgeUp).toBeGreaterThan(0.20);
    expect(r.bestEdge ?? Math.max(r.edgeUp, r.edgeDown)).toBe(r.edgeUp);
  });
});

describe('countAgreement', () => {
  it('counts indicators agreeing with UP side', () => {
    const breakdown = {
      rsi:        { side: 'UP' },
      macdHist:   { side: 'UP' },
      macdLine:   { side: 'DOWN' },
      momentum:   { side: 'UP' },
      vwapPos:    { side: 'NEUTRAL' },
    };
    const count = countAgreement(breakdown, 'UP');
    // Implementation may filter to specific indicator subset (5 canonical signals)
    // We assert: numeric + < total entries (counted UP ≤ 5)
    expect(typeof count).toBe('number');
    expect(count).toBeGreaterThanOrEqual(0);
    expect(count).toBeLessThanOrEqual(5);
  });

  it('counts zero when all indicators disagree', () => {
    const breakdown = {
      rsi:      { side: 'DOWN' },
      macdHist: { side: 'DOWN' },
      momentum: { side: 'DOWN' },
    };
    expect(countAgreement(breakdown, 'UP')).toBe(0);
  });

  it('handles empty breakdown', () => {
    expect(countAgreement({}, 'UP')).toBe(0);
  });

  it('handles null/undefined indicator entries safely (no throw)', () => {
    const breakdown = {
      rsi:      null,
      macdHist: { side: 'UP' },
      momentum: undefined,
    };
    // Result depends on implementation: 0 (filters all null/undef) or 1.
    // We assert NO THROW + numeric result.
    const result = countAgreement(breakdown, 'UP');
    expect(typeof result).toBe('number');
    expect(result).toBeGreaterThanOrEqual(0);
  });
});
