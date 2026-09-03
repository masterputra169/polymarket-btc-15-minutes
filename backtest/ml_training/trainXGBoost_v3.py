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

import argparse, json, os, sys, warnings
import numpy as np

from mltrain.data import load_training_data, temporal_split
from mltrain.features import engineer_features
from mltrain.weights import build_feature_weights, build_sample_weights, count_regimes

warnings.filterwarnings('ignore')

# --- Optional: Optuna ---
try:
    import optuna
    optuna.logging.set_verbosity(optuna.logging.WARNING)
    HAS_OPTUNA = True
except ImportError:
    HAS_OPTUNA = False

parser = argparse.ArgumentParser()
parser.add_argument('--input', default='training_data.csv')
parser.add_argument('--output-dir', default='./output')
parser.add_argument('--test-size', type=float, default=0.15)
parser.add_argument('--seed', type=int, default=42)
parser.add_argument('--tune', action='store_true', help='Use Optuna Bayesian optimization')
parser.add_argument('--tune-trials', type=int, default=150, help='Number of Optuna trials')
parser.add_argument('--deploy', action='store_true')
parser.add_argument('--days', type=int, default=540)
parser.add_argument('--zero-features', type=str, default='',
                    help='Comma-separated feature names to zero out before training (e.g., macd_hist,macd_line)')
parser.add_argument('--exclude-features', type=str, default='funding_rate_change',
                    help='Comma-separated feature names to pre-exclude via feature_weights=0 (applied before Optuna). '
                         'Default: funding_rate_change (always zero at inference — audit fix C8)')
parser.add_argument('--recency', action='store_true',
                    help='Apply recency sample weighting (90-day half-life)')
parser.add_argument('--recency-halflife', type=int, default=90,
                    help='Half-life in days for recency weighting (default: 90)')
parser.add_argument('--regime-split', action='store_true',
                    help='Train separate models per regime (trending/moderate/choppy)')
parser.add_argument('--session-weight', action='store_true',
                    help='Apply session-based sample weighting: US/Overlap +50%%/+30%%, Asia -20%%. '
                         'Improves model accuracy during US trading hours without changing feature vector.')
parser.add_argument('--holdout-frac', type=float, default=0.125,
                    help='Reserve final N%% of train data as holdout (not seen by Optuna/CV). '
                         'Default 0.125 = 12.5%% holdout (audit fix C3). Set to 0 to disable.')
parser.add_argument('--strict-holdout', dest='strict_holdout', action='store_true', default=True,
                    help='(default) Keep holdout strictly OOS: final model trains ONLY on tune subset, '
                         'NEVER on holdout. Audit fix (May 2026) — previously final model retrained on '
                         'X_train_full which INCLUDED holdout, making the "holdout 94.12%%" metric leak. '
                         'Disable with --no-strict-holdout if you want the old behavior for replication.')
parser.add_argument('--no-strict-holdout', dest='strict_holdout', action='store_false')
parser.add_argument('--cv-embargo', type=int, default=16,
                    help='Rows skipped after every temporal boundary (CV folds, test, holdout) so '
                         'validation rows whose feature lookbacks overlap the training window are '
                         'excluded (ML4T embargo). 16 rows = 4h of 15-min markets. 0 disables.')
# Legacy flags kept for compatibility
parser.add_argument('--epochs', type=int, default=0)
args = parser.parse_args()

CV_EMBARGO = max(0, args.cv_embargo)

os.makedirs(args.output_dir, exist_ok=True)
np.random.seed(args.seed)

USE_OPTUNA = args.tune and HAS_OPTUNA
if args.tune and not HAS_OPTUNA:
    print("  WARNING: Optuna not installed. Falling back to grid search.")
    print("     Install with: pip install optuna")

# Parse --zero-features
zero_feature_names = [f.strip() for f in args.zero_features.split(',') if f.strip()] if args.zero_features else []

# Parse --exclude-features
exclude_feature_names = [f.strip() for f in args.exclude_features.split(',') if f.strip()] if args.exclude_features else []

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

fi = {name: i for i, name in enumerate(feature_cols_orig)}  # base-feature index map (used by later sections)
X, feature_cols = engineer_features(X_orig, feature_cols_orig)
new_names = feature_cols[len(feature_cols_orig):]
print(f"   +{len(new_names)} engineered = {len(feature_cols)} total features")

pre_exclude_fw = build_feature_weights(feature_cols, exclude_feature_names)

# ================================================
# 3. TEMPORAL SPLIT
# ================================================
print("[3/8] Temporal split...")
# Split arithmetic + embargo live in mltrain/data.py. X_train/y_train below are
# the TUNE subset whenever a holdout was carved out (Optuna/CV never see it).
splits = temporal_split(X, y, test_size=args.test_size,
                        holdout_frac=args.holdout_frac, embargo=CV_EMBARGO)
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
    X_train, fi,
    use_recency=args.recency, days=args.days, halflife=args.recency_halflife,
    use_session=args.session_weight,
)

for rn, rc in regime_counts.items():
    pct = rc / len(X) * 100
    print(f"   {rn}: {rc:,} samples ({pct:.1f}%) × weight 1.0")

# ================================================
# 5. TRAINING (Optuna or Grid Search)
# ================================================

import xgboost as xgb
from sklearn.metrics import accuracy_score, roc_auc_score, log_loss, f1_score, precision_score, recall_score, confusion_matrix, brier_score_loss
from sklearn.linear_model import LogisticRegression

# Pure logic extracted into the mltrain package (importable + unit-tested).
from mltrain.metrics import safe_round, calibration_summary, confidence_bucket_summary
from mltrain.cv import walk_forward_cv as _walk_forward_cv
from mltrain.export import (
    ValidationInfo,
    XgbEvalMetrics,
    build_browser_model,
    build_norm_export,
    compute_signal_modifiers,
    dump_browser_trees,
)
from mltrain.report import build_training_report
from mltrain.sweeps import (
    align_oof_predictions,
    select_ensemble_weights,
    select_phase_thresholds,
    select_threshold,
)


