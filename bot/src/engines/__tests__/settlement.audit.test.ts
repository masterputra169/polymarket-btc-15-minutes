/**
 * Settlement audit fixes (2026-09-29).
 *
 * 1. A stale ARB position (bot restarted with an ARB from a past market) holds both
 *    tokens. It used to go through the oracle's UP/DOWN comparison, where side 'ARB'
 *    equals neither outcome, and was booked as a LOSS.
 * 2. With no oracle and no Binance price the settlement "BTC price" used to fall back
 *    to pos.price — the TOKEN's entry price (~0.6). Compared with a ~$80k price to
 *    beat that always reads DOWN, so every UP became a loss and every DOWN a win.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('../../logger.ts', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../config.ts', () => ({
  CONFIG: { gammaBaseUrl: 'https://gamma.test', clobBaseUrl: 'https://clob.test' },
  BOT_CONFIG: {},
}));
vi.mock('../../monitoring/notifier.ts', () => ({ notify: vi.fn(() => Promise.resolve()) }));

import { handleExpiry, handleStalePosition } from '../settlement.ts';

const SLUG = 'btc-updown-15m-1788768900';

function makeActions() {
  return {
    settleTrade: vi.fn(), unwindPosition: vi.fn(), invalidateUsdcSync: vi.fn(),
    clearEntrySnapshot: vi.fn(), writeJournalEntry: vi.fn(), recordLoss: vi.fn(),
    settlePrediction: vi.fn(), onFallbackSettled: vi.fn(), setLastSettled: vi.fn(),
  };
}

beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal('fetch', vi.fn()); });

describe('stale ARB position', () => {
  test('settles as a guaranteed WIN and never queries the oracle', async () => {
    const pos = {
      side: 'ARB', marketSlug: SLUG, conditionId: '0xc', price: 0.95, size: 10, cost: 9.5,
      arbUpCost: 4.6, arbDownCost: 4.9, settled: false,
    };
    const actions = makeActions();
    await handleStalePosition(
      { pos, currentMarketSlug: 'btc-updown-15m-1788769800', now: Date.now() },
      { getLastSettled: () => ({ slug: null, ts: 0 }), getOraclePrice: () => 80000, getBinancePrice: () => 80000 },
      actions,
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(actions.settleTrade).toHaveBeenCalledWith(true);
    expect(actions.recordLoss).not.toHaveBeenCalled();
    expect(actions.writeJournalEntry).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'WIN' }));
    expect(actions.setLastSettled).toHaveBeenCalledWith(SLUG, expect.any(Number));
  });
});

describe('no BTC price at all at settlement', () => {
  test('never compares the token price with the price to beat', async () => {
    const pos = { side: 'UP', marketSlug: SLUG, conditionId: null, price: 0.6, size: 5, cost: 3, settled: false };
    const actions = makeActions();
    await handleExpiry(
      { pos, currentMarketSlug: SLUG, currentConditionId: null, priceToBeat: { value: 80000, slug: SLUG }, now: Date.now() },
      { getLastSettled: () => ({ slug: null, ts: 0 }), setLastSettled: vi.fn(), getOraclePrice: () => null, getBinancePrice: () => null },
      actions,
      { getCloseTwap: async () => null },
    );
    // Booked 'unknown' (provisional, re-verified later) — not a fabricated price_fallback verdict.
    expect(actions.writeJournalEntry).toHaveBeenCalledWith(expect.objectContaining({
      exitData: expect.objectContaining({ source: 'unknown', priceSource: 'none' }),
    }));
    expect(actions.onFallbackSettled).toHaveBeenCalled();
  });

  test('control: a real close TWAP still decides an UP win', async () => {
    const pos = { side: 'UP', marketSlug: SLUG, conditionId: null, price: 0.6, size: 5, cost: 3, settled: false };
    const actions = makeActions();
    await handleExpiry(
      { pos, currentMarketSlug: SLUG, currentConditionId: null, priceToBeat: { value: 80000, slug: SLUG }, now: Date.now() },
      { getLastSettled: () => ({ slug: null, ts: 0 }), setLastSettled: vi.fn(), getOraclePrice: () => null, getBinancePrice: () => null },
      actions,
      { getCloseTwap: async () => 80010 },
    );
    expect(actions.settleTrade).toHaveBeenCalledWith(true);
    expect(actions.writeJournalEntry).toHaveBeenCalledWith(expect.objectContaining({
      exitData: expect.objectContaining({ source: 'price_fallback', outcome: 'UP' }),
    }));
  });
});
