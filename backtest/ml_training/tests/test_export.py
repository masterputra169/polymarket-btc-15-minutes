"""Unit tests for mltrain.export and mltrain.report — the browser contract.

xgboost_model.json and norm_browser.json are read by src/engines/Mlpredictor.ts
(by field name) and gated on by bot/src/autoRetrain.ts (by metric name), and
norm_browser.json's `means`/`stds`/`feature_names` are consumed POSITIONALLY.
So the properties worth pinning are: the three normaliser arrays agree in
length and order with the model's feature names, the exported key order does
not drift, and the deploy-gate metric names all survive.
"""

from __future__ import annotations

import json

import numpy as np
import pytest

from mltrain.export import (
    ENGINEERED_FEATURE_SPECS,
    SIGNAL_FEATURE_MAP,
    ValidationInfo,
    XgbEvalMetrics,
    build_browser_model,
    build_metrics_block,
    build_norm_export,
    compute_signal_modifiers,
    dump_browser_trees,
)
from mltrain.report import build_training_report

pytestmark = pytest.mark.unit

FEATURE_COLS = ["delta_1m_pct", "rsi_norm", "macd_hist", "vwap_dist", "delta_1m_capped"]
BASE_COLS = FEATURE_COLS[:4]
ENGINEERED = FEATURE_COLS[4:]


class _FakeBooster:
    """Stand-in for an xgboost Booster: only the dump API is exercised here."""

    def __init__(self, n_trees: int, best_iteration: int) -> None:
        self._trees = [json.dumps({"nodeid": 0, "leaf": float(i)}) for i in range(n_trees)]
        self.best_iteration = best_iteration

    def get_dump(self, dump_format: str = "json") -> list[str]:
        assert dump_format == "json"
        return self._trees


def _metrics(**overrides) -> XgbEvalMetrics:
    base = dict(
        accuracy=0.7712345,
        auc=0.8643219,
        f1=0.7512345,
        logloss=0.4912345,
        brier=0.1612345,
        calibration={"ece": 0.0451234, "mce": 0.1234567, "bins": [{"count": 3}]},
        high_conf_accuracy=0.912345,
        high_conf_ratio=31.4159,
        high_conf_count=421,
        high_conf_threshold=0.68,
        cv_auc=0.8412345,
        cv_acc=0.7512345,
        cv_test_acc_gap=0.02,
        cv_test_auc_gap=0.0231,
        holdout_accuracy=0.7412345,
        holdout_auc=0.8312345,
        test_holdout_acc_gap=0.03,
        test_holdout_auc_gap=0.0331,
        test_samples=1234,
        holdout_samples=567,
        confidence_buckets=[{"count": 7}],
    )
    base.update(overrides)
    return XgbEvalMetrics(**base)


def _validation() -> ValidationInfo:
    return ValidationInfo(
        test_size=0.15,
        holdout_frac=0.125,
        strict_holdout=True,
        threshold_source="oof_cv",
        calibration_eval_source="holdout",
        test_samples=1234,
        holdout_samples=567,
    )


def _browser_model(**overrides) -> dict:
    kwargs = dict(
        feature_cols=FEATURE_COLS,
        feature_cols_orig=BASE_COLS,
        engineered_features=ENGINEERED,
        best_iteration=41,
        optimal_threshold=0.68,
        platt_a=1.04,
        platt_b=0.02,
        platt_on_logits=True,
        pruned_features=["macd_hist"],
        pre_excluded_features=["funding_rate_change"],
        zero_features=[],
        recency_enabled=False,
        recency_halflife=90,
        signal_modifiers={"rsi": 1.2},
        phase_thresholds=None,
        params={"objective": "binary:logistic", "max_depth": 5},
        use_optuna=True,
        validation=_validation(),
        metrics=_metrics(),
    )
    kwargs.update(overrides)
    return build_browser_model([{"nodeid": 0}], **kwargs)


