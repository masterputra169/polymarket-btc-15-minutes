/**
 * Take-profit evaluator v2 — sell when up but signal genuinely weakening.
 *
 * Pro advice: "Don't hold to resolution when you're up +25% and signal weakens."
 * Runs every poll alongside cut-loss. When conditions met, sells via closePosition().
 *
 * v2 changes (2026-02-24, reduce false positives):
 * - Gate 5a: Entry-relative prob drop (15%+ from entry prob, not absolute 55%)
 * - Gate 5c: Regime change REMOVED as standalone weakener (too noisy — triggered at 90c ITM)
 * - Gate 5d: BTC momentum threshold $10→$50 (BTC noise is ±$30/min normally)
 * - Gate 5e: NEW — edge reversal (model now favors opposite side = strong sell signal)
 * - Gate 5 now requires 2+ weakeners (was 1) — reduces false positives dramatically
 * - Gate 4b: Deep ITM lowered 85c→80c (hold closer to settlement payout)
 *
 * Gate chain (all must pass for shouldTakeProfit = true):
 *   1. Feature enabled
 *   2. Has open position (not settled, not ARB)
 *   3. Min hold time (60s — give position time to stabilize)
 *   4. Token gain >= 18-22% from entry price (time-adjusted)
 *   4b. NOT deep ITM (>=80c — hold to settlement)
 *   5. Signal weakening (at least TWO of):
 *      a. Model prob dropped 15%+ from entry (entry-relative, not absolute)
 *      b. ML disagrees with our side AND ML confidence >= 60%
 *      c. (REMOVED: regime change — too noisy)
 *      d. BTC momentum strongly reversed (>$50/min against us)
 *      e. Edge flipped negative for our side (model now favors opposite)
 *   6. Not too close to settlement (>1 min left — let settlement handle)
 *   7. Orderbook liquidity — bestBid exists and spread not too wide
 */

import { BOT_CONFIG } from '../config.js';

// H4: 3-poll confirmation to prevent short-lived false triggers (tighter than cutLoss 2-poll)
let consecutiveTpPolls = 0;

/**
 * Evaluate whether the current position should take profit.
 * @param {Object} params
 * @param {Object} params.position - Current position from positionTracker
 * @param {number} params.currentTokenPrice - Live token price (market mid or best bid)
 * @param {Object|null} params.orderbook - Orderbook for this token side
 * @param {number|null} params.timeLeftMin - Minutes until market settlement
 * @param {number|null} params.modelProbability - Ensemble probability for position side (0-1)
 * @param {number|null} params.mlConfidence - ML model confidence (0-1)
 * @param {string|null} params.mlSide - ML predicted side ('UP'|'DOWN')
 * @param {string} params.regime - Current market regime
 * @param {string|null} params.entryRegime - Market regime at time of entry
 * @param {number|null} params.btcDelta1m - BTC price change per minute ($/min)
 * @param {number|null} params.entryEnsembleProb - Ensemble prob for our side AT ENTRY time (0-1)
 * @param {number|null} params.bestEdge - Current best edge for our side (can be negative)
 * @returns {{ shouldTakeProfit: boolean, reason: string, sellPrice?: number, gainPct?: number, recoveryAmount?: number }}
 */
