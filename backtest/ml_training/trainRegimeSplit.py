#!/usr/bin/env python3
"""
=== Regime-Split Training ===

Trains separate XGBoost models per regime (trending, moderate, choppy/mean_rev).
Each model learns patterns specific to its regime → higher accuracy per-regime.

Usage:
  python trainRegimeSplit.py --input training_data.csv --tune --tune-trials 50

Outputs:
  output/regime_trending/xgboost_model.json + norm_browser.json
  output/regime_moderate/xgboost_model.json + norm_browser.json
  output/regime_other/xgboost_model.json    + norm_browser.json  (choppy + mean_rev)
  output/regime_manifest.json  (metadata for model loader)
"""

import argparse, json, os, subprocess, sys
import pandas as pd
import numpy as np

parser = argparse.ArgumentParser()
parser.add_argument('--input', default='training_data.csv')
parser.add_argument('--output-dir', default='./output')
parser.add_argument('--tune', action='store_true')
parser.add_argument('--tune-trials', type=int, default=50)
parser.add_argument('--deploy', action='store_true')
args = parser.parse_args()

# Regime columns (one-hot in training data)
REGIME_COLS = {
    'trending':  'regime_trending',
    'moderate':  'regime_moderate',
    'other':     None,  # choppy + mean_reverting (combined — too few samples alone)
}

print(f"""
==================================================
  Regime-Split Training Pipeline
  Trains 3 models: trending, moderate, other
==================================================
  Input: {args.input}
  Optuna: {'Yes (' + str(args.tune_trials) + ' trials)' if args.tune else 'No'}
==================================================
""")

df = pd.read_csv(args.input)
print(f"  Total samples: {len(df):,}")

# Split by regime
splits = {}
if 'regime_trending' in df.columns:
    splits['trending'] = df[df['regime_trending'] == 1]
    splits['moderate'] = df[df['regime_moderate'] == 1]
    splits['other'] = df[(df['regime_trending'] == 0) & (df['regime_moderate'] == 0)]
else:
    print("  ERROR: No regime columns found in training data!")
    print("  Make sure to generate training data with regime detection enabled.")
    sys.exit(1)

for name, split_df in splits.items():
    print(f"  {name}: {len(split_df):,} samples ({len(split_df)/len(df)*100:.1f}%)")

print()

# Train each regime model
results = {}
for regime_name, split_df in splits.items():
    if len(split_df) < 1000:
        print(f"  SKIP {regime_name}: too few samples ({len(split_df)})")
        continue

    regime_dir = os.path.join(args.output_dir, f'regime_{regime_name}')
    os.makedirs(regime_dir, exist_ok=True)

    # Write split CSV
    split_csv = os.path.join(regime_dir, 'training_data.csv')
    split_df.to_csv(split_csv, index=False)

    print(f"\n{'='*50}")
    print(f"  Training: {regime_name} ({len(split_df):,} samples)")
    print(f"{'='*50}")

    # Call the main training script on the split
    cmd = [
        sys.executable, 'trainXGBoost_v3.py',
        '--input', split_csv,
        '--output-dir', regime_dir,
    ]
    if args.tune:
        cmd.extend(['--tune', '--tune-trials', str(args.tune_trials)])

    result = subprocess.run(cmd, capture_output=False)

    if result.returncode == 0:
        # Read the training report
        report_file = os.path.join(regime_dir, 'training_report.txt')
        if os.path.exists(report_file):
            with open(report_file) as f:
                report_lines = f.read().strip().split('\n')
            results[regime_name] = {
                'samples': len(split_df),
                'report': report_lines[:5],
                'model_path': os.path.join(regime_dir, 'xgboost_model.json'),
                'norm_path': os.path.join(regime_dir, 'norm_browser.json'),
            }
    else:
        print(f"  FAILED: {regime_name}")

# Write manifest for model loader
manifest = {
    'version': 'regime-split-v1',
    'regimes': {},
    'fallback': 'moderate',  # default model if regime unknown
}

for regime_name, info in results.items():
    manifest['regimes'][regime_name] = {
        'model': f'regime_{regime_name}/xgboost_model.json',
        'norm': f'regime_{regime_name}/norm_browser.json',
        'samples': info['samples'],
    }

manifest_path = os.path.join(args.output_dir, 'regime_manifest.json')
with open(manifest_path, 'w') as f:
    json.dump(manifest, f, indent=2)

print(f"\n{'='*50}")
print(f"  Regime-Split Training Complete")
print(f"{'='*50}")
for name, info in results.items():
    print(f"  {name}: {info['samples']:,} samples")
    for line in info['report'][:3]:
        print(f"    {line}")
print(f"\n  Manifest: {manifest_path}")

# Deploy if requested
if args.deploy:
    deploy_dir = os.path.join('..', '..', 'public', 'ml')
    import shutil
    for regime_name, info in results.items():
        regime_deploy = os.path.join(deploy_dir, f'regime_{regime_name}')
        os.makedirs(regime_deploy, exist_ok=True)
        shutil.copy2(info['model_path'], regime_deploy)
        shutil.copy2(info['norm_path'], regime_deploy)
        print(f"  Deployed {regime_name} to {regime_deploy}")
    shutil.copy2(manifest_path, deploy_dir)
    print(f"  Deployed manifest to {deploy_dir}")
