import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const TEST_PATHS = vi.hoisted(() => ({
  dir: '',
  journalFile: '',
  verifiedJournalFile: '',
  stateFile: '',
  stateAuditFile: '',
}));

vi.mock('../../logger.ts', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../config.ts', () => ({
  BOT_CONFIG: {
    get journalFile() { return TEST_PATHS.journalFile; },
    get verifiedJournalFile() { return TEST_PATHS.verifiedJournalFile; },
    get stateFile() { return TEST_PATHS.stateFile; },
    get stateAuditFile() { return TEST_PATHS.stateAuditFile; },
  },
}));

import {
  archiveSessionData,
  getArchivedJournalAnalytics,
  getJournalAnalytics,
  invalidateAnalyticsCache,
  listJournalArchives,
} from '../journalAnalytics.ts';

function seedOldSession(dir: string) {
  const t1 = Date.UTC(2026, 10, 14, 15, 0, 0);
  const t2 = Date.UTC(2026, 10, 15, 16, 30, 0);
  const rows = [
    {
      _ts: t1,
      entry: { side: 'UP', tokenPrice: 0.54, cost: 2.7, size: 5, marketSlug: 'btc-updown-15m-1', enteredAt: t1, fillModel: 'fok_limit', regime: 'moderate', mlConfidence: 0.72, bestEdge: 0.11 },
      exit: { verifiedOutcome: 'UP', exitedAt: t1 + 600_000 },
      analysis: { outcome: 'WIN', pnl: 2.21, holdDurationSec: 600 },
    },
    {
      _ts: t2,
      entry: { side: 'DOWN', tokenPrice: 0.56, cost: 2.8, size: 5, marketSlug: 'btc-updown-15m-2', enteredAt: t2, fillModel: 'fok_limit', regime: 'trending', mlConfidence: 0.65, bestEdge: 0.08 },
      exit: { verifiedOutcome: 'UP', exitedAt: t2 + 700_000 },
      analysis: { outcome: 'LOSS', pnl: -2.8, holdDurationSec: 700 },
    },
  ];
  writeFileSync(TEST_PATHS.journalFile, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  writeFileSync(TEST_PATHS.stateFile, JSON.stringify({ bankroll: 17.53, peakBankroll: 29.45, totalTrades: 2, wins: 1, losses: 1 }));
  writeFileSync(
    TEST_PATHS.stateAuditFile,
    [
      { type: 'STATE_LOADED', bankrollAfter: 20.33, _ts: t1 - 60_000 },
      { type: 'SETTLE', pnl: 2.21, bankrollAfter: 20.33, _ts: t1 },
      { type: 'SETTLE', pnl: -2.8, bankrollAfter: 17.53, _ts: t2 },
    ].map(r => JSON.stringify(r)).join('\n') + '\n',
  );
  writeFileSync(join(dir, 'feedback.json'), JSON.stringify([{ marketSlug: 'old', correct: false }]));
  writeFileSync(join(dir, 'signal_perf.json'), JSON.stringify({ rsi: { wins: 1, losses: 2 } }));
}

describe('journalArchives & archiveSessionData', () => {
  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'polybtc-arch-'));
    TEST_PATHS.dir = dir;
    TEST_PATHS.journalFile = join(dir, 'trade_journal.jsonl');
    TEST_PATHS.verifiedJournalFile = join(dir, 'verified_journal.jsonl');
    TEST_PATHS.stateFile = join(dir, 'state.json');
    TEST_PATHS.stateAuditFile = join(dir, 'state_audit.jsonl');
    invalidateAnalyticsCache();
  });

  afterEach(() => {
    invalidateAnalyticsCache();
    if (TEST_PATHS.dir) rmSync(TEST_PATHS.dir, { recursive: true, force: true });
  });

  test('archives old session cleanly, resets active bankroll to $100, and exposes archives to frontend', () => {
    seedOldSession(TEST_PATHS.dir);

    const res = archiveSessionData({
      archiveId: 'archive_20261116_pre_alltime_100',
      label: 'Pre-$100 Legacy Run',
      note: 'Dry-run history before All-Time Quant $100 test',
      modelId: '20261115-p2-c3e0fd',
      newBankroll: 100,
    });

    expect(res.ok).toBe(true);
    expect(res.meta.endBankroll).toBe(17.53);
    expect(existsSync(join(TEST_PATHS.dir, 'archive_20261116_pre_alltime_100/trade_journal.jsonl'))).toBe(true);
    expect(existsSync(join(TEST_PATHS.dir, 'archive_20261116_pre_alltime_100/archive_meta.json'))).toBe(true);

    // Active files were cleanly reset to $100 with 0 trades
    const newState = JSON.parse(readFileSync(TEST_PATHS.stateFile, 'utf-8'));
    expect(newState.bankroll).toBe(100);
    expect(newState.totalTrades).toBe(0);
    expect(newState.wins).toBe(0);
    expect(newState.losses).toBe(0);
    expect(readFileSync(TEST_PATHS.journalFile, 'utf-8')).toBe('');
    expect(readFileSync(join(TEST_PATHS.dir, 'feedback.json'), 'utf-8')).toBe('[]');

    // Active analytics has complete zero defaults AND lists the archive
    const active = getJournalAnalytics(0);
    expect(active.patterns.totalTrades).toBe(0);
    expect(active.patterns.totalWins).toBe(0);
    expect(active.patterns.totalLosses).toBe(0);
    expect(active.patterns.roi).toBe(0);
    expect(active.archives).toHaveLength(1);
    expect(active.archives[0]).toMatchObject({
      id: 'archive_20261116_pre_alltime_100',
      label: 'Pre-$100 Legacy Run',
      trades: 2,
      wins: 1,
      losses: 1,
      wr: 50,
      pnl: -0.59,
      endBankroll: 17.53,
      modelId: '20261115-p2-c3e0fd',
    });

    // Archive analytics renders full stats + equity curve + events on demand
    const archived = getArchivedJournalAnalytics('archive_20261116_pre_alltime_100');
    expect(archived).not.toBeNull();
    expect(archived!.patterns.totalTrades).toBe(2);
    expect(archived!.patterns.totalWins).toBe(1);
    expect(archived!.patterns.totalLosses).toBe(1);
    expect(archived!.equityCurve.length).toBeGreaterThanOrEqual(2);
    expect(archived!.events.length).toBeGreaterThanOrEqual(2);
  });

  test('rejects invalid archive ids, path traversal, and overwriting existing archives', () => {
    seedOldSession(TEST_PATHS.dir);
    expect(getArchivedJournalAnalytics('../secret')).toBeNull();
    expect(getArchivedJournalAnalytics('not_an_archive')).toBeNull();
    expect(getArchivedJournalAnalytics('archive_missing')).toBeNull();
    expect(listJournalArchives()).toEqual([]);

    archiveSessionData({ archiveId: 'archive_first', label: 'First', newBankroll: 100 });
    expect(() =>
      archiveSessionData({ archiveId: 'archive_first', label: 'Duplicate', newBankroll: 100 })
    ).toThrow(/already exists/i);
  });
});
