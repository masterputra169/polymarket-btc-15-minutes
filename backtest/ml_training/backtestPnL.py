#!/usr/bin/env python3
"""
=== Backtest P&L Simulation ===

Simulates Polymarket trading P&L using the trained XGBoost model.
Applies Platt calibration, threshold sweep, and per-regime breakdown.

Usage:
  python backtestPnL.py --threshold-sweep
  python backtestPnL.py --threshold 0.60 --bankroll 1000 --bet-size 10
  python backtestPnL.py --input training_data.csv --model-dir ./output

This file is the ENTRYPOINT only: argparse, orchestration, printing. The
simulation, its statistics and the sweep live in mltrain/backtest.py, the cost
and payoff arithmetic in mltrain/fees.py, and the engineered features in
mltrain/features.py (shared with trainXGBoost_v3.py, so the two can no longer
drift apart). Everything numeric is unit-tested in tests/test_backtest.py and
tests/test_fees.py.

NOTE: As of Apr 2026, market_yes_price is the REAL Polymarket UP-token price sampled
at market OPEN (secs~=0), not at observation time. This removes the label-leakage that
inflated prior accuracy. Samples without real Polymarket data are dropped entirely
(simulation fallback was removed due to distribution mismatch hurting real performance).
"""

import argparse
import json
import os
import sys

import numpy as np
import pandas as pd

from mltrain import fees
from mltrain.backtest import (
    KNOWN_REGIMES,
    bootstrap_ci,
    run_threshold_sweep,
    select_best_threshold,
    simulate_pnl,
)
from mltrain.backtest_inputs import (
    apply_platt_calibration,
    derive_regime_labels,
    extract_market_prices,
    oos_split_index,
)
from mltrain.data import DEFAULT_METADATA_COLS
from mltrain.features import engineer_features

try:
    import xgboost as xgb
except ImportError:
    print("ERROR: xgboost not installed. Run: pip install xgboost")
    sys.exit(1)

parser = argparse.ArgumentParser(description="Backtest P&L simulation for Polymarket")
parser.add_argument("--input", default="training_data.csv", help="Training data CSV")
parser.add_argument("--model-dir", default="./output", help="Directory with model files")
parser.add_argument(
    "--threshold", type=float, default=0.60, help="Confidence threshold for single run"
)
parser.add_argument("--threshold-sweep", action="store_true", help="Run sweep from 0.50 to 0.80")
parser.add_argument("--bankroll", type=float, default=1000, help="Starting bankroll")
parser.add_argument("--bet-size", type=float, default=10, help="Bet size per trade")
parser.add_argument("--min-edge", type=float, default=0.05, help="Minimum edge to trade")
parser.add_argument(
    "--spread-pct",
    type=float,
    default=fees.DEFAULT_SPREAD_PCT,
    help="Round-trip spread cost in %% (default: 3.0 — realistic for thin "
    "Polymarket 15m BTC liquidity; 2-4c on $0.50 price is common)",
)
parser.add_argument(
    "--slippage-pct",
    type=float,
    default=fees.DEFAULT_SLIPPAGE_PCT,
    help="Slippage cost in %% (default: 1.0 — orders often exceed top-of-book size)",
)
parser.add_argument(
    "--oos-start",
    type=float,
    default=0.85,
    help="Fraction of data to use as OOS start (default: 0.85 = last 15%%). "
    "Use 0.875 with --holdout-frac 0.125 for true OOS backtest.",
)
args = parser.parse_args()

# Transaction cost: half spread on entry + half spread on exit + slippage
# e.g. spread=1.0%, slippage=0.5% → 1.5% round-trip cost as fraction of bet
TXCOST_FRAC = fees.round_trip_cost_fraction(args.spread_pct, args.slippage_pct)

# ================================================
# 1. LOAD DATA
# ================================================
print(f"\n{'='*60}")
print("  Backtest P&L Simulation")
print(
    f"  Transaction costs: {args.spread_pct:.1f}% spread + {args.slippage_pct:.1f}% slippage = {TXCOST_FRAC*100:.1f}% round-trip"
)
print(f"{'='*60}")

if not os.path.exists(args.input):
    print(f"ERROR: Input file not found: {args.input}")
    sys.exit(1)

df = pd.read_csv(args.input)
# Metadata columns are row identifiers, not features. trainXGBoost_v3.py drops
# them via the same constant; keeping them here produced an 80-vs-79 feature
# mismatch that made every run against a current model abort in model.predict.
feature_cols_orig = [c for c in df.columns if c != "label" and c not in DEFAULT_METADATA_COLS]
X_orig = df[feature_cols_orig].values.astype(np.float32)
y = df["label"].values.astype(np.int32)
X_orig = np.nan_to_num(X_orig, nan=0.0, posinf=0.0, neginf=0.0)

print(f"  Samples: {len(df):,} | Features: {len(feature_cols_orig)}")

# ================================================
# 2. ENGINEER FEATURES (same as trainXGBoost_v3.py)
# ================================================
fi = {name: i for i, name in enumerate(feature_cols_orig)}
X, feature_cols = engineer_features(X_orig, feature_cols_orig)
n_engineered = len(feature_cols) - len(feature_cols_orig)

