import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getOpenOrders: vi.fn(),
  getTradeHistory: vi.fn(),
  cancelOrder: vi.fn(),
  cancelAllOrders: vi.fn(),
}));

vi.mock('../../logger.ts', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../clobClient.ts', () => ({
  getOpenOrders: (...args: any[]) => mocks.getOpenOrders(...args),
  getTradeHistory: (...args: any[]) => mocks.getTradeHistory(...args),
  cancelOrder: (...args: any[]) => mocks.cancelOrder(...args),
  cancelAllOrders: (...args: any[]) => mocks.cancelAllOrders(...args),
}));

import { checkPendingFill, clearPendingOrders, getFillTrackerStatus, isFillSizeWithinClip, trackOrderPlacement } from '../fillTracker.ts';
import { resetGhostGuardStats } from '../ghostGuard.ts';

describe('fillTracker + GhostGuard on-chain receipt verification', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    clearPendingOrders();
    resetGhostGuardStats();
    mocks.getOpenOrders.mockResolvedValue([]);
    mocks.cancelAllOrders.mockResolvedValue({});
  });

  afterEach(() => {
    clearPendingOrders();
    globalThis.fetch = realFetch;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('rejects a CLOB-reported fill whose Polygon receipt reverted (status=0x0) and triggers defensive cancel', async () => {
    const txHash = '0x' + 'c'.repeat(64);
    trackOrderPlacement('ord-ghost-1', {
      tokenId: 'tok-up-1',
      price: 0.60,
      size: 5,
      side: 'UP',
      confirmed: false,
      gtd: false,
      midPrice: 0.60,
    });

    mocks.getTradeHistory.mockResolvedValue([{
      asset_id: 'tok-up-1',
      timestamp: 1_700_000_001_000,
      price: '0.60',
      size: '5',
      transaction_hash: txHash,
    }]);

    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: { status: '0x0', blockNumber: '0x123' },
    }))) as typeof fetch;

    vi.advanceTimersByTime(6_000); // past FILL_VERIFY_FIRST_CHECK_MS (5s)
    const results = await checkPendingFill();

    expect(results).toHaveLength(1);
    expect(results![0]).toMatchObject({
      orderId: 'ord-ghost-1',
      filled: false,
      rejected: true,
      ghostFill: true,
      verified: true,
      txHash,
    });
    expect(mocks.cancelAllOrders).toHaveBeenCalledTimes(1);
    expect(getFillTrackerStatus().ghostFillCount).toBe(1);
  });

  it('confirms a fill only after Polygon receipt returns status=0x1', async () => {
    const txHash = '0x' + 'd'.repeat(64);
    trackOrderPlacement('ord-real-1', {
      tokenId: 'tok-dn-1',
      price: 0.58,
      size: 5,
      side: 'DOWN',
      confirmed: false,
      gtd: false,
      midPrice: 0.58,
    });

    mocks.getTradeHistory.mockResolvedValue([{
      asset_id: 'tok-dn-1',
      timestamp: 1_700_000_001_000,
      price: '0.58',
      size: '5',
      transaction_hash: txHash,
    }]);

    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: { status: '0x1', blockNumber: '0x456' },
    }))) as typeof fetch;

    vi.advanceTimersByTime(6_000);
    const results = await checkPendingFill();

    expect(results).toHaveLength(1);
    expect(results![0]).toMatchObject({
      orderId: 'ord-real-1',
      filled: true,
      rejected: false,
      verified: true,
      txHash,
    });
    expect(mocks.cancelAllOrders).not.toHaveBeenCalled();
  });

  it('flags fills whose size exceeds submitted clip (taker size misparse guard)', () => {
    expect(isFillSizeWithinClip(5, 5)).toBe(true);
    expect(isFillSizeWithinClip(5.2, 5)).toBe(true);
    expect(isFillSizeWithinClip(114, 5)).toBe(false);
  });
});
