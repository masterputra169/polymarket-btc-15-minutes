/**
 * Regression test for FIXED_SHARE_SIZE ordering in tradePipeline.ts.
 *
 * Production bug observed 2026-11-16 05:35 WIB: when FIXED_SHARE_SIZE=5 was set
 * and bankroll sat at $17.53, Kelly sized a passing high-edge trade to $0.30-$0.42
 * (< $0.50 guards.ts floor and < $0.55 token price -> 0 shares). Because validateTrade
 * and floor(betAmount/price) ran BEFORE FIXED_SHARE_SIZE, 63 qualifying polls failed.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

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
  },
}));

import { executeDirectionalTrade } from '../tradePipeline.ts';
import { validateTrade } from '../../safety/guards.ts';

const SLUG = 'btc-updown-15m-1794761100';

function makeSignal(overrides: Record<string, any> = {}) {
  return {
    rec: { action: 'ENTER', side: 'UP', confidence: 'HIGH', phase: 'MID', reason: 'test' },
    betSide: 'UP', betMarketPrice: 0.55, betEnsembleProb: 0.72,
    betSizing: {
      shouldBet: true,
      betAmount: 0.30, // sub-$0.50 Kelly output on a small bankroll
      kellyFraction: 0.017,
      riskLevel: 'LOW',
      expectedValue: 0.17,
      rationale: 'test',
    },
    edge: { edgeUp: 0.17, edgeDown: -0.17, bestEdge: 0.17, spreadPenaltyUp: 0, spreadPenaltyDown: 0 },
    ensembleUp: 0.72, timeAware: { adjustedUp: 0.65 },
    mlResult: { available: true, mlConfidence: 0.70, mlProbUp: 0.85, mlSide: 'UP' },
    mlAgreesWithRules: true,
    regimeInfo: { regime: 'moderate', confidence: 0.6 },
    poly: { tokens: { upTokenId: 'tok-up', downTokenId: 'tok-down' } },
    marketSlug: SLUG, currentConditionId: 'cond-1',
    priceToBeat: { value: 65000, source: 'chainlink_twap' },
    lastPrice: 65040, timeLeftMin: 8,
    signalConfirmCount: 3, recentFlipCount: 0,
    tiltMarketsLeft: 0, tiltMlConfMin: 0.7,
    rsiNow: 55, rsiSlope: 1, macd: { hist: 1, line: 2 }, vwapDist: 0.001, vwapSlope: 0.1,
    bb: { percentB: 0.6, width: 0.01, squeeze: false }, atr: { atrPct: 0.1, atrRatio: 1.0 },
    stochRsi: { k: 60, d: 55 }, emaCross: { cross: 'bull', distancePct: 0.05 },
    volDelta: { buyRatio: 0.55 }, consec: { color: 'green', count: 2 },
    delta1m: 5, delta3m: 12,
    orderbookSignal: { imbalance: 0.1 }, orderbookUp: { spread: 0.01, bestBid: 0.54, bestAsk: 0.55 }, orderbookDown: null,
    marketUp: 0.55, marketDown: 0.45, obFlow: null,
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
    validateTrade,
    getBankroll: vi.fn(() => 17.53),
    getAvailableBankroll: vi.fn(() => 17.53),
    getConsecutiveLosses: vi.fn(() => 2),
    hasOpenPosition: vi.fn(() => false),
    setPendingCost: vi.fn(),
    placeBuyOrder: vi.fn(async () => ({ orderId: 'ord-1' })),
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

describe('FIXED_SHARE_SIZE pre-validation ordering', () => {
  const prevFixed = process.env.FIXED_SHARE_SIZE;
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.FIXED_SHARE_SIZE = '5';
  });
  afterEach(() => {
    if (prevFixed === undefined) delete process.env.FIXED_SHARE_SIZE;
    else process.env.FIXED_SHARE_SIZE = prevFixed;
  });

  test('executes 5 shares even when Kelly betAmount is below $0.50 floor and 1-share price', async () => {
    const deps = makeDeps();
    const executed = await executeDirectionalTrade(makeSignal(), deps);

    expect(executed).toBe(true);
    expect(deps.recordTrade).toHaveBeenCalledTimes(1);
    expect(deps.recordTrade).toHaveBeenCalledWith(expect.objectContaining({
      size: 5,
      side: 'UP',
      marketSlug: SLUG,
    }));
  });

  test('still blocks when availableBankroll cannot cover fixed 5-share order cost', async () => {
    const deps = makeDeps({
      getBankroll: vi.fn(() => 2.0),
      getAvailableBankroll: vi.fn(() => 2.0),
    });
    // 5 * 0.55 = $2.75 > $2.00 bankroll
    const executed = await executeDirectionalTrade(makeSignal(), deps);
    expect(executed).toBe(false);
    expect(deps.recordTrade).not.toHaveBeenCalled();
  });

  test('still blocks when Kelly marks shouldBet=false', async () => {
    const deps = makeDeps();
    const sig = makeSignal({
      betSizing: { shouldBet: false, betAmount: 0, rationale: 'No edge' },
    });
    const executed = await executeDirectionalTrade(sig, deps);
    expect(executed).toBe(false);
    expect(deps.recordTrade).not.toHaveBeenCalled();
  });

  test('without FIXED_SHARE_SIZE, sub-$0.50 Kelly bet still fails validateTrade', async () => {
    delete process.env.FIXED_SHARE_SIZE;
    const deps = makeDeps();
    const executed = await executeDirectionalTrade(makeSignal(), deps);
    expect(executed).toBe(false);
    expect(deps.recordTrade).not.toHaveBeenCalled();
  });
});