NUM_BOOST_ROUND = 1200
EARLY_STOPPING = 80
N_CV_FOLDS = 5

# --- Walk-Forward CV (logic lives in mltrain/cv.py; bound to this run's config) ---
def walk_forward_cv(X_tr: np.ndarray, y_tr: np.ndarray, cfg: dict, w_tr: np.ndarray | None = None,
                    n_folds: int = N_CV_FOLDS, return_preds: bool = False,
                    feat_weights: np.ndarray | None = None,
                    return_importances: bool = False) -> tuple:
    """Thin binding of mltrain.cv.walk_forward_cv to this run's globals."""
    return _walk_forward_cv(
        X_tr, y_tr, cfg, w_tr, n_folds, return_preds, feat_weights, return_importances,
        feature_cols=feature_cols, seed=args.seed, embargo=CV_EMBARGO,
        num_boost_round=NUM_BOOST_ROUND, early_stopping=EARLY_STOPPING,
    )


# --- 8 Seed Configurations ---
configs = {
    'A_balanced': {
        'max_depth': 5, 'learning_rate': 0.05, 'subsample': 0.8,
        'colsample_bytree': 0.8, 'min_child_weight': 5, 'gamma': 0.1,
        'reg_alpha': 0.1, 'reg_lambda': 1.0,
    },
    'B_deeper': {
        'max_depth': 7, 'learning_rate': 0.03, 'subsample': 0.75,
        'colsample_bytree': 0.7, 'min_child_weight': 3, 'gamma': 0.05,
        'reg_alpha': 0.05, 'reg_lambda': 0.8,
    },
    'C_wider': {
        'max_depth': 5, 'learning_rate': 0.08, 'subsample': 0.85,
        'colsample_bytree': 0.9, 'min_child_weight': 7, 'gamma': 0.15,
        'reg_alpha': 0.2, 'reg_lambda': 1.5,
    },
    'D_shallow_fast': {
        'max_depth': 4, 'learning_rate': 0.10, 'subsample': 0.9,
        'colsample_bytree': 0.85, 'min_child_weight': 10, 'gamma': 0.2,
        'reg_alpha': 0.3, 'reg_lambda': 2.0,
    },
    'E_deep_slow': {
        'max_depth': 6, 'learning_rate': 0.02, 'subsample': 0.7,
        'colsample_bytree': 0.75, 'min_child_weight': 4, 'gamma': 0.08,
        'reg_alpha': 0.1, 'reg_lambda': 1.2,
    },
    'F_aggressive': {
        'max_depth': 5, 'learning_rate': 0.12, 'subsample': 0.85,
        'colsample_bytree': 0.95, 'min_child_weight': 5, 'gamma': 0.05,
        'reg_alpha': 0.05, 'reg_lambda': 0.5,
    },
    'G_regularized': {
        'max_depth': 5, 'learning_rate': 0.06, 'subsample': 0.8,
        'colsample_bytree': 0.8, 'min_child_weight': 8, 'gamma': 0.25,
        'reg_alpha': 0.5, 'reg_lambda': 3.0,
    },
    'H_wide_shallow': {
        'max_depth': 3, 'learning_rate': 0.15, 'subsample': 0.9,
        'colsample_bytree': 0.95, 'min_child_weight': 12, 'gamma': 0.3,
        'reg_alpha': 0.4, 'reg_lambda': 2.5,
    },
}

best_cfg = None
best_cfg_name = None

if USE_OPTUNA:
    # --- Optuna Bayesian Optimization ---
    print(f"[5/8] Optuna optimization ({args.tune_trials} trials, {N_CV_FOLDS}-fold CV)...")

    def objective(trial):
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
        cv_auc, _ = walk_forward_cv(X_train, y_train, cfg, w_train, feat_weights=pre_exclude_fw if exclude_feature_names else None)
        if np.isnan(cv_auc) or cv_auc == 0:
            return 0.5  # random chance — bad trial but not NaN
        return cv_auc

    study = optuna.create_study(
        direction='maximize',
        sampler=optuna.samplers.TPESampler(seed=args.seed),
    )

    # Seed with 8 hand-tuned configs so Optuna starts smart
    for name, cfg in configs.items():
        study.enqueue_trial({
            'max_depth': cfg['max_depth'],
            'learning_rate': cfg['learning_rate'],
            'subsample': cfg['subsample'],
            'colsample_bytree': cfg['colsample_bytree'],
            'min_child_weight': cfg['min_child_weight'],
            'gamma': cfg['gamma'],
            'reg_alpha': cfg['reg_alpha'],
            'reg_lambda': cfg['reg_lambda'],
        })

    study.optimize(objective, n_trials=args.tune_trials, show_progress_bar=True)

    best_cfg = study.best_trial.params
    best_cfg_name = f"Optuna_trial_{study.best_trial.number}"
    print(f"   Best trial #{study.best_trial.number}: CV AUC = {study.best_value:.4f}")
    print(f"   Params: {json.dumps({k: round(v,4) if isinstance(v,float) else v for k,v in best_cfg.items()})}")

    # Show top 5 trials
    print(f"\n   Top 5 trials:")
    trials_sorted = sorted(study.trials, key=lambda t: t.value if t.value is not None else 0, reverse=True)
    for t in trials_sorted[:5]:
        print(f"     #{t.number}: AUC={t.value:.4f} | depth={t.params.get('max_depth')} lr={t.params.get('learning_rate',0):.4f} lambda={t.params.get('reg_lambda',0):.2f}")

