/**
 * PTB-impact study — how much the wrong price to beat, and comparing Binance
 * with it, changed what the bot saw and decided (2026-09-25 PTB fix, cc24b5c).
 *
 *   node backtest/ml_training/ptbImpactStudy.mts [--until 2026-09-25T16:53:38Z] [--tape DIR] [--offline]
 *
 * Old view  = what the bot used: Binance (`btc` on the tape) minus its own PTB
 *             (`ptb`, the spot capture at the boundary).
 * New view  = the fix: Chainlink settlement estimate (`pl`, final-minute TWAP
 *             aware) minus Polymarket's published PTB (Gamma eventMetadata).
 * Outcome   = Gamma: finalPrice >= priceToBeat → UP.
 *
 * Sections:
 *  1. who is ahead, second by second — how often the old and new views
 *     disagree, and how often each one names the eventual winner;
 *  2. the distance error (old − new), i.e. the bias the bot traded on;
 *  3. filter replay — every ENTER decision whose filters ran, with 4c (BTC
 *     distance) and 11c (trending ML floor) recomputed on the corrected values;
 *     decisions that flip, and the trades each gate set would have taken (first
 *     qualifying second per market, last print + 1c, fee on profit);
 *  4. the rule score's PTB-distance indicator: how often its direction changes.
 *     Its effect on ENTER/WAIT is not replayable (other indicator votes are not
 *     on the tape).
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { gunzipSync, constants as zc } from 'zlib';
import { fetchJsonWithPolymarketDoh } from '../../bot/src/services/polymarketHttp.ts';
import {
  officialOutcome, settleFromTape, replayGates, ptbIndicator, type Side, type SpotSample,
} from './ptbImpactCore.mts';
import { simulateTrade, summarizeTrades, filtersRan, type SimTrade } from './decisionTrailCore.mts';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const TAPE = resolve(arg('tape') ?? join(HERE, 'tape'));
const UNTIL = Date.parse(arg('until') ?? '2026-09-25T16:53:38Z');
const OFFLINE = argv.includes('--offline');

// ── load the tape ────────────────────────────────────────────────────────────
type S = { t: number; m: string; ptb: number | null; btc: number | null; pl: number | null };
type D = { t: number; m: string; a: string; sd: string | null; mc: number | null; eu: number | null; ed: number | null; pu: number | null; pd: number | null; tl: number | null; rg: string | null; st: string; fr?: string[] };
const snaps = new Map<string, S[]>();
const decisions: D[] = [];
for (const day of readdirSync(TAPE).filter(d => /^\d{4}-\d\d-\d\d$/.test(d)).sort()) {
  for (const f of readdirSync(join(TAPE, day)).filter(n => n.endsWith('.jsonl.gz')).sort()) {
    let text: string;
    try { text = gunzipSync(readFileSync(join(TAPE, day, f)), { finishFlush: zc.Z_SYNC_FLUSH }).toString('utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.startsWith('{"k":"s"') && !line.startsWith('{"k":"d"')) continue;
      let l: any;
      try { l = JSON.parse(line); } catch { continue; }
      if (!l.m || l.t > UNTIL) continue;
      if (l.k === 's') {
        const arr = snaps.get(l.m) ?? [];
        arr.push({ t: l.t, m: l.m, ptb: l.ptb ?? null, btc: l.btc ?? null, pl: l.pl ?? null });
        snaps.set(l.m, arr);
      } else decisions.push(l);
    }
  }
}
for (const arr of snaps.values()) arr.sort((a, b) => a.t - b.t);
decisions.sort((a, b) => a.t - b.t);

// ── official PTB and close per market (Gamma, cached) ────────────────────────
const cachePath = join(TAPE, '_ptb_official.json');
const official: Record<string, { ptb: number | null; final: number | null }> = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : {};
const need = [...snaps.keys()].filter(m => !(m in official) || official[m].final == null);
if (!OFFLINE) {
  let i = 0;
  for (const m of need) {
    const start = Number(m.split('-').pop()) * 1000;
    if (start + 20 * 60_000 > Date.now()) continue; // not settled yet
    try {
      const ev: any = await fetchJsonWithPolymarketDoh(`https://gamma-api.polymarket.com/events/slug/${m}`, { timeoutMs: 10_000, label: 'Gamma event' });
      const ptb = Number(ev?.eventMetadata?.priceToBeat); const fin = Number(ev?.eventMetadata?.finalPrice);
      official[m] = { ptb: Number.isFinite(ptb) ? ptb : null, final: Number.isFinite(fin) ? fin : null };
    } catch { /* retry next run */ }
    if (++i % 25 === 0) writeFileSync(cachePath, JSON.stringify(official));
  }
  writeFileSync(cachePath, JSON.stringify(official));
}
// The next window's PTB is this window's close (129/129 on 2026-09-25) — fills a missing finalPrice.
for (const m of Object.keys(official)) {
  if (official[m].final == null) {
    const next = `btc-updown-15m-${Number(m.split('-').pop()) + 900}`;
    if (official[next]?.ptb != null) official[m].final = official[next].ptb;
  }
}

