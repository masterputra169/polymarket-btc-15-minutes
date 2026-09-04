"""Assembling the inputs the P&L simulation runs on: split, calibration, per-row context.

Nothing here computes money, but every one of these four steps decides WHICH
rows the simulator sees and WHAT it thinks they cost — so an error here moves
the reported P&L without touching a single line of P&L arithmetic. The split
index chooses whether the backtest is honest out-of-sample or a re-read of the
tuning set; the Platt transform decides the probability space, and applying it
in the wrong space silently truncates the model's range (see
`apply_platt_calibration`); the market-price extraction decides what every edge
is measured against, and its fallbacks quietly change that definition; the
regime labels decide which bucket each trade is attributed to.

Pure lookups and transforms: matrices and index maps in, arrays out. No global
state, no I/O, no printing — backtestPnL.py owns all three.
"""

from __future__ import annotations

from collections.abc import Sequence

import numpy as np

# Regime name -> one-hot feature column, in priority order. The first column
# reading above 0.5 wins; rows matching none fall through to DEFAULT_REGIME.
DEFAULT_REGIME_COLUMNS: tuple[tuple[str, str], ...] = (
    ("trending", "regime_trending"),
    ("mean_reverting", "regime_mean_reverting"),
    ("moderate", "regime_moderate"),
)
DEFAULT_REGIME: str = "moderate"


def oos_split_index(n_rows: int, oos_start: float) -> int:
    """First test-set row index for an --oos-start fraction."""
    return int(n_rows * oos_start)


def apply_platt_calibration(raw_scores: np.ndarray, platt_a: float, platt_b: float) -> np.ndarray:
    """Squash scores through the fitted Platt transform: sigmoid(A*s + B).

    CALLER OWNS THE INPUT SPACE. The trainer fits A/B on RAW MARGINS and records
    that contract as `platt_on_logits` in norm_browser.json (mltrain/calibration.py,
    audit fix C4); passing booster probabilities instead applies a second sigmoid
    and compresses the whole output range into roughly [0.5, 0.73]. This function
    reproduces the script's arithmetic verbatim and does not inspect or enforce
    which space it was handed.

    Args:
        raw_scores: model output, in the space A and B were fitted on.
        platt_a / platt_b: fitted scale and shift (1.0 / 0.0 = identity fit).
    """
    return 1.0 / (1.0 + np.exp(-(platt_a * raw_scores + platt_b)))


def derive_regime_labels(
    X_orig: np.ndarray,
    feature_index: dict[str, int],
    start: int,
    *,
    regime_columns: Sequence[tuple[str, str]] = DEFAULT_REGIME_COLUMNS,
    default_regime: str = DEFAULT_REGIME,
) -> np.ndarray:
    """Recover a regime name per test row from the one-hot regime features.

    Args:
        X_orig: base (pre-engineering) feature matrix.
        feature_index: base feature name -> column index.
        start: first test-set row; labels are returned for X_orig[start:].
        regime_columns: (regime name, column name) pairs in priority order.
        default_regime: used when no column reads above 0.5, and for rows whose
            regime columns are missing from the CSV entirely.
    """
    resolved = [(name, feature_index.get(column)) for name, column in regime_columns]
    labels: list[str] = []
    for i in range(start, len(X_orig)):
        label = default_regime
        for name, idx in resolved:
            if idx is not None and X_orig[i, idx] > 0.5:
                label = name
                break
        labels.append(label)
    return np.array(labels)


def extract_market_prices(
    X_orig: np.ndarray,
    feature_index: dict[str, int],
    start: int,
    n_rows: int,
    *,
    primary: str = "market_yes_price",
    fallback: str = "rule_prob_up",
    default: float = 0.5,
) -> np.ndarray:
    """Entry-price series for the test rows, with two documented fallbacks.

    Prefers the real Polymarket UP-token price. Falls back to the rule engine's
    probability-of-UP (a probability, matching market-price semantics) and then
    to a flat coin-flip price, which makes every edge purely model-driven.

    Args:
        X_orig: base feature matrix.
        feature_index: base feature name -> column index.
        start: first test-set row.
        n_rows: length of the test set, used to size the flat fallback.
    """
    primary_idx = feature_index.get(primary)
    if primary_idx is not None:
        return X_orig[start:, primary_idx]
    fallback_idx = feature_index.get(fallback)
    if fallback_idx is not None:
        return X_orig[start:, fallback_idx]
    return np.full(n_rows, default)
