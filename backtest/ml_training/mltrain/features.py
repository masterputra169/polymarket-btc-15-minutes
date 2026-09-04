"""The 25 engineered features layered on top of the base feature set.

Pure transformation: takes the raw feature matrix and its column names, returns
the widened matrix plus the full column-name list. No global state, so the exact
feature maths the model is trained on can be unit-tested directly.

Feature order is part of the model contract — `src/engines/Mlpredictor.ts`
resolves splits by feature NAME, but norm_browser.json is written positionally,
so appended names must keep their order.
"""

from __future__ import annotations

import numpy as np


def engineer_features(
    X_orig: np.ndarray, feature_cols_orig: list[str]
) -> tuple[np.ndarray, list[str]]:
    """Append the engineered features to `X_orig`.

    Args:
        X_orig: base feature matrix, shape (n_samples, n_base_features).
        feature_cols_orig: base feature names, positionally aligned to X_orig.

    Returns:
        (X, feature_cols) — float32 matrix with NaN/inf zeroed, and the base
        names followed by the engineered names in append order.
    """
    fi = {name: i for i, name in enumerate(feature_cols_orig)}

    def col(name):
        return X_orig[:, fi[name]] if name in fi else np.zeros(len(X_orig))

    delta_1m = col("delta_1m_pct")
    delta_3m = col("delta_3m_pct")
    rsi = col("rsi_norm")
    rsi_slope = col("rsi_slope")
    vwap_dist = col("vwap_dist")
    vwap_slope = col("vwap_slope")
    macd_line = col("macd_line")
    macd_hist = col("macd_hist")
    vol_ratio = col("vol_ratio_norm")
    multi_tf = col("multi_tf_agreement")
    bb_pctb = col("bb_percent_b")
    bb_squeeze = col("bb_squeeze")
    atr_pct = col("atr_pct_norm")
    vol_buy = col("vol_delta_buy_ratio")
    ema_cross = col("ema_cross_signal")
    stoch_k = col("stoch_k_norm")
    ha_consec = col("ha_signed_consec")
    regime_trending = col("regime_trending")
    regime_confidence = col("regime_confidence")  # v8: was regime_choppy
    regime_mr = col("regime_mean_reverting")

    new = {}
    # --- Original 16 engineered features ---
    new["delta_1m_capped"] = np.clip(delta_1m, -0.003, 0.003)
    new["momentum_accel"] = delta_1m - (delta_3m / 3)
    new["rsi_x_trending"] = rsi * regime_trending
    new["rsi_x_regime_conf"] = rsi * regime_confidence  # v8: was rsi_x_choppy = rsi * regime_choppy
    new["rsi_x_mean_rev"] = rsi * regime_mr
    new["delta1m_x_multitf"] = delta_1m * multi_tf
    new["bb_pctb_x_squeeze"] = bb_pctb * bb_squeeze
    new["vol_buy_x_delta"] = vol_buy * np.sign(delta_1m)
    new["vwap_trend_strength"] = vwap_dist * np.sign(vwap_slope)
    new["rsi_divergence"] = np.sign(delta_3m) * (-rsi_slope)
    new["combined_oscillator"] = (rsi + stoch_k + bb_pctb) / 3
    new["ha_delta_agree"] = (np.sign(ha_consec) == np.sign(delta_1m)).astype(np.float32)
    atr_safe = np.where(atr_pct > 0.01, atr_pct, 0.01)
    new["delta_1m_atr_adj"] = delta_1m / atr_safe
    new["price_position_score"] = (
        np.sign(vwap_dist) * 0.4 + (bb_pctb - 0.5) * 0.3 + (ema_cross - 0.5) * 0.3
    )
    new["vol_weighted_momentum"] = delta_1m * vol_ratio
    new["macd_x_rsi_slope"] = np.sign(macd_line) * rsi_slope

    # --- 6 engineered features (agreement/confirmation focus) ---
    new["trend_alignment_score"] = regime_trending * multi_tf * np.sign(delta_1m)
    new["oscillator_extreme"] = np.maximum(rsi - 0.7, 0) + np.maximum(0.3 - rsi, 0)
    new["vol_momentum_confirm"] = vol_buy * np.sign(delta_1m) * vol_ratio
    new["squeeze_breakout_potential"] = bb_squeeze * np.abs(stoch_k - 0.5) * 2

    delta_dir = np.sign(delta_1m)
    agree_count = (
        (np.sign(ha_consec) == delta_dir).astype(np.float32)
        + (np.sign(macd_hist) == delta_dir).astype(np.float32)
        + (np.sign(vwap_dist) == delta_dir).astype(np.float32)
        + ((rsi > 0.5).astype(np.float32) == (delta_dir > 0).astype(np.float32)).astype(np.float32)
        + (multi_tf).astype(np.float32)
    )
    new["multi_indicator_agree"] = agree_count / 5.0
    new["stoch_rsi_extreme"] = np.maximum(stoch_k - 0.8, 0) * 5 + np.maximum(0.2 - stoch_k, 0) * 5

    # --- 3 engineered features (Polymarket crowd/orderbook interactions) ---
    market_price_momentum = col("market_price_momentum")
    orderbook_imbalance = col("orderbook_imbalance")
    crowd_model_divergence = col("crowd_model_divergence")
    rule_confidence = col("rule_confidence")

    new["crowd_agree_momentum"] = np.sign(market_price_momentum) * np.sign(delta_1m)
    new["divergence_x_confidence"] = crowd_model_divergence * rule_confidence
    new["imbalance_x_vol_delta"] = orderbook_imbalance * vol_buy

    new_names = list(new.keys())
    X = np.hstack([X_orig, np.column_stack([new[n] for n in new_names])]).astype(np.float32)
    X = np.nan_to_num(X, nan=0.0, posinf=0.0, neginf=0.0)
    feature_cols = feature_cols_orig + new_names
    return X, feature_cols
