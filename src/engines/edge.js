import { ML_CONFIDENCE } from '../config.js';

/**
 * ═══ Edge & Decision Engine v2 ═══
 *
 * v3 changes (frequency + win rate optimization):
 * 1. Lowered edge thresholds (8-15% → 6-12%) — old thresholds blocked too many profitable trades
 * 2. Fixed trending regime: now RELAXES aligned signals, TIGHTENS counter-trend (was tightening all)
 * 3. Reduced regime/session penalties to prevent stacking to impossible levels
 * 4. Reduced UP side bias (+2% → +1%) to collect more UP trade data
 *
 * PHASE TABLE v3:
 * | Phase     | Time Left | Min Edge | Min Prob | Min Agreement | MultiTF Req |
 * |-----------|-----------|----------|----------|---------------|-------------|
 * | EARLY     | > 10 min  | 6%       | 58%      | 2             | preferred   |
 * | MID       | 5-10 min  | 8%       | 56%      | 2             | preferred   |
 * | LATE      | 2-5 min   | 10%      | 55%      | 2             | no          |
 * | VERY_LATE | < 2 min   | 12%      | 54%      | 2             | no          |
 */

/**
 * Compute edge: model probability minus effective execution price.
 *
 * Spread-aware (from Math Part 1 & 2.5):
 * - Real edge = modelProb - bestAsk (not midprice)
 * - Spread penalty: half-spread as execution cost estimate
 * - When orderbook data is available, use bestAsk; otherwise fall back to market mid
 *
 * @param {Object} params
 * @param {number} params.modelUp
 * @param {number} params.modelDown
 * @param {number|null} params.marketYes        - mid/last price
 * @param {number|null} params.marketNo         - mid/last price
 * @param {Object|null} [params.orderbookUp]    - { bestAsk, bestBid, spread, ... }
 * @param {Object|null} [params.orderbookDown]  - { bestAsk, bestBid, spread, ... }
 */
export function computeEdge({ modelUp, modelDown, marketYes, marketNo, orderbookUp, orderbookDown }) {
  // Effective price = bestAsk (what you'd actually pay), not mid.
  // bestAsk already includes the spread cost, so no additional penalty needed.
  // Only add half-spread penalty when falling back to mid/last price (marketYes/No).
  const hasBookUp = orderbookUp?.bestAsk != null;
  const hasBookDown = orderbookDown?.bestAsk != null;
  const effectiveUp = hasBookUp ? orderbookUp.bestAsk : marketYes;
  const effectiveDown = hasBookDown ? orderbookDown.bestAsk : marketNo;

  // Spread penalty only when using mid/last price (no orderbook bestAsk)
  // Guard: ensure spread is a finite number to prevent NaN propagation
  // v5: Default 1.5% penalty when no spread data at all (prevents phantom edge from mid-price)
  const DEFAULT_SPREAD_PENALTY = 0.015;
  const rawSpreadUp = orderbookUp?.spread;
  const rawSpreadDown = orderbookDown?.spread;
  const spreadPenaltyUp = hasBookUp ? 0 : (Number.isFinite(rawSpreadUp) ? rawSpreadUp * 0.5 : DEFAULT_SPREAD_PENALTY);
  const spreadPenaltyDown = hasBookDown ? 0 : (Number.isFinite(rawSpreadDown) ? rawSpreadDown * 0.5 : DEFAULT_SPREAD_PENALTY);

  const edgeUp = effectiveUp !== null && Number.isFinite(effectiveUp)
    ? modelUp - effectiveUp - spreadPenaltyUp
    : null;
  const edgeDown = effectiveDown !== null && Number.isFinite(effectiveDown)
    ? modelDown - effectiveDown - spreadPenaltyDown
    : null;

  let bestSide = null;
  let bestEdge = null;

  if (edgeUp !== null && edgeDown !== null) {
    if (edgeUp >= edgeDown && edgeUp > 0) {
      bestSide = 'UP';
      bestEdge = edgeUp;
    } else if (edgeDown > 0) {
      bestSide = 'DOWN';
      bestEdge = edgeDown;
    }
  } else if (edgeUp !== null && edgeUp > 0) {
    bestSide = 'UP';
    bestEdge = edgeUp;
  } else if (edgeDown !== null && edgeDown > 0) {
    bestSide = 'DOWN';
    bestEdge = edgeDown;
  }

  return { edgeUp, edgeDown, bestSide, bestEdge, spreadPenaltyUp, spreadPenaltyDown };
}

