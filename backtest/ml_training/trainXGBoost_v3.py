#!/usr/bin/env python3
"""
=== XGBoost v9 — Advanced Training Pipeline ===

v9 improvements (ML-retrain audit fixes):
  - C1: Real Polymarket market prices (via polymarket_lookup.json)
  - C3: Threshold sweep off test data. Revised Sep 2026: ALL selection sweeps
        (threshold, phase-threshold grid, ensemble weights) now select on
        calibrated out-of-fold CV predictions; the 12.5% holdout is
        EVALUATION-only (multiple-testing fix, Lopez de Prado / ML4T ch16)
  - C4: Platt calibration on raw logits (not double-sigmoid)
  - H: Real minutesLeft, real features 44-48, real labels from Polymarket
  - M: Early-stop, pruning, calibration evaluated on holdout
  - Metadata column (slug_timestamp) auto-dropped from features

v8 improvements:
  - Fixed MACD inference bug, replaced dead features
  - 5-fold walk-forward CV, Optuna 150 trials
  - Soft feature pruning + Platt calibration

Strategy: Optuna or 8 hand-tuned seed configs + walk-forward CV
          + soft feature pruning + Platt-on-logits calibration.
"""

import argparse
import json
import os
import sys
import warnings

import numpy as np

from mltrain.data import load_training_data, temporal_split
from mltrain.features import engineer_features
from mltrain.weights import build_feature_weights, build_sample_weights, count_regimes

warnings.filterwarnings("ignore")

# --- Optional: Optuna ---
try:
    import optuna

    optuna.logging.set_verbosity(optuna.logging.WARNING)
    HAS_OPTUNA = True
except ImportError:
    HAS_OPTUNA = False

parser = argparse.ArgumentParser()
parser.add_argument("--input", default="training_data.csv")
parser.add_argument("--output-dir", default="./output")
parser.add_argument("--test-size", type=float, default=0.15)
parser.add_argument("--seed", type=int, default=42)
parser.add_argument("--tune", action="store_true", help="Use Optuna Bayesian optimization")
parser.add_argument("--tune-trials", type=int, default=150, help="Number of Optuna trials")
parser.add_argument("--deploy", action="store_true")
parser.add_argument("--days", type=int, default=540)
parser.add_argument(
    "--zero-features",
    type=str,
    default="",
    help="Comma-separated feature names to zero out before training (e.g., macd_hist,macd_line)",
)
parser.add_argument(
    "--exclude-features",
    type=str,
    default="funding_rate_change",
    help="Comma-separated feature names to pre-exclude via feature_weights=0 (applied before Optuna). "
    "Default: funding_rate_change (always zero at inference — audit fix C8)",
)
parser.add_argument(
    "--recency", action="store_true", help="Apply recency sample weighting (90-day half-life)"
)
parser.add_argument(
    "--recency-halflife",
    type=int,
    default=90,
    help="Half-life in days for recency weighting (default: 90)",
)
parser.add_argument(
    "--regime-split",
    action="store_true",
    help="Train separate models per regime (trending/moderate/choppy)",
)
parser.add_argument(
    "--session-weight",
    action="store_true",
    help="Apply session-based sample weighting: US/Overlap +50%%/+30%%, Asia -20%%. "
    "Improves model accuracy during US trading hours without changing feature vector.",
)
parser.add_argument(
    "--holdout-frac",
    type=float,
    default=0.125,
    help="Reserve final N%% of train data as holdout (not seen by Optuna/CV). "
    "Default 0.125 = 12.5%% holdout (audit fix C3). Set to 0 to disable.",
)
parser.add_argument(
    "--strict-holdout",
    dest="strict_holdout",
    action="store_true",
    default=True,
    help="(default) Keep holdout strictly OOS: final model trains ONLY on tune subset, "
    "NEVER on holdout. Audit fix (May 2026) — previously final model retrained on "
    'X_train_full which INCLUDED holdout, making the "holdout 94.12%%" metric leak. '
    "Disable with --no-strict-holdout if you want the old behavior for replication.",
)
parser.add_argument("--no-strict-holdout", dest="strict_holdout", action="store_false")
parser.add_argument(
    "--cv-embargo",
    type=int,
    default=16,
    help="Rows skipped after every temporal boundary (CV folds, test, holdout) so "
    "validation rows whose feature lookbacks overlap the training window are "
    "excluded (ML4T embargo). 16 rows = 4h of 15-min markets. 0 disables.",
)
# Legacy flags kept for compatibility
parser.add_argument("--epochs", type=int, default=0)
args = parser.parse_args()

CV_EMBARGO = max(0, args.cv_embargo)

os.makedirs(args.output_dir, exist_ok=True)
np.random.seed(args.seed)

USE_OPTUNA = args.tune and HAS_OPTUNA
if args.tune and not HAS_OPTUNA:
    print("  WARNING: Optuna not installed. Falling back to grid search.")
    print("     Install with: pip install optuna")

