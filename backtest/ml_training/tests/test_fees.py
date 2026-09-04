"""Unit tests for mltrain.fees — the per-trade cost and payoff arithmetic.

Two classes of error matter here and are asserted directly. First, sign and
magnitude: a cost that is added instead of subtracted, or scaled by 100 instead
of divided, turns a losing strategy into a winning one on paper. Second, the gap
between the backtest's flat cost model and the fee the live bot actually pays
(0.072 * p * (1-p)) — that gap is pinned numerically here so it stays a known,
quantified conservatism rather than an unnoticed drift.
"""

from __future__ import annotations

import numpy as np
import pytest

from mltrain.fees import (
    DEFAULT_SLIPPAGE_PCT,
    DEFAULT_SPREAD_PCT,
    PRICE_CAP,
    PRICE_FLOOR,
    entry_price,
    loss_amount,
    net_edge,
    per_trade_cost,
    polymarket_dynamic_fee_rate,
    round_trip_cost_fraction,
    win_payoff,
)

pytestmark = pytest.mark.unit


class TestRoundTripCostFraction:
    def test_script_defaults_give_four_percent(self) -> None:
        frac = round_trip_cost_fraction(DEFAULT_SPREAD_PCT, DEFAULT_SLIPPAGE_PCT)
        assert frac == pytest.approx(0.04)

    def test_percent_is_divided_by_one_hundred(self) -> None:
        assert round_trip_cost_fraction(1.0, 0.5) == pytest.approx(0.015)

    def test_zero_costs_are_free(self) -> None:
        assert round_trip_cost_fraction(0.0, 0.0) == 0.0

    def test_spread_and_slippage_are_additive(self) -> None:
        assert round_trip_cost_fraction(2.0, 3.0) == pytest.approx(
            round_trip_cost_fraction(5.0, 0.0)
        )


class TestPerTradeCost:
    def test_scales_with_bet_size(self) -> None:
        assert per_trade_cost(0.04, 10.0) == pytest.approx(0.40)
        assert per_trade_cost(0.04, 25.0) == pytest.approx(1.00)

    def test_zero_cost_fraction_is_free(self) -> None:
        assert per_trade_cost(0.0, 10.0) == 0.0


class TestEntryPrice:
    def test_up_pays_the_quoted_price(self) -> None:
        assert entry_price(0.42, "UP") == pytest.approx(0.42)

    def test_down_pays_the_complement(self) -> None:
        assert entry_price(0.42, "DOWN") == pytest.approx(0.58)

    def test_the_two_sides_sum_to_one(self) -> None:
        for p in (0.10, 0.37, 0.5, 0.88):
            assert entry_price(p, "UP") + entry_price(p, "DOWN") == pytest.approx(1.0)

    def test_clips_to_the_tradeable_band(self) -> None:
        assert entry_price(0.001, "UP") == pytest.approx(PRICE_FLOOR)
        assert entry_price(0.999, "UP") == pytest.approx(PRICE_CAP)
        # DOWN complement of a near-zero quote is near one, and clips at the cap.
        assert entry_price(0.001, "DOWN") == pytest.approx(PRICE_CAP)

    def test_preserves_float32_width(self) -> None:
        # The simulator reads prices out of a float32 feature matrix; coercing
        # to float64 here would change the accumulated balance in the last bits.
        assert entry_price(np.float32(0.42), "UP").dtype == np.float32


class TestNetEdge:
    def test_edge_is_model_prob_minus_price_minus_cost(self) -> None:
        assert net_edge(0.70, 0.55, 0.04) == pytest.approx(0.11)

    def test_costs_reduce_the_edge_one_for_one(self) -> None:
        free = net_edge(0.70, 0.55, 0.0)
        costed = net_edge(0.70, 0.55, 0.04)
        assert costed == pytest.approx(free - 0.04)
        assert costed < free

    def test_an_overpriced_token_has_negative_edge(self) -> None:
        assert net_edge(0.55, 0.70, 0.04) < 0


class TestPayoffs:
    def test_win_pays_the_remaining_distance_to_settlement(self) -> None:
        assert win_payoff(0.40, 10.0) == pytest.approx(6.0)

    def test_loss_forfeits_the_premium_paid(self) -> None:
        assert loss_amount(0.40, 10.0) == pytest.approx(4.0)

    def test_win_plus_loss_equals_bet_size(self) -> None:
        # A binary contract's two outcomes must partition the notional exactly.
        for p in (0.05, 0.4, 0.5, 0.95):
            assert win_payoff(p, 10.0) + loss_amount(p, 10.0) == pytest.approx(10.0)

    def test_cheap_entries_pay_more_and_risk_less(self) -> None:
        assert win_payoff(0.10, 10.0) > win_payoff(0.90, 10.0)
        assert loss_amount(0.10, 10.0) < loss_amount(0.90, 10.0)


class TestPolymarketDynamicFeeRate:
    def test_peaks_at_one_point_eight_percent_on_a_coin_flip(self) -> None:
        assert polymarket_dynamic_fee_rate(0.50) == pytest.approx(0.018)

    def test_is_symmetric_about_a_half(self) -> None:
        assert polymarket_dynamic_fee_rate(0.30) == pytest.approx(polymarket_dynamic_fee_rate(0.70))

    def test_vanishes_at_the_extremes(self) -> None:
        assert polymarket_dynamic_fee_rate(0.0) == pytest.approx(0.0)
        assert polymarket_dynamic_fee_rate(1.0) == pytest.approx(0.0)

    def test_band_edges_cost_a_third_of_a_percent(self) -> None:
        assert polymarket_dynamic_fee_rate(PRICE_FLOOR) == pytest.approx(0.00342)
        assert polymarket_dynamic_fee_rate(PRICE_CAP) == pytest.approx(0.00342)

    def test_the_scripts_flat_default_is_conservative_at_every_price(self) -> None:
        # Documents the modelling gap: the backtest charges a flat 4.0% while the
        # live bot pays a price-dependent fee peaking at 1.8%. The flat charge is
        # the pessimistic side of that difference across the whole tradeable band.
        flat = round_trip_cost_fraction(DEFAULT_SPREAD_PCT, DEFAULT_SLIPPAGE_PCT)
        prices = np.linspace(PRICE_FLOOR, PRICE_CAP, 91)
        assert np.all(polymarket_dynamic_fee_rate(prices) < flat)

    def test_a_low_spread_setting_would_understate_the_real_fee(self) -> None:
        # --spread-pct 0.5 --slippage-pct 0.5 gives a 1.0% flat charge, which is
        # below the real 1.8% fee exactly where the bot trades most (p near 0.5).
        thin = round_trip_cost_fraction(0.5, 0.5)
        assert polymarket_dynamic_fee_rate(0.50) > thin
