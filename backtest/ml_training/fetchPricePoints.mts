/**
 * Fetch the last trade print at each training instant of past BTC 15m markets.
 *
 *   node fetchPricePoints.mts [--since <unixSec>] [--concurrency 24]
 *
 * The training generator reads a market's price at candle closes only — minutes
 * 1..14 into the window and 60 s before each (so seconds 0, 60, ..., 840). The
 * data API's `end` is inclusive and it returns newest first, so
 * `trades?market=<id>&limit=1&end=<T>` is exactly "the last print at or before T"
 * (checked against a full history). Fifteen ~1 KB requests replace a full
 * history that runs to several MB for a busy market, and the union of the
 * answers is a valid sparse price series for every queried instant: if the
 * last print before minute 3 happened before minute 2, it is also the last print
 * before minute 2.
 *
 * Skips markets that already have a complete trade_history/<slugTs>.json.gz.
 * Writes price_points/<slugTs>.json.gz (gitignored):
 *   { slugTs, slug, conditionId, points: [[querySecs, printSecs, outcome(0 Up | 1 Down), price] | [querySecs, null]] }
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { gzipSync, gunzipSync } from 'zlib';
import { fetchJsonWithPolymarketDoh } from '../../bot/src/services/polymarketHttp.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, 'price_points');
const HISTORY = resolve(HERE, 'trade_history');
const QUERY_SECS = Array.from({ length: 15 }, (_, i) => i * 60);

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const since = Number(arg('since', '0'));
const concurrency = Math.max(1, Math.min(32, Number(arg('concurrency', '24'))));

function slugsFromCsv(): number[] {
  const lines = readFileSync(resolve(HERE, 'training_data.csv'), 'utf-8').trim().split(/\r?\n/);
  const col = lines[0].split(',').indexOf('slug_timestamp');
  if (col < 0) throw new Error('training_data.csv has no slug_timestamp column');
  const out = new Set<number>();
  for (let i = 1; i < lines.length; i++) {
    const ts = Number(lines[i].split(',')[col]);
    if (Number.isFinite(ts) && ts >= since) out.add(ts);
  }
  return [...out].sort((a, b) => a - b);
}

function hasCompleteHistory(slugTs: number): boolean {
  const path = resolve(HISTORY, `${slugTs}.json.gz`);
  if (!existsSync(path)) return false;
  try { return JSON.parse(gunzipSync(readFileSync(path)).toString('utf-8')).truncated !== true; } catch { return false; }
}

async function withRetry<T>(fn: () => Promise<T>, what: string): Promise<T> {
  let delay = 1_000;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= 6) throw new Error(`${what}: ${(err as Error).message}`);
      await new Promise(r => setTimeout(r, delay));
      delay = Math.min(delay * 2, 30_000);
    }
  }
}

interface RawTrade { timestamp: number | string; outcome?: string; outcomeIndex?: number; price: number | string }

async function fetchMarket(slugTs: number): Promise<number> {
  const slug = `btc-updown-15m-${slugTs}`;
  const market = await withRetry(
    () => fetchJsonWithPolymarketDoh<{ conditionId?: string }>(`https://gamma-api.polymarket.com/markets/slug/${slug}`),
    `gamma ${slug}`,
  );
  const conditionId = market?.conditionId;
  if (!conditionId || !/^0x[0-9a-fA-F]{64}$/.test(conditionId)) throw new Error(`${slug}: no conditionId`);

  const points: Array<[number, number, number, number] | [number, null]> = [];
  for (const q of QUERY_SECS) {
    const page = await withRetry(
      () => fetchJsonWithPolymarketDoh<RawTrade[]>(
        `https://data-api.polymarket.com/trades?market=${conditionId}&limit=1&offset=0&takerOnly=false&end=${slugTs + q}`,
      ),
      `print ${slug} @${q}`,
    );
    const t = Array.isArray(page) ? page[0] : undefined;
    const ts = Number(t?.timestamp);
    const price = Number(t?.price);
    const outcome = t?.outcome === 'Up' ? 0 : t?.outcome === 'Down' ? 1 : t?.outcomeIndex === 0 ? 0 : t?.outcomeIndex === 1 ? 1 : -1;
    if (!t || !Number.isFinite(ts) || ts > slugTs + q || outcome < 0 || !(price > 0 && price < 1)) points.push([q, null]);
    else points.push([q, ts - slugTs, outcome, price]);
  }
  const path = resolve(OUT, `${slugTs}.json.gz`);
  writeFileSync(`${path}.part`, gzipSync(JSON.stringify({ slugTs, slug, conditionId, points })));
  renameSync(`${path}.part`, path);
  return points.filter(p => p[1] !== null).length;
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const all = slugsFromCsv();
  const todo = all.filter(ts => !existsSync(resolve(OUT, `${ts}.json.gz`)) && !hasCompleteHistory(ts));
  console.log(`${all.length} markets, ${all.length - todo.length} covered (full history or points), ${todo.length} to fetch (concurrency ${concurrency})`);
  let done = 0, failed = 0, missing = 0;
  const failures: string[] = [];
  const started = Date.now();
  let next = 0;
  async function worker(): Promise<void> {
    while (next < todo.length) {
      const ts = todo[next++];
      try {
        missing += QUERY_SECS.length - await fetchMarket(ts);
      } catch (err) {
        failed++;
        failures.push(`${ts}: ${(err as Error).message}`);
      }
      done++;
      if (done % 200 === 0 || done === todo.length) {
        console.log(`  ${done}/${todo.length} (${failed} failed, ${missing} empty points) ${((Date.now() - started) / 60_000).toFixed(1)} min`);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  if (failures.length) {
    writeFileSync(resolve(OUT, '_failures.txt'), failures.join('\n'));
    console.log('failures listed in price_points/_failures.txt (rerun to retry them)');
  }
  console.log('done');
}

await main();
