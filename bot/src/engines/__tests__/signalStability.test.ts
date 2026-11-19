import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const ORIGINAL_POLL = process.env.POLL_INTERVAL_MS;

async function loadStabilityAt50ms() {
  vi.resetModules();
  process.env.POLL_INTERVAL_MS = '50';
  return await import('../signalStability.ts');
}

describe('signalStability wall-clock confirmation (9s target)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    if (ORIGINAL_POLL === undefined) delete process.env.POLL_INTERVAL_MS;
    else process.env.POLL_INTERVAL_MS = ORIGINAL_POLL;
  });

  test('slow 106ms polls stabilize near 9.0s (~86 polls) rather than 19.1s', async () => {
    const stab = await loadStabilityAt50ms();
    stab.resetSignalState();
    expect(stab.SIGNAL_CONFIRM_POLLS).toBe(180);
    expect(stab.SIGNAL_CONFIRM_TARGET_MS).toBe(9_000);

    const t0 = 1_795_000_000_000;
    let t = t0;
    let stableAtPolls = -1;
    for (let i = 1; i <= 185; i++) {
      stab.trackSignal('UP', t);
      stab.updateConfirmation('UP', t);
      if (stab.isSignalStable()) {
        stableAtPolls = i;
        break;
      }
      t += 106;
    }

    expect(stableAtPolls).toBe(86); // 85 * 106ms = 9010ms >= 9000ms
    expect(t - t0).toBe(9_010);
    expect(stab.getConfirmMs()).toBe(9_010);
    expect(stab.getConfirmCount()).toBe(180);
  });

  test('nominal 50ms polls stabilize at 9.0s (~181 polls)', async () => {
    const stab = await loadStabilityAt50ms();
    stab.resetSignalState();

    const t0 = 1_795_000_000_000;
    let t = t0;
    let stableAtPolls = -1;
    for (let i = 1; i <= 190; i++) {
      stab.trackSignal('DOWN', t);
      stab.updateConfirmation('DOWN', t);
      if (stab.isSignalStable()) {
        stableAtPolls = i;
        break;
      }
      t += 50;
    }

    expect(stableAtPolls).toBe(181); // 180 * 50ms = 9000ms
    expect(t - t0).toBe(9_000);
  });

  test('dt cap prevents a single 10s stall from confirming in 2 ticks', async () => {
    const stab = await loadStabilityAt50ms();
    stab.resetSignalState();

    const t0 = 1_795_000_000_000;
    stab.updateConfirmation('UP', t0);
    stab.updateConfirmation('UP', t0 + 10_000);
    expect(stab.getConfirmMs()).toBe(1_500);
    expect(stab.isSignalStable()).toBe(false);
  });

  test('fast-entry overrides scale wall-clock confirmation proportionally and expose elapsed seconds in reasons', async () => {
    const stab = await loadStabilityAt50ms();
    stab.resetSignalState();

    const t0 = 1_795_000_000_000;
    // mlConf >= 0.80 -> requiredPolls = 1 -> immediate
    stab.updateConfirmation('UP', t0);
    expect(stab.isSignalStable(1)).toBe(true);
    expect(stab.getSignalStabilityStatus(1).confirmTargetMs).toBe(0);

    // leadLagFast -> 15/180 -> 750ms
    expect(stab.isSignalStable(15)).toBe(false);
    expect(stab.getInstabilityReasons(15)[0]).toMatch(/^confirm \d+\/15 \(0\.0s\/0\.8s\)$/);
    for (let elapsed = 50; elapsed <= 750; elapsed += 50) {
      stab.updateConfirmation('UP', t0 + elapsed);
    }
    expect(stab.isSignalStable(15)).toBe(true);
    expect(stab.getSignalStabilityStatus(15).confirmTargetMs).toBe(750);

    // r4Surge -> 60/180 -> 3000ms; highEdge/limit -> 90/180 -> 4500ms
    expect(stab.isSignalStable(60)).toBe(false);
    expect(stab.getSignalStabilityStatus(60).confirmTargetMs).toBe(3_000);
    expect(stab.getSignalStabilityStatus(90).confirmTargetMs).toBe(4_500);
  });

  test('decayConfirmation tolerates a 1-poll flicker and clears on full drain', async () => {
    const stab = await loadStabilityAt50ms();
    stab.resetSignalState();

    const t0 = 1_795_000_000_000;
    stab.updateConfirmation('UP', t0);
    stab.updateConfirmation('UP', t0 + 50);
    stab.updateConfirmation('UP', t0 + 100);
    expect(stab.getConfirmMs()).toBe(100);

    // 1-poll flicker decays by step rather than wiping side/count completely
    stab.decayConfirmation(t0 + 150);
    expect(stab.getSignalStabilityStatus().confirmSide).toBe('UP');
    expect(stab.getConfirmMs()).toBe(50);

    // Continue decaying remaining polls until empty
    stab.decayConfirmation(t0 + 200);
    stab.decayConfirmation(t0 + 250);
    expect(stab.getSignalStabilityStatus().confirmSide).toBeNull();
    expect(stab.getConfirmCount()).toBe(0);
    expect(stab.getConfirmMs()).toBe(0);
  });

  test('flip-rate guard blocks stability even after 9s elapsed', async () => {
    const stab = await loadStabilityAt50ms();
    stab.resetSignalState();

    const t0 = 1_795_000_000_000;
    // Generate 11 flips (> MAX_FLIPS_TO_ENTER = 10 at 50ms) inside 15s window
    for (let i = 0; i <= 11; i++) {
      stab.trackSignal(i % 2 === 0 ? 'UP' : 'DOWN', t0 + i * 200);
    }
    let t = t0 + 2_500;
    for (let i = 0; i <= 185; i++) {
      stab.updateConfirmation('DOWN', t);
      t += 50;
    }
    expect(stab.getConfirmMs()).toBeGreaterThanOrEqual(9_000);
    expect(stab.isSignalStable()).toBe(false);
    expect(stab.getInstabilityReasons()).toContain('11 flips in 15s');
  });
});
