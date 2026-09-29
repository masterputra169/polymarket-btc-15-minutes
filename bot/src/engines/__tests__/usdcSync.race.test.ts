/**
 * A queued USDC sync must not be applied after a trade moved the bankroll: the fetched
 * balance predates the trade, so applying it would hand the trade's cost back.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('../../logger.ts', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { scheduleUsdcCheck, applyPendingSync, invalidateSync, setReconcileCooldown } from '../usdcSync.ts';

let t = Date.now() + 10_000_000; // real-clock scale: the reconcile-cooldown guard compares with Date.now()
async function queueSyncOf(onChain: number, local: number) {
  t += 60_000; // beyond the 30 s fetch interval
  scheduleUsdcCheck({
    now: t, settlementCooldownActive: false, clientReady: true,
    fetchBalance: async () => ({ balance: onChain, allowance: 1, fetchedAt: t }),
    getBankroll: () => local, getCurrentPosition: () => null, getPendingCost: () => 0,
  });
  await new Promise(r => setTimeout(r, 0));
}

beforeEach(() => { invalidateSync(); setReconcileCooldown(-1); });

describe('applyPendingSync', () => {
  test('applies the queued balance when the bankroll has not moved', async () => {
    await queueSyncOf(90, 100);
    const set = vi.fn();
    applyPendingSync(() => 100, set);
    expect(set).toHaveBeenCalledWith(90);
  });

  test('drops it when a trade was recorded after the fetch', async () => {
    await queueSyncOf(90, 100);
    const set = vi.fn();
    applyPendingSync(() => 94 /* 100 − a $6 entry */, set);
    expect(set).not.toHaveBeenCalled();
  });
});
