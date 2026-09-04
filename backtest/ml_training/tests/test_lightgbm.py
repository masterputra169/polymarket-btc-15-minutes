"""Unit tests for mltrain.lightgbm_train / mltrain.lightgbm_export.

Two invariants matter more than the rest here:

1. The LGB folds must be cut exactly like the XGBoost folds. The ensemble-weight
   sweep lines the two models' out-of-fold predictions up by X_train row index
   (mltrain/sweeps.align_oof_predictions); if the fold arithmetic drifts, the
   sweep silently falls back to an intersection — or to the holdout it is meant
   to keep honest.
2. The exported JSON is a contract with src/engines/Mlpredictor.ts, so the
   traversal rules and the field names are asserted, not assumed.
"""

from __future__ import annotations

import numpy as np
import pytest

from mltrain.cv import DEFAULT_N_CV_FOLDS, walk_forward_cv
from mltrain.lightgbm_export import (
    build_lgb_browser_model,
    compute_init_score,
    traverse_lgb_tree,
    verify_browser_inference,
)
from mltrain.lightgbm_train import (
    LGB_BOOST_ROUND,
    LGB_EARLY_STOPPING,
    default_lgb_params,
    evaluate_lgb,
    fit_lgb_platt,
    lgb_walk_forward_cv,
    platt_probs,
    train_final_lgb,
)

FAST_KW = dict(num_boost_round=20, early_stopping=5)


def _lgb_cv(X, y, cols, embargo, n_folds=DEFAULT_N_CV_FOLDS):
    return lgb_walk_forward_cv(
        X,
        y,
        default_lgb_params(),
        None,
        n_folds,
        True,
        feature_cols=cols,
        embargo=embargo,
        **FAST_KW,
    )


class TestPureHelpers:
    @pytest.mark.unit
    def test_default_params_are_not_shared_between_calls(self) -> None:
        first = default_lgb_params()
        first["num_leaves"] = 999
        assert default_lgb_params()["num_leaves"] == 31

    @pytest.mark.unit
    def test_identity_platt_is_the_plain_sigmoid(self) -> None:
        margins = np.array([-2.0, 0.0, 1.5])
        expected = 1.0 / (1.0 + np.exp(-margins))
        assert np.allclose(platt_probs(margins, 1.0, 0.0), expected)

    @pytest.mark.unit
    def test_init_score_is_the_logit_of_the_weighted_label_mean(self) -> None:
        y = np.array([0, 0, 1, 1])
        # Weighting the positives 3:1 must move the base score above the
        # unweighted 0.5 -> logit 0.0.
        assert compute_init_score(y, None) == pytest.approx(0.0)
        assert compute_init_score(y, np.array([1.0, 1.0, 3.0, 3.0])) > 0.0


class TestTreeTraversal:
    LEAF_L = {"leaf_value": -1.0}
    LEAF_R = {"leaf_value": 2.0}

    def _node(self, **extra) -> dict:
        return {
            "split_feature": 0,
            "threshold": 0.5,
            "left_child": self.LEAF_L,
            "right_child": self.LEAF_R,
            **extra,
        }

    @pytest.mark.unit
    def test_split_is_left_inclusive(self) -> None:
        node = self._node()
        assert traverse_lgb_tree(node, np.array([0.5])) == -1.0
        assert traverse_lgb_tree(node, np.array([0.5001])) == 2.0

    @pytest.mark.unit
    def test_nan_follows_default_left_instead_of_comparing(self) -> None:
        nan = np.array([np.nan])
        # A NaN comparison would take the right branch every time; the browser
        # predictor follows default_left, so this must too.
        assert traverse_lgb_tree(self._node(), nan) == -1.0
        assert traverse_lgb_tree(self._node(default_left=True), nan) == -1.0
        assert traverse_lgb_tree(self._node(default_left=False), nan) == 2.0


class TestBrowserModelContract:
    @pytest.mark.unit
    def test_exported_fields_and_derived_gaps(self) -> None:
        trees = [{"tree_structure": {"leaf_value": 0.1}} for _ in range(3)]
        model = build_lgb_browser_model(
            trees,
            feature_cols=["a", "b"],
            init_score=0.25,
            platt_a=1.5,
            platt_b=-0.25,
            platt_on_logits=True,
            accuracy=0.80,
            auc=0.90,
            brier=0.15,
            calibration={"ece": 0.0123456, "mce": 0.2},
            cv_auc=0.85,
            cv_acc=0.75,
            ensemble_weights={"xgb": 0.6, "lgb": 0.4},
        )
        assert model["format"] == "lightgbm_json_v2"
        assert model["version"] == 2
        assert model["num_features"] == 2
        # C2: num_trees comes from the sliced list, never from best_iteration.
        assert model["num_trees"] == len(trees) == 3
        assert set(model["metrics"]) == {
            "accuracy",
            "auc",
            "brier",
            "calibration_ece",
            "calibration_mce",
            "cv_auc",
            "cv_acc",
            "cv_test_acc_gap",
            "cv_test_auc_gap",
        }
        assert model["metrics"]["cv_test_acc_gap"] == pytest.approx(0.05)
        assert model["metrics"]["cv_test_auc_gap"] == pytest.approx(0.05)
        assert model["metrics"]["calibration_ece"] == pytest.approx(0.0123)


