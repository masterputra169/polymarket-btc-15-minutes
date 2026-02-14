/**
 * Cut-loss (stop-loss) evaluator — v2 Smart Cut-Loss.
 *
 * v2 replaces the simple "token dropped X%" trigger with a multi-gate chain
 * that considers BTC position relative to PTB, momentum, expected value,
 * and ML confidence before cutting. This prevents premature exits where the
 * underlying (BTC vs PTB) is still favorable despite volatile token prices.
 *
 * Gate chain (all must pass for shouldCut = true):
 *   1. Feature enabled
 *   2. Has open, fill-confirmed position
 *   3. Max attempts not exceeded
 *   4. Cooldown elapsed since last failed sell
 *   5. Min hold time met (60s)
 *   6. Not too close to settlement (< 30s)
 *   7. BTC position check — if BTC is on our side of PTB, never cut
 *   8. BTC-to-PTB distance — time-scaled minimum distance before cutting
 *   9. BTC momentum — if BTC is recovering toward PTB, skip cut
 *  10. EV comparison — only cut if EV(hold) < EV(cut) × 0.9
 *  11. ML veto — if ML confidence >= 55% and agrees with position, block cut
 *  12. Token drop minimum — token must have dropped at least 15%
 *  13. Consecutive poll confirmation — 3 consecutive polls where all gates pass
 */

import { BOT_CONFIG } from '../config.js';

// ── Module state (reset on settlement / market switch) ──
let sellAttempts = 0;
let lastSellAttemptMs = 0;
let consecutiveCutPolls = 0;

/**
 * Time-scaled BTC-to-PTB distance thresholds.
 * More time left = higher threshold (position still recoverable).
 * Less time left = lower threshold (urgency to cut).
 */
function getBtcDistThreshold(timeLeftMin) {
  if (timeLeftMin == null) return 0.05; // default: mid-range
  if (timeLeftMin > 10) return 0.10;    // > 10 min: 0.10%
  if (timeLeftMin > 5)  return 0.07;    // 5-10 min: 0.07%
  if (timeLeftMin > 2)  return 0.05;    // 2-5 min:  0.05%
  return 0.03;                          // < 2 min:  0.03%
}

/**
 * Evaluate whether the current position should be cut.
 * @param {Object} params
 * @param {Object} params.position - Current position from positionTracker
 * @param {number} params.currentTokenPrice - Live token price (market mid or best bid)
 * @param {Object|null} params.orderbook - Orderbook for this token side ({ bestBid, bestAsk, ... })
 * @param {number|null} params.timeLeftMin - Minutes until market settlement
 * @param {number|null} params.btcPrice - Current BTC price
 * @param {number|null} params.priceToBeat - Price-to-beat (PTB) for this market
 * @param {number|null} params.modelProbability - Ensemble probability for position side (0-1)
 * @param {number|null} params.mlConfidence - ML model confidence (0-1)
 * @param {string|null} params.mlSide - ML predicted side ('UP'|'DOWN')
 * @param {string} params.regime - Market regime
 * @param {number|null} params.btcDelta1m - BTC price change per minute ($/min)
 * @returns {{ shouldCut: boolean, reason: string, sellPrice?: number, dropPct?: number, recoveryAmount?: number, savings?: number, diagnostics?: Object }}
 */
