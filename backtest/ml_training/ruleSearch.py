"""Entry-rule search on FRESH prices: can the bot trade more often without giving up expectancy?

Reuses freshBacktest.py (loader, side_view, gates_ok, fee / breakeven, summarize,
day_block_ci, simulate) and the same protocol: first qualifying minute per market,
pay last print + COST, fee on profit, choose on SELECT (slug < TEST_START_SLUG),
judge ONCE on VALIDATE with a day-block bootstrap.

The harness is vectorised (one mask per rule over every market-minute), so it is
first checked against freshBacktest.simulate trade-for-trade.

Pre-declared family (counted at run time, ~210 variants):
  A  CURRENT's own structure, env-implementable: conf >= cmin, relaxed to R when
     edge >= E (FILTER_ML_CONF_MIN / _RELAXED / FILTER_HIGH_EDGE_BYPASS)
  B  shrunk edge: q = price + lam (p - price), trade when q - breakeven(c) >= delta
  C  price band (entry floor / soft cap) on the CURRENT structure
  D  time-left windows and the late-phase ML floor (FILTER_LATE_ML_MIN)
  E  ML DISAGREES with the market (model side is the underdog)
  F  unions: CURRENT OR one other rule (first minute either passes)
Picks (pre-declared), each judged once on VALIDATE:
  1  max SELECT total PnL, n >= 40 (the incumbent CURRENT is in the pool)
  2  same, among rules with SELECT n >= 1.5 x CURRENT's
  3  same as 2, env-implementable rules only (families A, C, D-late)

Sensitivity (not used for choosing): execution cost 0.5c / 2c, and a "bot-strict"
harness that adds the replicable gates freshBacktest leaves out (50/50 band,
68/72/75c hard caps, dead zone, edge ceiling, 0.03% mid distance, entry-floor edge
bypass) with the edge measured on an approximate ensemble (ML blended with the
offline rule probability, alpha as src/engines/ml/ensemble.ts, minus ask and fee).
"""

import argparse
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import freshBacktest as fb  # noqa: E402

COST = 0.01
MARKETS_PER_DAY = 96
MIN_N = 40
VOLUME_MULT = 1.5
CUR = dict(cmin=0.65, relaxed=0.45, bypass=0.15)


# ── per-row arrays ──────────────────────────────────────────────────────────


def precompute(markets, cost):
    cols = {
        k: []
        for k in (
            "mkt",
            "ts",
            "left",
            "ps",
            "quote",
            "win",
            "conf",
            "aligned",
            "trending",
            "dist",
            "upAge",
            "rule_side",
            "gate_fb",
        )
    }
    for mi, (ts, rs) in enumerate(markets):
        for r in rs:
            up, ps, quote, win, conf, aligned = fb.side_view(r)
            cols["mkt"].append(mi)
            cols["ts"].append(ts)
            cols["left"].append((900 - r["secsInto"]) / 60)
            cols["ps"].append(ps)
            cols["quote"].append(quote)
            cols["win"].append(bool(win))
            cols["conf"].append(conf)
            cols["aligned"].append(bool(aligned))
            cols["trending"].append(r.get("regime") == "trending")
            cols["dist"].append(abs(r["btc"] - r["ptb"]) / r["ptb"] * 100)
            cols["upAge"].append(r["upAge"])
            cols["rule_side"].append(r["rule"] if up else 1 - r["rule"])
            cols["gate_fb"].append(fb.gates_ok(r, ps, quote, conf, aligned, use_ml=True))
    R = {k: np.array(v) for k, v in cols.items()}
    R["edge_ml"] = R["ps"] - R["quote"]
    # approximate live bestEdge: ensemble (ensemble.ts alphas, optimal_threshold 0.55)
    conf = R["conf"]
    alpha = np.where(
        conf >= 0.65, 0.9, np.where(conf >= 0.58, 0.8, np.where(conf >= 0.2, 0.5, 0.3))
    )
    ens = np.clip(alpha * R["ps"] + (1 - alpha) * R["rule_side"], 0.01, 0.99)
    ask = R["quote"] + cost
    R["edge_ens"] = ens - ask - fb.fee(ask) * (1 - ask)
    return R


