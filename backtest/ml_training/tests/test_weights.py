"""Unit tests for mltrain.weights — sample and feature weighting.

A weight vector that is negative, zero-mean or silently renormalised the wrong
way changes the effective sample size, which invalidates every regularisation
constant Optuna tuned against it. These tests pin the properties that keep the
weighting honest: strictly positive weights, mean exactly 1.0 after the session
pass, and per-feature exclusion that hits the intended column and nothing else.
"""

from __future__ import annotations

import numpy as np
import pytest

from mltrain.weights import (
    REGIME_FEATURES,
    apply_session_weights,
    build_feature_weights,
    build_sample_weights,
    count_regimes,
    recency_weights,
)

pytestmark = pytest.mark.unit

SESSION_FI = {'session_asia': 0, 'session_us': 1, 'session_overlap': 2}


def _sessions(n: int = 300) -> np.ndarray:
    """One-hot session columns cycling asia / us / overlap."""
    X = np.zeros((n, 3), dtype=np.float32)
    X[np.arange(n), np.arange(n) % 3] = 1.0
    return X


class TestRecencyWeights:
    def test_weights_are_strictly_positive(self) -> None:
        w = recency_weights(500, days=180, halflife=90)
        assert np.all(w > 0)

    def test_newest_row_outweighs_oldest(self) -> None:
        w = recency_weights(500, days=180, halflife=90)
        assert w[-1] > w[0]
        assert np.all(np.diff(w) >= 0)  # monotonically increasing toward "now"

    def test_bounded_between_the_floor_and_one(self) -> None:
        # 0.5 floor keeps old rows contributing instead of deleting them.
        w = recency_weights(400, days=540, halflife=30)
        assert w.min() >= 0.5
        assert w.max() == pytest.approx(1.0, abs=1e-6)

    def test_shorter_halflife_discounts_the_past_harder(self) -> None:
        slow = recency_weights(400, days=360, halflife=180)
        fast = recency_weights(400, days=360, halflife=20)
        assert fast[0] < slow[0]

    def test_dtype_is_float32_for_the_booster(self) -> None:
        assert recency_weights(50, days=90, halflife=90).dtype == np.float32


class TestSessionWeights:
    def test_normalised_to_mean_one(self) -> None:
        sw = apply_session_weights(None, _sessions(), SESSION_FI)
        assert float(sw.weights.mean()) == pytest.approx(1.0, abs=1e-5)

    def test_weights_are_strictly_positive(self) -> None:
        sw = apply_session_weights(None, _sessions(), SESSION_FI)
        assert np.all(sw.weights > 0)

    def test_relative_session_ordering_is_us_overlap_asia(self) -> None:
        X = _sessions(300)
        sw = apply_session_weights(None, X, SESSION_FI)
        asia = sw.weights[X[:, 0] > 0.5].mean()
        us = sw.weights[X[:, 1] > 0.5].mean()
        overlap = sw.weights[X[:, 2] > 0.5].mean()
        assert us > overlap > asia
        # Ratios survive the mean-1.0 renormalisation.
        assert us / asia == pytest.approx(1.5 / 0.8, rel=1e-5)
        assert overlap / asia == pytest.approx(1.3 / 0.8, rel=1e-5)

    def test_counts_match_the_flagged_rows(self) -> None:
        sw = apply_session_weights(None, _sessions(300), SESSION_FI)
        assert sw.n_us == 100
        assert sw.n_overlap == 100
        assert sw.n_asia == 100

    def test_input_weights_are_not_mutated(self) -> None:
        base = recency_weights(300, days=180, halflife=90)
        before = base.copy()
        apply_session_weights(base, _sessions(), SESSION_FI)
        assert np.array_equal(base, before)

    def test_composes_on_top_of_recency(self) -> None:
        X = _sessions(300)
        base = recency_weights(300, days=180, halflife=90)
        sw = apply_session_weights(base, X, SESSION_FI)
        assert float(sw.weights.mean()) == pytest.approx(1.0, abs=1e-5)
        # Still recency-ordered within a single session bucket.
        us_rows = np.flatnonzero(X[:, 1] > 0.5)
        assert sw.weights[us_rows[-1]] > sw.weights[us_rows[0]]

    def test_missing_session_features_degrade_to_renormalisation(self) -> None:
        sw = apply_session_weights(None, _sessions(), {})
        assert sw.n_us == sw.n_overlap == sw.n_asia == 0
        assert np.allclose(sw.weights, 1.0)


