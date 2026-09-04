"""CSV loading and the leakage-checked temporal split.

Both halves serve one guarantee: no row that trains the model may also score
it. Loading asserts the CSV is slug-unique and chronological BEFORE any split
arithmetic runs — a duplicate slug means the same 15-min market can land on
both sides of the boundary, and a non-monotonic timestamp means `X[:split]` is
not actually "the past". The split then embargoes rows after every temporal
boundary (test and holdout alike), because their feature lookbacks still
overlap the training window and would inflate the metrics the deploy gates read.

Pure logic: pandas/numpy in, frozen dataclasses out. The only side effect is
the injected `log` callable, which the trainer wires to `print` so stdout keeps
its exact shape.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass

import numpy as np
import pandas as pd

# Drop metadata columns (not features, just row identifiers from data generation)
DEFAULT_METADATA_COLS: tuple[str, ...] = ("slug_timestamp",)


@dataclass(frozen=True)
class TrainingData:
    """The raw feature matrix and labels, before feature engineering.

    `X_orig` and `feature_cols_orig` are positionally aligned; every downstream
    consumer indexes them through the name->index map it builds from
    `feature_cols_orig`, so appending engineered columns later cannot shift a
    base feature out from under an index.
    """

    X_orig: np.ndarray
    y: np.ndarray
    feature_cols_orig: list[str]
    n_rows: int
    n_up: int
    n_down: int

    @property
    def n_base(self) -> int:
        """Number of base (pre-engineering) features."""
        return len(self.feature_cols_orig)

    @property
    def scale_pos_weight(self) -> float:
        """XGBoost `scale_pos_weight` for this label balance (DOWN / UP)."""
        return self.n_down / max(self.n_up, 1)


@dataclass(frozen=True)
class TemporalSplit:
    """Chronological train/test split with an OOS holdout carved off the tail.

    `X_train`/`y_train` are the TUNE subset whenever a holdout was carved out:
    Optuna, walk-forward CV and (under --strict-holdout) the final model see
    only these rows. `X_train_full`/`y_train_full` keep the pre-carve reference,
    used for the exported normaliser and for the legacy --no-strict-holdout
    path. `X_holdout`/`y_holdout` are None when --holdout-frac is 0.
    """

    X_train: np.ndarray
    y_train: np.ndarray
    X_test: np.ndarray
    y_test: np.ndarray
    X_train_full: np.ndarray
    y_train_full: np.ndarray
    X_holdout: np.ndarray | None
    y_holdout: np.ndarray | None
    holdout_start_idx: int | None


def assert_chronological_unique_slugs(
    df: pd.DataFrame, *, log: Callable[[str], None] = print
) -> None:
    """Reject (or warn about) row orderings that would leak across the split.

    Duplicate slug_timestamps are fatal — the same market outcome appearing
    twice puts one copy in train and one in test, so the model is scored on a
    label it memorised. Non-monotonic timestamps only warn: the split is then
    merely *probably* dishonest, and regenerating the data is the real fix.
    """
    # Audit fix (May 2026): assert chronological + unique slug ordering BEFORE split.
    # Catches data-generation bugs that would silently leak labels across train/test.
    if "slug_timestamp" in df.columns:
        slug_ts_series = pd.to_numeric(df["slug_timestamp"], errors="coerce")
        real_mask = slug_ts_series.notna()
        n_real = int(real_mask.sum())
        if n_real > 0:
            real_ts = slug_ts_series[real_mask].values
            # 1. Uniqueness: per-slug dedup in generateTrainingData should guarantee this
            dup_count = len(real_ts) - len(set(real_ts.tolist()))
            if dup_count > 0:
                raise SystemExit(
                    f"[FATAL] {dup_count} duplicate slug_timestamps detected — "
                    f"group-leakage risk across train/test split. Regenerate training data."
                )
            # 2. Monotonic non-decreasing: trainXGBoost X[:split] is honest only if so
            if not np.all(np.diff(real_ts) >= 0):
                n_inversions = int((np.diff(real_ts) < 0).sum())
                log(
                    f"   [WARN] slug_timestamps NOT monotonic ({n_inversions} inversions) — "
                    f"temporal split may leak. Recommend regenerate with chronological sort."
                )
            else:
                log(f"   [OK] slug_timestamps monotonic ({n_real:,} real-labeled rows)")


def load_training_data(
    path: str,
    *,
    metadata_cols: Sequence[str] = DEFAULT_METADATA_COLS,
    zero_features: Sequence[str] = (),
    log: Callable[[str], None] = print,
) -> TrainingData:
    """Read the training CSV, drop metadata columns, apply --zero-features.

    Args:
        path: training_data.csv produced by generateTrainingData.mts.
        metadata_cols: row-identifier columns that must never become features.
        zero_features: --zero-features names, blanked in place. Ablation keeps
            the column (and therefore the browser feature contract) while
            removing its information, rather than dropping it and shifting
            every later index.
        log: stdout sink; the trainer passes `print`.
    """
    df = pd.read_csv(path)
    assert_chronological_unique_slugs(df, log=log)

    feature_cols_orig = [c for c in df.columns if c != "label" and c not in metadata_cols]
    X_orig = df[feature_cols_orig].values.astype(np.float32)
    y = df["label"].values.astype(np.int32)
    X_orig = np.nan_to_num(X_orig, nan=0.0, posinf=0.0, neginf=0.0)

    # Apply --zero-features: zero out specified columns
    if zero_features:
        fi_lookup = {name: i for i, name in enumerate(feature_cols_orig)}
        for zf in zero_features:
            if zf in fi_lookup:
                X_orig[:, fi_lookup[zf]] = 0.0
                log(f"   Zeroed feature: {zf} (idx {fi_lookup[zf]})")
            else:
                log(f"   WARNING: --zero-features '{zf}' not found in CSV columns")

    up = int(y.sum())
    return TrainingData(
        X_orig=X_orig,
        y=y,
        feature_cols_orig=feature_cols_orig,
        n_rows=len(df),
        n_up=up,
        n_down=len(y) - up,
    )


def temporal_split(
    X: np.ndarray,
    y: np.ndarray,
    *,
    test_size: float,
    holdout_frac: float,
    embargo: int,
    log: Callable[[str], None] = print,
) -> TemporalSplit:
    """Split chronologically into train / (tune, holdout) / test with an embargo.

    Args:
        test_size: tail fraction reserved for the test set.
        holdout_frac: fraction of the TRAIN block reserved as strictly OOS
            holdout (audit fix C3). 0 disables the carve-out.
        embargo: rows dropped immediately after each boundary (ML4T embargo).
    """
    split = int(len(X) * (1 - test_size))
    # Embargo: drop the first `embargo` test rows — their feature lookbacks overlap
    # the training window, so keeping them inflates test metrics.
    X_train, X_test = X[:split], X[split + embargo :]
    y_train, y_test = y[:split], y[split + embargo :]
    log(f"   Train: {len(X_train):,} | Test: {len(X_test):,} (embargo {embargo} rows)")

    # OOS holdout: reserve final portion of training data for true out-of-sample evaluation
    # This data is NOT seen by Optuna or walk-forward CV
    X_holdout, y_holdout = None, None
    holdout_start_idx = None
    if holdout_frac > 0:
        holdout_boundary = int(len(X_train) * (1 - holdout_frac))
        holdout_start_idx = holdout_boundary + embargo
        X_holdout = X_train[holdout_boundary + embargo :]
        y_holdout = y_train[holdout_boundary + embargo :]
        X_tune = X_train[:holdout_boundary]
        y_tune = y_train[:holdout_boundary]
        log(f"   OOS HOLDOUT: {len(X_holdout):,} samples reserved (not used for tuning)")
        log(f"   Tune set: {len(X_tune):,} | Holdout: {len(X_holdout):,}")
        # Swap: Optuna and CV will use X_tune/y_tune instead of full X_train/y_train
        X_train_full, y_train_full = (
            X_train,
            y_train,
        )  # keep reference to full train for final model
        X_train, y_train = X_tune, y_tune
    else:
        X_train_full, y_train_full = X_train, y_train

    return TemporalSplit(
        X_train=X_train,
        y_train=y_train,
        X_test=X_test,
        y_test=y_test,
        X_train_full=X_train_full,
        y_train_full=y_train_full,
        X_holdout=X_holdout,
        y_holdout=y_holdout,
        holdout_start_idx=holdout_start_idx,
    )