# Parse --zero-features
zero_feature_names = (
    [f.strip() for f in args.zero_features.split(",") if f.strip()] if args.zero_features else []
)

# Parse --exclude-features
exclude_feature_names = (
    [f.strip() for f in args.exclude_features.split(",") if f.strip()]
    if args.exclude_features
    else []
)

print(f"""
==================================================
  XGBoost v9 — Advanced Training Pipeline
  {('Optuna (' + str(args.tune_trials) + ' trials)') if USE_OPTUNA else '8 configs (grid)'} | Feat selection | Platt calibration
==================================================
  Input:     {args.input}
  Test size: {args.test_size}
  Optuna:    {'Yes (' + str(args.tune_trials) + ' trials)' if USE_OPTUNA else 'No (grid search)'}
  Zero-feat: {', '.join(zero_feature_names) if zero_feature_names else 'none'}
  Exclude:   {len(exclude_feature_names)} features {'(' + ', '.join(exclude_feature_names[:5]) + ('...' if len(exclude_feature_names) > 5 else '') + ')' if exclude_feature_names else 'none'}
  Recency:   {'Yes (half-life=' + str(args.recency_halflife) + 'd)' if args.recency else 'No'}
  Sess-wt:   {'Yes (US x1.5, Overlap x1.3, Asia x0.8)' if args.session_weight else 'No'}
==================================================
""")

# ================================================
# 1. LOAD
# ================================================
print("[1/8] Loading data...")
# CSV read, metadata-column drop, leakage assertions and --zero-features live in
# mltrain/data.py (importable + unit-tested); this owns only the run summary.
data = load_training_data(args.input, zero_features=zero_feature_names)
X_orig = data.X_orig
y = data.y
feature_cols_orig = data.feature_cols_orig

n_base = data.n_base
print(f"   {data.n_rows:,} rows | {n_base} base features | UP={data.n_up} DOWN={data.n_down}")
spw = data.scale_pos_weight

# ================================================
# 2. ENGINEER 25 FEATURES
# ================================================
print("[2/8] Engineering 25 features...")

fi = {
    name: i for i, name in enumerate(feature_cols_orig)
}  # base-feature index map (used by later sections)
X, feature_cols = engineer_features(X_orig, feature_cols_orig)
new_names = feature_cols[len(feature_cols_orig) :]
print(f"   +{len(new_names)} engineered = {len(feature_cols)} total features")

pre_exclude_fw = build_feature_weights(feature_cols, exclude_feature_names)

# ================================================
# 3. TEMPORAL SPLIT
# ================================================
print("[3/8] Temporal split...")
# Split arithmetic + embargo live in mltrain/data.py. X_train/y_train below are
# the TUNE subset whenever a holdout was carved out (Optuna/CV never see it).
splits = temporal_split(
    X, y, test_size=args.test_size, holdout_frac=args.holdout_frac, embargo=CV_EMBARGO
)
X_train, y_train = splits.X_train, splits.y_train
X_test, y_test = splits.X_test, splits.y_test
X_train_full, y_train_full = splits.X_train_full, splits.y_train_full
X_holdout, y_holdout = splits.X_holdout, splits.y_holdout
holdout_start_idx = splits.holdout_start_idx
holdout_acc = None
holdout_auc = None

# ================================================
# 4. REGIME STATS (no sample weighting — v7 showed it doesn't help)
# ================================================
print("[4/8] Regime statistics (uniform weights)...")

regime_counts = count_regimes(X_orig, fi)

# Sample weights: start with uniform, optionally add recency weighting
# (both schemes live in mltrain/weights.py; None means uniform).
w_train = build_sample_weights(
    X_train,
    fi,
    use_recency=args.recency,
    days=args.days,
    halflife=args.recency_halflife,
    use_session=args.session_weight,
)

for rn, rc in regime_counts.items():
    pct = rc / len(X) * 100
    print(f"   {rn}: {rc:,} samples ({pct:.1f}%) × weight 1.0")

# ================================================
# 5. TRAINING (Optuna or Grid Search)
# ================================================

import xgboost as xgb
from sklearn.metrics import (
    accuracy_score,
    brier_score_loss,
    confusion_matrix,
    f1_score,
    log_loss,
    precision_score,
    recall_score,
    roc_auc_score,
)

# Pure logic extracted into the mltrain package (importable + unit-tested).
from mltrain.calibration import calibrate_platt
from mltrain.configs import EARLY_STOPPING, N_CV_FOLDS, NUM_BOOST_ROUND
from mltrain.cv import walk_forward_cv as _walk_forward_cv
from mltrain.export import (
    ValidationInfo,
    XgbEvalMetrics,
    build_browser_model,
    build_norm_export,
    compute_signal_modifiers,
    dump_browser_trees,
)
from mltrain.metrics import calibration_summary, confidence_bucket_summary
from mltrain.pruning import evaluate_pruning
from mltrain.report import build_training_report
from mltrain.sweeps import select_phase_thresholds, select_threshold
from mltrain.tuning import search_hyperparameters


