"""Section 5's hyperparameter search: Optuna TPE, or a grid over the seed configs.

Both branches score candidates with the SAME embargoed walk-forward CV the rest
of the pipeline uses (injected as `cv_fn`), so the winner is chosen on the same
honest out-of-fold metric the deploy gates later read — never on the test split
and never on the strict OOS holdout.

RNG contract (the reason this module takes `seed` explicitly rather than reading
a global): the TPE sampler is constructed with `TPESampler(seed=seed)` and the 8
seed configs are enqueued BEFORE `study.optimize`, so trials 0..7 replay the
hand-tuned corners in `configs.seed_configs()` order and only later trials are
sampled. Constructing the sampler earlier or later, or enqueueing after
optimize, changes which hyperparameters are evaluated and therefore the trained
model. LightGBM's study is seeded with `seed + 1` at its own call site so the
two searches do not replay one another's sequence.

Pure orchestration: no module-level state, no stdout of its own — every line the
trainer prints is emitted through the injected `log` callable so the entrypoint
keeps ownership of the console.
"""

from __future__ import annotations

import json
from collections.abc import Callable, Mapping
from dataclasses import dataclass

import numpy as np

from mltrain.configs import SEED_CONFIG_KEYS, seed_configs


@dataclass(frozen=True)
class SearchResult:
    """Winning hyperparameters plus the CV numbers that picked them.

    `cv_acc` is None on the Optuna path: the objective maximizes AUC only, so no
    accuracy is recorded for the best trial (section 7's calibration CV
    recomputes both against the winner anyway). `n_trials` is None on the grid
    path, where there are no trials — only the 8 fixed configs.
    """
    config: Mapping[str, float]
    name: str
    cv_auc: float
    cv_acc: float | None
    n_trials: int | None


def search_hyperparameters(X_train: np.ndarray, y_train: np.ndarray,
                           w_train: np.ndarray | None,
                           *,
                           cv_fn: Callable[..., tuple],
                           feat_weights: np.ndarray | None,
                           use_optuna: bool,
                           n_trials: int,
                           seed: int,
                           n_folds: int,
                           log: Callable[..., None] = print) -> SearchResult:
    """Pick the XGBoost hyperparameters, by Optuna when available or by grid.

    Args:
        X_train, y_train: the TUNE subset — the holdout was already carved off
            upstream, so neither branch can see it.
        w_train: per-sample weights aligned to X_train (None = uniform).
        cv_fn: walk-forward CV bound to this run (cfg -> (mean_auc, mean_acc)).
        feat_weights: per-feature weights applied inside CV (None = all active).
            Pre-excluded columns are zeroed here so the search can never buy CV
            accuracy from a feature that is constant at inference time.
        use_optuna: True only when --tune was passed AND optuna imported.
        n_trials: Optuna trial budget (ignored on the grid path).
        seed: TPE sampler seed — see the RNG contract in the module docstring.
        n_folds: CV folds, reported in the section header.
        log: sink for the section's console lines (the trainer's `print`).

    Returns:
        SearchResult carrying the winning config, its name and CV metrics.
    """
    configs = seed_configs()

    if use_optuna:
        # --- Optuna Bayesian Optimization ---
        # Imported lazily: the entrypoint already probed availability (and set
        # the log verbosity), and the grid path must stay importable without it.
        import optuna

        log(f"[5/8] Optuna optimization ({n_trials} trials, {n_folds}-fold CV)...")

        def objective(trial) -> float:
            cfg = {
                'max_depth': trial.suggest_int('max_depth', 3, 7),
                'learning_rate': trial.suggest_float('learning_rate', 0.008, 0.2, log=True),
                'subsample': trial.suggest_float('subsample', 0.6, 0.95),
                'colsample_bytree': trial.suggest_float('colsample_bytree', 0.5, 0.95),
                'min_child_weight': trial.suggest_int('min_child_weight', 2, 15),
                'gamma': trial.suggest_float('gamma', 0.0, 0.5),
                'reg_alpha': trial.suggest_float('reg_alpha', 1e-3, 2.0, log=True),
                'reg_lambda': trial.suggest_float('reg_lambda', 0.3, 6.0),
            }
            cv_auc, _ = cv_fn(X_train, y_train, cfg, w_train, feat_weights=feat_weights)
            if np.isnan(cv_auc) or cv_auc == 0:
                return 0.5  # random chance — bad trial but not NaN
            return cv_auc

        study = optuna.create_study(
            direction='maximize',
            sampler=optuna.samplers.TPESampler(seed=seed),
        )

        # Seed with 8 hand-tuned configs so Optuna starts smart
        for name, cfg in configs.items():
            study.enqueue_trial({key: cfg[key] for key in SEED_CONFIG_KEYS})

        study.optimize(objective, n_trials=n_trials, show_progress_bar=True)

        best_cfg = study.best_trial.params
        best_cfg_name = f"Optuna_trial_{study.best_trial.number}"
        log(f"   Best trial #{study.best_trial.number}: CV AUC = {study.best_value:.4f}")
        log(f"   Params: {json.dumps({k: round(v,4) if isinstance(v,float) else v for k,v in best_cfg.items()})}")

        # Show top 5 trials
        log(f"\n   Top 5 trials:")
        trials_sorted = sorted(study.trials, key=lambda t: t.value if t.value is not None else 0, reverse=True)
        for t in trials_sorted[:5]:
            log(f"     #{t.number}: AUC={t.value:.4f} | depth={t.params.get('max_depth')} lr={t.params.get('learning_rate',0):.4f} lambda={t.params.get('reg_lambda',0):.2f}")

        return SearchResult(config=best_cfg, name=best_cfg_name,
                            cv_auc=float(study.best_value), cv_acc=None,
                            n_trials=len(study.trials))

    # --- Grid Search (8 fixed configs) ---
    log(f"[5/8] Training 8 configs with {n_folds}-fold walk-forward CV...")

    cv_results = {}
    for name, cfg in configs.items():
        cv_auc, cv_acc = cv_fn(X_train, y_train, cfg, w_train, feat_weights=feat_weights)
        cv_results[name] = {'auc': cv_auc, 'acc': cv_acc}
        log(f"   {name}: CV acc={cv_acc*100:.1f}% | CV AUC={cv_auc:.4f}")

    # Pick best by CV AUC
    best_cfg_name = max(cv_results, key=lambda n: cv_results[n]['auc'])
    best_cfg = configs[best_cfg_name]
    log(f"\n   >>> Best config: {best_cfg_name} (CV AUC={cv_results[best_cfg_name]['auc']:.4f})")

    return SearchResult(config=best_cfg, name=best_cfg_name,
                        cv_auc=cv_results[best_cfg_name]['auc'],
                        cv_acc=cv_results[best_cfg_name]['acc'],
                        n_trials=None)
