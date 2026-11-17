#!/usr/bin/env python3
"""Evaluate holypolyfoundation/bs-p Logit-Space features & djienne curved edge on 54d 1 Hz tape.

Strict chronological market-grouped 6-fold walk-forward + 80/20 Validation split:
  - Baseline: Live v4 Hybrid Residual (`HYBRID_FEATURES` on `base_margin = logit(v2_prob_up)`)
  - +Logit Micro: adds 4 Logit-Space features from `bs-p/docs/DOCS.md`:
      1) `implied_belief_vol`  = logit(up_ask) - logit(up_bid)
      2) `logit_vwm_pressure`  = imb1 + ((microprice - up_mid) / spread_up)
      3) `logit_micro_offset`  = logit(microprice) - logit(up_mid)
      4) `logit_curvature`     = up_mid * (1 - up_mid) * (1 - 2 * up_mid)
  - Curved Edge Gate (djienne/edge.py): `required_model_prob(p) = max(floor, 1 - (1 - p)^alpha)`
"""

from __future__ import annotations

import argparse
import os

import numpy as np
import pandas as pd
import xgboost as xgb
from sklearn.metrics import accuracy_score, brier_score_loss, log_loss, roc_auc_score

from exportHybridResidualV4 import HYBRID_FEATURES, LOGIT_EPS, logit
from mltrain.metrics import calibration_summary

HERE = os.path.dirname(os.path.abspath(__file__))

LOGIT_FEATURES = [
    "implied_belief_vol",
    "logit_vwm_pressure",
    "logit_micro_offset",
    "logit_curvature",
]

