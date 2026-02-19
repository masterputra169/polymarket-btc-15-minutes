/**
 * Take-profit evaluator — sell when up but signal weakening.
 *
 * Pro advice: "Don't hold to resolution when you're up +25% and signal weakens."
 * Runs every poll alongside cut-loss. When conditions met, sells via closePosition().
 *
 * Gate chain (all must pass for shouldTakeProfit = true):
 *   1. Feature enabled
 *   2. Has open position (not settled, not ARB)
 *   3. Min hold time (60s — give position time to stabilize)
 *   4. Token gain >= 20% from entry price
 *   5. Signal weakening (at least ONE of):
 *      a. Model probability for our side dropped below 55%
 *      b. ML now disagrees with our position side
 *      c. Regime changed since entry
 *      d. BTC momentum reversed against our position
 *   6. Not too close to settlement (>1 min left — let settlement handle)
 *   7. Orderbook liquidity — bestBid exists and spread not too wide
 */

import { BOT_CONFIG } from '../config.js';

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
 * @returns {{ shouldTakeProfit: boolean, reason: string, sellPrice?: number, gainPct?: number, recoveryAmount?: number }}
 */
export function evaluateTakeProfit({
  position, currentTokenPrice, orderbook, timeLeftMin,
  modelProbability, mlConfidence, mlSide, regime, entryRegime, btcDelta1m,
}) {
  const cfg = BOT_CONFIG.takeProfit;
  const no = (reason) => ({ shouldTakeProfit: false, reason });

  // ── Gate 1: Feature enabled? ──
  if (!cfg || !cfg.enabled) return no('disabled');

  // ── Gate 2: Has open, fill-confirmed position (not settled, not ARB)? ──
  if (!position || position.settled) return no('no_position');
  if (!position.fillConfirmed) return no('fill_unconfirmed'); // H1: match cutLoss.js — don't sell unconfirmed tokens
  if (position.side === 'ARB') return no('arb_position');

  // ── Gate 3: Min hold time met? ──
  const now = Date.now();
  const holdSec = (now - position.enteredAt) / 1000;
  if (holdSec < cfg.minHoldSec) return no(`hold_${Math.round(holdSec)}s/${cfg.minHoldSec}s`);

  // ── Gate 4: Token gain >= threshold? ──
  if (currentTokenPrice == null || !Number.isFinite(currentTokenPrice)) return no('no_price');
  const entryPrice = position.price;
  if (entryPrice < 1e-8) return no('bad_entry_price');

  const gainPct = ((currentTokenPrice - entryPrice) / entryPrice) * 100;
  if (gainPct < cfg.minGainPct) return no(`gain_${gainPct.toFixed(1)}%<${cfg.minGainPct}%`);

  // ── Gate 5: Signal weakening (at least ONE must be true)? ──
  const weakeners = [];

  // 5a. Model probability dropped below threshold
  if (modelProbability != null && modelProbability < cfg.minProbDrop) {
    weakeners.push(`prob_low_${(modelProbability * 100).toFixed(0)}%`);
  }

  // 5b. ML disagrees with our position
  if (mlConfidence != null && mlSide != null && mlSide !== position.side) {
    weakeners.push(`ml_disagrees_${mlSide}`);
  }

  // 5c. Regime changed since entry
  if (entryRegime && regime && entryRegime !== regime) {
    weakeners.push(`regime_${entryRegime}->${regime}`);
  }

  // 5d. BTC momentum reversed against position
  if (btcDelta1m != null && Number.isFinite(btcDelta1m)) {
    const btcAgainst = position.side === 'UP' ? btcDelta1m < -10 : btcDelta1m > 10;
    if (btcAgainst) {
      weakeners.push(`btc_against_$${btcDelta1m.toFixed(1)}/min`);
    }
  }

  if (weakeners.length === 0) return no('signal_strong');

  // ── Gate 6: Not too close to settlement? ──
  if (timeLeftMin != null && timeLeftMin < cfg.minTimeLeftMin) return no('near_settlement');

  // ── Gate 7: Orderbook liquidity? ──
  const bestBid = orderbook?.bestBid;
  if (bestBid == null || bestBid <= 0) return no('no_bid');
  const spread = orderbook?.spread ?? 0;
  if (spread > 0.15) return no(`wide_spread_${(spread * 100).toFixed(1)}%`);

  // ═══ All gates passed — compute sell details ═══
  // Sell at bestBid with 1% slippage (tighter than cut-loss 2% because we're in profit)
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
