/**
 * Dashboard sell: the tracked position may only be settled when the token that was sold IS
 * that position's token. The dashboard can also sell holdings the tracker does not know about
 * (getPositions merges the on-chain list); settling the tracked position for those used to
 * book the wrong cost and close a position that was still open.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

vi.mock('../logger.ts', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const tracker = vi.hoisted(() => ({
  pos: null as any,
  setBankroll: vi.fn(), getBankroll: vi.fn(() => 100),
  acquireSellLock: vi.fn(() => true), releaseSellLock: vi.fn(),
  settleTradeEarlyExit: vi.fn(() => true), partialExit: vi.fn(() => true),
  earlyExitPnl: vi.fn((_p: any, rec: number) => rec - 6),
  unwindPosition: vi.fn(), settleTrade: vi.fn(() => true), setLastSettled: vi.fn(),
}));
vi.mock('../trading/positionTracker.ts', () => ({
  ...tracker, getCurrentPosition: () => tracker.pos,
}));
const journal = vi.hoisted(() => ({ writeJournalEntry: vi.fn(), clearEntrySnapshot: vi.fn() }));
vi.mock('../trading/tradeJournal.ts', () => journal);

const PORT = 3198;
process.env.STATUS_PORT = String(PORT);
process.env.STATUS_HOST = '127.0.0.1';
delete process.env.STATUS_AUTH_TOKEN; delete process.env.STATUS_CONTROL_TOKEN; delete process.env.BOT_STATUS_TOKEN;

import { startStatusServer, stopStatusServer, registerPositionManager } from '../statusServer.ts';

function rpc(msg: Record<string, unknown>): Promise<any> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    const timer = setTimeout(() => { ws.close(); reject(new Error('rpc timeout')); }, 5000);
    ws.onopen = () => ws.send(JSON.stringify(msg));
    ws.onmessage = (ev) => {
      const data = JSON.parse(String(ev.data));
      if (data.type !== 'response') return;
      clearTimeout(timer); ws.close(); resolve(data.data);
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('ws error')); };
  });
}

beforeAll(() => {
  startStatusServer();
  registerPositionManager({ getPositions: () => [], closePosition: async () => ({ takingAmount: '2.5' }) });
});
afterAll(() => { stopStatusServer(); });
beforeEach(() => {
  vi.clearAllMocks();
  tracker.acquireSellLock.mockReturnValue(true);
  tracker.pos = { side: 'UP', tokenId: 'tok-mine', size: 10, price: 0.6, cost: 6, settled: false };
});

describe('sellPosition RPC', () => {
  test('selling the tracked token in full settles the position, net of the entry fee', async () => {
    const r = await rpc({ type: 'sellPosition', tokenId: 'tok-mine', size: 10, price: 0.25 });
    expect(r.ok).toBe(true);
    expect(tracker.settleTradeEarlyExit).toHaveBeenCalledWith(2.5);
    expect(tracker.earlyExitPnl).toHaveBeenCalled();
    expect(journal.writeJournalEntry).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'CUT_LOSS' }));
    expect(tracker.releaseSellLock).toHaveBeenCalled();
  });

  test('a size a hair under the tracked size (API rounding) is still a full exit, not a dust position', async () => {
    await rpc({ type: 'sellPosition', tokenId: 'tok-mine', size: 9.999, price: 0.25 });
    expect(tracker.settleTradeEarlyExit).toHaveBeenCalledTimes(1);
    expect(tracker.partialExit).not.toHaveBeenCalled();
  });

  test('a real partial sell of the tracked token keeps the rest of the position', async () => {
    const r = await rpc({ type: 'sellPosition', tokenId: 'tok-mine', size: 4, price: 0.25 });
    expect(r.ok).toBe(true);
    expect(tracker.partialExit).toHaveBeenCalledWith(4, 2.5);
    expect(tracker.settleTradeEarlyExit).not.toHaveBeenCalled();
  });

  test('a token the tracker does not hold never touches the tracked position', async () => {
    const r = await rpc({ type: 'sellPosition', tokenId: 'tok-other', size: 3, price: 0.25 });
    expect(r.ok).toBe(true);
    expect(r.note).toBe('sold_untracked_token');
    expect(tracker.settleTradeEarlyExit).not.toHaveBeenCalled();
    expect(tracker.partialExit).not.toHaveBeenCalled();
    expect(journal.writeJournalEntry).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'SELL_ORPHAN', exitData: expect.objectContaining({ note: 'token_not_tracked_position' }),
    }));
  });
});
