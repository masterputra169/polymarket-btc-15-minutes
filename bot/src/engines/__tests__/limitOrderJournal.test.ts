/**
 * Journal blindness on LIMIT / PREMARKET entries.
 *
 * Measured bug (trade_journal.jsonl, 1860 rows): every LIMIT, LIMIT_PARTIAL,
 * LIMIT_PHANTOM and PREMARKET entry carried only 13 keys, while FOK entries
 * (LOW/MEDIUM/HIGH/VERY_HIGH) carried 64 — no `mlProbUp`, `bestEdge`, `spread`
 * or any other decision signal. Root cause: the signal snapshot exists at
 * decision time, but the limit-order lifecycle (PLACED → MONITORING → FILLED)
 * spans polls and dropped it, so the journal write at fill time had nothing left.
 *
 * Invariants under test:
 *   1. placeLimitOrder() freezes the caller's decision-time signal block, and
 *      monitorLimitOrder()/cancelLimitOrder() hand it back verbatim in fillData.
 *   2. The block is the one from the ENTRY DECISION, never re-sampled at fill
 *      time — re-sampling would record numbers the bot never acted on.
 *   3. The resulting journal entry carries the same field NAMES the FOK path
 *      writes, so old and new rows stay comparable.
 *   4. Fill-time facts (side/price/size/cost) still win over the frozen block.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.mock('fs', () => ({
  readFileSync: vi.fn(() => ''),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(() => true),
  mkdirSync: vi.fn(),
  appendFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

vi.mock('../../logger.ts', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../config.ts', () => ({
  BOT_CONFIG: {
    dryRun: false,                                  // journal writes are skipped in DRY_RUN
    journalFile: '/tmp/test_trade_journal.jsonl',
    entrySnapshotFile: '/tmp/test_entry_snapshot.json',
    maxBetAmountUsd: 2.5,
    limitOrder: {
      enabled: true,
      minEntryPrice: 0.50, maxEntryPrice: 0.58,
      priceTierLow: 0.52, priceTierMid: 0.55, priceTierHigh: 0.58,
      minElapsedMin: 0.5, maxElapsedMin: 9.0,
      cancelAfterElapsedMin: 9.0,
      partialFillAcceptRatio: 0.60,
      expirationBufferSec: 120,
      minEvalPolls: 1,
      checkIntervalMs: 2000,
      minMlConfidence: 0.62,
    },
  },
}));

vi.mock('../../monitoring/notifier.ts', () => ({ notify: vi.fn(() => Promise.resolve()) }));
vi.mock('../../services/runtimeIntegrations.ts', () => ({
  mirrorTradeJournalRecord: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../trading/positionTracker.ts', () => ({ getBankroll: vi.fn(() => 100) }));

import { appendFileSync } from 'fs';
import {
  placeLimitOrder, monitorLimitOrder, cancelLimitOrder, resetLimitOrderState,
} from '../limitOrderManager.ts';
import {
  captureEntrySnapshot, writeJournalEntry, clearEntrySnapshot,
} from '../../trading/tradeJournal.ts';

// ── The decision-time signal block, as loop.ts builds it at placement ──
// Field names mirror `entryData` in engines/tradePipeline.ts (the FOK path).
const DECISION_BLOCK = {
  edgeUp: 0.13, edgeDown: -0.09, bestEdge: 0.13,
  ensembleUp: 0.68, ruleUp: 0.64,
  mlProbUp: 0.71, mlConfidence: 0.71, mlSide: 'UP', mlAgreesWithRules: true,
  rsiNow: 58.2, rsiSlope: 1.4, macdHist: 3.1, macdLine: 12.7,
  vwapDist: 0.0012, vwapSlope: 0.4,
  bbPercentB: 0.62, bbWidth: 0.018, bbSqueeze: false,
  atrPct: 0.09, atrRatio: 0.011,
  stochK: 61.0, stochD: 55.5,
  emaCrossSignal: 'bull', emaDistPct: 0.05,
  volDeltaBuyRatio: 0.57,
  haColor: 'green', haCount: 3,
  delta1m: 12.5, delta3m: 31.0,
  regime: 'trending', regimeConfidence: 0.72,
  marketUp: 0.61, marketDown: 0.39,
  orderbookImbalance: 0.18, spread: 0.021,
  signalConfirmCount: 4, recentFlips: 0,
  smartFlowDirection: 'UP', smartFlowStrength: 0.4, smartFlowWindow: 'EARLY',
  expectedPrice: 0.55,
  signalAt: 1_700_000_000_000,
};

// What the market looked like LATER, when the order actually filled. If any of
// these numbers reach the journal, the fix re-sampled instead of carrying.
const FILL_TIME_BLOCK = {
  bestEdge: -0.04, mlProbUp: 0.44, mlConfidence: 0.56, mlSide: 'DOWN',
  spread: 0.088, regime: 'choppy', marketUp: 0.47,
};

const T0 = 1_700_000_100_000;

const PLACE_ARGS = {
  side: 'UP',
  targetPrice: 0.55,
  tokenId: 'token-up-1',
  marketSlug: 'btc-updown-15m-1778902200',
  conditionId: '0xcond',
  marketEndMs: T0 + 12 * 60_000,
  bankroll: 100,
  mlConfidence: 0.80,
  sessionQuality: 1.0,
  signalSnapshot: DECISION_BLOCK,
};

function makeDeps(overrides = {}) {
  return {
    placeLimitBuyOrder: vi.fn(async () => ({ orderId: 'order-1' })),
    setPendingCost: vi.fn(),
    getOrderById: vi.fn(async () => null),          // gone from book
    getOrderStatus: vi.fn(async () => ({ status: 'MATCHED' })),
    cancelOrder: vi.fn(async () => ({})),
    ...overrides,
  };
}

/** Drive MONITORING → FILLED: past the 8s grace, then 3 consecutive null checks. */
async function driveToFill(deps) {
  vi.setSystemTime(T0 + 20_000);
  const monitorArgs = {
    mlConfidence: 0.72, mlSide: 'UP', ensembleProb: 0.68,
    btcPrice: 79_200, priceToBeat: 79_150,
    elapsedMin: 2.0, marketSlug: PLACE_ARGS.marketSlug,
  };
  let result;
  for (let i = 0; i < 3; i++) {
    vi.setSystemTime(T0 + 20_000 + i * 3_000);
    result = await monitorLimitOrder(monitorArgs, deps);
  }
  return result;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  resetLimitOrderState();
  clearEntrySnapshot();
});

