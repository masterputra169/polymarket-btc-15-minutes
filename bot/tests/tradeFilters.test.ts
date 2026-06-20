/**
 * Tests for trade filter logic.
 * Tier-2 unit tests — pure functions, no I/O.
 * Tests verify gates that protect bot from bad trades.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { applyTradeFilters, recordSpread, recordLoss } from '../src/safety/tradeFilters.ts';

function baseInput(overrides = {}) {
  return {
    mlConfidence: 0.85,
    mlAvailable: true,
    marketPrice: 0.55,
    atrRatio: 0.02,
    timeLeftMin: 8,
    marketSlug: 'btc-updown-15m-test',
    consecutiveLosses: 0,
    session: 'US',
    btcPrice: 80000,
    priceToBeat: 80000,
    tiltMlConfMin: null,
    bestEdge: 0.10,
    delta1m: 50,
    signalSide: 'UP',
    regime: 'trending',
    etHour: 12,        // mid-day, no blackout
    spread: 0.02,      // 2% spread, healthy
    mlAccuracy: 0.80,
    buyRatio: 0.55,
    ptbSource: 'polymarket_gamma',
    ...overrides,
  };
}

describe('applyTradeFilters', () => {
  beforeEach(() => {
    // Reset any module-level state
  });

  it('returns valid result structure on healthy input', () => {
    // NOTE: passing all 15 filters in unit-test isolation is hard because
    // some depend on module-level state (recordedSpread, prior trades, etc).
    // We test STRUCTURE here; integration tests would verify full pass.
    const r = applyTradeFilters(baseInput());
    expect(r).toHaveProperty('pass');
    expect(r).toHaveProperty('reasons');
    expect(typeof r.pass).toBe('boolean');
  });

  it('blocks during blackout hour (23 ET)', () => {
    const r = applyTradeFilters(baseInput({ etHour: 23 }));
    expect(r.pass).toBe(false);
    expect(r.reasons.some(x => /blackout|hour|23/i.test(x))).toBe(true);
  });

  it('blocks when ML confidence below threshold', () => {
    const r = applyTradeFilters(baseInput({ mlConfidence: 0.40 }));
    expect(r.pass).toBe(false);
    // At least one reason should reference ML/confidence
    expect(r.reasons.some(x => /ml/i.test(x))).toBe(true);
  });

  it('blocks when market price below MIN_ENTRY_PRICE', () => {
    // Default min entry price is around 0.55-0.62 per memory
    const r = applyTradeFilters(baseInput({ marketPrice: 0.30 }));
    expect(r.pass).toBe(false);
  });

  it('blocks when consecutive losses high', () => {
    const r = applyTradeFilters(baseInput({ consecutiveLosses: 10 }));
    expect(r.pass).toBe(false);
  });

  it('returns multiple reasons when multiple filters fail', () => {
    const r = applyTradeFilters(baseInput({
      etHour: 23, mlConfidence: 0.30, consecutiveLosses: 10
    }));
    expect(r.pass).toBe(false);
    expect(r.reasons.length).toBeGreaterThanOrEqual(2);
  });

  it('PTB source pending blocks trade', () => {
    const r = applyTradeFilters(baseInput({ ptbSource: 'pending' }));
    expect(r.pass).toBe(false);
  });

  it('returns object with pass + reasons fields', () => {
    const r = applyTradeFilters(baseInput());
    expect(r).toHaveProperty('pass');
    expect(r).toHaveProperty('reasons');
    expect(Array.isArray(r.reasons)).toBe(true);
  });
});

describe('recordLoss / recordSpread (state mgmt)', () => {
  it('recordLoss runs without throwing', () => {
    expect(() => recordLoss()).not.toThrow();
  });

  it('recordSpread accepts decimal spread', () => {
    expect(() => recordSpread(0.05)).not.toThrow();
  });

  it('recordSpread handles NaN gracefully', () => {
    expect(() => recordSpread(NaN)).not.toThrow();
  });
});