class TestFoldArithmetic:
    @pytest.mark.integration
    def test_oof_rows_match_the_xgboost_folds_exactly(self, separable_dataset) -> None:
        X, y, cols = separable_dataset
        embargo = 20
        *_, lgb_idx = _lgb_cv(X, y, cols, embargo)
        *_, xgb_idx = walk_forward_cv(
            X,
            y,
            {"max_depth": 3, "learning_rate": 0.3},
            n_folds=DEFAULT_N_CV_FOLDS,
            return_preds=True,
            feature_cols=cols,
            embargo=embargo,
            seed=42,
            **FAST_KW,
        )
        assert len(lgb_idx) > 0
        assert np.array_equal(lgb_idx, xgb_idx)

    @pytest.mark.integration
    def test_embargoed_rows_are_excluded_from_oof(self, separable_dataset) -> None:
        X, y, cols = separable_dataset
        embargo = 20
        *_, oof_idx = _lgb_cv(X, y, cols, embargo)

        fold_size = len(X) // (DEFAULT_N_CV_FOLDS + 2)
        forbidden: set[int] = set()
        for fold in range(DEFAULT_N_CV_FOLDS):
            tr_end = fold_size * (fold + 2)
            forbidden.update(range(tr_end, tr_end + embargo))
        assert forbidden, "test would be vacuous with an empty embargo window"
        assert not (set(oof_idx.tolist()) & forbidden)

    @pytest.mark.unit
    def test_boosting_budget_matches_the_xgboost_stage(self) -> None:
        from mltrain.cv import DEFAULT_EARLY_STOPPING, DEFAULT_NUM_BOOST_ROUND

        assert (LGB_BOOST_ROUND, LGB_EARLY_STOPPING) == (
            DEFAULT_NUM_BOOST_ROUND,
            DEFAULT_EARLY_STOPPING,
        )


class TestTrainAndCalibrate:
    @pytest.fixture
    def trained(self, separable_dataset):
        X, y, cols = separable_dataset
        split = 450
        model = train_final_lgb(
            X[:split],
            y[:split],
            None,
            X[split:],
            y[split:],
            default_lgb_params(),
            feature_cols=cols,
            **FAST_KW,
        )
        return model, X, y, cols, split

    @pytest.mark.integration
    def test_browser_traversal_reproduces_the_booster_raw_score(self, trained) -> None:
        model, X, y, _, split = trained
        scores = evaluate_lgb(model, X[split:], y[split:])
        trees = model.dump_model()["tree_info"][: scores.n_trees]
        init = compute_init_score(np.array([0, 1]), None)
        max_diff = verify_browser_inference(model, trees, init, X[split:])
        # `init` is 0.0 here, so any gap is pure traversal disagreement.
        assert max_diff < 1e-6

    @pytest.mark.integration
    def test_calibration_is_skipped_without_enough_oof_margins(self, trained) -> None:
        model, X, y, _, split = trained
        cal = fit_lgb_platt(
            model, X[split:], y[split:], np.zeros(10), np.zeros(10, dtype=int), raw_auc=0.9
        )
        assert (cal.fitted, cal.kept, cal.a, cal.b) == (False, False, 1.0, 0.0)
        # on_logits stays True: the identity transform of a raw margin is still
        # a logit-space transform, and the browser must treat it as one.
        assert cal.on_logits is True

    @pytest.mark.integration
    def test_calibration_that_hurts_auc_is_discarded(self, trained) -> None:
        model, X, y, _, split = trained
        margins = np.linspace(-3, 3, 300)
        labels = (margins < 0).astype(int)  # inverted: fitting this wrecks AUC
        cal = fit_lgb_platt(model, X[split:], y[split:], margins, labels, raw_auc=0.99)
        assert cal.fitted is True
        assert cal.kept is False
        assert (cal.a, cal.b) == (1.0, 0.0)
