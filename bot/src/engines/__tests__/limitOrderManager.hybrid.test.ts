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
});