export function evaluateCutLoss({
  position, currentTokenPrice, orderbook, timeLeftMin,
  btcPrice, priceToBeat, modelProbability,
  mlConfidence, mlSide, regime, btcDelta1m,
}) {
  const cfg = BOT_CONFIG.cutLoss;
  const no = (reason) => {
    // Any gate failure resets consecutive confirmation
    consecutiveCutPolls = 0;
    return { shouldCut: false, reason };
  };

  // ── Gate 1: Feature enabled? ──
  if (!cfg || !cfg.enabled) return no('disabled');

  // ── Gate 2: Has open, fill-confirmed position? ──
  if (!position || position.settled) return no('no_position');
  if (!position.fillConfirmed) return no('fill_unconfirmed');

  // ── Gate 3: Max attempts not exceeded? ──
  if (sellAttempts >= cfg.maxAttempts) return no(`max_attempts_${sellAttempts}/${cfg.maxAttempts}`);

  // ── Gate 4: Cooldown elapsed since last failed sell? ──
  const now = Date.now();
  if (lastSellAttemptMs > 0 && (now - lastSellAttemptMs) < cfg.cooldownMs) {
    return no('cooldown');
  }

  // ── Gate 5: Min hold time met? ──
  const holdSec = (now - position.enteredAt) / 1000;
  if (holdSec < cfg.minHoldSec) return no(`hold_${Math.round(holdSec)}s/${cfg.minHoldSec}s`);

  // ── Gate 6: Not too close to settlement? ──
  if (timeLeftMin != null && timeLeftMin < 0.5) return no('near_settlement');

  // ── Shared computations for smart gates ──
  if (currentTokenPrice == null || !Number.isFinite(currentTokenPrice)) return no('no_price');
  const entryPrice = position.price;
  if (entryPrice <= 0) return no('bad_entry_price');

  const dropPct = ((entryPrice - currentTokenPrice) / entryPrice) * 100;
  const hasPtb = btcPrice != null && priceToBeat != null && Number.isFinite(btcPrice) && Number.isFinite(priceToBeat);

  // BTC distance from PTB (signed: positive = on position's winning side)
  let btcDistPct = null;
  let btcFavorable = null;
  if (hasPtb) {
    const rawDistPct = ((btcPrice - priceToBeat) / priceToBeat) * 100;
    // Positive distance = BTC above PTB
    // For UP position: above PTB = favorable. For DOWN: below PTB = favorable.
    btcFavorable = position.side === 'UP' ? btcPrice >= priceToBeat : btcPrice < priceToBeat;
    btcDistPct = Math.abs(rawDistPct);
  }

  // ── Gate 7: BTC position check ──
  // If BTC is on our side of PTB (winning), never cut
  if (hasPtb && btcFavorable) {
    return no(`btc_favorable_${btcDistPct.toFixed(3)}%`);
  }

  // ── Gate 8: BTC-to-PTB distance (primary trigger) ──
  // If BTC is closer than time-scaled threshold → don't cut (still recoverable)
  if (hasPtb) {
    const threshold = getBtcDistThreshold(timeLeftMin);
    if (btcDistPct < threshold) {
      return no(`btc_close_${btcDistPct.toFixed(3)}%<${threshold}%`);
    }
  }

  // ── Gate 9: BTC momentum ──
  // If BTC is moving TOWARD PTB (recovering), skip cut.
  // Only vetoes if momentum magnitude > $5/min.
  if (hasPtb && btcDelta1m != null && Number.isFinite(btcDelta1m)) {
    const movingTowardPtb = position.side === 'UP'
      ? btcDelta1m > 0   // UP position losing = BTC below PTB; positive delta = recovering
      : btcDelta1m < 0;  // DOWN position losing = BTC above PTB; negative delta = recovering
    if (movingTowardPtb && Math.abs(btcDelta1m) > 5) {
      return no(`btc_recovering_$${btcDelta1m.toFixed(1)}/min`);
    }
  }

  // ── Gate 10: EV comparison ──
  // EV(hold) = modelProb × $1/share vs EV(cut) = tokenPrice
  // Only cut if EV(hold) < EV(cut) × 0.9 (10% margin)
  if (modelProbability != null && Number.isFinite(modelProbability)) {
    const evHold = modelProbability; // × $1 per share (payout if correct)
    const evCut = currentTokenPrice; // recovery per share if sold now
    if (evHold >= evCut * 0.9) {
      return no(`ev_hold_${(evHold * 100).toFixed(1)}%>=cut_${(evCut * 100).toFixed(1)}%×0.9`);
    }
  }

  // ── Gate 11: ML veto ──
  // If ML confidence >= 55% AND agrees with position side → block cut
  if (mlConfidence != null && mlConfidence >= 0.55 && mlSide === position.side) {
    return no(`ml_veto_${(mlConfidence * 100).toFixed(0)}%_${mlSide}`);
  }

  // ── Gate 12: Token drop minimum (secondary safety net) ──
  // Token must have dropped at least minTokenDropPct (15%)
  if (dropPct < cfg.minTokenDropPct) {
    return no(`drop_${dropPct.toFixed(1)}%<${cfg.minTokenDropPct}%`);
  }

  // ── Gate 12b: Token price above minimum? ──
  if (currentTokenPrice < cfg.minTokenPrice) {
    return no(`price_${currentTokenPrice.toFixed(3)}<min_${cfg.minTokenPrice}`);
  }

  // ── Gate 13: Consecutive poll confirmation ──
  // Require N consecutive polls where ALL smart gates pass before actually cutting.
  // Prevents flash-crash triggers. Counter resets (in `no()`) when any gate fails.
  consecutiveCutPolls++;
  if (consecutiveCutPolls < cfg.consecutivePolls) {
    // Don't reset — we passed all gates, just need more confirmations
    return {
      shouldCut: false,
      reason: `confirming_${consecutiveCutPolls}/${cfg.consecutivePolls}`,
    };
  }

  // ═══ All 13 gates passed — compute sell details ═══
  const sellPrice = (orderbook?.bestBid != null && orderbook.bestBid > 0)
    ? orderbook.bestBid
    : currentTokenPrice;
  const recoveryAmount = sellPrice * position.size;
  const savings = recoveryAmount;

  // Compute EV values for logging
  const evHold = modelProbability != null ? modelProbability : null;
  const evCut = currentTokenPrice;

  return {
    shouldCut: true,
    reason: 'triggered',
    sellPrice,
    dropPct,
    recoveryAmount,
    savings,
    diagnostics: {
      btcDistPct,
      btcFavorable,
      evHold,
      evCut,
      confirmCount: consecutiveCutPolls,
      regime,
    },
  };
}

