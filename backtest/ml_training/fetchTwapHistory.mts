/**
 * Fetch, per BTC 15m window, the two series the late-window TWAP backtest needs.
 *
 *   node backtest/ml_training/fetchTwapHistory.mts [--days 30] [--concurrency 2]
 *
 * 1. twap_history/<startSec>.json — Polymarket's 60 s TWAP path for the window,
 *    61 points every 15 s (polymarket.com/api/crypto/price-history with the twap
 *    parameters; the first point is the price to beat, the last the settlement
 *    price). The endpoint refuses windows older than 30 days and answers 429 when
 *    pushed, so calls are spaced and retried with backoff.
 * 2. binance_1s/<startSec>.json — Binance BTCUSDT 1 s closes for the window's last
 *    six minutes (data-api.binance.vision klines, interval=1s). The TWAP feed is
 *    15 s-grained and there is no public Chainlink spot history, so the backtest
 *    reconstructs Chainlink spot as Binance − basis, the basis re-anchored on
 *    every TWAP point.
 *
 * Resumable: a window with both files present is skipped. Data files are
 * gitignored (backtest/ml_training/*).
 */

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { fetchTextWithPolymarketDoh } from '../../bot/src/services/polymarketHttp.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const DAYS = Number(arg('days', '30'));
const CONC = Math.max(1, Number(arg('concurrency', '2')));
const TWAP_DIR = join(HERE, 'twap_history');
const BIN_DIR = join(HERE, 'binance_1s');
for (const d of [TWAP_DIR, BIN_DIR]) if (!existsSync(d)) mkdirSync(d, { recursive: true });

const iso = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// The endpoint's 30-day limit counts from now; keep a margin so a long run does not age out mid-way.
const nowSec = Math.floor(Date.now() / 1000);
const first = Math.ceil((nowSec - DAYS * 86_400 + 3 * 3_600) / 900) * 900;
const last = Math.floor((nowSec - 20 * 60) / 900) * 900 - 900;
const windows: number[] = [];
for (let s = first; s <= last; s += 900) windows.push(s);

let gap = 800; // ms between price-history calls per worker, grows on 429
async function twap(startSec: number): Promise<'ok' | 'skip' | 'fail'> {
  const out = join(TWAP_DIR, `${startSec}.json`);
  if (existsSync(out)) return 'skip';
  const s = startSec * 1000, e = s + 900_000;
  const url = `https://polymarket.com/api/crypto/price-history?symbol=BTC&eventStartTime=${iso(s)}&variant=fifteen&endDate=${iso(e)}&twapEnabled=true&twapLookbackSeconds=60`;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const body = await fetchTextWithPolymarketDoh(url, { timeoutMs: 20_000, label: 'price-history' });
      const arr = JSON.parse(body);
      const pts = (Array.isArray(arr) ? arr : Object.values(arr)).filter((p: any) => Number.isFinite(p?.timestamp) && Number.isFinite(p?.value));
      if (pts.length < 55) return 'fail'; // incomplete window
      writeFileSync(out, JSON.stringify({ startSec, points: pts.map((p: any) => [p.timestamp, p.value]) }));
      await sleep(gap);
      return 'ok';
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      if (/\b429\b/.test(msg)) { gap = Math.min(5_000, gap * 1.5); await sleep(10_000 * (attempt + 1)); continue; }
      if (/\b400\b/.test(msg)) return 'fail'; // older than 30 days
      await sleep(2_000 * (attempt + 1));
    }
  }
  return 'fail';
}

async function binance(startSec: number): Promise<'ok' | 'skip' | 'fail'> {
  const out = join(BIN_DIR, `${startSec}.json`);
  if (existsSync(out)) return 'skip';
  const endMs = (startSec + 900) * 1000;
  const from = endMs - 400_000;
  const url = `https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1s&startTime=${from}&endTime=${endMs + 5_000}&limit=1000`;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const k = await r.json() as any[];
      writeFileSync(out, JSON.stringify({ startSec, closes: k.map(c => [c[0], Number(c[4])]) }));
      return 'ok';
    } catch {
      await sleep(1_500 * (attempt + 1));
    }
  }
  return 'fail';
}

const stats = { twap: { ok: 0, skip: 0, fail: 0 }, bin: { ok: 0, skip: 0, fail: 0 } };
let next = 0;
async function worker() {
  while (next < windows.length) {
    const s = windows[next++];
    stats.bin[await binance(s)]++;
    stats.twap[await twap(s)]++;
    const done = stats.twap.ok + stats.twap.skip + stats.twap.fail;
    if (done % 100 === 0) console.log(`${done}/${windows.length} windows · twap ${JSON.stringify(stats.twap)} · binance ${JSON.stringify(stats.bin)} · gap ${Math.round(gap)}ms`);
  }
}
console.log(`${windows.length} windows ${iso(first * 1000)} → ${iso(last * 1000)}, concurrency ${CONC}`);
await Promise.all(Array.from({ length: CONC }, worker));
console.log(`done · twap ${JSON.stringify(stats.twap)} · binance ${JSON.stringify(stats.bin)}`);