# --- Walk-Forward CV (logic lives in mltrain/cv.py; bound to this run's config) ---
def walk_forward_cv(
    X_tr: np.ndarray,
    y_tr: np.ndarray,
    cfg: dict,
    w_tr: np.ndarray | None = None,
    n_folds: int = N_CV_FOLDS,
    return_preds: bool = False,
    feat_weights: np.ndarray | None = None,
    return_importances: bool = False,
) -> tuple:
    """Thin binding of mltrain.cv.walk_forward_cv to this run's globals."""
    return _walk_forward_cv(
        X_tr,
        y_tr,
        cfg,
        w_tr,
        n_folds,
        return_preds,
        feat_weights,
        return_importances,
        feature_cols=feature_cols,
        seed=args.seed,
        embargo=CV_EMBARGO,
        num_boost_round=NUM_BOOST_ROUND,
        early_stopping=EARLY_STOPPING,
    )


# Hyperparameter search — Optuna study or the 8-config grid — lives in
# mltrain/tuning.py, and the seed configs + boosting budget in mltrain/configs.py.
# The TPE sampler seed and the enqueue-before-optimize order are documented there
# (they decide which trials run); this owns only the winner's name for reporting.
search = search_hyperparameters(
    X_train,
    y_train,
    w_train,
    cv_fn=walk_forward_cv,
    feat_weights=pre_exclude_fw if exclude_feature_names else None,
    use_optuna=USE_OPTUNA,
    n_trials=args.tune_trials,
    seed=args.seed,
    n_folds=N_CV_FOLDS,
)
best_cfg = search.config
best_cfg_name = search.name


# --- Train final model with best config ---
# Final model trains on full X_train (including holdout), since holdout was only
# excluded from Optuna/CV tuning. The model gets the most data possible.
print(f"\n   Training final model with {best_cfg_name}...")
if args.holdout_frac > 0:
    if args.strict_holdout:
        print(
            f"   (strict holdout: training on tune subset {len(X_train):,} samples; holdout {len(X_holdout):,} stays OOS)"
        )
    else:
        print(
            f"   (non-strict: using full training data {len(X_train_full):,} samples — holdout INCLUDED in final train)"
        )

final_params = {
    "objective": "binary:logistic",
    "eval_metric": ["logloss", "auc"],
    "scale_pos_weight": spw,
    "seed": args.seed,
    "tree_method": "hist",
    **best_cfg,
}

# Audit fix (May 2026): when --strict-holdout (default), final model trains ONLY
# on the tune subset — holdout is never seen by the model. This keeps "holdout acc"
# an honest OOS metric. Previously X_train_full silently included the holdout,
# making early-stopping + threshold/phase/ensemble sweeps + final eval all touch
# the same data → multiple-comparisons + leak.
if args.holdout_frac > 0 and args.strict_holdout:
    X_final_train = X_train  # already swapped to tune subset at temporal-split step
    y_final_train = y_train
    w_train_final = w_train  # weights computed against tune subset
    print(
        f"   STRICT HOLDOUT: final model trains on tune subset only "
        f"({len(X_final_train):,} samples); holdout stays OOS."
    )
else:
    X_final_train = X_train_full
    y_final_train = y_train_full
    w_train_final = w_train
    if args.holdout_frac > 0 and args.recency:
        # Legacy path: recompute recency weights spanning full train (incl. holdout)
        n_full = len(X_train_full)
        days_ago_full = np.linspace(args.days, 0, n_full)
        w_train_final = (0.5 + 0.5 * np.exp(-days_ago_full / args.recency_halflife)).astype(
            np.float32
        )
    elif args.holdout_frac > 0:
        w_train_final = None  # full train had no weights (tune subset was swapped)
    if args.holdout_frac > 0:
        print(
            "   [WARN] --no-strict-holdout: final model includes holdout — downstream "
            "holdout metrics will be biased upward (legacy v16 behavior)."
        )

dtrain = xgb.DMatrix(
    X_final_train, label=y_final_train, weight=w_train_final, feature_names=feature_cols
)
if exclude_feature_names:
    # Ensure colsample_bytree < 1.0 for feature_weights to work
    if final_params.get("colsample_bytree", 1.0) >= 1.0:
        final_params["colsample_bytree"] = 0.95
    dtrain.feature_weights = pre_exclude_fw
dtest = xgb.DMatrix(X_test, label=y_test, feature_names=feature_cols)

# Early stopping on holdout (audit fix M-early) to avoid test data leakage
# If holdout available, monitor it; otherwise fall back to test set
if X_holdout is not None and len(X_holdout) > 0:
    dholdout = xgb.DMatrix(X_holdout, label=y_holdout, feature_names=feature_cols)
    early_stop_set = (dholdout, "holdout")
    print(f"   Early stopping monitored on: holdout ({len(X_holdout):,} samples)")