else:
    # --- Grid Search (8 fixed configs) ---
    print(f"[5/8] Training 8 configs with {N_CV_FOLDS}-fold walk-forward CV...")

    cv_results = {}
    for name, cfg in configs.items():
        cv_auc, cv_acc = walk_forward_cv(X_train, y_train, cfg, w_train, feat_weights=pre_exclude_fw if exclude_feature_names else None)
        cv_results[name] = {'auc': cv_auc, 'acc': cv_acc}
        print(f"   {name}: CV acc={cv_acc*100:.1f}% | CV AUC={cv_auc:.4f}")

    # Pick best by CV AUC
    best_cfg_name = max(cv_results, key=lambda n: cv_results[n]['auc'])
    best_cfg = configs[best_cfg_name]
    print(f"\n   >>> Best config: {best_cfg_name} (CV AUC={cv_results[best_cfg_name]['auc']:.4f})")


# --- Train final model with best config ---
# Final model trains on full X_train (including holdout), since holdout was only
# excluded from Optuna/CV tuning. The model gets the most data possible.
print(f"\n   Training final model with {best_cfg_name}...")
if args.holdout_frac > 0:
    if args.strict_holdout:
        print(f"   (strict holdout: training on tune subset {len(X_train):,} samples; holdout {len(X_holdout):,} stays OOS)")
    else:
        print(f"   (non-strict: using full training data {len(X_train_full):,} samples — holdout INCLUDED in final train)")

final_params = {
    'objective': 'binary:logistic',
    'eval_metric': ['logloss', 'auc'],
    'scale_pos_weight': spw,
    'seed': args.seed,
    'tree_method': 'hist',
    **best_cfg,
}

# Audit fix (May 2026): when --strict-holdout (default), final model trains ONLY
# on the tune subset — holdout is never seen by the model. This keeps "holdout acc"
# an honest OOS metric. Previously X_train_full silently included the holdout,
# making early-stopping + threshold/phase/ensemble sweeps + final eval all touch
# the same data → multiple-comparisons + leak.
if args.holdout_frac > 0 and args.strict_holdout:
    X_final_train = X_train          # already swapped to tune subset at temporal-split step
    y_final_train = y_train
    w_train_final = w_train           # weights computed against tune subset
    print(f"   STRICT HOLDOUT: final model trains on tune subset only "
          f"({len(X_final_train):,} samples); holdout stays OOS.")
else:
    X_final_train = X_train_full
    y_final_train = y_train_full
    w_train_final = w_train
    if args.holdout_frac > 0 and args.recency:
        # Legacy path: recompute recency weights spanning full train (incl. holdout)
        n_full = len(X_train_full)
        days_ago_full = np.linspace(args.days, 0, n_full)
        w_train_final = (0.5 + 0.5 * np.exp(-days_ago_full / args.recency_halflife)).astype(np.float32)
    elif args.holdout_frac > 0:
        w_train_final = None  # full train had no weights (tune subset was swapped)
    if args.holdout_frac > 0:
        print(f"   [WARN] --no-strict-holdout: final model includes holdout — downstream "
              f"holdout metrics will be biased upward (legacy v16 behavior).")

dtrain = xgb.DMatrix(X_final_train, label=y_final_train, weight=w_train_final, feature_names=feature_cols)
if exclude_feature_names:
    # Ensure colsample_bytree < 1.0 for feature_weights to work
    if final_params.get('colsample_bytree', 1.0) >= 1.0:
        final_params['colsample_bytree'] = 0.95
    dtrain.feature_weights = pre_exclude_fw
dtest = xgb.DMatrix(X_test, label=y_test, feature_names=feature_cols)

# Early stopping on holdout (audit fix M-early) to avoid test data leakage
# If holdout available, monitor it; otherwise fall back to test set
if X_holdout is not None and len(X_holdout) > 0:
    dholdout = xgb.DMatrix(X_holdout, label=y_holdout, feature_names=feature_cols)
    early_stop_set = (dholdout, 'holdout')
    print(f"   Early stopping monitored on: holdout ({len(X_holdout):,} samples)")
else:
    early_stop_set = (dtest, 'eval')

ev = {}
model = xgb.train(
    final_params, dtrain,
    num_boost_round=NUM_BOOST_ROUND,
    evals=[(dtrain, 'train'), early_stop_set],
    evals_result=ev,
    early_stopping_rounds=EARLY_STOPPING,
    verbose_eval=False,
)

y_prob = model.predict(dtest)
initial_acc = accuracy_score(y_test, (y_prob >= 0.5).astype(int))
initial_auc = roc_auc_score(y_test, y_prob)
print(f"   Initial model: acc={initial_acc*100:.1f}% | AUC={initial_auc:.4f} | trees={model.best_iteration+1}")

# --- OOS holdout evaluation (if --holdout-frac was used) ---
if X_holdout is not None and len(X_holdout) > 0:
    if 'dholdout' not in dir() or dholdout is None:
        dholdout = xgb.DMatrix(X_holdout, label=y_holdout, feature_names=feature_cols)
    y_prob_holdout = model.predict(dholdout)
    holdout_acc = accuracy_score(y_holdout, (y_prob_holdout >= 0.5).astype(int))
    holdout_auc = roc_auc_score(y_holdout, y_prob_holdout)
    holdout_label = ("(OOS — strict: never seen by Optuna/CV/final-train)"
                     if args.strict_holdout else
                     "(LEAKED — Optuna/CV skipped but final-train INCLUDED this data; numbers are biased)")
    print(f"\n   === HOLDOUT EVALUATION {holdout_label} ===")
    print(f"   Holdout samples: {len(X_holdout):,}")
    print(f"   Holdout acc: {holdout_acc*100:.1f}% | AUC: {holdout_auc:.4f}")
    print(f"   Test    acc: {initial_acc*100:.1f}% | AUC: {initial_auc:.4f}")
    acc_drop = (initial_acc - holdout_acc) * 100
    auc_drop = (initial_auc - holdout_auc) * 10000
    print(f"   Delta: acc {acc_drop:+.1f}pp | AUC {auc_drop:+.0f}bp")
    if holdout_acc < initial_acc * 0.90:
        print(f"   [WARN] Holdout accuracy dropped >10% vs test — possible overfitting!")

# ================================================
# 6. FEATURE SELECTION (soft, via feature_weights)
# ================================================
print("\n[6/8] Feature selection...")

