"""The 8 hand-tuned XGBoost seed configurations and the shared boosting budget.

These configs are the search prior. With --tune they are enqueued into Optuna so
the TPE sampler starts from known-decent corners of the space instead of random
ones; without --tune they ARE the search (grid over 8 points). Either way the
exact numbers below decide which trials Optuna evaluates first, so editing one
changes the sampled sequence and therefore the trained model — they are frozen
defaults, not tunables.

The mapping is exposed read-only (MappingProxyType, values included) because the
same dict is handed to the tuner, spread into the final booster params and read
again when the winner is reported: a caller that mutated it in place would
silently retrain a different model than the one it named.

NUM_BOOST_ROUND / EARLY_STOPPING / N_CV_FOLDS live here too — CV, the final fit
and the pruned retrain must all agree on the budget, and mltrain/cv.py carries
its own copies only as defaults for standalone use.
"""

from __future__ import annotations

from collections.abc import Mapping
from types import MappingProxyType

NUM_BOOST_ROUND = 1200
EARLY_STOPPING = 80
N_CV_FOLDS = 5

# --- 8 Seed Configurations ---
_SEED_CONFIGS: Mapping[str, Mapping[str, float]] = MappingProxyType(
    {
        "A_balanced": MappingProxyType(
            {
                "max_depth": 5,
                "learning_rate": 0.05,
                "subsample": 0.8,
                "colsample_bytree": 0.8,
                "min_child_weight": 5,
                "gamma": 0.1,
                "reg_alpha": 0.1,
                "reg_lambda": 1.0,
            }
        ),
        "B_deeper": MappingProxyType(
            {
                "max_depth": 7,
                "learning_rate": 0.03,
                "subsample": 0.75,
                "colsample_bytree": 0.7,
                "min_child_weight": 3,
                "gamma": 0.05,
                "reg_alpha": 0.05,
                "reg_lambda": 0.8,
            }
        ),
        "C_wider": MappingProxyType(
            {
                "max_depth": 5,
                "learning_rate": 0.08,
                "subsample": 0.85,
                "colsample_bytree": 0.9,
                "min_child_weight": 7,
                "gamma": 0.15,
                "reg_alpha": 0.2,
                "reg_lambda": 1.5,
            }
        ),
        "D_shallow_fast": MappingProxyType(
            {
                "max_depth": 4,
                "learning_rate": 0.10,
                "subsample": 0.9,
                "colsample_bytree": 0.85,
                "min_child_weight": 10,
                "gamma": 0.2,
                "reg_alpha": 0.3,
                "reg_lambda": 2.0,
            }
        ),
        "E_deep_slow": MappingProxyType(
            {
                "max_depth": 6,
                "learning_rate": 0.02,
                "subsample": 0.7,
                "colsample_bytree": 0.75,
                "min_child_weight": 4,
                "gamma": 0.08,
                "reg_alpha": 0.1,
                "reg_lambda": 1.2,
            }
        ),
        "F_aggressive": MappingProxyType(
            {
                "max_depth": 5,
                "learning_rate": 0.12,
                "subsample": 0.85,
                "colsample_bytree": 0.95,
                "min_child_weight": 5,
                "gamma": 0.05,
                "reg_alpha": 0.05,
                "reg_lambda": 0.5,
            }
        ),
        "G_regularized": MappingProxyType(
            {
                "max_depth": 5,
                "learning_rate": 0.06,
                "subsample": 0.8,
                "colsample_bytree": 0.8,
                "min_child_weight": 8,
                "gamma": 0.25,
                "reg_alpha": 0.5,
                "reg_lambda": 3.0,
            }
        ),
        "H_wide_shallow": MappingProxyType(
            {
                "max_depth": 3,
                "learning_rate": 0.15,
                "subsample": 0.9,
                "colsample_bytree": 0.95,
                "min_child_weight": 12,
                "gamma": 0.3,
                "reg_alpha": 0.4,
                "reg_lambda": 2.5,
            }
        ),
    }
)

# The 8 hyperparameters every seed config carries; also the exact key set the
# Optuna objective suggests, so enqueued trials line up with sampled ones.
SEED_CONFIG_KEYS: tuple[str, ...] = (
    "max_depth",
    "learning_rate",
    "subsample",
    "colsample_bytree",
    "min_child_weight",
    "gamma",
    "reg_alpha",
    "reg_lambda",
)


def seed_configs() -> Mapping[str, Mapping[str, float]]:
    """Return the 8 hand-tuned seed configs as an immutable mapping.

    Insertion order (A_balanced ... H_wide_shallow) is meaningful: it is the
    order Optuna enqueues them in, and `max()` over grid CV AUCs breaks ties on
    it, so the winner of a tied grid search is the earlier letter.
    """
    return _SEED_CONFIGS