class TestSignalModifiers:
    def test_every_signal_key_is_emitted(self) -> None:
        mods = compute_signal_modifiers({"rsi_norm": 100.0})
        assert set(mods) == set(SIGNAL_FEATURE_MAP)

    def test_mean_is_normalised_to_about_one(self) -> None:
        # Equal gain PER SIGNAL must leave the rule engine's hand-tuned
        # weights untouched (modifier 1.0 everywhere).
        importance = {
            feat: 12.0 / len(feats) for feats in SIGNAL_FEATURE_MAP.values() for feat in feats
        }
        mods = compute_signal_modifiers(importance)
        assert all(m == pytest.approx(1.0, abs=1e-9) for m in mods.values())
        assert np.mean(list(mods.values())) == pytest.approx(1.0, abs=1e-9)

    def test_values_are_clamped_to_the_documented_band(self) -> None:
        # A single dominant feature must not switch the rule engine off.
        mods = compute_signal_modifiers({"ptb_dist_pct": 1e9})
        assert min(mods.values()) >= 0.3
        assert max(mods.values()) <= 3.0

    def test_empty_importance_survives_the_zero_mean_guard(self) -> None:
        mods = compute_signal_modifiers({})
        assert set(mods) == set(SIGNAL_FEATURE_MAP)
        assert all(m == 0.3 for m in mods.values())

    def test_values_are_rounded_for_export(self) -> None:
        mods = compute_signal_modifiers({"rsi_norm": 7.0, "macd_hist": 3.0})
        assert all(m == round(m, 2) for m in mods.values())


class TestDumpBrowserTrees:
    def test_slices_at_the_early_stopped_iteration(self) -> None:
        trees = dump_browser_trees(_FakeBooster(100, best_iteration=41))
        assert len(trees.all_trees) == 100
        assert len(trees.best_trees) == 42  # best_iteration is inclusive

    def test_rejected_rounds_are_not_exported(self) -> None:
        trees = dump_browser_trees(_FakeBooster(10, best_iteration=3))
        assert [t["leaf"] for t in trees.best_trees] == [0.0, 1.0, 2.0, 3.0]


class TestMetricsBlock:
    def test_deploy_gate_field_names_are_all_present(self) -> None:
        block = build_metrics_block(_metrics())
        for name in (
            "accuracy",
            "auc",
            "brier",
            "calibration_ece",
            "calibration_mce",
            "high_conf_accuracy",
            "high_conf_ratio",
            "cv_test_acc_gap",
            "holdout_accuracy",
            "test_holdout_acc_gap",
        ):
            assert name in block

    def test_key_order_is_stable(self) -> None:
        # Key order is part of the exported bytes, which the deploy checksum sees.
        assert list(build_metrics_block(_metrics())) == [
            "accuracy",
            "auc",
            "f1",
            "logloss",
            "brier",
            "calibration_ece",
            "calibration_mce",
            "high_conf_accuracy",
            "high_conf_ratio",
            "high_conf_count",
            "high_conf_threshold",
            "cv_auc",
            "cv_acc",
            "cv_test_acc_gap",
            "cv_test_auc_gap",
            "holdout_accuracy",
            "holdout_auc",
            "test_holdout_acc_gap",
            "test_holdout_auc_gap",
            "test_samples",
            "holdout_samples",
            "confidence_buckets",
            "calibration_bins",
        ]

    def test_rounding_matches_the_gates_the_bot_compares_against(self) -> None:
        block = build_metrics_block(_metrics())
        assert block["accuracy"] == 0.7712
        assert block["auc"] == 0.8643
        assert block["high_conf_ratio"] == 31.42

    def test_absent_holdout_exports_null_not_zero(self) -> None:
        block = build_metrics_block(
            _metrics(
                holdout_accuracy=None,
                holdout_auc=None,
                test_holdout_acc_gap=None,
                test_holdout_auc_gap=None,
            )
        )
        assert block["holdout_accuracy"] is None
        assert block["test_holdout_auc_gap"] is None

    def test_block_is_json_serialisable(self) -> None:
        json.dumps(build_metrics_block(_metrics()))


