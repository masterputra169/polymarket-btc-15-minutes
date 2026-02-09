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
 * Compute edge: model probability minus market price.
 */
export function computeEdge({ modelUp, modelDown, marketYes, marketNo }) {
  const edgeUp = marketYes !== null && Number.isFinite(marketYes)
    ? modelUp - marketYes
    : null;
  const edgeDown = marketNo !== null && Number.isFinite(marketNo)
    ? modelDown - marketNo
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

  return { edgeUp, edgeDown, bestSide, bestEdge };
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
    'ptbDistance', 'momentum', 'rsi', 'macdHist', 'macdLine',
    'vwapPos', 'vwapSlope', 'heikenAshi', 'failedVwap', 'orderbook', 'multiTf',
  ];

  for (const key of signalKeys) {
    const entry = breakdown[key];
    if (!entry || entry.weight === 0) continue;

    const signal = entry.signal?.toUpperCase() ?? '';
    if (side === 'UP' && (signal.includes('UP') || signal === 'UP (CONFIRMED)')) count++;
    if (side === 'DOWN' && (signal.includes('DOWN') || signal === 'DOWN (CONFIRMED)')) count++;
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
}) {
  // ═══ Phase thresholds v2 (stricter) ═══
  let phase, minEdge, minProb, minAgreement, preferMultiTf;

  if (remainingMinutes > 10) {
    phase = 'EARLY';
    minEdge = 0.08;
    minProb = 0.60;
    minAgreement = 3;
    preferMultiTf = true;
  } else if (remainingMinutes > 5) {
    phase = 'MID';
    minEdge = 0.10;
    minProb = 0.58;
    minAgreement = 3;
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

  // ML high-confidence relaxation: when ML probUp >= 0.70 (confidence >= 0.40),
  // the model's 75%+ accuracy justifies relaxing thresholds by 2%
  const mlIsHighConf = mlConfidence !== null && mlConfidence >= 0.40;
  if (mlIsHighConf && mlAgreesWithRules) {
    minEdge = Math.max(minEdge - 0.02, 0.04);
    minProb = Math.max(minProb - 0.02, 0.52);
  }

  // Count agreements if breakdown available
  const upAgreement = breakdown ? countAgreement(breakdown, 'UP') : 99;
  const downAgreement = breakdown ? countAgreement(breakdown, 'DOWN') : 99;

  // Check UP side
  const upEdgePass = edgeUp !== null && edgeUp >= minEdge;
  const upProbPass = modelUp >= minProb;
  const upAgreementPass = upAgreement >= minAgreement;
  const upMultiTfPass = !preferMultiTf || multiTfConfirmed || upAgreement >= 4; // 4+ agreement waives multiTF
  const upPass = upEdgePass && upProbPass && upAgreementPass && upMultiTfPass;

  // Check DOWN side
  const downEdgePass = edgeDown !== null && edgeDown >= minEdge;
  const downProbPass = modelDown >= minProb;
  const downAgreementPass = downAgreement >= minAgreement;
  const downMultiTfPass = !preferMultiTf || multiTfConfirmed || downAgreement >= 4;
  const downPass = downEdgePass && downProbPass && downAgreementPass && downMultiTfPass;

  if (upPass && downPass) {
    if (edgeUp >= edgeDown) {
      return makeEnter('UP', edgeUp, modelUp, upAgreement, phase, minEdge, minProb, mlIsHighConf, mlAgreesWithRules);
    } else {
      return makeEnter('DOWN', edgeDown, modelDown, downAgreement, phase, minEdge, minProb, mlIsHighConf, mlAgreesWithRules);
    }
  }

  if (upPass) {
    return makeEnter('UP', edgeUp, modelUp, upAgreement, phase, minEdge, minProb, mlIsHighConf, mlAgreesWithRules);
  }

  if (downPass) {
    return makeEnter('DOWN', edgeDown, modelDown, downAgreement, phase, minEdge, minProb, mlIsHighConf, mlAgreesWithRules);
  }

  // No entry — explain why
  const bestEdge = Math.max(edgeUp ?? -Infinity, edgeDown ?? -Infinity);
  const bestSide = (edgeUp ?? -1) >= (edgeDown ?? -1) ? 'UP' : 'DOWN';
  const bestProb = bestSide === 'UP' ? modelUp : modelDown;
  const bestAgree = bestSide === 'UP' ? upAgreement : downAgreement;

  const reasons = [];
  if (bestEdge < minEdge) reasons.push(`edge ${(bestEdge * 100).toFixed(1)}% < ${(minEdge * 100).toFixed(0)}%`);
  if (bestProb < minProb) reasons.push(`prob ${(bestProb * 100).toFixed(0)}% < ${(minProb * 100).toFixed(0)}%`);
  if (bestAgree < minAgreement) reasons.push(`agree ${bestAgree} < ${minAgreement}`);
  if (preferMultiTf && !multiTfConfirmed && bestAgree < 4) reasons.push('no multiTF confirm');

  return {
    action: 'WAIT',
    side: null,
    confidence: 'NONE',
    phase,
    reason: `${bestSide}: ${reasons.join(', ')}`,
  };
}

function makeEnter(side, edge, prob, agreement, phase, minEdge, minProb, mlHighConf = false, mlAgrees = false) {
  return {
    action: 'ENTER',
    side,
    confidence: getConfidence(edge, prob, agreement, mlHighConf, mlAgrees),
    phase,
    reason: `${side} edge ${(edge * 100).toFixed(1)}%≥${(minEdge * 100).toFixed(0)}%, prob ${(prob * 100).toFixed(0)}%≥${(minProb * 100).toFixed(0)}%, ${agreement} indicators agree${mlHighConf ? ', ML high-conf' : ''}`,
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