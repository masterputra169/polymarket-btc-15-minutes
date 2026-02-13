/**
 * Feature extraction and engineered feature computation.
 */

import { MAX_FEATURES } from './state.js';
import * as S from './state.js';
import { FI } from './featureMap.js';

// Pre-allocated buffer (ZERO allocation per prediction)
export const featureBuf = new Float64Array(MAX_FEATURES);

/**
 * Compute 25 engineered features in-place in featureBuf[52..76].
 */
export function computeEngineeredFeaturesInPlace() {
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
  featureBuf[52] = Math.max(-clip, Math.min(clip, delta1m));
  featureBuf[53] = delta1m - (delta3m / 3);
  featureBuf[54] = rsi * regTrend;
  featureBuf[55] = rsi * regConf;
  featureBuf[56] = rsi * regMR;
  featureBuf[57] = delta1m * multiTf;
  featureBuf[58] = bbPctB * bbSqueeze;
  featureBuf[59] = volBuy * sign(delta1m);
  featureBuf[60] = vwapDist * sign(vwapSlope);
  featureBuf[61] = sign(delta3m) * (-rsiSlope);
  featureBuf[62] = (rsi + stochK + bbPctB) / 3;
  featureBuf[63] = (sign(haConsec) === sign(delta1m)) ? 1 : 0;

  const atrSafe = Math.max(atrPct, 0.01);
  featureBuf[64] = delta1m / atrSafe;
  featureBuf[65] = sign(vwapDist) * 0.4 + (bbPctB - 0.5) * 0.3 + (emaCross - 0.5) * 0.3;
  featureBuf[66] = delta1m * volRatio;
  featureBuf[67] = sign(macdLine) * rsiSlope;
  featureBuf[68] = regTrend * multiTf * sign(delta1m);
  featureBuf[69] = Math.max(rsi - 0.7, 0) + Math.max(0.3 - rsi, 0);
  featureBuf[70] = volBuy * sign(delta1m) * volRatio;
  featureBuf[71] = bbSqueeze * Math.abs(stochK - 0.5) * 2;

  const deltaDir = sign(delta1m);
  const macdHist = featureBuf[FI.macd_hist];
  const agreeCount = (
    (sign(haConsec) === deltaDir ? 1 : 0) +
    (sign(macdHist) === deltaDir ? 1 : 0) +
    (sign(featureBuf[FI.vwap_dist]) === deltaDir ? 1 : 0) +
    ((rsi > 0.5 ? 1 : -1) === deltaDir ? 1 : 0) +
    multiTf
  );
  featureBuf[72] = agreeCount / 5;
  featureBuf[73] = Math.max(stochK - 0.8, 0) * 5 + Math.max(0.2 - stochK, 0) * 5;

  const mktMomentum = featureBuf[FI.market_price_momentum];
  featureBuf[74] = sign(mktMomentum) * sign(delta1m);

  const crowdDiv = featureBuf[FI.crowd_model_divergence];
  const ruleConf = featureBuf[FI.rule_confidence];
  featureBuf[75] = crowdDiv * ruleConf;

  const obImbalance = featureBuf[FI.orderbook_imbalance];
  featureBuf[76] = obImbalance * volBuy;
}

/**
 * Extract 52 base features into featureBuf (in-place, zero alloc).
 * If model is v2, also computes 25 engineered features [52-76].
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
}) {
  const ptbDistPct = priceToBeat && price ? (price - priceToBeat) / priceToBeat : 0;
  const isGreen = heikenColor === 'green';
  const haSignedConsec = isGreen ? (heikenCount || 0) : -(heikenCount || 0);
  const volRatio = volumeAvg > 0 ? (volumeRecent || 0) / volumeAvg : 1;

  featureBuf[0]  = ptbDistPct;
  featureBuf[1]  = (rsi ?? 50) / 100;
  featureBuf[2]  = rsiSlope ?? 0;
  featureBuf[3]  = macd?.hist ?? 0;
  featureBuf[4]  = macd?.line ?? 0;
  featureBuf[5]  = vwap ? (price - vwap) / vwap : 0;
  featureBuf[6]  = vwapSlope ?? 0;
  featureBuf[7]  = haSignedConsec / 15;
  featureBuf[8]  = delta1m && price > 0 ? delta1m / price : 0;
  featureBuf[9]  = delta3m && price > 0 ? delta3m / price : 0;
  featureBuf[10] = Math.min(volRatio, 5) / 5;
  featureBuf[11] = (minutesLeft ?? 7.5) / 15;
  featureBuf[12] = Math.max(0, Math.min(1, ruleProbUp ?? 0.5));
  featureBuf[13] = ruleConfidence ?? 0;
  featureBuf[14] = Math.min(vwapCrossCount ?? 0, 10) / 10;
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
  featureBuf[26] = multiTfAgreement             ? 1 : 0;
  featureBuf[27] = failedVwapReclaim            ? 1 : 0;

  featureBuf[28] = bbWidth ?? 0;
  featureBuf[29] = bbPercentB != null ? bbPercentB : 0.5;
  featureBuf[30] = bbSqueeze ? 1 : 0;

  featureBuf[31] = atrPct != null ? Math.min(atrPct, 2) / 2 : 0.5;
  featureBuf[32] = atrRatio != null ? Math.min(atrRatio, 3) / 3 : 0.33;
  featureBuf[33] = (atrRatio ?? 1) > 1.1 ? 1 : 0;

  featureBuf[34] = volDeltaBuyRatio != null ? volDeltaBuyRatio : 0.5;
  featureBuf[35] = volDeltaAccel != null ? Math.max(-0.5, Math.min(0.5, volDeltaAccel)) + 0.5 : 0.5;

  featureBuf[36] = emaDistPct != null ? Math.max(-1, Math.min(1, emaDistPct * 10)) / 2 + 0.5 : 0.5;
  featureBuf[37] = emaCrossSignal != null ? (emaCrossSignal + 1) / 2 : 0.5;

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

  if (S.modelVersion >= 2) {
    computeEngineeredFeaturesInPlace();
  }

  return featureBuf;
}
