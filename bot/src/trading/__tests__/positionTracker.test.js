/**
 * positionTracker unit tests.
 *
 * Tests financial accounting, settlement, NaN guards, and state integrity.
 * Each test gets fresh state via _resetForTest().
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock filesystem + logger + config BEFORE importing the module
vi.mock('fs', () => ({
  readFileSync: vi.fn(() => '{}'),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  appendFileSync: vi.fn(),
  renameSync: vi.fn(),
  statSync: vi.fn(() => ({ size: 0 })),
}));

vi.mock('../../logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../config.js', () => ({
  BOT_CONFIG: {
    bankroll: 100,
    stateFile: '/tmp/test_state.json',
  },
}));

const {
  _resetForTest,
  recordTrade,
  settleTrade,
  settleTradeEarlyExit,
  recordArbTrade,
  unwindPosition,
  hasOpenPosition,
  getCurrentPosition,
  getAvailableBankroll,
  getBankroll,
  setPendingCost,
  getPendingCost,
  getDrawdownPct,
  confirmFill,
  getLastSettled,
  setLastSettled,
  getConsecutiveLosses,
  getStats,
  setBankroll,
  acquireSellLock,
  releaseSellLock,
  isSelling,
  partialExit,
  getDailyPnL,
  getDailyPnLPct,
  getLastSettlementMs,
  saveState,
} = await import('../positionTracker.js');

// ────────────────────────────────────────────
// SETUP
// ────────────────────────────────────────────

beforeEach(() => {
  _resetForTest({ bankroll: 100 });
  vi.clearAllMocks();
});

// ────────────────────────────────────────────
// recordTrade
// ────────────────────────────────────────────

describe('recordTrade', () => {
  it('deducts bankroll by theoretical cost (price * size)', () => {
    recordTrade({ side: 'UP', tokenId: 't1', price: 0.40, size: 10, marketSlug: 'slug-1' });
    expect(getBankroll()).toBeCloseTo(96, 2); // 100 - 4.00
  });

  it('deducts bankroll by actualCost when provided', () => {
    recordTrade({ side: 'UP', tokenId: 't1', price: 0.40, size: 10, marketSlug: 'slug-1', actualCost: 4.20 });
    expect(getBankroll()).toBeCloseTo(95.80, 2); // 100 - 4.20
  });

  it('records position with correct fields', () => {
    recordTrade({ side: 'DOWN', tokenId: 't2', conditionId: 'c1', price: 0.55, size: 5, marketSlug: 'slug-2', orderId: 'o1' });
    const pos = getCurrentPosition();
    expect(pos.side).toBe('DOWN');
    expect(pos.tokenId).toBe('t2');
    expect(pos.conditionId).toBe('c1');
    expect(pos.size).toBe(5);
    expect(pos.settled).toBe(false);
    expect(pos.fillConfirmed).toBe(false);
    expect(pos.orderId).toBe('o1');
  });

  it('increments totalTrades', () => {
    const before = getStats().totalTrades;
    recordTrade({ side: 'UP', tokenId: 't1', price: 0.50, size: 2, marketSlug: 's' });
    expect(getStats().totalTrades).toBe(before + 1);
  });

  it('clears pendingCost after recording', () => {
    setPendingCost(5);
    recordTrade({ side: 'UP', tokenId: 't1', price: 0.50, size: 10, marketSlug: 's' });
    expect(getPendingCost()).toBe(0);
  });

  it('force-unwinds stale position from different market', () => {
    recordTrade({ side: 'UP', tokenId: 't1', price: 0.40, size: 10, marketSlug: 'market-A' });
    const afterFirst = getBankroll(); // 96

    // Record on different market — should unwind first
    recordTrade({ side: 'DOWN', tokenId: 't2', price: 0.50, size: 5, marketSlug: 'market-B' });
    // After unwind: 96 + 4 = 100, then deduct 2.50 = 97.50
    expect(getBankroll()).toBeCloseTo(97.50, 2);
    expect(getCurrentPosition().marketSlug).toBe('market-B');
  });

  it('rejects NaN price', () => {
    recordTrade({ side: 'UP', tokenId: 't1', price: NaN, size: 10, marketSlug: 's' });
    expect(getCurrentPosition()).toBeNull();
    expect(getBankroll()).toBe(100);
  });

  it('rejects zero price', () => {
    recordTrade({ side: 'UP', tokenId: 't1', price: 0, size: 10, marketSlug: 's' });
    expect(getCurrentPosition()).toBeNull();
  });

  it('rejects negative size', () => {
    recordTrade({ side: 'UP', tokenId: 't1', price: 0.50, size: -5, marketSlug: 's' });
    expect(getCurrentPosition()).toBeNull();
  });

  it('rejects invalid actualCost (falls back to theoretical)', () => {
    recordTrade({ side: 'UP', tokenId: 't1', price: 0.50, size: 10, marketSlug: 's', actualCost: -1 });
    // Should use theoretical: 0.50 * 10 = 5.00
    expect(getBankroll()).toBeCloseTo(95, 2);
  });

  it('prevents float drift on price (rounds to 1e8)', () => {
    recordTrade({ side: 'UP', tokenId: 't1', price: 0.21, size: 10, marketSlug: 's' });
    const pos = getCurrentPosition();
    // 0.21 should NOT become 0.21000000000000002
    expect(pos.price).toBe(0.21);
    expect(pos.cost).toBeCloseTo(2.10, 2);
  });
});

// ────────────────────────────────────────────
// settleTrade
// ────────────────────────────────────────────

describe('settleTrade', () => {
  beforeEach(() => {
    recordTrade({ side: 'UP', tokenId: 't1', price: 0.40, size: 10, marketSlug: 's' });
  });

  it('on WIN: adds payout minus 2% fee to bankroll', () => {
    // cost = 4.00, win pays $1/share * 10 = $10
    // profit = 10 - 4 = 6, fee = 6 * 0.02 = 0.12, payout = 10 - 0.12 = 9.88
    // bankroll: 96 + 9.88 = 105.88
    const result = settleTrade(true);
    expect(result).toBe(true);
    expect(getBankroll()).toBeCloseTo(105.88, 2);
  });

  it('on LOSS: bankroll unchanged (payout = 0)', () => {
    settleTrade(false);
    // bankroll stays at 96 (already deducted)
    expect(getBankroll()).toBeCloseTo(96, 2);
  });

  it('increments wins on WIN', () => {
    settleTrade(true);
    expect(getStats().wins).toBe(1);
    expect(getConsecutiveLosses()).toBe(0);
  });

  it('increments losses and consecutiveLosses on LOSS', () => {
    settleTrade(false);
    expect(getStats().losses).toBe(1);
    expect(getConsecutiveLosses()).toBe(1);
  });

  it('resets consecutiveLosses on WIN', () => {
    _resetForTest({ bankroll: 100, consecutiveLosses: 3 });
    recordTrade({ side: 'UP', tokenId: 't1', price: 0.40, size: 10, marketSlug: 's' });
    settleTrade(true);
    expect(getConsecutiveLosses()).toBe(0);
  });

  it('clears currentPosition after settlement', () => {
    settleTrade(true);
    expect(getCurrentPosition()).toBeNull();
  });

  it('double-settlement returns false (dedup guard)', () => {
    settleTrade(true);
    recordTrade({ side: 'UP', tokenId: 't1', price: 0.40, size: 10, marketSlug: 's' });
    // Mark settled manually
    getCurrentPosition().settled = true;
    expect(settleTrade(true)).toBe(false);
  });

  it('returns false when no position', () => {
    _resetForTest({ bankroll: 100 });
    expect(settleTrade(true)).toBe(false);
  });

  it('aborts on NaN size', () => {
    const pos = getCurrentPosition();
    pos.size = NaN;
    expect(settleTrade(true)).toBe(false);
  });

  it('updates peakBankroll on winning trade', () => {
    settleTrade(true);
    expect(getStats().peakBankroll).toBeGreaterThan(100);
  });
});

// ────────────────────────────────────────────
// settleTradeEarlyExit
// ────────────────────────────────────────────

describe('settleTradeEarlyExit', () => {
  beforeEach(() => {
    recordTrade({ side: 'UP', tokenId: 't1', price: 0.40, size: 10, marketSlug: 's' });
    // bankroll: 96, cost: 4.00
  });

  it('adds recovered USDC to bankroll', () => {
    settleTradeEarlyExit(3.00);
    // bankroll: 96 + 3 = 99
    expect(getBankroll()).toBeCloseTo(99, 2);
  });

  it('counts as loss when recovered < cost', () => {
    settleTradeEarlyExit(2.00);
    expect(getStats().losses).toBe(1);
    expect(getConsecutiveLosses()).toBe(1);
  });

  it('counts as win when recovered >= cost', () => {
    settleTradeEarlyExit(5.00);
    expect(getStats().wins).toBe(1);
  });

  it('clears position after exit', () => {
    settleTradeEarlyExit(3.00);
    expect(getCurrentPosition()).toBeNull();
  });

  it('rejects NaN recovery', () => {
    expect(settleTradeEarlyExit(NaN)).toBe(false);
    expect(getCurrentPosition()).not.toBeNull();
  });

  it('rejects negative recovery', () => {
    expect(settleTradeEarlyExit(-5)).toBe(false);
  });

  it('increments cutLossCount', () => {
    const before = getStats().cutLosses;
    settleTradeEarlyExit(2.00);
    expect(getStats().cutLosses).toBe(before + 1);
  });

  it('dedup guard prevents double early-exit', () => {
    getCurrentPosition().settled = true;
    expect(settleTradeEarlyExit(3.00)).toBe(false);
  });
});

// ────────────────────────────────────────────
// recordArbTrade
// ────────────────────────────────────────────

describe('recordArbTrade', () => {
  it('deducts upCost + downCost from bankroll', () => {
    recordArbTrade({ upCost: 4.60, downCost: 5.10, shares: 10, marketSlug: 'arb-1' });
    // cost = 9.70, bankroll = 100 - 9.70 = 90.30
    expect(getBankroll()).toBeCloseTo(90.30, 2);
  });

  it('creates position with side ARB', () => {
    recordArbTrade({ upCost: 4.60, downCost: 5.10, shares: 10, marketSlug: 'arb-1' });
    const pos = getCurrentPosition();
    expect(pos.side).toBe('ARB');
    expect(pos.size).toBe(10);
    expect(pos.arbUpCost).toBeCloseTo(4.60, 2);
    expect(pos.arbDownCost).toBeCloseTo(5.10, 2);
    expect(pos.fillConfirmed).toBe(true);
  });

  it('rejects NaN upCost', () => {
    recordArbTrade({ upCost: NaN, downCost: 5, shares: 10, marketSlug: 's' });
    expect(getCurrentPosition()).toBeNull();
  });

  it('rejects zero shares', () => {
    recordArbTrade({ upCost: 5, downCost: 5, shares: 0, marketSlug: 's' });
    expect(getCurrentPosition()).toBeNull();
  });

  it('stores conditionId', () => {
    recordArbTrade({ upCost: 4, downCost: 5, shares: 10, marketSlug: 's', conditionId: 'c123' });
    expect(getCurrentPosition().conditionId).toBe('c123');
  });
});

// ────────────────────────────────────────────
// unwindPosition
// ────────────────────────────────────────────

describe('unwindPosition', () => {
  it('returns cost to bankroll', () => {
    recordTrade({ side: 'UP', tokenId: 't1', price: 0.40, size: 10, marketSlug: 's' });
    unwindPosition();
    expect(getBankroll()).toBeCloseTo(100, 2);
    expect(getCurrentPosition()).toBeNull();
  });

  it('decrements totalTrades', () => {
    recordTrade({ side: 'UP', tokenId: 't1', price: 0.40, size: 10, marketSlug: 's' });
    const before = getStats().totalTrades;
    unwindPosition();
    expect(getStats().totalTrades).toBe(before - 1);
  });

  it('does nothing when no position', () => {
    unwindPosition();
    expect(getBankroll()).toBe(100);
  });

  it('skips unwind on already-settled position (prevents double-credit)', () => {
    recordTrade({ side: 'UP', tokenId: 't1', price: 0.40, size: 10, marketSlug: 's' });
    getCurrentPosition().settled = true;
    unwindPosition();
    // Should NOT add cost back
    expect(getBankroll()).toBeCloseTo(96, 2);
  });
});

// ────────────────────────────────────────────
// hasOpenPosition
// ────────────────────────────────────────────

describe('hasOpenPosition', () => {
  it('returns false when no position', () => {
    expect(hasOpenPosition('slug')).toBe(false);
  });

  it('returns true when open position exists', () => {
    recordTrade({ side: 'UP', tokenId: 't1', price: 0.40, size: 10, marketSlug: 'slug-A' });
    expect(hasOpenPosition('slug-A')).toBe(true);
  });

  it('returns true for ANY unsettled position (different slug)', () => {
    recordTrade({ side: 'UP', tokenId: 't1', price: 0.40, size: 10, marketSlug: 'slug-A' });
    expect(hasOpenPosition('slug-B')).toBe(true);
  });

  it('returns false when position is settled', () => {
    recordTrade({ side: 'UP', tokenId: 't1', price: 0.40, size: 10, marketSlug: 'slug-A' });
    settleTrade(true);
    expect(hasOpenPosition('slug-A')).toBe(false);
  });
});

// ────────────────────────────────────────────
// getAvailableBankroll
// ────────────────────────────────────────────

describe('getAvailableBankroll', () => {
  it('equals bankroll when no pending', () => {
    expect(getAvailableBankroll()).toBe(100);
  });

  it('subtracts pendingCost', () => {
    setPendingCost(30);
    expect(getAvailableBankroll()).toBeCloseTo(70, 2);
  });

  it('floors at 0', () => {
    setPendingCost(200);
    expect(getAvailableBankroll()).toBe(0);
  });
});

// ────────────────────────────────────────────
// setPendingCost
// ────────────────────────────────────────────

describe('setPendingCost', () => {
  it('clamps NaN to 0', () => {
    setPendingCost(NaN);
    expect(getPendingCost()).toBe(0);
  });

  it('clamps Infinity to 0', () => {
    setPendingCost(Infinity);
    expect(getPendingCost()).toBe(0);
  });

  it('clamps negative to 0', () => {
    setPendingCost(-10);
    expect(getPendingCost()).toBe(0);
  });

  it('stores valid cost', () => {
    setPendingCost(5.50);
    expect(getPendingCost()).toBeCloseTo(5.50, 2);
  });
});

// ────────────────────────────────────────────
// getDrawdownPct
// ────────────────────────────────────────────

describe('getDrawdownPct', () => {
  it('returns 0 when at peak', () => {
    expect(getDrawdownPct()).toBe(0);
  });

  it('returns correct drawdown after loss', () => {
    recordTrade({ side: 'UP', tokenId: 't1', price: 0.50, size: 20, marketSlug: 's' });
    settleTrade(false);
    // bankroll = 90, peak = 100
    expect(getDrawdownPct()).toBeCloseTo(10, 1);
  });

  it('handles peak=0', () => {
    _resetForTest({ bankroll: 0, peakBankroll: 0 });
    expect(getDrawdownPct()).toBe(0);
  });
});

// ────────────────────────────────────────────
// confirmFill
// ────────────────────────────────────────────

describe('confirmFill', () => {
  it('marks position as fill-confirmed', () => {
    recordTrade({ side: 'UP', tokenId: 't1', price: 0.40, size: 10, marketSlug: 's' });
    confirmFill();
    expect(getCurrentPosition().fillConfirmed).toBe(true);
  });

  it('calls saveState (persists)', async () => {
    recordTrade({ side: 'UP', tokenId: 't1', price: 0.40, size: 10, marketSlug: 's' });
    const fs = await import('fs');
    fs.writeFileSync.mockClear();
    confirmFill();
    // saveState writes to file
    expect(fs.writeFileSync).toHaveBeenCalled();
  });

  it('is idempotent', () => {
    recordTrade({ side: 'UP', tokenId: 't1', price: 0.40, size: 10, marketSlug: 's' });
    confirmFill();
    confirmFill();
    expect(getCurrentPosition().fillConfirmed).toBe(true);
  });
});

// ────────────────────────────────────────────
// Double-settlement guard
// ────────────────────────────────────────────

describe('lastSettled guard', () => {
  it('round-trips slug and timestamp', () => {
    setLastSettled('market-abc', 12345);
    const { slug, ts } = getLastSettled();
    expect(slug).toBe('market-abc');
    expect(ts).toBe(12345);
  });
});

// ────────────────────────────────────────────
// setBankroll
// ────────────────────────────────────────────

describe('setBankroll', () => {
  it('updates bankroll', () => {
    setBankroll(200);
    expect(getBankroll()).toBe(200);
  });

  it('updates peakBankroll when higher', () => {
    setBankroll(200);
    expect(getStats().peakBankroll).toBe(200);
  });

  it('rejects NaN', () => {
    setBankroll(NaN);
    expect(getBankroll()).toBe(100); // unchanged
  });

  it('rejects negative', () => {
    setBankroll(-50);
    expect(getBankroll()).toBe(100);
  });
});

// ────────────────────────────────────────────
// Sell lock
// ────────────────────────────────────────────

describe('sell lock', () => {
  it('acquires and releases', () => {
    expect(acquireSellLock()).toBe(true);
    expect(isSelling()).toBe(true);
    expect(acquireSellLock()).toBe(false); // already locked
    releaseSellLock();
    expect(isSelling()).toBe(false);
    expect(acquireSellLock()).toBe(true);
  });
});

// ────────────────────────────────────────────
// partialExit
// ────────────────────────────────────────────

describe('partialExit', () => {
  beforeEach(() => {
    recordTrade({ side: 'UP', tokenId: 't1', price: 0.40, size: 10, marketSlug: 's' });
    // bankroll: 96, cost: 4.00
  });

  it('reduces position size proportionally', () => {
    partialExit(5, 2.50);
    const pos = getCurrentPosition();
    expect(pos.size).toBeCloseTo(5, 4);
    expect(pos.cost).toBeCloseTo(2, 2);
  });

  it('adds recovered USDC to bankroll', () => {
    partialExit(5, 2.50);
    expect(getBankroll()).toBeCloseTo(98.50, 2);
  });

  it('delegates to full exit when selling all', () => {
    partialExit(10, 3.00);
    expect(getCurrentPosition()).toBeNull();
    expect(getBankroll()).toBeCloseTo(99, 2);
  });

  it('returns false on settled position', () => {
    getCurrentPosition().settled = true;
    expect(partialExit(5, 2)).toBe(false);
  });
});

// ────────────────────────────────────────────
// Daily P&L
// ────────────────────────────────────────────

describe('getDailyPnL', () => {
  it('returns 0 at start', () => {
    expect(getDailyPnL()).toBe(0);
  });

  it('reflects loss after settlement', () => {
    recordTrade({ side: 'UP', tokenId: 't1', price: 0.50, size: 10, marketSlug: 's' });
    settleTrade(false);
    expect(getDailyPnL()).toBeLessThan(0);
  });
});

// ────────────────────────────────────────────
// getLastSettlementMs
// ────────────────────────────────────────────

describe('getLastSettlementMs', () => {
  it('returns 0 initially', () => {
    expect(getLastSettlementMs()).toBe(0);
  });

  it('updates after settlement', () => {
    recordTrade({ side: 'UP', tokenId: 't1', price: 0.40, size: 10, marketSlug: 's' });
    settleTrade(true);
    expect(getLastSettlementMs()).toBeGreaterThan(0);
  });
});

// ────────────────────────────────────────────
// Float precision
// ────────────────────────────────────────────

describe('float precision', () => {
  it('cost does not have float drift for 0.21 * 10', () => {
    recordTrade({ side: 'UP', tokenId: 't1', price: 0.21, size: 10, marketSlug: 's' });
    const pos = getCurrentPosition();
    // 0.21 * 10 = 2.1 exactly, not 2.1000000000000004
    expect(pos.cost).toBe(2.10);
  });

  it('bankroll stays rounded to cents', () => {
    recordTrade({ side: 'UP', tokenId: 't1', price: 0.33, size: 3, marketSlug: 's' });
    const bankroll = getBankroll();
    // Should be rounded to 2 decimal places
    expect(bankroll).toBe(Math.round(bankroll * 100) / 100);
  });
});

// ────────────────────────────────────────────
// ARB settlement with fee
// ────────────────────────────────────────────

describe('ARB settlement', () => {
  it('charges fee on worst-case winning leg profit', () => {
    recordArbTrade({ upCost: 4.60, downCost: 5.10, shares: 10, marketSlug: 'arb-1' });
    // cost = 9.70, bankroll = 90.30
    settleTrade(true);
    // Worst-case fee: min(4.60, 5.10)=4.60, profit from that leg = 10 - 4.60 = 5.40
    // fee = 5.40 * 0.02 = 0.108, rounded to 0.11
    // payout = 10 - 0.11 = 9.89
    // bankroll = 90.30 + 9.89 = 100.19
    expect(getBankroll()).toBeCloseTo(100.19, 2);
  });
});
