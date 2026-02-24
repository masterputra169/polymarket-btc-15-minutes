/**
 * Recovery buy — re-enter same side after cut-loss if signal stabilizes.
 *
 * State machine:
 *   IDLE → SAMPLING (10s, capture baseline price) → MONITORING (30s, wait for stable/rising) → BUY or → IDLE
 *
 * Triggered ONLY after a cut-loss exit (not settlement, not take-profit).
 * The idea: cut-loss fires on a temporary dip, but our original thesis (side)
 * is still valid. If price stabilizes or rises within 30s, re-enter at a
 * potentially better price with a smaller position (maxRecoveryPct of normal).
 *
 * Safety gates (all must pass to trigger buy):
 *   1. Feature enabled
 *   2. Bot not halted (circuit breaker)
 *   3. Bankroll >= minBankroll
 *   4. Time left >= minTimeLeftMin
 *   5. Token price >= minTokenPrice (only high-probability tokens)
 *   6. Token price stable or rising vs sampling baseline
 *   7. ML still agrees with our side at minMlConfidence
 *   8. Ensemble probability >= minEnsembleProb
 *   9. No open position (don't double up)
 */

import { BOT_CONFIG } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('Recovery');

// ── State machine ──
const STATE = { IDLE: 'IDLE', SAMPLING: 'SAMPLING', MONITORING: 'MONITORING' };

let state = STATE.IDLE;
let cutLossSide = null;        // Side we cut: 'UP' or 'DOWN'
let cutLossTokenId = null;     // Token ID we sold
let cutLossConditionId = null; // Condition ID for market
let cutLossMarketSlug = null;  // Market slug
let stateEnteredAt = 0;        // When current state started
let baselinePrice = null;      // Token price captured during SAMPLING
let baselinePrices = [];       // Prices collected during sampling window

/**
 * Called immediately after a successful cut-loss.
 * Transitions from IDLE → SAMPLING.
 *
 * @param {Object} params
 * @param {string} params.side - Side we cut ('UP' or 'DOWN')
 * @param {string} params.tokenId - Token ID of the cut position
 * @param {string|null} params.conditionId - Market condition ID
 * @param {string} params.marketSlug - Market slug
 */
export function onCutLoss({ side, tokenId, conditionId, marketSlug }) {
  const cfg = BOT_CONFIG.recoveryBuy;
  if (!cfg?.enabled) {
    log.debug('Recovery buy disabled — skipping');
    return;
  }

  state = STATE.SAMPLING;
  cutLossSide = side;
  cutLossTokenId = tokenId;
  cutLossConditionId = conditionId ?? null;
  cutLossMarketSlug = marketSlug;
  stateEnteredAt = Date.now();
  baselinePrice = null;
  baselinePrices = [];

  log.info(`Recovery SAMPLING started: ${side} on ${marketSlug} — watching for ${cfg.samplingMs / 1000}s`);
}

/**
 * Called every poll while recovery is active.
 * Drives the state machine and returns a buy signal when conditions are met.
 *
 * @param {Object} params
 * @param {number|null} params.tokenPrice - Current token price for our side
 * @param {number|null} params.timeLeftMin - Minutes until settlement
 * @param {number|null} params.mlConfidence - ML confidence (0-1)
 * @param {string|null} params.mlSide - ML predicted side
 * @param {number|null} params.ensembleProb - Ensemble prob for our side (0-1)
 * @param {boolean} params.hasPosition - Whether we already have a position
 * @param {boolean} params.isHalted - Whether circuit breaker is active
 * @param {number} params.bankroll - Available bankroll
 * @param {string} params.marketSlug - Current market slug
 * @returns {{ shouldBuy: boolean, side?: string, tokenId?: string, conditionId?: string, reason: string, sizePct?: number }}
 */
