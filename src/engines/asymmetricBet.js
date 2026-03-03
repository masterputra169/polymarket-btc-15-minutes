import { BET_SIZING, EXECUTION, polyFeeRate } from '../config.js';
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

// ML multiplier — tiered confidence scaling (Solution B: confidence-scaled sizing)
// Wider range: 0.50x (ML opposes strongly) to 1.30x (ML agrees strongly)
// Addresses P&L asymmetry: bigger bets on high-conf wins, smaller on uncertain trades
function mlMultiplier(ml, side) {
  if (!ml || ml.status !== 'ready' || ml.confidence == null) {
    return { multiplier: 1.0, label: 'N/A' };
  }
  const conf = ml.confidence;
  const agrees = ml.side === side;
  if (agrees) {
    if (conf >= 0.85) return { multiplier: 1.30, label: `ML\u2191${(conf * 100).toFixed(0)}%` };
    if (conf >= 0.75) return { multiplier: 1.15, label: `ML\u2191${(conf * 100).toFixed(0)}%` };
    if (conf >= 0.65) return { multiplier: 1.05, label: `ML\u2713${(conf * 100).toFixed(0)}%` };
    return { multiplier: 1.00, label: `ML~${(conf * 100).toFixed(0)}%` };
  } else {
    if (conf >= 0.80) return { multiplier: 0.50, label: `ML\u2193${(conf * 100).toFixed(0)}%` };
    if (conf >= 0.65) return { multiplier: 0.65, label: `ML\u2717${(conf * 100).toFixed(0)}%` };
    return { multiplier: 0.85, label: `ML?${(conf * 100).toFixed(0)}%` };
  }
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
  if (depth <= 0) liqMult = 0.60;  // Audit v4 H9: 0.30→0.60 — 0.30 makes bet below $1 minimum
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
  mcResult,          // from monteCarlo.simulateBTCPaths { pUp, pDown, mcConfidence, priceEfficiency }
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
  // Quant fix C2: net payout after Polymarket taker fee on profit.
  // Gross b = (1/price - 1). Net b = gross × (1 - feeRate).
  // Dynamic fee (Feb 2026): feeRate = 0.25 × (p×(1−p))². At 65c: 1.29%, at 70c: 1.10%.
  const grossB = (1 / marketPrice) - 1;
  const feeRate = polyFeeRate(marketPrice);
  // Audit v4 H7: Include spread cost + avg slippage in Kelly denominator (not just Polymarket fee)
  const spreadCost = executionContext?.spread ? executionContext.spread * 0.5 : 0.015;
  const slippage = executionContext?.avgSlippage ?? 0.005;
  const totalCost = feeRate + spreadCost + slippage;
  const b = grossB * (1 - totalCost);    // net decimal odds after fee + spread + slippage
  const p = ensembleProb;              // model probability of winning
  const q = 1 - p;
  const rawKelly = (b * p - q) / b;

  if (!Number.isFinite(rawKelly) || rawKelly <= 0) {
    noBet.rationale = `Negative Kelly (${Number.isFinite(rawKelly) ? (rawKelly * 100).toFixed(1) : 'NaN'}%) \u2014 no edge`;
    return noBet;
  }

  // Audit v4 C2: Dynamic Kelly gate — reduce sizing when actual WR is poor.
  // Hard suspend at <35% (clearly broken), soft penalty 50-55%. Requires ≥10 samples to avoid
  // deadlock from small feedback window (40% on 5 trades = 2 correct, not statistically meaningful).
  const actualWR = feedbackStats?.accuracy;
  const wrSampleCount = feedbackStats?.total ?? 0;
  if (actualWR != null && wrSampleCount >= 10 && actualWR < 0.35) {
    noBet.rationale = `Actual WR ${(actualWR * 100).toFixed(0)}% < 35% (n=${wrSampleCount}) \u2014 suspending`;
    return noBet;
  }
  const wrPenalty = (actualWR != null && wrSampleCount >= 10 && actualWR < 0.50) ? 0.50 : 1.0;

  // Dynamic Kelly fraction from calibration data
  const kellyTune = computeKellyTune(KELLY_FRACTION);
  const effectiveKelly = kellyTune.kellyFraction;

  // Fractional Kelly (rawKelly is mathematically bounded by p ≤ 1.0, no cap needed)
  let frac = rawKelly * effectiveKelly * wrPenalty;  // Audit v4 C2: wrPenalty halves sizing when WR 50-55%

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

  // Short-window rapid adaptation — when last 10 trades diverge badly from normal,
  // apply additional penalty to reduce sizing faster during cold spells.
  const shortAcc = feedbackStats?.shortTermAccuracy ?? null;
  if (shortAcc !== null && accRaw !== null && shortAcc < accRaw - 0.15) {
    const shortPenalty = Math.max(0.60, shortAcc / (accRaw || 0.5));
    accuracyAdj.multiplier *= shortPenalty;
    accuracyAdj.label += ` | ST\u2193${(shortAcc*100).toFixed(0)}%`;
  }

  // ML
  const mlAdj = mlMultiplier(ml, side);

  // Confidence tier
  // Fix P1: When ML confidence ≥ 0.80 and agrees with trade side, bypass confidence
  // tier penalty — ML at this level already encodes signal quality, double-dampening
  // causes systematic under-sizing ("death by a thousand cuts").
  const mlVeryHighConf = ml?.status === 'ready' && ml?.confidence >= 0.75 && ml?.side === side;
  const confMult = mlVeryHighConf ? 1.0 : (CONF_MULT[confidence] ?? 0.55);
  const confidenceAdj = {
    multiplier: confMult,
    label: mlVeryHighConf ? `${confidence}→ML↑` : (confidence ?? 'MEDIUM'),
  };

  // Execution risk
  const executionAdj = executionMultiplier(executionContext);

  // Solution C: Anti-martingale — progressive bet reduction after losses.
  // Key insight: after losing, reduce next bet immediately to protect accumulated profits.
  // Directly fixes "many small wins wiped by one loss" — losses now get smaller bets.
  // After win streaks, mild boost (Kelly-optimal under confirmed positive edge).
  let autoCorr = { multiplier: 1.0, label: 'N/A' };
  const streak = feedbackStats?.streak;
  if (streak && streak.type === 'loss' && streak.count >= 1) {
    if (streak.count >= 4) {
      autoCorr = { multiplier: 0.60, label: `${streak.count}L streak` };  // GC5e: 0.50→0.60 — less harsh, 4L streaks normal at 60.5% WR
    } else if (streak.count >= 3) {
      autoCorr = { multiplier: 0.70, label: `${streak.count}L streak` };  // GC5e: 0.60→0.70
    } else if (streak.count === 2) {
      autoCorr = { multiplier: 0.80, label: '2L streak' };               // GC5e: 0.75→0.80
    } else {
      // Single recent loss — near-neutral after single loss
      autoCorr = { multiplier: 0.95, label: '1L cool' };                 // GC5e: 0.90→0.95
    }
  } else if (streak && streak.type === 'win' && streak.count >= 3) {
    // Hot streak — mild boost (Kelly says increase when running hot)
    autoCorr = { multiplier: 1.10, label: `${streak.count}W hot` };
  }

  // ── Smart money flow multiplier ──
  // When smart flow agrees with trade direction and has good confidence, boost sizing.
  // When it disagrees, dampen.
  let smartFlowAdj = { multiplier: 1.0, label: 'N/A' };
  if (smartFlowSignal && smartFlowSignal.confidence > 0.2) {
    const agrees = typeof smartFlowSignal.agreesWithSide === 'function'
      ? smartFlowSignal.agreesWithSide(side)
      : smartFlowSignal.direction === side;
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

  // ── Monte Carlo agreement multiplier ──
  // MC provides independent P(win) from GBM BTC price path simulation.
  // Boost when MC confirms our direction, dampen when MC disagrees.
  let mcAdj = { multiplier: 1.0, label: 'N/A' };
  if (mcResult) {
    const mcProbForSide = side === 'UP' ? mcResult.pUp : mcResult.pDown;
    if (mcProbForSide >= 0.65) {
      // MC strongly agrees → boost (scaled by MC probability)
      mcAdj = {
        multiplier: Math.min(1.25, 1.0 + (mcProbForSide - 0.50) * 0.5),
        label: `MC\u2191${(mcProbForSide * 100).toFixed(0)}%`,
      };
    } else if (mcProbForSide < 0.40) {
      // MC disagrees → reduce size
      mcAdj = {
        multiplier: Math.max(0.60, 0.70 + (mcProbForSide - 0.30) * 1.0),
        label: `MC\u2193${(mcProbForSide * 100).toFixed(0)}%`,
      };
    } else {
      mcAdj = { multiplier: 1.0, label: `MC~${(mcProbForSide * 100).toFixed(0)}%` };
    }

    // Price efficiency bonus: if token is cheaper than MC fair value, extra edge
    if (mcResult.priceEfficiency?.favorableGap) {
      mcAdj.multiplier = Math.min(1.30, mcAdj.multiplier * 1.10);
      mcAdj.label += ' eff\u2713';
    }
  }

  // Audit v2 H2: Group correlated multipliers to prevent double-counting.
  // Regime+accuracy are correlated (choppy→cold accuracy). ML+confidence are correlated.
  // Group them and cap each group's combined penalty, then multiply groups together.
  const safeMult = (v) => Number.isFinite(v) ? v : 1.0;

  // Group 1: Market quality (regime × accuracy × autocorrelation) — correlated via regime
  const marketQuality = Math.max(0.35, safeMult(regimeAdj.multiplier) * safeMult(accuracyAdj.multiplier) * safeMult(autoCorr.multiplier)); // GC5d: 0.40→0.35 floor
  // Group 2: Signal quality (ML × confidence × smartFlow) — correlated via model agreement
  const signalQuality = Math.max(0.35, safeMult(mlAdj.multiplier) * safeMult(confidenceAdj.multiplier) * safeMult(smartFlowAdj.multiplier)); // GC5d: 0.40→0.35 floor
  // Group 3: Execution + MC (independent — MC is physics-based, not correlated with model/regime)
  const execQuality = safeMult(executionAdj.multiplier) * safeMult(timingAdj.multiplier) * safeMult(mcAdj.multiplier);

  const rawMultiplier = marketQuality * signalQuality * execQuality;
  // Audit v2 H2: Floor 0.15→0.25 — 0.15 produces near-zero bets that waste fees.
  // At $45 bankroll × 5% Kelly × 0.15 = $0.34 bet — below Polymarket $1 minimum anyway.
  const clampedMultiplier = Math.max(0.20, Math.min(3.0, rawMultiplier)); // GC5d: 0.25→0.20 global floor
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
    (autoCorr.multiplier !== 1.0 ? ` \u00d7 streak(${autoCorr.multiplier})` : '') +
    (smartFlowAdj.multiplier !== 1.0 ? ` \u00d7 flow(${smartFlowAdj.multiplier.toFixed(2)})` : '') +
    (timingAdj.multiplier !== 1.0 ? ` \u00d7 timing(${timingAdj.multiplier})` : '') +
    (mcAdj.multiplier !== 1.0 ? ` \u00d7 mc(${mcAdj.multiplier.toFixed(2)})` : '') +
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
    mcAdj,
    expectedValue,
    rationale,
    kellyTune,
  };
}
