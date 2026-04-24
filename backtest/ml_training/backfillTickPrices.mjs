#!/usr/bin/env node
/**
 * Backfill CLOB tick prices for existing polymarket_lookup.json markets with empty prices: [].
 *
 * Background: `quickUpdateLookup.py` was used for 2+ months to add markets with LABELS ONLY
 * (no tick prices) — explicit docstring says "Labels only — no tick prices (fast)".
 * Earlier `fetchFreshMarkets.mjs` also used fidelity=60 which returns 0 entries for
 * sparse 15-min markets. Result: lookup has ~17K markets, only ~3K usable for training.
 *
 * This script:
 *   1. Loads lookup, finds all markets with prices: [].
 *   2. Queries Gamma API in paginated chunks to build slug -> (upTokenId, startSec) map.
 *   3. For each market missing prices, fetches CLOB ticks with fidelity=1.
 *   4. Writes back to lookup with checkpointing every 500 markets.
 *
 * Usage:
 *   node backfillTickPrices.mjs [--lookup polymarket_lookup.json]
 *                               [--concurrency 5]
 *                               [--limit 0]           (max markets to process, 0 = all)
 *                               [--checkpoint 500]    (save lookup every N markets)
 *                               [--dry-run]           (don't write, just report)
 *
 * Rate limit: CLOB/Gamma tolerate ~5-10 parallel requests. Default concurrency=5.
 * ETA: ~15-25 min for 15K markets at concurrency=5.
 */

import fs from 'fs';

const ARGS = parseArgs();
const LOOKUP_PATH = ARGS.lookup || './polymarket_lookup.json';
const CONCURRENCY = parseInt(ARGS.concurrency || '5');
const LIMIT = parseInt(ARGS.limit || '0');
const CHECKPOINT_N = parseInt(ARGS.checkpoint || '500');
const DRY_RUN = 'dry-run' in ARGS;
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
    } else {
      args[key] = true;
    }
  }
  return args;
}

async function httpGet(url, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'backfill-tick-prices/1.0' },
      });
      clearTimeout(timeout);
      if (!res.ok) {
        if (res.status === 429 || res.status >= 500) {
          await sleep(1000 * (attempt + 1));
          continue;
        }
        return null;
      }
      return await res.json();
    } catch (err) {
      if (attempt === retries - 1) return null;
      await sleep(1000 * (attempt + 1));
    }
  }
  return null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Fetch all Gamma events for the BTC 15-min series, paginated.
 * Returns: Map<timestamp, { slug, upTokenId }>
 */
