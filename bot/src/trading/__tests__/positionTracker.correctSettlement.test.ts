/**
 * correctSettlement — apply a verified market resolution to a settlement that
 * was booked from price_fallback. Unlike adjustBankrollForReconciliation it
 * also moves the win/loss counters, because the counters were incremented from
 * the same wrong outcome the bankroll was.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.mock('fs', () => ({
  readFileSync: vi.fn(() => '{}'),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  appendFileSync: vi.fn(),
  renameSync: vi.fn(),
  statSync: vi.fn(() => ({ size: 0 })),
}));
vi.mock('../../logger.ts', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../config.ts', () => ({
  BOT_CONFIG: { bankroll: 100, stateFile: '/tmp/test_state.json' },
}));

import { appendFileSync } from 'fs';
import { _resetForTest, correctSettlement, getBankroll, getStats } from '../positionTracker.ts';

beforeEach(() => {
  vi.clearAllMocks();
  _resetForTest({ bankroll: 59.44, wins: 17, losses: 5, consecutiveLosses: 1 });
});

describe('correctSettlement', () => {
  test('win that resolved as a loss: bankroll down by delta, counters and loss streak move', () => {
    const ok = correctSettlement({ delta: -10.88, wasWin: true, nowWin: false, slug: 'btc-updown-15m-1788786000', reason: 'gamma_oracle' });
    expect(ok).toBe(true);
    expect(getBankroll()).toBe(48.56);
    expect(getStats().wins).toBe(16);
    expect(getStats().losses).toBe(6);
    expect(getStats().consecutiveLosses).toBe(2);
    const audit = vi.mocked(appendFileSync).mock.calls.map(c => JSON.parse(String(c[1])));
    expect(audit.some(a => a.type === 'SETTLEMENT_CORRECTED' && a.delta === -10.88)).toBe(true);
  });

  test('loss that resolved as a win: bankroll up, counters move the other way, streak shrinks', () => {
    correctSettlement({ delta: 2.03, wasWin: false, nowWin: true, slug: 's', reason: 'oracle' });
    expect(getBankroll()).toBe(61.47);
    expect(getStats().wins).toBe(18);
    expect(getStats().losses).toBe(4);
    expect(getStats().consecutiveLosses).toBe(0);
  });

  test('live row (adjustBankroll=false): counters move, bankroll is left to the on-chain reconciler', () => {
    const ok = correctSettlement({ delta: -10.88, wasWin: true, nowWin: false, slug: 's', reason: 'oracle', adjustBankroll: false });
    expect(ok).toBe(true);
    expect(getBankroll()).toBe(59.44);
    expect(getStats().wins).toBe(16);
    expect(getStats().losses).toBe(6);
    expect(getStats().consecutiveLosses).toBe(2);
  });

  test('a correction of a trade settled before today keeps daily P&L attributable to today', () => {
    // Measured 2026-09-08 02:03Z on Railway: the restart opened a new UTC day
    // with baseline $59.44, then the sweep corrected yesterday's PREMARKET row
    // by -10.88 → "Daily loss -18.3%" → circuit breaker, 240 min halt, on a
    // trade that had nothing to do with today.
    _resetForTest({ bankroll: 59.44, startOfDayBankroll: 59.44, wins: 17, losses: 5 }); // dayStartMs = now
    correctSettlement({
      delta: -10.88, wasWin: true, nowWin: false, slug: 's', reason: 'gamma_oracle',
      settledAtMs: Date.now() - 6 * 60 * 60 * 1000,
    });
    expect(getBankroll()).toBe(48.56);
    expect(getStats().dailyPnL).toBe(0);
  });

  test("a correction of a trade settled today does count toward today's P&L", () => {
    _resetForTest({ bankroll: 59.44, startOfDayBankroll: 59.44, wins: 17, losses: 5 });
    correctSettlement({
      delta: -10.88, wasWin: true, nowWin: false, slug: 's', reason: 'gamma_oracle',
      settledAtMs: Date.now(),
    });
    expect(getStats().dailyPnL).toBe(-10.88);
  });

  test('rejects a non-finite delta without touching state', () => {
    expect(correctSettlement({ delta: NaN, wasWin: true, nowWin: false, slug: 's', reason: 'x' })).toBe(false);
    expect(getBankroll()).toBe(59.44);
    expect(getStats().wins).toBe(17);
  });

  test('rejects a correction larger than half the bankroll as a data error', () => {
    expect(correctSettlement({ delta: -40, wasWin: true, nowWin: false, slug: 's', reason: 'x' })).toBe(false);
    expect(getBankroll()).toBe(59.44);
  });
});