describe('limit order lifecycle carries the decision-time signal block', () => {
  test('FILLED hands back the block frozen at placement, not re-sampled at fill', async () => {
    const deps = makeDeps();
    const placed = await placeLimitOrder(PLACE_ARGS, deps);
    expect(placed.placed).toBe(true);

    const result = await driveToFill(deps);

    expect(result.action).toBe('FILLED');
    expect(result.fillData.signalSnapshot).toEqual(DECISION_BLOCK);

    // Explicitly: the LATER market state never leaks in.
    for (const [key, fillTimeValue] of Object.entries(FILL_TIME_BLOCK)) {
      expect(result.fillData.signalSnapshot[key]).not.toBe(fillTimeValue);
      expect(result.fillData.signalSnapshot[key]).toBe(DECISION_BLOCK[key]);
    }
  });

  test('PARTIAL_ACCEPT carries the same block', async () => {
    const deps = makeDeps({
      getOrderById: vi.fn(async () => ({ original_size: '7', size_matched: '5' })),
    });
    await placeLimitOrder(PLACE_ARGS, deps);
    vi.setSystemTime(T0 + 20_000);

    const result = await monitorLimitOrder({
      mlConfidence: 0.72, mlSide: 'UP', ensembleProb: 0.68,
      btcPrice: 79_200, priceToBeat: 79_150,
      elapsedMin: 2.0, marketSlug: PLACE_ARGS.marketSlug,
    }, deps);

    expect(result.action).toBe('PARTIAL_ACCEPT');
    expect(result.fillData.signalSnapshot).toEqual(DECISION_BLOCK);
  });

  test('phantom fill during cancel carries the same block', async () => {
    const deps = makeDeps({ cancelOrder: vi.fn(async () => ({ error: 'invalid order payload' })) });
    await placeLimitOrder(PLACE_ARGS, deps);
    vi.setSystemTime(T0 + 20_000);

    const result = await cancelLimitOrder('signal_flip', deps);

    expect(result.filledInstead).toBe(true);
    expect(result.fillData.signalSnapshot).toEqual(DECISION_BLOCK);
  });

  test('a caller that passes no block still works (field simply absent)', async () => {
    const deps = makeDeps();
    const { signalSnapshot, ...noBlock } = PLACE_ARGS;
    await placeLimitOrder(noBlock, deps);

    const result = await driveToFill(deps);
    expect(result.action).toBe('FILLED');
    expect(result.fillData.signalSnapshot).toBeNull();
  });
});

