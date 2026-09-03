"""Section 7's Platt calibration: fit on OOF logits, keep only if it does not hurt.

Audit fix C4: the scaler is fitted on RAW MARGINS, not on the booster's already
sigmoid-squashed probabilities. Fitting on probabilities applies a second
sigmoid, which flattens the tails exactly where the bot trades — sigmoid(A*logit
+ B) is the correct transform and is what `Mlpredictor.ts` reproduces in the
browser, so `platt_on_logits` ships alongside A and B as an explicit contract.

The fit uses out-of-fold walk-forward margins rather than the final model's own
training predictions: a model is overconfident on rows it was fitted to, so
in-sample calibration would learn to undo confidence the deployed model never
has. The resulting A/B are then CHECKED on the strict OOS holdout (test when no
holdout exists) and reverted to the identity (A=1, B=0) if AUC drops by more
than 0.005 — a calibrator can only reorder ties, so a real AUC loss means the
fit is wrong, not merely conservative.

The final holdout numbers are recomputed here for a reason: the acc/AUC measured
right after the initial fit describe a model that section 6 may since have
replaced (pruning) and a decision boundary this section may since have moved.
Recomputing against the shipped booster with the shipped transform keeps the
exported holdout metrics and the deploy-gate test/holdout gaps comparing the
same artifact on both sides.

Pure logic with an injected `log` callable; the trainer owns stdout and all JSON.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

import numpy as np
import xgboost as xgb
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, roc_auc_score

MIN_OOF_MARGINS = 100        # below this the fit is noise; ship the identity
AUC_REGRESSION_TOLERANCE = 0.005  # AUC drop that disables the calibrator


@dataclass(frozen=True)
class CalibrationResult:
    """The Platt transform actually shipped, plus the metrics it was judged on.

    A/B are (1.0, 0.0) — the identity — whenever calibration was skipped for too
    few OOF margins or reverted for hurting AUC, so callers never branch on
    "was it fitted": applying the transform is always correct. `probabilities`
    is the test-set probability vector the final evaluation should score, and
    `eval_label` names where the keep/revert decision was taken ("holdout" or
    "test") for the exported validation block.
    """
    a: float
    b: float
    on_logits: bool
    fitted: bool
    kept: bool
    eval_label: str
    probabilities: np.ndarray
    holdout_accuracy: float | None
    holdout_auc: float | None


def calibrate_platt(model: xgb.Booster,
                    *,
                    oof_margins: np.ndarray,
                    oof_labels: np.ndarray,
                    dtest: xgb.DMatrix,
                    y_test: np.ndarray,
                    y_prob: np.ndarray,
                    dholdout: xgb.DMatrix | None,
                    y_holdout: np.ndarray | None,
                    log: Callable[..., None] = print) -> CalibrationResult:
    """Fit sigmoid(A*logit + B) on OOF margins, then keep it only if AUC holds.

    Args:
        model: the FINAL booster (post-pruning) whose margins get transformed.
        oof_margins: out-of-fold raw logits from walk-forward CV.
        oof_labels: ground-truth 0/1 labels aligned to `oof_margins`.
        dtest, y_test: the test split, always scored so the caller has
            calibrated test probabilities for the final evaluation.
        y_prob: the final model's RAW test probabilities, returned unchanged
            when calibration is skipped or reverted.
        dholdout, y_holdout: strict OOS holdout used for the keep/revert
            decision and the recomputed final holdout metrics; None disables
            both and falls the decision back to the test split.
        log: sink for the section's console lines (the trainer's `print`).

    Returns:
        CalibrationResult; see its docstring.
    """
    # Fit Platt scaling on RAW LOGITS (not post-sigmoid probabilities)
    # This is the correct way: sigmoid(A*logit + B) gives properly calibrated probs
    platt_a, platt_b = 1.0, 0.0  # defaults (identity)
    platt_on_logits = True  # flag for browser inference
    eval_label = 'test'  # where calibration was evaluated (overwritten below when holdout is used)
    fitted = False
    kept = False

    if len(oof_margins) > MIN_OOF_MARGINS:
        fitted = True
        lr = LogisticRegression(C=1.0, solver='lbfgs', max_iter=1000)
        lr.fit(oof_margins.reshape(-1, 1), oof_labels)
        platt_a = float(lr.coef_[0][0])
        platt_b = float(lr.intercept_[0])

        # Get raw margins from final model for evaluation
        y_margin_test = model.predict(dtest, output_margin=True)
        y_prob_calibrated = 1.0 / (1.0 + np.exp(-(platt_a * y_margin_test + platt_b)))

        # Evaluate calibration on holdout (audit fix M-cal) or test as fallback
        if dholdout is not None:
            y_margin_holdout = model.predict(dholdout, output_margin=True)
            y_prob_cal_holdout = 1.0 / (1.0 + np.exp(-(platt_a * y_margin_holdout + platt_b)))
            cal_acc = accuracy_score(y_holdout, (y_prob_cal_holdout >= 0.5).astype(int))
            cal_auc = roc_auc_score(y_holdout, y_prob_cal_holdout)
            # Compare vs raw on same holdout set
            raw_prob_holdout = model.predict(dholdout)
            raw_acc = accuracy_score(y_holdout, (raw_prob_holdout >= 0.5).astype(int))
            raw_auc = roc_auc_score(y_holdout, raw_prob_holdout)
            eval_label = "holdout"
        else:
            cal_acc = accuracy_score(y_test, (y_prob_calibrated >= 0.5).astype(int))
            cal_auc = roc_auc_score(y_test, y_prob_calibrated)
            raw_acc = accuracy_score(y_test, (y_prob >= 0.5).astype(int))
            raw_auc = roc_auc_score(y_test, y_prob)
            eval_label = "test"

        log(f"   Platt params (on logits): A={platt_a:.4f}, B={platt_b:.4f}")
        log(f"   Raw ({eval_label}):        acc={raw_acc*100:.1f}% | AUC={raw_auc:.4f}")
        log(f"   Calibrated ({eval_label}): acc={cal_acc*100:.1f}% | AUC={cal_auc:.4f}")

        if cal_auc < raw_auc - AUC_REGRESSION_TOLERANCE:
            log(f"   [WARN] Calibration hurts AUC on {eval_label}, disabling (A=1, B=0)")
            platt_a, platt_b = 1.0, 0.0
            y_prob_final = y_prob
        else:
            log(f"   [OK] Platt-on-logits calibration active")
            kept = True
            y_prob_final = y_prob_calibrated  # calibrated test probs for final eval
    else:
        log(f"   [WARN] Not enough OOF margins ({len(oof_margins)}), skipping calibration")
        y_prob_final = y_prob

    # --- Final holdout metrics (post-pruning, post-calibration) ---
    # holdout_acc/holdout_auc above were measured on the INITIAL model, before feature
    # pruning could swap `model` (section 6) and before Platt calibration moved the
    # decision boundary (section 7). Recompute against the FINAL model artifact with
    # the FINAL Platt transform (identity A=1, B=0 when calibration was skipped or
    # disabled) so the exported holdout metrics and the test/holdout deploy-gate gaps
    # compare the same artifact on both sides.
    final_holdout_acc = None
    final_holdout_auc = None
    if dholdout is not None:
        final_margin_ho = model.predict(dholdout, output_margin=True)
        final_prob_ho = 1.0 / (1.0 + np.exp(-(platt_a * final_margin_ho + platt_b)))
        final_holdout_acc = float(accuracy_score(y_holdout, (final_prob_ho >= 0.5).astype(int)))
        final_holdout_auc = float(roc_auc_score(y_holdout, final_prob_ho))
        log(f"   Final holdout (final model + final Platt): "
            f"acc={final_holdout_acc*100:.1f}% | AUC={final_holdout_auc:.4f}")

    return CalibrationResult(
        a=platt_a, b=platt_b, on_logits=platt_on_logits,
        fitted=fitted, kept=kept, eval_label=eval_label,
        probabilities=y_prob_final,
        holdout_accuracy=final_holdout_acc,
        holdout_auc=final_holdout_auc,
    )
