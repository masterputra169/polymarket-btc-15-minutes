"""Does model v3 help as a VETO on model v2's live entry rule? Fresh prices, out-of-sample.

    python hybridBacktest.py [--a fresh_predictions.json] [--b fresh_predictions_p3.json]

The bot trades v2's side (v2 P(UP) >= 0.5 -> UP) under the live rule "CURRENT: conf>=0.65
(0.45 if edge>=15%)". A hybrid adds one gate: v3's probability for that same side, p3_side,
must clear a threshold (tau in 0.35..0.60), or v3 must "not be against" it (p3_side >= 0.5 or
v3 confidence 2|p3 - 0.5| < 0.2). Everything else is freshBacktest.py unchanged: the same
replicable gates, first qualifying minute per market, one trade per market, +1c cost (0.5c and
2c as sensitivity), fee 0.072 c (1 - c) on profit.

Because the veto is an extra gate, a hybrid can only drop a market or enter it LATER than
CURRENT does (at a different price); it never adds a market. Both effects are reported.

Protocol: markets out-of-sample for BOTH models (slugTs >= 1785528900). The variant is chosen
on the FIRST half only (slugTs < TEST_START_SLUG) by total PnL with n >= 20, then judged once
on the SECOND half with a day-block bootstrap, beside v2 CURRENT and the no-ML favourite on the
same markets. The paired difference (hybrid - CURRENT) gets its own day-block CI.
"""

import argparse
import os
from collections import defaultdict
from collections.abc import Callable

import numpy as np

import compareFreshModels as cfm
import freshBacktest as fb

HERE = os.path.dirname(os.path.abspath(__file__))
OOS_BOTH_SINCE = 1785528900  # first market neither v2 nor v3 trained on
SPLIT = fb.TEST_START_SLUG
CURRENT = "CURRENT: conf>=0.65 (0.45 if edge>=15%)"
BASELINE = "NO-ML baseline: buy the favourite"
TAUS = (0.35, 0.40, 0.45, 0.50, 0.55, 0.60)
# freshBacktest.py selects with n >= 40, but v2 CURRENT has only 38 first-half entries, so
# 40 would leave nothing to choose. A veto can only remove trades, so the candidates are
# subsets of those 38; the second half (n=192, day-block CI) is what judges the choice.
MIN_N_SELECT = 20
COSTS = (0.01, 0.005, 0.02)
# Established results this script must reproduce before it says anything (+1c cost).
EXPECTED = {
    "v2 CURRENT, all OOS": (230, 0.1073),
    "v2 CURRENT, first half": (38, 0.2043),
    "v2 CURRENT, second half": (192, 0.0881),
    "no-ML favourite, all OOS": (1009, 0.0252),
}
rng = np.random.default_rng(2027)

Veto = Callable[[float], bool]
Market = tuple[int, list[dict]]
Trade = tuple[int, bool, float, int]  # (slugTs, win, price paid, secsInto)


def load_joined(path_a: str, path_b: str, since: int) -> tuple[list[Market], int]:
    """v2 rows grouped by market, each carrying v3's P(UP) as 'p3'; tradeable minutes only."""
    a, b = cfm.load(path_a, since), cfm.load(path_b, since)
    keys = sorted(k for k in set(a) & set(b) if cfm.tradeable(a[k]))
    mismatched = sum(1 for k in keys if a[k]["y"] != b[k]["y"] or a[k]["up"] != b[k]["up"])
    by = defaultdict(list)
    for k in keys:
        by[k[0]].append({**a[k], "p3": b[k]["pred"]})
    markets = [(ts, sorted(rs, key=lambda r: r["secsInto"])) for ts, rs in sorted(by.items())]
    return markets, mismatched


def tau_veto(tau: float) -> Veto:
    return lambda p3_side: p3_side >= tau


def not_against(p3_side: float) -> bool:
    return p3_side >= 0.5 or 2 * abs(p3_side - 0.5) < 0.2


def make_variants() -> dict[str, Veto]:
    variants = {f"v2 CURRENT + v3 p3_side>={t:.2f}": tau_veto(t) for t in TAUS}
    variants["v2 CURRENT + v3 not against"] = not_against
    return variants


