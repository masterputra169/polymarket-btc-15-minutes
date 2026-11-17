import { beforeEach, describe, expect, it } from 'vitest';
import {
  PREDICTIVE_WARN_THRESHOLD,
  extractTxHashFromTrade,
  getGhostGuardStats,
  recordGhostGuardVerdict,
  recordPredictiveWarning,
  resetGhostGuardStats,
  scorePredictiveGhostFill,
  verifyTxReceiptOnChain,
} from '../ghostGuard.ts';

describe('ghostGuard', () => {
  beforeEach(() => {
    resetGhostGuardStats();
  });

  it('extracts valid 32-byte tx hashes across heterogeneous trade shapes', () => {
    const valid = '0x' + 'a'.repeat(64);
    expect(extractTxHashFromTrade({ transaction_hash: valid })).toBe(valid);
    expect(extractTxHashFromTrade({ transactionHash: valid })).toBe(valid);
    expect(extractTxHashFromTrade({ transaction_hash: 'not-a-hash' })).toBeNull();
    expect(extractTxHashFromTrade(null)).toBeNull();
  });

  it('scores predictive anomalies only after MIN_SIZE_SAMPLES and flags suspicious deviations', () => {
    expect(scorePredictiveGhostFill({
      tradePrice: 0.70,
      midPrice: 0.50,
      tradeSize: 50,
      rollingAvgSize: 10,
      sampleCount: 4,
    })).toBeNull();

    const normal = scorePredictiveGhostFill({
      tradePrice: 0.605,
      midPrice: 0.600,
      tradeSize: 5,
      rollingAvgSize: 5,
      sampleCount: 10,
    });
    expect(normal?.suspicious).toBe(false);
    expect(normal?.score).toBeLessThan(0.1);

    const weird = scorePredictiveGhostFill({
      tradePrice: 0.60,
      midPrice: 0.50, // 20% dev * 5.0 -> 1.0 (clamped)
      tradeSize: 40,  // 8x avg -> log2(8) * 0.3 = 0.9
      rollingAvgSize: 5,
      sampleCount: 10,
    });
    expect(weird?.score).toBe(1);
    expect(weird?.suspicious).toBe(true);
    expect(weird!.score).toBeGreaterThanOrEqual(PREDICTIVE_WARN_THRESHOLD);
  });

  it('verifies Polygon transaction receipts cleanly without confusing RPC errors for ghost fills', async () => {
    const tx = '0x' + 'b'.repeat(64);

    const real = await verifyTxReceiptOnChain(tx, {
      rpcUrl: 'https://rpc.test',
      fetchFn: async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { status: '0x1', blockNumber: '0x10' } })),
    });
    expect(real).toEqual({ status: 'real', txHash: tx, blockNumber: 16 });
    recordGhostGuardVerdict(real);

    const ghost = await verifyTxReceiptOnChain(tx, {
      rpcUrl: 'https://rpc.test',
      fetchFn: async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { status: '0x0', blockNumber: '0x11' } })),
    });
    expect(ghost).toEqual({ status: 'ghost', txHash: tx, blockNumber: 17 });
    recordGhostGuardVerdict(ghost, 123456);

    const pending = await verifyTxReceiptOnChain(tx, {
      rpcUrl: 'https://rpc.test',
      fetchFn: async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: null })),
    });
    expect(pending).toEqual({ status: 'pending', txHash: tx, blockNumber: null });
    recordGhostGuardVerdict(pending);

    const rpcErr = await verifyTxReceiptOnChain(tx, {
      rpcUrl: 'https://rpc.test',
      fetchFn: async () => { throw new Error('ECONNREFUSED'); },
    });
    expect(rpcErr.status).toBe('rpc_error');
    expect(rpcErr.error).toContain('ECONNREFUSED');
    recordGhostGuardVerdict(rpcErr);
    recordPredictiveWarning();

    expect(getGhostGuardStats()).toEqual({
      checked: 4,
      real: 1,
      ghost: 1,
      pending: 1,
      rpcErrors: 1,
      suspiciousWarnings: 1,
      lastGhostTx: tx,
      lastGhostAtMs: 123456,
    });
  });
});
