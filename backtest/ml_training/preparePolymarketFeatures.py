#!/usr/bin/env python3
"""
=== Phase 0: Prepare Polymarket Features ===

Pre-processes real Polymarket historical data into a compact JSON lookup
that generateTrainingData.mts consumes for:
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

WARNING: without --merge this REPLACES the output file with the static scrape in
--data-dir. Markets discovered since that scrape (everything fetchFreshMarkets.mts
has added) are not in it and would be dropped. Pass
--merge <same path as --output> to keep them.

This file is the ENTRYPOINT only: argparse, printing and file I/O. The lookup
construction, price-history ingest, merge and summary live in
mltrain/polymarket_lookup.py and are unit-tested in tests/test_polymarket_lookup.py.
"""

import argparse
import csv
import json
import os
import sys

from mltrain.polymarket_lookup import (
    build_market_lookup,
    ingest_price_history,
    merge_existing,
    sort_price_series,
    summarise_lookup,
)

parser = argparse.ArgumentParser(description="Prepare Polymarket features lookup")
parser.add_argument(
    "--data-dir",
    default="./polymarket_btc15m_data",
    help="Directory containing Polymarket CSV files",
)
parser.add_argument("--output", default="./polymarket_lookup.json", help="Output JSON lookup file")
parser.add_argument(
    "--merge",
    default=None,
    help="Path to existing lookup JSON to merge (keeps entries not in dataset)",
)
args = parser.parse_args()

MASTER_CSV = os.path.join(args.data_dir, "02_btc15m_ml_ready.csv")
PRICE_CSV = os.path.join(args.data_dir, "price_history.csv")

# Validate inputs
for path, name in [(MASTER_CSV, "Master CSV"), (PRICE_CSV, "Price history CSV")]:
    if not os.path.isfile(path):
        print(f"ERROR: {name} not found at {path}")
        sys.exit(1)

# ============================================================
# Step 1: Load master market data
# ============================================================
print("[1/3] Loading master market data...")

with open(MASTER_CSV, encoding="utf-8") as f:
    lookup = build_market_lookup(csv.DictReader(f))

print(f"   {len(lookup):,} markets loaded")

# Fail before writing: an empty master CSV means the scrape produced nothing,
# and continuing would overwrite --output with "{}" (and then divide by zero in
# the summary below). Bail out while the existing lookup is still intact.
if not lookup:
    print(f"ERROR: {MASTER_CSV} contained no market rows — refusing to write an empty lookup")
    sys.exit(1)

# ============================================================
# Step 2: Load price history (UP token only)
# ============================================================
print("[2/3] Loading price history (UP token snapshots)...")

with open(PRICE_CSV, encoding="utf-8") as f:
    ingest = ingest_price_history(lookup, csv.DictReader(f))

print(
    f"   {ingest.rows_read:,} total rows | {ingest.matched:,} matched | "
    f"{ingest.skipped_side:,} non-UP | {ingest.skipped_range:,} out-of-range"
)

# Sort prices by time within each market
markets_with_prices = sort_price_series(lookup)

print(f"   {markets_with_prices:,}/{len(lookup):,} markets have price history")

# ============================================================
# Step 3: Merge with existing lookup (if --merge provided)
# ============================================================
if args.merge and os.path.isfile(args.merge):
    print(f"[3/4] Merging with existing lookup: {args.merge}")
    with open(args.merge) as f:
        existing = json.load(f)
    # Add entries from existing that are NOT in the new dataset
    merged_count = merge_existing(lookup, existing)
    print(f"   Merged {merged_count:,} entries from existing lookup (not in dataset)")
    print(f"   Total after merge: {len(lookup):,}")
else:
    print("[3/4] No merge file — using dataset only")

# ============================================================
# Step 4: Write JSON lookup
# ============================================================
print("[4/4] Writing JSON lookup...")

with open(args.output, "w") as f:
    json.dump(lookup, f, separators=(",", ":"))

file_size = os.path.getsize(args.output) / (1024 * 1024)
print(f"   Saved to {args.output} ({file_size:.1f} MB)")

# Summary stats. NOTE: `markets_with_prices` is the PRE-merge count, so with
# --merge this line under-reports; `Avg prices/market` covers the merged set.
summary = summarise_lookup(lookup)

print(f"""
============================================
  Polymarket Lookup Ready
============================================
  Markets:    {summary.n_markets:,}
  UP labels:  {summary.n_up:,} ({summary.n_up/summary.n_markets*100:.1f}%)
  DN labels:  {summary.n_down:,} ({summary.n_down/summary.n_markets*100:.1f}%)
  With prices: {markets_with_prices:,}
  Avg prices/market: {summary.avg_prices_per_market:.1f}
  File size:  {file_size:.1f} MB
============================================
""")
