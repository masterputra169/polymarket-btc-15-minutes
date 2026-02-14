/**
 * Cut-loss (stop-loss) evaluator — v3 Smart Cut-Loss.
 *
 * v3 changes over v2.1:
 *   - Removed partial cuts (always full exit — binary options are all-or-nothing)
 *   - ATR-scaled momentum threshold (Gate 9) replaces fixed $5/min
 *   - Time-decay EV multiplier (Gate 10) — holding value decreases as time expires
 *   - Regime-change detection (Gate 8b) — lowers threshold if regime changed since entry
 *   - Expanded token trajectory buffer (12 polls) + higher recovery magnitude (2 cent)
 *   - minTokenDropPct raised 15% → 25%
 *
 * Gate chain (all must pass for shouldCut = true):
 *   1.  Feature enabled
 *   2.  Has open, fill-confirmed position
 *   3.  Max attempts not exceeded
 *   4.  Cooldown elapsed since last failed sell
 *   5.  Min hold time met (60s)
 *   6.  Not too close to settlement (< 30s)
 *   7.  BTC position check — if BTC is on our side of PTB, never cut
 *   8.  BTC-to-PTB distance — time-scaled, ATR-adjusted, regime-aware
 *   8b. Regime-change accelerator — if regime changed since entry, lower threshold 30%
 *   9.  BTC momentum — ATR-scaled, if BTC is recovering toward PTB, skip cut
 *  10.  EV comparison — regime-aware margin + time-decay multiplier
 *  11.  ML veto — if ML confidence >= 55% and agrees with position, block cut
 *  12.  Token drop minimum — token must have dropped at least 25%
 *  12b. Token price above minimum ($0.05)
 *  12c. Orderbook liquidity — don't sell into thin books or wide spreads
 *  12d. Token trajectory — if token is recovering (>2¢ over 12 polls), skip cut
 *  13.  Consecutive poll confirmation — 3 consecutive polls where all gates pass
 */

import { BOT_CONFIG } from '../config.js';

// ── Module state (reset on settlement / market switch) ──
let sellAttempts = 0;
let lastSellAttemptMs = 0;
let consecutiveCutPolls = 0;

// Token price ring buffer (for trajectory tracking)
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
  if (tokenBufCount < 4) return null; // Need at least 4 samples (~12s)
  const newest = tokenPriceBuf[(tokenBufIdx - 1 + TOKEN_BUF_SIZE) % TOKEN_BUF_SIZE];
  const oldest = tokenPriceBuf[(tokenBufIdx - tokenBufCount + TOKEN_BUF_SIZE) % TOKEN_BUF_SIZE];
  return newest - oldest; // positive = recovering, negative = still falling
}

/**
 * Time-scaled BTC-to-PTB distance thresholds.
 * Scaled by ATR ratio and regime.
 */
function getBtcDistThreshold(timeLeftMin, atrRatio, regime) {
  // Base threshold: time-scaled
  let base;
  if (timeLeftMin == null) base = 0.05;
  else if (timeLeftMin > 10) base = 0.10;
  else if (timeLeftMin > 5)  base = 0.07;
  else if (timeLeftMin > 2)  base = 0.05;
  else base = 0.03;

  // ATR scaling — high vol = wider threshold (more patient, BTC can recover)
  const volScale = Math.max(0.5, Math.min(2.0, atrRatio ?? 1.0));

  // Regime scaling — trending cuts sooner, choppy holds longer
  const regimeScale = regime === 'trending' ? 0.8
    : regime === 'choppy' ? 1.3
    : regime === 'mean_reverting' ? 1.2
    : 1.0;

  return base * volScale * regimeScale;
}

/**
 * Regime-aware EV margin for Gate 10.
 * Trending: tighter margin (0.85) — if losing in trend, cut faster.
 * Choppy: wider margin (0.95) — expect reversals, hold longer.
 */
function getEvMargin(regime) {
  if (regime === 'trending') return 0.85;
  if (regime === 'choppy') return 0.95;
  if (regime === 'mean_reverting') return 0.93;
  return 0.90;
}

