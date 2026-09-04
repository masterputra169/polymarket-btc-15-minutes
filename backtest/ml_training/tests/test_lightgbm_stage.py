"""Unit tests for mltrain.lightgbm_stage — the ensemble partner's orchestration.

Three properties decide whether this stage ships a coherent artifact set, and
none of them are visible from the numbers alone:

  * norm_browser.json must come back as the caller's payload with EXACTLY the
    five ensemble keys appended, in order. The stage used to add them by
    in-place assignment on the trainer's dict; it now rebuilds the dict, and
    key order is part of the browser contract (it changes the bytes on disk that
    the deploy checksum notices);
  * the blend weight must be selected on OOF CV predictions, falling back to the
    holdout and then to test ONLY when the OOF rows are unusable. The fallbacks
    are the paths a degenerate CV takes, so they are exercised explicitly rather
    than trusted;
  * the returned LightGbmStageResult must agree with what was written, since the
    trainer's closing summary restates it instead of recomputing it.
"""

from __future__ import annotations

import json
from typing import Any

import numpy as np
import pytest

from mltrain.cv import walk_forward_cv
from mltrain.lightgbm_stage import (
    LightGbmStageResult,
    _resolve_lgb_params,
    _select_ensemble_weight,
    run_lightgbm_stage,
)
from mltrain.lightgbm_train import default_lgb_params

EMBARGO = 4
N_FOLDS = 2

# The trainer's norm_browser.json payload, trimmed to the keys whose ORDER the
# ensemble block has to land after.
BASE_NORM: dict[str, Any] = {
    "version": 3,
    "means": [0.0, 0.0, 0.0, 0.0],
    "stds": [1.0, 1.0, 1.0, 1.0],
    "platt_a": 1.0,
    "platt_b": 0.0,
    "holdout_frac": 0.125,
}

ENSEMBLE_KEYS = [
    "ensemble_weights",
    "ensemble_metrics",
    "lgb_platt_a",
    "lgb_platt_b",
    "lgb_platt_on_logits",
]

ENSEMBLE_METRIC_KEYS = [
    "accuracy",
    "auc",
    "logloss",
    "brier",
    "calibration_ece",
    "calibration_mce",
    "weight_source",
    "test_samples",
    "holdout_samples",
    "strict_holdout",
]


class _ExplodingBooster:
    """Stands in for the XGBoost booster on paths that must never consult it.

    The OOF sweep works from margins the trainer already computed; touching the
    booster again would mean the holdout fallback fired by mistake.
    """

    def predict(self, *args: Any, **kwargs: Any) -> np.ndarray:
        raise AssertionError("the OOF path must not re-predict with the XGB booster")


class _MarginBooster:
    """Returns fixed raw margins, whatever it is asked to score."""

    def __init__(self, margins: np.ndarray) -> None:
        self._margins = margins

    def predict(
        self, data: Any, output_margin: bool = False, raw_score: bool = False
    ) -> np.ndarray:
        assert output_margin or raw_score, "the sweep only ever wants raw margins"
        return self._margins


@pytest.fixture
def splits() -> dict[str, Any]:
    """Train / holdout / test blocks cut the way the trainer cuts them."""
    rng = np.random.default_rng(11)
    n, k = 600, 4
    X = rng.normal(size=(n, k)).astype(np.float32)
    y = (rng.uniform(size=n) < 1.0 / (1.0 + np.exp(-2.5 * X[:, 0]))).astype(np.int32)
    return {
        "X_train": X[:480],
        "y_train": y[:480],
        "X_holdout": X[480:540],
        "y_holdout": y[480:540],
        "X_test": X[540:],
        "y_test": y[540:],
        "feature_cols": [f"f{i}" for i in range(k)],
    }


