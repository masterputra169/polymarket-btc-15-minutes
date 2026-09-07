/**
 * Drift detection must see dry-run trades.
 *
 * The detector compares the model's live accuracy (analysis.mlWasRight) with
 * its training baseline. Whether money moved is irrelevant to that question:
 * a dry-run row carries the same prediction and the same market outcome. With
 * dry-run rows skipped, a bot observing the market for weeks has no drift
 * guard at all — measured 2026-09-07 as 122 consecutive "Drift check skipped"
 * lines while the model ran unwatched.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const { JOURNAL_PATH } = vi.hoisted(() => ({ JOURNAL_PATH: '/tmp/test_trade_journal.jsonl' }));

vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  existsSync: vi.fn((p: any) => String(p) === JOURNAL_PATH),
  appendFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));
vi.mock('child_process', () => ({ execSync: vi.fn(), spawn: vi.fn() }));
vi.mock('../../logger.ts', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../notifier.ts', () => ({ notify: vi.fn(() => Promise.resolve()) }));
vi.mock('../../config.ts', () => ({ BOT_CONFIG: { journalFile: JOURNAL_PATH } }));

import { readFileSync } from 'fs';
import { checkDrift, resetDriftState } from '../driftDetector.ts';

/** `n` recent dry-run rows, the model right on every one. */
function dryRunJournal(n: number): string {
  const now = Date.now();
  return Array.from({ length: n }, (_, i) => JSON.stringify({
    entry: { dryRun: true, side: 'UP', mlSide: 'UP', mlConfidence: 0.85, marketSlug: `m-${i}` },
    exit: { outcome: 'UP' },
    analysis: { outcome: 'WIN', pnl: 1, mlWasRight: true },
    _ts: now - (n - i) * 60_000,
  })).join('\n') + '\n';
}

beforeEach(() => {
  vi.clearAllMocks();
  resetDriftState();
  vi.mocked(readFileSync).mockImplementation((p: any) => {
    if (String(p) === JOURNAL_PATH) return dryRunJournal(50);
    throw new Error(`unexpected read: ${p}`); // model json → baseline falls back to its default
  });
});

describe('checkDrift with a dry-run journal', () => {
  test('counts dry-run rows as ML observations instead of skipping them', () => {
    const result = checkDrift();
    expect(result.status).not.toBe('insufficient_data');
    expect(result.trades).toBe(50);
    expect(result.accuracy).toBe(100);
  });
});