export function evaluateTakeProfit({
  position, currentTokenPrice, orderbook, timeLeftMin,
  modelProbability, mlConfidence, mlSide, regime, entryRegime, btcDelta1m,
  entryEnsembleProb, bestEdge,
}) {
  const cfg = BOT_CONFIG.takeProfit;
  const no = (reason) => { consecutiveTpPolls = 0; return { shouldTakeProfit: false, reason }; };

  // ── Gate 1: Feature enabled? ──
  if (!cfg || !cfg.enabled) return no('disabled');

  // ── Gate 2: Has open, fill-confirmed position (not settled, not ARB)? ──
  if (!position || position.settled) return no('no_position');
  if (!position.fillConfirmed) return no('fill_unconfirmed');
  if (position.side === 'ARB') return no('arb_position');

  // ── Gate 3: Min hold time met? ──
  const now = Date.now();
  const holdSec = (now - position.enteredAt) / 1000;
  if (holdSec < cfg.minHoldSec) return no(`hold_${Math.round(holdSec)}s/${cfg.minHoldSec}s`);

  // ── Gate 4: Token gain >= threshold? ──
  if (currentTokenPrice == null || !Number.isFinite(currentTokenPrice)) return no('no_price');
  const entryPrice = position.price;
  if (entryPrice < 0.01) return no('bad_entry_price');

  // ── Gate 4b: Deep in-the-money — hold to settlement ──
  // v2: 85c→80c — at 80c+, settlement pays $1.00 (minus 2% fee = $0.98).
  // Selling at 80c loses ~18c/token. Even with signal weakening, hold.
  if (currentTokenPrice >= 0.80) return no(`deep_itm_${(currentTokenPrice * 100).toFixed(0)}c`);

  const gainPct = ((currentTokenPrice - entryPrice) / entryPrice) * 100;
  // Time-aware gain threshold: tighter late (lock gains), looser early (let it run)
  const timeAdjustedMinGain = cfg.minGainPct + 4 * ((timeLeftMin ?? 7.5) / 15);
  if (gainPct < timeAdjustedMinGain) return no(`gain_${gainPct.toFixed(1)}%<${timeAdjustedMinGain.toFixed(1)}%`);

  // ── Gate 5: Signal weakening (at least TWO must be true) ──
  // v2: Raised from 1→2 weakeners to reduce false positives.
  // Each weakener represents an independent signal that the trade thesis is breaking down.
  const weakeners = [];

  // 5a. Model probability dropped significantly from ENTRY prob (entry-relative)
  // v2: Changed from absolute 55% to relative 15% drop — entry at 80% dropping to 65% is meaningful,
  // but entry at 58% dropping to 54% is just noise.
  const PROB_DROP_THRESHOLD = 0.15; // 15 percentage points below entry
  if (modelProbability != null && entryEnsembleProb != null) {
    const probDrop = entryEnsembleProb - modelProbability;
    if (probDrop >= PROB_DROP_THRESHOLD) {
      weakeners.push(`prob_drop_${(probDrop * 100).toFixed(0)}%_(${(entryEnsembleProb * 100).toFixed(0)}->${(modelProbability * 100).toFixed(0)}%)`);
    }
  } else if (modelProbability != null && modelProbability < (cfg.minProbDrop ?? 0.45)) {
    // Fallback: absolute threshold if no entry data (shouldn't happen normally)
    weakeners.push(`prob_low_${(modelProbability * 100).toFixed(0)}%`);
  }

  // 5b. ML disagrees with our position AND is confident about it
  // v2: Added confidence gate — ML flipping at 52% confidence is noise, at 70% is meaningful
  const ML_DISAGREE_MIN_CONF = 0.60;
  if (mlConfidence != null && mlSide != null && mlSide !== position.side && mlConfidence >= ML_DISAGREE_MIN_CONF) {
    weakeners.push(`ml_disagrees_${mlSide}_${(mlConfidence * 100).toFixed(0)}%`);
  }

  // 5c. (REMOVED: Regime change — too noisy, triggered at 90c ITM on moderate→mean_reverting)
  // Regime changes happen naturally without implying the trade is wrong.

  // 5d. BTC momentum strongly reversed against position
  // v2: $10→$50 — BTC moves ±$30/min normally. $50 is a genuine 1-minute reversal.
  const BTC_REVERSAL_THRESHOLD = 50;
  if (btcDelta1m != null && Number.isFinite(btcDelta1m)) {
    const btcAgainst = position.side === 'UP' ? btcDelta1m < -BTC_REVERSAL_THRESHOLD : btcDelta1m > BTC_REVERSAL_THRESHOLD;
    if (btcAgainst) {
      weakeners.push(`btc_reversal_$${btcDelta1m.toFixed(0)}/min`);
    }
  }

  // 5e. Edge flipped negative (model now favors the opposite side)
  // This is the strongest signal: the model that entered the trade now disagrees with it.
  if (bestEdge != null && bestEdge < -0.02) {
    weakeners.push(`edge_negative_${(bestEdge * 100).toFixed(1)}%`);
  }

  // v2: Require 2+ weakeners (was 1). Reduces false positives while catching genuine reversals.
  // With 5 possible weakeners, requiring 2 means at least two independent signals confirm weakening.
  const MIN_WEAKENERS = 2;
  if (weakeners.length < MIN_WEAKENERS) return no(`weak_${weakeners.length}/${MIN_WEAKENERS}${weakeners.length > 0 ? ':' + weakeners[0] : ''}`);

  // ── Gate 6: Not too close to settlement? ──
  if (timeLeftMin != null && timeLeftMin < cfg.minTimeLeftMin) return no('near_settlement');

  // ── Gate 7: Orderbook liquidity? ──
  const bestBid = orderbook?.bestBid;
  if (bestBid == null || bestBid <= 0) return no('no_bid');
  const spread = orderbook?.spread ?? 0;
  if (spread > 0.10) return no(`wide_spread_${(spread * 100).toFixed(1)}%`);

  // ── 3-poll confirmation (v2: raised from 2 to reduce flicker triggers) ──
  consecutiveTpPolls++;
  if (consecutiveTpPolls < 3) {
    return { shouldTakeProfit: false, reason: `tp_confirming_${consecutiveTpPolls}/3` };
  }

  // ═══ All gates passed — compute sell details ═══
  const sellPrice = Math.max(0.01, bestBid * 0.99);
  const recoveryAmount = sellPrice * position.size;

  return {
    shouldTakeProfit: true,
    reason: `TAKE_PROFIT: ${weakeners.join(', ')}`,
    sellPrice,
    gainPct,
    recoveryAmount,
    weakeners,
  };
}

/**
 * Reset take-profit confirmation counter. Call on settlement / market switch.
 */
export function resetTakeProfitState() {
  consecutiveTpPolls = 0;
}
