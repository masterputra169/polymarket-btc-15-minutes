/**
 * Maker fill gate — pure helpers for resting limit orders.
 *
 * Evidence (makerFillStudy.py on the tape): resting bids fill ~60% within 15 s
 * and save ~1¢ + the taker fee; adverse selection is still unresolved, so an
 * unfilled order must not always fall through to a taker FOK. This module:
 *   1. Cancels a resting order that sits too long without a fill.
 *   2. Cancels when the fee-adjusted edge at the limit price erodes.
 *   3. Allows FOK fallback only when cancel was time/unfilled and edge remains.
 *   4. Deterministic dry-run maker fill draw (slug-hashed) for paper parity.
 */

import { polyTakerFeePerShare } from '../../../src/config.ts';

export type MakerCancelReason =
  | 'unfilled_timeout'
  | 'edge_erosion'
  | 'signal_flip'
  | 'time_cutoff'
  | 'market_switch'
  | 'partial_reject'
  | 'other';

/** Fee-adjusted edge for a buy: P(side) − ask − takerFeePerShare(ask). */
export function feeAdjustedEdge(
  sideProb: number | null | undefined,
  ask: number | null | undefined,
): number | null {
  if (!Number.isFinite(sideProb) || !Number.isFinite(ask)) return null;
  const p = sideProb as number;
  const a = ask as number;
  if (p <= 0 || p >= 1 || a <= 0 || a >= 1) return null;
  return p - a - polyTakerFeePerShare(a);
}

/** Edge at our resting limit (makers pay 0 fee): P(side) − limitPrice. */
export function limitRemainingEdge(
  sideProb: number | null | undefined,
  limitPrice: number | null | undefined,
): number | null {
  if (!Number.isFinite(sideProb) || !Number.isFinite(limitPrice)) return null;
  const p = sideProb as number;
  const lim = limitPrice as number;
  if (p <= 0 || p >= 1 || lim <= 0 || lim >= 1) return null;
  return p - lim;
}

export function shouldCancelUnfilled(heldSec: number, maxUnfilledSec: number): boolean {
  if (!Number.isFinite(heldSec) || !Number.isFinite(maxUnfilledSec)) return false;
  if (maxUnfilledSec <= 0) return false;
  return heldSec >= maxUnfilledSec;
}

export function shouldCancelEdgeErosion(
  sideProb: number | null | undefined,
  limitPrice: number | null | undefined,
  minRemainingEdge: number,
): boolean {
  const edge = limitRemainingEdge(sideProb, limitPrice);
  if (edge == null) return false;
  return edge < minRemainingEdge;
}

/**
 * After a limit cancel, may the directional FOK path take over?
 * Signal flips / market switches / partial rejects → no.
 * Time cutoff / unfilled timeout → only if fee-adjusted edge clears the floor.
 */
export function shouldAllowFokFallback({
  cancelReason,
  sideProb,
  ask,
  minEdge,
}: {
  cancelReason: MakerCancelReason | string;
  sideProb: number | null | undefined;
  ask: number | null | undefined;
  minEdge: number;
}): { allow: boolean; reason: string } {
  const reason = String(cancelReason || 'other');
  if (
    reason === 'signal_flip' ||
    reason.startsWith('ml_flip') ||
    reason === 'market_switch' ||
    reason.startsWith('market_switched') ||
    reason === 'partial_reject'
  ) {
    return { allow: false, reason: `no_fok_after_${reason}` };
  }

  if (reason !== 'unfilled_timeout' && reason !== 'time_cutoff' && !reason.startsWith('elapsed_')) {
    // Unknown / other cancels: fail closed — do not chase with FOK.
    if (reason !== 'other') {
      return { allow: false, reason: `no_fok_after_${reason}` };
    }
  }

  const edge = feeAdjustedEdge(sideProb, ask);
  if (edge == null) {
    return { allow: false, reason: 'no_fok_missing_edge_inputs' };
  }
  if (edge < minEdge) {
    return { allow: false, reason: `no_fok_edge_${(edge * 100).toFixed(1)}pp<${(minEdge * 100).toFixed(0)}pp` };
  }
  return { allow: true, reason: `fok_ok_edge_${(edge * 100).toFixed(1)}pp` };
}

/** JOIN maker price: best bid, floored at minEntry and capped below the ask. */
export function makerJoinPrice(
  bestBid: number | null | undefined,
  bestAsk: number | null | undefined,
  minEntry = 0.50,
  tick = 0.01,
): number | null {
  if (!Number.isFinite(bestBid) || (bestBid as number) <= 0) return null;
  let px = Math.max(minEntry, bestBid as number);
  if (Number.isFinite(bestAsk) && (bestAsk as number) > tick) {
    px = Math.min(px, (bestAsk as number) - tick);
  }
  if (px < minEntry) return null;
  return Math.round(px * 100) / 100;
}

/**
 * Deterministic dry-run fill draw from market slug (stable across polls).
 * fillRate 0.60 ≈ makerFillStudy 15 s JOIN fill rate on the tape.
 */
export function dryRunMakerWouldFill(marketSlug: string, fillRate: number): boolean {
  const rate = Number.isFinite(fillRate) ? Math.min(1, Math.max(0, fillRate)) : 0;
  if (rate <= 0) return false;
  if (rate >= 1) return true;
  const s = String(marketSlug || '');
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const u = ((h >>> 0) % 10000) / 10000;
  return u < rate;
}

export function classifyCancelReason(actionOrDetail: string): MakerCancelReason {
  const s = String(actionOrDetail || '');
  if (s.includes('UNFILLED') || s.includes('unfilled_timeout')) return 'unfilled_timeout';
  if (s.includes('EDGE_EROSION') || s.includes('edge_erosion')) return 'edge_erosion';
  if (s.includes('SIGNAL_FLIP') || s.includes('ml_flip')) return 'signal_flip';
  if (s.includes('TIME_CUTOFF') || s.startsWith('elapsed_')) return 'time_cutoff';
  if (s.includes('MARKET_SWITCH') || s.includes('market_switched')) return 'market_switch';
  if (s.includes('PARTIAL_REJECT') || s.includes('partial_reject')) return 'partial_reject';
  return 'other';
}
