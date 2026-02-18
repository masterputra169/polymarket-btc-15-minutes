#!/usr/bin/env python3
"""
=== Phase 0: Prepare Polymarket Features ===

Pre-processes real Polymarket historical data into a compact JSON lookup
that generateTrainingData.mjs consumes for:
  - Real market labels (resolved UP/DOWN)
  - Real minutesLeft computation
  - Real features 44-48 (market_yes_price, momentum, spread, etc.)

Input:
  polymarket_btc15m_data/02_btc15m_ml_ready.csv  (master market data)
  polymarket_btc15m_data/price_history.csv        (UP token price snapshots)

Output:
  polymarket_lookup.json  (~1-3 MB)

Structure:
  {
    "<slug_timestamp>": {
      "label": 0|1,
      "spread": float,
      "liquidity": float,
      "volume": float,
      "prices": [[secs_into_market, up_price], ...]
    },
    ...
  }

Usage:
  python preparePolymarketFeatures.py --data-dir ./polymarket_btc15m_data --output ./polymarket_lookup.json
"""

import argparse
import csv
import json
import os
import sys
from collections import defaultdict

parser = argparse.ArgumentParser(description='Prepare Polymarket features lookup')
parser.add_argument('--data-dir', default='./polymarket_btc15m_data',
                    help='Directory containing Polymarket CSV files')
parser.add_argument('--output', default='./polymarket_lookup.json',
                    help='Output JSON lookup file')
args = parser.parse_args()

MASTER_CSV = os.path.join(args.data_dir, '02_btc15m_ml_ready.csv')
PRICE_CSV = os.path.join(args.data_dir, 'price_history.csv')

# Validate inputs
for path, name in [(MASTER_CSV, 'Master CSV'), (PRICE_CSV, 'Price history CSV')]:
    if not os.path.isfile(path):
        print(f"ERROR: {name} not found at {path}")
        sys.exit(1)

# ============================================================
# Step 1: Load master market data
# ============================================================
print("[1/3] Loading master market data...")

lookup = {}
with open(MASTER_CSV, 'r', encoding='utf-8') as f:
    reader = csv.DictReader(f)
    for row in reader:
        slug_ts = row['slug_timestamp'].strip()
        label = int(row['resolved_label'])
        spread = float(row['spread']) if row['spread'] else 0.0
        liquidity = float(row['liquidity']) if row['liquidity'] else 0.0
        volume = float(row['volume']) if row['volume'] else 0.0

        lookup[slug_ts] = {
            'label': label,
            'spread': spread,
            'liquidity': liquidity,
            'volume': volume,
            'prices': [],  # filled in step 2
        }

print(f"   {len(lookup):,} markets loaded")

# ============================================================
# Step 2: Load price history (UP token only)
# ============================================================
print("[2/3] Loading price history (UP token snapshots)...")

# Group price snapshots by slug_timestamp
price_count = 0
skipped_side = 0
skipped_range = 0
matched = 0

with open(PRICE_CSV, 'r', encoding='utf-8') as f:
    reader = csv.DictReader(f)
    for row in reader:
        price_count += 1

        # Only UP token prices
        if row['token_side'].strip().lower() != 'up':
            skipped_side += 1
            continue

        # Extract slug_timestamp from slug: "btc-updown-15m-{ts}"
        slug = row['slug'].strip()
        parts = slug.rsplit('-', 1)
        if len(parts) != 2:
            continue
        slug_ts_str = parts[1]

        if slug_ts_str not in lookup:
            continue

        try:
            slug_ts_int = int(slug_ts_str)
            obs_ts = int(row['timestamp_unix'])
            price = float(row['price'])
        except (ValueError, KeyError):
            continue

        # secs_into_market: how many seconds after market opened
        secs_into = obs_ts - slug_ts_int
        if secs_into < 0 or secs_into > 900:
            skipped_range += 1
            continue

        lookup[slug_ts_str]['prices'].append([secs_into, round(price, 6)])
        matched += 1

        if price_count % 500000 == 0:
            print(f"   {price_count:,} rows processed, {matched:,} matched...")

print(f"   {price_count:,} total rows | {matched:,} matched | {skipped_side:,} non-UP | {skipped_range:,} out-of-range")

# Sort prices by time within each market
markets_with_prices = 0
for entry in lookup.values():
    if entry['prices']:
        entry['prices'].sort(key=lambda x: x[0])
        markets_with_prices += 1

print(f"   {markets_with_prices:,}/{len(lookup):,} markets have price history")

# ============================================================
# Step 3: Write JSON lookup
# ============================================================
print("[3/3] Writing JSON lookup...")

with open(args.output, 'w') as f:
    json.dump(lookup, f, separators=(',', ':'))

file_size = os.path.getsize(args.output) / (1024 * 1024)
print(f"   Saved to {args.output} ({file_size:.1f} MB)")

# Summary stats
labels = [e['label'] for e in lookup.values()]
up_count = sum(labels)
dn_count = len(labels) - up_count
avg_prices = sum(len(e['prices']) for e in lookup.values()) / max(len(lookup), 1)

print(f"""
============================================
  Polymarket Lookup Ready
============================================
  Markets:    {len(lookup):,}
  UP labels:  {up_count:,} ({up_count/len(lookup)*100:.1f}%)
  DN labels:  {dn_count:,} ({dn_count/len(lookup)*100:.1f}%)
  With prices: {markets_with_prices:,}
  Avg prices/market: {avg_prices:.1f}
  File size:  {file_size:.1f} MB
============================================
""")
