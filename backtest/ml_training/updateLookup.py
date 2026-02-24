#!/usr/bin/env python3
"""
=== Update Polymarket Lookup with Fresh Market Data ===

Reads freshly fetched polymarket_history_fresh.csv and fetches tick-level
price history from CLOB API for new markets, then merges into existing
polymarket_lookup.json.

Usage:
  python updateLookup.py [--fresh polymarket_history_fresh.csv] [--lookup polymarket_lookup.json] [--days 7]
"""

import argparse
import csv
import json
import os
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone

parser = argparse.ArgumentParser()
parser.add_argument('--fresh', default='polymarket_history_fresh.csv',
                    help='Freshly fetched market history CSV from fetchPolymarketHistory.mjs')
parser.add_argument('--lookup', default='polymarket_lookup.json',
                    help='Existing polymarket_lookup.json to update')
parser.add_argument('--days', type=int, default=7,
                    help='Only process markets newer than N days (default: 7)')
parser.add_argument('--no-prices', action='store_true',
                    help='Skip CLOB price fetching (only update labels/metadata)')
parser.add_argument('--clob-token-file', default='polymarket_btc15m_data/raw_btc15m_markets.json',
                    help='JSON file with conditionId->tokenIds mapping (optional)')
args = parser.parse_args()

CLOB_BASE = 'https://clob.polymarket.com'
GAMMA_BASE = 'https://gamma-api.polymarket.com'
CUTOFF_MS = int((time.time() - args.days * 86400) * 1000)


def http_get(url, timeout=15):
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'BTC-ML-Trainer/1.0'})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise
    except Exception:
        return None


def fetch_clob_prices(token_id, start_ts_sec, end_ts_sec):
    """Fetch tick-level price history from CLOB API for a token."""
    url = f"{CLOB_BASE}/prices-history?market={token_id}&startTs={start_ts_sec}&endTs={end_ts_sec}&fidelity=60"
    data = http_get(url)
    if not data or 'history' not in data:
        return []
    return [[int(p['t']) - start_ts_sec, round(float(p['p']), 6)]
            for p in data.get('history', [])
            if 0 <= int(p['t']) - start_ts_sec <= 900]


def fetch_token_id_for_market(slug):
    """Fetch YES/UP tokenId for a market by querying Gamma API."""
    # slug format: btc-updown-15m-{ts} or btc-up-or-down-15m-{ts}
    url = f"{GAMMA_BASE}/markets?slug={slug}"
    markets = http_get(url)
    if not markets:
        return None

    market_list = markets if isinstance(markets, list) else [markets]
    for m in market_list:
        tokens = m.get('clobTokenIds', [])
        outcomes = m.get('outcomes', '[]')
        if isinstance(outcomes, str):
            try:
                outcomes = json.loads(outcomes)
            except Exception:
                outcomes = []

        # Find UP/YES token
        for i, outcome in enumerate(outcomes):
            if str(outcome).lower() in ('up', 'yes') and i < len(tokens):
                return tokens[i]
    return None


def slug_to_ts(slug):
    """Extract slug_timestamp (Unix seconds) from market slug."""
    import re
    match = re.search(r'(\d{9,10})$', slug)
    if match:
        ts = int(match.group(1))
        if 1700000000 < ts < 2000000000:
            return ts
    return None


