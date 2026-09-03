"""Unit tests for mltrain.pruning — soft feature pruning and its safety rails.

Two properties decide whether pruning helps or quietly degrades the deployed
model, and both are asserted here rather than assumed:

  * the fold-stability filter must RESCUE a feature that looks weak in the final
    model's gain but carries at least one walk-forward fold. Without it, single
    -model gain noise prunes a different tail on every retrain and the deployed
    feature set churns (ML4T ch8/11);
  * the keep/reject comparison must REJECT a pruned retrain that scores worse,
    and must empty `pruned_features` when it does — otherwise the exported
    metadata describes a model that was never shipped.
"""

from __future__ import annotations

from typing import Any

import numpy as np
import pytest
import xgboost as xgb

from mltrain.pruning import PRUNE_THRESHOLD, evaluate_pruning

RETRAIN_PARAMS: dict[str, Any] = {
    'objective': 'binary:logistic',
    'eval_metric': ['logloss', 'auc'],
    'seed': 42,
    'tree_method': 'hist',
    'max_depth': 3,
    'learning_rate': 0.3,
    'colsample_bytree': 0.5,
}


class _StubBooster:
    """Stands in for the initial booster: only its gain dict drives pruning.

    `predictions` is consulted just once, for the baseline score on the holdout
    when one exists; without a holdout the caller supplies `initial_auc` instead.
    """

    def __init__(self, gains: dict[str, float],
                 predictions: np.ndarray | None = None) -> None:
        self._gains = gains
        self._predictions = predictions

    def get_score(self, importance_type: str = 'gain') -> dict[str, float]:
        assert importance_type == 'gain'
        return self._gains

    def predict(self, dmatrix) -> np.ndarray:
        assert self._predictions is not None, "no holdout predictions were staged"
        return self._predictions


def _cv_returning(fold_importances: list[dict[str, float]]):
    """A walk-forward-CV stand-in that replays fixed per-fold importances."""
    def cv_fn(X, y, cfg, w, *, return_importances: bool = False,
              feat_weights=None, **kwargs):
        assert return_importances, "pruning only calls CV for the stability check"
        return 0.0, 0.0, fold_importances
    return cv_fn


def _signal_dataset(n: int = 600, k: int = 10) -> tuple[np.ndarray, np.ndarray, list[str]]:
    """Column 0 carries all the signal; columns 1..k-1 are pure noise."""
    rng = np.random.default_rng(7)
    X = rng.normal(size=(n, k)).astype(np.float32)
    y = (rng.uniform(size=n) < 1.0 / (1.0 + np.exp(-3.0 * X[:, 0]))).astype(np.int32)
    return X, y, [f"f{i}" for i in range(k)]


def _call(model, cols, cv_fn, *, X, y, dtest, y_test, initial_auc,
          pre_exclude_fw=None, has_pre_excluded=False, log=None):
    """evaluate_pruning with the no-holdout wiring these tests exercise."""
    return evaluate_pruning(
        model,
        feature_cols=cols,
        cv_fn=cv_fn,
        X_train=X, y_train=y, w_train=None,
        best_cfg={'max_depth': 3},
        feat_weights=None,
        pre_exclude_fw=(np.ones(len(cols), dtype=np.float32)
                        if pre_exclude_fw is None else pre_exclude_fw),
        has_pre_excluded=has_pre_excluded,
        final_params=RETRAIN_PARAMS,
        X_final_train=X, y_final_train=y, w_train_final=None,
        num_boost_round=25, early_stopping=10,
        dtest=dtest, y_test=y_test,
        dholdout=None, y_holdout=None,
        initial_auc=initial_auc,
        log=(lambda *a, **k: None) if log is None else log,
    )


@pytest.mark.unit
class TestFoldStabilityFilter:
    """No retrain here: half the columns are pruned, which trips the >=50% guard."""

    COLS = ['strong', 'weak_a', 'weak_b', 'rescued']
    GAINS = {'strong': 100.0, 'weak_a': 0.1, 'weak_b': 0.1, 'rescued': 0.1}
    FOLDS = [
        {'strong': 100.0, 'weak_a': 0.1, 'weak_b': 0.1, 'rescued': 0.1},
        # 'rescued' carries a third of fold 2 despite being invisible overall.
        {'strong': 100.0, 'weak_a': 0.1, 'weak_b': 0.1, 'rescued': 50.0},
    ]

    def _run(self, log=None):
        X, y, _ = _signal_dataset(n=40, k=4)
        dtest = xgb.DMatrix(X, label=y, feature_names=self.COLS)
        return _call(_StubBooster(self.GAINS), self.COLS, _cv_returning(self.FOLDS),
                     X=X, y=y, dtest=dtest, y_test=y, initial_auc=0.9, log=log)

    def test_feature_strong_in_one_fold_is_rescued_not_pruned(self) -> None:
        result = self._run()
        assert result.rescued_features == ['rescued']
        assert 'rescued' not in result.pruned_features

    def test_feature_weak_in_every_fold_is_identified(self) -> None:
        # This fixture trips the >=50% guard, so the retrain is skipped and the
        # exported list is emptied (see test_skipped_retrain_reports_no_pruned_features).
        # Candidate identification is therefore asserted through the log, which
        # reports what the stability filter selected before that clearing.
        lines: list[str] = []
        self._run(log=lines.append)
        assert any('Pruned list: weak_a, weak_b' in line for line in lines)
        assert any('folds): 2' in line for line in lines)

    def test_feature_strong_overall_is_never_a_candidate(self) -> None:
        result = self._run()
        assert 'strong' not in result.pruned_features
        assert 'strong' not in result.rescued_features

    def test_rescue_is_reported_by_name(self) -> None:
        lines: list[str] = []
        self._run(log=lines.append)
        assert any('Rescued by fold stability' in line and 'rescued' in line
                   for line in lines)

    def test_gain_fractions_straddle_the_documented_threshold(self) -> None:
        # Guards the fixture rather than the code: if these stop straddling
        # PRUNE_THRESHOLD the tests above would pass vacuously.
        total = sum(self.GAINS.values())
        assert self.GAINS['weak_a'] / total < PRUNE_THRESHOLD < self.GAINS['strong'] / total
        fold2_total = sum(self.FOLDS[1].values())
        assert self.FOLDS[1]['rescued'] / fold2_total > PRUNE_THRESHOLD

    def test_majority_prune_skips_the_retrain(self) -> None:
        # 2 of 4 columns is not < 50%, so no retrain runs and no model is swapped.
        result = self._run()
        assert result.pruned_model_kept is False
        assert result.combined_fw is None
        assert result.test_probs is None

    def test_skipped_retrain_reports_no_pruned_features(self) -> None:
        # The exported pruned_features feeds xgboost_model.json. When the >=50%
        # guard skips the retrain, nothing was pruned, so the model must not
        # claim a pruning that never happened.
        assert self._run().pruned_features == []


