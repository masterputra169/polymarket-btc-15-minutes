/**
 * Limit Order Manager — passive entry at optimal prices via GTD limit orders.
 *
 * State machine:
 *   IDLE → EVALUATING → PLACED → MONITORING → FILLED | CANCELLED | FOK_FALLBACK
 *
 * Strategy:
 *   Place GTD limit BUY at 55-62¢ during first 0:30-3:00 of market.
 *   Monitor fill status every 2s. Cancel on signal flip or 10 min timeout.
 *   If not filled by cutoff, release to FOK fallback (existing step 10b).
 *
 * Price tiers (by ML confidence):
 *   ML ≥ 85% → max 62¢ (high confidence = tolerate worse price)
 *   ML 70-85% → max 58¢
 *   ML 60-70% → max 55¢
 *   Floor: 50¢ (below = random walk territory)
 *
 * Similar pattern to recoveryBuy.js — stateful module with tick-based evaluation.
 */

import { BOT_CONFIG } from '../config.js';
import { createLogger } from '../logger.js';
import { getSpreadTrend } from './executionTiming.js';

const log = createLogger('LimitOrder');

// ── Anti-loop protection (module-level, persists across state resets) ──
// Prevents place→cancel→place cycle that caused $16 loss on 2026-03-02.
// Scoped by market slug — fresh market = fresh attempts.
// v2: Raised to 2 — allows ONE re-placement after confirmed cancel (not phantom fill).
//     Phantom fills count as attempt, confirmed cancels allow 1 retry.
const MAX_ATTEMPTS_PER_MARKET = 2;     // Max 2 limit order attempts per market (cancel + retry allowed)
const CANCEL_COOLDOWN_MS = 30_000;     // 30s cooldown after cancel before re-placement (was 1min)
let attemptCount = 0;
let lastCancelAt = 0;
let marketForAttempts = null;

// ── Last event (persists across state resets for frontend transition display) ──
const LAST_EVENT_TTL_MS = 20_000; // Show fill/cancel event for 20s on frontend
let lastEvent = { type: null, data: null, at: 0 };

// ── Fill verification (prevents phantom fills from CLOB API indexing lag) ──
// Race condition: getOpenOrders() may return null right after placement (not yet indexed).
// Fix: require grace period + consecutive null checks before declaring "filled".
const FILL_GRACE_MS = 8_000;          // Don't check fills for 8s after placement
const FILL_CONFIRM_NULL_COUNT = 3;    // Require 3 consecutive null returns to confirm fill

// ── State ──
let state = {
  phase: 'IDLE',           // IDLE | PLACED | MONITORING | FILLED | FOK_FALLBACK
  orderId: null,           // CLOB order ID
  tokenId: null,           // Token being bought
  side: null,              // 'UP' | 'DOWN'
  targetPrice: null,       // Our limit price
  size: null,              // Shares
  marketSlug: null,        // Market this order belongs to
  conditionId: null,       // Oracle condition ID
  placedAt: null,          // Timestamp
  expirationTs: null,      // Unix seconds for GTD
  mlConfAtPlacement: null, // ML confidence when placed
  cancelReason: null,      // Why cancelled (if applicable)
  lastCheckAt: 0,          // Last CLOB status check timestamp
  evalCount: 0,            // Polls spent evaluating before placement
  nullCheckCount: 0,       // Consecutive null returns from getOrderById (fill verification)
};

/**
 * Compute target price as a discount from current market price.
 *
 * Strategy: "buy the dip" — place limit order X% below bestBid.
 * Discount scales by ML confidence: higher confidence → smaller discount (willing to pay more).
 *
 *   ML ≥ 85% → 5% discount  (very confident → small discount, likely fills)
 *   ML 70-85% → 8% discount  (confident → moderate discount)
 *   ML 60-70% → 12% discount (uncertain → demand bigger discount for risk)
 *
 * Examples (bestBid=65¢):  ML 90% → 61.8¢  |  ML 75% → 59.8¢  |  ML 62% → 57.2¢
 * Examples (bestBid=55¢):  ML 90% → 52.3¢  |  ML 75% → 50.6¢  |  ML 62% → 50.0¢ (floor)
 *
 * @param {number} mlConf - ML confidence (0-1)
 * @param {number|null} bestBid - Best bid from CLOB orderbook for our side
 * @returns {number} Target limit price (rounded to 0.001 tick)
 */
function computeTargetPrice(mlConf, bestBid) {
  const cfg = BOT_CONFIG.limitOrder;

  // Discount tier by ML confidence (higher conf → smaller discount)
  let discountPct;
  if (mlConf >= 0.85) {
    discountPct = 0.05;   // 5% below market
  } else if (mlConf >= 0.70) {
    discountPct = 0.08;   // 8% below market
  } else {
    discountPct = 0.12;   // 12% below market
  }

  let target;
  if (bestBid != null && Number.isFinite(bestBid) && bestBid > 0) {
    // Discount from current market price
    target = bestBid * (1 - discountPct);
  } else {
    // No orderbook data — use conservative fixed price
    target = cfg.priceTierLow;
  }

  // Cap at config maximum (never overpay)
  target = Math.min(target, cfg.maxEntryPrice);

  // Floor: don't go below minEntryPrice (below 50¢ = random walk territory)
  target = Math.max(target, cfg.minEntryPrice);

  // Round to Polymarket tick size (0.001)
  return Math.round(target * 1000) / 1000;
}

