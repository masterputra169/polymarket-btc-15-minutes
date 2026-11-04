import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../trading/positionTracker.ts', () => ({
  getStats: vi.fn(),
}));

vi.mock('../notifier.ts', () => ({
  notify: vi.fn(),
}));

vi.mock('../../loop.ts', () => ({
  pauseBot: vi.fn(),
}));

import { getStats } from '../../trading/positionTracker.ts';
import { notify } from '../notifier.ts';
import { checkWinRate, resetPerfMonitorWinRateForTests } from '../perfMonitor.ts';

describe('perfMonitor checkWinRate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetPerfMonitorWinRateForTests();
  });

  it('skips check if trades < MIN_TRADES_FOR_ALERT (8)', () => {
    (getStats as any).mockReturnValue({ wins: 2, losses: 3, winRate: 0.40, consecutiveLosses: 0 });
    checkWinRate();
    expect(notify).not.toHaveBeenCalled();
  });

  it('alerts once on low win rate and throttles duplicate alerts on subsequent cycles if trade count is unchanged', () => {
    (getStats as any).mockReturnValue({ wins: 4, losses: 7, winRate: 4 / 11, consecutiveLosses: 1 });

    // First cycle
    checkWinRate();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith('warn', expect.stringContaining('Win rate LOW: 36.4% (4W/7L)'), { key: 'perf:win_rate_low' });

    // Subsequent cycles without new trades -> should be throttled
    checkWinRate();
    checkWinRate();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('alerts again when trade count changes and win rate remains low', () => {
    (getStats as any).mockReturnValue({ wins: 4, losses: 7, winRate: 4 / 11, consecutiveLosses: 1 });
    checkWinRate();
    expect(notify).toHaveBeenCalledTimes(1);

    // Another trade settles as a loss
    (getStats as any).mockReturnValue({ wins: 4, losses: 8, winRate: 4 / 12, consecutiveLosses: 2 });
    checkWinRate();
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenLastCalledWith('warn', expect.stringContaining('Win rate LOW: 33.3% (4W/8L)'), { key: 'perf:win_rate_low' });
  });

  it('resets alert state if win rate recovers above threshold', () => {
    (getStats as any).mockReturnValue({ wins: 4, losses: 7, winRate: 4 / 11, consecutiveLosses: 1 });
    checkWinRate();
    expect(notify).toHaveBeenCalledTimes(1);

    // Win rate recovers
    (getStats as any).mockReturnValue({ wins: 8, losses: 7, winRate: 8 / 15, consecutiveLosses: 0 });
    checkWinRate();
    expect(notify).toHaveBeenCalledTimes(1); // no new warn

    // Drops again on new trade
    (getStats as any).mockReturnValue({ wins: 8, losses: 13, winRate: 8 / 21, consecutiveLosses: 2 });
    checkWinRate();
    expect(notify).toHaveBeenCalledTimes(2);
  });
});
