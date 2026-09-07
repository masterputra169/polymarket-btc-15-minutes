/**
 * Pre-market LONG must not buy a market that is already over.
 *
 * Measured in bot/data/state.json: on 2026-09-04 the pre-market entry fired at
 * 13:00:00.564Z into btc-updown-15m-1788525900 — the 12:45–13:00 market that
 * had closed half a second earlier — at 0.115 (UP was already lost) and was
 * settled as a LOSS 12 seconds later. The regular entry path has a 30-second
 * expiry floor; the pre-market path bypassed it.
 *
 * Invariant: inside the window, on a weekday, the entry is refused when the
 * current market has less than the entry floor left, or when time left is
 * unknown. With time to spare it still enters (control).
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../logger.ts', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { checkPreMarketEntry } from '../preMarketLong.ts';

const CONFIG = {
  enabled: true, riskPct: 0.05, maxEntryPrice: 0.60,
  windowStartH: 9, windowStartM: 0, windowEndH: 9, windowEndM: 15,
};

const BASE = {
  hasPosition: false, bankroll: 50, settlementPending: false,
  marketUpPrice: 0.5, config: CONFIG,
};

beforeEach(() => {
  process.env.PREMARKET_LONG_ENABLED = 'true';
  vi.useFakeTimers();
  // Tuesday 2026-09-08 09:05 EDT — inside the 09:00–09:15 window.
  vi.setSystemTime(new Date('2026-09-08T13:05:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
  delete process.env.PREMARKET_LONG_ENABLED;
});

describe('checkPreMarketEntry expiry floor', () => {
  test('control: enters inside the window when the market has time left', () => {
    const r = checkPreMarketEntry({ ...BASE, timeLeftMin: 12 });
    expect(r.shouldEnter).toBe(true);
  });

  test('refuses when the current market is about to expire', () => {
    const r = checkPreMarketEntry({ ...BASE, timeLeftMin: 0.2 });
    expect(r.shouldEnter).toBe(false);
    expect(r.reason).toMatch(/expir/i);
  });

  test('refuses when time left is unknown', () => {
    const r = checkPreMarketEntry({ ...BASE, timeLeftMin: null });
    expect(r.shouldEnter).toBe(false);
    expect(r.reason).toMatch(/expir/i);
  });
});