/**
 * Check if ML/BTC signal has flipped against our order.
 *
 * CONSERVATIVE: Limit orders already have GTD expiration as safety net.
 * Only cancel on very strong contrary evidence to avoid premature cancels
 * that miss profitable fills when price temporarily dips to our target.
 *
 * Previous triggers (prob drop <40%, BTC crosses PTB) were too noisy —
 * caused cancel at 50¢ then re-entry at 55¢ (worse price).
 *
 * @param {Object} params
 * @returns {{ flipped: boolean, reason: string }}
 */
function detectSignalFlip({ side, mlSide, mlConfidence, ensembleProb, btcPrice, priceToBeat }) {
  // Only cancel on very strong ML flip (≥85% confidence in opposite direction).
  // Lower thresholds caused premature cancels on noisy ML fluctuations.
  if (mlSide && mlSide !== side && mlConfidence != null && mlConfidence >= 0.85) {
    return { flipped: true, reason: `ml_flip_${mlSide}_${(mlConfidence * 100).toFixed(0)}%` };
  }

  return { flipped: false, reason: '' };
}

/**
 * Evaluate whether to place a limit order.
 * Called during minutes 0:30 - 3:00 of market.
 *
 * @param {Object} params
 * @param {number|null} params.mlConfidence - ML confidence (0-1)
 * @param {string|null} params.mlSide - ML predicted side ('UP' | 'DOWN')
 * @param {number|null} params.btcPrice - Current BTC price
 * @param {number|null} params.priceToBeat - PTB threshold
 * @param {number|null} params.bestBidUp - Best bid for UP token
 * @param {number|null} params.bestBidDown - Best bid for DOWN token
 * @param {boolean} params.hasPosition - Whether already has a position
 * @param {boolean} params.isHalted - Circuit breaker active
 * @param {string} params.marketSlug - Current market slug
 * @param {number} params.elapsedMin - Minutes since market opened
 * @returns {{ shouldPlace: boolean, side: string|null, targetPrice: number|null, reason: string }}
 */
