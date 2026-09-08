/**
 * Fallback verifier — re-checks every settlement that was decided by
 * price_fallback against Polymarket's real resolution and corrects the row,
 * the bankroll and the win/loss counters when they differ.
 *
 * Measured 2026-09-08 on the Railway dry run: all 22 settlements were
 * price_fallback (the market switch aborts the oracle retries at expiry).
 * 21 matched Polymarket; the PREMARKET long at 13:15Z (11 shares @ 0.365,
 * booked +6.87 on a +0.020% spot gap) resolved DOWN under the TWAP rule.
 * Reported 17W-5L +14.13 was really 16W-6L +3.25 and nothing corrected it.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../logger.ts', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../tradeJournal.ts', () => ({
  readJournalRows: vi.fn(() => []),
  rewriteJournalRow: vi.fn(() => true),
}));
vi.mock('../positionTracker.ts', () => ({ correctSettlement: vi.fn(() => true) }));
vi.mock('../../engines/marketResolution.ts', () => ({ fetchResolvedOutcome: vi.fn(async () => null) }));
vi.mock('../../monitoring/notifier.ts', () => ({ notify: vi.fn(() => Promise.resolve()) }));
vi.mock('../../services/runtimeIntegrations.ts', () => ({ mirrorTradeJournalRecord: vi.fn(() => Promise.resolve()) }));

import { readJournalRows, rewriteJournalRow } from '../tradeJournal.ts';
import { correctSettlement } from '../positionTracker.ts';
import { fetchResolvedOutcome } from '../../engines/marketResolution.ts';
import { notify } from '../../monitoring/notifier.ts';
import { mirrorTradeJournalRecord } from '../../services/runtimeIntegrations.ts';
import {
  applyResolution, verifyFallbackSettlement, scheduleFallbackVerification, verifyPendingFallbacks, _resetForTest,
} from '../fallbackVerifier.ts';

const SLUG = 'btc-updown-15m-1788786000';
const NOW = 1_788_790_000_000;

/** The Railway PREMARKET row, as written by settlement. */
const PREMARKET_ROW = {
  _ts: 1_788_786_900_000,
  entry: { marketSlug: SLUG, side: 'UP', tokenPrice: 0.365, cost: 4.01, size: 11, dryRun: true, mlSide: 'UP', ruleUp: 0.8 },
  exit: { outcome: 'UP', source: 'price_fallback', btcPrice: 79611.25, priceToBeat: 79594.94, priceSource: 'oracle', exitedAt: 1_788_786_900_000 },
  analysis: { outcome: 'WIN', pnl: 6.87, actualOutcome: 'UP', mlWasRight: true, ruleWasRight: true, edgeWasReal: true },
};

/** A LOSS row (first Railway trade) for the loss→win direction. */
const LOSS_ROW = {
  _ts: 1_788_769_800_000,
  entry: { marketSlug: 'btc-updown-15m-1788768900', side: 'UP', tokenPrice: 0.625, cost: 1.25, size: 2, dryRun: true, mlSide: 'UP' },
  exit: { outcome: 'DOWN', source: 'price_fallback', btcPrice: 79450.78, priceToBeat: 79453.26, priceSource: 'oracle', exitedAt: 1_788_769_800_000 },
  analysis: { outcome: 'LOSS', pnl: -1.25, actualOutcome: 'DOWN', mlWasRight: false, edgeWasReal: false },
};

beforeEach(() => {
  vi.clearAllMocks();
  _resetForTest();
  vi.mocked(readJournalRows).mockReturnValue([PREMARKET_ROW]);
  vi.mocked(rewriteJournalRow).mockReturnValue(true);
  vi.mocked(fetchResolvedOutcome).mockResolvedValue(null);
});
afterEach(() => { vi.useRealTimers(); });

describe('applyResolution', () => {
  test('confirmed: stamps the verification, leaves outcome and P&L alone, does not mutate the input', () => {
    const before = JSON.stringify(PREMARKET_ROW);
    const r = applyResolution(PREMARKET_ROW, { outcome: 'UP', source: 'gamma_oracle' }, NOW);
    expect(r.status).toBe('confirmed');
    expect(r.delta).toBe(0);
    expect(r.row.exit).toMatchObject({ verifiedOutcome: 'UP', verifiedSource: 'gamma_oracle', verifiedAt: NOW });
    expect(r.row.analysis).toEqual(PREMARKET_ROW.analysis);
    expect(JSON.stringify(PREMARKET_ROW)).toBe(before);
  });

  test('corrected win→loss: LOSS at full cost, delta = new − old, model flags recomputed', () => {
    const r = applyResolution(PREMARKET_ROW, { outcome: 'DOWN', source: 'gamma_oracle' }, NOW);
    expect(r.status).toBe('corrected');
    expect(r.wasWin).toBe(true);
    expect(r.nowWin).toBe(false);
    expect(r.delta).toBe(-10.88);
    expect(r.row.analysis).toMatchObject({
      outcome: 'LOSS', pnl: -4.01, actualOutcome: 'DOWN', mlWasRight: false, ruleWasRight: false, edgeWasReal: false,
    });
    expect(r.row.exit).toMatchObject({
      outcome: 'DOWN', source: 'price_fallback', verifiedOutcome: 'DOWN', verifiedSource: 'gamma_oracle',
      correctedFrom: { outcome: 'WIN', pnl: 6.87 },
    });
  });

  test('corrected loss→win: WIN with the same fee math settlement uses', () => {
    const r = applyResolution(LOSS_ROW, { outcome: 'UP', source: 'oracle' }, NOW);
    expect(r.status).toBe('corrected');
    expect(r.row.analysis).toMatchObject({ outcome: 'WIN', pnl: 0.74, actualOutcome: 'UP', mlWasRight: true, edgeWasReal: true });
    expect(r.delta).toBe(1.99);
  });
});