else:
    early_stop_set = (dtest, "eval")

ev = {}
model = xgb.train(
    final_params,
    dtrain,
    num_boost_round=NUM_BOOST_ROUND,
    evals=[(dtrain, "train"), early_stop_set],
    evals_result=ev,
    early_stopping_rounds=EARLY_STOPPING,
    verbose_eval=False,
)

y_prob = model.predict(dtest)
initial_acc = accuracy_score(y_test, (y_prob >= 0.5).astype(int))
initial_auc = roc_auc_score(y_test, y_prob)
print(
    f"   Initial model: acc={initial_acc*100:.1f}% | AUC={initial_auc:.4f} | trees={model.best_iteration+1}"
)

# --- OOS holdout evaluation (if --holdout-frac was used) ---
if X_holdout is not None and len(X_holdout) > 0:
    if "dholdout" not in dir() or dholdout is None:
        dholdout = xgb.DMatrix(X_holdout, label=y_holdout, feature_names=feature_cols)
    y_prob_holdout = model.predict(dholdout)
    holdout_acc = accuracy_score(y_holdout, (y_prob_holdout >= 0.5).astype(int))
    holdout_auc = roc_auc_score(y_holdout, y_prob_holdout)
    holdout_label = (
        "(OOS — strict: never seen by Optuna/CV/final-train)"
        if args.strict_holdout
        else "(LEAKED — Optuna/CV skipped but final-train INCLUDED this data; numbers are biased)"
    )
    print(f"\n   === HOLDOUT EVALUATION {holdout_label} ===")
    print(f"   Holdout samples: {len(X_holdout):,}")
    print(f"   Holdout acc: {holdout_acc*100:.1f}% | AUC: {holdout_auc:.4f}")
    print(f"   Test    acc: {initial_acc*100:.1f}% | AUC: {initial_auc:.4f}")
    acc_drop = (initial_acc - holdout_acc) * 100
    auc_drop = (initial_auc - holdout_auc) * 10000
    print(f"   Delta: acc {acc_drop:+.1f}pp | AUC {auc_drop:+.0f}bp")
    if holdout_acc < initial_acc * 0.90:
        print("   [WARN] Holdout accuracy dropped >10% vs test — possible overfitting!")

# ================================================
# 6. FEATURE SELECTION (soft, via feature_weights)
# ================================================
print("\n[6/8] Feature selection...")

# Gain thresholding, the fold-stability filter (a feature weak in the final model
# but strong in >=1 walk-forward fold is rescued, not pruned), the soft-pruned
# retrain and the keep/reject comparison all live in mltrain/pruning.py. This
# owns only the eval-set plumbing: `dholdout` exists as a name only when a
# holdout was carved out, so it is passed conditionally.
has_holdout = X_holdout is not None and len(X_holdout) > 0
pruning = evaluate_pruning(
    model,
    feature_cols=feature_cols,
    cv_fn=walk_forward_cv,
    X_train=X_train,
    y_train=y_train,
    w_train=w_train,
    best_cfg=best_cfg,
    feat_weights=pre_exclude_fw if exclude_feature_names else None,
    pre_exclude_fw=pre_exclude_fw,
    has_pre_excluded=bool(exclude_feature_names),
    final_params=final_params,
    X_final_train=X_final_train,
    y_final_train=y_final_train,
    w_train_final=w_train_final,
    num_boost_round=NUM_BOOST_ROUND,
    early_stopping=EARLY_STOPPING,
    dtest=dtest,
    y_test=y_test,
    dholdout=dholdout if has_holdout else None,
    y_holdout=y_holdout,
    initial_auc=initial_auc,
)
model = pruning.model
pruned_features = pruning.pruned_features
pruned_model_kept = pruning.pruned_model_kept
combined_fw = pruning.combined_fw
if pruning.test_probs is not None:
    y_prob = pruning.test_probs  # pruned retrain replaced `model`

# ================================================
# 7. PLATT CALIBRATION
# ================================================
print("\n[7/8] Platt calibration (on raw logits — audit fix C4)...")

# Get out-of-fold predictions AND raw margins for calibration fitting.
# Use the SAME feature weighting the final model was trained with: soft-pruning
# weights (combined_fw) when the pruned retrain was kept, otherwise the
# pre-exclude weights (if any). Keeps cv_test_*_gap apples-to-apples.
cv_feat_weights = (
    combined_fw if pruned_model_kept else (pre_exclude_fw if exclude_feature_names else None)
)
cv_auc_final, cv_acc_final, oof_preds, oof_margins, oof_labels, oof_idx = walk_forward_cv(
    X_train, y_train, best_cfg, w_train, return_preds=True, feat_weights=cv_feat_weights
)
print(f"   CV AUC: {cv_auc_final:.4f} | CV acc: {cv_acc_final*100:.1f}%")
print(f"   Out-of-fold predictions: {len(oof_preds)} samples")
print(f"   Out-of-fold margins: {len(oof_margins)} samples")

