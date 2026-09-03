"""Unit tests for mltrain.sweeps — the selection procedures that pick the
thresholds, per-phase entry rules and ensemble weights the live bot trades on.

These run on out-of-fold CV predictions rather than the strict holdout
(multiple-testing fix, ML4T ch16). Two properties matter most and are asserted
directly: a degenerate input must fall back to the documented default instead of
inventing a threshold, and the OOF alignment check must refuse to pair up rows
that do not correspond to the same samples.
"""

from __future__ import annotations

import numpy as np
import pytest

from mltrain.sweeps import (
    PHASE_BRACKETS,
    align_oof_predictions,
    select_ensemble_weights,
    select_phase_thresholds,
    select_threshold,
)

pytestmark = pytest.mark.unit


def _confident(n: int, correct: bool, rng: np.random.Generator) -> tuple[np.ndarray, ...]:
    """n rows of high-confidence predictions that are all right (or all wrong)."""
    probs = rng.uniform(0.9, 0.99, size=n)
    labels = np.ones(n, dtype=int) if correct else np.zeros(n, dtype=int)
    preds = np.ones(n, dtype=int)
    return probs, labels, preds


class TestSelectThreshold:
    def test_picks_a_threshold_within_the_grid(self, rng: np.random.Generator) -> None:
        probs, labels, preds = _confident(400, True, rng)
        choice = select_threshold(probs, labels, preds)
        assert 0.55 <= choice.threshold <= 0.85
        assert choice.score > 0

    def test_falls_back_to_default_when_no_candidate_qualifies(self, rng: np.random.Generator) -> None:
        # Fewer rows than min_high_conf => nothing may be selected.
        probs, labels, preds = _confident(10, True, rng)
        choice = select_threshold(probs, labels, preds, min_high_conf=50)
        assert choice.threshold == pytest.approx(0.60)
        assert choice.score == 0

    def test_respects_a_custom_default(self, rng: np.random.Generator) -> None:
        probs, labels, preds = _confident(5, True, rng)
        choice = select_threshold(probs, labels, preds, default_threshold=0.71)
        assert choice.threshold == pytest.approx(0.71)

    def test_score_rewards_accuracy_over_coverage(self, rng: np.random.Generator) -> None:
        # Same coverage, opposite accuracy: the accurate set must score higher.
        good = select_threshold(*_confident(300, True, rng))
        bad = select_threshold(*_confident(300, False, rng))
        assert good.score > bad.score

    def test_uncertain_predictions_select_nothing(self) -> None:
        # Probabilities at 0.5 fall inside every candidate's exclusion band.
        n = 400
        probs = np.full(n, 0.5)
        labels = np.ones(n, dtype=int)
        choice = select_threshold(probs, labels, labels)
        assert choice.threshold == pytest.approx(0.60)


class TestSelectPhaseThresholds:
    def _phase_inputs(self, rng: np.random.Generator, n: int = 1200):
        minutes = rng.uniform(0.0, 15.0, size=n) / 15.0  # minutes_left_norm
        market = rng.uniform(0.2, 0.8, size=n)
        probs = np.clip(market + rng.normal(0, 0.15, size=n), 0.01, 0.99)
        labels = (rng.uniform(size=n) < probs).astype(int)
        return probs, labels, minutes, market

    def test_returns_one_result_per_bracket_in_order(self, rng: np.random.Generator) -> None:
        results = select_phase_thresholds(*self._phase_inputs(rng))
        assert [r.phase for r in results] == [b[0] for b in PHASE_BRACKETS]

    def test_selected_values_stay_inside_the_grids(self, rng: np.random.Generator) -> None:
        for r in select_phase_thresholds(*self._phase_inputs(rng)):
            if r.selected:
                assert 0.02 <= r.min_edge <= 0.2
                assert 0.52 <= r.min_prob <= 0.65

    def test_sparse_phase_is_not_selected_and_keeps_defaults(self, rng: np.random.Generator) -> None:
        # Only EARLY rows present => other phases must report unselected defaults
        # rather than fitting an entry rule to a handful of samples.
        probs, labels, minutes, market = self._phase_inputs(rng, n=400)
        minutes = np.full_like(minutes, 12.0 / 15.0)
        results = {r.phase: r for r in select_phase_thresholds(probs, labels, minutes, market)}
        assert results["LATE"].selected is False
        assert results["LATE"].min_edge == pytest.approx(0.06)
        assert results["LATE"].min_prob == pytest.approx(0.54)

    def test_sample_counts_sum_to_input_rows(self, rng: np.random.Generator) -> None:
        # Brackets must partition the timeline — no row counted twice or dropped.
        probs, labels, minutes, market = self._phase_inputs(rng)
        results = select_phase_thresholds(probs, labels, minutes, market)
        assert sum(r.n_samples for r in results) == len(probs)