const pct = (x: number | null, dp = 1) => x == null ? '   —' : `${(x * 100).toFixed(dp)}%`;
const usd = (x: number) => `${x >= 0 ? '+' : '−'}$${Math.abs(x).toFixed(2)}`;
const q = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };

const markets = [...snaps.keys()].filter(m => official[m]?.ptb != null && official[m]?.final != null).sort();
console.log(`Tape ${TAPE}\nWindow: up to ${new Date(UNTIL).toISOString()} (the old code); ${markets.length} markets with a published PTB and close, ${decisions.length} decision lines\n`);

// ── 1 + 2: who is ahead, second by second ────────────────────────────────────
const buckets = [
  { name: '> 10 min left', lo: 600, hi: Infinity }, { name: '5–10 min', lo: 300, hi: 600 },
  { name: '1–5 min', lo: 60, hi: 300 }, { name: '< 1 min', lo: -Infinity, hi: 60 },
];
const agg = buckets.map(() => ({ n: 0, disagree: 0, oldRight: 0, newRight: 0 }));
const distErr: number[] = [];
const cache = new Map<string, SpotSample[]>();
const spotOf = (m: string) => {
  let s = cache.get(m);
  if (!s) { s = (snaps.get(m) ?? []).filter(x => x.pl != null).map(x => ({ t: x.t, pl: x.pl! })); cache.set(m, s); }
  return s;
};
for (const m of markets) {
  const o = official[m];
  const outcome = officialOutcome(o.ptb, o.final)!;
  const end = (Number(m.split('-').pop()) + 900) * 1000;
  const spot = spotOf(m);
  for (const s of snaps.get(m)!) {
    if (s.btc == null || s.ptb == null || s.t > end) continue;
    const settle = settleFromTape(spot, s.t, end);
    if (settle == null) continue;
    const oldD = s.btc - s.ptb;
    const newD = settle - o.ptb!;
    distErr.push(oldD - newD);
    const left = (end - s.t) / 1000;
    const b = buckets.findIndex(x => left > x.lo && left <= x.hi);
    if (b < 0) continue;
    const oldSide: Side = oldD >= 0 ? 'UP' : 'DOWN';
    const newSide: Side = newD >= 0 ? 'UP' : 'DOWN';
    const a = agg[b];
    a.n++;
    if (oldSide !== newSide) a.disagree++;
    if (oldSide === outcome) a.oldRight++;
    if (newSide === outcome) a.newRight++;
  }
}
console.log('1. Who is ahead now — old view (Binance − bot PTB) vs corrected (Chainlink estimate − official PTB)');
console.log('   time left       seconds   views disagree   old names winner   corrected names winner');
buckets.forEach((b, i) => {
  const a = agg[i];
  console.log(`   ${b.name.padEnd(14)} ${String(a.n).padStart(8)}   ${pct(a.n ? a.disagree / a.n : null).padStart(13)}   ${pct(a.n ? a.oldRight / a.n : null).padStart(15)}   ${pct(a.n ? a.newRight / a.n : null).padStart(19)}`);
});
const mean = distErr.reduce((x, y) => x + y, 0) / (distErr.length || 1);
console.log(`\n2. Distance error the bot traded on (old distance − corrected), ${distErr.length} seconds:`);
console.log(`   mean ${usd(mean)} · median ${usd(q(distErr, 0.5))} · p5 ${usd(q(distErr, 0.05))} · p95 ${usd(q(distErr, 0.95))} · |err| > $20 in ${pct(distErr.filter(x => Math.abs(x) > 20).length / (distErr.length || 1))}`);