async function buildGammaMap(targetTimestamps) {
  const targetSet = new Set(targetTimestamps.map(String));
  const map = new Map();

  // Cover date range of targets
  let minTs = Infinity, maxTs = 0;
  for (const ts of targetTimestamps) {
    minTs = Math.min(minTs, ts);
    maxTs = Math.max(maxTs, ts);
  }
  const startDate = new Date(minTs * 1000);
  const endDate = new Date(maxTs * 1000);
  // Pad 2 days either side to be safe
  startDate.setUTCDate(startDate.getUTCDate() - 2);
  endDate.setUTCDate(endDate.getUTCDate() + 2);

  const startStr = startDate.toISOString().split('T')[0];
  const endStr = endDate.toISOString().split('T')[0];

  console.log(`\n[Gamma] Building tokenId map for ${targetTimestamps.length} targets...`);
  console.log(`[Gamma] Date range: ${startStr} to ${endStr}`);

  let offset = 0;
  const PAGE_SIZE = 500;
  let totalEvents = 0;

  while (true) {
    const url = `${GAMMA_BASE}/events?series_id=${SERIES_ID}` +
      `&end_date_min=${startStr}&end_date_max=${endStr}` +
      `&limit=${PAGE_SIZE}&offset=${offset}&order=startDate&ascending=true`;
    const events = await httpGet(url);
    if (!events || events.length === 0) break;

    for (const e of events) {
      const slugMatch = /(\d{9,10})$/.exec(e.slug || '');
      if (!slugMatch) continue;
      const ts = slugMatch[1];
      if (!targetSet.has(ts)) continue; // only care about target markets

      const market = e.markets?.[0];
      if (!market) continue;
      let tokenIds;
      try {
        tokenIds = typeof market.clobTokenIds === 'string'
          ? JSON.parse(market.clobTokenIds)
          : (Array.isArray(market.clobTokenIds) ? market.clobTokenIds : []);
      } catch { tokenIds = []; }
      if (tokenIds.length < 1) continue;

      // Outcome ordering: outcomes[0]=Up, outcomes[1]=Down (standard)
      // upTokenId = tokenIds[0] (per fetchFreshMarkets.mjs convention)
      map.set(ts, {
        slug: e.slug,
        upTokenId: tokenIds[0],
        startSec: parseInt(ts, 10),
      });
    }

    totalEvents += events.length;
    process.stdout.write(`\r  Gamma page offset=${offset} | events scanned=${totalEvents} | matched=${map.size}`);

    if (events.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
    await sleep(100); // gentle pagination
  }
  console.log('');
  console.log(`[Gamma] Matched ${map.size}/${targetTimestamps.length} target markets`);
  return map;
}

async function fetchTickPrices(tokenId, startSec) {
  if (!tokenId) return null;
  const url = `${CLOB_BASE}/prices-history?market=${tokenId}&startTs=${startSec}&endTs=${startSec + 900}&fidelity=1`;
  const data = await httpGet(url);
  if (!data || !Array.isArray(data.history)) return null;
  return data.history
    .map(p => [parseInt(p.t) - startSec, Math.round(parseFloat(p.p) * 1000000) / 1000000])
    .filter(([secs]) => secs >= 0 && secs <= 900);
}

/**
 * Concurrent map with bounded parallelism.
 */
async function parallelMap(items, concurrency, fn, onProgress) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx], idx);
      if (onProgress) onProgress(idx + 1);
    }
  });
  await Promise.all(workers);
  return results;
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Backfill Tick Prices for polymarket_lookup.json');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`Lookup:       ${LOOKUP_PATH}`);
  console.log(`Concurrency:  ${CONCURRENCY}`);
  console.log(`Checkpoint:   every ${CHECKPOINT_N} markets`);
  console.log(`Limit:        ${LIMIT || 'all'}`);
  console.log(`Mode:         ${DRY_RUN ? 'DRY RUN (no write)' : 'WRITE'}`);
  console.log('');

  // 1. Load lookup
  if (!fs.existsSync(LOOKUP_PATH)) {
    console.error(`ERROR: lookup not found: ${LOOKUP_PATH}`);
    process.exit(1);
  }
  const lookup = JSON.parse(fs.readFileSync(LOOKUP_PATH, 'utf-8'));
  const totalMarkets = Object.keys(lookup).length;

  // 2. Find markets needing backfill
  const needBackfill = [];
  for (const [ts, v] of Object.entries(lookup)) {
    if (!v.prices || v.prices.length === 0) needBackfill.push(ts);
  }
  needBackfill.sort((a, b) => parseInt(a) - parseInt(b));
  console.log(`Total markets in lookup:  ${totalMarkets}`);
  console.log(`Markets with prices:      ${totalMarkets - needBackfill.length}`);
  console.log(`Markets needing backfill: ${needBackfill.length}`);

  if (needBackfill.length === 0) {
    console.log('\n✅ Nothing to do.');
    return;
  }

  const targets = LIMIT > 0 ? needBackfill.slice(0, LIMIT) : needBackfill;
  console.log(`Processing:               ${targets.length} markets`);

  // 3. Build Gamma -> tokenId map
  const t0 = Date.now();
  const gammaMap = await buildGammaMap(targets.map(t => parseInt(t, 10)));
  const t1 = Date.now();
  console.log(`[Gamma] Duration: ${((t1 - t0) / 1000).toFixed(1)}s`);

  // 4. Fetch CLOB ticks in parallel
  console.log(`\n[CLOB] Fetching ticks (concurrency=${CONCURRENCY})...`);
  let withTicks = 0, emptyTicks = 0, missing = 0, lastPrintMs = 0;
  const t2 = Date.now();

  const results = await parallelMap(targets, CONCURRENCY, async (ts) => {
    const info = gammaMap.get(ts);
    if (!info) return { ts, status: 'missing_gamma', ticks: null };
    const ticks = await fetchTickPrices(info.upTokenId, info.startSec);
    if (ticks == null) return { ts, status: 'fetch_error', ticks: null };
    return { ts, status: 'ok', ticks };
  }, (done) => {
    const now = Date.now();
    if (now - lastPrintMs < 1000 && done !== targets.length) return;
    lastPrintMs = now;
    const rate = done / Math.max(1, (now - t2) / 1000);
    const eta = rate > 0 ? ((targets.length - done) / rate) : 0;
    process.stdout.write(`\r  ${done}/${targets.length} | ${rate.toFixed(1)}/s | ETA ${Math.round(eta)}s      `);

    // Checkpoint save
    if (!DRY_RUN && done % CHECKPOINT_N === 0) {
      try {
        fs.writeFileSync(LOOKUP_PATH + '.tmp', JSON.stringify(lookup));
        fs.renameSync(LOOKUP_PATH + '.tmp', LOOKUP_PATH);
      } catch (err) {
        console.error(`\n  checkpoint write failed: ${err.message}`);
      }
    }
  });
  console.log('');

  // 5. Apply results to lookup + count stats
  for (const r of results) {
    if (r.status === 'ok' && r.ticks) {
      if (r.ticks.length > 0) withTicks++;
      else emptyTicks++;
      if (!DRY_RUN) lookup[r.ts].prices = r.ticks;
    } else {
      missing++;
    }
  }

  const t3 = Date.now();
  console.log(`[CLOB] Duration: ${((t3 - t2) / 1000).toFixed(1)}s`);

  // 6. Final save
  if (!DRY_RUN) {
    fs.writeFileSync(LOOKUP_PATH + '.tmp', JSON.stringify(lookup));
    fs.renameSync(LOOKUP_PATH + '.tmp', LOOKUP_PATH);
  }

  // 7. Report
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  Backfill Complete');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`Processed:        ${targets.length} markets`);
  console.log(`With ticks:       ${withTicks} (${(100 * withTicks / targets.length).toFixed(1)}%)`);
  console.log(`Zero ticks:       ${emptyTicks} (empty but valid response)`);
  console.log(`Missing/errored:  ${missing}`);
  console.log(`Total with px:    ${Object.values(lookup).filter(v => v.prices?.length > 0).length} / ${totalMarkets}`);
  console.log(`Total duration:   ${((t3 - t0) / 1000).toFixed(1)}s`);
  if (DRY_RUN) console.log('  (DRY RUN — no changes written)');
  console.log('═══════════════════════════════════════════════════════════');
}

main().catch(err => {
  console.error('Fatal:', err.stack || err.message);
  process.exit(1);
});
