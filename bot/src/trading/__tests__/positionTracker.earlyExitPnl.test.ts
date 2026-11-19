/**
 * earlyExitPnl: the journal's P&L for an early exit must equal what settleTradeEarlyExit()
 * books to the bankroll (proceeds − cost − entry fee). The loop used to write
 * `recovered − cost`, drifting from the bankroll by the taker fee on every cut-loss.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('fs', () => ({
  readFileSync: vi.fn(() => '{}'), writeFileSync: vi.fn(), existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(), appendFileSync: vi.fn(), renameSync: vi.fn(), statSync: vi.fn(() => ({ size: 0 })),
}));
vi.mock('../../logger.ts', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../config.ts', () => ({ BOT_CONFIG: { bankroll: 100, stateFile: '/tmp/test_state_pnl.json' } }));

const { _resetForTest, recordTrade, partialExit, getCurrentPosition, getBankroll, settleTradeEarlyExit, earlyExitPnl } =
  await import('../positionTracker.ts');

beforeEach(() => { _resetForTest({ bankroll: 100 }); });

describe('earlyExitPnl', () => {
  it('matches the bankroll movement of settleTradeEarlyExit', () => {
    recordTrade({ side: 'UP', tokenId: 't', price: 0.6, size: 10, marketSlug: 'm', orderId: null });
    const pos = getCurrentPosition();
    const before = getBankroll(); // 94 after the $6 cost
    const pnl = earlyExitPnl(pos, 2);
    expect(settleTradeEarlyExit(2)).toBe(true);
    // 2 recovered − 6 cost − taker fee (10 × 0.07 × 0.6 × 0.4 = 0.168 → $0.17)
    expect(pnl).toBe(-4.17);
    expect(getBankroll()).toBeCloseTo(before + 2 - 0.17, 2);
  });

  it('treats a negative or missing recovery as zero', () => {
    recordTrade({ side: 'DOWN', tokenId: 't', price: 0.5, size: 4, marketSlug: 'm', orderId: null });
    const pos = getCurrentPosition();
    expect(earlyExitPnl(pos, -3)).toBe(earlyExitPnl(pos, 0));
  });

  it('subtracts an explicit exit fee (dry-run sell leg) from P&L and bankroll', () => {
    recordTrade({ side: 'UP', tokenId: 't', price: 0.6, size: 10, marketSlug: 'm', orderId: null });
    const pos = getCurrentPosition();
    const before = getBankroll(); // 94 after the $6 cost
    // entry fee 0.17, exit fee 0.17
    expect(earlyExitPnl(pos, 2, 0.17)).toBe(-4.34);
    expect(settleTradeEarlyExit(2, 0.17)).toBe(true);
    expect(getBankroll()).toBeCloseTo(before + 2 - 0.17 - 0.17, 2);
  });

  it('partialExit guards NaN/non-positive inputs and subtracts exitFee', () => {
    recordTrade({ side: 'UP', tokenId: 't', price: 0.6, size: 10, marketSlug: 'm', orderId: null });
    const before = getBankroll(); // 94
    expect(partialExit(0, 2)).toBe(false);
    expect(partialExit(Number.NaN, 2)).toBe(false);
    expect(partialExit(4, -1)).toBe(false);
    expect(partialExit(4, Number.NaN)).toBe(false);
    expect(getBankroll()).toBe(before);

    // Sell 4 shares for $3 with $0.05 exitFee; entry fee portion on 4@0.60 = 0.0672
    expect(partialExit(4, 3, 0.05)).toBe(true);
    expect(getCurrentPosition()?.size).toBe(6);
    expect(getBankroll()).toBeCloseTo(before + 3 - 0.0672 - 0.05, 2);
  });
});
