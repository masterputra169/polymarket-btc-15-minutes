/**
 * DRY_RUN must simulate the position, not just log it.
 *
 * Measured 2026-09-07: the dry-run branch of executeDirectionalTrade() logged
 * "[DRY RUN] Would BUY", recorded a feedback prediction and returned. No
 * position, no settlement, no journal row. Five days of dry run therefore
 * produced zero resolved trades — the bot could not be judged against the 52%
 * live benchmark because nothing was ever measured.
 *
 * Invariants under test:
 *   1. In dry run the pipeline records a position at the quoted price and size,
 *      confirms the (simulated) fill and captures the entry snapshot — the same
 *      hooks the live path uses, so settlement / cut-loss / journal run unchanged.
 *   2. No order ever reaches the CLOB in dry run.
 *   3. The live path is untouched: with dryRun=false the order is placed.
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
    maxBetAmountUsd: 2.5,
    monteCarlo: { enabled: false },
    metEngine: { enabled: false },
    rl: { enabled: false },
  },
}));

import { executeDirectionalTrade } from '../tradePipeline.ts';

const SLUG = 'btc-updown-15m-1788800000';

/** A signal that clears every gate: stable, filters pass, price valid. */
function signal(overrides: Record<string, any> = {}) {
  return {
    rec: { action: 'ENTER', side: 'UP', confidence: 'HIGH', phase: 'MID', reason: 'test' },
    betSide: 'UP', betMarketPrice: 0.6, betEnsembleProb: 0.8,
    betSizing: { betAmount: 3, kellyFraction: 0.1, riskLevel: 'MODERATE', expectedValue: 0.2, rationale: 'test' },
    edge: { edgeUp: 0.2, edgeDown: -0.2, bestEdge: 0.2, spreadPenaltyUp: 0, spreadPenaltyDown: 0 },
    ensembleUp: 0.8, timeAware: { adjustedUp: 0.75 },
    mlResult: { available: true, mlConfidence: 0.9, mlProbUp: 0.9, mlSide: 'UP' },
    mlAgreesWithRules: true,
    regimeInfo: { regime: 'trending', confidence: 0.7 },
    poly: { tokens: { upTokenId: 'tok-up', downTokenId: 'tok-down' } },
    marketSlug: SLUG, currentConditionId: 'cond-1',
    priceToBeat: { value: 80000, source: 'scheduled_ws' },
    lastPrice: 80010, timeLeftMin: 8,
    signalConfirmCount: 3, recentFlipCount: 0,
    tiltMarketsLeft: 0, tiltMlConfMin: 0.7,
    rsiNow: 55, rsiSlope: 1, macd: { hist: 1, line: 2 }, vwapDist: 0.001, vwapSlope: 0.1,
    bb: { percentB: 0.6, width: 0.01, squeeze: false }, atr: { atrPct: 0.1, atrRatio: 1.0 },
    stochRsi: { k: 60, d: 55 }, emaCross: { cross: 'bull', distancePct: 0.05 },
    volDelta: { buyRatio: 0.55 }, consec: { color: 'green', count: 2 },
    delta1m: 5, delta3m: 12,
    orderbookSignal: { imbalance: 0.1 }, orderbookUp: { spread: 0.01 },
    marketUp: 0.6, marketDown: 0.4, obFlow: null,
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
    getBankroll: vi.fn(() => 100),
    getAvailableBankroll: vi.fn(() => 100),
    getConsecutiveLosses: vi.fn(() => 0),
    hasOpenPosition: vi.fn(() => false),
    setPendingCost: vi.fn(),
    placeBuyOrder: vi.fn(async () => ({ orderId: 'ord-1', makingAmount: '3.6', takingAmount: '6' })),
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
    getRLScalar: null,
    ...overrides,
  };
}

beforeEach(() => { vi.clearAllMocks(); });

describe('executeDirectionalTrade in DRY_RUN', () => {
  test('records a simulated position at the quoted price instead of only logging', async () => {
    const deps = makeDeps();
    const executed = await executeDirectionalTrade(signal(), deps);

    expect(executed).toBe(true);
    // HIGH confidence bumps to the 6-share FOK minimum: 6 × 0.60 = $3.60.
    expect(deps.recordTrade).toHaveBeenCalledTimes(1);
    expect(deps.recordTrade).toHaveBeenCalledWith(expect.objectContaining({
      side: 'UP', tokenId: 'tok-up', conditionId: 'cond-1',
      price: 0.6, size: 6, marketSlug: SLUG, orderId: null, actualCost: 3.6,
    }));
    expect(deps.confirmFill).toHaveBeenCalledTimes(1);
    expect(deps.captureEntrySnapshot).toHaveBeenCalledWith(expect.objectContaining({
      side: 'UP', tokenPrice: 0.6, size: 6, cost: 3.6, marketSlug: SLUG,
      mlProbUp: 0.9, mlConfidence: 0.9, actualPrice: 0.6,
    }));
    // Same bookkeeping as a live fill, so the simulation obeys the same limits.
    expect(deps.recordTradeForMarket).toHaveBeenCalledWith(SLUG);
    expect(deps.recordTradeTimestamp).toHaveBeenCalledTimes(1);
    expect(deps.setEntryRegime).toHaveBeenCalledWith('trending');
    expect(deps.recordPrediction).toHaveBeenCalledTimes(1);
    // Reservation is released once the simulated fill is booked.
    const pendingCalls = deps.setPendingCost.mock.calls.map(c => c[0]);
    expect(pendingCalls[pendingCalls.length - 1]).toBe(0);
  });

  test('never sends an order to the CLOB in dry run', async () => {
    const deps = makeDeps();
    await executeDirectionalTrade(signal(), deps);
    expect(deps.placeBuyOrder).not.toHaveBeenCalled();
    expect(deps.trackOrderPlacement).not.toHaveBeenCalled();
  });

  test('live path still places the order (dryRun=false)', async () => {
    const deps = makeDeps();
    const executed = await executeDirectionalTrade(signal({ dryRun: false }), deps);
    expect(executed).toBe(true);
    expect(deps.placeBuyOrder).toHaveBeenCalledTimes(1);
    expect(deps.recordTrade).toHaveBeenCalledWith(expect.objectContaining({ orderId: 'ord-1' }));
    expect(deps.confirmFill).not.toHaveBeenCalled(); // live fills are confirmed by the fill tracker
  });
});

describe('entry snapshot carries the market conditionId', () => {
  test('so the fallback verifier can query the CLOB oracle by conditionId later', async () => {
    const deps = makeDeps();
    await executeDirectionalTrade(signal(), deps);
    expect(deps.captureEntrySnapshot).toHaveBeenCalledWith(expect.objectContaining({ conditionId: 'cond-1' }));
  });
});