importance = model.get_score(importance_type='gain')
total_gain = sum(importance.values())
sorted_imp = sorted(importance.items(), key=lambda x: x[1], reverse=True)

# Identify low-importance features
PRUNE_THRESHOLD = 0.005  # features with <0.5% of total gain
pruned_features = []
pruned_model_kept = False  # True only when the soft-pruned retrain replaces `model`
combined_fw = None         # pre-exclude + soft-pruning feature weights (set on retrain)
feature_weights = np.ones(len(feature_cols), dtype=np.float32)

# Stability filter (ML4T ch8/11): single-model gain is noisy, so a feature is
# only pruned when it is ALSO below threshold in every walk-forward fold.
# Prevents pruning on noise and feature churn between retrains.
print("   Computing per-fold importances for stability check...")
_, _, fold_importances = walk_forward_cv(
    X_train, y_train, best_cfg, w_train, return_importances=True,
    feat_weights=pre_exclude_fw if exclude_feature_names else None
)
fold_fracs: dict[str, list[float]] = {feat: [] for feat in feature_cols}
for imp in fold_importances:
    fold_total = sum(imp.values())
    for feat in feature_cols:
        fold_fracs[feat].append((imp.get(feat, 0.0) / fold_total) if fold_total > 0 else 0.0)

rescued_by_stability = []
for i, feat in enumerate(feature_cols):
    gain = importance.get(feat, 0)
    frac = gain / total_gain if total_gain > 0 else 0
    if frac < PRUNE_THRESHOLD:
        fracs = fold_fracs.get(feat) or [0.0]
        if all(f < PRUNE_THRESHOLD for f in fracs):
            feature_weights[i] = 0.0  # effectively exclude from splits
            pruned_features.append(feat)
        else:
            rescued_by_stability.append(feat)

print(f"   Total features: {len(feature_cols)}")
print(f"   Pruned (< {PRUNE_THRESHOLD*100:.1f}% gain in final model AND all {len(fold_importances)} folds): {len(pruned_features)}")
if rescued_by_stability:
    print(f"   Rescued by fold stability (weak in final model, strong in >=1 fold): {len(rescued_by_stability)}"
          f" — {', '.join(rescued_by_stability[:10])}{'...' if len(rescued_by_stability) > 10 else ''}")
if pruned_features:
    print(f"   Pruned list: {', '.join(pruned_features[:15])}{'...' if len(pruned_features) > 15 else ''}")

# Retrain with feature weights if any features were pruned
if pruned_features and len(pruned_features) < len(feature_cols) * 0.5:
    print(f"   Retraining with {len(feature_cols) - len(pruned_features)} active features...")

    # Need colsample_bytree < 1.0 for feature_weights to take effect
    retrain_params = dict(final_params)
    if retrain_params.get('colsample_bytree', 1.0) >= 1.0:
        retrain_params['colsample_bytree'] = 0.95

    # Combine pre-exclude weights with soft-pruning weights
    combined_fw = feature_weights.copy()
    if exclude_feature_names:
        combined_fw = np.minimum(combined_fw, pre_exclude_fw)
    # Audit fix (May 2026 P6 follow-up): use X_final_train / y_final_train (which
    # respect strict-holdout). Previously used X_train_full unconditionally → weight
    # dimension mismatch when strict_holdout excluded holdout from final train.
    dtrain_fw = xgb.DMatrix(X_final_train, label=y_final_train, weight=w_train_final, feature_names=feature_cols)
    dtrain_fw.feature_weights = combined_fw

    # Early stop on holdout for pruned model too (audit fix M-prune)
    if X_holdout is not None and len(X_holdout) > 0:
        prune_early_stop_set = (dholdout, 'holdout')
    else:
        prune_early_stop_set = (dtest, 'eval')

    ev2 = {}
    model_pruned = xgb.train(
        retrain_params, dtrain_fw,
        num_boost_round=NUM_BOOST_ROUND,
        evals=[(dtrain_fw, 'train'), prune_early_stop_set],
        evals_result=ev2,
        early_stopping_rounds=EARLY_STOPPING,
        verbose_eval=False,
    )

    # Evaluate pruned model on holdout (audit fix M-prune) or test as fallback
    if X_holdout is not None and len(X_holdout) > 0:
        y_prob_pruned_eval = model_pruned.predict(dholdout)
        pruned_acc = accuracy_score(y_holdout, (y_prob_pruned_eval >= 0.5).astype(int))
        pruned_auc = roc_auc_score(y_holdout, y_prob_pruned_eval)
        eval_set_name = "holdout"
    else:
        y_prob_pruned_eval = model_pruned.predict(dtest)
        pruned_acc = accuracy_score(y_test, (y_prob_pruned_eval >= 0.5).astype(int))
        pruned_auc = roc_auc_score(y_test, y_prob_pruned_eval)
        eval_set_name = "test"
    print(f"   Pruned model ({eval_set_name}): acc={pruned_acc*100:.1f}% | AUC={pruned_auc:.4f} | trees={model_pruned.best_iteration+1}")

    # Compare on same eval set (holdout if available, test otherwise)
    if X_holdout is not None and len(X_holdout) > 0:
        initial_eval_prob = model.predict(dholdout)
        initial_eval_auc = roc_auc_score(y_holdout, initial_eval_prob)
    else:
        initial_eval_auc = initial_auc

    # Keep better model
    if pruned_auc >= initial_eval_auc - 0.002:  # allow tiny regression for simpler model
        print(f"   [OK]Using pruned model (AUC diff: {(pruned_auc-initial_eval_auc)*100:+.2f}%)")
        model = model_pruned
        pruned_model_kept = True
        y_prob = model_pruned.predict(dtest)  # always keep test predictions for final eval
    else:
        print(f"   [NO]Keeping original (pruned AUC {pruned_auc:.4f} < original {initial_eval_auc:.4f})")
        pruned_features = []  # reset since we're not using pruned model