class TestBrowserModel:
    def test_top_level_key_order_is_stable(self) -> None:
        assert list(_browser_model()) == [
            "format",
            "version",
            "num_features",
            "num_trees",
            "feature_names",
            "original_features",
            "engineered_features",
            "best_iteration",
            "optimal_threshold",
            "platt_a",
            "platt_b",
            "platt_on_logits",
            "pruned_features",
            "pre_excluded_features",
            "zero_features",
            "recency_weighting",
            "signal_modifiers",
            "phase_thresholds",
            "params",
            "training_method",
            "validation",
            "metrics",
            "trees",
        ]

    def test_num_features_matches_the_exported_feature_names(self) -> None:
        model = _browser_model()
        assert model["num_features"] == len(model["feature_names"]) == len(FEATURE_COLS)
        assert model["original_features"] == len(BASE_COLS)

    def test_num_trees_comes_from_the_sliced_list(self) -> None:
        assert _browser_model()["num_trees"] == 1

    def test_params_are_stringified_for_the_browser(self) -> None:
        assert _browser_model()["params"] == {"objective": "binary:logistic", "max_depth": "5"}

    def test_recency_block_is_null_when_disabled(self) -> None:
        assert _browser_model()["recency_weighting"] is None
        enabled = _browser_model(recency_enabled=True, recency_halflife=90)
        assert enabled["recency_weighting"] == {"enabled": True, "halflife_days": 90}

    def test_training_method_tracks_the_search_used(self) -> None:
        assert _browser_model()["training_method"] == "optuna"
        assert _browser_model(use_optuna=False)["training_method"] == "grid_search"

    def test_validation_records_where_selection_happened(self) -> None:
        validation = _browser_model()["validation"]
        assert validation["split"] == "temporal"
        assert validation["threshold_source"] == "oof_cv"
        assert validation["calibration_eval_source"] == "holdout"

    def test_model_is_json_serialisable(self) -> None:
        json.dumps(_browser_model())


