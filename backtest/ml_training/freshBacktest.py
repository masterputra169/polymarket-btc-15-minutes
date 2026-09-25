"""Event-driven backtest of ML entry rules on FRESH historical token prices, plus a
Monte Carlo of bankroll risk.

Input: fresh_predictions.json from predictFreshPrices.mts — one row per (market,
minute), the model re-predicted with the token price rebuilt from per-second
trade prints (as fresh as a live quote), never the ~1/min lookup print.

Simulation (per rule): walk each market minute by minute; enter at the FIRST
minute every gate passes, at most one trade per market, on the model's side.
Gates replicated from the bot: time left 2-12 min; entry floor 50c; ceiling 63c
(63-75c only with conf >= 0.85, hard cap 75c); late phase (<5 min) conf >= 0.80
(0.55 if edge >= 15%); BTC distance from PTB >= 0.04% (0.02% with > 10 min left,
bypassed at conf >= 0.80); trending regime: token >= 60c, no entry with > 10 min
left, ML conf >= 0.55 with / 0.65 against the BTC side unless edge >= 15%.
Not replicable offline: rule agreement, signal stability, VPIN, spread widening,
the ensemble edge ceiling -> trade counts are upper bounds, comparisons are fair.

Economics: pay = last print + COST (tape: spread 1c in 98% of snapshots);
fee 0.072 c (1 - c) on profit; breakeven c / ((1 - c)(1 - r) + c).

Protocol: rules are chosen on SELECT (Jul 31 -> Aug 27) and judged on VALIDATE
(Aug 28 -> Sep 23) only. Monte Carlo resamples VALIDATE trades by day.
"""

import argparse
import json
import os
from collections import defaultdict

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
# First market of the v2 test split (training_data.csv row 12,431); earlier OOS rows = holdout.
TEST_START_SLUG = 1788232500
BANKROLL = 56.0
STAKE_USD = 1.31  # median dry-run stake on Railway (458 trades)
rng = np.random.default_rng(2026)


def fee(c):
    return 0.072 * c * (1 - c)


def breakeven(c):
    return c / ((1 - c) * (1 - fee(c)) + c)


def pnl_per_dollar(win, c):
    return np.where(win, (1 / c - 1) * (1 - fee(c)), -1.0)


def logit(x):
    x = np.clip(x, 1e-4, 1 - 1e-4)
    return np.log(x / (1 - x))


def fit_logistic(X, y, iters=60):
    X = np.column_stack([np.ones(len(X)), X])
    b = np.zeros(X.shape[1])
    for _ in range(iters):
        mu = 1 / (1 + np.exp(-X @ b))
        H = X.T @ (X * (mu * (1 - mu))[:, None]) + 1e-9 * np.eye(X.shape[1])
        step = np.linalg.solve(H, X.T @ (y - mu))
        b += step
        if np.abs(step).max() < 1e-10:
            break
    return b


def load(path):
    with open(path, encoding="utf-8") as f:
        rows = json.load(f)
    by_market = defaultdict(list)
    for r in rows:
        by_market[r["slugTs"]].append(r)
    markets = []
    for ts, rs in sorted(by_market.items()):
        rs.sort(key=lambda r: r["secsInto"])
        markets.append((ts, rs))
    return rows, markets


def side_view(r):
    p = r["pred"]
    up = p >= 0.5
    ps = p if up else 1 - p
    quote = r["up"] if up else 1 - r["up"]
    win = (r["y"] == 1) if up else (r["y"] == 0)
    conf = 2 * abs(p - 0.5)
    btc_up = r["btc"] > r["ptb"]
    aligned = (up and btc_up) or ((not up) and (r["btc"] < r["ptb"]))
    return up, ps, quote, win, conf, aligned


def gates_ok(r, ps, quote, conf, aligned, use_ml=True):
    """Replicable bot gates other than the ML entry rule itself.

    use_ml=False keeps only the gates that do not read the model (time, price,
    BTC distance without its ML bypass, the trending price/time gates), so the
    no-ML baseline faces the same market conditions as the ML rules.
    """
    left = (900 - r["secsInto"]) / 60
    if left < 2 or left > 12 or r["upAge"] > 30:
        return False
    if quote < 0.50:
        return False
    if quote > (0.75 if use_ml and conf >= 0.85 else 0.63):
        return False
    edge = ps - quote
    if use_ml and left < 5 and conf < (0.55 if edge >= 0.15 else 0.80):
        return False
    dist = abs(r["btc"] - r["ptb"]) / r["ptb"] * 100
    if not (use_ml and conf >= 0.80) and dist < (0.02 if left > 10 else 0.04):
        return False
    if r.get("regime") == "trending":
        if quote < 0.60 or left > 10:
            return False
        if use_ml and edge < 0.15 and conf < (0.55 if aligned else 0.65):
            return False
    return True


