#!/usr/bin/env python3
"""
=== XGBoost v8 — Advanced Training Pipeline ===

v8 improvements over v5:
  - Fixed MACD inference bug (histogram/macd → hist/line)
  - Replaced dead features: regime_choppy→regime_confidence,
    funding_rate_norm→volume_acceleration, funding_sentiment→bb_squeeze_intensity
  - Renamed engineered: rsi_x_choppy → rsi_x_regime_conf
  - Removed regime sample weights (all=1.0, v7 showed weighting doesn't help)
  - 5-fold walk-forward CV (vs 3)
  - Boost rounds 1200, early stopping patience 80
  - Narrowed Optuna search space, 150 default trials
  - --zero-features flag for variant training (e.g., without MACD)

Strategy: Optuna or 8 hand-tuned seed configs + walk-forward CV
          + soft feature pruning + Platt calibration.
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
parser.add_argument('--exclude-features', type=str, default='',
                    help='Comma-separated feature names to pre-exclude via feature_weights=0 (applied before Optuna)')
parser.add_argument('--recency', action='store_true',
                    help='Apply recency sample weighting (90-day half-life)')
parser.add_argument('--recency-halflife', type=int, default=90,
                    help='Half-life in days for recency weighting (default: 90)')
parser.add_argument('--regime-split', action='store_true',
                    help='Train separate models per regime (trending/moderate/choppy)')
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
  XGBoost v8 — Advanced Training Pipeline
  {('Optuna (' + str(args.tune_trials) + ' trials)') if USE_OPTUNA else '8 configs (grid)'} | Feat selection | Platt calibration
==================================================
  Input:     {args.input}
  Test size: {args.test_size}
  Optuna:    {'Yes (' + str(args.tune_trials) + ' trials)' if USE_OPTUNA else 'No (grid search)'}
  Zero-feat: {', '.join(zero_feature_names) if zero_feature_names else 'none'}
  Exclude:   {len(exclude_feature_names)} features {'(' + ', '.join(exclude_feature_names[:5]) + ('...' if len(exclude_feature_names) > 5 else '') + ')' if exclude_feature_names else 'none'}
  Recency:   {'Yes (half-life=' + str(args.recency_halflife) + 'd)' if args.recency else 'No'}
==================================================
""")

