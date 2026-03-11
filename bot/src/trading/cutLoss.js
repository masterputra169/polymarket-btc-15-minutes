/**
 * Cut-loss (stop-loss) evaluator — v13 Recovery Gate for ALL paths (incl. fast-tracks).
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
 *   5.  Min hold time met (240s)
 *   6.  Not too close to settlement (< 30s)
 *
 * FAST TRACKS (skip to confirmation):
 *   6b. CRASH: drop >= crashDropPct AND BTC distance >= crashBtcDistPct
 *   6c. LATE FORCE-CUT: <2min left + drop >= 30%
 *
 * CUT DECISION (must pass ONE of):
 *   7a. EV-NEGATIVE: modelProb < tokenPrice × evBuffer (model agrees with market)
 *   7b. ML FLIPPED: ML now predicts opposite side with confidence >= mlFlipConf
 *
 * RECOVERY (applies to ALL paths except CRASH):
 *   6.5 Recovery gate: if token is rising >5¢/36s, hold (may self-correct)
 *
 * MINIMUM DAMAGE (normal path only):
 *   8.  Token drop >= minTokenDropPct (v12: 35% — data shows 25-35% zone is 83% FP)
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
let peakTokenPrice = 0;   // Fix 6: trailing stop — track peak price since entry
let lastCutUrgent = false; // v14: Track if last cut was urgent (crash/maxLoss) for faster retry cooldown

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
  // v14: Crash-aware cooldown — 1.5s retry during crash vs 5s normal.
  // After a failed urgent sell, we need to retry FAST before token drops further.
  const effectiveCooldown = lastCutUrgent ? (cfg.crashCooldownMs ?? 1500) : cfg.cooldownMs;
  if (lastSellAttemptMs > 0 && (now - lastSellAttemptMs) < effectiveCooldown) {
    return no(`cooldown_${lastCutUrgent ? 'crash' : 'normal'}`);
  }

  // Track peak token price (before Gate 5 for profit reversal hold bypass)
  if (currentTokenPrice != null && Number.isFinite(currentTokenPrice) && currentTokenPrice > peakTokenPrice) {
    peakTokenPrice = currentTokenPrice;
  }

  // Profit reversal detection: position peaked at 85¢+ then giving back 15%+ from peak.
  // Reduces min hold to 60s so trailing stop can fire early to protect gains.
  const PROFIT_PEAK_THRESHOLD = 0.85;
  const PROFIT_REVERSAL_DRAWDOWN = 15; // 15% drawdown from peak triggers hold bypass
  const profitPeakDrawdown = (peakTokenPrice >= PROFIT_PEAK_THRESHOLD && currentTokenPrice != null && Number.isFinite(currentTokenPrice))
    ? ((peakTokenPrice - currentTokenPrice) / peakTokenPrice) * 100 : 0;
  const profitReversalActive = peakTokenPrice >= PROFIT_PEAK_THRESHOLD && profitPeakDrawdown >= PROFIT_REVERSAL_DRAWDOWN;

  // ── Gate 5: Min hold time met? ──
  const holdSec = (now - position.enteredAt) / 1000;
  // v8: If token is in a steep crash (slope strongly negative) + severe drop + BTC confirms, reduce hold to 60s.
  // H1 audit fix: Raised from 8%→15% and 45s→60s. At 50ms poll, 45s is too aggressive — flash crashes bounce.
  // Also requires BTC unfavorable confirmation to avoid cutting on volatility-only dips.
  const slope = getTokenPriceSlope();
  const isSteeplyFalling = slope !== null && slope < -0.10; // dropping > 10 cents in last 36s
  const earlyDropPct = currentTokenPrice != null && position.price > 0
    ? ((position.price - currentTokenPrice) / position.price) * 100 : 0;
  const hasPtbEarly = btcPrice != null && priceToBeat != null &&
    Number.isFinite(btcPrice) && Number.isFinite(priceToBeat) && priceToBeat > 0;
  const btcConfirmsEarly = hasPtbEarly && (position.side === 'UP' ? btcPrice < priceToBeat : btcPrice >= priceToBeat);
  const steepFallHold = (isSteeplyFalling && earlyDropPct >= 15 && btcConfirmsEarly) ? Math.min(60, cfg.minHoldSec) : cfg.minHoldSec;
  // Profit reversal: peak ≥85¢ + drawdown ≥15% → allow early exit (60s hold) to protect gains
  const minHoldRequired = profitReversalActive ? Math.min(60, steepFallHold) : steepFallHold;
  if (holdSec < minHoldRequired) return no(`hold_${Math.round(holdSec)}s/${minHoldRequired}s`);

  // ── Gate 6: Not too close to settlement? ──
  if (timeLeftMin != null && timeLeftMin < 0.5) return no('near_settlement');

  // ── Shared computations ──
  if (currentTokenPrice == null || !Number.isFinite(currentTokenPrice)) return no('no_price');
  const entryPrice = position.price;
  if (entryPrice < 0.01) return no('bad_entry_price'); // M3: min Polymarket token price is $0.01

  recordTokenPrice(currentTokenPrice);
  // peakTokenPrice already updated above Gate 5 for profit reversal hold bypass

  const dropPct = ((entryPrice - currentTokenPrice) / entryPrice) * 100;
  const hasPtb = btcPrice != null && priceToBeat != null &&
    Number.isFinite(btcPrice) && Number.isFinite(priceToBeat) && priceToBeat > 0;

  // Fix 1: Volatility scaling — high vol widens thresholds (noise), low vol tightens
  const volScale = (atrRatio != null && Number.isFinite(atrRatio) && atrRatio > 0)
    ? Math.max(0.7, Math.min(1.5, atrRatio))
    : 1.0;

  let btcDistPct = null;
  let btcFavorable = null;
  if (hasPtb) {
    const rawDistPct = ((btcPrice - priceToBeat) / priceToBeat) * 100;
    btcFavorable = position.side === 'UP' ? btcPrice >= priceToBeat : btcPrice < priceToBeat;
    btcDistPct = Math.abs(rawDistPct);
  }

  // ── Gate 6b: CRASH fast-track ──
  const crashDrop = (cfg.crashDropPct ?? 30) * volScale;  // Fix 1: vol-scaled
  const crashDist = cfg.crashBtcDistPct ?? 0.20;
  // H10: OR logic — 30%+ token drop is a crash even without BTC data.
  // BTC distance OR BTC unfavorable confirms, but lack of PTB data shouldn't block crash detection.
  const isCrash = dropPct >= crashDrop && (!hasPtb || btcDistPct >= crashDist || !btcFavorable);

  // ── Gate 6c: LATE FORCE-CUT fast-track ──
  // v11→v15: Tightened from (1.5min + 30%) → (1.0min + 40%).
  // Settlement WR 87.5% beats cut-loss 23.3% — only force cut in truly catastrophic scenarios.
  // At <1 min left with 40%+ drop, recovery is statistically impossible.
  const LATE_FORCE_CUT_MIN = 0.5;   // v16: only last 30s
  const LATE_FORCE_CUT_DROP = 70;   // v16: 70% drop required
  const isLateForceCut = timeLeftMin != null && timeLeftMin < LATE_FORCE_CUT_MIN && dropPct >= LATE_FORCE_CUT_DROP;

  // ── Gate 6d: TIME-BASED PERSISTENT LOSS fast-track (Fix D) ──
  // If token has been down >= persistentDropPct% continuously for >= persistentDropMinutes,
  // cut without waiting for model agreement (skip gates 7a/7b).
  // Prevents holding a deeply losing position indefinitely while model is slow to flip.
  const persistentDropPct = (cfg.persistentDropPct ?? 20) * volScale;  // Fix 1: vol-scaled
  const persistentDropMs = (cfg.persistentDropMinutes ?? 5) * 60_000;
  // Fix 4: Cap persistent wait at 50% of remaining time (never wait longer than half the market)
  const maxPersistentMs = (timeLeftMin != null && Number.isFinite(timeLeftMin))
    ? Math.max(60_000, timeLeftMin * 60_000 * 0.5)
    : persistentDropMs;
  const effectivePersistentMs = Math.min(persistentDropMs, maxPersistentMs);
  if (dropPct >= persistentDropPct) {
    if (firstLargeDropMs === 0) firstLargeDropMs = now;
  } else {
    firstLargeDropMs = 0; // Recovered above threshold — reset timer
  }
  const persistentDropDurationMs = firstLargeDropMs > 0 ? now - firstLargeDropMs : 0;
  // M10: Re-verify dropPct at trigger time — token may have partially recovered since timer started
  const isTimeBased = firstLargeDropMs > 0 && persistentDropDurationMs >= effectivePersistentMs && dropPct >= persistentDropPct;

  // ── Gate 6e: DOLLAR-BASED MAX LOSS fast-track ──
  // Force cut when position has lost ≥75% of invested capital, regardless of model.
  const maxLossOfCostPct = cfg.maxLossOfCostPct ?? 75;
  const currentValue = currentTokenPrice * (position.size ?? 0);
  const costLossPct = (position.cost > 0) ? ((position.cost - currentValue) / position.cost) * 100 : 0;
  const isMaxLoss = position.cost > 0 && costLossPct >= maxLossOfCostPct;

  // ── Gate 6f: TRAILING STOP fast-track — protect unrealized gains from complete reversal ──
  const trailingActivation = cfg.trailingStopActivationPct ?? 15; // need 15%+ gain first
  const baseTrailingDrop = cfg.trailingStopDropPct ?? 50;         // normal: 50% give-back
  const gainFromEntry = entryPrice > 0 ? ((peakTokenPrice - entryPrice) / entryPrice) * 100 : 0;
  const peakDrawdown = peakTokenPrice > 0 ? ((peakTokenPrice - currentTokenPrice) / peakTokenPrice) * 100 : 0;
  // High-peak profit protection: when peak >= 85¢, tighten drawdown threshold.
  // With BTC reversal confirmed: 20% give-back. Without BTC confirm: 40%. Normal: 50%.
  // v15 fix: When BTC is favorable (our side winning), require BOTH highPeak AND model < 0.60.
  // Previous bug: highPeak alone skipped model check → cut winning positions on token noise.
  // Token prices on Polymarket 15m are noisy — 89¢→60¢ swings happen even when BTC is winning.
  const highPeak = peakTokenPrice >= PROFIT_PEAK_THRESHOLD;
  const btcConfirmsReversal = hasPtb && btcFavorable === false;
  const effectiveTrailingDrop = (highPeak && btcConfirmsReversal) ? 20 : highPeak ? 40 : baseTrailingDrop;
  // v15: Only bypass model check when BTC confirms reversal (unfavorable).
  // When BTC is still favorable, always require model agreement (prob < 0.60).
  const trailingModelBypass = highPeak && btcConfirmsReversal;
  const isTrailingStop = gainFromEntry >= trailingActivation && peakDrawdown >= effectiveTrailingDrop
    && (trailingModelBypass || modelProbability == null || modelProbability < 0.60);

  // v14: Urgency flag — crash/maxLoss/lateForceCut/timeBased need faster slippage + retry
  const isUrgent = isCrash || isMaxLoss || isLateForceCut || isTimeBased;

  // ── Gate 6.5: Recovery gate (applies to ALL paths including fast-tracks) ──
  // If token is actively bouncing back, don't cut at the bottom — let it recover.
  // Only CRASH bypasses this (true crash = no bounce expected).
  const RECOVERY_SLOPE_THRESHOLD = 0.05; // +5 cents in 36s = meaningful recovery
  if (!isCrash && slope !== null && slope > RECOVERY_SLOPE_THRESHOLD) {
    consecutiveCutPolls = 0; // reset confirmation — re-evaluate next poll
    return no(`recovering(slope=+${slope.toFixed(3)})`);
  }

  // ── Determine cut reason (skip for fast-tracks) ──
  let cutReason = null;
  let evNegative = false;
  let mlFlipped = false;

  // H4 audit fix: Compute evThreshold outside the fast-track block so diagnostics can reuse it.
  // Previously, diagnostics used a different default (0.85) and missed regime adjustment.
  const evBuffer = cfg.evBuffer ?? 0.80;
  let computedEvThreshold = Math.max(entryPrice * evBuffer, 0.40);
  if (regime === 'trending') {
    computedEvThreshold *= 0.92; // ~8% more lenient → holds profitable trending positions longer
  } else if (regime === 'choppy') {
    computedEvThreshold *= 1.08; // ~8% stricter → faster exit in whipsaw conditions
  }

  // Fix 3: Time decay — binary options have extreme theta near expiry.
  // Model must be MORE supportive near expiry to justify holding.
  let timeDecayScale = 1.0;
  if (timeLeftMin != null && Number.isFinite(timeLeftMin)) {
    if (timeLeftMin < 2)       timeDecayScale = 1.15;  // VERY_LATE: 15% stricter
    else if (timeLeftMin < 5)  timeDecayScale = 1.10;  // LATE: 10% stricter
    else if (timeLeftMin < 10) timeDecayScale = 1.05;  // MID: 5% stricter
  }
  computedEvThreshold *= timeDecayScale;

  let dropTier = null; // v14: signal-strength tier (set in normal path, null for fast-tracks)

  if (!isCrash && !isLateForceCut && !isTimeBased && !isMaxLoss && !isTrailingStop) {

    // ── Gate 7a: EV-NEGATIVE — model agrees position is losing ──
    // C2: Uniform 80% threshold with 0.40 floor — cheap tokens no longer cut at 25% (too loose)
    // M22: Regime-aware EV threshold — relax in trending (model stronger), tighten in choppy (noisy)
    if (modelProbability != null && Number.isFinite(modelProbability)) {
      if (modelProbability < computedEvThreshold) {
        evNegative = true;
        cutReason = `ev_negative(model=${(modelProbability * 100).toFixed(0)}%<market=${(computedEvThreshold * 100).toFixed(0)}%)`;
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
        ? `model_holds(prob=${(modelProbability * 100).toFixed(0)}%,threshold=${(computedEvThreshold * 100).toFixed(0)}%)`
        : 'no_model_data');
    }

    // ── Gate 8: Minimum damage threshold (signal-strength-tiered, vol-scaled) ──
    // v14: Stronger evidence → cut at lower drop. Both signals agreeing = high confidence in loss.
    // Double-confirmed (EV-neg + ML-flip): 50% of threshold (e.g., 40% × 0.50 = 20% drop)
    // Single signal: 70% of threshold (e.g., 40% × 0.70 = 28% drop)
    // BTC momentum amplifier: fast unfavorable BTC movement lowers threshold further.
    dropTier = 1.0;
    if (evNegative && mlFlipped) dropTier = 0.50;       // both signals → 50% of threshold
    else if (evNegative || mlFlipped) dropTier = 0.70;   // one signal → 70%
    if (btcDelta1m != null && Number.isFinite(btcDelta1m) && btcFavorable === false) {
      if (Math.abs(btcDelta1m) > 50) dropTier *= 0.85;  // BTC >$50/min against → 15% lower
    }
    const scaledMinDrop = cfg.minTokenDropPct * volScale * dropTier;
    if (dropPct < scaledMinDrop) {
      return no(`drop_${dropPct.toFixed(1)}%<${scaledMinDrop.toFixed(1)}%`);
    }

    // Gate 8b (recovery) now handled above Gate 6.5 for ALL paths including fast-tracks.
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
  const requiredPolls = (isCrash || isLateForceCut || isTimeBased || isMaxLoss || isTrailingStop) ? 1 : cfg.consecutivePolls;
  consecutiveCutPolls++;
  if (consecutiveCutPolls < requiredPolls) {
    const tag = isCrash ? 'crash' : isLateForceCut ? 'late_force' : isMaxLoss ? 'max_loss' : isTrailingStop ? 'trailing_stop' : 'ev';
    return {
      shouldCut: false,
      reason: `${tag}_confirming_${consecutiveCutPolls}/${requiredPolls}`,
    };
  }

  // ═══ All gates passed — compute sell details ═══
  // v14: Progressive slippage (attempt-based, urgency-aware):
  // URGENT (crash/maxLoss/lateForceCut/timeBased): 5%, 10%, market — fill ASAP, 3 attempts max
  // NORMAL: 2%, 4%, 6%, 10%, market — gradual 5-attempt escalation
  // Key fix: old 2% initial slippage was too tight for crash — FOK failed, token dropped further
  const rawSellPrice = (orderbook?.bestBid != null && orderbook.bestBid > 0)
    ? orderbook.bestBid
    : currentTokenPrice;

  const attempt = sellAttempts + 1;
  const baseSlippage = isUrgent ? 0.05 : 0.02;
  let slippageMultiplier;
  if (isUrgent) {
    // Urgent: 5%, 10%, market (3 attempts max before market order)
    if (attempt >= 3)      slippageMultiplier = null;
    else if (attempt === 2) slippageMultiplier = 2;
    else                    slippageMultiplier = 1;
  } else {
    // Normal: 2%, 4%, 6%, 10%, market
    if (attempt >= 5)      slippageMultiplier = null;
    else if (attempt === 4) slippageMultiplier = 5;
    else                    slippageMultiplier = attempt;
  }

  let sellPrice;
  if (slippageMultiplier === null) {
    // Market order: 15% slippage for guaranteed fill (was 10% — still failed in thin crash books)
    sellPrice = Math.max(0.01, rawSellPrice * 0.85);
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
    : isMaxLoss ? `MAX_LOSS(cost_loss=${costLossPct.toFixed(1)}%)`
    : isTrailingStop ? `TRAILING_STOP(peak=${(peakTokenPrice * 100).toFixed(0)}¢,gain=${gainFromEntry.toFixed(1)}%,drawdown=${peakDrawdown.toFixed(1)}%/${effectiveTrailingDrop}%)`
    : isTimeBased ? `TIME_BASED(drop=${dropPct.toFixed(1)}%,${(persistentDropDurationMs / 60_000).toFixed(1)}min)`
    : cutReason ?? 'triggered';

  lastCutUrgent = isUrgent;

  return {
    shouldCut: true,
    reason,
    sellPrice,
    dropPct,
    recoveryAmount,
    urgency: isUrgent ? 'crash' : 'normal',
    diagnostics: {
      btcDistPct,
      btcFavorable,
      modelProbability: modelProbability ?? null,
      evThreshold: computedEvThreshold,
      evNegative,
      mlFlipped,
      mlSide: mlSide ?? null,
      mlConfidence: mlConfidence ?? null,
      confirmCount: consecutiveCutPolls,
      regime,
      entryRegime: entryRegime ?? null,
      atrRatio: atrRatio ?? null,
      volScale,
      tokenSlope: getTokenPriceSlope(),
      isCrash,
      isLateForceCut,
      isTimeBased,
      isMaxLoss,
      isTrailingStop,
      profitReversalActive,
      highPeak,
      profitPeakDrawdown: parseFloat(profitPeakDrawdown.toFixed(1)),
      costLossPct: position.cost > 0 ? parseFloat(costLossPct.toFixed(1)) : null,
      timeDecayScale,
      gainFromEntry: parseFloat(gainFromEntry.toFixed(1)),
      peakDrawdown: parseFloat(peakDrawdown.toFixed(1)),
      persistentDropDurationMin: persistentDropDurationMs > 0 ? parseFloat((persistentDropDurationMs / 60_000).toFixed(1)) : null,
      sellAttempt: attempt,
      slippageMode: slippageMultiplier === null ? 'market' : `${slippageMultiplier}x`,
      isUrgent,
      dropTier,
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
  peakTokenPrice = 0;
  lastCutUrgent = false;
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

  const statusEvBuffer = cfg.evBuffer ?? 0.80;
  let evThreshold = Math.max((position?.price ?? currentTokenPrice ?? 0.5) * statusEvBuffer, 0.40); // C2: uniform 80% with 0.40 floor
  // H4 audit fix: include regime adjustment in dashboard status (matches evaluateCutLoss)
  if (regime === 'trending') evThreshold *= 0.92;
  else if (regime === 'choppy') evThreshold *= 1.08;
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
