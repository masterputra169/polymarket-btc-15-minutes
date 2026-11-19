import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetEffectiveLimitOrderConfig = vi.fn();

vi.mock('fs', () => ({
  default: {
    existsSync: () => false,
    mkdirSync: () => undefined,
    readFileSync: () => '{}',
    writeFileSync: () => undefined,
    renameSync: () => undefined,
  },
  existsSync: () => false,
  mkdirSync: () => undefined,
  readFileSync: () => '{}',
  writeFileSync: () => undefined,
  renameSync: () => undefined,
}));

vi.mock('../../logger.ts', () => ({
  log: vi.fn(),
  logError: vi.fn(),
  warn: vi.fn(),
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../ml/modelProfiles.ts', () => ({
  getEffectiveLimitOrderConfig: () => mockGetEffectiveLimitOrderConfig(),
  getEffectiveMaxBetAmountUsd: () => 5,
}));

vi.mock('../executionTiming.ts', () => ({
  getSpreadTrend: () => 'STABLE',
}));

vi.mock('../../trading/positionTracker.ts', () => ({
  getPositionState: () => ({ bankroll: 100, currentPosition: null }),
  getBankroll: () => 100,
  canOpenPosition: () => ({ allowed: true }),
}));

vi.mock('../../monitoring/notifier.ts', () => ({
  notifyLimitOrder: vi.fn(),
}));

vi.mock('../../services/runtimeIntegrations.ts', () => ({
  recordJournalEvent: vi.fn(),
}));

import {
  computeTargetPrice,
  evaluateLimitEntry,
  monitorLimitOrder,
  placeLimitOrder,
  resetLimitAttempts,
  resetLimitOrderState,
} from '../limitOrderManager.ts';

const DEFAULT_CFG = {
  enabled: true,
  minMlConfidence: 0.30,
  minEntryPrice: 0.50,
  maxEntryPrice: 0.64,
  maxUnfilledSec: 15,
  minRemainingEdge: 0.03,
  maxSpread: 0.08,
  maxAttemptsPerMarket: 2,
  cancelCooldownSec: 60,
  priceDiscountPct: 0.12,
  minElapsedMin: 1,
  maxElapsedMin: 12,
  expirationBufferSec: 120,
  postOnly: true,
};

function makeSignal(overrides: Record<string, unknown> = {}) {
  return {
    mlConfidence: 0.30,
    mlSide: 'UP' as const,
    btcPrice: 100_050,
    priceToBeat: 100_000,
    bestBidUp: 0.58,
    bestBidDown: 0.40,
    bestAskUp: 0.60,
    bestAskDown: 0.42,
    hasPosition: false,
    isHalted: false,
    marketSlug: 'btc-updown-15m-test-hybrid',
    elapsedMin: 4,
    btcDelta1m: 10,
    spread: 0.02,
    ...overrides,
  };
}

