#!/usr/bin/env python3
"""
Fill missing Polymarket market resolutions by querying gamma API directly for
slugTs values present in shadow capture but NOT in polymarket_lookup.json.

Used during v19 shadow validation when quickUpdateLookup misses fresh markets.
"""
import json, os, re, sys, time, urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
CAPTURE = os.path.join(ROOT, 'bot', 'data', 'feature_capture.jsonl')
LOOKUP  = os.path.join(ROOT, 'backtest', 'ml_training', 'polymarket_lookup.json')
GAMMA   = 'https://gamma-api.polymarket.com'
SERIES  = '10192'

def get(url, retries=3):
    for a in range(retries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent':'BTC-ML/1.0'})
            with urllib.request.urlopen(req, timeout=20) as r:
                return json.loads(r.read())
        except Exception as e:
            if a == retries - 1: return None
            time.sleep(1)
    return None

print('Loading capture + lookup...')
with open(LOOKUP) as f: lookup = json.load(f)
slugs_in_capture = set()
with open(CAPTURE) as f:
    for line in f:
        if not line.strip(): continue
        r = json.loads(line)
        if r.get('slugTs'): slugs_in_capture.add(str(r['slugTs']))
missing = sorted(slugs_in_capture - set(lookup.keys()))
print(f'  Capture has {len(slugs_in_capture)} unique slugTs, {len(missing)} missing from lookup')

if not missing:
    print('Nothing to fill.')
    sys.exit(0)

# Query gamma in pages until we cover the missing range
min_ts = int(missing[0])
max_ts = int(missing[-1])
print(f'  Missing range: {min_ts} → {max_ts} (span {(max_ts-min_ts)/3600:.1f}h)')

# Fetch ALL events in last 2 days (both open and closed), then check each
import datetime
cutoff = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=2)
cutoff_str = cutoff.strftime('%Y-%m-%d')

new_resolutions = {}
for closed_flag in ['true', 'false']:
    offset = 0
    while True:
        url = f"{GAMMA}/events?series_id={SERIES}&closed={closed_flag}&start_date_min={cutoff_str}&limit=100&offset={offset}"
        events = get(url)
        if not events or not isinstance(events, list) or len(events) == 0:
            break
        for ev in events:
            for m in (ev.get('markets') or []):
                slug = m.get('slug', '')
                mt = re.search(r'(\d{9,10})$', slug)
                if not mt: continue
                ts = mt.group(1)
                if ts not in missing or ts in new_resolutions: continue

                outcomes = m.get('outcomes', [])
                if isinstance(outcomes, str):
                    try: outcomes = json.loads(outcomes)
                    except: outcomes = []
                prices = m.get('outcomePrices', [])
                if isinstance(prices, str):
                    try: prices = json.loads(prices)
                    except: prices = []
                up_i = next((i for i,o in enumerate(outcomes) if str(o).lower()=='up'), -1)
                dn_i = next((i for i,o in enumerate(outcomes) if str(o).lower()=='down'), -1)
                up_p = float(prices[up_i]) if 0 <= up_i < len(prices) else None
                dn_p = float(prices[dn_i]) if 0 <= dn_i < len(prices) else None
                if up_p is None or dn_p is None: continue
                # Strict resolution threshold (matches audit fix)
                if up_p >= 0.95: label = 1
                elif dn_p >= 0.95: label = 0
                else: continue
                new_resolutions[ts] = {
                    'label': label,
                    'spread': 0.02,
                    'liquidity': float(m.get('liquidityNum') or m.get('liquidity') or 0),
                    'volume': float(m.get('volume') or 0),
                    'prices': [],
                }
        print(f'  closed={closed_flag} offset={offset}: collected {len(new_resolutions)} resolutions')
        if len(events) < 100: break
        offset += 100
        time.sleep(0.3)
        if len(new_resolutions) >= len(missing): break
    if len(new_resolutions) >= len(missing): break

print(f'\nFilling {len(new_resolutions)}/{len(missing)} resolutions...')
for ts, info in new_resolutions.items():
    lookup[ts] = info

# Atomic write
tmp = LOOKUP + '.tmp'
with open(tmp, 'w') as f:
    json.dump(lookup, f, separators=(',', ':'))
    f.flush(); os.fsync(f.fileno())
os.replace(tmp, LOOKUP)
print(f'Saved {LOOKUP} ({len(lookup):,} total markets)')
