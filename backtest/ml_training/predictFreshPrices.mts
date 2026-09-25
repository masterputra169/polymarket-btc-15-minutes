/**
 * Re-predict a model at every decision minute of past markets, with the token
 * price as FRESH as a live quote — rebuilt from the per-second trade history
 * fetched by fetchTradeHistory.mts.
 *
 *   node predictFreshPrices.mts --model <dir> --since <unixSec> [--out fresh_predictions.json]
 *
 * The feature path is the live one: buildTrainingSnapshot → buildMlFeatureInputs
 * → extractLiveFeaturesInPlace → predictML, with the market series replaced by
 * the trade prints (UP prints as-is, DOWN prints as 1 − price). So `marketUp` and
 * the 60 s lag are what the bot would have seen, not a ~1/min lookup print.
 *
 * One row per (market, minute 1..14): fresh UP price and its age, the model's
 * P(UP), BTC and PTB (for the BTC-distance gate), regime, and the resolved
 * label from polymarket_lookup.json.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { gunzipSync } from 'zlib';
import { BOT_CONFIG } from '../../bot/src/config.ts';
import { loadMLModelFromDisk, getFeaturePipeline } from '../../bot/src/adapters/mlLoader.ts';
import { predictML } from '../../src/engines/Mlpredictor.ts';
import { featureBuf, extractLiveFeaturesInPlace } from '../../src/engines/ml/featureExtract.ts';
import { buildMlFeatureInputs } from '../../src/engines/ml/featureInputs.ts';
import { buildTrainingSnapshot, printsToUpSeries, CANDLES_1M } from '../../src/engines/ml/trainingRow.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIN = 60_000;

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const modelDir = resolve(arg('model', resolve(HERE, '..', '..', 'public', 'ml'))!);
const since = Number(arg('since', '0'));
const outPath = resolve(HERE, arg('out', 'fresh_predictions.json')!);

(BOT_CONFIG as any).modelPath = resolve(modelDir, 'xgboost_model.json');
(BOT_CONFIG as any).normPath = resolve(modelDir, 'norm_browser.json');
if (!loadMLModelFromDisk()) throw new Error(`model load failed: ${modelDir}`);
if (getFeaturePipeline() < 2) throw new Error('this replay uses the shared v2 feature builder; the model must declare feature_pipeline >= 2');

type Candle = { openTime: number; open: number; high: number; low: number; close: number; volume: number; takerBuyVolume: number };

async function klines(startMs: number, endMs: number): Promise<Candle[]> {
  const cache = resolve(HERE, 'trade_history', '_klines_cache.json');
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
  }
  writeFileSync(cache, JSON.stringify({ startMs, endMs, candles: out }));
  return out;
}

function lastAtOrBefore(series: Array<[number, number]>, secs: number): { price: number; age: number } | null {
  let lo = 0, hi = series.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid][0] <= secs) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found < 0 ? null : { price: series[found][1], age: secs - series[found][0] };
}

async function main(): Promise<void> {
  const lookup = JSON.parse(readFileSync(resolve(HERE, 'polymarket_lookup.json'), 'utf-8'));
  const files = readdirSync(resolve(HERE, 'trade_history')).filter(f => /^\d+\.json\.gz$/.test(f));
  const markets = files.map(f => Number(f.split('.')[0])).filter(ts => ts >= since).sort((a, b) => a - b);
  if (markets.length === 0) throw new Error('no trade history on disk — run fetchTradeHistory.mts first');

  const candles = await klines(markets[0] * 1000 - (CANDLES_1M + 30) * MIN, markets[markets.length - 1] * 1000 + 16 * MIN);
  const byOpen = new Map(candles.map((c, i) => [c.openTime, i]));
  console.log(`model ${modelDir} (pipeline v${getFeaturePipeline()}) | ${markets.length} markets | ${candles.length} candles`);

  const rows: any[] = [];
  let skipped = 0, noLabel = 0;
  for (const slugTs of markets) {
    const label = lookup[String(slugTs)]?.label;
    if (label !== 0 && label !== 1) { noLabel++; continue; }
    const hist = JSON.parse(gunzipSync(readFileSync(resolve(HERE, 'trade_history', `${slugTs}.json.gz`))).toString('utf-8'));
    const series = printsToUpSeries(hist.trades, slugTs);
    const market = { label, prices: series };
    for (let minute = 1; minute <= 14; minute++) {
      const secsInto = minute * 60;
      const idx = byOpen.get(slugTs * 1000 + (secsInto - 60) * 1000);
      if (idx == null) { skipped++; continue; }
      const snap = buildTrainingSnapshot({ candles1m: candles, idx, slugTs, market });
      if (!snap) { skipped++; continue; }
      const { marketState, ruleProbUp } = buildMlFeatureInputs(snap);
      extractLiveFeaturesInPlace({ ...marketState, ruleProbUp, ruleConfidence: Math.abs(ruleProbUp - 0.5) * 2 });
      const r = predictML(featureBuf);
      if (!r) { skipped++; continue; }
      const fresh = lastAtOrBefore(series, secsInto)!;
      rows.push({
        slugTs, secsInto, y: label,
        up: fresh.price, upAge: fresh.age,
        pred: r.probUp,
        rule: ruleProbUp,
        btc: snap.lastPrice, ptb: snap.windowOpenPrice,
        regime: (marketState as any).regime ?? null,
      });
    }
  }
  writeFileSync(outPath, JSON.stringify(rows));
  console.log(`rows ${rows.length} | skipped instants ${skipped} | markets without label ${noLabel} -> ${outPath}`);
}

await main();