def main():
    print(f"\n=== Update Polymarket Lookup ===")
    print(f"Fresh data:  {args.fresh}")
    print(f"Lookup:      {args.lookup}")
    print(f"Days cutoff: last {args.days} days (>{datetime.fromtimestamp(CUTOFF_MS/1000, tz=timezone.utc).strftime('%Y-%m-%d')})")

    # 1. Load existing lookup
    existing = {}
    if os.path.exists(args.lookup):
        print(f"\n[1/4] Loading existing lookup...")
        with open(args.lookup, 'r') as f:
            existing = json.load(f)
        print(f"   {len(existing):,} existing markets")
    else:
        print(f"\n[1/4] No existing lookup found — will create new")

    # 2. Read fresh market CSV
    if not os.path.exists(args.fresh):
        print(f"\nERROR: Fresh market file not found: {args.fresh}")
        sys.exit(1)

    print(f"\n[2/4] Reading fresh markets...")
    fresh_markets = []
    with open(args.fresh, 'r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for row in reader:
            slug = row.get('slug', '').strip()
            outcome = row.get('outcome', '').strip().upper()
            if not slug or outcome not in ('UP', 'DOWN'):
                continue

            # Parse market time
            market_time_ms = int(row.get('market_time_ms', 0) or 0)
            if not market_time_ms:
                # Try to extract from slug
                ts = slug_to_ts(slug)
                market_time_ms = ts * 1000 if ts else 0

            if not market_time_ms or market_time_ms < CUTOFF_MS:
                continue  # Only process recent markets

            slug_ts = slug_to_ts(slug)
            if not slug_ts:
                continue

            fresh_markets.append({
                'slug': slug,
                'slug_ts': str(slug_ts),
                'label': 1 if outcome == 'UP' else 0,
                'volume': float(row.get('volume', 0) or 0),
                'liquidity': float(row.get('liquidity', 0) or 0),
                'market_time_sec': slug_ts,
                'market_time_ms': market_time_ms,
            })

    print(f"   {len(fresh_markets):,} fresh markets in last {args.days} days")

    # Only process markets NOT already in lookup
    new_markets = [m for m in fresh_markets if m['slug_ts'] not in existing]
    print(f"   {len(new_markets):,} new markets to add")

    if not new_markets:
        print("\nAll fresh markets already in lookup. Nothing to update.")
        return

    # 3. Fetch CLOB prices for each new market
    print(f"\n[3/4] Fetching CLOB tick prices for {len(new_markets)} new markets...")
    added = 0
    skipped_prices = 0

    for i, m in enumerate(new_markets):
        slug_ts = m['slug_ts']
        start_sec = m['market_time_sec']
        end_sec = start_sec + 900  # 15-minute market

        prices = []
        if not args.no_prices:
            # Fetch token ID for this market
            token_id = fetch_token_id_for_market(m['slug'])
            time.sleep(0.2)  # Rate limit

            if token_id:
                prices = fetch_clob_prices(token_id, start_sec, end_sec)
                time.sleep(0.3)  # Rate limit

            if not prices:
                skipped_prices += 1

        # Add to lookup
        existing[slug_ts] = {
            'label': m['label'],
            'spread': 0.02,  # Default spread estimate
            'liquidity': m['liquidity'],
            'volume': m['volume'],
            'prices': prices,
        }
        added += 1

        if (i + 1) % 10 == 0:
            print(f"   {i+1}/{len(new_markets)} — {added} added, {skipped_prices} without tick prices")
            sys.stdout.flush()

    print(f"\n   Done: {added} new markets added ({skipped_prices} without tick prices)")

    # 4. Save updated lookup
    print(f"\n[4/4] Saving updated lookup...")
    with open(args.lookup, 'w') as f:
        json.dump(existing, f, separators=(',', ':'))

    size_mb = os.path.getsize(args.lookup) / 1024 / 1024
    labels = [v['label'] for v in existing.values()]
    up_count = sum(labels)
    with_prices = sum(1 for v in existing.values() if v['prices'])

    print(f"""
============================================
  Lookup Updated
============================================
  Total markets:  {len(existing):,}
  New markets:    {added:,}
  UP labels:      {up_count:,} ({up_count/len(existing)*100:.1f}%)
  DN labels:      {len(existing)-up_count:,} ({(len(existing)-up_count)/len(existing)*100:.1f}%)
  With tick px:   {with_prices:,} ({with_prices/len(existing)*100:.1f}%)
  File size:      {size_mb:.1f} MB

Next step: node generateTrainingData.mjs --days 540 --polymarket-lookup ./polymarket_lookup.json
============================================
""")


if __name__ == '__main__':
    main()