def simulate_veto(markets: list[Market], veto: Veto | None, cost: float) -> list[Trade]:
    """freshBacktest.simulate for the CURRENT rule, plus an optional v3 gate on v2's side."""
    kind, arg = fb.make_rules()[CURRENT]
    trades = []
    for ts, rs in markets:
        for r in rs:
            up, ps, quote, win, conf, aligned = fb.side_view(r)
            if not fb.gates_ok(r, ps, quote, conf, aligned):
                continue
            if not fb.passes(kind, arg, r, ps, quote, conf, cost):
                continue
            if veto is not None and not veto(r["p3"] if up else 1 - r["p3"]):
                continue
            trades.append((ts, bool(win), min(quote + cost, 0.99), r["secsInto"]))
            break
    return trades


def first_half(markets: list[Market]) -> list[Market]:
    return [m for m in markets if m[0] < SPLIT]


def second_half(markets: list[Market]) -> list[Market]:
    return [m for m in markets if m[0] >= SPLIT]


def veto_effect(cur: list[Trade], hyb: list[Trade]) -> dict:
    """Split CURRENT's trades into removed / delayed (entered later) / unchanged by the veto."""
    by_hyb = {t[0]: t for t in hyb}
    removed = [t for t in cur if t[0] not in by_hyb]
    delayed_cur = [t for t in cur if t[0] in by_hyb and by_hyb[t[0]][3] != t[3]]
    delayed_hyb = [by_hyb[t[0]] for t in delayed_cur]
    return dict(
        removed=fb.summarize(removed),
        delayed_cur=fb.summarize(delayed_cur),
        delayed_hyb=fb.summarize(delayed_hyb),
        unchanged=len(cur) - len(removed) - len(delayed_cur),
    )


def fmt_effect(e: dict) -> str:
    r = e["removed"]
    out = f"      veto removed {r['n']:3d}"
    if r["n"]:
        out += (
            f" (WR {r['wr']*100:5.1f}% vs BE {r['be']*100:5.1f}%, their PnL/$1 {r['pnl']:+6.2f}"
            f" -> {'harmful: removed winners on net' if r['pnl'] > 0 else 'removed net losers'})"
        )
    dc, dh = e["delayed_cur"], e["delayed_hyb"]
    out += f"; delayed {dc['n']}"
    if dc["n"]:
        out += f" (PnL/$1 {dc['pnl']:+.2f} at CURRENT's minute -> {dh['pnl']:+.2f} later)"
    return out + f"; unchanged {e['unchanged']}"


