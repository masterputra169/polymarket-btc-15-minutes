"""Would a model with TWAP-correct inputs add information the fresh market price lacks?

    python twapModelStudy.py [--cache rows.npz] [--latency 2] [--cost 0.01] [--basis-lag 1]
        [--no-intercept]

Result (2026-09-26, 2,788 markets 08-26 -> 09-25, test = 09-11 -> 09-25): TWAP features add
nothing before the final minute (physics coefficient ~0); inside it they cut Brier ~7-8% vs the
print (CI borders zero), but a final-minute entry rule does not beat buying the favourite at the
same instants, and its ROI swings with 1-2c of fill assumption. v2 adds nothing beyond the price.
--no-intercept removes the UP/DOWN bias term (UP is ~1.5pp overpriced by the print in both
halves), which otherwise inflates every rule's ROI without being TWAP information.

Decision points every 15 s up to 360 s before the end of each window (binance_1s covers the
last ~400 s; the Chainlink proxy needs a TWAP-anchored basis, so rows start at 300 s left).
Per row: seconds left; the fresh UP price = last print stamped <= t-1 (a print stamped t
happened in [t, t+1)), at most 5 s old, else the row is skipped; the median of the prints in
[t-5, t-1] (a de-noised price: in the final minute prints inside 5 s span a median 10c); the
settlement estimate (expected final Chainlink 60 s TWAP, twapLateBacktest.settle_estimate)
minus the price to beat, in $ and as a z-score; 30 s drift; v2's probability from
fresh_predictions.json (nearest minute <= t). Label = official outcome, final TWAP >= PTB.

z-score: the final TWAP is an average, so its variance given information at t is
sigma^2 * T_eff with T_eff = (L - 60) + 20.5 for L >= 60 s left and L(L+1)(2L+1)/21600
inside the last minute (Brownian motion; seconds already averaged carry no variance).
sigma = RMS of 1 s Binance close changes over the last <= 120 s.

Protocol: split by date at the middle market; models fitted on the first half, judged once on
the second. v2 was trained on markets before TEST_START_SLUG (2026-09-01), so every model that
reads v2 is fitted only on first-half rows after that date. Brier / log loss skill vs the raw
fresh print and vs the recalibrated market (logistic on its logit: a favourite-longshot bias
is not information), with a day-block bootstrap CI.

Entry rule: decide at t on information <= t-1 only: buy side s when
q_s - breakeven(decision price + cost) >= delta (delta chosen on day-block out-of-fold
predictions of the first half), price 0.40-0.95, one trade per market. Fill: the last print at
t + latency ("last", optimistic: a print may be a bid) or the highest price printed for that
side in [t-5, t + latency] ("worst", a conservative ask proxy), plus cost.
"""

import argparse
import bisect
import json
import math
import os

import numpy as np
from sklearn.linear_model import LogisticRegression

import freshBacktest as fb
import twapLateBacktest as tl

HERE = os.path.dirname(os.path.abspath(__file__))
LEFTS = list(range(360, 14, -15))
MAX_AGE = 5
MIN_PRICE = 0.40
MAX_PAY = 0.95
DELTAS = (0.0, 0.01, 0.02, 0.03, 0.05, 0.08)
BUCKETS = (("195-360s", 195, 360), ("75-180s", 75, 180), ("15-60s", 15, 60))
RECAL = "(a') market recalibrated"
COLS = (
    "start", "left", "y", "p_up", "age", "p_med", "dist", "z", "drift30",
    "v2", "v2_age", "exec_last", "exec_hi", "exec_lo",
)  # fmt: skip
rng = np.random.default_rng(11)
OPTS = {"intercept": True}  # --no-intercept: symmetric UP/DOWN models (no directional bias term)


# ---------------------------------------------------------------- rows


def chainlink_proxy(m, basis_lag):
    """twapLateBacktest.chainlink_proxy with the TWAP point stamped tau usable from tau+lag."""
    b = m["binance"]
    basis_at = {}
    for t_ms, v in m["twap"]:
        tau = t_ms // 1000
        window = [b[s] for s in range(tau - 59, tau + 1) if s in b]
        if len(window) >= 50:
            basis_at[tau] = float(np.mean(window)) - v
    taus = sorted(basis_at)
    proxy, j, basis = {}, 0, None
    for s in range(m["end"] - 400, m["end"] + 1):
        while j < len(taus) and taus[j] + basis_lag <= s:
            basis = basis_at[taus[j]]
            j += 1
        c = b.get(s - 1)
        if basis is not None and c is not None:
            proxy[s] = c - basis
    return proxy


