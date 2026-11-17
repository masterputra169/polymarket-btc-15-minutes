/**
 * GhostGuard — Real-time ghost-fill scoring & on-chain receipt verification.
 *
 * Inspired by OrderBookTrade/GhostGuard:
 * A CLOB fill report (WebSocket or trade history) can arrive before or without
 * a successful Polygon settlement transaction (e.g. reverted with status=0 via
 * nonce invalidation, wallet drain / TRANSFER_FROM_FAILED, or gas front-run).
 *
 * Two layers:
 *   1. Predictive anomaly score (instant, zero latency):
 *        score = clamp(|tradePrice - midPrice| / midPrice * 5.0
 *                      + max(0, log2(tradeSize / avgTradeSize)) * 0.3, 0, 1)
 *      Emits an early warning when score >= PREDICTIVE_WARN_THRESHOLD once at
 *      least MIN_SIZE_SAMPLES trades exist.
 *   2. On-chain receipt check (eth_getTransactionReceipt):
 *        receipt.status === '0x1' -> 'real'
 *        receipt.status === '0x0' -> 'ghost'  (confirmed revert on-chain)
 *        receipt === null         -> 'pending' (still in mempool)
 *        RPC error / timeout      -> 'rpc_error' (never misclassified as ghost)
 */

import { polygonRpcUrl } from './polygonRpc.ts';

export const PREDICTIVE_WARN_THRESHOLD = 0.65;
export const MIN_SIZE_SAMPLES = 5;
const DEFAULT_RPC_TIMEOUT_MS = 5_000;

export type TxReceiptStatus = 'real' | 'ghost' | 'pending' | 'rpc_error';

export interface TxReceiptVerdict {
  status: TxReceiptStatus;
  txHash: string;
  blockNumber: number | null;
  error?: string;
}

export interface PredictiveScoreInput {
  tradePrice: number | null | undefined;
  midPrice: number | null | undefined;
  tradeSize: number | null | undefined;
  rollingAvgSize: number | null | undefined;
  sampleCount: number;
}

export interface PredictiveScoreResult {
  score: number;
  priceDeviation: number;
  sizeRatio: number;
  suspicious: boolean;
}

export interface GhostGuardStats {
  checked: number;
  real: number;
  ghost: number;
  pending: number;
  rpcErrors: number;
  suspiciousWarnings: number;
  lastGhostTx: string | null;
  lastGhostAtMs: number | null;
}

let stats: GhostGuardStats = {
  checked: 0,
  real: 0,
  ghost: 0,
  pending: 0,
  rpcErrors: 0,
  suspiciousWarnings: 0,
  lastGhostTx: null,
  lastGhostAtMs: null,
};

/** Extract txHash from heterogeneous CLOB Trade objects safely. */
export function extractTxHashFromTrade(trade: unknown): string | null {
  if (!trade || typeof trade !== 'object') return null;
  const t = trade as Record<string, unknown>;
  const raw = t.transaction_hash ?? t.transactionHash ?? t.txHash ?? t.tx_hash;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return /^0x[0-9a-fA-F]{64}$/.test(trimmed) ? trimmed : null;
}

/**
 * Predictive anomaly score matching OrderBookTrade/GhostGuard.
 * Returns null when cold-start (< MIN_SIZE_SAMPLES) or missing valid price/size inputs.
 */
export function scorePredictiveGhostFill({
  tradePrice,
  midPrice,
  tradeSize,
  rollingAvgSize,
  sampleCount,
}: PredictiveScoreInput): PredictiveScoreResult | null {
  if (sampleCount < MIN_SIZE_SAMPLES) return null;
  if (
    tradePrice == null || !Number.isFinite(tradePrice) || tradePrice <= 0 ||
    midPrice == null || !Number.isFinite(midPrice) || midPrice <= 0 ||
    tradeSize == null || !Number.isFinite(tradeSize) || tradeSize <= 0 ||
    rollingAvgSize == null || !Number.isFinite(rollingAvgSize) || rollingAvgSize <= 0
  ) {
    return null;
  }

  const priceDeviation = Math.abs(tradePrice - midPrice) / midPrice;
  const sizeRatio = tradeSize / rollingAvgSize;
  const sizeTerm = sizeRatio > 1 ? Math.log2(sizeRatio) * 0.3 : 0;
  const rawScore = priceDeviation * 5.0 + sizeTerm;
  const score = Math.max(0, Math.min(1, rawScore));

  return {
    score,
    priceDeviation,
    sizeRatio,
    suspicious: score >= PREDICTIVE_WARN_THRESHOLD,
  };
}

/**
 * Query Polygon JSON-RPC `eth_getTransactionReceipt` directly without throwing.
 * Distinguishes RPC/network failure ('rpc_error') from genuine reverts ('ghost').
 */
export async function verifyTxReceiptOnChain(
  txHash: string,
  options: {
    rpcUrl?: string;
    timeoutMs?: number;
    fetchFn?: typeof fetch;
  } = {},
): Promise<TxReceiptVerdict> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return { status: 'rpc_error', txHash, blockNumber: null, error: 'invalid_tx_hash' };
  }

  const rpcUrl = options.rpcUrl ?? polygonRpcUrl();
  const timeoutMs = Math.max(500, options.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS);
  const fetchFn = options.fetchFn ?? fetch;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchFn(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getTransactionReceipt',
        params: [txHash],
      }),
      signal: ac.signal,
    });
    if (!res.ok) {
      return { status: 'rpc_error', txHash, blockNumber: null, error: `http_${res.status}` };
    }
    const payload = await res.json() as {
      error?: { message?: string; code?: number };
      result?: { status?: string; blockNumber?: string } | null;
    };
    if (payload.error) {
      return {
        status: 'rpc_error',
        txHash,
        blockNumber: null,
        error: payload.error.message || `rpc_${payload.error.code ?? 'err'}`,
      };
    }
    if (payload.result == null) {
      return { status: 'pending', txHash, blockNumber: null };
    }
    const blockNumber = typeof payload.result.blockNumber === 'string'
      ? Number.parseInt(payload.result.blockNumber, 16)
      : null;
    const hexStatus = String(payload.result.status ?? '').toLowerCase();
    if (hexStatus === '0x1' || hexStatus === '1') {
      return { status: 'real', txHash, blockNumber: Number.isFinite(blockNumber) ? blockNumber : null };
    }
    if (hexStatus === '0x0' || hexStatus === '0') {
      return { status: 'ghost', txHash, blockNumber: Number.isFinite(blockNumber) ? blockNumber : null };
    }
    return { status: 'rpc_error', txHash, blockNumber: null, error: `unexpected_status:${hexStatus}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: 'rpc_error', txHash, blockNumber: null, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

export function recordPredictiveWarning(): void {
  stats.suspiciousWarnings += 1;
}

export function recordGhostGuardVerdict(verdict: TxReceiptVerdict, nowMs = Date.now()): void {
  stats.checked += 1;
  if (verdict.status === 'real') stats.real += 1;
  else if (verdict.status === 'ghost') {
    stats.ghost += 1;
    stats.lastGhostTx = verdict.txHash;
    stats.lastGhostAtMs = nowMs;
  } else if (verdict.status === 'pending') stats.pending += 1;
  else stats.rpcErrors += 1;
}

export function getGhostGuardStats(): GhostGuardStats {
  return { ...stats };
}

export function resetGhostGuardStats(): void {
  stats = {
    checked: 0,
    real: 0,
    ghost: 0,
    pending: 0,
    rpcErrors: 0,
    suspiciousWarnings: 0,
    lastGhostTx: null,
    lastGhostAtMs: null,
  };
}
