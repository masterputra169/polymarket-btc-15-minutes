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
