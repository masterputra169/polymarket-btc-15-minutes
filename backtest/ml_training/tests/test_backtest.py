"""Unit tests for mltrain.backtest — the P&L simulation the deploy decision rests on.

The script this came from is how the user decides whether a retrained model is
profitable enough to trade real money, so these tests target the failures that
would mislead rather than crash: P&L that does not equal the hand-computed sum
of its trades, costs that fail to bite, a win rate or drawdown computed off the
wrong denominator, and a sweep that recommends a threshold other than its own
argmax. Every expected number below is derived by hand in the test body — no
golden files, so a wrong result cannot be blessed by re-recording it.

The degenerate cases get equal weight: an empty test set, a threshold that
admits no trades, one trade, all wins and all losses must each return zeros
rather than raising or dividing by zero, because those are exactly the inputs a
freshly retrained (or badly broken) model produces.
"""

from __future__ import annotations

import numpy as np
import pytest

from mltrain.backtest import (
    DEFAULT_SWEEP_GRID,
    RegimeStats,
    SimulationResult,
    SweepRow,
    bootstrap_ci,
    run_threshold_sweep,
    select_best_threshold,
    simulate_pnl,
)

pytestmark = pytest.mark.unit

BANKROLL = 1000.0
BET = 10.0


def _sim(
    outcomes: list[int],
    *,
    prob: float = 0.9,
    price: float = 0.4,
    threshold: float = 0.6,
    min_edge: float = 0.0,
    txcost_frac: float = 0.0,
    bankroll: float = BANKROLL,
    bet_size: float = BET,
    regimes: np.ndarray | None = None,
) -> SimulationResult:
    """Run n trades at one fixed (confidence, price) with the given outcomes.

    With prob=0.9 the model always takes the UP side at 0.9 confidence, and at
    price=0.4 the edge is 0.5 before costs — so every row trades and the only
    thing varying is whether it won, which is what makes the P&L hand-computable.
    """
    n = len(outcomes)
    return simulate_pnl(
        np.full(n, prob),
        np.array(outcomes),
        np.full(n, price),
        threshold,
        min_edge,
        bankroll,
        bet_size,
        regimes,
        txcost_frac,
    )


def _result(*, trades: int, win_rate: float, trade_ratio: float) -> SimulationResult:
    """A SimulationResult carrying only the three fields the selector scores on."""
    return SimulationResult(
        trades=trades,
        wins=0,
        losses=0,
        win_rate=win_rate,
        total_pnl=0.0,
        roi=0.0,
        max_drawdown=0.0,
        profit_factor=0.0,
        sharpe=0.0,
        trades_per_year=0.0,
        trade_ratio=trade_ratio,
        regime_stats={},
        final_balance=0.0,
        total_txcost=0.0,
        pnl_history=[],
        returns=np.array([]),
    )


