"""Unit tests for mltrain.metrics — the helpers that build the exported
`metrics` block the deploy gates in bot/src/autoRetrain.ts read by name."""

from __future__ import annotations

import numpy as np
import pytest

from mltrain.metrics import calibration_summary, confidence_bucket_summary, safe_round

pytestmark = pytest.mark.unit


class TestSafeRound:
    def test_rounds_to_requested_digits(self) -> None:
        assert safe_round(0.123456, 4) == 0.1235

    def test_none_passes_through(self) -> None:
        assert safe_round(None) is None

    @pytest.mark.parametrize("bad", [float("nan"), float("inf"), float("-inf")])
    def test_non_finite_becomes_none(self, bad: float) -> None:
        # Gate metrics must never export NaN/inf — autoRetrain compares them numerically.
        assert safe_round(bad) is None

    def test_non_numeric_becomes_none(self) -> None:
        assert safe_round("not a number") is None  # type: ignore[arg-type]


class TestCalibrationSummary:
    def test_perfect_calibration_has_zero_ece(self) -> None:
        # Predictions equal to observed frequencies in every bin => ECE 0.
        y_prob = np.array([0.05] * 100 + [0.95] * 100)
        y_true = np.array([0] * 95 + [1] * 5 + [0] * 5 + [1] * 95)
        out = calibration_summary(y_true, y_prob, bins=10)
        assert out["ece"] == pytest.approx(0.0, abs=1e-9)
        assert out["mce"] == pytest.approx(0.0, abs=1e-9)

    def test_worst_case_calibration_saturates(self) -> None:
        # Confident and always wrong => ECE and MCE approach 1.
        y_prob = np.full(50, 0.99)
        y_true = np.zeros(50, dtype=int)
        out = calibration_summary(y_true, y_prob)
        assert out["ece"] == pytest.approx(0.99, abs=1e-6)
        assert out["mce"] == pytest.approx(0.99, abs=1e-6)

    def test_ece_never_exceeds_mce(self, rng: np.random.Generator) -> None:
        # ECE is a coverage-weighted mean of per-bin gaps; MCE is their max.
        y_prob = rng.uniform(size=500)
        y_true = (rng.uniform(size=500) < y_prob).astype(int)
        out = calibration_summary(y_true, y_prob)
        assert out["ece"] <= out["mce"] + 1e-12

    def test_bin_edges_cover_unit_interval_without_gaps(self) -> None:
        out = calibration_summary(np.array([0, 1]), np.array([0.1, 0.9]), bins=10)
        bins = out["bins"]
        assert len(bins) == 10
        assert bins[0]["min_prob"] == 0.0
        assert bins[-1]["max_prob"] == 1.0
        for lo, hi in zip(bins, bins[1:]):
            assert lo["max_prob"] == hi["min_prob"]

    def test_probability_of_one_lands_in_last_bin(self) -> None:
        # The top bin is closed on the right; p=1.0 must not fall through.
        out = calibration_summary(np.array([1, 1]), np.array([1.0, 1.0]), bins=10)
        assert out["bins"][-1]["count"] == 2

    def test_nan_probabilities_are_dropped_not_silently_binned(self) -> None:
        y_prob = np.array([0.9, np.nan, 0.9])
        y_true = np.array([1, 0, 1])
        out = calibration_summary(y_true, y_prob)
        assert sum(b["count"] for b in out["bins"]) == 2


class TestConfidenceBucketSummary:
    def test_buckets_partition_every_sample(self, rng: np.random.Generator) -> None:
        y_prob = rng.uniform(size=300)
        y_true = (rng.uniform(size=300) < 0.5).astype(int)
        rows = confidence_bucket_summary(y_true, y_prob)
        assert sum(r["count"] for r in rows) == 300

    def test_accuracy_is_reported_per_bucket(self) -> None:
        # All predictions confident and correct => accuracy 1.0 wherever counted.
        y_prob = np.full(40, 0.95)
        y_true = np.ones(40, dtype=int)
        rows = [r for r in confidence_bucket_summary(y_true, y_prob) if r["count"]]
        assert rows and all(r["accuracy"] == pytest.approx(1.0) for r in rows)

    def test_nan_probabilities_are_dropped(self) -> None:
        y_prob = np.array([0.95, np.nan, 0.95])
        y_true = np.array([1, 1, 1])
        rows = confidence_bucket_summary(y_true, y_prob)
        assert sum(r["count"] for r in rows) == 2
