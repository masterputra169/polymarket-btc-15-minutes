/** Score the JEV shadow log against settled outcomes (all markets, via Gamma fallback).
 *
 *   node bot/scripts/jevEvaluate.mts [--no-fetch]
 *
 * Joins bot/data/jev_log.jsonl with:
 *   1) bot/data/trade_journal.jsonl (settled bot trades), then
 *   2) Gamma /markets/slug/<slug> for every remaining market (cached in bot/data/jev_outcomes.json).
 * Compares JEV direction/settle probability with the rule side, ML prob and market-implied prob.
 */
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config as loadEnv } from 'dotenv';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
loadEnv({ path: resolve(ROOT, 'bot', '.env'), quiet: true });
const DATA = resolve(ROOT, 'bot', 'data');
const JEV_FILE = process.env.JEV_LOG_FILE || resolve(DATA, 'jev_log.jsonl');
const JOURNAL_FILE = resolve(DATA, 'trade_journal.jsonl');
const CACHE_FILE = resolve(DATA, 'jev_outcomes.json');
const NO_FETCH = process.argv.includes('--no-fetch');

type Row = Record<string, any>;
type Outcome = 'UP' | 'DOWN';
function readJsonl(file: string): Row[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => { try { return JSON.parse(line) as Row; } catch { return null; } }).filter((r): r is Row => r !== null);
}
if (!existsSync(JEV_FILE)) { console.error('No JEV log yet: ' + JEV_FILE); process.exit(2); }

const jev = readJsonl(JEV_FILE);
const journal = readJsonl(JOURNAL_FILE);
// Keep the latest JEV decision per market (restarts can duplicate a slug).
const latest = new Map<string, Row>();
for (const r of jev) {
  const slug = r.slug;
  if (!slug) continue;
  const prev = latest.get(slug);
  if (!prev || Number(r.ts) > Number(prev.ts)) latest.set(slug, r);
}
const rows = [...latest.values()];

const outcomes = new Map<string, Outcome>();
for (const row of journal) {
  const slug = row.entry?.marketSlug ?? row.marketSlug;
  const outcome = row.exit?.verifiedOutcome ?? row.exit?.outcome;
  if (slug && (outcome === 'UP' || outcome === 'DOWN')) outcomes.set(slug, outcome);
}
const cache: Record<string, Outcome> = existsSync(CACHE_FILE) ? (JSON.parse(readFileSync(CACHE_FILE, 'utf8')) as Record<string, Outcome>) : {};
for (const [slug, o] of Object.entries(cache)) if (!outcomes.has(slug)) outcomes.set(slug, o);

function mapWinner(market: Row): Outcome | null {
  let outs = market.outcomes;
  let prices = market.outcomePrices;
  try { if (typeof outs === 'string') outs = JSON.parse(outs); } catch { return null; }
  try { if (typeof prices === 'string') prices = JSON.parse(prices); } catch { return null; }
  if (!Array.isArray(outs) || !Array.isArray(prices) || outs.length !== prices.length) return null;
  let best = 0;
  for (let i = 1; i < prices.length; i++) if (Number(prices[i]) > Number(prices[best])) best = i;
  const label = String(outs[best] ?? '').toLowerCase();
  if (label.includes('up')) return 'UP';
  if (label.includes('down')) return 'DOWN';
  // Generic binary market: first outcome is usually the YES/UP side.
  return best === 0 ? 'UP' : 'DOWN';
}

