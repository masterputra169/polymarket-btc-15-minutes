/**
 * Export every decision minute of every past market — the full live feature
 * vector with a FRESH token price — for model studies that need more than one
 * row per market (residualModelStudy.py).
 *
 *   node exportFreshFeatures.mts [--days 182] [--out fresh_features.csv]
 *
 * Prices: per-second trade prints (trade_history/, fetchTradeHistory.mts) where
 * the file is complete, else the point queries (price_points/, fetchPricePoints.mts)
 * — the same two sources, in the same order, as generateTrainingData.mts, so a
 * row here equals the row the generator would build at that minute.
 *
 * One row per (market, minute 1..14): the base features in live index order,
 * then slug_timestamp, secs_into, label, up_fresh / up_age (the last UP print at
 * or before the instant and its age in seconds), v2_pred (the deployed model's
 * P(UP) on this vector), btc / ptb_binance, and rv_1m (st.dev. of the last 30
 * one-minute log returns, for a driftless digital-option price).
 */

import { existsSync, readFileSync, writeFileSync, createWriteStream } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { gunzipSync } from 'zlib';
import { BOT_CONFIG } from '../../bot/src/config.ts';
import { loadMLModelFromDisk, getFeaturePipeline } from '../../bot/src/adapters/mlLoader.ts';
import { predictML } from '../../src/engines/Mlpredictor.ts';
import { featureBuf } from '../../src/engines/ml/featureExtract.ts';
import { FI } from '../../src/engines/ml/featureMap.ts';
import {
  buildTrainingSnapshot, buildTrainingFeatures, printsToUpSeries, pricePointsToUpSeries, CANDLES_1M,
} from '../../src/engines/ml/trainingRow.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIN = 60_000;

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const days = Number(arg('days', '182'));
const outPath = resolve(HERE, arg('out', 'fresh_features.csv'));
const modelDir = resolve(HERE, '..', '..', 'public', 'ml');

(BOT_CONFIG as any).modelPath = resolve(modelDir, 'xgboost_model.json');
(BOT_CONFIG as any).normPath = resolve(modelDir, 'norm_browser.json');
if (!loadMLModelFromDisk()) throw new Error(`model load failed: ${modelDir}`);
if (getFeaturePipeline() < 2) throw new Error('the deployed model must declare feature_pipeline >= 2');

type Candle = { openTime: number; open: number; high: number; low: number; close: number; volume: number; takerBuyVolume: number };

async function klines(startMs: number, endMs: number): Promise<Candle[]> {
  const cache = resolve(HERE, 'trade_history', '_klines_cache_full.json');
  if (existsSync(cache)) {
    const c = JSON.parse(readFileSync(cache, 'utf-8'));
    if (c.startMs <= startMs && c.endMs >= endMs) return c.candles;
  }
  const out: Candle[] = [];
  for (let cursor = startMs; cursor < endMs;) {
    const url = `https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1m&startTime=${cursor}&endTime=${endMs}&limit=1000`;
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`klines HTTP ${res.status}`);
    const raw = await res.json() as any[];
    if (!raw.length) break;
    for (const k of raw) out.push({ openTime: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5], takerBuyVolume: +k[9] });
    cursor = raw[raw.length - 1][0] + MIN;
    if (out.length % 50_000 < 1000) process.stdout.write(`\r  ${out.length.toLocaleString()} candles`);
  }
  writeFileSync(cache, JSON.stringify({ startMs, endMs, candles: out }));
  return out;
}

function upSeries(slugTs: number): Array<[number, number]> | null {
  const hist = resolve(HERE, 'trade_history', `${slugTs}.json.gz`);
  if (existsSync(hist)) {
    const h = JSON.parse(gunzipSync(readFileSync(hist)).toString('utf-8'));
    if (!h.truncated && Array.isArray(h.trades)) {
      const s = printsToUpSeries(h.trades, slugTs);
      if (s.length) return s;
    }
  }
  const pts = resolve(HERE, 'price_points', `${slugTs}.json.gz`);
  if (existsSync(pts)) {
    const p = JSON.parse(gunzipSync(readFileSync(pts)).toString('utf-8'));
    const s = Array.isArray(p.points) ? pricePointsToUpSeries(p.points) : [];
    if (s.length) return s;
  }
  return null;
}