export function evaluateLimitEntry({
  mlConfidence, mlSide, btcPrice, priceToBeat,
  bestBidUp, bestBidDown, hasPosition, isHalted,
  marketSlug, elapsedMin,
  btcDelta1m, spread,
}) {
  const cfg = BOT_CONFIG.limitOrder;
  const no = (reason) => {
    // Log first rejection per market for debugging (every 30s to avoid spam)
    if (!state._lastRejectLogAt || Date.now() - state._lastRejectLogAt > 30_000) {
      log.debug(`LIMIT_SKIP: ${reason} | ML=${mlConfidence != null ? (mlConfidence * 100).toFixed(0) + '%' : 'null'} ${mlSide ?? '?'} | elapsed=${elapsedMin?.toFixed(1) ?? '?'}m`);
      state._lastRejectLogAt = Date.now();
    }
    return { shouldPlace: false, side: null, targetPrice: null, reason };
  };

  // Basic guards
  if (!cfg?.enabled) return no('disabled');
  if (hasPosition) return no('has_position');
  if (isHalted) return no('halted');

  // Anti-loop: max 1 attempt per market (after cancel → FOK fallback only)
  if (marketSlug === marketForAttempts && attemptCount >= MAX_ATTEMPTS_PER_MARKET) {
    return no(`max_attempts_${attemptCount}`);
  }
  // Cooldown after cancel (even across market boundaries — prevent rapid fire)
  if (lastCancelAt > 0 && Date.now() - lastCancelAt < CANCEL_COOLDOWN_MS) {
    return no(`cancel_cooldown_${Math.round((Date.now() - lastCancelAt) / 1000)}s`);
  }

  // Time window: only evaluate during configured window
  if (elapsedMin < cfg.minElapsedMin) return no(`too_early_${elapsedMin.toFixed(1)}m`);
  if (elapsedMin > cfg.maxElapsedMin) return no(`past_window_${elapsedMin.toFixed(1)}m`);

  // ML must be loaded and confident enough
  if (mlConfidence == null || mlConfidence < cfg.minMlConfidence) {
    return no(`ml_conf_${mlConfidence != null ? (mlConfidence * 100).toFixed(0) + '%' : 'null'}`);
  }
  if (!mlSide) return no('no_ml_side');

  // Side from ML + BTC-PTB consensus
  // ML gives direction, BTC vs PTB confirms market agrees
  let side = mlSide;

  // BTC-PTB consensus gate (relaxed): only block when BTC is significantly on the wrong side.
  // BTC oscillates around PTB in early market — strict binary check blocked too many good entries.
  // Buffer: 0.05% (~$36 at $72k BTC) allows limit orders when BTC is near PTB.
  const PTB_BUFFER_PCT = 0.0005;
  if (btcPrice != null && priceToBeat != null && Number.isFinite(btcPrice) && Number.isFinite(priceToBeat)) {
    const distPct = (btcPrice - priceToBeat) / priceToBeat;
    if (side === 'UP' && distPct < -PTB_BUFFER_PCT) {
      return no(`btc_below_ptb_${(distPct * 100).toFixed(2)}%`);
    }
    if (side === 'DOWN' && distPct > PTB_BUFFER_PCT) {
      return no(`btc_above_ptb_+${(distPct * 100).toFixed(2)}%`);
    }
  }

  // ── Momentum gate — don't place limit orders during active selling pressure ──
  // Problem: limit orders placed during selloff get filled right as price keeps dropping.
  // Solution: wait for selling pressure to stabilize before placing.
  // Gate 1: BTC momentum opposing signal direction (strong move against us)
  if (btcDelta1m != null && Number.isFinite(btcDelta1m)) {
    const ADVERSE_MOMENTUM_USD = 30; // $30 BTC move against us in 1 min = strong adverse momentum
    if (side === 'UP' && btcDelta1m < -ADVERSE_MOMENTUM_USD) {
      return no(`momentum_adverse_delta_${btcDelta1m.toFixed(0)}`);
    }
    if (side === 'DOWN' && btcDelta1m > ADVERSE_MOMENTUM_USD) {
      return no(`momentum_adverse_delta_+${btcDelta1m.toFixed(0)}`);
    }
  }
  // Gate 2: Spread widening = orderbook stress, price likely still moving
  if (spread != null && Number.isFinite(spread)) {
    const spreadTrend = getSpreadTrend(spread);
    if (spreadTrend === 'wide') {
      return no(`spread_wide_${(spread * 100).toFixed(1)}%`);
    }
  }

  // Compute target price
  const bestBid = side === 'UP' ? bestBidUp : bestBidDown;
  const targetPrice = computeTargetPrice(mlConfidence, bestBid);

  // Fix #3: Limit-specific edge gate — mlConfidence minus entry price must be positive.
  // Unlike FOK edge (model_prob - market_price), limit edge uses our actual entry price.
  // Example: ML 65%, target 55c → limit_edge = 10% (good). ML 55%, target 54c → 1% (marginal).
  const MIN_LIMIT_EDGE = 0.05; // 5% minimum edge at our entry price
  const limitEdge = mlConfidence - targetPrice;
  if (limitEdge < MIN_LIMIT_EDGE) {
    return no(`limit_edge_${(limitEdge * 100).toFixed(1)}%<${(MIN_LIMIT_EDGE * 100).toFixed(0)}%`);
  }

  // Increment eval count
  state.evalCount++;

  // Require minimum evaluation polls for confidence
  if (state.evalCount < cfg.minEvalPolls) {
    return no(`eval_${state.evalCount}/${cfg.minEvalPolls}`);
  }

  const discountPct = bestBid ? ((1 - targetPrice / bestBid) * 100).toFixed(0) : '?';
  log.info(
    `LIMIT_EVAL: ${side} target=${(targetPrice * 100).toFixed(1)}c (-${discountPct}%) | ` +
    `ML=${(mlConfidence * 100).toFixed(0)}% ${mlSide} | ` +
    `bestBid=${bestBid != null ? (bestBid * 100).toFixed(1) + 'c' : 'null'} | ` +
    `elapsed=${elapsedMin.toFixed(1)}m`
  );

  return { shouldPlace: true, side, targetPrice, reason: 'eval_passed' };
}

/**
 * Place a GTD limit buy order.
 *
 * @param {Object} params
 * @param {string} params.side - 'UP' | 'DOWN'
 * @param {number} params.targetPrice - Limit price
 * @param {string} params.tokenId - Token to buy
 * @param {string} params.marketSlug - Market slug
 * @param {string|null} params.conditionId - Oracle condition ID
 * @param {number} params.marketEndMs - Market end timestamp (ms)
 * @param {number} params.bankroll - Available bankroll
 * @param {number} params.mlConfidence - ML conf at placement
 * @param {number} [params.sessionQuality] - Session quality multiplier (1.0=US, 0.85=Asia, 0.7=Off)
 * @param {Object} deps - Dependencies
 * @param {Function} deps.placeLimitBuyOrder - CLOB limit order function
 * @param {Function} deps.setPendingCost - Reserve bankroll
 * @returns {Promise<{ placed: boolean, orderId: string|null, reason: string }>}
 */
