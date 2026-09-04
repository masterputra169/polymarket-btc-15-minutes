"""Embargoed walk-forward cross-validation for the XGBoost stage.

Splits are purely temporal: fold k trains on rows [0, tr_end) and validates on
[tr_end + embargo, val_end). The embargo drops validation rows whose feature
lookbacks overlap the training tail, keeping the CV score Optuna maximizes
honest (ML4T ch6/16).

Every former global (feature_cols, seed, embargo, boosting budget) is now an
explicit parameter, so this module is importable and unit-testable.
"""

from __future__ import annotations

import numpy as np
import xgboost as xgb
from sklearn.metrics import accuracy_score, roc_auc_score

DEFAULT_NUM_BOOST_ROUND = 1200
DEFAULT_EARLY_STOPPING = 80
DEFAULT_N_CV_FOLDS = 5


def walk_forward_cv(
    X_tr: np.ndarray,
    y_tr: np.ndarray,
    cfg: dict,
    w_tr: np.ndarray | None = None,
    n_folds: int = DEFAULT_N_CV_FOLDS,
    return_preds: bool = False,
    feat_weights: np.ndarray | None = None,
    return_importances: bool = False,
    *,
    feature_cols: list[str],
    seed: int,
    embargo: int = 0,
    num_boost_round: int = DEFAULT_NUM_BOOST_ROUND,
    early_stopping: int = DEFAULT_EARLY_STOPPING,
) -> tuple:
    """Walk-forward CV: train on folds 1..k, validate on fold k+1.
    Optionally returns out-of-fold predictions AND raw margins for calibration,
    plus oof_idx — the X_tr row index of every OOF prediction. oof_idx lets
    downstream SELECTION sweeps (threshold / phase-grid / ensemble-weight)
    recover per-row metadata (e.g. minutes_left_norm) and verify row alignment
    against another model's OOF arrays, so selection can run on OOF predictions
    instead of the holdout (multiple-testing fix, Sep 2026).
    Indices are appended in the same place as predictions, so a fold skipped by
    the NaN guard stays consistently absent from preds, margins, labels AND idx.
    feat_weights: optional per-feature weight array (0=exclude from splits).
    return_importances: also return per-fold gain importance dicts (for
    stability-filtered pruning)."""
    fold_size = len(X_tr) // (n_folds + 2)
    aucs, accs = [], []
    oof_preds, oof_margins, oof_labels = [], [], []
    oof_idx: list[int] = []
    fold_importances = []

    for fold in range(n_folds):
        tr_end = fold_size * (fold + 2)
        # Embargo: first val rows share feature lookback with the train tail;
        # skipping them keeps the CV score (Optuna's objective) honest.
        val_start = tr_end + embargo
        val_end = len(X_tr) if fold == n_folds - 1 else tr_end + fold_size
        if val_end <= val_start:
            continue

        X_f_train = X_tr[:tr_end]
        y_f_train = y_tr[:tr_end]
        X_f_val = X_tr[val_start:val_end]
        y_f_val = y_tr[val_start:val_end]
        w_f_train = w_tr[:tr_end] if w_tr is not None else None

        spw_f = (len(y_f_train) - y_f_train.sum()) / max(y_f_train.sum(), 1)

        params = {
            "objective": "binary:logistic",
            "eval_metric": ["logloss", "auc"],
            "scale_pos_weight": spw_f,
            "seed": seed,
            "tree_method": "hist",
            **cfg,
        }
        # feature_weights requires colsample_bytree < 1.0
        if feat_weights is not None and params.get("colsample_bytree", 1.0) >= 1.0:
            params["colsample_bytree"] = 0.95

        dtrain_f = xgb.DMatrix(
            X_f_train, label=y_f_train, weight=w_f_train, feature_names=feature_cols
        )
        if feat_weights is not None:
            dtrain_f.feature_weights = feat_weights
        dval_f = xgb.DMatrix(X_f_val, label=y_f_val, feature_names=feature_cols)

        model_f = xgb.train(
            params,
            dtrain_f,
            num_boost_round=num_boost_round,
            evals=[(dval_f, "eval")],
            early_stopping_rounds=early_stopping,
            verbose_eval=False,
        )

        y_prob_f = model_f.predict(dval_f)

        # Guard against NaN predictions from degenerate hyperparameters
        if np.any(np.isnan(y_prob_f)):
            continue

        acc_f = accuracy_score(y_f_val, (y_prob_f >= 0.5).astype(int))
        try:
            auc_f = roc_auc_score(y_f_val, y_prob_f)
        except ValueError:
            # Only one class in fold or other issue
            auc_f = 0.5
        if np.isnan(auc_f):
            auc_f = 0.5
        aucs.append(auc_f)
        accs.append(acc_f)

        if return_preds:
            oof_preds.extend(y_prob_f.tolist())
            # Also collect raw margins (logits) for Platt-on-logits calibration (C4)
            y_margin_f = model_f.predict(dval_f, output_margin=True)
            oof_margins.extend(y_margin_f.tolist())
            oof_labels.extend(y_f_val.tolist())
            oof_idx.extend(range(val_start, val_end))

        if return_importances:
            fold_importances.append(model_f.get_score(importance_type="gain"))

    mean_auc = np.mean(aucs) if aucs else 0
    mean_acc = np.mean(accs) if accs else 0

    if return_preds and return_importances:
        return (
            mean_auc,
            mean_acc,
            np.array(oof_preds),
            np.array(oof_margins),
            np.array(oof_labels),
            np.array(oof_idx, dtype=np.int64),
            fold_importances,
        )
    if return_preds:
        return (
            mean_auc,
            mean_acc,
            np.array(oof_preds),
            np.array(oof_margins),
            np.array(oof_labels),
            np.array(oof_idx, dtype=np.int64),
        )
    if return_importances:
        return mean_auc, mean_acc, fold_importances
    return mean_auc, mean_acc
