/**
 * Feature index constants and named-feature resolution.
 */

import * as S from './state.js';

export const FI = {
  ptb_dist_pct: 0, rsi_norm: 1, rsi_slope: 2, macd_hist: 3, macd_line: 4,
  vwap_dist: 5, vwap_slope: 6, ha_signed_consec: 7, delta_1m_pct: 8,
  delta_3m_pct: 9, vol_ratio_norm: 10, minutes_left_norm: 11,
  rule_prob_up: 12, rule_confidence: 13, vwap_cross_count_norm: 14,
  best_edge: 15, regime_trending: 16, regime_choppy: 17,
  regime_mean_reverting: 18, regime_moderate: 19, session_asia: 20,
  session_europe: 21, session_us: 22, session_overlap: 23,
  session_offhours: 24, ha_is_green: 25, multi_tf_agreement: 26,
  failed_vwap_reclaim: 27, bb_width: 28, bb_percent_b: 29, bb_squeeze: 30,
  atr_pct_norm: 31, atr_ratio_norm: 32, atr_expanding: 33,
  vol_delta_buy_ratio: 34, vol_delta_accel: 35, ema_dist_norm: 36,
  ema_cross_signal: 37, stoch_k_norm: 38, stoch_kd_norm: 39,
  funding_rate_norm: 40, funding_sentiment: 41,
  hour_sin: 42, hour_cos: 43,
  market_yes_price: 44, market_price_momentum: 45, orderbook_imbalance: 46,
  spread_pct: 47, crowd_model_divergence: 48,
};

export function resolveFeatureIdx(splitName) {
  if (S.featureNameToIdx) {
    const idx = S.featureNameToIdx.get(splitName);
    if (idx !== undefined) return idx;
  }
  if (splitName[0] === 'f') {
    const idx = parseInt(splitName.slice(1), 10);
    if (!isNaN(idx)) return idx;
  }
  return -1;
}
