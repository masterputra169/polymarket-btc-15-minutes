#!/usr/bin/env python3
"""Train & export the live Pipeline v4 Hybrid Residual XGBoost overlay.

Anchors to the active 395d v2 production ensemble (20261116-p2-ef8dfd) using
`base_margin = logit(v2_prob_up)` and fits regularized depth-2 residual trees
over the 13 Chainlink-native + TWAP + L2 orderbook features.

Verifies exact tree traversal parity against XGBoost DMatrix prediction
(`max_abs_diff < 1e-5`) before writing `public/ml/hybrid_residual_v4.json`.
"""

from __future__ import annotations

import argparse
import json
import math
import os
from datetime import UTC, datetime

import numpy as np
import pandas as pd
import xgboost as xgb
from sklearn.metrics import accuracy_score, brier_score_loss, log_loss, roc_auc_score

from mltrain.metrics import calibration_summary

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))

HYBRID_FEATURES = [
    "oracle_ptb_dist_pct",
    "twap_physics_z",
    "basis_pct",
    "basis_drift_pct",
    "cross_feed_lead",
    "orderbook_imbalance",
    "spread_pct",
    "imb1",
    "imb5",
    "minutes_left_norm",
    "market_yes_price",
    "crowd_model_divergence",
    "v2_minus_mkt_logit",
]

LOGIT_EPS = 1e-4


def logit(p: np.ndarray | float, eps: float = LOGIT_EPS) -> np.ndarray:
    arr = np.clip(np.asarray(p, dtype=float), eps, 1.0 - eps)
    return np.log(arr / (1.0 - arr))


def sigmoid(x: np.ndarray | float) -> np.ndarray:
    arr = np.clip(np.asarray(x, dtype=float), -30.0, 30.0)
    return 1.0 / (1.0 + np.exp(-arr))


def build_feature_matrix(df: pd.DataFrame) -> np.ndarray:
    base_cols = df[HYBRID_FEATURES[:-1]].to_numpy(dtype=np.float32)
    v2_minus_mkt = (logit(df["v2_prob_up"].to_numpy()) - logit(df["up_mid"].to_numpy())).astype(
        np.float32
    )
    return np.column_stack([base_cols, v2_minus_mkt])


def normalize_tree_f32(node: dict) -> dict:
    """Convert XGBoost decimal-rounded thresholds to exact float32 IEEE values."""
    if "leaf" in node:
        return {"nodeid": int(node["nodeid"]), "leaf": float(node["leaf"])}
    return {
        "nodeid": int(node["nodeid"]),
        "depth": int(node.get("depth", 0)),
        "split": node["split"],
        "split_condition": float(np.float32(node["split_condition"])),
        "yes": int(node["yes"]),
        "no": int(node["no"]),
        "missing": int(node["missing"]),
        "children": [normalize_tree_f32(c) for c in node.get("children", [])],
    }


def eval_tree_dict(node: dict, x_row: np.ndarray, name_to_idx: dict[str, int]) -> float:
    cur = node
    while "leaf" not in cur:
        split_name = cur.get("split", "")
        idx = name_to_idx.get(split_name, -1)
        thresh = float(np.float32(cur.get("split_condition", 0.0)))
        nxt_id = cur.get("missing")
        if 0 <= idx < len(x_row):
            val = float(np.float32(x_row[idx]))
            if not math.isnan(val):
                nxt_id = cur["yes"] if val < thresh else cur["no"]
        children = {int(c["nodeid"]): c for c in cur.get("children", [])}
        if nxt_id not in children:
            return 0.0
        cur = children[nxt_id]
    return float(cur["leaf"])


