"""Browser-facing LightGBM export: tree traversal, parity check, JSON assembly.

`src/engines/Mlpredictor.ts` re-implements LightGBM inference in the browser, so
lightgbm_model.json is a contract rather than a dump: the TypeScript side reads
its fields by name, and bot/src/autoRetrain.ts gates deploys on the `metrics`
block. The traversal here mirrors that browser implementation — same
`val <= threshold` split rule, same NaN/default_left fallback — so the trainer
can prove, before shipping, that walking the exported trees reproduces the
booster's own raw scores.

Pure functions: model/arrays in, plain dict out. No printing and no file I/O —
the trainer owns stdout and decides where the JSON lands.
"""

from __future__ import annotations

from typing import Any

import numpy as np

from mltrain.metrics import safe_round


def traverse_lgb_tree(node: dict, features: np.ndarray) -> float:
    """Score one exported LightGBM tree exactly as the browser predictor does.

    Missing values follow `default_left` (defaulting to True, as LightGBM's own
    dump omits the flag when it is the default) instead of comparing NaN, which
    would silently take the right branch every time.
    """
    if "leaf_value" in node:
        return node["leaf_value"]
    fi = node["split_feature"]
    thr = node["threshold"]
    val = features[fi]
    default_left = node.get("default_left", True)
    if np.isnan(val):
        return traverse_lgb_tree(
            node["left_child"] if default_left else node["right_child"], features
        )
    if val <= thr:
        return traverse_lgb_tree(node["left_child"], features)
    else:
        return traverse_lgb_tree(node["right_child"], features)


def compute_init_score(y_train: np.ndarray, w_train: np.ndarray | None) -> float:
    """Base score the browser must add before summing the exported trees.

    LightGBM's binary objective starts from the logit of the (weight-adjusted)
    label mean and boosts the residual from there, so the exported trees alone
    do not reconstruct the raw margin.
    """
    label_mean = (
        float(np.average(y_train, weights=w_train))
        if w_train is not None
        else float(y_train.mean())
    )
    return float(np.log(label_mean / (1 - label_mean)))


def verify_browser_inference(
    model: Any, tree_info: list[dict], init_score: float, X: np.ndarray, n_rows: int = 5
) -> float:
    """Max |booster raw score - manual traversal| over the first `n_rows` rows.

    A large gap means the exported trees and the browser's traversal rules have
    drifted apart, so live predictions would differ from the ones every metric
    in the export was measured on.

    Args:
        tree_info: the ALREADY-SLICED tree list actually being exported.
    """
    model_raw_scores = model.predict(X[:n_rows], raw_score=True)
    max_diff = 0
    for i in range(n_rows):
        manual_raw = init_score
        for ti in tree_info:
            manual_raw += traverse_lgb_tree(ti["tree_structure"], X[i])
        diff = abs(model_raw_scores[i] - manual_raw)
        max_diff = max(max_diff, diff)
    return max_diff


def build_lgb_browser_model(
    tree_info: list[dict],
    *,
    feature_cols: list[str],
    init_score: float,
    platt_a: float,
    platt_b: float,
    platt_on_logits: bool,
    accuracy: float,
    auc: float,
    brier: float,
    calibration: dict[str, object],
    cv_auc: float,
    cv_acc: float,
    ensemble_weights: dict[str, float],
) -> dict:
    """Assemble the lightgbm_model.json payload.

    Field names and values are a contract with src/engines/Mlpredictor.ts and
    with the deploy gates in bot/src/autoRetrain.ts, which read the `metrics`
    block by name — do not rename, retype or reorder without updating both.

    The cv/test gaps are derived here rather than passed in so the exported
    "how much did the model overfit its folds" numbers can never disagree with
    the accuracy/auc/cv_* fields sitting beside them.

    Args:
        tree_info: the ALREADY-SLICED tree list (C2: num_trees is taken from
            len(tree_info) rather than recomputed from best_iteration, which is
            where the old off-by-one came from).
        calibration: mltrain.metrics.calibration_summary output for the
            calibrated test probabilities.
    """
    return {
        "format": "lightgbm_json_v2",
        "version": 2,
        "num_features": len(feature_cols),
        "num_trees": len(tree_info),
        "feature_names": feature_cols,
        "init_score": init_score,
        "platt_a": platt_a,
        "platt_b": platt_b,
        "platt_on_logits": platt_on_logits,
        "metrics": {
            "accuracy": round(accuracy, 4),
            "auc": round(auc, 4),
            "brier": round(brier, 4),
            "calibration_ece": safe_round(calibration["ece"]),
            "calibration_mce": safe_round(calibration["mce"]),
            "cv_auc": safe_round(cv_auc),
            "cv_acc": safe_round(cv_acc),
            "cv_test_acc_gap": safe_round(accuracy - cv_acc),
            "cv_test_auc_gap": safe_round(auc - cv_auc),
        },
        "ensemble_weights": ensemble_weights,
        "tree_info": tree_info,
    }
