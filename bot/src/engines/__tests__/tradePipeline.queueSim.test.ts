import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../logger.ts', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../monitoring/notifier.ts', () => ({ notify: vi.fn(() => Promise.resolve()) }));
vi.mock('../signalStability.ts', () => ({ SIGNAL_CONFIRM_POLLS: 3 }));
vi.mock('../../config.ts', () => ({
  BOT_CONFIG: {
    dryRun: true,
    maxBetAmountUsd: 2.5,
    maxRunawaySlippage: 0.02,
    monteCarlo: { enabled: false },
    metEngine: { enabled: false },
    rl: { enabled: false },
    limitOrder: {
      enabled: true,
      minElapsedMin: 0.5,
      maxElapsedMin: 9,
      minEntryPrice: 0.50,
      maxEntryPrice: 0.62,
      maxUnfilledSec: 45,
      fokFallbackMinEdge: 0.05,
      fokFallbackMinMlConf: 0.32,
      dryRunMakerSim: true,
      dryRunMakerFillRate: 0.60,
      maxAttemptsPerMarket: 1,
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
      upgradeMLThreshold: 0.90,
      upgradeHoldSec: 60,
    },
  },
}));

import {
  executeDirectionalTrade,
  hasActiveDryRunMaker,
  resetDryRunMaker,
  stepDryRunMaker,
} from '../tradePipeline.ts';

const SLUG = 'btc-updown-15m-1795000000';

function baseSignal(overrides: Record<string, any> = {}) {
  return {
    rec: { action: 'ENTER', side: 'UP', confidence: 'HIGH', phase: 'MID', reason: 'test' },
    betSide: 'UP',
    betMarketPrice: 0.59,
    betEnsembleProb: 0.72,
    betSizing: { betAmount: 3.0, kellyFraction: 0.1, riskLevel: 'MODERATE', expectedValue: 0.13, rationale: 'test' },
    edge: { edgeUp: 0.13, edgeDown: -0.13, bestEdge: 0.13, spreadPenaltyUp: 0, spreadPenaltyDown: 0 },
    ensembleUp: 0.72,
    timeAware: { adjustedUp: 0.70 },
    mlResult: { available: true, mlConfidence: 0.55, mlProbUp: 0.775, mlSide: 'UP' },
    mlAgreesWithRules: true,
    regimeInfo: { regime: 'moderate', confidence: 0.7 },
    poly: { tokens: { upTokenId: 'tok-up', downTokenId: 'tok-down' } },
    marketSlug: SLUG,
    currentConditionId: 'cond-1',
    priceToBeat: { value: 65000, source: 'chainlink_twap' },
    lastPrice: 65025,
    settlePrice: 65025,
    timeLeftMin: 10, // elapsedMin = 5m -> routes to LIMIT when ask=0.59 & ML=0.55 < 0.88
    signalConfirmCount: 3,
    recentFlipCount: 0,
    tiltMarketsLeft: 0,
    tiltMlConfMin: 0.7,
    rsiNow: 55,
    rsiSlope: 1,
    macd: { hist: 1, line: 2 },
    vwapDist: 0.001,
    vwapSlope: 0.1,
    bb: { percentB: 0.6, width: 0.01, squeeze: false },
    atr: { atrPct: 0.1, atrRatio: 1.0 },
    stochRsi: { k: 60, d: 55 },
    emaCross: { cross: 'bull', distancePct: 0.05 },
    volDelta: { buyRatio: 0.55 },
    consec: { color: 'green', count: 2 },
    delta1m: 10,
    delta3m: 20,
    orderbookSignal: { imbalance: 0.1 },
    orderbookUp: { bestBid: 0.57, bestAsk: 0.59, spread: 0.02, bidSize: 20, bidLiquidity: 200, askLiquidity: 200 },
    orderbookDown: { bestBid: 0.41, bestAsk: 0.43, spread: 0.02, bidSize: 20, bidLiquidity: 200, askLiquidity: 200 },
    marketUp: 0.59,
    marketDown: 0.41,
    obFlow: null,
    smartFlowSignal: null,
    mcResult: null,
    dryRun: true,
    ...overrides,
  };
}

function makeDeps(nowRef: { now: number }, overrides: Record<string, any> = {}) {
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
    placeBuyOrder: vi.fn(),
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
    getLastBookQuoteMs: vi.fn(() => nowRef.now - 20),
    ...overrides,
  };
}

