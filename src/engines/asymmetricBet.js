import { BET_SIZING, EXECUTION } from '../config.js';
import { computeKellyTune } from './feedback/stats.js';

const {
  KELLY_FRACTION,
  MAX_BET_PCT,
  MIN_BET_PCT,
  MIN_EDGE_FOR_BET,
} = BET_SIZING;

// Regime multipliers (scaled by regime confidence)
const REGIME_MULT = {
  trending:       1.00,
  moderate:       0.85,
  mean_reverting: 0.70,
  choppy:         0.50,
};

// Accuracy multipliers
function accuracyMultiplier(accuracy) {
  if (accuracy == null) return { multiplier: 1.0, label: 'N/A' };
  if (accuracy > 0.70) return { multiplier: 1.15, label: `Hot (${(accuracy * 100).toFixed(0)}%)` };
  if (accuracy > 0.55) return { multiplier: 1.05, label: `Good (${(accuracy * 100).toFixed(0)}%)` };
  if (accuracy < 0.35) return { multiplier: 0.50, label: `Cold (${(accuracy * 100).toFixed(0)}%)` };
  return { multiplier: 1.0, label: `Avg (${(accuracy * 100).toFixed(0)}%)` };
}

// ML multiplier — high-conf agree boosts, disagree dampens
function mlMultiplier(ml, side) {
  if (!ml || ml.status !== 'ready' || ml.confidence == null) {
    return { multiplier: 1.0, label: 'N/A' };
  }
  const hiConf = ml.confidence >= 0.40;
  const agrees = ml.side === side;
  if (hiConf && agrees) return { multiplier: 1.15, label: 'Hi-Conf \u2713' };
  if (hiConf && !agrees) return { multiplier: 0.70, label: 'Hi-Conf \u2717' };
  return { multiplier: 1.0, label: `${(ml.confidence * 100).toFixed(0)}%` };
}

// Execution-risk multiplier (from Math Part 2.5: Kelly with execution risk)
// Accounts for spread cost, liquidity depth, and fill reliability
function executionMultiplier(ctx) {
  if (!ctx) return { multiplier: 1.0, label: 'N/A' };

  // Spread factor: tight=1.0, normal=0.85, wide=0.75, very wide=0.60
  let spreadMult = 1.0;
  const spread = ctx.spread ?? 0;
  if (spread >= EXECUTION.SPREAD_WIDE) spreadMult = 0.60;
  else if (spread >= EXECUTION.SPREAD_NORMAL) spreadMult = 0.75;
  else if (spread >= EXECUTION.SPREAD_TIGHT) spreadMult = 0.85;

  // Liquidity factor: based on ask-side depth (what we'd buy into)
  // depth=0 or null means empty/unknown orderbook → heavy penalty
  let liqMult = 1.0;
  const depth = ctx.askLiquidity ?? 0;
  if (depth <= 0) liqMult = 0.30;
  else if (depth < EXECUTION.LIQ_VERY_THIN) liqMult = 0.50;
  else if (depth < EXECUTION.LIQ_THIN) liqMult = 0.70;
  else if (depth < EXECUTION.LIQ_MODERATE) liqMult = 0.85;

  // Fill rate factor (from fill tracker history)
  let fillMult = 1.0;
  if (ctx.fillRate != null && ctx.fillRate < EXECUTION.FILL_POOR_RATE) fillMult = 0.70;

  const multiplier = Math.round(spreadMult * liqMult * fillMult * 100) / 100;
  const label = `Spr:${spreadMult} Liq:${liqMult} Fill:${fillMult}`;
  return { multiplier, label };
}

// Confidence tier multiplier
const CONF_MULT = {
  VERY_HIGH: 1.00,
  HIGH:      0.80,
  MEDIUM:    0.55,
  LOW:       0.30,
};

function riskLevel(pct) {
  if (pct <= 0) return 'NO_BET';
  if (pct < 0.02) return 'CONSERVATIVE';
  if (pct < 0.05) return 'MODERATE';
  return 'AGGRESSIVE';
}

