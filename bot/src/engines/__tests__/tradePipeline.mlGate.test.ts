/**
 * Every ML gate in applyTradeFilters is skipped when the model is not loaded
 * (mlConfidence is null). The pipeline therefore refuses entries without ML unless
 * ALLOW_RULE_ONLY_TRADING=true — the rule engine was only validated together with the model.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../logger.ts', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../monitoring/notifier.ts', () => ({ notify: vi.fn(() => Promise.resolve()) }));
vi.mock('../signalStability.ts', () => ({ SIGNAL_CONFIRM_POLLS: 3 }));
vi.mock('../../config.ts', () => ({
  BOT_CONFIG: { dryRun: true, maxBetAmountUsd: 2.5, monteCarlo: { enabled: false }, metEngine: { enabled: false } },
}));

import { executeDirectionalTrade } from '../tradePipeline.ts';

const SLUG = 'btc-updown-15m-1788800000';
const args = (mlAvailable: boolean) => ({
  rec: { action: 'ENTER', side: 'UP', confidence: 'HIGH', phase: 'MID', reason: 'test' },
  betSide: 'UP', betMarketPrice: 0.6, betEnsembleProb: 0.8,
  betSizing: { betAmount: 3, kellyFraction: 0.1, riskLevel: 'MODERATE', expectedValue: 0.2, rationale: 'test' },
  edge: { edgeUp: 0.2, edgeDown: -0.2, bestEdge: 0.2, spreadPenaltyUp: 0, spreadPenaltyDown: 0 },
  ensembleUp: 0.8, timeAware: { adjustedUp: 0.75 },
  mlResult: mlAvailable
    ? { available: true, mlConfidence: 0.9, mlProbUp: 0.9, mlSide: 'UP' }
    : { available: false, mlConfidence: null, mlProbUp: null, mlSide: null },
  mlAgreesWithRules: true, regimeInfo: { regime: 'trending', confidence: 0.7 },
  poly: { tokens: { upTokenId: 'u', downTokenId: 'd' } }, marketSlug: SLUG, currentConditionId: 'c',
  priceToBeat: { value: 80000, source: 'chainlink_twap' }, lastPrice: 80010, timeLeftMin: 8,
  signalConfirmCount: 3, recentFlipCount: 0, tiltMarketsLeft: 0, tiltMlConfMin: 0.7,
  rsiNow: 55, rsiSlope: 1, macd: { hist: 1, line: 2 }, vwapDist: 0.001, vwapSlope: 0.1,
  bb: { percentB: 0.6, width: 0.01, squeeze: false }, atr: { atrPct: 0.1, atrRatio: 1 },
  stochRsi: { k: 60, d: 55 }, emaCross: { cross: 'bull', distancePct: 0.05 }, volDelta: { buyRatio: 0.55 },
  consec: { color: 'green', count: 2 }, delta1m: 5, delta3m: 12, orderbookSignal: { imbalance: 0.1 },
  orderbookUp: { spread: 0.01 }, orderbookDown: null, marketUp: 0.6, marketDown: 0.4, obFlow: null,
  smartFlowSignal: null, mcResult: null, dryRun: true,
});
const deps = () => ({
  updateConfirmation: vi.fn(), isSignalStable: vi.fn(() => true), getInstabilityReasons: vi.fn(() => []),
  applyTradeFilters: vi.fn(() => ({ pass: true, reasons: [], sessionQuality: 1 })),
  checkFlowAlignment: vi.fn(() => ({ signal: 'INSUFFICIENT_DATA', agrees: true })),
  validatePrice: vi.fn(() => ({ valid: true })), validateTrade: vi.fn(() => ({ valid: true })),
  getBankroll: vi.fn(() => 100), getAvailableBankroll: vi.fn(() => 100), getConsecutiveLosses: vi.fn(() => 0),
  hasOpenPosition: vi.fn(() => false), setPendingCost: vi.fn(), placeBuyOrder: vi.fn(),
  recordTrade: vi.fn(), confirmFill: vi.fn(), trackOrderPlacement: vi.fn(), recordTradeForMarket: vi.fn(),
  captureEntrySnapshot: vi.fn(), recordPrediction: vi.fn(), recordTradeTimestamp: vi.fn(), setEntryRegime: vi.fn(),
  notifyTrade: null, updateConditionalApproval: null, querySmartMoney: null,
});

beforeEach(() => { delete process.env.ALLOW_RULE_ONLY_TRADING; });
afterEach(() => { delete process.env.ALLOW_RULE_ONLY_TRADING; });

describe('ML availability gate', () => {
  test('blocks the entry when the model is not loaded', async () => {
    const d = deps();
    expect(await executeDirectionalTrade(args(false) as any, d as any)).toBe(false);
    expect(d.recordTrade).not.toHaveBeenCalled();
    expect(d.applyTradeFilters).not.toHaveBeenCalled();
  });

  test('ALLOW_RULE_ONLY_TRADING=true is the explicit opt-in', async () => {
    process.env.ALLOW_RULE_ONLY_TRADING = 'true';
    const d = deps();
    expect(await executeDirectionalTrade(args(false) as any, d as any)).toBe(true);
    expect(d.recordTrade).toHaveBeenCalledTimes(1);
  });

  test('control: with the model loaded the entry goes through', async () => {
    const d = deps();
    expect(await executeDirectionalTrade(args(true) as any, d as any)).toBe(true);
  });
});