else:
    print(f"   No features pruned (all above threshold or too many would be pruned)")

# ================================================
# 7. PLATT CALIBRATION
# ================================================
print("\n[7/8] Platt calibration (on raw logits — audit fix C4)...")

# Get out-of-fold predictions AND raw margins for calibration fitting.
# Use the SAME feature weighting the final model was trained with: soft-pruning
# weights (combined_fw) when the pruned retrain was kept, otherwise the
# pre-exclude weights (if any). Keeps cv_test_*_gap apples-to-apples.
cv_feat_weights = combined_fw if pruned_model_kept else (pre_exclude_fw if exclude_feature_names else None)
cv_auc_final, cv_acc_final, oof_preds, oof_margins, oof_labels, oof_idx = walk_forward_cv(
    X_train, y_train, best_cfg, w_train, return_preds=True,
    feat_weights=cv_feat_weights
)
print(f"   CV AUC: {cv_auc_final:.4f} | CV acc: {cv_acc_final*100:.1f}%")
print(f"   Out-of-fold predictions: {len(oof_preds)} samples")
print(f"   Out-of-fold margins: {len(oof_margins)} samples")

# Fit Platt scaling on RAW LOGITS (not post-sigmoid probabilities)
# This is the correct way: sigmoid(A*logit + B) gives properly calibrated probs
platt_a, platt_b = 1.0, 0.0  # defaults (identity)
platt_on_logits = True  # flag for browser inference
eval_label = 'test'  # where calibration was evaluated (overwritten below when holdout is used)

if len(oof_margins) > 100:
    lr = LogisticRegression(C=1.0, solver='lbfgs', max_iter=1000)
    lr.fit(oof_margins.reshape(-1, 1), oof_labels)
    platt_a = float(lr.coef_[0][0])
    platt_b = float(lr.intercept_[0])

    # Get raw margins from final model for evaluation
    y_margin_test = model.predict(dtest, output_margin=True)
    y_prob_calibrated = 1.0 / (1.0 + np.exp(-(platt_a * y_margin_test + platt_b)))

    # Evaluate calibration on holdout (audit fix M-cal) or test as fallback
    if X_holdout is not None and len(X_holdout) > 0:
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

    print(f"   Platt params (on logits): A={platt_a:.4f}, B={platt_b:.4f}")
    print(f"   Raw ({eval_label}):        acc={raw_acc*100:.1f}% | AUC={raw_auc:.4f}")
    print(f"   Calibrated ({eval_label}): acc={cal_acc*100:.1f}% | AUC={cal_auc:.4f}")

    if cal_auc < raw_auc - 0.005:
        print(f"   [WARN] Calibration hurts AUC on {eval_label}, disabling (A=1, B=0)")
        platt_a, platt_b = 1.0, 0.0
        y_prob_final = y_prob
    else:
        print(f"   [OK] Platt-on-logits calibration active")
        y_prob_final = y_prob_calibrated  # calibrated test probs for final eval
else:
    print(f"   [WARN] Not enough OOF margins ({len(oof_margins)}), skipping calibration")
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
if X_holdout is not None and len(X_holdout) > 0:
    final_margin_ho = model.predict(dholdout, output_margin=True)
    final_prob_ho = 1.0 / (1.0 + np.exp(-(platt_a * final_margin_ho + platt_b)))
    final_holdout_acc = float(accuracy_score(y_holdout, (final_prob_ho >= 0.5).astype(int)))
    final_holdout_auc = float(roc_auc_score(y_holdout, final_prob_ho))
    print(f"   Final holdout (final model + final Platt): "
          f"acc={final_holdout_acc*100:.1f}% | AUC={final_holdout_auc:.4f}")

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
test_holdout_acc_gap = float(accuracy - final_holdout_acc) if final_holdout_acc is not None else None
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
    print(f"   Test/Holdout gap: acc {test_holdout_acc_gap*100:+.2f}pp | AUC {test_holdout_auc_gap*10000:+.0f}bp")

cm = confusion_matrix(y_test, y_pred)
print(f"   Confusion Matrix:")
print(f"              Pred DOWN  Pred UP")
print(f"   Actual DOWN  {cm[0][0]:>6}    {cm[0][1]:>6}")
print(f"   Actual UP    {cm[1][0]:>6}    {cm[1][1]:>6}")

# Confidence analysis (use final calibrated probabilities)
print(f"\n   Confidence Distribution:")
buckets = [(0.50,0.55),(0.55,0.60),(0.60,0.65),(0.65,0.70),(0.70,0.75),(0.75,0.80),(0.80,0.85),(0.85,0.90),(0.90,1.0)]
for lo, hi in buckets:
    mask_up = (y_prob_final >= lo) & (y_prob_final < hi)
    mask_dn = (y_prob_final > (1-hi)) & (y_prob_final <= (1-lo))
    mask = mask_up | mask_dn
    if mask.sum() > 0:
        a = accuracy_score(y_test[mask], y_pred[mask])
        print(f"     {lo:.2f}-{hi:.2f}: {a*100:.1f}% acc ({mask.sum():,} samples, {mask.sum()/len(y_test)*100:.1f}%)")

# --- Optimal threshold scan on calibrated OOF CV predictions (audit fix C3, revised Sep 2026) ---
# The sweep itself (and the multiple-testing rationale behind selecting on OOF
# rather than on the strict OOS holdout) lives in mltrain/sweeps.select_threshold.
# This block owns only the source selection: OOF CV when available, with the
# holdout/test fallbacks kept for degenerate CV (no OOF rows). Thresholds are
# applied to calibrated probabilities at inference, so the sweep runs on the
# FINAL Platt transform (identity A=1/B=0 when calibration was disabled) applied
# to the OOF margins — the same probability space inference sees.
oof_cal_probs = (1.0 / (1.0 + np.exp(-(platt_a * oof_margins + platt_b)))
                 if len(oof_margins) > 0 else np.array([]))
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
high_mask = (y_prob_final < (1-best_threshold)) | (y_prob_final > best_threshold)
hc_acc = accuracy_score(y_test[high_mask], y_pred[high_mask]) if high_mask.sum() > 0 else 0
hc_count = int(high_mask.sum())
hc_ratio = hc_count / len(y_test) * 100

