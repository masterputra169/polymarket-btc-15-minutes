"""Browser-facing XGBoost export: tree dump, signal modifiers, JSON assembly.

`src/engines/Mlpredictor.ts` re-implements XGBoost inference in the browser and
`bot/src/autoRetrain.ts` gates deploys on the `metrics` block, so
xgboost_model.json and norm_browser.json are contracts, not dumps: field names,
values AND key order are all load-bearing (key order changes the bytes on disk,
which the deploy checksum notices). Nothing here rounds or renames on its own
initiative — the rounding you see is the rounding production has always read.

Pure functions: model/arrays/metrics in, plain dicts out. No printing and no
file I/O — the trainer owns stdout and decides where the JSON lands.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

import numpy as np

from mltrain.metrics import safe_round

# === Signal Modifiers (H2): Feature importance → probability.js signal weights ===
# Map XGBoost feature importances to probability.js signal modifier keys.
# Each key groups features that inform one scoring signal in scoreDirection().
SIGNAL_FEATURE_MAP = {
    "ptbDistance": ["ptb_dist_pct"],
    "momentum": [
        "delta_1m_pct",
        "delta_3m_pct",
        "momentum_5candle_slope",
        "delta_1m_capped",
        "momentum_accel",
        "vol_weighted_momentum",
        "delta_1m_atr_adj",
    ],
    "rsi": [
        "rsi_norm",
        "rsi_slope",
        "stoch_k_norm",
        "stoch_kd_norm",
        "rsi_x_trending",
        "rsi_x_regime_conf",
        "rsi_x_mean_rev",
        "combined_oscillator",
        "oscillator_extreme",
        "rsi_divergence",
        "stoch_rsi_extreme",
    ],
    "macdHist": ["macd_hist"],
    "macdLine": ["macd_line", "macd_x_rsi_slope"],
    "vwapPos": ["vwap_dist", "vwap_trend_strength", "price_position_score"],
    "vwapSlope": ["vwap_slope"],
    "heikenAshi": ["ha_signed_consec", "ha_is_green", "ha_delta_agree"],
    "failedVwap": ["failed_vwap_reclaim"],
    "orderbook": ["orderbook_imbalance", "imbalance_x_vol_delta"],
    "multiTf": [
        "multi_tf_agreement",
        "delta1m_x_multitf",
        "trend_alignment_score",
        "multi_indicator_agree",
    ],
    "bbPos": [
        "bb_percent_b",
        "bb_width",
        "bb_squeeze",
        "bb_squeeze_intensity",
        "bb_pctb_x_squeeze",
        "squeeze_breakout_potential",
    ],
    "atrExpand": ["atr_pct_norm", "atr_ratio_norm", "atr_expanding"],
}

# Browser-side recipe for each engineered feature. Mlpredictor.ts does NOT read
# these to compute features (it has its own implementations) — they are the
# written-down spec the two implementations are checked against, so the key
# order and formula strings are part of the exported contract.
ENGINEERED_FEATURE_SPECS: dict[str, dict[str, object]] = {
    "delta_1m_capped": {"type": "clip", "source": "delta_1m_pct", "clip_std": 3},
    "momentum_accel": {"type": "formula", "formula": "delta_1m - delta_3m/3"},
    "rsi_x_trending": {"type": "multiply", "a": "rsi_norm", "b": "regime_trending"},
    "rsi_x_regime_conf": {"type": "multiply", "a": "rsi_norm", "b": "regime_confidence"},
    "rsi_x_mean_rev": {"type": "multiply", "a": "rsi_norm", "b": "regime_mean_reverting"},
    "delta1m_x_multitf": {"type": "multiply", "a": "delta_1m_pct", "b": "multi_tf_agreement"},
    "bb_pctb_x_squeeze": {"type": "multiply", "a": "bb_percent_b", "b": "bb_squeeze"},
    "vol_buy_x_delta": {"type": "formula", "formula": "vol_delta_buy_ratio * sign(delta_1m_pct)"},
    "vwap_trend_strength": {"type": "formula", "formula": "vwap_dist * sign(vwap_slope)"},
    "rsi_divergence": {"type": "formula", "formula": "sign(delta_3m_pct) * (-rsi_slope)"},
    "combined_oscillator": {
        "type": "formula",
        "formula": "(rsi_norm + stoch_k_norm + bb_percent_b) / 3",
    },
    "ha_delta_agree": {
        "type": "formula",
        "formula": "sign(ha_signed_consec) == sign(delta_1m_pct) ? 1 : 0",
    },
    "delta_1m_atr_adj": {"type": "formula", "formula": "delta_1m_pct / max(atr_pct_norm, 0.01)"},
    "price_position_score": {
        "type": "formula",
        "formula": "sign(vwap_dist)*0.4 + (bb_percent_b-0.5)*0.3 + (ema_cross_signal-0.5)*0.3",
    },
    "vol_weighted_momentum": {"type": "multiply", "a": "delta_1m_pct", "b": "vol_ratio_norm"},
    "macd_x_rsi_slope": {"type": "formula", "formula": "sign(macd_line) * rsi_slope"},
    "trend_alignment_score": {
        "type": "formula",
        "formula": "regime_trending * multi_tf_agreement * sign(delta_1m_pct)",
    },
    "oscillator_extreme": {
        "type": "formula",
        "formula": "max(rsi_norm - 0.7, 0) + max(0.3 - rsi_norm, 0)",
    },
    "vol_momentum_confirm": {
        "type": "formula",
        "formula": "vol_delta_buy_ratio * sign(delta_1m_pct) * vol_ratio_norm",
    },
    "squeeze_breakout_potential": {
        "type": "formula",
        "formula": "bb_squeeze * abs(stoch_k_norm - 0.5) * 2",
    },
    "multi_indicator_agree": {
        "type": "formula",
        "formula": "(ha_agree + macd_agree + vwap_agree + rsi_agree + multi_tf) / 5",
    },
    "stoch_rsi_extreme": {
        "type": "formula",
        "formula": "max(stoch_k_norm - 0.8, 0)*5 + max(0.2 - stoch_k_norm, 0)*5",
    },
    "crowd_agree_momentum": {
        "type": "formula",
        "formula": "sign(market_price_momentum) * sign(delta_1m_pct)",
    },
    "divergence_x_confidence": {
        "type": "multiply",
        "a": "crowd_model_divergence",
        "b": "rule_confidence",
    },
    "imbalance_x_vol_delta": {
        "type": "multiply",
        "a": "orderbook_imbalance",
        "b": "vol_delta_buy_ratio",
    },
}


@dataclass(frozen=True)
class BrowserTrees:
    """The dumped forest, plus the slice that early stopping actually selected."""

    all_trees: list[dict]
    best_trees: list[dict]


@dataclass(frozen=True)
class ValidationInfo:
    """Provenance of every selected number, exported as the `validation` block.

    `threshold_source` / `calibration_eval_source` record whether the threshold
    sweep and the calibration check ran on OOF CV rows, the holdout, or the
    test set — the difference between an honest number and a multiple-testing
    artefact, so it ships with the model rather than living in a log.
    """

    test_size: float
    holdout_frac: float | None
    strict_holdout: bool
    threshold_source: str
    calibration_eval_source: str
    test_samples: int
    holdout_samples: int


@dataclass(frozen=True)
class XgbEvalMetrics:
    """Raw (unrounded) evaluation numbers behind the `metrics` block.

    One object feeds both the exported JSON and the human-readable training
    report, so the two can never quote different accuracies. Rounding happens
    at assembly time in `build_metrics_block`, because autoRetrain.ts compares
    these fields against fixed deploy gates and a precision change moves a gate.
    """

    accuracy: float
    auc: float
    f1: float
    logloss: float
    brier: float
    calibration: dict[str, object]
    high_conf_accuracy: float
    high_conf_ratio: float
    high_conf_count: int
    high_conf_threshold: float
    cv_auc: float
    cv_acc: float
    cv_test_acc_gap: float
    cv_test_auc_gap: float
    holdout_accuracy: float | None
    holdout_auc: float | None
    test_holdout_acc_gap: float | None
    test_holdout_auc_gap: float | None
    test_samples: int
    holdout_samples: int
    confidence_buckets: list[dict[str, object]]


def compute_signal_modifiers(importance: dict[str, float]) -> dict[str, float]:
    """Turn gain importances into per-signal multipliers for probability.js.

    Each SIGNAL_FEATURE_MAP key sums the gain of the features informing one
    rule-engine signal, then the sums are normalised so the MEAN modifier is
    1.0 — the rule engine's hand-tuned weights stay the baseline and the model
    only redistributes emphasis. Clamped to [0.3, 3.0] so a single dominant
    feature cannot silently switch the rule engine off.
    """
    signal_importances = {}
    for signal_key, feat_names in SIGNAL_FEATURE_MAP.items():
        total_gain = sum(importance.get(fn, 0) for fn in feat_names)
        signal_importances[signal_key] = total_gain

    # Normalize: mean modifier = 1.0
    sig_gains = list(signal_importances.values())
    mean_sig_gain = np.mean(sig_gains) if sig_gains else 1.0
    if mean_sig_gain < 1e-8:
        mean_sig_gain = 1.0

    signal_modifiers = {}
    for key, gain in signal_importances.items():
        mod_val = gain / mean_sig_gain
        mod_val = max(0.3, min(3.0, mod_val))  # clamp to prevent extreme values
        signal_modifiers[key] = round(float(mod_val), 2)
    return signal_modifiers


def dump_browser_trees(model: Any) -> BrowserTrees:
    """Dump the booster to JSON and slice it at the early-stopped iteration.

    Only `best_trees` ships: the rounds after `best_iteration` are the ones
    early stopping rejected, and shipping them would make browser inference
    disagree with every metric measured here.
    """
    json_dump = model.get_dump(dump_format="json")
    all_trees = [json.loads(t) for t in json_dump]
    best_trees = all_trees[: model.best_iteration + 1]
    return BrowserTrees(all_trees=all_trees, best_trees=best_trees)


def build_metrics_block(metrics: XgbEvalMetrics) -> dict:
    """Assemble the exported `metrics` dict — names and order read downstream."""
    return {
        "accuracy": round(metrics.accuracy, 4),
        "auc": round(metrics.auc, 4),
        "f1": round(metrics.f1, 4),
        "logloss": round(metrics.logloss, 4),
        "brier": round(metrics.brier, 4),
        "calibration_ece": safe_round(metrics.calibration["ece"]),
        "calibration_mce": safe_round(metrics.calibration["mce"]),
        "high_conf_accuracy": round(metrics.high_conf_accuracy, 4),
        "high_conf_ratio": round(metrics.high_conf_ratio, 2),
        "high_conf_count": metrics.high_conf_count,
        "high_conf_threshold": metrics.high_conf_threshold,
        "cv_auc": round(metrics.cv_auc, 4),
        "cv_acc": round(metrics.cv_acc, 4),
        "cv_test_acc_gap": safe_round(metrics.cv_test_acc_gap),
        "cv_test_auc_gap": safe_round(metrics.cv_test_auc_gap),
        "holdout_accuracy": safe_round(metrics.holdout_accuracy),
        "holdout_auc": safe_round(metrics.holdout_auc),
        "test_holdout_acc_gap": safe_round(metrics.test_holdout_acc_gap),
        "test_holdout_auc_gap": safe_round(metrics.test_holdout_auc_gap),
        "test_samples": metrics.test_samples,
        "holdout_samples": metrics.holdout_samples,
        "confidence_buckets": metrics.confidence_buckets,
        "calibration_bins": metrics.calibration["bins"],
    }


def build_browser_model(
    trees: list[dict],
    *,
    feature_cols: list[str],
    feature_cols_orig: list[str],
    engineered_features: list[str],
    best_iteration: int,
    optimal_threshold: float,
    platt_a: float,
    platt_b: float,
    platt_on_logits: bool,
    pruned_features: list[str],
    pre_excluded_features: list[str],
    zero_features: list[str],
    recency_enabled: bool,
    recency_halflife: int,
    signal_modifiers: dict[str, float],
    phase_thresholds: dict[str, dict[str, float]] | None,
    params: dict[str, object],
    use_optuna: bool,
    validation: ValidationInfo,
    metrics: XgbEvalMetrics,
) -> dict:
    """Assemble the xgboost_model.json payload.

    Field names, values and key ORDER are a contract with
    src/engines/Mlpredictor.ts and bot/src/autoRetrain.ts — do not rename,
    retype or reorder without updating both.

    Args:
        trees: the ALREADY-SLICED best_trees list actually being exported;
            `num_trees` is taken from its length rather than recomputed.
        params: the final XGBoost params; stringified on export because
            eval_metric is a list and the browser only ever displays these.
    """
    return {
        "format": "xgboost_json_v9",
        "version": 3,
        "num_features": len(feature_cols),
        "num_trees": len(trees),
        "feature_names": feature_cols,
        "original_features": len(feature_cols_orig),
        "engineered_features": engineered_features,
        "best_iteration": best_iteration,
        "optimal_threshold": optimal_threshold,
        "platt_a": platt_a,
        "platt_b": platt_b,
        "platt_on_logits": platt_on_logits,
        "pruned_features": pruned_features,
        "pre_excluded_features": pre_excluded_features,
        "zero_features": zero_features,
        "recency_weighting": (
            {"enabled": recency_enabled, "halflife_days": recency_halflife}
            if recency_enabled
            else None
        ),
        "signal_modifiers": signal_modifiers,
        "phase_thresholds": phase_thresholds,
        "params": {k: str(v) for k, v in params.items()},
        "training_method": "optuna" if use_optuna else "grid_search",
        "validation": {
            "split": "temporal",
            "test_size": validation.test_size,
            "holdout_frac": validation.holdout_frac,
            "strict_holdout": validation.strict_holdout,
            "threshold_source": validation.threshold_source,
            "calibration_eval_source": validation.calibration_eval_source,
            "test_samples": validation.test_samples,
            "holdout_samples": validation.holdout_samples,
        },
        "metrics": build_metrics_block(metrics),
        "trees": trees,
    }


def build_norm_export(
    X_train_full: np.ndarray,
    *,
    feature_cols: list[str],
    feature_cols_orig: list[str],
    platt_a: float,
    platt_b: float,
    platt_on_logits: bool,
    pruned_features: list[str],
    signal_modifiers: dict[str, float],
    phase_thresholds: dict[str, dict[str, float]] | None,
    holdout_frac: float | None,
    holdout_start_idx: int | None,
) -> dict:
    """Assemble norm_browser.json: the z-score normaliser plus inference config.

    Means/stds come from the FULL training block (not the tune subset), so the
    normaliser the browser applies matches the distribution the deployed model
    was fitted against. Near-zero stds are floored at 1.0 rather than dropped —
    dividing by them would turn a constant feature into ±inf in the browser.

    `means`, `stds` and `feature_names` are positionally aligned; the trainer
    is expected to assert they are the same length before shipping.
    """
    # Normalization (use full training data for mean/std, not just tune subset)
    means = X_train_full.mean(axis=0).tolist()
    stds = X_train_full.std(axis=0).tolist()
    for i in range(len(stds)):
        if stds[i] < 1e-8:
            stds[i] = 1.0

    return {
        "version": 3,
        "means": means,
        "stds": stds,
        "feature_names": feature_cols,
        "num_features": len(feature_cols),
        "original_features": len(feature_cols_orig),
        "platt_a": platt_a,
        "platt_b": platt_b,
        "platt_on_logits": platt_on_logits,
        "pruned_features": pruned_features,
        "engineered_feature_specs": ENGINEERED_FEATURE_SPECS,
        "signal_modifiers": signal_modifiers,
        "phase_thresholds": phase_thresholds,
        "train_samples": len(X_train_full),
        "holdout_frac": holdout_frac,
        "holdout_start_idx": holdout_start_idx,
    }