// ── 3: filter replay on ENTER decisions ──────────────────────────────────────
const outcomeOf = (m: string): Side | null => officialOutcome(official[m]?.ptb ?? null, official[m]?.final ?? null);
const replayed: { d: D; oldPass: boolean; newPass: boolean; oldGates: string[]; newGates: string[] }[] = [];
for (const d of decisions) {
  if (d.a !== 'E' || !filtersRan(d as any) || official[d.m]?.ptb == null) continue;
  const side: Side | null = d.sd === 'U' ? 'UP' : d.sd === 'D' ? 'DOWN' : null;
  const end = (Number(d.m.split('-').pop()) + 900) * 1000;
  const settle = settleFromTape(spotOf(d.m), d.t, end);
  const r = replayGates(d.fr ?? [], { price: settle, ptb: official[d.m].ptb }, {
    side, mlConf: d.mc, timeLeftMin: d.tl, regime: d.rg, bestEdge: side === 'UP' ? d.eu : side === 'DOWN' ? d.ed : null,
  });
  replayed.push({ d, ...r });
}
const nb = replayed.filter(r => r.oldPass && !r.newPass);
const np = replayed.filter(r => !r.oldPass && r.newPass);
const gateFlips = (list: typeof replayed, key: 'newGates' | 'oldGates') => {
  const c: Record<string, number> = {};
  for (const r of list) for (const g of r[key]) if (g === 'btc_dist' || g === 'trending_ml') c[g] = (c[g] ?? 0) + 1;
  return JSON.stringify(c);
};
const marketsOf = (list: typeof replayed) => new Set(list.map(r => r.d.m)).size;
console.log(`\n3. Filter replay — ${replayed.length} ENTER decisions whose filters ran (${marketsOf(replayed)} markets)`);
console.log(`   passed before, blocked now:  ${nb.length} decisions in ${marketsOf(nb)} markets  (new blocks ${gateFlips(nb, 'newGates')})`);
console.log(`   blocked before, passing now: ${np.length} decisions in ${marketsOf(np)} markets  (old blocks removed ${gateFlips(np, 'oldGates')})`);
const firstPerMarket = (list: typeof replayed) => {
  const seen = new Set<string>(); const out: SimTrade[] = [];
  for (const r of list) {
    if (seen.has(r.d.m)) continue;
    const t = simulateTrade(r.d as any, outcomeOf(r.d.m));
    if (t) { seen.add(r.d.m); out.push(t); }
  }
  return out;
};
const line = (label: string, tr: SimTrade[]) => {
  const s = summarizeTrades(tr);
  const ci = s.ci ? ` [${pct(s.ci[0], 0)}–${pct(s.ci[1], 0)}]` : '';
  console.log(`   ${label.padEnd(34)} n=${String(s.n).padStart(3)}  WR ${pct(s.winRate)}${ci}  paid ${s.avgPrice != null ? (s.avgPrice * 100).toFixed(1) + 'c' : '—'}  BE ${pct(s.breakeven)}  ROI ${pct(s.roi)}  PnL/$1 ${s.pnl.toFixed(2)}`);
};
console.log('\n   Trades each gate set would take (first passing second per market, last print + 1c):');
line('bot filters as they ran (old)', firstPerMarket(replayed.filter(r => r.oldPass)));
line('with the corrected PTB/price', firstPerMarket(replayed.filter(r => r.newPass)));
line('  of which: markets no longer traded', firstPerMarket(nb).filter(t => !firstPerMarket(replayed.filter(r => r.newPass)).some(x => x.slug === t.slug)));
line('  of which: markets newly traded', firstPerMarket(np).filter(t => !firstPerMarket(replayed.filter(r => r.oldPass)).some(x => x.slug === t.slug)));
const flipped = [...new Set([...nb, ...np].map(r => r.d.m))];
if (flipped.length) {
  console.log('\n   Markets with a flipped decision:');
  for (const m of flipped) {
    const o = official[m];
    const rs = [...nb, ...np].filter(r => r.d.m === m);
    const side = rs[0].d.sd === 'U' ? 'UP' : 'DOWN';
    const kind = nb.some(r => r.d.m === m) ? 'now blocked' : 'now passes';
    console.log(`   ${m}  ${kind.padEnd(11)} side ${side.padEnd(4)} × ${rs.length} s  outcome ${outcomeOf(m)}  (PTB ${o.ptb!.toFixed(2)}, close ${o.final!.toFixed(2)})`);
  }
}

// ── 4: the rule score's PTB-distance indicator ───────────────────────────────
let n4 = 0, changed4 = 0, reversed4 = 0;
for (const d of decisions) {
  if (official[d.m]?.ptb == null) continue;
  const sn = snaps.get(d.m); if (!sn) continue;
  let s: S | null = null;
  for (const x of sn) if (x.t <= d.t) s = x; else break;
  if (!s || s.btc == null || s.ptb == null) continue;
  const end = (Number(d.m.split('-').pop()) + 900) * 1000;
  const oldI = ptbIndicator(s.btc, s.ptb);
  const newI = ptbIndicator(settleFromTape(spotOf(d.m), d.t, end), official[d.m].ptb);
  if (!oldI || !newI) continue;
  n4++;
  if (oldI !== newI) changed4++;
  if ((oldI === 'UP' && newI === 'DOWN') || (oldI === 'DOWN' && newI === 'UP')) reversed4++;
}
console.log(`\n4. Rule-score PTB-distance indicator (±0.05% neutral band), ${n4} decision seconds:`);
console.log(`   direction changed in ${pct(n4 ? changed4 / n4 : null)}, fully reversed (UP↔DOWN) in ${pct(n4 ? reversed4 / n4 : null)}.`);
console.log('   Not replayable into ENTER/WAIT: the agreement count also needs RSI/MACD/… votes the tape does not carry.');