describe('tradePipeline DRY_RUN_QUEUE_SIM=true resting FIFO simulator', () => {
  const prevQueueEnv = process.env.DRY_RUN_QUEUE_SIM;
  const prevFixedEnv = process.env.FIXED_SHARE_SIZE;

  beforeEach(() => {
    resetDryRunMaker();
    process.env.DRY_RUN_QUEUE_SIM = 'true';
    process.env.FIXED_SHARE_SIZE = '5';
  });

  afterEach(() => {
    resetDryRunMaker();
    if (prevQueueEnv === undefined) delete process.env.DRY_RUN_QUEUE_SIM;
    else process.env.DRY_RUN_QUEUE_SIM = prevQueueEnv;
    if (prevFixedEnv === undefined) delete process.env.FIXED_SHARE_SIZE;
    else process.env.FIXED_SHARE_SIZE = prevFixedEnv;
  });

  test('rests maker bid first, then fills at join price when live prints clear queueAhead', async () => {
    const nowRef = { now: Date.now() };
    const deps = makeDeps(nowRef);
    const sig = baseSignal();

    const enteredAtPlace = await executeDirectionalTrade(sig, deps);
    expect(enteredAtPlace).toBe(false);
    expect(deps.recordTrade).not.toHaveBeenCalled();
    expect(hasActiveDryRunMaker(SLUG)).toBe(true);

    // Poll +5s: trade eats 15 of 20 queueAhead -> still RESTING
    const t1 = nowRef.now + 5_000;
    const step1 = stepDryRunMaker({
      marketSlug: SLUG,
      timeLeftMin: 9.9,
      lastPrice: 65025,
      priceToBeat: { value: 65000, source: 'chainlink_twap' },
      orderbookUp: sig.orderbookUp,
      orderbookDown: sig.orderbookDown,
      marketUp: 0.59,
      marketDown: 0.41,
      ensembleUp: 0.72,
      ensembleDown: 0.28,
      mlResult: sig.mlResult,
      regimeInfo: sig.regimeInfo,
      twapProbUp: 0.70,
      recentTrades: [{ t: nowRef.now + 2_000, seq: 1, token: 'up', side: 'SELL', price: 0.57, size: 15 }],
      lastBookQuoteMs: t1 - 50,
      nowMs: t1,
    });
    expect(step1).toEqual({ active: true, entered: false, deniedFokForSlug: null });
    expect(deps.recordTrade).not.toHaveBeenCalled();

    // Poll +10s: complementary DOWN BUY at 0.43 (= 1 - 0.57) consumes remaining 5 ahead + our 5 shares
    const t2 = nowRef.now + 10_000;
    const step2 = stepDryRunMaker({
      marketSlug: SLUG,
      timeLeftMin: 9.8,
      lastPrice: 65025,
      priceToBeat: { value: 65000, source: 'chainlink_twap' },
      orderbookUp: sig.orderbookUp,
      orderbookDown: sig.orderbookDown,
      marketUp: 0.59,
      marketDown: 0.41,
      ensembleUp: 0.72,
      ensembleDown: 0.28,
      mlResult: sig.mlResult,
      regimeInfo: sig.regimeInfo,
      twapProbUp: 0.70,
      recentTrades: [
        { t: nowRef.now + 2_000, seq: 1, token: 'up', side: 'SELL', price: 0.57, size: 15 },
        { t: nowRef.now + 8_000, seq: 2, token: 'down', side: 'BUY', price: 0.43, size: 10 },
      ],
      lastBookQuoteMs: t2 - 40,
      nowMs: t2,
    });
    expect(step2).toEqual({ active: false, entered: true, deniedFokForSlug: null, filledSide: 'UP' });
    expect(deps.recordTrade).toHaveBeenCalledTimes(1);
    expect(deps.recordTrade).toHaveBeenCalledWith(expect.objectContaining({
      side: 'UP',
      price: 0.57,
      size: 5,
      isMaker: true,
    }));
    expect(deps.captureEntrySnapshot).toHaveBeenCalledWith(expect.objectContaining({
      fillModel: 'maker_join',
      queueAheadShares: 20,
      queueRemainingAtFill: 0,
    }));
  });

  test('pulls resting bid without FOK chase when TWAP turns adverse, and blocks repeat attempt in same market', async () => {
    const nowRef = { now: Date.now() };
    const deps = makeDeps(nowRef);
    const sig = baseSignal();

    await executeDirectionalTrade(sig, deps);
    expect(hasActiveDryRunMaker(SLUG)).toBe(true);

    // twapProbUp collapses to 0.35 -> edge vs 0.57 bid = -22pp (< -12pp hardDeficit)
    const t1 = nowRef.now + 3_000;
    const step = stepDryRunMaker({
      marketSlug: SLUG,
      timeLeftMin: 9.9,
      lastPrice: 64980,
      priceToBeat: { value: 65000, source: 'chainlink_twap' },
      orderbookUp: sig.orderbookUp,
      orderbookDown: sig.orderbookDown,
      marketUp: 0.40,
      marketDown: 0.60,
      ensembleUp: 0.45,
      ensembleDown: 0.55,
      mlResult: sig.mlResult,
      regimeInfo: sig.regimeInfo,
      twapProbUp: 0.35,
      recentTrades: [],
      lastBookQuoteMs: t1 - 20,
      nowMs: t1,
    });
    expect(step).toEqual({ active: false, entered: false, deniedFokForSlug: SLUG });
    expect(hasActiveDryRunMaker()).toBe(false);
    expect(deps.recordTrade).not.toHaveBeenCalled();

    // Anti-loop maxAttemptsPerMarket=1: re-calling executeDirectionalTrade in same slug cannot place again
    const retry = await executeDirectionalTrade(sig, makeDeps({ now: t1 + 1_000 }));
    expect(retry).toBe(false);
    expect(hasActiveDryRunMaker()).toBe(false);
  });

  test('on timeout falls back to FOK at delayed live ask when edge survives and blocks when runaway >2c', async () => {
    const nowRef = { now: Date.now() };
    const deps = makeDeps(nowRef);
    const sig = baseSignal();

    await executeDirectionalTrade(sig, deps);
    const tTimeout = nowRef.now + 46_000;

    // Ask jumped +4c (0.59 -> 0.63 > +0.02 runaway cap): fallback blocked
    const blocked = stepDryRunMaker({
      marketSlug: SLUG,
      timeLeftMin: 9.2,
      lastPrice: 65040,
      priceToBeat: { value: 65000, source: 'chainlink_twap' },
      orderbookUp: { ...sig.orderbookUp, bestAsk: 0.63 },
      orderbookDown: sig.orderbookDown,
      marketUp: 0.63,
      marketDown: 0.37,
      ensembleUp: 0.72,
      ensembleDown: 0.28,
      mlResult: sig.mlResult,
      regimeInfo: sig.regimeInfo,
      twapProbUp: 0.72,
      recentTrades: [],
      lastBookQuoteMs: tTimeout - 30,
      nowMs: tTimeout,
    });
    expect(blocked).toEqual({ active: false, entered: false, deniedFokForSlug: SLUG });
    expect(deps.recordTrade).not.toHaveBeenCalled();

    // Fresh slug where ask stayed flat at 0.59 -> timeout fallback fills fok_after_maker_miss
    const slug2 = 'btc-updown-15m-1795000900';
    resetDryRunMaker();
    const deps2 = makeDeps(nowRef);
    const sig2 = baseSignal({ marketSlug: slug2 });
    await executeDirectionalTrade(sig2, deps2);
    const ok = stepDryRunMaker({
      marketSlug: slug2,
      timeLeftMin: 9.2,
      lastPrice: 65025,
      priceToBeat: { value: 65000, source: 'chainlink_twap' },
      orderbookUp: sig2.orderbookUp,
      orderbookDown: sig2.orderbookDown,
      marketUp: 0.59,
      marketDown: 0.41,
      ensembleUp: 0.72,
      ensembleDown: 0.28,
      mlResult: sig2.mlResult,
      regimeInfo: sig2.regimeInfo,
      twapProbUp: 0.72,
      recentTrades: [],
      lastBookQuoteMs: nowRef.now + 45_950,
      nowMs: nowRef.now + 46_000,
    });
    expect(ok).toEqual({ active: false, entered: true, deniedFokForSlug: null, filledSide: 'UP' });
    expect(deps2.recordTrade).toHaveBeenCalledTimes(1);
    expect(deps2.captureEntrySnapshot).toHaveBeenCalledWith(expect.objectContaining({
      fillModel: 'fok_after_maker_miss',
      isMaker: false,
    }));
  });
});
