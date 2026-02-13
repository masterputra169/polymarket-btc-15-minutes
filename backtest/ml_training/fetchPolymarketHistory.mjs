#!/usr/bin/env node
/**
 * ═══ Fetch Historical Polymarket BTC 15-min Market Data ═══
 *
 * Paginates through the Gamma API to get all resolved BTC 15-min markets.
 * Extracts: slug, endDate, outcomePrices (yes/no), volume, outcome.
 *
 * Output: polymarket_history.csv with one row per resolved market (~96/day)
 *
 * Usage:
 *   node fetchPolymarketHistory.mjs [--output polymarket_history.csv] [--limit 5000]
 *
 * Note: Gamma API returns one price per market (settlement/final price),
 *       not tick-level data. This is still valuable for replacing simulated
 *       Polymarket features in training data.
 */

import fs from 'fs';

// ═══ CONFIG ═══
const ARGS = parseArgs();
const OUTPUT_FILE = ARGS.output || 'polymarket_history.csv';
const MAX_EVENTS = ARGS.limit ? parseInt(ARGS.limit) : 50000;
const SERIES_ID = '10192'; // BTC 15-min Up/Down series
const GAMMA_BASE = 'https://gamma-api.polymarket.com';
const PAGE_SIZE = 100;

function parseArgs() {
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    const raw = process.argv[i];
    if (!raw.startsWith('--')) continue;
    const key = raw.replace('--', '');
    if (i + 1 < process.argv.length && !process.argv[i + 1].startsWith('--')) {
      args[key] = process.argv[i + 1];
      i++;
    }
  }
  return args;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchWithRetry(url, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!resp.ok) {
        if (resp.status === 429) {
          console.log(`  Rate limited, waiting 5s... (attempt ${attempt}/${retries})`);
          await sleep(5000);
          continue;
        }
        throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
      }
      return await resp.json();
    } catch (err) {
      if (attempt === retries) throw err;
      console.log(`  Fetch failed (attempt ${attempt}/${retries}): ${err.message}. Retrying...`);
      await sleep(2000);
    }
  }
}

/**
 * Parse slug to extract market start time.
 * Actual slug formats observed:
 *   "btc-up-or-down-15m-1757724300"  (old: Unix ts in seconds)
 *   "btc-updown-15m-1770962400"      (current: Unix ts in seconds)
 * The trailing number is the market START time as Unix seconds.
 * priceToBeat is NOT in the slug — it's the BTC price at market open.
 */
function parseSlug(slug) {
  if (!slug) return { priceToBeat: null, marketTime: null };

  // Extract trailing Unix timestamp (9-10 digit number at end of slug)
  const match = slug.match(/(\d{9,10})$/);
  if (match) {
    const unixSec = parseInt(match[1]);
    const marketTime = unixSec * 1000;
    if (marketTime > 1700000000000 && marketTime < 2000000000000) {
      return { priceToBeat: null, marketTime };
    }
  }

  return { priceToBeat: null, marketTime: null };
}

