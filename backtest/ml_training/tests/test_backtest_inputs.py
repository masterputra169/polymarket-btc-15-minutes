"""Unit tests for mltrain.backtest_inputs — what the simulator is handed.

These four helpers never touch money, which is exactly why they are worth
pinning: each one silently redefines the backtest without changing a line of
P&L arithmetic. A split index off by a fraction turns an out-of-sample result
into a re-read of the tuning set; a market-price fallback firing unnoticed
changes what every "edge" is measured against; a regime label resolved in the
wrong priority order moves P&L between buckets the user reads per-regime.

`TestPlattCalibration::test_probability_input_collapses_the_output_range` is the
important one: it pins the observed consequence of feeding booster PROBABILITIES
to a transform fitted on raw margins, so the truncated output range is a
documented, asserted fact rather than something to rediscover.
"""

from __future__ import annotations

import numpy as np
import pytest

from mltrain.backtest_inputs import (
    apply_platt_calibration,
    derive_regime_labels,
    extract_market_prices,
    oos_split_index,
)

pytestmark = pytest.mark.unit


class TestPlattCalibration:
    def test_identity_parameters_are_a_plain_sigmoid(self) -> None:
        logits = np.array([-2.0, 0.0, 2.0])
        out = apply_platt_calibration(logits, 1.0, 0.0)
        assert out == pytest.approx(1 / (1 + np.exp(-logits)))
        assert out[1] == pytest.approx(0.5)

    def test_is_monotonically_increasing(self) -> None:
        out = apply_platt_calibration(np.linspace(-5, 5, 50), 1.3, -0.2)
        assert np.all(np.diff(out) > 0)

    def test_output_always_lands_in_the_unit_interval(self) -> None:
        out = apply_platt_calibration(np.array([-50.0, 0.0, 50.0]), 2.0, 1.0)
        assert np.all((out >= 0.0) & (out <= 1.0))
        # Strictly interior for any score the model can realistically produce.
        interior = apply_platt_calibration(np.linspace(-8, 8, 33), 2.0, 1.0)
        assert np.all((interior > 0.0) & (interior < 1.0))

    def test_probability_input_collapses_the_output_range(self) -> None:
        # Guard on the documented space mismatch: A/B are fitted on raw margins
        # (norm_browser.json carries platt_on_logits=true), so feeding booster
        # PROBABILITIES applies a second sigmoid and squashes [0,1] into
        # [0.50, 0.73] — no prediction can ever fall below 0.5 again.
        out = apply_platt_calibration(np.linspace(0.0, 1.0, 101), 1.0, 0.0)
        assert out.min() == pytest.approx(0.5)
        assert out.max() == pytest.approx(0.7311, abs=1e-4)


class TestRegimeLabels:
    FEATURES = {"regime_trending": 0, "regime_mean_reverting": 1, "regime_moderate": 2}

    def test_reads_the_one_hot_columns(self) -> None:
        X = np.array([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]])
        labels = derive_regime_labels(X, self.FEATURES, 0)
        assert list(labels) == ["trending", "mean_reverting", "moderate"]

    def test_rows_before_the_split_are_not_labelled(self) -> None:
        X = np.array([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]])
        assert list(derive_regime_labels(X, self.FEATURES, 2)) == ["moderate"]

    def test_unset_rows_fall_back_to_the_default(self) -> None:
        X = np.zeros((2, 3))
        assert list(derive_regime_labels(X, self.FEATURES, 0)) == ["moderate", "moderate"]

    def test_the_first_matching_column_wins(self) -> None:
        # Priority order is trending, mean_reverting, moderate.
        X = np.ones((1, 3))
        assert list(derive_regime_labels(X, self.FEATURES, 0)) == ["trending"]

    def test_missing_regime_columns_are_skipped_not_indexed(self) -> None:
        X = np.array([[1.0, 0.0, 0.0]])
        assert list(derive_regime_labels(X, {"regime_trending": 0}, 0)) == ["trending"]
        assert list(derive_regime_labels(X, {}, 0)) == ["moderate"]

    def test_a_custom_default_is_honoured(self) -> None:
        assert list(derive_regime_labels(np.zeros((1, 3)), {}, 0, default_regime="unknown")) == [
            "unknown"
        ]


class TestMarketPrices:
    def test_prefers_the_real_polymarket_price(self) -> None:
        X = np.array([[0.30, 0.90], [0.40, 0.95]])
        prices = extract_market_prices(X, {"market_yes_price": 0, "rule_prob_up": 1}, 0, 2)
        assert list(prices) == pytest.approx([0.30, 0.40])

    def test_starts_at_the_split_index(self) -> None:
        X = np.array([[0.30], [0.40], [0.50]])
        assert list(extract_market_prices(X, {"market_yes_price": 0}, 1, 2)) == pytest.approx(
            [0.40, 0.50]
        )

    def test_falls_back_to_the_rule_engine_probability(self) -> None:
        X = np.array([[0.90], [0.95]])
        assert list(extract_market_prices(X, {"rule_prob_up": 0}, 0, 2)) == pytest.approx(
            [0.90, 0.95]
        )

    def test_falls_back_to_a_flat_coin_flip(self) -> None:
        prices = extract_market_prices(np.zeros((3, 1)), {}, 0, 3)
        assert list(prices) == pytest.approx([0.5, 0.5, 0.5])
        assert len(prices) == 3


class TestOosSplitIndex:
    def test_takes_the_floor_of_the_fraction(self) -> None:
        assert oos_split_index(1000, 0.85) == 850
        assert oos_split_index(12596, 0.85) == 10706

    def test_zero_keeps_every_row(self) -> None:
        assert oos_split_index(100, 0.0) == 0

    def test_one_leaves_no_rows(self) -> None:
        assert oos_split_index(100, 1.0) == 100
