"""Unit tests for mltrain.configs — the 8 hand-tuned seed configs.

These configs are not decoration: with --tune they are the first 8 trials Optuna
evaluates, so their values and their ORDER decide which region of the search
space the TPE sampler models before it starts sampling. A caller that mutated
the shared mapping in place (say, injecting scale_pos_weight before training)
would silently change every later run in the same process. The immutability
assertions below are the guard against that.
"""

from __future__ import annotations

import pytest

from mltrain.configs import (
    EARLY_STOPPING,
    N_CV_FOLDS,
    NUM_BOOST_ROUND,
    SEED_CONFIG_KEYS,
    seed_configs,
)

pytestmark = pytest.mark.unit

EXPECTED_NAMES = (
    'A_balanced', 'B_deeper', 'C_wider', 'D_shallow_fast',
    'E_deep_slow', 'F_aggressive', 'G_regularized', 'H_wide_shallow',
)


class TestSeedConfigContents:
    def test_exactly_eight_configs_in_declared_order(self) -> None:
        # Order is the Optuna enqueue order and the grid tie-break order.
        assert tuple(seed_configs().keys()) == EXPECTED_NAMES

    def test_every_config_carries_the_same_hyperparameter_keys(self) -> None:
        # Enqueued trials must line up with what the objective suggests; a
        # missing or extra key would make Optuna reject the enqueued trial.
        for name, cfg in seed_configs().items():
            assert tuple(cfg.keys()) == SEED_CONFIG_KEYS, name

    def test_integer_hyperparameters_stay_integers(self) -> None:
        # suggest_int enqueues must not receive floats, and the exported
        # params block would otherwise serialise 5.0 where the bot expects 5.
        for name, cfg in seed_configs().items():
            assert isinstance(cfg['max_depth'], int), name
            assert isinstance(cfg['min_child_weight'], int), name

    def test_boosting_budget_constants(self) -> None:
        # CV, the final fit and the pruned retrain must share one budget.
        assert (NUM_BOOST_ROUND, EARLY_STOPPING, N_CV_FOLDS) == (1200, 80, 5)


class TestSeedConfigImmutability:
    def test_top_level_mapping_rejects_assignment(self) -> None:
        with pytest.raises(TypeError):
            seed_configs()['A_balanced'] = {}

    def test_top_level_mapping_rejects_deletion(self) -> None:
        with pytest.raises(TypeError):
            del seed_configs()['A_balanced']

    def test_individual_configs_reject_assignment(self) -> None:
        with pytest.raises(TypeError):
            seed_configs()['A_balanced']['max_depth'] = 99

    def test_repeated_calls_share_the_same_untouched_defaults(self) -> None:
        first = seed_configs()
        # A caller that copies is free to mutate its copy; the shared default
        # must be unaffected.
        mutable_copy = dict(first['B_deeper'])
        mutable_copy['max_depth'] = 99
        assert seed_configs()['B_deeper']['max_depth'] == 7

    def test_configs_are_spreadable_into_booster_params(self) -> None:
        # The trainer builds final_params with **best_cfg; a read-only mapping
        # must still spread into a plain dict.
        params = {'objective': 'binary:logistic', **seed_configs()['A_balanced']}
        assert params['max_depth'] == 5
        assert params['objective'] == 'binary:logistic'