describe('journal entry written for a LIMIT fill', () => {
  /** Reproduces loop.ts's LIMIT-fill captureEntrySnapshot + settlement write. */
  async function journalALimitFill() {
    const deps = makeDeps();
    await placeLimitOrder(PLACE_ARGS, deps);
    const { fillData: fd } = await driveToFill(deps);

    captureEntrySnapshot({
      ...(fd.signalSnapshot ?? {}),
      side: fd.side, tokenPrice: fd.price, btcPrice: 79_240,
      priceToBeat: 79_150, marketSlug: fd.marketSlug,
      cost: fd.price * fd.size, size: fd.size,
      confidence: 'LIMIT', phase: 'EARLY', reason: 'limit_order_filled',
      timeLeftMin: 11.2, session: 'US',
    });

    writeJournalEntry({
      outcome: 'WIN',
      pnl: 3.15,
      exitData: { btcPrice: 79_410, priceToBeat: 79_150, tokenPrice: 1.0, regime: 'trending' },
    });

    expect(appendFileSync).toHaveBeenCalledTimes(1);
    const [, line] = (appendFileSync as any).mock.calls[0];
    return JSON.parse(line);
  }

  // The signal fields the FOK path records that LIMIT/PREMARKET rows lacked.
  // Sizing/execution-quality fields (betAmount, kellyFraction, riskLevel,
  // expectedValue, meBoost, rlScalar, rlActionIdx, actualPrice, slippagePct,
  // avgSlippage) stay FOK-only — they describe the FOK sizing path, and
  // fabricating them on a LIMIT row would poison the same analysis.
  const RESTORED_FIELDS = [
    'edgeUp', 'edgeDown', 'bestEdge', 'ensembleUp', 'ruleUp',
    'mlProbUp', 'mlConfidence', 'mlSide', 'mlAgreesWithRules',
    'rsiNow', 'rsiSlope', 'macdHist', 'macdLine', 'vwapDist', 'vwapSlope',
    'bbPercentB', 'bbWidth', 'bbSqueeze', 'atrPct', 'atrRatio',
    'stochK', 'stochD', 'emaCrossSignal', 'emaDistPct', 'volDeltaBuyRatio',
    'haColor', 'haCount', 'delta1m', 'delta3m',
    'regime', 'regimeConfidence', 'marketUp', 'marketDown',
    'orderbookImbalance', 'spread', 'signalConfirmCount', 'recentFlips',
    'smartFlowDirection', 'smartFlowStrength', 'smartFlowWindow', 'expectedPrice',
  ];

  test('records the three fields the meta-labeling run had to impute', async () => {
    const record = await journalALimitFill();
    expect(record.entry.mlProbUp).toBe(DECISION_BLOCK.mlProbUp);
    expect(record.entry.bestEdge).toBe(DECISION_BLOCK.bestEdge);
    expect(record.entry.spread).toBe(DECISION_BLOCK.spread);
  });

  test('records every restored FOK signal field, under the FOK field names', async () => {
    const record = await journalALimitFill();
    const missing = RESTORED_FIELDS.filter((f) => !(f in record.entry));
    expect(missing).toEqual([]);
    for (const f of RESTORED_FIELDS) {
      expect(record.entry[f]).toEqual(DECISION_BLOCK[f]);
    }
  });

  test('fill-time facts still win over the frozen block', async () => {
    const record = await journalALimitFill();
    expect(record.entry.confidence).toBe('LIMIT');
    expect(record.entry.reason).toBe('limit_order_filled');
    expect(record.entry.side).toBe('UP');
    expect(record.entry.tokenPrice).toBe(PLACE_ARGS.targetPrice);
    expect(record.entry.btcPrice).toBe(79_240);        // fill-time BTC, not decision-time
    expect(record.entry.marketSlug).toBe(PLACE_ARGS.marketSlug);
  });

  test('signalAt stamps decision time, so the placement→fill lag stays visible', async () => {
    const record = await journalALimitFill();
    expect(record.entry.signalAt).toBe(DECISION_BLOCK.signalAt);
    expect(record.entry.enteredAt).toBeGreaterThan(record.entry.signalAt);
  });

  test('analysis still derives mlWasRight from the now-present mlSide', async () => {
    const record = await journalALimitFill();
    // Previously impossible: LIMIT rows had no mlSide, so mlWasRight was always null.
    expect(record.analysis.actualOutcome).toBe('UP');
    expect(record.analysis.mlWasRight).toBe(true);
  });
});
