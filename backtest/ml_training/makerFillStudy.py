"""Maker vs taker entry on the bot's own signals, replayed on the market tape.

Question: had the bot entered with a resting bid on its side (MAKER) instead of
a FOK at the ask (TAKER), would it have made more money? How often does the
bid fill, how much cheaper is it, and are the filled orders adversely selected
(filled orders win less often than the signals as a whole)?

Data: the local tape (npm run tape:pull), outcomes from tape/_resolutions.json
(the cache decisionTrailStudy.mts fills for markets with `d` lines).

Signals (first qualifying `d` line per market):
  S1  st == 'entered'                                  the bot's real entries
  S2  a == 'E', 2 <= tl <= 12, side price in [.50,.68] the ENTER population
      (side price = pu for U, pd for D)

At a signal, the order is priced off the first snapshot of the side's token at
or after the d line (<= 5 s later); that snapshot's time is the placement time.

Policies, $1 stake each:
  TAKER          best ask, taker fee 0.07*c*(1-c) per share at match, win or lose
                 (CLOB V2; decisionTrailCore.pnlPerDollar): win 1/c-1-f, loss -1-f,
                 f = 0.07*(1-c) per $1
  JOIN(T)        bid = best bid, valid T s, never past 2 min before market end
  IMPROVE(T)     bid = best bid + 1c when that is still below the ask, else JOIN
  Makers pay no fee (the maker rebate is ignored). Unfilled: SKIP (no trade) or
  FALLBACK (taker at the ask when the window ends).

Fill rules, all in (placement, window end]:
  cons       same-token print strictly below the bid, or best ask <= bid
  cons+comp  cons, or an opposite-token BUY strictly above 1 - bid
  opt        same-token print at or below the bid, or best ask <= bid
  opt+comp   opt, or an opposite-token BUY at or above 1 - bid
The book is unified: an UP bid at b is the DOWN ask at 1-b, so a taker buying
DOWN through 1-b fills it. Each match prints once, on the taker's token, with the
taker's side. A print AT the bid is only a fill if the queue ahead of a joiner
cleared, hence "opt".

Prints are timed by the server match time `st` (receipt `t` lags it by up to
~14 s at the 99th percentile), so a print that arrived late is not taken for a
fill of an order placed after it matched.

Markout: token mid 60 s after the fill minus the price paid (taker: mid 60 s
after placement minus the ask). CIs: market-block bootstrap, 2000 draws.
"""

from __future__ import annotations

import glob
import json
import os
from collections import defaultdict
from dataclasses import dataclass
from datetime import UTC, datetime

import numpy as np

from tapeMicroStudy import read_lines, slug_start

HERE = os.path.dirname(os.path.abspath(__file__))
TAPE = os.path.join(HERE, "tape")

FEE_COEF = 0.07
TICK = 0.01
EPS = 1e-6
MARKET_MS = 900_000
END_GUARD_MS = 120_000
SNAP_GAP_MS = 5_000
MARKOUT_MS = 60_000
WINDOWS_S = (15, 30, 60, 120, 240)
POLICIES = ("JOIN", "IMPROVE")
RULES = ("cons", "cons+comp", "opt", "opt+comp")
S2_TL = (2.0, 12.0)
S2_PRICE = (0.50, 0.68)
N_BOOT = 2000
SEED = 11


@dataclass(frozen=True)
class TokenBook:
    """Top of one token's book, per 1 Hz snapshot (ok == 1, both sides present)."""

    t: np.ndarray
    bid: np.ndarray
    ask: np.ndarray


@dataclass(frozen=True)
class Prints:
    """A market's trade prints at the server match time `st`, deduplicated across processes."""

    t: np.ndarray
    up: np.ndarray
    p: np.ndarray
    buy: np.ndarray


@dataclass(frozen=True)
class Signal:
    market: str
    tok: str
    won: bool
    tp: float
    bid: float
    ask: float
    end_ms: int


@dataclass(frozen=True)
class Trial:
    filled: bool
    delay_s: float
    pnl_skip: float
    paid_fb: float
    pnl_fb: float
    markout: float


# ── Loading ──────────────────────────────────────────────────────────────────


def load_outcomes() -> dict[str, str]:
    with open(os.path.join(TAPE, "_resolutions.json"), encoding="utf-8") as fh:
        markets = json.load(fh)["markets"]
    return {m: v["outcome"] for m, v in markets.items() if v.get("outcome") in ("UP", "DOWN")}


