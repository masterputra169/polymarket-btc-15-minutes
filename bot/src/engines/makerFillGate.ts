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
  | 'toxic_flow'
  | 'clob_down'
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
 * Pull a resting bid before adverse selection hits when live TWAP fair value
 * turns against our side:
 *  - Inside `maxSecsLeft` (default last 180s, where TWAP math is sharp): cancel if
 *    `twapSideProb - limitPrice < minEdge`.
 *  - Inside `hardMaxSecsLeft` (default last 300s): cancel immediately if
 *    `twapSideProb - limitPrice < hardDeficit` (-5pp).
 *  - Earlier (`secsLeft > hardMaxSecsLeft`): only pull on extreme collapse
 *    `earlyHardDeficit` (-15pp), so Brownian `1.4× σ √T` compression in EARLY
 *    windows does not pull healthy bids (e.g. `07:31` at 13.6m, 58.1% vs 64c).
 */
export function shouldCancelTwapAdverse({
  twapProbUp,
  side,
  limitPrice,
  secsLeft,
  maxSecsLeft = 180,
  minEdge = 0.03,
  hardDeficit = -0.05,
  hardMaxSecsLeft = 300,
  earlyHardDeficit = -0.15,
}: {
  twapProbUp: number | null | undefined;
  side: 'UP' | 'DOWN' | string | null | undefined;
  limitPrice: number | null | undefined;
  secsLeft: number | null | undefined;
  maxSecsLeft?: number;
  minEdge?: number;
  hardDeficit?: number;
  hardMaxSecsLeft?: number;
  earlyHardDeficit?: number;
}): { cancel: boolean; reason: string | null; twapEdge: number | null } {
  if (!Number.isFinite(twapProbUp) || (side !== 'UP' && side !== 'DOWN')) {
    return { cancel: false, reason: null, twapEdge: null };
  }
  const sideProb = side === 'UP' ? (twapProbUp as number) : 1 - (twapProbUp as number);
  const twapEdge = limitRemainingEdge(sideProb, limitPrice);
  if (twapEdge == null) return { cancel: false, reason: null, twapEdge: null };

  const isEarly = secsLeft != null && Number.isFinite(secsLeft) && secsLeft > hardMaxSecsLeft;
  const activeHardDeficit = isEarly ? earlyHardDeficit : hardDeficit;
  if (twapEdge < activeHardDeficit) {
    return {
      cancel: true,
      reason: `twap_adverse_${(twapEdge * 100).toFixed(1)}pp<${(activeHardDeficit * 100).toFixed(0)}pp`,
      twapEdge,
    };
  }
  if (secsLeft != null && Number.isFinite(secsLeft) && secsLeft <= maxSecsLeft && twapEdge < minEdge) {
    return {
      cancel: true,
      reason: `twap_late_erosion_${(twapEdge * 100).toFixed(1)}pp<${(minEdge * 100).toFixed(0)}pp`,
      twapEdge,
    };
  }
  return { cancel: false, reason: null, twapEdge };
}

/**
 * Maker adverse-selection guard (Cancel-on-Toxicity): pull a resting bid before
 * informed flow or a sudden BTC impulse dumps into it.
 * Strict no-op when inputs are null/unavailable.
 */
