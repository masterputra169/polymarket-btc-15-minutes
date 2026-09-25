"""Late-window TWAP backtest: buy the side ahead in the final minutes of a BTC 15m window.

    python twapLateBacktest.py [--latency 2] [--cost 0.01]

Since 2026-08-07 these markets settle on Chainlink's 60 s TWAP: UP iff the TWAP stamped at
the window's end >= the TWAP stamped at its start (the price to beat). In the last minute part
of that average is already written, so "who is ahead" becomes nearly certain before the market
closes. The 2-day tape suggested the leader's token is priced below its real chance
(ptbImpactStudy.mts, section 5). This tests that over 30 days, out of sample.

Data (fetchTwapHistory.mts, fetchTradeHistory.mts --all-windows):
  twap_history/<start>.json   61 TWAP points, 15 s apart; first = price to beat, last = final
  binance_1s/<start>.json     Binance 1 s closes for the window's last ~400 s
  trade_history/<start>.json.gz  every trade print (second resolution), both tokens

Chainlink spot is not published historically, so it is reconstructed as Binance minus a
basis re-anchored on every TWAP point (basis = mean Binance over the TWAP's 60 s - TWAP).
The settlement estimate at time t is that spot when more than 60 s remain, and inside the last
minute (seconds already in the average + current spot x seconds still to come) / 60 — the same
rule the bot now runs live (bot/src/engines/settlePrice.ts).

Entry: at the first scan second t (every 5 s) inside the rule's window where the lead and the
price qualify, buy the leader at the last print of its token at or before t + latency, plus
cost, fee on profit. One trade per market. Rules are chosen on the FIRST half by date and
judged once on the SECOND half with a day-block bootstrap, next to the no-signal baseline
"buy the favourite token at the same second".
"""

import argparse
import bisect
import gzip
import json
import os
from itertools import product

import numpy as np

import freshBacktest as fb

HERE = os.path.dirname(os.path.abspath(__file__))
TWAP_DIR = os.path.join(HERE, "twap_history")
BIN_DIR = os.path.join(HERE, "binance_1s")
TRADE_DIR = os.path.join(HERE, "trade_history")
SCAN_STEP = 5  # seconds between entry checks


