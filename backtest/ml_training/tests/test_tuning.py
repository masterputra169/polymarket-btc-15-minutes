"""Unit tests for mltrain.tuning — the hyperparameter search.

The search is where the pipeline's RNG contract lives. Optuna's TPE sampler is
constructed with an explicit seed and the 8 hand-tuned configs are enqueued
BEFORE `optimize`, so trials 0..7 must replay `configs.seed_configs()` in order
and only later trials may be sampled. If that prefix or the seed ever shifts, a
rerun trains a different model from identical inputs — so it is pinned here.

The CV is stubbed: these tests are about which candidates get evaluated and
which one wins, not about how well any of them scores.
"""

from __future__ import annotations

from typing import Any

import numpy as np
import pytest

from mltrain.configs import SEED_CONFIG_KEYS, seed_configs
from mltrain.tuning import search_hyperparameters

pytestmark = pytest.mark.unit

optuna = pytest.importorskip("optuna")

X = np.zeros((10, 3), dtype=np.float32)
Y = np.zeros(10, dtype=np.int32)


def _recording_cv(seen: list[dict[str, Any]], score=lambda cfg: 0.5):
    """CV stand-in that records every config it is asked to evaluate."""

    def cv_fn(X_tr, y_tr, cfg, w_tr, feat_weights=None):
        seen.append(dict(cfg))
        return score(cfg), 0.6

    return cv_fn


def _search(cv_fn, **overrides):
    kwargs = dict(
        cv_fn=cv_fn,
        feat_weights=None,
        use_optuna=False,
        n_trials=10,
        seed=42,
        n_folds=5,
        log=lambda *a, **k: None,
    )
    kwargs.update(overrides)
    return search_hyperparameters(X, Y, None, **kwargs)


class TestGridSearch:
    def test_evaluates_every_seed_config_in_order(self) -> None:
        seen: list[dict[str, Any]] = []
        _search(_recording_cv(seen))
        assert [cfg["max_depth"] for cfg in seen] == [
            cfg["max_depth"] for cfg in seed_configs().values()
        ]

    def test_winner_is_the_highest_cv_auc(self) -> None:
        # Score peaks on the deepest config, B_deeper (max_depth 7).
        result = _search(_recording_cv([], score=lambda cfg: cfg["max_depth"] / 10))
        assert result.name == "B_deeper"
        assert result.cv_auc == pytest.approx(0.7)
        assert result.cv_acc == pytest.approx(0.6)
        assert result.n_trials is None

    def test_ties_break_on_declared_order(self) -> None:
        result = _search(_recording_cv([]))  # every config scores 0.5
        assert result.name == "A_balanced"

    def test_returns_the_shared_immutable_config(self) -> None:
        result = _search(_recording_cv([]))
        with pytest.raises(TypeError):
            result.config["max_depth"] = 99

    def test_feature_weights_reach_the_cv(self) -> None:
        received: list[Any] = []

        def cv_fn(X_tr, y_tr, cfg, w_tr, feat_weights=None):
            received.append(feat_weights)
            return 0.5, 0.5

        fw = np.ones(3, dtype=np.float32)
        _search(cv_fn, feat_weights=fw)
        assert all(w is fw for w in received)


class TestOptunaSearch:
    def test_first_eight_trials_replay_the_seed_configs(self) -> None:
        seen: list[dict[str, Any]] = []
        result = _search(
            _recording_cv(seen, score=lambda cfg: cfg["max_depth"] / 10),
            use_optuna=True,
            n_trials=10,
        )
        expected = [{k: cfg[k] for k in SEED_CONFIG_KEYS} for cfg in seed_configs().values()]
        assert seen[:8] == expected
        assert len(seen) == 10, "the remaining trials must be TPE-sampled"
        assert result.n_trials == 10
        assert result.name.startswith("Optuna_trial_")

    def test_same_seed_reproduces_the_sampled_trials(self) -> None:
        runs = []
        for _ in range(2):
            seen: list[dict[str, Any]] = []
            _search(
                _recording_cv(seen, score=lambda cfg: cfg["learning_rate"]),
                use_optuna=True,
                n_trials=10,
            )
            runs.append(seen[8:])
        assert runs[0] == runs[1], "TPESampler(seed=...) must be reproducible"

    def test_cv_acc_is_absent_on_the_optuna_path(self) -> None:
        # The objective maximizes AUC only; no accuracy is recorded per trial.
        result = _search(_recording_cv([]), use_optuna=True, n_trials=8)
        assert result.cv_acc is None
        assert result.cv_auc == pytest.approx(0.5)

    def test_degenerate_cv_scores_as_random_chance(self) -> None:
        # NaN or zero AUC must become 0.5, never propagate into the study.
        result = _search(
            _recording_cv([], score=lambda cfg: float("nan")), use_optuna=True, n_trials=8
        )
        assert result.cv_auc == pytest.approx(0.5)