def top_of_book(book: dict | None) -> tuple[float, float] | None:
    """(best bid, best ask), sorting levels ourselves; None if a side is empty or crossed."""
    if not book:
        return None
    bids = [lv[0] for lv in book.get("b", []) if lv[1] > 0]
    asks = [lv[0] for lv in book.get("a", []) if lv[1] > 0]
    if not bids or not asks:
        return None
    bb, ba = max(bids), min(asks)
    return (bb, ba) if bb < ba - EPS else None


def route_line(line: dict, snaps: dict, prints: dict, decisions: dict) -> None:
    """File one tape line of a resolved market into the loader's accumulators."""
    kind, m = line.get("k"), line.get("m")
    if kind == "s" and line.get("ok") == 1:
        for tok in ("u", "d"):
            tob = top_of_book(line.get(tok))
            if tob is not None:
                snaps[(m, tok)].append((line["t"], *tob))
    elif kind == "x" and line.get("p") is not None and line.get("o") in ("u", "d"):
        st = line.get("st")
        key = (line["o"], line["p"], line.get("q"), line.get("sd"), st if st else line["t"])
        prints[m].setdefault(key, st if st else line["t"])
    elif kind == "d":
        decisions[m].append(line)


def read_tape(outcomes: dict[str, str]) -> tuple[dict, dict, dict, set, list]:
    snaps, prints, decisions = defaultdict(list), defaultdict(dict), defaultdict(list)
    seen, days = set(), []
    for path in sorted(glob.glob(os.path.join(TAPE, "*", "*.jsonl.gz"))):
        day = os.path.basename(os.path.dirname(path))
        if day not in days:
            days.append(day)
        for line in read_lines(path):
            m = line.get("m")
            if not m:
                continue
            if line.get("k") == "s":
                seen.add(m)
            if m in outcomes:
                route_line(line, snaps, prints, decisions)
    return snaps, prints, decisions, seen, days


def build_books(snaps: dict) -> dict[tuple[str, str], TokenBook]:
    out = {}
    for key, rows in snaps.items():
        arr = np.array(sorted(rows), dtype=float)
        out[key] = TokenBook(arr[:, 0], arr[:, 1], arr[:, 2])
    return out


def build_prints(prints: dict) -> dict[str, Prints]:
    out = {}
    for m, keyed in prints.items():
        rows = sorted((t, o == "u", p, sd == "BUY") for (o, p, _q, sd, _st), t in keyed.items())
        arr = np.array(rows, dtype=float)
        out[m] = Prints(arr[:, 0], arr[:, 1] > 0.5, arr[:, 2], arr[:, 3] > 0.5)
    return out


# ── Signals ──────────────────────────────────────────────────────────────────


def is_s1(line: dict) -> bool:
    return line.get("st") == "entered" and line.get("sd") in ("U", "D")


def is_s2(line: dict) -> bool:
    if line.get("a") != "E" or line.get("sd") not in ("U", "D"):
        return False
    tl = line.get("tl")
    price = line.get("pu") if line["sd"] == "U" else line.get("pd")
    if tl is None or price is None:
        return False
    return S2_TL[0] <= tl <= S2_TL[1] and S2_PRICE[0] <= price <= S2_PRICE[1]


def first_line(lines: list[dict], pred) -> dict | None:
    for line in sorted(lines, key=lambda x: x["t"]):
        if pred(line):
            return line
    return None


def make_signal(line: dict, outcome: str, books: dict) -> Signal | None:
    """Price the signal off the side token's first snapshot at or after the d line."""
    m = line["m"]
    tok = "u" if line["sd"] == "U" else "d"
    book = books.get((m, tok))
    if book is None:
        return None
    i = int(np.searchsorted(book.t, line["t"], side="left"))
    if i >= len(book.t) or book.t[i] - line["t"] > SNAP_GAP_MS:
        return None
    won = (outcome == "UP") == (tok == "u")
    end_ms = (slug_start(m) * 1000) + MARKET_MS
    return Signal(m, tok, won, float(book.t[i]), float(book.bid[i]), float(book.ask[i]), end_ms)


def select_signals(pred, decisions: dict, outcomes: dict, books: dict) -> tuple[list, int]:
    """One signal per market; also how many qualifying lines had no usable snapshot."""
    sigs, unpriced = [], 0
    for m in sorted(decisions):
        line = first_line(decisions[m], pred)
        if line is None:
            continue
        sig = make_signal(line, outcomes[m], books)
        if sig is None:
            unpriced += 1
        else:
            sigs.append(sig)
    return sigs, unpriced


# ── Execution ────────────────────────────────────────────────────────────────