/**
 * H1 FIX: Family-based agreement count.
 *
 * RSI, StochRSI, BB%B, EMA, MACD are highly correlated — counting them as
 * independent "agreements" inflates signal confidence. We group correlated
 * indicators into families and count family-level agreement:
 *
 *   Momentum family (1.5x): RSI + StochRSI (stochK via bbPos proxy) + MACD hist + MACD line
 *   Trend family    (1.5x): EMA crossover (heikenAshi) + Heiken Ashi + multiTf
 *   Volatility fam  (1.0x): Bollinger %B + ATR expansion
 *   Volume family   (1.0x): Volume Delta (orderbook) + VWAP position + VWAP slope
 *   Funding/Other   (1.0x): failedVwap + ptbDistance + ptbMomentum + momentum (delta)
 *
 * Max family agreement = 5 weighted votes (instead of 14 individual indicators).
 */

// Helper: check if a breakdown entry signals a given side
function _entrySignals(entry, side) {
  if (!entry || entry.weight === 0) return false;
  const signal = entry.signal?.toUpperCase() ?? '';
  if (entry.weight > 0) {
    return side === 'UP' ? signal.includes('UP') : signal.includes('DOWN');
  }
  // Negative weight (conflict): opposite side
  return side === 'UP' ? signal.includes('DOWN') : signal.includes('UP');
}

/**
 * Count family-level agreement on a direction from breakdown.
 * Returns a weighted count where momentum and trend families get 1.5x weight.
 *
 * @param {Object} breakdown - scoreDirection breakdown
 * @param {string} side - 'UP' or 'DOWN'
 * @returns {number} weighted family agreement count (max ~7.0)
 */
export function countAgreement(breakdown, side) {
  if (!breakdown) return 0;

  let total = 0;

  // ═══ Momentum family (weight 1.5): RSI + MACD hist + MACD line ═══
  {
    let votes = 0, members = 0;
    for (const key of ['rsi', 'macdHist', 'macdLine']) {
      if (breakdown[key] && breakdown[key].weight !== 0) {
        members++;
        if (_entrySignals(breakdown[key], side)) votes++;
      }
    }
    if (members > 0 && votes > members / 2) total += 1.5;
  }

  // ═══ Trend family (weight 1.5): Heiken Ashi + multiTf ═══
  {
    let votes = 0, members = 0;
    for (const key of ['heikenAshi', 'multiTf']) {
      if (breakdown[key] && breakdown[key].weight !== 0) {
        members++;
        if (_entrySignals(breakdown[key], side)) votes++;
      }
    }
    if (members > 0 && votes > members / 2) total += 1.5;
  }

  // ═══ Volatility family (weight 1.0): Bollinger %B + ATR expansion ═══
  {
    let votes = 0, members = 0;
    for (const key of ['bbPos', 'atrExpand']) {
      if (breakdown[key] && breakdown[key].weight !== 0) {
        members++;
        if (_entrySignals(breakdown[key], side)) votes++;
      }
    }
    if (members > 0 && votes > members / 2) total += 1.0;
  }

  // ═══ Volume family (weight 1.0): Orderbook + VWAP position + VWAP slope ═══
  {
    let votes = 0, members = 0;
    for (const key of ['orderbook', 'vwapPos', 'vwapSlope']) {
      if (breakdown[key] && breakdown[key].weight !== 0) {
        members++;
        if (_entrySignals(breakdown[key], side)) votes++;
      }
    }
    if (members > 0 && votes > members / 2) total += 1.0;
  }

  // ═══ Price/Directional family (weight 1.0): ptbDistance + ptbMomentum + momentum(delta) + failedVwap ═══
  {
    let votes = 0, members = 0;
    for (const key of ['ptbDistance', 'ptbMomentum', 'momentum', 'failedVwap']) {
      if (breakdown[key] && breakdown[key].weight !== 0) {
        members++;
        if (_entrySignals(breakdown[key], side)) votes++;
      }
    }
    if (members > 0 && votes > members / 2) total += 1.0;
  }

  return total;
}