print(
    f"  Total features: {len(feature_cols)} ({len(feature_cols_orig)} base + {n_engineered} engineered)"
)

# ================================================
# 3. LOAD MODEL
# ================================================
model_ubj = os.path.join(args.model_dir, "xgboost_model.ubj")
norm_path = os.path.join(args.model_dir, "norm_browser.json")

if not os.path.exists(model_ubj):
    print(f"ERROR: Model not found: {model_ubj}")
    sys.exit(1)

model = xgb.Booster()
model.load_model(model_ubj)
print(f"  Model loaded: {model_ubj}")

# Load Platt calibration params
platt_a, platt_b = 1.0, 0.0
platt_on_logits = True
if os.path.exists(norm_path):
    with open(norm_path) as f:
        norm = json.load(f)
    platt_a = norm.get("platt_a", 1.0)
    platt_b = norm.get("platt_b", 0.0)
    # The trainer fits A/B on raw margins and records that as platt_on_logits
    # (mltrain/calibration.py, audit fix C4). Honour the flag: feeding
    # probabilities into a logit-space fit applies a second sigmoid, which
    # compresses every prediction into ~[0.50, 0.73] — the backtest then trades
    # UP on 100% of rows and reports an always-long strategy instead of the
    # model's. Default True to match every model this trainer has shipped.
    platt_on_logits = bool(norm.get("platt_on_logits", True))
    space = "logits" if platt_on_logits else "probabilities"
    print(f"  Platt calibration: A={platt_a:.4f}, B={platt_b:.4f} (fitted on {space})")

# ================================================
# 4. PREDICT
# ================================================
# Temporal split: use --oos-start to control test region
# Default 0.85 = same as training test set (in-sample for Optuna)
# Use 0.875+ for true OOS (data Optuna never saw, if trained with --holdout-frac)
split = oos_split_index(len(X), args.oos_start)
X_test = X[split:]
y_test = y[split:]

oos_mode = "OUT-OF-SAMPLE" if args.oos_start > 0.85 else "IN-SAMPLE (overlaps tuning data)"
print(f"  Split at {args.oos_start:.1%} → test starts at sample {split:,} [{oos_mode}]")

# Regime labels for test set
test_regimes = derive_regime_labels(X_orig, fi, split)

# Market price proxy (real Polymarket UP price, else rule_prob_up, else 0.5)
market_prices = extract_market_prices(X_orig, fi, split, len(X_test))

dtest = xgb.DMatrix(X_test, feature_names=feature_cols)
y_prob_raw = model.predict(dtest)

# Apply Platt calibration in the space A/B were fitted on (see above).
platt_input = model.predict(dtest, output_margin=True) if platt_on_logits else y_prob_raw
y_prob = apply_platt_calibration(platt_input, platt_a, platt_b)

print(f"  Test samples: {len(X_test):,}")
print(f"  Raw prob range: [{y_prob_raw.min():.3f}, {y_prob_raw.max():.3f}]")
print(f"  Calibrated prob range: [{y_prob.min():.3f}, {y_prob.max():.3f}]")

# ================================================
# 5. OUTPUT
# ================================================