def verify_tree_parity(
    trees: list[dict],
    X: np.ndarray,
    base_margin: np.ndarray,
    xgb_preds: np.ndarray,
    feature_names: list[str],
    sample_n: int = 1500,
) -> float:
    name_to_idx = {n: i for i, n in enumerate(feature_names)}
    step = max(1, len(X) // sample_n)
    indices = range(0, len(X), step)
    max_diff = 0.0
    for i in indices:
        x_row = X[i]
        margin = float(base_margin[i])
        leaf_sum = sum(eval_tree_dict(t, x_row, name_to_idx) for t in trees)
        manual_p = float(sigmoid(margin + leaf_sum))
        diff = abs(manual_p - float(xgb_preds[i]))
        if diff > max_diff:
            max_diff = diff
    return max_diff


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", default=os.path.join(HERE, "tape_v4_panel.csv"))
    ap.add_argument(
        "--out",
        default=os.path.join(ROOT, "public", "ml", "hybrid_residual_v4.json"),
    )
    ap.add_argument(
        "--norm",
        default=os.path.join(ROOT, "public", "ml", "norm_browser.json"),
    )
    args = ap.parse_args()

    with open(args.norm, encoding="utf-8") as fh:
        norm = json.load(fh)
    base_model_id = str(norm.get("model_id") or "")
    if not base_model_id:
        raise RuntimeError(f"Missing model_id in {args.norm}")

    df = pd.read_csv(args.input)
    df = df[
        df["v2_prob_up"].notna()
        & (df["up_mid"] > 0.01)
        & (df["up_mid"] < 0.99)
        & (df["up_ask"] > 0.01)
        & (df["dn_ask"] > 0.01)
    ].copy()
    df.sort_values(["slug_timestamp", "secs_into"], inplace=True)
    df.reset_index(drop=True, inplace=True)

    uniq_slugs = np.sort(df["slug_timestamp"].unique())
    n_mkts = len(uniq_slugs)
    embargo = 16
    tr_end = int(n_mkts * 0.80)
    val_start = tr_end + embargo

    tr_slugs = set(uniq_slugs[:tr_end])
    val_slugs = set(uniq_slugs[val_start:])
    m_tr = df["slug_timestamp"].isin(tr_slugs).to_numpy()
    m_val = df["slug_timestamp"].isin(val_slugs).to_numpy()

    X = build_feature_matrix(df)
    y = df["label"].to_numpy(dtype=int)
    base_margin = logit(df["v2_prob_up"].to_numpy()).astype(np.float32)

    dtr = xgb.DMatrix(
        X[m_tr], label=y[m_tr], base_margin=base_margin[m_tr], feature_names=HYBRID_FEATURES
    )
    dval = xgb.DMatrix(
        X[m_val], label=y[m_val], base_margin=base_margin[m_val], feature_names=HYBRID_FEATURES
    )
    dall = xgb.DMatrix(X, base_margin=base_margin, feature_names=HYBRID_FEATURES)

    params = {
        "objective": "binary:logistic",
        "eval_metric": "logloss",
        "tree_method": "hist",
        "max_depth": 2,
        "learning_rate": 0.015,
        "min_child_weight": 350,
        "subsample": 0.75,
        "colsample_bytree": 0.70,
        "reg_lambda": 30.0,
        "reg_alpha": 1.0,
        "gamma": 0.5,
        "seed": 42,
    }
    bst = xgb.train(
        params,
        dtr,
        num_boost_round=1500,
        evals=[(dval, "val")],
        early_stopping_rounds=80,
        verbose_eval=False,
    )

    best_iter = int(bst.best_iteration)
    raw_dump = bst.get_dump(dump_format="json")
    trees = [normalize_tree_f32(json.loads(t)) for t in raw_dump[: best_iter + 1]]

    preds_all = bst.predict(dall, iteration_range=(0, best_iter + 1))
    max_diff = verify_tree_parity(trees, X, base_margin, preds_all, HYBRID_FEATURES)
    if max_diff >= 1e-5:
        raise RuntimeError(f"Tree parity check failed: max_abs_diff={max_diff:.8f}")

    p_v2_val = np.clip(df.loc[m_val, "v2_prob_up"].to_numpy(dtype=float), 1e-4, 1.0 - 1e-4)
    p_hyb_val = preds_all[m_val]
    y_val = y[m_val]

    v2_cal = calibration_summary(y_val, p_v2_val)
    hyb_cal = calibration_summary(y_val, p_hyb_val)

    gains = bst.get_score(importance_type="gain")
    total_gain = sum(float(v) for v in gains.values()) or 1.0
    feat_gains = sorted(
        [
            {
                "name": fn,
                "gain": round(float(gains.get(fn, 0.0)), 2),
                "sharePct": round(float(gains.get(fn, 0.0)) / total_gain * 100.0, 2),
            }
            for fn in HYBRID_FEATURES
        ],
        key=lambda r: -float(r["gain"]),
    )

    payload = {
        "schema_version": 1,
        "id": f"v4-hybrid-{datetime.now(UTC).strftime('%Y%m%d')}",
        "requires_base_model_id": base_model_id,
        "created_at": datetime.now(UTC).isoformat(),
        "logit_eps": LOGIT_EPS,
        "feature_names": HYBRID_FEATURES,
        "best_iteration": best_iter,
        "num_trees": len(trees),
        "params": params,
        "training_split": {
            "total_rows": len(df),
            "total_markets": int(n_mkts),
            "train_markets": len(tr_slugs),
            "val_markets": len(val_slugs),
            "embargo_markets": embargo,
            "date_start": datetime.fromtimestamp(int(uniq_slugs[0]), tz=UTC).strftime(
                "%Y-%m-%d %H:%MZ"
            ),
            "date_end": datetime.fromtimestamp(int(uniq_slugs[-1]), tz=UTC).strftime(
                "%Y-%m-%d %H:%MZ"
            ),
        },
        "metrics": {
            "val_rows": int(m_val.sum()),
            "v2_val_acc": round(float(accuracy_score(y_val, p_v2_val >= 0.5)), 4),
            "v2_val_auc": round(float(roc_auc_score(y_val, p_v2_val)), 4),
            "v2_val_logloss": round(float(log_loss(y_val, p_v2_val)), 4),
            "v2_val_brier": round(float(brier_score_loss(y_val, p_v2_val)), 4),
            "v2_val_ece": round(float(v2_cal["ece"]), 4),
            "hybrid_val_acc": round(float(accuracy_score(y_val, p_hyb_val >= 0.5)), 4),
            "hybrid_val_auc": round(float(roc_auc_score(y_val, p_hyb_val)), 4),
            "hybrid_val_logloss": round(float(log_loss(y_val, p_hyb_val)), 4),
            "hybrid_val_brier": round(float(brier_score_loss(y_val, p_hyb_val)), 4),
            "hybrid_val_ece": round(float(hyb_cal["ece"]), 4),
            "max_inference_diff": round(float(max_diff), 8),
        },
        "feature_gains": feat_gains,
        "trees": trees,
    }

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, separators=(",", ":"))

    size_kb = os.path.getsize(args.out) / 1024.0
    print(f"[Export] Saved {args.out} ({size_kb:.1f} KB, {len(trees)} depth-2 trees)")
    print(f"[Anchor] requires_base_model_id = {base_model_id}")
    print(
        f"[Val]    v2 Acc={payload['metrics']['v2_val_acc']:.4f} AUC={payload['metrics']['v2_val_auc']:.4f} "
        f"Brier={payload['metrics']['v2_val_brier']:.4f} ECE={payload['metrics']['v2_val_ece']:.4f} LogLoss={payload['metrics']['v2_val_logloss']:.4f}"
    )
    print(
        f"[Val]    v4 Hyb Acc={payload['metrics']['hybrid_val_acc']:.4f} AUC={payload['metrics']['hybrid_val_auc']:.4f} "
        f"Brier={payload['metrics']['hybrid_val_brier']:.4f} ECE={payload['metrics']['hybrid_val_ece']:.4f} LogLoss={payload['metrics']['hybrid_val_logloss']:.4f}"
    )
    print(f"[Parity] max_abs_diff = {max_diff:.2e} (< 1e-5 OK)")


if __name__ == "__main__":
    main()