# The fit on OOF logits, the keep-or-revert decision judged on the strict OOS
# holdout, and the final-holdout recompute against the SHIPPED booster with the
# SHIPPED transform all live in mltrain/calibration.py (audit fixes C4 / M-cal).
# `platt_on_logits` is exported alongside A/B so Mlpredictor.ts applies the same
# sigmoid(A*logit + B) the numbers here were measured with.
calib = calibrate_platt(
    model,
    oof_margins=oof_margins,
    oof_labels=oof_labels,
    dtest=dtest,
    y_test=y_test,
    y_prob=y_prob,
    dholdout=dholdout if has_holdout else None,
    y_holdout=y_holdout,
)
platt_a, platt_b = calib.a, calib.b
platt_on_logits = calib.on_logits
eval_label = calib.eval_label  # where the keep/revert decision was taken
y_prob_final = calib.probabilities  # calibrated test probs for the final eval
final_holdout_acc = calib.holdout_accuracy
final_holdout_auc = calib.holdout_auc

# ================================================
# 8. EVALUATE + EXPORT
# ================================================
print("\n[8/8] Evaluating & exporting...")

y_pred = (y_prob_final >= 0.5).astype(int)

accuracy = accuracy_score(y_test, y_pred)
precision = precision_score(y_test, y_pred, zero_division=0)
recall = recall_score(y_test, y_pred, zero_division=0)
f1 = f1_score(y_test, y_pred, zero_division=0)
auc = roc_auc_score(y_test, y_prob_final)
ll = log_loss(y_test, y_prob_final)
brier = brier_score_loss(y_test, y_prob_final)
calibration = calibration_summary(y_test, y_prob_final)
cv_test_acc_gap = float(accuracy - cv_acc_final)
cv_test_auc_gap = float(auc - cv_auc_final)
test_holdout_acc_gap = (
    float(accuracy - final_holdout_acc) if final_holdout_acc is not None else None
)
test_holdout_auc_gap = float(auc - final_holdout_auc) if final_holdout_auc is not None else None
confidence_buckets = confidence_bucket_summary(y_test, y_prob_final)

print(f"""
   ====================================
   Accuracy:   {accuracy*100:.2f}%
   Precision:  {precision:.4f}
   Recall:     {recall:.4f}
   F1:         {f1:.4f}
   AUC-ROC:    {auc:.4f}
   Log Loss:   {ll:.4f}
   Brier:      {brier:.4f}
   Cal ECE:    {calibration['ece']:.4f}
   ====================================
""")

print(f"   CV/Test gap: acc {cv_test_acc_gap*100:+.2f}pp | AUC {cv_test_auc_gap*10000:+.0f}bp")
if test_holdout_acc_gap is not None:
    print(
        f"   Test/Holdout gap: acc {test_holdout_acc_gap*100:+.2f}pp | AUC {test_holdout_auc_gap*10000:+.0f}bp"
    )

cm = confusion_matrix(y_test, y_pred)
print("   Confusion Matrix:")
print("              Pred DOWN  Pred UP")
print(f"   Actual DOWN  {cm[0][0]:>6}    {cm[0][1]:>6}")
print(f"   Actual UP    {cm[1][0]:>6}    {cm[1][1]:>6}")

# Confidence analysis (use final calibrated probabilities)
print("\n   Confidence Distribution:")
buckets = [
    (0.50, 0.55),
    (0.55, 0.60),
    (0.60, 0.65),
    (0.65, 0.70),
    (0.70, 0.75),
    (0.75, 0.80),
    (0.80, 0.85),
    (0.85, 0.90),
    (0.90, 1.0),
]
for lo, hi in buckets:
    mask_up = (y_prob_final >= lo) & (y_prob_final < hi)
    mask_dn = (y_prob_final > (1 - hi)) & (y_prob_final <= (1 - lo))
    mask = mask_up | mask_dn
    if mask.sum() > 0:
        a = accuracy_score(y_test[mask], y_pred[mask])
        print(
            f"     {lo:.2f}-{hi:.2f}: {a*100:.1f}% acc ({mask.sum():,} samples, {mask.sum()/len(y_test)*100:.1f}%)"
        )

# --- Optimal threshold scan on calibrated OOF CV predictions (audit fix C3, revised Sep 2026) ---
# The sweep itself (and the multiple-testing rationale behind selecting on OOF
# rather than on the strict OOS holdout) lives in mltrain/sweeps.select_threshold.
# This block owns only the source selection: OOF CV when available, with the
# holdout/test fallbacks kept for degenerate CV (no OOF rows). Thresholds are
# applied to calibrated probabilities at inference, so the sweep runs on the
# FINAL Platt transform (identity A=1/B=0 when calibration was disabled) applied
# to the OOF margins — the same probability space inference sees.
oof_cal_probs = (
    1.0 / (1.0 + np.exp(-(platt_a * oof_margins + platt_b)))
    if len(oof_margins) > 0
    else np.array([])
)
if len(oof_cal_probs) >= 100:
    sweep_probs = oof_cal_probs
    sweep_labels = oof_labels
    sweep_preds = (oof_cal_probs >= 0.5).astype(int)
    sweep_name = "oof_cv"