class TestSimulatePnLHandComputed:
    """Entry 0.40, bet 10 => a win pays +6.00 and a loss costs -4.00."""

    def test_two_wins_and_one_loss_nets_exactly_eight_dollars(self) -> None:
        r = _sim([1, 1, 0])
        assert r.trades == 3
        assert (r.wins, r.losses) == (2, 1)
        # +6.00 +6.00 -4.00
        assert r.total_pnl == pytest.approx(8.0)
        assert r.final_balance == pytest.approx(1008.0)

    def test_balance_series_matches_the_trade_by_trade_walk(self) -> None:
        r = _sim([1, 1, 0])
        assert [float(b) for b in r.pnl_history] == pytest.approx([1006.0, 1012.0, 1008.0])

    def test_win_rate_is_wins_over_trades(self) -> None:
        assert _sim([1, 1, 0]).win_rate == pytest.approx(2 / 3)

    def test_roi_is_pnl_as_a_percent_of_starting_bankroll(self) -> None:
        assert _sim([1, 1, 0]).roi == pytest.approx(0.8)
        assert _sim([1, 1, 0], bankroll=500.0).roi == pytest.approx(1.6)

    def test_profit_factor_is_gross_win_over_gross_loss(self) -> None:
        # 12.00 won / 4.00 lost
        assert _sim([1, 1, 0]).profit_factor == pytest.approx(3.0)

    def test_max_drawdown_is_measured_from_the_running_peak(self) -> None:
        # Balances 1005, 1010, 1005, 1000, 995 at +/-5.00 per trade (price 0.5).
        r = _sim([1, 1, 0, 0, 0], price=0.5)
        assert r.max_drawdown == pytest.approx(15 / 1010)

    def test_trade_ratio_counts_rows_offered_not_rows_taken(self) -> None:
        # Half the rows are below the 0.6 threshold, so only half can trade.
        y_prob = np.array([0.9, 0.55, 0.9, 0.55])
        r = simulate_pnl(y_prob, np.array([1, 1, 1, 1]), np.full(4, 0.4), 0.6, 0.0, BANKROLL, BET)
        assert r.trades == 2
        assert r.trade_ratio == pytest.approx(50.0)

    def test_bet_size_scales_pnl_linearly(self) -> None:
        assert _sim([1, 1, 0], bet_size=25.0).total_pnl == pytest.approx(8.0 * 2.5)

    def test_cheap_entry_pays_more_per_win(self) -> None:
        # price 0.01 clips up to the 0.05 floor => win pays 0.95 * 10.
        assert _sim([1], price=0.01).total_pnl == pytest.approx(9.5)

    def test_down_side_is_taken_when_the_model_expects_a_fall(self) -> None:
        # prob_up 0.1 => 0.9 confidence on DOWN, entry 1 - 0.4 = 0.60.
        r = simulate_pnl(np.array([0.1]), np.array([0]), np.array([0.4]), 0.6, 0.0, BANKROLL, BET)
        assert r.trades == 1 and r.wins == 1
        assert r.total_pnl == pytest.approx(4.0)

    def test_down_side_losing_forfeits_its_premium(self) -> None:
        r = simulate_pnl(np.array([0.1]), np.array([1]), np.array([0.4]), 0.6, 0.0, BANKROLL, BET)
        assert r.losses == 1
        assert r.total_pnl == pytest.approx(-6.0)


class TestTransactionCosts:
    def test_costs_are_charged_once_per_trade_win_or_lose(self) -> None:
        r = _sim([1, 1, 0], txcost_frac=0.04)
        # 4% of a $10 bet = $0.40, on all three trades.
        assert r.total_txcost == pytest.approx(1.20)

    def test_costs_reduce_pnl_by_exactly_the_amount_charged(self) -> None:
        free = _sim([1, 1, 0])
        costed = _sim([1, 1, 0], txcost_frac=0.04)
        assert costed.total_pnl == pytest.approx(free.total_pnl - 1.20)
        assert costed.total_pnl < free.total_pnl

    def test_costs_never_increase_pnl(self) -> None:
        outcomes = [1, 0, 1, 1, 0, 1]
        pnls = [_sim(outcomes, txcost_frac=f).total_pnl for f in (0.0, 0.01, 0.04, 0.10)]
        assert all(a >= b for a, b in zip(pnls, pnls[1:]))

    def test_profit_factor_charges_costs_to_the_loss_side(self) -> None:
        # 12.00 won / (4.00 lost + 1.20 in costs)
        assert _sim([1, 1, 0], txcost_frac=0.04).profit_factor == pytest.approx(12 / 5.2)

    def test_costs_are_subtracted_from_the_edge_before_the_gate(self) -> None:
        # Raw edge is 0.9 - 0.4 = 0.50; a 0.11 cost drops it under a 0.40 min-edge.
        assert _sim([1], min_edge=0.40, txcost_frac=0.11).trades == 0
        assert _sim([1], min_edge=0.40, txcost_frac=0.09).trades == 1

    def test_a_high_enough_cost_turns_a_winning_run_into_a_loss(self) -> None:
        # 6 wins at +6.00 each. min_edge is dropped below zero so the edge gate
        # cannot mask the effect: the cost alone has to sink the run.
        assert _sim([1] * 6, min_edge=-1.0, txcost_frac=0.60).total_pnl == pytest.approx(
            0.0, abs=1e-9
        )
        assert _sim([1] * 6, min_edge=-1.0, txcost_frac=0.70).total_pnl == pytest.approx(-6.0)