function lastAtOrBefore(series: Array<[number, number]>, secs: number): { price: number; age: number } | null {
  let lo = 0, hi = series.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid][0] <= secs) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found < 0 ? null : { price: series[found][1], age: secs - series[found][0] };
}

function rv1m(candles: Candle[], idx: number, n = 30): number | null {
  if (idx < n) return null;
  let s = 0, s2 = 0;
  for (let i = idx - n + 1; i <= idx; i++) {
    const r = Math.log(candles[i].close / candles[i - 1].close);
    s += r; s2 += r * r;
  }
  const v = s2 / n - (s / n) ** 2;
  return v > 0 ? Math.sqrt(v) : null;
}

async function main(): Promise<void> {
  const lookup = JSON.parse(readFileSync(resolve(HERE, 'polymarket_lookup.json'), 'utf-8'));
  const names = Object.entries(FI).sort((a, b) => (a[1] as number) - (b[1] as number)).map(([n]) => n);
  const endMs = Math.floor(Date.now() / MIN) * MIN;
  const startMs = endMs - days * 86_400_000;
  const candles = await klines(startMs - (CANDLES_1M + 30) * MIN, endMs);
  const byOpen = new Map(candles.map((c, i) => [c.openTime, i]));
  const slugs = Object.keys(lookup).map(Number)
    .filter(ts => Number.isFinite(ts) && ts * 1000 >= startMs && ts * 1000 + 15 * MIN <= endMs)
    .sort((a, b) => a - b);
  console.log(`\n${candles.length.toLocaleString()} candles | ${slugs.length.toLocaleString()} markets in range | ${names.length} features`);

  const out = createWriteStream(outPath);
  out.write([...names, 'slug_timestamp', 'secs_into', 'label', 'up_fresh', 'up_age', 'v2_pred', 'btc', 'ptb_binance', 'rv_1m'].join(',') + '\n');
  let rows = 0, markets = 0, noPrices = 0, badLabel = 0, skipped = 0;
  for (const slugTs of slugs) {
    const label = lookup[String(slugTs)]?.label;
    if (label !== 0 && label !== 1) { badLabel++; continue; }
    const series = upSeries(slugTs);
    if (!series) { noPrices++; continue; }
    const market = { label, prices: series };
    let any = false;
    for (let minute = 1; minute <= 14; minute++) {
      const secsInto = minute * 60;
      const idx = byOpen.get(slugTs * 1000 + (secsInto - 60) * 1000);
      if (idx == null) { skipped++; continue; }
      const snap = buildTrainingSnapshot({ candles1m: candles, idx, slugTs, market });
      if (!snap) { skipped++; continue; }
      const feats = buildTrainingFeatures(snap, names.length);
      const r = predictML(featureBuf);
      const fresh = lastAtOrBefore(series, secsInto);
      if (!r || !fresh) { skipped++; continue; }
      const vol = rv1m(candles, idx);
      out.write([
        ...feats.map(v => (Number.isFinite(v) ? +v.toPrecision(7) : '')),
        slugTs, secsInto, label, fresh.price, fresh.age, +r.probUp.toFixed(6),
        snap.lastPrice, snap.windowOpenPrice, vol == null ? '' : +vol.toPrecision(6),
      ].join(',') + '\n');
      rows++; any = true;
    }
    if (any) markets++;
    if (markets % 1000 === 0 && any) process.stdout.write(`\r  ${markets.toLocaleString()} markets, ${rows.toLocaleString()} rows`);
  }
  await new Promise<void>(res => out.end(res));
  console.log(`\nrows ${rows} | markets ${markets} | no prices ${noPrices} | no label ${badLabel} | skipped instants ${skipped} -> ${outPath}`);
}

await main();
