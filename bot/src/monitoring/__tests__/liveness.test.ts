/**
 * Bot liveness from the PTB health rollups.
 *
 * Measured 2026-09-06 14:39Z → 2026-09-07 02:27Z: the container stayed "Up",
 * the Docker engine answered, and every poll failed on fetch timeouts for
 * 11.8 hours. The watchdog checks "engine up" and "container running" and saw
 * nothing wrong. ptb_health.jsonl is appended once a minute by a poll that got
 * far enough to evaluate the filters, so a stale last rollup is the signal that
 * the bot is alive but blind.
 */

import { describe, test, expect } from 'vitest';
import { assessLiveness } from '../liveness.ts';

const MIN = 60_000;
const NOW = 1_788_800_000_000;
const rollup = (to: number) =>
  JSON.stringify({ from: to - MIN, to, total: 200, exact: 200, exactPct: 100, bySource: { scheduled_ws: 200 } });

describe('assessLiveness', () => {
  test('fresh when the last rollup closed within the stale window', () => {
    const content = [rollup(NOW - 5 * MIN), rollup(NOW - MIN)].join('\n') + '\n';
    expect(assessLiveness(content, { now: NOW, staleMs: 10 * MIN }))
      .toEqual({ status: 'fresh', lastTo: NOW - MIN, ageMs: MIN });
  });

  test('stale when the last rollup is older than the window', () => {
    const content = rollup(NOW - 60 * MIN) + '\n';
    expect(assessLiveness(content, { now: NOW, staleMs: 10 * MIN }))
      .toEqual({ status: 'stale', lastTo: NOW - 60 * MIN, ageMs: 60 * MIN });
  });

  test('no_data when nothing parsable has been written', () => {
    expect(assessLiveness('', { now: NOW, staleMs: 10 * MIN }))
      .toEqual({ status: 'no_data', lastTo: null, ageMs: null });
  });

  test('ignores a torn last line and uses the last complete rollup', () => {
    const content = rollup(NOW - 2 * MIN) + '\n' + '{"from":1788800,"to":17888';
    expect(assessLiveness(content, { now: NOW, staleMs: 10 * MIN }))
      .toEqual({ status: 'fresh', lastTo: NOW - 2 * MIN, ageMs: 2 * MIN });
  });
});
