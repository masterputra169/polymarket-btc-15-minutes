"""Metric, calibration-quality and rounding helpers.

Pure functions: no global state, no I/O. Used by the trainer to build the
exported `metrics` block (Brier, ECE/MCE, confidence buckets) that the
deploy gates in bot/src/autoRetrain.ts read by name.
"""

from __future__ import annotations

import numpy as np
from sklearn.metrics import accuracy_score

def safe_round(value: float | int | None, digits: int = 4) -> float | None:
    if value is None:
        return None
    try:
        v = float(value)
    except (TypeError, ValueError):
        return None
    if not np.isfinite(v):
        return None
    return round(v, digits)

def calibration_summary(y_true: np.ndarray, y_prob: np.ndarray, bins: int = 10) -> dict[str, object]:
    """Expected calibration error for probability-of-UP predictions."""
    y_true = np.asarray(y_true)
    y_prob = np.asarray(y_prob)
    nan_mask = np.isnan(y_prob)
    if np.any(nan_mask):
        print(f"   [WARN] calibration_summary: dropping {int(nan_mask.sum())} NaN probabilities")
        y_true = y_true[~nan_mask]
        y_prob = y_prob[~nan_mask]
    edges = np.linspace(0.0, 1.0, bins + 1)
    total = max(1, len(y_prob))
    rows = []
    ece = 0.0
    mce = 0.0

    for i in range(bins):
        lo = float(edges[i])
        hi = float(edges[i + 1])
        if i == bins - 1:
            mask = (y_prob >= lo) & (y_prob <= hi)
        else:
            mask = (y_prob >= lo) & (y_prob < hi)

        count = int(mask.sum())
        if count == 0:
            rows.append({
                'min_prob': round(lo, 2),
                'max_prob': round(hi, 2),
                'count': 0,
                'coverage_pct': 0.0,
                'avg_predicted': None,
                'observed_rate': None,
                'gap': None,
            })
            continue

        avg_pred = float(y_prob[mask].mean())
        observed = float(y_true[mask].mean())
        gap = abs(avg_pred - observed)
        ece += (count / total) * gap
        mce = max(mce, gap)
        rows.append({
            'min_prob': round(lo, 2),
            'max_prob': round(hi, 2),
            'count': count,
            'coverage_pct': round(count / total * 100, 2),
            'avg_predicted': round(avg_pred, 4),
            'observed_rate': round(observed, 4),
            'gap': round(gap, 4),
        })

    return {
        'ece': float(ece),
        'mce': float(mce),
        'bins': rows,
    }

def confidence_bucket_summary(y_true: np.ndarray, y_prob: np.ndarray) -> list[dict[str, object]]:
    """Accuracy broken down by prediction-confidence bucket.

    Confidence is max(p, 1-p) of the probability-of-UP prediction, bucketed
    into [0.50, 0.55), ..., [0.80, 0.90), [0.90, 1.00] (upper bucket inclusive).
    Returns one dict per bucket with: min_confidence, max_confidence, count,
    coverage_pct, and accuracy (None when the bucket is empty).
    """
    y_true = np.asarray(y_true)
    y_prob = np.asarray(y_prob)
    nan_mask = np.isnan(y_prob)
    if np.any(nan_mask):
        print(f"   [WARN] confidence_bucket_summary: dropping {int(nan_mask.sum())} NaN probabilities")
        y_true = y_true[~nan_mask]
        y_prob = y_prob[~nan_mask]
    y_pred = y_prob >= 0.5
    confidence = np.maximum(y_prob, 1 - y_prob)
    total = max(1, len(y_prob))
    buckets = [(0.50, 0.55), (0.55, 0.60), (0.60, 0.65), (0.65, 0.70),
               (0.70, 0.75), (0.75, 0.80), (0.80, 0.90), (0.90, 1.01)]
    rows = []

    for lo, hi in buckets:
        if hi >= 1.0:
            mask = (confidence >= lo) & (confidence <= 1.0)
        else:
            mask = (confidence >= lo) & (confidence < hi)
        count = int(mask.sum())
        acc = accuracy_score(y_true[mask], y_pred[mask]) if count > 0 else None
        rows.append({
            'min_confidence': round(lo, 2),
            'max_confidence': round(min(hi, 1.0), 2),
            'count': count,
            'coverage_pct': round(count / total * 100, 2),
            'accuracy': safe_round(acc),
        })

    return rows
