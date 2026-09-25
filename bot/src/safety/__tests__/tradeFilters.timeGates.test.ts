/**
 * Time-of-day / day-of-week gates: ET blackout hours, the weekend ML floor and
 * the two Asia-session ML floors.
 *
 * Off by default since 2026-09-25 (operator decision: every session trades
 * under the same signal rules). TIME_GATES_ENABLED=true restores all four.
 * BLOCKED_SESSIONS is a separate, explicit switch and is covered by its own test.
 */
import { describe, test, expect, afterEach, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

async function loadFilters(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const mod = await import('../tradeFilters.ts');
  return mod.applyTradeFilters;
}

function baseInput(overrides = {}) {
  return {
    mlConfidence: 0.70,
    mlAvailable: true,
    marketPrice: 0.60,
    atrRatio: 1.0,
    timeLeftMin: 7,
    marketSlug: 'btc-updown-15m-1778902200',
    consecutiveLosses: 0,
    session: 'US',
    btcPrice: 79150,
    priceToBeat: 79500,
    tiltMlConfMin: null,
    bestEdge: 0.12,
    delta1m: 5,
    signalSide: 'UP',
    regime: 'moderate',
    etHour: 14,
    spread: 0.02,
    ptbSource: 'scheduled_ws',
    ...overrides,
  };
}

const timeReasons = (reasons: string[]) =>
  reasons.filter(r => /Blackout hour|Asia session|Weekend/.test(r));

const SATURDAY_NOON_UTC = Date.UTC(2026, 8, 26, 12, 0, 0);

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.useRealTimers();
  vi.resetModules();
});

describe('time gates — default off', () => {
  test('a blackout hour (23 ET) does not block', async () => {
    const apply = await loadFilters({ TIME_GATES_ENABLED: undefined });
    expect(timeReasons(apply(baseInput({ etHour: 23 })).reasons)).toEqual([]);
  });

  test('Asia trades under the same ML rule as every other session', async () => {
    const apply = await loadFilters({ TIME_GATES_ENABLED: undefined });
    expect(timeReasons(apply(baseInput({ session: 'Asia', mlConfidence: 0.70 })).reasons)).toEqual([]);
  });

  test('weekends are not gated', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(SATURDAY_NOON_UTC);
    const apply = await loadFilters({ TIME_GATES_ENABLED: undefined });
    expect(timeReasons(apply(baseInput({ mlConfidence: 0.50 })).reasons)).toEqual([]);
  });

  test('any value other than "true" keeps them off', async () => {
    const apply = await loadFilters({ TIME_GATES_ENABLED: 'yes' });
    expect(timeReasons(apply(baseInput({ etHour: 23, session: 'Asia' })).reasons)).toEqual([]);
  });
});

describe('time gates — TIME_GATES_ENABLED=true restores them', () => {
  test('blackout hour', async () => {
    const apply = await loadFilters({ TIME_GATES_ENABLED: 'true' });
    expect(timeReasons(apply(baseInput({ etHour: 23 })).reasons)).toEqual([
      'Blackout hour: 23:00 ET (historically unprofitable)',
    ]);
  });

  test('both Asia ML floors', async () => {
    const apply = await loadFilters({ TIME_GATES_ENABLED: 'TRUE' });
    const reasons = timeReasons(apply(baseInput({ session: 'Asia', mlConfidence: 0.70, bestEdge: 0.10 })).reasons);
    expect(reasons).toHaveLength(2);
    expect(reasons.every(r => r.startsWith('Asia session'))).toBe(true);
  });

  test('weekend ML floor', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(SATURDAY_NOON_UTC);
    const apply = await loadFilters({ TIME_GATES_ENABLED: 'true' });
    expect(timeReasons(apply(baseInput({ mlConfidence: 0.50 })).reasons)).toEqual(['Weekend + low ML conf 50% < 65%']);
  });
});