# ── gates ───────────────────────────────────────────────────────────────────


def gate_mask(R, E, floor=0.50, soft_cap=0.63, min_left=2, max_left=12, late_ml=0.80, strict=False):
    """fb.gates_ok(use_ml=True), vectorised and parameterised; defaults reproduce it exactly."""
    left, q, conf = R["left"], R["quote"], R["conf"]
    m = (left >= min_left) & (left <= max_left) & (R["upAge"] <= 30)
    if strict:
        trend_prem = R["trending"] & (conf >= 0.80)
        hard = np.where(conf >= 0.90, 0.75, np.where(trend_prem, 0.72, 0.68))
        cap = np.where((conf >= 0.85) | trend_prem, hard, np.minimum(soft_cap, hard))
        m &= (q >= floor) | (E >= 0.08)  # entry-floor edge bypass
        m &= (q >= 0.15) | (conf >= 0.85)  # MARKET_PRICE_RANGE
        m &= ~((q >= 0.47) & (q <= 0.53))  # MARKET_5050_RANGE
        m &= ~((conf >= 0.75) & (conf < 0.80) & (E < 0.10))  # dead zone
        m &= ~(E > np.where(conf >= 0.85, 0.35, 0.25))  # noqa: SIM300 — edge ceiling
        dist_req = np.where(left > 10, 0.02, np.where(left > 5, 0.03, 0.04))
    else:
        cap = np.where(conf >= 0.85, 0.75, soft_cap)
        m &= q >= floor
        dist_req = np.where(left > 10, 0.02, 0.04)
    m &= q <= cap
    m &= ~((left < 5) & (conf < np.where(E >= 0.15, 0.55, late_ml)))
    m &= (conf >= 0.80) | (R["dist"] >= dist_req)
    tr_block = (q < 0.60) | (left > 10) | ((E < 0.15) & (conf < np.where(R["aligned"], 0.55, 0.65)))
    m &= ~(R["trending"] & tr_block)
    return m


# ── entry rules (each returns a mask; combined with its gate) ───────────────


def conf_rule(cmin, relaxed=None, bypass=None):
    def f(R, E, cost):
        if relaxed is None:
            return R["conf"] >= cmin
        return R["conf"] >= np.where(E >= bypass, min(cmin, relaxed), cmin)  # noqa: SIM300

    return f


def edge_rule(lam, delta):
    def f(R, E, cost):
        q = R["quote"] + lam * (R["ps"] - R["quote"])
        return q - fb.breakeven(R["quote"] + cost) >= delta

    return f


def band_rule(inner, lo=None, hi=None, min_left=None, max_left=None):
    """inner rule restricted to quote in [lo, hi) and/or left in [min_left, max_left]."""

    def f(R, E, cost):
        m = inner(R, E, cost)
        if lo is not None:
            m = m & (R["quote"] >= lo)
        if hi is not None:
            m = m & (R["quote"] < hi)
        if min_left is not None:
            m = m & (R["left"] >= min_left)
        if max_left is not None:
            m = m & (R["left"] <= max_left)
        return m

    return f


def rule(name, fam, parts, env=False):
    """parts: list of (gate_kwargs, entry_fn); a market-minute qualifies if ANY part passes."""
    return dict(name=name, fam=fam, parts=parts, env=env)


def current_part():
    return ({}, conf_rule(**CUR))