describe('limitOrderManager Hybrid JOIN & edge math', () => {
  beforeEach(() => {
    resetLimitOrderState();
    mockGetEffectiveLimitOrderConfig.mockReturnValue({ ...DEFAULT_CFG });
  });

  it('computeTargetPrice joins bestBid via makerJoinPrice without discounting -12% or crossing bestAsk', () => {
    // Wide 4c spread: joins bestBid at 0.56 instead of 0.56 * 0.88 = 0.493 crash trap
    expect(computeTargetPrice(0.30, 0.56, 0.60)).toBe(0.56);
    // Tight 1c spread: joins bestBid cleanly without crossing bestAsk
    expect(computeTargetPrice(0.30, 0.59, 0.60)).toBe(0.59);
    // Clamps above maxEntryPrice (0.64) and below minEntryPrice (0.50)
    expect(computeTargetPrice(0.30, 0.67, 0.69)).toBe(0.64);
    expect(computeTargetPrice(0.30, 0.42, 0.45)).toBe(0.50);
  });

  it('evaluateLimitEntry uses sideProb = 0.5 + mlConfidence / 2 for limitEdge', () => {
    // mlConfidence = 0.30 -> sideProb = 0.65. At targetPrice = 0.58, edge = +7.0% >= 3.0% -> allowed
    const passRes = evaluateLimitEntry(makeSignal({
      mlConfidence: 0.30,
      bestBidUp: 0.58,
      bestAskUp: 0.60,
    }));
    expect(passRes.shouldPlace).toBe(true);
    expect(passRes.targetPrice).toBe(0.58);

    // mlConfidence = 0.30 -> sideProb = 0.65. At targetPrice = 0.63, edge = +2.0% < 3.0% -> rejected
    const failRes = evaluateLimitEntry(makeSignal({
      mlConfidence: 0.30,
      bestBidUp: 0.63,
      bestAskUp: 0.65,
    }));
    expect(failRes.shouldPlace).toBe(false);
    expect(failRes.reason).toBe('limit_edge_2.0%<3%');
  });

  it('placeLimitOrder passes postOnly: true by default and catches post-only book-cross rejections cleanly', async () => {
    const placeMock = vi.fn(async () => ({ orderId: 'ord-po-1' }));
    const setPending = vi.fn();

    const ok = await placeLimitOrder({
      side: 'UP',
      targetPrice: 0.56,
      tokenId: 'tok-up',
      marketSlug: 'btc-updown-15m-test-po-1',
      conditionId: '0xcond',
      marketEndMs: Date.now() + 10 * 60_000,
      bankroll: 100,
      mlConfidence: 0.75,
      sessionQuality: 1.0,
    }, { placeLimitBuyOrder: placeMock, setPendingCost: setPending });

    expect(ok.placed).toBe(true);
    expect(placeMock).toHaveBeenCalledWith(expect.objectContaining({ postOnly: true }));

    // Explicit postOnly: false override respected
    resetLimitOrderState();
    mockGetEffectiveLimitOrderConfig.mockReturnValue({ ...DEFAULT_CFG, postOnly: false });
    await placeLimitOrder({
      side: 'UP',
      targetPrice: 0.56,
      tokenId: 'tok-up',
      marketSlug: 'btc-updown-15m-test-po-2',
      conditionId: '0xcond',
      marketEndMs: Date.now() + 10 * 60_000,
      bankroll: 100,
      mlConfidence: 0.75,
      sessionQuality: 1.0,
    }, { placeLimitBuyOrder: placeMock, setPendingCost: setPending });
    expect(placeMock).toHaveBeenLastCalledWith(expect.objectContaining({ postOnly: false }));

    // postOnly book-cross rejection releases pending cost and returns post_only_rejected
    resetLimitOrderState();
    mockGetEffectiveLimitOrderConfig.mockReturnValue({ ...DEFAULT_CFG, postOnly: true });
    const crossMock = vi.fn(async () => {
      throw new Error('invalid post only order: crosses book');
    });
    const rej = await placeLimitOrder({
      side: 'UP',
      targetPrice: 0.56,
      tokenId: 'tok-up',
      marketSlug: 'btc-updown-15m-test-po-3',
      conditionId: '0xcond',
      marketEndMs: Date.now() + 10 * 60_000,
      bankroll: 100,
      mlConfidence: 0.75,
      sessionQuality: 1.0,
    }, { placeLimitBuyOrder: crossMock, setPendingCost: setPending });

    expect(rej).toEqual({ placed: false, orderId: null, reason: 'post_only_rejected' });
    expect(setPending).toHaveBeenLastCalledWith(0);
  });

  it('resets per-market attemptCount on slug change and clamps UserWS sub-0.5 partial fills to >= 1 share', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_795_000_000_000);
      resetLimitAttempts();
      resetLimitOrderState();
      mockGetEffectiveLimitOrderConfig.mockReturnValue({
        ...DEFAULT_CFG,
        maxAttemptsPerMarket: 2,
        minEvalPolls: 1,
        partialFillAcceptRatio: 0.60,
        maxUnfilledSec: 60,
        cancelAfterElapsedMin: 12,
      });

      const failPlace = vi.fn(async () => { throw new Error('network error'); });
      const setPending = vi.fn();

      // 1 failed attempt on slug-a
      await placeLimitOrder({
        side: 'UP', targetPrice: 0.56, tokenId: 'tok-up', marketSlug: 'slug-a',
        conditionId: '0xc1', marketEndMs: Date.now() + 10 * 60_000, bankroll: 100, mlConfidence: 0.75, sessionQuality: 1.0,
      }, { placeLimitBuyOrder: failPlace, setPendingCost: setPending });

      vi.advanceTimersByTime(31_000);

      // 1 failed attempt on new market slug-b should reset attemptCount to 1 (not increment to 2)
      await placeLimitOrder({
        side: 'UP', targetPrice: 0.56, tokenId: 'tok-up', marketSlug: 'slug-b',
        conditionId: '0xc2', marketEndMs: Date.now() + 10 * 60_000, bankroll: 100, mlConfidence: 0.75, sessionQuality: 1.0,
      }, { placeLimitBuyOrder: failPlace, setPendingCost: setPending });

      vi.advanceTimersByTime(31_000);

      const secondEval = evaluateLimitEntry(makeSignal({ marketSlug: 'slug-b', bestBidUp: 0.56, bestAskUp: 0.58 }));
      expect(secondEval.shouldPlace).toBe(true);

      // Place valid order then verify UserWS sub-0.5 partial fill clamps size >= 1
      await placeLimitOrder({
        side: 'UP', targetPrice: 0.56, tokenId: 'tok-up', marketSlug: 'slug-b',
        conditionId: '0xc2', marketEndMs: Date.now() + 10 * 60_000, bankroll: 100, mlConfidence: 0.75, sessionQuality: 1.0,
      }, { placeLimitBuyOrder: vi.fn(async () => ({ orderId: 'ord-sub-1' })), setPendingCost: setPending });

      const mon = await monitorLimitOrder({
        mlConfidence: 0.75, mlSide: 'UP', ensembleProb: 0.85, btcPrice: 100_050,
        priceToBeat: 100_000, elapsedMin: 4, marketSlug: 'slug-b', sideProb: 0.85,
      }, {
        getUserOrderEvent: () => ({ status: 'PARTIAL', originalSize: 0.5, sizeMatched: 0.4, price: 0.56 }),
        getOrderById: vi.fn(),
        cancelOrder: vi.fn(),
        setPendingCost: setPending,
      });
      expect(mon.action).toBe('PARTIAL_ACCEPT');
      expect(mon.fillData?.size).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
