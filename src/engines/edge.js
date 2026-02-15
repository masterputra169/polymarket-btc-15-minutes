import { ML_CONFIDENCE } from '../config.js';

/**
 * ═══ Edge & Decision Engine v2 ═══
 *
 * v2 changes:
 * 1. Raised probability thresholds (55% → 58-60%)
 * 2. Raised edge thresholds (5-12% → 8-15%)
 * 3. Added quality gates: minimum indicator agreement count
 * 4. Added multiTF confirmation requirement for EARLY/MID phases
 *
 * Result: Fewer ENTER signals but much higher accuracy.
 * Before: 71% trade rate, 77.7% accuracy
 * Target: ~50% trade rate, 83-85% accuracy
 *
 * PHASE TABLE v2:
 * | Phase     | Time Left | Min Edge | Min Prob | Min Agreement | MultiTF Req |
 * |-----------|-----------|----------|----------|---------------|-------------|
 * | EARLY     | > 10 min  | 8%       | 60%      | 3             | preferred   |
 * | MID       | 5-10 min  | 10%      | 58%      | 3             | preferred   |
 * | LATE      | 2-5 min   | 12%      | 57%      | 2             | no          |
 * | VERY_LATE | < 2 min   | 15%      | 56%      | 2             | no          |
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
  const rawSpreadUp = orderbookUp?.spread;
  const rawSpreadDown = orderbookDown?.spread;
  const spreadPenaltyUp = hasBookUp ? 0 : (Number.isFinite(rawSpreadUp) ? rawSpreadUp * 0.5 : 0);
  const spreadPenaltyDown = hasBookDown ? 0 : (Number.isFinite(rawSpreadDown) ? rawSpreadDown * 0.5 : 0);

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
 * Count how many indicators agree on a direction from breakdown.
 * @param {Object} breakdown - scoreDirection breakdown
 * @param {string} side - 'UP' or 'DOWN'
 * @returns {number} count of agreeing indicators
 */
