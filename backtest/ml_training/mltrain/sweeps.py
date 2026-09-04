"""The three SELECTION sweeps: threshold, per-phase edge grid, ensemble weights.

Every sweep here scores many candidates and keeps the argmax, so each one is a
multiple-comparisons procedure in the Lopez de Prado / ML4T ch16 sense: running
them on the strict OOS holdout would quietly optimize the very metrics the
deploy gates (autoRetrain.ts / mlQualityAudit.mts) treat as honest OOS. The
callers therefore feed these functions calibrated OUT-OF-FOLD CV predictions;
the holdout/test fallbacks exist only for degenerate CV (no OOF rows).

Pure functions: arrays and grid bounds in, frozen result objects out. No global
state and no printing — the trainer owns all stdout and all JSON assembly, so
the exported field names/values stay its concern alone.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

import numpy as np
from sklearn.metrics import accuracy_score, roc_auc_score

# Phase brackets (same as edge.js decide())
PHASE_BRACKETS: tuple[tuple[str, float, float], ...] = (
    ("EARLY", 10, 15.01),
    ("MID", 5, 10),
    ("LATE", 2, 5),
    ("VERY_LATE", 0, 2),
)


@dataclass(frozen=True)
class ThresholdChoice:
    """Result of the high-confidence threshold sweep."""

    threshold: float
    score: float


@dataclass(frozen=True)
class PhaseResult:
    """Per-phase outcome of the (minEdge, minProb) grid.

    `selected` is False when the phase had too few OOF samples to sweep; the
    caller then reports "using defaults" and omits the phase from the exported
    `phase_thresholds` map. min_edge/min_prob are the raw grid values (not yet
    rounded for export) so the caller controls the exported precision.
    """

    phase: str
    selected: bool
    n_samples: int
    min_edge: float
    min_prob: float
    n_entries: int
    accuracy: float


@dataclass(frozen=True)
class OofAlignment:
    """XGB/LGB out-of-fold rows lined up on their shared X_train row indices.

    `identical` records that both models' fold arithmetic produced exactly the
    same oof_idx (the common case); otherwise the arrays were re-aligned on the
    index intersection. When too few rows survive, all three arrays are None
    and the caller falls back to holdout/test weight selection.
    """

    xgb_probs: np.ndarray | None
    lgb_probs: np.ndarray | None
    labels: np.ndarray | None
    identical: bool
    n_xgb: int
    n_lgb: int
    n_common: int


@dataclass(frozen=True)
class WeightChoice:
    """Result of the XGB/LGB ensemble-weight sweep (weight is the XGB share)."""

    weight_xgb: float
    auc: float


def select_threshold(
    probs: np.ndarray,
    labels: np.ndarray,
    preds: np.ndarray,
    *,
    grid: tuple[float, float, float] = (0.55, 0.85, 0.005),
    min_high_conf: int = 50,
    default_threshold: float = 0.60,
) -> ThresholdChoice:
    """Scan ~60 candidate high-confidence thresholds and keep the best-scoring.

    MULTIPLE-TESTING FIX: this sweep tries ~60 candidate thresholds and keeps the
    best-scoring one. Running the sweep on the strict OOS holdout — the same set
    the deploy gates (autoRetrain.ts / mlQualityAudit.mts) treat as "honest OOS"
    — quietly optimizes the gate metrics themselves (Lopez de Prado / ML4T ch16
    selection bias under multiple comparisons). SELECTION therefore moved onto
    out-of-fold walk-forward-CV predictions; the holdout is now EVALUATION-only.
    Thresholds are applied to calibrated probabilities at inference, so the sweep
    runs on the FINAL Platt transform (identity A=1/B=0 when calibration was
    disabled) applied to the OOF margins — the same probability space inference
    sees. Holdout/test fallbacks remain only for degenerate CV (no OOF rows).

    Args:
        probs: calibrated probability-of-UP per row.
        labels: ground-truth 0/1 labels, aligned to `probs`.
        preds: hard 0/1 predictions, aligned to `probs`.
        grid: (start, stop, step) passed to np.arange for the threshold scan.
        min_high_conf: skip candidates selecting fewer than this many rows.
        default_threshold: returned when no candidate qualifies.

    Returns:
        ThresholdChoice with the argmax threshold and its accuracy*sqrt(coverage)
        score (0 when no candidate qualified).
    """
    best_threshold = default_threshold
    best_score = 0
    for thresh in np.arange(*grid):
        hmask = (probs < (1 - thresh)) | (probs > thresh)
        if hmask.sum() < min_high_conf:
            continue
        hacc = accuracy_score(labels[hmask], preds[hmask])
        hratio = hmask.sum() / len(labels)
        score = hacc * np.sqrt(hratio)
        if score > best_score:
            best_score = score
            best_threshold = thresh
    return ThresholdChoice(threshold=best_threshold, score=best_score)


def select_phase_thresholds(
    probs: np.ndarray,
    labels: np.ndarray,
    minutes_left: np.ndarray,
    market_price: np.ndarray,
    *,
    brackets: Sequence[tuple[str, float, float]] = PHASE_BRACKETS,
    edge_grid: tuple[float, float, float] = (0.02, 0.20, 0.005),
    prob_grid: tuple[float, float, float] = (0.52, 0.65, 0.005),
    min_phase_samples: int = 50,
    default_min_edge: float = 0.06,
    default_min_prob: float = 0.54,
) -> list[PhaseResult]:
    """Sweep optimal (minEdge, minProb) per market phase.

    MULTIPLE-TESTING FIX (Sep 2026): this grid scores ~36x26 ~= 900 (minEdge,
    minProb) combinations per phase and keeps the max — by far the heaviest
    selection procedure in the script. Selecting on the strict OOS holdout made
    the holdout no longer honest for the deploy-gate metrics (Lopez de Prado /
    ML4T ch16 multiple-testing problem). SELECTION moved to calibrated
    out-of-fold CV predictions; holdout stays EVALUATION-only.
    Metadata recovery: every OOF prediction corresponds to a specific X_train
    row (oof_idx, produced by the same fold arithmetic that cut the validation
    slices, embargo included), so minutes_left_norm and market_yes_price are
    read from those X_train rows — no bootstrap fallback needed. The caller does
    that lookup and passes the denormalized arrays in.

    Args:
        probs: calibrated OOF probability-of-UP (the Platt space inference uses).
        labels: ground-truth 0/1 labels, aligned to `probs`.
        minutes_left: minutes remaining per row (denormalized), aligned to `probs`.
        market_price: Polymarket YES price per row, aligned to `probs`.
        brackets: (phase name, exclusive-low, inclusive-high) minute brackets.
        edge_grid / prob_grid: (start, stop, step) np.arange bounds for the grid.
        min_phase_samples: phases with fewer rows are reported unswept.
        default_min_edge / default_min_prob: kept when no grid point qualifies.

    Returns:
        One PhaseResult per bracket, in bracket order (including unswept ones).
    """
    ph_prob = np.asarray(probs)
    ph_labels = np.asarray(labels)
    ph_minutes = np.asarray(minutes_left)
    ph_mkt_price = np.asarray(market_price)

    results: list[PhaseResult] = []
    for phase_name, lo_min, hi_min in brackets:
        phase_mask = (ph_minutes > lo_min) & (ph_minutes <= hi_min)
        n_phase = int(phase_mask.sum())
        if n_phase < min_phase_samples:
            results.append(
                PhaseResult(
                    phase=phase_name,
                    selected=False,
                    n_samples=n_phase,
                    min_edge=default_min_edge,
                    min_prob=default_min_prob,
                    n_entries=0,
                    accuracy=0.0,
                )
            )
            continue

        p_probs = ph_prob[phase_mask]
        p_mkt = ph_mkt_price[phase_mask]
        p_labels = ph_labels[phase_mask]

        # Best edge and best side for each sample
        p_edge_abs = np.abs(p_probs - p_mkt)
        p_model_best = np.maximum(p_probs, 1 - p_probs)
        p_predicted_up = p_probs > p_mkt
        p_correct = (p_predicted_up & (p_labels == 1)) | (~p_predicted_up & (p_labels == 0))

        best_score = 0
        best_me = default_min_edge
        best_mp = default_min_prob

        for me in np.arange(*edge_grid):
            for mp in np.arange(*prob_grid):
                entry_mask = (p_edge_abs >= me) & (p_model_best >= mp)
                n_entries = entry_mask.sum()
                if n_entries < max(20, n_phase * 0.05):
                    continue
                acc = p_correct[entry_mask].mean()
                coverage = n_entries / n_phase
                score = acc * np.sqrt(coverage)
                if score > best_score:
                    best_score = score
                    best_me = me
                    best_mp = mp

        entry_mask = (p_edge_abs >= best_me) & (p_model_best >= best_mp)
        n_enter = int(entry_mask.sum())
        acc_val = float(p_correct[entry_mask].mean()) if n_enter > 0 else 0
        results.append(
            PhaseResult(
                phase=phase_name,
                selected=True,
                n_samples=n_phase,
                min_edge=best_me,
                min_prob=best_mp,
                n_entries=n_enter,
                accuracy=acc_val,
            )
        )

    return results


def align_oof_predictions(
    xgb_probs: np.ndarray,
    lgb_probs: np.ndarray,
    labels: np.ndarray,
    xgb_idx: np.ndarray,
    lgb_idx: np.ndarray,
    *,
    min_common: int = 100,
) -> OofAlignment:
    """Line up the two models' OOF predictions on their shared X_train rows.

    XGB and LGB OOF rows are produced by identical fold arithmetic (same
    fold_size formula, same CV_EMBARGO, same X_train ordering), so they should
    align 1:1 — but this is VERIFIED here via the per-row oof_idx arrays rather
    than assumed; on mismatch (e.g. a NaN-skipped fold in one model only) the
    arrays are re-aligned on the intersection of X_train row indices instead.

    Args:
        xgb_probs / lgb_probs: calibrated OOF probabilities per model.
        labels: ground-truth 0/1 labels, aligned to `xgb_probs`.
        xgb_idx / lgb_idx: X_train row index behind each OOF prediction.
        min_common: minimum intersection size to accept a re-alignment.

    Returns:
        OofAlignment; its arrays are None when the intersection was too small.
    """
    if len(xgb_idx) == len(lgb_idx) and np.array_equal(xgb_idx, lgb_idx):
        return OofAlignment(
            xgb_probs=xgb_probs,
            lgb_probs=lgb_probs,
            labels=np.asarray(labels),
            identical=True,
            n_xgb=len(xgb_idx),
            n_lgb=len(lgb_idx),
            n_common=len(xgb_idx),
        )

    common_idx, xgb_pos, lgb_pos = np.intersect1d(xgb_idx, lgb_idx, return_indices=True)
    if len(common_idx) >= min_common:
        return OofAlignment(
            xgb_probs=xgb_probs[xgb_pos],
            lgb_probs=lgb_probs[lgb_pos],
            labels=np.asarray(labels)[xgb_pos],
            identical=False,
            n_xgb=len(xgb_idx),
            n_lgb=len(lgb_idx),
            n_common=len(common_idx),
        )
    return OofAlignment(
        xgb_probs=None,
        lgb_probs=None,
        labels=None,
        identical=False,
        n_xgb=len(xgb_idx),
        n_lgb=len(lgb_idx),
        n_common=len(common_idx),
    )


def select_ensemble_weights(
    xgb_probs: np.ndarray,
    lgb_probs: np.ndarray,
    labels: np.ndarray,
    *,
    grid: tuple[float, float, float] = (0.25, 0.80, 0.05),
    default_weight: float = 0.5,
) -> WeightChoice:
    """Score 11 candidate XGB/LGB blends by AUC and keep the best.

    MULTIPLE-TESTING FIX: 11 candidate weights were scored on the strict OOS
    holdout and the argmax kept — selecting the exported ensemble_weights on
    the very set the deploy gates treat as honest OOS (Lopez de Prado / ML4T
    ch16). SELECTION moved to calibrated out-of-fold CV predictions; the
    holdout stays EVALUATION-only.

    Args:
        xgb_probs / lgb_probs: calibrated probabilities, positionally aligned.
        labels: ground-truth 0/1 labels, aligned to the probability arrays.
        grid: (start, stop, step) np.arange bounds for the XGB weight scan.
        default_weight: returned when no candidate beats an AUC of 0.

    Returns:
        WeightChoice with the argmax XGB weight (LGB weight is 1 - it) and
        the AUC it scored.
    """
    best_ens_auc = 0
    best_ens_w = default_weight
    for w in np.arange(*grid):
        ens_prob = w * xgb_probs + (1 - w) * lgb_probs
        ens_auc_val = roc_auc_score(labels, ens_prob)
        if ens_auc_val > best_ens_auc:
            best_ens_auc = ens_auc_val
            best_ens_w = w
    return WeightChoice(weight_xgb=best_ens_w, auc=best_ens_auc)