class TestNormExport:
    def _norm(self, **overrides) -> dict:
        kwargs = dict(
            feature_cols=FEATURE_COLS,
            feature_cols_orig=BASE_COLS,
            platt_a=1.04,
            platt_b=0.02,
            platt_on_logits=True,
            pruned_features=[],
            signal_modifiers={"rsi": 1.2},
            phase_thresholds=None,
            holdout_frac=0.125,
            holdout_start_idx=900,
        )
        kwargs.update(overrides)
        X = np.arange(50 * len(FEATURE_COLS), dtype=np.float32).reshape(50, len(FEATURE_COLS))
        return build_norm_export(kwargs.pop("X", X), **kwargs)

    def test_normaliser_arrays_agree_with_the_feature_names(self) -> None:
        # means/stds/feature_names are consumed POSITIONALLY in the browser: a
        # length disagreement silently normalises the wrong column.
        norm = self._norm()
        assert len(norm["means"]) == len(norm["stds"]) == len(norm["feature_names"])
        assert norm["num_features"] == len(norm["feature_names"])
        assert norm["feature_names"] == FEATURE_COLS

    def test_constant_columns_get_a_unit_std_not_zero(self) -> None:
        X = np.ones((20, len(FEATURE_COLS)), dtype=np.float32)
        norm = self._norm(X=X)
        assert all(s == 1.0 for s in norm["stds"])

    def test_means_and_stds_come_from_the_supplied_block(self) -> None:
        X = np.vstack(
            [np.zeros((10, len(FEATURE_COLS))), np.full((10, len(FEATURE_COLS)), 4.0)]
        ).astype(np.float32)
        norm = self._norm(X=X)
        assert norm["means"] == pytest.approx([2.0] * len(FEATURE_COLS))
        assert norm["stds"] == pytest.approx([2.0] * len(FEATURE_COLS))
        assert norm["train_samples"] == 20

    def test_key_order_is_stable(self) -> None:
        assert list(self._norm()) == [
            "version",
            "means",
            "stds",
            "feature_names",
            "num_features",
            "original_features",
            "platt_a",
            "platt_b",
            "platt_on_logits",
            "pruned_features",
            "engineered_feature_specs",
            "signal_modifiers",
            "phase_thresholds",
            "train_samples",
            "holdout_frac",
            "holdout_start_idx",
        ]

    def test_every_engineered_feature_has_a_written_down_spec(self) -> None:
        # The specs are the reference the TS re-implementation is checked
        # against, so a new engineered feature must not slip through unspecified.
        from mltrain.features import engineer_features

        base = [
            "delta_1m_pct",
            "delta_3m_pct",
            "rsi_norm",
            "rsi_slope",
            "vwap_dist",
            "vwap_slope",
            "macd_line",
            "macd_hist",
            "vol_ratio_norm",
            "multi_tf_agreement",
            "bb_percent_b",
            "bb_squeeze",
            "atr_pct_norm",
            "vol_delta_buy_ratio",
            "ema_cross_signal",
            "ema_dist_norm",
            "stoch_k_norm",
            "ha_signed_consec",
            "regime_trending",
            "regime_confidence",
            "regime_mean_reverting",
            "ha_is_green",
            "market_price_momentum",
            "orderbook_imbalance",
            "crowd_model_divergence",
            "rule_confidence",
        ]
        _, cols = engineer_features(np.zeros((4, len(base)), dtype=np.float32), base)
        engineered = cols[len(base) :]
        assert set(engineered) == set(ENGINEERED_FEATURE_SPECS)

    def test_norm_is_json_serialisable(self) -> None:
        json.dumps(self._norm())


class TestTrainingReport:
    def _report(self, **overrides) -> list[str]:
        kwargs = dict(
            use_optuna=True,
            tune_trials=150,
            winner="Optuna_trial_7",
            threshold=0.68,
            n_trees=42,
            feature_cols=FEATURE_COLS,
            feature_cols_orig=BASE_COLS,
            engineered_features=ENGINEERED,
            platt_a=1.04,
            platt_b=0.02,
            pruned_features=["macd_hist"],
            zero_features=[],
            pre_excluded_features=["funding_rate_change"],
            recency_enabled=False,
            recency_halflife=90,
            cv_folds=5,
            num_boost_round=1200,
            early_stopping=80,
            params={"objective": "binary:logistic", "max_depth": 5, "seed": 42},
        )
        kwargs.update(overrides)
        metrics = kwargs.pop("metrics", _metrics())
        return build_training_report(metrics, **kwargs)

    def test_quotes_the_same_numbers_as_the_metrics_block(self) -> None:
        report = "\n".join(self._report())
        assert "Accuracy: 77.12% | AUC: 0.8643" in report
        assert "Threshold: 0.680 | Trees: 42" in report

    def test_feature_counts_reconcile(self) -> None:
        report = "\n".join(self._report())
        assert (
            f"Features: {len(FEATURE_COLS)} ({len(BASE_COLS)} base + {len(ENGINEERED)} engineered)"
            in report
        )

    def test_missing_holdout_gap_keeps_the_line_shape(self) -> None:
        report = "\n".join(self._report(metrics=_metrics(test_holdout_acc_gap=None)))
        assert "test-holdout acc=+0.00pp" in report

    def test_noise_params_are_stripped_from_the_dump(self) -> None:
        report = "\n".join(self._report())
        assert '"max_depth": 5' in report
        assert "objective" not in report.split("Params:")[1]
        assert '"seed"' not in report

    def test_grid_search_run_is_labelled_as_such(self) -> None:
        assert "Method: Grid search (8 configs)" in self._report(use_optuna=False)[1]
        assert "Method: Optuna (150 trials)" in self._report()[1]