/**
 * Time-decay multiplier for EV comparison (Gate 10).
 * Early in market: holding has higher "option value" (time to recover).
 * Late in market: option value drops — if losing, it's likely staying that way.
 */
function getTimeDecay(timeLeftMin) {
  if (timeLeftMin == null) return 1.0;
  if (timeLeftMin > 8)  return 1.15; // early: holding has bonus value
  if (timeLeftMin > 4)  return 1.05; // mid: slight bonus
  if (timeLeftMin > 2)  return 1.00; // late: no bonus
  return 0.90;                       // very late: penalty (less time to recover)
}

/**
 * ATR-scaled momentum threshold for Gate 9.
 * High volatility = higher threshold (BTC normally moves more, don't veto easily).
 * Low volatility = lower threshold (even small recovery is meaningful).
 */
function getMomentumThreshold(atrRatio) {
  return Math.max(10, (atrRatio ?? 1.0) * 15);
}

/**
 * Evaluate whether the current position should be cut.
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

  // Record token price for trajectory tracking
  recordTokenPrice(currentTokenPrice);

  const dropPct = ((entryPrice - currentTokenPrice) / entryPrice) * 100;
  const hasPtb = btcPrice != null && priceToBeat != null && Number.isFinite(btcPrice) && Number.isFinite(priceToBeat) && priceToBeat > 0;

  // BTC distance from PTB
  let btcDistPct = null;
  let btcFavorable = null;
  if (hasPtb) {
    const rawDistPct = ((btcPrice - priceToBeat) / priceToBeat) * 100;
    btcFavorable = position.side === 'UP' ? btcPrice >= priceToBeat : btcPrice < priceToBeat;
    btcDistPct = Math.abs(rawDistPct);
  }

  // ── Gate 7: BTC position check ──
  if (hasPtb && btcFavorable) {
    return no(`btc_favorable_${btcDistPct.toFixed(3)}%`);
  }

  // ── Gate 8: BTC-to-PTB distance (ATR + regime adjusted) ──
  let regimeChanged = false;
  if (hasPtb) {
    let threshold = getBtcDistThreshold(timeLeftMin, atrRatio, regime);

    // ── Gate 8b: Regime-change accelerator ──
    // If regime changed since entry AND BTC is on wrong side, lower threshold 30%.
    // Regime change invalidates the original entry signal.
    if (entryRegime && entryRegime !== regime && !btcFavorable) {
      threshold *= 0.7;
      regimeChanged = true;
    }

    if (btcDistPct < threshold) {
      return no(`btc_close_${btcDistPct.toFixed(3)}%<${threshold.toFixed(3)}%${regimeChanged ? '_regime_chg' : ''}`);
    }
  }

  // ── Gate 9: BTC momentum (ATR-scaled) ──
  if (hasPtb && btcDelta1m != null && Number.isFinite(btcDelta1m)) {
    const movingTowardPtb = position.side === 'UP'
      ? btcDelta1m > 0
      : btcDelta1m < 0;
    const momentumThreshold = getMomentumThreshold(atrRatio);
    if (movingTowardPtb && Math.abs(btcDelta1m) > momentumThreshold) {
      return no(`btc_recovering_$${btcDelta1m.toFixed(1)}/min>$${momentumThreshold.toFixed(0)}`);
    }
  }

  // ── Gate 10: EV comparison (regime-aware margin + time-decay) ──
  const evMargin = getEvMargin(regime);
  const timeDecay = getTimeDecay(timeLeftMin);
  let evHold = null;
  let evCut = currentTokenPrice;
  if (modelProbability != null && Number.isFinite(modelProbability)) {
    evHold = modelProbability * timeDecay;
    if (evHold >= evCut * evMargin) {
      return no(`ev_hold_${(evHold * 100).toFixed(1)}%>=cut_${(evCut * 100).toFixed(1)}%×${evMargin}×t${timeDecay}`);
    }
  }

  // ── Gate 11: ML veto ──
  if (mlConfidence != null && mlConfidence >= 0.55 && mlSide === position.side) {
    return no(`ml_veto_${(mlConfidence * 100).toFixed(0)}%_${mlSide}`);
  }

  // ── Gate 12: Token drop minimum ──
  if (dropPct < cfg.minTokenDropPct) {
    return no(`drop_${dropPct.toFixed(1)}%<${cfg.minTokenDropPct}%`);
  }

  // ── Gate 12b: Token price above minimum? ──
  if (currentTokenPrice < cfg.minTokenPrice) {
    return no(`price_${currentTokenPrice.toFixed(3)}<min_${cfg.minTokenPrice}`);
  }

  // ── Emergency fast-track: genuine crash detection ──
  // If token dropped hard AND BTC is far from PTB, skip slow gates (12c/12d/13)
  // and force immediate full cut. In a real crash, liquidity evaporates.
  const crashDrop = cfg.crashDropPct ?? 40;
  const crashDist = cfg.crashBtcDistPct ?? 0.20;
  const isCrash = dropPct >= crashDrop && hasPtb && btcDistPct >= crashDist;

  let tokenSlope = null;

  if (!isCrash) {
    // ── Gate 12c: Orderbook liquidity ──
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

    // ── Gate 12d: Token price trajectory ──
    // Require >2¢ recovery over 12 polls (~36s) to veto cut.
    // Smaller bounces (noise) don't block the cut.
    tokenSlope = getTokenPriceSlope();
    if (tokenSlope != null && tokenSlope > 0.02) {
      return no(`token_recovering_+${(tokenSlope * 100).toFixed(1)}¢`);
    }
  }

  // ── Gate 13: Consecutive poll confirmation ──
  // Crash: only 1 poll needed. Normal: full consecutivePolls (3).
  const requiredPolls = isCrash ? 1 : cfg.consecutivePolls;
  consecutiveCutPolls++;
  if (consecutiveCutPolls < requiredPolls) {
    return {
      shouldCut: false,
      reason: isCrash
        ? `crash_confirming_${consecutiveCutPolls}/${requiredPolls}`
        : `confirming_${consecutiveCutPolls}/${cfg.consecutivePolls}`,
    };
  }

  // ═══ All gates passed — compute sell details ═══
  const sellPrice = (orderbook?.bestBid != null && orderbook.bestBid > 0)
    ? orderbook.bestBid
    : currentTokenPrice;

  // v3: Always full cut (binary options are all-or-nothing)
  const recoveryAmount = sellPrice * position.size;

  return {
    shouldCut: true,
    reason: isCrash ? 'CRASH' : 'triggered',
    sellPrice,
    dropPct,
    recoveryAmount,
    diagnostics: {
      btcDistPct,
      btcFavorable,
      evHold,
      evCut,
      evMargin,
      timeDecay,
      confirmCount: consecutiveCutPolls,
      regime,
      entryRegime: entryRegime ?? null,
      regimeChanged,
      atrRatio: atrRatio ?? null,
      tokenSlope,
      isCrash,
      momentumThreshold: getMomentumThreshold(atrRatio),
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
  // Reset token trajectory buffer
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
  let evHold = null;
  let evCut = currentTokenPrice;

  if (btcPrice != null && priceToBeat != null) {
    btcDistPct = Math.abs(((btcPrice - priceToBeat) / priceToBeat) * 100);
    btcFavorable = position.side === 'UP' ? btcPrice >= priceToBeat : btcPrice < priceToBeat;
  }
  if (modelProbability != null) {
    evHold = modelProbability * getTimeDecay(timeLeftMin);
  }

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
    // Smart gate fields
    btcDistPct,
    btcFavorable,
    evHold,
    evCut,
    evMargin: getEvMargin(regime),
    timeDecay: getTimeDecay(timeLeftMin),
    confirmCount: consecutiveCutPolls,
    confirmNeeded: cfg.consecutivePolls,
    mlVeto: mlConfidence != null && mlConfidence >= 0.55 && mlSide === position.side,
    regime,
    atrRatio: atrRatio ?? null,
    tokenSlope,
    tokenRecovering: tokenSlope != null && tokenSlope > 0.02,
    momentumThreshold: getMomentumThreshold(atrRatio),
  };
}