def paired_delta_ci(cur: list[Trade], hyb: list[Trade], n_boot: int = 4000) -> dict:
    """Day-block bootstrap of hybrid - CURRENT on the same markets (total PnL/$1 and ROI)."""
    pnl_c = {t[0]: float(fb.pnl_per_dollar(t[1], t[2])) for t in cur}
    pnl_h = {t[0]: float(fb.pnl_per_dollar(t[1], t[2])) for t in hyb}
    by_day = defaultdict(list)
    for ts in pnl_c:  # hybrid markets are a subset of CURRENT's
        by_day[ts // 86400].append(ts)
    days = sorted(by_day)
    cols = []
    for d in days:
        ts_list = by_day[d]
        cols.append(
            (
                sum(pnl_c[t] for t in ts_list),
                len(ts_list),
                sum(pnl_h.get(t, 0.0) for t in ts_list),
                sum(1 for t in ts_list if t in pnl_h),
            )
        )
    arr = np.array(cols)
    d_pnl, d_roi = [], []
    for _ in range(n_boot):
        s = arr[rng.integers(0, len(days), len(days))].sum(0)
        d_pnl.append(s[2] - s[0])
        if s[3] > 0:
            d_roi.append(s[2] / s[3] - s[0] / s[1])
    tot = arr.sum(0)
    return dict(
        d_pnl=tot[2] - tot[0],
        d_pnl_ci=tuple(np.percentile(d_pnl, [2.5, 97.5])),
        d_roi=(tot[2] / tot[3] - tot[0] / tot[1]) if tot[3] else np.nan,
        d_roi_ci=tuple(np.percentile(d_roi, [2.5, 97.5])) if d_roi else (np.nan, np.nan),
    )


def fmt_delta(label: str, d: dict) -> str:
    lo, hi = d["d_roi_ci"]
    plo, phi = d["d_pnl_ci"]
    verdict = "outside noise" if (lo > 0 or hi < 0) else "inside noise"
    return (
        f"  {label}: dROI {d['d_roi']*100:+.2f}pp  CI [{lo*100:+.1f}, {hi*100:+.1f}]pp ({verdict}); "
        f"dPnL/$1 {d['d_pnl']:+.2f}  CI [{plo:+.2f}, {phi:+.2f}]"
    )


def sanity_check(markets: list[Market]) -> bool:
    kind_c, arg_c = fb.make_rules()[CURRENT]
    got = {
        "v2 CURRENT, all OOS": fb.simulate(markets, kind_c, arg_c, 0.01),
        "v2 CURRENT, first half": fb.simulate(first_half(markets), kind_c, arg_c, 0.01),
        "v2 CURRENT, second half": fb.simulate(second_half(markets), kind_c, arg_c, 0.01),
        "no-ML favourite, all OOS": fb.simulate(markets, *fb.make_rules()[BASELINE], 0.01),
    }
    ok = True
    print("0. Sanity check against the established results (+1c)")
    for label, trades in got.items():
        s = fb.summarize(trades)
        n_exp, roi_exp = EXPECTED[label]
        match = s["n"] == n_exp and round(s["roi"], 4) == roi_exp
        ok &= match
        print(
            f"   {label:<26s} n={s['n']:4d} ROI {s['roi']*100:+6.2f}%   expected n={n_exp:4d} "
            f"ROI {roi_exp*100:+6.2f}%   {'OK' if match else 'MISMATCH'}"
        )
    mine = [t[:3] for t in simulate_veto(markets, None, 0.01)]
    same = mine == got["v2 CURRENT, all OOS"]
    ok &= same
    print(f"   simulate_veto(no veto) == freshBacktest.simulate(CURRENT): {'OK' if same else 'NO'}")
    return ok


def v3_view_of_entries(markets: list[Market]) -> None:
    """Where v3 stands on the side v2 enters, at the minute v2 enters (+1c)."""
    print("\n   v3's probability for v2's side (p3_side) at v2 CURRENT's entry minute:")
    for part, ms in (("first half", first_half(markets)), ("second half", second_half(markets))):
        entries = {t[0]: t[3] for t in simulate_veto(ms, None, 0.01)}
        p3s = []
        for ts, rs in ms:
            if ts not in entries:
                continue
            r = next(r for r in rs if r["secsInto"] == entries[ts])
            p3s.append(r["p3"] if r["pred"] >= 0.5 else 1 - r["p3"])
        p = np.array(p3s)
        q = np.percentile(p, [5, 25, 50, 75, 95])
        print(
            f"   {part:<11s} n={len(p):3d}  min {p.min():.2f} p5 {q[0]:.2f} p25 {q[1]:.2f} median {q[2]:.2f} "
            f"p75 {q[3]:.2f} p95 {q[4]:.2f}  | share >=0.50 {np.mean(p >= 0.5)*100:5.1f}%  "
            f">=0.55 {np.mean(p >= 0.55)*100:5.1f}%  >=0.60 {np.mean(p >= 0.60)*100:5.1f}%"
        )


def select_on_first_half(markets: list[Market], variants: dict[str, Veto], cost: float) -> str:
    fh = first_half(markets)
    cur = simulate_veto(fh, None, cost)
    print("   FIRST half (selection data):")
    print(fb.fmt("v2 CURRENT (no veto)", fb.summarize(cur)))
    scores = {}
    for label, veto in variants.items():
        hyb = simulate_veto(fh, veto, cost)
        scores[label] = fb.summarize(hyb)
        print(fb.fmt(label, scores[label]))
        if cost == 0.01:
            print(fmt_effect(veto_effect(cur, hyb)))
    cands = {k: s for k, s in scores.items() if s["n"] >= MIN_N_SELECT}
    best = max(cands, key=lambda k: cands[k]["pnl"]) if cands else None
    print(f"   chosen on FIRST half (max PnL, n>={MIN_N_SELECT}): {best}")
    if best is not None:
        ties = sum(1 for s in cands.values() if np.isclose(s["pnl"], cands[best]["pnl"]))
        if ties > 1:
            print(
                f"   ({ties} variants tie at that PnL; the first listed, least restrictive, is taken)"
            )
    return best


def judge_on_second_half(markets: list[Market], variants: dict[str, Veto], best, cost: float):
    sh = second_half(markets)
    print("   SECOND half, judged once:")
    base = fb.summarize(fb.simulate(sh, *fb.make_rules()[BASELINE], cost))
    print(fb.fmt("no-ML favourite", base, fb.day_block_ci(base)))
    cur_t = simulate_veto(sh, None, cost)
    cur = fb.summarize(cur_t)
    print(fb.fmt("v2 CURRENT (no veto)", cur, fb.day_block_ci(cur)))
    if best is None:
        return cur, None, None
    hyb_t = simulate_veto(sh, variants[best], cost)
    hyb = fb.summarize(hyb_t)
    print(fb.fmt(best, hyb, fb.day_block_ci(hyb)))
    print(fmt_effect(veto_effect(cur_t, hyb_t)))
    if hyb_t == cur_t:
        print("  paired, chosen hybrid - v2 CURRENT: identical trades, nothing to test")
    else:
        print(fmt_delta("paired, chosen hybrid - v2 CURRENT", paired_delta_ci(cur_t, hyb_t)))
    return cur, hyb, cur_t


def second_half_curve(markets: list[Market], variants: dict[str, Veto], cur_t: list[Trade]):
    sh = second_half(markets)
    print("   SECOND half, every variant (the curve — NOT for choosing):")
    print(fb.fmt("v2 CURRENT (no veto)", fb.summarize(cur_t)))
    for label, veto in variants.items():
        hyb_t = simulate_veto(sh, veto, 0.01)
        print(fb.fmt(label, fb.summarize(hyb_t)))
        print(fmt_effect(veto_effect(cur_t, hyb_t)))
        if hyb_t != cur_t:
            print("  " + fmt_delta("paired vs v2 CURRENT", paired_delta_ci(cur_t, hyb_t)))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--a", default=os.path.join(HERE, "fresh_predictions.json"))
    ap.add_argument("--b", default=os.path.join(HERE, "fresh_predictions_p3.json"))
    args = ap.parse_args()

    markets, mismatched = load_joined(args.a, args.b, OOS_BOTH_SINCE)
    n_rows = sum(len(rs) for _, rs in markets)
    print(
        f"{n_rows} tradeable market-minutes, {len(markets)} markets out-of-sample for both "
        f"(since {OOS_BOTH_SINCE}); first half {len(first_half(markets))}, second half "
        f"{len(second_half(markets))} (split {SPLIT}); rows where v2/v3 files disagree on y or "
        f"price: {mismatched}\n"
    )
    if mismatched:
        # The two files must describe the same minutes; a veto judged on v2's outcome
        # while v3 saw another price is no comparison. Regenerate both with one run.
        raise SystemExit(f"{mismatched} joined rows disagree on outcome or price between the files")
    if not sanity_check(markets):
        raise SystemExit("sanity check failed: the join or the rule differs from the study")
    v3_view_of_entries(markets)

    variants = make_variants()
    kept = {}
    for cost in COSTS:
        tag = "DEFAULT" if cost == 0.01 else "sensitivity"
        print(f"\n1. v3 veto on v2 CURRENT, execution cost +{cost*100:.1f}c ({tag})")
        best = select_on_first_half(markets, variants, cost)
        cur, hyb, cur_t = judge_on_second_half(markets, variants, best, cost)
        if cost == 0.01:
            kept = {"v2 CURRENT, second half": cur}
            if hyb is not None:
                kept[f"{best}, second half"] = hyb
            second_half_curve(markets, variants, cur_t)

    print("\n2. Monte Carlo on SECOND-half trades (+1c cost)")
    for label, s in kept.items():
        if s["n"] >= 30:
            fb.monte_carlo(s, label)
        else:
            print(f"\n  {label}: n={s['n']} < 30, Monte Carlo skipped")

    print(
        f"\nVariants tried: {len(variants)} veto variants (tau in {', '.join(f'{t:.2f}' for t in TAUS)}"
        f" + 'not against'), selected separately at each of {len(COSTS)} cost settings; "
        "+1c is the primary result. 'not against' = p3_side > 0.40, i.e. tau=0.40 up to ties."
    )


if __name__ == "__main__":
    main()
