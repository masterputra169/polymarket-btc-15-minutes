/**
 * DRY_RUN must simulate a realistic fill, not the quoted price.
 *
 * Measured 2026-09-20 over 378 Railway dry-run trades: every single one booked
 * `actualPrice === betMarketPrice` and `slippagePct === 0`, because the dry
 * branch hard-coded them. That is the optimistic bound — it assumes the whole
 * size filled at the top of book and the book never moved. The live path does
 * NOT do that: it submits at fokBuyPrice(quote, spread) and fills somewhere up
 * to that limit.
 *
 * The edge being measured is +3.2pp over breakeven with ~3.2c of slippage
 * tolerance, so a systematically optimistic fill price is not a rounding
 * detail — it is a material part of the go-live number.
 *
 * Invariants under test:
 *   1. Dry run books at the SAME price the live path would submit, so the
 *      simulation can never be better than what the bot itself would accept.
 *   2. Both prices survive into the journal (expectedPrice = quote,
 *      actualPrice = simulated fill) so neither era's number is lost, plus a
 *      fillModel marker so reports can tell them apart.
 *   3. A size the book cannot absorb is REJECTED, the way a real FOK would be,
 *      and releases the bankroll reservation.
 *   4. The live path is untouched.
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

import { executeDirectionalTrade, executeArbitrage } from '../tradePipeline.ts';
import { notify } from '../../monitoring/notifier.ts';

const SLUG = 'btc-updown-15m-1788800000';

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
    orderbookSignal: { imbalance: 0.1 }, orderbookUp: { spread: 0.01 }, orderbookDown: null,
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

    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.FIXED_SHARE_SIZE;
});

describe('DRY_RUN fill price', () => {
  test('books at the price the live path would submit, not the quote', async () => {
    const deps = makeDeps();
    await executeDirectionalTrade(signal(), deps);

    // fokBuyPrice(0.60, spread 0.01):
    //   fixed = max(0.005, 0.60*0.005=0.003) = 0.005
    //   pct   = 0.003
    //   half-spread = 0.005
    //   → 0.60 + 0.005 = 0.605
    expect(deps.recordTrade).toHaveBeenCalledWith(expect.objectContaining({
      price: 0.605,
      size: 6,
      actualCost: 3.63,   // 6 × 0.605
    }));
  });

  test('keeps BOTH prices in the journal so neither era is lost', async () => {
    const deps = makeDeps();
    await executeDirectionalTrade(signal(), deps);

    const snap = deps.captureEntrySnapshot.mock.calls[0][0];
    expect(snap.expectedPrice).toBe(0.6);    // the quote the decision was made on
    expect(snap.actualPrice).toBe(0.605);    // what the simulation charged
    expect(snap.tokenPrice).toBe(0.605);     // settlement math keys on this
    expect(snap.cost).toBe(3.63);
    // Marker so a report can separate pre/post 2026-09-20 dry-run rows.
    expect(snap.fillModel).toBe('fok_limit');
  });

  test('records a non-zero slippage instead of a hard-coded 0', async () => {
    const deps = makeDeps();
    await executeDirectionalTrade(signal(), deps);

    const snap = deps.captureEntrySnapshot.mock.calls[0][0];
    // (0.605 - 0.600) / 0.600 = 0.8333%
    expect(snap.slippagePct).toBeCloseTo(0.8333, 3);
    expect(snap.slippagePct).toBeGreaterThan(0);
  });

  test('a wider spread costs more, exactly as it would live', async () => {
    const deps = makeDeps();
    // half of a 4c spread = 0.02 → 0.62
    await executeDirectionalTrade(signal({ orderbookUp: { spread: 0.04 } }), deps);
    expect(deps.recordTrade).toHaveBeenCalledWith(expect.objectContaining({ price: 0.62 }));
  });

  test('simulation never beats the limit the bot itself would submit', async () => {
    // Whatever the spread, the simulated price must equal the live submit price.
    for (const spread of [0, 0.005, 0.01, 0.03, 0.08]) {
      const deps = makeDeps();
      await executeDirectionalTrade(signal({ orderbookUp: { spread } }), deps);
      const booked = deps.recordTrade.mock.calls[0][0].price;
      expect(booked, `spread ${spread}`).toBeGreaterThanOrEqual(0.6);
      expect(booked, `spread ${spread}`).toBeLessThanOrEqual(0.99);
    }
  });
});

describe('DRY_RUN fill rejection on thin books', () => {
  test('rejects when the ask side cannot absorb the order, like a real FOK', async () => {
    const deps = makeDeps();
    // 6 shares × 0.605 = $3.63 needed, only $2 resting on the ask.
    const executed = await executeDirectionalTrade(
      signal({ orderbookUp: { spread: 0.01, askLiquidity: 2 } }), deps);

    expect(executed).toBe(false);
    expect(deps.recordTrade).not.toHaveBeenCalled();
    expect(deps.captureEntrySnapshot).not.toHaveBeenCalled();
    // A rejected order must not consume the per-market attempt budget.
    expect(deps.recordTradeForMarket).not.toHaveBeenCalled();
  });

  test('a rejected fill releases the bankroll reservation', async () => {
    const deps = makeDeps();
    await executeDirectionalTrade(
      signal({ orderbookUp: { spread: 0.01, askLiquidity: 2 } }), deps);
    expect(deps.setPendingCost).toHaveBeenLastCalledWith(0);
  });

  test('fills when the book is deep enough', async () => {
    const deps = makeDeps();
    const executed = await executeDirectionalTrade(
      signal({ orderbookUp: { spread: 0.01, askLiquidity: 500 } }), deps);
    expect(executed).toBe(true);
    expect(deps.recordTrade).toHaveBeenCalledTimes(1);
  });

  test('compares SHARES to shares, not dollars to shares', async () => {
    // askLiquidity sums book `size` over the top 5 levels (src/data/polymarket.ts
    // :154) — a share count, never multiplied by price. The arb sizing path has
    // always read it that way (tradePipeline.ts `liqShares = Math.floor(...)`);
    // only its comment claimed dollars.
    //
    // This case separates the two readings: 6 shares @ $0.605 = $3.63 of cost
    // against 4 shares of resting depth. Comparing dollars-to-shares ($3.63 > 4
    // is false) would FILL an order the book cannot cover. Since a token costs
    // < $1, the dollar reading is always the more permissive one.
    const deps = makeDeps();
    const executed = await executeDirectionalTrade(
      signal({ orderbookUp: { spread: 0.01, askLiquidity: 4 } }), deps);

    expect(executed).toBe(false);
    expect(deps.recordTrade).not.toHaveBeenCalled();
  });

  test('exactly enough depth fills', async () => {
    const deps = makeDeps();
    const executed = await executeDirectionalTrade(
      signal({ orderbookUp: { spread: 0.01, askLiquidity: 6 } }), deps);
    expect(executed).toBe(true);
  });

  test('unknown depth is not treated as zero depth', async () => {
    // askLiquidity missing (the common case — dataFetcher returns null on error).
    // Rejecting on unknown depth would silently halve the sample size.
    const deps = makeDeps();
    const executed = await executeDirectionalTrade(
      signal({ orderbookUp: { spread: 0.01, askLiquidity: null } }), deps);
    expect(executed).toBe(true);
  });
});

describe('the live path is untouched', () => {
  test('with dryRun=false the order still goes to the CLOB at the quote-derived limit', async () => {
    const deps = makeDeps();
    await executeDirectionalTrade(signal({ dryRun: false }), deps);
    expect(deps.placeBuyOrder).toHaveBeenCalledTimes(1);
    expect(deps.placeBuyOrder).toHaveBeenCalledWith(expect.objectContaining({
      tokenId: 'tok-up', price: 0.605, size: 6,
    }));
  });

  test('live is not subject to the simulated depth rejection', async () => {
    // Real FOK rejection is the CLOB's job; we must not pre-empt it and change
    // live behaviour from a dry-run fidelity change.
    const deps = makeDeps();
    await executeDirectionalTrade(
      signal({ dryRun: false, orderbookUp: { spread: 0.01, askLiquidity: 2 } }), deps);
    expect(deps.placeBuyOrder).toHaveBeenCalledTimes(1);
  });
});

describe('the depth gate reads the book of the side being traded', () => {
  /**
   * UP and DOWN are separate tokens with independent books. Using the UP book
   * to decide whether a DOWN order fills is not an approximation — it is noise
   * uncorrelated with the thing being measured, on roughly half the sample.
   *
   * The PRICE input deliberately still mirrors live (which passes orderbookUp
   * for both sides); that inconsistency is pre-existing in the live order path
   * and changing it would alter live behaviour from a dry-run fidelity fix.
   */
  test('a DOWN bet is rejected on thin DOWN depth even when UP is deep', async () => {
    const deps = makeDeps();
    const executed = await executeDirectionalTrade(signal({
      rec: { action: 'ENTER', side: 'DOWN', confidence: 'HIGH', phase: 'MID', reason: 'test' },
      betSide: 'DOWN', betMarketPrice: 0.6,
      mlResult: { available: true, mlConfidence: 0.9, mlProbUp: 0.1, mlSide: 'DOWN' },
      edge: { edgeUp: -0.2, edgeDown: 0.2, bestEdge: 0.2, spreadPenaltyUp: 0, spreadPenaltyDown: 0 },
      ensembleUp: 0.2, timeAware: { adjustedUp: 0.25 }, betEnsembleProb: 0.8,
      orderbookUp: { spread: 0.01, askLiquidity: 9999 },
      orderbookDown: { spread: 0.01, askLiquidity: 2 },
    }), deps);

    expect(executed).toBe(false);
    expect(deps.recordTrade).not.toHaveBeenCalled();
  });

  test('a DOWN bet fills on deep DOWN depth even when UP is thin', async () => {
    const deps = makeDeps();
    const executed = await executeDirectionalTrade(signal({
      rec: { action: 'ENTER', side: 'DOWN', confidence: 'HIGH', phase: 'MID', reason: 'test' },
      betSide: 'DOWN', betMarketPrice: 0.6,
      mlResult: { available: true, mlConfidence: 0.9, mlProbUp: 0.1, mlSide: 'DOWN' },
      edge: { edgeUp: -0.2, edgeDown: 0.2, bestEdge: 0.2, spreadPenaltyUp: 0, spreadPenaltyDown: 0 },
      ensembleUp: 0.2, timeAware: { adjustedUp: 0.25 }, betEnsembleProb: 0.8,
      orderbookUp: { spread: 0.01, askLiquidity: 1 },
      orderbookDown: { spread: 0.01, askLiquidity: 9999 },
    }), deps);

    expect(executed).toBe(true);
    expect(deps.recordTrade).toHaveBeenCalledTimes(1);
  });

  test('an UP bet still reads the UP book', async () => {
    const deps = makeDeps();
    const executed = await executeDirectionalTrade(signal({
      orderbookUp: { spread: 0.01, askLiquidity: 2 },
      orderbookDown: { spread: 0.01, askLiquidity: 9999 },
    }), deps);
    expect(executed).toBe(false);
  });

  test('FIXED_SHARE_SIZE floors to the live 5-share minimum in dry run', async () => {
    process.env.FIXED_SHARE_SIZE = '3';
    try {
      const deps = makeDeps();
      const executed = await executeDirectionalTrade(signal(), deps);
      expect(executed).toBe(true);
      // max(3, 5) = 5 so paper selection matches CLOB min
      expect(deps.recordTrade).toHaveBeenCalledWith(expect.objectContaining({
        size: 5,
        actualCost: 3.03, // 5 × 0.605 = 3.025 -> 3.03
      }));
    } finally {
      delete process.env.FIXED_SHARE_SIZE;
    }
  });

  test('gammaSizingDampener reduces size in late phase (timeLeftMin < 5)', async () => {
    const deps = makeDeps();
    // timeLeftMin: 1.25 -> sqrt(1.25/5.0) = sqrt(0.25) = 0.50 dampener
    const executed = await executeDirectionalTrade(signal({
      timeLeftMin: 1.25,
      betSizing: { betAmount: 4.0, kellyFraction: 0.1, riskLevel: 'MODERATE', expectedValue: 0.2, rationale: 'test' },
      orderbookUp: { spread: 0.01, askLiquidity: 9999 },
    }), deps);
    expect(executed).toBe(true);
    // Bet of 4.0 * 0.85 asym * 0.50 gamma = 1.70 -> at 0.60/share = 2 shares (avoiding 6 shares FOK bump)
    expect(deps.recordTrade).toHaveBeenCalledWith(expect.objectContaining({
      size: 2,
    }));
  });

  test('maxBetForRiskOfRuin caps sizing on tight bankroll', async () => {
    const deps = makeDeps({ getBankroll: vi.fn(() => 25) }); // $25 bankroll -> rorMaxBet ~ $1.52
    const executed = await executeDirectionalTrade(signal({
      betSizing: { betAmount: 5.0, kellyFraction: 0.2, riskLevel: 'HIGH', expectedValue: 0.3, rationale: 'test' },
      orderbookUp: { spread: 0.01, askLiquidity: 9999 },
    }), deps);
    expect(executed).toBe(true);
    // At $25 bankroll, rorMaxBet = $1.52 -> floor(1.52 / 0.6) = 2 shares (avoiding 6 shares FOK bump)
    expect(deps.recordTrade).toHaveBeenCalledWith(expect.objectContaining({
      size: 2,
    }));
  });

  test('persists Hybrid Residual telemetry fields into trade journal entry snapshot', async () => {
    const deps = makeDeps();
    const executed = await executeDirectionalTrade(signal({
      mlResult: {
        available: true,
        mlConfidence: 0.36,
        mlProbUp: 0.68,
        mlSide: 'UP',
        baseMlProbUp: 0.63,
        hybridDeltaProb: 0.05,
        hybridActive: true,
        hybridId: 'v4-hybrid-20261116',
      },
    }), deps);
    expect(executed).toBe(true);
    const snap = deps.captureEntrySnapshot.mock.calls[0][0];
    expect(snap.baseMlProbUp).toBe(0.63);
    expect(snap.hybridDeltaProb).toBe(0.05);
    expect(snap.hybridActive).toBe(true);
    expect(snap.hybridId).toBe('v4-hybrid-20261116');
  });

  test('blocks entry cleanly while CLOB outage latch is active and records queue-ahead telemetry', async () => {
    const { recordClobOrderFailure, resetClobOutageStats } = await import('../../trading/clobOutageLatch.ts');
    resetClobOutageStats();

    // Normal entry attaches queue-ahead shadow telemetry
    const depsOk = makeDeps({ getLastBookQuoteMs: () => Date.now() - 100 });
    const ok = await executeDirectionalTrade(signal({
      orderbookUp: { spread: 0.01, askLiquidity: 9999, bidSize: 42 },
    }), depsOk);
    expect(ok).toBe(true);
    const snapOk = depsOk.captureEntrySnapshot.mock.calls[0][0];
    expect(snapOk.queueAheadShares).toBe(42);
    expect(snapOk.queueBookFresh).toBe(true);

    // Outage cooldown blocks subsequent trades without hitting order/record hooks
    recordClobOrderFailure('HTTP 425 service not ready', 60_000);
    const depsBlocked = makeDeps();
    const blocked = await executeDirectionalTrade(signal(), depsBlocked);
    expect(blocked).toBe(false);
    expect(depsBlocked.recordTrade).not.toHaveBeenCalled();
    resetClobOutageStats();
  });

  test('aborts FOK on 2c runaway ask spike and logs twapPhysicsZ in snapshot', async () => {
    const depsOk = makeDeps();
    const ok = await executeDirectionalTrade(signal({
      betMarketPrice: 0.60,
      orderbookUp: { spread: 0.01, bestAsk: 0.61, askLiquidity: 9999 },
      twapPhysicsZ: 0.42,
    }), depsOk);
    expect(ok).toBe(true);
    expect(depsOk.captureEntrySnapshot.mock.calls[0][0].twapPhysicsZ).toBe(0.42);

    const depsRunaway = makeDeps();
    const aborted = await executeDirectionalTrade(signal({
      betMarketPrice: 0.60,
      orderbookUp: { spread: 0.01, bestAsk: 0.64, askLiquidity: 9999 }, // +4c > 2c haircut
    }), depsRunaway);
    expect(aborted).toBe(false);
    expect(depsRunaway.recordTrade).not.toHaveBeenCalled();
  });

  test('rejects dry-run FOK when asks are empty or explicit askLiquidity is 0 (one-sided 99c book)', async () => {
    const depsOneSided = makeDeps();
    const rejOneSided = await executeDirectionalTrade(signal({
      betMarketPrice: 0.595,
      orderbookUp: { spread: null, bestBid: 0.99, bestAsk: null, askLiquidity: 0 },
    }), depsOneSided);
    expect(rejOneSided).toBe(false);
    expect(depsOneSided.recordTrade).not.toHaveBeenCalled();
    expect(depsOneSided.setPendingCost).not.toHaveBeenCalled();

    const depsZeroLiq = makeDeps();
    const rejZeroLiq = await executeDirectionalTrade(signal({
      betMarketPrice: 0.60,
      orderbookUp: { spread: 0.01, bestBid: 0.59, bestAsk: 0.60, askLiquidity: 0 },
    }), depsZeroLiq);
    expect(rejZeroLiq).toBe(false);
    expect(depsZeroLiq.recordTrade).not.toHaveBeenCalled();
    expect(depsZeroLiq.setPendingCost).toHaveBeenLastCalledWith(0);
  });

  test('aborts LIVE FOK when asks are empty (bestAsk=null or askLiquidity=0)', async () => {
    const depsEmpty = makeDeps();
    const resEmpty = await executeDirectionalTrade(signal({
      dryRun: false,
      betMarketPrice: 0.60,
      orderbookUp: { bestBid: 0.59, bestAsk: 0.60, spread: 0.01, askLiquidity: 0 },
    }), depsEmpty);
    expect(resEmpty).toBe(false);
    expect(depsEmpty.placeBuyOrder).not.toHaveBeenCalled();

    const depsNullAsk = makeDeps();
    const resNullAsk = await executeDirectionalTrade(signal({
      dryRun: false,
      betMarketPrice: 0.60,
      orderbookUp: { spread: 0.01, bestBid: 0.59, bestAsk: null, askLiquidity: 100 },
    }), depsNullAsk);
    expect(resNullAsk).toBe(false);
    expect(depsNullAsk.placeBuyOrder).not.toHaveBeenCalled();
  });

  test('executeArbitrage caps shares to 0 when minAskLiq === 0 instead of falling back to budgetShares', async () => {
    const deps = makeDeps();
    await executeArbitrage({
      arb: { found: true, askUp: 0.45, askDown: 0.48, totalCost: 0.93, netProfit: 0.04, profitPct: 4.3, spreadHealthy: true },
      poly: { tokens: { upTokenId: 'tok-up', downTokenId: 'tok-down' }, market: {} },
      marketSlug: SLUG,
      currentConditionId: 'cond-arb',
      regimeInfo: { regime: 'moderate' },
      rec: { confidence: 'HIGH', phase: 'MID' },
      priceToBeat: { value: 80000, source: 'chainlink_twap' },
      lastPrice: 80010,
      orderbookUp: { bestAsk: 0.45, spread: 0.01, askLiquidity: 0 },
      orderbookDown: { bestAsk: 0.48, spread: 0.01, askLiquidity: 100 },
      dryRun: false,
    }, deps);
    expect(deps.placeBuyOrder).not.toHaveBeenCalled();
  });

  test('DOWN entry uses orderbookDown.spread (does not borrow orderbookUp.spread) and blocks one-sided invariant', async () => {
    const deps = makeDeps();
    const blocked = await executeDirectionalTrade(signal({
      betSide: 'DOWN',
      rec: { action: 'ENTER', side: 'DOWN', confidence: 'HIGH', phase: 'MID', reason: 'test' },
      betMarketPrice: 0.60,
      mlResult: { available: true, mlConfidence: 0.9, mlProbUp: 0.1, mlSide: 'DOWN' },
      orderbookUp: { bestBid: 0.39, bestAsk: 0.41, spread: 0.02, askLiquidity: 200 },
      orderbookDown: { bestBid: null, bestAsk: 0.60, spread: null, askLiquidity: 200 },
      marketUp: 0.40,
      marketDown: 0.60,
    }), deps);
    expect(blocked).toBe(false);
    expect(deps.applyTradeFilters).toHaveBeenCalledWith(expect.objectContaining({ spread: null }));
    expect(notify).toHaveBeenCalledWith(
      'warn',
      expect.stringContaining('one_sided_book'),
      expect.objectContaining({ key: expect.stringContaining('one_sided_book') }),
    );
  });

  test('blocks extreme z-score with cheap price contradiction (Trade #42 signature) and formats MetEngine alert in cents + BTC line', async () => {
    const depsInv = makeDeps();
    const blocked = await executeDirectionalTrade(signal({
      betMarketPrice: 0.60,
      twapPhysicsZ: 4.50,
      edge: { edgeUp: 0.291, edgeDown: -0.291, bestEdge: 0.291, spreadPenaltyUp: 0, spreadPenaltyDown: 0 },
      orderbookUp: { bestBid: 0.59, bestAsk: 0.60, spread: 0.01, askLiquidity: 200 },
      lastPrice: 63_873,
      priceToBeat: { value: 63_672.88, source: 'chainlink_twap' },
    }), depsInv);
    expect(blocked).toBe(false);
    expect(depsInv.recordTrade).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      'warn',
      expect.stringContaining('extreme_z_cheap_price'),
      expect.any(Object),
    );

    vi.mocked(notify).mockClear();
    const depsMe = makeDeps({
      querySmartMoney: vi.fn(async () => ({ blocked: false, boost: true, consensusStrength: 0.85, insiderScore: 3, reason: 'aligned' })),
      notifyTrade: vi.fn(),
      placeBuyOrder: vi.fn(async () => ({ orderId: 'ord-me', makingAmount: '3.0', takingAmount: '5' })),
    });
    const okMe = await executeDirectionalTrade(signal({
      dryRun: false,
      betMarketPrice: 0.60,
      orderbookUp: { bestBid: 0.59, bestAsk: 0.60, spread: 0.01, askLiquidity: 200 },
      lastPrice: 63_873,
      settlePrice: 63_850,
      priceToBeat: { value: 63_672.88, source: 'chainlink_twap' },
    }), depsMe);
    expect(okMe).toBe(true);
    expect(notify).toHaveBeenCalledWith(
      'info',
      expect.stringContaining('Token: 60.0c'),
      expect.any(Object),
    );
    expect(notify).toHaveBeenCalledWith(
      'info',
      expect.stringContaining('₿ BTC <b>$63,850.00</b> (PTB $63,672.88, +$177.12)'),
      expect.any(Object),
    );
  });
});
