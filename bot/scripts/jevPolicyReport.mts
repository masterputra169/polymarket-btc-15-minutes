/** Fixed-policy JEV forward shadow report (record-only).
 *
 *   node --env-file=./.env scripts/jevPolicyReport.mts [--no-fetch]
 *
 * Reads data/jev_policy.jsonl (candidates written by jevPolicyShadow.ts), resolves
 * each market via the journal first and Gamma /markets/slug/<slug> otherwise,
 * computes outcome/PnL/fee/Brier and compares with the bot's journal entries on
 * the same markets. Writes data/jev_policy_report.json.
 */
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { config as loadEnv } from 'dotenv';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
loadEnv({ path: resolve(ROOT, 'bot', '.env'), quiet: true });
const DATA = resolve(ROOT, 'bot', 'data');
const POLICY_FILE = resolve(DATA, 'jev_policy.jsonl');
const JOURNAL_FILE = resolve(DATA, 'trade_journal.jsonl');
const CACHE_FILE = resolve(DATA, 'jev_policy_outcomes.json');
const REPORT_FILE = resolve(DATA, 'jev_policy_report.json');
const NO_FETCH = process.argv.includes('--no-fetch');

type Row = Record<string, any>;
type Outcome = 'UP' | 'DOWN';

function readJsonl(file: string): Row[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line) as Row; } catch { return null; }
  }).filter((r): r is Row => r !== null);
}
if (!existsSync(POLICY_FILE)) { console.error('No policy log yet: ' + POLICY_FILE); process.exit(2); }

const raw = readJsonl(POLICY_FILE);
const bySlug = new Map<string, Row>();
for (const r of raw) {
  if (!r.slug) continue;
  const prev = bySlug.get(r.slug);
  if (!prev || Number(r.ts) < Number(prev.ts)) bySlug.set(r.slug, r);
}
const candidates = [...bySlug.values()];
const journal = readJsonl(JOURNAL_FILE);
const botBySlug = new Map<string, Row>();
for (const row of journal) {
  const slug = row.entry?.marketSlug;
  if (!slug) continue;
  if (!botBySlug.has(slug)) botBySlug.set(slug, row);
}

