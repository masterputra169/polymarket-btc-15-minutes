/**
 * Dry-run journal rows.
 *
 * Measured 2026-09-07: five days of DRY_RUN produced zero journal rows and an
 * empty dryRunReport — not because the filters blocked everything, but because
 * writeJournalEntry() returned early under BOT_CONFIG.dryRun. The report the
 * go-live decision depends on was empty by construction.
 *
 * Invariants under test:
 *   1. A dry-run settlement appends a journal row exactly like a live one.
 *   2. The row is flagged entry.dryRun === true (dryRunReport keys on it), so
 *      simulated rows can never be mistaken for real money.
 *   3. It never reaches the Postgres mirror — trade_journal_records is the
 *      record of real trades and its reports carry no dry-run column.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.mock('fs', () => ({
  readFileSync: vi.fn(() => ''),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(() => true),
  mkdirSync: vi.fn(),
  appendFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

vi.mock('../../logger.ts', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../config.ts', () => ({
  BOT_CONFIG: {
    dryRun: true,
    journalFile: '/tmp/test_trade_journal.jsonl',
    entrySnapshotFile: '/tmp/test_entry_snapshot.json',
  },
}));

vi.mock('../../monitoring/notifier.ts', () => ({ notify: vi.fn(() => Promise.resolve()) }));
vi.mock('../../services/runtimeIntegrations.ts', () => ({
  mirrorTradeJournalRecord: vi.fn(() => Promise.resolve()),
}));
vi.mock('../positionTracker.ts', () => ({ getBankroll: vi.fn(() => 100) }));

import { appendFileSync, readFileSync } from 'fs';
import { mirrorTradeJournalRecord } from '../../services/runtimeIntegrations.ts';
import {
  captureEntrySnapshot, writeJournalEntry, clearEntrySnapshot, getEntrySnapshot, loadEntrySnapshotFromDisk,
} from '../tradeJournal.ts';

const ENTRY = {
  side: 'UP', tokenPrice: 0.6, btcPrice: 80010, priceToBeat: 80000,
  marketSlug: 'btc-updown-15m-1788800000', cost: 3.6, size: 6,
  confidence: 'HIGH', phase: 'MID', reason: 'test',
  mlProbUp: 0.9, mlConfidence: 0.9, mlSide: 'UP',
};

function lastAppendedRow() {
  const calls = vi.mocked(appendFileSync).mock.calls;
  expect(calls.length).toBe(1);
  const [path, line] = calls[0];
  return { path: String(path), row: JSON.parse(String(line).trim()) };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearEntrySnapshot();
});

describe('journal under DRY_RUN', () => {
  test('captureEntrySnapshot stamps the snapshot as a dry-run entry', () => {
    captureEntrySnapshot(ENTRY);
    expect(getEntrySnapshot()?.dryRun).toBe(true);
  });

  test('a dry-run settlement appends a journal row flagged dryRun', () => {
    captureEntrySnapshot(ENTRY);
    writeJournalEntry({
      outcome: 'WIN', pnl: 2.3,
      exitData: { outcome: 'UP', source: 'oracle', btcPrice: 80100, priceToBeat: 80000 },
    });

    const { path, row } = lastAppendedRow();
    expect(path).toBe('/tmp/test_trade_journal.jsonl');
    expect(row.entry.dryRun).toBe(true);
    expect(row.entry.side).toBe('UP');
    expect(row.entry.marketSlug).toBe(ENTRY.marketSlug);
    expect(row.analysis.outcome).toBe('WIN');
    expect(row.analysis.pnl).toBe(2.3);
    // Snapshot is consumed by the write, same as the live path.
    expect(getEntrySnapshot()).toBeNull();
  });

  test('a live snapshot restored from disk is still mirrored, even if the bot now runs DRY_RUN', () => {
    // Restart with DRY_RUN flipped while a real position was still open: the
    // flag stamped at entry is authoritative, the current mode is not.
    vi.mocked(readFileSync).mockReturnValueOnce(JSON.stringify({ ...ENTRY, dryRun: false, enteredAt: 1 }));
    expect(loadEntrySnapshotFromDisk()).toBe(true);
    writeJournalEntry({ outcome: 'WIN', pnl: 2.3, exitData: { outcome: 'UP', source: 'oracle' } });

    const { row } = lastAppendedRow();
    expect(row.entry.dryRun).toBe(false);
    expect(mirrorTradeJournalRecord).toHaveBeenCalledTimes(1);
  });

  test('dry-run rows never reach the Postgres mirror', () => {
    captureEntrySnapshot(ENTRY);
    writeJournalEntry({ outcome: 'LOSS', pnl: -3.6, exitData: { outcome: 'DOWN', source: 'oracle' } });

    expect(appendFileSync).toHaveBeenCalledTimes(1);
    expect(mirrorTradeJournalRecord).not.toHaveBeenCalled();
  });
});