export async function placeLimitOrder({
  side, targetPrice, tokenId, marketSlug, conditionId,
  marketEndMs, bankroll, mlConfidence, sessionQuality,
}, deps) {
  const cfg = BOT_CONFIG.limitOrder;

  // ── Kelly Criterion sizing for limit orders ──
  // Same formula as asymmetricBet.js but adapted for limit order entry price.
  // Limit orders at 55-65¢ have much better payoff ratio than FOK at 70-80¢,
  // so Kelly naturally recommends larger bets at cheap prices.
  const CLOB_MIN_SHARES = 5;
  const HALF_KELLY = 0.50;          // Conservative half-Kelly
  const POLY_FEE = 0.25 * Math.pow(targetPrice * (1 - targetPrice), 2); // Dynamic fee
  const SPREAD_COST = 0.01;         // Limit orders = maker → lower spread cost
  const grossB = (1 / targetPrice) - 1;                   // Gross payoff ratio
  const netB = grossB * (1 - POLY_FEE - SPREAD_COST);     // Net after fees
  const p = mlConfidence;                                  // Win probability from ML
  const q = 1 - p;
  const rawKelly = (netB * p - q) / netB;

  if (!Number.isFinite(rawKelly) || rawKelly <= 0) {
    return { placed: false, orderId: null, reason: `negative_kelly_${(rawKelly * 100).toFixed(1)}%` };
  }

  // Confidence-tiered Kelly cap (same logic as tradePipeline.js)
  const kellyCapPct = mlConfidence >= 0.85 ? 0.08
    : mlConfidence >= 0.70 ? 0.06
    : 0.04;

  // Fix #5: Scale maxBet with bankroll (same as tradePipeline.js audit v5 M4)
  const fixedMaxBet = BOT_CONFIG.maxBetAmountUsd ?? 2.50;
  const maxBet = Math.max(fixedMaxBet, bankroll * kellyCapPct);
  const kellyBet = bankroll * rawKelly * HALF_KELLY;
  const kellyCap = bankroll * kellyCapPct;
  const betAmount = Math.min(kellyBet, kellyCap, maxBet);

  // Fix #7: Apply session quality scaling (Asia=0.85, Off=0.7)
  const sq = (sessionQuality != null && Number.isFinite(sessionQuality) && sessionQuality > 0) ? sessionQuality : 1.0;
  const sqBetAmount = sq < 1.0 ? Math.round(betAmount * sq * 100) / 100 : betAmount;
  if (sq < 1.0) log.info(`LIMIT session quality: $${betAmount.toFixed(2)} × ${sq} = $${sqBetAmount.toFixed(2)}`);

  let size = Math.floor(sqBetAmount / targetPrice);

  // Enforce CLOB minimum 5 shares — bump up if affordable
  if (size < CLOB_MIN_SHARES) {
    const minCost = CLOB_MIN_SHARES * targetPrice;
    if (minCost <= maxBet && minCost <= bankroll * 0.15) {
      size = CLOB_MIN_SHARES;
    } else {
      return { placed: false, orderId: null, reason: `min_shares_${size}<${CLOB_MIN_SHARES}_cost_$${minCost.toFixed(2)}` };
    }
  }

  const orderCost = Math.round(size * targetPrice * 100) / 100;
  if (orderCost < 1.00) {
    return { placed: false, orderId: null, reason: `below_minimum_$${orderCost.toFixed(2)}` };
  }

  log.info(
    `LIMIT SIZING: Kelly=${(rawKelly * 100).toFixed(1)}% × ${HALF_KELLY} → ` +
    `$${kellyBet.toFixed(2)} | cap=${(kellyCapPct * 100).toFixed(0)}%=$${kellyCap.toFixed(2)} | ` +
    `bet=$${betAmount.toFixed(2)} → ${size}@${(targetPrice * 100).toFixed(1)}c`
  );

  // GTD expiration: market end - buffer (default 2 min)
  const expirationTs = Math.floor(marketEndMs / 1000) - cfg.expirationBufferSec;
  const nowSec = Math.floor(Date.now() / 1000);
  if (expirationTs <= nowSec) {
    return { placed: false, orderId: null, reason: 'expiration_past' };
  }

  // Reserve bankroll
  deps.setPendingCost(orderCost);

  try {
    const result = await deps.placeLimitBuyOrder({
      tokenId,
      price: targetPrice,
      size,
      expiration: expirationTs,
    });

    const orderId = result?.orderId ?? null;

    // Update state
    state = {
      phase: 'MONITORING',
      orderId,
      tokenId,
      side,
      targetPrice,
      size,
      marketSlug,
      conditionId: conditionId ?? null,
      placedAt: Date.now(),
      expirationTs,
      mlConfAtPlacement: mlConfidence,
      cancelReason: null,
      lastCheckAt: 0,
      evalCount: 0,
    };

    log.info(
      `LIMIT ORDER PLACED: ${side} ${size}@${(targetPrice * 100).toFixed(1)}c ($${orderCost.toFixed(2)}) | ` +
      `orderId=${orderId} | exp=${new Date(expirationTs * 1000).toISOString()}`
    );

    return { placed: true, orderId, reason: 'placed' };
  } catch (err) {
    deps.setPendingCost(0); // Release reservation on failure
    log.error(`LIMIT ORDER FAILED: ${err.message}`);
    // Count as attempt to prevent retry spam (anti-loop)
    attemptCount++;
    lastCancelAt = Date.now();
    marketForAttempts = marketSlug;
    resetLimitOrderState();
    return { placed: false, orderId: null, reason: `error: ${err.message}` };
  }
}