// ── 5: the leader in the final minutes vs the token price (a lead, not a result) ─
// With the corrected view, how often does the side ahead win, against what its
// token costs? Seconds are not independent (one market gives ~120 of them), so
// the per-market view — one entry at the first qualifying second, best ask + 1c —
// is the one to read; both are shown. All markets on the tape, old and new code.
{
  type Row = { m: string; t: number; ask: number; won: boolean };
  const rows: Record<string, Row[]> = {};
  const allSnaps = new Map<string, any[]>();
  for (const day of readdirSync(TAPE).filter(d => /^\d{4}-\d\d-\d\d$/.test(d)).sort()) {
    for (const f of readdirSync(join(TAPE, day)).filter(n => n.endsWith('.jsonl.gz')).sort()) {
      let text: string;
      try { text = gunzipSync(readFileSync(join(TAPE, day, f)), { finishFlush: zc.Z_SYNC_FLUSH }).toString('utf8'); } catch { continue; }
      for (const line of text.split('\n')) {
        if (!line.startsWith('{"k":"s"')) continue;
        let l: any; try { l = JSON.parse(line); } catch { continue; }
        if (!l.m || !l.u || !l.d) continue;
        (allSnaps.get(l.m) ?? allSnaps.set(l.m, []).get(l.m)!).push(l);
      }
    }
  }
  for (const [m, arr] of allSnaps) {
    const o = official[m];
    const out = officialOutcome(o?.ptb ?? null, o?.final ?? null);
    if (!out) continue;
    arr.sort((a, b) => a.t - b.t);
    const end = (Number(m.split('-').pop()) + 900) * 1000;
    const spot = arr.filter(x => x.pl != null).map(x => ({ t: x.t, pl: x.pl }));
    for (const s of arr) {
      const left = (end - s.t) / 1000;
      if (left <= 3 || left > 180) continue;
      const est = settleFromTape(spot, s.t, end);
      if (est == null) continue;
      const lead: Side = est >= o.ptb! ? 'UP' : 'DOWN';
      const asks = (lead === 'UP' ? s.u : s.d).a as [number, number][] | undefined;
      if (!asks?.length) continue;
      const ask = Math.min(...asks.map(a => a[0]));
      const gap = Math.abs(est - o.ptb!);
      const key = `${left <= 60 ? '≤ 60 s' : '60–180 s'} left, lead ${gap < 10 ? '< $10' : gap < 30 ? '$10–30' : '≥ $30'}`;
      (rows[key] ??= []).push({ m, t: s.t, ask, won: lead === out });
    }
  }
  console.log('\n5. The side ahead (corrected view) in the last 3 minutes vs its token price — a lead to test, not a result');
  console.log('   bucket                         seconds  leader WR  avg ask | markets  WR [95% CI]         paid   BE     ROI');
  for (const k of Object.keys(rows).sort()) {
    const r = rows[k];
    const wr = r.filter(x => x.won).length / r.length;
    const ask = r.reduce((a, x) => a + x.ask, 0) / r.length;
    const seen = new Set<string>();
    const trades: SimTrade[] = [];
    for (const x of r) {
      if (seen.has(x.m)) continue;
      seen.add(x.m);
      const price = Math.min(0.99, x.ask + 0.01);
      trades.push({ slug: x.m, t: x.t, side: 'UP', price, won: x.won });
    }
    const s = summarizeTrades(trades);
    const ci = s.ci ? `[${pct(s.ci[0], 0)}–${pct(s.ci[1], 0)}]` : '';
    console.log(`   ${k.padEnd(30)} ${String(r.length).padStart(7)}  ${pct(wr).padStart(8)}  ${(ask * 100).toFixed(1).padStart(5)}c | ${String(s.n).padStart(5)}    ${pct(s.winRate)} ${ci.padEnd(12)} ${s.avgPrice != null ? (s.avgPrice * 100).toFixed(1) + 'c' : '—'}  ${pct(s.breakeven)}  ${pct(s.roi)}`);
  }
  console.log('   Caveats: 2 days of tape; entries this late are blocked by the bot today (too-close gate); fills at the');
  console.log('   ask assume the book is still there ~1 s later. Needs a month-long test (price-history API) before any rule.');
}
