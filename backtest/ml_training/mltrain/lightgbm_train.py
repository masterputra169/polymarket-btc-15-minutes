"""LightGBM half of the ensemble: embargoed CV, tuning, final fit, calibration.

The deployed model is an XGB/LGB blend, so the LightGBM partner is trained on
the same rows and cut into the same embargoed walk-forward folds as the
XGBoost side. That symmetry is what lets the ensemble-weight sweep line the two
models' out-of-fold predictions up row-for-row (verified, not assumed, by
mltrain/sweeps.align_oof_predictions).

Every former global (feature_cols, embargo, fold count, boosting budget, Optuna
seed/budget) is an explicit parameter, so this module is importable and
unit-testable. It does no reporting of its own: the trainer owns all stdout and
all JSON assembly, so the exported field names/values stay its concern alone.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import lightgbm as lgb
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, roc_auc_score

from mltrain.cv import (
    DEFAULT_EARLY_STOPPING,
    DEFAULT_N_CV_FOLDS,
    DEFAULT_NUM_BOOST_ROUND,
)

# Same boosting budget as the XGBoost stage (mltrain/cv.py), so neither half of
# the ensemble is handed more rounds — or a looser early stop — than the other.
LGB_BOOST_ROUND = DEFAULT_NUM_BOOST_ROUND
LGB_EARLY_STOPPING = DEFAULT_EARLY_STOPPING
LGB_OPTUNA_TRIALS = 50


@dataclass(frozen=True)
class LgbTuning:
    """Outcome of the LightGBM Optuna study.

    `params` is the best trial's suggestions merged with the fixed objective /
    metric / verbosity / bagging_freq settings, i.e. ready to hand to lgb.train.
    """
    params: dict[str, Any]
    best_trial: int
    best_value: float


@dataclass(frozen=True)
class LgbScores:
    """Raw (uncalibrated) test scores for the LightGBM partner."""
    accuracy: float
    auc: float
    n_trees: int


@dataclass(frozen=True)
class LgbCalibration:
    """Platt-on-logits calibration for the LightGBM partner.

    `a`/`b` are the transform that gets EXPORTED: (1.0, 0.0) — the identity —
    when there were too few OOF margins to fit (`fitted` False), or when the fit
    cost more test AUC than the tolerance and was discarded (`kept` False).
    `on_logits` records that the transform applies to raw margins rather than to
    already-sigmoided probabilities (audit fix C4); it stays True even when the
    fit was discarded, because the identity transform of a raw margin is still a
    logit-space transform and the browser must treat it as one.
    """
    a: float
    b: float
    on_logits: bool
    fitted: bool
    kept: bool
    cal_accuracy: float | None
    cal_auc: float | None


def default_lgb_params() -> dict[str, Any]:
    """Hand-tuned LightGBM params used when Optuna tuning is off.

    Returns a fresh dict every call — callers mutate the params they train with,
    so a shared module-level constant would leak between runs.
    """
    return {
        'objective': 'binary',
        'metric': ['binary_logloss', 'auc'],
        'verbosity': -1,
        'num_leaves': 31,
        'learning_rate': 0.05,
        'feature_fraction': 0.8,
        'bagging_fraction': 0.8,
        'bagging_freq': 5,
        'min_child_samples': 20,
        'lambda_l1': 0.1,
        'lambda_l2': 1.0,
    }


def platt_probs(margins: np.ndarray, a: float, b: float) -> np.ndarray:
    """Sigmoid of the Platt-scaled raw margins — the probability space inference uses.

    A=1.0 / B=0.0 is the identity transform (calibration skipped or disabled),
    for which this collapses to sigmoid(raw margin) = the model's raw probability.
    """
    return 1.0 / (1.0 + np.exp(-(a * margins + b)))


def lgb_walk_forward_cv(X_tr: np.ndarray, y_tr: np.ndarray, params: dict,
                        w_tr: np.ndarray | None = None,
                        n_folds: int = DEFAULT_N_CV_FOLDS,
                        return_preds: bool = False,
                        *,
                        feature_cols: list[str],
                        embargo: int = 0,
                        num_boost_round: int = LGB_BOOST_ROUND,
                        early_stopping: int = LGB_EARLY_STOPPING) -> tuple:
    """Walk-forward CV for LightGBM. Returns margins for Platt-on-logits.
    Also returns oof_idx (X_tr row index per OOF prediction) so the
    ensemble-weight sweep can VERIFY row alignment against the XGBoost OOF
    arrays instead of assuming it (multiple-testing fix, Sep 2026). Fold
    arithmetic (fold_size formula, CV_EMBARGO, X_tr ordering) is identical
    to walk_forward_cv, so the arrays normally align 1:1."""
    fold_size = len(X_tr) // (n_folds + 2)
    aucs, accs = [], []
    oof_preds, oof_margins, oof_labels = [], [], []
    oof_idx: list[int] = []

    for fold in range(n_folds):
        tr_end = fold_size * (fold + 2)
        # Same embargo as the XGBoost CV — keeps the two ensembles' CV honest
        # and comparable.
        val_start = tr_end + embargo
        val_end = len(X_tr) if fold == n_folds - 1 else tr_end + fold_size
        if val_end <= val_start:
            continue

        X_f_train = X_tr[:tr_end]
        y_f_train = y_tr[:tr_end]
        X_f_val = X_tr[val_start:val_end]
        y_f_val = y_tr[val_start:val_end]
        w_f_train = w_tr[:tr_end] if w_tr is not None else None

        dtrain = lgb.Dataset(X_f_train, label=y_f_train, weight=w_f_train,
                             feature_name=feature_cols, free_raw_data=False)
        dval = lgb.Dataset(X_f_val, label=y_f_val,
                           feature_name=feature_cols, free_raw_data=False, reference=dtrain)

        callbacks = [lgb.early_stopping(early_stopping, verbose=False),
                     lgb.log_evaluation(period=0)]

        model_f = lgb.train(
            params, dtrain,
            num_boost_round=num_boost_round,
            valid_sets=[dval],
            callbacks=callbacks,
        )

        y_prob_f = model_f.predict(X_f_val)

        if np.any(np.isnan(y_prob_f)):
            continue

        acc_f = accuracy_score(y_f_val, (y_prob_f >= 0.5).astype(int))
        try:
            auc_f = roc_auc_score(y_f_val, y_prob_f)
        except ValueError:
            auc_f = 0.5
        if np.isnan(auc_f):
            auc_f = 0.5
        aucs.append(auc_f)
        accs.append(acc_f)

        if return_preds:
            oof_preds.extend(y_prob_f.tolist())
            # Raw logits for Platt-on-logits (C4)
            y_margin_f = model_f.predict(X_f_val, raw_score=True)
            oof_margins.extend(y_margin_f.tolist())
            oof_labels.extend(y_f_val.tolist())
            oof_idx.extend(range(val_start, val_end))

    mean_auc = np.mean(aucs) if aucs else 0
    mean_acc = np.mean(accs) if accs else 0

    if return_preds:
        return (mean_auc, mean_acc, np.array(oof_preds), np.array(oof_margins), np.array(oof_labels),
                np.array(oof_idx, dtype=np.int64))
    return mean_auc, mean_acc


def tune_lgb_params(X_train: np.ndarray, y_train: np.ndarray,
                    w_train: np.ndarray | None = None,
                    *,
                    feature_cols: list[str],
                    seed: int,
                    embargo: int = 0,
                    n_folds: int = DEFAULT_N_CV_FOLDS,
                    n_trials: int = LGB_OPTUNA_TRIALS,
                    num_boost_round: int = LGB_BOOST_ROUND,
                    early_stopping: int = LGB_EARLY_STOPPING,
                    show_progress_bar: bool = True) -> LgbTuning:
    """Bayesian search over the LightGBM hyperparameters, scored by embargoed CV AUC.

    The objective is the walk-forward CV AUC — never a holdout score — so the
    strict OOS holdout stays untouched by tuning. Degenerate trials (NaN or zero
    CV AUC) are floored at 0.5 rather than propagating NaN into the sampler.

    The TPE sampler is seeded with `seed`; the trainer passes args.seed + 1 so
    the LGB study does not replay the XGBoost study's trial sequence.

    optuna is imported lazily: it is an optional dependency, and this function
    only runs once the trainer has confirmed it is installed.
    """
    import optuna

    def lgb_objective(trial):
        params = {
            'objective': 'binary',
            'metric': ['binary_logloss', 'auc'],
            'verbosity': -1,
            'num_leaves': trial.suggest_int('num_leaves', 15, 63),
            'learning_rate': trial.suggest_float('learning_rate', 0.008, 0.2, log=True),
            'feature_fraction': trial.suggest_float('feature_fraction', 0.5, 0.95),
            'bagging_fraction': trial.suggest_float('bagging_fraction', 0.6, 0.95),
            'bagging_freq': 5,
            'min_child_samples': trial.suggest_int('min_child_samples', 5, 50),
            'lambda_l1': trial.suggest_float('lambda_l1', 1e-3, 2.0, log=True),
            'lambda_l2': trial.suggest_float('lambda_l2', 0.3, 6.0),
        }
        cv_auc, _ = lgb_walk_forward_cv(
            X_train, y_train, params, w_train, n_folds,
            feature_cols=feature_cols, embargo=embargo,
            num_boost_round=num_boost_round, early_stopping=early_stopping,
        )
        if np.isnan(cv_auc) or cv_auc == 0:
            return 0.5
        return cv_auc

    lgb_study = optuna.create_study(
        direction='maximize',
        sampler=optuna.samplers.TPESampler(seed=seed),
    )
    lgb_study.optimize(lgb_objective, n_trials=n_trials, show_progress_bar=show_progress_bar)

    lgb_best_params = lgb_study.best_trial.params
    lgb_best_params.update({
        'objective': 'binary',
        'metric': ['binary_logloss', 'auc'],
        'verbosity': -1,
        'bagging_freq': 5,
    })
    return LgbTuning(
        params=lgb_best_params,
        best_trial=lgb_study.best_trial.number,
        best_value=lgb_study.best_value,
    )


def train_final_lgb(X_train: np.ndarray, y_train: np.ndarray,
                    w_train: np.ndarray | None,
                    X_val: np.ndarray, y_val: np.ndarray,
                    params: dict,
                    *,
                    feature_cols: list[str],
                    num_boost_round: int = LGB_BOOST_ROUND,
                    early_stopping: int = LGB_EARLY_STOPPING) -> lgb.Booster:
    """Fit the deployed LightGBM booster, early-stopping on `X_val`.

    Audit fix (May 2026 P6 follow-up): the caller respects strict-holdout for LGB
    too — under --strict-holdout the training rows are the tune subset only, and
    the holdout it early-stops on is never trained on.
    """
    lgb_dtrain = lgb.Dataset(X_train, label=y_train, weight=w_train,
                             feature_name=feature_cols, free_raw_data=False)
    lgb_dval = lgb.Dataset(X_val, label=y_val,
                           feature_name=feature_cols, free_raw_data=False, reference=lgb_dtrain)

    lgb_callbacks = [lgb.early_stopping(early_stopping, verbose=False),
                     lgb.log_evaluation(period=0)]

    return lgb.train(
        params, lgb_dtrain,
        num_boost_round=num_boost_round,
        valid_sets=[lgb_dval],
        callbacks=lgb_callbacks,
    )


def evaluate_lgb(model: lgb.Booster, X_test: np.ndarray, y_test: np.ndarray) -> LgbScores:
    """Score the RAW (pre-Platt) LightGBM probabilities on the test split.

    n_trees is the count the browser export slices to: best_iteration when early
    stopping fired, otherwise every tree that was built.
    """
    lgb_y_prob = model.predict(X_test)
    return LgbScores(
        accuracy=accuracy_score(y_test, (lgb_y_prob >= 0.5).astype(int)),
        auc=roc_auc_score(y_test, lgb_y_prob),
        n_trees=model.best_iteration if model.best_iteration > 0 else model.num_trees(),
    )


def fit_lgb_platt(model: lgb.Booster, X_test: np.ndarray, y_test: np.ndarray,
                  oof_margins: np.ndarray, oof_labels: np.ndarray,
                  *,
                  raw_auc: float,
                  min_oof_margins: int = 100,
                  auc_tolerance: float = 0.005) -> LgbCalibration:
    """Fit Platt scaling on the LightGBM OOF logits (audit fix C4).

    Calibrating on RAW MARGINS rather than on already-sigmoided probabilities
    avoids the double sigmoid that flattened the old calibration curve. The fit
    is discarded (identity transform restored) when it costs more than
    `auc_tolerance` of test AUC — a calibration that hurts ranking is not worth
    the better probability scale.

    Args:
        model: the trained booster, queried for raw test margins.
        X_test / y_test: EVALUATION split used only to accept/reject the fit.
        oof_margins / oof_labels: out-of-fold logits the transform is fitted on.
        raw_auc: uncalibrated test AUC the fit has to stay within tolerance of.

    Returns:
        LgbCalibration; a/b are the identity when the fit was skipped or rejected.
    """
    on_logits = True
    if len(oof_margins) <= min_oof_margins:
        return LgbCalibration(a=1.0, b=0.0, on_logits=on_logits, fitted=False, kept=False,
                              cal_accuracy=None, cal_auc=None)

    lgb_lr = LogisticRegression(C=1.0, solver='lbfgs', max_iter=1000)
    lgb_lr.fit(oof_margins.reshape(-1, 1), oof_labels)
    platt_a = float(lgb_lr.coef_[0][0])
    platt_b = float(lgb_lr.intercept_[0])

    # Apply Platt on raw logits of test predictions
    lgb_y_margin_test = model.predict(X_test, raw_score=True)
    lgb_y_cal = platt_probs(lgb_y_margin_test, platt_a, platt_b)
    cal_acc = accuracy_score(y_test, (lgb_y_cal >= 0.5).astype(int))
    cal_auc = roc_auc_score(y_test, lgb_y_cal)

    if cal_auc < raw_auc - auc_tolerance:
        return LgbCalibration(a=1.0, b=0.0, on_logits=on_logits, fitted=True, kept=False,
                              cal_accuracy=cal_acc, cal_auc=cal_auc)
    return LgbCalibration(a=platt_a, b=platt_b, on_logits=on_logits, fitted=True, kept=True,
                          cal_accuracy=cal_acc, cal_auc=cal_auc)
