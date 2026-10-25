import { describe, it, expect, beforeEach } from 'vitest';
import { recordOrderFlowBook, recordOrderFlowTrades, getOrderFlowFeatures, resetOrderFlow } from '../orderFlowFeatures.ts';

const book = (over: Record<string, number | null> = {}) => ({
  bestBid: 0.50, bestAsk: 0.52, spread: 0.02,
  bidLiquidity: 200, askLiquidity: 100, bidSize: 100, askSize: 50,
  ...over,
});

describe('order-flow features', () => {
  beforeEach(() => resetOrderFlow());

  it('computes mid, microprice edge, depth and top imbalance', () => {
    recordOrderFlowBook(book(), null, 'm1', 1000);
    const f = getOrderFlowFeatures();
    expect(f.ok).toBe(true);
    expect(f.mid).toBeCloseTo(0.51, 6);
    expect(f.microprice).toBeCloseTo((0.52 * 100 + 0.50 * 50) / 150, 6);
    expect(f.micropriceEdgePct).toBeGreaterThan(0);
    expect(f.depthImbalance).toBeCloseTo(1 / 3, 6);
    expect(f.topImbalance).toBeCloseTo(1 / 3, 6);
    expect(f.sampleCount).toBe(1);
  });

  it('computes positive OFI when bid size grows and ask size falls', () => {
    recordOrderFlowBook(book(), null, 'm1', 1000);
    recordOrderFlowBook(book({ bidSize: 150, askSize: 40 }), null, 'm1', 2000);
    expect(getOrderFlowFeatures().ofi).toBeGreaterThan(0);
  });

  it('computes trade-flow imbalance and a VPIN proxy', () => {
    recordOrderFlowBook(book(), null, 'm1', 1000);
    recordOrderFlowTrades([
      { t: 1000, token: 'up', side: 'BUY', price: 0.51, size: 60 },
      { t: 1001, token: 'up', side: 'SELL', price: 0.51, size: 20 },
      { t: 1002, token: 'down', side: 'BUY', price: 0.49, size: 30 },
    ], 'm1', 3000);
    const f = getOrderFlowFeatures();
    expect(f.buyVolume).toBe(60);
    expect(f.sellVolume).toBe(50);
    expect(f.tradeImbalance).toBeCloseTo(10 / 110, 6);
    expect(f.vpin).toBeGreaterThanOrEqual(0);
    expect(f.vpin).toBeLessThanOrEqual(1);
    expect(f.tradeCount).toBe(3);
  });

  it('resets state when the market slug changes', () => {
    recordOrderFlowBook(book(), null, 'm1', 1000);
    recordOrderFlowTrades([{ t: 1000, token: 'up', side: 'BUY', price: 0.51, size: 10 }], 'm1', 2000);
    recordOrderFlowBook(book({ bidSize: 10, askSize: 10 }), null, 'm2', 3000);
    const f = getOrderFlowFeatures();
    expect(f.sampleCount).toBe(1);
    expect(f.tradeCount).toBe(0);
    expect(f.ofi).toBe(0);
  });
});
