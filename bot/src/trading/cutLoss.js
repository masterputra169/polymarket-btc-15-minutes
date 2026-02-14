/**
 * Cut-loss (stop-loss) evaluator.
 *
 * Pure-logic module that evaluates whether an open position should be
 * sold early to recover partial capital, rather than riding to full loss.
 *
 * Gate chain (all must pass for shouldCut = true):
 *   1. Feature enabled
 *   2. Has open, fill-confirmed position
 *   3. Max attempts not exceeded
 *   4. Cooldown elapsed since last failed sell
 *   5. Min hold time met (avoid cutting during volatile opens)
 *   6. Not too close to settlement (< 30s → let it settle)
 *   7. Drop % exceeds threshold
 *   8. Token price above minimum (don't sell near-zero tokens)
 */

import { BOT_CONFIG } from '../config.js';

// ── Module state (reset on settlement / market switch) ──
let sellAttempts = 0;
let lastSellAttemptMs = 0;

/**
 * Evaluate whether the current position should be cut.
 * @param {Object} params
 * @param {Object} params.position - Current position from positionTracker
 * @param {number} params.currentTokenPrice - Live token price (market mid or best bid)
 * @param {Object|null} params.orderbook - Orderbook for this token side ({ bestBid, bestAsk, ... })
 * @param {number|null} params.timeLeftMin - Minutes until market settlement
 * @returns {{ shouldCut: boolean, reason: string, sellPrice?: number, dropPct?: number, recoveryAmount?: number, savings?: number }}
 */
export function evaluateCutLoss({ position, currentTokenPrice, orderbook, timeLeftMin }) {
  const cfg = BOT_CONFIG.cutLoss;
  const no = (reason) => ({ shouldCut: false, reason });

  // 1. Feature enabled?
  if (!cfg || !cfg.enabled) return no('disabled');

  // 2. Has open, fill-confirmed position?
  if (!position || position.settled) return no('no_position');
  if (!position.fillConfirmed) return no('fill_unconfirmed');

  // 3. Max attempts not exceeded?
  if (sellAttempts >= cfg.maxAttempts) return no(`max_attempts_${sellAttempts}/${cfg.maxAttempts}`);

  // 4. Cooldown elapsed since last failed sell?
  const now = Date.now();
  if (lastSellAttemptMs > 0 && (now - lastSellAttemptMs) < cfg.cooldownMs) {
    return no('cooldown');
  }

  // 5. Min hold time met?
  const holdSec = (now - position.enteredAt) / 1000;
  if (holdSec < cfg.minHoldSec) return no(`hold_${Math.round(holdSec)}s/${cfg.minHoldSec}s`);

  // 6. Not too close to settlement?
  if (timeLeftMin != null && timeLeftMin < 0.5) return no('near_settlement');

  // 7. Drop % exceeds threshold?
  if (currentTokenPrice == null || !Number.isFinite(currentTokenPrice)) return no('no_price');
  const entryPrice = position.price;
  if (entryPrice <= 0) return no('bad_entry_price');

  const dropPct = ((entryPrice - currentTokenPrice) / entryPrice) * 100;
  if (dropPct < cfg.dropPct) return no(`drop_${dropPct.toFixed(1)}%<${cfg.dropPct}%`);

  // 8. Token price above minimum?
  if (currentTokenPrice < cfg.minTokenPrice) return no(`price_${currentTokenPrice.toFixed(3)}<min_${cfg.minTokenPrice}`);

  // All gates passed — compute sell details
  const sellPrice = (orderbook?.bestBid != null && orderbook.bestBid > 0)
    ? orderbook.bestBid
    : currentTokenPrice;
  const recoveryAmount = sellPrice * position.size;
  const savings = recoveryAmount; // amount recovered (saved vs full loss of $0 payout)

  return {
    shouldCut: true,
    reason: 'triggered',
    sellPrice,
    dropPct,
    recoveryAmount,
    savings,
  };
}

/**
 * Reset cut-loss state. Call on settlement, market switch, or successful cut.
 */
export function resetCutLossState() {
  sellAttempts = 0;
  lastSellAttemptMs = 0;
}

/**
 * Record a sell attempt (increment counter + set timestamp).
 */
export function recordSellAttempt() {
  sellAttempts++;
  lastSellAttemptMs = Date.now();
}

/**
 * Get cut-loss status for dashboard broadcast.
 * @param {Object|null} position - Current position
 * @param {number|null} currentTokenPrice - Live token price
 * @returns {Object} Status object for dashboard
 */
export function getCutLossStatus(position, currentTokenPrice) {
  const cfg = BOT_CONFIG.cutLoss;
  if (!cfg?.enabled || !position || position.settled) {
    return { enabled: cfg?.enabled ?? false, active: false };
  }

  const entryPrice = position.price;
  const dropPct = (entryPrice > 0 && currentTokenPrice != null)
    ? ((entryPrice - currentTokenPrice) / entryPrice) * 100
    : 0;

  const holdSec = (Date.now() - position.enteredAt) / 1000;
  const holdMet = holdSec >= cfg.minHoldSec;

  return {
    enabled: true,
    active: true,
    dropPct: Math.max(0, dropPct),
    threshold: cfg.dropPct,
    ratio: Math.min(1, Math.max(0, dropPct) / cfg.dropPct),
    holdSec: Math.round(holdSec),
    holdNeeded: cfg.minHoldSec,
    holdMet,
    attempts: sellAttempts,
    maxAttempts: cfg.maxAttempts,
    fillConfirmed: position.fillConfirmed ?? false,
  };
}