describe('verifyFallbackSettlement', () => {
  test('missing: no unverified price_fallback row for the slug', async () => {
    vi.mocked(readJournalRows).mockReturnValue([]);
    expect(await verifyFallbackSettlement({ marketSlug: SLUG, conditionId: null })).toBe('missing');
    expect(fetchResolvedOutcome).not.toHaveBeenCalled();
  });

  test('pending: market not resolved yet, nothing written', async () => {
    vi.mocked(fetchResolvedOutcome).mockResolvedValue(null);
    expect(await verifyFallbackSettlement({ marketSlug: SLUG, conditionId: null })).toBe('pending');
    expect(rewriteJournalRow).not.toHaveBeenCalled();
    expect(correctSettlement).not.toHaveBeenCalled();
  });

  test('confirmed: row stamped, bankroll untouched', async () => {
    vi.mocked(fetchResolvedOutcome).mockResolvedValue({ outcome: 'UP', source: 'gamma_oracle' });
    expect(await verifyFallbackSettlement({ marketSlug: SLUG, conditionId: null })).toBe('confirmed');
    const [match, update] = vi.mocked(rewriteJournalRow).mock.calls[0];
    expect(match(PREMARKET_ROW)).toBe(true);
    expect(match({ ...PREMARKET_ROW, _ts: 1 })).toBe(false);
    expect(update(PREMARKET_ROW).exit.verifiedOutcome).toBe('UP');
    expect(correctSettlement).not.toHaveBeenCalled();
  });

  test('the rewrite refuses a row another verification already stamped (no double correction)', async () => {
    vi.mocked(fetchResolvedOutcome).mockResolvedValue({ outcome: 'DOWN', source: 'gamma_oracle' });
    await verifyFallbackSettlement({ marketSlug: SLUG, conditionId: null });
    const [match] = vi.mocked(rewriteJournalRow).mock.calls[0];
    expect(match({ ...PREMARKET_ROW, exit: { ...PREMARKET_ROW.exit, verifiedAt: 1 } })).toBe(false);
  });

  test('journal rewrite failed: pending, bankroll untouched, so the retry can try again', async () => {
    vi.mocked(fetchResolvedOutcome).mockResolvedValue({ outcome: 'DOWN', source: 'gamma_oracle' });
    vi.mocked(rewriteJournalRow).mockReturnValue(false);
    expect(await verifyFallbackSettlement({ marketSlug: SLUG, conditionId: null })).toBe('pending');
    expect(correctSettlement).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  test('corrected dry-run row: journal rewritten, bankroll + counters corrected, operator told, never mirrored', async () => {
    vi.mocked(fetchResolvedOutcome).mockResolvedValue({ outcome: 'DOWN', source: 'gamma_oracle' });
    expect(await verifyFallbackSettlement({ marketSlug: SLUG, conditionId: null })).toBe('corrected');
    const [, update] = vi.mocked(rewriteJournalRow).mock.calls[0];
    expect(update(PREMARKET_ROW).analysis).toMatchObject({ outcome: 'LOSS', pnl: -4.01 });
    expect(correctSettlement).toHaveBeenCalledWith(expect.objectContaining({
      delta: -10.88, wasWin: true, nowWin: false, slug: SLUG, adjustBankroll: true,
    }));
    expect(notify).toHaveBeenCalledTimes(1);
    expect(mirrorTradeJournalRecord).not.toHaveBeenCalled();
  });

  test('corrected live row: journal + Postgres mirror updated, counters corrected, bankroll left to the on-chain reconciler', async () => {
    const liveRow = { ...PREMARKET_ROW, entry: { ...PREMARKET_ROW.entry, dryRun: false } };
    vi.mocked(readJournalRows).mockReturnValue([liveRow]);
    vi.mocked(fetchResolvedOutcome).mockResolvedValue({ outcome: 'DOWN', source: 'oracle' });
    expect(await verifyFallbackSettlement({ marketSlug: SLUG, conditionId: '0xc' })).toBe('corrected');
    expect(correctSettlement).toHaveBeenCalledWith(expect.objectContaining({
      wasWin: true, nowWin: false, slug: SLUG, adjustBankroll: false,
    }));
    expect(mirrorTradeJournalRecord).toHaveBeenCalledTimes(1);
    expect(vi.mocked(mirrorTradeJournalRecord).mock.calls[0][0].analysis.outcome).toBe('LOSS');
    expect(fetchResolvedOutcome).toHaveBeenCalledWith(expect.objectContaining({ conditionId: '0xc', marketSlug: SLUG }));
  });

  test('confirmed live row: the stamped row is mirrored too, so Postgres does not drift', async () => {
    const liveRow = { ...PREMARKET_ROW, entry: { ...PREMARKET_ROW.entry, dryRun: false } };
    vi.mocked(readJournalRows).mockReturnValue([liveRow]);
    vi.mocked(fetchResolvedOutcome).mockResolvedValue({ outcome: 'UP', source: 'oracle' });
    expect(await verifyFallbackSettlement({ marketSlug: SLUG, conditionId: '0xc' })).toBe('confirmed');
    expect(mirrorTradeJournalRecord).toHaveBeenCalledTimes(1);
    expect(vi.mocked(mirrorTradeJournalRecord).mock.calls[0][0].exit.verifiedOutcome).toBe('UP');
    expect(correctSettlement).not.toHaveBeenCalled();
  });

  test("an evidence-free 'unknown' settlement (stale position, no PTB) is verified like price_fallback", async () => {
    const unknownRow = { ...LOSS_ROW, exit: { ...LOSS_ROW.exit, outcome: null, source: 'unknown', staleRecovery: true } };
    vi.mocked(readJournalRows).mockReturnValue([unknownRow]);
    vi.mocked(fetchResolvedOutcome).mockResolvedValue({ outcome: 'UP', source: 'oracle' });
    expect(await verifyFallbackSettlement({ marketSlug: LOSS_ROW.entry.marketSlug, conditionId: null })).toBe('corrected');
    expect(correctSettlement).toHaveBeenCalledWith(expect.objectContaining({ wasWin: false, nowWin: true, delta: 1.99 }));
  });
});

describe('scheduleFallbackVerification', () => {
  test('retries on a backoff until the market resolves, then stops; duplicate schedules are ignored', async () => {
    vi.useFakeTimers();
    vi.mocked(fetchResolvedOutcome)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ outcome: 'DOWN', source: 'gamma_oracle' });

    scheduleFallbackVerification({ marketSlug: SLUG, conditionId: null });
    scheduleFallbackVerification({ marketSlug: SLUG, conditionId: null }); // in flight → no-op

    await vi.advanceTimersByTimeAsync(90_000);
    expect(fetchResolvedOutcome).toHaveBeenCalledTimes(1);
    expect(rewriteJournalRow).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(180_000);
    expect(fetchResolvedOutcome).toHaveBeenCalledTimes(2);
    expect(rewriteJournalRow).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(fetchResolvedOutcome).toHaveBeenCalledTimes(2); // stopped
  });

  test('gives up after the last retry and reports it', async () => {
    vi.useFakeTimers();
    vi.mocked(fetchResolvedOutcome).mockResolvedValue(null);
    scheduleFallbackVerification({ marketSlug: SLUG, conditionId: null });
    await vi.advanceTimersByTimeAsync(3 * 60 * 60_000);
    expect(fetchResolvedOutcome).toHaveBeenCalledTimes(5);
    expect(notify).toHaveBeenCalledTimes(1);
  });
});

