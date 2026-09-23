#!/usr/bin/env node
/**
 * ═══ Generate Training Data — feature pipeline v2 ═══
 *
 * One row per resolved Polymarket BTC 15-minute market: its real resolution
 * as the label, and the 54 base features the LIVE bot would have computed at
 * one instant inside the window.
 *
 * The features are not re-implemented here. Every row goes through
 * src/engines/ml/trainingRow.ts -> featureInputs.ts -> featureExtract.ts,
 * the same code path the bot runs (see featureInputs.ts for the history:
 * until 2026-09-23 this file mirrored the live features by hand, with a 60s
 * look-ahead, a fake price-to-beat and market features from the window open,
 * and the model looked far better offline than it did live).
 *
 * Output: training_data.csv (54 features + slug_timestamp + label) and
 * training_data.meta.json, which records the feature pipeline so the trainer
 * can stamp it into norm_browser.json and the bot can refuse to feed the model
 * any other way.
 *
 * Usage:
 *   node generateTrainingData.mts [--days 180] [--output training_data.csv]
 *                                 [--polymarket-lookup ./polymarket_lookup.json] [--seed 42]
 *
 * Requirements:
 *   - Node.js 25+
 *   - Internet connection (Binance API)
 *   - polymarket_lookup.json with price histories (fetchFreshMarkets.mts)
 */

import fs from 'fs';
import {
  candidateIndices, buildTrainingSnapshot, buildTrainingFeatures,
  type HistoricalCandle, type LookupMarket,
} from '../../src/engines/ml/trainingRow.ts';
import { FI } from '../../src/engines/ml/featureMap.ts';
import { FEATURE_PIPELINE_VERSION } from '../../src/engines/ml/featureInputs.ts';

type CliArgs = Record<string, string | number | boolean | undefined>;


// ═══ CONFIG ═══
const ARGS = parseArgs();
const DAYS = typeof ARGS.days === 'number' ? ARGS.days : Number(ARGS.days ?? 540);
const CANDLE_INTERVAL = '1m';
const OUTPUT_FILE = typeof ARGS.output === 'string' ? ARGS.output : 'training_data.csv';
const LIMIT_PER_REQUEST = 1000;
const POLYMARKET_LOOKUP_PATH = typeof ARGS['polymarket-lookup'] === 'string' ? ARGS['polymarket-lookup'] : './polymarket_lookup.json';

// Proxy support for regions where Binance is blocked (e.g., Indonesia)
// Usage: --proxy http://localhost:3001  (your local proxy)
//   or:  --proxy https://your-proxy.vercel.app
const PROXY_URL = typeof ARGS.proxy === 'string' ? ARGS.proxy : process.env.BINANCE_PROXY || '';

// If proxy provided, route everything through it
// Otherwise use fallback host lists (try multiple until one works)
const BINANCE_API = PROXY_URL || 'https://data-api.binance.vision';

// Fallback hosts for when primary is blocked
const SPOT_FALLBACKS = [
  'https://data-api.binance.vision',
  'https://api1.binance.com',
  'https://api2.binance.com',
  'https://api3.binance.com',
];

// Cache working hosts to avoid retrying failed ones
let workingSpotHost = PROXY_URL || null;
let workingFapiHost = PROXY_URL || null;

// ═══ Seeded PRNG for reproducible training data ═══
// Using mulberry32 — fast 32-bit seeded PRNG (deterministic)
let _prngState = 42;
function seedRng(s) { _prngState = s | 0; }
function seededRandom() {
  _prngState |= 0; _prngState = _prngState + 0x6D2B79F5 | 0;
  let t = Math.imul(_prngState ^ _prngState >>> 15, 1 | _prngState);
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
  return ((t ^ t >>> 14) >>> 0) / 4294967296;
}

// ═══ Polymarket lookup (real data when available) ═══
let polyLookup = null; // { "slug_ts": { label, spread, liquidity, volume, prices: [[secs,price],...] } }

function loadPolymarketLookup(path) {
  try {
    if (!fs.existsSync(path)) {
      console.log(`⚠️  Polymarket lookup not found at ${path} — using simulation fallback`);
      return null;
    }
    const raw = JSON.parse(fs.readFileSync(path, 'utf-8'));
    const count = Object.keys(raw).length;
    console.log(`✅ Polymarket lookup loaded: ${count.toLocaleString()} markets from ${path}`);
    return raw;
  } catch (err) {
    console.log(`⚠️  Failed to load Polymarket lookup: ${err.message} — using simulation fallback`);
    return null;
  }
}

