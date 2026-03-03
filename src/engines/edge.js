import { ML_CONFIDENCE, polyFeeRate } from '../config.js';

/**
 * ═══ Edge & Decision Engine v2 ═══
 *
 * v3 changes (frequency + win rate optimization):
 * 1. Lowered edge thresholds (8-15% → 6-12%) — old thresholds blocked too many profitable trades
 * 2. Fixed trending regime: now RELAXES aligned signals, TIGHTENS counter-trend (was tightening all)
 * 3. Reduced regime/session penalties to prevent stacking to impossible levels
 * 4. Reduced UP side bias (+2% → +1%) to collect more UP trade data
 *
 * v4 changes (Pendekatan B — price-scaled edge requirement):
 * 5. Added price-scaled extra edge: +0.70% per 1% above price floor 0.60.
 *    Data: entries at 0.65-0.70 have 46% WR (break-even = 65%) → net losing.
 *    Entries at 0.70-0.75 have 93% WR (above 70% break-even) → profitable.
 *    Fix: price 0.65→+3.5% extra | price 0.68→+5.6% extra | price 0.70→+7% extra.
 *    High-confidence 0.70+ entries still pass (model 85%+ agrees with strong market signal).
 *    Low-quality 0.65-0.70 entries now blocked unless model is 80%+ confident.
 *
 * PHASE TABLE v5 (frequency fix: lowered to match Polymarket's efficient pricing):
 * | Phase     | Time Left | Min Edge | Min Prob | Min Agreement | MultiTF Req |
 * |-----------|-----------|----------|----------|---------------|-------------|
 * | EARLY     | > 10 min  | 6%       | 60%      | 3             | preferred   |
 * | MID       | 5-10 min  | 7%       | 58%      | 3             | preferred   |
 * | LATE      | 2-5 min   | 5%       | 57%      | 2             | no          |
 * | VERY_LATE | < 2 min   | 7%       | 56%      | 2             | no          |
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

  // H3: Subtract expected Polymarket taker fee from edge.
  // Fee is on profit (1 - price). Dynamic formula (Feb 2026): feeRate = 0.25 × (p×(1−p))².
  // At 65c: 1.29% (was flat 2%), at 70c: 1.10%, at 50c: 1.56% (max).
  const feeAdjUp = effectiveUp != null && Number.isFinite(effectiveUp) ? polyFeeRate(effectiveUp) * (1 - effectiveUp) : 0;
  const feeAdjDown = effectiveDown != null && Number.isFinite(effectiveDown) ? polyFeeRate(effectiveDown) * (1 - effectiveDown) : 0;

  const edgeUp = effectiveUp !== null && Number.isFinite(effectiveUp)
    ? modelUp - effectiveUp - spreadPenaltyUp - feeAdjUp
    : null;
  const edgeDown = effectiveDown !== null && Number.isFinite(effectiveDown)
    ? modelDown - effectiveDown - spreadPenaltyDown - feeAdjDown
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

  return { edgeUp, edgeDown, bestSide, bestEdge, spreadPenaltyUp, spreadPenaltyDown, effectiveUp, effectiveDown };
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
 * @param {Object|null} [params.smartFlowSignal] - from smartMoneyTracker { direction, strength, confidence, window }
 * @returns {{ action: string, side: string|null, confidence: string, phase: string, reason: string }}
 */
