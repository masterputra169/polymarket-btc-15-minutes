#!/usr/bin/env python3
"""
=== XGBoost v9 — Advanced Training Pipeline ===

v9 improvements (ML-retrain audit fixes):
  - C1: Real Polymarket market prices (via polymarket_lookup.json)
  - C3: Threshold sweep on holdout split (default 12.5%), not test
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
import pandas as pd

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
                    help='Apply session-based sample weighting: US/Overlap +50%/+30%, Asia -20%. '
                         'Improves model accuracy during US trading hours without changing feature vector.')
parser.add_argument('--holdout-frac', type=float, default=0.125,
                    help='Reserve final N%% of train data as holdout (not seen by Optuna/CV). '
                         'Default 0.125 = 12.5%% holdout (audit fix C3). Set to 0 to disable.')
# Legacy flags kept for compatibility
parser.add_argument('--epochs', type=int, default=0)
args = parser.parse_args()

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
df = pd.read_csv(args.input)
# Drop metadata columns (not features, just row identifiers from data generation)
metadata_cols = ['slug_timestamp']
feature_cols_orig = [c for c in df.columns if c != 'label' and c not in metadata_cols]
X_orig = df[feature_cols_orig].values.astype(np.float32)
y = df['label'].values.astype(np.int32)
X_orig = np.nan_to_num(X_orig, nan=0.0, posinf=0.0, neginf=0.0)

# Apply --zero-features: zero out specified columns
if zero_feature_names:
    fi_lookup = {name: i for i, name in enumerate(feature_cols_orig)}
    for zf in zero_feature_names:
        if zf in fi_lookup:
            X_orig[:, fi_lookup[zf]] = 0.0
            print(f"   Zeroed feature: {zf} (idx {fi_lookup[zf]})")
        else:
            print(f"   WARNING: --zero-features '{zf}' not found in CSV columns")

n_base = len(feature_cols_orig)
up = int(y.sum()); dn = len(y) - up
print(f"   {len(df):,} rows | {n_base} base features | UP={up} DOWN={dn}")
spw = dn / max(up, 1)

# ================================================
# 2. ENGINEER 25 FEATURES
# ================================================
print("[2/8] Engineering 25 features...")

fi = {name: i for i, name in enumerate(feature_cols_orig)}
def col(name): return X_orig[:, fi[name]] if name in fi else np.zeros(len(X_orig))

delta_1m = col('delta_1m_pct')
delta_3m = col('delta_3m_pct')
rsi = col('rsi_norm')
rsi_slope = col('rsi_slope')
vwap_dist = col('vwap_dist')
vwap_slope = col('vwap_slope')
macd_line = col('macd_line')
macd_hist = col('macd_hist')
vol_ratio = col('vol_ratio_norm')
multi_tf = col('multi_tf_agreement')
bb_pctb = col('bb_percent_b')
bb_squeeze = col('bb_squeeze')
atr_pct = col('atr_pct_norm')
vol_buy = col('vol_delta_buy_ratio')
ema_cross = col('ema_cross_signal')
ema_dist = col('ema_dist_norm')
stoch_k = col('stoch_k_norm')
ha_consec = col('ha_signed_consec')
regime_trending = col('regime_trending')
regime_confidence = col('regime_confidence')  # v8: was regime_choppy
regime_mr = col('regime_mean_reverting')
ha_green = col('ha_is_green')

new = {}
# --- Original 16 engineered features ---
new['delta_1m_capped'] = np.clip(delta_1m, -0.003, 0.003)
new['momentum_accel'] = delta_1m - (delta_3m / 3)
new['rsi_x_trending'] = rsi * regime_trending
new['rsi_x_regime_conf'] = rsi * regime_confidence  # v8: was rsi_x_choppy = rsi * regime_choppy
new['rsi_x_mean_rev'] = rsi * regime_mr
new['delta1m_x_multitf'] = delta_1m * multi_tf
new['bb_pctb_x_squeeze'] = bb_pctb * bb_squeeze
new['vol_buy_x_delta'] = vol_buy * np.sign(delta_1m)
new['vwap_trend_strength'] = vwap_dist * np.sign(vwap_slope)
new['rsi_divergence'] = np.sign(delta_3m) * (-rsi_slope)
new['combined_oscillator'] = (rsi + stoch_k + bb_pctb) / 3
new['ha_delta_agree'] = (np.sign(ha_consec) == np.sign(delta_1m)).astype(np.float32)
atr_safe = np.where(atr_pct > 0.01, atr_pct, 0.01)
new['delta_1m_atr_adj'] = delta_1m / atr_safe
new['price_position_score'] = np.sign(vwap_dist)*0.4 + (bb_pctb-0.5)*0.3 + (ema_cross-0.5)*0.3
new['vol_weighted_momentum'] = delta_1m * vol_ratio
new['macd_x_rsi_slope'] = np.sign(macd_line) * rsi_slope

# --- 6 engineered features (agreement/confirmation focus) ---
new['trend_alignment_score'] = regime_trending * multi_tf * np.sign(delta_1m)
new['oscillator_extreme'] = np.maximum(rsi - 0.7, 0) + np.maximum(0.3 - rsi, 0)
new['vol_momentum_confirm'] = vol_buy * np.sign(delta_1m) * vol_ratio
new['squeeze_breakout_potential'] = bb_squeeze * np.abs(stoch_k - 0.5) * 2

delta_dir = np.sign(delta_1m)
agree_count = (
    (np.sign(ha_consec) == delta_dir).astype(np.float32) +
    (np.sign(macd_hist) == delta_dir).astype(np.float32) +
    (np.sign(vwap_dist) == delta_dir).astype(np.float32) +
    ((rsi > 0.5).astype(np.float32) == (delta_dir > 0).astype(np.float32)).astype(np.float32) +
    (multi_tf).astype(np.float32)
)
new['multi_indicator_agree'] = agree_count / 5.0
new['stoch_rsi_extreme'] = np.maximum(stoch_k - 0.8, 0) * 5 + np.maximum(0.2 - stoch_k, 0) * 5

# --- 3 engineered features (Polymarket crowd/orderbook interactions) ---
market_price_momentum = col('market_price_momentum')
orderbook_imbalance = col('orderbook_imbalance')
crowd_model_divergence = col('crowd_model_divergence')
rule_confidence = col('rule_confidence')

new['crowd_agree_momentum'] = np.sign(market_price_momentum) * np.sign(delta_1m)
new['divergence_x_confidence'] = crowd_model_divergence * rule_confidence
new['imbalance_x_vol_delta'] = orderbook_imbalance * vol_buy

new_names = list(new.keys())
X = np.hstack([X_orig, np.column_stack([new[n] for n in new_names])]).astype(np.float32)
X = np.nan_to_num(X, nan=0.0, posinf=0.0, neginf=0.0)
feature_cols = feature_cols_orig + new_names
print(f"   +{len(new_names)} engineered = {len(feature_cols)} total features")

# Build pre-exclude feature weights (Task B: zero out consistently pruned features BEFORE Optuna)
pre_exclude_fw = np.ones(len(feature_cols), dtype=np.float32)
if exclude_feature_names:
    fi_all = {name: i for i, name in enumerate(feature_cols)}
    excluded_count = 0
    for ef in exclude_feature_names:
        if ef in fi_all:
            pre_exclude_fw[fi_all[ef]] = 0.0
            excluded_count += 1
        else:
            print(f"   WARNING: --exclude-features '{ef}' not found in feature list")
    print(f"   Pre-excluded {excluded_count} features via feature_weights=0")

# ================================================
# 3. TEMPORAL SPLIT
# ================================================
print("[3/8] Temporal split...")
split = int(len(X) * (1 - args.test_size))
X_train, X_test = X[:split], X[split:]
y_train, y_test = y[:split], y[split:]
print(f"   Train: {len(X_train):,} | Test: {len(X_test):,}")

# OOS holdout: reserve final portion of training data for true out-of-sample evaluation
# This data is NOT seen by Optuna or walk-forward CV
X_holdout, y_holdout, w_holdout = None, None, None
holdout_start_idx = None
if args.holdout_frac > 0:
    holdout_boundary = int(len(X_train) * (1 - args.holdout_frac))
    holdout_start_idx = holdout_boundary
    X_holdout = X_train[holdout_boundary:]
    y_holdout = y_train[holdout_boundary:]
    X_tune = X_train[:holdout_boundary]
    y_tune = y_train[:holdout_boundary]
    print(f"   OOS HOLDOUT: {len(X_holdout):,} samples reserved (not used for tuning)")
    print(f"   Tune set: {len(X_tune):,} | Holdout: {len(X_holdout):,}")
    # Swap: Optuna and CV will use X_tune/y_tune instead of full X_train/y_train
    X_train_full, y_train_full = X_train, y_train  # keep reference to full train for final model
    X_train, y_train = X_tune, y_tune
else:
    X_train_full, y_train_full = X_train, y_train

# ================================================
# 4. REGIME STATS (no sample weighting — v7 showed it doesn't help)
# ================================================
print("[4/8] Regime statistics (uniform weights)...")

regime_idx = {
    'trending': fi.get('regime_trending'),
    'mean_rev': fi.get('regime_mean_reverting'),
    'moderate': fi.get('regime_moderate'),
}

regime_counts = {}
for regime_name, feat_idx in regime_idx.items():
    if feat_idx is None:
        continue
    mask = X_orig[:, feat_idx] > 0.5
    regime_counts[regime_name] = int(mask.sum())

# Sample weights: start with uniform, optionally add recency weighting
w_train = None
w_test = None

if args.recency:
    # Task H: Recency-weighted training — recent data matters more
    # Rows are chronological; estimate days_ago from row position
    n_train = len(X_train)
    days_ago = np.linspace(args.days, 0, n_train)  # first row = oldest, last = newest
    recency_weight = 0.5 + 0.5 * np.exp(-days_ago / args.recency_halflife)
    w_train = recency_weight.astype(np.float32)
    print(f"   Recency weighting: half-life={args.recency_halflife}d")
    print(f"     Oldest sample weight: {w_train[0]:.3f} | Newest: {w_train[-1]:.3f} | Mean: {w_train.mean():.3f}")

if args.session_weight:
    # v10: Session-based sample weighting — boost underrepresented US/Overlap patterns.
    # US and EU/US Overlap sessions have lower ML confidence in production because the
    # model sees fewer high-quality examples from these volatile hours. Up-weighting
    # forces the model to learn US-specific patterns from existing session features
    # (session_us, session_overlap, hour_sin/cos at indices 22, 23, 42, 43 in X_orig).
    # No new features needed — works with existing 74-feature vector.
    if w_train is None:
        w_train = np.ones(len(X_train), dtype=np.float32)
    # Feature indices from fi lookup (X_orig columns = same indices in X since engineered appended)
    sess_us_idx  = fi.get('session_us')       # index 22
    sess_ov_idx  = fi.get('session_overlap')  # index 23
    sess_asia_idx = fi.get('session_asia')    # index 20
    n_us = n_ov = n_asia = 0
    if sess_us_idx is not None:
        us_mask = X_train[:, sess_us_idx] > 0.5
        w_train[us_mask] *= 1.5
        n_us = int(us_mask.sum())
    if sess_ov_idx is not None:
        ov_mask = X_train[:, sess_ov_idx] > 0.5
        w_train[ov_mask] *= 1.3
        n_ov = int(ov_mask.sum())
    if sess_asia_idx is not None:
        asia_mask = X_train[:, sess_asia_idx] > 0.5
        w_train[asia_mask] *= 0.8
        n_asia = int(asia_mask.sum())
    # Normalize so mean weight stays ~1.0 (preserves effective sample count)
    w_mean = w_train.mean()
    w_train = w_train / w_mean
    print(f"   Session weighting applied:")
    print(f"     US ×1.5       : {n_us:,} samples")
    print(f"     Overlap ×1.3  : {n_ov:,} samples")
    print(f"     Asia ×0.8     : {n_asia:,} samples")
    print(f"     Normalized (mean={w_mean:.3f} -> 1.000)")

for rn, rc in regime_counts.items():
    pct = rc / len(X) * 100
    print(f"   {rn}: {rc:,} samples ({pct:.1f}%) × weight 1.0")

# ================================================
# 5. TRAINING (Optuna or Grid Search)
# ================================================

import xgboost as xgb
from sklearn.metrics import accuracy_score, roc_auc_score, log_loss, f1_score, precision_score, recall_score, confusion_matrix
from sklearn.linear_model import LogisticRegression

NUM_BOOST_ROUND = 1200
EARLY_STOPPING = 80
N_CV_FOLDS = 5

# --- Walk-Forward CV ---
def walk_forward_cv(X_tr, y_tr, cfg, w_tr=None, n_folds=N_CV_FOLDS, return_preds=False, feat_weights=None):
    """Walk-forward CV: train on folds 1..k, validate on fold k+1.
    Optionally returns out-of-fold predictions AND raw margins for calibration.
    feat_weights: optional per-feature weight array (0=exclude from splits)."""
    fold_size = len(X_tr) // (n_folds + 2)
    aucs, accs = [], []
    oof_preds, oof_margins, oof_labels = [], [], []

    for fold in range(n_folds):
        tr_end = fold_size * (fold + 2)
        val_start = tr_end
        val_end = len(X_tr) if fold == n_folds - 1 else val_start + fold_size
        if val_end <= val_start:
            continue

        X_f_train = X_tr[:tr_end]
        y_f_train = y_tr[:tr_end]
        X_f_val = X_tr[val_start:val_end]
        y_f_val = y_tr[val_start:val_end]
        w_f_train = w_tr[:tr_end] if w_tr is not None else None

        spw_f = (len(y_f_train) - y_f_train.sum()) / max(y_f_train.sum(), 1)

        params = {
            'objective': 'binary:logistic',
            'eval_metric': ['logloss', 'auc'],
            'scale_pos_weight': spw_f,
            'seed': args.seed,
            'tree_method': 'hist',
            **cfg,
        }
        # feature_weights requires colsample_bytree < 1.0
        if feat_weights is not None and params.get('colsample_bytree', 1.0) >= 1.0:
            params['colsample_bytree'] = 0.95

        dtrain_f = xgb.DMatrix(X_f_train, label=y_f_train, weight=w_f_train, feature_names=feature_cols)
        if feat_weights is not None:
            dtrain_f.feature_weights = feat_weights
        dval_f = xgb.DMatrix(X_f_val, label=y_f_val, feature_names=feature_cols)

        model_f = xgb.train(
            params, dtrain_f,
            num_boost_round=NUM_BOOST_ROUND,
            evals=[(dval_f, 'eval')],
            early_stopping_rounds=EARLY_STOPPING,
            verbose_eval=False,
        )

        y_prob_f = model_f.predict(dval_f)

        # Guard against NaN predictions from degenerate hyperparameters
        if np.any(np.isnan(y_prob_f)):
            continue

        acc_f = accuracy_score(y_f_val, (y_prob_f >= 0.5).astype(int))
        try:
            auc_f = roc_auc_score(y_f_val, y_prob_f)
        except ValueError:
            # Only one class in fold or other issue
            auc_f = 0.5
        if np.isnan(auc_f):
            auc_f = 0.5
        aucs.append(auc_f)
        accs.append(acc_f)

        if return_preds:
            oof_preds.extend(y_prob_f.tolist())
            # Also collect raw margins (logits) for Platt-on-logits calibration (C4)
            y_margin_f = model_f.predict(dval_f, output_margin=True)
            oof_margins.extend(y_margin_f.tolist())
            oof_labels.extend(y_f_val.tolist())

    mean_auc = np.mean(aucs) if aucs else 0
    mean_acc = np.mean(accs) if accs else 0

    if return_preds:
        return mean_auc, mean_acc, np.array(oof_preds), np.array(oof_margins), np.array(oof_labels)
    return mean_auc, mean_acc


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
    print(f"   (using full training data: {len(X_train_full):,} samples, holdout was only excluded from tuning)")

final_params = {
    'objective': 'binary:logistic',
    'eval_metric': ['logloss', 'auc'],
    'scale_pos_weight': spw,
    'seed': args.seed,
    'tree_method': 'hist',
    **best_cfg,
}

# Recalculate sample weights for full training set if holdout was used
w_train_final = w_train
if args.holdout_frac > 0 and args.recency:
    n_full = len(X_train_full)
    days_ago_full = np.linspace(args.days, 0, n_full)
    w_train_final = (0.5 + 0.5 * np.exp(-days_ago_full / args.recency_halflife)).astype(np.float32)
elif args.holdout_frac > 0:
    w_train_final = None  # full train had no weights (tune subset was swapped)

dtrain = xgb.DMatrix(X_train_full, label=y_train_full, weight=w_train_final, feature_names=feature_cols)
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
    print(f"\n   === OOS HOLDOUT (Optuna/CV never saw this data) ===")
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
feature_weights = np.ones(len(feature_cols), dtype=np.float32)

for i, feat in enumerate(feature_cols):
    gain = importance.get(feat, 0)
    frac = gain / total_gain if total_gain > 0 else 0
    if frac < PRUNE_THRESHOLD:
        feature_weights[i] = 0.0  # effectively exclude from splits
        pruned_features.append(feat)

print(f"   Total features: {len(feature_cols)}")
print(f"   Pruned (< {PRUNE_THRESHOLD*100:.1f}% gain): {len(pruned_features)}")
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
    dtrain_fw = xgb.DMatrix(X_train_full, label=y_train_full, weight=w_train_final, feature_names=feature_cols)
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

# Get out-of-fold predictions AND raw margins for calibration fitting
cv_auc_final, cv_acc_final, oof_preds, oof_margins, oof_labels = walk_forward_cv(
    X_train, y_train, best_cfg, w_train, return_preds=True,
    feat_weights=pre_exclude_fw if exclude_feature_names else None
)
print(f"   CV AUC: {cv_auc_final:.4f} | CV acc: {cv_acc_final*100:.1f}%")
print(f"   Out-of-fold predictions: {len(oof_preds)} samples")
print(f"   Out-of-fold margins: {len(oof_margins)} samples")

# Fit Platt scaling on RAW LOGITS (not post-sigmoid probabilities)
# This is the correct way: sigmoid(A*logit + B) gives properly calibrated probs
platt_a, platt_b = 1.0, 0.0  # defaults (identity)
platt_on_logits = True  # flag for browser inference

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

print(f"""
   ====================================
   Accuracy:   {accuracy*100:.2f}%
   Precision:  {precision:.4f}
   Recall:     {recall:.4f}
   F1:         {f1:.4f}
   AUC-ROC:    {auc:.4f}
   Log Loss:   {ll:.4f}
   ====================================
