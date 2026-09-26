"""Can an ML model add anything to the FRESH market price? The market-offset study.

Input: fresh_features.csv from exportFreshFeatures.mts - one row per (market,
minute 1..14): the live feature vector, the fresh UP price, the deployed v2
model's P(UP), BTC / Binance window open and a 1m realised volatility.

Models (all probabilities of UP):
  market   the fresh UP print
  v2       the deployed model
  phys     driftless digital price Phi(ln(S/K) / (sigma_1m * sqrt(minutes left)))
  resid    XGBoost trained on the RESIDUAL: base_margin = logit(market), so the
           trees can only move the price; the market price is not a feature
  resid+   the same, allowed to see the market price and its gap to phys
           (favourite-longshot / over-reaction corrections)
  stack    logistic on [logit market, logit phys, logit v2] fitted on SELECT

Protocol: TRAIN < Jul 31 (the period v2 trained on), SELECT Jul 31 -> Sep 1
(hyper-parameters, stacking weights, entry thresholds), VALIDATE >= Sep 1
(the v2 test split), judged once. Scored on the tradable window, 2-12 min left.
Brier skill vs the market with a day-block bootstrap CI; an edge entry rule
(p - ask >= theta, ask = print + 1c, price band, print age guard) chosen on
SELECT by total PnL, then run once on VALIDATE with the same bootstrap.
"""

import argparse
import math
import os

import numpy as np
import pandas as pd
import xgboost as xgb

HERE = os.path.dirname(os.path.abspath(__file__))
SELECT_START = 1785456000  # 2026-07-31 00:00 UTC
VALIDATE_START = 1788232500  # first market of the v2 test split (2026-09-01 03:15 UTC)
TRADABLE = (180, 780)  # secs into the window: 12 .. 2 minutes left
COST = 0.01
EXCLUDE_ALWAYS = [
    "slug_timestamp",
    "secs_into",
    "label",
    "up_fresh",
    "up_age",
    "v2_pred",
    "btc",
    "ptb_binance",
    "rv_1m",
]
MARKET_DERIVED = ["market_yes_price", "crowd_model_divergence"]
rng = np.random.default_rng(2026)


def logit(p):
    p = np.clip(p, 1e-4, 1 - 1e-4)
    return np.log(p / (1 - p))


def sigmoid(x):
    return 1 / (1 + np.exp(-x))


def norm_cdf(z):
    return 0.5 * (1 + np.vectorize(math.erf)(z / math.sqrt(2)))


def fee_per_dollar(c):
    """Taker fee on a $1 buy at c (CLOB V2): 1/c shares x 0.07 c (1 - c), win or lose."""
    return 0.07 * (1 - c)