async function fetchAllResolvedMarkets() {
  const allMarkets = [];
  let offset = 0;
  let consecutiveEmpty = 0;

  console.log(`Fetching resolved BTC 15-min markets from Gamma API...`);
  console.log(`Series ID: ${SERIES_ID}`);

  while (allMarkets.length < MAX_EVENTS) {
    try {
      // Fetch closed events
      const url = `${GAMMA_BASE}/events?series_id=${SERIES_ID}&closed=true&limit=${PAGE_SIZE}&offset=${offset}`;
      const events = await fetchWithRetry(url);

      if (!Array.isArray(events) || events.length === 0) {
        consecutiveEmpty++;
        if (consecutiveEmpty >= 3) break;
        offset += PAGE_SIZE;
        await sleep(300);
        continue;
      }
      consecutiveEmpty = 0;

      for (const event of events) {
        const markets = Array.isArray(event.markets) ? event.markets : [];
        for (const m of markets) {
          const safeParse = (v) => { try { return JSON.parse(v); } catch { return []; } };
          const outcomes = Array.isArray(m.outcomes) ? m.outcomes
            : typeof m.outcomes === 'string' ? safeParse(m.outcomes) : [];
          const outcomePrices = Array.isArray(m.outcomePrices) ? m.outcomePrices
            : typeof m.outcomePrices === 'string' ? safeParse(m.outcomePrices) : [];

          const upIdx = outcomes.findIndex(o => String(o).toLowerCase() === 'up');
          const downIdx = outcomes.findIndex(o => String(o).toLowerCase() === 'down');

          const upPrice = upIdx >= 0 ? Number(outcomePrices[upIdx]) : null;
          const downPrice = downIdx >= 0 ? Number(outcomePrices[downIdx]) : null;

          // Determine outcome: whichever outcome has price ~1.0 is the winner
          let outcome = null;
          if (upPrice !== null && downPrice !== null) {
            if (upPrice > 0.8) outcome = 'UP';
            else if (downPrice > 0.8) outcome = 'DOWN';
          }

          const { priceToBeat, marketTime } = parseSlug(m.slug);

          allMarkets.push({
            slug: m.slug || '',
            question: m.question || m.title || '',
            endDate: m.endDate || null,
            endDateMs: m.endDate ? new Date(m.endDate).getTime() : null,
            marketTime,
            priceToBeat,
            upPrice: Number.isFinite(upPrice) ? upPrice : null,
            downPrice: Number.isFinite(downPrice) ? downPrice : null,
            volume: Number(m.volume) || 0,
            liquidity: Number(m.liquidityNum || m.liquidity) || 0,
            outcome,
          });
        }
      }

      offset += PAGE_SIZE;
      process.stdout.write(`\r  ${allMarkets.length} markets fetched (offset ${offset})...`);

      // Rate limit
      await sleep(300);

    } catch (err) {
      console.log(`\n  Error at offset ${offset}: ${err.message}`);
      consecutiveEmpty++;
      if (consecutiveEmpty >= 3) break;
      offset += PAGE_SIZE;
      await sleep(1000);
    }
  }

  console.log(`\n  Total: ${allMarkets.length} resolved markets`);
  return allMarkets;
}

async function main() {
  console.log(`\n=== Polymarket BTC 15-min Historical Data Fetcher ===`);
  console.log(`Output: ${OUTPUT_FILE}\n`);

  const markets = await fetchAllResolvedMarkets();

  if (markets.length === 0) {
    console.log('No markets found. Check series ID or network connectivity.');
    process.exit(1);
  }

  // Sort by endDate
  markets.sort((a, b) => (a.endDateMs || 0) - (b.endDateMs || 0));

  // Stats
  const withOutcome = markets.filter(m => m.outcome !== null);
  const upCount = withOutcome.filter(m => m.outcome === 'UP').length;
  const withPtb = markets.filter(m => m.priceToBeat !== null);

  console.log(`\nStats:`);
  console.log(`  Total markets: ${markets.length}`);
  console.log(`  With outcome:  ${withOutcome.length} (UP: ${upCount}, DOWN: ${withOutcome.length - upCount})`);
  console.log(`  With PTB:      ${withPtb.length}`);
  if (markets.length > 0) {
    const first = markets[0].endDate || 'unknown';
    const last = markets[markets.length - 1].endDate || 'unknown';
    console.log(`  Date range:    ${first} to ${last}`);
  }

  // Write CSV
  const header = [
    'slug', 'question', 'end_date', 'end_date_ms', 'market_time_ms',
    'price_to_beat', 'up_price', 'down_price',
    'volume', 'liquidity', 'outcome',
  ].join(',');

  const csvEscape = (s) => {
    if (typeof s !== 'string') return s ?? '';
    return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const csvRows = markets.map(m => [
    csvEscape(m.slug),
    csvEscape(m.question),
    m.endDate || '',
    m.endDateMs || '',
    m.marketTime || '',
    m.priceToBeat ?? '',
    m.upPrice ?? '',
    m.downPrice ?? '',
    m.volume,
    m.liquidity,
    m.outcome || '',
  ].join(','));

  fs.writeFileSync(OUTPUT_FILE, [header, ...csvRows].join('\n'));
  const sizeMb = (fs.statSync(OUTPUT_FILE).size / 1024 / 1024).toFixed(2);
  console.log(`\nSaved to ${OUTPUT_FILE} (${sizeMb} MB, ${markets.length} rows)`);

  console.log(`\nDone! Use this data to replace simulated Polymarket features in training.`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
