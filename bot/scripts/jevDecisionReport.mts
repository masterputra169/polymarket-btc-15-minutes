/** Entry-time JEV decision shadow report (record-only).
 *
 *   node --env-file=./.env scripts/jevDecisionReport.mts [--no-fetch]
 *
 * Reads data/jev_decision.jsonl, resolves outcomes from the journal/Gamma, and
 * reports: direction/Brier, hypothetical fixed-policy PnL, agreement with the
 * fixed-policy sample and with the bot's actual side, and what a JEV veto would
 * have done to the bot's entries.
 */
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { config as loadEnv } from 'dotenv';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
loadEnv({ path: resolve(ROOT, 'bot', '.env'), quiet: true });
const DATA = resolve(ROOT, 'bot', 'data');
const DECISION_FILE = resolve(DATA, 'jev_decision.jsonl');
const SAMPLE_FILE = resolve(DATA, 'jev_log.jsonl');
const JOURNAL_FILE = resolve(DATA, 'trade_journal.jsonl');
const CACHE_FILE = resolve(DATA, 'jev_decision_outcomes.json');
const REPORT_FILE = resolve(DATA, 'jev_decision_report.json');
const NO_FETCH = process.argv.includes('--no-fetch');

type Row = Record<string, any>;
type Outcome = 'UP' | 'DOWN';
function readJsonl(file: string): Row[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line) as Row; } catch { return null; }
  }).filter((r): r is Row => r !== null);
}
if (!existsSync(DECISION_FILE)) { console.error('No decision log yet: ' + DECISION_FILE); process.exit(2); }
const raw = readJsonl(DECISION_FILE);
const bySlug = new Map<string, Row>();
for (const r of raw) {
  if (!r.slug) continue;
  const prev = bySlug.get(r.slug);
  if (!prev || Number(r.ts) < Number(prev.ts)) bySlug.set(r.slug, r);
}
const decisions = [...bySlug.values()];
const journal = readJsonl(JOURNAL_FILE);
const botBySlug = new Map<string, Row>();
for (const row of journal) {
  const slug = row.entry?.marketSlug;
  if (slug && !botBySlug.has(slug)) botBySlug.set(slug, row);
}
const outcomes = new Map<string, Outcome>();
for (const row of journal) {
  const slug = row.entry?.marketSlug;
  const outcome = row.exit?.verifiedOutcome ?? row.exit?.outcome;
  if (slug && (outcome === 'UP' || outcome === 'DOWN')) outcomes.set(slug, outcome);
}
const cache: Record<string, Outcome> = existsSync(CACHE_FILE) ? JSON.parse(readFileSync(CACHE_FILE, 'utf8')) : {};
for (const [slug, o] of Object.entries(cache)) if (!outcomes.has(slug)) outcomes.set(slug, o);