function parseArgs(): CliArgs {
  const args: CliArgs = {};
  for (let i = 2; i < process.argv.length; i++) {
    const raw = process.argv[i];
    if (!raw.startsWith('--')) continue;
    const key = raw.replace('--', '');
    // Flags without value
    if (key === 'tune') { args[key] = true; continue; }
    if (key === 'deploy') { args[key] = true; continue; }
    // Key-value pairs
    if (i + 1 < process.argv.length && !process.argv[i + 1].startsWith('--')) {
      args[key] = process.argv[i + 1];
      i++;
    }
  }
  if (args.days) args.days = parseInt(String(args.days), 10);
  if (args['min-move']) args['min-move'] = parseFloat(String(args['min-move']));
  if (args.seed) args.seed = parseInt(String(args.seed), 10);
  return args;
}

// ═══ BINANCE FETCH (with retry + multi-host fallback) ═══
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchWithRetry(url, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!resp.ok) {
        if (resp.status === 429) {
          console.log(`\n  Rate limited, waiting 10s... (attempt ${attempt}/${retries})`);
          await sleep(10000);
          continue;
        }
        throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
      }
      return await resp.json();
    } catch (err) {
      if (attempt === retries) throw err;
      console.log(`\n  Fetch failed (attempt ${attempt}/${retries}): ${err.message}. Retrying in 3s...`);
      await sleep(3000);
    }
  }
}

/**
 * Fetch with automatic host fallback.
 * Tries cached working host first, then falls back through host list.
 */
async function fetchWithFallback(path, fallbackHosts, hostType) {
  // If proxy, just use proxy URL directly
  if (PROXY_URL) {
    return await fetchWithRetry(`${PROXY_URL}${path}`);
  }

  // Try cached working host first
  const cached = hostType === 'spot' ? workingSpotHost : workingFapiHost;
  if (cached) {
    try {
      const result = await fetchWithRetry(`${cached}${path}`, 2);
      return result;
    } catch {
      // Cached host failed, clear it
      if (hostType === 'spot') workingSpotHost = null;
      else workingFapiHost = null;
    }
  }

  // Try each fallback host
  for (const host of fallbackHosts) {
    if (host === cached) continue; // already tried
    try {
      const result = await fetchWithRetry(`${host}${path}`, 1);
      // Cache this working host
      if (hostType === 'spot') workingSpotHost = host;
      else workingFapiHost = host;
      console.log(`\n  Connected to ${host}`);
      return result;
    } catch {
      // Try next host
    }
  }

  throw new Error(`All ${hostType} API hosts failed for ${path}`);
}

async function fetchKlinesBatch(startTime, endTime) {
  const path = `/api/v3/klines?symbol=BTCUSDT&interval=${CANDLE_INTERVAL}&startTime=${startTime}&endTime=${endTime}&limit=${LIMIT_PER_REQUEST}`;
  const data = await fetchWithFallback(path, SPOT_FALLBACKS, 'spot');

  return data.map(k => ({
    openTime: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
    closeTime: k[6],
    takerBuyVolume: parseFloat(k[9]),
  }));
}

async function fetchAllKlines(days) {
  const endMs = Date.now();
  const startMs = endMs - days * 24 * 60 * 60 * 1000;
  const allCandles = [];

  console.log(`📡 Fetching ${days} days of 1m BTCUSDT klines...`);
  let cursor = startMs;

  while (cursor < endMs) {
    const batch = await fetchKlinesBatch(cursor, endMs);
    if (batch.length === 0) break;

    allCandles.push(...batch);
    cursor = batch[batch.length - 1].openTime + 60000;

    process.stdout.write(`\r  ${allCandles.length} candles fetched...`);

    // Rate limit: Binance allows 1200 req/min
    await sleep(100);
  }

  console.log(`\n✅ Total: ${allCandles.length} candles (${(allCandles.length / 1440).toFixed(1)} days)`);
  return allCandles;
}

// ═══ FEATURE NAMES (CSV header) — the live feature map, in index order ═══
const FEATURE_NAMES: string[] = Object.entries(FI)
  .sort((a, b) => a[1] - b[1])
  .map(([name]) => name);

