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
  BOT_CONFIG: {
    dryRun: true,
    journalFile: '/tmp/test_markout_journal.jsonl',
    entrySnapshotFile: '/tmp/test_markout_entry.json',
  },
}));
vi.mock('../../monitoring/notifier.ts', () => ({ notify: vi.fn(() => Promise.resolve()) }));
vi.mock('../../services/runtimeIntegrations.ts', () => ({
  mirrorTradeJournalRecord: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../trading/positionTracker.ts', () => ({ getBankroll: vi.fn(() => 100) }));

import { appendFileSync } from 'fs';
import {
  startMarkoutTracking,
  sampleMarkout,
  finalizeMarkout,
  getActiveMarkout,
  getMarkoutStats,
  resetMarkoutTrackerForTest,
} from '../markoutTracker.ts';
import { captureEntrySnapshot, writeJournalEntry, clearEntrySnapshot } from '../../trading/tradeJournal.ts';

describe('markoutTracker post-fill adverse selection telemetry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMarkoutTrackerForTest();
    clearEntrySnapshot();
  });

  test('latches +5s/+15s/+30s/+60s horizons, adverse/favorable peaks, and updates EWMA toxicity', () => {
    const slug = 'btc-updown-15m-1795000000';
    const t0 = 1_795_000_100_000;
    startMarkoutTracking({
      marketSlug: slug,
      side: 'UP',
      fillPrice: 0.60,
      fillModel: 'queue_sim_maker',
      isMaker: true,
      filledAt: t0,
    });

    // Ignored for mismatched slug or side
    sampleMarkout({ marketSlug: 'other-slug', side: 'UP', currentTokenPrice: 0.40, now: t0 + 10_000 });
    sampleMarkout({ marketSlug: slug, side: 'DOWN', currentTokenPrice: 0.40, now: t0 + 10_000 });

    // Early favorable bump, then adverse markouts at 5s/15s/30s/60s
    sampleMarkout({ marketSlug: slug, side: 'UP', currentTokenPrice: 0.63, now: t0 + 2_000 });
    sampleMarkout({ marketSlug: slug, side: 'UP', currentTokenPrice: 0.57, now: t0 + 5_100 });
    sampleMarkout({ marketSlug: slug, side: 'UP', currentTokenPrice: 0.54, now: t0 + 15_200 });
    sampleMarkout({ marketSlug: slug, side: 'UP', currentTokenPrice: 0.52, now: t0 + 30_100 });
    sampleMarkout({ marketSlug: slug, side: 'UP', currentTokenPrice: 0.55, now: t0 + 60_500 });

    const active = getActiveMarkout()!;
    expect(active).toMatchObject({
      fillPrice: 0.60,
      fillModel: 'queue_sim_maker',
      isMaker: true,
      m5s: -0.03,
      m15s: -0.06,
      m30s: -0.08,
      m60s: -0.05,
      adversePeak: -0.08,
      favorablePeak: 0.03,
    });

    const snap = finalizeMarkout(slug)!;
    expect(snap).toEqual(active);
    expect(getActiveMarkout()).toBeNull();

    const stats = getMarkoutStats();
    expect(stats.sampleCount).toBe(1);
    expect(stats.avg5s).toBe(-0.03);
    expect(stats.avg15s).toBe(-0.06);
    expect(stats.avg30s).toBe(-0.08);
    expect(stats.avg60s).toBe(-0.05);
    expect(stats.ewmaToxicity).toBe(0.08);
  });

  test('tradeJournal attaches analysis.markout on settlement without breaking mocked fs writes', () => {
    const slug = 'btc-updown-15m-1795000900';
    vi.useFakeTimers();
    const t0 = 1_795_001_000_000;
    vi.setSystemTime(t0);

    captureEntrySnapshot({
      side: 'DOWN',
      tokenPrice: 0.58,
      fillModel: 'queue_sim_maker',
      isMaker: true,
      btcPrice: 62_800,
      priceToBeat: 62_820,
      marketSlug: slug,
      cost: 2.9,
      size: 5,
      confidence: 'LIMIT',
      phase: 'EARLY',
      reason: 'queue_sim_maker',
    });

    sampleMarkout({ marketSlug: slug, side: 'DOWN', currentTokenPrice: 0.61, now: t0 + 5_500 });
    sampleMarkout({ marketSlug: slug, side: 'DOWN', currentTokenPrice: 0.64, now: t0 + 30_200 });

    vi.setSystemTime(t0 + 120_000);
    writeJournalEntry({ outcome: 'WIN', pnl: 2.1, exitData: { btcPrice: 62_700 } });

    vi.useRealTimers();

    const [, line] = vi.mocked(appendFileSync).mock.calls[0];
    const row = JSON.parse(String(line));
    expect(row.analysis.markout).toMatchObject({
      fillPrice: 0.58,
      fillModel: 'queue_sim_maker',
      isMaker: true,
      m5s: 0.03,
      m30s: 0.06,
      adversePeak: 0,
      favorablePeak: 0.06,
    });
  });
});