// Fixed-policy sample (non-refresh calls, latest per market) for agreement.
const sampleBySlug = new Map<string, Row>();
for (const r of readJsonl(SAMPLE_FILE)) {
  if (!r.slug || r.entryRefresh) continue;
  const prev = sampleBySlug.get(r.slug);
  if (!prev || Number(r.ts) > Number(prev.ts)) sampleBySlug.set(r.slug, r);
}
function mapWinner(market: Row): Outcome | null {
  // Gamma returns a live placeholder with 0.5/0.5 prices for an open market.
  if (market.closed !== true) return null;
  let outs = market.outcomes;
  let prices = market.outcomePrices;
  try { if (typeof outs === 'string') outs = JSON.parse(outs); } catch { return null; }
  try { if (typeof prices === 'string') prices = JSON.parse(prices); } catch { return null; }
  if (!Array.isArray(outs) || !Array.isArray(prices) || outs.length !== prices.length) return null;
  // A resolved binary market must be closed and priced 1/0, not 0.5/0.5.
  const numericPrices = prices.map(Number);
  if (!numericPrices.some(p => p >= 0.99) || !numericPrices.some(p => p <= 0.01)) return null;
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
  const missing = decisions.map(d => String(d.slug)).filter(slug => !outcomes.has(slug));
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
let resolved = 0, dirN = 0, dirOk = 0, settleN = 0, settleBrier = 0, marketBrierN = 0, marketBrier = 0;
let gateTrades = 0, gateWins = 0, gatePnl = 0, gateCost = 0;
let botOverlap = 0, botWins = 0, botPnl = 0, oppose = 0, opposeBotWins = 0, opposeBotPnl = 0;
let sampleN = 0, sampleAgree = 0;
const rows: Row[] = [];
for (const d of decisions) {
  const outcome = outcomes.get(String(d.slug));
  if (outcome !== 'UP' && outcome !== 'DOWN') continue;
  resolved++;
  const actualUp = outcome === 'UP';
  const dir = d.direction;
  const win = dir === outcome;
  const sp = Number(d.settleUpProbability);
  if (Number.isFinite(sp)) { settleN++; settleBrier += Math.pow(sp - (actualUp ? 1 : 0), 2); }
  const mp = Number(d.market?.marketUp);
  if (Number.isFinite(mp)) { marketBrierN++; marketBrier += Math.pow(mp - (actualUp ? 1 : 0), 2); }
  if (dir === 'UP' || dir === 'DOWN') { dirN++; if (win) dirOk++; }
  const pSide = Number(dir === 'UP' ? d.directionProbabilities?.UP : d.directionProbabilities?.DOWN);
  const ask = Number(dir === 'UP' ? d.market?.marketUp : d.market?.marketDown);
  const conf = Number(d.directionConfidence);
  const gate = (dir === 'UP' || dir === 'DOWN') && conf > 0.60 && Number.isFinite(ask) && ask > 0 && ask <= 0.70 && Number.isFinite(pSide) && pSide - ask >= 0.10;
  if (gate) {
    const fee = 0.07 * ask * (1 - ask);
    const pnl = win ? 1 - ask - fee : -ask - fee;
    gateTrades++; gatePnl += pnl; gateCost += ask; if (win) gateWins++;
  }
  const botRow = botBySlug.get(String(d.slug));
  let botSide: string | null = null, botPnlRow: number | null = null, botWin: boolean | null = null;
  if (botRow) {
    botOverlap++;
    botSide = botRow.entry?.side ?? null;
    botPnlRow = Number(botRow.analysis?.pnl);
    botWin = botSide === outcome;
    if (botWin) botWins++;
    if (Number.isFinite(botPnlRow)) botPnl += botPnlRow;
    if ((dir === 'UP' || dir === 'DOWN') && botSide && dir !== botSide) {
      oppose++;
      if (botWin) opposeBotWins++;
      if (Number.isFinite(botPnlRow)) opposeBotPnl += botPnlRow;
    }
  }
  const sample = sampleBySlug.get(String(d.slug));
  let sampleDir: string | null = null, agree: boolean | null = null;
  if (sample && (sample.direction === 'UP' || sample.direction === 'DOWN')) {
    sampleDir = sample.direction;
    if (dir === 'UP' || dir === 'DOWN') { sampleN++; agree = sampleDir === dir; if (agree) sampleAgree++; }
  }
  rows.push({
    slug: d.slug, iso: d.iso, direction: dir, confidence: conf, pSide: Number.isFinite(pSide) ? round(pSide) : null,
    ask: Number.isFinite(ask) ? ask : null, edge: Number.isFinite(pSide) && Number.isFinite(ask) ? round(pSide - ask) : null,
    outcome, win, gate, sampleDir, sampleAgree: agree, botSide, botWin,
    botPnl: Number.isFinite(botPnlRow as number) ? round(botPnlRow as number) : null,
  });
}
const report = {
  generatedAt: new Date().toISOString(),
  decisions: decisions.length, resolved, open: decisions.length - resolved,
  direction: { n: dirN, correct: dirOk, accuracy: dirN ? round(dirOk / dirN) : null },
  brier: { jevSettleUp: settleN ? round(settleBrier / settleN) : null, marketUp: marketBrierN ? round(marketBrier / marketBrierN) : null, n: settleN },
  gate: { trades: gateTrades, wins: gateWins, winRate: gateTrades ? round(gateWins / gateTrades) : null, pnlPerShare: round(gatePnl), roi: gateCost > 0 ? round(gatePnl / gateCost) : null },
  botOverlap: { markets: botOverlap, botWins, botPnl: round(botPnl), opposed: oppose, opposedBotWins: opposeBotWins, opposedBotPnl: round(opposeBotPnl) },
  sampleAgreement: { n: sampleN, agree: sampleAgree, rate: sampleN ? round(sampleAgree / sampleN) : null },
  rows,
};
writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2), 'utf8');
console.log('JEV entry-time decision shadow');
console.log('  decisions: ' + decisions.length + ' (resolved ' + resolved + ', open ' + (decisions.length - resolved) + ')');
console.log('  direction: ' + dirOk + '/' + dirN + ' = ' + pct(dirOk, dirN));
console.log('  Brier settle-up: JEV ' + (report.brier.jevSettleUp ?? 'n/a') + ' | market ' + (report.brier.marketUp ?? 'n/a') + ' (n=' + settleN + ')');
console.log('  hypothetical gate: trades ' + gateTrades + ' | WR ' + pct(gateWins, gateTrades) + ' | PnL/share ' + report.gate.pnlPerShare + ' | ROI ' + (report.gate.roi != null ? (100 * report.gate.roi).toFixed(1) + '%' : 'n/a'));
console.log('  bot overlap: ' + botOverlap + ' markets | bot PnL ' + report.botOverlap.botPnl + ' | opposed ' + oppose + ' (bot won ' + opposeBotWins + ', PnL ' + report.botOverlap.opposedBotPnl + ')');
console.log('  sample agreement: ' + sampleAgree + '/' + sampleN + ' = ' + pct(sampleAgree, sampleN));
console.log('  report: ' + REPORT_FILE);