/**
 * Phase-based decision with quality gates.
 *
 * @param {Object} params
 * @param {number} params.remainingMinutes
 * @param {number|null} params.edgeUp
 * @param {number|null} params.edgeDown
 * @param {number} params.modelUp
 * @param {number} params.modelDown
 * @param {Object} [params.breakdown] - scoring breakdown for agreement count
 * @param {boolean} [params.multiTfConfirmed] - whether 1m+5m agree
 * @param {number|null} [params.mlConfidence] - ML model confidence (0-1)
 * @param {boolean} [params.mlAgreesWithRules] - whether ML and rules agree on direction
 * @returns {{ action: string, side: string|null, confidence: string, phase: string, reason: string }}
 */
export function decide({
  remainingMinutes,
  edgeUp,
  edgeDown,
  modelUp,
  modelDown,
  breakdown = null,
  multiTfConfirmed = false,
  mlConfidence = null,
  mlAgreesWithRules = false,
  regimeInfo = null,
  session = null,
  calibratedThresholds = null,  // from norm_browser.json phase_thresholds (audit H3)
}) {
  // ═══ Phase thresholds — calibrated from holdout if available, else v3 defaults ═══
  let phase, minEdge, minProb, minAgreement, preferMultiTf;
  const cal = calibratedThresholds;

  if (remainingMinutes > 10) {
    phase = 'EARLY';
    minEdge = cal?.EARLY?.minEdge ?? 0.06;
    minProb = cal?.EARLY?.minProb ?? 0.58;
    minAgreement = 2;
    preferMultiTf = true;
  } else if (remainingMinutes > 5) {
    phase = 'MID';
    minEdge = cal?.MID?.minEdge ?? 0.08;
    minProb = cal?.MID?.minProb ?? 0.56;
    minAgreement = 2;
    preferMultiTf = true;
  } else if (remainingMinutes > 2) {
    phase = 'LATE';
    minEdge = cal?.LATE?.minEdge ?? 0.10;
    minProb = cal?.LATE?.minProb ?? 0.55;
    minAgreement = 2;
    preferMultiTf = false;
  } else {
    phase = 'VERY_LATE';
    minEdge = cal?.VERY_LATE?.minEdge ?? 0.12;
    minProb = cal?.VERY_LATE?.minProb ?? 0.54;
    minAgreement = 2;
    preferMultiTf = false;
  }

  // ═══ Regime-adaptive thresholds ═══
  // Save base thresholds before adjustments to cap combined penalty
  const baseMinEdge = minEdge;
  const baseMinProb = minProb;

  if (regimeInfo && regimeInfo.regime) {
    const scale = Math.min(regimeInfo.confidence ?? 0.5, 0.85);
    switch (regimeInfo.regime) {
      case 'trending':
        // v3: Direction-aware — old code tightened ALL trending (33% WR was from counter-trend entries).
        // Aligned signals in trends are strong; counter-trend is what loses.
        // Check if best model side aligns with trend direction.
        {
          const trendDir = regimeInfo.direction; // 'UP' or 'DOWN'
          const bestModelSide = modelUp >= modelDown ? 'UP' : 'DOWN';
          if (trendDir && bestModelSide === trendDir) {
            // Aligned with trend: RELAX thresholds (clear signal)
            minEdge = Math.max(minEdge - 0.01 * scale, 0.04);
            minProb = Math.max(minProb - 0.01 * scale, 0.52);
          } else {
            // Counter-trend: TIGHTEN (risky against momentum)
            minEdge = Math.min(minEdge + 0.02 * scale, 0.25);
            minProb = Math.min(minProb + 0.02 * scale, 0.70);
          }
        }
        break;
      case 'choppy':
        minEdge = Math.min(minEdge + 0.02 * scale, 0.25);
        minProb = Math.min(minProb + 0.02 * scale, 0.70);
        break;
      case 'mean_reverting':
        minEdge = Math.min(minEdge + 0.01 * scale, 0.20);
        break;
    }
  }

  // ═══ Session-adaptive thresholds ═══
  // Asia/Off-hours: tighten (noisy/thin liquidity)
  // US/EU-US Overlap: relax (predictable trends, high volume)
  if (session) {
    const SESSION_ADJ = {
      'Asia':          { edgeAdj: +0.01, probAdj: +0.01 },   // v3: reduced from +2%/+2%
      'US':            { edgeAdj: -0.01, probAdj: -0.01 },
      'EU/US Overlap': { edgeAdj: -0.02, probAdj: -0.01 },
      'Europe':        { edgeAdj:  0,    probAdj:  0    },
      'Off-hours':     { edgeAdj: +0.02, probAdj: +0.01 },   // v3: reduced from +3%/+2%
    };
    const adj = SESSION_ADJ[session];
    if (adj) {
      minEdge = Math.max(minEdge + adj.edgeAdj, 0.04);
      minProb = Math.max(Math.min(minProb + adj.probAdj, 0.70), 0.52);
    }
  }

  // ML high-confidence relaxation: when ML probUp >= 0.70 (confidence >= HIGH),
  // the model's 75%+ accuracy justifies relaxing thresholds by 2%
  const mlIsHighConf = mlConfidence !== null && mlConfidence >= ML_CONFIDENCE.HIGH;
  if (mlIsHighConf && mlAgreesWithRules) {
    minEdge = Math.max(minEdge - 0.02, 0.04);
    minProb = Math.max(minProb - 0.02, 0.52);
  }

  // ═══ Side bias v3 (reduced: UP +1%, DOWN -0.5%) ═══
  // v2 had UP +2% which blocked almost all UP trades → no new data to recalibrate.
  // Reduced to collect more UP data while still giving DOWN slight advantage.
  let upMinEdge = Math.min(minEdge + 0.01, 0.25);   // UP: +1% harder (was +2%)
  let upMinProb = Math.min(minProb + 0.01, 0.70);
  let downMinEdge = Math.max(minEdge - 0.005, 0.04); // DOWN: -0.5% easier (was -1%)
  let downMinProb = Math.max(minProb - 0.005, 0.52);

  // ═══ Cap combined regime+session+side-bias penalty ═══
  // Prevent stacking (e.g. choppy +3% + off-hours +3% + UP bias +2% = +8%) from
  // making entry impossible. Cap AFTER side bias so the final thresholds are bounded.
  const MAX_COMBINED_PENALTY = 0.04;  // v3: reduced from 5% to prevent impossible thresholds
  upMinEdge = Math.min(upMinEdge, baseMinEdge + MAX_COMBINED_PENALTY);
  upMinProb = Math.min(upMinProb, baseMinProb + MAX_COMBINED_PENALTY);
  downMinEdge = Math.min(downMinEdge, baseMinEdge + MAX_COMBINED_PENALTY);
  downMinProb = Math.min(downMinProb, baseMinProb + MAX_COMBINED_PENALTY);

  // Count agreements if breakdown available (default 0 = conservative, not 99)
  const upAgreement = breakdown ? countAgreement(breakdown, 'UP') : 0;
  const downAgreement = breakdown ? countAgreement(breakdown, 'DOWN') : 0;

  // Check UP side (stricter thresholds)
  // MultiTF waiver: minAgreement+1 indicators can waive multiTF requirement
  const multiTfWaiver = minAgreement + 1;

  const upEdgePass = edgeUp !== null && edgeUp >= upMinEdge;
  const upProbPass = modelUp >= upMinProb;
  const upAgreementPass = upAgreement >= minAgreement;
  const upMultiTfPass = !preferMultiTf || multiTfConfirmed || upAgreement >= multiTfWaiver;
  const upPass = upEdgePass && upProbPass && upAgreementPass && upMultiTfPass;

  // Check DOWN side (relaxed thresholds)
  const downEdgePass = edgeDown !== null && edgeDown >= downMinEdge;
  const downProbPass = modelDown >= downMinProb;
  const downAgreementPass = downAgreement >= minAgreement;
  const downMultiTfPass = !preferMultiTf || multiTfConfirmed || downAgreement >= multiTfWaiver;
  const downPass = downEdgePass && downProbPass && downAgreementPass && downMultiTfPass;

  const regimeLabel = regimeInfo?.label ?? regimeInfo?.regime ?? null;

  if (upPass && downPass) {
    if (edgeUp >= edgeDown) {
      return makeEnter('UP', edgeUp, modelUp, upAgreement, phase, upMinEdge, upMinProb, mlIsHighConf, mlAgreesWithRules, regimeLabel);
    } else {
      return makeEnter('DOWN', edgeDown, modelDown, downAgreement, phase, downMinEdge, downMinProb, mlIsHighConf, mlAgreesWithRules, regimeLabel);
    }
  }

  if (upPass) {
    return makeEnter('UP', edgeUp, modelUp, upAgreement, phase, upMinEdge, upMinProb, mlIsHighConf, mlAgreesWithRules, regimeLabel);
  }

  if (downPass) {
    return makeEnter('DOWN', edgeDown, modelDown, downAgreement, phase, downMinEdge, downMinProb, mlIsHighConf, mlAgreesWithRules, regimeLabel);
  }

  // No entry — explain why (use the side-specific thresholds for the best side)
  const bestEdge = Math.max(edgeUp ?? -Infinity, edgeDown ?? -Infinity);
  const hasValidEdge = Number.isFinite(bestEdge);
  const bestSide = edgeUp == null && edgeDown == null ? null
    : (edgeUp ?? -Infinity) >= (edgeDown ?? -Infinity) ? 'UP' : 'DOWN';
  const bestProb = bestSide === 'UP' ? modelUp : bestSide === 'DOWN' ? modelDown : Math.max(modelUp, modelDown);
  const bestAgree = bestSide === 'UP' ? upAgreement : bestSide === 'DOWN' ? downAgreement : Math.max(upAgreement, downAgreement);
  const sideMinEdge = bestSide === 'DOWN' ? downMinEdge : upMinEdge;
  const sideMinProb = bestSide === 'DOWN' ? downMinProb : upMinProb;

  const reasons = [];
  if (!hasValidEdge) reasons.push('no valid edge');
  else if (bestEdge < sideMinEdge) reasons.push(`edge ${(bestEdge * 100).toFixed(1)}% < ${(sideMinEdge * 100).toFixed(0)}%`);
  if (bestProb < sideMinProb) reasons.push(`prob ${(bestProb * 100).toFixed(0)}% < ${(sideMinProb * 100).toFixed(0)}%`);
  if (bestAgree < minAgreement) reasons.push(`agree ${bestAgree} < ${minAgreement}`);
  if (preferMultiTf && !multiTfConfirmed && bestAgree < multiTfWaiver) reasons.push('no multiTF confirm');
  if (regimeLabel) reasons.push(regimeLabel);

  return {
    action: 'WAIT',
    side: null,
    confidence: 'NONE',
    phase,
    reason: `${bestSide ?? 'N/A'}: ${reasons.join(', ')}`,
  };
}

