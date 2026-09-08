/**
 * Journal rows must be correctable in place.
 *
 * The journal is append-only by design, but a settlement decided by
 * price_fallback can turn out wrong once Polymarket resolves (measured
 * 2026-09-08: the Railway PREMARKET row booked +6.87 for a market that
 * resolved DOWN). rewriteJournalRow replaces exactly one row atomically
 * (temp file + rename) and drops the in-memory cache so the dashboard sees it.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.mock('fs', () => ({
  readFileSync: vi.fn(() => ''),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(() => true),
  mkdirSync: vi.fn(),
  appendFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  renameSync: vi.fn(),
}));
vi.mock('../../logger.ts', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../config.ts', () => ({
  BOT_CONFIG: { dryRun: true, journalFile: '/tmp/j.jsonl', entrySnapshotFile: '/tmp/snap.json' },
}));
vi.mock('../../monitoring/notifier.ts', () => ({ notify: vi.fn(() => Promise.resolve()) }));
vi.mock('../../services/runtimeIntegrations.ts', () => ({ mirrorTradeJournalRecord: vi.fn(() => Promise.resolve()) }));
vi.mock('../positionTracker.ts', () => ({ getBankroll: vi.fn(() => 100) }));

import { readFileSync, writeFileSync, renameSync } from 'fs';
import { readJournalRows, rewriteJournalRow, getRecentJournal, _resetJournalCacheForTest } from '../tradeJournal.ts';

const ROWS = [
  { _ts: 1, entry: { marketSlug: 'a' }, exit: { source: 'oracle' }, analysis: { outcome: 'WIN', pnl: 1 } },
  { _ts: 2, entry: { marketSlug: 'b' }, exit: { source: 'price_fallback' }, analysis: { outcome: 'WIN', pnl: 6.87 } },
  { _ts: 3, entry: { marketSlug: 'c' }, exit: { source: 'oracle' }, analysis: { outcome: 'LOSS', pnl: -1 } },
];
const FILE = ROWS.map(r => JSON.stringify(r)).join('\n') + '\n';

beforeEach(() => {
  vi.clearAllMocks();
  _resetJournalCacheForTest();
  vi.mocked(readFileSync).mockReturnValue(FILE);
});

describe('readJournalRows', () => {
  test('parses every row and skips torn lines', () => {
    vi.mocked(readFileSync).mockReturnValue(FILE + '{"torn":');
    const rows = readJournalRows();
    expect(rows.map(r => r._ts)).toEqual([1, 2, 3]);
  });
});

describe('rewriteJournalRow', () => {
  test('replaces only the matching row and writes atomically via temp file + rename', () => {
    const ok = rewriteJournalRow(
      r => r._ts === 2,
      r => ({ ...r, analysis: { ...r.analysis, outcome: 'LOSS', pnl: -4.01 } }),
    );
    expect(ok).toBe(true);
    const [tmpPath, content] = vi.mocked(writeFileSync).mock.calls[0];
    expect(String(tmpPath)).not.toBe('/tmp/j.jsonl');
    const written = String(content).trim().split('\n').map(l => JSON.parse(l));
    expect(written).toHaveLength(3);
    expect(written[0]).toEqual(ROWS[0]);
    expect(written[1].analysis).toEqual({ outcome: 'LOSS', pnl: -4.01 });
    expect(written[2]).toEqual(ROWS[2]);
    expect(renameSync).toHaveBeenCalledWith(tmpPath, '/tmp/j.jsonl');
  });

  test('does not touch the file when nothing matches', () => {
    expect(rewriteJournalRow(r => r._ts === 99, r => r)).toBe(false);
    expect(writeFileSync).not.toHaveBeenCalled();
    expect(renameSync).not.toHaveBeenCalled();
  });

  test('drops the recent-journal cache so the dashboard re-reads the corrected row', () => {
    getRecentJournal(1);
    const readsBefore = vi.mocked(readFileSync).mock.calls.length;
    rewriteJournalRow(r => r._ts === 2, r => r);
    getRecentJournal(1);
    expect(vi.mocked(readFileSync).mock.calls.length).toBeGreaterThan(readsBefore);
  });
});