export function tick({
  tokenPrice, timeLeftMin, mlConfidence, mlSide,
  ensembleProb, hasPosition, isHalted, bankroll, marketSlug,
}) {
  const cfg = BOT_CONFIG.recoveryBuy;
  const no = (reason) => ({ shouldBuy: false, reason });

  // ── Not active ──
  if (state === STATE.IDLE) return no('idle');
  if (!cfg?.enabled) { reset(); return no('disabled'); }

  // ── Market switched while recovery was pending ──
  if (marketSlug !== cutLossMarketSlug) {
    log.info(`Recovery cancelled — market switched (${cutLossMarketSlug} → ${marketSlug})`);
    reset();
    return no('market_switched');
  }

  const now = Date.now();
  const elapsed = now - stateEnteredAt;

  // ── SAMPLING phase: collect baseline prices ──
  if (state === STATE.SAMPLING) {
    if (tokenPrice != null && Number.isFinite(tokenPrice)) {
      baselinePrices.push(tokenPrice);
    }

    if (elapsed < cfg.samplingMs) {
      return no(`sampling_${Math.round(elapsed / 1000)}s/${cfg.samplingMs / 1000}s`);
    }

    // Transition: SAMPLING → MONITORING
    if (baselinePrices.length === 0) {
      log.info('Recovery cancelled — no prices during sampling');
      reset();
      return no('no_sampling_data');
    }

    // Baseline = median of sampled prices (robust to outliers)
    baselinePrices.sort((a, b) => a - b);
    baselinePrice = baselinePrices[Math.floor(baselinePrices.length / 2)];

    state = STATE.MONITORING;
    stateEnteredAt = now;
    log.info(`Recovery MONITORING: baseline=${(baselinePrice * 100).toFixed(1)}c — watching for ${cfg.monitoringMs / 1000}s`);
    return no('entered_monitoring');
  }

  // ── MONITORING phase: check gates each poll ──
  if (state === STATE.MONITORING) {
    // Timeout — give up
    if (elapsed > cfg.monitoringMs) {
      log.info(`Recovery expired after ${cfg.monitoringMs / 1000}s monitoring — no stable entry found`);
      reset();
      return no('monitoring_expired');
    }

    // Gate 1: Not halted
    if (isHalted) return no('halted');

    // Gate 2: Bankroll
    if (bankroll < cfg.minBankroll) return no(`bankroll_$${bankroll.toFixed(2)}<$${cfg.minBankroll}`);

    // Gate 3: Time left
    if (timeLeftMin != null && timeLeftMin < cfg.minTimeLeftMin) {
      log.info(`Recovery cancelled — too close to settlement (${timeLeftMin.toFixed(1)}min)`);
      reset();
      return no('near_settlement');
    }

    // Gate 4: No open position
    if (hasPosition) return no('has_position');

    // Gate 5: Token price available and above minimum
    if (tokenPrice == null || !Number.isFinite(tokenPrice)) return no('no_price');
    if (tokenPrice < cfg.minTokenPrice) return no(`price_${(tokenPrice * 100).toFixed(0)}c<${(cfg.minTokenPrice * 100).toFixed(0)}c`);

    // Gate 6: Token stable or rising vs baseline
    if (baselinePrice != null && tokenPrice < baselinePrice * 0.97) {
      // Still falling — 3%+ below baseline, don't buy into continued decline
      return no(`falling_${(tokenPrice * 100).toFixed(0)}c<baseline_${(baselinePrice * 100).toFixed(0)}c`);
    }

    // Gate 7: ML still agrees
    if (mlConfidence == null || mlConfidence < cfg.minMlConfidence) {
      return no(`ml_conf_${mlConfidence != null ? (mlConfidence * 100).toFixed(0) + '%' : 'null'}<${(cfg.minMlConfidence * 100).toFixed(0)}%`);
    }
    if (mlSide !== cutLossSide) return no(`ml_side_${mlSide}_!=_${cutLossSide}`);

    // Gate 8: Ensemble probability
    if (ensembleProb == null || ensembleProb < cfg.minEnsembleProb) {
      return no(`prob_${ensembleProb != null ? (ensembleProb * 100).toFixed(0) + '%' : 'null'}<${(cfg.minEnsembleProb * 100).toFixed(0)}%`);
    }

    // ═══ All gates passed — signal buy ═══
    log.info(
      `Recovery BUY signal: ${cutLossSide} | price=${(tokenPrice * 100).toFixed(1)}c | ` +
      `baseline=${(baselinePrice * 100).toFixed(1)}c | ML=${(mlConfidence * 100).toFixed(0)}% | ` +
      `prob=${(ensembleProb * 100).toFixed(0)}% | size=${(cfg.maxRecoveryPct * 100).toFixed(0)}%`
    );

    const result = {
      shouldBuy: true,
      side: cutLossSide,
      tokenId: cutLossTokenId,
      conditionId: cutLossConditionId,
      reason: 'recovery_buy',
      sizePct: cfg.maxRecoveryPct,
    };

    reset();
    return result;
  }

  return no('unknown_state');
}

/**
 * Reset recovery state. Called on settlement, market switch, or after buy.
 */
export function reset() {
  state = STATE.IDLE;
  cutLossSide = null;
  cutLossTokenId = null;
  cutLossConditionId = null;
  cutLossMarketSlug = null;
  stateEnteredAt = 0;
  baselinePrice = null;
  baselinePrices = [];
}

/**
 * Get recovery buy status for dashboard broadcast.
 */
export function getRecoveryStatus() {
  const cfg = BOT_CONFIG.recoveryBuy;
  if (!cfg?.enabled || state === STATE.IDLE) {
    return { enabled: cfg?.enabled ?? false, state: STATE.IDLE };
  }

  const elapsed = Date.now() - stateEnteredAt;
  return {
    enabled: true,
    state,
    side: cutLossSide,
    marketSlug: cutLossMarketSlug,
    elapsedMs: elapsed,
    baselinePrice,
    sampledCount: baselinePrices.length,
  };
}

/**
 * Check if recovery is currently active (not idle).
 */
export function isRecoveryActive() {
  return state !== STATE.IDLE;
}
