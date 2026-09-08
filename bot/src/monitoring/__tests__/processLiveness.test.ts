/**
 * In-process liveness: the bot judges itself, so any supervisor that restarts
 * a non-zero exit (Railway ON_FAILURE, Docker unless-stopped, PM2) cures a
 * bot that is alive but blind. This replaces the host-side watchdog on
 * platforms that have no host.
 *
 * The verdict is pure: it depends only on when the last poll completed, how
 * long the process has been up, and the two thresholds.
 */

import { describe, test, expect } from 'vitest';
import { createProcessLiveness } from '../processLiveness.ts';

const MIN = 60_000;
const T0 = 1_788_800_000_000;

function clock(start = T0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('createProcessLiveness', () => {
  test('grace period before the first poll is not stale', () => {
    const c = clock();
    const live = createProcessLiveness({ staleMs: 10 * MIN, graceMs: 5 * MIN, now: c.now });
    c.advance(4 * MIN);
    expect(live.verdict()).toEqual({ status: 'grace', ageMs: null });
  });

  test('a recent completed poll is fresh', () => {
    const c = clock();
    const live = createProcessLiveness({ staleMs: 10 * MIN, graceMs: 5 * MIN, now: c.now });
    c.advance(6 * MIN);
    live.beat();
    c.advance(2 * MIN);
    expect(live.verdict()).toEqual({ status: 'fresh', ageMs: 2 * MIN });
  });

  test('no completed poll within the stale window is stale', () => {
    const c = clock();
    const live = createProcessLiveness({ staleMs: 10 * MIN, graceMs: 5 * MIN, now: c.now });
    live.beat();
    c.advance(11 * MIN);
    expect(live.verdict()).toEqual({ status: 'stale', ageMs: 11 * MIN });
  });

  test('never completing a poll is stale once the grace period is over', () => {
    const c = clock();
    const live = createProcessLiveness({ staleMs: 10 * MIN, graceMs: 5 * MIN, now: c.now });
    c.advance(6 * MIN);
    expect(live.verdict()).toEqual({ status: 'stale', ageMs: null });
  });
});

/**
 * The exit path must tell the operator. On 2026-09-08 the bot crash-looped on
 * Railway from 02:13Z, the supervisor gave up after 10 restarts at 03:09Z and
 * the service stayed down for 3+ hours — with nothing in Telegram, because the
 * liveness watch only logged before process.exit(1).
 */
import { vi } from 'vitest';
import { handleStale } from '../processLiveness.ts';

function staleDeps(overrides: Partial<Parameters<typeof handleStale>[1]> = {}) {
  return {
    exitEnabled: true,
    staleMin: 10,
    notify: vi.fn(async () => {}),
    flush: vi.fn(),
    exit: vi.fn(),
    notifyTimeoutMs: 5000,
    ...overrides,
  };
}

describe('handleStale (liveness exit path)', () => {
  test('sends a critical Telegram alert, then exits 1', async () => {
    const deps = staleDeps();
    await handleStale({ status: 'stale', ageMs: 11 * MIN }, deps);
    expect(deps.notify).toHaveBeenCalledWith('critical', expect.stringMatching(/blind.*11\.0 min/s), expect.objectContaining({ key: expect.any(String) }));
    expect(deps.exit).toHaveBeenCalledWith(1);
    expect(vi.mocked(deps.notify).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(deps.exit).mock.invocationCallOrder[0]);
    expect(deps.flush).toHaveBeenCalledTimes(1);
  });

  test('still exits when the alert hangs (bounded wait)', async () => {
    vi.useFakeTimers();
    try {
      const deps = staleDeps({ notify: vi.fn(() => new Promise<void>(() => {})) });
      const p = handleStale({ status: 'stale', ageMs: null }, deps);
      await vi.advanceTimersByTimeAsync(5000);
      await p;
      expect(deps.exit).toHaveBeenCalledWith(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test('still exits when the alert fails', async () => {
    const deps = staleDeps({ notify: vi.fn(async () => { throw new Error('telegram down'); }) });
    await handleStale({ status: 'stale', ageMs: 12 * MIN }, deps);
    expect(deps.exit).toHaveBeenCalledWith(1);
  });

  test('with exits disabled it neither alerts nor exits', async () => {
    const deps = staleDeps({ exitEnabled: false });
    await handleStale({ status: 'stale', ageMs: 12 * MIN }, deps);
    expect(deps.notify).not.toHaveBeenCalled();
    expect(deps.exit).not.toHaveBeenCalled();
  });
});
