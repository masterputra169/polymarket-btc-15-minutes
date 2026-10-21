import { describe, expect, test } from 'vitest';
import { assessDrift } from '../driftDetector.ts';
import type { DriftThresholds, MlDriftTrade } from '../driftDetector.ts';

const CFG: DriftThresholds = { wrDropPp: 15, cusumThreshold: 5, confDrop: 0.08 };

function trades(n: number, wins: number, conf = 0.45): MlDriftTrade[] {
  return Array.from({ length: n }, (_, i) => ({
    ts: 1_700_000_000_000 + i * 60_000,
    mlWasRight: i < wins,
    mlConf: conf,
  }));
}

/** ~67% wins spread across every 20-trade slice. */
function stableTrades(n: number, conf = 0.45): MlDriftTrade[] {
  return Array.from({ length: n }, (_, i) => ({
    ts: 1_700_000_000_000 + i * 60_000,
    mlWasRight: i % 3 !== 0,
    mlConf: conf,
  }));
}

describe('drift detector gates', () => {
  test('stable live window against live same-model baseline does not fire', () => {
    // 64% recent vs a 64.25% live reference is a 0.25pp change, not drift.
    const r = assessDrift(stableTrades(50), 0.6425, 0.447, 0, CFG);
    expect(r.accuracy).toBeCloseTo(0.66, 3);
    expect(r.drop).toBeLessThan(0);
    expect(r.hardFire).toBe(false);
    expect(r.cusumFire).toBe(false);
    expect(r.driftDetected).toBe(false);
  });

  test('a genuine 20pp accuracy drop triggers the hard gate', () => {
    const r = assessDrift(trades(50, 22), 0.65, 0.45, 0, CFG);
    expect(r.drop).toBeCloseTo(0.21, 4);
    expect(r.hardFire).toBe(true);
    expect(r.driftDetected).toBe(true);
  });

  test('a sharp recent-20 drop fires even when the 50-trade window looks fine', () => {
    const rows = [...trades(30, 23), ...trades(20, 8).map((t, i) => ({ ...t, ts: 1_700_000_100_000 + i }))];
    const r = assessDrift(rows, 0.65, 0.45, 0, CFG);
    expect(r.recentAccuracy).toBeCloseTo(0.4, 4);
    expect(r.hardFire).toBe(true);
  });

  test('confidence drop is advisory, not a drift trigger', () => {
    const rows = stableTrades(50, 0.30);
    const r = assessDrift(rows, 0.65, 0.50, 0, CFG);
    expect(r.accuracy).toBeCloseTo(0.66, 3);
    expect(r.confFire).toBe(true);
    expect(r.cusumFire).toBe(false);
    expect(r.hardFire).toBe(false);
    expect(r.driftDetected).toBe(false);
  });

  test('CUSUM can trigger on its own', () => {
    const r = assessDrift(trades(50, 32), 0.65, 0.45, 5.17, CFG);
    expect(r.cusumFire).toBe(true);
    expect(r.driftDetected).toBe(true);
  });
});