def make_rules():
    rules = {}
    rules["NO-ML baseline: buy the favourite"] = ("baseline", None)
    rules["CURRENT: conf>=0.65 (0.45 if edge>=15%)"] = ("current", None)
    for t in (0.0, 0.20, 0.30, 0.40, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70, 0.80):
        rules[f"conf>={t:.2f}"] = ("conf", t)
    for lam in (0.25, 0.5, 0.75, 1.0):
        for delta in (0.0, 0.02, 0.04, 0.06):
            rules[f"edge lam={lam:.2f} q-BE>={delta*100:.0f}pp"] = ("edge", (lam, delta))
    return rules


def passes(kind, arg, r, ps, quote, conf, cost):
    c = quote + cost
    if kind == "baseline":
        return True
    if kind == "current":
        return conf >= (0.45 if ps - quote >= 0.15 else 0.65)
    if kind == "conf":
        return conf >= arg
    lam, delta = arg
    q = quote + lam * (ps - quote)
    return q - breakeven(c) >= delta


def simulate(markets, kind, arg, cost):
    trades = []
    for ts, rs in markets:
        for r in rs:
            up, ps, quote, win, conf, aligned = side_view(r)
            if kind == "baseline":
                # favourite = the market's side, not the model's
                up = r["up"] >= 0.5
                quote = r["up"] if up else 1 - r["up"]
                win = (r["y"] == 1) if up else (r["y"] == 0)
                ps = quote
                conf = 0.0
                aligned = (up and r["btc"] > r["ptb"]) or ((not up) and r["btc"] < r["ptb"])
            if not gates_ok(r, ps, quote, conf, aligned, use_ml=kind != "baseline"):
                continue
            if not passes(kind, arg, r, ps, quote, conf, cost):
                continue
            c = min(quote + cost, 0.99)
            trades.append((ts, bool(win), c))
            break
    return trades


