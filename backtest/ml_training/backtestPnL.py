#!/usr/bin/env python3
"""
=== Backtest P&L Simulation ===

Simulates Polymarket trading P&L using the trained XGBoost model.
Applies Platt calibration, threshold sweep, and per-regime breakdown.

Usage:
  python backtestPnL.py --threshold-sweep
  python backtestPnL.py --threshold 0.60 --bankroll 1000 --bet-size 10
  python backtestPnL.py --input training_data.csv --model-dir ./output

NOTE: market_yes_price in training data is simulated (rule-based confidence),
not real historical Polymarket prices. Results are indicative only.
"""

import argparse, json, os, sys
import numpy as np
import pandas as pd

try:
    import xgboost as xgb
except ImportError:
    print("ERROR: xgboost not installed. Run: pip install xgboost")
    sys.exit(1)

parser = argparse.ArgumentParser(description='Backtest P&L simulation for Polymarket')
parser.add_argument('--input', default='training_data.csv', help='Training data CSV')
parser.add_argument('--model-dir', default='./output', help='Directory with model files')
parser.add_argument('--threshold', type=float, default=0.60, help='Confidence threshold for single run')
parser.add_argument('--threshold-sweep', action='store_true', help='Run sweep from 0.50 to 0.80')
parser.add_argument('--bankroll', type=float, default=1000, help='Starting bankroll')
parser.add_argument('--bet-size', type=float, default=10, help='Bet size per trade')
parser.add_argument('--min-edge', type=float, default=0.05, help='Minimum edge to trade')
parser.add_argument('--spread-pct', type=float, default=1.0,
                    help='Round-trip spread cost in %% (default: 1.0 = 0.5%% each side)')
parser.add_argument('--slippage-pct', type=float, default=0.5,
                    help='Slippage cost in %% (default: 0.5)')
parser.add_argument('--oos-start', type=float, default=0.85,
                    help='Fraction of data to use as OOS start (default: 0.85 = last 15%%). '
                         'Use 0.875 with --holdout-frac 0.125 for true OOS backtest.')
args = parser.parse_args()

# Transaction cost: half spread on entry + half spread on exit + slippage
# e.g. spread=1.0%, slippage=0.5% → 1.5% round-trip cost as fraction of bet
TXCOST_FRAC = (args.spread_pct + args.slippage_pct) / 100.0

# ================================================
# 1. LOAD DATA
# ================================================
print(f"\n{'='*60}")
print(f"  Backtest P&L Simulation")
print(f"  Transaction costs: {args.spread_pct:.1f}% spread + {args.slippage_pct:.1f}% slippage = {TXCOST_FRAC*100:.1f}% round-trip")
print(f"{'='*60}")

if not os.path.exists(args.input):
    print(f"ERROR: Input file not found: {args.input}")
    sys.exit(1)

df = pd.read_csv(args.input)
feature_cols_orig = [c for c in df.columns if c != 'label']
X_orig = df[feature_cols_orig].values.astype(np.float32)
y = df['label'].values.astype(np.int32)
X_orig = np.nan_to_num(X_orig, nan=0.0, posinf=0.0, neginf=0.0)

print(f"  Samples: {len(df):,} | Features: {len(feature_cols_orig)}")

# ================================================
# 2. ENGINEER FEATURES (same as trainXGBoost_v3.py)
# ================================================
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
new['delta_1m_capped'] = np.clip(delta_1m, -0.003, 0.003)
new['momentum_accel'] = delta_1m - (delta_3m / 3)
new['rsi_x_trending'] = rsi * regime_trending
new['rsi_x_regime_conf'] = rsi * regime_confidence  # v8: was rsi_x_choppy
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

print(f"  Total features: {len(feature_cols)} ({len(feature_cols_orig)} base + {len(new_names)} engineered)")

# ================================================
# 3. LOAD MODEL
# ================================================
model_ubj = os.path.join(args.model_dir, 'xgboost_model.ubj')
norm_path = os.path.join(args.model_dir, 'norm_browser.json')