@pytest.fixture
def xgb_oof(splits: dict[str, Any]) -> tuple:
    """Genuine XGBoost OOF margins/labels/row-indices from the shared fold cut.

    Produced by the real walk_forward_cv (on a tiny boosting budget) so the
    alignment check meets the same arrays production hands it.
    """
    return walk_forward_cv(
        splits["X_train"],
        splits["y_train"],
        {"max_depth": 3, "learning_rate": 0.3},
        None,
        N_FOLDS,
        True,
        None,
        False,
        feature_cols=splits["feature_cols"],
        seed=42,
        embargo=EMBARGO,
        num_boost_round=40,
        early_stopping=10,
    )


def _run(
    splits: dict[str, Any],
    xgb_oof: tuple,
    out_dir,
    log,
    *,
    xgb_model: Any = None,
    norm: dict[str, Any] | None = None,
) -> LightGbmStageResult:
    """run_lightgbm_stage on the OOF-selection path, at a test-sized budget."""
    _, _, _, oof_margins, oof_labels, oof_idx = xgb_oof
    return run_lightgbm_stage(
        X_train=splits["X_train"],
        y_train=splits["y_train"],
        w_train=None,
        X_final_train=splits["X_train"],
        y_final_train=splits["y_train"],
        w_train_final=None,
        X_test=splits["X_test"],
        y_test=splits["y_test"],
        X_holdout=splits["X_holdout"],
        y_holdout=splits["y_holdout"],
        feature_cols=splits["feature_cols"],
        seed=42,
        embargo=EMBARGO,
        n_folds=N_FOLDS,
        use_optuna=False,
        xgb_model=xgb_model or _ExplodingBooster(),
        xgb_dholdout=None,
        xgb_oof_margins=oof_margins,
        xgb_oof_labels=oof_labels,
        xgb_oof_idx=oof_idx,
        xgb_platt_a=1.0,
        xgb_platt_b=0.0,
        xgb_test_probs=np.full(len(splits["y_test"]), 0.5),
        xgb_accuracy=0.6,
        xgb_auc=0.7,
        norm=dict(BASE_NORM) if norm is None else norm,
        output_dir=str(out_dir),
        strict_holdout=True,
        num_boost_round=60,
        early_stopping=15,
        log=log,
    )


@pytest.mark.integration
def test_norm_export_appends_ensemble_block_in_order(splits, xgb_oof, tmp_path, capsys):
    lines: list[str] = []
    caller_norm = dict(BASE_NORM)
    result = _run(splits, xgb_oof, tmp_path, lines.append, norm=caller_norm)

    written = json.loads((tmp_path / "norm_browser.json").read_text())
    assert list(written.keys()) == list(BASE_NORM.keys()) + ENSEMBLE_KEYS
    assert list(written["ensemble_metrics"].keys()) == ENSEMBLE_METRIC_KEYS
    assert caller_norm == BASE_NORM, "the trainer's norm dict must not be mutated"

    assert written["ensemble_weights"] == {"xgb": result.weight_xgb, "lgb": result.weight_lgb}
    assert written["ensemble_metrics"]["weight_source"] == result.weight_source
    assert written["ensemble_metrics"]["test_samples"] == len(splits["y_test"])
    assert written["ensemble_metrics"]["holdout_samples"] == len(splits["y_holdout"])
    assert written["ensemble_metrics"]["strict_holdout"] is True
    assert written["lgb_platt_on_logits"] is True

    # Every line the stage emits goes through the injected sink, so the trainer
    # keeps ownership of stdout.
    assert any("=== Ensemble Results" in line for line in lines)
    assert "=== Ensemble Results" not in capsys.readouterr().out


@pytest.mark.integration
def test_result_matches_exported_lightgbm_model(splits, xgb_oof, tmp_path):
    result = _run(splits, xgb_oof, tmp_path, lambda *a: None)

    exported = json.loads((tmp_path / "lightgbm_model.json").read_text())
    assert exported["num_trees"] == result.n_trees
    assert exported["ensemble_weights"] == {"xgb": result.weight_xgb, "lgb": result.weight_lgb}
    assert exported["metrics"]["accuracy"] == round(result.accuracy, 4)
    assert exported["metrics"]["auc"] == round(result.auc, 4)
    assert result.weight_source == "oof_cv"
    assert result.weight_xgb + result.weight_lgb == pytest.approx(1.0)