def t_eff(left):
    if left >= 60:
        return (left - 60) + 60 * 61 * 121 / 21600
    return left * (left + 1) * (2 * left + 1) / 21600


def norm_cdf(x):
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def up_equiv(tr):
    return tr[2] if tr[1] == 0 else 1 - tr[2]


def prints_between(trades, times, a, b):
    return [
        up_equiv(trades[i])
        for i in range(bisect.bisect_left(times, a), bisect.bisect_right(times, b))
    ]


def last_up(trades, times, t):
    i = bisect.bisect_right(times, t) - 1
    return (None, None) if i < 0 else (up_equiv(trades[i]), t - trades[i][0])


def sigma_1s(binance, t):
    """RMS of 1 s close changes over the candles closed by t (opens <= t-1), <= 120 s."""
    closes = [binance[s] for s in range(t - 121, t) if s in binance]
    if len(closes) < 31:
        return None
    d = np.diff(closes)
    return max(float(np.sqrt(np.mean(d * d))), 0.5)


def market_rows(m, v2, latency, basis_lag):
    proxy = chainlink_proxy(m, basis_lag)
    trades = sorted(m["trades"], key=lambda x: x[0])
    times = [x[0] for x in trades]
    out = []
    for left in LEFTS:
        t = m["end"] - left
        p_up, age = last_up(trades, times, t - 1)
        if p_up is None or age + 1 > MAX_AGE:
            continue
        est = tl.settle_estimate(proxy, t, m["end"])
        sig = sigma_1s(m["binance"], t)
        if est is None or sig is None or proxy.get(t - 30) is None:
            continue
        dist = est - m["ptb"]
        into = 900 - left
        key = (m["start"], (into // 60) * 60)
        p_ex, ex_age = last_up(trades, times, t + latency)
        window = prints_between(trades, times, t - 5, t + latency)
        out.append(
            (
                m["start"], left, 1 - m["outcome"], p_up, age + 1,
                float(np.median(prints_between(trades, times, t - 5, t - 1))),
                dist, dist / (sig * math.sqrt(t_eff(left))),
                (proxy[t] - proxy[t - 30]) / (sig * math.sqrt(30)),
                v2.get(key, np.nan), into - key[1],
                p_ex if ex_age <= MAX_AGE else p_up, max(window), min(window),
            )
        )  # fmt: skip
    return out


def build_rows(latency, basis_lag):
    with open(os.path.join(HERE, "fresh_predictions.json"), encoding="utf-8") as f:
        fp = json.load(f)
    v2 = {(r["slugTs"], r["secsInto"]): r["pred"] for r in fp}
    v2_y = {r["slugTs"]: r["y"] for r in fp}
    starts = sorted(int(f[:-5]) for f in os.listdir(tl.TWAP_DIR) if f.endswith(".json"))
    rows, agree = [], []
    for s in starts:
        m = tl.load_market(s)
        if m is None:
            continue
        if s in v2_y:
            agree.append(v2_y[s] == 1 - m["outcome"])
        rows.extend(market_rows(m, v2, latency, basis_lag))
    print(
        f"label check: TWAP outcome == fresh_predictions y in {np.mean(agree)*100:.2f}% of {len(agree)}"
    )
    return np.array(rows, float)


# ---------------------------------------------------------------- models


def lgt(p, eps=1e-3):
    p = np.clip(p, eps, 1 - eps)
    return np.log(p / (1 - p))


def features(R, which):
    phys = np.array([norm_cdf(v) for v in np.clip(R["z"], -8, 8)])
    cols = {
        "mkt": [lgt(R["p_up"])],
        "med": [lgt(R["p_med"])],
        "v2": [lgt(R["v2"])],
        "twap": [lgt(phys, 1e-4), R["drift30"]],
    }
    return np.column_stack([c for w in which for c in cols[w]])


def bucket_of(left):
    for i, (_, lo, hi) in enumerate(BUCKETS):
        if lo <= left <= hi:
            return i
    return -1


def sub(R, mask):
    return {k: v[mask] for k, v in R.items()}


def fit_predict(Rtr, Rte, which):
    """Per-bucket logistic regressions (the TWAP physics differs inside the last minute)."""
    q = np.full(len(Rte["y"]), np.nan)
    for b in range(len(BUCKETS)):
        mtr, mte = Rtr["bucket"] == b, Rte["bucket"] == b
        if mte.sum() == 0:
            continue
        lr = LogisticRegression(C=10.0, max_iter=2000, fit_intercept=OPTS["intercept"])
        lr.fit(features(sub(Rtr, mtr), which), Rtr["y"][mtr])
        q[mte] = lr.predict_proba(features(sub(Rte, mte), which))[:, 1]
    return q


def brier(p, y):
    return (p - y) ** 2


def logloss(p, y):
    p = np.clip(p, 1e-6, 1 - 1e-6)
    return -(y * np.log(p) + (1 - y) * np.log(1 - p))


def day_boot(day, a, b, n=4000):
    """Mean difference a - b with a day-block bootstrap 95% CI."""
    days = np.unique(day)
    sa = np.array([a[day == d].sum() for d in days])
    sb = np.array([b[day == d].sum() for d in days])
    cnt = np.array([(day == d).sum() for d in days])
    pick = rng.integers(0, len(days), (n, len(days)))
    diff = (sa[pick].sum(1) - sb[pick].sum(1)) / cnt[pick].sum(1)
    return (a.mean() - b.mean(), *np.percentile(diff, [2.5, 97.5]))


def score_block(title, R, preds, ref=RECAL):
    """Brier / log loss / skill vs the raw print; CI of the Brier difference vs the raw print
    and vs `ref` (the recalibrated market: information beyond the price, not a bias fix)."""
    y, day = R["y"], R["start"] // 86400
    mb = brier(R["p_up"], y)
    ab = brier(preds[ref], y) if ref in preds else None
    print(
        f"\n{title}: {len(y)} rows, {len(np.unique(R['start']))} markets, {len(np.unique(day))} days"
    )
    print(
        f"  {'model':<30s} {'Brier':>7s} {'LogLoss':>8s} {'skill':>7s}  {'Brier - print [95% CI]':<34s} Brier - {ref[:4]} [95% CI]"
    )
    print(f"  {'market (last print)':<30s} {mb.mean():7.4f} {logloss(R['p_up'], y).mean():8.4f}")
    for name, p in preds.items():
        bb = brier(p, y)
        d, lo, hi = day_boot(day, bb, mb)
        line = (
            f"  {name:<30s} {bb.mean():7.4f} {logloss(p, y).mean():8.4f} {(1-bb.mean()/mb.mean())*100:+6.2f}%"
            f"  {d:+.5f} [{lo:+.5f}, {hi:+.5f}]"
        )
        if ab is not None and name != ref and not name.startswith(("TWAP physics", "v2 alone")):
            d, lo, hi = day_boot(day, bb, ab)
            line += f"   {d:+.5f} [{lo:+.5f}, {hi:+.5f}]"
        print(line)


# ---------------------------------------------------------------- entry rule


def fill(R, i, side, mode, cost):
    if mode == "last":
        p = R["exec_last"][i] if side else 1 - R["exec_last"][i]
    else:  # worst: the highest price printed for that side in [t-5, t+latency]
        p = R["exec_hi"][i] if side else 1 - R["exec_lo"][i]
    return min(0.99, p + cost)


def entry_trades(R, q, delta, cost, mode, baseline=False):
    order = np.lexsort((-R["left"], R["start"]))  # per market, earliest decision point first
    done, trades = set(), []
    for i in order:
        s = int(R["start"][i])
        if s in done or np.isnan(q[i]):
            continue
        for side in (1, 0):  # 1 = buy UP, 0 = buy DOWN
            dec = min(0.99, (R["p_up"][i] if side else 1 - R["p_up"][i]) + cost)
            if dec < MIN_PRICE or dec > MAX_PAY:
                continue
            if baseline:
                ok = (R["p_up"][i] >= 0.5) == bool(side)
            else:
                ok = (q[i] if side else 1 - q[i]) - fb.breakeven(dec) >= delta
            if ok:
                trades.append(
                    (s, R["y"][i] == side, fill(R, i, side, mode, cost), int(R["left"][i]))
                )
                done.add(s)
                break
    return trades


def same_instant_favourite(R, trades, cost, mode):
    idx = {
        (int(s), int(lf)): i for i, (s, lf) in enumerate(zip(R["start"], R["left"], strict=True))
    }
    out = []
    for s, _w, _c, left in trades:
        i = idx[(s, left)]
        side = int(R["p_up"][i] >= 0.5)
        out.append((s, R["y"][i] == side, fill(R, i, side, mode, cost)))
    return out


def oof(Rtr, which, folds=5):
    """Day-block out-of-fold predictions on the first half (for choosing delta)."""
    day = Rtr["start"] // 86400
    fold_of = {d: i % folds for i, d in enumerate(np.unique(day))}
    f = np.array([fold_of[d] for d in day])
    q = np.full(len(f), np.nan)
    for k in range(folds):
        q[f == k] = fit_predict(sub(Rtr, f != k), sub(Rtr, f == k), which)
    return q


def entry_study(title, Rtr, Rte, models, cost, mode):
    print(
        f"\n{title}: +{cost*100:.0f}c, fill '{mode}', price {MIN_PRICE:.2f}-{MAX_PAY:.2f}, print <= {MAX_AGE}s"
    )
    ndays = len(np.unique(Rte["start"] // 86400))
    for name, which in models.items():
        q_oof = oof(Rtr, which)
        sel = {d: fb.summarize(entry_trades(Rtr, q_oof, d, cost, mode)) for d in DELTAS}
        cands = [d for d in DELTAS if sel[d]["n"] >= 40]
        best = max(cands, key=lambda d: sel[d]["pnl"]) if cands else DELTAS[-1]
        q = fit_predict(Rtr, Rte, which)
        tr = entry_trades(Rte, q, best, cost, mode)
        s = fb.summarize(tr)
        print(
            f"  {name}: delta {best:.2f} chosen out-of-fold (OOF ROI {sel[best].get('roi', np.nan)*100:+.1f}%)"
        )
        if s["n"]:
            print(fb.fmt(f"rule, {s['n']/ndays:.1f}/day", s, fb.day_block_ci(s)))
            base = fb.summarize(same_instant_favourite(Rte, tr, cost, mode))
            print(fb.fmt("favourite, same instants", base, fb.day_block_ci(base)))
            diff = dict(n=s["n"], per_trade=s["per_trade"] - base["per_trade"], days=s["days"])
            lo, hi = fb.day_block_ci(diff)
            day_pnl = [s["per_trade"][s["days"] == d].sum() for d in np.unique(s["days"])]
            print(
                f"   rule - favourite: {diff['per_trade'].mean()*100:+.1f}pp ROI, day-block CI "
                f"[{lo*100:+.1f}, {hi*100:+.1f}]; rule profitable on {np.mean(np.array(day_pnl) > 0)*100:.0f}% of {len(day_pnl)} days"
            )
        curve = []
        for d in DELTAS:
            c = fb.summarize(entry_trades(Rte, q, d, cost, mode))
            curve.append(f"{d:.2f}: n={c['n']} {c.get('roi', np.nan)*100:+.1f}%")
        print("   test curve by delta (not for choosing): " + " | ".join(curve))
    fav = fb.summarize(entry_trades(Rte, Rte["p_up"], 0, cost, mode, baseline=True))
    print(
        fb.fmt(
            f"no model: favourite, first point, {fav['n']/ndays:.1f}/day", fav, fb.day_block_ci(fav)
        )
    )


# ---------------------------------------------------------------- main


def load_rows(args):
    if args.cache and os.path.exists(args.cache):
        A = np.load(args.cache)["rows"]
    else:
        A = build_rows(args.latency, args.basis_lag)
        if args.cache:
            np.savez_compressed(args.cache, rows=A)
    R = {c: A[:, i] for i, c in enumerate(COLS)}
    R["bucket"] = np.array([bucket_of(v) for v in R["left"]])
    return R


def section_probability(Rtr, Rte, iso):
    models = {RECAL: ["mkt"], "(c) market + TWAP": ["mkt", "twap"]}
    preds = {
        "TWAP physics alone, Phi(z)": np.array([norm_cdf(v) for v in np.clip(Rte["z"], -8, 8)])
    }
    preds.update({k: fit_predict(Rtr, Rte, w) for k, w in models.items()})
    preds["median-5s print, recalibrated"] = fit_predict(Rtr, Rte, ["med"])
    preds["(c') median print + TWAP"] = fit_predict(Rtr, Rte, ["med", "twap"])
    print("\n1-2. Out-of-sample probability quality (fitted on the first half)")
    score_block("TEST, all rows", Rte, preds)
    for name, lo, hi in BUCKETS:
        m = (Rte["left"] >= lo) & (Rte["left"] <= hi)
        score_block(f"TEST {name} left", sub(Rte, m), {k: v[m] for k, v in preds.items()})
    m = (Rte["left"] <= 60) & (Rte["p_up"] >= 0.1) & (Rte["p_up"] <= 0.9)
    part = {k: v[m] for k, v in preds.items()}
    score_block("TEST 15-60s left, contested (0.10-0.90)", sub(Rte, m), part)
    score_block(
        "  same rows, TWAP judged against the de-noised price",
        sub(Rte, m),
        part,
        ref="median-5s print, recalibrated",
    )

    hv_tr = ~np.isnan(Rtr["v2"]) & (Rtr["start"] >= fb.TEST_START_SLUG)
    Vtr, Vte = sub(Rtr, hv_tr), sub(Rte, ~np.isnan(Rte["v2"]))
    vmodels = {
        RECAL: ["mkt"],
        "(b) market + v2": ["mkt", "v2"],
        "(c) market + TWAP": ["mkt", "twap"],
        "(d) market + v2 + TWAP": ["mkt", "v2", "twap"],
    }
    vpreds = {"v2 alone (raw)": Vte["v2"]}
    vpreds.update({k: fit_predict(Vtr, Vte, w) for k, w in vmodels.items()})
    print(
        f"\nv2 rows: fitted on {len(Vtr['y'])} first-half rows after {iso(fb.TEST_START_SLUG)} (v2 out-of-sample)"
    )
    score_block("TEST rows with v2", Vte, vpreds)
    m = Vte["left"] <= 60
    score_block("TEST rows with v2, 15-60s left", sub(Vte, m), {k: v[m] for k, v in vpreds.items()})

    print(
        "\n(c) logistic coefficients per bucket, first half: logit(print), logit(Phi(z)), drift_z"
    )
    for b, (name, _, _) in enumerate(BUCKETS):
        mb = Rtr["bucket"] == b
        lr = LogisticRegression(C=10.0, max_iter=2000, fit_intercept=OPTS["intercept"])
        lr.fit(features(sub(Rtr, mb), ["mkt", "twap"]), Rtr["y"][mb])
        print(
            f"  {name:<9s} {np.round(lr.coef_[0], 3)}  intercept {float(np.ravel(lr.intercept_)[0]):+.3f}"
        )


def section_xgb(Rtr, Rte):
    import xgboost as xgb

    Ltr, Lte = sub(Rtr, Rtr["left"] <= 60), sub(Rte, Rte["left"] <= 60)

    def xf(R):
        return np.column_stack([features(R, ["mkt", "med", "twap"]), R["left"]])

    model = xgb.XGBClassifier(
        n_estimators=200, max_depth=2, learning_rate=0.05, subsample=0.8, min_child_weight=20
    )
    model.fit(xf(Ltr), Ltr["y"])
    preds = {
        RECAL: fit_predict(Ltr, Lte, ["mkt"]),
        "(c) market + TWAP (logistic)": fit_predict(Ltr, Lte, ["mkt", "twap"]),
        "small XGBoost print+median+TWAP": model.predict_proba(xf(Lte))[:, 1],
    }
    print("\n2b. Final minute: does a small XGBoost find more than the logistic?")
    score_block("TEST 15-60s left", Lte, preds)


def tape_fill_check(latency):
    """Calibrate the two fill models on the market tape (real best ask, 1 Hz, since 09-24):
    how far the side's ask sits above (a) the last print at t + latency and (b) the highest
    print in [t-5, t + latency], for books where that ask is 0.40-0.95."""
    import glob
    import gzip

    snaps, prints = {}, {}
    for path in sorted(glob.glob(os.path.join(HERE, "tape", "*", "*.jsonl.gz"))):
        with gzip.open(path, "rt") as fh:
            for line in fh:
                o = json.loads(line)
                if o["k"] == "s" and o.get("m") and o.get("u") and o.get("d"):
                    u, d = o["u"], o["d"]
                    if u["a"] and d["a"]:
                        snaps.setdefault(o["m"], {})[o["t"] // 1000] = (u["a"][0][0], d["a"][0][0])
                elif o["k"] == "x" and o.get("m"):
                    p = o["p"] if o["o"] == "u" else 1 - o["p"]
                    prints.setdefault(o["m"], []).append(((o.get("st") or o["t"]) // 1000, p))
    rows = {b[0]: [] for b in BUCKETS}
    for slug, ss in snaps.items():
        pr = sorted(prints.get(slug, []))
        times = [x[0] for x in pr]
        end = int(slug.rsplit("-", 1)[1]) + 900
        for left in LEFTS:
            t = end - left
            b = BUCKETS[bucket_of(left)][0] if bucket_of(left) >= 0 else None
            fill_s = ss.get(t + latency)
            if b is None or fill_s is None:
                continue
            i = bisect.bisect_right(times, t + latency) - 1
            if i < 0 or t + latency - times[i] > MAX_AGE:
                continue
            win = [p for s_, p in pr[bisect.bisect_left(times, t - 5) : i + 1]]
            for side, ask in ((1, fill_s[0]), (0, fill_s[1])):
                if not MIN_PRICE <= ask <= MAX_PAY:
                    continue
                last = pr[i][1] if side else 1 - pr[i][1]
                worst = max(win) if side else 1 - min(win)
                rows[b].append((ask - last, ask - worst))
    print(
        f"\n5. Fill realism on the tape ({len(snaps)} markets): side's ask at t+{latency}s minus the fill model"
    )
    for b, v in rows.items():
        if v:
            a = np.array(v)
            print(
                f"  {b:<9s} n={len(a):5d}  ask - last print: mean {a[:, 0].mean()*100:+5.1f}c median {np.median(a[:, 0])*100:+4.1f}c"
                f" | ask - worst print: mean {a[:, 1].mean()*100:+5.1f}c median {np.median(a[:, 1])*100:+4.1f}c"
            )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", default=None, help="npz file to store / reuse the built rows")
    ap.add_argument("--latency", type=int, default=2)
    ap.add_argument("--cost", type=float, default=0.01)
    ap.add_argument(
        "--basis-lag", type=int, default=1, help="s after its stamp a TWAP point is usable"
    )
    ap.add_argument(
        "--no-intercept", action="store_true", help="symmetric models: no UP/DOWN bias term"
    )
    args = ap.parse_args()
    OPTS["intercept"] = not args.no_intercept

    R = load_rows(args)
    starts = np.unique(R["start"])
    split = starts[len(starts) // 2]
    Rtr, Rte = sub(R, R["start"] < split), sub(R, R["start"] >= split)
    iso = lambda s: np.datetime_as_string(np.datetime64(int(s), "s"), unit="m")  # noqa: E731
    print(
        f"{len(R['y'])} rows, {len(starts)} markets {iso(starts[0])} -> {iso(starts[-1])} UTC; "
        f"train < {iso(split)} ({len(Rtr['y'])} rows), test {len(Rte['y'])} rows; "
        f"seconds left {int(R['left'].min())}-{int(R['left'].max())}"
    )
    print(
        f"print age median {np.median(R['age']):.0f}s; v2 on {np.mean(~np.isnan(R['v2']))*100:.0f}% of rows"
    )

    section_probability(Rtr, Rte, iso)
    section_xgb(Rtr, Rte)

    models = {RECAL: ["mkt"], "(c) market + TWAP": ["mkt", "twap"]}
    for mode in ("last", "worst"):
        entry_study("3. Entry rule, 15-300 s left", Rtr, Rte, models, args.cost, mode)
    Ltr, Lte = sub(Rtr, Rtr["left"] <= 60), sub(Rte, Rte["left"] <= 60)
    for mode, cost in (
        ("last", args.cost),
        ("last", args.cost + 0.01),
        ("last", args.cost + 0.02),
        ("worst", args.cost),
    ):
        entry_study("3b. Entry rule, final minute only", Ltr, Lte, models, cost, mode)
    hv_tr = ~np.isnan(Rtr["v2"]) & (Rtr["start"] >= fb.TEST_START_SLUG)
    vm = {"(b) market + v2": ["mkt", "v2"], "(d) market + v2 + TWAP": ["mkt", "v2", "twap"]}
    entry_study(
        "3c. Entry rule with v2, 15-300 s left",
        sub(Rtr, hv_tr),
        sub(Rte, ~np.isnan(Rte["v2"])),
        vm,
        args.cost + 0.01,
        "last",
    )
    if os.path.isdir(os.path.join(HERE, "tape")):
        tape_fill_check(args.latency)


if __name__ == "__main__":
    main()
