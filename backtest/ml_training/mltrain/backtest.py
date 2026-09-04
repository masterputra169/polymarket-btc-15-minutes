"""The P&L simulation, its summary statistics, and the threshold sweep.

This is the code that answers "is the trained model actually profitable?", so a
silent error here does not produce a wrong number the user can see — it produces
a plausible one they act on. Extracting it from backtestPnL.py makes the
arithmetic assertable: a hand-computed sequence of wins and losses can be walked
through `simulate_pnl` and checked to the cent, and the degenerate cases (no
trade clears the threshold, one trade, all wins, all losses) can be pinned so
they return zeros instead of raising or dividing by zero.

Scope note: these functions reproduce the script's behaviour exactly, including
one modelling choice they do NOT get to decide — costs are a flat fraction of
bet size rather than Polymarket's price-dependent fee (see mltrain/fees.py). The
split, calibration and per-row context that decide WHICH rows arrive here live
in mltrain/backtest_inputs.py.

Pure logic: arrays and scalars in, frozen dataclasses out. No global state, no
I/O, no printing — backtestPnL.py owns argparse, stdout and file output.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

import numpy as np

from mltrain import fees

# np.arange bounds for --threshold-sweep: 0.500 .. 0.800 inclusive, 13 candidates.
DEFAULT_SWEEP_GRID: tuple[float, float, float] = (0.50, 0.81, 0.025)

# Regimes printed in fixed order by the entrypoint; anything else is "unknown".
KNOWN_REGIMES: tuple[str, ...] = ("trending", "moderate", "mean_reverting")

# 15-minute Polymarket markets => 96 per day. Used to turn a test-set row count
# into a calendar span, which is what annualises Sharpe honestly.
MARKETS_PER_DAY: float = 96.0
DAYS_PER_YEAR: float = 365.25


@dataclass(frozen=True)
class RegimeStats:
    """Trade count, wins and net P&L for one market regime."""

    trades: int
    wins: int
    pnl: float

    @property
    def win_rate(self) -> float:
        """Fraction of regime trades that settled in the money (0 when idle)."""
        return self.wins / self.trades if self.trades > 0 else 0.0


@dataclass(frozen=True)
class SimulationResult:
    """Everything one (threshold, min_edge) configuration produced.

    `total_pnl` is net of transaction costs; `profit_factor` charges every cost
    to the loss side of the ratio, so it is the pessimistic reading. `returns`
    holds per-trade fractional returns and is one shorter than `trades` — it is
    a diff of the balance series, so the first trade's return has no predecessor
    to difference against and is not represented (this also excludes it from
    Sharpe and from the bootstrap CI).
    """

    trades: int
    wins: int
    losses: int
    win_rate: float
    total_pnl: float
    roi: float
    max_drawdown: float
    profit_factor: float
    sharpe: float
    trades_per_year: float
    trade_ratio: float
    regime_stats: dict[str, RegimeStats]
    final_balance: float
    total_txcost: float
    pnl_history: list[float]
    returns: np.ndarray


@dataclass(frozen=True)
class BootstrapCI:
    """Percentile confidence interval for Sharpe and ROI.

    All four bounds are NaN when there were too few trades to resample; check
    `sufficient` rather than testing a bound for NaN at each call site.
    """

    sharpe_lo: float
    sharpe_hi: float
    roi_lo: float
    roi_hi: float
    n_trades: int

    @property
    def sufficient(self) -> bool:
        """True when the interval was actually computed."""
        return not np.isnan(self.sharpe_lo)


@dataclass(frozen=True)
class SweepRow:
    """One threshold candidate and the simulation it produced."""

    threshold: float
    result: SimulationResult


@dataclass(frozen=True)
class ThresholdSelection:
    """Argmax of the threshold sweep under the accuracy-vs-coverage score."""

    threshold: float
    score: float


def simulate_pnl(
    y_prob: np.ndarray,
    y_true: np.ndarray,
    market_prices: np.ndarray,
    threshold: float,
    min_edge: float,
    bankroll: float,
    bet_size: float,
    regimes: np.ndarray | None = None,
    txcost_frac: float = 0.0,
) -> SimulationResult:
    """Walk the test set once, taking every trade that clears both gates.

    A row is traded when the model's confidence max(p, 1-p) is at least
    `threshold` AND its cost-adjusted edge over the market price is at least
    `min_edge`. Positions are held to settlement — there is no early exit — so
    each trade either pays (1 - entry) * bet_size or loses entry * bet_size, and
    pays `txcost_frac * bet_size` either way.

    Args:
        y_prob: calibrated probability-of-UP per test row.
        y_true: ground-truth 0/1 outcome, aligned to y_prob.
        market_prices: quoted UP-token price per row, aligned to y_prob.
        threshold: minimum model confidence to trade.
        min_edge: minimum cost-adjusted edge to trade.
        bankroll: starting balance; ROI and drawdown are measured against it.
        bet_size: shares bought per trade (see mltrain/fees.py on the bet unit).
        regimes: optional per-row regime name for the per-regime breakdown.
        txcost_frac: round-trip cost as a fraction of bet_size.

    Returns:
        SimulationResult. An empty input, or a threshold that admits no trade,
        yields zeros throughout rather than raising.
    """
    balance = bankroll
    trades = 0
    wins = 0
    losses = 0
    peak = bankroll
    max_drawdown = 0
    pnl_history: list[float] = []
    gross_win = 0
    gross_loss = 0
    total_txcost = 0

    # Per-regime tracking, accumulated mutably and frozen on return.
    regime_totals: dict[str, dict[str, float]] = {}

    # Per-trade cost deducted on every trade
    trade_cost = fees.per_trade_cost(txcost_frac, bet_size)

    for i in range(len(y_prob)):
        prob_up = y_prob[i]
        prob_down = 1 - prob_up
        best_prob = max(prob_up, prob_down)
        side = "UP" if prob_up >= prob_down else "DOWN"

        # Entry price, bounded to the tradeable band
        entry = fees.entry_price(market_prices[i], side)

        # Edge = model prob - market price (net of transaction costs)
        edge = fees.net_edge(best_prob, entry, txcost_frac)

        # Decision: trade if above threshold AND positive edge (after costs)
        if best_prob < threshold or edge < min_edge:
            continue

        trades += 1
        actual_up = y_true[i] == 1
        correct = (side == "UP" and actual_up) or (side == "DOWN" and not actual_up)

        # Always pay transaction costs
        balance -= trade_cost
        total_txcost += trade_cost

        if correct:
            profit = fees.win_payoff(entry, bet_size)
            balance += profit
            wins += 1
            gross_win += profit
        else:
            loss = fees.loss_amount(entry, bet_size)
            balance -= loss
            losses += 1
            gross_loss += loss

        pnl_history.append(balance)
        peak = max(peak, balance)
        dd = (peak - balance) / peak if peak > 0 else 0
        max_drawdown = max(max_drawdown, dd)

        if regimes is not None:
            r = regimes[i]
            if r not in regime_totals:
                regime_totals[r] = {"trades": 0, "wins": 0, "pnl": 0}
            regime_totals[r]["trades"] += 1
            if correct:
                regime_totals[r]["wins"] += 1
                regime_totals[r]["pnl"] += fees.win_payoff(entry, bet_size) - trade_cost
            else:
                regime_totals[r]["pnl"] -= fees.loss_amount(entry, bet_size) + trade_cost

    win_rate = wins / trades if trades > 0 else 0
    total_pnl = balance - bankroll
    roi = total_pnl / bankroll * 100 if bankroll > 0 else 0
    profit_factor = (
        gross_win / (gross_loss + total_txcost)
        if (gross_loss + total_txcost) > 0
        else (999.99 if gross_win > 0 else 0)
    )

    # Sharpe annualization: scale by ACTUAL trades/year, not 96x365 bars/year.
    # Audit fix (Apr 2026): previous formula over-inflated Sharpe ~4x when trade frequency
    # was much lower than bar frequency (e.g. ~5 trades/day at threshold 0.6 vs 96 bars/day).
    # n_samples_in_test approximates test span in 15-min markets; fall back to trades if absent.
    if len(pnl_history) > 1 and trades > 0:
        returns = np.diff(pnl_history) / np.maximum(np.array(pnl_history[:-1]), 1)
        std = np.std(returns)
        # Each test sample is ~1 Polymarket 15-min market -> 96 samples/day
        test_span_days = max(1.0, len(y_prob) / MARKETS_PER_DAY)
        trades_per_year = (trades / test_span_days) * DAYS_PER_YEAR
        sharpe = np.mean(returns) / std * np.sqrt(max(trades_per_year, 1.0)) if std > 0 else 0
    else:
        sharpe = 0
        returns = np.array([])
        trades_per_year = 0

    return SimulationResult(
        trades=trades,
        wins=wins,
        losses=losses,
        win_rate=win_rate,
        total_pnl=total_pnl,
        roi=roi,
        max_drawdown=max_drawdown,
        profit_factor=profit_factor,
        sharpe=sharpe,
        trades_per_year=trades_per_year,
        trade_ratio=trades / len(y_prob) * 100 if len(y_prob) > 0 else 0,
        regime_stats={
            name: RegimeStats(trades=int(t["trades"]), wins=int(t["wins"]), pnl=t["pnl"])
            for name, t in regime_totals.items()
        },
        final_balance=balance,
        total_txcost=total_txcost,
        pnl_history=pnl_history,
        returns=returns,
    )


def bootstrap_ci(
    returns: np.ndarray,
    n_boot: int = 1000,
    ci: float = 0.95,
    seed: int = 42,
    trades_per_year: float | None = None,
) -> BootstrapCI:
    """Bootstrap a confidence interval for Sharpe ratio and total ROI.

    Resamples trade-level returns with replacement, recomputes Sharpe and ROI
    for each bootstrap sample, then returns percentile confidence intervals.
    Fewer than 10 trades produces an all-NaN interval rather than a meaningless
    one — resampling 3 returns 1000 times measures nothing.

    Args:
        returns: per-trade fractional returns (SimulationResult.returns).
        n_boot: resample count.
        ci: interval width (0.95 = 2.5th/97.5th percentiles).
        seed: RandomState seed; the interval must not move between runs.
        trades_per_year: actual trading frequency. If None, falls back to
            bars-per-year (stale, and inflates Sharpe when trades are sparse).
    """
    if len(returns) < 10:
        return BootstrapCI(
            sharpe_lo=np.nan, sharpe_hi=np.nan, roi_lo=np.nan, roi_hi=np.nan, n_trades=len(returns)
        )

    rng = np.random.RandomState(seed)
    alpha = (1 - ci) / 2  # 0.025 for 95% CI

    sharpe_samples = np.empty(n_boot)
    roi_samples = np.empty(n_boot)

    # Annualization factor based on ACTUAL trade frequency (audit fix, Apr 2026).
    tpy = (
        trades_per_year
        if (trades_per_year and trades_per_year > 0)
        else (DAYS_PER_YEAR * MARKETS_PER_DAY)
    )
    ann_factor = np.sqrt(max(tpy, 1.0))

    for b in range(n_boot):
        idx = rng.randint(0, len(returns), size=len(returns))
        boot_ret = returns[idx]

        std = np.std(boot_ret)
        sharpe_samples[b] = (np.mean(boot_ret) / std * ann_factor) if std > 0 else 0

        # ROI: sum of dollar returns -> pct of bankroll.
        # returns are fractional (dollar P&L / balance); total P&L is approximated
        # as sum(returns) * bankroll, since each return ~ pnl/balance.
        roi_samples[b] = np.sum(boot_ret) * 100  # as percentage

    return BootstrapCI(
        sharpe_lo=float(np.percentile(sharpe_samples, alpha * 100)),
        sharpe_hi=float(np.percentile(sharpe_samples, (1 - alpha) * 100)),
        roi_lo=float(np.percentile(roi_samples, alpha * 100)),
        roi_hi=float(np.percentile(roi_samples, (1 - alpha) * 100)),
        n_trades=len(returns),
    )


def run_threshold_sweep(
    y_prob: np.ndarray,
    y_true: np.ndarray,
    market_prices: np.ndarray,
    *,
    min_edge: float,
    bankroll: float,
    bet_size: float,
    regimes: np.ndarray | None = None,
    txcost_frac: float = 0.0,
    grid: tuple[float, float, float] = DEFAULT_SWEEP_GRID,
) -> list[SweepRow]:
    """Re-run the simulation at each candidate confidence threshold.

    Args:
        grid: (start, stop, step) np.arange bounds for the threshold scan.
        (all other arguments are passed straight through to simulate_pnl.)

    Returns:
        One SweepRow per candidate, in ascending threshold order.
    """
    return [
        SweepRow(
            threshold=thresh,
            result=simulate_pnl(
                y_prob,
                y_true,
                market_prices,
                thresh,
                min_edge,
                bankroll,
                bet_size,
                regimes,
                txcost_frac,
            ),
        )
        for thresh in np.arange(*grid)
    ]


def select_best_threshold(
    rows: Sequence[SweepRow], *, min_trades: int = 50, default_threshold: float = 0.60
) -> ThresholdSelection:
    """Pick the sweep row maximising win_rate * sqrt(trade_ratio).

    The sqrt(coverage) term is what stops the sweep recommending a threshold so
    high that it wins 100% of four trades. Candidates below `min_trades` are not
    scored at all, and ties keep the LOWEST qualifying threshold (strict >),
    which is the more liquid of two equal-scoring rules.

    Args:
        rows: output of run_threshold_sweep.
        min_trades: candidates with fewer trades are ignored outright.
        default_threshold: returned, with score 0, when nothing qualifies.
    """
    best_threshold = default_threshold
    best_score = 0
    for row in rows:
        if row.result.trades < min_trades:
            continue
        score = row.result.win_rate * np.sqrt(row.result.trade_ratio / 100)
        if score > best_score:
            best_score = score
            best_threshold = row.threshold
    return ThresholdSelection(threshold=best_threshold, score=best_score)
