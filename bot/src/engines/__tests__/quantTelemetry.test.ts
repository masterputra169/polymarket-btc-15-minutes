import { describe, it, expect } from 'vitest';
import { KinematicKalmanTracker } from '../settlePrice.ts';
import { recordOrderFlowTrades, getOrderFlowFeatures, resetOrderFlow } from '../orderFlowFeatures.ts';

describe('KinematicKalmanTracker (2-State Price/Velocity + Adaptive Basis)', () => {
  it('tracks positive velocity and fires positive innovationZ on sudden upward jump', () => {
    const kf = new KinematicKalmanTracker();
    let t = 1_700_000_000_000;
    for (let i = 0; i < 15; i++) {
      kf.update(61_000 + i * 2, t, 61_025 + i * 2, 61_000 + i * 2);
      t += 1_000;
    }
    const steady = kf.getSnapshot()!;
    expect(steady.velocityUsdPerSec).toBeGreaterThan(1.0);
    expect(steady.adaptiveBasisUsd).toBeCloseTo(25, 0);
    expect(steady.samples).toBe(15);

    // Sudden +$45 momentum break
    const jump = kf.update(61_075, t, 61_100, 61_075)!;
    expect(jump.innovationZ).toBeGreaterThan(2.0);
    expect(jump.velocityUsdPerSec).toBeGreaterThan(steady.velocityUsdPerSec);
  });

  it('adapts basis Kalman gain when sustained basis widens while smoothing single-tick spikes', () => {
    const kf = new KinematicKalmanTracker();
    let t = 1_700_000_000_000;
    for (let i = 0; i < 10; i++) {
      kf.update(61_000, t, 61_020, 61_000);
      t += 1_000;
    }
    const beforeSpike = kf.getSnapshot()!.adaptiveBasisUsd!;
    // Single-tick +$80 glitch shouldn't jump all the way to $80
    const afterSpike = kf.update(61_000, t, 61_080, 61_000)!.adaptiveBasisUsd!;
    expect(afterSpike - beforeSpike).toBeLessThan(35);
  });
});

describe("OrderFlowFeatures Kyle's Lambda", () => {
  it('computes positive Kyle lambda and high R^2 when signed volume drives price linearly', () => {
    resetOrderFlow();
    const now = 1_700_000_000_000;
    const trades = [
      { t: now - 6000, token: 'up' as const, side: 'BUY' as const, price: 0.50, size: 100 },
      { t: now - 5000, token: 'up' as const, side: 'BUY' as const, price: 0.52, size: 200 },
      { t: now - 4000, token: 'up' as const, side: 'SELL' as const, price: 0.51, size: 100 },
      { t: now - 3000, token: 'up' as const, side: 'BUY' as const, price: 0.54, size: 300 },
      { t: now - 2000, token: 'up' as const, side: 'SELL' as const, price: 0.52, size: 200 },
      { t: now - 1000, token: 'up' as const, side: 'BUY' as const, price: 0.53, size: 100 },
      { t: now - 500, token: 'down' as const, side: 'BUY' as const, price: 0.49, size: 200 }, // bearish -> upPx 0.51
    ];
    recordOrderFlowTrades(trades, 'test-slug', now);
    const feat = getOrderFlowFeatures();
    expect(feat.kylesLambda).not.toBeNull();
    expect(feat.kylesLambda!).toBeGreaterThan(5); // ~10c per 1,000 shares
    expect(feat.kylesLambdaR2!).toBeGreaterThan(0.9);
  });
});
