/**
 * Comprehensive Quantitative Analysis of Trade Journal
 * Usage: node _quant.mjs
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dir = dirname(__filename);

// ─── Load Data ───────────────────────────────────────────────────────
const raw = readFileSync(join(__dir, 'trade_journal.jsonl'), 'utf-8')
  .split('\n')
  .filter(l => l.trim())
  .map(l => JSON.parse(l));

const all = raw;
const real = all.filter(t => t.analysis.outcome !== 'DRY_RUN');
const settled = real.filter(t => ['WIN', 'LOSS', 'CUT_LOSS', 'PARTIAL_CUT'].includes(t.analysis.outcome));
const wins = real.filter(t => t.analysis.outcome === 'WIN');
const losses = real.filter(t => t.analysis.outcome === 'LOSS');
const cuts = real.filter(t => t.analysis.outcome === 'CUT_LOSS');
const partials = real.filter(t => t.analysis.outcome === 'PARTIAL_CUT');
const unwinds = real.filter(t => t.analysis.outcome === 'UNWIND');

// ─── Helpers ─────────────────────────────────────────────────────────
const sum = arr => arr.reduce((a, b) => a + b, 0);
const mean = arr => arr.length ? sum(arr) / arr.length : 0;
const median = arr => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const std = arr => {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(sum(arr.map(x => (x - m) ** 2)) / (arr.length - 1));
};
const downstd = arr => {
  const m = mean(arr);
  const neg = arr.filter(x => x < m).map(x => (x - m) ** 2);
  return neg.length ? Math.sqrt(sum(neg) / neg.length) : 0;
};
const percentile = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (s.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (idx - lo);
};

const fmt = (n, d = 4) => (typeof n === 'number' && isFinite(n)) ? n.toFixed(d) : 'N/A';
const fmtPct = (n, d = 2) => (typeof n === 'number' && isFinite(n)) ? (n * 100).toFixed(d) + '%' : 'N/A';
const fmtUsd = n => (typeof n === 'number' && isFinite(n)) ? '$' + n.toFixed(4) : 'N/A';
const pad = (s, w) => String(s).padEnd(w);
const padL = (s, w) => String(s).padStart(w);

function tableRow(cols, widths) {
  return cols.map((c, i) => padL(c, widths[i])).join('  ');
}

// ─── Extract pnl arrays ─────────────────────────────────────────────
const settledPnls = settled.map(t => t.analysis.pnl);
const winPnls = wins.map(t => t.analysis.pnl);
const lossPnls = losses.map(t => t.analysis.pnl); // pure losses
const cutPnls = cuts.map(t => t.analysis.pnl);
const partialPnls = partials.map(t => t.analysis.pnl);
// Combined losses: LOSS + CUT_LOSS + PARTIAL_CUT with negative P&L
const allLossLikePnls = [...lossPnls, ...cutPnls, ...partialPnls.filter(p => p < 0)];
const allWinLikePnls = [...winPnls, ...partialPnls.filter(p => p >= 0)];

console.log('='.repeat(80));
console.log('  TRADE JOURNAL QUANTITATIVE ANALYSIS');
console.log('  ' + new Date().toISOString());
console.log('='.repeat(80));

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 1. BASIC PERFORMANCE METRICS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
console.log('\n' + '━'.repeat(80));
console.log('  1. BASIC PERFORMANCE METRICS (Real Trades Only)');
console.log('━'.repeat(80));

console.log(`\n  Total entries:            ${all.length}`);
console.log(`  DRY_RUN:                  ${all.length - real.length}`);
console.log(`  Real trades:              ${real.length}`);
console.log(`    WIN:                    ${wins.length}`);
console.log(`    LOSS:                   ${losses.length}`);
console.log(`    CUT_LOSS:               ${cuts.length}`);
console.log(`    PARTIAL_CUT:            ${partials.length}`);
console.log(`    UNWIND:                 ${unwinds.length}`);
console.log(`  Settled (excl UNWIND):    ${settled.length}`);

const totalPnl = sum(settledPnls);
const meanPnl = mean(settledPnls);
const medianPnl = median(settledPnls);

console.log(`\n  Total P&L:                ${fmtUsd(totalPnl)}`);
console.log(`  Mean P&L per trade:       ${fmtUsd(meanPnl)}`);
console.log(`  Median P&L per trade:     ${fmtUsd(medianPnl)}`);

// Win rate: WIN only / settled
const winRateStrict = wins.length / settled.length;
// Win rate: treating CUT_LOSS as loss, PARTIAL_CUT with pnl>=0 as win
const winCountBroad = allWinLikePnls.length;
const lossCountBroad = allLossLikePnls.length;
const winRateBroad = winCountBroad / settled.length;

console.log(`\n  Win rate (WIN only):      ${fmtPct(winRateStrict)}`);
console.log(`  Win rate (cuts=loss):     ${fmtPct(winRateBroad)}`);

// Profit factor
const grossWins = sum(settledPnls.filter(p => p > 0));
const grossLosses = Math.abs(sum(settledPnls.filter(p => p < 0)));
const profitFactor = grossLosses > 0 ? grossWins / grossLosses : Infinity;

console.log(`\n  Gross wins:               ${fmtUsd(grossWins)}`);
console.log(`  Gross losses:             ${fmtUsd(grossLosses)}`);
console.log(`  Profit factor:            ${fmt(profitFactor, 3)}`);

// Average win vs average loss
const avgWin = mean(allWinLikePnls);
const avgLoss = mean(allLossLikePnls.map(Math.abs));

console.log(`\n  Avg win size:             ${fmtUsd(avgWin)}`);
console.log(`  Avg loss size:            ${fmtUsd(avgLoss)}`);
console.log(`  Win/Loss ratio:           ${fmt(avgWin / avgLoss, 3)}`);

// Expectancy
const wR = winCountBroad / settled.length;
const lR = lossCountBroad / settled.length;
const expectancy = wR * avgWin - lR * avgLoss;
console.log(`\n  Expectancy per trade:     ${fmtUsd(expectancy)}`);
console.log(`  (win_rate*avg_win - loss_rate*avg_loss)`);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 2. RISK METRICS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
console.log('\n' + '━'.repeat(80));
console.log('  2. RISK METRICS');
console.log('━'.repeat(80));

// Max drawdown
let cumPnl = 0;
let peak = 0;
let maxDD = 0;
let ddStart = -1, ddEnd = -1, ddPeakIdx = -1;
const cumPnls = [];
for (let i = 0; i < settled.length; i++) {
  cumPnl += settled[i].analysis.pnl;
  cumPnls.push(cumPnl);
  if (cumPnl > peak) {
    peak = cumPnl;
    ddPeakIdx = i;
  }
  const dd = peak - cumPnl;
  if (dd > maxDD) {
    maxDD = dd;
    ddStart = ddPeakIdx;
    ddEnd = i;
  }
}

console.log(`\n  Max drawdown:             ${fmtUsd(maxDD)}`);
if (ddStart >= 0 && ddEnd >= 0) {
  console.log(`  Drawdown period:          Trade #${ddStart + 1} to #${ddEnd + 1} (${ddEnd - ddStart} trades)`);
}
console.log(`  Final cumulative P&L:     ${fmtUsd(cumPnl)}`);

// Max consecutive losses
let maxConsecLoss = 0;
let curConsecLoss = 0;
for (const t of settled) {
  if (['LOSS', 'CUT_LOSS'].includes(t.analysis.outcome) || (t.analysis.outcome === 'PARTIAL_CUT' && t.analysis.pnl < 0)) {
    curConsecLoss++;
    maxConsecLoss = Math.max(maxConsecLoss, curConsecLoss);
  } else {
    curConsecLoss = 0;
  }
}
console.log(`  Max consecutive losses:   ${maxConsecLoss}`);

// Estimate trades per day from timestamps
const settledTs = settled.map(t => t._ts).sort((a, b) => a - b);
const tradingSpanMs = settledTs[settledTs.length - 1] - settledTs[0];
const tradingSpanDays = tradingSpanMs / (1000 * 60 * 60 * 24);
const tradesPerDay = settled.length / tradingSpanDays;

console.log(`\n  Trading span:             ${fmt(tradingSpanDays, 1)} days`);
console.log(`  Trades per day:           ${fmt(tradesPerDay, 2)}`);

// Sharpe-like ratio: mean(pnl) / std(pnl) * sqrt(trades_per_day)
const pnlStd = std(settledPnls);
const sharpe = pnlStd > 0 ? (meanPnl / pnlStd) * Math.sqrt(tradesPerDay) : 0;
console.log(`\n  P&L std dev:              ${fmtUsd(pnlStd)}`);
console.log(`  Sharpe-like ratio:        ${fmt(sharpe, 4)} (annualized: ${fmt(sharpe * Math.sqrt(365), 4)})`);

// Sortino ratio
const downDev = downstd(settledPnls);
const sortino = downDev > 0 ? (meanPnl / downDev) * Math.sqrt(tradesPerDay) : 0;
console.log(`  Downside deviation:       ${fmtUsd(downDev)}`);
console.log(`  Sortino ratio:            ${fmt(sortino, 4)}`);

// Calmar ratio
const totalReturn = totalPnl;
const calmar = maxDD > 0 ? totalReturn / maxDD : 0;
console.log(`  Calmar ratio:             ${fmt(calmar, 4)}`);

// VaR 95th percentile
const var95 = percentile(settledPnls, 5); // 5th percentile = 95% VaR
console.log(`\n  VaR (95%):                ${fmtUsd(var95)} (worst trade at 5th percentile)`);
console.log(`  Worst trade:              ${fmtUsd(Math.min(...settledPnls))}`);
console.log(`  Best trade:               ${fmtUsd(Math.max(...settledPnls))}`);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 3. KELLY CRITERION
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
console.log('\n' + '━'.repeat(80));
console.log('  3. KELLY CRITERION');
console.log('━'.repeat(80));

const p = wR;  // win probability (broad)
const q = 1 - p;
const b = avgLoss > 0 ? avgWin / avgLoss : 0;  // win/loss ratio
const kellyFull = b > 0 ? (p * b - q) / b : 0;
const kellyHalf = kellyFull / 2;

const avgCost = mean(settled.map(t => t.entry.cost));
const bankroll = 100;
const effectiveKelly = avgCost / bankroll;

console.log(`\n  Win probability (p):      ${fmtPct(p)}`);
console.log(`  Win/Loss ratio (b):       ${fmt(b, 4)}`);
console.log(`  Full Kelly (f*):          ${fmtPct(kellyFull)}`);
console.log(`  Half Kelly (recommended): ${fmtPct(kellyHalf)}`);
console.log(`  Current avg cost:         ${fmtUsd(avgCost)}`);
console.log(`  Effective Kelly (cost/$100): ${fmtPct(effectiveKelly)}`);

if (kellyFull <= 0) {
  console.log(`\n  *** KELLY IS NEGATIVE — no edge detected, do not bet ***`);
} else if (effectiveKelly > kellyFull) {
  console.log(`\n  *** OVERBETTING: effective ${fmtPct(effectiveKelly)} > full Kelly ${fmtPct(kellyFull)} ***`);
} else if (effectiveKelly > kellyHalf) {
  console.log(`\n  *** SLIGHTLY AGGRESSIVE: between half and full Kelly ***`);
} else {
  console.log(`\n  Position sizing is conservative (below half Kelly)`);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 4. EDGE ANALYSIS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
console.log('\n' + '━'.repeat(80));
console.log('  4. EDGE ANALYSIS');
console.log('━'.repeat(80));

const totalCost = sum(settled.map(t => t.entry.cost));
const edgeOverall = totalCost > 0 ? totalPnl / totalCost : 0;
console.log(`\n  Overall edge (return/cost): ${fmtPct(edgeOverall)}`);
console.log(`  Total capital deployed:     ${fmtUsd(totalCost)}`);

// Edge by regime
console.log('\n  Edge by Regime:');
const regimes = {};
for (const t of settled) {
  const r = t.entry.regime || 'unknown';
  if (!regimes[r]) regimes[r] = { trades: 0, pnl: 0, cost: 0, wins: 0 };
  regimes[r].trades++;
  regimes[r].pnl += t.analysis.pnl;
  regimes[r].cost += t.entry.cost;
  if (t.analysis.pnl > 0) regimes[r].wins++;
}
const regHeader = ['Regime', 'Trades', 'P&L', 'Edge', 'WinRate'];
const regWidths = [18, 8, 12, 10, 10];
console.log('  ' + tableRow(regHeader, regWidths));
console.log('  ' + '-'.repeat(sum(regWidths) + (regWidths.length - 1) * 2));
for (const [r, d] of Object.entries(regimes).sort((a, b) => b[1].trades - a[1].trades)) {
  const edge = d.cost > 0 ? d.pnl / d.cost : 0;
  const wr = d.wins / d.trades;
  console.log('  ' + tableRow([r, d.trades, fmtUsd(d.pnl), fmtPct(edge), fmtPct(wr)], regWidths));
}

// Edge by ML confidence bucket
console.log('\n  Edge by ML Confidence:');
const mlBuckets = { '<0.55': { t: 0, pnl: 0, cost: 0, w: 0 }, '0.55-0.60': { t: 0, pnl: 0, cost: 0, w: 0 }, '0.60-0.65': { t: 0, pnl: 0, cost: 0, w: 0 }, '0.65-0.70': { t: 0, pnl: 0, cost: 0, w: 0 }, '0.70+': { t: 0, pnl: 0, cost: 0, w: 0 } };
for (const t of settled) {
  const c = t.entry.mlConfidence ?? 0;
  let bucket;
  if (c < 0.55) bucket = '<0.55';
  else if (c < 0.60) bucket = '0.55-0.60';
  else if (c < 0.65) bucket = '0.60-0.65';
  else if (c < 0.70) bucket = '0.65-0.70';
  else bucket = '0.70+';
  mlBuckets[bucket].t++;
  mlBuckets[bucket].pnl += t.analysis.pnl;
  mlBuckets[bucket].cost += t.entry.cost;
  if (t.analysis.pnl > 0) mlBuckets[bucket].w++;
}
const mlHeader = ['Confidence', 'Trades', 'P&L', 'Edge', 'WinRate'];
const mlWidths = [14, 8, 12, 10, 10];
console.log('  ' + tableRow(mlHeader, mlWidths));
console.log('  ' + '-'.repeat(sum(mlWidths) + (mlWidths.length - 1) * 2));
for (const [b, d] of Object.entries(mlBuckets)) {
  if (d.t === 0) continue;
  const edge = d.cost > 0 ? d.pnl / d.cost : 0;
  const wr = d.w / d.t;
  console.log('  ' + tableRow([b, d.t, fmtUsd(d.pnl), fmtPct(edge), fmtPct(wr)], mlWidths));
}

// Edge by session
console.log('\n  Edge by Session:');
const sessions = {};
for (const t of settled) {
  const s = t.entry.session || 'unknown';
  if (!sessions[s]) sessions[s] = { trades: 0, pnl: 0, cost: 0, wins: 0 };
  sessions[s].trades++;
  sessions[s].pnl += t.analysis.pnl;
  sessions[s].cost += t.entry.cost;
  if (t.analysis.pnl > 0) sessions[s].wins++;
}
const sessHeader = ['Session', 'Trades', 'P&L', 'Edge', 'WinRate'];
const sessWidths = [18, 8, 12, 10, 10];
console.log('  ' + tableRow(sessHeader, sessWidths));
console.log('  ' + '-'.repeat(sum(sessWidths) + (sessWidths.length - 1) * 2));
for (const [s, d] of Object.entries(sessions).sort((a, b) => b[1].trades - a[1].trades)) {
  const edge = d.cost > 0 ? d.pnl / d.cost : 0;
  const wr = d.wins / d.trades;
  console.log('  ' + tableRow([s, d.trades, fmtUsd(d.pnl), fmtPct(edge), fmtPct(wr)], sessWidths));
}

// Edge by side
console.log('\n  Edge by Side:');
const sides = {};
for (const t of settled) {
  const s = t.entry.side;
  if (!sides[s]) sides[s] = { trades: 0, pnl: 0, cost: 0, wins: 0 };
  sides[s].trades++;
  sides[s].pnl += t.analysis.pnl;
  sides[s].cost += t.entry.cost;
  if (t.analysis.pnl > 0) sides[s].wins++;
}
const sideHeader = ['Side', 'Trades', 'P&L', 'Edge', 'WinRate'];
const sideWidths = [8, 8, 12, 10, 10];
console.log('  ' + tableRow(sideHeader, sideWidths));
console.log('  ' + '-'.repeat(sum(sideWidths) + (sideWidths.length - 1) * 2));
for (const [s, d] of Object.entries(sides)) {
  const edge = d.cost > 0 ? d.pnl / d.cost : 0;
  const wr = d.wins / d.trades;
  console.log('  ' + tableRow([s, d.trades, fmtUsd(d.pnl), fmtPct(edge), fmtPct(wr)], sideWidths));
}

// Chi-square test
console.log('\n  Chi-Square Test (win rate vs 50%):');
const n = settled.length;
const observed = winCountBroad;
const expected = n * 0.5;
const chiSq = ((observed - expected) ** 2) / expected + ((n - observed - expected) ** 2) / expected;
// For 1 df, critical value at 95% is 3.841, at 99% is 6.635
const pValue = chiSq > 6.635 ? '<0.01' : chiSq > 3.841 ? '<0.05' : '>0.05';
console.log(`  Observed wins:            ${observed} / ${n}`);
console.log(`  Expected (50%):           ${expected}`);
console.log(`  Chi-square statistic:     ${fmt(chiSq, 4)}`);
console.log(`  p-value:                  ${pValue}`);
console.log(`  Significant at 95%?       ${chiSq > 3.841 ? 'YES' : 'NO'}`);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 5. CUT-LOSS ANALYSIS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
console.log('\n' + '━'.repeat(80));
console.log('  5. CUT-LOSS ANALYSIS');
console.log('━'.repeat(80));

const cutAndPartial = [...cuts, ...partials];
const cutPctOfSettled = cutAndPartial.length / settled.length;
console.log(`\n  Trades cut (CUT_LOSS + PARTIAL): ${cutAndPartial.length} / ${settled.length} (${fmtPct(cutPctOfSettled)})`);
console.log(`  Trades settled to maturity:      ${wins.length + losses.length}`);

// Recovery rate
const cutsWithRecovery = cutAndPartial.filter(t => t.exit?.cutLossRecovered != null && t.entry?.cost);
const recoveryRates = cutsWithRecovery.map(t => t.exit.cutLossRecovered / t.entry.cost);
console.log(`\n  Average recovery (recovered/cost): ${fmtPct(mean(recoveryRates))}`);
console.log(`  Median recovery:                   ${fmtPct(median(recoveryRates))}`);

// Actual P&L from cuts
const cutTotalPnl = sum(cutAndPartial.map(t => t.analysis.pnl));
console.log(`\n  Actual total P&L from cuts:        ${fmtUsd(cutTotalPnl)}`);

// What if cuts had NOT been made?
// For cuts where we know actualOutcome, simulate: if actualOutcome matches side → WIN (payout = cost * size/size = size - cost), else LOSS (pnl = -cost)
const cutsWithActual = cutAndPartial.filter(t => t.analysis.actualOutcome);
let hypotheticalPnlIfNoCut = 0;
let cutsWouldHaveWon = 0;
let cutsWouldHaveLost = 0;
for (const t of cutsWithActual) {
  const side = t.entry.side;
  const actual = t.analysis.actualOutcome;
  const wouldWin = side === actual;
  if (wouldWin) {
    // Payout: size * $1 - cost
    hypotheticalPnlIfNoCut += (t.entry.size - t.entry.cost);
    cutsWouldHaveWon++;
  } else {
    hypotheticalPnlIfNoCut += -t.entry.cost;
    cutsWouldHaveLost++;
  }
}
console.log(`\n  If cuts had NOT been made (held to expiry):`);
console.log(`    Would have won:           ${cutsWouldHaveWon} / ${cutsWithActual.length}`);
console.log(`    Would have lost:          ${cutsWouldHaveLost} / ${cutsWithActual.length}`);
console.log(`    Hypothetical P&L:         ${fmtUsd(hypotheticalPnlIfNoCut)}`);
console.log(`    Actual P&L (with cuts):   ${fmtUsd(cutTotalPnl)}`);
console.log(`    Cut-loss saved:           ${fmtUsd(cutTotalPnl - hypotheticalPnlIfNoCut)}`);
if (cutTotalPnl > hypotheticalPnlIfNoCut) {
  console.log(`    >> Cut-loss system SAVED ${fmtUsd(cutTotalPnl - hypotheticalPnlIfNoCut)}`);
} else {
  console.log(`    >> Cut-loss system COST ${fmtUsd(hypotheticalPnlIfNoCut - cutTotalPnl)} (would have been better to hold)`);
}

// Optimal cut-loss threshold
console.log('\n  Optimal Cut-Loss Threshold Sweep:');
const cutsWithDropPct = cutAndPartial.filter(t => t.analysis.cutLossDropPct != null || t.exit?.cutLossDropPct != null);
// Get all cut-loss drop percentages
const dropPcts = cutsWithDropPct.map(t => t.analysis.cutLossDropPct ?? t.exit?.cutLossDropPct ?? 0);
const thresholds = [15, 20, 25, 30, 35, 40, 45, 50, 60, 70, 80, 90];
const thrHeader = ['Threshold', 'CutsAvoided', 'CutsKept', 'EstPnL'];
const thrWidths = [12, 14, 10, 12];
console.log('  ' + tableRow(thrHeader, thrWidths));
console.log('  ' + '-'.repeat(sum(thrWidths) + (thrWidths.length - 1) * 2));

for (const thr of thresholds) {
  // If threshold = X%, only cut when drop >= X%
  // Cuts with drop < thr would NOT be cut (held to expiry)
  // Cuts with drop >= thr would still be cut
  let estPnl = 0;
  let kept = 0, avoided = 0;
  for (const t of cutsWithActual) {
    const dropPct = t.analysis.cutLossDropPct ?? t.exit?.cutLossDropPct ?? 0;
    if (dropPct < thr) {
      // Would NOT have been cut - hold to expiry
      avoided++;
      const wouldWin = t.entry.side === t.analysis.actualOutcome;
      estPnl += wouldWin ? (t.entry.size - t.entry.cost) : -t.entry.cost;
    } else {
      // Still cut
      kept++;
      estPnl += t.analysis.pnl;
    }
  }
  // Add non-cut settled trades
  const nonCutPnl = sum(wins.map(t => t.analysis.pnl)) + sum(losses.map(t => t.analysis.pnl));
  console.log('  ' + tableRow([thr + '%', avoided, kept, fmtUsd(estPnl + nonCutPnl)], thrWidths));
}
console.log(`\n  (Current total P&L = ${fmtUsd(totalPnl)})`);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 6. TIME ANALYSIS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
console.log('\n' + '━'.repeat(80));
console.log('  6. TIME ANALYSIS');
console.log('━'.repeat(80));

// P&L by hour of day (UTC)
const hourStats = {};
for (let h = 0; h < 24; h++) hourStats[h] = { trades: 0, pnl: 0, wins: 0 };
for (const t of settled) {
  const h = new Date(t.entry.enteredAt).getUTCHours();
  hourStats[h].trades++;
  hourStats[h].pnl += t.analysis.pnl;
  if (t.analysis.pnl > 0) hourStats[h].wins++;
}
console.log('\n  P&L by Hour (UTC):');
const hourHeader = ['Hour', 'Trades', 'P&L', 'AvgPnL', 'WinRate'];
const hourWidths = [6, 8, 12, 10, 10];
console.log('  ' + tableRow(hourHeader, hourWidths));
console.log('  ' + '-'.repeat(sum(hourWidths) + (hourWidths.length - 1) * 2));
for (let h = 0; h < 24; h++) {
  const d = hourStats[h];
  if (d.trades === 0) continue;
  const avg = d.pnl / d.trades;
  const wr = d.wins / d.trades;
  console.log('  ' + tableRow([`${h}:00`, d.trades, fmtUsd(d.pnl), fmtUsd(avg), fmtPct(wr)], hourWidths));
}

// Average hold time
const holdWins = wins.map(t => t.analysis.holdDurationSec).filter(x => x > 0);
const holdLosses = losses.map(t => t.analysis.holdDurationSec).filter(x => x > 0);
const holdCuts = cuts.map(t => t.analysis.holdDurationSec).filter(x => x > 0);

console.log('\n  Average Hold Duration (seconds):');
console.log(`    Wins:        ${fmt(mean(holdWins), 1)}s  (${fmt(mean(holdWins) / 60, 1)} min)`);
console.log(`    Losses:      ${fmt(mean(holdLosses), 1)}s  (${fmt(mean(holdLosses) / 60, 1)} min)`);
console.log(`    Cut-Losses:  ${fmt(mean(holdCuts), 1)}s  (${fmt(mean(holdCuts) / 60, 1)} min)`);

// Best and worst hours
const activeHours = Object.entries(hourStats).filter(([, d]) => d.trades >= 2);
if (activeHours.length > 0) {
  const bestHour = activeHours.reduce((a, b) => (a[1].pnl / a[1].trades) > (b[1].pnl / b[1].trades) ? a : b);
  const worstHour = activeHours.reduce((a, b) => (a[1].pnl / a[1].trades) < (b[1].pnl / b[1].trades) ? a : b);
  console.log(`\n  Best hour (UTC):   ${bestHour[0]}:00 (avg P&L: ${fmtUsd(bestHour[1].pnl / bestHour[1].trades)}, ${bestHour[1].trades} trades)`);
  console.log(`  Worst hour (UTC):  ${worstHour[0]}:00 (avg P&L: ${fmtUsd(worstHour[1].pnl / worstHour[1].trades)}, ${worstHour[1].trades} trades)`);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 7. POSITION SIZING RECOMMENDATIONS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
console.log('\n' + '━'.repeat(80));
console.log('  7. POSITION SIZING RECOMMENDATIONS');
console.log('━'.repeat(80));

const BR = 100;
console.log(`\n  Bankroll:                 ${fmtUsd(BR)}`);

if (kellyFull > 0) {
  const optimalBet = BR * kellyHalf;
  console.log(`  Optimal trade size:       ${fmtUsd(optimalBet)} (half Kelly)`);
  console.log(`  Max trade size:           ${fmtUsd(BR * kellyFull)} (full Kelly — NOT recommended)`);
} else {
  console.log(`  Optimal trade size:       $0.00 (negative edge — do not trade)`);
}

// How many trades to break even at 95% confidence?
// Using CLT: P(sum > 0) = P(Z > -mean*sqrt(n)/std) = 0.95
// -mean*sqrt(n)/std = -1.645  =>  n = (1.645 * std / mean)^2
if (meanPnl > 0 && pnlStd > 0) {
  const nBreakEven = Math.ceil((1.645 * pnlStd / meanPnl) ** 2);
  console.log(`\n  Trades to break even (95% conf): ${nBreakEven}`);
  console.log(`  At ${fmt(tradesPerDay, 1)} trades/day, that's ${fmt(nBreakEven / tradesPerDay, 1)} days`);
} else {
  console.log(`\n  Cannot compute break-even trades (negative or zero mean P&L)`);
}

// Risk of ruin approximation
// Simplified: P(ruin) ≈ (q/p)^(bankroll/avgBet)  when p > q
if (wR > 0.5 && avgLoss > 0) {
  const riskOfRuin = Math.pow(q / wR, BR / avgCost);
  console.log(`\n  Risk of ruin estimate:    ${riskOfRuin < 1e-10 ? '<0.0000000001%' : fmtPct(riskOfRuin)}`);
} else if (wR <= 0.5) {
  console.log(`\n  Risk of ruin:             HIGH (win rate <= 50%)`);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// BONUS: Additional Insights
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
console.log('\n' + '━'.repeat(80));
console.log('  BONUS: ML & RULE AGREEMENT ANALYSIS');
console.log('━'.repeat(80));

const mlRight = settled.filter(t => t.analysis.mlWasRight === true);
const mlWrong = settled.filter(t => t.analysis.mlWasRight === false);
const ruleRight = settled.filter(t => t.analysis.ruleWasRight === true);
const ruleWrong = settled.filter(t => t.analysis.ruleWasRight === false);
const edgeReal = settled.filter(t => t.analysis.edgeWasReal === true);
const edgeFalse = settled.filter(t => t.analysis.edgeWasReal === false);

console.log(`\n  ML was right:             ${mlRight.length} / ${settled.length} (${fmtPct(mlRight.length / settled.length)})`);
console.log(`  Rules were right:         ${ruleRight.length} / ${settled.length} (${fmtPct(ruleRight.length / settled.length)})`);
console.log(`  Edge was real:            ${edgeReal.length} / ${settled.length} (${fmtPct(edgeReal.length / settled.length)})`);

// ML agreement
const mlAgreed = settled.filter(t => t.entry.mlAgreesWithRules === true);
const mlDisagreed = settled.filter(t => t.entry.mlAgreesWithRules === false);
console.log(`\n  ML agreed with rules:     ${mlAgreed.length} / ${settled.length}`);
if (mlAgreed.length > 0) {
  const agreedPnl = sum(mlAgreed.map(t => t.analysis.pnl));
  const agreedWins = mlAgreed.filter(t => t.analysis.pnl > 0).length;
  console.log(`    P&L when agreed:        ${fmtUsd(agreedPnl)} (WR: ${fmtPct(agreedWins / mlAgreed.length)})`);
}
if (mlDisagreed.length > 0) {
  const disagPnl = sum(mlDisagreed.map(t => t.analysis.pnl));
  const disagWins = mlDisagreed.filter(t => t.analysis.pnl > 0).length;
  console.log(`    P&L when disagreed:     ${fmtUsd(disagPnl)} (WR: ${fmtPct(disagWins / mlDisagreed.length)})`);
}

// Regime changed analysis
const regimeChanged = settled.filter(t => t.analysis.regimeChanged === true);
const regimeStayed = settled.filter(t => t.analysis.regimeChanged === false);
console.log(`\n  Regime changed mid-trade: ${regimeChanged.length} / ${settled.length}`);
if (regimeChanged.length > 0) {
  console.log(`    P&L when regime changed:  ${fmtUsd(sum(regimeChanged.map(t => t.analysis.pnl)))}`);
}
if (regimeStayed.length > 0) {
  console.log(`    P&L when regime stayed:   ${fmtUsd(sum(regimeStayed.map(t => t.analysis.pnl)))}`);
}

// Edge by bestEdge bucket
console.log('\n  Edge by Entry Best-Edge Bucket:');
const edgeBuckets = { '<10%': { t: 0, pnl: 0, w: 0 }, '10-20%': { t: 0, pnl: 0, w: 0 }, '20-30%': { t: 0, pnl: 0, w: 0 }, '30-40%': { t: 0, pnl: 0, w: 0 }, '40%+': { t: 0, pnl: 0, w: 0 } };
for (const t of settled) {
  const e = (t.entry.bestEdge ?? 0) * 100;
  let bucket;
  if (e < 10) bucket = '<10%';
  else if (e < 20) bucket = '10-20%';
  else if (e < 30) bucket = '20-30%';
  else if (e < 40) bucket = '30-40%';
  else bucket = '40%+';
  edgeBuckets[bucket].t++;
  edgeBuckets[bucket].pnl += t.analysis.pnl;
  if (t.analysis.pnl > 0) edgeBuckets[bucket].w++;
}
const ebHeader = ['Edge Bucket', 'Trades', 'P&L', 'WinRate'];
const ebWidths = [14, 8, 12, 10];
console.log('  ' + tableRow(ebHeader, ebWidths));
console.log('  ' + '-'.repeat(sum(ebWidths) + (ebWidths.length - 1) * 2));
for (const [b, d] of Object.entries(edgeBuckets)) {
  if (d.t === 0) continue;
  const wr = d.w / d.t;
  console.log('  ' + tableRow([b, d.t, fmtUsd(d.pnl), fmtPct(wr)], ebWidths));
}

// Phase analysis
console.log('\n  Edge by Entry Phase:');
const phases = {};
for (const t of settled) {
  const ph = t.entry.phase || 'unknown';
  if (!phases[ph]) phases[ph] = { trades: 0, pnl: 0, cost: 0, wins: 0 };
  phases[ph].trades++;
  phases[ph].pnl += t.analysis.pnl;
  phases[ph].cost += t.entry.cost;
  if (t.analysis.pnl > 0) phases[ph].wins++;
}
const phHeader = ['Phase', 'Trades', 'P&L', 'Edge', 'WinRate'];
const phWidths = [12, 8, 12, 10, 10];
console.log('  ' + tableRow(phHeader, phWidths));
console.log('  ' + '-'.repeat(sum(phWidths) + (phWidths.length - 1) * 2));
for (const [ph, d] of Object.entries(phases).sort((a, b) => b[1].trades - a[1].trades)) {
  const edge = d.cost > 0 ? d.pnl / d.cost : 0;
  const wr = d.wins / d.trades;
  console.log('  ' + tableRow([ph, d.trades, fmtUsd(d.pnl), fmtPct(edge), fmtPct(wr)], phWidths));
}

// P&L distribution
console.log('\n  P&L Distribution (settled trades):');
const pctiles = [1, 5, 10, 25, 50, 75, 90, 95, 99];
for (const p of pctiles) {
  console.log(`    ${padL(p + 'th', 5)} percentile:  ${fmtUsd(percentile(settledPnls, p))}`);
}

console.log('\n' + '='.repeat(80));
console.log('  ANALYSIS COMPLETE');
console.log('='.repeat(80));
