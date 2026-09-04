"""Unit tests for mltrain.data — CSV loading and the leakage-checked split.

The two properties that would actually cost money in production are asserted
directly: the loader must REFUSE data whose row ordering could leak a label
across the train/test boundary, and the split must honour the embargo at BOTH
boundaries (test and holdout) while never letting the holdout overlap the tune
set the model is fitted on.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from mltrain.data import (
    assert_chronological_unique_slugs,
    load_training_data,
    temporal_split,
)

pytestmark = pytest.mark.unit


def _frame(n: int = 40, *, slugs: list[int] | None = None) -> pd.DataFrame:
    """Minimal training CSV: two features, a label, and a slug_timestamp."""
    data = {
        "feat_a": np.arange(n, dtype=float),
        "feat_b": np.arange(n, dtype=float) * -1.0,
        "label": (np.arange(n) % 2).astype(int),
    }
    if slugs is not None:
        data["slug_timestamp"] = slugs
    return pd.DataFrame(data)


def _write(tmp_path, df: pd.DataFrame) -> str:
    path = tmp_path / "training_data.csv"
    df.to_csv(path, index=False)
    return str(path)


class TestLeakageAssertions:
    def test_duplicate_slug_timestamps_are_fatal(self) -> None:
        # The same market appearing twice can land one copy in train and one in
        # test — the model would be scored on a label it memorised.
        df = _frame(6, slugs=[1, 2, 3, 3, 4, 5])
        with pytest.raises(SystemExit, match="duplicate slug_timestamps"):
            assert_chronological_unique_slugs(df, log=lambda _: None)

    def test_non_chronological_rows_warn_but_do_not_abort(self) -> None:
        lines: list[str] = []
        df = _frame(6, slugs=[1, 2, 9, 3, 4, 5])
        assert_chronological_unique_slugs(df, log=lines.append)
        assert any("NOT monotonic" in line for line in lines)
        assert any("1 inversions" in line for line in lines)

    def test_monotonic_rows_report_ok(self) -> None:
        lines: list[str] = []
        assert_chronological_unique_slugs(_frame(6, slugs=[1, 2, 3, 4, 5, 6]), log=lines.append)
        assert any("[OK] slug_timestamps monotonic" in line for line in lines)

    def test_missing_slug_column_is_silently_allowed(self) -> None:
        lines: list[str] = []
        assert_chronological_unique_slugs(_frame(6), log=lines.append)
        assert lines == []

    def test_unparseable_slugs_are_excluded_from_the_check(self) -> None:
        # Synthetic rows carry non-numeric slugs; they must not trip either gate.
        lines: list[str] = []
        df = _frame(4, slugs=["x", "y", "z", "w"])
        assert_chronological_unique_slugs(df, log=lines.append)
        assert lines == []


class TestLoadTrainingData:
    def test_metadata_column_never_becomes_a_feature(self, tmp_path) -> None:
        data = load_training_data(
            _write(tmp_path, _frame(10, slugs=list(range(10)))), log=lambda _: None
        )
        assert data.feature_cols_orig == ["feat_a", "feat_b"]
        assert data.X_orig.shape == (10, 2)
        assert data.n_base == 2
        assert data.n_rows == 10

    def test_label_balance_and_scale_pos_weight(self, tmp_path) -> None:
        data = load_training_data(_write(tmp_path, _frame(10)), log=lambda _: None)
        assert data.n_up == 5
        assert data.n_down == 5
        assert data.scale_pos_weight == pytest.approx(1.0)

    def test_scale_pos_weight_survives_an_all_down_label_column(self, tmp_path) -> None:
        df = _frame(8)
        df["label"] = 0
        data = load_training_data(_write(tmp_path, df), log=lambda _: None)
        # max(up, 1) guard: no ZeroDivisionError, weight equals the row count.
        assert data.scale_pos_weight == pytest.approx(8.0)

    def test_non_finite_values_are_zeroed(self, tmp_path) -> None:
        df = _frame(6)
        df.loc[0, "feat_a"] = np.inf
        df.loc[1, "feat_b"] = np.nan
        data = load_training_data(_write(tmp_path, df), log=lambda _: None)
        assert np.isfinite(data.X_orig).all()
        assert data.X_orig[0, 0] == 0.0
        assert data.X_orig[1, 1] == 0.0

    def test_zero_features_blanks_the_column_without_dropping_it(self, tmp_path) -> None:
        lines: list[str] = []
        data = load_training_data(
            _write(tmp_path, _frame(10)), zero_features=["feat_a"], log=lines.append
        )
        # Shape (and therefore every downstream feature index) is preserved.
        assert data.feature_cols_orig == ["feat_a", "feat_b"]
        assert np.all(data.X_orig[:, 0] == 0.0)
        assert np.any(data.X_orig[:, 1] != 0.0)
        assert any("Zeroed feature: feat_a" in line for line in lines)

    def test_unknown_zero_feature_warns_instead_of_failing(self, tmp_path) -> None:
        lines: list[str] = []
        load_training_data(_write(tmp_path, _frame(10)), zero_features=["nope"], log=lines.append)
        assert any("--zero-features 'nope' not found" in line for line in lines)


class TestTemporalSplit:
    def _xy(self, n: int = 1000) -> tuple[np.ndarray, np.ndarray]:
        X = np.arange(n, dtype=np.float32).reshape(-1, 1)
        return X, (np.arange(n) % 2).astype(np.int32)

    def test_embargo_gap_at_the_test_boundary(self) -> None:
        X, y = self._xy()
        embargo = 16
        s = temporal_split(
            X, y, test_size=0.15, holdout_frac=0.0, embargo=embargo, log=lambda _: None
        )
        # X holds its own row index, so the gap is directly observable.
        last_train = int(s.X_train_full[-1, 0])
        first_test = int(s.X_test[0, 0])
        assert first_test - last_train == embargo + 1

    def test_embargo_gap_at_the_holdout_boundary(self) -> None:
        X, y = self._xy()
        embargo = 16
        s = temporal_split(
            X, y, test_size=0.15, holdout_frac=0.125, embargo=embargo, log=lambda _: None
        )
        last_tune = int(s.X_train[-1, 0])
        first_holdout = int(s.X_holdout[0, 0])
        assert first_holdout - last_tune == embargo + 1

    def test_holdout_never_overlaps_the_tune_set(self) -> None:
        X, y = self._xy()
        s = temporal_split(X, y, test_size=0.15, holdout_frac=0.125, embargo=16, log=lambda _: None)
        tune_rows = set(s.X_train[:, 0].tolist())
        holdout_rows = set(s.X_holdout[:, 0].tolist())
        assert tune_rows and holdout_rows
        assert not (tune_rows & holdout_rows)

    def test_holdout_never_overlaps_the_test_set(self) -> None:
        X, y = self._xy()
        s = temporal_split(X, y, test_size=0.15, holdout_frac=0.125, embargo=16, log=lambda _: None)
        assert not (set(s.X_holdout[:, 0].tolist()) & set(s.X_test[:, 0].tolist()))

    def test_holdout_start_idx_indexes_into_train_full(self) -> None:
        X, y = self._xy()
        s = temporal_split(X, y, test_size=0.15, holdout_frac=0.125, embargo=16, log=lambda _: None)
        # autoRetrain/backtests slice X_train_full with this index; it must land
        # exactly on the first holdout row.
        assert np.array_equal(s.X_train_full[s.holdout_start_idx :], s.X_holdout)
        assert np.array_equal(s.y_train_full[s.holdout_start_idx :], s.y_holdout)

    def test_features_and_labels_stay_row_aligned(self) -> None:
        X, y = self._xy()
        s = temporal_split(X, y, test_size=0.15, holdout_frac=0.125, embargo=16, log=lambda _: None)
        for Xs, ys in (
            (s.X_train, s.y_train),
            (s.X_test, s.y_test),
            (s.X_holdout, s.y_holdout),
            (s.X_train_full, s.y_train_full),
        ):
            assert len(Xs) == len(ys)
            assert np.array_equal(ys, (Xs[:, 0].astype(int) % 2))

    def test_disabled_holdout_leaves_train_untouched(self) -> None:
        X, y = self._xy()
        s = temporal_split(X, y, test_size=0.15, holdout_frac=0.0, embargo=16, log=lambda _: None)
        assert s.X_holdout is None
        assert s.y_holdout is None
        assert s.holdout_start_idx is None
        assert np.array_equal(s.X_train, s.X_train_full)

    def test_zero_embargo_makes_the_split_contiguous(self) -> None:
        X, y = self._xy()
        s = temporal_split(X, y, test_size=0.15, holdout_frac=0.125, embargo=0, log=lambda _: None)
        assert int(s.X_test[0, 0]) - int(s.X_train_full[-1, 0]) == 1
        assert int(s.X_holdout[0, 0]) - int(s.X_train[-1, 0]) == 1
        assert len(s.X_train) + len(s.X_holdout) == len(s.X_train_full)

    def test_reported_sizes_match_the_returned_arrays(self) -> None:
        X, y = self._xy()
        lines: list[str] = []
        s = temporal_split(X, y, test_size=0.15, holdout_frac=0.125, embargo=16, log=lines.append)
        assert f"Test: {len(s.X_test):,}" in lines[0]
        assert f"{len(s.X_holdout):,} samples reserved" in lines[1]
        assert f"Tune set: {len(s.X_train):,}" in lines[2]