""")

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

# --- Optimal threshold scan on holdout (audit fix C3) or test fallback ---
# Threshold is selected on holdout to prevent information leakage
if X_holdout is not None and len(X_holdout) > 0:
    # Use holdout for threshold selection
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

best_threshold = 0.60
best_score = 0
for thresh in np.arange(0.55, 0.85, 0.005):
    hmask = (sweep_probs < (1-thresh)) | (sweep_probs > thresh)
    if hmask.sum() < 50: continue
    hacc = accuracy_score(sweep_labels[hmask], sweep_preds[hmask])
    hratio = hmask.sum() / len(sweep_labels)
    score = hacc * np.sqrt(hratio)
    if score > best_score:
        best_score = score
        best_threshold = thresh

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
# Map XGBoost feature importances to probability.js signal modifier keys.
# Each key groups features that inform one scoring signal in scoreDirection().
SIGNAL_FEATURE_MAP = {
    'ptbDistance': ['ptb_dist_pct'],
    'momentum': ['delta_1m_pct', 'delta_3m_pct', 'momentum_5candle_slope',
                  'delta_1m_capped', 'momentum_accel', 'vol_weighted_momentum',
                  'delta_1m_atr_adj'],
    'rsi': ['rsi_norm', 'rsi_slope', 'stoch_k_norm', 'stoch_kd_norm',
            'rsi_x_trending', 'rsi_x_regime_conf', 'rsi_x_mean_rev',
            'combined_oscillator', 'oscillator_extreme', 'rsi_divergence',
            'stoch_rsi_extreme'],
    'macdHist': ['macd_hist'],
    'macdLine': ['macd_line', 'macd_x_rsi_slope'],
    'vwapPos': ['vwap_dist', 'vwap_trend_strength', 'price_position_score'],
    'vwapSlope': ['vwap_slope'],
    'heikenAshi': ['ha_signed_consec', 'ha_is_green', 'ha_delta_agree'],
    'failedVwap': ['failed_vwap_reclaim'],
    'orderbook': ['orderbook_imbalance', 'imbalance_x_vol_delta'],
    'multiTf': ['multi_tf_agreement', 'delta1m_x_multitf',
                'trend_alignment_score', 'multi_indicator_agree'],
    'bbPos': ['bb_percent_b', 'bb_width', 'bb_squeeze', 'bb_squeeze_intensity',
              'bb_pctb_x_squeeze', 'squeeze_breakout_potential'],
    'atrExpand': ['atr_pct_norm', 'atr_ratio_norm', 'atr_expanding'],
}

signal_importances = {}
for signal_key, feat_names in SIGNAL_FEATURE_MAP.items():
    total_gain = sum(importance.get(fn, 0) for fn in feat_names)
    signal_importances[signal_key] = total_gain

# Normalize: mean modifier = 1.0
sig_gains = list(signal_importances.values())
mean_sig_gain = np.mean(sig_gains) if sig_gains else 1.0
if mean_sig_gain < 1e-8:
    mean_sig_gain = 1.0

signal_modifiers = {}
for key, gain in signal_importances.items():
    mod_val = gain / mean_sig_gain
    mod_val = max(0.3, min(3.0, mod_val))  # clamp to prevent extreme values
    signal_modifiers[key] = round(float(mod_val), 2)

print(f"   Signal Modifiers (H2):")
for k in sorted(signal_modifiers.keys()):
    bar = '#' * int(signal_modifiers[k] * 15)
    print(f"     {k:<15s}: {signal_modifiers[k]:.2f}  {bar}")

# === Phase Thresholds (H3): Sweep optimal minEdge/minProb per phase on holdout ===
calibrated_phase_thresholds = None
if X_holdout is not None and len(X_holdout) > 200:
    print(f"\n   Phase Threshold Calibration (H3) on holdout ({len(X_holdout):,} samples)...")

    # Get calibrated probabilities on holdout
    ho_margin = model.predict(dholdout, output_margin=True)
    ho_prob = 1.0 / (1.0 + np.exp(-(platt_a * ho_margin + platt_b)))

    # Extract minutesLeft and market_yes_price from holdout features
    ml_idx = fi.get('minutes_left_norm')   # index 11
    mkt_idx = fi.get('market_yes_price')   # index 44

    if ml_idx is not None and mkt_idx is not None:
        ho_minutes = X_holdout[:, ml_idx] * 15  # denormalize
        ho_mkt_price = X_holdout[:, mkt_idx]

        # Phase brackets (same as edge.js decide())
        phase_brackets = {
            'EARLY':     (10, 15.01),
            'MID':       (5,  10),
            'LATE':      (2,  5),
            'VERY_LATE': (0,  2),
        }

        calibrated_phase_thresholds = {}
        for phase_name, (lo_min, hi_min) in phase_brackets.items():
            phase_mask = (ho_minutes > lo_min) & (ho_minutes <= hi_min)
            n_phase = int(phase_mask.sum())
            if n_phase < 50:
                print(f"     {phase_name:10s}: too few samples ({n_phase}), using defaults")
                continue

            p_probs = ho_prob[phase_mask]
            p_mkt = ho_mkt_price[phase_mask]
            p_labels = y_holdout[phase_mask]

            # Best edge and best side for each sample
            p_edge_abs = np.abs(p_probs - p_mkt)
            p_model_best = np.maximum(p_probs, 1 - p_probs)
            p_predicted_up = p_probs > p_mkt
            p_correct = (p_predicted_up & (p_labels == 1)) | (~p_predicted_up & (p_labels == 0))

            best_score = 0
            best_me = 0.06
            best_mp = 0.54

            for me in np.arange(0.02, 0.20, 0.005):
                for mp in np.arange(0.52, 0.65, 0.005):
                    entry_mask = (p_edge_abs >= me) & (p_model_best >= mp)
                    n_entries = entry_mask.sum()
                    if n_entries < max(20, n_phase * 0.05):
                        continue
                    acc = p_correct[entry_mask].mean()
                    coverage = n_entries / n_phase
                    score = acc * np.sqrt(coverage)
                    if score > best_score:
                        best_score = score
                        best_me = me
                        best_mp = mp

            calibrated_phase_thresholds[phase_name] = {
                'minEdge': round(float(best_me), 3),
                'minProb': round(float(best_mp), 3),
            }

            entry_mask = (p_edge_abs >= best_me) & (p_model_best >= best_mp)
            n_enter = int(entry_mask.sum())
            acc_val = float(p_correct[entry_mask].mean()) if n_enter > 0 else 0
            print(f"     {phase_name:10s}: minEdge={best_me:.3f} minProb={best_mp:.3f} | "
                  f"{n_enter}/{n_phase} entries ({n_enter/n_phase*100:.1f}%), acc={acc_val*100:.1f}%")
    else:
        print(f"   [WARN] minutes_left_norm or market_yes_price not found in features")
else:
    print(f"   Phase thresholds: skipped (no holdout or too few samples)")

# --- EXPORT ---
print(f"\n   Exporting model...")

model.save_model(os.path.join(args.output_dir, 'xgboost_model.ubj'))

json_dump = model.get_dump(dump_format='json')
all_trees = [json.loads(t) for t in json_dump]
best_trees = all_trees[:model.best_iteration + 1]
print(f"   Trees: {len(best_trees)} (best) / {len(all_trees)} (total)")

browser_model = {
    'format': 'xgboost_json_v9',
    'version': 3,
    'num_features': len(feature_cols),
    'num_trees': len(best_trees),
    'feature_names': feature_cols,
    'original_features': len(feature_cols_orig),
    'engineered_features': new_names,
    'best_iteration': model.best_iteration,
    'optimal_threshold': best_threshold,
    'platt_a': platt_a,
    'platt_b': platt_b,
    'platt_on_logits': platt_on_logits,
    'pruned_features': pruned_features,
    'pre_excluded_features': exclude_feature_names,
    'zero_features': zero_feature_names,
    'recency_weighting': {'enabled': args.recency, 'halflife_days': args.recency_halflife} if args.recency else None,
    'signal_modifiers': signal_modifiers,
    'phase_thresholds': calibrated_phase_thresholds,
    'params': {k: str(v) for k, v in final_params.items()},
    'training_method': 'optuna' if USE_OPTUNA else 'grid_search',
    'metrics': {
        'accuracy': round(accuracy, 4),
        'auc': round(auc, 4),
        'f1': round(f1, 4),
        'logloss': round(ll, 4),
        'high_conf_accuracy': round(hc_acc, 4),
        'high_conf_ratio': round(hc_ratio, 2),
        'high_conf_threshold': best_threshold,
        'cv_auc': round(cv_auc_final, 4),
        'cv_acc': round(cv_acc_final, 4),
    },
    'trees': best_trees,
}

model_path = os.path.join(args.output_dir, 'xgboost_model.json')
with open(model_path, 'w') as f:
    json.dump(browser_model, f)
mb = os.path.getsize(model_path) / 1024 / 1024
print(f"   Browser model: {model_path} ({mb:.1f} MB)")

# Normalization (use full training data for mean/std, not just tune subset)
means = X_train_full.mean(axis=0).tolist()
stds = X_train_full.std(axis=0).tolist()
for i in range(len(stds)):
    if stds[i] < 1e-8: stds[i] = 1.0

norm = {
    'version': 3,
    'means': means,
    'stds': stds,
    'feature_names': feature_cols,
    'num_features': len(feature_cols),
    'original_features': len(feature_cols_orig),
    'platt_a': platt_a,
    'platt_b': platt_b,
    'platt_on_logits': platt_on_logits,
    'pruned_features': pruned_features,
    'engineered_feature_specs': {
        'delta_1m_capped': {'type': 'clip', 'source': 'delta_1m_pct', 'clip_std': 3},
        'momentum_accel': {'type': 'formula', 'formula': 'delta_1m - delta_3m/3'},
        'rsi_x_trending': {'type': 'multiply', 'a': 'rsi_norm', 'b': 'regime_trending'},
        'rsi_x_regime_conf': {'type': 'multiply', 'a': 'rsi_norm', 'b': 'regime_confidence'},
        'rsi_x_mean_rev': {'type': 'multiply', 'a': 'rsi_norm', 'b': 'regime_mean_reverting'},
        'delta1m_x_multitf': {'type': 'multiply', 'a': 'delta_1m_pct', 'b': 'multi_tf_agreement'},
        'bb_pctb_x_squeeze': {'type': 'multiply', 'a': 'bb_percent_b', 'b': 'bb_squeeze'},
        'vol_buy_x_delta': {'type': 'formula', 'formula': 'vol_delta_buy_ratio * sign(delta_1m_pct)'},
        'vwap_trend_strength': {'type': 'formula', 'formula': 'vwap_dist * sign(vwap_slope)'},
        'rsi_divergence': {'type': 'formula', 'formula': 'sign(delta_3m_pct) * (-rsi_slope)'},
        'combined_oscillator': {'type': 'formula', 'formula': '(rsi_norm + stoch_k_norm + bb_percent_b) / 3'},
        'ha_delta_agree': {'type': 'formula', 'formula': 'sign(ha_signed_consec) == sign(delta_1m_pct) ? 1 : 0'},
        'delta_1m_atr_adj': {'type': 'formula', 'formula': 'delta_1m_pct / max(atr_pct_norm, 0.01)'},
        'price_position_score': {'type': 'formula', 'formula': 'sign(vwap_dist)*0.4 + (bb_percent_b-0.5)*0.3 + (ema_cross_signal-0.5)*0.3'},
        'vol_weighted_momentum': {'type': 'multiply', 'a': 'delta_1m_pct', 'b': 'vol_ratio_norm'},
        'macd_x_rsi_slope': {'type': 'formula', 'formula': 'sign(macd_line) * rsi_slope'},
        'trend_alignment_score': {'type': 'formula', 'formula': 'regime_trending * multi_tf_agreement * sign(delta_1m_pct)'},
        'oscillator_extreme': {'type': 'formula', 'formula': 'max(rsi_norm - 0.7, 0) + max(0.3 - rsi_norm, 0)'},
        'vol_momentum_confirm': {'type': 'formula', 'formula': 'vol_delta_buy_ratio * sign(delta_1m_pct) * vol_ratio_norm'},
        'squeeze_breakout_potential': {'type': 'formula', 'formula': 'bb_squeeze * abs(stoch_k_norm - 0.5) * 2'},
        'multi_indicator_agree': {'type': 'formula', 'formula': '(ha_agree + macd_agree + vwap_agree + rsi_agree + multi_tf) / 5'},
        'stoch_rsi_extreme': {'type': 'formula', 'formula': 'max(stoch_k_norm - 0.8, 0)*5 + max(0.2 - stoch_k_norm, 0)*5'},
        'crowd_agree_momentum': {'type': 'formula', 'formula': 'sign(market_price_momentum) * sign(delta_1m_pct)'},
        'divergence_x_confidence': {'type': 'multiply', 'a': 'crowd_model_divergence', 'b': 'rule_confidence'},
        'imbalance_x_vol_delta': {'type': 'multiply', 'a': 'orderbook_imbalance', 'b': 'vol_delta_buy_ratio'},
    },
    'signal_modifiers': signal_modifiers,
    'phase_thresholds': calibrated_phase_thresholds,
    'train_samples': len(X_train_full),
    'holdout_frac': args.holdout_frac if args.holdout_frac > 0 else None,
    'holdout_start_idx': holdout_start_idx,
}

with open(os.path.join(args.output_dir, 'norm_browser.json'), 'w') as f:
    json.dump(norm, f, indent=2)

# Training report
report = [
    f"=== XGBoost v9 Training Report ===",
    f"Method: {'Optuna (' + str(args.tune_trials) + ' trials)' if USE_OPTUNA else 'Grid search (8 configs)'}",
    f"Winner: {best_cfg_name}",
    f"Accuracy: {accuracy*100:.2f}% | AUC: {auc:.4f}",
    f"High-conf: {hc_acc*100:.1f}% ({hc_count:,} signals, {hc_ratio:.1f}%)",
    f"Threshold: {best_threshold:.3f} | Trees: {len(best_trees)}",
    f"Features: {len(feature_cols)} ({len(feature_cols_orig)} base + {len(new_names)} engineered)",
    f"Platt calibration (on logits): A={platt_a:.4f}, B={platt_b:.4f}",
    f"Pruned features ({len(pruned_features)}): {', '.join(pruned_features) if pruned_features else 'none'}",
    f"Zero features: {', '.join(zero_feature_names) if zero_feature_names else 'none'}",
    f"Pre-excluded: {', '.join(exclude_feature_names) if exclude_feature_names else 'none'}",
    f"Recency: {'half-life=' + str(args.recency_halflife) + 'd' if args.recency else 'off'}",
    f"CV folds: {N_CV_FOLDS} | Boost rounds: {NUM_BOOST_ROUND} | Early stopping: {EARLY_STOPPING}",
    f"",
    f"Params: {json.dumps({k:v for k,v in final_params.items() if k not in ['objective','eval_metric','tree_method','seed']}, indent=2)}",
]

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
    import lightgbm as lgb
    HAS_LGB = True
except ImportError:
    HAS_LGB = False

lgb_model_final = None
lgb_platt_a, lgb_platt_b = 1.0, 0.0
ens_weight_xgb, ens_weight_lgb = 0.5, 0.5

if HAS_LGB:
    print("[9/9] Training LightGBM ensemble partner...")

    LGB_BOOST_ROUND = 1200
    LGB_EARLY_STOPPING = 80
    LGB_OPTUNA_TRIALS = 50

    def lgb_walk_forward_cv(X_tr, y_tr, params, w_tr=None, n_folds=N_CV_FOLDS, return_preds=False):
        """Walk-forward CV for LightGBM. Returns margins for Platt-on-logits."""
        fold_size = len(X_tr) // (n_folds + 2)
        aucs, accs = [], []
        oof_preds, oof_margins, oof_labels = [], [], []

        for fold in range(n_folds):
            tr_end = fold_size * (fold + 2)
            val_start = tr_end
            val_end = len(X_tr) if fold == n_folds - 1 else val_start + fold_size
            if val_end <= val_start:
                continue

            X_f_train = X_tr[:tr_end]
            y_f_train = y_tr[:tr_end]
            X_f_val = X_tr[val_start:val_end]
            y_f_val = y_tr[val_start:val_end]
            w_f_train = w_tr[:tr_end] if w_tr is not None else None

            dtrain = lgb.Dataset(X_f_train, label=y_f_train, weight=w_f_train,
                                 feature_name=feature_cols, free_raw_data=False)
            dval = lgb.Dataset(X_f_val, label=y_f_val,
                               feature_name=feature_cols, free_raw_data=False, reference=dtrain)

            callbacks = [lgb.early_stopping(LGB_EARLY_STOPPING, verbose=False),
                         lgb.log_evaluation(period=0)]

            model_f = lgb.train(
                params, dtrain,
                num_boost_round=LGB_BOOST_ROUND,
                valid_sets=[dval],
                callbacks=callbacks,
            )

            y_prob_f = model_f.predict(X_f_val)

            if np.any(np.isnan(y_prob_f)):
                continue

            acc_f = accuracy_score(y_f_val, (y_prob_f >= 0.5).astype(int))
            try:
                auc_f = roc_auc_score(y_f_val, y_prob_f)
            except ValueError:
                auc_f = 0.5
            if np.isnan(auc_f):
                auc_f = 0.5
            aucs.append(auc_f)
            accs.append(acc_f)

            if return_preds:
                oof_preds.extend(y_prob_f.tolist())
                # Raw logits for Platt-on-logits (C4)
                y_margin_f = model_f.predict(X_f_val, raw_score=True)
                oof_margins.extend(y_margin_f.tolist())
                oof_labels.extend(y_f_val.tolist())

        mean_auc = np.mean(aucs) if aucs else 0
        mean_acc = np.mean(accs) if accs else 0

        if return_preds:
            return mean_auc, mean_acc, np.array(oof_preds), np.array(oof_margins), np.array(oof_labels)
        return mean_auc, mean_acc

    # --- LightGBM Hyperparameter Optimization ---
    lgb_best_params = None

    if USE_OPTUNA:
        print(f"   Optuna optimization ({LGB_OPTUNA_TRIALS} trials, {N_CV_FOLDS}-fold CV)...")

        def lgb_objective(trial):
            params = {
                'objective': 'binary',
                'metric': ['binary_logloss', 'auc'],
                'verbosity': -1,
                'num_leaves': trial.suggest_int('num_leaves', 15, 63),
                'learning_rate': trial.suggest_float('learning_rate', 0.008, 0.2, log=True),
                'feature_fraction': trial.suggest_float('feature_fraction', 0.5, 0.95),
                'bagging_fraction': trial.suggest_float('bagging_fraction', 0.6, 0.95),
                'bagging_freq': 5,
                'min_child_samples': trial.suggest_int('min_child_samples', 5, 50),
                'lambda_l1': trial.suggest_float('lambda_l1', 1e-3, 2.0, log=True),
                'lambda_l2': trial.suggest_float('lambda_l2', 0.3, 6.0),
            }
            cv_auc, _ = lgb_walk_forward_cv(X_train, y_train, params, w_train)
            if np.isnan(cv_auc) or cv_auc == 0:
                return 0.5
            return cv_auc

        lgb_study = optuna.create_study(
            direction='maximize',
            sampler=optuna.samplers.TPESampler(seed=args.seed + 1),
        )
        lgb_study.optimize(lgb_objective, n_trials=LGB_OPTUNA_TRIALS, show_progress_bar=True)

        lgb_best_params = lgb_study.best_trial.params
        lgb_best_params.update({
            'objective': 'binary',
            'metric': ['binary_logloss', 'auc'],
            'verbosity': -1,
            'bagging_freq': 5,
        })
        print(f"   Best trial #{lgb_study.best_trial.number}: CV AUC = {lgb_study.best_value:.4f}")
        print(f"   Params: {json.dumps({k: round(v,4) if isinstance(v,float) else v for k,v in lgb_best_params.items() if k not in ['objective','metric','verbosity']})}")
    else:
        # Default LightGBM params (no Optuna)
        lgb_best_params = {
            'objective': 'binary',
            'metric': ['binary_logloss', 'auc'],
            'verbosity': -1,
            'num_leaves': 31,
            'learning_rate': 0.05,
            'feature_fraction': 0.8,
            'bagging_fraction': 0.8,
            'bagging_freq': 5,
            'min_child_samples': 20,
            'lambda_l1': 0.1,
            'lambda_l2': 1.0,
        }
        print(f"   Using default LightGBM params (no Optuna)")

    # --- Train final LightGBM model ---
    # Use full training data; early stop on holdout (audit fix M-early)
    print(f"   Training final LightGBM model...")

    lgb_dtrain = lgb.Dataset(X_train_full, label=y_train_full, weight=w_train_final,
                             feature_name=feature_cols, free_raw_data=False)
    if X_holdout is not None and len(X_holdout) > 0:
        lgb_dval = lgb.Dataset(X_holdout, label=y_holdout,
                               feature_name=feature_cols, free_raw_data=False, reference=lgb_dtrain)
        print(f"   LGB early stopping on: holdout ({len(X_holdout):,} samples)")
    else:
        lgb_dval = lgb.Dataset(X_test, label=y_test,
                               feature_name=feature_cols, free_raw_data=False, reference=lgb_dtrain)

    lgb_callbacks = [lgb.early_stopping(LGB_EARLY_STOPPING, verbose=False),
                     lgb.log_evaluation(period=0)]

    lgb_model_final = lgb.train(
        lgb_best_params, lgb_dtrain,
        num_boost_round=LGB_BOOST_ROUND,
        valid_sets=[lgb_dval],
        callbacks=lgb_callbacks,
    )

    lgb_y_prob = lgb_model_final.predict(X_test)
    lgb_acc = accuracy_score(y_test, (lgb_y_prob >= 0.5).astype(int))
    lgb_auc = roc_auc_score(y_test, lgb_y_prob)
    lgb_n_trees = lgb_model_final.best_iteration if lgb_model_final.best_iteration > 0 else lgb_model_final.num_trees()
    print(f"   LightGBM: acc={lgb_acc*100:.1f}% | AUC={lgb_auc:.4f} | trees={lgb_n_trees}")

    # --- LightGBM Platt Calibration (on raw logits — audit fix C4) ---
    print(f"   LightGBM Platt calibration (on logits)...")
    lgb_cv_auc, lgb_cv_acc, lgb_oof_preds, lgb_oof_margins, lgb_oof_labels = lgb_walk_forward_cv(
        X_train, y_train, lgb_best_params, w_train, return_preds=True
    )
    print(f"   LGB CV AUC: {lgb_cv_auc:.4f} | CV acc: {lgb_cv_acc*100:.1f}%")

    lgb_platt_on_logits = True
    if len(lgb_oof_margins) > 100:
        lgb_lr = LogisticRegression(C=1.0, solver='lbfgs', max_iter=1000)
        lgb_lr.fit(lgb_oof_margins.reshape(-1, 1), lgb_oof_labels)
        lgb_platt_a = float(lgb_lr.coef_[0][0])
        lgb_platt_b = float(lgb_lr.intercept_[0])

        # Apply Platt on raw logits of test predictions
        lgb_y_margin_test = lgb_model_final.predict(X_test, raw_score=True)
        lgb_y_cal = 1.0 / (1.0 + np.exp(-(lgb_platt_a * lgb_y_margin_test + lgb_platt_b)))
        lgb_cal_acc = accuracy_score(y_test, (lgb_y_cal >= 0.5).astype(int))
        lgb_cal_auc = roc_auc_score(y_test, lgb_y_cal)

        if lgb_cal_auc < lgb_auc - 0.005:
            print(f"   [WARN] LGB calibration hurts AUC, disabling")
            lgb_platt_a, lgb_platt_b = 1.0, 0.0
        else:
            print(f"   LGB Platt (on logits): A={lgb_platt_a:.4f}, B={lgb_platt_b:.4f}")
            print(f"   LGB calibrated: acc={lgb_cal_acc*100:.1f}% | AUC={lgb_cal_auc:.4f}")

    # --- Ensemble Weight Optimization (on holdout — audit fix H5) ---
    # Sweep ensemble weights on holdout to prevent test leakage
    if X_holdout is not None and len(X_holdout) > 0:
        print(f"\n   Optimizing ensemble weights (on holdout)...")
        xgb_margin_ho = model.predict(dholdout, output_margin=True)
        xgb_cal_ho = 1.0 / (1.0 + np.exp(-(platt_a * xgb_margin_ho + platt_b)))
        lgb_margin_ho = lgb_model_final.predict(X_holdout, raw_score=True)
        lgb_cal_ho = 1.0 / (1.0 + np.exp(-(lgb_platt_a * lgb_margin_ho + lgb_platt_b)))

        best_ens_auc = 0
        best_ens_w = 0.5
        for w in np.arange(0.25, 0.80, 0.05):
            ens_prob = w * xgb_cal_ho + (1 - w) * lgb_cal_ho
            ens_auc_val = roc_auc_score(y_holdout, ens_prob)
            if ens_auc_val > best_ens_auc:
                best_ens_auc = ens_auc_val
                best_ens_w = w
        sweep_label = "holdout"
    else:
        print(f"\n   Optimizing ensemble weights (on test, no holdout)...")
        xgb_cal_test = y_prob_final
        lgb_margin_test = lgb_model_final.predict(X_test, raw_score=True)
        lgb_cal_test = 1.0 / (1.0 + np.exp(-(lgb_platt_a * lgb_margin_test + lgb_platt_b)))

        best_ens_auc = 0
        best_ens_w = 0.5
        for w in np.arange(0.25, 0.80, 0.05):
            ens_prob = w * xgb_cal_test + (1 - w) * lgb_cal_test
            ens_auc_val = roc_auc_score(y_test, ens_prob)
            if ens_auc_val > best_ens_auc:
                best_ens_auc = ens_auc_val
                best_ens_w = w
        sweep_label = "test"

    ens_weight_xgb = round(best_ens_w, 3)
    ens_weight_lgb = round(1 - best_ens_w, 3)

    # Report on test (read-only) regardless of where weights were tuned
    xgb_cal_probs = y_prob_final
    lgb_y_margin_ens = lgb_model_final.predict(X_test, raw_score=True)
    lgb_cal_probs = 1.0 / (1.0 + np.exp(-(lgb_platt_a * lgb_y_margin_ens + lgb_platt_b)))
    ens_prob_final = ens_weight_xgb * xgb_cal_probs + ens_weight_lgb * lgb_cal_probs
    ens_acc = accuracy_score(y_test, (ens_prob_final >= 0.5).astype(int))
    ens_auc_final = roc_auc_score(y_test, ens_prob_final)

    print(f"\n   === Ensemble Results (weights from {sweep_label}) ===")
    print(f"   XGB weight: {ens_weight_xgb} | LGB weight: {ens_weight_lgb}")
    print(f"   XGB only:   acc={accuracy*100:.1f}% | AUC={auc:.4f}")
    print(f"   LGB only:   acc={lgb_acc*100:.1f}% | AUC={lgb_auc:.4f}")
    print(f"   Ensemble:   acc={ens_acc*100:.1f}% | AUC={ens_auc_final:.4f}")

    # --- Export LightGBM model ---
    print(f"\n   Exporting LightGBM model...")
    lgb_dump = lgb_model_final.dump_model()

    # Compute init_score for browser inference
    label_mean = float(np.average(y_train, weights=w_train)) if w_train is not None else float(y_train.mean())
    lgb_init_score = float(np.log(label_mean / (1 - label_mean)))

    # C2: Use len(sliced_trees) for num_trees to avoid off-by-one
    sliced_tree_info = lgb_dump['tree_info'][:lgb_n_trees]
    lgb_browser = {
        'format': 'lightgbm_json_v2',
        'version': 2,
        'num_features': len(feature_cols),
        'num_trees': len(sliced_tree_info),
        'feature_names': feature_cols,
        'init_score': lgb_init_score,
        'platt_a': lgb_platt_a,
        'platt_b': lgb_platt_b,
        'platt_on_logits': lgb_platt_on_logits,
        'metrics': {
            'accuracy': round(lgb_acc, 4),
            'auc': round(lgb_auc, 4),
        },
        'ensemble_weights': {'xgb': ens_weight_xgb, 'lgb': ens_weight_lgb},
        'tree_info': sliced_tree_info,
    }

    lgb_path = os.path.join(args.output_dir, 'lightgbm_model.json')
    with open(lgb_path, 'w') as f:
        json.dump(lgb_browser, f)
    lgb_mb = os.path.getsize(lgb_path) / 1024 / 1024
    print(f"   LGB model: {lgb_path} ({lgb_mb:.1f} MB)")

    # --- Update norm_browser.json with ensemble info ---
    norm['ensemble_weights'] = {'xgb': ens_weight_xgb, 'lgb': ens_weight_lgb}
    norm['lgb_platt_a'] = lgb_platt_a
    norm['lgb_platt_b'] = lgb_platt_b
    norm['lgb_platt_on_logits'] = lgb_platt_on_logits

    with open(os.path.join(args.output_dir, 'norm_browser.json'), 'w') as f:
        json.dump(norm, f, indent=2)
    print(f"   Updated norm_browser.json with ensemble weights")

    # --- Verify browser inference consistency ---
    print(f"\n   Verifying LGB browser inference...")
    def _traverse_lgb_tree(node, features):
        if 'leaf_value' in node:
            return node['leaf_value']
        fi = node['split_feature']
        thr = node['threshold']
        val = features[fi]
        default_left = node.get('default_left', True)
        if np.isnan(val):
            return _traverse_lgb_tree(node['left_child'] if default_left else node['right_child'], features)
        if val <= thr:
            return _traverse_lgb_tree(node['left_child'], features)
        else:
            return _traverse_lgb_tree(node['right_child'], features)

    model_raw_scores = lgb_model_final.predict(X_test[:5], raw_score=True)
    max_diff = 0
    for i in range(5):
        manual_raw = lgb_init_score
        for ti in lgb_dump['tree_info'][:lgb_n_trees]:
            manual_raw += _traverse_lgb_tree(ti['tree_structure'], X_test[i])
        diff = abs(model_raw_scores[i] - manual_raw)
        max_diff = max(max_diff, diff)
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