describe('verifyPendingFallbacks (startup sweep)', () => {
  test('verifies only unverified WIN/LOSS price_fallback rows inside the window', async () => {
    const oracleRow = { ...LOSS_ROW, _ts: 5, entry: { ...LOSS_ROW.entry, marketSlug: 'oracle-row' }, exit: { ...LOSS_ROW.exit, source: 'oracle' } };
    const verifiedRow = { ...LOSS_ROW, _ts: 6, entry: { ...LOSS_ROW.entry, marketSlug: 'verified-row' }, exit: { ...LOSS_ROW.exit, verifiedAt: 1 } };
    const cutRow = { ...LOSS_ROW, _ts: 7, entry: { ...LOSS_ROW.entry, marketSlug: 'cut-row' }, analysis: { outcome: 'CUT_LOSS', pnl: -0.5 } };
    const ancientRow = { ...LOSS_ROW, _ts: NOW - 30 * 86_400_000, entry: { ...LOSS_ROW.entry, marketSlug: 'ancient-row' } };
    vi.mocked(readJournalRows).mockReturnValue([oracleRow, verifiedRow, cutRow, ancientRow, PREMARKET_ROW, LOSS_ROW]);
    vi.mocked(fetchResolvedOutcome)
      .mockResolvedValueOnce({ outcome: 'DOWN', source: 'gamma_oracle' }) // PREMARKET → corrected
      .mockResolvedValueOnce({ outcome: 'DOWN', source: 'gamma_oracle' }); // LOSS_ROW → confirmed

    const summary = await verifyPendingFallbacks({ now: NOW, maxAgeMs: 7 * 86_400_000 });

    expect(summary).toEqual({ checked: 2, confirmed: 1, corrected: 1, pending: 0 });
    const slugs = vi.mocked(fetchResolvedOutcome).mock.calls.map(c => c[0].marketSlug);
    expect(slugs).toEqual([SLUG, LOSS_ROW.entry.marketSlug]);
  });
});