# ================================================
# 1. LOAD
# ================================================
print("[1/8] Loading data...")
df = pd.read_csv(args.input)
feature_cols_orig = [c for c in df.columns if c != 'label']
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
    Optionally returns out-of-fold predictions for calibration.
    feat_weights: optional per-feature weight array (0=exclude from splits)."""
    fold_size = len(X_tr) // (n_folds + 2)
    aucs, accs = [], []
    oof_preds, oof_labels = [], []

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
            oof_labels.extend(y_f_val.tolist())

    mean_auc = np.mean(aucs) if aucs else 0
    mean_acc = np.mean(accs) if accs else 0

    if return_preds:
        return mean_auc, mean_acc, np.array(oof_preds), np.array(oof_labels)
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
print(f"\n   Training final model with {best_cfg_name}...")

final_params = {
    'objective': 'binary:logistic',
    'eval_metric': ['logloss', 'auc'],
    'scale_pos_weight': spw,
    'seed': args.seed,
    'tree_method': 'hist',
    **best_cfg,
}

dtrain = xgb.DMatrix(X_train, label=y_train, weight=w_train, feature_names=feature_cols)
if exclude_feature_names:
    # Ensure colsample_bytree < 1.0 for feature_weights to work
    if final_params.get('colsample_bytree', 1.0) >= 1.0:
        final_params['colsample_bytree'] = 0.95
    dtrain.feature_weights = pre_exclude_fw
dtest = xgb.DMatrix(X_test, label=y_test, feature_names=feature_cols)

ev = {}
model = xgb.train(
    final_params, dtrain,
    num_boost_round=NUM_BOOST_ROUND,
    evals=[(dtrain, 'train'), (dtest, 'eval')],
    evals_result=ev,
    early_stopping_rounds=EARLY_STOPPING,
    verbose_eval=False,
)

y_prob = model.predict(dtest)
initial_acc = accuracy_score(y_test, (y_prob >= 0.5).astype(int))
initial_auc = roc_auc_score(y_test, y_prob)
print(f"   Initial model: acc={initial_acc*100:.1f}% | AUC={initial_auc:.4f} | trees={model.best_iteration+1}")

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
    dtrain_fw = xgb.DMatrix(X_train, label=y_train, weight=w_train, feature_names=feature_cols)
    dtrain_fw.feature_weights = combined_fw

    ev2 = {}
    model_pruned = xgb.train(
        retrain_params, dtrain_fw,
        num_boost_round=NUM_BOOST_ROUND,
        evals=[(dtrain_fw, 'train'), (dtest, 'eval')],
        evals_result=ev2,
        early_stopping_rounds=EARLY_STOPPING,
        verbose_eval=False,
    )

    y_prob_pruned = model_pruned.predict(dtest)
    pruned_acc = accuracy_score(y_test, (y_prob_pruned >= 0.5).astype(int))
    pruned_auc = roc_auc_score(y_test, y_prob_pruned)
    print(f"   Pruned model: acc={pruned_acc*100:.1f}% | AUC={pruned_auc:.4f} | trees={model_pruned.best_iteration+1}")

    # Keep better model
    if pruned_auc >= initial_auc - 0.002:  # allow tiny regression for simpler model
        print(f"   [OK]Using pruned model (AUC diff: {(pruned_auc-initial_auc)*100:+.2f}%)")
        model = model_pruned
        y_prob = y_prob_pruned
    else:
        print(f"   [NO]Keeping original (pruned AUC {pruned_auc:.4f} < original {initial_auc:.4f})")
        pruned_features = []  # reset since we're not using pruned model
else:
    print(f"   No features pruned (all above threshold or too many would be pruned)")

# ================================================
# 7. PLATT CALIBRATION
# ================================================
print("\n[7/8] Platt calibration...")

# Get out-of-fold predictions for calibration fitting
cv_auc_final, cv_acc_final, oof_preds, oof_labels = walk_forward_cv(
    X_train, y_train, best_cfg, w_train, return_preds=True,
    feat_weights=pre_exclude_fw if exclude_feature_names else None
)
print(f"   CV AUC: {cv_auc_final:.4f} | CV acc: {cv_acc_final*100:.1f}%")
print(f"   Out-of-fold predictions: {len(oof_preds)} samples")

# Fit Platt scaling (logistic regression on raw probabilities)
platt_a, platt_b = 1.0, 0.0  # defaults (identity)
if len(oof_preds) > 100:
    lr = LogisticRegression(C=1.0, solver='lbfgs', max_iter=1000)
    lr.fit(oof_preds.reshape(-1, 1), oof_labels)
    platt_a = float(lr.coef_[0][0])
    platt_b = float(lr.intercept_[0])

    # Test calibration on held-out test set
    y_prob_calibrated = 1.0 / (1.0 + np.exp(-(platt_a * y_prob + platt_b)))
    cal_acc = accuracy_score(y_test, (y_prob_calibrated >= 0.5).astype(int))
    cal_auc = roc_auc_score(y_test, y_prob_calibrated)

    # Check calibration quality — does it actually help?
    raw_acc = accuracy_score(y_test, (y_prob >= 0.5).astype(int))
    raw_auc = roc_auc_score(y_test, y_prob)

    print(f"   Platt params: A={platt_a:.4f}, B={platt_b:.4f}")
    print(f"   Raw:        acc={raw_acc*100:.1f}% | AUC={raw_auc:.4f}")
    print(f"   Calibrated: acc={cal_acc*100:.1f}% | AUC={cal_auc:.4f}")

    if cal_auc < raw_auc - 0.005:
        print(f"   [WARN] Calibration hurts AUC, disabling (A=1, B=0)")
        platt_a, platt_b = 1.0, 0.0
        y_prob_final = y_prob
    else:
        print(f"   [OK]Calibration active")
        y_prob_final = y_prob_calibrated
else:
    print(f"   [WARN] Not enough OOF predictions ({len(oof_preds)}), skipping calibration")
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

# --- Optimal threshold scan ---
best_threshold = 0.60
best_score = 0
for thresh in np.arange(0.55, 0.85, 0.005):
    hmask = (y_prob_final < (1-thresh)) | (y_prob_final > thresh)
    if hmask.sum() < 50: continue
    hacc = accuracy_score(y_test[hmask], y_pred[hmask])
    hratio = hmask.sum() / len(y_test)
    score = hacc * np.sqrt(hratio)
    if score > best_score:
        best_score = score
        best_threshold = thresh

high_mask = (y_prob_final < (1-best_threshold)) | (y_prob_final > best_threshold)
hc_acc = accuracy_score(y_test[high_mask], y_pred[high_mask]) if high_mask.sum() > 0 else 0
hc_count = int(high_mask.sum())
hc_ratio = hc_count / len(y_test) * 100

print(f"\n   Optimal Threshold: {best_threshold:.3f}")
print(f"   HIGH-CONF: {hc_acc*100:.1f}% accuracy ({hc_count:,} signals, {hc_ratio:.1f}% of test)")

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

# --- EXPORT ---
print(f"\n   Exporting model...")

model.save_model(os.path.join(args.output_dir, 'xgboost_model.ubj'))

json_dump = model.get_dump(dump_format='json')
all_trees = [json.loads(t) for t in json_dump]
best_trees = all_trees[:model.best_iteration + 1]
print(f"   Trees: {len(best_trees)} (best) / {len(all_trees)} (total)")

browser_model = {
    'format': 'xgboost_json_v8',
    'version': 2,
    'num_features': len(feature_cols),
    'num_trees': len(best_trees),
    'feature_names': feature_cols,
    'original_features': len(feature_cols_orig),
    'engineered_features': new_names,
    'best_iteration': model.best_iteration,
    'optimal_threshold': best_threshold,
    'platt_a': platt_a,
    'platt_b': platt_b,
    'pruned_features': pruned_features,
    'pre_excluded_features': exclude_feature_names,
    'zero_features': zero_feature_names,
    'recency_weighting': {'enabled': args.recency, 'halflife_days': args.recency_halflife} if args.recency else None,
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

# Normalization
means = X_train.mean(axis=0).tolist()
stds = X_train.std(axis=0).tolist()
for i in range(len(stds)):
    if stds[i] < 1e-8: stds[i] = 1.0

norm = {
    'version': 2,
    'means': means,
    'stds': stds,
    'feature_names': feature_cols,
    'num_features': len(feature_cols),
    'original_features': len(feature_cols_orig),
    'platt_a': platt_a,
    'platt_b': platt_b,
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
    'train_samples': len(X_train),
}

with open(os.path.join(args.output_dir, 'norm_browser.json'), 'w') as f:
    json.dump(norm, f, indent=2)

# Training report
report = [
    f"=== XGBoost v8 Training Report ===",
    f"Method: {'Optuna (' + str(args.tune_trials) + ' trials)' if USE_OPTUNA else 'Grid search (8 configs)'}",
    f"Winner: {best_cfg_name}",
    f"Accuracy: {accuracy*100:.2f}% | AUC: {auc:.4f}",
    f"High-conf: {hc_acc*100:.1f}% ({hc_count:,} signals, {hc_ratio:.1f}%)",
    f"Threshold: {best_threshold:.3f} | Trees: {len(best_trees)}",
    f"Features: {len(feature_cols)} ({len(feature_cols_orig)} base + {len(new_names)} engineered)",
    f"Platt calibration: A={platt_a:.4f}, B={platt_b:.4f}",
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
        """Walk-forward CV for LightGBM."""
        fold_size = len(X_tr) // (n_folds + 2)
        aucs, accs = [], []
        oof_preds, oof_labels = [], []

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
                oof_labels.extend(y_f_val.tolist())

        mean_auc = np.mean(aucs) if aucs else 0
        mean_acc = np.mean(accs) if accs else 0

        if return_preds:
            return mean_auc, mean_acc, np.array(oof_preds), np.array(oof_labels)
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
    print(f"   Training final LightGBM model...")

    lgb_dtrain = lgb.Dataset(X_train, label=y_train, weight=w_train,
                             feature_name=feature_cols, free_raw_data=False)
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

    # --- LightGBM Platt Calibration ---
    print(f"   LightGBM Platt calibration...")
    lgb_cv_auc, lgb_cv_acc, lgb_oof_preds, lgb_oof_labels = lgb_walk_forward_cv(
        X_train, y_train, lgb_best_params, w_train, return_preds=True
    )
    print(f"   LGB CV AUC: {lgb_cv_auc:.4f} | CV acc: {lgb_cv_acc*100:.1f}%")

    if len(lgb_oof_preds) > 100:
        lgb_lr = LogisticRegression(C=1.0, solver='lbfgs', max_iter=1000)
        lgb_lr.fit(lgb_oof_preds.reshape(-1, 1), lgb_oof_labels)
        lgb_platt_a = float(lgb_lr.coef_[0][0])
        lgb_platt_b = float(lgb_lr.intercept_[0])

        lgb_y_cal = 1.0 / (1.0 + np.exp(-(lgb_platt_a * lgb_y_prob + lgb_platt_b)))
        lgb_cal_acc = accuracy_score(y_test, (lgb_y_cal >= 0.5).astype(int))
        lgb_cal_auc = roc_auc_score(y_test, lgb_y_cal)

        if lgb_cal_auc < lgb_auc - 0.005:
            print(f"   [WARN] LGB calibration hurts AUC, disabling")
            lgb_platt_a, lgb_platt_b = 1.0, 0.0
        else:
            print(f"   LGB Platt: A={lgb_platt_a:.4f}, B={lgb_platt_b:.4f}")
            print(f"   LGB calibrated: acc={lgb_cal_acc*100:.1f}% | AUC={lgb_cal_auc:.4f}")

    # --- Ensemble Weight Optimization ---
    print(f"\n   Optimizing ensemble weights...")
    xgb_cal_probs = y_prob_final
    lgb_cal_probs = 1.0 / (1.0 + np.exp(-(lgb_platt_a * lgb_y_prob + lgb_platt_b)))

    best_ens_auc = 0
    best_ens_w = 0.5
    for w in np.arange(0.25, 0.80, 0.05):
        ens_prob = w * xgb_cal_probs + (1 - w) * lgb_cal_probs
        ens_auc_val = roc_auc_score(y_test, ens_prob)
        if ens_auc_val > best_ens_auc:
            best_ens_auc = ens_auc_val
            best_ens_w = w

    ens_weight_xgb = round(best_ens_w, 3)
    ens_weight_lgb = round(1 - best_ens_w, 3)

    ens_prob_final = ens_weight_xgb * xgb_cal_probs + ens_weight_lgb * lgb_cal_probs
    ens_acc = accuracy_score(y_test, (ens_prob_final >= 0.5).astype(int))
    ens_auc_final = roc_auc_score(y_test, ens_prob_final)

    print(f"\n   === Ensemble Results ===")
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
        'format': 'lightgbm_json_v1',
        'version': 1,
        'num_features': len(feature_cols),
        'num_trees': len(sliced_tree_info),
        'feature_names': feature_cols,
        'init_score': lgb_init_score,
        'platt_a': lgb_platt_a,
        'platt_b': lgb_platt_b,
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