elif X_holdout is not None and len(X_holdout) > 0:
    # Fallback (degenerate CV only): legacy holdout selection
    y_margin_ho = model.predict(dholdout, output_margin=True)
    y_prob_ho = 1.0 / (1.0 + np.exp(-(platt_a * y_margin_ho + platt_b)))
    y_pred_ho = (y_prob_ho >= 0.5).astype(int)
    sweep_probs = y_prob_ho
    sweep_labels = y_holdout
    sweep_preds = y_pred_ho
    sweep_name = "holdout"
else:
    sweep_probs = y_prob_final
    sweep_labels = y_test
    sweep_preds = y_pred
    sweep_name = "test"

best_threshold = select_threshold(sweep_probs, sweep_labels, sweep_preds).threshold

print(f"\n   Optimal Threshold (from {sweep_name}): {best_threshold:.3f}")

# Report HIGH-CONF stats on TEST as read-only (audit fix C3)
high_mask = (y_prob_final < (1 - best_threshold)) | (y_prob_final > best_threshold)
hc_acc = accuracy_score(y_test[high_mask], y_pred[high_mask]) if high_mask.sum() > 0 else 0
hc_count = int(high_mask.sum())
hc_ratio = hc_count / len(y_test) * 100

print(
    f"   HIGH-CONF (test, read-only): {hc_acc*100:.1f}% accuracy ({hc_count:,} signals, {hc_ratio:.1f}% of test)"
)

# Feature importance (from final model)
importance = model.get_score(importance_type="gain")
sorted_imp = sorted(importance.items(), key=lambda x: x[1], reverse=True)
print("\n   Top 25 Features (by gain):")
for i, (feat, gain) in enumerate(sorted_imp[:25]):
    bar = "#" * int(gain / sorted_imp[0][1] * 30)
    tag = " [ENG]" if feat in new_names else " [PRUNED]" if feat in pruned_features else ""
    print(f"     {i+1:2d}. {feat:<35s} {gain:>10.1f}  {bar}{tag}")

new_in_top20 = sum(1 for f, _ in sorted_imp[:20] if f in new_names)
print(f"\n   Engineered features in top 20: {new_in_top20}/{len(new_names)}")

if pruned_features:
    print(f"   Pruned features ({len(pruned_features)}): {', '.join(pruned_features)}")

# ── Data-Driven Calibration (audit Signals H2 + H3) ──
print("\n   --- Data-Driven Calibration ---")

# === Signal Modifiers (H2): Feature importance → probability.js signal weights ===
# The SIGNAL_FEATURE_MAP grouping and the mean-1.0 normalisation live in
# mltrain/export.compute_signal_modifiers; this block owns only the reporting.
signal_modifiers = compute_signal_modifiers(importance)

print("   Signal Modifiers (H2):")
for k in sorted(signal_modifiers.keys()):
    bar = "#" * int(signal_modifiers[k] * 15)
    print(f"     {k:<15s}: {signal_modifiers[k]:.2f}  {bar}")

# === Phase Thresholds (H3): Sweep optimal minEdge/minProb per phase on OOF CV preds ===
# The ~36x26 grid per phase (and the multiple-testing rationale for selecting on
# OOF instead of the strict OOS holdout) lives in
# mltrain/sweeps.select_phase_thresholds. This block owns the metadata recovery:
# every OOF prediction corresponds to a specific X_train row (oof_idx, produced
# by the same fold arithmetic that cut the validation slices, embargo included),
# so minutes_left_norm and market_yes_price are read from those X_train rows —
# no bootstrap fallback needed — plus the reporting and the exported dict.
calibrated_phase_thresholds = None
if len(oof_cal_probs) > 200 and len(oof_idx) == len(oof_cal_probs):
    print(
        f"\n   Phase Threshold Calibration (H3) on OOF CV predictions ({len(oof_cal_probs):,} samples)..."
    )

    # Extract minutesLeft and market_yes_price from the X_train rows behind each OOF pred
    ml_idx = fi.get("minutes_left_norm")  # index 11
    mkt_idx = fi.get("market_yes_price")  # index 44

    if ml_idx is not None and mkt_idx is not None:
        ph_minutes = X_train[oof_idx, ml_idx] * 15  # denormalize
        ph_mkt_price = X_train[oof_idx, mkt_idx]

        # oof_cal_probs is the calibrated OOF probability (same Platt space inference uses)
        phase_results = select_phase_thresholds(
            oof_cal_probs,
            oof_labels,
            ph_minutes,
            ph_mkt_price,
        )

        calibrated_phase_thresholds = {}
        for ph in phase_results:
            if not ph.selected:
                print(f"     {ph.phase:10s}: too few samples ({ph.n_samples}), using defaults")
                continue

            calibrated_phase_thresholds[ph.phase] = {
                "minEdge": round(float(ph.min_edge), 3),
                "minProb": round(float(ph.min_prob), 3),
            }

            print(
                f"     {ph.phase:10s}: minEdge={ph.min_edge:.3f} minProb={ph.min_prob:.3f} | "
                f"{ph.n_entries}/{ph.n_samples} entries ({ph.n_entries/ph.n_samples*100:.1f}%), "
                f"acc={ph.accuracy*100:.1f}%"
            )
    else:
        print("   [WARN] minutes_left_norm or market_yes_price not found in features")