def taker_pnl(c: float, won: bool) -> float:
    fee = FEE_COEF * (1 - c)  # 1/c shares x 0.07 c (1 - c)
    return (1 / c - 1 if won else -1.0) - fee


def maker_pnl(b: float, won: bool) -> float:
    return (1 / b - 1) if won else -1.0


def snap_index(book: TokenBook, t: float) -> int:
    """First snapshot at or after t (within 5 s), else the last one before it."""
    i = int(np.searchsorted(book.t, t, side="left"))
    if i < len(book.t) and book.t[i] - t <= SNAP_GAP_MS:
        return i
    return max(i - 1, 0)


def mid_at(book: TokenBook, t: float) -> float:
    i = snap_index(book, t)
    return float(book.bid[i] + book.ask[i]) / 2


def order_price(sig: Signal, policy: str) -> float:
    if policy == "IMPROVE" and sig.bid + TICK < sig.ask - EPS:
        return round(sig.bid + TICK, 4)
    return sig.bid


def print_hits(pr: Prints, k0: int, k1: int, side_up: bool, bid: float, rule: str) -> np.ndarray:
    up, p, buy = pr.up[k0:k1], pr.p[k0:k1], pr.buy[k0:k1]
    same = up == side_up
    strict = rule.startswith("cons")
    hit = same & ((p < bid - EPS) if strict else (p <= bid + EPS))
    if rule.endswith("+comp"):
        mirror = 1 - bid
        through = (p > mirror + EPS) if strict else (p >= mirror - EPS)
        hit = hit | (~same & buy & through)
    return hit


def first_fill(sig: Signal, bid: float, wend: float, book: TokenBook, pr, rule: str):
    """Time of the first fill event in (placement, wend], or None."""
    times = []
    j0, j1 = np.searchsorted(book.t, [sig.tp, wend], side="right")
    hit = np.nonzero(book.ask[j0:j1] <= bid + EPS)[0]
    if hit.size:
        times.append(float(book.t[j0 + hit[0]]))
    if pr is not None:
        k0, k1 = np.searchsorted(pr.t, [sig.tp, wend], side="right")
        idx = np.nonzero(print_hits(pr, k0, k1, sig.tok == "u", bid, rule))[0]
        if idx.size:
            times.append(float(pr.t[k0 + idx[0]]))
    return min(times) if times else None


def simulate(sig: Signal, policy: str, t_s: int, rule: str, books: dict, prints: dict) -> Trial:
    book = books[(sig.market, sig.tok)]
    bid = order_price(sig, policy)
    wend = max(sig.tp, min(sig.tp + t_s * 1000, sig.end_ms - END_GUARD_MS))
    fill_t = first_fill(sig, bid, wend, book, prints.get(sig.market), rule)
    if fill_t is not None:
        pnl = maker_pnl(bid, sig.won)
        markout = mid_at(book, fill_t + MARKOUT_MS) - bid
        return Trial(True, (fill_t - sig.tp) / 1000, pnl, bid, pnl, markout)
    ask = float(book.ask[snap_index(book, wend)])
    return Trial(False, np.nan, 0.0, ask, taker_pnl(ask, sig.won), np.nan)


# ── Statistics ───────────────────────────────────────────────────────────────


def boot_index(n_groups: int, rng: np.random.Generator) -> np.ndarray:
    return rng.integers(0, n_groups, (N_BOOT, n_groups))


def market_sums(markets: list[str], *cols: np.ndarray) -> list[np.ndarray]:
    _, inv = np.unique(markets, return_inverse=True)
    return [np.bincount(inv, weights=np.asarray(c, dtype=float)) for c in cols]


def total_ci(markets: list[str], values: np.ndarray, idx: np.ndarray) -> tuple[float, float, float]:
    (s,) = market_sums(markets, values)
    draws = s[idx].sum(axis=1)
    lo, hi = np.percentile(draws, [2.5, 97.5])
    return float(values.sum()), float(lo), float(hi)


def gap_ci(markets: list[str], won: np.ndarray, filled: np.ndarray, idx: np.ndarray):
    """WR(filled) - WR(all signals), with a market-block bootstrap CI."""
    ones = np.ones(len(won))
    w, f, wf, n = market_sums(markets, won, filled, won * filled, ones)
    with np.errstate(invalid="ignore", divide="ignore"):
        draws = wf[idx].sum(1) / f[idx].sum(1) - w[idx].sum(1) / n[idx].sum(1)
        point = (won * filled).sum() / filled.sum() - won.mean() if filled.any() else np.nan
    if np.all(np.isnan(draws)):
        return float(point), np.nan, np.nan
    lo, hi = np.nanpercentile(draws, [2.5, 97.5])
    return float(point), float(lo), float(hi)


