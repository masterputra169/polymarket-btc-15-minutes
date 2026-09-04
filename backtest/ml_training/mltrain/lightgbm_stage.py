"""Section 9's LightGBM partner: tune, fit, calibrate, blend, export.

The deployed predictor is a weighted blend, so this stage is not an independent
second model: it trains on the same rows as the XGBoost half, early-stops on the
same strict OOS holdout, calibrates into the same Platt-on-logits space, and
then picks the blend weight on out-of-fold CV predictions rather than on the
holdout (multiple-testing fix, Sep 2026 — the holdout stays EVALUATION-only).
Sharing the fold arithmetic is what lets the weight sweep line the two models'
OOF rows up 1:1, which mltrain/sweeps.align_oof_predictions verifies rather than
assumes.

This stage also owns the two artifacts the browser reads for the LGB half:
lightgbm_model.json, and the ensemble block appended to norm_browser.json. Both
are contracts with src/engines/Mlpredictor.ts and bot/src/autoRetrain.ts, so
field names, values AND key order are load-bearing.

The number crunching lives in mltrain/lightgbm_train.py, the JSON assembly in
mltrain/lightgbm_export.py and the weight sweep in mltrain/sweeps.py; this
module is only the orchestration between them, with an injected `log` callable
so the trainer keeps ownership of stdout. `import lightgbm` happens transitively
through lightgbm_train, which is why the trainer imports this module from inside
its `if HAS_LGB:` guard — a missing lightgbm must still degrade to the
XGBoost-only branch.
"""

from __future__ import annotations

import json
import os
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import numpy as np
from sklearn.metrics import accuracy_score, brier_score_loss, log_loss, roc_auc_score

from mltrain.lightgbm_export import (
    build_lgb_browser_model,
    compute_init_score,
    verify_browser_inference,
)
from mltrain.lightgbm_train import (
    LGB_BOOST_ROUND,
    LGB_EARLY_STOPPING,
    LGB_OPTUNA_TRIALS,
    default_lgb_params,
    evaluate_lgb,
    fit_lgb_platt,
    lgb_walk_forward_cv,
    platt_probs,
    train_final_lgb,
    tune_lgb_params,
)
from mltrain.metrics import calibration_summary, safe_round
from mltrain.sweeps import align_oof_predictions, select_ensemble_weights


@dataclass(frozen=True)
class LightGbmStageResult:
    """What the trainer still needs once the stage has written its artifacts.

    The stage reports its own numbers through `log`; these fields exist so the
    entrypoint's closing summary can restate the LGB and ensemble headline
    metrics without recomputing (and possibly disagreeing with) them.
    `weight_source` names the split the blend weights were selected on —
    "oof_cv", or the "holdout"/"test" fallbacks kept for degenerate CV — and is
    the same string exported as ensemble_metrics.weight_source.
    """

    accuracy: float
    auc: float
    n_trees: int
    ensemble_accuracy: float
    ensemble_auc: float
    weight_xgb: float
    weight_lgb: float
    weight_source: str


def _resolve_lgb_params(
    X_train: np.ndarray,
    y_train: np.ndarray,
    w_train: np.ndarray | None,
    *,
    feature_cols: list[str],
    seed: int,
    embargo: int,
    n_folds: int,
    use_optuna: bool,
    log: Callable[..., None],
) -> dict[str, Any]:
    """Optuna-tuned LightGBM params, or the hand-tuned defaults.

    The study is scored by embargoed walk-forward CV AUC only (see
    mltrain/lightgbm_train.tune_lgb_params), so tuning never touches the holdout.
    """
    if use_optuna:
        log(f"   Optuna optimization ({LGB_OPTUNA_TRIALS} trials, {n_folds}-fold CV)...")
        # seed + 1: the LGB study must not replay the XGBoost study's trial sequence.
        lgb_tuning = tune_lgb_params(
            X_train,
            y_train,
            w_train,
            feature_cols=feature_cols,
            seed=seed + 1,
            embargo=embargo,
            n_folds=n_folds,
        )
        lgb_best_params = lgb_tuning.params
        log(f"   Best trial #{lgb_tuning.best_trial}: CV AUC = {lgb_tuning.best_value:.4f}")
        log(
            f"   Params: {json.dumps({k: round(v,4) if isinstance(v,float) else v for k,v in lgb_best_params.items() if k not in ['objective','metric','verbosity']})}"
        )
        return lgb_best_params

    # Default LightGBM params (no Optuna)
    lgb_best_params = default_lgb_params()
    log("   Using default LightGBM params (no Optuna)")
    return lgb_best_params