export function decide({
  remainingMinutes,
  edgeUp,
  edgeDown,
  modelUp,
  modelDown,
  effectiveUp = null,           // raw execution price (bestAsk or mid) — for Pendekatan B
  effectiveDown = null,
  breakdown = null,
  multiTfConfirmed = false,
  mlConfidence = null,
  mlAgreesWithRules = false,
  regimeInfo = null,
  session = null,
  calibratedThresholds = null,  // from norm_browser.json phase_thresholds (audit H3)
  smartFlowSignal = null,       // from smartMoneyTracker (time-windowed CLOB flow)
  dataQualityScore = null,       // Audit v4 M11: from ML feature extraction (0-1)
}) {
  // ═══ Phase thresholds — calibrated from holdout if available, else v3 defaults ═══
  let phase, minEdge, minProb, minAgreement, preferMultiTf;
  const cal = calibratedThresholds;

  if (remainingMinutes > 10) {
    phase = 'EARLY';
    minEdge = cal?.EARLY?.minEdge ?? 0.06;
    minProb = cal?.EARLY?.minProb ?? 0.60;
    minAgreement = 3;
    preferMultiTf = true;
  } else if (remainingMinutes > 5) {
    phase = 'MID';
    minEdge = cal?.MID?.minEdge ?? 0.07;
    minProb = cal?.MID?.minProb ?? 0.58;
    minAgreement = 3;
    preferMultiTf = true;
  } else if (remainingMinutes > 2) {
    phase = 'LATE';
    minEdge = cal?.LATE?.minEdge ?? 0.07;    // Audit v4 M12: 0.05→0.07 — LATE was inverted (lower than EARLY 6%); 7% restores monotonic phase progression
    minProb = cal?.LATE?.minProb ?? 0.57;
    minAgreement = 2;                         // v5: 3→2 — late phase signals converge, fewer families strongly agree
    preferMultiTf = false;
  } else {
    phase = 'VERY_LATE';
    minEdge = cal?.VERY_LATE?.minEdge ?? 0.07;  // v5: 0.15→0.07 — was impossible to meet at premium token prices
    minProb = cal?.VERY_LATE?.minProb ?? 0.56;
    minAgreement = 2;                            // v5: 3→2 — same rationale as LATE
    preferMultiTf = false;
  }

  // ═══ Regime-adaptive thresholds ═══
  // Save base thresholds before adjustments to cap combined penalty
  const baseMinEdge = minEdge;
  const baseMinProb = minProb;

  if (regimeInfo && regimeInfo.regime) {
    // M1: Cap at 0.95 — ATR-confirmed regime with 99% confidence shouldn't be limited to 85%.
    // TODO: backtest whether uncapped (1.0) improves PnL vs current 0.95 cap.
    const scale = Math.min(regimeInfo.confidence ?? 0.5, 0.95);
    switch (regimeInfo.regime) {
      case 'trending':
        // v3: Direction-aware — old code tightened ALL trending (33% WR was from counter-trend entries).
        // Aligned signals in trends are strong; counter-trend is what loses.
        // M6: Use best EDGE side (not model side) for regime direction check.
        // Model side = higher probability, but edge side = higher (prob - price).
        // Edge side accounts for market pricing, avoiding false alignment when market already agrees.
        {
          const trendDir = regimeInfo.direction; // 'UP' or 'DOWN'
          const bestEdgeSide = (edgeUp ?? -Infinity) >= (edgeDown ?? -Infinity) ? 'UP' : 'DOWN';
          if (trendDir && bestEdgeSide === trendDir) {
            // Aligned with trend: NO relaxation — data (Feb 23-25): trending 66.7% WR, +$0.03 (breakeven)
            // Relaxation was counterproductive; keep base thresholds for aligned signals.
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

  // Audit v4 M11: Data quality gate — when feature extraction quality is poor, require more edge
  if (dataQualityScore != null && dataQualityScore < 0.70) {
    minEdge = Math.min(minEdge + 0.03, 0.25);
  }

  // ML high-confidence relaxation: when ML probUp >= 0.70 (confidence >= HIGH),
  // the model's 75%+ accuracy justifies relaxing thresholds by 2%
  // v5: Floor lowered 0.04→0.02 — edge is already net of spread+fees; 2% floor = genuine edge.
  // v6: Tiered by ML confidence level:
  //   conf ≥ 0.90: relax 3%, floor 1.5% (extremely high trust — 74%+ accuracy)
  //   conf ≥ 0.75: relax 2%, floor 2.0% (very high trust)
  //   conf ≥ HIGH(0.58): relax 2%, floor 3.0% (moderate trust)
  // v6: Agreement reduction — ML as independent "family" (74%+ accuracy at high conf).
  //   When ML ≥ 80% and agrees with rules, minAgreement -= 1 (min 1).
  //   Fixes: P:93% E:5.9% ML:98% → WAIT because agreement < 2 (structural deadlock).
  // v7: ML trust-alone — when ML ≥ 85%, apply relaxation even when rules disagree.
  //   Root cause: rule-based adjustedUp can be ~50% (mixed indicators) while ML is 95%.
  //   mlAgreesWithRules = false → no relaxation → Off-hours +2% makes minEdge 9% > edge 8.5% → WAIT.
  //   At 85%+ conf (84% accuracy on 45K samples), ML should override noisy indicator disagreement.
  //   Also allows minAgreement = 0 when ML is sole signal (no family agreement needed).
  const mlIsHighConf = mlConfidence !== null && mlConfidence >= ML_CONFIDENCE.HIGH;
  const mlTrustAlone = mlConfidence !== null && mlConfidence >= 0.85;
  if (mlIsHighConf && (mlAgreesWithRules || mlTrustAlone)) {
    const mlRelax = mlConfidence >= 0.90 ? 0.03 : 0.02;
    const mlFloor = mlConfidence >= 0.90 ? 0.015 : mlConfidence >= 0.75 ? 0.02 : 0.03;
    minEdge = Math.max(minEdge - mlRelax, mlFloor);
    minProb = Math.max(minProb - 0.02, 0.52);
    // ML counts as one independent agreement family — reduce required indicator agreement
    // v7: At 85%+ conf trusting alone, ML substitutes for ALL indicator families:
    //   - minAgreement = 0 (no family agreement needed)
    //   - preferMultiTf = false (skip 5m timeframe confirmation)
    //   Root cause: BTC > PTB but indicators see recent downtrend → agreement=0, multiTf=false
    //   ML (94% conf, 84% accuracy on 45K samples) correctly predicts UP from full feature set
    if (mlTrustAlone) {
      minAgreement = 0;
      preferMultiTf = false;
    } else if (mlConfidence >= 0.80) {
      minAgreement = Math.max(minAgreement - 1, 1);
    }
  }

  // ═══ Smart money flow adjustment ═══
  // Early flow (82.8% accuracy): relax thresholds when flow agrees with best model side.
  // Late flow (56.3%): tighten — flow is noise, reduce reliance on it.
  // M2: Smart flow confidence gate raised 0.30→0.50 — 30% confidence signals are noise
  if (smartFlowSignal && smartFlowSignal.confidence > 0.50) {
    const bestModelSide = modelUp >= modelDown ? 'UP' : 'DOWN';
    const flowAgrees = smartFlowSignal.direction === bestModelSide;
    const flowStrength = smartFlowSignal.strength ?? 0;

    if (smartFlowSignal.window === 'EARLY' && flowAgrees && flowStrength > 0.3) {
      // Early flow agrees: relax by up to 1.5% (scaled by strength)
      const relax = 0.015 * flowStrength;
      minEdge = Math.max(minEdge - relax, 0.04);
      minProb = Math.max(minProb - relax, 0.52);
    } else if (smartFlowSignal.window === 'LATE') {
      // Late flow: tighten by 1% — discount noisy late-market flow signals
      minEdge = Math.min(minEdge + 0.01, 0.25);
    }
  }

  // ═══ Quant fix H4: Side bias REMOVED ═══
  // Previous: UP +1% harder, DOWN -0.5% easier (for data collection purposes).
  // Removed: no empirical evidence showing one side is systematically harder to predict.
  // Bias was hurting UP entries without improving WR — use symmetric thresholds.
  let upMinEdge = minEdge;
  let upMinProb = minProb;
  let downMinEdge = minEdge;
  let downMinProb = minProb;

  // ═══ Cap combined regime+session penalty ═══
  // Prevent stacking (e.g. choppy +2% + off-hours +2% = +4%) from making entry impossible.
  // M4: 4% cap is empirically chosen to allow ~1 trade/hour in worst conditions (choppy+off-hours).
  // TODO: validate via backtest that 4% doesn't leave money on the table in moderate conditions.
  const MAX_COMBINED_PENALTY = 0.04;  // max 4% above base threshold
  upMinEdge = Math.min(upMinEdge, baseMinEdge + MAX_COMBINED_PENALTY);
  upMinProb = Math.min(upMinProb, baseMinProb + MAX_COMBINED_PENALTY);
  downMinEdge = Math.min(downMinEdge, baseMinEdge + MAX_COMBINED_PENALTY);
  downMinProb = Math.min(downMinProb, baseMinProb + MAX_COMBINED_PENALTY);

  // ═══ Pendekatan B: Price-scaled edge requirement ═══
  // Data: entries at 0.65-0.70 → 46% WR (break-even 65%) = zona rugi.
  // Entries at 0.70-0.75 → 93% WR = profitable karena model conviction tinggi.
  // v5: ML confidence gate — skip penalty when ML conf >= 0.65 (high-conviction entries
  // at premium prices are profitable; the 46% WR was from LOW-conviction expensive entries).
  // v5: PRICE_SCALE 0.70→0.35, PRICE_FLOOR 0.60→0.65 — old values created structural deadlock:
  //   at 0.71c token: +7.7% extra → minEdge 18%+ but natural edge only 3-5% → IMPOSSIBLE.
  {
    const PRICE_FLOOR = 0.65;
    const PRICE_SCALE = 0.35;
    const mlConfBypass = mlConfidence !== null && mlConfidence >= 0.65;
    if (!mlConfBypass) {
      // C4 fix: use raw effective prices directly, not reconstructed from edge
      // (edge = model - effective - spread - fee, so model - edge = effective + spread + fee, overstating price)
      const priceUp   = effectiveUp   ?? (edgeUp   != null ? Math.max(0, modelUp   - edgeUp)   : null);
      const priceDown = effectiveDown ?? (edgeDown != null ? Math.max(0, modelDown - edgeDown) : null);
      if (priceUp   != null && priceUp   > PRICE_FLOOR) {
        upMinEdge   = Math.min(upMinEdge   + (priceUp   - PRICE_FLOOR) * PRICE_SCALE, 0.30);
      }
      if (priceDown != null && priceDown > PRICE_FLOOR) {
        downMinEdge = Math.min(downMinEdge + (priceDown - PRICE_FLOOR) * PRICE_SCALE, 0.30);
      }
    }
  }

  // Count agreements if breakdown available (default 0 = conservative, not 99)
  const upAgreement = breakdown ? countAgreement(breakdown, 'UP') : 0;
  const downAgreement = breakdown ? countAgreement(breakdown, 'DOWN') : 0;

  // Check UP side (stricter thresholds)
  // M5: MultiTF waiver: EARLY needs minAgreement+2 (strong conviction to skip 5m confirm),
  // other phases: minAgreement+1 (less time = less confirmation needed)
  const multiTfWaiver = phase === 'EARLY' ? minAgreement + 2 : minAgreement + 1;

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