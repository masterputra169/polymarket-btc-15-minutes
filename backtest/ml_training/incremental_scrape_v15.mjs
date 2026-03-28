#!/usr/bin/env node
/**
 * Incremental scrape + enrich for v15 training.
 * Appends new markets (since last scrape) to existing data.
 * Then re-enriches ONLY new markets with price history.
 */

import fs from 'fs';
import path from 'path';

const DATA_DIR = './polymarket_btc15m_data';
const GAMMA_API = 'https://gamma-api.polymarket.com';
const CLOB_API = 'https://clob.polymarket.com';
const DELAY_MS = 200;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

function escapeCSV(val) {
  if (val === null || val === undefined) return '';
  const s = String(val);
  return (s.includes(',') || s.includes('"') || s.includes('\n'))
    ? `"${s.replace(/"/g, '""')}"` : s;
}

async function fetchJSON(url) {
  for (let i = 1; i <= 3; i++) {
    try {
      const res = await fetch(url);
      if (res.status === 429) { await sleep(i * 5000); continue; }
      if (!res.ok) return null;
      return await res.json();
    } catch {
      if (i === 3) return null;
      await sleep(i * 1000);
    }
  }
  return null;
}

function parseTokenIds(market) {
  try {
    const ids = typeof market.clobTokenIds === 'string'
      ? JSON.parse(market.clobTokenIds) : (market.clobTokenIds || []);
    return { upToken: ids[0] || null, downToken: ids[1] || null };
  } catch { return { upToken: null, downToken: null }; }
}

// ── Step 1: Load existing data ──
log('📂 Loading existing raw data...');
const rawPath = path.join(DATA_DIR, 'raw_btc15m_markets.json');
const existing = JSON.parse(fs.readFileSync(rawPath, 'utf-8'));
log(`   Loaded ${existing.length} existing markets`);

// Find last timestamp
const lastTs = existing.reduce((max, m) => {
  const slug = m.slug || m._event_slug || '';
  const match = slug.match(/(\d{10,})$/);
  return match ? Math.max(max, parseInt(match[1])) : max;
}, 0);
log(`   Last timestamp: ${lastTs} (${new Date(lastTs * 1000).toISOString()})`);

// ── Step 2: Scrape new markets ──
const startTs = lastTs + 900; // Next 15-min slot
const endTs = Math.floor(Date.now() / 1000);
const totalSlots = Math.floor((endTs - startTs) / 900);

log('');
log('═══════════════════════════════════════════════════');
log(`INCREMENTAL SCRAPE: ${totalSlots} new slots`);
log(`From: ${new Date(startTs * 1000).toISOString()}`);
log(`To:   ${new Date(endTs * 1000).toISOString()}`);
log(`Est. time: ~${Math.round(totalSlots * DELAY_MS / 1000 / 60)} minutes`);
log('═══════════════════════════════════════════════════');

const newMarkets = [];
let checked = 0;

for (let ts = startTs; ts <= endTs; ts += 900) {
  checked++;
  const slug = `btc-updown-15m-${ts}`;
  const data = await fetchJSON(`${GAMMA_API}/events?slug=${slug}`);

  if (data && data.length > 0) {
    const event = data[0];
    if (event.markets && event.markets.length > 0) {
      const market = event.markets[0];
      market._event_slug = event.slug;
      market._event_title = event.title;
      market._event_volume = event.volume;
      market._event_startDate = event.startDate;
      market._event_endDate = event.endDate;
      newMarkets.push(market);
    }
  }

  if (checked % 50 === 0) {
    const pct = ((checked / totalSlots) * 100).toFixed(1);
    log(`  Progress: ${checked}/${totalSlots} (${pct}%) | Found: ${newMarkets.length}`);
  }

  await sleep(DELAY_MS);
}

log(`✅ Found ${newMarkets.length} new markets`);

if (newMarkets.length === 0) {
  log('No new markets to add. Exiting.');
  process.exit(0);
}

// ── Step 3: Merge and save ──
const merged = [...existing, ...newMarkets];
log(`📝 Merging: ${existing.length} + ${newMarkets.length} = ${merged.length} total`);

