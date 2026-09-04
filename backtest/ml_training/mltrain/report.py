"""The human-readable training_report.txt written beside the exported models.

This is the artefact a person opens when a retrain looks wrong, so it quotes
the same `XgbEvalMetrics` object the JSON `metrics` block is built from: the
report and the model can disagree about wording, never about numbers.

Pure function: metrics and run settings in, a list of lines out. The trainer
joins and writes them, so this module does no I/O.
"""

from __future__ import annotations

import json

from mltrain.export import XgbEvalMetrics


def build_training_report(
    metrics: XgbEvalMetrics,
    *,
    use_optuna: bool,
    tune_trials: int,
    winner: str,
    threshold: float,
    n_trees: int,
    feature_cols: list[str],
    feature_cols_orig: list[str],
    engineered_features: list[str],
    platt_a: float,
    platt_b: float,
    pruned_features: list[str],
    zero_features: list[str],
    pre_excluded_features: list[str],
    recency_enabled: bool,
    recency_halflife: int,
    cv_folds: int,
    num_boost_round: int,
    early_stopping: int,
    params: dict[str, object],
) -> list[str]:
    """Build training_report.txt as a list of lines (no trailing newline).

    The "Overfit gaps" line substitutes 0 for a missing test-holdout gap so the
    line keeps its shape when --holdout-frac is 0; the JSON export records the
    same case as null instead, which is what the deploy gates check.
    """
    return [
        "=== XGBoost v9 Training Report ===",
        f"Method: {'Optuna (' + str(tune_trials) + ' trials)' if use_optuna else 'Grid search (8 configs)'}",
        f"Winner: {winner}",
        f"Accuracy: {metrics.accuracy*100:.2f}% | AUC: {metrics.auc:.4f}",
        f"Calibration: Brier={metrics.brier:.4f} | ECE={metrics.calibration['ece']:.4f} | MCE={metrics.calibration['mce']:.4f}",
        f"Overfit gaps: test-CV acc={metrics.cv_test_acc_gap*100:+.2f}pp | test-holdout acc={(metrics.test_holdout_acc_gap*100 if metrics.test_holdout_acc_gap is not None else 0):+.2f}pp",
        f"High-conf: {metrics.high_conf_accuracy*100:.1f}% ({metrics.high_conf_count:,} signals, {metrics.high_conf_ratio:.1f}%)",
        f"Threshold: {threshold:.3f} | Trees: {n_trees}",
        f"Features: {len(feature_cols)} ({len(feature_cols_orig)} base + {len(engineered_features)} engineered)",
        f"Platt calibration (on logits): A={platt_a:.4f}, B={platt_b:.4f}",
        f"Pruned features ({len(pruned_features)}): {', '.join(pruned_features) if pruned_features else 'none'}",
        f"Zero features: {', '.join(zero_features) if zero_features else 'none'}",
        f"Pre-excluded: {', '.join(pre_excluded_features) if pre_excluded_features else 'none'}",
        f"Recency: {'half-life=' + str(recency_halflife) + 'd' if recency_enabled else 'off'}",
        f"CV folds: {cv_folds} | Boost rounds: {num_boost_round} | Early stopping: {early_stopping}",
        "",
        f"Params: {json.dumps({k:v for k,v in params.items() if k not in ['objective','eval_metric','tree_method','seed']}, indent=2)}",
    ]