// ═══ MAIN ═══
async function main() {
  console.log(`\n=== Training Data Generator — feature pipeline v${FEATURE_PIPELINE_VERSION} (shared live builder) ===`);
  console.log(`Days: ${DAYS} | Output: ${OUTPUT_FILE} | Features: ${FEATURE_NAMES.length}`);
  if (PROXY_URL) {
    console.log(`API: ${PROXY_URL} (proxy mode)`);
  } else {
    console.log(`Spot API fallbacks: ${SPOT_FALLBACKS.length} hosts`);
  }
  console.log();

  // Every row is labelled from a real resolution — there is no simulated fallback.
  polyLookup = loadPolymarketLookup(POLYMARKET_LOOKUP_PATH);
  if (!polyLookup) throw new Error(`Polymarket lookup required at ${POLYMARKET_LOOKUP_PATH}`);

  // Seed PRNG for the reproducible per-market pick of the observed instant.
  const seed = typeof ARGS.seed === 'number' && Number.isFinite(ARGS.seed) ? ARGS.seed : 42;
  seedRng(seed);
  console.log(`PRNG seed: ${seed}`);

  // No funding rate: the live bot never has one (loop.ts passes null — Binance
  // FAPI/Bybit are blocked where it has run), so a historical rate here would be
  // information the model can never see when it trades.
  const candles1m: HistoricalCandle[] = await fetchAllKlines(DAYS);
  if (candles1m.length === 0) throw new Error('No candles fetched');

  const firstMs = candles1m[0].openTime;
  const lastMs = candles1m[candles1m.length - 1].openTime;
  const slugs = Object.keys(polyLookup)
    .map(Number)
    .filter(ts => Number.isFinite(ts) && ts * 1000 >= firstMs && ts * 1000 + 15 * 60_000 <= lastMs + 60_000)
    .sort((a, b) => a - b);

  // One observed instant per market, picked at random among the candle closes
  // that can be built honestly. Markets are the independent unit; several rows
  // from one market would only repeat its label.
  console.log(`\n🔧 Building rows for ${slugs.length.toLocaleString()} markets in the candle range...`);
  const rows: Array<{ features: number[]; label: number; slugTs: number }> = [];
  let badLabel = 0;
  let unbuildable = 0;
  for (const slugTs of slugs) {
    const market = polyLookup[String(slugTs)] as LookupMarket;
    if (!market || (market.label !== 0 && market.label !== 1)) { badLabel++; continue; }

    const snaps = [];
    for (const idx of candidateIndices(candles1m, slugTs)) {
      const snap = buildTrainingSnapshot({ candles1m, idx, slugTs, market });
      if (snap) snaps.push(snap);
    }
    if (snaps.length === 0) { unbuildable++; continue; }

    const snap = snaps[Math.floor(seededRandom() * snaps.length)];
    rows.push({ features: buildTrainingFeatures(snap, FEATURE_NAMES.length), label: market.label, slugTs });
    if (rows.length % 1000 === 0) process.stdout.write(`\r  ${rows.length.toLocaleString()} rows...`);
  }

  console.log(`\n✅ Generated ${rows.length.toLocaleString()} rows (one per market, all real Polymarket labels)`);
  console.log(`   Skipped: ${unbuildable} markets with no honest instant (candle gap / no print yet), ${badLabel} without a resolved label`);
  if (rows.length === 0) throw new Error('No rows generated');

  const header = FEATURE_NAMES.join(',') + ',slug_timestamp,label';
  const csvRows = rows.map(r =>
    r.features.map(f => Number.isFinite(f) ? f.toFixed(8) : '0').join(',') + ',' + r.slugTs + ',' + r.label
  );
  fs.writeFileSync(OUTPUT_FILE, [header, ...csvRows].join('\n'));
  console.log(`💾 Saved to ${OUTPUT_FILE} (${(fs.statSync(OUTPUT_FILE).size / 1024 / 1024).toFixed(1)} MB)`);

  // The trainer copies feature_pipeline into norm_browser.json; the bot feeds a
  // model through the shared builder only when the model says it was built that way.
  const metaPath = OUTPUT_FILE.replace(/\.csv$/i, '') + '.meta.json';
  const meta = {
    feature_pipeline: FEATURE_PIPELINE_VERSION,
    generated_at: new Date().toISOString(),
    days: DAYS,
    seed,
    rows: rows.length,
    first_slug_ts: rows[0].slugTs,
    last_slug_ts: rows[rows.length - 1].slugTs,
    feature_names: FEATURE_NAMES,
  };
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  console.log(`💾 Saved ${metaPath} (feature_pipeline=${FEATURE_PIPELINE_VERSION})`);

  // Normalization stats (kept for tooling that still reads them)
  const nf = FEATURE_NAMES.length;
  const n = rows.length;
  const means = new Array(nf).fill(0);
  const stds = new Array(nf).fill(0);
  for (const row of rows) for (let j = 0; j < nf; j++) means[j] += row.features[j];
  for (let j = 0; j < nf; j++) means[j] /= n;
  for (const row of rows) for (let j = 0; j < nf; j++) { const d = row.features[j] - means[j]; stds[j] += d * d; }
  for (let j = 0; j < nf; j++) { stds[j] = Math.sqrt(stds[j] / n); if (stds[j] < 1e-8) stds[j] = 1; }
  fs.writeFileSync('norm_stats.json', JSON.stringify({ means, stds, featureNames: FEATURE_NAMES, numFeatures: nf }, null, 2));
  console.log('💾 Saved norm_stats.json');

  const upCount = rows.filter(r => r.label === 1).length;
  console.log(`\n📊 Label distribution: UP=${upCount} (${(upCount / n * 100).toFixed(1)}%) | DOWN=${n - upCount} (${((n - upCount) / n * 100).toFixed(1)}%)`);
  console.log(`\n✅ Done! Next step: python trainXGBoost_v3.py --input ${OUTPUT_FILE} --tune`);
}

main().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
