/**
 * Verify tradePipeline wiring for:
 * 1. Lead-lag 3s Binance impulse fast-entry confirmation (15 / 180 polls when aligned & edge >= 8%).
 * 2. Bwijn R4 300s taker buy ratio fast-entry confirmation (60 / 180 polls).
 * 3. Forwarding buyRatio300s & leadLagDirection into applyTradeFilters.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.mock('../../logger.ts', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../monitoring/notifier.ts', () => ({ notify: vi.fn(() => Promise.resolve()) }));
vi.mock('../signalStability.ts', () => ({ SIGNAL_CONFIRM_POLLS: 180 }));
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
      fokMlThreshold: 0.68,
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

function baseSignal(overrides: Record<string, any> = {}) {
  return {
    rec: { action: 'ENTER', side: 'UP', confidence: 'HIGH', phase: 'MID', reason: 'test' },
    betSide: 'UP', betMarketPrice: 0.54, betEnsembleProb: 0.70,
    betSizing: { betAmount: 2.0, kellyFraction: 0.04, riskLevel: 'MODERATE', expectedValue: 0.16, rationale: 'test' },
    edge: { edgeUp: 0.12, edgeDown: -0.12, bestEdge: 0.12, spreadPenaltyUp: 0, spreadPenaltyDown: 0 },
    ensembleUp: 0.70, timeAware: { adjustedUp: 0.68 },
    mlResult: { available: true, mlConfidence: 0.62, mlProbUp: 0.70, mlSide: 'UP' },
    mlAgreesWithRules: true,
    regimeInfo: { regime: 'moderate', confidence: 0.7 },
    poly: { tokens: { upTokenId: 'tok-up', downTokenId: 'tok-down' } },
    marketSlug: SLUG, currentConditionId: 'cond-1',
    priceToBeat: { value: 95000, source: 'chainlink_twap' },
    lastPrice: 95050, timeLeftMin: 8.5,
    signalConfirmCount: 15, recentFlipCount: 0,
    tiltMarketsLeft: 0, tiltMlConfMin: null,
    rsiNow: 58, rsiSlope: 1, macd: { hist: 1, line: 2 }, vwapDist: 0.001, vwapSlope: 0.1,
    bb: { percentB: 0.6, width: 0.01, squeeze: false }, atr: { atrPct: 0.1, atrRatio: 1.0 },
    stochRsi: { k: 60, d: 55 }, emaCross: { cross: 'bull', distancePct: 0.05 },
    volDelta: { buyRatio: 0.60, buyRatio300s: 0.78, buyRatio60s: 0.85, r4Bullish: true, r4Bearish: false },
    consec: { color: 'green', count: 2 },
    delta1m: 10, delta3m: 25,
    orderbookSignal: { imbalance: 0.2 },
    orderbookUp: { bestBid: 0.53, bestAsk: 0.54, spread: 0.01 },
    orderbookDown: null,
    marketUp: 0.54, marketDown: 0.46, obFlow: null,
    smartFlowSignal: null, mcResult: null,
    leadLagImpulse: { active: true, direction: 'UP', btcDelta3sUsd: 38, btcDelta3sPct: 0.04, marketMomentum: 0.002, clobQuietMs: 900 },
    dryRun: true,
    ...overrides,
  };
}

function makeDeps() {
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
  };
}

beforeEach(() => { vi.clearAllMocks(); });

describe('tradePipeline Quant Upgrades (R4 300s & 3s Lead-Lag)', () => {
  test('accelerates confirmation to 15/180 on aligned lead-lag impulse and forwards Gate 20d/20e inputs', async () => {
    const deps = makeDeps();
    const ok = await executeDirectionalTrade(baseSignal(), deps);
    expect(ok).toBe(true);
    expect(deps.isSignalStable).toHaveBeenCalledWith(15);
    expect(deps.applyTradeFilters).toHaveBeenCalledWith(expect.objectContaining({
      buyRatio300s: 0.78,
      leadLagDirection: 'UP',
    }));
  });

  test('accelerates confirmation to 60/180 on R4 300s taker surge without lead-lag impulse', async () => {
    const deps = makeDeps();
    const ok = await executeDirectionalTrade(baseSignal({ leadLagImpulse: null }), deps);
    expect(ok).toBe(true);
    expect(deps.isSignalStable).toHaveBeenCalledWith(60);
    expect(deps.applyTradeFilters).toHaveBeenCalledWith(expect.objectContaining({
      buyRatio300s: 0.78,
      leadLagDirection: null,
    }));
  });
});