print(f"   HIGH-CONF (test, read-only): {hc_acc*100:.1f}% accuracy ({hc_count:,} signals, {hc_ratio:.1f}% of test)")

# Feature importance (from final model)
importance = model.get_score(importance_type='gain')
sorted_imp = sorted(importance.items(), key=lambda x: x[1], reverse=True)
print(f"\n   Top 25 Features (by gain):")
for i, (feat, gain) in enumerate(sorted_imp[:25]):
    bar = '#' * int(gain / sorted_imp[0][1] * 30)
    tag = " [ENG]" if feat in new_names else " [PRUNED]" if feat in pruned_features else ""
    print(f"     {i+1:2d}. {feat:<35s} {gain:>10.1f}  {bar}{tag}")

new_in_top20 = sum(1 for f,_ in sorted_imp[:20] if f in new_names)
print(f"\n   Engineered features in top 20: {new_in_top20}/{len(new_names)}")

if pruned_features:
    print(f"   Pruned features ({len(pruned_features)}): {', '.join(pruned_features)}")

# ── Data-Driven Calibration (audit Signals H2 + H3) ──
print("\n   --- Data-Driven Calibration ---")

# === Signal Modifiers (H2): Feature importance → probability.js signal weights ===
# The SIGNAL_FEATURE_MAP grouping and the mean-1.0 normalisation live in
# mltrain/export.compute_signal_modifiers; this block owns only the reporting.
signal_modifiers = compute_signal_modifiers(importance)

print(f"   Signal Modifiers (H2):")
for k in sorted(signal_modifiers.keys()):
    bar = '#' * int(signal_modifiers[k] * 15)
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
    print(f"\n   Phase Threshold Calibration (H3) on OOF CV predictions ({len(oof_cal_probs):,} samples)...")

    # Extract minutesLeft and market_yes_price from the X_train rows behind each OOF pred
    ml_idx = fi.get('minutes_left_norm')   # index 11
    mkt_idx = fi.get('market_yes_price')   # index 44

    if ml_idx is not None and mkt_idx is not None:
        ph_minutes = X_train[oof_idx, ml_idx] * 15  # denormalize
        ph_mkt_price = X_train[oof_idx, mkt_idx]

        # oof_cal_probs is the calibrated OOF probability (same Platt space inference uses)
        phase_results = select_phase_thresholds(
            oof_cal_probs, oof_labels, ph_minutes, ph_mkt_price,
        )

        calibrated_phase_thresholds = {}
        for ph in phase_results:
            if not ph.selected:
                print(f"     {ph.phase:10s}: too few samples ({ph.n_samples}), using defaults")
                continue

            calibrated_phase_thresholds[ph.phase] = {
                'minEdge': round(float(ph.min_edge), 3),
                'minProb': round(float(ph.min_prob), 3),
            }

            print(f"     {ph.phase:10s}: minEdge={ph.min_edge:.3f} minProb={ph.min_prob:.3f} | "
                  f"{ph.n_entries}/{ph.n_samples} entries ({ph.n_entries/ph.n_samples*100:.1f}%), "
                  f"acc={ph.accuracy*100:.1f}%")
    else:
        print(f"   [WARN] minutes_left_norm or market_yes_price not found in features")
else:
    print(f"   Phase thresholds: skipped (too few OOF CV predictions)")

# --- EXPORT ---
print(f"\n   Exporting model...")

model.save_model(os.path.join(args.output_dir, 'xgboost_model.ubj'))

trees_dump = dump_browser_trees(model)
all_trees, best_trees = trees_dump.all_trees, trees_dump.best_trees
print(f"   Trees: {len(best_trees)} (best) / {len(all_trees)} (total)")

# One metrics object feeds both the exported JSON block and training_report.txt,
# so the two can never disagree. JSON key order lives in mltrain/export.py.
export_holdout_frac = args.holdout_frac if args.holdout_frac > 0 else None
export_holdout_samples = int(len(y_holdout)) if y_holdout is not None else 0
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
    test_samples=int(len(y_test)),
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
        test_samples=int(len(y_test)),
        holdout_samples=export_holdout_samples,
    ),
    metrics=xgb_metrics,
)

model_path = os.path.join(args.output_dir, 'xgboost_model.json')
with open(model_path, 'w') as f:
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

with open(os.path.join(args.output_dir, 'norm_browser.json'), 'w') as f:
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

with open(os.path.join(args.output_dir, 'training_report.txt'), 'w') as f:
    f.write('\n'.join(report))

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

lgb_model_final = None
lgb_platt_a, lgb_platt_b = 1.0, 0.0
ens_weight_xgb, ens_weight_lgb = 0.5, 0.5