class TestNoTradesAndEdgeCases:
    def test_a_threshold_above_every_prediction_takes_no_trades(self) -> None:
        r = _sim([1, 1, 0], threshold=0.99)
        assert r.trades == 0
        assert r.total_pnl == 0
        assert r.roi == 0
        assert r.win_rate == 0
        assert r.max_drawdown == 0
        assert r.profit_factor == 0
        assert r.sharpe == 0
        assert r.trade_ratio == 0
        assert r.final_balance == pytest.approx(BANKROLL)
        assert r.total_txcost == 0
        assert r.regime_stats == {}
        assert len(r.returns) == 0

    def test_a_min_edge_above_every_edge_takes_no_trades(self) -> None:
        assert _sim([1, 1, 0], min_edge=0.9).trades == 0

    def test_an_empty_test_set_does_not_divide_by_zero(self) -> None:
        r = simulate_pnl(np.array([]), np.array([]), np.array([]), 0.6, 0.0, BANKROLL, BET)
        assert r.trades == 0
        assert r.trade_ratio == 0
        assert r.total_pnl == 0

    def test_a_zero_bankroll_reports_no_roi_instead_of_dividing_by_zero(self) -> None:
        r = _sim([1, 0], bankroll=0.0)
        assert r.roi == 0
        assert r.total_pnl == pytest.approx(2.0)

    def test_a_peak_that_never_goes_positive_reports_no_drawdown(self) -> None:
        # Drawdown is a fraction of the running peak; from a zero bankroll a
        # losing run has no positive peak to be a fraction of.
        assert _sim([0, 0], bankroll=0.0).max_drawdown == 0

    def test_a_single_trade_reports_no_sharpe(self) -> None:
        r = _sim([1])
        # One balance point cannot be differenced into a return series.
        assert r.trades == 1
        assert r.sharpe == 0
        assert r.trades_per_year == 0
        assert len(r.returns) == 0

    def test_all_wins_report_a_perfect_record(self) -> None:
        r = _sim([1] * 5)
        assert (r.wins, r.losses) == (5, 0)
        assert r.win_rate == 1.0
        assert r.total_pnl == pytest.approx(30.0)
        assert r.max_drawdown == 0
        # No losses and no costs => the sentinel, not a ZeroDivisionError.
        assert r.profit_factor == pytest.approx(999.99)

    def test_all_losses_report_a_zero_record(self) -> None:
        r = _sim([0] * 5)
        assert (r.wins, r.losses) == (0, 5)
        assert r.win_rate == 0.0
        assert r.total_pnl == pytest.approx(-20.0)
        assert r.profit_factor == 0
        assert r.max_drawdown == pytest.approx(20 / 1000)

    def test_identical_returns_report_no_sharpe(self) -> None:
        # Two identical wins => a one-element return series => zero dispersion.
        r = _sim([1, 1])
        assert r.sharpe == 0

    def test_sharpe_is_finite_and_positive_for_a_winning_mixed_run(self) -> None:
        r = _sim([1, 0, 1, 1, 0, 1, 1, 1])
        assert np.isfinite(r.sharpe)
        assert r.sharpe > 0
        assert r.trades_per_year > 0


