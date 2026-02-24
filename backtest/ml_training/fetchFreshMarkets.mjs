#!/usr/bin/env node
/**
 * Fetch fresh Polymarket BTC 15m markets (last N days) + CLOB tick prices
 * and merge into polymarket_lookup.json.
 *
 * Usage: node fetchFreshMarkets.mjs [--days 7] [--lookup polymarket_lookup.json] [--no-prices]
 */

import fs from 'fs';

const ARGS = parseArgs();
const DAYS = ARGS.days ? parseInt(ARGS.days) : 7;
const LOOKUP_PATH = ARGS.lookup || './polymarket_lookup.json';
const NO_PRICES = 'no-prices' in ARGS;
const GAMMA_BASE = 'https://gamma-api.polymarket.com';
const CLOB_BASE = 'https://clob.polymarket.com';
const SERIES_ID = '10192';

function parseArgs() {
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    if (!process.argv[i].startsWith('--')) continue;
    const key = process.argv[i].replace('--', '');
    if (i + 1 < process.argv.length && !process.argv[i + 1].startsWith('--')) {
      args[key] = process.argv[i + 1]; i++;
    }
  }
  return args;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function httpGet(url, retries = 3) {
  for (let a = 1; a <= retries; a++) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (resp.status === 429) { await sleep(5000); continue; }
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.json();
    } catch (err) {
      if (a === retries) return null;
      await sleep(1500 * a);
    }
  }
  return null;
}

async function fetchFreshEvents(cutoffDate) {
  const markets = [];
  let offset = 0;
  const PAGE = 100;

  console.log(`Fetching events since ${cutoffDate}...`);
  while (true) {
    const url = `${GAMMA_BASE}/events?series_id=${SERIES_ID}&closed=true&start_date_min=${cutoffDate}&limit=${PAGE}&offset=${offset}`;
    const events = await httpGet(url);
    if (!Array.isArray(events) || events.length === 0) break;

    for (const ev of events) {
      const evMarkets = Array.isArray(ev.markets) ? ev.markets : [];
      for (const m of evMarkets) {
        // Parse resolution
        const safeParse = (v) => { try { return JSON.parse(v); } catch { return []; } };
        const outcomes = Array.isArray(m.outcomes) ? m.outcomes : safeParse(m.outcomes || '[]');
        const prices = Array.isArray(m.outcomePrices) ? m.outcomePrices : safeParse(m.outcomePrices || '[]');
        const upIdx = outcomes.findIndex(o => String(o).toLowerCase() === 'up');
        const downIdx = outcomes.findIndex(o => String(o).toLowerCase() === 'down');
        const upPrice = upIdx >= 0 ? Number(prices[upIdx]) : null;
        const downPrice = downIdx >= 0 ? Number(prices[downIdx]) : null;

        let outcome = null;
        if (upPrice !== null && downPrice !== null) {
          if (upPrice > 0.8) outcome = 'UP';
          else if (downPrice > 0.8) outcome = 'DOWN';
        }
        if (!outcome) continue;  // Skip unresolved

        // Extract slug_ts
        const slug = m.slug || '';
        const match = slug.match(/(\d{9,10})$/);
        if (!match) continue;
        const slugTs = parseInt(match[1]);
        if (slugTs < 1700000000) continue;

        // Get YES/UP token ID
        const clobTokenIds = m.clobTokenIds || [];
        let upTokenId = null;
        for (let i = 0; i < outcomes.length; i++) {
          if (String(outcomes[i]).toLowerCase() === 'up' && i < clobTokenIds.length) {
            upTokenId = clobTokenIds[i];
            break;
          }
        }
        if (!upTokenId && clobTokenIds.length > 0) upTokenId = clobTokenIds[0];

        markets.push({
          slug,
          slugTs: String(slugTs),
          label: outcome === 'UP' ? 1 : 0,
          volume: Number(m.volume) || 0,
          liquidity: Number(m.liquidityNum || m.liquidity) || 0,
          upTokenId,
          startSec: slugTs,
        });
      }
    }

    process.stdout.write(`\r  ${markets.length} markets... (offset ${offset})`);
    if (events.length < PAGE) break;
    offset += PAGE;
    await sleep(300);
  }
  console.log(`\n  ${markets.length} resolved markets found`);
  return markets;
}