def build_family():
    rules = []
    # A: CURRENT's structure
    for cmin in (0.45, 0.50, 0.55, 0.60, 0.65, 0.70):
        rules.append(
            rule(f"A conf>={cmin:.2f} (no bypass)", "A", [({}, conf_rule(cmin))], env=True)
        )
        for relaxed in (0.20, 0.30, 0.45):
            if relaxed >= cmin:
                continue
            for bypass in (0.08, 0.10, 0.12, 0.15, 0.20):
                nm = f"A conf>={cmin:.2f}, {relaxed:.2f} if edge>={bypass:.2f}"
                rules.append(rule(nm, "A", [({}, conf_rule(cmin, relaxed, bypass))], env=True))
    # B: shrunk edge
    edge_specs = [(lam, d) for lam in (0.2, 0.3, 0.5) for d in (0.03, 0.05, 0.08)]
    for lam, d in edge_specs:
        rules.append(
            rule(f"B edge lam={lam:.1f} q-BE>={d*100:.0f}pp", "B", [({}, edge_rule(lam, d))])
        )
    # C: price band on the CURRENT structure
    bands = (
        (0.50, 0.58),
        (0.50, 0.60),
        (0.53, 0.63),
        (0.55, 0.63),
        (0.50, 0.68),
        (0.50, 0.70),
        (0.55, 0.70),
        (0.53, 0.68),
    )
    for cmin in (0.45, 0.55, 0.65):
        for lo, hi in bands:
            g = dict(floor=lo, soft_cap=hi)
            nm = f"C conf>={cmin:.2f}(0.45@15%) price {lo*100:.0f}-{hi*100:.0f}c"
            rules.append(rule(nm, "C", [(g, conf_rule(cmin, 0.45, 0.15))], env=True))
    # D: time windows / late ML floor
    for cmin in (0.45, 0.55, 0.65):
        for lo, hi in ((5, 12), (2, 10), (3, 12), (5, 10), (3, 10)):
            g = dict(min_left=lo, max_left=hi)
            nm = f"D conf>={cmin:.2f}(0.45@15%) left {lo}-{hi}m"
            rules.append(rule(nm, "D", [(g, conf_rule(cmin, 0.45, 0.15))]))
        for lm in (0.55, 0.65, 0.70):
            nm = f"D conf>={cmin:.2f}(0.45@15%) late ML>={lm:.2f}"
            rules.append(rule(nm, "D", [(dict(late_ml=lm), conf_rule(cmin, 0.45, 0.15))], env=True))
    # E: ML disagrees with the market (model side is the underdog)
    dis_specs = [
        (c, lo, hi)
        for c in (0.20, 0.30, 0.45, 0.65)
        for lo, hi in ((0.30, 0.47), (0.40, 0.47), (0.40, 0.50))
    ]
    for c, lo, hi in dis_specs:
        part = (dict(floor=lo), band_rule(conf_rule(c), hi=hi))
        rules.append(
            rule(f"E disagree conf>={c:.2f} price {lo*100:.0f}-{hi*100:.0f}c", "E", [part])
        )
    # F: unions with CURRENT
    restr = {
        "": {},
        " & price<58c": dict(hi=0.58),
        " & price<60c": dict(hi=0.60),
        " & price>=55c": dict(lo=0.55),
        " & left>=5m": dict(min_left=5),
        " & left 5-10m": dict(min_left=5, max_left=10),
    }
    for t in (0.30, 0.40, 0.45, 0.50, 0.55):
        for tag, kw in restr.items():
            part = ({}, band_rule(conf_rule(t), **kw))
            rules.append(rule(f"F CURRENT | conf>={t:.2f}{tag}", "F", [current_part(), part]))
    for lam, d in edge_specs:
        nm = f"F CURRENT | edge lam={lam:.1f} q-BE>={d*100:.0f}pp"
        rules.append(rule(nm, "F", [current_part(), ({}, edge_rule(lam, d))]))
    for c, lo, hi in dis_specs:
        part = (dict(floor=lo), band_rule(conf_rule(c), hi=hi))
        nm = f"F CURRENT | disagree conf>={c:.2f} {lo*100:.0f}-{hi*100:.0f}c"
        rules.append(rule(nm, "F", [current_part(), part]))
    return rules


# ── simulation ──────────────────────────────────────────────────────────────


def trades_for(R, rl, cost=COST, strict=False):
    E = R["edge_ens"] if strict else R["edge_ml"]
    mask = np.zeros(len(R["mkt"]), dtype=bool)
    for g, fn in rl["parts"]:
        mask |= gate_mask(R, E, strict=strict, **g) & fn(R, E, cost)
    idx = np.flatnonzero(mask)
    _, first = np.unique(R["mkt"][idx], return_index=True)
    pick = idx[first]
    c = np.minimum(R["quote"][pick] + cost, 0.99)
    return [(int(R["ts"][i]), bool(R["win"][i]), float(ci)) for i, ci in zip(pick, c, strict=True)]


