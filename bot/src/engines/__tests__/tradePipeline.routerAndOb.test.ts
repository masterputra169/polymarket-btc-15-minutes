/**
 * End-to-end tradePipeline wiring for:
 *   1. Forwarding orderbookSignal.imbalance into applyTradeFilters (Gate 20c).
 *   2. Routing qualified 45%-64% high-edge signals through routeOrder() to
 *      'maker_join' (LIMIT sim) when BOT_CONFIG.orderRouter.limitMlThreshold = 0.45.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.mock('../../logger.ts', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../monitoring/notifier.ts', () => ({ notify: vi.fn(() => Promise.resolve()) }));
vi.mock('../signalStability.ts', () => ({ SIGNAL_CONFIRM_POLLS: 3 }));
vi.mock('../../config.ts', () => ({
  BOT_CONFIG: {
    dryRun: true,
    maxBetAmountUsd: 2.1,
    monteCarlo: { enabled: false },
    metEngine: { enabled: false },
    rl: { enabled: false },
    limitOrder: {
      enabled: true,
      dryRunMakerSim: true,
      dryRunMakerFillRate: 1,
      minEntryPrice: 0.50,
      maxEntryPrice: 0.58,
      maxElapsedMin: 12,
    },
    orderRouter: {
      enabled: true,
      fokMlThreshold: 0.88,
      limitMlThreshold: 0.45,
      fokMaxPrice: 0.58,
      fokMaxPriceTrending: 0.68,
      cheapPriceThreshold: 0.52,
      cheapMlThreshold: 0.75,
      momentumRelThreshold: 0.0007,
      spreadNarrowThreshold: 0.03,
      spreadWideThreshold: 0.03,
      upgradeMLThreshold: 0.88,
      upgradeHoldSec: 60,
    },
  },
}));

import { executeDirectionalTrade } from '../tradePipeline.ts';

const SLUG = 'btc-updown-15m-1794712500';

function signal(overrides: Record<string, any> = {}) {
  return {
    rec: { action: 'ENTER', side: 'UP', confidence: 'HIGH', phase: 'MID', reason: 'test' },
    betSide: 'UP', betMarketPrice: 0.575, betEnsembleProb: 0.82,
    betSizing: { betAmount: 2.0, kellyFraction: 0.04, riskLevel: 'MODERATE', expectedValue: 0.24, rationale: 'test' },
    edge: { edgeUp: 0.244, edgeDown: -0.244, bestEdge: 0.244, spreadPenaltyUp: 0, spreadPenaltyDown: 0 },
    ensembleUp: 0.82, timeAware: { adjustedUp: 0.80 },
    mlResult: { available: true, mlConfidence: 0.48, mlProbUp: 0.74, mlSide: 'UP' },
    mlAgreesWithRules: true,
    regimeInfo: { regime: 'moderate', confidence: 0.7 },
    poly: { tokens: { upTokenId: 'tok-up', downTokenId: 'tok-down' } },
    marketSlug: SLUG, currentConditionId: 'cond-1',
    priceToBeat: { value: 95000, source: 'chainlink_twap' },
    lastPrice: 95040, timeLeftMin: 12.62,
    signalConfirmCount: 3, recentFlipCount: 0,
    tiltMarketsLeft: 0, tiltMlConfMin: null,
    rsiNow: 55, rsiSlope: 1, macd: { hist: 1, line: 2 }, vwapDist: 0.001, vwapSlope: 0.1,
    bb: { percentB: 0.6, width: 0.01, squeeze: false }, atr: { atrPct: 0.1, atrRatio: 1.0 },
    stochRsi: { k: 60, d: 55 }, emaCross: { cross: 'bull', distancePct: 0.05 },
    volDelta: { buyRatio: 0.55 }, consec: { color: 'green', count: 2 },
    delta1m: 0, delta3m: 12,
    orderbookSignal: { imbalance: -0.44 },
    orderbookUp: { bestBid: 0.57, bestAsk: 0.58, spread: 0.01 },
    orderbookDown: null,
    marketUp: 0.575, marketDown: 0.425, obFlow: null,
    smartFlowSignal: null, mcResult: null,
    dryRun: true,
    ...overrides,
  };
}

function makeDeps(overrides: Record<string, any> = {}) {
  return {
    updateConfirmation: vi.fn(),
    isSignalStable: vi.fn(() => true),
    getInstabilityReasons: vi.fn(() => []),
    applyTradeFilters: vi.fn(() => ({ pass: true, reasons: [], sessionQuality: 1.0 })),
    checkFlowAlignment: vi.fn(() => ({ signal: 'INSUFFICIENT_DATA', agrees: true })),
    validatePrice: vi.fn(() => ({ valid: true })),
    validateTrade: vi.fn(() => ({ valid: true })),
    getBankroll: vi.fn(() => 45.31),
    getAvailableBankroll: vi.fn(() => 45.31),
    getConsecutiveLosses: vi.fn(() => 0),
    hasOpenPosition: vi.fn(() => false),
    setPendingCost: vi.fn(),
    placeBuyOrder: vi.fn(async () => ({ orderId: 'ord-1', makingAmount: '2.0', takingAmount: '5' })),
    recordTrade: vi.fn(),
    confirmFill: vi.fn(),
    trackOrderPlacement: vi.fn(),
    recordTradeForMarket: vi.fn(),
    captureEntrySnapshot: vi.fn(),
    recordPrediction: vi.fn(),
    recordTradeTimestamp: vi.fn(),
    setEntryRegime: vi.fn(),
    notifyTrade: null,
    updateConditionalApproval: null,
    querySmartMoney: null,
    ...overrides,
  };
}

beforeEach(() => { vi.clearAllMocks(); });

describe('tradePipeline router ML floor & OB imbalance wiring', () => {
  test('forwards orderbookSignal.imbalance to applyTradeFilters and routes 48% ML high-edge to maker_join', async () => {
    const deps = makeDeps();
    const ok = await executeDirectionalTrade(signal(), deps);
    expect(ok).toBe(true);
    expect(deps.applyTradeFilters).toHaveBeenCalledWith(expect.objectContaining({
      orderbookImbalance: -0.44,
    }));
    expect(deps.captureEntrySnapshot).toHaveBeenCalledWith(expect.objectContaining({
      fillModel: 'maker_join',
      isMaker: true,
      mlConfidence: 0.48,
      orderbookImbalance: -0.44,
    }));
  });
});
