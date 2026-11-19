import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.mock('../../logger.ts', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../ml/modelProfiles.ts', () => ({
  getEffectiveLimitOrderConfig: () => ({
    enabled: true,
    minEntryPrice: 0.50,
    maxEntryPrice: 0.58,
    minRemainingEdge: 0.03,
    partialFillAcceptRatio: 0.60,
    expirationBufferSec: 120,
    maxUnfilledSec: 45,
    cancelAfterElapsedMin: 9.0,
    checkIntervalMs: 2000,
    postOnly: true,
  }),
  getEffectiveMaxBetAmountUsd: () => 5,
}));

import {
  ingestClobUserMessage,
  getUserOrderEvent,
  getClobUserWsHealth,
  resetClobUserWsForTest,
} from '../clobUserWs.ts';
import {
  placeLimitOrder,
  monitorLimitOrder,
  resetLimitOrderState,
} from '../../engines/limitOrderManager.ts';

describe('clobUserWs & real-time monitorLimitOrder integration', () => {
  beforeEach(() => {
    resetClobUserWsForTest();
    resetLimitOrderState();
  });

  test('parses order lifecycle (PLACEMENT -> partial UPDATE -> CANCELLATION) and ignores PONG', () => {
    const t0 = 1_795_000_000_000;
    ingestClobUserMessage('PONG', t0);
    expect(getClobUserWsHealth().parseErrors).toBe(0);

    ingestClobUserMessage(JSON.stringify({
      event_type: 'order',
      type: 'PLACEMENT',
      id: 'ord-1',
      asset_id: 'tok-up',
      side: 'BUY',
      price: '0.56',
      original_size: '10',
      size_matched: '0',
    }), t0 + 100);
    expect(getUserOrderEvent('ord-1')).toMatchObject({
      orderId: 'ord-1',
      status: 'OPEN',
      originalSize: 10,
      sizeMatched: 0,
      price: 0.56,
    });

    ingestClobUserMessage(JSON.stringify({
      event_type: 'order',
      type: 'UPDATE',
      id: 'ord-1',
      original_size: '10',
      size_matched: '6',
    }), t0 + 200);
    expect(getUserOrderEvent('ord-1')?.status).toBe('PARTIAL');

    ingestClobUserMessage(JSON.stringify({
      event_type: 'order',
      type: 'CANCELLATION',
      id: 'ord-1',
    }), t0 + 300);
    expect(getUserOrderEvent('ord-1')?.status).toBe('CANCELLED');
  });

  test('processes trade maker_orders and taker_order_id without downgrading MATCHED back to OPEN', () => {
    const t0 = 1_795_000_000_000;
    ingestClobUserMessage(JSON.stringify({
      event_type: 'order',
      type: 'PLACEMENT',
      id: 'ord-maker',
      price: '0.55',
      original_size: '8',
      size_matched: '0',
    }), t0);

    ingestClobUserMessage(JSON.stringify({
      event_type: 'trade',
      status: 'MATCHED',
      price: '0.55',
      size: '12',
      taker_order_id: 'ord-taker',
      transaction_hash: '0xabc',
      maker_orders: [{ order_id: 'ord-maker', matched_amount: '8', price: '0.55' }],
    }), t0 + 50);

    expect(getUserOrderEvent('ord-maker')).toMatchObject({
      status: 'MATCHED',
      sizeMatched: 8,
      txHash: '0xabc',
    });
    expect(getUserOrderEvent('ord-taker')).toMatchObject({
      status: 'MATCHED',
      sizeMatched: 12,
      txHash: '0xabc',
    });

    // Late stale OPEN/UPDATE frame cannot un-match a terminal MATCHED order
    ingestClobUserMessage(JSON.stringify({
      event_type: 'order',
      type: 'UPDATE',
      id: 'ord-maker',
      size_matched: '0',
    }), t0 + 100);
    expect(getUserOrderEvent('ord-maker')?.status).toBe('MATCHED');
  });

  test('monitorLimitOrder reacts immediately to WS MATCHED/CANCELLED/PARTIAL bypassing 8s REST grace', async () => {
    const slug = 'btc-updown-15m-1795000000';
    const deps = {
      placeLimitBuyOrder: vi.fn(async () => ({ orderId: 'ord-ws-1' })),
      setPendingCost: vi.fn(),
      getOrderById: vi.fn(async () => null),
      getOrderStatus: vi.fn(async () => ({ status: 'LIVE' })),
      getUserOrderEvent: (id: string) => getUserOrderEvent(id),
      cancelOrder: vi.fn(async () => ({})),
    };

    const placed = await placeLimitOrder({
      side: 'UP',
      targetPrice: 0.56,
      tokenId: 'tok-up',
      marketSlug: slug,
      conditionId: '0xcond',
      marketEndMs: Date.now() + 10 * 60_000,
      bankroll: 100,
      mlConfidence: 0.72,
      sessionQuality: 1.0,
    }, deps);
    expect(placed.placed).toBe(true);

    ingestClobUserMessage(JSON.stringify({
      event_type: 'order',
      type: 'UPDATE',
      id: 'ord-ws-1',
      price: '0.56',
      original_size: '8',
      size_matched: '8',
    }));

    const res = await monitorLimitOrder({
      mlConfidence: 0.72,
      mlSide: 'UP',
      ensembleProb: 0.70,
      sideProb: 0.70,
      btcPrice: 63_000,
      priceToBeat: 62_950,
      elapsedMin: 1.0,
      marketSlug: slug,
    }, deps);

    expect(res.action).toBe('FILLED');
    expect(res.detail).toBe('ws_user_matched');
    expect(res.fillData?.size).toBe(8);
    expect(deps.getOrderById).not.toHaveBeenCalled();

    // Cancelled path via WS
    resetLimitOrderState();
    resetClobUserWsForTest();
    deps.placeLimitBuyOrder.mockResolvedValueOnce({ orderId: 'ord-ws-2' });
    await placeLimitOrder({
      side: 'UP',
      targetPrice: 0.56,
      tokenId: 'tok-up',
      marketSlug: slug,
      conditionId: '0xcond',
      marketEndMs: Date.now() + 10 * 60_000,
      bankroll: 100,
      mlConfidence: 0.72,
      sessionQuality: 1.0,
    }, deps);
    ingestClobUserMessage(JSON.stringify({
      event_type: 'order',
      type: 'CANCELLATION',
      id: 'ord-ws-2',
    }));
    const cancelRes = await monitorLimitOrder({
      mlConfidence: 0.72,
      mlSide: 'UP',
      ensembleProb: 0.70,
      sideProb: 0.70,
      btcPrice: 63_000,
      priceToBeat: 62_950,
      elapsedMin: 1.0,
      marketSlug: slug,
    }, deps);
    expect(cancelRes.action).toBe('CANCEL_EXPIRED');
    expect(cancelRes.detail).toBe('ws_user_cancelled');
  });
});