if HAS_LGB:
    # CV / tuning / training / calibration live in mltrain/lightgbm_train.py, the
    # browser export in mltrain/lightgbm_export.py (importable + unit-tested).
    # Imported inside the guard so a missing lightgbm still degrades cleanly to
    # the XGBoost-only branch at the bottom of this section.
    from mltrain.lightgbm_export import (
        build_lgb_browser_model,
        compute_init_score,
        verify_browser_inference,
    )
    from mltrain.lightgbm_train import (
        LGB_OPTUNA_TRIALS,
        default_lgb_params,
        evaluate_lgb,
        fit_lgb_platt,
        lgb_walk_forward_cv,
        platt_probs,
        train_final_lgb,
        tune_lgb_params,
    )

    print("[9/9] Training LightGBM ensemble partner...")

    # --- LightGBM Hyperparameter Optimization ---
    lgb_best_params = None

    if USE_OPTUNA:
        print(f"   Optuna optimization ({LGB_OPTUNA_TRIALS} trials, {N_CV_FOLDS}-fold CV)...")
        # seed + 1: the LGB study must not replay the XGBoost study's trial sequence.
        lgb_tuning = tune_lgb_params(
            X_train, y_train, w_train,
            feature_cols=feature_cols, seed=args.seed + 1, embargo=CV_EMBARGO,
            n_folds=N_CV_FOLDS,
        )
        lgb_best_params = lgb_tuning.params
        print(f"   Best trial #{lgb_tuning.best_trial}: CV AUC = {lgb_tuning.best_value:.4f}")
        print(f"   Params: {json.dumps({k: round(v,4) if isinstance(v,float) else v for k,v in lgb_best_params.items() if k not in ['objective','metric','verbosity']})}")
    else:
        # Default LightGBM params (no Optuna)
        lgb_best_params = default_lgb_params()
        print(f"   Using default LightGBM params (no Optuna)")

    # --- Train final LightGBM model ---
    # Use full training data; early stop on holdout (audit fix M-early)
    print(f"   Training final LightGBM model...")

    # Audit fix (May 2026 P6 follow-up): respect strict-holdout for LGB too
    if X_holdout is not None and len(X_holdout) > 0:
        lgb_X_val, lgb_y_val = X_holdout, y_holdout
        print(f"   LGB early stopping on: holdout ({len(X_holdout):,} samples)")
    else:
        lgb_X_val, lgb_y_val = X_test, y_test

    lgb_model_final = train_final_lgb(
        X_final_train, y_final_train, w_train_final, lgb_X_val, lgb_y_val,
        lgb_best_params, feature_cols=feature_cols,
    )

    lgb_scores = evaluate_lgb(lgb_model_final, X_test, y_test)
    lgb_acc, lgb_auc, lgb_n_trees = lgb_scores.accuracy, lgb_scores.auc, lgb_scores.n_trees
    print(f"   LightGBM: acc={lgb_acc*100:.1f}% | AUC={lgb_auc:.4f} | trees={lgb_n_trees}")

    # --- LightGBM Platt Calibration (on raw logits — audit fix C4) ---
    print(f"   LightGBM Platt calibration (on logits)...")
    lgb_cv_auc, lgb_cv_acc, lgb_oof_preds, lgb_oof_margins, lgb_oof_labels, lgb_oof_idx = lgb_walk_forward_cv(
        X_train, y_train, lgb_best_params, w_train, N_CV_FOLDS, return_preds=True,
        feature_cols=feature_cols, embargo=CV_EMBARGO,
    )
    print(f"   LGB CV AUC: {lgb_cv_auc:.4f} | CV acc: {lgb_cv_acc*100:.1f}%")

    lgb_calibrator = fit_lgb_platt(
        lgb_model_final, X_test, y_test, lgb_oof_margins, lgb_oof_labels, raw_auc=lgb_auc,
    )
    lgb_platt_a, lgb_platt_b = lgb_calibrator.a, lgb_calibrator.b
    lgb_platt_on_logits = lgb_calibrator.on_logits
    if lgb_calibrator.fitted:
        if not lgb_calibrator.kept:
            print(f"   [WARN] LGB calibration hurts AUC, disabling")
        else:
            print(f"   LGB Platt (on logits): A={lgb_platt_a:.4f}, B={lgb_platt_b:.4f}")
            print(f"   LGB calibrated: acc={lgb_calibrator.cal_accuracy*100:.1f}% | AUC={lgb_calibrator.cal_auc:.4f}")

    # Exported Brier/calibration must reflect the probabilities inference uses:
    # apply the FINAL Platt transform (identity when calibration was skipped or
    # disabled — sigmoid(raw margin) then equals the raw probability) to the raw
    # test margins before scoring.
    lgb_y_margin_final = lgb_model_final.predict(X_test, raw_score=True)
    lgb_y_prob_cal = platt_probs(lgb_y_margin_final, lgb_platt_a, lgb_platt_b)
    lgb_brier = brier_score_loss(y_test, lgb_y_prob_cal)
    lgb_calibration = calibration_summary(y_test, lgb_y_prob_cal)
    print(f"   LGB calibrated (exported): Brier={lgb_brier:.4f} | ECE={lgb_calibration['ece']:.4f}")

    # --- Ensemble Weight Optimization (on OOF CV preds — audit fix H5, revised Sep 2026) ---
    # The 11-candidate weight sweep and the OOF row-alignment check live in
    # mltrain/sweeps (select_ensemble_weights / align_oof_predictions), which
    # carry the multiple-testing rationale for selecting on OOF instead of the
    # strict OOS holdout. This block owns the Platt transforms, the reporting,
    # and the holdout/test fallbacks kept for degenerate/misaligned CV.
    ens_oof_xgb = None
    ens_oof_lgb = None
    ens_oof_labels = None
    if len(oof_margins) > 0 and len(lgb_oof_margins) > 0:
        xgb_oof_cal = platt_probs(oof_margins, platt_a, platt_b)
        lgb_oof_cal = platt_probs(lgb_oof_margins, lgb_platt_a, lgb_platt_b)
        ens_align = align_oof_predictions(
            xgb_oof_cal, lgb_oof_cal, oof_labels, oof_idx, lgb_oof_idx,
        )
        if ens_align.identical:
            print(f"\n   Ensemble OOF alignment check: OK "
                  f"({len(oof_idx):,} rows, XGB/LGB fold arithmetic identical)")
        else:
            print(f"\n   [WARN] Ensemble OOF rows misaligned (xgb={len(oof_idx)}, lgb={len(lgb_oof_idx)}) "
                  f"— re-aligning on {ens_align.n_common:,} common X_train row indices")
        ens_oof_xgb = ens_align.xgb_probs
        ens_oof_lgb = ens_align.lgb_probs
        ens_oof_labels = ens_align.labels

    if ens_oof_xgb is not None and len(ens_oof_xgb) >= 100:
        print(f"   Optimizing ensemble weights (on OOF CV predictions, {len(ens_oof_xgb):,} rows)...")
        best_ens_w = select_ensemble_weights(ens_oof_xgb, ens_oof_lgb, ens_oof_labels).weight_xgb
        sweep_label = "oof_cv"
    elif X_holdout is not None and len(X_holdout) > 0:
        # Fallback (degenerate/misaligned CV only): legacy holdout selection
        print(f"\n   Optimizing ensemble weights (on holdout — OOF unavailable)...")
        xgb_margin_ho = model.predict(dholdout, output_margin=True)
        xgb_cal_ho = platt_probs(xgb_margin_ho, platt_a, platt_b)
        lgb_margin_ho = lgb_model_final.predict(X_holdout, raw_score=True)
        lgb_cal_ho = platt_probs(lgb_margin_ho, lgb_platt_a, lgb_platt_b)

        best_ens_w = select_ensemble_weights(xgb_cal_ho, lgb_cal_ho, y_holdout).weight_xgb
        sweep_label = "holdout"
    else:
        print(f"\n   Optimizing ensemble weights (on test, no holdout)...")
        xgb_cal_test = y_prob_final
        lgb_margin_test = lgb_model_final.predict(X_test, raw_score=True)
        lgb_cal_test = platt_probs(lgb_margin_test, lgb_platt_a, lgb_platt_b)

        best_ens_w = select_ensemble_weights(xgb_cal_test, lgb_cal_test, y_test).weight_xgb
        sweep_label = "test"

    ens_weight_xgb = round(best_ens_w, 3)
    ens_weight_lgb = round(1 - best_ens_w, 3)

    # Report on test (read-only) regardless of where weights were tuned
    xgb_cal_probs = y_prob_final
    lgb_y_margin_ens = lgb_model_final.predict(X_test, raw_score=True)
    lgb_cal_probs = platt_probs(lgb_y_margin_ens, lgb_platt_a, lgb_platt_b)
    ens_prob_final = ens_weight_xgb * xgb_cal_probs + ens_weight_lgb * lgb_cal_probs
    ens_acc = accuracy_score(y_test, (ens_prob_final >= 0.5).astype(int))
    ens_auc_final = roc_auc_score(y_test, ens_prob_final)
    ens_logloss = log_loss(y_test, ens_prob_final)
    ens_brier = brier_score_loss(y_test, ens_prob_final)
    ens_calibration = calibration_summary(y_test, ens_prob_final)

    print(f"\n   === Ensemble Results (weights from {sweep_label}) ===")
    print(f"   XGB weight: {ens_weight_xgb} | LGB weight: {ens_weight_lgb}")
    print(f"   XGB only:   acc={accuracy*100:.1f}% | AUC={auc:.4f}")
    print(f"   LGB only:   acc={lgb_acc*100:.1f}% | AUC={lgb_auc:.4f}")
    print(f"   Ensemble:   acc={ens_acc*100:.1f}% | AUC={ens_auc_final:.4f} | ECE={ens_calibration['ece']:.4f}")

    # --- Export LightGBM model ---
    print(f"\n   Exporting LightGBM model...")
    lgb_dump = lgb_model_final.dump_model()

    # Compute init_score for browser inference
    lgb_init_score = compute_init_score(y_train, w_train)

    # C2: Use len(sliced_trees) for num_trees to avoid off-by-one
    sliced_tree_info = lgb_dump['tree_info'][:lgb_n_trees]
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
        ensemble_weights={'xgb': ens_weight_xgb, 'lgb': ens_weight_lgb},
    )

    lgb_path = os.path.join(args.output_dir, 'lightgbm_model.json')
    with open(lgb_path, 'w') as f:
        json.dump(lgb_browser, f)
    lgb_mb = os.path.getsize(lgb_path) / 1024 / 1024
    print(f"   LGB model: {lgb_path} ({lgb_mb:.1f} MB)")

    # --- Update norm_browser.json with ensemble info ---
    norm['ensemble_weights'] = {'xgb': ens_weight_xgb, 'lgb': ens_weight_lgb}
    norm['ensemble_metrics'] = {
        'accuracy': round(ens_acc, 4),
        'auc': round(ens_auc_final, 4),
        'logloss': round(ens_logloss, 4),
        'brier': round(ens_brier, 4),
        'calibration_ece': safe_round(ens_calibration['ece']),
        'calibration_mce': safe_round(ens_calibration['mce']),
        'weight_source': sweep_label,
        'test_samples': int(len(y_test)),
        'holdout_samples': int(len(y_holdout)) if y_holdout is not None else 0,
        'strict_holdout': bool(args.strict_holdout),
    }
    norm['lgb_platt_a'] = lgb_platt_a
    norm['lgb_platt_b'] = lgb_platt_b
    norm['lgb_platt_on_logits'] = lgb_platt_on_logits

    with open(os.path.join(args.output_dir, 'norm_browser.json'), 'w') as f:
        json.dump(norm, f, indent=2)
    print(f"   Updated norm_browser.json with ensemble weights")

    # --- Verify browser inference consistency ---
    print(f"\n   Verifying LGB browser inference...")
    max_diff = verify_browser_inference(lgb_model_final, sliced_tree_info, lgb_init_score, X_test)
    print(f"   Max raw score diff (model vs manual): {max_diff:.8f}")
    if max_diff > 0.01:
        print(f"   [WARN] Large inference discrepancy! Browser predictions may differ.")
    else:
        print(f"   [OK] Browser inference verified")

    print(f"""
==================================================
  ENSEMBLE DONE
==================================================
  XGB:      acc={accuracy*100:.2f}% | AUC={auc:.4f} | {len(best_trees)} trees
  LGB:      acc={lgb_acc*100:.1f}% | AUC={lgb_auc:.4f} | {lgb_n_trees} trees
  Ensemble: acc={ens_acc*100:.1f}% | AUC={ens_auc_final:.4f} (w={ens_weight_xgb}/{ens_weight_lgb})
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