@pytest.mark.unit
def test_resolve_params_without_optuna_returns_defaults():
    lines: list[str] = []
    params = _resolve_lgb_params(
        np.zeros((4, 2), dtype=np.float32),
        np.zeros(4, dtype=np.int32),
        None,
        feature_cols=["a", "b"],
        seed=42,
        embargo=0,
        n_folds=2,
        use_optuna=False,
        log=lines.append,
    )
    assert params == default_lgb_params()
    assert lines == ["   Using default LightGBM params (no Optuna)"]


def _sweep(
    *, xgb_margins, lgb_margins, xgb_idx, lgb_idx, X_holdout, xgb_model, lgb_model, log, n_test=40
):
    labels = np.tile([0, 1], max(len(xgb_margins), 1) // 2 + 1)[: len(xgb_margins)]
    return _select_ensemble_weight(
        xgb_oof_margins=xgb_margins,
        lgb_oof_margins=lgb_margins,
        xgb_oof_labels=labels,
        xgb_oof_idx=xgb_idx,
        lgb_oof_idx=lgb_idx,
        xgb_platt_a=1.0,
        xgb_platt_b=0.0,
        lgb_platt_a=1.0,
        lgb_platt_b=0.0,
        xgb_model=xgb_model,
        xgb_dholdout=None,
        lgb_model=lgb_model,
        X_holdout=X_holdout,
        y_holdout=np.tile([0, 1], 30),
        X_test=np.zeros((n_test, 2), dtype=np.float32),
        y_test=np.tile([0, 1], n_test // 2),
        xgb_test_probs=np.linspace(0.1, 0.9, n_test),
        log=log,
    )


@pytest.mark.unit
def test_sweep_realigns_and_warns_when_oof_rows_differ():
    lines: list[str] = []
    rng = np.random.default_rng(3)
    xgb_idx = np.arange(0, 300, dtype=np.int64)
    lgb_idx = np.arange(50, 350, dtype=np.int64)
    weight, source = _sweep(
        xgb_margins=rng.normal(size=300),
        lgb_margins=rng.normal(size=300),
        xgb_idx=xgb_idx,
        lgb_idx=lgb_idx,
        X_holdout=None,
        xgb_model=_ExplodingBooster(),
        lgb_model=_ExplodingBooster(),
        log=lines.append,
    )
    assert source == "oof_cv"
    assert 0.25 <= weight <= 0.80
    assert any("[WARN] Ensemble OOF rows misaligned" in line for line in lines)


@pytest.mark.unit
def test_sweep_falls_back_to_holdout_when_oof_is_empty():
    lines: list[str] = []
    empty = np.array([])
    weight, source = _sweep(
        xgb_margins=empty,
        lgb_margins=empty,
        xgb_idx=empty,
        lgb_idx=empty,
        X_holdout=np.zeros((60, 2), dtype=np.float32),
        xgb_model=_MarginBooster(np.linspace(-2, 2, 60)),
        lgb_model=_MarginBooster(np.linspace(-2, 2, 60)),
        log=lines.append,
    )
    assert source == "holdout"
    assert 0.25 <= weight <= 0.80
    assert any("on holdout" in line for line in lines)


@pytest.mark.unit
def test_sweep_falls_back_to_test_without_holdout():
    lines: list[str] = []
    empty = np.array([])
    weight, source = _sweep(
        xgb_margins=empty,
        lgb_margins=empty,
        xgb_idx=empty,
        lgb_idx=empty,
        X_holdout=None,
        xgb_model=_ExplodingBooster(),
        lgb_model=_MarginBooster(np.linspace(-2, 2, 40)),
        log=lines.append,
    )
    assert source == "test"
    assert 0.25 <= weight <= 0.80
    assert any("on test, no holdout" in line for line in lines)
