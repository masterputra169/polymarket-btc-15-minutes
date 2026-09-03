"""Regime accounting and the three weighting schemes the trainer can apply.

Two are per-SAMPLE and both are optional:
  * recency — an exponential half-life ramp, so a model retrained today leans
    on the regime it will actually trade rather than on 500-day-old candles;
  * session — up-weights the US / EU-US-overlap hours where live ML confidence
    lags, using the session flags already present in the feature vector. No new
    features, so the browser feature contract is untouched.

The third is per-FEATURE: `build_feature_weights` zeroes a column out of every
split BEFORE Optuna runs, so the search can never buy CV accuracy from a
feature that is constant at inference time.

Session weights are renormalised to mean 1.0, keeping the effective sample
count (and therefore every regularisation constant tuned against it) put.
Pure logic with an injected `log` callable; the trainer owns stdout.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass

import numpy as np

# Regime name -> the one-hot base feature that marks it. Order fixes the order
# of the trainer's per-regime report lines.
REGIME_FEATURES: tuple[tuple[str, str], ...] = (
    ('trending', 'regime_trending'),
    ('mean_rev', 'regime_mean_reverting'),
    ('moderate', 'regime_moderate'),
)


@dataclass(frozen=True)
class SessionWeighting:
    """Session-multiplied, mean-normalised weights plus the reported counts.

    `mean_before_norm` is the pre-normalisation mean the trainer prints; it is
    the factor every weight was divided by, so a value far from 1.0 means the
    session mix shifted the effective sample count before renormalisation.
    """
    weights: np.ndarray
    n_us: int
    n_overlap: int
    n_asia: int
    mean_before_norm: float


def count_regimes(X_orig: np.ndarray, fi: dict[str, int]) -> dict[str, int]:
    """Count rows flagged for each regime, skipping regimes absent from the CSV.

    Args:
        X_orig: base (pre-engineering) feature matrix.
        fi: base-feature name -> column index map.
    """
    regime_idx = {name: fi.get(feat) for name, feat in REGIME_FEATURES}

    regime_counts = {}
    for regime_name, feat_idx in regime_idx.items():
        if feat_idx is None:
            continue
        mask = X_orig[:, feat_idx] > 0.5
        regime_counts[regime_name] = int(mask.sum())
    return regime_counts


def recency_weights(n_train: int, *, days: int, halflife: int) -> np.ndarray:
    """Exponential recency ramp over `n_train` chronological rows.

    Weights run from 0.5 (oldest) to 1.0 (newest): the 0.5 floor keeps old rows
    contributing rather than deleting them, which would shrink the effective
    sample size just as much as a shorter training window would.
    """
    # Task H: Recency-weighted training — recent data matters more
    # Rows are chronological; estimate days_ago from row position
    days_ago = np.linspace(days, 0, n_train)  # first row = oldest, last = newest
    recency_weight = 0.5 + 0.5 * np.exp(-days_ago / halflife)
    return recency_weight.astype(np.float32)


def apply_session_weights(w_train: np.ndarray | None, X_train: np.ndarray,
                          fi: dict[str, int]) -> SessionWeighting:
    """Multiply per-session factors into `w_train`, then renormalise to mean 1.0.

    `w_train` is copied, never mutated: the caller's recency array stays intact
    for comparison. Missing session features are skipped (count 0), so a CSV
    without them degrades to a pure renormalisation.
    """
    # v10: Session-based sample weighting — boost underrepresented US/Overlap patterns.
    # US and EU/US Overlap sessions have lower ML confidence in production because the
    # model sees fewer high-quality examples from these volatile hours. Up-weighting
    # forces the model to learn US-specific patterns from existing session features
    # (session_us, session_overlap, hour_sin/cos at indices 22, 23, 42, 43 in X_orig).
    # No new features needed — works with existing 74-feature vector.
    if w_train is None:
        w_train = np.ones(len(X_train), dtype=np.float32)
    else:
        w_train = w_train.copy()
    # Feature indices from fi lookup (X_orig columns = same indices in X since engineered appended)
    sess_us_idx  = fi.get('session_us')       # index 22
    sess_ov_idx  = fi.get('session_overlap')  # index 23
    sess_asia_idx = fi.get('session_asia')    # index 20
    n_us = n_ov = n_asia = 0
    if sess_us_idx is not None:
        us_mask = X_train[:, sess_us_idx] > 0.5
        w_train[us_mask] *= 1.5
        n_us = int(us_mask.sum())
    if sess_ov_idx is not None:
        ov_mask = X_train[:, sess_ov_idx] > 0.5
        w_train[ov_mask] *= 1.3
        n_ov = int(ov_mask.sum())
    if sess_asia_idx is not None:
        asia_mask = X_train[:, sess_asia_idx] > 0.5
        w_train[asia_mask] *= 0.8
        n_asia = int(asia_mask.sum())
    # Normalize so mean weight stays ~1.0 (preserves effective sample count)
    w_mean = w_train.mean()
    w_train = w_train / w_mean
    return SessionWeighting(
        weights=w_train,
        n_us=n_us,
        n_overlap=n_ov,
        n_asia=n_asia,
        mean_before_norm=w_mean,
    )


def build_sample_weights(X_train: np.ndarray, fi: dict[str, int],
                         *,
                         use_recency: bool,
                         days: int,
                         halflife: int,
                         use_session: bool,
                         log: Callable[[str], None] = print) -> np.ndarray | None:
    """Compose the enabled weighting schemes, or None when both are off.

    None (rather than an array of ones) is deliberate: XGBoost/LightGBM skip
    the weight path entirely, which is what the uniform-weight baseline the
    v7 experiments settled on actually measured.
    """
    w_train = None

    if use_recency:
        w_train = recency_weights(len(X_train), days=days, halflife=halflife)
        log(f"   Recency weighting: half-life={halflife}d")
        log(f"     Oldest sample weight: {w_train[0]:.3f} | Newest: {w_train[-1]:.3f} | Mean: {w_train.mean():.3f}")

    if use_session:
        sw = apply_session_weights(w_train, X_train, fi)
        w_train = sw.weights
        log(f"   Session weighting applied:")
        log(f"     US ×1.5       : {sw.n_us:,} samples")
        log(f"     Overlap ×1.3  : {sw.n_overlap:,} samples")
        log(f"     Asia ×0.8     : {sw.n_asia:,} samples")
        log(f"     Normalized (mean={sw.mean_before_norm:.3f} -> 1.000)")

    return w_train


def build_feature_weights(feature_cols: list[str],
                          exclude_feature_names: Sequence[str],
                          *,
                          log: Callable[[str], None] = print) -> np.ndarray:
    """Per-feature split weights: 0.0 excludes a column from every tree.

    Note these only take effect when `colsample_bytree < 1.0`; every caller
    that attaches them lowers colsample to 0.95 if it is at the default.
    """
    # Build pre-exclude feature weights (Task B: zero out consistently pruned features BEFORE Optuna)
    pre_exclude_fw = np.ones(len(feature_cols), dtype=np.float32)
    if exclude_feature_names:
        fi_all = {name: i for i, name in enumerate(feature_cols)}
        excluded_count = 0
        for ef in exclude_feature_names:
            if ef in fi_all:
                pre_exclude_fw[fi_all[ef]] = 0.0
                excluded_count += 1
            else:
                log(f"   WARNING: --exclude-features '{ef}' not found in feature list")
        log(f"   Pre-excluded {excluded_count} features via feature_weights=0")
    return pre_exclude_fw