export function shouldCancelToxicFlow({
  side,
  leadLagDirection = null,
  kalmanVelocityUsdPerSec = null,
  vpin = null,
  kylesLambda = null,
  kylesLambdaR2 = null,
  tradeImbalance = null,
  minKalmanVelUsdPerSec = 5.0,
  minVpin = 0.78,
  minKylesLambda = 1.5,
  minKylesLambdaR2 = 0.15,
  minOpposingImbalance = 0.35,
}: {
  side: 'UP' | 'DOWN' | string | null | undefined;
  leadLagDirection?: 'UP' | 'DOWN' | string | null;
  kalmanVelocityUsdPerSec?: number | null;
  vpin?: number | null;
  kylesLambda?: number | null;
  kylesLambdaR2?: number | null;
  tradeImbalance?: number | null;
  minKalmanVelUsdPerSec?: number;
  minVpin?: number;
  minKylesLambda?: number;
  minKylesLambdaR2?: number;
  minOpposingImbalance?: number;
}): { cancel: boolean; reason: string | null } {
  if (side !== 'UP' && side !== 'DOWN') return { cancel: false, reason: null };

  // 1. Active 3s Binance lead-lag impulse opposing our resting bid
  if ((leadLagDirection === 'UP' || leadLagDirection === 'DOWN') && leadLagDirection !== side) {
    return { cancel: true, reason: `toxic_lead_lag_${leadLagDirection}` };
  }

  // 2. Kinematic Kalman velocity sharply opposing our resting bid ($/sec)
  if (kalmanVelocityUsdPerSec != null && Number.isFinite(kalmanVelocityUsdPerSec)) {
    const opposingVel = side === 'UP' ? -kalmanVelocityUsdPerSec : kalmanVelocityUsdPerSec;
    if (opposingVel >= minKalmanVelUsdPerSec) {
      return {
        cancel: true,
        reason: `toxic_kalman_vel_${kalmanVelocityUsdPerSec >= 0 ? '+' : ''}${kalmanVelocityUsdPerSec.toFixed(1)}usd/s`,
      };
    }
  }

  // 3. Elevated VPIN or Kyle's lambda while signed CLOB trade flow opposes our bid
  if (tradeImbalance != null && Number.isFinite(tradeImbalance)) {
    const opposingImb = side === 'UP' ? -tradeImbalance : tradeImbalance;
    if (opposingImb >= minOpposingImbalance) {
      if (vpin != null && Number.isFinite(vpin) && vpin >= minVpin) {
        return {
          cancel: true,
          reason: `toxic_vpin_${vpin.toFixed(2)}_imb_${(opposingImb * 100).toFixed(0)}%`,
        };
      }
      if (
        kylesLambda != null && Number.isFinite(kylesLambda) && kylesLambda >= minKylesLambda &&
        kylesLambdaR2 != null && Number.isFinite(kylesLambdaR2) && kylesLambdaR2 >= minKylesLambdaR2
      ) {
        return {
          cancel: true,
          reason: `toxic_lambda_${kylesLambda.toFixed(2)}c_imb_${(opposingImb * 100).toFixed(0)}%`,
        };
      }
    }
  }

  return { cancel: false, reason: null };
}

/**
 * After a limit cancel, may the directional FOK path take over?
 * Signal flips / toxic flow / market switches / partial rejects → no.
 * Time cutoff / unfilled timeout → only if fee-adjusted edge clears the floor.
 */
export function shouldAllowFokFallback({
  cancelReason,
  sideProb,
  ask,
  minEdge,
  mlConfidence,
  minMlConfidence,
}: {
  cancelReason: MakerCancelReason | string;
  sideProb: number | null | undefined;
  ask: number | null | undefined;
  minEdge: number;
  mlConfidence?: number | null;
  minMlConfidence?: number;
}): { allow: boolean; reason: string } {
  const reason = String(cancelReason || 'other');
  if (
    reason === 'signal_flip' ||
    reason.startsWith('ml_flip') ||
    reason === 'toxic_flow' ||
    reason.startsWith('toxic_') ||
    reason === 'clob_down' ||
    reason === 'clob_feed_down' ||
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

  if (
    typeof minMlConfidence === 'number' &&
    Number.isFinite(minMlConfidence) &&
    minMlConfidence > 0 &&
    typeof mlConfidence === 'number' &&
    Number.isFinite(mlConfidence) &&
    mlConfidence < minMlConfidence
  ) {
    return {
      allow: false,
      reason: `no_fok_ml_${(mlConfidence * 100).toFixed(0)}%<${(minMlConfidence * 100).toFixed(0)}%`,
    };
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
  if (s.includes('CLOB_DOWN') || s.includes('clob_feed_down')) return 'clob_down';
  if (s.includes('TOXIC_FLOW') || s.includes('toxic_')) return 'toxic_flow';
  if (s.includes('EDGE_EROSION') || s.includes('edge_erosion')) return 'edge_erosion';
  if (s.includes('SIGNAL_FLIP') || s.includes('ml_flip')) return 'signal_flip';
  if (s.includes('TIME_CUTOFF') || s.startsWith('elapsed_')) return 'time_cutoff';
  if (s.includes('MARKET_SWITCH') || s.includes('market_switched')) return 'market_switch';
  if (s.includes('PARTIAL_REJECT') || s.includes('partial_reject')) return 'partial_reject';
  return 'other';
}