@pytest.mark.integration
class TestKeepOrRejectRetrain:
    """These fit a real (tiny) booster, since the decision is about its score."""

    @staticmethod
    def _split():
        X, y, cols = _signal_dataset()
        return X[:400], y[:400], X[400:], y[400:], cols

    def test_rejects_pruned_model_that_scores_worse(self) -> None:
        # Prune the ONLY informative column: the retrain cannot beat the
        # (claimed) 0.95 baseline, so the original model must survive.
        X_tr, y_tr, X_te, y_te, cols = self._split()
        gains = {'f0': 0.1, **{c: 50.0 for c in cols[1:]}}
        stub = _StubBooster(gains)
        dtest = xgb.DMatrix(X_te, label=y_te, feature_names=cols)

        result = _call(stub, cols, _cv_returning([gains, gains]),
                       X=X_tr, y=y_tr, dtest=dtest, y_test=y_te, initial_auc=0.95)

        assert result.pruned_auc is not None and result.pruned_auc < 0.95
        assert result.pruned_model_kept is False
        assert result.model is stub, "rejected retrain must not replace the model"
        assert result.pruned_features == [], "exported list must describe the shipped model"
        assert result.test_probs is None
        assert result.eval_set_name == 'test'
        assert result.baseline_auc == 0.95

    def test_holdout_outranks_test_for_the_keep_decision(self) -> None:
        # Audit fix M-prune: with a holdout, BOTH models are scored on it and
        # the caller's `initial_auc` (a test-split number) is ignored. Here the
        # baseline is perfect on the holdout, so pruning the signal is rejected.
        X_tr, y_tr, X_te, y_te, cols = self._split()
        X_ho, y_ho = X_tr[300:], y_tr[300:]
        gains = {'f0': 0.1, **{c: 50.0 for c in cols[1:]}}
        stub = _StubBooster(gains, predictions=y_ho.astype(np.float64))
        dtest = xgb.DMatrix(X_te, label=y_te, feature_names=cols)
        dholdout = xgb.DMatrix(X_ho, label=y_ho, feature_names=cols)

        result = evaluate_pruning(
            stub,
            feature_cols=cols, cv_fn=_cv_returning([gains, gains]),
            X_train=X_tr[:300], y_train=y_tr[:300], w_train=None,
            best_cfg={'max_depth': 3}, feat_weights=None,
            pre_exclude_fw=np.ones(len(cols), dtype=np.float32),
            has_pre_excluded=False,
            final_params=RETRAIN_PARAMS,
            X_final_train=X_tr[:300], y_final_train=y_tr[:300], w_train_final=None,
            num_boost_round=25, early_stopping=10,
            dtest=dtest, y_test=y_te,
            dholdout=dholdout, y_holdout=y_ho,
            initial_auc=0.0,  # deliberately absurd: must be ignored
            log=lambda *a, **k: None,
        )

        assert result.eval_set_name == 'holdout'
        assert result.baseline_auc == pytest.approx(1.0)
        assert result.pruned_model_kept is False
        assert result.pruned_features == []

    def test_keeps_pruned_model_that_holds_up(self) -> None:
        # Prune 4 noise columns, keep the signal: the retrain matches the
        # (claimed) 0.5 baseline and replaces the model.
        X_tr, y_tr, X_te, y_te, cols = self._split()
        gains = {'f0': 100.0, 'f1': 0.05, 'f2': 0.05, 'f3': 0.05, 'f4': 0.05,
                 **{c: 20.0 for c in cols[5:]}}
        stub = _StubBooster(gains)
        dtest = xgb.DMatrix(X_te, label=y_te, feature_names=cols)
        # f9 is also pre-excluded (--exclude-features), so the combined vector
        # must zero it even though pruning left it alone.
        pre_exclude_fw = np.ones(len(cols), dtype=np.float32)
        pre_exclude_fw[9] = 0.0

        result = _call(stub, cols, _cv_returning([gains, gains]),
                       X=X_tr, y=y_tr, dtest=dtest, y_test=y_te, initial_auc=0.5,
                       pre_exclude_fw=pre_exclude_fw, has_pre_excluded=True)

        assert result.pruned_model_kept is True
        assert result.model is not stub
        assert result.pruned_features == ['f1', 'f2', 'f3', 'f4']
        assert result.test_probs is not None and len(result.test_probs) == len(y_te)
        assert result.combined_fw is not None
        assert result.combined_fw[0] == 1.0
        assert list(result.combined_fw[1:5]) == [0.0, 0.0, 0.0, 0.0]
        assert result.combined_fw[9] == 0.0, "pre-excluded column must stay excluded"