class TestRegimeBreakdown:
    def _regimed(self, txcost_frac: float = 0.0) -> SimulationResult:
        regimes = np.array(["trending", "moderate", "trending", "moderate"])
        return _sim([1, 1, 0, 0], regimes=regimes, txcost_frac=txcost_frac)

    def test_splits_trades_and_wins_by_regime(self) -> None:
        stats = self._regimed().regime_stats
        assert stats["trending"].trades == 2
        assert stats["trending"].wins == 1
        assert stats["moderate"].trades == 2
        assert stats["moderate"].wins == 1

    def test_regime_pnl_sums_to_total_pnl(self) -> None:
        r = self._regimed(txcost_frac=0.04)
        assert sum(s.pnl for s in r.regime_stats.values()) == pytest.approx(r.total_pnl)

    def test_regime_pnl_is_net_of_costs(self) -> None:
        # trending: one win (+6.00 -0.40) and one loss (-4.00 -0.40).
        assert self._regimed(txcost_frac=0.04).regime_stats["trending"].pnl == pytest.approx(1.20)

    def test_regime_stats_are_absent_when_no_regimes_are_supplied(self) -> None:
        assert _sim([1, 0]).regime_stats == {}

    def test_untraded_regimes_do_not_appear(self) -> None:
        regimes = np.array(["trending", "mean_reverting"])
        r = simulate_pnl(
            np.array([0.9, 0.55]),
            np.array([1, 1]),
            np.full(2, 0.4),
            0.6,
            0.0,
            BANKROLL,
            BET,
            regimes,
        )
        assert set(r.regime_stats) == {"trending"}

    def test_win_rate_of_an_idle_regime_is_zero(self) -> None:
        assert RegimeStats(trades=0, wins=0, pnl=0.0).win_rate == 0.0


class TestThresholdSweep:
    def _sweep(self, n: int = 400, rng: np.random.Generator | None = None):
        rng = rng or np.random.default_rng(7)
        probs = rng.uniform(0.50, 0.85, size=n)
        prices = rng.uniform(0.20, 0.55, size=n)
        labels = (rng.uniform(size=n) < 0.7).astype(int)
        return run_threshold_sweep(
            probs, labels, prices, min_edge=0.0, bankroll=BANKROLL, bet_size=BET, txcost_frac=0.0
        )

    def test_covers_the_documented_grid(self) -> None:
        rows = self._sweep()
        expected = list(np.arange(*DEFAULT_SWEEP_GRID))
        assert [row.threshold for row in rows] == pytest.approx(expected)
        assert rows[0].threshold == pytest.approx(0.50)
        assert rows[-1].threshold == pytest.approx(0.80)

    def test_trade_count_is_monotonically_non_increasing(self) -> None:
        # A higher confidence gate can only ever be a subset of a lower one.
        counts = [row.result.trades for row in self._sweep()]
        assert all(a >= b for a, b in zip(counts, counts[1:]))

    def test_selects_the_highest_scoring_qualifying_row(self) -> None:
        rows = self._sweep()
        best = select_best_threshold(rows)
        scored = [
            (r.result.win_rate * np.sqrt(r.result.trade_ratio / 100), r.threshold)
            for r in rows
            if r.result.trades >= 50
        ]
        assert best.score == pytest.approx(max(s for s, _ in scored))
        assert best.threshold == pytest.approx(max(scored)[1])

    def test_score_is_win_rate_times_sqrt_coverage(self) -> None:
        rows = [SweepRow(0.60, _result(trades=100, win_rate=0.64, trade_ratio=25.0))]
        # 0.64 * sqrt(0.25) = 0.32
        assert select_best_threshold(rows).score == pytest.approx(0.32)

    def test_ignores_rows_below_the_minimum_trade_count(self) -> None:
        rows = [
            SweepRow(0.60, _result(trades=100, win_rate=0.60, trade_ratio=50.0)),
            SweepRow(0.70, _result(trades=49, win_rate=0.99, trade_ratio=90.0)),
        ]
        assert select_best_threshold(rows).threshold == pytest.approx(0.60)

    def test_prefers_coverage_when_accuracy_ties(self) -> None:
        rows = [
            SweepRow(0.60, _result(trades=100, win_rate=0.80, trade_ratio=20.0)),
            SweepRow(0.70, _result(trades=100, win_rate=0.80, trade_ratio=80.0)),
        ]
        assert select_best_threshold(rows).threshold == pytest.approx(0.70)

    def test_ties_keep_the_lowest_threshold(self) -> None:
        rows = [
            SweepRow(0.55, _result(trades=100, win_rate=0.70, trade_ratio=40.0)),
            SweepRow(0.65, _result(trades=100, win_rate=0.70, trade_ratio=40.0)),
        ]
        assert select_best_threshold(rows).threshold == pytest.approx(0.55)

    def test_falls_back_to_the_default_when_nothing_qualifies(self) -> None:
        rows = [SweepRow(0.60, _result(trades=3, win_rate=1.0, trade_ratio=1.0))]
        choice = select_best_threshold(rows)
        assert choice.threshold == pytest.approx(0.60)
        assert choice.score == 0

    def test_honours_a_custom_default(self) -> None:
        assert select_best_threshold([], default_threshold=0.72).threshold == pytest.approx(0.72)

    def test_a_sweep_that_admits_no_trades_is_all_zeros(self) -> None:
        # Every prediction sits at 0.55, below all but the lowest candidates.
        rows = run_threshold_sweep(
            np.full(100, 0.55),
            np.ones(100, dtype=int),
            np.full(100, 0.40),
            min_edge=0.9,
            bankroll=BANKROLL,
            bet_size=BET,
        )
        assert all(row.result.trades == 0 for row in rows)
        assert all(row.result.total_pnl == 0 for row in rows)
        assert select_best_threshold(rows).threshold == pytest.approx(0.60)