// Backup old file
fs.copyFileSync(rawPath, rawPath + '.bak');
fs.writeFileSync(rawPath, JSON.stringify(merged, null, 2));
log('✅ raw_btc15m_markets.json updated');

// Rebuild master CSV
const columns = [
  'market_id', 'condition_id', 'slug', 'question',
  'date_str', 'time_start_et', 'time_end_et',
  'slug_timestamp', 'slug_datetime_utc',
  'start_date', 'end_date', 'created_at',
  'active', 'closed', 'accepting_orders',
  'resolved_outcome', 'resolved_label',
  'price_up_final', 'price_down_final',
  'best_bid', 'best_ask',
  'volume', 'volume_num', 'liquidity', 'spread',
  'token_id_up', 'token_id_down',
];

const csvRows = [];
for (const m of merged) {
  let outcomePrices = [], clobTokenIds = [];
  try { outcomePrices = typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : (m.outcomePrices || []); } catch {}
  try { clobTokenIds = typeof m.clobTokenIds === 'string' ? JSON.parse(m.clobTokenIds) : (m.clobTokenIds || []); } catch {}

  const upP = parseFloat(outcomePrices[0]) || null;
  const downP = parseFloat(outcomePrices[1]) || null;
  let resolved = '', label = '';
  if (upP >= 0.95) { resolved = 'UP'; label = 1; }
  else if (downP >= 0.95) { resolved = 'DOWN'; label = 0; }
  else if (upP !== null) { resolved = 'UNRESOLVED'; }

  const q = m.question || '';
  const timeMatch = q.match(/(\w+ \d{1,2}),?\s+(\d{1,2}:\d{2}(?:AM|PM))\s*-\s*(\d{1,2}:\d{2}(?:AM|PM))/i);
  const slug = m.slug || m._event_slug || '';
  const tsMatch = slug.match(/(\d{10,})$/);

  csvRows.push({
    market_id: m.id || '',
    condition_id: m.conditionId || '',
    slug,
    question: q,
    date_str: timeMatch?.[1] || '',
    time_start_et: timeMatch?.[2] || '',
    time_end_et: timeMatch?.[3] || '',
    slug_timestamp: tsMatch ? parseInt(tsMatch[1]) : '',
    slug_datetime_utc: tsMatch ? new Date(parseInt(tsMatch[1]) * 1000).toISOString() : '',
    start_date: m.startDate || m._event_startDate || '',
    end_date: m.endDate || m._event_endDate || '',
    created_at: m.createdAt || '',
    active: m.active ?? '',
    closed: m.closed ?? '',
    accepting_orders: m.acceptingOrders ?? '',
    resolved_outcome: resolved,
    resolved_label: label,
    price_up_final: upP ?? '',
    price_down_final: downP ?? '',
    best_bid: m.bestBid || '',
    best_ask: m.bestAsk || '',
    volume: m.volume || m._event_volume || '',
    volume_num: m.volumeNum || '',
    liquidity: m.liquidity || '',
    spread: m.spread || '',
    token_id_up: clobTokenIds[0] || '',
    token_id_down: clobTokenIds[1] || '',
  });
}

csvRows.sort((a, b) => (a.slug_timestamp || 0) - (b.slug_timestamp || 0));
const header = columns.join(',');
const csvLines = csvRows.map(r => columns.map(c => escapeCSV(r[c])).join(','));
fs.writeFileSync(path.join(DATA_DIR, '01_btc15m_master.csv'), [header, ...csvLines].join('\n'));
log(`✅ Master CSV updated: ${csvRows.length} rows`);

// ML-ready CSV
const mlRows = csvRows.filter(r => r.resolved_outcome === 'UP' || r.resolved_outcome === 'DOWN');
const mlCols = ['slug_timestamp', 'slug_datetime_utc', 'time_start_et', 'time_end_et',
  'resolved_outcome', 'resolved_label', 'price_up_final', 'price_down_final',
  'volume', 'liquidity', 'spread', 'token_id_up', 'token_id_down', 'condition_id'];
fs.writeFileSync(path.join(DATA_DIR, '02_btc15m_ml_ready.csv'),
  [mlCols.join(','), ...mlRows.map(r => mlCols.map(c => escapeCSV(r[c])).join(','))].join('\n'));
