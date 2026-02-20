/**
 * Cut-loss (stop-loss) evaluator — v6 Pure EV Cut-Loss.
 *
 * v6 rewrite: Data-driven simplification based on 71 real trades analysis.
 *
 * EVIDENCE (71 trades, 24 cut-loss, 38 settlement):
 *   - Settlement WR: 71.1% (27W/11L) → most positions WIN if held
 *   - Cut-loss destroyed $28.77 of edge (P&L -$18.21 vs est. +$10.56 if held)
 *   - v5's 16-gate weighted scoring was too complex and always blocked cuts
 *     OR cut positions that would have won
 *
 * v6 PRINCIPLE: Only cut when the MODEL ITSELF agrees the position will lose.
 * Binary option EV math: CUT when modelProb < tokenPrice × evBuffer
 * (i.e., even our model thinks we're worse off than the market implies)
 *
 * Gate chain (all must pass for shouldCut = true):
 *   1.  Feature enabled
 *   2.  Has open, fill-confirmed position (not ARB)
 *   3.  Max attempts not exceeded
 *   4.  Cooldown elapsed since last failed sell
 *   5.  Min hold time met (120s)
 *   6.  Not too close to settlement (< 30s)
 *
 * FAST TRACKS (skip to confirmation):
 *   6b. CRASH: drop >= crashDropPct AND BTC distance >= crashBtcDistPct
 *   6c. LATE FORCE-CUT: <2min left + drop >= 15%
 *
 * CUT DECISION (must pass ONE of):
 *   7a. EV-NEGATIVE: modelProb < tokenPrice × evBuffer (model agrees with market)
 *   7b. ML FLIPPED: ML now predicts opposite side with confidence >= mlFlipConf
 *
 * MINIMUM DAMAGE:
 *   8.  Token drop >= minTokenDropPct (confirmed real loss, not noise)
 *
 * HARD EXECUTION GATES:
 *   9.  Token price above minimum
 *  10.  Orderbook liquidity sufficient
 *
 * CONFIRMATION:
 *  11.  2 consecutive polls agreeing
 */

import { BOT_CONFIG } from '../config.js';

// ── Module state (reset on settlement / market switch) ──
let sellAttempts = 0;
let lastSellAttemptMs = 0;
let consecutiveCutPolls = 0;
let firstLargeDropMs = 0; // Fix D: timestamp when position first crossed persistentDropPct threshold

// Token price ring buffer (for dashboard trajectory tracking)
const TOKEN_BUF_SIZE = 12; // 12 polls ≈ 36s at 3s interval
const tokenPriceBuf = new Float64Array(TOKEN_BUF_SIZE);
let tokenBufIdx = 0;
let tokenBufCount = 0;

function recordTokenPrice(price) {
  if (price == null || !Number.isFinite(price)) return;
  tokenPriceBuf[tokenBufIdx] = price;
  tokenBufIdx = (tokenBufIdx + 1) % TOKEN_BUF_SIZE;
  if (tokenBufCount < TOKEN_BUF_SIZE) tokenBufCount++;
}

function getTokenPriceSlope() {
  if (tokenBufCount < 4) return null;
  const newest = tokenPriceBuf[(tokenBufIdx - 1 + TOKEN_BUF_SIZE) % TOKEN_BUF_SIZE];
  const oldest = tokenPriceBuf[(tokenBufIdx - tokenBufCount + TOKEN_BUF_SIZE) % TOKEN_BUF_SIZE];
  return newest - oldest;
}

/**
 * Evaluate whether the current position should be cut.
 *
 * @param {Object} params
 * @param {Object} params.position - Current position from positionTracker
 * @param {number} params.currentTokenPrice - Live token price (market mid or best bid)
 * @param {Object|null} params.orderbook - Orderbook for this token side
 * @param {number|null} params.timeLeftMin - Minutes until market settlement
 * @param {number|null} params.btcPrice - Current BTC price
 * @param {number|null} params.priceToBeat - Price-to-beat (PTB) for this market
 * @param {number|null} params.modelProbability - Ensemble probability for position side (0-1)
 * @param {number|null} params.mlConfidence - ML model confidence (0-1)
 * @param {string|null} params.mlSide - ML predicted side ('UP'|'DOWN')
 * @param {string} params.regime - Current market regime
 * @param {string|null} params.entryRegime - Market regime at time of entry
 * @param {number|null} params.btcDelta1m - BTC price change per minute ($/min)
 * @param {number|null} params.atrRatio - Current ATR / average ATR (volatility scaling)
 * @returns {{ shouldCut: boolean, reason: string, sellPrice?: number, dropPct?: number, recoveryAmount?: number, diagnostics?: Object }}
 */