const outcomes = new Map<string, Outcome>();
for (const row of journal) {
  const slug = row.entry?.marketSlug;
  const outcome = row.exit?.verifiedOutcome ?? row.exit?.outcome;
  if (slug && (outcome === 'UP' || outcome === 'DOWN')) outcomes.set(slug, outcome);
}
const cache: Record<string, Outcome> = existsSync(CACHE_FILE) ? (JSON.parse(readFileSync(CACHE_FILE, 'utf8')) as Record<string, Outcome>) : {};
for (const [slug, o] of Object.entries(cache)) if (!outcomes.has(slug)) outcomes.set(slug, o as Outcome);

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
  return best === 0 ? 'UP' : 'DOWN';
}
async function fetchOutcome(slug: string): Promise<Outcome | null> {
  try {
    const res = await fetch('https://gamma-api.polymarket.com/markets/slug/' + encodeURIComponent(slug), { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    return mapWinner(await res.json() as Row);
  } catch { return null; }
}

let fetched = 0;
if (!NO_FETCH) {
  const missing = candidates.map(c => String(c.slug)).filter(slug => !outcomes.has(slug));
  let i = 0;
  async function worker() {
    while (i < missing.length) {
      const slug = missing[i++];
      const o = await fetchOutcome(slug);
      if (o) { outcomes.set(slug, o); cache[slug] = o; fetched++; }
    }
  }
  await Promise.all(Array.from({ length: 4 }, () => worker()));
  if (fetched > 0) writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
}
console.log('Gamma lookup: ' + fetched + ' outcome(s) resolved');

const pct = (a: number, b: number) => b > 0 ? (100 * a / b).toFixed(1) + '%' : 'n/a';
const round = (x: number, dp = 4) => Math.round(x * 10 ** dp) / 10 ** dp;
let resolved = 0, dirN = 0, dirOk = 0, wins = 0, policyPnl = 0, policyCost = 0;
let settleN = 0, settleBrier = 0, marketN = 0, marketBrier = 0;
let botOverlap = 0, botPnl = 0, botWins = 0, policyOnBotPnl = 0;
const resolvedRows: Row[] = [];
for (const c of candidates) {
  const outcome = outcomes.get(String(c.slug));
  if (outcome !== 'UP' && outcome !== 'DOWN') continue;
  resolved++;
  const actualUp = outcome === 'UP';
  const dir = c.direction;
  const win = dir === outcome;
  const ask = Number(c.ask);
  const fee = Number.isFinite(ask) ? 0.07 * ask * (1 - ask) : 0;
  const pnl = win ? 1 - ask - fee : -ask - fee;
  policyPnl += pnl;
  policyCost += ask;
  if (win) wins++;
  if (dir === 'UP' || dir === 'DOWN') { dirN++; if (win) dirOk++; }
  const sp = Number(c.settleUpProbability);
  if (Number.isFinite(sp)) { settleN++; settleBrier += Math.pow(sp - (actualUp ? 1 : 0), 2); }
  const mp = Number(c.marketUp);
  if (Number.isFinite(mp)) { marketN++; marketBrier += Math.pow(mp - (actualUp ? 1 : 0), 2); }
  const botRow = botBySlug.get(String(c.slug));
  let botPnlRow: number | null = null;
  let botSide: string | null = null;
  if (botRow) {
    botOverlap++;
    botSide = botRow.entry?.side ?? null;
    botPnlRow = Number(botRow.analysis?.pnl);
    if (Number.isFinite(botPnlRow)) { botPnl += botPnlRow; policyOnBotPnl += pnl; }
    if (botSide === outcome) botWins++;
  }
  resolvedRows.push({
    slug: c.slug, iso: c.iso, direction: dir, confidence: c.confidence, pSide: c.pSide,
    ask, edge: c.edge, outcome, win, fee: round(fee), pnl: round(pnl),
    botTraded: !!botRow, botSide, botPnl: Number.isFinite(botPnlRow as number) ? round(botPnlRow as number) : null,
  });
}
const open = candidates.length - resolved;
const report = {
  generatedAt: new Date().toISOString(),
  candidateMarkets: candidates.length,
  resolvedMarkets: resolved,
  openMarkets: open,
  progressTo100: resolved + '/100 resolved markets',
  direction: { n: dirN, correct: dirOk, accuracy: dirN ? round(dirOk / dirN) : null },
  brier: {
    jevSettleUp: settleN ? round(settleBrier / settleN) : null,
    marketUp: marketN ? round(marketBrier / marketN) : null,
    n: settleN,
  },
  policy: {
    wins, resolved, winRate: resolved ? round(wins / resolved) : null,
    pnlPerShare: round(policyPnl), roi: policyCost > 0 ? round(policyPnl / policyCost) : null,
    avgAsk: resolved ? round(policyCost / resolved) : null,
  },
  botOverlap: {
    markets: botOverlap, botWins, botPnl: round(botPnl),
    policyPnlOnSameMarkets: round(policyOnBotPnl),
  },
  rows: resolvedRows,
};
writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2), 'utf8');
console.log('JEV fixed-policy forward shadow');
console.log('  candidate markets: ' + candidates.length + ' (resolved ' + resolved + ', open ' + open + ')');
console.log('  progress: ' + report.progressTo100);
console.log('  direction: ' + dirOk + '/' + dirN + ' = ' + pct(dirOk, dirN));
console.log('  Brier settle-up: JEV ' + (report.brier.jevSettleUp ?? 'n/a') + ' | market ' + (report.brier.marketUp ?? 'n/a') + ' (n=' + settleN + ')');
console.log('  policy: WR ' + pct(wins, resolved) + ' | PnL/share ' + report.policy.pnlPerShare + ' | ROI ' + (report.policy.roi != null ? (100 * report.policy.roi).toFixed(1) + '%' : 'n/a') + ' | avgAsk ' + (report.policy.avgAsk ?? 'n/a'));
console.log('  bot overlap: ' + botOverlap + ' markets | bot PnL ' + report.botOverlap.botPnl + ' | policy PnL on those ' + report.botOverlap.policyPnlOnSameMarkets);
console.log('  report: ' + REPORT_FILE);