async function fetchTickPrices(tokenId, startSec, endSec) {
  if (!tokenId) return [];
  const url = `${CLOB_BASE}/prices-history?market=${tokenId}&startTs=${startSec}&endTs=${endSec}&fidelity=60`;
  const data = await httpGet(url);
  if (!data || !data.history) return [];
  return data.history
    .map(p => [parseInt(p.t) - startSec, Math.round(parseFloat(p.p) * 1000000) / 1000000])
    .filter(([secs]) => secs >= 0 && secs <= 900);
}

async function main() {
  const cutoffDate = new Date(Date.now() - DAYS * 86400000).toISOString().split('T')[0];
  console.log(`\n=== Fetch Fresh Polymarket Markets ===`);
  console.log(`Period:  last ${DAYS} days (since ${cutoffDate})`);
  console.log(`Lookup:  ${LOOKUP_PATH}`);

  // Load existing lookup
  let lookup = {};
  if (fs.existsSync(LOOKUP_PATH)) {
    console.log(`\nLoading existing lookup...`);
    lookup = JSON.parse(fs.readFileSync(LOOKUP_PATH, 'utf-8'));
    console.log(`  ${Object.keys(lookup).length.toLocaleString()} existing markets`);
  }

  // Fetch new events
  const freshMarkets = await fetchFreshEvents(cutoffDate);
  const newMarkets = freshMarkets.filter(m => !(m.slugTs in lookup));
  console.log(`  ${newMarkets.length} new (not in lookup)`);

  if (newMarkets.length === 0) {
    console.log('\nNothing to add. Lookup is up to date!');
    return;
  }

  // Fetch tick prices for each new market
  let withPrices = 0, noPrices = 0;

  if (NO_PRICES) {
    console.log(`\nSkipping CLOB tick prices (--no-prices). Adding ${newMarkets.length} markets with labels only...`);
    for (const m of newMarkets) {
      lookup[m.slugTs] = { label: m.label, spread: 0.02, liquidity: m.liquidity, volume: m.volume, prices: [] };
    }
  } else {
    console.log(`\nFetching CLOB tick prices for ${newMarkets.length} markets...`);
    for (let i = 0; i < newMarkets.length; i++) {
      const m = newMarkets[i];
      const tickPrices = await fetchTickPrices(m.upTokenId, m.startSec, m.startSec + 900);
      if (tickPrices.length > 0) withPrices++;
      else noPrices++;

      lookup[m.slugTs] = { label: m.label, spread: 0.02, liquidity: m.liquidity, volume: m.volume, prices: tickPrices };

      if ((i + 1) % 20 === 0 || i === newMarkets.length - 1) {
        process.stdout.write(`\r  ${i+1}/${newMarkets.length} — ${withPrices} with prices, ${noPrices} without`);
      }
      await sleep(200);
    }
    console.log('');
  }

  // Save updated lookup
  console.log(`\nSaving updated lookup...`);
  fs.writeFileSync(LOOKUP_PATH, JSON.stringify(lookup, null, 0));
  const sizeMb = (fs.statSync(LOOKUP_PATH).size / 1024 / 1024).toFixed(1);

  const total = Object.keys(lookup).length;
  const upCount = Object.values(lookup).filter(v => v.label === 1).length;
  const withTickPrices = Object.values(lookup).filter(v => v.prices && v.prices.length > 0).length;

  console.log(`
============================================
  polymarket_lookup.json Updated
============================================
  Total markets:  ${total.toLocaleString()}
  Added:          ${newMarkets.length}
  With tick px:   ${withPrices}/${newMarkets.length} new (${withTickPrices} total)
  UP labels:      ${upCount.toLocaleString()} (${(upCount/total*100).toFixed(1)}%)
  DN labels:      ${(total-upCount).toLocaleString()} (${((total-upCount)/total*100).toFixed(1)}%)
  File size:      ${sizeMb} MB

Next:
  node generateTrainingData.mjs --days 540 --polymarket-lookup ./polymarket_lookup.json
============================================
`);
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
