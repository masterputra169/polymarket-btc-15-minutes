/**
 * Feature extraction and engineered feature computation.
 */

import * as S from './state.js';
import { FI } from './featureMap.js';

// Pre-allocated buffer — sized for max model (84 = 59 base + 25 engineered)
export const featureBuf = new Float64Array(84);

/**
 * Compute 25 engineered features in-place starting at featureBuf[BASE_FEATURES].
 * Offset adapts: v9 → starts at [54], v9a+ → starts at [59].
 */
export function computeEngineeredFeaturesInPlace() {
  const O = S.BASE_FEATURES; // engineered feature offset
  const sign = (v) => v > 0 ? 1 : v < 0 ? -1 : 0;

  const delta1m   = featureBuf[FI.delta_1m_pct];
  const delta3m   = featureBuf[FI.delta_3m_pct];
  const rsi       = featureBuf[FI.rsi_norm];
  const rsiSlope  = featureBuf[FI.rsi_slope];
  const vwapDist  = featureBuf[FI.vwap_dist];
  const vwapSlope = featureBuf[FI.vwap_slope];
  const macdLine  = featureBuf[FI.macd_line];
  const volRatio  = featureBuf[FI.vol_ratio_norm];
  const multiTf   = featureBuf[FI.multi_tf_agreement];
  const bbPctB    = featureBuf[FI.bb_percent_b];
  const bbSqueeze = featureBuf[FI.bb_squeeze];
  const atrPct    = featureBuf[FI.atr_pct_norm];
  const volBuy    = featureBuf[FI.vol_delta_buy_ratio];
  const emaCross  = featureBuf[FI.ema_cross_signal];
  const stochK    = featureBuf[FI.stoch_k_norm];
  const haConsec  = featureBuf[FI.ha_signed_consec];
  const regTrend  = featureBuf[FI.regime_trending];
  const regConf   = featureBuf[FI.regime_confidence];
  const regMR     = featureBuf[FI.regime_mean_reverting];

  const clip = 0.003;
  featureBuf[O + 0]  = Math.max(-clip, Math.min(clip, delta1m));
  featureBuf[O + 1]  = delta1m - (delta3m / 3);
  featureBuf[O + 2]  = rsi * regTrend;
  featureBuf[O + 3]  = rsi * regConf;
  featureBuf[O + 4]  = rsi * regMR;
  featureBuf[O + 5]  = delta1m * multiTf;
  featureBuf[O + 6]  = bbPctB * bbSqueeze;
  featureBuf[O + 7]  = volBuy * sign(delta1m);
  featureBuf[O + 8]  = vwapDist * sign(vwapSlope);
  featureBuf[O + 9]  = sign(delta3m) * (-rsiSlope);
  featureBuf[O + 10] = (rsi + stochK + bbPctB) / 3;
  featureBuf[O + 11] = (sign(haConsec) === sign(delta1m)) ? 1 : 0;

  const atrSafe = Math.max(atrPct, 0.01);
  featureBuf[O + 12] = delta1m / atrSafe;
  featureBuf[O + 13] = sign(vwapDist) * 0.4 + (bbPctB - 0.5) * 0.3 + (emaCross - 0.5) * 0.3;
  featureBuf[O + 14] = delta1m * volRatio;
  featureBuf[O + 15] = sign(macdLine) * rsiSlope;
  featureBuf[O + 16] = regTrend * multiTf * sign(delta1m);
  featureBuf[O + 17] = Math.max(rsi - 0.7, 0) + Math.max(0.3 - rsi, 0);
  featureBuf[O + 18] = volBuy * sign(delta1m) * volRatio;
  featureBuf[O + 19] = bbSqueeze * Math.abs(stochK - 0.5) * 2;

  // L6: Removed `deltaDir !== 0` guard — training computes sign comparisons naturally
  const deltaDir = sign(delta1m);
  const macdHist = featureBuf[FI.macd_hist];
  const agreeCount = (
    (sign(haConsec) === deltaDir ? 1 : 0) +
    (sign(macdHist) === deltaDir ? 1 : 0) +
    (sign(featureBuf[FI.vwap_dist]) === deltaDir ? 1 : 0) +
    ((rsi > 0.5 ? 1 : 0) === (deltaDir > 0 ? 1 : 0) ? 1 : 0) +
    (multiTf > 0.5 ? 1 : 0)
  );
  featureBuf[O + 20] = agreeCount / 5;
  featureBuf[O + 21] = Math.max(stochK - 0.8, 0) * 5 + Math.max(0.2 - stochK, 0) * 5;

  const mktMomentum = featureBuf[FI.market_price_momentum];
  featureBuf[O + 22] = sign(mktMomentum) * sign(delta1m);

  const crowdDiv = featureBuf[FI.crowd_model_divergence];
  const ruleConf = featureBuf[FI.rule_confidence];
  featureBuf[O + 23] = crowdDiv * ruleConf;

  const obImbalance = featureBuf[FI.orderbook_imbalance];
  featureBuf[O + 24] = obImbalance * volBuy;
}