def _select_ensemble_weight(
    *,
    xgb_oof_margins: np.ndarray,
    lgb_oof_margins: np.ndarray,
    xgb_oof_labels: np.ndarray,
    xgb_oof_idx: np.ndarray,
    lgb_oof_idx: np.ndarray,
    xgb_platt_a: float,
    xgb_platt_b: float,
    lgb_platt_a: float,
    lgb_platt_b: float,
    xgb_model: Any,
    xgb_dholdout: Any,
    lgb_model: Any,
    X_holdout: np.ndarray | None,
    y_holdout: np.ndarray | None,
    X_test: np.ndarray,
    y_test: np.ndarray,
    xgb_test_probs: np.ndarray,
    log: Callable[..., None],
) -> tuple[float, str]:
    """Pick the XGB blend weight, and report which split it was picked on.

    Audit fix H5, revised Sep 2026: the 11-candidate sweep and the OOF
    row-alignment check live in mltrain/sweeps (select_ensemble_weights /
    align_oof_predictions), which carry the multiple-testing rationale for
    selecting on OOF instead of on the strict OOS holdout. This owns only the
    Platt transforms, the reporting, and the holdout/test fallbacks kept for
    degenerate or misaligned CV.

    Args:
        xgb_model / xgb_dholdout: booster and holdout DMatrix, typed loosely so
            an otherwise LightGBM-only module need not import xgboost.
        xgb_test_probs: the XGBoost half's calibrated test probabilities, used
            only by the last-resort test-split fallback.

    Returns:
        (weight for the XGBoost half, name of the split it was selected on).
    """
    ens_oof_xgb = None
    ens_oof_lgb = None
    ens_oof_labels = None
    if len(xgb_oof_margins) > 0 and len(lgb_oof_margins) > 0:
        xgb_oof_cal = platt_probs(xgb_oof_margins, xgb_platt_a, xgb_platt_b)
        lgb_oof_cal = platt_probs(lgb_oof_margins, lgb_platt_a, lgb_platt_b)
        ens_align = align_oof_predictions(
            xgb_oof_cal,
            lgb_oof_cal,
            xgb_oof_labels,
            xgb_oof_idx,
            lgb_oof_idx,
        )
        if ens_align.identical:
            log(
                f"\n   Ensemble OOF alignment check: OK "
                f"({len(xgb_oof_idx):,} rows, XGB/LGB fold arithmetic identical)"
            )
        else:
            log(
                f"\n   [WARN] Ensemble OOF rows misaligned (xgb={len(xgb_oof_idx)}, lgb={len(lgb_oof_idx)}) "
                f"— re-aligning on {ens_align.n_common:,} common X_train row indices"
            )
        ens_oof_xgb = ens_align.xgb_probs
        ens_oof_lgb = ens_align.lgb_probs
        ens_oof_labels = ens_align.labels

    if ens_oof_xgb is not None and len(ens_oof_xgb) >= 100:
        log(f"   Optimizing ensemble weights (on OOF CV predictions, {len(ens_oof_xgb):,} rows)...")
        return (
            select_ensemble_weights(ens_oof_xgb, ens_oof_lgb, ens_oof_labels).weight_xgb,
            "oof_cv",
        )

    if X_holdout is not None and len(X_holdout) > 0:
        # Fallback (degenerate/misaligned CV only): legacy holdout selection
        log("\n   Optimizing ensemble weights (on holdout — OOF unavailable)...")
        xgb_margin_ho = xgb_model.predict(xgb_dholdout, output_margin=True)
        xgb_cal_ho = platt_probs(xgb_margin_ho, xgb_platt_a, xgb_platt_b)
        lgb_margin_ho = lgb_model.predict(X_holdout, raw_score=True)
        lgb_cal_ho = platt_probs(lgb_margin_ho, lgb_platt_a, lgb_platt_b)

        return select_ensemble_weights(xgb_cal_ho, lgb_cal_ho, y_holdout).weight_xgb, "holdout"

    log("\n   Optimizing ensemble weights (on test, no holdout)...")
    xgb_cal_test = xgb_test_probs
    lgb_margin_test = lgb_model.predict(X_test, raw_score=True)
    lgb_cal_test = platt_probs(lgb_margin_test, lgb_platt_a, lgb_platt_b)

    return select_ensemble_weights(xgb_cal_test, lgb_cal_test, y_test).weight_xgb, "test"