def safe_mean(x: np.ndarray) -> float:
    return float(np.mean(x)) if len(x) else np.nan


# ── Report ───────────────────────────────────────────────────────────────────


def fmt_ci(tot: float, lo: float, hi: float) -> str:
    return f"{tot:+6.2f} [{lo:+6.2f},{hi:+6.2f}]"


def taker_arrays(sigs: list[Signal], books: dict) -> dict[str, np.ndarray]:
    asks = np.array([s.ask for s in sigs])
    won = np.array([s.won for s in sigs], dtype=float)
    pnl = np.array([taker_pnl(s.ask, s.won) for s in sigs])
    mk = np.array([mid_at(books[(s.market, s.tok)], s.tp + MARKOUT_MS) - s.ask for s in sigs])
    return {"ask": asks, "won": won, "pnl": pnl, "markout": mk}


def print_taker(sigs: list[Signal], tk: dict, idx: np.ndarray) -> None:
    markets = [s.market for s in sigs]
    spread = np.array([s.ask - s.bid for s in sigs])
    print(
        f"  TAKER  n {len(sigs)}  WR {tk['won'].mean():.3f}  avg ask {tk['ask'].mean():.3f}"
        f"  ROI {tk['pnl'].mean():+.3f}  PnL {fmt_ci(*total_ci(markets, tk['pnl'], idx))}"
        f"  mk60 {tk['markout'].mean() * 100:+.2f}c"
    )
    print(
        f"  spread at signal: mean {spread.mean() * 100:.2f}c, 1c in"
        f" {np.mean(spread < TICK + EPS) * 100:.0f}% of signals"
    )


def trial_arrays(trials: list[Trial], tk: dict, bids: np.ndarray) -> dict[str, np.ndarray]:
    filled = np.array([t.filled for t in trials], dtype=float)
    f = filled > 0
    return {
        "filled": filled,
        "delay": np.array([t.delay_s for t in trials])[f],
        "skip": np.array([t.pnl_skip for t in trials]),
        "fb": np.array([t.pnl_fb for t in trials]),
        "save": (tk["ask"] - bids)[f],
        "fb_save": tk["ask"] - np.array([t.paid_fb for t in trials]),
        "markout": np.array([t.markout for t in trials])[f],
    }


def format_row(t_s: int, ar: dict, tk: dict, markets: list[str], idx: np.ndarray) -> str:
    f = ar["filled"] > 0
    won = tk["won"]
    gap, glo, ghi = gap_ci(markets, won, ar["filled"], idx)
    delay = float(np.median(ar["delay"])) if f.any() else np.nan
    sel = (
        f"{t_s:4d}s {f.mean() * 100:4.0f}% {delay:4.0f}s  {safe_mean(won[f]):.2f}"
        f"  {safe_mean(won[~f]):.2f}  {gap:+.2f}[{glo:+.2f},{ghi:+.2f}]"
        f"  {safe_mean(ar['save']) * 100:4.1f}c {safe_mean(ar['markout']) * 100:+5.1f}c"
    )
    skip = (
        f" | {int(f.sum()):3d} {safe_mean(ar['skip'][f]):+.3f} {safe_mean(tk['pnl'][f]):+.3f}"
        f" {fmt_ci(*total_ci(markets, ar['skip'], idx))}"
        f" {fmt_ci(*total_ci(markets, ar['skip'] - tk['pnl'], idx))}"
    )
    fb = (
        f" | {ar['fb'].mean():+.3f} {ar['fb_save'].mean() * 100:+4.1f}c"
        f" {fmt_ci(*total_ci(markets, ar['fb'], idx))}"
        f" {fmt_ci(*total_ci(markets, ar['fb'] - tk['pnl'], idx))}"
    )
    return sel + skip + fb


ROW_HEADER = (
    "     T fill% delay  WRf   WRu   gap=WRf-WRall[CI]   save   mk60"
    " | SKIP n  ROI   tkROIf  PnL [95% CI]           dPnL vs taker [CI]"
    " | FALLBACK ROI  save  PnL [95% CI]           dPnL vs taker [CI]"
)