/**
 * Reset cut-loss state. Call on settlement, market switch, or successful cut.
 */
export function resetCutLossState() {
  sellAttempts = 0;
  lastSellAttemptMs = 0;
  consecutiveCutPolls = 0;
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
 * @param {Object} [v2Context] - Additional v2 context (btcPrice, priceToBeat, etc.)
 * @returns {Object} Status object for dashboard
 */
export function getCutLossStatus(position, currentTokenPrice, v2Context = {}) {
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

  // v2 diagnostics
  const { btcPrice, priceToBeat, modelProbability, mlConfidence, mlSide } = v2Context;
  let btcDistPct = null;
  let btcFavorable = null;
  let evHold = null;
  let evCut = currentTokenPrice;

  if (btcPrice != null && priceToBeat != null) {
    btcDistPct = Math.abs(((btcPrice - priceToBeat) / priceToBeat) * 100);
    btcFavorable = position.side === 'UP' ? btcPrice >= priceToBeat : btcPrice < priceToBeat;
  }
  if (modelProbability != null) {
    evHold = modelProbability;
  }

  return {
    enabled: true,
    active: true,
    dropPct: Math.max(0, dropPct),
    threshold: cfg.minTokenDropPct,
    ratio: Math.min(1, Math.max(0, dropPct) / cfg.minTokenDropPct),
    holdSec: Math.round(holdSec),
    holdNeeded: cfg.minHoldSec,
    holdMet,
    attempts: sellAttempts,
    maxAttempts: cfg.maxAttempts,
    fillConfirmed: position.fillConfirmed ?? false,
    // v2 fields
    btcDistPct,
    btcFavorable,
    evHold,
    evCut,
    confirmCount: consecutiveCutPolls,
    confirmNeeded: cfg.consecutivePolls,
    mlVeto: mlConfidence != null && mlConfidence >= 0.55 && mlSide === position.side,
  };
}
