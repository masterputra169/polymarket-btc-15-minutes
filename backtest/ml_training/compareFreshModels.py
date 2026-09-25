"""Head-to-head of two models on FRESH historical prices, on markets neither trained on.

    python compareFreshModels.py --a fresh_predictions.json --b fresh_predictions_p3.json \
        --since <first slug out-of-sample for BOTH> [--split <slug>]

Both files come from predictFreshPrices.mts (same markets, same minutes, the
model re-predicted with the token price as fresh as a live quote). Reports, per
model: Brier and log loss vs the fresh market price (skill), the weight the
outcome puts on the model beside the price, calibration by claimed probability,
and the event-driven backtest of the live entry rule with its Monte Carlo (from
freshBacktest.py). Differences come with a market-level bootstrap CI.
"""

import argparse
import itertools
import json
import os
from collections import defaultdict

import numpy as np

import freshBacktest as fb

HERE = os.path.dirname(os.path.abspath(__file__))
rng = np.random.default_rng(7)


def load(path, since):
    with open(path, encoding="utf-8") as f:
        rows = json.load(f)
    return {(r["slugTs"], r["secsInto"]): r for r in rows if r["slugTs"] >= since}


def tradeable(r):
    left = (900 - r["secsInto"]) / 60
    return 2 <= left <= 12 and r["upAge"] <= 30


def brier(p, y):
    return float(np.mean((p - y) ** 2))


def logloss(p, y):
    q = np.clip(p, 1e-6, 1 - 1e-6)
    return float(-np.mean(y * np.log(q) + (1 - y) * np.log(1 - q)))


def one_minute_per_market(keys):
    by = defaultdict(list)
    for k in keys:
        by[k[0]].append(k)
    return [v[rng.integers(0, len(v))] for _, v in sorted(by.items())]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--a", default=os.path.join(HERE, "fresh_predictions.json"))
    ap.add_argument("--b", default=os.path.join(HERE, "fresh_predictions_p3.json"))
    ap.add_argument("--label-a", default="v2")
    ap.add_argument("--label-b", default="v3")
    ap.add_argument("--since", type=int, required=True)
    ap.add_argument("--split", type=int, default=fb.TEST_START_SLUG)
    args = ap.parse_args()

    A, B = load(args.a, args.since), load(args.b, args.since)
    keys = sorted(k for k in set(A) & set(B) if tradeable(A[k]))
    sample = one_minute_per_market(keys)
    y = np.array([A[k]["y"] for k in sample], float)
    mkt = np.array([A[k]["up"] for k in sample], float)
    pa = np.array([A[k]["pred"] for k in sample], float)
    pb = np.array([B[k]["pred"] for k in sample], float)
    n = len(sample)
    print(
        f"{n} markets out-of-sample for both (since {args.since}), one random tradeable minute each\n"
    )

    print("1. Probability quality vs the FRESH market price")
    mb = brier(mkt, y)
    print(f"   {'':22s} {'Brier':>7s} {'LogLoss':>8s} {'skill vs mkt':>12s}")
    for lab, p in (("market (fresh print)", mkt), (args.label_a, pa), (args.label_b, pb)):
        print(
            f"   {lab:22s} {brier(p, y):7.4f} {logloss(p, y):8.4f} {(1 - brier(p, y) / mb) * 100:+11.1f}%"
        )
    idx = rng.integers(0, n, (4000, n))
    d = ((pb[idx] - y[idx]) ** 2).mean(1) - ((pa[idx] - y[idx]) ** 2).mean(1)
    print(
        f"   {args.label_b} - {args.label_a} Brier: {brier(pb, y) - brier(pa, y):+.4f}  "
        f"95% CI [{np.percentile(d, 2.5):+.4f}, {np.percentile(d, 97.5):+.4f}]  (negative = {args.label_b} better)"
    )
    for lab, p in ((args.label_a, pa), (args.label_b, pb)):
        dm = ((p[idx] - y[idx]) ** 2).mean(1) - ((mkt[idx] - y[idx]) ** 2).mean(1)
        print(
            f"   {lab} - market Brier: {brier(p, y) - mb:+.4f}  "
            f"95% CI [{np.percentile(dm, 2.5):+.4f}, {np.percentile(dm, 97.5):+.4f}]"
        )

    print("\n2. Weight on the model beside the fresh price (logit model, favourite side)")
    for lab, p in ((args.label_a, pa), (args.label_b, pb)):
        up = p >= 0.5
        ps = np.where(up, p, 1 - p)
        q = np.where(up, mkt, 1 - mkt)
        win = np.where(up, y == 1, y == 0).astype(float)
        keep = (q >= 0.5) & (q <= 0.95)
        b = fb.fit_logistic(np.column_stack([fb.logit(q[keep]), fb.logit(ps[keep])]), win[keep])
        print(
            f"   {lab}: b_market {b[1]:+.2f}  b_model {b[2]:+.2f}  -> weight on model {b[2] / (b[1] + b[2]):.2f}"
        )

    print("\n3. Calibration on the side the model favours (claimed vs actual)")
    edges = [0.5, 0.6, 0.7, 0.8, 1.01]
    for lab, p in ((args.label_a, pa), (args.label_b, pb)):
        ps = np.maximum(p, 1 - p)
        win = np.where(p >= 0.5, y == 1, y == 0)
        parts = []
        for lo, hi in itertools.pairwise(edges):
            m = (ps >= lo) & (ps < hi)
            if m.sum():
                parts.append(
                    f"{lo:.1f}-{min(hi, 1):.1f}: n={m.sum()} claim {ps[m].mean()*100:.0f}% won {win[m].mean()*100:.0f}%"
                )
        print(f"   {lab}: " + " | ".join(parts))

    print("\n4. Event backtest of the live entry rule (+1c cost), halves split at", args.split)
    key_set = set(keys)
    rule = fb.make_rules()["CURRENT: conf>=0.65 (0.45 if edge>=15%)"]
    base = fb.make_rules()["NO-ML baseline: buy the favourite"]
    for lab, D in ((args.label_a, A), (args.label_b, B)):
        by = defaultdict(list)
        for k, r in D.items():
            if k in key_set:
                by[k[0]].append(r)
        markets = [(ts, sorted(rs, key=lambda r: r["secsInto"])) for ts, rs in sorted(by.items())]
        for part, ms in (
            ("first half", [m for m in markets if m[0] < args.split]),
            ("second half", [m for m in markets if m[0] >= args.split]),
            ("all", markets),
        ):
            s = fb.summarize(fb.simulate(ms, *rule, 0.01))
            ci = fb.day_block_ci(s) if s["n"] >= 10 else None
            print(fb.fmt(f"{lab} current rule, {part}", s, ci))
        if lab == args.label_a:
            s0 = fb.summarize(fb.simulate(markets, *base, 0.01))
            print(fb.fmt("no-ML favourite, all", s0, fb.day_block_ci(s0)))
        s_all = fb.summarize(fb.simulate(markets, *rule, 0.01))
        if s_all["n"] >= 30:
            fb.monte_carlo(s_all, f"{lab} current rule, all OOS markets")


if __name__ == "__main__":
    main()