def load(path):
    df = pd.read_csv(path)
    df = df[(df.up_fresh > 0) & (df.up_fresh < 1)].copy()
    df["day"] = (df.slug_timestamp // 86400).astype(int)
    left = (900 - df.secs_into) / 60
    z = np.log(df.btc / df.ptb_binance) / (df.rv_1m * np.sqrt(left))
    df["phys"] = np.clip(norm_cdf(z.fillna(0).to_numpy()), 1e-3, 1 - 1e-3)
    df["mkt"] = df.up_fresh.clip(0.01, 0.99)
    df["mkt_vs_phys"] = logit(df.mkt) - logit(df.phys)
    return df


def feature_cols(df, with_market):
    derived = ["day", "phys", "mkt", "mkt_vs_phys", "resid", "resid+", "stack", "mkt_recal"]
    cols = [c for c in df.columns if c not in EXCLUDE_ALWAYS + derived]
    if not with_market:
        cols = [c for c in cols if c not in MARKET_DERIVED]
    cols = [c for c in cols if df[c].nunique() > 1]
    return cols + (["mkt", "mkt_vs_phys"] if with_market else ["phys"])


def fit_resid(train, select, cols, params, rounds=2000):
    cut = train.slug_timestamp.quantile(0.8)
    tr = train[
        train.slug_timestamp < cut - 86400
    ]  # one-day embargo before the early-stopping block
    es = train[train.slug_timestamp >= cut]
    dtr = xgb.DMatrix(tr[cols], label=tr.label, base_margin=logit(tr.mkt))
    des = xgb.DMatrix(es[cols], label=es.label, base_margin=logit(es.mkt))
    p = {
        "objective": "binary:logistic",
        "eval_metric": "logloss",
        "tree_method": "hist",
        "seed": 7,
        **params,
    }
    bst = xgb.train(
        p, dtr, rounds, evals=[(des, "es")], early_stopping_rounds=100, verbose_eval=False
    )
    return bst


def predict_resid(bst, df, cols):
    d = xgb.DMatrix(df[cols], base_margin=logit(df.mkt))
    return bst.predict(d, iteration_range=(0, bst.best_iteration + 1))


def fit_logistic(X, y, iters=50, l2=1e-3):
    X = np.column_stack([np.ones(len(X)), X])
    b = np.zeros(X.shape[1])
    for _ in range(iters):
        p = sigmoid(X @ b)
        g = X.T @ (p - y) + l2 * b
        h = (X * (p * (1 - p))[:, None]).T @ X + l2 * np.eye(len(b))
        b -= np.linalg.solve(h, g)
    return b


def brier(p, y):
    return (p - y) ** 2


def skill_ci(df, col, n_boot=2000):
    """Brier skill vs market, and a day-block bootstrap 95% CI."""
    g = (
        df.assign(bm=brier(df.mkt, df.label), bx=brier(df[col], df.label))
        .groupby("day")[["bm", "bx"]]
        .sum()
    )
    bm, bx = g.bm.to_numpy(), g.bx.to_numpy()
    point = 1 - bx.sum() / bm.sum()
    idx = rng.integers(0, len(g), (n_boot, len(g)))
    boots = 1 - bx[idx].sum(1) / bm[idx].sum(1)
    return point, np.percentile(boots, 2.5), np.percentile(boots, 97.5)


def simulate(df, col, theta, band, max_age):
    """First minute per market where the model's side is priced theta below its probability."""
    d = df[(df.secs_into >= TRADABLE[0]) & (df.secs_into <= TRADABLE[1]) & (df.up_age <= max_age)]
    d = d.sort_values(["slug_timestamp", "secs_into"])
    p_up = d[col].to_numpy()
    up = d.mkt.to_numpy()
    side_up = p_up >= 0.5
    ask = np.where(side_up, up, 1 - up) + COST
    prob = np.where(side_up, p_up, 1 - p_up)
    ok = (prob - ask >= theta) & (ask >= band[0]) & (ask <= band[1])
    d = d.assign(ok=ok, ask=ask, win=np.where(side_up, d.label == 1, d.label == 0))
    first = d[d.ok].groupby("slug_timestamp").head(1)
    c = first.ask.to_numpy()
    pnl = np.where(first.win, 1 / c - 1, -1.0) - fee_per_dollar(c)
    return first.assign(pnl=pnl)


def trade_summary(t, n_boot=2000):
    if len(t) == 0:
        return "n=0"
    days = t.groupby("day").pnl.agg(["sum", "count"])
    idx = rng.integers(0, len(days), (n_boot, len(days)))
    s, n = days["sum"].to_numpy(), days["count"].to_numpy()
    roi = s[idx].sum(1) / n[idx].sum(1)
    ndays = t.day.nunique()
    return (
        f"n={len(t):4d} ({len(t) / max(ndays, 1):4.1f}/day) WR {t.win.mean() * 100:5.1f}% avg ask {t.ask.mean():.3f} "
        f"ROI {t.pnl.mean() * 100:+6.1f}% [{np.percentile(roi, 2.5) * 100:+.1f}, {np.percentile(roi, 97.5) * 100:+.1f}] "
        f"PnL {t.pnl.sum():+7.1f}"
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", default=os.path.join(HERE, "fresh_features.csv"))
    ap.add_argument(
        "--max-age", type=float, default=15.0, help="print-age guard (s) for the entry rule"
    )
    args = ap.parse_args()

    df = load(args.input)
    train = df[df.slug_timestamp < SELECT_START]
    select = df[(df.slug_timestamp >= SELECT_START) & (df.slug_timestamp < VALIDATE_START)]
    validate = df[df.slug_timestamp >= VALIDATE_START]
    print(
        f"rows {len(df):,} | markets TRAIN {train.slug_timestamp.nunique():,} SELECT {select.slug_timestamp.nunique():,} "
        f"VALIDATE {validate.slug_timestamp.nunique():,} | print age <= 15 s in {(df.up_age <= 15).mean() * 100:.0f}% of rows"
    )

    configs = {
        "d2": {
            "max_depth": 2,
            "eta": 0.02,
            "min_child_weight": 200,
            "subsample": 0.7,
            "colsample_bytree": 0.7,
            "lambda": 10,
        },
        "d3": {
            "max_depth": 3,
            "eta": 0.02,
            "min_child_weight": 400,
            "subsample": 0.7,
            "colsample_bytree": 0.6,
            "lambda": 20,
            "gamma": 1,
        },
        "d4": {
            "max_depth": 4,
            "eta": 0.01,
            "min_child_weight": 800,
            "subsample": 0.6,
            "colsample_bytree": 0.5,
            "lambda": 50,
            "gamma": 2,
        },
    }
    sel_w = select[(select.secs_into >= TRADABLE[0]) & (select.secs_into <= TRADABLE[1])]
    pm = sel_w.mkt
    print(
        f"  market  SELECT logloss {-np.mean(sel_w.label * np.log(pm) + (1 - sel_w.label) * np.log(1 - pm)):.5f}"
    )
    for name, with_market in (("resid", False), ("resid+", True)):
        cols = feature_cols(df, with_market)
        best = None
        for cname, params in configs.items():
            bst = fit_resid(train, select, cols, params)
            p = predict_resid(bst, sel_w, cols)
            ll = -np.mean(sel_w.label * np.log(p) + (1 - sel_w.label) * np.log(1 - p))
            print(
                f"  {name:7s} {cname}: {bst.best_iteration + 1:4d} trees, SELECT logloss {ll:.5f}"
            )
            if best is None or ll < best[0]:
                best = (ll, cname, bst)
        print(f"  {name}: chosen {best[1]} on SELECT")
        df[name] = predict_resid(best[2], df, cols)
        if name == "resid":
            imp = best[2].get_score(importance_type="gain")
            named = {(cols[int(k[1:])] if k[1:].isdigit() else k): v for k, v in imp.items()}
            top = sorted(named.items(), key=lambda kv: -kv[1])[:10]
            print("  top gain:", ", ".join(f"{k} {v:.1f}" for k, v in top))

    # Stacking weights on SELECT (tradable window) only.
    sel_w = df[(df.slug_timestamp >= SELECT_START) & (df.slug_timestamp < VALIDATE_START)]
    sel_w = sel_w[(sel_w.secs_into >= TRADABLE[0]) & (sel_w.secs_into <= TRADABLE[1])]
    Xs = np.column_stack([logit(sel_w.mkt), logit(sel_w.phys), logit(sel_w.v2_pred)])
    b = fit_logistic(Xs, sel_w.label.to_numpy())
    print(
        f"  stack (SELECT): intercept {b[0]:+.3f}  market {b[1]:.3f}  phys {b[2]:.3f}  v2 {b[3]:.3f}"
    )
    df["stack"] = sigmoid(
        b[0] + np.column_stack([logit(df.mkt), logit(df.phys), logit(df.v2_pred)]) @ b[1:]
    )
    b1 = fit_logistic(logit(sel_w.mkt).to_numpy()[:, None], sel_w.label.to_numpy())
    print(
        f"  market recalibration (SELECT): intercept {b1[0]:+.3f} slope {b1[1]:.3f}  (slope > 1 = the market is under-confident)"
    )
    df["mkt_recal"] = sigmoid(b1[0] + b1[1] * logit(df.mkt))

    models = ["v2_pred", "phys", "resid", "resid+", "stack", "mkt_recal"]
    for split_name, lo, hi in (
        ("SELECT", SELECT_START, VALIDATE_START),
        ("VALIDATE", VALIDATE_START, 1 << 40),
    ):
        d = df[(df.slug_timestamp >= lo) & (df.slug_timestamp < hi)]
        d = d[(d.secs_into >= TRADABLE[0]) & (d.secs_into <= TRADABLE[1])]
        print(
            f"\n== {split_name}: Brier on the tradable window ({len(d):,} market-minutes, {d.slug_timestamp.nunique():,} markets)"
        )
        print(f"   market   {brier(d.mkt, d.label).mean():.4f}")
        for m in models:
            s, lo_ci, hi_ci = skill_ci(d, m)
            print(
                f"   {m:9s} {brier(d[m], d.label).mean():.4f}  skill vs market {s * 100:+5.2f}% [{lo_ci * 100:+.2f}, {hi_ci * 100:+.2f}]"
            )
        fresh = d[d.up_age <= 5]
        print(
            f"   -- prints <= 5 s old only ({len(fresh):,}): market {brier(fresh.mkt, fresh.label).mean():.4f}"
        )
        for m in models:
            s, lo_ci, hi_ci = skill_ci(fresh, m)
            print(
                f"   {m:9s} skill vs market {s * 100:+5.2f}% [{lo_ci * 100:+.2f}, {hi_ci * 100:+.2f}]"
            )

    print(
        f"\n== Edge entry rule: p - ask >= theta (ask = print + {COST * 100:.0f}c), first minute per market, print age <= {args.max_age:.0f} s"
    )
    thetas = [0.02, 0.03, 0.04, 0.05, 0.06, 0.08, 0.10, 0.12, 0.15]
    for band in ((0.50, 0.68), (0.40, 0.75)):
        print(f"  price band {band[0]:.2f}-{band[1]:.2f}")
        for m in ["v2_pred", "resid", "resid+", "stack", "mkt_recal"]:
            sel = df[(df.slug_timestamp >= SELECT_START) & (df.slug_timestamp < VALIDATE_START)]
            best = None
            for th in thetas:
                t = simulate(sel, m, th, band, args.max_age)
                if len(t) >= 40 and (best is None or t.pnl.sum() > best[1]):
                    best = (th, t.pnl.sum())
            if best is None:
                print(f"    {m:9s} no theta with n >= 40 on SELECT")
                continue
            val = df[df.slug_timestamp >= VALIDATE_START]
            t = simulate(val, m, best[0], band, args.max_age)
            print(
                f"    {m:9s} theta {best[0]:.2f} (SELECT PnL {best[1]:+.1f}) -> VALIDATE {trade_summary(t)}"
            )


if __name__ == "__main__":
    main()
