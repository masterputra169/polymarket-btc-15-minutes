"""Unit tests for mltrain.features.

Feature order and count are part of the model contract: norm_browser.json is
written positionally and src/engines/Mlpredictor.ts rebuilds the vector in the
same order, so a silent reordering here would mis-predict in production while
every training metric still looked fine.
"""

from __future__ import annotations

import numpy as np
import pytest

from mltrain.features import engineer_features

pytestmark = pytest.mark.unit

BASE_FEATURES = [
    "delta_1m_pct",
    "delta_3m_pct",
    "rsi_norm",
    "rsi_slope",
    "vwap_dist",
    "vwap_slope",
    "macd_line",
    "macd_hist",
    "bb_percent_b",
    "bb_squeeze",
    "atr_pct_norm",
    "stoch_k_norm",
    "vol_ratio_norm",
    "vol_delta_buy_ratio",
    "ha_is_green",
    "ha_signed_consec",
    "ema_cross_signal",
    "ema_dist_norm",
    "multi_tf_agreement",
    "regime_trending",
    "regime_mean_reverting",
    "regime_confidence",
    "market_price_momentum",
    "orderbook_imbalance",
    "crowd_model_divergence",
    "rule_confidence",
]
EXPECTED_ENGINEERED = 25  # the '25 engineered features' the pipeline advertises


@pytest.fixture
def base_matrix(rng: np.random.Generator) -> np.ndarray:
    return rng.uniform(-1.0, 1.0, size=(64, len(BASE_FEATURES))).astype(np.float32)


class TestShapeAndNaming:
    def test_appends_expected_number_of_features(self, base_matrix: np.ndarray) -> None:
        X, cols = engineer_features(base_matrix, BASE_FEATURES)
        assert X.shape[1] == len(BASE_FEATURES) + EXPECTED_ENGINEERED
        assert len(cols) == X.shape[1]

    def test_base_columns_are_preserved_bit_for_bit(self, base_matrix: np.ndarray) -> None:
        X, cols = engineer_features(base_matrix, BASE_FEATURES)
        assert np.array_equal(X[:, : len(BASE_FEATURES)], base_matrix)
        assert cols[: len(BASE_FEATURES)] == BASE_FEATURES

    def test_engineered_names_are_unique_and_appended_last(self, base_matrix: np.ndarray) -> None:
        _, cols = engineer_features(base_matrix, BASE_FEATURES)
        engineered = cols[len(BASE_FEATURES) :]
        assert len(set(engineered)) == len(engineered)
        assert not set(engineered) & set(BASE_FEATURES)

    def test_row_count_unchanged(self, base_matrix: np.ndarray) -> None:
        X, _ = engineer_features(base_matrix, BASE_FEATURES)
        assert X.shape[0] == base_matrix.shape[0]

    def test_output_is_float32(self, base_matrix: np.ndarray) -> None:
        # The browser predictor reads Float64Array built from float32 exports.
        X, _ = engineer_features(base_matrix, BASE_FEATURES)
        assert X.dtype == np.float32


class TestNumericalSafety:
    def test_no_nan_or_inf_in_output(self, base_matrix: np.ndarray) -> None:
        X, _ = engineer_features(base_matrix, BASE_FEATURES)
        assert np.isfinite(X).all()

    def test_nan_inputs_are_zeroed_not_propagated(self, base_matrix: np.ndarray) -> None:
        dirty = base_matrix.copy()
        dirty[0, :] = np.nan
        dirty[1, :] = np.inf
        X, _ = engineer_features(dirty, BASE_FEATURES)
        assert np.isfinite(X).all()

    def test_zero_input_is_handled(self) -> None:
        zeros = np.zeros((8, len(BASE_FEATURES)), dtype=np.float32)
        X, _ = engineer_features(zeros, BASE_FEATURES)
        assert np.isfinite(X).all()


class TestMissingBaseColumns:
    def test_absent_base_feature_defaults_to_zero_column(self, rng: np.random.Generator) -> None:
        # Training data older than a feature addition must still train, with the
        # missing input treated as 0 rather than raising.
        reduced = [c for c in BASE_FEATURES if c != "orderbook_imbalance"]
        X_small = rng.uniform(size=(16, len(reduced))).astype(np.float32)
        X, cols = engineer_features(X_small, reduced)
        assert np.isfinite(X).all()
        assert "imbalance_x_vol_delta" in cols


class TestKnownFeatureMaths:
    def _engineered(self, matrix: np.ndarray) -> dict[str, np.ndarray]:
        X, cols = engineer_features(matrix, BASE_FEATURES)
        return {name: X[:, i] for i, name in enumerate(cols)}

    def test_multi_indicator_agree_is_a_normalised_fraction(self, rng: np.random.Generator) -> None:
        # Sums five agreement flags / 5. The fifth term passes multi_tf_agreement
        # through raw, so the [0,1] range holds for its real 0/1 domain (the
        # generator emits binary agreement) — not for arbitrary floats.
        m = rng.uniform(-1.0, 1.0, size=(64, len(BASE_FEATURES))).astype(np.float32)
        m[:, BASE_FEATURES.index("multi_tf_agreement")] = rng.integers(0, 2, size=64)
        vals = self._engineered(m)["multi_indicator_agree"]
        assert ((vals >= 0.0) & (vals <= 1.0)).all()

    def test_crowd_agree_momentum_is_sign_agreement(self) -> None:
        m = np.zeros((3, len(BASE_FEATURES)), dtype=np.float32)
        i_delta = BASE_FEATURES.index("delta_1m_pct")
        i_mom = BASE_FEATURES.index("market_price_momentum")
        m[0, i_delta], m[0, i_mom] = 0.5, 0.5  # agree, both up
        m[1, i_delta], m[1, i_mom] = -0.5, 0.5  # disagree
        m[2, i_delta], m[2, i_mom] = -0.5, -0.5  # agree, both down
        vals = self._engineered(m)["crowd_agree_momentum"]
        assert vals[0] == pytest.approx(1.0)
        assert vals[1] == pytest.approx(-1.0)
        assert vals[2] == pytest.approx(1.0)

    def test_divergence_x_confidence_is_the_product(self, rng: np.random.Generator) -> None:
        m = rng.uniform(0.1, 0.9, size=(5, len(BASE_FEATURES))).astype(np.float32)
        i_div = BASE_FEATURES.index("crowd_model_divergence")
        i_conf = BASE_FEATURES.index("rule_confidence")
        vals = self._engineered(m)["divergence_x_confidence"]
        assert np.allclose(vals, m[:, i_div] * m[:, i_conf], atol=1e-6)