if not os.path.exists(model_ubj):
    print(f"ERROR: Model not found: {model_ubj}")
    sys.exit(1)

model = xgb.Booster()
model.load_model(model_ubj)
print(f"  Model loaded: {model_ubj}")

# Load Platt calibration params
platt_a, platt_b = 1.0, 0.0
if os.path.exists(norm_path):
    with open(norm_path) as f:
        norm = json.load(f)
    platt_a = norm.get('platt_a', 1.0)
    platt_b = norm.get('platt_b', 0.0)
    print(f"  Platt calibration: A={platt_a:.4f}, B={platt_b:.4f}")

# ================================================
# 4. PREDICT
# ================================================
# Temporal split: use --oos-start to control test region
# Default 0.85 = same as training test set (in-sample for Optuna)
# Use 0.875+ for true OOS (data Optuna never saw, if trained with --holdout-frac)
split = int(len(X) * args.oos_start)
X_test = X[split:]
y_test = y[split:]

oos_mode = 'OUT-OF-SAMPLE' if args.oos_start > 0.85 else 'IN-SAMPLE (overlaps tuning data)'
print(f"  Split at {args.oos_start:.1%} → test starts at sample {split:,} [{oos_mode}]")

# Regime labels for test set
regime_idx = {
    'trending': fi.get('regime_trending'),
    'mean_reverting': fi.get('regime_mean_reverting'),
    'moderate': fi.get('regime_moderate'),
}
test_regimes = []
for i in range(split, len(X)):
    r = 'moderate'  # default
    for rname, ridx in regime_idx.items():
        if ridx is not None and X_orig[i, ridx] > 0.5:
            r = rname
            break
    test_regimes.append(r)
test_regimes = np.array(test_regimes)

# Market price proxy (rule confidence as entry price)
market_yes_idx = fi.get('market_yes_price')
if market_yes_idx is not None:
    market_prices = X_orig[split:, market_yes_idx]
else:
    # Fallback: use rule_prob_up (probability, not confidence — matches market price semantics)
    rp_idx = fi.get('rule_prob_up')
    if rp_idx is not None:
        market_prices = X_orig[split:, rp_idx]
    else:
        market_prices = np.full(len(X_test), 0.5)

dtest = xgb.DMatrix(X_test, feature_names=feature_cols)
y_prob_raw = model.predict(dtest)

# Apply Platt calibration
y_prob = 1.0 / (1.0 + np.exp(-(platt_a * y_prob_raw + platt_b)))

print(f"  Test samples: {len(X_test):,}")
print(f"  Raw prob range: [{y_prob_raw.min():.3f}, {y_prob_raw.max():.3f}]")
print(f"  Calibrated prob range: [{y_prob.min():.3f}, {y_prob.max():.3f}]")

# ================================================
# 5. P&L SIMULATION
# ================================================