XGB_PARAMS = {
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


def compute_extended_matrix(df: pd.DataFrame) -> tuple[np.ndarray, list[str]]:
    base_cols = df[HYBRID_FEATURES[:-1]].to_numpy(dtype=np.float32)
    p_mid = np.clip(df["up_mid"].to_numpy(dtype=float), LOGIT_EPS, 1.0 - LOGIT_EPS)
    p_bid = np.clip(df["up_bid"].to_numpy(dtype=float), LOGIT_EPS, 1.0 - LOGIT_EPS)
    p_ask = np.clip(df["up_ask"].to_numpy(dtype=float), LOGIT_EPS, 1.0 - LOGIT_EPS)
    p_mic = np.clip(
        df["microprice"].fillna(df["up_mid"]).to_numpy(dtype=float), LOGIT_EPS, 1.0 - LOGIT_EPS
    )

    v2_minus_mkt = (logit(df["v2_prob_up"].to_numpy()) - logit(p_mid)).astype(np.float32)
    implied_belief_vol = np.maximum(0.0, logit(p_ask) - logit(p_bid)).astype(np.float32)
    raw_spread = df["spread_up"].to_numpy(dtype=float)
    spread = np.maximum(0.005, np.where(np.isfinite(raw_spread), raw_spread, p_ask - p_bid))
    logit_vwm_pressure = (
        df["imb1"].fillna(0.0).to_numpy(dtype=float) + (p_mic - p_mid) / spread
    ).astype(np.float32)
    logit_micro_offset = (logit(p_mic) - logit(p_mid)).astype(np.float32)
    logit_curvature = (p_mid * (1.0 - p_mid) * (1.0 - 2.0 * p_mid)).astype(np.float32)

    X_base = np.column_stack([base_cols, v2_minus_mkt])
    X_ext = np.column_stack(
        [X_base, implied_belief_vol, logit_vwm_pressure, logit_micro_offset, logit_curvature]
    )
    return X_ext, HYBRID_FEATURES + LOGIT_FEATURES


def taker_pnl_for_entry(win: bool, ask: float, shares: int = 5) -> float:
    fee = shares * 0.07 * ask * (1.0 - ask)
    cost = shares * ask + fee
    return (shares * 1.0 - cost) if win else -cost


def eval_threshold_rule(
    df_val: pd.DataFrame,
    p_up: np.ndarray,
    alpha_curve: float | None = None,
    min_conf: float = 0.30,
    min_edge: float = 0.04,
    max_price: float = 0.65,
) -> tuple[int, float, float]:
    """Simulate market-first entry per window in 50c..65c band."""
    df_s = df_val[["slug_timestamp", "up_ask", "dn_ask", "label"]].copy()
    df_s["p_up"] = p_up
    df_s["row_pos"] = np.arange(len(df_s))

    trades = 0
    wins = 0
    pnl = 0.0
    for _, grp in df_s.groupby("slug_timestamp", sort=True):
        for row in grp.itertuples(index=False):
            p = float(row.p_up)
            side_up = p >= 0.5
            model_prob = p if side_up else (1.0 - p)
            conf = 2.0 * model_prob - 1.0
            ask = float(row.up_ask if side_up else row.dn_ask)
            if conf < min_conf or ask < 0.50 or ask > max_price:
                continue
            if alpha_curve is not None:
                req = max(0.35, 1.0 - (1.0 - ask) ** alpha_curve)
                if model_prob < req:
                    continue
            elif (model_prob - ask) < min_edge:
                continue
            win = (int(row.label) == 1) if side_up else (int(row.label) == 0)
            trades += 1
            wins += 1 if win else 0
            pnl += taker_pnl_for_entry(win, ask)
            break
    wr = (wins / trades * 100.0) if trades else 0.0
    return trades, wr, pnl


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", default=os.path.join(HERE, "tape_v4_panel.csv"))
    args = ap.parse_args()

    df = pd.read_csv(args.input)
    df = df[
        df["v2_prob_up"].notna()
        & (df["up_mid"] > 0.01)
        & (df["up_mid"] < 0.99)
        & (df["up_ask"] > 0.01)
        & (df["dn_ask"] > 0.01)
        & (df["up_bid"] > 0.01)
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

    X_ext, feat_ext = compute_extended_matrix(df)
    X_base = X_ext[:, : len(HYBRID_FEATURES)]
    y = df["label"].to_numpy(dtype=int)
    base_margin = logit(df["v2_prob_up"].to_numpy()).astype(np.float32)

    def fit_and_eval(
        tag: str, X_mat: np.ndarray, names: list[str]
    ) -> tuple[np.ndarray, xgb.Booster]:
        dtr = xgb.DMatrix(
            X_mat[m_tr], label=y[m_tr], base_margin=base_margin[m_tr], feature_names=names
        )
        dval = xgb.DMatrix(
            X_mat[m_val], label=y[m_val], base_margin=base_margin[m_val], feature_names=names
        )
        bst = xgb.train(
            XGB_PARAMS,
            dtr,
            num_boost_round=1500,
            evals=[(dval, "val")],
            early_stopping_rounds=80,
            verbose_eval=False,
        )
        p_val = bst.predict(dval, iteration_range=(0, int(bst.best_iteration) + 1))
        cal = calibration_summary(y[m_val], p_val)
        print(
            f"{tag:20s} | trees={bst.best_iteration + 1:3d} | "
            f"Acc={accuracy_score(y[m_val], p_val >= 0.5) * 100:.2f}% | "
            f"AUC={roc_auc_score(y[m_val], p_val):.4f} | "
            f"Brier={brier_score_loss(y[m_val], p_val):.4f} | "
            f"LogLoss={log_loss(y[m_val], p_val):.4f} | ECE={cal['ece']:.4f}"
        )
        return p_val, bst

    print(
        f"Dataset: {len(df)} rows across {n_mkts} markets | Train={len(tr_slugs)} mkts | Val={len(val_slugs)} mkts (embargo={embargo})"
    )
    p_base, _ = fit_and_eval("v4_baseline_13f", X_base, HYBRID_FEATURES)
    p_ext, bst_ext = fit_and_eval("v4_plus_logit_17f", X_ext, feat_ext)

    gains = bst_ext.get_score(importance_type="gain")
    tot_gain = sum(gains.values()) or 1.0
    print("\nTop Logit-Feature Gain Shares:")
    for lf in LOGIT_FEATURES:
        print(f"  {lf:22s}: {(gains.get(lf, 0.0) / tot_gain) * 100:.2f}%")

    df_val = df.loc[m_val]
    print("\nOOS Taker 50-65c Comparison (baseline 13f vs +Logit 17f vs djienne curved edge):")
    for label, probs, alpha in [
        ("v4_base + flat 4c", p_base, None),
        ("v4_logit + flat 4c", p_ext, None),
        ("v4_base + curve a=1.20", p_base, 1.20),
        ("v4_base + curve a=1.35", p_base, 1.35),
        ("v4_logit + curve a=1.20", p_ext, 1.20),
        ("v4_logit + curve a=1.35", p_ext, 1.35),
    ]:
        t, wr, pnl = eval_threshold_rule(df_val, probs, alpha_curve=alpha)
        print(f"  {label:24s}: trades={t:4d} | WR={wr:5.2f}% | TakerPnL={pnl:+.2f}")


if __name__ == "__main__":
    main()