export function countAgreement(breakdown, side) {
  if (!breakdown) return 0;

  let count = 0;
  const signalKeys = [
    'ptbDistance', 'ptbMomentum', 'momentum', 'rsi', 'macdHist', 'macdLine',
    'vwapPos', 'vwapSlope', 'heikenAshi', 'failedVwap', 'orderbook', 'multiTf',
  ];

  for (const key of signalKeys) {
    const entry = breakdown[key];
    if (!entry || entry.weight <= 0) continue;

    const signal = entry.signal?.toUpperCase() ?? '';
    if (side === 'UP' && signal.includes('UP')) count++;
    if (side === 'DOWN' && signal.includes('DOWN')) count++;
  }

  return count;
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
}) {
  // ═══ Phase thresholds v2 (stricter) ═══
  let phase, minEdge, minProb, minAgreement, preferMultiTf;

  if (remainingMinutes > 10) {
    phase = 'EARLY';
    minEdge = 0.08;
    minProb = 0.60;
    minAgreement = 2;
    preferMultiTf = true;
  } else if (remainingMinutes > 5) {
    phase = 'MID';
    minEdge = 0.10;
    minProb = 0.58;
    minAgreement = 2;
    preferMultiTf = true;
  } else if (remainingMinutes > 2) {
    phase = 'LATE';
    minEdge = 0.12;
    minProb = 0.57;
    minAgreement = 2;
    preferMultiTf = false;
  } else {
    phase = 'VERY_LATE';
    minEdge = 0.15;
    minProb = 0.56;
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
        minEdge = Math.max(minEdge - 0.02 * scale, 0.04);
        minProb = Math.max(minProb - 0.02 * scale, 0.52);
        break;
      case 'choppy':
        minEdge = Math.min(minEdge + 0.03 * scale, 0.25);
        minProb = Math.min(minProb + 0.03 * scale, 0.70);
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
      'Asia':          { edgeAdj: +0.02, probAdj: +0.02 },
      'US':            { edgeAdj: -0.01, probAdj: -0.01 },
      'EU/US Overlap': { edgeAdj: -0.02, probAdj: -0.01 },
      'Europe':        { edgeAdj:  0,    probAdj:  0    },
      'Off-hours':     { edgeAdj: +0.03, probAdj: +0.02 },
    };
    const adj = SESSION_ADJ[session];
    if (adj) {
      minEdge = Math.max(minEdge + adj.edgeAdj, 0.04);
      minProb = Math.max(Math.min(minProb + adj.probAdj, 0.70), 0.52);
    }
  }

  // ═══ Cap combined regime+session penalty ═══
  // Prevent stacking (e.g. choppy +3% + off-hours +3% = +6%) from making entry impossible.
  // Max combined tightening: +3% edge, +3% prob above phase base.
  const MAX_COMBINED_PENALTY = 0.03;
  if (minEdge > baseMinEdge + MAX_COMBINED_PENALTY) {
    minEdge = baseMinEdge + MAX_COMBINED_PENALTY;
  }
  if (minProb > baseMinProb + MAX_COMBINED_PENALTY) {
    minProb = baseMinProb + MAX_COMBINED_PENALTY;
  }

  // ML high-confidence relaxation: when ML probUp >= 0.70 (confidence >= HIGH),
  // the model's 75%+ accuracy justifies relaxing thresholds by 2%
  const mlIsHighConf = mlConfidence !== null && mlConfidence >= ML_CONFIDENCE.HIGH;
  if (mlIsHighConf && mlAgreesWithRules) {
    minEdge = Math.max(minEdge - 0.02, 0.04);
    minProb = Math.max(minProb - 0.02, 0.52);
  }

  // Count agreements if breakdown available (default 0 = conservative, not 99)
  const upAgreement = breakdown ? countAgreement(breakdown, 'UP') : 0;
  const downAgreement = breakdown ? countAgreement(breakdown, 'DOWN') : 0;

  // Check UP side
  // MultiTF waiver: minAgreement+1 indicators can waive multiTF requirement
  const multiTfWaiver = minAgreement + 1;

  const upEdgePass = edgeUp !== null && edgeUp >= minEdge;
  const upProbPass = modelUp >= minProb;
  const upAgreementPass = upAgreement >= minAgreement;
  const upMultiTfPass = !preferMultiTf || multiTfConfirmed || upAgreement >= multiTfWaiver;
  const upPass = upEdgePass && upProbPass && upAgreementPass && upMultiTfPass;

  // Check DOWN side
  const downEdgePass = edgeDown !== null && edgeDown >= minEdge;
  const downProbPass = modelDown >= minProb;
  const downAgreementPass = downAgreement >= minAgreement;
  const downMultiTfPass = !preferMultiTf || multiTfConfirmed || downAgreement >= multiTfWaiver;
  const downPass = downEdgePass && downProbPass && downAgreementPass && downMultiTfPass;

  const regimeLabel = regimeInfo?.label ?? regimeInfo?.regime ?? null;

  if (upPass && downPass) {
    if (edgeUp >= edgeDown) {
      return makeEnter('UP', edgeUp, modelUp, upAgreement, phase, minEdge, minProb, mlIsHighConf, mlAgreesWithRules, regimeLabel);
    } else {
      return makeEnter('DOWN', edgeDown, modelDown, downAgreement, phase, minEdge, minProb, mlIsHighConf, mlAgreesWithRules, regimeLabel);
    }
  }

  if (upPass) {
    return makeEnter('UP', edgeUp, modelUp, upAgreement, phase, minEdge, minProb, mlIsHighConf, mlAgreesWithRules, regimeLabel);
  }

  if (downPass) {
    return makeEnter('DOWN', edgeDown, modelDown, downAgreement, phase, minEdge, minProb, mlIsHighConf, mlAgreesWithRules, regimeLabel);
  }

  // No entry — explain why
  const bestEdge = Math.max(edgeUp ?? -Infinity, edgeDown ?? -Infinity);
  const hasValidEdge = Number.isFinite(bestEdge);
  const bestSide = edgeUp == null && edgeDown == null ? null
    : (edgeUp ?? -1) >= (edgeDown ?? -1) ? 'UP' : 'DOWN';
  const bestProb = bestSide === 'UP' ? modelUp : bestSide === 'DOWN' ? modelDown : Math.max(modelUp, modelDown);
  const bestAgree = bestSide === 'UP' ? upAgreement : bestSide === 'DOWN' ? downAgreement : Math.max(upAgreement, downAgreement);

  const reasons = [];
  if (!hasValidEdge) reasons.push('no valid edge');
  else if (bestEdge < minEdge) reasons.push(`edge ${(bestEdge * 100).toFixed(1)}% < ${(minEdge * 100).toFixed(0)}%`);
  if (bestProb < minProb) reasons.push(`prob ${(bestProb * 100).toFixed(0)}% < ${(minProb * 100).toFixed(0)}%`);
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

  if (edge >= 0.25 && prob >= 0.68 && agreement >= 5) return 'VERY_HIGH';
  if (mlBoost && edge >= 0.15 && prob >= 0.60 && agreement >= 4) return 'VERY_HIGH';
  if (edge >= 0.18 && prob >= 0.62 && agreement >= 4) return 'HIGH';
  if (mlBoost && edge >= 0.10 && prob >= 0.56 && agreement >= 3) return 'HIGH';
  if (edge >= 0.12 && prob >= 0.58 && agreement >= 3) return 'MEDIUM';
  return 'LOW';
}