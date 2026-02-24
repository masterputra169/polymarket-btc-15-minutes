#!/usr/bin/env python3
"""
Quick update polymarket_lookup.json with fresh markets (last N days).
Labels only — no tick prices (fast).
"""
import json, urllib.request, urllib.error, time, sys, re, os

DAYS = int(sys.argv[1]) if len(sys.argv) > 1 else 6
LOOKUP_PATH = './polymarket_lookup.json'
GAMMA = 'https://gamma-api.polymarket.com'
SERIES_ID = '10192'

cutoff = __import__('datetime').datetime.now(__import__('datetime').timezone.utc) - __import__('datetime').timedelta(days=DAYS)
cutoff_str = cutoff.strftime('%Y-%m-%d')

def get(url, retries=3):
    for a in range(retries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'BTC-ML/1.0'})
            with urllib.request.urlopen(req, timeout=20) as r:
                return json.loads(r.read())
        except Exception as e:
            if a == retries-1: return None
            time.sleep(1)
    return None

def slug_ts(slug):
    m = re.search(r'(\d{9,10})$', slug)
    if m:
        ts = int(m.group(1))
        if 1700000000 < ts < 2000000000: return str(ts)
    return None

print(f"Loading existing lookup...")
with open(LOOKUP_PATH) as f:
    lookup = json.load(f)
print(f"  {len(lookup):,} markets")

print(f"Fetching events since {cutoff_str}...")
markets = []
offset = 0
while True:
    url = f"{GAMMA}/events?series_id={SERIES_ID}&closed=true&start_date_min={cutoff_str}&limit=100&offset={offset}"
    events = get(url)
    if not events or not isinstance(events, list) or len(events) == 0:
        break
    for ev in events:
        for m in (ev.get('markets') or []):
            slug = m.get('slug', '')
            outcomes = m.get('outcomes', [])
            if isinstance(outcomes, str):
                try: outcomes = json.loads(outcomes)
                except: outcomes = []
            prices = m.get('outcomePrices', [])
            if isinstance(prices, str):
                try: prices = json.loads(prices)
                except: prices = []
            up_idx = next((i for i, o in enumerate(outcomes) if str(o).lower() == 'up'), -1)
            dn_idx = next((i for i, o in enumerate(outcomes) if str(o).lower() == 'down'), -1)
            up_p = float(prices[up_idx]) if up_idx >= 0 and up_idx < len(prices) else None
            dn_p = float(prices[dn_idx]) if dn_idx >= 0 and dn_idx < len(prices) else None
            outcome = None
            if up_p is not None and dn_p is not None:
                if up_p > 0.8: outcome = 1
                elif dn_p > 0.8: outcome = 0
            if outcome is None: continue
            ts = slug_ts(slug)
            if not ts: continue
            markets.append({'ts': ts, 'label': outcome,
                          'volume': float(m.get('volume') or 0),
                          'liquidity': float(m.get('liquidityNum') or m.get('liquidity') or 0)})
    print(f"  {len(markets)} markets... (offset {offset})")
    if len(events) < 100: break
    offset += 100
    time.sleep(0.3)

new = [m for m in markets if m['ts'] not in lookup]
print(f"  {len(new)} new markets to add")

for m in new:
    lookup[m['ts']] = {'label': m['label'], 'spread': 0.02, 'liquidity': m['liquidity'], 'volume': m['volume'], 'prices': []}

print(f"Saving updated lookup ({len(lookup):,} total)...")
with open(LOOKUP_PATH, 'w') as f:
    json.dump(lookup, f, separators=(',', ':'))

size = os.path.getsize(LOOKUP_PATH) / 1024 / 1024
labels = [v['label'] for v in lookup.values()]
print(f"""
============================================
  Done: +{len(new)} new markets
  Total: {len(lookup):,}
  UP: {sum(labels):,} ({sum(labels)/len(labels)*100:.1f}%)
  DN: {len(labels)-sum(labels):,} ({(len(labels)-sum(labels))/len(labels)*100:.1f}%)
  File: {size:.1f} MB
============================================
""")