export function computeBetSizing({
  action, side, ensembleProb, marketPrice, edge,
  confidence, regimeInfo, feedbackStats, ml, bankroll,
  executionContext,
}) {
  const noBet = {
    shouldBet: false, side: null,
    rawKelly: 0, kellyFraction: KELLY_FRACTION, adjustedFraction: 0,
    betPercent: 0, betAmount: 0, bankroll: bankroll ?? 0,
    riskLevel: 'NO_BET',
    regimeAdj: { multiplier: 1.0, label: '-' },
    accuracyAdj: { multiplier: 1.0, label: '-' },
    mlAdj: { multiplier: 1.0, label: '-' },
    confidenceAdj: { multiplier: 1.0, label: '-' },
    executionAdj: { multiplier: 1.0, label: '-' },
    expectedValue: 0,
    rationale: '',
  };

  // Gate 1: must be ENTER
  if (action !== 'ENTER') {
    noBet.rationale = 'No trade signal (WAIT)';
    return noBet;
  }

  // Gate 2: valid inputs (reject NaN, non-finite, out-of-range)
  if (!side || !Number.isFinite(ensembleProb) || !Number.isFinite(marketPrice) ||
      marketPrice <= 0.01 || marketPrice >= 0.99 ||
      ensembleProb < 0 || ensembleProb > 1) {
    noBet.rationale = 'Invalid price or probability data';
    return noBet;
  }

  // Gate 3: minimum edge
  const absEdge = Math.abs(edge ?? 0);
  if (absEdge < MIN_EDGE_FOR_BET) {
    noBet.rationale = `Edge ${(absEdge * 100).toFixed(1)}% < minimum ${(MIN_EDGE_FOR_BET * 100).toFixed(0)}%`;
    return noBet;
  }

  // ── Kelly Criterion ──
  const b = (1 / marketPrice) - 1;    // decimal odds payout ratio
  const p = ensembleProb;              // model probability of winning
  const q = 1 - p;
  const rawKelly = (b * p - q) / b;

  if (!Number.isFinite(rawKelly) || rawKelly <= 0) {
    noBet.rationale = `Negative Kelly (${Number.isFinite(rawKelly) ? (rawKelly * 100).toFixed(1) : 'NaN'}%) \u2014 no edge`;
    return noBet;
  }

  // Dynamic Kelly fraction from calibration data
  const kellyTune = computeKellyTune(KELLY_FRACTION);
  const effectiveKelly = kellyTune.kellyFraction;

  // Fractional Kelly (rawKelly is mathematically bounded by p ≤ 1.0, no cap needed)
  let frac = rawKelly * effectiveKelly;

  // ── Multipliers ──

  // Regime
  const regime = regimeInfo?.regime ?? 'moderate';
  const regimeConf = regimeInfo?.confidence ?? 0.5;
  const baseRegimeMult = REGIME_MULT[regime] ?? 0.85;
  // Scale toward 1.0 when regime confidence is low
  const regimeMult = 1.0 + (baseRegimeMult - 1.0) * regimeConf;
  const regimeAdj = {
    multiplier: Math.round(regimeMult * 100) / 100,
    label: `${regime} (${(regimeConf * 100).toFixed(0)}%)`,
  };

  // Accuracy — dampen when kellyTune is active to avoid double-counting
  // (both react to the same signal: model miscalibration)
  const accRaw = feedbackStats?.accuracy ?? null;
  const accuracyAdj = accuracyMultiplier(accRaw);
  const kellyTuneActive = kellyTune.reason !== 'insufficient_data' && kellyTune.reason !== 'sparse_buckets';
  if (kellyTuneActive && accuracyAdj.multiplier !== 1.0) {
    // Halve the accuracy deviation from 1.0: e.g. 0.50 → 0.75, 1.15 → 1.075
    accuracyAdj.multiplier = Math.round((1.0 + (accuracyAdj.multiplier - 1.0) * 0.5) * 100) / 100;
    accuracyAdj.label += ' (damped)';
  }

  // ML
  const mlAdj = mlMultiplier(ml, side);

  // Confidence tier
  const confMult = CONF_MULT[confidence] ?? 0.55;
  const confidenceAdj = {
    multiplier: confMult,
    label: confidence ?? 'MEDIUM',
  };

  // Execution risk
  const executionAdj = executionMultiplier(executionContext);

  // Apply all multipliers (5 total: regime, accuracy, ML, confidence, execution)
  // Multiply all together, clamp once at end — per-step clamping loses information
  // when intermediate values hit bounds and later multipliers pull back
  const safeMult = (v) => Number.isFinite(v) ? v : 1.0;
  let adjustedFraction = frac
    * safeMult(regimeAdj.multiplier)
    * safeMult(accuracyAdj.multiplier)
    * safeMult(mlAdj.multiplier)
    * safeMult(confidenceAdj.multiplier)
    * safeMult(executionAdj.multiplier);
  adjustedFraction = Math.min(Math.max(adjustedFraction, 0), MAX_BET_PCT);

  // NaN-safe: if adjustedFraction is somehow NaN, default to 0
  const safeFraction = Number.isFinite(adjustedFraction) ? adjustedFraction : 0;
  // MIN_BET_PCT as threshold — if multipliers reduced fraction below minimum,
  // the edge isn't worth a bet under current conditions
  if (safeFraction > 0 && safeFraction < MIN_BET_PCT) {
    noBet.rationale = `Adjusted Kelly ${(safeFraction * 100).toFixed(2)}% < min ${(MIN_BET_PCT * 100).toFixed(1)}%`;
    return noBet;
  }
  const betPercent = safeFraction;
  const br = bankroll ?? BET_SIZING.DEFAULT_BANKROLL;
  const betAmount = Math.round(betPercent * br * 100) / 100;

  // EV per dollar
  const expectedValue = Math.round((b * p - q) * 100) / 100;

  // Rationale string
  const rationale =
    `Kelly=${(rawKelly * 100).toFixed(1)}% \u00d7 ${effectiveKelly}` +
    (kellyTune.reason !== 'insufficient_data' && kellyTune.reason !== 'sparse_buckets'
      ? ` (${kellyTune.reason})`
      : '') +
    ` \u00d7 regime(${regimeAdj.multiplier})` +
    ` \u00d7 acc(${accuracyAdj.multiplier})` +
    ` \u00d7 ml(${mlAdj.multiplier})` +
    ` \u00d7 conf(${confidenceAdj.multiplier})` +
    ` \u00d7 exec(${executionAdj.multiplier})` +
    ` = ${(betPercent * 100).toFixed(1)}%` +
    ` \u2192 $${betAmount.toFixed(2)}` +
    ` [${riskLevel(betPercent)}]`;

  return {
    shouldBet: true,
    side,
    rawKelly,
    kellyFraction: effectiveKelly,
    adjustedFraction,
    betPercent,
    betAmount,
    bankroll: br,
    riskLevel: riskLevel(betPercent),
    regimeAdj,
    accuracyAdj,
    mlAdj,
    confidenceAdj,
    executionAdj,
    expectedValue,
    rationale,
    kellyTune,
  };
}
