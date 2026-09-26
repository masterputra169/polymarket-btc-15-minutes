"""Does the order book know more than the price? A microstructure check on the tape.

For every market on the local tape (npm run tape:pull) with a known outcome
(tape/_resolutions.json), one UP-book sample every 10 s with 2-12 minutes left:

  mid        (best bid + best ask) / 2
  micro      Stoikov-style microprice: (bid * ask_size + ask * bid_size) / (bid_size + ask_size)
  last       the last UP-equivalent trade print (what the backtests call "fresh")
  imb1/imb5  bid share of the size at the top 1 / top 5 levels

Questions:
  1. Which price is the better probability of the outcome (Brier, market-block
     bootstrap CI of the difference)?
  2. Does imbalance add anything to the mid (logistic, fitted on the first 60%
     of markets in time, scored on the rest)?
  3. Does (micro - mid) or imbalance predict the next 30 s mid move, and is that
     move ever bigger than the half-spread a taker pays?

The tape starts 2026-09-24, so this is a first look (a few hundred markets),
not a verdict.
"""

import glob
import json
import os
import zlib

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
TAPE = os.path.join(HERE, "tape")
rng = np.random.default_rng(11)


def read_lines(path):
    """Concatenated gzip members; tolerate a truncated final member."""
    with open(path, "rb") as fh:
        raw = fh.read()
    out = []
    while raw:
        d = zlib.decompressobj(16 + zlib.MAX_WBITS)
        try:
            chunk = d.decompress(raw)
        except zlib.error:
            break
        out.append(chunk)
        raw = d.unused_data
        if not d.eof:
            break
    for line in b"".join(out).decode("utf-8", "replace").splitlines():
        if line:
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue


def slug_start(slug):
    return int(slug.rsplit("-", 1)[1])


def load():
    with open(os.path.join(TAPE, "_resolutions.json"), encoding="utf-8") as fh:
        outcomes = json.load(fh)["markets"]
    snaps, trades = {}, {}
    for f in sorted(glob.glob(os.path.join(TAPE, "*", "*.jsonl.gz"))):
        for o in read_lines(f):
            m = o.get("m")
            if not m or m not in outcomes:
                continue
            if o["k"] == "s" and o.get("ok") == 1 and o.get("u"):
                snaps.setdefault(m, []).append((o["t"], o["u"]))
            elif o["k"] == "x" and o.get("p"):
                p = o["p"] if o["o"] == "u" else 1 - o["p"]
                trades.setdefault(m, []).append((o.get("st") or o["t"], p))
    return outcomes, snaps, trades


def top(book):
    bids = sorted(book.get("b", []), key=lambda lv: -lv[0])
    asks = sorted(book.get("a", []), key=lambda lv: lv[0])
    if not bids or not asks:
        return None
    return bids, asks