def per_day(s, days_all):
    out = np.zeros(len(days_all))
    if s["n"]:
        np.add.at(out, np.searchsorted(days_all, s["days"]), s["per_trade"])
    return out


def boot_sum_ci(daily, n=4000):
    picks = fb.rng.integers(0, len(daily), (n, len(daily)))
    return tuple(np.percentile(daily[picks].sum(1), [2.5, 97.5]))


def line(label, s, ndays, extra=""):
    if s["n"] == 0:
        return f"  {label:<52s} n=   0"
    return (
        f"  {label:<52s} n={s['n']:4d} {s['n']/ndays:4.1f}/d  WR {s['wr']*100:5.1f}%  paid {s['price']*100:4.1f}c  "
        f"BE {s['be']*100:5.1f}%  margin {(s['wr']-s['be'])*100:+5.1f}pp  ROI {s['roi']*100:+6.2f}%  "
        f"PnL {s['pnl']:+7.2f}{extra}"
    )


def verify_harness(R, markets):
    """Vectorised gates and rules must equal freshBacktest's row-by-row code exactly."""
    assert np.array_equal(gate_mask(R, R["edge_ml"]), R["gate_fb"]), "gate_mask != fb.gates_ok"
    checks = [
        ("current", None, rule("cur", "", [current_part()])),
        ("conf", 0.45, rule("c45", "", [({}, conf_rule(0.45))])),
        ("conf", 0.70, rule("c70", "", [({}, conf_rule(0.70))])),
        ("edge", (0.5, 0.02), rule("e", "", [({}, edge_rule(0.5, 0.02))])),
    ]
    for kind, arg, rl in checks:
        ref = fb.simulate(markets, kind, arg, COST)
        got = trades_for(R, rl)
        assert [(a, b, round(c, 9)) for a, b, c in ref] == [
            (a, b, round(c, 9)) for a, b, c in got
        ], kind
    print(
        f"harness check: gate mask equals fb.gates_ok on {len(R['mkt'])} rows; 4 rules equal fb.simulate"
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", default=os.path.join(HERE, "fresh_predictions.json"))
    ap.add_argument("--curve", action="store_true", help="print every rule on VALIDATE")
    args = ap.parse_args()
    _rows, markets = fb.load(args.input)
    sel = [m for m in markets if m[0] < fb.TEST_START_SLUG]
    val = [m for m in markets if m[0] >= fb.TEST_START_SLUG]
    Rs, Rv = precompute(sel, COST), precompute(val, COST)
    days_s, days_v = len(sel) / MARKETS_PER_DAY, len(val) / MARKETS_PER_DAY
    dall_v = np.unique([m[0] // 86400 for m in val])
    print(
        f"SELECT {len(sel)} markets ({days_s:.1f} d), VALIDATE {len(val)} markets ({days_v:.1f} d)"
    )
    verify_harness(Rs, sel)
    verify_harness(Rv, val)

    # 1. reproduce freshBacktest
    print("\n1. Reproduction with freshBacktest.simulate (+1c):")
    for nm, kind in (("NO-ML favourite", "baseline"), ("CURRENT", "current")):
        for split, mk, nd in (("SELECT", sel, days_s), ("VALIDATE", val, days_v)):
            print(line(f"{nm} [{split}]", fb.summarize(fb.simulate(mk, kind, None, COST)), nd))

    rules = build_family()
    fams = {}
    for rl in rules:
        fams[rl["fam"]] = fams.get(rl["fam"], 0) + 1
    print(
        f"\n2. Family: {len(rules)} variants tried  "
        + "  ".join(f"{k}={v}" for k, v in sorted(fams.items()))
    )
    cur_rule = rule("CURRENT", "A", [current_part()], env=True)
    s_cur = fb.summarize(trades_for(Rs, cur_rule))
    sel_scores = [(rl, fb.summarize(trades_for(Rs, rl))) for rl in rules]

    def best(pred):
        pool = [(rl, s) for rl, s in sel_scores if s["n"] >= MIN_N and pred(rl, s)]
        return max(pool, key=lambda x: x[1]["pnl"]) if pool else (None, None)

    vol = VOLUME_MULT * s_cur["n"]
    picks = {
        "PICK1 max PnL": best(lambda rl, s: True),
        "PICK2 max PnL, n>=1.5x": best(lambda rl, s: s["n"] >= vol),
        "PICK3 max PnL, n>=1.5x, env-only": best(lambda rl, s: s["n"] >= vol and rl["env"]),
    }
    print(f"\n   SELECT top 15 by total PnL (n>={MIN_N}); CURRENT n={s_cur['n']}, 1.5x = {vol:.0f}")
    print(line("CURRENT", s_cur, days_s))
    ranked = sorted([x for x in sel_scores if x[1]["n"] >= MIN_N], key=lambda x: -x[1]["pnl"])
    for rl, s in ranked[:15]:
        print(line(rl["name"], s, days_s))
    for tag, (rl, _s) in picks.items():
        print(f"   {tag}: {rl['name'] if rl else None}")
    sigs = {}
    val_scores = {}
    for rl, s in sel_scores:
        sv = fb.summarize(trades_for(Rv, rl))
        val_scores[rl["name"]] = sv
        sigs.setdefault(
            (s["n"], round(s.get("pnl", 0), 9), sv["n"], round(sv.get("pnl", 0), 9)), []
        ).append(rl["name"])
    print(f"   distinct rules (by SELECT+VALIDATE trade sets): {len(sigs)} of {len(rules)}")
    for tag, (rl, s) in picks.items():
        if rl is None:
            continue
        ties = [
            r2["name"]
            for r2, s2 in sel_scores
            if s2["n"] == s["n"] and abs(s2["pnl"] - s["pnl"]) < 1e-9
        ]
        vp = [val_scores[t]["pnl"] for t in ties]
        print(
            f"   {tag.split()[0]} ties on SELECT with {len(ties)} variants; their VALIDATE PnL {min(vp):+.2f} .. {max(vp):+.2f}"
        )

    # 3. VALIDATE, judged once
    print(
        "\n3. VALIDATE (Aug 28 -> Sep 23), judged once; CI = day-block bootstrap (ROI, total PnL, PnL - CURRENT)"
    )
    base = fb.summarize(fb.simulate(val, "baseline", None, COST))
    sv_cur = fb.summarize(trades_for(Rv, cur_rule))
    d_cur = per_day(sv_cur, dall_v)
    judged = [("NO-ML favourite", None, base), ("CURRENT", cur_rule, sv_cur)]
    seen = set()
    for tag, (rl, _) in picks.items():
        if rl is None or rl["name"] in seen:
            continue
        seen.add(rl["name"])
        judged.append((f"{tag.split()[0]} {rl['name']}", rl, fb.summarize(trades_for(Rv, rl))))
    for label, rl, s in judged:
        lo, hi = fb.day_block_ci(s)
        d = per_day(s, dall_v)
        plo, phi = boot_sum_ci(d)
        extra = (
            f"\n{'':56s}ROI CI [{lo*100:+.1f}%, {hi*100:+.1f}%]  PnL CI [{plo:+.1f}, {phi:+.1f}]"
        )
        if rl is not None and label != "CURRENT":
            dlo, dhi = boot_sum_ci(d - d_cur)
            extra += f"  PnL-CURRENT {s['pnl']-sv_cur['pnl']:+.2f} CI [{dlo:+.1f}, {dhi:+.1f}]"
        print(line(label, s, days_v, extra))

    # 3b. post-hoc context: what the protocol could not select
    print(
        "\n3b. POST-HOC (chosen on VALIDATE itself — context only, not evidence): top 3 by VALIDATE PnL, n >= 1.5x CURRENT"
    )
    by_name = {rl["name"]: (rl, s) for rl, s in sel_scores}
    top = sorted(
        (nm for nm, sv in val_scores.items() if sv["n"] >= VOLUME_MULT * sv_cur["n"]),
        key=lambda nm: -val_scores[nm]["pnl"],
    )
    shown = set()
    for nm in top:
        sv = val_scores[nm]
        key = (sv["n"], round(sv["pnl"], 9))
        if key in shown:
            continue
        shown.add(key)
        rl, ss = by_name[nm]
        d = per_day(sv, dall_v)
        dlo, dhi = boot_sum_ci(d - d_cur)
        lo, hi = fb.day_block_ci(sv)
        extra = (
            f"\n{'':56s}ROI CI [{lo*100:+.1f}%, {hi*100:+.1f}%]  PnL-CURRENT {sv['pnl']-sv_cur['pnl']:+.2f} "
            f"CI [{dlo:+.1f}, {dhi:+.1f}]  | SELECT n={ss['n']} ROI {ss.get('roi', 0)*100:+.1f}% PnL {ss.get('pnl', 0):+.2f}"
        )
        print(line(nm, sv, days_v, extra))
        judged.append((f"post-hoc {nm}", rl, sv))
        if len(shown) == 3:
            break

    # 3c. post-hoc context: at or above CURRENT's total PnL in BOTH halves with >= 1.5x its trades in each
    print(
        "\n3c. POST-HOC: rules with PnL >= CURRENT and n >= 1.5x CURRENT in BOTH halves (uses VALIDATE; context only)"
    )
    both, shown = [], set()
    for rl, ss in sel_scores:
        sv = val_scores[rl["name"]]
        if ss["n"] < VOLUME_MULT * s_cur["n"] or sv["n"] < VOLUME_MULT * sv_cur["n"]:
            continue
        if ss["pnl"] < s_cur["pnl"] or sv["pnl"] < sv_cur["pnl"]:
            continue
        key = (ss["n"], round(ss["pnl"], 9), sv["n"], round(sv["pnl"], 9))
        if key not in shown:
            shown.add(key)
            both.append((rl, ss, sv))
    for rl, ss, sv in sorted(both, key=lambda x: -(x[1]["pnl"] + x[2]["pnl"])):
        dlo, dhi = boot_sum_ci(per_day(sv, dall_v) - d_cur)
        lo, hi = fb.day_block_ci(sv)
        print(line(rl["name"] + " [SEL]", ss, days_s))
        extra = (
            f"  ROI CI [{lo*100:+.1f}%, {hi*100:+.1f}%]  PnL-CURRENT CI [{dlo:+.1f}, {dhi:+.1f}]"
        )
        print(line(rl["name"] + " [VAL]", sv, days_v, extra))
        judged.append((f"both {rl['name']}", rl, sv))

    # 4. sensitivity for the judged rules
    print("\n4. Sensitivity on VALIDATE (not for choosing)")
    for label, rl, _ in judged[1:]:
        for cost in (0.005, 0.02):
            print(
                line(
                    f"{label[:40]} cost+{cost*100:.1f}c",
                    fb.summarize(trades_for(Rv, rl, cost)),
                    days_v,
                )
            )
    print(
        "   bot-strict harness (50/50 band, 68c hard cap, dead zone, edge ceiling, ensemble edge):"
    )
    for label, rl, _ in judged[1:]:
        for split, R, nd in (("SEL", Rs, days_s), ("VAL", Rv, days_v)):
            s = fb.summarize(trades_for(R, rl, strict=True))
            ci = fb.day_block_ci(s) if s["n"] else (np.nan, np.nan)
            print(
                line(
                    f"{label[:44]} [{split}]", s, nd, f"  CI [{ci[0]*100:+.1f}%, {ci[1]*100:+.1f}%]"
                )
            )

    if args.curve:
        print("\n5. VALIDATE curve, every rule (context only)")
        print(line("CURRENT", sv_cur, days_v))
        for rl, ss in sel_scores:
            s = val_scores[rl["name"]]
            print(line(rl["name"], s, days_v, f"   | SEL n={ss['n']} PnL {ss.get('pnl', 0):+.2f}"))


if __name__ == "__main__":
    main()