def simulate_pnl(y_prob, y_true, market_prices, threshold, min_edge, bankroll, bet_size,
                  regimes=None, txcost_frac=0.0):
    """Simulate Polymarket trading P&L with transaction costs.

    Args:
        txcost_frac: Round-trip transaction cost as a fraction of bet_size.
                     e.g. 0.015 = 1.5% (0.5% spread each side + 0.5% slippage).
    """
    balance = bankroll
    trades = 0
    wins = 0
    losses = 0
    peak = bankroll
    max_drawdown = 0
    pnl_history = []
    gross_win = 0
    gross_loss = 0
    total_txcost = 0

    # Per-regime tracking
    regime_stats = {}

    # Per-trade cost deducted on every trade
    trade_cost = txcost_frac * bet_size

    for i in range(len(y_prob)):
        prob_up = y_prob[i]
        prob_down = 1 - prob_up
        best_prob = max(prob_up, prob_down)
        side = 'UP' if prob_up >= prob_down else 'DOWN'

        # Entry price
        entry_price = market_prices[i] if side == 'UP' else (1 - market_prices[i])
        entry_price = np.clip(entry_price, 0.05, 0.95)  # bound to valid range

        # Edge = model prob - market price (net of transaction costs)
        edge = best_prob - entry_price - txcost_frac

        # Decision: trade if above threshold AND positive edge (after costs)
        if best_prob < threshold or edge < min_edge:
            continue

        trades += 1
        actual_up = y_true[i] == 1
        correct = (side == 'UP' and actual_up) or (side == 'DOWN' and not actual_up)

        # Always pay transaction costs
        balance -= trade_cost
        total_txcost += trade_cost

        if correct:
            profit = (1 - entry_price) * bet_size
            balance += profit
            wins += 1
            gross_win += profit
        else:
            loss = entry_price * bet_size
            balance -= loss
            losses += 1
            gross_loss += loss

        pnl_history.append(balance)
        peak = max(peak, balance)
        dd = (peak - balance) / peak if peak > 0 else 0
        max_drawdown = max(max_drawdown, dd)

        # Per-regime
        if regimes is not None:
            r = regimes[i]
            if r not in regime_stats:
                regime_stats[r] = {'trades': 0, 'wins': 0, 'pnl': 0}
            regime_stats[r]['trades'] += 1
            if correct:
                regime_stats[r]['wins'] += 1
                regime_stats[r]['pnl'] += (1 - entry_price) * bet_size - trade_cost
            else:
                regime_stats[r]['pnl'] -= entry_price * bet_size + trade_cost

    win_rate = wins / trades if trades > 0 else 0
    total_pnl = balance - bankroll
    roi = total_pnl / bankroll * 100 if bankroll > 0 else 0
    profit_factor = gross_win / (gross_loss + total_txcost) if (gross_loss + total_txcost) > 0 else (999.99 if gross_win > 0 else 0)

    # Sharpe annualization: 15-min bars → 96 bars/day × 365.25 days/year (crypto is 24/7)
    if len(pnl_history) > 1:
        returns = np.diff(pnl_history) / np.maximum(np.array(pnl_history[:-1]), 1)
        std = np.std(returns)
        sharpe = np.mean(returns) / std * np.sqrt(365.25 * 96) if std > 0 else 0
    else:
        sharpe = 0
        returns = np.array([])

    return {
        'trades': trades,
        'wins': wins,
        'losses': losses,
        'win_rate': win_rate,
        'total_pnl': total_pnl,
        'roi': roi,
        'max_drawdown': max_drawdown,
        'profit_factor': profit_factor,
        'sharpe': sharpe,
        'trade_ratio': trades / len(y_prob) * 100 if len(y_prob) > 0 else 0,
        'regime_stats': regime_stats,
        'final_balance': balance,
        'total_txcost': total_txcost,
        'pnl_history': pnl_history,
        'returns': returns,
    }


# ================================================
# 5b. BOOTSTRAP CONFIDENCE INTERVALS
# ================================================

def bootstrap_ci(returns, bankroll, n_boot=1000, ci=0.95, seed=42):
    """Bootstrap 95% CI for Sharpe ratio and total ROI.

    Resamples trade-level returns with replacement, recomputes Sharpe and ROI
    for each bootstrap sample, then returns percentile confidence intervals.
    """
    if len(returns) < 10:
        return {'sharpe_ci': (np.nan, np.nan), 'roi_ci': (np.nan, np.nan), 'n_trades': len(returns)}

    rng = np.random.RandomState(seed)
    alpha = (1 - ci) / 2  # 0.025 for 95% CI

    sharpe_samples = np.empty(n_boot)
    roi_samples = np.empty(n_boot)

    # Annualization factor: 96 bars/day × 365.25 days/year (crypto 24/7)
    ann_factor = np.sqrt(365.25 * 96)

    for b in range(n_boot):
        idx = rng.randint(0, len(returns), size=len(returns))
        boot_ret = returns[idx]

        # Sharpe
        std = np.std(boot_ret)
        sharpe_samples[b] = (np.mean(boot_ret) / std * ann_factor) if std > 0 else 0

        # ROI: sum of dollar returns → pct of bankroll
        # returns are fractional (dollar P&L / balance), convert to total dollar P&L approx
        # We approximate total P&L as sum(returns) * bankroll (since each return ~ pnl/balance)
        roi_samples[b] = np.sum(boot_ret) * 100  # as percentage

    sharpe_lo = np.percentile(sharpe_samples, alpha * 100)
    sharpe_hi = np.percentile(sharpe_samples, (1 - alpha) * 100)
    roi_lo = np.percentile(roi_samples, alpha * 100)
    roi_hi = np.percentile(roi_samples, (1 - alpha) * 100)

    return {
        'sharpe_ci': (sharpe_lo, sharpe_hi),
        'roi_ci': (roi_lo, roi_hi),
        'n_trades': len(returns),
    }


