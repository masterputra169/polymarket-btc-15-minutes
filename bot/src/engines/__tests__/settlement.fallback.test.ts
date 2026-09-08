/**
 * Settlement after price_fallback.
 *
 * Measured 2026-09-08 (Railway dry run): every settlement was decided by
 * price_fallback because the market switch aborts the oracle retries right at
 * expiry, and the Gamma secondary oracle queried `/markets?slug=`, which
 * returns `[]` for these markets. Two invariants:
 *   1. A price_fallback settlement hands the market to the fallback verifier
 *      (actions.onFallbackSettled) so it is re-checked once Polymarket resolves.
 *   2. When the retries are not aborted, the Gamma lookup uses the endpoint
 *      that actually returns the market (`/markets/slug/<slug>`).
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../logger.ts', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../config.ts', () => ({
  CONFIG: { gammaBaseUrl: 'https://gamma.test', clobBaseUrl: 'https://clob.test' },
  BOT_CONFIG: {},
}));
vi.mock('../../monitoring/notifier.ts', () => ({ notify: vi.fn(() => Promise.resolve()) }));

import { handleExpiry, handleStalePosition, settleViaOracle } from '../settlement.ts';

const SLUG = 'btc-updown-15m-1788768900';
const COND = '0xc0nd';
const POS = { side: 'UP', marketSlug: SLUG, conditionId: COND, price: 0.625, size: 2, cost: 1.25, settled: false };
const PTB = { value: 79453.26, slug: SLUG };

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as any;
}

function makeActions() {
  return {
    settleTrade: vi.fn(), unwindPosition: vi.fn(), invalidateUsdcSync: vi.fn(),
    clearEntrySnapshot: vi.fn(), writeJournalEntry: vi.fn(), recordLoss: vi.fn(),
    settlePrediction: vi.fn(), onFallbackSettled: vi.fn(),
  };
}
const deps = {
  getLastSettled: () => ({ slug: null, ts: 0 }),
  setLastSettled: vi.fn(),
  getOraclePrice: () => 79450.78,
  getBinancePrice: () => null,
};

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.clearAllMocks();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('price_fallback settlement', () => {
  test('aborted oracle retries → price_fallback row and the verifier is handed the market', async () => {
    const ac = new AbortController(); ac.abort();
    const actions = makeActions();
    await handleExpiry({ pos: POS, currentMarketSlug: SLUG, currentConditionId: COND, priceToBeat: PTB, now: Date.now() },
      deps, actions, { signal: ac.signal });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(actions.writeJournalEntry).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'LOSS', pnl: -1.25,
      exitData: expect.objectContaining({ outcome: 'DOWN', source: 'price_fallback' }),
    }));
    expect(actions.onFallbackSettled).toHaveBeenCalledWith({ marketSlug: SLUG, conditionId: COND });
  });

  test('control: an oracle-resolved settlement does not involve the verifier', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ closed: true, tokens: [{ outcome: 'Down', winner: true }, { outcome: 'Up', winner: false }] }));
    const actions = makeActions();
    await handleExpiry({ pos: POS, currentMarketSlug: SLUG, currentConditionId: COND, priceToBeat: PTB, now: Date.now() }, deps, actions, {});
    expect(actions.writeJournalEntry).toHaveBeenCalledWith(expect.objectContaining({
      exitData: expect.objectContaining({ source: 'oracle' }),
    }));
    expect(actions.onFallbackSettled).not.toHaveBeenCalled();
  });
});

describe('stale position (restart with a leftover position, no PTB)', () => {
  test("unresolved oracle books an evidence-free LOSS ('unknown') and hands it to the verifier", async () => {
    const ac = new AbortController(); ac.abort();
    const actions = { ...makeActions(), setLastSettled: vi.fn() };
    await handleStalePosition({ pos: POS, currentMarketSlug: 'btc-updown-15m-1788769800', now: Date.now() },
      deps, actions, { signal: ac.signal });

    expect(actions.writeJournalEntry).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'LOSS', pnl: -1.25,
      exitData: expect.objectContaining({ source: 'unknown', staleRecovery: true }),
    }));
    expect(actions.onFallbackSettled).toHaveBeenCalledWith({ marketSlug: SLUG, conditionId: COND });
  });

  test('Gamma-lookup branch writes the journal row before clearing the snapshot and hands it to the verifier', async () => {
    const ac = new AbortController(); ac.abort();
    const posNoCond = { ...POS, conditionId: null, fillConfirmed: true };
    fetchMock.mockResolvedValue(jsonResponse({ slug: SLUG, conditionId: COND, closed: false }));
    const actions = { ...makeActions(), setLastSettled: vi.fn() };
    await handleStalePosition({ pos: posNoCond, currentMarketSlug: 'btc-updown-15m-1788769800', now: Date.now() },
      deps, actions, { signal: ac.signal });

    expect(actions.writeJournalEntry).toHaveBeenCalledTimes(1);
    expect(actions.writeJournalEntry.mock.invocationCallOrder[0])
      .toBeLessThan(actions.clearEntrySnapshot.mock.invocationCallOrder[0]);
    expect(actions.onFallbackSettled).toHaveBeenCalledWith({ marketSlug: SLUG, conditionId: COND });
  });
});

describe('Gamma secondary oracle', () => {
  test('after CLOB retries are exhausted, resolves via /markets/slug/<slug>', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.startsWith('https://clob.test/')) return jsonResponse({ closed: false, tokens: [] });
      if (u === `https://gamma.test/markets/slug/${SLUG}`) {
        return jsonResponse({ closed: true, outcomes: '["Up","Down"]', outcomePrices: '["0","1"]' });
      }
      return jsonResponse([], 200); // the old ?slug= form: empty, as measured
    });

    const pending = settleViaOracle(POS, COND, 79450.78, 79453.26, {});
    await vi.advanceTimersByTimeAsync(120_000);
    const r = await pending;

    expect(r).toEqual({ won: false, outcome: 'DOWN', source: 'gamma_oracle' });
    const urls = fetchMock.mock.calls.map(c => String(c[0]));
    expect(urls).toContain(`https://gamma.test/markets/slug/${SLUG}`);
  });
});