/**
 * Monitor active limit order each poll.
 * Checks fill status, signal flip, time cutoff.
 *
 * @param {Object} params
 * @param {number|null} params.mlConfidence
 * @param {string|null} params.mlSide
 * @param {number|null} params.ensembleProb - Ensemble prob for our side
 * @param {number|null} params.btcPrice
 * @param {number|null} params.priceToBeat
 * @param {number|null} params.elapsedMin - Minutes since market opened
 * @param {string} params.marketSlug
 * @param {Object} deps
 * @param {Function} deps.getOrderById - Check order status
 * @param {Function} [deps.getOrderStatus] - Definitive order status check (/data/order/{id})
 * @param {Function} deps.cancelOrder - Cancel order
 * @param {Function} deps.setPendingCost - Release bankroll
 * @returns {Promise<{ action: string, detail: string, fillData?: Object }>}
 */
export async function monitorLimitOrder({
  mlConfidence, mlSide, ensembleProb, btcPrice, priceToBeat,
  elapsedMin, marketSlug,
}, deps) {
  const cfg = BOT_CONFIG.limitOrder;

  if (state.phase !== 'MONITORING' || !state.orderId) {
    return { action: 'NONE', detail: 'not_monitoring' };
  }

  // Market switched while order active
  if (marketSlug !== state.marketSlug) {
    return { action: 'CANCEL_MARKET_SWITCH', detail: `market_switched_${state.marketSlug}_to_${marketSlug}` };
  }

  // Signal flip detection (check every poll — cancels are time-critical)
  const flip = detectSignalFlip({
    side: state.side,
    mlSide,
    mlConfidence,
    ensembleProb,
    btcPrice,
    priceToBeat,
  });
  if (flip.flipped) {
    log.info(`LIMIT ORDER signal flip: ${flip.reason}`);
    return { action: 'CANCEL_SIGNAL_FLIP', detail: flip.reason };
  }

  // Time cutoff — cancel after N minutes to allow FOK fallback
  if (elapsedMin != null && elapsedMin >= cfg.cancelAfterElapsedMin) {
    log.info(`LIMIT ORDER time cutoff: ${elapsedMin.toFixed(1)}m >= ${cfg.cancelAfterElapsedMin}m`);
    return { action: 'CANCEL_TIME_CUTOFF', detail: `elapsed_${elapsedMin.toFixed(1)}m` };
  }

  // Grace period — don't check fills too soon after placement (CLOB API indexing lag)
  const now = Date.now();
  const holdMs = now - state.placedAt;
  if (holdMs < FILL_GRACE_MS) {
    return { action: 'HOLD', detail: `grace_${Math.round(holdMs / 1000)}s/${Math.round(FILL_GRACE_MS / 1000)}s` };
  }

  // Throttled CLOB status check (every checkIntervalMs)
  if (now - state.lastCheckAt < cfg.checkIntervalMs) {
    return { action: 'HOLD', detail: 'check_throttled' };
  }
  state.lastCheckAt = now;

  // Check order status via CLOB API
  try {
    const order = await deps.getOrderById(state.orderId);

    if (order === null) {
      // Order not in open orders — could be filled OR API indexing lag.
      // Require multiple consecutive null returns to confirm fill (prevents phantom fills).
      state.nullCheckCount++;
      if (state.nullCheckCount < FILL_CONFIRM_NULL_COUNT) {
        log.debug(
          `LIMIT_CHECK: order null ${state.nullCheckCount}/${FILL_CONFIRM_NULL_COUNT} — ` +
          `awaiting confirmation (held ${(holdMs / 1000).toFixed(0)}s)`
        );
        return { action: 'HOLD', detail: `null_${state.nullCheckCount}/${FILL_CONFIRM_NULL_COUNT}` };
      }
      // Order gone after multiple null checks — verify via getOrderStatus before declaring filled.
      // GTD-expired orders also disappear from getOpenOrders(); only MATCHED status = real fill.
      if (deps.getOrderStatus) {
        try {
          const detail = await deps.getOrderStatus(state.orderId);
          const st = (detail?.status ?? detail?.order_status ?? '').toUpperCase();
          if (st && st !== 'MATCHED') {
            log.info(`LIMIT ORDER not filled (status: ${st}) — GTD expired or cancelled on-chain | orderId=${state.orderId}`);
            deps.setPendingCost(0);
            resetLimitOrderState();
            return { action: 'CANCEL_EXPIRED', detail: `order_status_${st.toLowerCase()}` };
          }
        } catch (err) {
          log.debug(`getOrderStatus during fill check failed: ${err.message} — treating as filled`);
        }
      }

      // Confirmed: order gone after multiple checks + status is MATCHED (or status check unavailable)
      log.info(
        `LIMIT ORDER FILLED: ${state.side} ${state.size}@${(state.targetPrice * 100).toFixed(1)}c | ` +
        `held ${(holdMs / 1000).toFixed(0)}s | confirmed after ${state.nullCheckCount} null checks | orderId=${state.orderId}`
      );
      return {
        action: 'FILLED',
        detail: `filled_after_${(holdMs / 1000).toFixed(0)}s`,
        fillData: {
          side: state.side,
          tokenId: state.tokenId,
          price: state.targetPrice,
          size: state.size,
          conditionId: state.conditionId,
          marketSlug: state.marketSlug,
          orderId: state.orderId,
        },
      };
    }

    // Order found on book — reset null counter (previous nulls were API glitches)
    if (state.nullCheckCount > 0) {
      log.debug(`LIMIT_CHECK: order found on book — resetting null count (was ${state.nullCheckCount})`);
      state.nullCheckCount = 0;
    }

    // Order still on book — check for partial fills
    const originalSize = parseFloat(order.original_size ?? order.size ?? state.size);
    const sizeMatched = parseFloat(order.size_matched ?? 0);
    if (sizeMatched > 0 && originalSize > 0) {
      const fillRatio = sizeMatched / originalSize;
      const holdMs = now - state.placedAt;

      if (fillRatio >= cfg.partialFillAcceptRatio) {
        // Accept partial fill — enough to be meaningful
        log.info(
          `LIMIT ORDER PARTIAL ACCEPT: ${(fillRatio * 100).toFixed(0)}% filled (${sizeMatched}/${originalSize}) | ` +
          `${state.side} @${(state.targetPrice * 100).toFixed(1)}c | held ${(holdMs / 1000).toFixed(0)}s`
        );
        // Fix #6: Use actual sizeMatched (not Math.floor) — CLOB reports exact filled shares.
        // Flooring loses real shares → bankroll drift. Round to nearest integer for ERC-1155.
        const acceptedSize = Math.round(sizeMatched);
        return {
          action: 'PARTIAL_ACCEPT',
          detail: `partial_${(fillRatio * 100).toFixed(0)}%`,
          fillData: {
            side: state.side,
            tokenId: state.tokenId,
            price: state.targetPrice,
            size: Math.max(1, acceptedSize), // At least 1 share if partial accepted
            conditionId: state.conditionId,
            marketSlug: state.marketSlug,
            orderId: state.orderId,
          },
        };
      } else if (fillRatio > 0) {
        log.debug(`LIMIT_CHECK: partial ${(fillRatio * 100).toFixed(0)}% < accept ${(cfg.partialFillAcceptRatio * 100).toFixed(0)}% — still monitoring`);
      }
    }

    // Still on book, no meaningful fill — keep waiting
    const holdSec = ((now - state.placedAt) / 1000).toFixed(0);
    log.debug(`LIMIT_CHECK: ${state.side} order active ${holdSec}s | orderId=${state.orderId}`);
    return { action: 'HOLD', detail: `active_${holdSec}s` };
  } catch (err) {
    log.warn(`LIMIT_CHECK error: ${err.message} — will retry next interval`);
    return { action: 'HOLD', detail: `check_error: ${err.message}` };
  }
}

