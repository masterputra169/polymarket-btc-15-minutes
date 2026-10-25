/**
 * JEV target study — primary and secondary Brier targets.
 *
 * Primary: beat market Brier on all walk-forward OOF predictions, with a
 * paired bootstrap lower bound above zero.
 *
 * Secondary: Brier below 0.20 on the top 20-30% high-confidence slice, with
 * n >= 100, evaluated on walk-forward OOF predictions.
 *
 * Record-only. No runtime path imports this file.
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
const OUT_FILE = resolve(DATA, 'jev_target_study.json');

type Row = Record<string, any>;
type Outcome = 'UP' | 'DOWN';
type Sample = { ts: number; y: number; market: number; ml: number; jev: number; dirConf: number; edge: number; regime: string; };

function readJsonl(file: string): Row[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split(String.fromCharCode(10)).filter(Boolean).map((line) => {
    try { return JSON.parse(line) as Row; } catch { return null; }
  }).filter((r): r is Row => r !== null);
}
function logit(p: number): number { const c = Math.max(0.01, Math.min(0.99, p)); return Math.log(c / (1 - c)); }
function sigmoid(z: number): number { return 1 / (1 + Math.exp(-z)); }
function brier(p: number, y: number): number { return (p - y) ** 2; }
function mean(xs: number[]): number { return xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length); }
function metrics(preds: number[], ys: number[]) { let b = 0; for (let i = 0; i < preds.length; i++) b += brier(preds[i], ys[i]); return { n: preds.length, brier: preds.length ? b / preds.length : NaN }; }
function fitLogistic(X: number[][], y: number[], lambda = 0.5): { predict: (x: number[]) => number } {
  const n = X.length; const d = X[0].length;
  const mu = new Array(d).fill(0); const sd = new Array(d).fill(1);
  for (let j = 0; j < d; j++) { const col = X.map((r) => r[j]); mu[j] = mean(col); const v = mean(col.map((x) => (x - mu[j]) ** 2)); sd[j] = Math.sqrt(v) || 1; }
  const Z = X.map((r) => [1, ...r.map((x, j) => (x - mu[j]) / sd[j])]);
  const w = new Array(d + 1).fill(0);
  for (let it = 0; it < 4000; it++) {
    const g = new Array(w.length).fill(0);
    for (let i = 0; i < n; i++) { let z = 0; for (let j = 0; j < w.length; j++) z += w[j] * Z[i][j]; const err = sigmoid(z) - y[i]; for (let j = 0; j < w.length; j++) g[j] += err * Z[i][j]; }
    for (let j = 0; j < w.length; j++) { g[j] /= n; if (j > 0) g[j] += lambda * w[j]; w[j] -= 0.15 * g[j]; }
  }
  return { predict: (x: number[]) => { let z = w[0]; for (let j = 0; j < d; j++) z += w[j + 1] * ((x[j] - mu[j]) / sd[j]); return sigmoid(z); } };
}
function mapWinner(market: Row): Outcome | null {
  if (market.closed !== true) return null;
  let outs = market.outcomes; let prices = market.outcomePrices;
  try { if (typeof outs === 'string') outs = JSON.parse(outs); if (typeof prices === 'string') prices = JSON.parse(prices); } catch { return null; }
  if (!Array.isArray(outs) || !Array.isArray(prices) || outs.length !== prices.length) return null;
  const np = prices.map(Number); if (!np.some((p) => p >= 0.99) || !np.some((p) => p <= 0.01)) return null;
  let best = 0; for (let i = 1; i < np.length; i++) if (np[i] > np[best]) best = i;
  const label = String(outs[best] ?? '').toLowerCase();
  if (label.includes('up')) return 'UP'; if (label.includes('down')) return 'DOWN';
  return best === 0 ? 'UP' : 'DOWN';
}
async function fetchOutcome(slug: string): Promise<Outcome | null> {
  try { const res = await fetch('https://gamma-api.polymarket.com/markets/slug/' + encodeURIComponent(slug), { signal: AbortSignal.timeout(15000) }); if (!res.ok) return null; return mapWinner(await res.json() as Row); } catch { return null; }
}
function seeded(seed: number) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

const jev = readJsonl(JEV_FILE); const journal = readJsonl(JOURNAL_FILE);
const latest = new Map<string, Row>();
for (const r of jev) { if (!r.slug) continue; const p = latest.get(r.slug); if (!p || Number(r.ts) > Number(p.ts)) latest.set(r.slug, r); }
const rows = [...latest.values()];
const outcomes = new Map<string, Outcome>();
for (const r of journal) { const slug = r.entry?.marketSlug ?? r.marketSlug; const o = r.exit?.verifiedOutcome ?? r.exit?.outcome; if (slug && (o === 'UP' || o === 'DOWN')) outcomes.set(slug, o); }
const cache: Record<string, Outcome> = existsSync(CACHE_FILE) ? JSON.parse(readFileSync(CACHE_FILE, 'utf8')) : {};
for (const [s, o] of Object.entries(cache)) if (!outcomes.has(s)) outcomes.set(s, o);
const missing = rows.map((r) => r.slug).filter((s): s is string => !!s && !outcomes.has(s));
let idx = 0;
async function worker() { while (idx < missing.length) { const slug = missing[idx++]; const o = await fetchOutcome(slug); if (o) { outcomes.set(slug, o); cache[slug] = o; } } }
await Promise.all(Array.from({ length: 6 }, () => worker()));
writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');

const samples: Sample[] = [];
for (const r of rows) {
  const o = outcomes.get(r.slug); if (!o) continue;
  const market = Number(r.market?.marketUp); const ml = Number(r.ml?.probUp); const jevCal = calibrateJevSettleUp(Number(r.settleUpProbability));
  if (!Number.isFinite(market) || !Number.isFinite(ml) || !Number.isFinite(jevCal)) continue;
  samples.push({ ts: Number(r.ts), y: o === 'UP' ? 1 : 0, market, ml, jev: jevCal, dirConf: Number(r.directionConfidence) || 0.5, edge: Math.abs(Number(r.edge?.best) || 0), regime: String(r.regime ?? 'unknown') });
}
samples.sort((a, b) => a.ts - b.ts);
console.log('samples', samples.length);

const FOLDS = 6; const startFrac = 0.4; const step = 0.1;
const folds: Array<{ test: Sample[]; train: Sample[] }> = [];
for (let f = 0; f < FOLDS; f++) {
  const start = Math.floor(samples.length * (startFrac + f * step));
  const end = Math.floor(samples.length * (startFrac + (f + 1) * step));
  if (end > samples.length) break;
  folds.push({ train: samples.slice(0, start), test: samples.slice(start, end) });
}
const models: Record<string, { pred: number[]; y: number[] }> = { market: { pred: [], y: [] } };
for (const m of ['stack3', 'stack5']) models[m] = { pred: [], y: [] };
const coverageConf: Record<string, number[]> = { stack3: [], stack5: [], market: [] };

for (const fold of folds) {
  const y = fold.test.map((s) => s.y);
  const market = fold.test.map((s) => s.market);
  const feat3 = (s: Sample) => [logit(s.market), logit(s.jev), logit(s.ml)];
  const feat5 = (s: Sample) => [logit(s.market), logit(s.jev), logit(s.ml), s.dirConf, Math.abs(s.market - 0.5), s.edge];
  const m3 = fitLogistic(fold.train.map(feat3), fold.train.map((s) => s.y), 0.5);
  const m5 = fitLogistic(fold.train.map(feat5), fold.train.map((s) => s.y), 0.5);
  const p3 = fold.test.map((s) => m3.predict(feat3(s)));
  const p5 = fold.test.map((s) => m5.predict(feat5(s)));
  models.market.pred.push(...market); models.market.y.push(...y);
  models.stack3.pred.push(...p3); models.stack3.y.push(...y);
  models.stack5.pred.push(...p5); models.stack5.y.push(...y);
  coverageConf.market.push(...market.map((p) => Math.abs(p - 0.5)));
  coverageConf.stack3.push(...p3.map((p) => Math.abs(p - 0.5)));
  coverageConf.stack5.push(...p5.map((p) => Math.abs(p - 0.5)));
}
const allY = models.market.y;
const results: any = { samples: samples.length, folds: folds.length, foldTestN: folds.map((f) => f.test.length), models: {}, bootstrap: {}, coverage: {} };
for (const [name, m] of Object.entries(models)) results.models[name] = metrics(m.pred, m.y);
const marketBrier = results.models.market.brier;

function bootDiff(a: number[], b: number[], ys: number[], rounds = 2000) {
  const rnd = seeded(42); const diffs: number[] = [];
  for (let r = 0; r < rounds; r++) { let ba = 0; let bb = 0; for (let i = 0; i < ys.length; i++) { const k = Math.floor(rnd() * ys.length); ba += brier(a[k], ys[k]); bb += brier(b[k], ys[k]); } diffs.push((ba - bb) / ys.length); }
  diffs.sort((x, y) => x - y);
  return { mean: mean(diffs), lo: diffs[Math.floor(diffs.length * 0.025)], hi: diffs[Math.floor(diffs.length * 0.975)] };
}
for (const name of ['stack3', 'stack5']) results.bootstrap[name + '_vs_market'] = bootDiff(models[name].pred, models.market.pred, allY);

function coverageCurve(name: string, fraction: number) {
  const pred = models[name].pred; const conf = coverageConf[name];
  const n = Math.floor(pred.length * fraction);
  const chosen = pred.map((p, i) => ({ i, c: conf[i] })).sort((a, b) => b.c - a.c).slice(0, n);
  return { coverage: fraction, n, brier: metrics(chosen.map((x) => pred[x.i]), chosen.map((x) => allY[x.i])).brier };
}
for (const name of ['market', 'stack3', 'stack5']) results.coverage[name] = [0.1, 0.2, 0.3, 0.5, 1].map((f) => coverageCurve(name, f));
for (const name of ['stack3', 'stack5']) results.models[name].skillVsMarket = 1 - results.models[name].brier / marketBrier;
results.targets = {
  primary: Object.entries(results.models).filter(([n]) => n !== 'market').some(([n, v]: any) => v.brier < marketBrier && results.bootstrap[n + '_vs_market'].hi < 0),
  secondary: results.coverage.stack5.some((x: any) => x.coverage >= 0.2 && x.coverage <= 0.3 && x.n >= 100 && x.brier < 0.2),
};
writeFileSync(OUT_FILE, JSON.stringify(results, null, 2), 'utf8');
console.log(JSON.stringify(results, null, 2));
