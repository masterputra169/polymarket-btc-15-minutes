/**
 * Fetch the full trade history (second-resolution prints) of past BTC 15m markets.
 *
 *   node fetchTradeHistory.mts --since 1785528900 [--until <unixSec>] [--concurrency 8]
 *
 * Why: training_data.csv's market price is the last print of a ~1/min series,
 * up to 60 s older than the model's inputs, so every offline "edge vs market"
 * number was inflated (2026-09-25 threshold study). Polymarket's data API keeps
 * every trade with a second timestamp — 2,000-5,000 per market, median gap < 1 s —
 * so the token price at any instant can be rebuilt as fresh as a live quote.
 *
 * Markets come from training_data.csv (slug_timestamp column). One gzipped JSON
 * per market in ./trade_history/<slugTs>.json.gz (gitignored):
 *   { slugTs, slug, conditionId, trades: [[ts, outcome(0 Up | 1 Down), price, size, side(0 BUY | 1 SELL)], ...] }
 * sorted by time. Resumable: markets already on disk are skipped. Runs through
 * the repo's DoH-aware fetch, because this host's DNS black-holes polymarket.com.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { gzipSync } from 'zlib';
import { fetchJsonWithPolymarketDoh } from '../../bot/src/services/polymarketHttp.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, 'trade_history');
const PAGE = 500;
/** The data API answers HTTP 400 past offset 10,000; newest trades come first, so a market busier than that loses its opening minutes (marked truncated). */
const MAX_OFFSET = 10_000;

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const since = Number(arg('since', '0'));
const until = Number(arg('until', String(Number.MAX_SAFE_INTEGER)));
const concurrency = Math.max(1, Math.min(16, Number(arg('concurrency', '8'))));

function slugsFromCsv(): number[] {
  const lines = readFileSync(resolve(HERE, 'training_data.csv'), 'utf-8').trim().split(/\r?\n/);
  const col = lines[0].split(',').indexOf('slug_timestamp');
  if (col < 0) throw new Error('training_data.csv has no slug_timestamp column');
  const out = new Set<number>();
  for (let i = 1; i < lines.length; i++) {
    const ts = Number(lines[i].split(',')[col]);
    if (Number.isFinite(ts) && ts >= since && ts <= until) out.add(ts);
  }
  return [...out].sort((a, b) => a - b);
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

interface RawTrade { timestamp: number | string; outcome?: string; outcomeIndex?: number; price: number | string; size: number | string; side?: string }

async function fetchMarket(slugTs: number): Promise<{ trades: number; truncated: boolean }> {
  const slug = `btc-updown-15m-${slugTs}`;
  const market = await withRetry(
    () => fetchJsonWithPolymarketDoh<{ conditionId?: string }>(`https://gamma-api.polymarket.com/markets/slug/${slug}`),
    `gamma ${slug}`,
  );
  const conditionId = market?.conditionId;
  if (!conditionId || !/^0x[0-9a-fA-F]{64}$/.test(conditionId)) throw new Error(`${slug}: no conditionId`);

  const raw: RawTrade[] = [];
  let truncated = false;
  for (let offset = 0; ; offset += PAGE) {
    if (offset > MAX_OFFSET) { truncated = true; break; }
    const page = await withRetry(
      () => fetchJsonWithPolymarketDoh<RawTrade[]>(
        `https://data-api.polymarket.com/trades?market=${conditionId}&limit=${PAGE}&offset=${offset}&takerOnly=false`,
      ),
      `trades ${slug} @${offset}`,
    );
    if (!Array.isArray(page)) throw new Error(`${slug}: trades page is not an array`);
    raw.push(...page);
    if (page.length < PAGE) break;
  }

  const trades = raw
    .map(t => {
      const outcome = t.outcome === 'Up' ? 0 : t.outcome === 'Down' ? 1 : t.outcomeIndex === 0 ? 0 : t.outcomeIndex === 1 ? 1 : -1;
      return [Number(t.timestamp), outcome, Number(t.price), Number(t.size), t.side === 'SELL' ? 1 : 0];
    })
    .filter(t => Number.isFinite(t[0]) && t[1] >= 0 && Number.isFinite(t[2]) && t[2] > 0 && t[2] < 1)
    .sort((a, b) => a[0] - b[0]);

  const path = resolve(OUT, `${slugTs}.json.gz`);
  writeFileSync(`${path}.part`, gzipSync(JSON.stringify({ slugTs, slug, conditionId, truncated, trades })));
  renameSync(`${path}.part`, path);
  return { trades: trades.length, truncated };
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const all = slugsFromCsv();
  const todo = all.filter(ts => !existsSync(resolve(OUT, `${ts}.json.gz`)));
  console.log(`${all.length} markets in range, ${all.length - todo.length} already on disk, ${todo.length} to fetch (concurrency ${concurrency})`);

  let done = 0, failed = 0, truncated = 0, trades = 0;
  const started = Date.now();
  const failures: string[] = [];
  let next = 0;
  async function worker(): Promise<void> {
    while (next < todo.length) {
      const ts = todo[next++];
      try {
        const r = await fetchMarket(ts);
        trades += r.trades;
        if (r.truncated) truncated++;
      } catch (err) {
        failed++;
        failures.push(`${ts}: ${(err as Error).message}`);
      }
      done++;
      if (done % 100 === 0 || done === todo.length) {
        const min = (Date.now() - started) / 60_000;
        console.log(`  ${done}/${todo.length} (${failed} failed, ${truncated} truncated, ${trades.toLocaleString()} trades) ${min.toFixed(1)} min`);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  if (failures.length) {
    writeFileSync(resolve(OUT, '_failures.txt'), failures.join('\n'));
    console.log(`failures listed in trade_history/_failures.txt (rerun to retry them)`);
  }
  console.log('done');
}

await main();
