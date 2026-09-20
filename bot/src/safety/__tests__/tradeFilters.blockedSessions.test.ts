/**
 * BLOCKED_SESSIONS — hard session gate.
 *
 * Why it exists: 14 days of Railway dry run (378 trades) put the Europe session
 * at 55.6% WR in week 1 and 58.3% in week 2 — below its own breakeven both
 * weeks — for -17.05 across 123 trades, while US (+30.90) and Asia (+12.43)
 * carried the book. SESSION_QUALITY only scales bet size, which is not enough
 * for a session that loses money at any size.
 *
 * This is a HARD gate on purpose: the bypasses in this module (high edge,
 * oracle-lag, ML high-confidence) all exist to relax signal thresholds. A
 * session we have decided not to trade is not a signal threshold, so nothing
 * may bypass it.
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

/** Permissive baseline: nothing else should fire, so the session reason is isolatable. */
function baseInput(overrides = {}) {
  return {
    mlConfidence: 0.90,
    mlAvailable: true,
    marketPrice: 0.60,
    atrRatio: 1.0,
    timeLeftMin: 7,
    marketSlug: 'btc-updown-15m-1778902200',
    consecutiveLosses: 0,
    session: 'Europe',
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

const sessionReasons = (reasons: string[]) => reasons.filter(r => r.includes('session blocked'));

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

describe('BLOCKED_SESSIONS hard gate', () => {
  test('unset — nothing is blocked (no behaviour change by default)', async () => {
    const applyTradeFilters = await loadFilters({ BLOCKED_SESSIONS: undefined });
    const { reasons } = applyTradeFilters(baseInput());
    expect(sessionReasons(reasons)).toHaveLength(0);
  });

  test('empty string is treated as unset, not as a session named ""', async () => {
    const applyTradeFilters = await loadFilters({ BLOCKED_SESSIONS: '' });
    const { reasons } = applyTradeFilters(baseInput({ session: '' }));
    expect(sessionReasons(reasons)).toHaveLength(0);
  });

  test('Europe blocked: the named session is rejected with a readable reason', async () => {
    const applyTradeFilters = await loadFilters({ BLOCKED_SESSIONS: 'Europe' });
    const { pass, reasons } = applyTradeFilters(baseInput({ session: 'Europe' }));
    expect(pass).toBe(false);
    const hits = sessionReasons(reasons);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain('Europe');
  });

  test('Europe blocked: other sessions still pass', async () => {
    const applyTradeFilters = await loadFilters({ BLOCKED_SESSIONS: 'Europe' });
    for (const session of ['US', 'Asia', 'EU/US Overlap']) {
      const { reasons } = applyTradeFilters(baseInput({ session }));
      expect(sessionReasons(reasons), `session ${session}`).toHaveLength(0);
    }
  });

  test('comma-separated list, tolerant of spacing and case', async () => {
    const applyTradeFilters = await loadFilters({ BLOCKED_SESSIONS: ' europe , EU/US OVERLAP ' });
    expect(sessionReasons(applyTradeFilters(baseInput({ session: 'Europe' })).reasons)).toHaveLength(1);
    expect(sessionReasons(applyTradeFilters(baseInput({ session: 'EU/US Overlap' })).reasons)).toHaveLength(1);
    expect(sessionReasons(applyTradeFilters(baseInput({ session: 'US' })).reasons)).toHaveLength(0);
  });

  test('a high edge does NOT bypass the session gate', async () => {
    const applyTradeFilters = await loadFilters({ BLOCKED_SESSIONS: 'Europe' });
    const { pass, reasons } = applyTradeFilters(baseInput({ session: 'Europe', bestEdge: 0.40 }));
    expect(pass).toBe(false);
    expect(sessionReasons(reasons)).toHaveLength(1);
  });

  test('ML at 99% does NOT bypass the session gate', async () => {
    const applyTradeFilters = await loadFilters({ BLOCKED_SESSIONS: 'Europe' });
    const { pass, reasons } = applyTradeFilters(baseInput({ session: 'Europe', mlConfidence: 0.99 }));
    expect(pass).toBe(false);
    expect(sessionReasons(reasons)).toHaveLength(1);
  });

  test('the oracle-lag sniper bypass does NOT bypass the session gate', async () => {
    const applyTradeFilters = await loadFilters({
      BLOCKED_SESSIONS: 'Europe',
      LATE_SNIPER_ENABLED: 'true',
    });
    const { pass, reasons } = applyTradeFilters(baseInput({
      session: 'Europe',
      ptbSource: 'data_streams',
      marketPrice: 0.60,
      timeLeftMin: 6,
      delta1m: 80,
      mlConfidence: 0.80,
    }));
    expect(pass).toBe(false);
    expect(sessionReasons(reasons)).toHaveLength(1);
  });

  test('a null/unknown session is never blocked by accident', async () => {
    const applyTradeFilters = await loadFilters({ BLOCKED_SESSIONS: 'Europe' });
    expect(sessionReasons(applyTradeFilters(baseInput({ session: null })).reasons)).toHaveLength(0);
    expect(sessionReasons(applyTradeFilters(baseInput({ session: undefined })).reasons)).toHaveLength(0);
  });
});