/**
 * H5 FIX: Data quality tracking.
 * Tracks how many features used fallback/default values vs real data.
 * Exported alongside the feature vector so callers can gate on it.
 */
let _lastDataQualityScore = 1.0;
let _lastFallbackCount = 0;

/** Get the data quality score from the last extractLiveFeaturesInPlace() call. */
export function getDataQualityScore() {
  return {
    dataQualityScore: _lastDataQualityScore,
    fallbackCount: _lastFallbackCount,
    isSufficient: _lastDataQualityScore >= 0.7,
  };
}

/**
 * Extract 59 base features into featureBuf (in-place, zero alloc).
 * If model is v2+, also computes 25 engineered features [59-83].
 *
 * H5 FIX: Tracks data freshness — counts how many features used fallback defaults.
 * Call getDataQualityScore() after this to retrieve the result.
 */
export function extractLiveFeaturesInPlace({
  price, priceToBeat, rsi, rsiSlope, macd, vwap, vwapSlope,
  heikenColor, heikenCount, delta1m, delta3m, volumeRecent, volumeAvg,
  regime, regimeConfidence, session, minutesLeft, ruleProbUp, ruleConfidence,
  vwapCrossCount, bestEdge, multiTfAgreement, failedVwapReclaim,
  bbWidth, bbPercentB, bbSqueeze, bbSqueezeIntensity,
  atrPct, atrRatio,
  volDeltaBuyRatio, volDeltaAccel,
  emaDistPct, emaCrossSignal,
  stochK, stochKD,
  marketYesPrice, marketPriceMomentum, orderbookImbalance, spreadPct,
  momentum5CandleSlope, volatilityChangeRatio, priceConsistency,
  fundingRate,
  smBullRatio, smFlowIntensity, smEarlySignal, smFlowAccel, smActivity,
}) {
  // H5: Track fallback usage — each key indicator group that falls back increments this.
  // We track the 18 "primary data" features (not session/regime one-hots or time/clock).
  let fallbackCount = 0;
  const TRACKED_FEATURE_COUNT = 18;

  const ptbDistPct = priceToBeat && price ? (price - priceToBeat) / priceToBeat : 0;
  if (!priceToBeat || !price) fallbackCount++;

  const isGreen = heikenColor === 'green';
  const haSignedConsec = isGreen ? (heikenCount || 0) : -(heikenCount || 0);
  const volRatio = volumeAvg > 0 ? (volumeRecent || 0) / volumeAvg : 1;

  featureBuf[0]  = ptbDistPct;

  // RSI
  if (rsi == null) fallbackCount++;
  featureBuf[1]  = (rsi ?? 50) / 100;
  featureBuf[2]  = rsiSlope ?? 0;

  // MACD
  if (!macd || (macd.hist == null && macd.line == null)) fallbackCount++;
  featureBuf[3]  = macd?.hist ?? 0;
  featureBuf[4]  = macd?.line ?? 0;

  // VWAP
  if (!vwap) fallbackCount++;
  featureBuf[5]  = vwap ? (price - vwap) / vwap : 0;
  featureBuf[6]  = vwapSlope ?? 0;

  // Heiken Ashi
  if (!heikenColor) fallbackCount++;
  featureBuf[7]  = haSignedConsec / 15;

  // Deltas
  if (delta1m == null) fallbackCount++;
  if (delta3m == null) fallbackCount++;
  featureBuf[8]  = delta1m != null && price > 0 ? delta1m / price : 0;
  featureBuf[9]  = delta3m != null && price > 0 ? delta3m / price : 0;

  // Volume
  if (!volumeAvg || volumeAvg <= 0) fallbackCount++;
  featureBuf[10] = Math.min(volRatio, 5) / 5;
  featureBuf[11] = (minutesLeft ?? 7.5) / 15;
  featureBuf[12] = Math.max(0, Math.min(1, ruleProbUp ?? 0.5));
  featureBuf[13] = ruleConfidence ?? 0;
  featureBuf[14] = Math.min(vwapCrossCount ?? 0, 10) / 10;
  // DESIGN NOTE (circular dependency audit): bestEdge is the RULE-based edge from
  // the SAME tick (ruleEdge = computeEdge(ruleProbUp, marketPrice)). It is NOT a
  // feedback loop from a prior candle's ML output. The flow is:
  //   1. Rule engine scores indicators → ruleProbUp
  //   2. computeEdge(ruleProbUp, marketPrice) → ruleEdge.bestEdge
  //   3. This value enters the ML feature vector as feature[15]
  //   4. ML produces mlProbUp → final ensemble edge (separate from ruleEdge)
  // This is intentional stacking (ML sees how the rule engine rates the current state)
  // and does NOT create a temporal feedback loop.
  featureBuf[15] = Math.max(0, Math.min(bestEdge ?? 0, 0.5));

  featureBuf[16] = regime === 'trending'       ? 1 : 0;
  featureBuf[17] = Math.max(0, Math.min(1, regimeConfidence ?? 0.5));
  featureBuf[18] = regime === 'mean_reverting' ? 1 : 0;
  featureBuf[19] = regime === 'moderate' || regime === 'choppy' ? 1 : 0;

  featureBuf[20] = session === 'Asia'           ? 1 : 0;
  featureBuf[21] = session === 'Europe'         ? 1 : 0;
  featureBuf[22] = session === 'US'             ? 1 : 0;
  featureBuf[23] = session === 'EU/US Overlap'  ? 1 : 0;
  featureBuf[24] = session === 'Off-hours'      ? 1 : 0;

  featureBuf[25] = isGreen                      ? 1 : 0;
  featureBuf[26] = Number.isFinite(multiTfAgreement) ? multiTfAgreement : (multiTfAgreement ? 1 : 0);
  featureBuf[27] = failedVwapReclaim            ? 1 : 0;

  // Bollinger
  if (bbPercentB == null && bbWidth == null) fallbackCount++;
  featureBuf[28] = bbWidth ?? 0;
  featureBuf[29] = bbPercentB != null ? bbPercentB : 0.5;
  featureBuf[30] = bbSqueeze ? 1 : 0;

  // ATR
  if (atrPct == null && atrRatio == null) fallbackCount++;
  featureBuf[31] = atrPct != null ? Math.min(atrPct, 2) / 2 : 0.5;
  featureBuf[32] = atrRatio != null ? Math.min(atrRatio, 3) / 3 : 0.33;
  featureBuf[33] = (atrRatio ?? 1) > 1.1 ? 1 : 0;

  // Volume Delta
  if (volDeltaBuyRatio == null) fallbackCount++;
  featureBuf[34] = volDeltaBuyRatio != null ? volDeltaBuyRatio : 0.5;
  featureBuf[35] = volDeltaAccel != null ? Math.max(-0.5, Math.min(0.5, volDeltaAccel)) + 0.5 : 0.5;

  // EMA
  if (emaDistPct == null && emaCrossSignal == null) fallbackCount++;
  featureBuf[36] = emaDistPct != null ? Math.max(-1, Math.min(1, emaDistPct * 10)) / 2 + 0.5 : 0.5;
  featureBuf[37] = emaCrossSignal != null ? (emaCrossSignal + 1) / 2 : 0.5;

  // StochRSI
  if (stochK == null) fallbackCount++;
  featureBuf[38] = stochK != null ? stochK / 100 : 0.5;
  featureBuf[39] = stochKD != null ? Math.max(-50, Math.min(50, stochKD)) / 100 + 0.5 : 0.5;

  // volume_acceleration: recent 5-candle volume vs prior 5-candle volume ratio, normalized [0,1]
  const volAccel = volumeAvg > 0 && volumeRecent > 0
    ? Math.min((volumeRecent / volumeAvg), 3) / 3 : 0.5;
  featureBuf[40] = volAccel;
  // bb_squeeze_intensity: Bollinger squeeze intensity [0,1]
  featureBuf[41] = Math.max(0, Math.min(1, bbSqueezeIntensity ?? 0));

  const now = new Date();
  const hourUTC = now.getUTCHours() + now.getUTCMinutes() / 60;
  featureBuf[42] = Math.sin(hourUTC / 24 * 2 * Math.PI);
  featureBuf[43] = Math.cos(hourUTC / 24 * 2 * Math.PI);

  // Market price
  if (marketYesPrice == null) fallbackCount++;
  const mktYes = marketYesPrice ?? 0.5;
  featureBuf[44] = Math.max(0.01, Math.min(0.99, mktYes));
  featureBuf[45] = Math.max(-0.1, Math.min(0.1, marketPriceMomentum ?? 0));
  featureBuf[46] = Math.max(-1, Math.min(1, orderbookImbalance ?? 0));
  featureBuf[47] = Math.max(0, Math.min(1, spreadPct ?? 0.02));
  featureBuf[48] = Math.abs((ruleProbUp ?? 0.5) - mktYes);

  // [49-51] Temporal features (v9+)
  featureBuf[49] = Math.max(-0.01, Math.min(0.01, momentum5CandleSlope ?? 0));
  featureBuf[50] = Math.min((volatilityChangeRatio ?? 1), 3) / 3;
  featureBuf[51] = priceConsistency ?? 0.5;

  // [52-53] Funding rate features (v10a+)
  const fr = fundingRate?.ratePct ?? 0;
  featureBuf[52] = Math.max(-1, Math.min(1, fr / 0.1));  // funding_rate_norm
  featureBuf[53] = 0; // funding_rate_change (no historical comparison live)

  // [54-58] Smart money features — only written when model has 59 base features (v9a+)
  if (S.BASE_FEATURES >= 59) {
    // H11: Track SM fallbacks in data quality score
    if (smBullRatio == null && smFlowIntensity == null && smActivity == null) fallbackCount++;
    featureBuf[54] = smBullRatio ?? 0.5;       // sm_bull_ratio
    featureBuf[55] = smFlowIntensity ?? 0;     // sm_flow_intensity
    featureBuf[56] = smEarlySignal ?? 0.5;     // sm_early_signal
    featureBuf[57] = smFlowAccel ?? 0;         // sm_flow_accel
    featureBuf[58] = smActivity ?? 0;          // sm_activity
  }

  if (S.modelVersion >= 2) {
    computeEngineeredFeaturesInPlace(); // writes at [BASE_FEATURES..BASE_FEATURES+24]
  } else {
    featureBuf.fill(0, S.BASE_FEATURES, S.MAX_FEATURES);
  }

  // H5: Compute and store data quality score
  _lastFallbackCount = fallbackCount;
  _lastDataQualityScore = Math.max(0, 1 - fallbackCount / TRACKED_FEATURE_COUNT);

  return featureBuf;
}
