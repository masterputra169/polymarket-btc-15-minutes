import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  evaluateMilestones,
  reconcileMilestoneAlerts,
  type MilestoneInputs,
} from '../milestoneMonitor.ts';
import type { notify } from '../notifier.ts';

function baseInputs(overrides: Partial<MilestoneInputs> = {}): MilestoneInputs {
  return {
    onlineCalib: {
      mode: 'active',
      effectiveMode: 'active',
      historySize: 300,
      allowActive: true,
      rawMlBrier: 0.2323,
      calMlBrier: 0.2319,
      promoteMinWindows: 100,
    },
    jevV5: {
      mode: 'veto',
      v5Windows: 253,
      skillPct: -0.07,
      dirAccPct: 64.7,
    },
    metaLabeler: {
      mode: 'auto',
      effectiveMode: 'shadow',
      autoPromoted: false,
      samples: 75,
      holdoutAuc: 0.8036,
      baseWinRate: 0.68,
      promoteMinSamples: 100,
      promoteMinAuc: 0.58,
    },
    makerAudit: {
      postPatchFills: 0,
      wins: 0,
      m15Avg: null,
      m60Avg: null,
      minFills: 15,
    },
    tapeDays: 63,
    paperPerformance: {
      totalTrades: 75,
      winRate: 0.68,
      avgEntryPrice: 0.635,
    },
    dryRun: true,
    ...overrides,
  };
}

describe('milestoneMonitor', () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length > 0) {
      rmSync(dirs.pop()!, { recursive: true, force: true });
    }
  });

  function tempStateFile(): string {
    const d = mkdtempSync(join(tmpdir(), 'poly-milestone-'));
    dirs.push(d);
    return join(d, 'milestone_state.json');
  }

  it('seeds already-active milestones silently on first boot and alerts once when Meta-Labeler auto-promotes', async () => {
    const stateFile = tempStateFile();
    const sendNotify = vi.fn<typeof notify>(async () => true);

    // Cycle 1: current VPS baseline (online_ml & jev_v5 active, meta_labeler 75/100 WAIT) -> zero alerts
    const r1 = evaluateMilestones(baseInputs());
    const out1 = await reconcileMilestoneAlerts(r1, stateFile, sendNotify);
    expect(out1.alerted).toEqual([]);
    expect(sendNotify).not.toHaveBeenCalled();

    // Cycle 2: Meta-Labeler crosses 100 trades with AUC 0.8036 and auto-promotes to VETO -> alerts once
    const r2 = evaluateMilestones(baseInputs({
      metaLabeler: {
        mode: 'auto',
        effectiveMode: 'veto',
        autoPromoted: true,
        samples: 100,
        holdoutAuc: 0.8036,
        baseWinRate: 0.69,
        promoteMinSamples: 100,
        promoteMinAuc: 0.58,
      },
    }));
    const out2 = await reconcileMilestoneAlerts(r2, stateFile, sendNotify);
    expect(out2.alerted).toEqual(['meta_labeler_veto']);
    expect(sendNotify).toHaveBeenCalledTimes(1);
    expect(sendNotify.mock.calls[0][0]).toBe('info');
    expect(sendNotify.mock.calls[0][1]).toContain('AUTO-PROMOTED');
    expect(sendNotify.mock.calls[0][1]).toContain('Stage-2 Meta-Labeler');

    // Cycle 3: same state on next 15m poll -> deduplicated, zero new alerts
    const out3 = await reconcileMilestoneAlerts(r2, stateFile, sendNotify);
    expect(out3.alerted).toEqual([]);
    expect(sendNotify).toHaveBeenCalledTimes(1);

    // Cycle 4: self-guard demotes Meta-Labeler back to shadow (AUC drop) -> warn alert sent
    const r4 = evaluateMilestones(baseInputs({
      metaLabeler: {
        mode: 'auto',
        effectiveMode: 'shadow',
        autoPromoted: false,
        samples: 110,
        holdoutAuc: 0.54,
        baseWinRate: 0.65,
        promoteMinSamples: 100,
        promoteMinAuc: 0.58,
      },
    }));
    const out4 = await reconcileMilestoneAlerts(r4, stateFile, sendNotify);
    expect(out4.alerted).toEqual(['meta_labeler_veto']);
    expect(sendNotify).toHaveBeenCalledTimes(2);
    expect(sendNotify.mock.calls[1][0]).toBe('warn');
    expect(sendNotify.mock.calls[1][1]).toContain('AUTO-DEMOTED');
  });

  it('alerts maker_markout_audit, tape_v4_retrain, and live_money_readiness advisory without mutating dryRun', async () => {
    const stateFile = tempStateFile();
    const sendNotify = vi.fn<typeof notify>(async () => true);

    await reconcileMilestoneAlerts(evaluateMilestones(baseInputs()), stateFile, sendNotify);

    const readyAll = evaluateMilestones(baseInputs({
      metaLabeler: {
        mode: 'auto',
        effectiveMode: 'veto',
        autoPromoted: true,
        samples: 102,
        holdoutAuc: 0.78,
        baseWinRate: 0.69,
        promoteMinSamples: 100,
        promoteMinAuc: 0.58,
      },
      makerAudit: {
        postPatchFills: 16,
        wins: 12,
        m15Avg: 0.012,
        m60Avg: 0.018,
        minFills: 15,
      },
      tapeDays: 75,
      paperPerformance: {
        totalTrades: 102,
        winRate: 0.69,
        avgEntryPrice: 0.635,
      },
      dryRun: true,
    }));

    const out = await reconcileMilestoneAlerts(readyAll, stateFile, sendNotify);
    expect(out.alerted).toEqual([
      'meta_labeler_veto',
      'maker_markout_audit',
      'tape_v4_retrain',
      'live_money_readiness',
    ]);
    const liveRes = readyAll.find(m => m.id === 'live_money_readiness')!;
    expect(liveRes.status).toBe('ready');
    expect(liveRes.autoManaged).toBe(false);
    expect(liveRes.detail).toContain('konfirmasi manual');
  });
});
