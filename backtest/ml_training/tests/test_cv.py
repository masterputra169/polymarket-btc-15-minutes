"""Unit tests for mltrain.cv — embargoed walk-forward cross-validation.

The embargo is the property that keeps the CV score Optuna maximizes honest:
validation rows whose feature lookbacks overlap the training tail must be
dropped. These tests assert that structurally, not just that the code runs.
"""

from __future__ import annotations

import numpy as np
import pytest

from mltrain.cv import DEFAULT_N_CV_FOLDS, walk_forward_cv

pytestmark = pytest.mark.integration

FAST_CFG = {"max_depth": 3, "learning_rate": 0.3, "subsample": 1.0, "colsample_bytree": 1.0}
FAST_KW = dict(seed=42, num_boost_round=20, early_stopping=5)


def _run(X, y, cols, embargo, n_folds=DEFAULT_N_CV_FOLDS):
    return walk_forward_cv(X, y, FAST_CFG, n_folds=n_folds, return_preds=True,
                           feature_cols=cols, embargo=embargo, **FAST_KW)


class TestEmbargo:
    def test_embargoed_rows_are_excluded_from_oof(self, separable_dataset) -> None:
        X, y, cols = separable_dataset
        embargo = 20
        *_, oof_idx = _run(X, y, cols, embargo)

        # Reproduce the fold arithmetic and assert no OOF row falls inside a
        # fold's embargo window [tr_end, tr_end + embargo).
        fold_size = len(X) // (DEFAULT_N_CV_FOLDS + 2)
        forbidden: set[int] = set()
        for fold in range(DEFAULT_N_CV_FOLDS):
            tr_end = fold_size * (fold + 2)
            forbidden.update(range(tr_end, tr_end + embargo))
        assert forbidden, "test would be vacuous with an empty embargo window"
        assert not (set(oof_idx.tolist()) & forbidden)

    def test_larger_embargo_yields_fewer_oof_rows(self, separable_dataset) -> None:
        X, y, cols = separable_dataset
        *_, idx_none = _run(X, y, cols, 0)
        *_, idx_big = _run(X, y, cols, 30)
        assert len(idx_big) < len(idx_none)

    def test_zero_embargo_keeps_folds_contiguous(self, separable_dataset) -> None:
        X, y, cols = separable_dataset
        *_, idx = _run(X, y, cols, 0)
        # With no embargo the union of validation slices has no internal holes.
        assert np.array_equal(np.unique(idx), np.arange(idx.min(), idx.max() + 1))


class TestTemporalOrdering:
    def test_validation_rows_always_follow_training_rows(self, separable_dataset) -> None:
        # No OOF prediction may come from the first fold's training block —
        # that would mean the model predicted rows it had trained on.
        X, y, cols = separable_dataset
        *_, oof_idx = _run(X, y, cols, 8)
        fold_size = len(X) // (DEFAULT_N_CV_FOLDS + 2)
        first_train_end = fold_size * 2
        assert oof_idx.min() >= first_train_end


class TestReturnShapes:
    def test_oof_arrays_are_row_aligned(self, separable_dataset) -> None:
        X, y, cols = separable_dataset
        _, _, preds, margins, labels, idx = _run(X, y, cols, 8)
        assert len(preds) == len(margins) == len(labels) == len(idx)

    def test_oof_labels_match_source_rows(self, separable_dataset) -> None:
        # Guards the index bookkeeping the ensemble-weight sweep relies on.
        X, y, cols = separable_dataset
        _, _, _, _, labels, idx = _run(X, y, cols, 8)
        assert np.array_equal(labels.astype(int), y[idx].astype(int))

    def test_margins_and_probabilities_agree(self, separable_dataset) -> None:
        # Platt calibration is fitted on margins; they must be the logits of preds.
        X, y, cols = separable_dataset
        _, _, preds, margins, _, _ = _run(X, y, cols, 8)
        assert np.allclose(preds, 1.0 / (1.0 + np.exp(-margins)), atol=1e-5)

    def test_importances_returned_per_fold(self, separable_dataset) -> None:
        X, y, cols = separable_dataset
        out = walk_forward_cv(X, y, FAST_CFG, return_importances=True,
                              feature_cols=cols, embargo=8, **FAST_KW)
        _, _, fold_importances = out
        assert len(fold_importances) == DEFAULT_N_CV_FOLDS
        assert all(isinstance(d, dict) for d in fold_importances)

    def test_learns_signal_above_chance(self, separable_dataset) -> None:
        # Sanity: the harness must be able to detect real signal, else the
        # embargo tests above would pass trivially on a broken CV.
        X, y, cols = separable_dataset
        auc, acc = walk_forward_cv(X, y, FAST_CFG, feature_cols=cols, embargo=8, **FAST_KW)
        assert auc > 0.7 and acc > 0.6


class TestDegenerateInputs:
    def test_folds_too_small_for_embargo_are_skipped(self, separable_dataset) -> None:
        # An embargo wider than a fold must skip folds, not crash or emit rows.
        X, y, cols = separable_dataset
        auc, acc, preds, _, _, idx = _run(X, y, cols[:], 10_000)
        assert len(preds) == 0 and len(idx) == 0
        assert auc == 0 and acc == 0