else:
    print("   Phase thresholds: skipped (too few OOF CV predictions)")

# --- EXPORT ---
print("\n   Exporting model...")

model.save_model(os.path.join(args.output_dir, "xgboost_model.ubj"))

trees_dump = dump_browser_trees(model)
all_trees, best_trees = trees_dump.all_trees, trees_dump.best_trees
print(f"   Trees: {len(best_trees)} (best) / {len(all_trees)} (total)")

# One metrics object feeds both the exported JSON block and training_report.txt,
# so the two can never disagree. JSON key order lives in mltrain/export.py.
export_holdout_frac = args.holdout_frac if args.holdout_frac > 0 else None
export_holdout_samples = len(y_holdout) if y_holdout is not None else 0
xgb_metrics = XgbEvalMetrics(
    accuracy=accuracy,
    auc=auc,
    f1=f1,
    logloss=ll,
    brier=brier,
    calibration=calibration,
    high_conf_accuracy=hc_acc,
    high_conf_ratio=hc_ratio,
    high_conf_count=hc_count,
    high_conf_threshold=best_threshold,
    cv_auc=cv_auc_final,
    cv_acc=cv_acc_final,
    cv_test_acc_gap=cv_test_acc_gap,
    cv_test_auc_gap=cv_test_auc_gap,
    holdout_accuracy=final_holdout_acc,
    holdout_auc=final_holdout_auc,
    test_holdout_acc_gap=test_holdout_acc_gap,
    test_holdout_auc_gap=test_holdout_auc_gap,
    test_samples=len(y_test),
    holdout_samples=export_holdout_samples,
    confidence_buckets=confidence_buckets,
)

browser_model = build_browser_model(
    best_trees,
    feature_cols=feature_cols,
    feature_cols_orig=feature_cols_orig,
    engineered_features=new_names,
    best_iteration=model.best_iteration,
    optimal_threshold=best_threshold,
    platt_a=platt_a,
    platt_b=platt_b,
    platt_on_logits=platt_on_logits,
    pruned_features=pruned_features,
    pre_excluded_features=exclude_feature_names,
    zero_features=zero_feature_names,
    recency_enabled=args.recency,
    recency_halflife=args.recency_halflife,
    signal_modifiers=signal_modifiers,
    phase_thresholds=calibrated_phase_thresholds,
    params=final_params,
    use_optuna=USE_OPTUNA,
    validation=ValidationInfo(
        test_size=args.test_size,
        holdout_frac=export_holdout_frac,
        strict_holdout=bool(args.strict_holdout),
        threshold_source=sweep_name,
        calibration_eval_source=eval_label,
        test_samples=len(y_test),
        holdout_samples=export_holdout_samples,
    ),
    metrics=xgb_metrics,
)

model_path = os.path.join(args.output_dir, "xgboost_model.json")
with open(model_path, "w") as f:
    json.dump(browser_model, f)
mb = os.path.getsize(model_path) / 1024 / 1024
print(f"   Browser model: {model_path} ({mb:.1f} MB)")

# Normaliser + engineered-feature specs assembled in mltrain/export.py (means and
# stds come from the FULL train block, not just the tune subset).
norm = build_norm_export(
    X_train_full,
    feature_cols=feature_cols,
    feature_cols_orig=feature_cols_orig,
    platt_a=platt_a,
    platt_b=platt_b,
    platt_on_logits=platt_on_logits,
    pruned_features=pruned_features,
    signal_modifiers=signal_modifiers,
    phase_thresholds=calibrated_phase_thresholds,
    holdout_frac=export_holdout_frac,
    holdout_start_idx=holdout_start_idx,
)

with open(os.path.join(args.output_dir, "norm_browser.json"), "w") as f:
    json.dump(norm, f, indent=2)

