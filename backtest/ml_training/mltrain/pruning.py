"""Section 6's soft feature pruning: fold-stability filter, retrain, keep-or-reject.

Pruning is SOFT — a dropped column is not removed from the feature vector, it is
given `feature_weight = 0` so XGBoost never samples it for a split. The browser
feature contract (79 columns, fixed order) therefore never changes, and a later
retrain can bring a column back without a schema migration.

The stability filter is the part that matters (ML4T ch8/11): single-model gain is
noisy, so a column is only pruned when it falls below the threshold in the final
model AND in every walk-forward fold. Without it each retrain prunes a slightly
different tail on noise alone, and the deployed feature set churns between runs.
Columns that are weak overall but carry one fold are reported as "rescued".

The retrain is only kept when it does not lose AUC on the strict OOS holdout
(test is the fallback when no holdout was carved out), with a 0.002 tolerance
buying simplicity; on rejection the caller keeps the original model AND an empty
pruned list, so the exported `pruned_features` always describes the artifact
actually shipped.

Pure logic with an injected `log` callable; the trainer owns stdout and all JSON.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass

import numpy as np
import xgboost as xgb
from sklearn.metrics import accuracy_score, roc_auc_score

PRUNE_THRESHOLD = 0.005  # features with <0.5% of total gain


@dataclass(frozen=True)
class PruningResult:
    """The model that survived pruning plus everything the caller must export.

    `model` is the artifact to ship: the pruned retrain when it was kept, the
    original booster otherwise. `pruned_features` is emptied on rejection so it
    always describes `model`. `combined_fw` records the pre-exclude + soft-prune
    weights the retrain used (None when no retrain happened) — section 7 feeds it
    back into the calibration CV so cv/test gaps stay apples-to-apples.
    `test_probs` carries the pruned model's test predictions when it was kept
    (None otherwise, meaning the caller's existing `y_prob` still applies).
    """
    model: xgb.Booster
    pruned_features: list[str]
    pruned_model_kept: bool
    combined_fw: np.ndarray | None
    test_probs: np.ndarray | None
    rescued_features: list[str]
    n_folds_checked: int
    eval_set_name: str | None
    pruned_accuracy: float | None
    pruned_auc: float | None
    baseline_auc: float | None


def evaluate_pruning(model: xgb.Booster,
                     *,
                     feature_cols: Sequence[str],
                     cv_fn: Callable[..., tuple],
                     X_train: np.ndarray,
                     y_train: np.ndarray,
                     w_train: np.ndarray | None,
                     best_cfg: Mapping[str, float],
                     feat_weights: np.ndarray | None,
                     pre_exclude_fw: np.ndarray,
                     has_pre_excluded: bool,
                     final_params: Mapping[str, object],
                     X_final_train: np.ndarray,
                     y_final_train: np.ndarray,
                     w_train_final: np.ndarray | None,
                     num_boost_round: int,
                     early_stopping: int,
                     dtest: xgb.DMatrix,
                     y_test: np.ndarray,
                     dholdout: xgb.DMatrix | None,
                     y_holdout: np.ndarray | None,
                     initial_auc: float,
                     log: Callable[..., None] = print) -> PruningResult:
    """Prune low-gain features, retrain, and keep the retrain only if it holds up.

    Args:
        model: the initial booster, scored for gain and used as the baseline.
        feature_cols: full feature order; the returned weight vector aligns to it.
        cv_fn: walk-forward CV bound to this run, called with
            return_importances=True for the per-fold stability check.
        X_train, y_train, w_train: the TUNE subset the CV runs on.
        best_cfg: winning hyperparameters, re-used for the stability CV.
        feat_weights: per-feature weights for the stability CV (None = all active).
        pre_exclude_fw: the --exclude-features weight vector, min-combined with
            the soft-prune weights so an excluded column can never come back.
        has_pre_excluded: whether --exclude-features named anything.
        final_params: the initial model's booster params, copied for the retrain.
        X_final_train, y_final_train, w_train_final: the rows the FINAL model
            trained on (strict-holdout aware — see the May 2026 audit note below).
        num_boost_round, early_stopping: same budget as the initial fit.
        dtest, y_test: test split; also the eval set when no holdout exists.
        dholdout, y_holdout: strict OOS holdout, or None.
        initial_auc: the initial model's TEST AUC (baseline when no holdout).
        log: sink for the section's console lines (the trainer's `print`).

    Returns:
        PruningResult; see its docstring for the keep/reject semantics.
    """
    importance = model.get_score(importance_type='gain')
    total_gain = sum(importance.values())

    # Identify low-importance features
    pruned_features: list[str] = []
    pruned_model_kept = False  # True only when the soft-pruned retrain replaces `model`
    combined_fw = None         # pre-exclude + soft-pruning feature weights (set on retrain)
    feature_weights = np.ones(len(feature_cols), dtype=np.float32)

    # Stability filter (ML4T ch8/11): single-model gain is noisy, so a feature is
    # only pruned when it is ALSO below threshold in every walk-forward fold.
    # Prevents pruning on noise and feature churn between retrains.
    log("   Computing per-fold importances for stability check...")
    _, _, fold_importances = cv_fn(
        X_train, y_train, best_cfg, w_train, return_importances=True,
        feat_weights=feat_weights
    )
    fold_fracs: dict[str, list[float]] = {feat: [] for feat in feature_cols}
    for imp in fold_importances:
        fold_total = sum(imp.values())
        for feat in feature_cols:
            fold_fracs[feat].append((imp.get(feat, 0.0) / fold_total) if fold_total > 0 else 0.0)

    rescued_by_stability: list[str] = []
    for i, feat in enumerate(feature_cols):
        gain = importance.get(feat, 0)
        frac = gain / total_gain if total_gain > 0 else 0
        if frac < PRUNE_THRESHOLD:
            fracs = fold_fracs.get(feat) or [0.0]
            if all(f < PRUNE_THRESHOLD for f in fracs):
                feature_weights[i] = 0.0  # effectively exclude from splits
                pruned_features.append(feat)
            else:
                rescued_by_stability.append(feat)

    log(f"   Total features: {len(feature_cols)}")
    log(f"   Pruned (< {PRUNE_THRESHOLD*100:.1f}% gain in final model AND all {len(fold_importances)} folds): {len(pruned_features)}")
    if rescued_by_stability:
        log(f"   Rescued by fold stability (weak in final model, strong in >=1 fold): {len(rescued_by_stability)}"
            f" — {', '.join(rescued_by_stability[:10])}{'...' if len(rescued_by_stability) > 10 else ''}")
    if pruned_features:
        log(f"   Pruned list: {', '.join(pruned_features[:15])}{'...' if len(pruned_features) > 15 else ''}")

    eval_set_name = None
    pruned_acc = None
    pruned_auc = None
    initial_eval_auc = None
    test_probs = None

    # Retrain with feature weights if any features were pruned
    if pruned_features and len(pruned_features) < len(feature_cols) * 0.5:
        log(f"   Retraining with {len(feature_cols) - len(pruned_features)} active features...")

        # Need colsample_bytree < 1.0 for feature_weights to take effect
        retrain_params = dict(final_params)
        if retrain_params.get('colsample_bytree', 1.0) >= 1.0:
            retrain_params['colsample_bytree'] = 0.95

        # Combine pre-exclude weights with soft-pruning weights
        combined_fw = feature_weights.copy()
        if has_pre_excluded:
            combined_fw = np.minimum(combined_fw, pre_exclude_fw)
        # Audit fix (May 2026 P6 follow-up): use X_final_train / y_final_train (which
        # respect strict-holdout). Previously used X_train_full unconditionally → weight
        # dimension mismatch when strict_holdout excluded holdout from final train.
        dtrain_fw = xgb.DMatrix(X_final_train, label=y_final_train, weight=w_train_final, feature_names=list(feature_cols))
        dtrain_fw.feature_weights = combined_fw

        # Early stop on holdout for pruned model too (audit fix M-prune)
        if dholdout is not None:
            prune_early_stop_set = (dholdout, 'holdout')
        else:
            prune_early_stop_set = (dtest, 'eval')

        ev2 = {}
        model_pruned = xgb.train(
            retrain_params, dtrain_fw,
            num_boost_round=num_boost_round,
            evals=[(dtrain_fw, 'train'), prune_early_stop_set],
            evals_result=ev2,
            early_stopping_rounds=early_stopping,
            verbose_eval=False,
        )

        # Evaluate pruned model on holdout (audit fix M-prune) or test as fallback
        if dholdout is not None:
            y_prob_pruned_eval = model_pruned.predict(dholdout)
            pruned_acc = accuracy_score(y_holdout, (y_prob_pruned_eval >= 0.5).astype(int))
            pruned_auc = roc_auc_score(y_holdout, y_prob_pruned_eval)
            eval_set_name = "holdout"
        else:
            y_prob_pruned_eval = model_pruned.predict(dtest)
            pruned_acc = accuracy_score(y_test, (y_prob_pruned_eval >= 0.5).astype(int))
            pruned_auc = roc_auc_score(y_test, y_prob_pruned_eval)
            eval_set_name = "test"
        log(f"   Pruned model ({eval_set_name}): acc={pruned_acc*100:.1f}% | AUC={pruned_auc:.4f} | trees={model_pruned.best_iteration+1}")

        # Compare on same eval set (holdout if available, test otherwise)
        if dholdout is not None:
            initial_eval_prob = model.predict(dholdout)
            initial_eval_auc = roc_auc_score(y_holdout, initial_eval_prob)
        else:
            initial_eval_auc = initial_auc

        # Keep better model
        if pruned_auc >= initial_eval_auc - 0.002:  # allow tiny regression for simpler model
            log(f"   [OK]Using pruned model (AUC diff: {(pruned_auc-initial_eval_auc)*100:+.2f}%)")
            model = model_pruned
            pruned_model_kept = True
            test_probs = model_pruned.predict(dtest)  # always keep test predictions for final eval
        else:
            log(f"   [NO]Keeping original (pruned AUC {pruned_auc:.4f} < original {initial_eval_auc:.4f})")
            pruned_features = []  # reset since we're not using pruned model
    else:
        log(f"   No features pruned (all above threshold or too many would be pruned)")

    return PruningResult(
        model=model,
        pruned_features=pruned_features,
        pruned_model_kept=pruned_model_kept,
        combined_fw=combined_fw,
        test_probs=test_probs,
        rescued_features=rescued_by_stability,
        n_folds_checked=len(fold_importances),
        eval_set_name=eval_set_name,
        pruned_accuracy=pruned_acc,
        pruned_auc=pruned_auc,
        baseline_auc=initial_eval_auc,
    )