# ================================================
# 6. OUTPUT
# ================================================

if args.threshold_sweep:
    print(f"\n{'='*80}")
    print(f"  THRESHOLD SWEEP — Bankroll: ${args.bankroll:.0f} | Bet: ${args.bet_size:.0f} | Min Edge: {args.min_edge*100:.0f}% | TxCost: {TXCOST_FRAC*100:.1f}%")
    print(f"{'='*80}")
    print(f"  {'Thresh':>7} | {'Trades':>7} | {'Rate':>6} | {'WinR':>6} | {'P&L':>10} | {'ROI':>7} | {'MaxDD':>7} | {'PF':>6} | {'Sharpe':>7}")
    print(f"  {'-'*7}-+-{'-'*7}-+-{'-'*6}-+-{'-'*6}-+-{'-'*10}-+-{'-'*7}-+-{'-'*7}-+-{'-'*6}-+-{'-'*7}")

    sweep_results = []
    for thresh in np.arange(0.50, 0.81, 0.025):
        r = simulate_pnl(y_prob, y_test, market_prices, thresh, args.min_edge,
                         args.bankroll, args.bet_size, test_regimes, TXCOST_FRAC)
        sweep_results.append((thresh, r))

        pnl_str = f"${r['total_pnl']:+.2f}"
        pnl_color = '' if r['total_pnl'] >= 0 else ''
        print(f"  {thresh:>7.3f} | {r['trades']:>7,} | {r['trade_ratio']:>5.1f}% | {r['win_rate']*100:>5.1f}% | {pnl_str:>10} | {r['roi']:>+6.1f}% | {r['max_drawdown']*100:>6.1f}% | {r['profit_factor']:>6.2f} | {r['sharpe']:>7.2f}")

    # Find optimal threshold (best win_rate * sqrt(trade_ratio))
    best_thresh = 0.60
    best_score = 0
    for thresh, r in sweep_results:
        if r['trades'] < 50:
            continue
        score = r['win_rate'] * np.sqrt(r['trade_ratio'] / 100)
        if score > best_score:
            best_score = score
            best_thresh = thresh

    print(f"\n  Recommended threshold: {best_thresh:.3f} (score = win_rate * sqrt(trade_ratio) = {best_score:.4f})")

    # Per-regime breakdown at optimal threshold
    optimal = simulate_pnl(y_prob, y_test, market_prices, best_thresh, args.min_edge,
                           args.bankroll, args.bet_size, test_regimes, TXCOST_FRAC)

    print(f"\n{'='*60}")
    print(f"  PER-REGIME BREAKDOWN @ threshold={best_thresh:.3f}")
    print(f"{'='*60}")
    print(f"  {'Regime':<15} | {'Trades':>7} | {'WinR':>6} | {'P&L':>10}")
    print(f"  {'-'*15}-+-{'-'*7}-+-{'-'*6}-+-{'-'*10}")

    for rname in ['trending', 'moderate', 'choppy', 'mean_reverting']:
        rs = optimal['regime_stats'].get(rname)
        if rs and rs['trades'] > 0:
            wr = rs['wins'] / rs['trades'] * 100
            print(f"  {rname:<15} | {rs['trades']:>7,} | {wr:>5.1f}% | ${rs['pnl']:>+9.2f}")

    # Unknown regime
    for rname, rs in optimal['regime_stats'].items():
        if rname not in ['trending', 'moderate', 'choppy', 'mean_reverting']:
            if rs['trades'] > 0:
                wr = rs['wins'] / rs['trades'] * 100
                print(f"  {rname:<15} | {rs['trades']:>7,} | {wr:>5.1f}% | ${rs['pnl']:>+9.2f}")

    # Transaction cost summary for optimal threshold
    print(f"\n  Tx Costs Paid @ optimal: ${optimal['total_txcost']:.2f} ({TXCOST_FRAC*100:.1f}% x {optimal['trades']} trades)")

    # Bootstrap CI for optimal threshold
    ci = bootstrap_ci(optimal['returns'], args.bankroll)
    if not np.isnan(ci['sharpe_ci'][0]):
        print(f"\n  Bootstrap 95% CI (1000 samples) @ threshold={best_thresh:.3f}:")
        print(f"    Sharpe:  [{ci['sharpe_ci'][0]:.2f}, {ci['sharpe_ci'][1]:.2f}]  (point: {optimal['sharpe']:.2f})")
        print(f"    ROI:     [{ci['roi_ci'][0]:+.1f}%, {ci['roi_ci'][1]:+.1f}%]  (point: {optimal['roi']:+.1f}%)")
    else:
        print(f"\n  Bootstrap CI: insufficient trades ({ci['n_trades']}) for reliable intervals")