log(`✅ ML-ready CSV: ${mlRows.length} resolved rows`);

// Stats
const upWins = mlRows.filter(r => r.resolved_outcome === 'UP').length;
const downWins = mlRows.filter(r => r.resolved_outcome === 'DOWN').length;
fs.writeFileSync(path.join(DATA_DIR, '03_stats.json'), JSON.stringify({
  total: merged.length, resolved: mlRows.length,
  up: upWins, down: downWins,
  up_pct: mlRows.length ? `${((upWins/mlRows.length)*100).toFixed(2)}%` : 'N/A',
  first: csvRows[0]?.slug_datetime_utc, last: csvRows[csvRows.length-1]?.slug_datetime_utc,
}, null, 2));

// ── Step 4: Enrich ONLY new markets with price history ──
log('');
log('═══════════════════════════════════════════════════');
log(`ENRICHING ${newMarkets.length} new markets (price history)`);
log('═══════════════════════════════════════════════════');

const priceHistPath = path.join(DATA_DIR, 'price_history.csv');
const priceColumns = ['market_id', 'condition_id', 'slug', 'question',
  'token_id', 'token_side', 'timestamp_unix', 'timestamp_utc', 'price'];

// Check if header exists
if (!fs.existsSync(priceHistPath)) {
  fs.writeFileSync(priceHistPath, priceColumns.join(',') + '\n');
}

let totalPoints = 0;
let marketsWithData = 0;

for (let i = 0; i < newMarkets.length; i++) {
  const market = newMarkets[i];
  const { upToken, downToken } = parseTokenIds(market);
  const slug = market.slug || market._event_slug || '';
  const conditionId = market.conditionId || '';
  const marketId = market.id || '';
  const question = market.question || '';

  const tokens = [
    { id: upToken, side: 'up' },
    { id: downToken, side: 'down' },
  ].filter(t => t.id);

  let marketPoints = 0;

  for (const token of tokens) {
    const url = `${CLOB_API}/prices-history?market=${token.id}&interval=max&fidelity=1`;
    const data = await fetchJSON(url);

    if (data?.history && Array.isArray(data.history) && data.history.length > 0) {
      const rows = data.history.map(pt => {
        const vals = {
          market_id: marketId, condition_id: conditionId, slug, question,
          token_id: token.id, token_side: token.side,
          timestamp_unix: pt.t, timestamp_utc: new Date(pt.t * 1000).toISOString(), price: pt.p,
        };
        return priceColumns.map(c => escapeCSV(vals[c])).join(',');
      });
      fs.appendFileSync(priceHistPath, rows.join('\n') + '\n');
      marketPoints += data.history.length;
    }

    await sleep(250);
  }

  if (marketPoints > 0) marketsWithData++;
  totalPoints += marketPoints;

  if ((i + 1) % 50 === 0 || i === newMarkets.length - 1) {
    log(`  Enrich: ${i + 1}/${newMarkets.length} | ${totalPoints} price points | ${marketsWithData} with data`);
  }
}

log(`✅ Enrichment done: ${totalPoints} new price points from ${marketsWithData} markets`);

// ── Summary ──
console.log(`
╔════════════════════════════════════════════════════════╗
║           INCREMENTAL UPDATE COMPLETE                  ║
╠════════════════════════════════════════════════════════╣
║  New markets scraped:     ${String(newMarkets.length).padStart(6)}                       ║
║  Total markets now:       ${String(merged.length).padStart(6)}                       ║
║  Resolved (ML-ready):     ${String(mlRows.length).padStart(6)}                       ║
║  New price history pts:   ${String(totalPoints).padStart(6)}                       ║
║  UP / DOWN:        ${String(upWins).padStart(5)} / ${String(downWins).padEnd(5)}                       ║
╚════════════════════════════════════════════════════════╝

Next steps:
  1. node convertScrapedToLookup.mjs  (update lookup JSON)
  2. node generateTrainingData.mjs --days 600 --polymarket-lookup ./polymarket_lookup_v15.json
  3. python trainXGBoost_v3.py --input training_data.csv --output-dir ./output_v15 --tune --tune-trials 150 --holdout-frac 0.125 --recency
`);