/**
 * Cancel the active limit order. Verifies cancel success with TWO-LAYER
 * fill detection:
 *   Layer 1: getOpenOrders() — order gone = likely filled
 *   Layer 2: getOrderStatus() via /data/order/{id} — definitive MATCHED status
 *
 * Fixes the phantom fill bug where getOpenOrders() has stale data (order
 * appears on book even though matching engine already filled it).
 *
 * @param {string} reason - Why cancelling
 * @param {Object} deps
 * @param {Function} deps.cancelOrder
 * @param {Function} deps.setPendingCost
 * @param {Function} [deps.getOrderById] - For verifying cancel success (open orders)
 * @param {Function} [deps.getOrderStatus] - Secondary check via /data/order/{id}
 * @returns {Promise<{ cancelled: boolean, filledInstead: boolean, fillData?: Object }>}
 */
export async function cancelLimitOrder(reason, deps) {
  if (state.phase === 'IDLE' || !state.orderId) {
    log.debug(`cancelLimitOrder(${reason}): already idle`);
    return { cancelled: true, filledInstead: false };
  }

  const orderId = state.orderId;
  // Snapshot fill data BEFORE reset — needed if order was actually filled
  const savedFillData = {
    side: state.side,
    tokenId: state.tokenId,
    price: state.targetPrice,
    size: state.size,
    conditionId: state.conditionId,
    marketSlug: state.marketSlug,
    orderId: state.orderId,
  };
  const savedMarketSlug = state.marketSlug;
  state.cancelReason = reason;

  let cancelApiOk = false;

  try {
    const result = await deps.cancelOrder(orderId);

    // CLOB client swallows HTTP errors — check result.error
    if (result?.error) {
      log.warn(`LIMIT cancel rejected by CLOB: ${JSON.stringify(result.error)} — verifying order status`);
    } else {
      cancelApiOk = true;
    }
  } catch (err) {
    log.warn(`LIMIT ORDER cancel threw (${reason}): ${err.message} — verifying order status`);
  }

  // ── Helper: finalize phantom fill ──
  const returnPhantomFill = (scenario) => {
    log.warn(
      `LIMIT ORDER PHANTOM FILL (${scenario}): cancel(${reason}) order ${orderId} → ` +
      `recording as filled: ${savedFillData.side} ${savedFillData.size}@${(savedFillData.price * 100).toFixed(1)}c`
    );
    deps.setPendingCost(0);
    lastEvent = { type: 'FILLED', data: savedFillData, at: Date.now() };
    attemptCount++;
    lastCancelAt = Date.now();
    marketForAttempts = savedMarketSlug;
    resetLimitOrderState();
    return { cancelled: false, filledInstead: true, fillData: savedFillData };
  };

  // ── LAYER 1: Check open orders list ──
  // CLOB cancel API "success" does NOT guarantee the order wasn't filled.
  // Race condition: matching engine fills the order, THEN processes cancel.
  if (deps.getOrderById) {
    try {
      const order = await deps.getOrderById(orderId);
      const holdMs = state.placedAt ? Date.now() - state.placedAt : Infinity;

      if (order === null && holdMs >= FILL_GRACE_MS) {
        // Order gone from open orders AND past grace period.
        // When cancel API succeeded, order null is EXPECTED (we just cancelled it).
        // Must verify via Layer 2 (getOrderStatus) to distinguish cancel vs fill.
        if (deps.getOrderStatus) {
          try {
            const orderDetail = await deps.getOrderStatus(orderId);
            const status = (orderDetail?.status ?? orderDetail?.order_status ?? '').toUpperCase();
            if (status === 'MATCHED') {
              return returnPhantomFill(cancelApiOk ? 'CANCEL_API_OK_BUT_MATCHED' : 'CANCEL_FAILED_AND_MATCHED');
            }
            // Status is CANCELLED, EXPIRED, or other non-MATCHED → cancel worked, not filled
            log.info(`LIMIT ORDER verified not filled (status: ${status || 'unknown'}) — cancel confirmed`);
          } catch (statusErr) {
            log.debug(`getOrderStatus after cancel failed: ${statusErr.message}`);
            // If status check fails AND cancel API failed → assume phantom fill (safer)
            if (!cancelApiOk) {
              return returnPhantomFill('CANCEL_FAILED_STATUS_UNKNOWN');
            }
            // Cancel API OK but status check failed → trust the cancel API
            log.info(`LIMIT ORDER cancel API OK, status check failed — trusting cancel`);
          }
        } else if (!cancelApiOk) {
          // No Layer 2 available and cancel failed → assume phantom fill
          return returnPhantomFill('CANCEL_FAILED_NO_STATUS_CHECK');
        }
        // cancelApiOk=true with no Layer 2 → trust cancel API
      } else if (order === null && holdMs < FILL_GRACE_MS) {
        // Within grace period — null COULD be API indexing lag OR a genuine fill.
        // KEY SIGNAL: if cancel API also returned an error ("Invalid order payload"),
        // the order likely doesn't exist anymore (was already matched on-chain).
        // Use Layer 2 (getOrderStatus via /data/order/{id}) for definitive answer.
        if (!cancelApiOk && deps.getOrderStatus) {
          try {
            const orderDetail = await deps.getOrderStatus(orderId);
            const status = (orderDetail?.status ?? orderDetail?.order_status ?? '').toUpperCase();
            if (status === 'MATCHED') {
              return returnPhantomFill('GRACE_PERIOD_BUT_MATCHED');
            }
            log.info(`LIMIT ORDER /data/order status during grace: ${status || 'unknown'} — not matched, treating as cancelled`);
          } catch (statusErr) {
            log.debug(`getOrderStatus grace check failed: ${statusErr.message}`);
          }
        }

        if (!cancelApiOk) {
          // Cancel API error + order null within grace = high suspicion of fill
          // Layer 2 either wasn't available or returned non-MATCHED status
          log.warn(
            `LIMIT ORDER cancel: order null + cancel API error within grace period ` +
            `(${Math.round(holdMs / 1000)}s < ${Math.round(FILL_GRACE_MS / 1000)}s) — ` +
            `treating as cancelled but status uncertain (Layer 2 inconclusive)`
          );
        } else {
          log.warn(
            `LIMIT ORDER cancel: order null but only ${Math.round(holdMs / 1000)}s after placement ` +
            `(< ${Math.round(FILL_GRACE_MS / 1000)}s grace) — treating as cancelled, not filled`
          );
        }
      } else if (order !== null && !cancelApiOk) {
        // ── LAYER 2: Order appears on book but cancel failed ──
        // getOpenOrders() can have STALE data — matching engine may have filled
        // the order but the open orders index hasn't updated yet.
        // Use /data/order/{id} for the definitive status.
        if (deps.getOrderStatus) {
          try {
            const orderDetail = await deps.getOrderStatus(orderId);
            const status = (orderDetail?.status ?? orderDetail?.order_status ?? '').toUpperCase();
            if (status === 'MATCHED') {
              return returnPhantomFill('STALE_BOOK_BUT_MATCHED');
            }
            log.info(`LIMIT ORDER /data/order status: ${status || 'unknown'} — not matched, retrying cancel`);
          } catch (statusErr) {
            log.debug(`getOrderStatus fallback failed: ${statusErr.message}`);
          }
        }

        // Truly still on book — retry cancel once
        log.warn(`LIMIT ORDER still on book after failed cancel — retry once`);
        let retryOk = false;
        try {
          const retryResult = await deps.cancelOrder(orderId);
          if (retryResult?.error) {
            log.warn(`LIMIT ORDER cancel retry also returned error: ${retryResult.error}`);
          } else {
            log.info(`LIMIT ORDER cancel retry succeeded: ${orderId}`);
            retryOk = true;
          }
        } catch (retryErr) {
          log.warn(`LIMIT ORDER cancel retry threw: ${retryErr.message}`);
        }

        // ── FINAL VERIFICATION: If retry also failed, check definitive status ──
        // The order may have been matched between our checks (race condition).
        if (!retryOk && deps.getOrderStatus) {
          try {
            const finalDetail = await deps.getOrderStatus(orderId);
            const finalStatus = (finalDetail?.status ?? finalDetail?.order_status ?? '').toUpperCase();
            if (finalStatus === 'MATCHED') {
              return returnPhantomFill('RETRY_FAILED_BUT_MATCHED');
            }
            log.warn(`LIMIT ORDER final status after failed retry: ${finalStatus || 'unknown'} — GTD expiration is safety net`);
          } catch (finalErr) {
            log.debug(`Final getOrderStatus check failed: ${finalErr.message}`);
          }
        }
      }
      // else: order still on book + cancel API OK → truly cancelled
    } catch (checkErr) {
      log.warn(`Order status verification failed: ${checkErr.message} — GTD expiration is safety net`);
    }
  } else if (!cancelApiOk && deps.getOrderStatus) {
    // ── No getOrderById but getOrderStatus available — use it directly ──
    try {
      const orderDetail = await deps.getOrderStatus(orderId);
      const status = (orderDetail?.status ?? orderDetail?.order_status ?? '').toUpperCase();
      if (status === 'MATCHED') {
        return returnPhantomFill('NO_OPEN_ORDERS_CHECK_BUT_MATCHED');
      }
    } catch (statusErr) {
      log.debug(`getOrderStatus fallback failed: ${statusErr.message}`);
    }
  }

  log.info(`LIMIT ORDER CANCELLED: ${reason} | orderId=${orderId} | side=${state.side}`);

  // Preserve event for frontend transition display
  lastEvent = { type: 'CANCELLED', data: { ...savedFillData, reason }, at: Date.now() };

  // Track cooldown (prevents immediate re-placement)
  attemptCount++;
  lastCancelAt = Date.now();
  marketForAttempts = savedMarketSlug;

  // Release bankroll reservation
  deps.setPendingCost(0);
  resetLimitOrderState();
  return { cancelled: true, filledInstead: false };
}