async function fetchOutcome(slug: string): Promise<Outcome | null> {
  try {
    const res = await fetch('https://gamma-api.polymarket.com/markets/slug/' + encodeURIComponent(slug), { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const json = await res.json() as Row;
    return mapWinner(json);
  } catch { return null; }
}

let fetched = 0;
if (!NO_FETCH) {
  const missing = rows.map(r => r.slug).filter((s): s is string => !!s && !outcomes.has(s));
  const queue = [...new Set(missing)];
  let i = 0;
  async function worker() {
    while (i < queue.length) {
      const slug = queue[i++];
      const o = await fetchOutcome(slug);
      if (o) { outcomes.set(slug, o); cache[slug] = o; fetched++; }
    }
  }
  const started = Date.now();
  await Promise.all(Array.from({ length: 4 }, () => worker()));
  if (fetched > 0) writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
  console.log('Gamma lookup: ' + fetched + ' outcome(s) resolved in ' + ((Date.now() - started) / 1000).toFixed(1) + 's');
} else {
  console.log('--no-fetch: using journal + cached outcomes only (' + [...outcomes.keys()].length + ' known)');
}

const scored = rows.filter(r => r.slug && outcomes.has(r.slug));
if (scored.length === 0) { console.log('No matched entries yet: jev=' + rows.length + ' knownOutcomes=' + outcomes.size); process.exit(0); }

function brier(prob: number, actualUp: boolean): number { return Math.pow(prob - (actualUp ? 1 : 0), 2); }
let dirN = 0, dirOk = 0, noEdge = 0, ruleN = 0, ruleOk = 0;
let settleN = 0, jevBrier = 0, marketN = 0, marketBrier = 0, mlN = 0, mlBrier = 0;
const buckets: Record<string, { n: number; hits: number; conf: number }> = {};
const byRegime: Record<string, { n: number; ok: number; pnl: number }> = {};
for (const row of scored) {
  const actual = outcomes.get(row.slug)!;
  const actualUp = actual === 'UP';
  const dir = row.direction;
  if (dir === 'NO_EDGE') noEdge++;
  else if (dir === 'UP' || dir === 'DOWN') { dirN++; if (dir === actual) dirOk++; }
  const ruleSide = row.rules?.side;
  if (ruleSide === 'UP' || ruleSide === 'DOWN') { ruleN++; if (ruleSide === actual) ruleOk++; }
  const sp = Number(row.settleUpProbability);
  if (Number.isFinite(sp)) { settleN++; jevBrier += brier(sp, actualUp); }
  const mp = Number(row.market?.marketUp);
  if (Number.isFinite(mp)) { marketN++; marketBrier += brier(mp, actualUp); }
  const mlp = Number(row.ml?.probUp);
  if (Number.isFinite(mlp)) { mlN++; mlBrier += brier(mlp, actualUp); }
  const key = sp < 0.2 ? '0-20' : sp < 0.4 ? '20-40' : sp < 0.6 ? '40-60' : sp < 0.8 ? '60-80' : '80-100';
  const b = buckets[key] ?? { n: 0, hits: 0, conf: 0 };
  b.n++; b.conf += sp; if (actualUp) b.hits++; buckets[key] = b;
  const rg = String(row.regime ?? 'unknown');
  const rr = byRegime[rg] ?? { n: 0, ok: 0, pnl: 0 };
  rr.n++; if ((dir === 'UP' || dir === 'DOWN') && dir === actual) rr.ok++;
  byRegime[rg] = rr;
}
const pct = (a: number, b: number) => b > 0 ? (100 * a / b).toFixed(1) + '%' : 'n/a';
console.log('JEV evaluation (all resolvable markets)');
console.log('  matched markets: ' + scored.length + ' (from ' + rows.length + ' unique markets)');
console.log('  direction: ' + dirOk + '/' + dirN + ' = ' + pct(dirOk, dirN) + ' (NO_EDGE ' + noEdge + ', coverage ' + pct(dirN, scored.length) + ')');
console.log('  rule side: ' + ruleOk + '/' + ruleN + ' = ' + pct(ruleOk, ruleN));
console.log('  Brier settle-up: JEV ' + (settleN ? (jevBrier / settleN).toFixed(4) : 'n/a') + ' (n=' + settleN + ')' +
  ' | market ' + (marketN ? (marketBrier / marketN).toFixed(4) : 'n/a') + ' (n=' + marketN + ')' +
  ' | ML ' + (mlN ? (mlBrier / mlN).toFixed(4) : 'n/a') + ' (n=' + mlN + ')');
console.log('  calibration (JEV settle-up):');
for (const key of Object.keys(buckets).sort()) { const b = buckets[key]; console.log('    ' + key + '%: n=' + b.n + ' avg=' + (b.conf / b.n).toFixed(2) + ' up-rate=' + (b.hits / b.n).toFixed(2)); }
console.log('  by JEV regime:');
for (const [rg, v] of Object.entries(byRegime).sort()) console.log('    ' + rg + ': n=' + v.n + ' dir-acc=' + pct(v.ok, v.n));