# Training report (text assembly in mltrain/report.py)
report = build_training_report(
    xgb_metrics,
    use_optuna=USE_OPTUNA,
    tune_trials=args.tune_trials,
    winner=best_cfg_name,
    threshold=best_threshold,
    n_trees=len(best_trees),
    feature_cols=feature_cols,
    feature_cols_orig=feature_cols_orig,
    engineered_features=new_names,
    platt_a=platt_a,
    platt_b=platt_b,
    pruned_features=pruned_features,
    zero_features=zero_feature_names,
    pre_excluded_features=exclude_feature_names,
    recency_enabled=args.recency,
    recency_halflife=args.recency_halflife,
    cv_folds=N_CV_FOLDS,
    num_boost_round=NUM_BOOST_ROUND,
    early_stopping=EARLY_STOPPING,
    params=final_params,
)

with open(os.path.join(args.output_dir, "training_report.txt"), "w") as f:
    f.write("\n".join(report))

print(f"""
==================================================
  XGBoost DONE — {best_cfg_name}
==================================================
  Accuracy:     {accuracy*100:.2f}%
  AUC:          {auc:.4f}
  High-conf:    {hc_acc*100:.1f}% ({hc_count:,} signals)
  Threshold:    {best_threshold:.3f}
  Trees:        {len(best_trees)}
  Features:     {len(feature_cols)} ({len(feature_cols_orig)} + {len(new_names)} eng)
  Platt:        A={platt_a:.4f} B={platt_b:.4f}
  Pruned:       {len(pruned_features)} features
  Zero-feat:    {', '.join(zero_feature_names) if zero_feature_names else 'none'}
  Pre-excluded: {len(exclude_feature_names)} features
  Recency:      {'half-life=' + str(args.recency_halflife) + 'd' if args.recency else 'off'}
  Sess-weight:  {'US x1.5, Overlap x1.3, Asia x0.8' if args.session_weight else 'off'}
  Method:       {'Optuna' if USE_OPTUNA else 'Grid search'}
  CV folds:     {N_CV_FOLDS}
==================================================
""")

# ================================================
# 9. LIGHTGBM ENSEMBLE PARTNER
# ================================================

try:
    import lightgbm  # availability probe — every lgb call lives in mltrain.lightgbm_*

    HAS_LGB = True
except ImportError:
    HAS_LGB = False

if HAS_LGB:
    # Tuning, the final fit, calibration, the ensemble-weight sweep, the browser
    # export and the norm_browser.json ensemble block all live in
    # mltrain/lightgbm_stage.py (which drives mltrain/lightgbm_train.py and
    # mltrain/lightgbm_export.py). Imported inside the guard — it pulls lightgbm
    # in transitively — so a missing lightgbm still degrades cleanly to the
    # XGBoost-only branch below. log=print keeps this file the owner of stdout.
    from mltrain.lightgbm_stage import run_lightgbm_stage

    print("[9/9] Training LightGBM ensemble partner...")

    lgb_stage = run_lightgbm_stage(
        X_train=X_train,
        y_train=y_train,
        w_train=w_train,
        X_final_train=X_final_train,
        y_final_train=y_final_train,
        w_train_final=w_train_final,
        X_test=X_test,
        y_test=y_test,
        X_holdout=X_holdout,
        y_holdout=y_holdout,
        feature_cols=feature_cols,
        seed=args.seed,
        embargo=CV_EMBARGO,
        n_folds=N_CV_FOLDS,
        use_optuna=USE_OPTUNA,
        xgb_model=model,
        xgb_dholdout=dholdout if has_holdout else None,
        xgb_oof_margins=oof_margins,
        xgb_oof_labels=oof_labels,
        xgb_oof_idx=oof_idx,
        xgb_platt_a=platt_a,
        xgb_platt_b=platt_b,
        xgb_test_probs=y_prob_final,
        xgb_accuracy=accuracy,
        xgb_auc=auc,
        norm=norm,
        output_dir=args.output_dir,
        strict_holdout=bool(args.strict_holdout),
        log=print,
    )

    print(f"""
==================================================
  ENSEMBLE DONE
==================================================
  XGB:      acc={accuracy*100:.2f}% | AUC={auc:.4f} | {len(best_trees)} trees
  LGB:      acc={lgb_stage.accuracy*100:.1f}% | AUC={lgb_stage.auc:.4f} | {lgb_stage.n_trees} trees
  Ensemble: acc={lgb_stage.ensemble_accuracy*100:.1f}% | AUC={lgb_stage.ensemble_auc:.4f} (w={lgb_stage.weight_xgb}/{lgb_stage.weight_lgb})
  Target: >=60% acc, >=70% high-conf
==================================================
""")

else:
    print("\n[9/9] LightGBM not available — XGBoost only")
    print("   Install with: pip install lightgbm")
    print(f"""
==================================================
  DONE — {best_cfg_name} (XGBoost only)
==================================================
  Accuracy:     {accuracy*100:.2f}%
  AUC:          {auc:.4f}
  High-conf:    {hc_acc*100:.1f}% ({hc_count:,} signals)
  Target: >=60% acc, >=70% high-conf
==================================================
""")