def load_market(start):
    """Everything one window needs, or None when a series is missing or broken."""
    try:
        with open(os.path.join(TWAP_DIR, f"{start}.json")) as f:
            tw = json.load(f)["points"]
        with open(os.path.join(BIN_DIR, f"{start}.json")) as f:
            bn = json.load(f)["closes"]
        with gzip.open(os.path.join(TRADE_DIR, f"{start}.json.gz"), "rt") as f:
            tr = json.load(f)
    except (OSError, ValueError, KeyError):
        return None
    tw = sorted((int(t), float(v)) for t, v in tw)
    if len(tw) < 55 or tw[0][0] != start * 1000 or tw[-1][0] != (start + 900) * 1000:
        return None
    if len(bn) < 300 or tr.get("truncated"):
        return None
    ptb, final = tw[0][1], tw[-1][1]
    return dict(
        start=start,
        end=start + 900,
        ptb=ptb,
        outcome=0 if final >= ptb else 1,  # 0 = UP wins, 1 = DOWN wins
        twap=tw,
        binance={int(t) // 1000: float(c) for t, c in bn},  # candle open second -> close
        trades=tr["trades"],  # [ts_sec, outcome 0 Up | 1 Down, price, size, side]
    )


def chainlink_proxy(m):
    """Per-second Chainlink spot estimate: Binance close - the basis at the last TWAP point."""
    b = m["binance"]
    basis_at = {}
    for t_ms, v in m["twap"]:
        tau = t_ms // 1000
        window = [b[s] for s in range(tau - 59, tau + 1) if s in b]
        if len(window) >= 50:
            basis_at[tau] = float(np.mean(window)) - v
    taus = sorted(basis_at)
    proxy = {}
    j, basis = 0, None
    # A 1 s candle opening at s closes at s+1: its close is known at s+1, so it stands for second s+1.
    for s in range(m["end"] - 400, m["end"] + 1):
        while j < len(taus) and taus[j] + 1 <= s:  # the TWAP point stamped tau is known ~1 s later
            basis = basis_at[taus[j]]
            j += 1
        c = b.get(s - 1)
        if basis is not None and c is not None:
            proxy[s] = c - basis
    return proxy


def settle_estimate(proxy, t, end):
    """Expected final TWAP at second t (see module docstring)."""
    cur = proxy.get(t)
    if cur is None:
        return None
    if t <= end - 60:
        return cur
    seen, total, held = 0, 0.0, None
    for s in range(end - 59, t + 1):
        held = proxy.get(s, held)
        total += held if held is not None else cur
        seen += 1
    return (total + cur * (60 - seen)) / 60


def last_price(trades, times, side, t):
    """Last traded price of `side`'s token at or before t (the other token's print as 1 - p);
    None when nothing traded in the 30 s before t."""
    i = bisect.bisect_right(times, t) - 1
    if i < 0 or t - times[i] > 30:
        return None
    ts, oc, p, _q, _s = trades[i]
    return (p if oc == side else 1 - p), t - ts


def market_rows(m, latency):
    """(seconds_left, lead_usd, leader, leader_price, favourite, favourite_price) per scan second."""
    proxy = chainlink_proxy(m)
    trades = sorted(m["trades"], key=lambda x: x[0])
    times = [x[0] for x in trades]
    rows = []
    for left in range(240, 4, -SCAN_STEP):
        t = m["end"] - left
        est = settle_estimate(proxy, t, m["end"])
        if est is None:
            continue
        leader = 0 if est >= m["ptb"] else 1
        got = last_price(trades, times, leader, t + latency)
        if got is None:
            continue
        p_lead, age = got
        fav = leader if p_lead >= 0.5 else 1 - leader
        p_fav = p_lead if fav == leader else 1 - p_lead
        rows.append((left, abs(est - m["ptb"]), leader, p_lead, fav, p_fav, age))
    return rows


def make_rules():
    rules = []
    for kmax, kmin, (lo, hi), cap in product(
        (180, 120, 90, 60, 45, 30),
        (5, 15),
        ((0, 10), (10, 30), (30, 60), (0, 30), (0, 60), (10, 60)),
        (0.80, 0.90, 0.95),
    ):
        if kmin < kmax:
            rules.append((kmax, kmin, lo, hi, cap))
    return rules


# Realism guards (set from the command line): a print older than max_age seconds may not be
# buyable any more, and a very cheap token is a lottery ticket whose rare win would dominate
# the P&L of a rule chosen by total P&L.
GUARDS = {"min_price": 0.40, "max_age": 5}


def simulate(markets, rule, cost, baseline=False):
    kmax, kmin, lo, hi, cap = rule
    trades = []
    for m in markets:
        for left, lead, leader, p_lead, fav, p_fav, age in m["rows"]:
            if left > kmax or left < kmin or not (lo <= lead < hi):
                continue
            if age > GUARDS["max_age"]:
                continue
            side, p = (fav, p_fav) if baseline else (leader, p_lead)
            pay = min(0.99, p + cost)
            if pay > cap or pay < GUARDS["min_price"]:
                continue
            trades.append((m["start"], side == m["outcome"], pay))
            break
    return trades


def rule_name(r):
    kmax, kmin, lo, hi, cap = r
    return f"{kmax}-{kmin}s left, lead ${lo}-{hi}, pay<={cap:.2f}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--latency", type=int, default=2, help="seconds between the decision and the fill"
    )
    ap.add_argument(
        "--cost", type=float, default=0.01, help="added to the last print (spread/slippage)"
    )
    ap.add_argument("--min-price", type=float, default=0.40, help="skip tokens cheaper than this")
    ap.add_argument("--max-age", type=int, default=5, help="max seconds since the print paid")
    args = ap.parse_args()
    GUARDS.update(min_price=args.min_price, max_age=args.max_age)

    starts = sorted(int(f[:-5]) for f in os.listdir(TWAP_DIR) if f.endswith(".json"))
    markets = []
    for s in starts:
        m = load_market(s)
        if m is None:
            continue
        m["rows"] = market_rows(m, args.latency)
        del m["trades"], m["binance"]
        if m["rows"]:
            markets.append(m)
    if len(markets) < 100:
        raise SystemExit(f"only {len(markets)} usable markets — fetch data first")
    split = markets[len(markets) // 2]["start"]
    first = [m for m in markets if m["start"] < split]
    second = [m for m in markets if m["start"] >= split]
    ts = lambda s: np.datetime_as_string(np.datetime64(s, "s"), unit="m")  # noqa: E731
    print(
        f"{len(markets)} usable markets {ts(markets[0]['start'])} → {ts(markets[-1]['start'])} UTC; "
        f"SELECT {len(first)} (before {ts(split)}), VALIDATE {len(second)}; latency {args.latency}s, cost +{args.cost*100:.1f}c, "
        f"price >= {args.min_price:.2f}, print <= {args.max_age}s old\n"
    )

    # Sanity: the settlement estimate names the winner more often as the window closes.
    for left in (180, 120, 60, 30, 10):
        hits = [r[2] == m["outcome"] for m in markets for r in m["rows"] if r[0] == left]
        if hits:
            print(
                f"  leader at {left:3d}s left names the winner in {np.mean(hits)*100:5.1f}% of {len(hits)} markets"
            )

    rules = make_rules()
    scored = []
    for r in rules:
        s = fb.summarize(simulate(first, r, args.cost))
        if s["n"] >= 40:
            scored.append((s["pnl"], r, s))
    scored.sort(key=lambda x: -x[0])
    print(f"\n{len(rules)} rules tried; {len(scored)} with n >= 40 on SELECT. Top 5 on SELECT:")
    for _, r, s in scored[:5]:
        print(fb.fmt(rule_name(r), s))
    if not scored:
        raise SystemExit("no rule with enough SELECT trades")
    best = scored[0][1]
    print(f"\nChosen on SELECT: {rule_name(best)}")
    print("VALIDATE, judged once:")
    sv = fb.summarize(simulate(second, best, args.cost))
    base = fb.summarize(simulate(second, best, args.cost, baseline=True))
    print(fb.fmt("leader (TWAP-aware)", sv, fb.day_block_ci(sv) if sv["n"] else None))
    print(fb.fmt("baseline: favourite token", base, fb.day_block_ci(base) if base["n"] else None))
    if sv["n"]:
        top = np.sort(sv["per_trade"])[::-1]
        day_pnl = [sv["per_trade"][sv["days"] == d].sum() for d in np.unique(sv["days"])]
        print(
            f"  concentration: top 5 trades {top[:5].sum():+.2f} of {sv['pnl']:+.2f} PnL/$1; "
            f"median trade {np.median(sv['per_trade']):+.3f}; profitable days "
            f"{np.mean(np.array(day_pnl) > 0) * 100:.0f}% of {len(day_pnl)}"
        )
    for c in (0.005, 0.02, 0.03):
        s = fb.summarize(simulate(second, best, c))
        print(fb.fmt(f"leader, cost +{c*100:.1f}c", s))
    print("\nVALIDATE, every rule (the curve — not for choosing): best and worst 5 by PnL")
    allv = sorted(
        ((fb.summarize(simulate(second, r, args.cost)), r) for r in rules),
        key=lambda x: -(x[0].get("pnl") or 0),
    )
    for s, r in allv[:5] + allv[-5:]:
        if s["n"]:
            print(fb.fmt(rule_name(r), s))
    if sv["n"] >= 20:
        fb.monte_carlo(sv, f"leader rule {rule_name(best)}, VALIDATE")


if __name__ == "__main__":
    main()
