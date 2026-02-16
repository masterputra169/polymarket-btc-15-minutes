/**
 * Trade journal analyzer — reads from state.json (same source as Position Panel).
 * Guaranteed in sync with dashboard stats.
 *
 * Usage: node bot/data/_analyze.mjs
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const state = JSON.parse(readFileSync(resolve(__dirname, 'state.json'), 'utf-8'));

const trades = state.trades || [];

// ── Pair ENTER → EXIT (SETTLE/CUT_LOSS/UNWIND/PARTIAL_CUT) ──
const paired = [];
let currentEntry = null;

for (const t of trades) {
  if (t.type === 'ENTER') {
    currentEntry = t;
  } else if (currentEntry && ['SETTLE', 'CUT_LOSS', 'UNWIND', 'PARTIAL_CUT', 'FORCE_UNWIND'].includes(t.type)) {
    paired.push({
      side: currentEntry.side,
      entryPrice: currentEntry.price,
      size: currentEntry.size,
      cost: currentEntry.cost,
      marketSlug: currentEntry.marketSlug,
      entryTime: currentEntry.timestamp,
      exitTime: t.timestamp,
      outcome: t.type === 'SETTLE' ? (t.won ? 'WIN' : 'LOSS') : t.type,
      pnl: t.pnl ?? 0,
      payout: t.payout ?? 0,
      bankrollAfter: t.bankrollAfter,
      holdSec: Math.round((t.timestamp - currentEntry.timestamp) / 1000),
      won: t.won ?? false,
    });
    if (t.type !== 'PARTIAL_CUT') currentEntry = null;
  }
}

// ── Summary ──
console.log('═'.repeat(55));
console.log('  TRADE JOURNAL (from state.json — synced with dashboard)');
console.log('═'.repeat(55));
console.log(`  State: $${state.bankroll.toFixed(2)} bankroll | ${state.totalTrades} trades | ${state.wins}W/${state.losses}L`);
console.log(`  Peak: $${(state.peakBankroll ?? state.bankroll).toFixed(2)} | Drawdown: ${state.peakBankroll > 0 ? ((state.peakBankroll - state.bankroll) / state.peakBankroll * 100).toFixed(1) : 0}%`);
console.log(`  Paired trades: ${paired.length}`);
if (paired.length > 0) {
  const first = new Date(paired[0].entryTime).toISOString().slice(0, 16);
  const last = new Date(paired[paired.length - 1].exitTime).toISOString().slice(0, 16);
  console.log(`  Date range: ${first} → ${last}`);
}
console.log('');

// ── Outcomes ──
const byOutcome = {};
let totalPnl = 0;
for (const t of paired) {
  if (!byOutcome[t.outcome]) byOutcome[t.outcome] = { count: 0, pnl: 0, holdSecs: [], costs: [] };
  byOutcome[t.outcome].count++;
  byOutcome[t.outcome].pnl += t.pnl;
  byOutcome[t.outcome].holdSecs.push(t.holdSec);
  byOutcome[t.outcome].costs.push(t.cost);
  totalPnl += t.pnl;
}

console.log('── OUTCOMES ──');
for (const [o, d] of Object.entries(byOutcome)) {
  const avgPnl = (d.pnl / d.count).toFixed(2);
  const avgCost = (d.costs.reduce((a, b) => a + b, 0) / d.costs.length).toFixed(2);
  const avgHold = d.holdSecs.length > 0 ? Math.round(d.holdSecs.reduce((a, b) => a + b, 0) / d.holdSecs.length) : 0;
  const avgMin = (avgHold / 60).toFixed(1);
  console.log(`  ${o.padEnd(10)} ${String(d.count).padStart(3)} trades | P&L: ${d.pnl >= 0 ? '+' : ''}$${d.pnl.toFixed(2).padStart(7)} (avg ${avgPnl >= 0 ? '+' : ''}$${avgPnl}) | cost: $${avgCost} | hold: ${avgMin}min`);
}
console.log(`  ${'TOTAL'.padEnd(10)} ${String(paired.length).padStart(3)} trades | P&L: ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`);
console.log('');

// ── Win Rate ──
const wins = paired.filter(t => t.outcome === 'WIN').length;
const losses = paired.filter(t => t.outcome === 'LOSS').length;
const cuts = paired.filter(t => t.outcome === 'CUT_LOSS').length;
const settled = wins + losses;
const allDecided = wins + losses + cuts;
console.log('── WIN RATE ──');
console.log(`  W/L only:      ${wins}W / ${losses}L = ${settled > 0 ? (wins / settled * 100).toFixed(1) : 0}%`);
console.log(`  Incl cut-loss: ${wins}W / ${losses + cuts}L = ${allDecided > 0 ? (wins / allDecided * 100).toFixed(1) : 0}%`);
console.log('');

// ── Cut-loss detail ──
if (cuts > 0) {
  const cutTrades = paired.filter(t => t.outcome === 'CUT_LOSS');
  const totalCutCost = cutTrades.reduce((a, t) => a + t.cost, 0);
  const totalCutPayout = cutTrades.reduce((a, t) => a + t.payout, 0);
  const totalCutPnl = cutTrades.reduce((a, t) => a + t.pnl, 0);
  const savedVsFullLoss = totalCutCost + totalCutPnl;
  console.log('── CUT-LOSS DETAIL ──');
  console.log(`  Count: ${cuts} of ${paired.length} (${(cuts / paired.length * 100).toFixed(0)}%)`);
  console.log(`  Total cost: $${totalCutCost.toFixed(2)} | Recovered: $${totalCutPayout.toFixed(2)} (${(totalCutPayout / totalCutCost * 100).toFixed(0)}%)`);
  console.log(`  Cut P&L: -$${Math.abs(totalCutPnl).toFixed(2)} | If held to full loss: -$${totalCutCost.toFixed(2)} | Saved: $${savedVsFullLoss.toFixed(2)}`);
  const avgHoldCut = cutTrades.reduce((a, t) => a + t.holdSec, 0) / cuts;
  console.log(`  Avg hold before cut: ${(avgHoldCut / 60).toFixed(1)}min`);
  console.log('');
}

// ── Side Analysis ──
console.log('── BY SIDE ──');
const bySide = {};
for (const t of paired) {
  if (!bySide[t.side]) bySide[t.side] = { count: 0, wins: 0, losses: 0, cuts: 0, pnl: 0 };
  bySide[t.side].count++;
  bySide[t.side].pnl += t.pnl;
  if (t.outcome === 'WIN') bySide[t.side].wins++;
  if (t.outcome === 'LOSS') bySide[t.side].losses++;
  if (t.outcome === 'CUT_LOSS') bySide[t.side].cuts++;
}
for (const [s, d] of Object.entries(bySide)) {
  const wr = (d.wins + d.losses) > 0 ? (d.wins / (d.wins + d.losses) * 100).toFixed(0) : '-';
  console.log(`  ${s.padEnd(5)} ${d.count} trades | ${d.wins}W/${d.losses}L/${d.cuts}C | WR: ${wr}% | P&L: ${d.pnl >= 0 ? '+' : ''}$${d.pnl.toFixed(2)}`);
}
console.log('');

// ── Bankroll curve ──
console.log('── TRADE-BY-TRADE ──');
let cumPnl = 0;
for (let i = 0; i < paired.length; i++) {
  const t = paired[i];
  cumPnl += t.pnl;
  const time = new Date(t.exitTime).toISOString().slice(5, 16).replace('T', ' ');
  const sym = t.outcome === 'WIN' ? 'W' : t.outcome === 'LOSS' ? 'L' : t.outcome === 'CUT_LOSS' ? 'C' : 'U';
  const holdMin = (t.holdSec / 60).toFixed(1);
  console.log(
    `  #${String(i + 1).padStart(2)} ${time} | ${sym} ${t.side.padEnd(5)}` +
    `${(t.pnl >= 0 ? '+' : '') + t.pnl.toFixed(2).padStart(7)} | ` +
    `cost:$${t.cost.toFixed(2).padStart(5)} | ${holdMin.padStart(4)}min | ` +
    `bal:$${t.bankrollAfter.toFixed(2).padStart(6)} | cum:${(cumPnl >= 0 ? '+' : '') + cumPnl.toFixed(2).padStart(7)}`
  );
}
console.log('');
console.log('═'.repeat(55));
