import { BET_SIZING, EXECUTION } from '../config.js';
import { computeKellyTune } from './feedback/stats.js';

const {
  KELLY_FRACTION,
  MAX_BET_PCT,
  MIN_BET_PCT,
  MIN_EDGE_FOR_BET,
} = BET_SIZING;

// Regime multipliers (scaled by regime confidence)
// v3: raised choppy 0.50→0.60, mean_reverting 0.70→0.75 — less double-dampening with probability engine
const REGIME_MULT = {
  trending:       1.00,
  moderate:       0.85,
  mean_reverting: 0.75,
  choppy:         0.60,
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
  const hiConf = ml.confidence >= 0.58;  // Audit fix H3: 0.55→0.58 — sync with MIN_ML_CONFIDENCE in config
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
// v3: raised LOW 0.30→0.40, MEDIUM 0.55→0.65 — old values killed most bets below MIN_BET_PCT
const CONF_MULT = {
  VERY_HIGH: 1.00,
  HIGH:      0.80,
  MEDIUM:    0.65,
  LOW:       0.40,
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
  smartFlowSignal,   // from smartMoneyTracker { direction, strength, confidence, agreesWithSide }
  entryTimingScore,  // from smartMoneyTracker.getEntryTimingScore { score, label, inSweetSpot }
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
  // Quant fix C2: net payout after Polymarket 2% fee on profit.
  // Gross b = (1/price - 1). Net b = gross × (1 - 0.02) = gross × 0.98.
  // Without fee, Kelly slightly oversizes every trade systematically.
  const grossB = (1 / marketPrice) - 1;
  const b = grossB * 0.98;             // net decimal odds after 2% fee
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
  // Fix P1: When ML confidence ≥ 0.80 and agrees with trade side, bypass confidence
  // tier penalty — ML at this level already encodes signal quality, double-dampening
  // causes systematic under-sizing ("death by a thousand cuts").
  const mlVeryHighConf = ml?.status === 'ready' && ml?.confidence >= 0.80 && ml?.side === side;
  const confMult = mlVeryHighConf ? 1.0 : (CONF_MULT[confidence] ?? 0.55);
  const confidenceAdj = {
    multiplier: confMult,
    label: mlVeryHighConf ? `${confidence}→ML↑` : (confidence ?? 'MEDIUM'),
  };

  // Execution risk
  const executionAdj = executionMultiplier(executionContext);

  // Autocorrelation penalty — consecutive loss streaks signal correlated regime failure.
  // Quant fix H7: Gate behind accuracy check — don't penalize random variance.
  // Kelly assumes independence; streak penalty only valid when accuracy is also statistically poor.
  // With 65% WR, P(5 consecutive losses) = 0.35^5 = 0.52% — can happen by chance alone.
  // Only apply if recent accuracy < 45% (well below random 50%) confirming systematic failure.
  let autoCorr = { multiplier: 1.0, label: 'N/A' };
  const streak = feedbackStats?.streak;
  // accRaw already declared above (line ~166) — reuse for streak accuracy gate
  const accPoor = accRaw === null || accRaw < 0.45;  // null = no data → conservative, apply penalty
  if (streak && streak.count >= 3 && streak.type === 'loss' && accPoor) {
    if (streak.count >= 5) { autoCorr = { multiplier: 0.60, label: `${streak.count}× corr (acc=${accRaw != null ? (accRaw*100).toFixed(0)+'%' : 'N/A'})` }; }
    else { autoCorr = { multiplier: 0.80, label: `${streak.count}× corr (acc=${accRaw != null ? (accRaw*100).toFixed(0)+'%' : 'N/A'})` }; }
  }

  // ── Smart money flow multiplier ──
  // When smart flow agrees with trade direction and has good confidence, boost sizing.
  // When it disagrees, dampen.
  let smartFlowAdj = { multiplier: 1.0, label: 'N/A' };
  if (smartFlowSignal && smartFlowSignal.confidence > 0.2) {
    const agrees = smartFlowSignal.agreesWithSide?.(side) ?? true;
    const str = smartFlowSignal.strength ?? 0;
    if (agrees && str > 0.3) {
      smartFlowAdj = { multiplier: Math.min(1.25, 1.10 + str * 0.10), label: `Flow✓ ${smartFlowSignal.direction}` }; // Audit fix H1: cap at 1.25
    } else if (!agrees && str > 0.3) {
      smartFlowAdj = { multiplier: 0.70, label: `Flow✗ ${smartFlowSignal.direction}` };
    }
  }

  // ── Entry timing multiplier ──
  // Sweet spot (3-7 min elapsed): boost. Very late (>12 min): penalize.
  let timingAdj = { multiplier: 1.0, label: 'N/A' };
  if (entryTimingScore) {
    timingAdj = {
      // Quant fix L3: clamp score to [0.5, 1.5] before use as multiplier — prevents corrupt
      // upstream value from hitting the [0.15, 3.0] global clamp at max (makes debugging opaque).
      multiplier: Math.max(0.5, Math.min(1.5, entryTimingScore.score)),
      label: entryTimingScore.label + (entryTimingScore.inSweetSpot ? ' ★' : ''),
    };
  }

  // Audit v2 H2: Group correlated multipliers to prevent double-counting.
  // Regime+accuracy are correlated (choppy→cold accuracy). ML+confidence are correlated.
  // Group them and cap each group's combined penalty, then multiply groups together.
  const safeMult = (v) => Number.isFinite(v) ? v : 1.0;

  // Group 1: Market quality (regime × accuracy × autocorrelation) — correlated via regime
  const marketQuality = Math.max(0.40, safeMult(regimeAdj.multiplier) * safeMult(accuracyAdj.multiplier) * safeMult(autoCorr.multiplier));
  // Group 2: Signal quality (ML × confidence × smartFlow) — correlated via model agreement
  const signalQuality = Math.max(0.40, safeMult(mlAdj.multiplier) * safeMult(confidenceAdj.multiplier) * safeMult(smartFlowAdj.multiplier));
  // Group 3: Execution (independent)
  const execQuality = safeMult(executionAdj.multiplier) * safeMult(timingAdj.multiplier);

  const rawMultiplier = marketQuality * signalQuality * execQuality;
  // Audit v2 H2: Floor 0.15→0.25 — 0.15 produces near-zero bets that waste fees.
  // At $45 bankroll × 5% Kelly × 0.15 = $0.34 bet — below Polymarket $1 minimum anyway.
  const clampedMultiplier = Math.max(0.25, Math.min(3.0, rawMultiplier));
  let adjustedFraction = frac * clampedMultiplier;
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
    (autoCorr.multiplier !== 1.0 ? ` \u00d7 corr(${autoCorr.multiplier})` : '') +
    (smartFlowAdj.multiplier !== 1.0 ? ` \u00d7 flow(${smartFlowAdj.multiplier.toFixed(2)})` : '') +
    (timingAdj.multiplier !== 1.0 ? ` \u00d7 timing(${timingAdj.multiplier})` : '') +
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
    autoCorrAdj: autoCorr,
    smartFlowAdj,
    timingAdj,
    expectedValue,
    rationale,
    kellyTune,
  };
}
