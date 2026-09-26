"""Early stopping follows log loss, in both boosters.

XGBoost stops on the LAST metric of `eval_metric`, LightGBM on whichever metric
stalls first unless `first_metric_only=True`. Until 2026-09-26 the XGBoost list
was ["logloss", "auc"], so every fit stopped on AUC — a ranking score — although
the bot prices with the probability. These tests pin the behaviour we rely on,
not just the constant, so a library change that moved it would show up here.
"""

from __future__ import annotations

import lightgbm as lgb
import numpy as np
import pytest
import xgboost as xgb
from sklearn.metrics import log_loss

from mltrain.configs import XGB_EVAL_METRIC
from mltrain.lightgbm_train import train_final_lgb

pytestmark = pytest.mark.unit


def _noisy_data(seed: int = 0):
    rng = np.random.default_rng(seed)
    X = rng.normal(size=(4000, 5))
    y = (X[:, 0] + rng.normal(scale=2.0, size=4000) > 0).astype(int)
    return X[:3000], y[:3000], X[3000:], y[3000:]


def test_log_loss_is_the_metric_xgboost_stops_on() -> None:
    assert XGB_EVAL_METRIC[-1] == "logloss"
    Xtr, ytr, Xva, yva = _noisy_data()
    dva = xgb.DMatrix(Xva, label=yva)
    params = {
        "objective": "binary:logistic",
        "eval_metric": list(XGB_EVAL_METRIC),
        "eta": 0.3,
        "max_depth": 6,
        "seed": 1,
    }
    bst = xgb.train(
        params,
        xgb.DMatrix(Xtr, label=ytr),
        500,
        evals=[(dva, "eval")],
        early_stopping_rounds=20,
        verbose_eval=False,
    )
    p = bst.predict(dva, iteration_range=(0, bst.best_iteration + 1))
    assert bst.best_score == pytest.approx(log_loss(yva, p), abs=1e-4)


LGB_PARAMS = {
    "objective": "binary",
    "metric": ["binary_logloss", "auc"],
    "verbosity": -1,
    "learning_rate": 0.3,
    "num_leaves": 63,
    "seed": 3,
    "deterministic": True,
    "num_threads": 1,
}


def _lgb_best_iteration(Xtr, ytr, Xva, yva, first_metric_only: bool) -> int:
    dtr = lgb.Dataset(Xtr, label=ytr, free_raw_data=False)
    dva = lgb.Dataset(Xva, label=yva, free_raw_data=False, reference=dtr)
    cb = [lgb.early_stopping(20, first_metric_only=first_metric_only, verbose=False)]
    return lgb.train(dict(LGB_PARAMS), dtr, 500, valid_sets=[dva], callbacks=cb).best_iteration


def test_final_lightgbm_fit_stops_on_log_loss_not_on_the_first_metric_to_stall() -> None:
    Xtr, ytr, Xva, yva = _noisy_data()
    on_logloss = _lgb_best_iteration(Xtr, ytr, Xva, yva, first_metric_only=True)
    on_any = _lgb_best_iteration(Xtr, ytr, Xva, yva, first_metric_only=False)
    assert on_logloss != on_any, "fixture must separate the two stopping rules"
    booster = train_final_lgb(
        Xtr,
        ytr,
        None,
        Xva,
        yva,
        dict(LGB_PARAMS),
        feature_cols=[f"f{i}" for i in range(5)],
        early_stopping=20,
    )
    assert booster.best_iteration == on_logloss