else:
    # Single threshold run
    r = simulate_pnl(y_prob, y_test, market_prices, args.threshold, args.min_edge,
                     args.bankroll, args.bet_size, test_regimes, TXCOST_FRAC)

    print(f"\n{'='*60}")
    print(f"  RESULTS @ threshold={args.threshold:.3f}")
    print(f"{'='*60}")
    print(f"  Trades:         {r['trades']:,} ({r['trade_ratio']:.1f}% of samples)")
    print(f"  Win Rate:       {r['win_rate']*100:.1f}%")
    print(f"  Total P&L:      ${r['total_pnl']:+.2f}")
    print(f"  Tx Costs Paid:  ${r['total_txcost']:.2f} ({TXCOST_FRAC*100:.1f}% x {r['trades']} trades)")
    print(f"  ROI:            {r['roi']:+.1f}%")
    print(f"  Max Drawdown:   {r['max_drawdown']*100:.1f}%")
    print(f"  Profit Factor:  {r['profit_factor']:.2f}")
    print(f"  Sharpe:         {r['sharpe']:.2f}")
    print(f"  Final Balance:  ${r['final_balance']:.2f}")

    # Bootstrap confidence intervals
    ci = bootstrap_ci(r['returns'], args.bankroll)
    if not np.isnan(ci['sharpe_ci'][0]):
        print(f"\n  Bootstrap 95% CI (1000 samples):")
        print(f"    Sharpe:  [{ci['sharpe_ci'][0]:.2f}, {ci['sharpe_ci'][1]:.2f}]")
        print(f"    ROI:     [{ci['roi_ci'][0]:+.1f}%, {ci['roi_ci'][1]:+.1f}%]")
    else:
        print(f"\n  Bootstrap CI: insufficient trades ({ci['n_trades']}) for reliable intervals")

    print(f"\n  Per-Regime:")
    for rname in ['trending', 'moderate', 'choppy', 'mean_reverting']:
        rs = r['regime_stats'].get(rname)
        if rs and rs['trades'] > 0:
            wr = rs['wins'] / rs['trades'] * 100
            print(f"    {rname:<15} {rs['trades']:>5} trades | {wr:>5.1f}% win | ${rs['pnl']:>+.2f}")

print(f"""
{'='*60}
  DISCLAIMER
{'='*60}
  market_yes_price in training data is SIMULATED
  (derived from rule-based confidence, not real Polymarket prices).
  Real-world results will differ. Use as directional guidance only.
{'='*60}
""")