def samples(outcomes, snaps, trades):
    rows = []
    for m, ss in snaps.items():
        y = 1 if outcomes[m]["outcome"] == "UP" else 0
        end = (slug_start(m) + 900) * 1000
        ss.sort(key=lambda s: s[0])
        tr = sorted(trades.get(m, []))
        tt = np.array([t for t, _ in tr]) if tr else np.array([])
        by_t = {}
        for t, book in ss:
            by_t[t // 1000] = book
        next_t = -1
        for t, book in ss:
            left = (end - t) / 1000
            if left < 120 or left > 720 or t < next_t:
                continue
            tb = top(book)
            if tb is None:
                continue
            bids, asks = tb
            bb, bs = bids[0]
            ba, as_ = asks[0]
            if ba - bb > 0.05 or bs <= 0 or as_ <= 0:
                continue
            mid = (bb + ba) / 2
            micro = (bb * as_ + ba * bs) / (bs + as_)
            b5 = sum(s for _, s in bids[:5])
            a5 = sum(s for _, s in asks[:5])
            k = np.searchsorted(tt, t, side="right") - 1 if len(tt) else -1
            last = tr[k][1] if k >= 0 else np.nan
            fut = by_t.get(t // 1000 + 30)
            fmid = np.nan
            if fut is not None and (ft := top(fut)) is not None:
                fmid = (ft[0][0][0] + ft[1][0][0]) / 2
            rows.append(
                (
                    slug_start(m),
                    y,
                    left,
                    mid,
                    micro,
                    last,
                    bs / (bs + as_),
                    b5 / (b5 + a5),
                    ba - bb,
                    fmid,
                )
            )
            next_t = t + 10_000
    return np.array(rows, dtype=float)


def brier_diff_ci(y, a, b, groups, n_boot=2000):
    """Mean Brier(a) - Brier(b) with a market-block bootstrap CI."""
    d = (a - y) ** 2 - (b - y) ** 2
    ug, inv = np.unique(groups, return_inverse=True)
    sums = np.bincount(inv, d)
    cnts = np.bincount(inv)
    idx = rng.integers(0, len(ug), (n_boot, len(ug)))
    boots = sums[idx].sum(1) / cnts[idx].sum(1)
    return d.mean(), np.percentile(boots, 2.5), np.percentile(boots, 97.5)


def logit(p):
    p = np.clip(p, 1e-3, 1 - 1e-3)
    return np.log(p / (1 - p))


def fit_logistic(X, y, iters=40, l2=1e-3):
    X = np.column_stack([np.ones(len(X)), X])
    b = np.zeros(X.shape[1])
    for _ in range(iters):
        p = 1 / (1 + np.exp(-(X @ b)))
        g = X.T @ (p - y) + l2 * b
        h = (X * (p * (1 - p))[:, None]).T @ X + l2 * np.eye(len(b))
        b -= np.linalg.solve(h, g)
    return b


def main():
    outcomes, snaps, trades = load()
    r = samples(outcomes, snaps, trades)
    slug, y, _left, mid, micro, last, imb1, imb5, spread, fmid = r.T
    print(
        f"{len(np.unique(slug))} markets, {len(r):,} samples (every 10 s, 2-12 min left, spread <= 5c)"
    )
    print(
        f"spread: 1c in {np.mean(np.isclose(spread, 0.01)) * 100:.0f}% of samples; |micro - mid| >= 0.5c in {np.mean(np.abs(micro - mid) >= 0.005) * 100:.0f}%"
    )

    print("\n1. Brier (lower is better) and the difference vs mid, market-block CI")
    for name, p in (("mid", mid), ("micro", micro)):
        print(f"   {name:6s} {np.mean((p - y) ** 2):.4f}")
    d, lo, hi = brier_diff_ci(y, micro, mid, slug)
    print(f"   micro - mid: {d:+.5f} [{lo:+.5f}, {hi:+.5f}]")
    ok = ~np.isnan(last)
    d, lo, hi = brier_diff_ci(y[ok], last[ok], mid[ok], slug[ok])
    print(
        f"   last - mid (n={ok.sum():,}): {d:+.5f} [{lo:+.5f}, {hi:+.5f}]  (Brier last {np.mean((last[ok] - y[ok]) ** 2):.4f})"
    )

    print("\n2. Does imbalance add to the mid? logistic, fitted on the first 60% of markets")
    cut = np.quantile(np.unique(slug), 0.6)
    tr, te = slug < cut, slug >= cut
    for name, cols in (
        ("mid", [logit(mid)]),
        ("mid + imb5", [logit(mid), imb5 - 0.5]),
        ("mid + imb1", [logit(mid), imb1 - 0.5]),
    ):
        X = np.column_stack(cols)
        b = fit_logistic(X[tr], y[tr])
        p = 1 / (1 + np.exp(-(b[0] + X[te] @ b[1:])))
        ll = -np.mean(y[te] * np.log(p) + (1 - y[te]) * np.log(1 - p))
        print(
            f"   {name:11s} coef {np.round(b, 3)}  test logloss {ll:.5f}  Brier {np.mean((p - y[te]) ** 2):.5f}"
        )

    print("\n3. Next-30 s mid move vs (micro - mid) and imbalance")
    ok = ~np.isnan(fmid)
    dm = fmid[ok] - mid[ok]
    for name, x in (("micro - mid", (micro - mid)[ok]), ("imb5 - 0.5", (imb5 - 0.5)[ok])):
        X = np.column_stack([np.ones(ok.sum()), x])
        beta, *_ = np.linalg.lstsq(X, dm, rcond=None)
        pred = X @ beta
        r2 = 1 - np.sum((dm - pred) ** 2) / np.sum((dm - dm.mean()) ** 2)
        print(
            f"   {name:11s} slope {beta[1]:+.3f}  R^2 {r2:.4f}  predicted |move| > half-spread in {np.mean(np.abs(pred) > spread[ok] / 2) * 100:.1f}%"
        )
    print(
        f"   realised |30 s mid move|: median {np.median(np.abs(dm)) * 100:.2f}c, mean {np.mean(np.abs(dm)) * 100:.2f}c"
    )


if __name__ == "__main__":
    main()
