/**
 * UTC day rollover for the daily-loss baseline.
 *
 * Why this exists: the rollover used to live only inside loadState(), so it ran
 * once per process start and never again. On 2026-09-20 the Railway bot had
 * been up since 2026-09-10T17:15Z with dayStartMs still pointing there —
 * 9.5 days stale. shouldHalt() reads getDailyPnLPct() against
 * startOfDayBankroll, so the "max daily loss" circuit breaker was really
 * measuring P&L since the last restart: a genuinely bad day hides behind
 * accumulated profit, and an accumulated drawdown halts the bot on a fine day.
 *
 * The fix is a rollover the poll loop can call every cycle. These tests pin the
 * behaviour that makes that safe to call ~20x/second.
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
  // Thresholds are also read by guards.ts, which resolves to this same module.
  BOT_CONFIG: {
    bankroll: 100,
    stateFile: '/tmp/test_state.json',
    maxDailyLossPct: 15,
    maxDrawdownPct: 25,
    maxConsecutiveLosses: 5,
  },
}));

import {
  _resetForTest,
  rolloverDayIfNeeded,
  getDailyPnL,
  getDailyPnLPct,
  getStats,
  getConsecutiveLosses,
} from '../positionTracker.ts';
import { shouldHalt } from '../../safety/guards.ts';

const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('rolloverDayIfNeeded', () => {
  test('does nothing inside the same UTC day', () => {
    _resetForTest({ bankroll: 49.33, startOfDayBankroll: 41.27, dayStartMs: Date.now() });
    expect(rolloverDayIfNeeded()).toBe(false);
    expect(getStats().startOfDayBankroll).toBe(41.27);
    expect(getDailyPnL()).toBe(8.06);
  });

  test('the Railway case: a 9.5-day-stale baseline rolls to the current bankroll', () => {
    _resetForTest({
      bankroll: 49.33,
      startOfDayBankroll: 41.27,
      dayStartMs: Date.now() - 9.5 * DAY,
    });
    // Before: "today" is really 9.5 days of P&L.
    expect(getDailyPnL()).toBe(8.06);

    expect(rolloverDayIfNeeded()).toBe(true);

    expect(getStats().startOfDayBankroll).toBe(49.33);
    expect(getDailyPnL()).toBe(0);
    expect(getDailyPnLPct()).toBe(0);
  });

  test('is idempotent — the second call in the same day is a no-op', () => {
    _resetForTest({ bankroll: 49.33, startOfDayBankroll: 41.27, dayStartMs: Date.now() - 2 * DAY });
    expect(rolloverDayIfNeeded()).toBe(true);
    expect(rolloverDayIfNeeded()).toBe(false);
    expect(rolloverDayIfNeeded()).toBe(false);
    expect(getStats().startOfDayBankroll).toBe(49.33);
  });

  test('an open position is added back — the baseline is account value, not free cash', () => {
    _resetForTest({
      bankroll: 45.00,
      startOfDayBankroll: 41.27,
      dayStartMs: Date.now() - DAY,
      currentPosition: { side: 'UP', cost: 1.31, settled: false, marketSlug: 'btc-updown-15m-1789877700' },
    });
    expect(rolloverDayIfNeeded()).toBe(true);
    // 45.00 free + 1.31 tied up in the open position
    expect(getStats().startOfDayBankroll).toBe(46.31);
  });

  test('a settled position is not added back', () => {
    _resetForTest({
      bankroll: 45.00,
      startOfDayBankroll: 41.27,
      dayStartMs: Date.now() - DAY,
      currentPosition: { side: 'UP', cost: 1.31, settled: true, marketSlug: 'btc-updown-15m-1789877700' },
    });
    expect(rolloverDayIfNeeded()).toBe(true);
    expect(getStats().startOfDayBankroll).toBe(45.00);
  });

  test('does NOT reset the loss streak — the streak breaker must survive midnight', () => {
    // H4 FIX in loadState(): resetting consecutiveLosses at midnight let a bot
    // bypass the 5-consecutive-loss halt by waiting for the date to change.
    _resetForTest({
      bankroll: 40,
      startOfDayBankroll: 50,
      dayStartMs: Date.now() - DAY,
      consecutiveLosses: 4,
    });
    expect(rolloverDayIfNeeded()).toBe(true);
    expect(getConsecutiveLosses()).toBe(4);
  });

  test('a rolled-over baseline clears a daily-loss halt that was not from today', () => {
    // -20% "today", but the loss happened on a previous UTC day.
    _resetForTest({ bankroll: 40, startOfDayBankroll: 50, dayStartMs: Date.now() - DAY });
    expect(getDailyPnLPct()).toBe(-20);

    rolloverDayIfNeeded();

    expect(getDailyPnLPct()).toBe(0);
  });
});

describe('rolloverDayIfNeeded during a circuit-breaker cooldown', () => {
  /** The loop's inputs to shouldHalt(), so the assertion uses the real guard. */
  const halt = () => shouldHalt({
    dailyPnLPct: getDailyPnLPct(),
    bankroll: getStats().bankroll,
    consecutiveLosses: getConsecutiveLosses(),
    drawdownPct: 0,
  });

  test('a daily-loss halt survives UTC midnight instead of self-clearing', () => {
    // -20% on the day, past the 15% max → halted. Then the UTC day advances
    // while the 4h cooldown is still running.
    _resetForTest({ bankroll: 40, peakBankroll: 40, startOfDayBankroll: 50, dayStartMs: Date.now() - DAY });
    expect(halt().halt).toBe(true);

    // The loop passes haltActive=true for as long as cbHaltStartMs > 0.
    expect(rolloverDayIfNeeded({ haltActive: true })).toBe(false);

    // Baseline untouched, so the guard still sees the loss and stays halted.
    expect(getStats().startOfDayBankroll).toBe(50);
    expect(getDailyPnLPct()).toBe(-20);
    expect(halt().halt).toBe(true);
    expect(halt().reason).toContain('Daily loss');
  });

  test('without the guard the same sequence would resume trading — pins the mechanism', () => {
    _resetForTest({ bankroll: 40, peakBankroll: 40, startOfDayBankroll: 50, dayStartMs: Date.now() - DAY });
    expect(halt().halt).toBe(true);

    // haltActive=false is the pre-fix behaviour: rebase → guard reads 0% → resumes.
    expect(rolloverDayIfNeeded({ haltActive: false })).toBe(true);
    expect(halt().halt).toBe(false);
  });

  test('once the cooldown ends the baseline rolls over normally', () => {
    _resetForTest({ bankroll: 40, peakBankroll: 40, startOfDayBankroll: 50, dayStartMs: Date.now() - DAY });
    expect(rolloverDayIfNeeded({ haltActive: true })).toBe(false);
    // resetDailyBaseline() runs at cooldown expiry and clears cbHaltStartMs;
    // the next poll passes haltActive=false.
    expect(rolloverDayIfNeeded({ haltActive: false })).toBe(true);
    expect(getStats().startOfDayBankroll).toBe(40);
  });

  test('no argument at all behaves as not-halted (default stays permissive)', () => {
    _resetForTest({ bankroll: 49.33, startOfDayBankroll: 41.27, dayStartMs: Date.now() - DAY });
    expect(rolloverDayIfNeeded()).toBe(true);
  });
});