export function evaluateCutLoss({
  position, currentTokenPrice, orderbook, timeLeftMin,
  btcPrice, priceToBeat, modelProbability,
  mlConfidence, mlSide, regime, entryRegime, btcDelta1m, atrRatio,
}) {
  const cfg = BOT_CONFIG.cutLoss;
  const no = (reason) => {
    consecutiveCutPolls = 0;
    return { shouldCut: false, reason };
  };

  // ── Gate 1: Feature enabled? ──
  if (!cfg || !cfg.enabled) return no('disabled');

  // ── Gate 2: Has open, fill-confirmed position (not ARB)? ──
  if (!position || position.settled) return no('no_position');
  if (!position.fillConfirmed) return no('fill_unconfirmed');
  if (position.side === 'ARB') return no('arb_position');

  // ── Gate 3: Max attempts not exceeded? ──
  if (sellAttempts >= cfg.maxAttempts) return no(`max_attempts_${sellAttempts}/${cfg.maxAttempts}`);

  // ── Gate 4: Cooldown elapsed since last failed sell? ──
  const now = Date.now();
  if (lastSellAttemptMs > 0 && (now - lastSellAttemptMs) < cfg.cooldownMs) {
    return no('cooldown');
  }

  // ── Gate 5: Min hold time met? ──
  const holdSec = (now - position.enteredAt) / 1000;
  // v8: If token is in a steep crash (slope strongly negative) + big drop, reduce hold to 45s.
  // This protects against immediate post-entry crashes where waiting would lose more capital.
  const slope = getTokenPriceSlope();
  const isSteeplyFalling = slope !== null && slope < -0.10; // dropping > 10 cents in last 36s
  const earlyDropPct = currentTokenPrice != null && position.price > 0
    ? ((position.price - currentTokenPrice) / position.price) * 100 : 0;
  const minHoldRequired = (isSteeplyFalling && earlyDropPct >= 8) ? Math.min(45, cfg.minHoldSec) : cfg.minHoldSec;
  if (holdSec < minHoldRequired) return no(`hold_${Math.round(holdSec)}s/${minHoldRequired}s`);

  // ── Gate 6: Not too close to settlement? ──
  if (timeLeftMin != null && timeLeftMin < 0.5) return no('near_settlement');

  // ── Shared computations ──
  if (currentTokenPrice == null || !Number.isFinite(currentTokenPrice)) return no('no_price');
  const entryPrice = position.price;
  if (entryPrice < 0.01) return no('bad_entry_price'); // M3: min Polymarket token price is $0.01

  recordTokenPrice(currentTokenPrice);

  const dropPct = ((entryPrice - currentTokenPrice) / entryPrice) * 100;
  const hasPtb = btcPrice != null && priceToBeat != null &&
    Number.isFinite(btcPrice) && Number.isFinite(priceToBeat) && priceToBeat > 0;

  let btcDistPct = null;
  let btcFavorable = null;
  if (hasPtb) {
    const rawDistPct = ((btcPrice - priceToBeat) / priceToBeat) * 100;
    btcFavorable = position.side === 'UP' ? btcPrice >= priceToBeat : btcPrice < priceToBeat;
    btcDistPct = Math.abs(rawDistPct);
  }

  // ── Gate 6b: CRASH fast-track ──
  const crashDrop = cfg.crashDropPct ?? 30;
  const crashDist = cfg.crashBtcDistPct ?? 0.20;
  // H10: OR logic — 30%+ token drop is a crash even without BTC data.
  // BTC distance OR BTC unfavorable confirms, but lack of PTB data shouldn't block crash detection.
  const isCrash = dropPct >= crashDrop && (!hasPtb || btcDistPct >= crashDist || !btcFavorable);

  // ── Gate 6c: LATE FORCE-CUT fast-track ──
  // v9 conviction play: only cut when very close to expiry AND very large drop.
  // Loosened from (3.0min + 10%) → (2.0min + 25%) — don't panic-cut near settlement.
  const LATE_FORCE_CUT_MIN = 2.0;
  const LATE_FORCE_CUT_DROP = 25;
  const isLateForceCut = timeLeftMin != null && timeLeftMin < LATE_FORCE_CUT_MIN && dropPct >= LATE_FORCE_CUT_DROP;

  // ── Gate 6d: TIME-BASED PERSISTENT LOSS fast-track (Fix D) ──
  // If token has been down >= persistentDropPct% continuously for >= persistentDropMinutes,
  // cut without waiting for model agreement (skip gates 7a/7b).
  // Prevents holding a deeply losing position indefinitely while model is slow to flip.
  const persistentDropPct = cfg.persistentDropPct ?? 20;
  const persistentDropMs = (cfg.persistentDropMinutes ?? 5) * 60_000;
  if (dropPct >= persistentDropPct) {
    if (firstLargeDropMs === 0) firstLargeDropMs = now;
  } else {
    firstLargeDropMs = 0; // Recovered above threshold — reset timer
  }
  const persistentDropDurationMs = firstLargeDropMs > 0 ? now - firstLargeDropMs : 0;
  // M10: Re-verify dropPct at trigger time — token may have partially recovered since timer started
  const isTimeBased = firstLargeDropMs > 0 && persistentDropDurationMs >= persistentDropMs && dropPct >= persistentDropPct;

  // ── Determine cut reason (skip for fast-tracks) ──
  let cutReason = null;
  let evNegative = false;
  let mlFlipped = false;

  if (!isCrash && !isLateForceCut && !isTimeBased) {

    // ── Gate 7a: EV-NEGATIVE — model agrees position is losing ──
    // Binary option math: CUT when modelProb < tokenPrice × evBuffer
    // This means: even our model (which has 71% WR) says we have less chance
    // of winning than the current market price implies.
    const evBuffer = cfg.evBuffer ?? 0.95;
    // M2: Floor prevents EV check from becoming useless at very low token prices.
    // Without floor, a $0.05 token has threshold $0.045 — any model prob passes.
    const evThreshold = Math.max(currentTokenPrice * evBuffer, 0.25);
    if (modelProbability != null && Number.isFinite(modelProbability)) {
      if (modelProbability < evThreshold) {
        evNegative = true;
        cutReason = `ev_negative(model=${(modelProbability * 100).toFixed(0)}%<market=${(evThreshold * 100).toFixed(0)}%)`;
      }
    }

    // ── Gate 7b: ML FLIPPED — ML now predicts opposite side ──
    const mlFlipConf = cfg.mlFlipConfidence ?? 0.55;
    if (mlConfidence != null && mlConfidence >= mlFlipConf && mlSide != null && mlSide !== position.side) {
      mlFlipped = true;
      cutReason = cutReason
        ? `${cutReason}+ml_flipped(${mlSide}@${(mlConfidence * 100).toFixed(0)}%)`
        : `ml_flipped(${mlSide}@${(mlConfidence * 100).toFixed(0)}%)`;
    }

    // Must have at least one cut signal
    if (!evNegative && !mlFlipped) {
      return no(modelProbability != null
        ? `model_holds(prob=${(modelProbability * 100).toFixed(0)}%,threshold=${(currentTokenPrice * (cfg.evBuffer ?? 0.95) * 100).toFixed(0)}%)`
        : 'no_model_data');
    }

    // ── Gate 8: Minimum damage threshold ──
    if (dropPct < cfg.minTokenDropPct) {
      return no(`drop_${dropPct.toFixed(1)}%<${cfg.minTokenDropPct}%`);
    }
  }

  // ── Gate 9: Token price above minimum — HARD GATE ──
  if (currentTokenPrice < cfg.minTokenPrice) {
    return no(`price_${currentTokenPrice.toFixed(3)}<min_${cfg.minTokenPrice}`);
  }

  // ── Gate 10: Orderbook liquidity — HARD GATE ──
  if (orderbook) {
    const bidLiq = orderbook.bidLiquidity ?? 0;
    const spread = orderbook.spread ?? 0;
    if (bidLiq > 0 && bidLiq < cfg.minBidLiquidity) {
      return no(`thin_book_${bidLiq.toFixed(1)}<${cfg.minBidLiquidity}`);
    }
    if (spread > cfg.maxCutSpreadPct / 100) {
      return no(`wide_spread_${(spread * 100).toFixed(1)}%>${cfg.maxCutSpreadPct}%`);
    }
  }

  // ── Gate 11: Consecutive poll confirmation ──
  const requiredPolls = (isCrash || isLateForceCut || isTimeBased) ? 1 : cfg.consecutivePolls;
  consecutiveCutPolls++;
  if (consecutiveCutPolls < requiredPolls) {
    const tag = isCrash ? 'crash' : isLateForceCut ? 'late_force' : 'ev';
    return {
      shouldCut: false,
      reason: `${tag}_confirming_${consecutiveCutPolls}/${requiredPolls}`,
    };
  }

  // ═══ All gates passed — compute sell details ═══
  // Progressive slippage (attempt-based):
  //   Attempt 1: 1x base (2%)  |  Attempt 2: 2x (4%)
  //   Attempt 3: 3x (6%)       |  Attempt 4: 5x (10%)
  //   Attempt 5+: market order (bestBid - 3 cents)
  const rawSellPrice = (orderbook?.bestBid != null && orderbook.bestBid > 0)
    ? orderbook.bestBid
    : currentTokenPrice;

  const attempt = sellAttempts + 1;
  const baseSlippage = 0.02;
  let slippageMultiplier;
  if (attempt >= 5)      slippageMultiplier = null;
  else if (attempt === 4) slippageMultiplier = 5;
  else                    slippageMultiplier = attempt;

  let sellPrice;
  if (slippageMultiplier === null) {
    // H6: Proportional slippage instead of hardcoded $0.03.
    // $0.03 is 30% on a $0.10 token but only 3% on a $1.00 token.
    // 10% market slippage scales correctly across all price levels.
    sellPrice = Math.max(0.01, rawSellPrice * 0.90);
  } else {
    sellPrice = Math.max(0.01, rawSellPrice * (1 - baseSlippage * slippageMultiplier));
  }

  // H1: NaN guard — reject if sellPrice is corrupted (e.g. rawSellPrice was NaN from bad orderbook)
  if (!Number.isFinite(sellPrice) || sellPrice <= 0 || sellPrice > 0.99) {
    return no(`invalid_sell_price_${sellPrice}`);
  }

  const recoveryAmount = sellPrice * position.size;

  const reason = isCrash ? 'CRASH'
    : isLateForceCut ? 'LATE_FORCE_CUT'
    : isTimeBased ? `TIME_BASED(drop=${dropPct.toFixed(1)}%,${(persistentDropDurationMs / 60_000).toFixed(1)}min)`
    : cutReason ?? 'triggered';

  return {
    shouldCut: true,
    reason,
    sellPrice,
    dropPct,
    recoveryAmount,
    diagnostics: {
      btcDistPct,
      btcFavorable,
      modelProbability: modelProbability ?? null,
      evThreshold: currentTokenPrice * (cfg.evBuffer ?? 0.95),
      evNegative,
      mlFlipped,
      mlSide: mlSide ?? null,
      mlConfidence: mlConfidence ?? null,
      confirmCount: consecutiveCutPolls,
      regime,
      entryRegime: entryRegime ?? null,
      atrRatio: atrRatio ?? null,
      tokenSlope: getTokenPriceSlope(),
      isCrash,
      isLateForceCut,
      isTimeBased,
      persistentDropDurationMin: persistentDropDurationMs > 0 ? parseFloat((persistentDropDurationMs / 60_000).toFixed(1)) : null,
      sellAttempt: attempt,
      slippageMode: slippageMultiplier === null ? 'market' : `${slippageMultiplier}x`,
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
  firstLargeDropMs = 0;
  tokenPriceBuf.fill(0);
  tokenBufIdx = 0;
  tokenBufCount = 0;
}

/**
 * Record a sell attempt (increment counter + set timestamp).
 */
export function recordSellAttempt() {
  sellAttempts++;
  lastSellAttemptMs = Date.now();
}

/**
 * Reset consecutive confirmation counter after failed sell.
 * Preserves sellAttempts and lastSellAttemptMs for Gate 3/4.
 */
export function resetCutConfirm() {
  consecutiveCutPolls = 0;
}

/**
 * Get current sell attempt count (for progressive slippage logging).
 */
export function getSellAttempts() {
  return sellAttempts;
}

/**
 * Get cut-loss status for dashboard broadcast.
 * @param {Object|null} position - Current position
 * @param {number|null} currentTokenPrice - Live token price
 * @param {Object} [v2Context] - Additional context
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

  const { btcPrice, priceToBeat, modelProbability, mlConfidence, mlSide, regime, atrRatio, timeLeftMin } = v2Context;
  let btcDistPct = null;
  let btcFavorable = null;

  if (btcPrice != null && priceToBeat != null) {
    btcDistPct = Math.abs(((btcPrice - priceToBeat) / priceToBeat) * 100);
    btcFavorable = position.side === 'UP' ? btcPrice >= priceToBeat : btcPrice < priceToBeat;
  }

  const evBuffer = cfg.evBuffer ?? 0.95;
  const evThreshold = Math.max((currentTokenPrice ?? 0.5) * evBuffer, 0.25); // M2: match evaluator floor
  const evNegative = modelProbability != null && modelProbability < evThreshold;
  const mlFlipConf = cfg.mlFlipConfidence ?? 0.55;
  const mlFlipped = mlConfidence != null && mlConfidence >= mlFlipConf && mlSide != null && mlSide !== position.side;
  const tokenSlope = getTokenPriceSlope();

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
    // v6 EV-based fields
    btcDistPct,
    btcFavorable,
    modelProbability: modelProbability ?? null,
    evThreshold,
    evNegative,
    mlFlipped,
    confirmCount: consecutiveCutPolls,
    confirmNeeded: cfg.consecutivePolls,
    regime,
    atrRatio: atrRatio ?? null,
    tokenSlope,
    tokenRecovering: tokenSlope != null && tokenSlope > 0.03,
  };
}