def run_lightgbm_stage(
    *,
    X_train: np.ndarray,
    y_train: np.ndarray,
    w_train: np.ndarray | None,
    X_final_train: np.ndarray,
    y_final_train: np.ndarray,
    w_train_final: np.ndarray | None,
    X_test: np.ndarray,
    y_test: np.ndarray,
    X_holdout: np.ndarray | None,
    y_holdout: np.ndarray | None,
    feature_cols: list[str],
    seed: int,
    embargo: int,
    n_folds: int,
    use_optuna: bool,
    xgb_model: Any,
    xgb_dholdout: Any,
    xgb_oof_margins: np.ndarray,
    xgb_oof_labels: np.ndarray,
    xgb_oof_idx: np.ndarray,
    xgb_platt_a: float,
    xgb_platt_b: float,
    xgb_test_probs: np.ndarray,
    xgb_accuracy: float,
    xgb_auc: float,
    norm: dict[str, Any],
    output_dir: str,
    strict_holdout: bool,
    num_boost_round: int = LGB_BOOST_ROUND,
    early_stopping: int = LGB_EARLY_STOPPING,
    log: Callable[..., None] = print,
) -> LightGbmStageResult:
    """Train, calibrate, blend and export the LightGBM half of the ensemble.

    Steps run in a fixed order because each feeds the next: params -> final fit
    (early-stopped on the holdout) -> raw test scores -> embargoed CV -> Platt
    on the OOF logits -> exported Brier/ECE in the SHIPPED probability space ->
    blend weight -> lightgbm_model.json + the norm_browser.json ensemble block ->
    browser-parity check.

    Args:
        X_train, y_train, w_train: the TUNE subset — what CV and tuning see.
        X_final_train, y_final_train, w_train_final: the rows the FINAL models
            train on (strict-holdout aware, see the May 2026 P6 note below).
        X_holdout, y_holdout: the strict OOS holdout, or None; doubles as the
            early-stopping set (audit fix M-early) with test as the fallback.
        xgb_*: the XGBoost half's booster, holdout DMatrix, OOF margins/labels/
            row indices, Platt transform, calibrated test probabilities and
            headline test metrics — everything the blend and its report need.
        norm: the norm_browser.json payload from mltrain.export.build_norm_export;
            it is copied, not mutated, and rewritten with the ensemble block.
        output_dir: where lightgbm_model.json and norm_browser.json land.
        strict_holdout: exported verbatim as ensemble_metrics.strict_holdout so
            a consumer can tell a clean number from a leaked one.
        num_boost_round, early_stopping: boosting budget for the CV folds and
            the final fit; the defaults are the same constants the callees
            would have applied, so production behaviour is unchanged.
        log: sink for the section's console lines (the trainer's `print`).

    Returns:
        LightGbmStageResult; see its docstring.
    """
    # --- LightGBM Hyperparameter Optimization ---
    lgb_best_params = _resolve_lgb_params(
        X_train,
        y_train,
        w_train,
        feature_cols=feature_cols,
        seed=seed,
        embargo=embargo,
        n_folds=n_folds,
        use_optuna=use_optuna,
        log=log,
    )

    # --- Train final LightGBM model ---
    # Use full training data; early stop on holdout (audit fix M-early)
    log("   Training final LightGBM model...")

    # Audit fix (May 2026 P6 follow-up): respect strict-holdout for LGB too
    if X_holdout is not None and len(X_holdout) > 0:
        lgb_X_val, lgb_y_val = X_holdout, y_holdout
        log(f"   LGB early stopping on: holdout ({len(X_holdout):,} samples)")
    else:
        lgb_X_val, lgb_y_val = X_test, y_test

    lgb_model_final = train_final_lgb(
        X_final_train,
        y_final_train,
        w_train_final,
        lgb_X_val,
        lgb_y_val,
        lgb_best_params,
        feature_cols=feature_cols,
        num_boost_round=num_boost_round,
        early_stopping=early_stopping,
    )

    lgb_scores = evaluate_lgb(lgb_model_final, X_test, y_test)
    lgb_acc, lgb_auc, lgb_n_trees = lgb_scores.accuracy, lgb_scores.auc, lgb_scores.n_trees
    log(f"   LightGBM: acc={lgb_acc*100:.1f}% | AUC={lgb_auc:.4f} | trees={lgb_n_trees}")

    # --- LightGBM Platt Calibration (on raw logits — audit fix C4) ---
    log("   LightGBM Platt calibration (on logits)...")
    lgb_cv_auc, lgb_cv_acc, _lgb_oof_preds, lgb_oof_margins, lgb_oof_labels, lgb_oof_idx = (
        lgb_walk_forward_cv(
            X_train,
            y_train,
            lgb_best_params,
            w_train,
            n_folds,
            return_preds=True,
            feature_cols=feature_cols,
            embargo=embargo,
            num_boost_round=num_boost_round,
            early_stopping=early_stopping,
        )
    )
    log(f"   LGB CV AUC: {lgb_cv_auc:.4f} | CV acc: {lgb_cv_acc*100:.1f}%")

    lgb_calibrator = fit_lgb_platt(
        lgb_model_final,
        X_test,
        y_test,
        lgb_oof_margins,
        lgb_oof_labels,
        raw_auc=lgb_auc,
    )
    lgb_platt_a, lgb_platt_b = lgb_calibrator.a, lgb_calibrator.b
    lgb_platt_on_logits = lgb_calibrator.on_logits
    if lgb_calibrator.fitted:
        if not lgb_calibrator.kept:
            log("   [WARN] LGB calibration hurts AUC, disabling")
        else:
            log(f"   LGB Platt (on logits): A={lgb_platt_a:.4f}, B={lgb_platt_b:.4f}")
            log(
                f"   LGB calibrated: acc={lgb_calibrator.cal_accuracy*100:.1f}% | AUC={lgb_calibrator.cal_auc:.4f}"
            )

    # Exported Brier/calibration must reflect the probabilities inference uses:
    # apply the FINAL Platt transform (identity when calibration was skipped or
    # disabled — sigmoid(raw margin) then equals the raw probability) to the raw
    # test margins before scoring.
    lgb_y_margin_final = lgb_model_final.predict(X_test, raw_score=True)
    lgb_y_prob_cal = platt_probs(lgb_y_margin_final, lgb_platt_a, lgb_platt_b)
    lgb_brier = brier_score_loss(y_test, lgb_y_prob_cal)
    lgb_calibration = calibration_summary(y_test, lgb_y_prob_cal)
    log(f"   LGB calibrated (exported): Brier={lgb_brier:.4f} | ECE={lgb_calibration['ece']:.4f}")

    # --- Ensemble Weight Optimization (on OOF CV preds — audit fix H5, revised Sep 2026) ---
    best_ens_w, sweep_label = _select_ensemble_weight(
        xgb_oof_margins=xgb_oof_margins,
        lgb_oof_margins=lgb_oof_margins,
        xgb_oof_labels=xgb_oof_labels,
        xgb_oof_idx=xgb_oof_idx,
        lgb_oof_idx=lgb_oof_idx,
        xgb_platt_a=xgb_platt_a,
        xgb_platt_b=xgb_platt_b,
        lgb_platt_a=lgb_platt_a,
        lgb_platt_b=lgb_platt_b,
        xgb_model=xgb_model,
        xgb_dholdout=xgb_dholdout,
        lgb_model=lgb_model_final,
        X_holdout=X_holdout,
        y_holdout=y_holdout,
        X_test=X_test,
        y_test=y_test,
        xgb_test_probs=xgb_test_probs,
        log=log,
    )

    ens_weight_xgb = round(best_ens_w, 3)
    ens_weight_lgb = round(1 - best_ens_w, 3)

    # Report on test (read-only) regardless of where weights were tuned
    xgb_cal_probs = xgb_test_probs
    lgb_y_margin_ens = lgb_model_final.predict(X_test, raw_score=True)
    lgb_cal_probs = platt_probs(lgb_y_margin_ens, lgb_platt_a, lgb_platt_b)
    ens_prob_final = ens_weight_xgb * xgb_cal_probs + ens_weight_lgb * lgb_cal_probs
    ens_acc = accuracy_score(y_test, (ens_prob_final >= 0.5).astype(int))
    ens_auc_final = roc_auc_score(y_test, ens_prob_final)
    ens_logloss = log_loss(y_test, ens_prob_final)
    ens_brier = brier_score_loss(y_test, ens_prob_final)
    ens_calibration = calibration_summary(y_test, ens_prob_final)

    log(f"\n   === Ensemble Results (weights from {sweep_label}) ===")
    log(f"   XGB weight: {ens_weight_xgb} | LGB weight: {ens_weight_lgb}")
    log(f"   XGB only:   acc={xgb_accuracy*100:.1f}% | AUC={xgb_auc:.4f}")
    log(f"   LGB only:   acc={lgb_acc*100:.1f}% | AUC={lgb_auc:.4f}")
    log(
        f"   Ensemble:   acc={ens_acc*100:.1f}% | AUC={ens_auc_final:.4f} | ECE={ens_calibration['ece']:.4f}"
    )

    # --- Export LightGBM model ---
    log("\n   Exporting LightGBM model...")
    lgb_dump = lgb_model_final.dump_model()

    # Compute init_score for browser inference
    lgb_init_score = compute_init_score(y_train, w_train)

    # C2: Use len(sliced_trees) for num_trees to avoid off-by-one
    sliced_tree_info = lgb_dump["tree_info"][:lgb_n_trees]
    lgb_browser = build_lgb_browser_model(
        sliced_tree_info,
        feature_cols=feature_cols,
        init_score=lgb_init_score,
        platt_a=lgb_platt_a,
        platt_b=lgb_platt_b,
        platt_on_logits=lgb_platt_on_logits,
        accuracy=lgb_acc,
        auc=lgb_auc,
        brier=lgb_brier,
        calibration=lgb_calibration,
        cv_auc=lgb_cv_auc,
        cv_acc=lgb_cv_acc,
        ensemble_weights={"xgb": ens_weight_xgb, "lgb": ens_weight_lgb},
    )

    lgb_path = os.path.join(output_dir, "lightgbm_model.json")
    with open(lgb_path, "w") as f:
        json.dump(lgb_browser, f)
    lgb_mb = os.path.getsize(lgb_path) / 1024 / 1024
    log(f"   LGB model: {lgb_path} ({lgb_mb:.1f} MB)")

    # --- Update norm_browser.json with ensemble info ---
    # Rebuilt rather than mutated in place: dict literals keep insertion order,
    # so spreading `norm` first and appending the five ensemble keys reproduces
    # the old in-place assignment byte-for-byte (none of the five already exist
    # in build_norm_export's payload) while leaving the caller's dict untouched.
    norm_with_ensemble = {
        **norm,
        "ensemble_weights": {"xgb": ens_weight_xgb, "lgb": ens_weight_lgb},
        "ensemble_metrics": {
            "accuracy": round(ens_acc, 4),
            "auc": round(ens_auc_final, 4),
            "logloss": round(ens_logloss, 4),
            "brier": round(ens_brier, 4),
            "calibration_ece": safe_round(ens_calibration["ece"]),
            "calibration_mce": safe_round(ens_calibration["mce"]),
            "weight_source": sweep_label,
            "test_samples": len(y_test),
            "holdout_samples": len(y_holdout) if y_holdout is not None else 0,
            "strict_holdout": bool(strict_holdout),
        },
        "lgb_platt_a": lgb_platt_a,
        "lgb_platt_b": lgb_platt_b,
        "lgb_platt_on_logits": lgb_platt_on_logits,
    }

    with open(os.path.join(output_dir, "norm_browser.json"), "w") as f:
        json.dump(norm_with_ensemble, f, indent=2)
    log("   Updated norm_browser.json with ensemble weights")

    # --- Verify browser inference consistency ---
    log("\n   Verifying LGB browser inference...")
    max_diff = verify_browser_inference(lgb_model_final, sliced_tree_info, lgb_init_score, X_test)
    log(f"   Max raw score diff (model vs manual): {max_diff:.8f}")
    if max_diff > 0.01:
        log("   [WARN] Large inference discrepancy! Browser predictions may differ.")
    else:
        log("   [OK] Browser inference verified")

    return LightGbmStageResult(
        accuracy=lgb_acc,
        auc=lgb_auc,
        n_trees=lgb_n_trees,
        ensemble_accuracy=ens_acc,
        ensemble_auc=ens_auc_final,
        weight_xgb=ens_weight_xgb,
        weight_lgb=ens_weight_lgb,
        weight_source=sweep_label,
    )
