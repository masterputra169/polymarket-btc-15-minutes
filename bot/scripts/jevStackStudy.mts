/**
 * JEV stacking study — record-only, time-split, coverage-aware Brier.
 *
 * Compares:
 *   market, ML, JEV calibrated, JEV+market, JEV+market+ML
 *
 * Fits logistic stacking on the first 70% of markets by time and reports the
 * last 30% only. Bootstrap CIs are paired. No live path imports this script.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { calibrateJevSettleUp } from '../src/ai/jevSettleCalibration.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA = resolve(ROOT, 'bot', 'data');
const JEV_FILE = resolve(DATA, 'jev_log.jsonl');
const JOURNAL_FILE = resolve(DATA, 'trade_journal.jsonl');
const CACHE_FILE = resolve(DATA, 'jev_outcomes.json');
const OUT_FILE = resolve(DATA, 'jev_stack_study.json');

type Row = Record<string, any>;
type Outcome = 'UP' | 'DOWN';

function readJsonl(file: string): Row[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split(String.fromCharCode(10)).filter(Boolean).map((line) => {
    try { return JSON.parse(line) as Row; } catch { return null; }
  }).filter((r): r is Row => r !== null);
}
function logit(p: number): number {
  const c = Math.max(0.01, Math.min(0.99, p));
  return Math.log(c / (1 - c));
}
function sigmoid(z: number): number { return 1 / (1 + Math.exp(-z)); }
function brier(p: number, y: number): number { return (p - y) ** 2; }
function mean(xs: number[]): number { return xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length); }
function metrics(preds: number[], ys: number[]) {
  const n = preds.length;
  let b = 0; let ll = 0;
  for (let i = 0; i < n; i++) { b += brier(preds[i], ys[i]); const p = Math.max(1e-9, Math.min(1 - 1e-9, preds[i])); ll -= ys[i] * Math.log(p) + (1 - ys[i]) * Math.log(1 - p); }
  return { n, brier: n ? b / n : NaN, logloss: n ? ll / n : NaN };
}
function fitLogistic(X: number[][], y: number[], lambda = 0.3): { predict: (x: number[]) => number } {
  const n = X.length; const d = X[0].length;
  const mu = new Array(d).fill(0); const sd = new Array(d).fill(1);
  for (let j = 0; j < d; j++) {
    const col = X.map((r) => r[j]); mu[j] = mean(col);
    const v = mean(col.map((x) => (x - mu[j]) ** 2)); sd[j] = Math.sqrt(v) || 1;
  }
  const Z = X.map((r) => [1, ...r.map((x, j) => (x - mu[j]) / sd[j])]);
  let w = new Array(d + 1).fill(0);
  const lr = 0.15;
  for (let it = 0; it < 4000; it++) {
    const g = new Array(w.length).fill(0);
    for (let i = 0; i < n; i++) {
      let z = 0; for (let j = 0; j < w.length; j++) z += w[j] * Z[i][j];
      const err = sigmoid(z) - y[i];
      for (let j = 0; j < w.length; j++) g[j] += err * Z[i][j];
    }
    for (let j = 0; j < w.length; j++) { g[j] /= n; if (j > 0) g[j] += lambda * w[j]; w[j] -= lr * g[j]; }
  }
  return { predict: (x: number[]) => {
    let z = w[0]; for (let j = 0; j < d; j++) z += w[j + 1] * ((x[j] - mu[j]) / sd[j]);
    return sigmoid(z);
  } };
}
function mapWinner(market: Row): Outcome | null {
  if (market.closed !== true) return null;
  let outs = market.outcomes; let prices = market.outcomePrices;
  try { if (typeof outs === 'string') outs = JSON.parse(outs); if (typeof prices === 'string') prices = JSON.parse(prices); } catch { return null; }
  if (!Array.isArray(outs) || !Array.isArray(prices) || outs.length !== prices.length) return null;
  const np = prices.map(Number);
  if (!np.some((p) => p >= 0.99) || !np.some((p) => p <= 0.01)) return null;
  let best = 0; for (let i = 1; i < np.length; i++) if (np[i] > np[best]) best = i;
  const label = String(outs[best] ?? '').toLowerCase();
  if (label.includes('up')) return 'UP';
  if (label.includes('down')) return 'DOWN';
  return best === 0 ? 'UP' : 'DOWN';
}
async function fetchOutcome(slug: string): Promise<Outcome | null> {
  try {
    const res = await fetch('https://gamma-api.polymarket.com/markets/slug/' + encodeURIComponent(slug), { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    return mapWinner(await res.json() as Row);
  } catch { return null; }
}

const jev = readJsonl(JEV_FILE);
const journal = readJsonl(JOURNAL_FILE);
const latest = new Map<string, Row>();
for (const r of jev) {
  if (!r.slug) continue;
  const prev = latest.get(r.slug);
  if (!prev || Number(r.ts) > Number(prev.ts)) latest.set(r.slug, r);
}
const rows = [...latest.values()];
const outcomes = new Map<string, Outcome>();
for (const r of journal) {
  const slug = r.entry?.marketSlug ?? r.marketSlug;
  const o = r.exit?.verifiedOutcome ?? r.exit?.outcome;
  if (slug && (o === 'UP' || o === 'DOWN')) outcomes.set(slug, o);
}
const cache: Record<string, Outcome> = existsSync(CACHE_FILE) ? JSON.parse(readFileSync(CACHE_FILE, 'utf8')) : {};
for (const [slug, o] of Object.entries(cache)) if (!outcomes.has(slug)) outcomes.set(slug, o);
const missing = rows.map((r) => r.slug).filter((s): s is string => !!s && !outcomes.has(s));
let idx = 0; let fetched = 0;
async function worker() {
  while (idx < missing.length) {
    const slug = missing[idx++]; const o = await fetchOutcome(slug);
    if (o) { outcomes.set(slug, o); cache[slug] = o; fetched++; }
  }
}
await Promise.all(Array.from({ length: 6 }, () => worker()));
if (fetched > 0) writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');

type Sample = { ts: number; slug: string; y: number; market: number; ml: number; jev: number; dirConf: number; regime: string };
const samples: Sample[] = [];
for (const r of rows) {
  const slug = r.slug; const o = outcomes.get(slug);
  if (!slug || !o) continue;
  const market = Number(r.market?.marketUp);
  const ml = Number(r.ml?.probUp);
  const raw = Number(r.settleUpProbability);
  const jevCal = calibrateJevSettleUp(raw);
  if (!Number.isFinite(market) || !Number.isFinite(ml) || !Number.isFinite(jevCal)) continue;
  samples.push({ ts: Number(r.ts), slug, y: o === 'UP' ? 1 : 0, market, ml, jev: jevCal, dirConf: Number(r.directionConfidence) || 0.5, regime: String(r.regime ?? 'unknown') });
}
samples.sort((a, b) => a.ts - b.ts);
const split = Math.floor(samples.length * 0.7);
const train = samples.slice(0, split); const test = samples.slice(split);
const trainY = train.map((s) => s.y); const testY = test.map((s) => s.y);
const baseRate = mean(trainY);
console.log('samples', samples.length, 'train', train.length, 'test', test.length, 'trainUp', baseRate.toFixed(4));

function predMarket(s: Sample) { return s.market; }
function predMl(s: Sample) { return s.ml; }
function predJev(s: Sample) { return s.jev; }
function evalOn(name: string, fn: (s: Sample) => number) {
  const p = test.map(fn); const m = metrics(p, testY);
  console.log(name, JSON.stringify(m));
  return { name, ...m };
}
const bases = [evalOn('market', predMarket), evalOn('ml', predMl), evalOn('jev_cal', predJev)];
const Xjm = train.map((s) => [logit(s.market), logit(s.jev)]);
const Xjmm = train.map((s) => [logit(s.market), logit(s.jev), logit(s.ml)]);
const modelJm = fitLogistic(Xjm, trainY, 0.5);
const modelJmm = fitLogistic(Xjmm, trainY, 0.5);
function predJm(s: Sample) { return modelJm.predict([logit(s.market), logit(s.jev)]); }
function predJmm(s: Sample) { return modelJmm.predict([logit(s.market), logit(s.jev), logit(s.ml)]); }
const stacks = [evalOn('stack_market+jev', predJm), evalOn('stack_market+jev+ml', predJmm)];

function bootstrapDiff(predA: number[], predB: number[], ys: number[], rounds = 1500) {
  const diffs: number[] = [];
  for (let r = 0; r < rounds; r++) {
    let ba = 0; let bb = 0; const n = ys.length;
    for (let i = 0; i < n; i++) {
      const k = Math.floor(Math.random() * n);
      ba += brier(predA[k], ys[k]); bb += brier(predB[k], ys[k]);
    }
    diffs.push((ba - bb) / n);
  }
  diffs.sort((a, b) => a - b);
  return { diffMean: mean(diffs), lo: diffs[Math.floor(diffs.length * 0.025)], hi: diffs[Math.floor(diffs.length * 0.975)] };
}
const testMarket = test.map(predMarket); const testJmm = test.map(predJmm); const testCal = test.map(predJev);
const boot = {
  jmm_vs_market: bootstrapDiff(testJmm, testMarket, testY),
  cal_vs_market: bootstrapDiff(testCal, testMarket, testY),
};

function coverage(preds: number[], conf: number[], ys: number[], fractions: number[]) {
  const out = [];
  for (const f of fractions) {
    const n = Math.max(1, Math.floor(preds.length * f));
    const sorted = preds.map((p, i) => ({ i, c: conf[i] })).sort((a, b) => b.c - a.c).slice(0, n);
    const ps = sorted.map((x) => preds[x.i]); const yy = sorted.map((x) => ys[x.i]);
    out.push({ coverage: f, n, brier: metrics(ps, yy).brier });
  }
  return out;
}
const coverageOut = {
  model_conf: coverage(testJmm, testJmm.map((p) => Math.abs(p - 0.5)), testY, [0.1, 0.2, 0.3, 0.5, 1]),
  market_conf: coverage(testMarket, testMarket.map((p) => Math.abs(p - 0.5)), testY, [0.1, 0.2, 0.3, 0.5, 1]),
};
const marketBrier = bases[0].brier;
const result = {
  generatedAt: new Date().toISOString(),
  samples: samples.length,
  train: train.length,
  test: test.length,
  trainUpRate: baseRate,
  baselines: bases,
  stacks,
  skillVsMarket: stacks.map((s) => ({ name: s.name, skill: 1 - s.brier / marketBrier })),
  bootstrap: boot,
  coverage: coverageOut,
  target: {
    allMarketBelow02: stacks.some((s) => s.brier < 0.2),
    anyStackBeatsMarket: stacks.some((s) => s.brier < marketBrier),
  },
};
writeFileSync(OUT_FILE, JSON.stringify(result, null, 2), 'utf8');
console.log('RESULT', JSON.stringify(result, null, 2));