class TestBootstrapCI:
    def test_too_few_trades_yields_an_unusable_interval(self) -> None:
        ci = bootstrap_ci(np.array([0.01] * 9))
        assert not ci.sufficient
        assert ci.n_trades == 9
        assert np.isnan(ci.sharpe_lo) and np.isnan(ci.roi_hi)

    def test_ten_trades_is_enough(self) -> None:
        ci = bootstrap_ci(np.linspace(-0.01, 0.03, 10))
        assert ci.sufficient
        assert ci.n_trades == 10
        assert ci.sharpe_lo <= ci.sharpe_hi
        assert ci.roi_lo <= ci.roi_hi

    def test_is_deterministic_for_a_fixed_seed(self) -> None:
        returns = np.linspace(-0.02, 0.05, 40)
        first = bootstrap_ci(returns)
        second = bootstrap_ci(returns)
        assert first == second

    def test_a_different_seed_moves_the_interval(self, rng: np.random.Generator) -> None:
        returns = rng.normal(0.002, 0.01, size=200)
        assert bootstrap_ci(returns, seed=1) != bootstrap_ci(returns, seed=2)

    def test_constant_returns_have_no_sharpe_dispersion(self) -> None:
        # 0.5 is exactly representable, so every resample has a true zero stdev
        # and Sharpe is reported as 0 rather than as a division by ~0.
        ci = bootstrap_ci(np.full(20, 0.5))
        assert ci.sharpe_lo == 0 and ci.sharpe_hi == 0

    def test_a_profitable_series_has_a_positive_roi_interval(self) -> None:
        ci = bootstrap_ci(np.full(20, 0.01) + np.linspace(0, 0.001, 20))
        assert ci.roi_lo > 0

    def test_sharpe_scales_with_the_square_root_of_trade_frequency(
        self, rng: np.random.Generator
    ) -> None:
        returns = rng.normal(0.002, 0.01, size=100)
        base = bootstrap_ci(returns, trades_per_year=250.0)
        quadrupled = bootstrap_ci(returns, trades_per_year=1000.0)
        assert quadrupled.sharpe_hi == pytest.approx(2 * base.sharpe_hi)
        # ROI is a plain sum of returns, so annualisation must not touch it.
        assert quadrupled.roi_hi == pytest.approx(base.roi_hi)

    def test_missing_trade_frequency_falls_back_to_bar_frequency(self) -> None:
        returns = np.linspace(-0.01, 0.03, 30)
        assert bootstrap_ci(returns, trades_per_year=None) == bootstrap_ci(
            returns, trades_per_year=0
        )