function makeEnter(side, edge, prob, agreement, phase, minEdge, minProb, mlHighConf = false, mlAgrees = false, regimeLabel = null) {
  return {
    action: 'ENTER',
    side,
    confidence: getConfidence(edge, prob, agreement, mlHighConf, mlAgrees),
    phase,
    reason: `${side} edge ${(edge * 100).toFixed(1)}%≥${(minEdge * 100).toFixed(0)}%, prob ${(prob * 100).toFixed(0)}%≥${(minProb * 100).toFixed(0)}%, ${agreement} indicators agree${mlHighConf ? ', ML high-conf' : ''}${regimeLabel ? `, ${regimeLabel}` : ''}`,
  };
}

function getConfidence(edge, prob, agreement, mlHighConf = false, mlAgrees = false) {
  // ML high-conf + rule agreement can boost by one tier
  const mlBoost = mlHighConf && mlAgrees;

  // H1 FIX: Agreement thresholds rescaled for family-based counting.
  // Old: max ~14 individual indicators → thresholds 3/4/5
  // New: max ~7.0 weighted family votes → thresholds 2.5/3.5/4.0
  if (edge >= 0.16 && prob >= 0.62 && agreement >= 4.0) return 'VERY_HIGH';
  if (mlBoost && edge >= 0.12 && prob >= 0.58 && agreement >= 3.5) return 'VERY_HIGH';
  if (edge >= 0.12 && prob >= 0.58 && agreement >= 3.5) return 'HIGH';
  if (mlBoost && edge >= 0.08 && prob >= 0.55 && agreement >= 2.5) return 'HIGH';
  if (edge >= 0.08 && prob >= 0.55 && agreement >= 2.5) return 'MEDIUM';
  return 'LOW';
}