class TestAlignOofPredictions:
    def test_identical_indices_pass_through_untouched(self, rng: np.random.Generator) -> None:
        idx = np.arange(500)
        a, b = rng.uniform(size=500), rng.uniform(size=500)
        labels = (rng.uniform(size=500) < 0.5).astype(int)
        out = align_oof_predictions(a, b, labels, idx, idx)
        assert out.identical is True
        assert out.n_common == 500
        assert np.array_equal(out.xgb_probs, a)

    def test_mismatched_indices_are_intersected(self, rng: np.random.Generator) -> None:
        # The two CVs disagree on which rows are OOF: only shared rows may be
        # compared, otherwise the weight sweep would pair unrelated samples.
        xgb_idx = np.arange(0, 400)
        lgb_idx = np.arange(100, 500)
        a = rng.uniform(size=len(xgb_idx))
        b = rng.uniform(size=len(lgb_idx))
        labels = (rng.uniform(size=len(xgb_idx)) < 0.5).astype(int)
        out = align_oof_predictions(a, b, labels, xgb_idx, lgb_idx)
        assert out.identical is False
        assert out.n_common == 300
        assert len(out.xgb_probs) == len(out.lgb_probs) == len(out.labels) == 300

    def test_alignment_maps_rows_to_the_same_sample(self) -> None:
        # Row k of both aligned arrays must come from the same source index;
        # here each value encodes its source index so equality proves the map.
        xgb_idx = np.array([0, 1, 2, 3])
        lgb_idx = np.array([2, 3, 4, 5])
        a = np.array([10.0, 11.0, 12.0, 13.0])
        b = np.array([12.0, 13.0, 14.0, 15.0])
        labels = np.array([0, 1, 0, 1])
        out = align_oof_predictions(a, b, labels, xgb_idx, lgb_idx, min_common=1)
        assert np.array_equal(out.xgb_probs, out.lgb_probs)

    def test_too_little_overlap_is_reported(self, rng: np.random.Generator) -> None:
        xgb_idx, lgb_idx = np.arange(0, 100), np.arange(95, 195)
        a, b = rng.uniform(size=100), rng.uniform(size=100)
        labels = (rng.uniform(size=100) < 0.5).astype(int)
        out = align_oof_predictions(a, b, labels, xgb_idx, lgb_idx, min_common=100)
        assert out.n_common < 100


class TestSelectEnsembleWeights:
    def test_favours_the_stronger_model(self, rng: np.random.Generator) -> None:
        n = 800
        labels = (rng.uniform(size=n) < 0.5).astype(int)
        strong = np.clip(labels + rng.normal(0, 0.15, size=n), 0.01, 0.99)  # informative
        noise = rng.uniform(size=n)                                         # useless
        assert select_ensemble_weights(strong, noise, labels).weight_xgb > 0.6
        assert select_ensemble_weights(noise, strong, labels).weight_xgb < 0.4

    def test_weight_stays_inside_the_grid(self, rng: np.random.Generator) -> None:
        n = 300
        labels = (rng.uniform(size=n) < 0.5).astype(int)
        a = np.clip(labels + rng.normal(0, 0.3, size=n), 0.01, 0.99)
        b = np.clip(labels + rng.normal(0, 0.3, size=n), 0.01, 0.99)
        choice = select_ensemble_weights(a, b, labels)
        assert 0.25 <= choice.weight_xgb <= 0.8

    def test_single_class_labels_fall_back_to_default(self) -> None:
        # AUC is undefined with one class — must not crash or emit a bogus weight.
        n = 200
        labels = np.ones(n, dtype=int)
        a = np.full(n, 0.7)
        b = np.full(n, 0.6)
        choice = select_ensemble_weights(a, b, labels, default_weight=0.5)
        assert choice.weight_xgb == pytest.approx(0.5)
