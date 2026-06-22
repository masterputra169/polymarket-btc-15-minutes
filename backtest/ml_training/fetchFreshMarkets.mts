#!/usr/bin/env node
/**
 * Fetch fresh Polymarket BTC 15m markets (last N days) + CLOB tick prices
 * and merge into polymarket_lookup.json.
 *
 * Usage: node fetchFreshMarkets.mts [--days 7] [--lookup polymarket_lookup.json] [--no-prices]
 *        [--series-ids 10192] [--search "Bitcoin Up or Down,BTC Up or Down"]
 *        [--slug-prefixes "btc-updown-15m,btc-up-or-down-15m"] [--http-timeout-ms 20000]
 */

import fs from 'fs';

type CliArgs = Record<string, string | boolean | undefined>;
type LookupEntry = Record<string, any> & { label?: number; prices?: unknown[] };
type FreshMarket = {
  slug: string;
  slugTs: string;
  label: number;
  volume: number;
  liquidity: number;
  upTokenId: string | null;
  startSec: number;
};
type PriceHistoryResponse = { history?: Array<{ t: string | number; p: string | number }> };

const ARGS = parseArgs();
const DAYS = ARGS.days ? parseInt(String(ARGS.days), 10) : 7;
const LOOKUP_PATH = typeof ARGS.lookup === 'string' ? ARGS.lookup : './polymarket_lookup.json';
const NO_PRICES = 'no-prices' in ARGS;
const GAMMA_BASE = 'https://gamma-api.polymarket.com';
const CLOB_BASE = 'https://clob.polymarket.com';
const SERIES_ID = '10192';
const SERIES_IDS = String(ARGS['series-ids'] ?? process.env.POLYMARKET_SERIES_IDS ?? SERIES_ID)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const SEARCH_TERMS = String(
  ARGS.search ?? process.env.POLYMARKET_BTC_SEARCH_TERMS ?? 'Bitcoin Up or Down,BTC Up or Down,btc-updown-15m'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const SLUG_PREFIXES = String(
  ARGS['slug-prefixes'] ?? process.env.POLYMARKET_BTC_SLUG_PREFIXES ?? 'btc-updown-15m,btc-up-or-down-15m'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const MAX_ALL_EVENT_PAGES = ARGS['max-all-pages'] ? parseInt(String(ARGS['max-all-pages']), 10) : 20;
const MAX_SLUG_SWEEP = ARGS['max-slug-sweep'] ? parseInt(String(ARGS['max-slug-sweep']), 10) : 5000;
const SLUG_SWEEP_DELAY_MS = ARGS['slug-sweep-delay-ms'] ? parseInt(String(ARGS['slug-sweep-delay-ms']), 10) : 80;
const HTTP_TIMEOUT_MS_RAW = ARGS['http-timeout-ms']
  ? parseInt(String(ARGS['http-timeout-ms']), 10)
  : parseInt(process.env.POLYMARKET_HTTP_TIMEOUT_MS || '20000', 10);
const HTTP_TIMEOUT_MS = Number.isFinite(HTTP_TIMEOUT_MS_RAW) && HTTP_TIMEOUT_MS_RAW > 0
  ? HTTP_TIMEOUT_MS_RAW
  : 20_000;
const NO_SLUG_SWEEP = 'no-slug-sweep' in ARGS;

function parseArgs(): CliArgs {
  const args: CliArgs = {};
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

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

type HttpResult<T> = { data: T | null; error: string | null };

async function httpGetResult<T = unknown>(url, retries = 3, timeoutMs = HTTP_TIMEOUT_MS): Promise<HttpResult<T>> {
  let lastError = 'unknown error';
  for (let a = 1; a <= retries; a++) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (resp.status === 429) { await sleep(5000); continue; }
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return { data: await resp.json() as T, error: null };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (a === retries) return { data: null, error: lastError };
      await sleep(1500 * a);
    }
  }
  return { data: null, error: lastError };
}

async function httpGet<T = unknown>(url, retries = 3): Promise<T | null> {
  const result = await httpGetResult<T>(url, retries);
  return result.data;
}

function safeParseArray(value: unknown): any[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeEvents(payload: unknown): any[] {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, any>;
    if (Array.isArray(obj.events)) return obj.events;
    if (obj.slug || obj.id || obj.ticker) return [obj];
  }
  return [];
}

function extractSlugTs(slug: unknown): string | null {
  const match = String(slug ?? '').match(/(\d{9,10})$/);
  if (!match) return null;
  const ts = Number(match[1]);
  return ts > 1700000000 && ts < 2000000000 ? String(ts) : null;
}

function isBtc15mSlug(slug: unknown): boolean {
  return /^btc-(?:updown|up-or-down)-15m-\d{9,10}$/i.test(String(slug ?? ''));
}

function isBtc15mMarket(ev: Record<string, any>, m: Record<string, any>): boolean {
  const slug = String(m.slug || ev.slug || '');
  if (isBtc15mSlug(slug)) return true;

  const text = [
    m.question, m.title, m.description,
    ev.title, ev.slug, ev.ticker, ev.description,
  ].filter(Boolean).join(' ').toLowerCase();
  const hasBitcoin = text.includes('bitcoin') || /\bbtc\b/.test(text);
  const hasUpDown = text.includes('up or down') ||
    text.includes('updown') ||
    /\bup\b.*\bdown\b/.test(text) ||
    /\bdown\b.*\bup\b/.test(text);
  const has15m = text.includes('15m') ||
    text.includes('15 min') ||
    text.includes('15-minute') ||
    text.includes('15 minute');
  return hasBitcoin && hasUpDown && has15m;
}

function extractFreshMarket(ev: Record<string, any>, m: Record<string, any>): FreshMarket | null {
  if (!isBtc15mMarket(ev, m)) return null;

  const slug = String(m.slug || ev.slug || '');
  const slugTs = extractSlugTs(slug);
  if (!slugTs) return null;

  const outcomes = safeParseArray(m.outcomes);
  const prices = safeParseArray(m.outcomePrices);
  const upIdx = outcomes.findIndex(o => String(o).toLowerCase() === 'up');
  const downIdx = outcomes.findIndex(o => String(o).toLowerCase() === 'down');
  const upPrice = upIdx >= 0 ? Number(prices[upIdx]) : null;
  const downPrice = downIdx >= 0 ? Number(prices[downIdx]) : null;

  let outcome: 'UP' | 'DOWN' | null = null;
  // Audit fix (May 2026): tighten resolution threshold to >=0.95 to match
  // incremental_scrape_v15.mjs. Previous 0.8 admitted ambiguous resolutions.
  if (upPrice !== null && downPrice !== null) {
    if (upPrice >= 0.95) outcome = 'UP';
    else if (downPrice >= 0.95) outcome = 'DOWN';
  }
  if (!outcome) return null;

  const clobTokenIds = safeParseArray(m.clobTokenIds);
  let upTokenId: string | null = null;
  for (let i = 0; i < outcomes.length; i++) {
    if (String(outcomes[i]).toLowerCase() === 'up' && i < clobTokenIds.length) {
      upTokenId = String(clobTokenIds[i]);
      break;
    }
  }
  if (!upTokenId && clobTokenIds.length > 0) upTokenId = String(clobTokenIds[0]);

  return {
    slug,
    slugTs,
    label: outcome === 'UP' ? 1 : 0,
    volume: Number(m.volume) || Number(ev.volume) || 0,
    liquidity: Number(m.liquidityNum || m.liquidity || ev.liquidityNum || ev.liquidity) || 0,
    upTokenId,
    startSec: Number(slugTs),
  };
}

function addMarketsFromEvents(
  events: any[],
  marketMap: Map<string, FreshMarket>,
  source: string,
  verbose = true,
): number {
  let inspected = 0;
  let matched = 0;
  let added = 0;

  for (const ev of events) {
    const eventObj = ev as Record<string, any>;
    const evMarkets = Array.isArray(eventObj.markets) && eventObj.markets.length > 0
      ? eventObj.markets
      : [eventObj];

    for (const rawMarket of evMarkets) {
      const marketObj = rawMarket as Record<string, any>;
      inspected++;
      if (!isBtc15mMarket(eventObj, marketObj)) continue;
      matched++;

      const fresh = extractFreshMarket(eventObj, marketObj);
      if (!fresh) continue;

      const previous = marketMap.get(fresh.slugTs);
      if (!previous || fresh.volume > previous.volume || (!previous.upTokenId && fresh.upTokenId)) {
        marketMap.set(fresh.slugTs, fresh);
      }
      added++;
    }
  }

  if (verbose) {
    console.log(`  ${source}: ${added} resolved (${matched} matched / ${inspected} inspected)`);
  }
  return added;
}

type PagedEventsResult = {
  events: any[];
  successfulPages: number;
  failed: boolean;
  error: string | null;
};

async function fetchPagedEvents(
  source: string,
  buildUrl: (offset: number, limit: number) => string,
  maxPages = 100,
): Promise<PagedEventsResult> {
  const PAGE = 100;
  const events: any[] = [];
  let successfulPages = 0;
  let lastError: string | null = null;

  for (let page = 0; page < maxPages; page++) {
    const offset = page * PAGE;
    const result = await httpGetResult<unknown>(buildUrl(offset, PAGE));
    if (result.data === null) {
      lastError = result.error || 'empty response';
      console.warn(`  ${source}: page ${page + 1} failed (${lastError})`);
      break;
    }

    const pageEvents = normalizeEvents(result.data);
    successfulPages++;
    events.push(...pageEvents);
    if (pageEvents.length < PAGE) break;
    await sleep(300);
  }

  return {
    events,
    successfulPages,
    failed: successfulPages === 0 && Boolean(lastError),
    error: lastError,
  };
}

async function fetchSlugSweep(
  startSec: number,
  endSec: number,
  marketMap: Map<string, FreshMarket>,
): Promise<{ successfulRequests: number; failed: boolean; error: string | null }> {
  if (NO_SLUG_SWEEP || SLUG_PREFIXES.length === 0 || startSec > endSec) {
    return { successfulRequests: 0, failed: false, error: null };
  }

  let successfulRequests = 0;
  let consecutiveFailures = 0;
  let added = 0;
  let slots = 0;
  let lastError: string | null = null;
  let ts = Math.ceil(startSec / 900) * 900;

  console.log(`  slug sweep: ${SLUG_PREFIXES.join(', ')} from ${new Date(ts * 1000).toISOString()}...`);
  while (ts <= endSec && slots < MAX_SLUG_SWEEP) {
    for (const prefix of SLUG_PREFIXES) {
      const slug = `${prefix}-${ts}`;
      const url = `${GAMMA_BASE}/events?slug=${encodeURIComponent(slug)}&closed=true&limit=10`;
      const result = await httpGetResult<unknown>(url, 1, 8000);

      if (result.data === null) {
        consecutiveFailures++;
        lastError = result.error || 'empty response';
        if (consecutiveFailures >= 3) {
          console.warn(`  slug sweep: aborted after ${consecutiveFailures} consecutive failures (${lastError})`);
          return { successfulRequests, failed: successfulRequests === 0, error: lastError };
        }
        continue;
      }

      successfulRequests++;
      consecutiveFailures = 0;
      added += addMarketsFromEvents(normalizeEvents(result.data), marketMap, 'slug sweep', false);
      await sleep(SLUG_SWEEP_DELAY_MS);
    }
    slots++;
    ts += 900;
  }

  console.log(`  slug sweep: ${added} resolved across ${successfulRequests} successful requests`);
  return { successfulRequests, failed: successfulRequests === 0 && Boolean(lastError), error: lastError };
}

async function fetchFreshEvents(cutoffDate: string, lookup: Record<string, LookupEntry>) {
  const marketMap = new Map<string, FreshMarket>();
  let successfulStrategies = 0;
  const failures: string[] = [];

  console.log(`Fetching events since ${cutoffDate}...`);

  for (const seriesId of SERIES_IDS) {
    const result = await fetchPagedEvents(
      `series_id=${seriesId}`,
      (offset, limit) => `${GAMMA_BASE}/events?series_id=${encodeURIComponent(seriesId)}&closed=true&start_date_min=${cutoffDate}&limit=${limit}&offset=${offset}`,
    );
    if (result.successfulPages > 0) successfulStrategies++;
    if (result.failed) failures.push(`series_id=${seriesId}: ${result.error}`);
    addMarketsFromEvents(result.events, marketMap, `series_id=${seriesId}`);
  }

  for (const term of SEARCH_TERMS) {
    const encoded = encodeURIComponent(term);
    const result = await fetchPagedEvents(
      `search=${term}`,
      (offset, limit) => `${GAMMA_BASE}/events?search=${encoded}&closed=true&start_date_min=${cutoffDate}&limit=${limit}&offset=${offset}`,
    );
    if (result.successfulPages > 0) successfulStrategies++;
    if (result.failed) failures.push(`search=${term}: ${result.error}`);
    addMarketsFromEvents(result.events, marketMap, `search=${term}`);
  }

  const recent = await fetchPagedEvents(
    'recent closed events',
    (offset, limit) => `${GAMMA_BASE}/events?closed=true&start_date_min=${cutoffDate}&order=endDate&ascending=false&limit=${limit}&offset=${offset}`,
    MAX_ALL_EVENT_PAGES,
  );
  if (recent.successfulPages > 0) successfulStrategies++;
  if (recent.failed) failures.push(`recent closed events: ${recent.error}`);
  addMarketsFromEvents(recent.events, marketMap, 'recent closed events');

  if (marketMap.size === 0 && !NO_SLUG_SWEEP) {
    const lookupTimes = Object.keys(lookup)
      .map((k) => Number(k))
      .filter((n) => Number.isFinite(n) && n > 0);
    const latestLookup = lookupTimes.length ? Math.max(...lookupTimes) : 0;
    const cutoffSec = Math.floor(new Date(`${cutoffDate}T00:00:00.000Z`).getTime() / 1000);
    const startSec = Math.max(cutoffSec, latestLookup ? latestLookup + 900 : cutoffSec);
    const endSec = Math.floor((Date.now() / 1000) / 900) * 900;
    const sweep = await fetchSlugSweep(startSec, endSec, marketMap);
    if (sweep.successfulRequests > 0) successfulStrategies++;
    if (sweep.failed) failures.push(`slug sweep: ${sweep.error}`);
  }

  if (successfulStrategies === 0 && failures.length > 0) {
    throw new Error(`All Polymarket discovery strategies failed: ${failures.join('; ')}`);
  }

  const markets = Array.from(marketMap.values()).sort((a, b) => a.startSec - b.startSec);
  console.log(`  ${markets.length} resolved markets found`);
  return markets;
}

async function fetchTickPrices(tokenId, startSec, endSec) {
  if (!tokenId) return [];
  // fidelity=60 returns 0 entries for sparse 15-min markets (needs >=60s between consecutive ticks
  // to surface them). fidelity=1 returns all available ticks (~1 per minute on average).
  const url = `${CLOB_BASE}/prices-history?market=${tokenId}&startTs=${startSec}&endTs=${endSec}&fidelity=1`;
  const data = await httpGet<PriceHistoryResponse>(url);
  if (!data || !data.history) return [];
  return data.history
    .map(p => [parseInt(String(p.t), 10) - startSec, Math.round(parseFloat(String(p.p)) * 1000000) / 1000000])
    .filter(([secs]) => secs >= 0 && secs <= 900);
}

async function main() {
  const cutoffDate = new Date(Date.now() - DAYS * 86400000).toISOString().split('T')[0];
  console.log(`\n=== Fetch Fresh Polymarket Markets ===`);
  console.log(`Period:  last ${DAYS} days (since ${cutoffDate})`);
  console.log(`Lookup:  ${LOOKUP_PATH}`);

  // Load existing lookup
  let lookup: Record<string, LookupEntry> = {};
  if (fs.existsSync(LOOKUP_PATH)) {
    console.log(`\nLoading existing lookup...`);
    lookup = JSON.parse(fs.readFileSync(LOOKUP_PATH, 'utf-8'));
    console.log(`  ${Object.keys(lookup).length.toLocaleString()} existing markets`);
  }

  // Fetch new events
  const freshMarkets = await fetchFreshEvents(cutoffDate, lookup);
  const existingTimestamps = Object.keys(lookup)
    .map((k) => Number(k))
    .filter((n) => Number.isFinite(n) && n > 0);
  const latestExisting = existingTimestamps.length ? Math.max(...existingTimestamps) : 0;
  const staleDays = latestExisting ? (Date.now() / 1000 - latestExisting) / 86400 : Infinity;
  if (freshMarkets.length === 0 && staleDays > 3) {
    const latestIso = latestExisting ? new Date(latestExisting * 1000).toISOString() : 'none';
    throw new Error(
      `Gamma returned 0 fresh BTC markets while lookup is stale ` +
      `(latest=${latestIso}, age=${staleDays.toFixed(1)}d). ` +
      `Check Polymarket Gamma/CLOB network access, series ids, search terms, or slug prefixes.`
    );
  }
  // Audit fix (May 2026): include markets that exist in lookup but have empty prices
  // (added label-only by quickUpdateLookup.py). Previously these were skipped here,
  // leaving the corpus with priceless rows that generateTrainingData drops silently.
  const newMarkets = freshMarkets.filter(m => {
    const existing = lookup[m.slugTs];
    if (!existing) return true;                              // brand new
    if (!existing.prices || existing.prices.length === 0) return true;  // needs enrichment
    return false;
  });
  const trulyNew = freshMarkets.filter(m => !(m.slugTs in lookup)).length;
  const reEnrich = newMarkets.length - trulyNew;
  console.log(`  ${newMarkets.length} to fetch (${trulyNew} new, ${reEnrich} re-enrich priceless)`);

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

  // Save updated lookup (atomic write — audit fix May 2026)
  // Write to .tmp then rename so Ctrl-C/OOM cannot corrupt the 4 MB corpus.
  console.log(`\nSaving updated lookup...`);
  const tmpPath = LOOKUP_PATH + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(lookup, null, 0));
  fs.renameSync(tmpPath, LOOKUP_PATH);
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
  node generateTrainingData.mts --days 540 --polymarket-lookup ./polymarket_lookup.json
============================================
`);
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
