import { describe, it, expect } from 'vitest';
import { computeStepCompoundingCap, type StepCompoundingConfig } from '../stepCompounding.ts';

const baseCfg: StepCompoundingConfig = {
  enabled: true,
  baseBankroll: 100,
  stepBankroll: 50,
  baseBetUsd: 2.10,
  stepBetUsd: 0.90,
  maxBetUsd: 25.00,
  drawdownStepDownPct: 15,
};

describe('computeStepCompoundingCap', () => {
  it('stays flat at baseBetUsd across Tier 0 ($0..$149.99)', () => {
    expect(computeStepCompoundingCap(80, 100, baseCfg)).toMatchObject({ rawTier: 0, effectiveTier: 0, capUsd: 2.10, steppedDown: true });
    expect(computeStepCompoundingCap(100, 100, baseCfg)).toMatchObject({ rawTier: 0, effectiveTier: 0, capUsd: 2.10, steppedDown: false });
    expect(computeStepCompoundingCap(117.45, 117.45, baseCfg)).toMatchObject({ rawTier: 0, effectiveTier: 0, capUsd: 2.10, steppedDown: false });
    expect(computeStepCompoundingCap(149.99, 149.99, baseCfg)).toMatchObject({ rawTier: 0, effectiveTier: 0, capUsd: 2.10, steppedDown: false });
  });

  it('steps up cleanly at every $50 bankroll tier and respects maxBetUsd ceiling', () => {
    expect(computeStepCompoundingCap(150, 150, baseCfg)).toMatchObject({ rawTier: 1, effectiveTier: 1, capUsd: 3.00, steppedDown: false });
    expect(computeStepCompoundingCap(200, 200, baseCfg)).toMatchObject({ rawTier: 2, effectiveTier: 2, capUsd: 3.90, steppedDown: false });
    expect(computeStepCompoundingCap(250, 250, baseCfg)).toMatchObject({ rawTier: 3, effectiveTier: 3, capUsd: 4.80, steppedDown: false });
    expect(computeStepCompoundingCap(2000, 2000, baseCfg)).toMatchObject({ capUsd: 25.00 });
  });

  it('auto steps down 1 tier on >=15% peak drawdown and resets to Tier 0 on >=30% drawdown', () => {
    // Peak $240 -> bankroll $201.60 (-16% dd, rawTier=2 -> effectiveTier=1 -> $3.00)
    const dd16 = computeStepCompoundingCap(201.60, 240, baseCfg);
    expect(dd16.rawTier).toBe(2);
    expect(dd16.effectiveTier).toBe(1);
    expect(dd16.steppedDown).toBe(true);
    expect(dd16.capUsd).toBe(3.00);

    // Peak $320 -> bankroll $220 (-31.25% dd, rawTier=2 -> reset to Tier 0 -> $2.10)
    const dd31 = computeStepCompoundingCap(220, 320, baseCfg);
    expect(dd31.rawTier).toBe(2);
    expect(dd31.effectiveTier).toBe(0);
    expect(dd31.steppedDown).toBe(true);
    expect(dd31.capUsd).toBe(2.10);
  });
});