class TestBuildSampleWeights:
    def test_returns_none_when_both_schemes_are_off(self) -> None:
        # None (not ones) so the boosters skip the weight path entirely.
        w = build_sample_weights(_sessions(), SESSION_FI, use_recency=False, days=180,
                                 halflife=90, use_session=False, log=lambda _: None)
        assert w is None

    def test_recency_only_is_not_renormalised(self) -> None:
        w = build_sample_weights(_sessions(), SESSION_FI, use_recency=True, days=180,
                                 halflife=90, use_session=False, log=lambda _: None)
        assert w.max() == pytest.approx(1.0, abs=1e-6)
        assert float(w.mean()) < 1.0

    def test_both_schemes_yield_positive_mean_one_weights(self) -> None:
        w = build_sample_weights(_sessions(), SESSION_FI, use_recency=True, days=180,
                                 halflife=90, use_session=True, log=lambda _: None)
        assert np.all(w > 0)
        assert float(w.mean()) == pytest.approx(1.0, abs=1e-5)

    def test_reports_every_session_bucket(self) -> None:
        lines: list[str] = []
        build_sample_weights(_sessions(), SESSION_FI, use_recency=False, days=180,
                             halflife=90, use_session=True, log=lines.append)
        joined = "\n".join(lines)
        for fragment in ("Session weighting applied", "US ", "Overlap ", "Asia ", "Normalized"):
            assert fragment in joined


class TestCountRegimes:
    def test_counts_rows_flagged_per_regime(self) -> None:
        X = np.zeros((10, 3), dtype=np.float32)
        X[:4, 0] = 1.0   # trending
        X[4:7, 1] = 1.0  # mean_rev
        fi = {'regime_trending': 0, 'regime_mean_reverting': 1, 'regime_moderate': 2}
        assert count_regimes(X, fi) == {'trending': 4, 'mean_rev': 3, 'moderate': 0}

    def test_absent_regimes_are_skipped_not_zeroed(self) -> None:
        X = np.ones((5, 1), dtype=np.float32)
        counts = count_regimes(X, {'regime_trending': 0})
        assert counts == {'trending': 5}

    def test_report_order_follows_the_declared_regime_order(self) -> None:
        X = np.ones((5, 3), dtype=np.float32)
        fi = {'regime_trending': 0, 'regime_mean_reverting': 1, 'regime_moderate': 2}
        assert list(count_regimes(X, fi)) == [name for name, _ in REGIME_FEATURES]


class TestBuildFeatureWeights:
    def test_defaults_to_all_ones(self) -> None:
        fw = build_feature_weights(['a', 'b', 'c'], [], log=lambda _: None)
        assert fw.dtype == np.float32
        assert np.array_equal(fw, np.ones(3, dtype=np.float32))

    def test_excludes_only_the_named_columns(self) -> None:
        lines: list[str] = []
        fw = build_feature_weights(['a', 'b', 'c'], ['b'], log=lines.append)
        assert np.array_equal(fw, np.array([1.0, 0.0, 1.0], dtype=np.float32))
        assert any("Pre-excluded 1 features" in line for line in lines)

    def test_unknown_names_warn_and_are_not_counted(self) -> None:
        lines: list[str] = []
        fw = build_feature_weights(['a', 'b'], ['b', 'ghost'], log=lines.append)
        assert np.array_equal(fw, np.array([1.0, 0.0], dtype=np.float32))
        assert any("--exclude-features 'ghost' not found" in line for line in lines)
        assert any("Pre-excluded 1 features" in line for line in lines)

    def test_length_matches_the_full_feature_list(self) -> None:
        # feature_weights is passed positionally to DMatrix; a length mismatch
        # would silently weight the wrong columns.
        cols = [f"f{i}" for i in range(79)]
        assert len(build_feature_weights(cols, [], log=lambda _: None)) == len(cols)