if args.threshold_sweep:
    print(f"\n{'='*80}")
    print(
        f"  THRESHOLD SWEEP — Bankroll: ${args.bankroll:.0f} | Bet: ${args.bet_size:.0f} | Min Edge: {args.min_edge*100:.0f}% | TxCost: {TXCOST_FRAC*100:.1f}%"
    )
    print(f"{'='*80}")
    print(
        f"  {'Thresh':>7} | {'Trades':>7} | {'Rate':>6} | {'WinR':>6} | {'P&L':>10} | {'ROI':>7} | {'MaxDD':>7} | {'PF':>6} | {'Sharpe':>7}"
    )
    print(
        f"  {'-'*7}-+-{'-'*7}-+-{'-'*6}-+-{'-'*6}-+-{'-'*10}-+-{'-'*7}-+-{'-'*7}-+-{'-'*6}-+-{'-'*7}"
    )

    sweep_rows = run_threshold_sweep(
        y_prob,
        y_test,
        market_prices,
        min_edge=args.min_edge,
        bankroll=args.bankroll,
        bet_size=args.bet_size,
        regimes=test_regimes,
        txcost_frac=TXCOST_FRAC,
    )

    for row in sweep_rows:
        r = row.result
        pnl_str = f"${r.total_pnl:+.2f}"
        print(
            f"  {row.threshold:>7.3f} | {r.trades:>7,} | {r.trade_ratio:>5.1f}% | {r.win_rate*100:>5.1f}% | {pnl_str:>10} | {r.roi:>+6.1f}% | {r.max_drawdown*100:>6.1f}% | {r.profit_factor:>6.2f} | {r.sharpe:>7.2f}"
        )

    # Find optimal threshold (best win_rate * sqrt(trade_ratio))
    best = select_best_threshold(sweep_rows)

    print(
        f"\n  Recommended threshold: {best.threshold:.3f} (score = win_rate * sqrt(trade_ratio) = {best.score:.4f})"
    )

    # Per-regime breakdown at optimal threshold
    optimal = simulate_pnl(
        y_prob,
        y_test,
        market_prices,
        best.threshold,
        args.min_edge,
        args.bankroll,
        args.bet_size,
        test_regimes,
        TXCOST_FRAC,
    )

    print(f"\n{'='*60}")
    print(f"  PER-REGIME BREAKDOWN @ threshold={best.threshold:.3f}")
    print(f"{'='*60}")
    print(f"  {'Regime':<15} | {'Trades':>7} | {'WinR':>6} | {'P&L':>10}")
    print(f"  {'-'*15}-+-{'-'*7}-+-{'-'*6}-+-{'-'*10}")

    for rname in KNOWN_REGIMES:
        rs = optimal.regime_stats.get(rname)
        if rs and rs.trades > 0:
            print(f"  {rname:<15} | {rs.trades:>7,} | {rs.win_rate*100:>5.1f}% | ${rs.pnl:>+9.2f}")

    # Unknown regime
    for rname, rs in optimal.regime_stats.items():
        if rname not in KNOWN_REGIMES and rs.trades > 0:
            print(f"  {rname:<15} | {rs.trades:>7,} | {rs.win_rate*100:>5.1f}% | ${rs.pnl:>+9.2f}")

    # Transaction cost summary for optimal threshold
    print(
        f"\n  Tx Costs Paid @ optimal: ${optimal.total_txcost:.2f} ({TXCOST_FRAC*100:.1f}% x {optimal.trades} trades)"
    )

    # Bootstrap CI for optimal threshold
    ci = bootstrap_ci(optimal.returns, trades_per_year=optimal.trades_per_year)
    if ci.sufficient:
        print(f"\n  Bootstrap 95% CI (1000 samples) @ threshold={best.threshold:.3f}:")
        print(
            f"    Sharpe:  [{ci.sharpe_lo:.2f}, {ci.sharpe_hi:.2f}]  (point: {optimal.sharpe:.2f})"
        )
        print(f"    ROI:     [{ci.roi_lo:+.1f}%, {ci.roi_hi:+.1f}%]  (point: {optimal.roi:+.1f}%)")
    else:
        print(f"\n  Bootstrap CI: insufficient trades ({ci.n_trades}) for reliable intervals")

else:
    # Single threshold run
    r = simulate_pnl(
        y_prob,
        y_test,
        market_prices,
        args.threshold,
        args.min_edge,
        args.bankroll,
        args.bet_size,
        test_regimes,
        TXCOST_FRAC,
    )

    print(f"\n{'='*60}")
    print(f"  RESULTS @ threshold={args.threshold:.3f}")
    print(f"{'='*60}")
    print(f"  Trades:         {r.trades:,} ({r.trade_ratio:.1f}% of samples)")
    print(f"  Win Rate:       {r.win_rate*100:.1f}%")
    print(f"  Total P&L:      ${r.total_pnl:+.2f}")
    print(f"  Tx Costs Paid:  ${r.total_txcost:.2f} ({TXCOST_FRAC*100:.1f}% x {r.trades} trades)")
    print(f"  ROI:            {r.roi:+.1f}%")
    print(f"  Max Drawdown:   {r.max_drawdown*100:.1f}%")
    print(f"  Profit Factor:  {r.profit_factor:.2f}")
    print(f"  Sharpe:         {r.sharpe:.2f}")
    print(f"  Final Balance:  ${r.final_balance:.2f}")

    # Bootstrap confidence intervals
    ci = bootstrap_ci(r.returns, trades_per_year=r.trades_per_year)
    if ci.sufficient:
        print("\n  Bootstrap 95% CI (1000 samples):")
        print(f"    Sharpe:  [{ci.sharpe_lo:.2f}, {ci.sharpe_hi:.2f}]")
        print(f"    ROI:     [{ci.roi_lo:+.1f}%, {ci.roi_hi:+.1f}%]")
    else:
        print(f"\n  Bootstrap CI: insufficient trades ({ci.n_trades}) for reliable intervals")

    print("\n  Per-Regime:")
    for rname in KNOWN_REGIMES:
        rs = r.regime_stats.get(rname)
        if rs and rs.trades > 0:
            print(
                f"    {rname:<15} {rs.trades:>5} trades | {rs.win_rate*100:>5.1f}% win | ${rs.pnl:>+.2f}"
            )

print(f"""
{'='*60}
  DISCLAIMER
{'='*60}
  market_yes_price comes from the real Polymarket CLOB (generateTrainingData
  falls back to a rule-based proxy only where no market was matched).
  Fees here are a FLAT round-trip percentage; the live bot pays the dynamic
  0.072*p*(1-p) (max 1.80% at p=0.50), so a low --spread-pct understates the
  real cost near 50c. Fills are assumed at the quoted price with no partial
  fills or queue position. Use as directional guidance, not a P&L forecast.
{'='*60}
""")
