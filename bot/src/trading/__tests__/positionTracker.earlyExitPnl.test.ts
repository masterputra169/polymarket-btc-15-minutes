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

const { _resetForTest, recordTrade, getCurrentPosition, getBankroll, settleTradeEarlyExit, earlyExitPnl } =
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
});
