"""Contract tests: the trained model JSON vs what the TypeScript bot reads.

The Python trainer and the Node bot are coupled only by field NAMES inside
xgboost_model.json / lightgbm_model.json / norm_browser.json. A rename on the
Python side type-checks fine, trains fine, and then silently disables a deploy
gate (an undefined metric fails `isFiniteNumber` and the gate reports "missing")
or mis-loads the model in the browser. These tests read the gate names straight
out of bot/src/autoRetrain.ts so the contract cannot drift unnoticed.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

pytestmark = pytest.mark.contract

REPO_ROOT = Path(__file__).resolve().parents[3]
ML_DIR = REPO_ROOT / "public" / "ml"
AUTORETRAIN_TS = REPO_ROOT / "bot" / "src" / "autoRetrain.ts"

# Fields the browser predictor (src/engines/Mlpredictor.ts) needs to rebuild the model.
INFERENCE_FIELDS = ("feature_names", "optimal_threshold", "platt_a", "platt_b")


def _load(name: str) -> dict:
    path = ML_DIR / name
    if not path.exists():
        pytest.skip(f"{name} not deployed yet")
    return json.loads(path.read_text(encoding="utf-8"))


def _gate_fields() -> set[str]:
    """Metric names autoRetrain.ts reads off the model's `metrics` block."""
    if not AUTORETRAIN_TS.exists():
        pytest.skip("autoRetrain.ts not found")
    src = AUTORETRAIN_TS.read_text(encoding="utf-8")
    # `audit` is the fresh xgb metrics object; `ens` is the weighted ensemble.
    fields = set(re.findall(r"\baudit\.([a-z_]+)", src))
    fields |= set(re.findall(r"\bens\.([a-z_]+)", src))
    fields.discard("validation")  # nested object, asserted separately
    return fields


class TestGateContract:
    def test_gate_field_names_were_found(self) -> None:
        # Guards the regex itself: if it silently matched nothing, every other
        # assertion in this class would pass vacuously.
        assert len(_gate_fields()) >= 5

    def test_every_gate_metric_exists_in_xgboost_model(self) -> None:
        metrics = _load("xgboost_model.json").get("metrics", {})
        missing = sorted(f for f in _gate_fields() if f not in metrics)
        assert not missing, f"deploy gates read fields the trainer no longer exports: {missing}"

    def test_gate_metrics_are_finite_numbers(self) -> None:
        # autoRetrain's isFiniteNumber() check turns NaN/null into a failed gate.
        metrics = _load("xgboost_model.json").get("metrics", {})
        for field in sorted(_gate_fields()):
            value = metrics.get(field)
            assert isinstance(value, (int, float)), f"{field} is {value!r}, not numeric"
            assert value == value and abs(value) != float("inf"), f"{field} is not finite"

    def test_strict_holdout_flag_is_exported(self) -> None:
        # Read as d.validation?.strict_holdout — a missing block fails the gate.
        validation = _load("xgboost_model.json").get("validation")
        assert isinstance(validation, dict)
        assert isinstance(validation.get("strict_holdout"), bool)

    def test_lightgbm_exposes_the_ensemble_metrics(self) -> None:
        # readCurrentMetrics() weights xgb/lgb accuracy and auc together.
        metrics = _load("lightgbm_model.json").get("metrics", {})
        for field in ("accuracy", "auc"):
            assert isinstance(metrics.get(field), (int, float))


class TestEnsembleWeights:
    def test_weights_exist_and_are_normalised(self) -> None:
        weights = _load("norm_browser.json").get("ensemble_weights")
        assert isinstance(weights, dict), "norm_browser.json must carry ensemble_weights"
        assert set(weights) >= {"xgb", "lgb"}
        assert weights["xgb"] + weights["lgb"] == pytest.approx(1.0, abs=1e-6)

    def test_weights_are_within_unit_interval(self) -> None:
        weights = _load("norm_browser.json")["ensemble_weights"]
        assert all(0.0 <= weights[k] <= 1.0 for k in ("xgb", "lgb"))


class TestInferenceContract:
    def test_inference_fields_present(self) -> None:
        model = _load("xgboost_model.json")
        missing = [f for f in INFERENCE_FIELDS if f not in model]
        assert not missing, f"Mlpredictor.ts needs these fields: {missing}"

    def test_feature_names_match_normaliser_length(self) -> None:
        # norm_browser.json is positional: a length mismatch silently shifts
        # every feature at inference time.
        model = _load("xgboost_model.json")
        norm = _load("norm_browser.json")
        vector = norm.get("mean") or norm.get("means") or norm.get("mu")
        if vector is None:
            pytest.skip("normaliser layout has no recognised mean vector")
        assert len(model["feature_names"]) == len(vector)

    def test_threshold_is_a_valid_probability(self) -> None:
        threshold = _load("xgboost_model.json")["optimal_threshold"]
        assert 0.0 < threshold < 1.0