/**
 * Reset all limit order state. Called on market switch, settlement, etc.
 */
export function resetLimitOrderState() {
  state = {
    phase: 'IDLE',
    orderId: null,
    tokenId: null,
    side: null,
    targetPrice: null,
    size: null,
    marketSlug: null,
    conditionId: null,
    placedAt: null,
    expirationTs: null,
    mlConfAtPlacement: null,
    cancelReason: null,
    lastCheckAt: 0,
    evalCount: 0,
    nullCheckCount: 0,
  };
}

/**
 * Reset anti-loop protection. Called on market switch to allow fresh attempts
 * for new market. NOT called on cut-loss/take-profit (same market = no retry).
 */
export function resetLimitAttempts() {
  attemptCount = 0;
  lastCancelAt = 0;
  marketForAttempts = null;
}

/**
 * Record a fill event for frontend transition display.
 * Called from loop.js after recordTrade() and before resetLimitOrderState().
 */
export function recordFillEvent(fillData) {
  lastEvent = { type: 'FILLED', data: fillData, at: Date.now() };
}

/**
 * Get limit order status for dashboard broadcast.
 * Includes recent fill/cancel events (within TTL) for frontend transition animations.
 */
export function getLimitOrderStatus() {
  const cfg = BOT_CONFIG.limitOrder;

  // Include recent event if within TTL (fill/cancel transition for frontend)
  const recentEvent = (lastEvent.at && Date.now() - lastEvent.at < LAST_EVENT_TTL_MS)
    ? { type: lastEvent.type, side: lastEvent.data?.side, price: lastEvent.data?.price,
        size: lastEvent.data?.size, reason: lastEvent.data?.reason, ageSec: Math.round((Date.now() - lastEvent.at) / 1000) }
    : null;

  if (!cfg?.enabled || state.phase === 'IDLE') {
    return { enabled: cfg?.enabled ?? false, phase: 'IDLE', lastEvent: recentEvent };
  }

  return {
    enabled: true,
    phase: state.phase,
    side: state.side,
    targetPrice: state.targetPrice,
    size: state.size,
    orderId: state.orderId,
    marketSlug: state.marketSlug,
    placedAt: state.placedAt,
    elapsedMs: state.placedAt ? Date.now() - state.placedAt : 0,
    mlConfAtPlacement: state.mlConfAtPlacement,
    cancelReason: state.cancelReason,
    cancelAfterMin: cfg.cancelAfterElapsedMin,
    lastEvent: recentEvent,
  };
}

/**
 * Check if a limit order is currently active (on book or being monitored).
 */
export function isLimitOrderActive() {
  return state.phase === 'MONITORING' || state.phase === 'PLACED';
}