def print_policy(sigs: list[Signal], policy: str, ctx: dict) -> None:
    bids = np.array([order_price(s, policy) for s in sigs])
    markets = [s.market for s in sigs]
    if policy == "IMPROVE":
        k = int(np.sum(bids > np.array([s.bid for s in sigs]) + EPS))
        print(f"\n  MAKER_IMPROVE: bid + 1c possible on {k}/{len(sigs)} signals (others join)")
        if k == 0:
            print("  -> identical to JOIN on this set (every spread is 1c); table omitted")
            return
    for rule in RULES:
        print(f"\n  {policy} / fill rule '{rule}'")
        print("  " + ROW_HEADER)
        for t_s in WINDOWS_S:
            trials = [simulate(s, policy, t_s, rule, ctx["books"], ctx["prints"]) for s in sigs]
            ar = trial_arrays(trials, ctx["tk"], bids)
            print("  " + format_row(t_s, ar, ctx["tk"], markets, ctx["idx"]))


def report_set(name: str, pred, data: dict, rng: np.random.Generator) -> None:
    sigs, unpriced = select_signals(pred, data["decisions"], data["outcomes"], data["books"])
    print(f"\n{'=' * 100}\n{name}: {len(sigs)} signals ({unpriced} without a snapshot within 5 s)")
    if not sigs:
        return
    days = sorted({datetime.fromtimestamp(s.tp / 1000, UTC).date().isoformat() for s in sigs})
    left = np.array([(s.end_ms - s.tp) / 60_000 for s in sigs])
    print(
        f"  days: {', '.join(days)}  |  UP-side signals {sum(s.tok == 'u' for s in sigs)}"
        f"  |  minutes left: median {np.median(left):.1f},"
        f" 10-90% {np.percentile(left, 10):.1f}-{np.percentile(left, 90):.1f}"
    )
    tk = taker_arrays(sigs, data["books"])
    idx = boot_index(len({s.market for s in sigs}), rng)
    print_taker(sigs, tk, idx)
    ctx = {"books": data["books"], "prints": data["prints"], "tk": tk, "idx": idx}
    for policy in POLICIES:
        print_policy(sigs, policy, ctx)


def print_coverage(data: dict, seen: set, days: list) -> None:
    books, decisions = data["books"], data["decisions"]
    snap_t = np.concatenate([b.t for b in books.values()])
    d_t = np.array([ln["t"] for lines in decisions.values() for ln in lines], dtype=float)

    def iso(ms: float) -> str:
        return datetime.fromtimestamp(ms / 1000, UTC).strftime("%Y-%m-%d %H:%M")

    print(f"Tape folders: {', '.join(days)}")
    print(f"Markets with snapshots on the tape: {len(seen)}")
    print(
        f"Resolved markets (_resolutions.json): {len(data['outcomes'])}; with books"
        f" {len({m for m, _ in books})}, with d lines {len(decisions)},"
        f" with prints {len(data['prints'])}"
    )
    print(f"Resolved-market snapshots: {iso(snap_t.min())} -> {iso(snap_t.max())} UTC")
    print(f"d lines: {len(d_t):,}, {iso(d_t.min())} -> {iso(d_t.max())} UTC")
    n_prints = sum(len(p.t) for p in data["prints"].values())
    buys = sum(int(p.buy.sum()) for p in data["prints"].values())
    print(f"Prints (deduplicated): {n_prints:,}, taker BUY {buys / max(n_prints, 1) * 100:.0f}%")


def main() -> None:
    outcomes = load_outcomes()
    snaps, prints, decisions, seen, days = read_tape(outcomes)
    data = {
        "outcomes": outcomes,
        "books": build_books(snaps),
        "prints": build_prints(prints),
        "decisions": dict(decisions),
    }
    print_coverage(data, seen, days)
    print(
        "\nColumns: fill% of signals; WRf / WRu win rate of filled / unfilled; gap = WRf - WR(all)"
        "\nwith market-block CI; delay = median s to fill; save = taker ask - bid on fills;"
        "\nmk60 = mid 60 s after fill - bid; SKIP: n filled, ROI per $1 filled, tkROIf = TAKER ROI"
        "\non the same filled signals (ROI - tkROIf = price effect, tkROIf - TAKER ROI = selection),"
        "\ntotal PnL ($1 stakes), paired dPnL vs TAKER on all signals (unfilled count as 0);"
        "\nFALLBACK: ROI per signal, save = mean(ask at signal - price paid), PnL, dPnL vs TAKER."
    )
    rng = np.random.default_rng(SEED)
    s1 = "S1 bot entries (first st=='entered' per market)"
    s2 = "S2 ENTER signals (first a=='E', 2<=tl<=12, side price .50-.68)"
    report_set(s1, is_s1, data, rng)
    report_set(s2, is_s2, data, rng)


if __name__ == "__main__":
    main()
