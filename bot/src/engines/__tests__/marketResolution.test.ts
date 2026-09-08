/**
 * Market resolution lookups.
 *
 * Measured 2026-09-08 on the Railway dry run: Gamma `GET /markets?slug=<slug>`
 * returns `[]` for the 15-minute BTC markets, so the bot's secondary oracle
 * (settlement.ts) never resolved anything and every settlement fell through to
 * price_fallback. `GET /markets/slug/<slug>` returns the market object.
 */
import { describe, test, expect, vi } from 'vitest';

vi.mock('../../logger.ts', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../config.ts', () => ({
  CONFIG: { gammaBaseUrl: 'https://gamma.test', clobBaseUrl: 'https://clob.test' },
  BOT_CONFIG: {},
}));

import { fetchGammaMarketBySlug, outcomeFromMarket, fetchResolvedOutcome } from '../marketResolution.ts';

const SLUG = 'btc-updown-15m-1788786000';
const COND = '0xabc';

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as any;
}

describe('fetchGammaMarketBySlug', () => {
  test('uses /markets/slug/<slug> and returns the market object', async () => {
    const fetchImpl = vi.fn(async (_url: string) => jsonResponse({ slug: SLUG, closed: true }));
    const m = await fetchGammaMarketBySlug(SLUG, { fetchImpl });
    expect(m).toEqual({ slug: SLUG, closed: true });
    expect(String(fetchImpl.mock.calls[0][0])).toBe(`https://gamma.test/markets/slug/${SLUG}`);
  });

  test('falls back to the ?slug= list form when the path form is not found', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'not found' }, 404))
      .mockResolvedValueOnce(jsonResponse([{ slug: SLUG, closed: false }]));
    const m = await fetchGammaMarketBySlug(SLUG, { fetchImpl });
    expect(m).toEqual({ slug: SLUG, closed: false });
    expect(String(fetchImpl.mock.calls[1][0])).toBe(`https://gamma.test/markets?slug=${SLUG}`);
  });

  test('returns null when both forms come back empty', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(null, 404))
      .mockResolvedValueOnce(jsonResponse([]));
    expect(await fetchGammaMarketBySlug(SLUG, { fetchImpl })).toBeNull();
  });

  test('returns null on a network error instead of throwing', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNRESET'); });
    expect(await fetchGammaMarketBySlug(SLUG, { fetchImpl })).toBeNull();
  });
});

describe('outcomeFromMarket', () => {
  test('null while the market is still open', () => {
    expect(outcomeFromMarket({ closed: false, outcomes: '["Up","Down"]', outcomePrices: '["0.6","0.4"]' })).toBeNull();
  });

  test('reads the winner from CLOB-style tokens[]', () => {
    expect(outcomeFromMarket({ closed: true, tokens: [{ outcome: 'Up', winner: false }, { outcome: 'Down', winner: true }] })).toBe('DOWN');
  });

  test('reads the winner from Gamma-style outcomePrices strings', () => {
    expect(outcomeFromMarket({ closed: true, outcomes: '["Up","Down"]', outcomePrices: '["0","1"]' })).toBe('DOWN');
    expect(outcomeFromMarket({ closed: true, outcomes: ['Up', 'Down'], outcomePrices: ['1', '0'] })).toBe('UP');
  });

  test('null when closed but nothing is priced at 1 (unresolved / disputed)', () => {
    expect(outcomeFromMarket({ closed: true, outcomes: '["Up","Down"]', outcomePrices: '["0.5","0.5"]' })).toBeNull();
  });
});

describe('fetchResolvedOutcome', () => {
  test('prefers the CLOB oracle when the market is closed there', async () => {
    const fetchImpl = vi.fn(async (_url: string) => jsonResponse({ closed: true, tokens: [{ outcome: 'Up', winner: true }, { outcome: 'Down', winner: false }] }));
    const r = await fetchResolvedOutcome({ conditionId: COND, marketSlug: SLUG }, { fetchImpl });
    expect(r).toEqual({ outcome: 'UP', source: 'oracle' });
    expect(String(fetchImpl.mock.calls[0][0])).toBe(`https://clob.test/markets/${COND}`);
  });

  test('falls through to Gamma when CLOB has not closed the market', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ closed: false, tokens: [] }))
      .mockResolvedValueOnce(jsonResponse({ closed: true, outcomes: '["Up","Down"]', outcomePrices: '["0","1"]' }));
    const r = await fetchResolvedOutcome({ conditionId: COND, marketSlug: SLUG }, { fetchImpl });
    expect(r).toEqual({ outcome: 'DOWN', source: 'gamma_oracle' });
  });

  test('skips CLOB without a conditionId and still resolves via Gamma', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ closed: true, outcomes: '["Up","Down"]', outcomePrices: '["1","0"]' }));
    const r = await fetchResolvedOutcome({ conditionId: null, marketSlug: SLUG }, { fetchImpl });
    expect(r).toEqual({ outcome: 'UP', source: 'gamma_oracle' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('null when neither source has resolved', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ closed: false }));
    expect(await fetchResolvedOutcome({ conditionId: COND, marketSlug: SLUG }, { fetchImpl })).toBeNull();
  });
});