def summarize(trades):
    if not trades:
        return dict(n=0)
    w = np.array([t[1] for t in trades])
    c = np.array([t[2] for t in trades])
    pnl = pnl_per_dollar(w, c)
    return dict(
        n=len(trades),
        wr=w.mean(),
        price=c.mean(),
        be=breakeven(c).mean(),
        roi=pnl.mean(),
        pnl=pnl.sum(),
        per_trade=pnl,
        days=np.array([t[0] // 86400 for t in trades]),
    )


def day_block_ci(s, n=4000):
    if s["n"] < 10:
        return (np.nan, np.nan)
    days = np.unique(s["days"])
    idx_by_day = [np.flatnonzero(s["days"] == d) for d in days]
    means = []
    for _ in range(n):
        pick = rng.integers(0, len(days), len(days))
        idx = np.concatenate([idx_by_day[i] for i in pick])
        means.append(s["per_trade"][idx].mean())
    return float(np.percentile(means, 2.5)), float(np.percentile(means, 97.5))


def fmt(label, s, ci=None):
    if s["n"] == 0:
        return f"  {label:<34s} n=   0"
    out = (
        f"  {label:<34s} n={s['n']:4d}  WR {s['wr']*100:5.1f}%  paid {s['price']*100:4.1f}c  "
        f"BE {s['be']*100:5.1f}%  margin {(s['wr']-s['be'])*100:+5.1f}pp  ROI {s['roi']*100:+6.2f}%  "
        f"PnL/$1 {s['pnl']:+7.2f}"
    )
    if ci is not None:
        out += f"  CI [{ci[0]*100:+.1f}%, {ci[1]*100:+.1f}%]"
    return out


def lambda_study(rows):
    """How much does the model know beyond a FRESH price? One random minute per market."""
    by = defaultdict(list)
    for r in rows:
        left = (900 - r["secsInto"]) / 60
        if 2 <= left <= 12 and r["upAge"] <= 30:
            by[r["slugTs"]].append(r)
    keys = sorted(by)

    def fit(sample_keys):
        X, y = [], []
        for k in sample_keys:
            r = by[k][rng.integers(0, len(by[k]))]
            _, ps, quote, win, _, _ = side_view(r)
            if quote < 0.5 or quote > 0.95:
                continue
            X.append((logit(quote), logit(ps)))
            y.append(float(win))
        b = fit_logistic(np.array(X), np.array(y))
        return b[1], b[2], len(y)

    bm, bp, n = fit(keys)
    boots = []
    for _ in range(300):
        ks = [keys[i] for i in rng.integers(0, len(keys), len(keys))]
        m, p, _ = fit(ks)
        boots.append(p / (m + p) if (m + p) != 0 else np.nan)
    boots = np.array(boots)
    lo, hi = np.nanpercentile(boots, [2.5, 97.5])
    return bm, bp, n, bp / (bm + bp), lo, hi


def kelly_fraction(per_trade):
    fs = np.linspace(0, 0.25, 251)
    growth = [np.mean(np.log1p(f * per_trade)) for f in fs]
    return float(fs[int(np.argmax(growth))])


def monte_carlo(s, label, n_paths=10_000, n_trades=500):
    """Resample VALIDATE trades by day (keeps within-day clustering) into 500-trade futures."""
    days = np.unique(s["days"])
    by_day = [s["per_trade"][s["days"] == d] for d in days]
    results = {}
    for sizing, desc in (
        ("fixed", f"fixed ${STAKE_USD:.2f}/trade (today's median)"),
        ("frac", "2.3% of bankroll (today's ratio)"),
    ):
        finals, maxdd, ruin = [], [], 0
        for _ in range(n_paths):
            seq = []
            while len(seq) < n_trades:
                seq.extend(by_day[rng.integers(0, len(by_day))])
            seq = np.array(seq[:n_trades])
            bank, peak, dd = BANKROLL, BANKROLL, 0.0
            for r in seq:
                stake = STAKE_USD if sizing == "fixed" else 0.023 * bank
                stake = min(stake, bank)
                bank += stake * r
                peak = max(peak, bank)
                dd = max(dd, (peak - bank) / peak if peak > 0 else 0)
                if bank < 5:
                    break
            finals.append(bank)
            maxdd.append(dd)
            ruin += bank < BANKROLL * 0.5
        finals, maxdd = np.array(finals), np.array(maxdd)
        results[sizing] = (desc, finals, maxdd, ruin / n_paths)
    print(
        f"\n  Monte Carlo — {label}: {n_paths:,} futures of {n_trades} trades, bankroll ${BANKROLL:.0f}"
    )
    for desc, finals, maxdd, ruin in results.values():
        p5, p50, p95 = np.percentile(finals, [5, 50, 95])
        print(
            f"   {desc:<40s} final bankroll p5 ${p5:6.1f} | median ${p50:6.1f} | p95 ${p95:6.1f}"
            f" | P(loss) {np.mean(finals < BANKROLL)*100:4.1f}% | P(<50%) {ruin*100:4.1f}%"
            f" | max drawdown median {np.median(maxdd)*100:4.1f}%, p95 {np.percentile(maxdd, 95)*100:4.1f}%"
        )
    kf = kelly_fraction(s["per_trade"])
    print(
        f"   growth-optimal (Kelly) fraction on these trades: {kf*100:.1f}% of bankroll per trade"
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", default=os.path.join(HERE, "fresh_predictions.json"))
    args = ap.parse_args()
    rows, markets = load(args.input)
    sel = [m for m in markets if m[0] < TEST_START_SLUG]
    val = [m for m in markets if m[0] >= TEST_START_SLUG]
    print(
        f"{len(rows)} market-minutes, {len(markets)} markets (SELECT {len(sel)}, VALIDATE {len(val)})"
    )
    ages = np.array([r["upAge"] for r in rows])
    print(
        f"fresh price age: median {np.median(ages):.0f}s, p90 {np.percentile(ages, 90):.0f}s, p99 {np.percentile(ages, 99):.0f}s"
    )

    bm, bp, n, w, lo, hi = lambda_study(rows)
    print("\n1. Outcome ~ logit(fresh market price) + logit(model), one random minute per market")
    print(
        f"   n={n}  b_market {bm:+.2f}  b_model {bp:+.2f}  -> weight on model {w:.2f}  (95% CI {lo:.2f} .. {hi:.2f})"
    )

    rules = make_rules()
    for cost in (0.01, 0.005, 0.02):
        tag = "DEFAULT" if cost == 0.01 else "sensitivity"
        print(f"\n2. Event-driven backtest, execution cost +{cost*100:.1f}c ({tag})")
        sel_scores = {k: summarize(simulate(sel, *v, cost)) for k, v in rules.items()}
        if cost == 0.01:
            print("   SELECT (Jul 31 -> Aug 27):")
            for k, s in sel_scores.items():
                print(fmt(k, s))
        cands = {
            k: s
            for k, s in sel_scores.items()
            if s["n"] >= 40 and not k.startswith(("NO-ML", "CURRENT"))
        }
        best = max(cands, key=lambda k: cands[k]["pnl"]) if cands else None
        print(f"   chosen on SELECT (max PnL, n>=40): {best}")
        print("   VALIDATE (Aug 28 -> Sep 23), judged once:")
        keep = {}
        for k in (
            "NO-ML baseline: buy the favourite",
            "CURRENT: conf>=0.65 (0.45 if edge>=15%)",
            best,
        ):
            if k is None:
                continue
            s = summarize(simulate(val, *rules[k], cost))
            keep[k] = s
            print(fmt(k, s, day_block_ci(s)))
        if cost == 0.01:
            print("   VALIDATE, every rule (for the curve, not for choosing):")
            for k, v in rules.items():
                s = summarize(simulate(val, *v, cost))
                print(fmt(k, s))
            print("\n3. Monte Carlo on VALIDATE trades (+1c cost)")
            for k, s in keep.items():
                if s["n"] >= 30:
                    monte_carlo(s, k)


if __name__ == "__main__":
    main()
