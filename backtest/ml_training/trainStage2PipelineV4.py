#!/usr/bin/env python3
"""Stage 2 / Pipeline v4 empirical study & Chainlink-native ML trainer on the 1 Hz Market Tape.

Compares:
  - Fresh CLOB L2 mid & Stoikov microprice
  - Recalibrated CLOB mid (removes favourite-longshot bias)
  - Active 395d production v2 model (20261116-p2-ef8dfd, 100% OOS for >= 2026-09-24)
  - TWAP physics Phi((settle - PTB) / (sigma * sqrt(T_eff)))
  - Pipeline v4 Standalone XGBoost (63 base + 25 engineered features trained on tape)
  - Pipeline v4 Hybrid Residual XGBoost (base_margin = logit(v2_prod) + Chainlink/TWAP/L2 book)
  - Pipeline v4 Calibrated Stack (logistic over logit(mid), logit(v2), twap_z, basis_drift, cross_feed)

Evaluates strictly chronologically by unique `slug_timestamp` (with 16-market embargo
across Train / Holdout / Test) and splits Test metrics into:
  1) Normal Trading Window (12m -> 2m left: secs_into in [180, 780])
  2) Final Minute Window (60s -> 15s left: secs_into in [840, 885])

Also replays Gate 20f Cross-Feed Alignment (FILTER_CROSS_FEED_SKEW_PCT = 0.035%) on
real CLOB best asks with official CLOB V2 taker fee (0.07 * c * (1 - c) per share).

Outputs:
  - bot/data/stage2_pipeline_v4_study.json
  - analysis/2026-11-16/tahap2-pipeline-v4-study.md
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

from mltrain.features import engineer_features
from mltrain.metrics import calibration_summary

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))

V4_CHAINLINK_COLS = [
    "oracle_ptb_dist_pct",
    "twap_physics_z",
    "basis_pct",
    "basis_drift_pct",
    "cross_feed_lead",
]

META_EXCLUDE_COLS = {
    "slug_timestamp",
    "secs_into",
    "label",
    "ptb_exact",
    "v2_prob_up",
    "up_mid",
    "up_bid",
    "up_ask",
    "dn_bid",
    "dn_ask",
    "microprice",
    "imb1",
    "imb5",
    "spread_up",
    "live_basis_usd",
    "cross_feed_skew_usd",
    "binance_dist_pct",
    "oracle_dist_pct",
    "twap_p",
}

RNG = np.random.default_rng(2026)


def logit(p: np.ndarray | float, eps: float = 1e-4) -> np.ndarray:
    arr = np.clip(np.asarray(p, dtype=float), eps, 1.0 - eps)
    return np.log(arr / (1.0 - arr))


def sigmoid(x: np.ndarray | float) -> np.ndarray:
    arr = np.clip(np.asarray(x, dtype=float), -30.0, 30.0)
    return 1.0 / (1.0 + np.exp(-arr))


def norm_cdf(z: np.ndarray) -> np.ndarray:
    return 0.5 * (1.0 + np.vectorize(math.erf)(np.asarray(z, dtype=float) / math.sqrt(2.0)))


def fee_per_dollar(c: np.ndarray | float) -> np.ndarray | float:
    """CLOB V2 taker fee per $1 staked at c: (1/c) * 0.07 * c * (1 - c) = 0.07 * (1 - c)."""
    return 0.07 * (1.0 - c)


def fit_logistic(X: np.ndarray, y: np.ndarray, iters: int = 60, l2: float = 1e-2) -> np.ndarray:
    Xd = np.column_stack([np.ones(len(X)), X])
    b = np.zeros(Xd.shape[1], dtype=float)
    for _ in range(iters):
        p = sigmoid(Xd @ b)
        g = Xd.T @ (p - y) + l2 * b
        h = (Xd * (p * (1.0 - p))[:, None]).T @ Xd + l2 * np.eye(len(b))
        try:
            b -= np.linalg.solve(h, g)
        except np.linalg.LinAlgError:
            b -= np.linalg.lstsq(h, g, rcond=None)[0]
    return b


def predict_logistic(b: np.ndarray, X: np.ndarray) -> np.ndarray:
    Xd = np.column_stack([np.ones(len(X)), X])
    return np.clip(sigmoid(Xd @ b), 1e-4, 1.0 - 1e-4)


def market_block_skill_ci(
    y: np.ndarray,
    p: np.ndarray,
    m: np.ndarray,
    slugs: np.ndarray,
    n_boot: int = 1500,
) -> tuple[float, float, float]:
    """Brier skill vs market baseline `m` with 95% market-block bootstrap CI."""
    bp = (p - y) ** 2
    bm = (m - y) ** 2
    _, inv = np.unique(slugs, return_inverse=True)
    sp = np.bincount(inv, weights=bp)
    sm = np.bincount(inv, weights=bm)
    point = float(1.0 - sp.sum() / max(sm.sum(), 1e-9))
    idx = RNG.integers(0, len(sp), (n_boot, len(sp)))
    boots = 1.0 - sp[idx].sum(axis=1) / np.maximum(sm[idx].sum(axis=1), 1e-9)
    return point, float(np.percentile(boots, 2.5)), float(np.percentile(boots, 97.5))


def eval_prob_slice(
    df_slice: pd.DataFrame,
    prob_col: str,
    ref_recal_col: str = "mkt_recal",
) -> dict[str, object] | None:
    if len(df_slice) < 20:
        return None
    y = df_slice["label"].to_numpy(dtype=int)
    p = np.clip(df_slice[prob_col].to_numpy(dtype=float), 1e-4, 1.0 - 1e-4)
    mkt = np.clip(df_slice["up_mid"].to_numpy(dtype=float), 1e-4, 1.0 - 1e-4)
    slugs = df_slice["slug_timestamp"].to_numpy(dtype=int)

    acc = float(accuracy_score(y, p >= 0.5))
    auc = float(roc_auc_score(y, p)) if len(np.unique(y)) > 1 else 0.5
    ll = float(log_loss(y, p))
    br = float(brier_score_loss(y, p))
    cal = calibration_summary(y, p, bins=10)
    sk_raw, lo_raw, hi_raw = market_block_skill_ci(y, p, mkt, slugs)

    out: dict[str, object] = {
        "rows": len(df_slice),
        "markets": int(df_slice["slug_timestamp"].nunique()),
        "accuracyPct": round(acc * 100.0, 2),
        "auc": round(auc, 4),
        "logloss": round(ll, 4),
        "brier": round(br, 4),
        "ece": round(float(cal["ece"]), 4),
        "skillVsMktPct": round(sk_raw * 100.0, 2),
        "skillCi95": [round(lo_raw * 100.0, 2), round(hi_raw * 100.0, 2)],
    }
    if ref_recal_col in df_slice.columns and prob_col != ref_recal_col:
        ref = np.clip(df_slice[ref_recal_col].to_numpy(dtype=float), 1e-4, 1.0 - 1e-4)
        sk_rec, lo_rec, hi_rec = market_block_skill_ci(y, p, ref, slugs)
        out["skillVsRecalPct"] = round(sk_rec * 100.0, 2)
        out["skillRecalCi95"] = [round(lo_rec * 100.0, 2), round(hi_rec * 100.0, 2)]
    return out


def train_xgb_with_early_stop(
    X_tr: np.ndarray,
    y_tr: np.ndarray,
    X_val: np.ndarray,
    y_val: np.ndarray,
    *,
    base_margin_tr: np.ndarray | None = None,
    base_margin_val: np.ndarray | None = None,
    feature_names: list[str] | None = None,
    params: dict[str, object] | None = None,
) -> xgb.Booster:
    dtr = xgb.DMatrix(X_tr, label=y_tr, base_margin=base_margin_tr, feature_names=feature_names)
    dval = xgb.DMatrix(X_val, label=y_val, base_margin=base_margin_val, feature_names=feature_names)
    p = {
        "objective": "binary:logistic",
        "eval_metric": "logloss",
        "tree_method": "hist",
        "max_depth": 3,
        "learning_rate": 0.02,
        "min_child_weight": 150,
        "subsample": 0.75,
        "colsample_bytree": 0.70,
        "reg_lambda": 15.0,
        "reg_alpha": 1.0,
        "gamma": 0.5,
        "seed": 42,
    }
    if params:
        p.update(params)
    return xgb.train(
        p,
        dtr,
        num_boost_round=1500,
        evals=[(dval, "val")],
        early_stopping_rounds=80,
        verbose_eval=False,
    )


def simulate_entries(
    df: pd.DataFrame,
    prob_col: str,
    *,
    conf_min: float,
    price_cap: float,
    min_edge: float,
    apply_gate_20f: bool,
    skew_pct_limit: float = 0.035,
    stake_usd: float = 2.0,
) -> dict[str, object]:
    """Replay first entry per market inside 12m..2m left against real L2 asks + CLOB V2 fee."""
    sub = df[(df["secs_into"] >= 180) & (df["secs_into"] <= 780)].sort_values(
        ["slug_timestamp", "secs_into"]
    )
    p_up = np.clip(sub[prob_col].to_numpy(dtype=float), 1e-4, 1.0 - 1e-4)
    side_up = p_up >= 0.5
    prob_side = np.where(side_up, p_up, 1.0 - p_up)
    conf = np.abs(p_up - 0.5) * 2.0
    ask = np.where(
        side_up,
        sub["up_ask"].to_numpy(dtype=float),
        sub["dn_ask"].to_numpy(dtype=float),
    )
    fee_pct = fee_per_dollar(ask)
    edge = prob_side - ask - fee_pct

    cand_mask = (conf >= conf_min) & (ask >= 0.40) & (ask <= price_cap) & (edge >= min_edge)

    bin_d = sub["binance_dist_pct"].to_numpy(dtype=float)
    ora_d = sub["oracle_dist_pct"].to_numpy(dtype=float)
    signed_bin = np.where(side_up, bin_d, -bin_d)
    signed_ora = np.where(side_up, ora_d, -ora_d)
    inflation = signed_bin - signed_ora
    cf_blocked_mask = (
        cand_mask
        & (sub["ptb_exact"].to_numpy(dtype=int) == 1)
        & (signed_bin > 0.0)
        & (inflation >= skew_pct_limit)
        & ((signed_ora <= 0.0) | (signed_ora < skew_pct_limit))
    )

    final_mask = cand_mask & (~cf_blocked_mask if apply_gate_20f else True)
    kept = sub[final_mask].groupby("slug_timestamp", as_index=False).first()

    blocked_markets = int(sub[cf_blocked_mask]["slug_timestamp"].nunique())
    if len(kept) == 0:
        return {
            "trades": 0,
            "blockedMarketsBy20f": blocked_markets,
            "wins": 0,
            "losses": 0,
            "wrPct": None,
            "breakevenWrPct": None,
            "marginPp": None,
            "pnlUsd": 0.0,
            "roiPct": 0.0,
            "pf": None,
            "maxDdUsd": 0.0,
        }

    k_up = kept[prob_col].to_numpy(dtype=float) >= 0.5
    k_y = kept["label"].to_numpy(dtype=int)
    k_win = np.where(k_up, k_y == 1, k_y == 0)
    k_ask = np.where(
        k_up, kept["up_ask"].to_numpy(dtype=float), kept["dn_ask"].to_numpy(dtype=float)
    )
    k_fee = fee_per_dollar(k_ask)

    per_trade_pnl = np.where(k_win, stake_usd * (1.0 / k_ask - 1.0), -stake_usd) - stake_usd * k_fee
    cum = np.cumsum(per_trade_pnl)
    peaks = np.maximum.accumulate(np.insert(cum, 0, 0.0))[1:]
    max_dd = float(np.max(np.maximum(0.0, peaks - cum)))
    gross_win = float(per_trade_pnl[per_trade_pnl > 0].sum())
    gross_loss = float(np.abs(per_trade_pnl[per_trade_pnl < 0].sum()))
    be_wr = float(np.mean(k_ask + 0.07 * k_ask * (1.0 - k_ask))) * 100.0
    wr = float(np.mean(k_win)) * 100.0
    pnl_sum = float(per_trade_pnl.sum())
    staked = len(kept) * stake_usd

    return {
        "trades": len(kept),
        "blockedMarketsBy20f": blocked_markets,
        "wins": int(k_win.sum()),
        "losses": int((~k_win).sum()),
        "wrPct": round(wr, 2),
        "breakevenWrPct": round(be_wr, 2),
        "marginPp": round(wr - be_wr, 2),
        "avgAskCents": round(float(k_ask.mean()) * 100.0, 2),
        "pnlUsd": round(pnl_sum, 2),
        "roiPct": round((pnl_sum / staked) * 100.0, 2),
        "pf": round(gross_win / gross_loss, 2) if gross_loss > 0 else 99.9,
        "maxDdUsd": round(max_dd, 2),
    }


def extract_top_gains(
    bst: xgb.Booster, col_names: list[str], top_n: int = 15
) -> list[dict[str, object]]:
    gain_map = bst.get_score(importance_type="gain")
    split_map = bst.get_score(importance_type="weight")
    total_gain = sum(gain_map.values()) or 1.0
    rows = []
    for col in col_names:
        g = float(gain_map.get(col, 0.0))
        sp = int(split_map.get(col, 0))
        rows.append(
            {
                "name": col,
                "isChainlinkNative": col in V4_CHAINLINK_COLS,
                "gain": round(g, 2),
                "gainSharePct": round((g / total_gain) * 100.0, 2),
                "splits": sp,
            }
        )
    rows.sort(key=lambda r: -float(r["gain"]))
    return rows[:top_n], rows


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", default=os.path.join(HERE, "tape_v4_panel.csv"))
    ap.add_argument(
        "--out-study", default=os.path.join(ROOT, "bot", "data", "stage2_pipeline_v4_study.json")
    )
    ap.add_argument(
        "--out-md",
        default=os.path.join(ROOT, "analysis", "2026-11-16", "tahap2-pipeline-v4-study.md"),
    )
    args = ap.parse_args()

    print(f"[Stage2] Loading {args.input}...")
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

    base_cols = [c for c in df.columns if c not in META_EXCLUDE_COLS]
    X_base = df[base_cols].to_numpy(dtype=np.float32)
    X_eng, full_cols = engineer_features(X_base, base_cols)
    print(
        f"[Stage2] Loaded {len(df):,} rows across {df['slug_timestamp'].nunique():,} markets | {len(base_cols)} base + {len(full_cols) - len(base_cols)} eng = {len(full_cols)} feats"
    )

    # Market-grouped strict chronological split with 16-market embargoes
    uniq_slugs = np.sort(df["slug_timestamp"].unique())
    n_mkts = len(uniq_slugs)
    embargo = 16
    tr_end = int(n_mkts * 0.60)
    val_start = tr_end + embargo
    val_end = val_start + int(n_mkts * 0.15)
    test_start = val_end + embargo

    tr_slugs = set(uniq_slugs[:tr_end])
    val_slugs = set(uniq_slugs[val_start:val_end])
    test_slugs = set(uniq_slugs[test_start:])

    m_tr = df["slug_timestamp"].isin(tr_slugs).to_numpy()
    m_val = df["slug_timestamp"].isin(val_slugs).to_numpy()
    m_test = df["slug_timestamp"].isin(test_slugs).to_numpy()

    def ts_iso(s: int) -> str:
        return datetime.fromtimestamp(int(s), tz=UTC).strftime("%Y-%m-%d %H:%MZ")

    print(
        f"[Split] Train {len(tr_slugs)} mkts ({ts_iso(uniq_slugs[0])}..{ts_iso(uniq_slugs[tr_end - 1])}) | "
        f"Val {len(val_slugs)} mkts | Test {len(test_slugs)} mkts ({ts_iso(uniq_slugs[test_start])}..{ts_iso(uniq_slugs[-1])})"
    )

    y = df["label"].to_numpy(dtype=int)
    df["twap_physics"] = np.clip(
        norm_cdf(df["twap_physics_z"].fillna(0).to_numpy()), 1e-4, 1.0 - 1e-4
    )

    # 1. Recalibrated market baseline fitted on Train only
    mkt_lgt_tr = logit(df.loc[m_tr, "up_mid"].to_numpy())[:, None]
    b_recal = fit_logistic(mkt_lgt_tr, y[m_tr])
    df["mkt_recal"] = predict_logistic(b_recal, logit(df["up_mid"].to_numpy())[:, None])

    # 2. Standalone Pipeline v4 XGBoost (all 88 features trained purely on Tape Train, early-stopped on Val)
    norm_win_tr = m_tr & (df["secs_into"] <= 840).to_numpy()
    norm_win_val = m_val & (df["secs_into"] <= 840).to_numpy()
    print("[Train 1/3] Fitting Pipeline v4 Standalone XGBoost (88 features)...")
    bst_standalone = train_xgb_with_early_stop(
        X_eng[norm_win_tr],
        y[norm_win_tr],
        X_eng[norm_win_val],
        y[norm_win_val],
        feature_names=full_cols,
        params={"max_depth": 3, "min_child_weight": 200, "colsample_bytree": 0.6},
    )
    d_all_full = xgb.DMatrix(X_eng, feature_names=full_cols)
    df["v4_standalone"] = bst_standalone.predict(
        d_all_full, iteration_range=(0, bst_standalone.best_iteration + 1)
    )

    # 3. Hybrid Residual Pipeline v4: base_margin = logit(v2_prod), learning ONLY Chainlink-native + L2 micro deltas
    hybrid_cols = [
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
    ]
    X_hyb = np.column_stack(
        [
            df[hybrid_cols].to_numpy(dtype=np.float32),
            (logit(df["v2_prob_up"].to_numpy()) - logit(df["up_mid"].to_numpy())).astype(
                np.float32
            ),
        ]
    )
    hybrid_feat_names = [*hybrid_cols, "v2_minus_mkt_logit"]
    base_margin_all = logit(df["v2_prob_up"].to_numpy())
    print(
        "[Train 2/3] Fitting Pipeline v4 Hybrid Residual XGBoost (v2 base_margin + Chainlink-native/TWAP/L2)..."
    )
    best_hyb = None
    for cfg_name, p in (
        (
            "d2_reg",
            {"max_depth": 2, "min_child_weight": 350, "reg_lambda": 30.0, "learning_rate": 0.015},
        ),
        (
            "d3_reg",
            {"max_depth": 3, "min_child_weight": 450, "reg_lambda": 40.0, "learning_rate": 0.015},
        ),
    ):
        bst_h = train_xgb_with_early_stop(
            X_hyb[m_tr],
            y[m_tr],
            X_hyb[m_val],
            y[m_val],
            base_margin_tr=base_margin_all[m_tr],
            base_margin_val=base_margin_all[m_val],
            feature_names=hybrid_feat_names,
            params=p,
        )
        p_val = bst_h.predict(
            xgb.DMatrix(
                X_hyb[m_val], base_margin=base_margin_all[m_val], feature_names=hybrid_feat_names
            ),
            iteration_range=(0, bst_h.best_iteration + 1),
        )
        ll_val = float(log_loss(y[m_val], p_val))
        print(
            f"    Hybrid {cfg_name}: best_iter={bst_h.best_iteration + 1}, Val logloss={ll_val:.5f}"
        )
        if best_hyb is None or ll_val < best_hyb[0]:
            best_hyb = (ll_val, cfg_name, bst_h)
    bst_hybrid = best_hyb[2]
    df["v4_hybrid"] = bst_hybrid.predict(
        xgb.DMatrix(X_hyb, base_margin=base_margin_all, feature_names=hybrid_feat_names),
        iteration_range=(0, bst_hybrid.best_iteration + 1),
    )

    # 4. Calibrated Stack (logistic on market + v2 + twap_physics + basis_drift + cross_feed_lead)
    print("[Train 3/3] Fitting Pipeline v4 Calibrated Logistic Stack...")
    X_stk = np.column_stack(
        [
            logit(df["up_mid"].to_numpy()),
            logit(df["v2_prob_up"].to_numpy()),
            logit(df["twap_physics"].to_numpy()),
            df["basis_drift_pct"].to_numpy(dtype=float) * 100.0,
            df["cross_feed_lead"].to_numpy(dtype=float) * 100.0,
            df["orderbook_imbalance"].to_numpy(dtype=float),
        ]
    )
    b_stk = fit_logistic(X_stk[m_tr | m_val], y[m_tr | m_val], l2=1.0)
    df["v4_stack"] = predict_logistic(b_stk, X_stk)

    # Score strict Test OOS split
    test_df = df[m_test].copy()
    norm_df = test_df[(test_df["secs_into"] >= 180) & (test_df["secs_into"] <= 780)]
    late_df = test_df[(test_df["secs_into"] >= 840) & (test_df["secs_into"] <= 885)]
    final_sec_df = test_df[(test_df["secs_into"] >= 855) & (test_df["secs_into"] <= 885)]

    model_specs = [
        ("up_mid", "CLOB L2 Mid (Fresh 1 Hz)"),
        ("microprice", "Stoikov L2 Microprice"),
        ("mkt_recal", "Recalibrated Market"),
        ("v2_prob_up", "Baseline v2 395d (OOS)"),
        ("twap_physics", "TWAP Physics Z"),
        ("v4_standalone", "Pipeline v4 Standalone (88f)"),
        ("v4_hybrid", "Pipeline v4 Hybrid Residual"),
        ("v4_stack", "Pipeline v4 Calibrated Stack"),
    ]

    normal_benchmarks = {}
    late_benchmarks = {}
    final_benchmarks = {}
    for col, label in model_specs:
        r_norm = eval_prob_slice(norm_df, col)
        if r_norm:
            normal_benchmarks[col] = {"label": label, **r_norm}
        r_late = eval_prob_slice(late_df, col)
        if r_late:
            late_benchmarks[col] = {"label": label, **r_late}
        r_fin = eval_prob_slice(final_sec_df, col)
        if r_fin:
            final_benchmarks[col] = {"label": label, **r_fin}

    # Simulated Trading Entry Replay on Real Tape Asks + Official CLOB V2 Fee
    print(
        "[Backtest] Simulating real-ask entries + Gate 20f Cross-Feed Replay on Strict Test OOS..."
    )
    presets = [
        ("prod_65c", "65c Cap / Edge>=6% / Conf>=45%", 0.45, 0.65, 0.06),
        ("wide_72c", "72c Cap / Edge>=4% / Conf>=45%", 0.45, 0.72, 0.04),
        ("tight_58c", "58c Cap / Edge>=6% / Conf>=45%", 0.45, 0.58, 0.06),
    ]
    trading_replay = []
    for pid, plabel, cmin, cap, edge in presets:
        row_set = {
            "presetId": pid,
            "label": plabel,
            "v2NoGate20f": simulate_entries(
                test_df,
                "v2_prob_up",
                conf_min=cmin,
                price_cap=cap,
                min_edge=edge,
                apply_gate_20f=False,
            ),
            "v2WithGate20f": simulate_entries(
                test_df,
                "v2_prob_up",
                conf_min=cmin,
                price_cap=cap,
                min_edge=edge,
                apply_gate_20f=True,
            ),
            "v4Standalone": simulate_entries(
                test_df,
                "v4_standalone",
                conf_min=cmin,
                price_cap=cap,
                min_edge=edge,
                apply_gate_20f=True,
            ),
            "v4Hybrid": simulate_entries(
                test_df,
                "v4_hybrid",
                conf_min=cmin,
                price_cap=cap,
                min_edge=edge,
                apply_gate_20f=True,
            ),
        }
        trading_replay.append(row_set)

    top_standalone, all_standalone = extract_top_gains(bst_standalone, full_cols, top_n=18)
    v4_native_ranks = []
    for idx_rank, item in enumerate(all_standalone, 1):
        if item["name"] in V4_CHAINLINK_COLS or item["name"] in (
            "orderbook_imbalance",
            "spread_pct",
        ):
            v4_native_ranks.append({"rank": idx_rank, **item})

    top_hybrid, _ = extract_top_gains(bst_hybrid, hybrid_feat_names, top_n=15)

    study_payload = {
        "generatedAt": datetime.now(UTC).isoformat(),
        "dataset": {
            "totalRows": len(df),
            "totalMarkets": int(n_mkts),
            "trainMarkets": len(tr_slugs),
            "valMarkets": len(val_slugs),
            "testMarkets": len(test_slugs),
            "testStart": ts_iso(uniq_slugs[test_start]),
            "testEnd": ts_iso(uniq_slugs[-1]),
            "featuresBase": len(base_cols),
            "featuresTotal": len(full_cols),
        },
        "stackWeights": {
            "intercept": round(float(b_stk[0]), 4),
            "logitMarketMid": round(float(b_stk[1]), 4),
            "logitV2Prod": round(float(b_stk[2]), 4),
            "logitTwapPhysics": round(float(b_stk[3]), 4),
            "basisDriftPct100": round(float(b_stk[4]), 4),
            "crossFeedLeadPct100": round(float(b_stk[5]), 4),
            "orderbookImbalance": round(float(b_stk[6]), 4),
        },
        "normalWindow": normal_benchmarks,
        "late60sWindow": late_benchmarks,
        "final15_45sWindow": final_benchmarks,
        "tradingReplay": trading_replay,
        "featureImportance": {
            "v4StandaloneTop": top_standalone,
            "v4NativeAndMicroRanks": v4_native_ranks,
            "v4HybridTop": top_hybrid,
        },
    }

    os.makedirs(os.path.dirname(args.out_study), exist_ok=True)
    with open(args.out_study, "w", encoding="utf-8") as fh:
        json.dump(study_payload, fh, indent=2)

    # Render clean Markdown report for analysis/ archive
    os.makedirs(os.path.dirname(args.out_md), exist_ok=True)
    md_lines = [
        "# Tahap 2 — Pipeline v4 (Chainlink-Native + 1 Hz Market Tape) Study",
        "",
        f"**Dataset:** {len(df):,} snapshots across **{n_mkts:,} resolved BTC 15m markets** (`{ts_iso(uniq_slugs[0])}` → `{ts_iso(uniq_slugs[-1])}`).  ",
        f"**Strict Temporal Split (16-market embargo):** Train `{len(tr_slugs)}` · Val `{len(val_slugs)}` · Test OOS **`{len(test_slugs)}`** (`{ts_iso(uniq_slugs[test_start])}` → `{ts_iso(uniq_slugs[-1])}`).",
        "",
        "## 1. Normal Trading Window (12m → 2m left) vs Final Minute (15s–60s left)",
        "",
        "| Model | Normal Acc | Normal AUC | Normal Brier | Normal Skill vs Mid | Final 15–45s Brier | Final 15–45s Skill vs Mid |",
        "|---|---:|---:|---:|---:|---:|---:|",
    ]
    for col, label in model_specs:
        rn = normal_benchmarks.get(col)
        rf = final_benchmarks.get(col)
        if not rn:
            continue
        fin_brier = rf["brier"] if rf else "—"
        fin_skill = f"{rf['skillVsMktPct']:+.2f}%" if rf else "—"
        md_lines.append(
            f"| {label} | {rn['accuracyPct']}% | {rn['auc']} | {rn['brier']} | "
            f"{rn['skillVsMktPct']:+.2f}% [{rn['skillCi95'][0]:+.2f}, {rn['skillCi95'][1]:+.2f}] | "
            f"{fin_brier} | {fin_skill} |"
        )

    md_lines.extend(
        [
            "",
            "## 2. Simulated Execution on Real CLOB Asks + CLOB V2 Taker Fee (Strict Test OOS)",
            "",
            "| Preset | Model / Gate | Trades | Blocked (20f) | WR% | Breakeven% | Margin | PnL ($2/tr) | ROI% | PF | Max DD |",
            "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
        ]
    )
    for row in trading_replay:
        for key, mlabel in (
            ("v2NoGate20f", "v2 (no Gate 20f)"),
            ("v2WithGate20f", "v2 + Gate 20f"),
            ("v4Standalone", "v4 Standalone + 20f"),
            ("v4Hybrid", "v4 Hybrid + 20f"),
        ):
            r = row[key]
            margin_str = f"{r['marginPp']:+.2f}pp" if r["marginPp"] is not None else "—"
            md_lines.append(
                f"| {row['label']} | {mlabel} | {r['trades']} | {r['blockedMarketsBy20f']} | "
                f"{r['wrPct'] or '—'}% | {r['breakevenWrPct'] or '—'}% | "
                f"{margin_str} | "
                f"${r['pnlUsd']:+.2f} | {r['roiPct']:+.2f}% | {r['pf'] or '—'} | ${r['maxDdUsd']:.2f} |"
            )

    md_lines.extend(
        [
            "",
            "## 3. Chainlink-Native Feature Ranks (Pipeline v4 Standalone Gain)",
            "",
            "| Rank / 88 | Feature | Gain | Share % | Splits |",
            "|---:|---|---:|---:|---:|",
        ]
    )
    for item in v4_native_ranks:
        md_lines.append(
            f"| #{item['rank']} | `{item['name']}` | {item['gain']} | {item['gainSharePct']}% | {item['splits']} |"
        )

    with open(args.out_md, "w", encoding="utf-8") as fh:
        fh.write("\n".join(md_lines) + "\n")

    print(f"\n[DONE] Saved Study JSON -> {args.out_study}")
    print(f"[DONE] Saved Study MD   -> {args.out_md}")


if __name__ == "__main__":
    main()
