#!/usr/bin/env python3
"""
=== Prepare Smart Money Features ===

Processes top100_trades.csv (top 100 profitable traders' trade history)
into a compact JSON lookup for ML training feature extraction.

For each 15-minute market, stores minute-by-minute flow data:
- Bullish volume per minute (BUY UP + SELL DOWN)
- Total volume per minute

This enables POINT-IN-TIME correct feature extraction:
  At observation minute M, only sum minutes 0..M-1 (no lookahead).

Input:
  polymarket_btc15m_data/top100_trades.csv  (5M+ trades from top 100 traders)

Output:
  smart_money_lookup.json

Structure:
  {
    "<slug_timestamp>": {
      "b": [15 floats],  // bullish volume per minute bucket (0-14)
      "t": [15 floats]   // total volume per minute bucket (0-14)
    },
    ...
  }

Usage:
  python prepareSmartMoneyFeatures.py --input ./polymarket_btc15m_data/top100_trades.csv --output ./smart_money_lookup.json
"""

import argparse
import csv
import json
import os
import sys
from collections import defaultdict

parser = argparse.ArgumentParser(description='Prepare smart money flow features from top trader data')
parser.add_argument('--input', default='./polymarket_btc15m_data/top100_trades.csv',
                    help='Path to top100_trades.csv')
parser.add_argument('--output', default='./smart_money_lookup.json',
                    help='Output JSON lookup file')
args = parser.parse_args()

if not os.path.isfile(args.input):
    print(f"ERROR: Input file not found at {args.input}")
    sys.exit(1)

# ============================================================
# Step 1: Parse trades and aggregate by market + minute
# ============================================================
print(f"[1/2] Processing trades from {args.input}...")

# Per-market minute-bucket data
# { slug_ts_str: { "b": [0]*15, "t": [0]*15 } }
markets = defaultdict(lambda: {"b": [0.0]*15, "t": [0.0]*15})

count = 0
skipped = 0
parse_errors = 0

with open(args.input, 'r', encoding='utf-8') as f:
    reader = csv.DictReader(f)
    for row in reader:
        count += 1

        try:
            # Extract slug_timestamp from slug: "btc-updown-15m-{ts}"
            slug = row['slug'].strip()
            parts = slug.rsplit('-', 1)
            if len(parts) != 2:
                skipped += 1
                continue
            slug_ts = parts[1]

            trade_ts = int(row['timestamp'])
            slug_ts_int = int(slug_ts)
            size = float(row['size'])
            side = row['side'].strip().upper()
            outcome_idx = int(row['outcome_index'])
        except (ValueError, KeyError):
            parse_errors += 1
            continue

        # Skip trades outside the 15-min window
        secs_into = trade_ts - slug_ts_int
        if secs_into < 0 or secs_into >= 900:
            skipped += 1
            continue

        # Minute bucket (0-14)
        minute = min(secs_into // 60, 14)

        # Classify flow direction:
        # Bullish: BUY UP token (outcome_idx=0) or SELL DOWN token (outcome_idx=1)
        # Bearish: BUY DOWN token (outcome_idx=1) or SELL UP token (outcome_idx=0)
        is_bullish = (side == 'BUY' and outcome_idx == 0) or \
                     (side == 'SELL' and outcome_idx == 1)

        m = markets[slug_ts]
        m["t"][minute] += size
        if is_bullish:
            m["b"][minute] += size

        if count % 1000000 == 0:
            print(f"   {count:,} trades processed ({len(markets):,} markets)...")

print(f"   {count:,} trades | {len(markets):,} markets | {skipped:,} skipped | {parse_errors:,} errors")

# ============================================================
# Step 2: Write compact JSON
# ============================================================
print("[2/2] Writing JSON lookup...")

# Round to 2 decimal places to reduce file size
output = {}
for slug_ts, data in markets.items():
    output[slug_ts] = {
        "b": [round(v, 2) for v in data["b"]],
        "t": [round(v, 2) for v in data["t"]],
    }

with open(args.output, 'w') as f:
    json.dump(output, f, separators=(',', ':'))

file_size = os.path.getsize(args.output) / (1024 * 1024)

# ============================================================
# Summary statistics
# ============================================================
total_vol = sum(sum(m["t"]) for m in output.values())
total_bull = sum(sum(m["b"]) for m in output.values())
avg_vol = total_vol / max(len(output), 1)
bull_ratio = total_bull / max(total_vol, 1)

# Early vs late flow analysis
early_bull, early_total = 0, 0
late_bull, late_total = 0, 0
for m in output.values():
    for i in range(5):
        early_bull += m["b"][i]
        early_total += m["t"][i]
    for i in range(10, 15):
        late_bull += m["b"][i]
        late_total += m["t"][i]

early_ratio = early_bull / max(early_total, 1)
late_ratio = late_bull / max(late_total, 1)

print(f"""
============================================
  Smart Money Lookup Ready
============================================
  Trades processed:      {count:,}
  Markets:               {len(output):,}
  Total volume:          ${total_vol:,.0f}
  Avg volume/market:     ${avg_vol:,.0f}
  Overall bullish ratio: {bull_ratio:.1%}
  Early (0-5min) ratio:  {early_ratio:.1%}
  Late (10-15min) ratio: {late_ratio:.1%}
  File size:             {file_size:.1f} MB
============================================
""")
