#!/usr/bin/env node
/**
 * v19 Performance Report — comprehensive trade analysis since v19 deploy.
 *
 * Slices trades by:
 *   - Entry type: FOK | LIMIT | ARB
 *   - Phase: EARLY | MID | LATE | VERY_LATE
 *   - ML confidence band: <60% | 60-70% | 70-80% | 80-90% | ≥90%
 *
 * Produces per-bucket WR + Wilson 95% confidence intervals so we can
 * distinguish signal from noise at small sample sizes.
 *
 * Usage:
 *   node bot/scripts/v19_performance_report.mjs
 *   node bot/scripts/v19_performance_report.mjs --since-ms 1778737618575
 *   node bot/scripts/v19_performance_report.mjs --json (machine-readable)
 *
 * Created 2026-05-14.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

type CliArgs = Record<string, string | boolean | undefined> & {
  json?: boolean;
};

type BucketStats = {
  w: number;
  l: number;
  p: number;
  pnl: number;
};

const args: CliArgs = (() => {
  const o: CliArgs = {};
  for (let i = 2; i < process.argv.length; i++) {
    const k = process.argv[i];
    if (k === '--json') { o.json = true; continue; }
    if (k.startsWith('--') && i + 1 < process.argv.length) o[k.slice(2)] = process.argv[++i];
  }
  return o;
})();

// Default: v19 deploy time = ctime of backup folder
function detectDeployTime() {
  const backupDir = path.join(ROOT, 'public', 'ml', 'backups', 'v16_pre_v19_2026-05-14T05-46-58');
  if (fs.existsSync(backupDir)) return Math.floor(fs.statSync(backupDir).ctimeMs);
  return 1778737618575; // fallback
}

const SINCE_MS = args['since-ms'] ? parseInt(String(args['since-ms']), 10) : detectDeployTime();
const JOURNAL  = path.join(ROOT, 'bot', 'data', 'trade_journal.jsonl');

// ── Wilson 95% CI for binomial proportion ──
// Better than normal approx for small samples (n < 30).
function wilson95(wins, total) {
  if (total === 0) return { lo: 0, hi: 1, point: null };
  const z = 1.96;
  const p = wins / total;
  const denom = 1 + (z * z) / total;
  const center = (p + (z * z) / (2 * total)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total)) / denom;
  return { lo: Math.max(0, center - margin), hi: Math.min(1, center + margin), point: p };
}

function classifyEntry(reason = '') {
  if (/limit_order_filled|limit_order_partial|limit_phantom/i.test(reason)) return 'LIMIT';
  if (/arb|arbitrage/i.test(reason)) return 'ARB';
  if (/pre_market|premarket/i.test(reason)) return 'PRE_MARKET';
  return 'FOK';
}

function classifyConfBand(conf) {
  if (conf == null || !Number.isFinite(conf)) return 'unknown';
  if (conf < 0.60) return '<60%';
  if (conf < 0.70) return '60-70%';
  if (conf < 0.80) return '70-80%';
  if (conf < 0.90) return '80-90%';
  return '≥90%';
}

// ── Load trades ──
if (!fs.existsSync(JOURNAL)) {
  console.error(`Journal not found: ${JOURNAL}`);
  process.exit(1);
}

const trades = [];
for (const line of fs.readFileSync(JOURNAL, 'utf-8').split('\n')) {
  if (!line.trim()) continue;
  try {
    const r = JSON.parse(line);
    const ts = (r.entry || {}).enteredAt || 0;
    if (ts < SINCE_MS) continue;
    trades.push(r);
  } catch {}
}

if (trades.length === 0) {
  const out = { sinceMs: SINCE_MS, sinceDt: new Date(SINCE_MS).toISOString(), trades: 0, message: 'No trades in window' };
  if (args.json) console.log(JSON.stringify(out, null, 2));
  else {
    console.log(`\n=== v19 Performance Report ===`);
    console.log(`Since: ${out.sinceDt} (ms=${SINCE_MS})`);
    console.log(`Trades in window: 0`);
  }
  process.exit(0);
}

// ── Aggregate ──
const allStats: BucketStats = { w: 0, l: 0, p: 0, pnl: 0 };
const byEntry: Record<string, BucketStats> = {};   // type -> {w,l,p,pnl}
const byPhase: Record<string, BucketStats> = {};   // phase -> {...}
const byBand: Record<string, BucketStats> = {};   // confBand -> {...}
const byEntryPhase: Record<string, BucketStats> = {}; // type:phase -> {...}

function bucket(map: Record<string, BucketStats>, key: string): BucketStats {
  return map[key] ?? (map[key] = { w: 0, l: 0, p: 0, pnl: 0 });
}

for (const r of trades) {
  const e = r.entry || {};
  const a = r.analysis || {};
  const outcome = a.outcome || 'PENDING';
  const pnl = a.pnl || 0;
  const phase = e.phase || 'UNKNOWN';
  const entryType = classifyEntry(e.reason);
  const conf = e.mlConfidence;
  const band = classifyConfBand(conf);

  function add(b) {
    if (outcome === 'WIN') b.w++;
    else if (outcome === 'LOSS') b.l++;
    else b.p++;
    b.pnl += pnl;
  }
  add(allStats);
  add(bucket(byEntry, entryType));
  add(bucket(byPhase, phase));
  add(bucket(byBand,  band));
  add(bucket(byEntryPhase, `${entryType}:${phase}`));
}

// ── Output ──
const summary = {
  sinceMs: SINCE_MS,
  sinceDt: new Date(SINCE_MS).toISOString(),
  totalTrades: trades.length,
  resolved: allStats.w + allStats.l,
  pending: allStats.p,
  wins: allStats.w,
  losses: allStats.l,
  wr: allStats.w + allStats.l > 0 ? allStats.w / (allStats.w + allStats.l) : null,
  pnl: allStats.pnl,
  byEntry,
  byPhase,
  byBand,
  byEntryPhase,
};

if (args.json) { console.log(JSON.stringify(summary, null, 2)); process.exit(0); }

// Human format
function fmt(b: BucketStats) {
  const n = b.w + b.l;
  const wr = n > 0 ? b.w / n : null;
  const ci = wilson95(b.w, n);
  const wrStr = wr != null ? `${(wr * 100).toFixed(1)}%` : 'n/a';
  const ciStr = n > 0 ? `[${(ci.lo * 100).toFixed(0)}–${(ci.hi * 100).toFixed(0)}%]` : '';
  return { n, wrStr, ciStr, pnl: b.pnl, w: b.w, l: b.l, p: b.p };
}

console.log(`\n══════ v19 PERFORMANCE REPORT ══════`);
console.log(`Window:     ${summary.sinceDt} → now`);
console.log(`Elapsed:    ${((Date.now() - SINCE_MS) / 3600000).toFixed(2)}h`);
console.log(`Trades:     ${summary.totalTrades} (resolved ${summary.resolved}, pending ${summary.pending})`);
const overall = fmt(allStats);
console.log(`Overall:    ${overall.w}W/${overall.l}L | WR ${overall.wrStr} ${overall.ciStr} | PnL $${summary.pnl.toFixed(2)}`);

console.log(`\n── By Entry Type ──`);
console.log(`Type           N    WR     95%-CI       PnL`);
for (const [t, b] of Object.entries(byEntry).sort()) {
  const f = fmt(b);
  console.log(`  ${t.padEnd(11)} ${String(f.n).padStart(3)}  ${f.wrStr.padStart(6)} ${f.ciStr.padEnd(12)} $${f.pnl.toFixed(2).padStart(7)}`);
}

console.log(`\n── By Phase ──`);
console.log(`Phase          N    WR     95%-CI       PnL    vs shadow`);
const shadowWR: Record<string, number> = { EARLY: 0.69, MID: 0.82, LATE: 0.90, VERY_LATE: 0.99 };
for (const phase of ['EARLY', 'MID', 'LATE', 'VERY_LATE', 'UNKNOWN']) {
  const b = byPhase[phase];
  if (!b) continue;
  const f = fmt(b);
  const expected = shadowWR[phase];
  let cmp = '';
  if (expected != null && f.n > 0) {
    const actual = b.w / (b.w + b.l);
    const delta = (actual - expected) * 100;
    cmp = `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}pp`;
  }
  console.log(`  ${phase.padEnd(11)} ${String(f.n).padStart(3)}  ${f.wrStr.padStart(6)} ${f.ciStr.padEnd(12)} $${f.pnl.toFixed(2).padStart(7)}  ${cmp}`);
}

console.log(`\n── By ML Confidence Band ──`);
console.log(`Band           N    WR     95%-CI       PnL`);
for (const band of ['unknown', '<60%', '60-70%', '70-80%', '80-90%', '≥90%']) {
  const b = byBand[band];
  if (!b) continue;
  const f = fmt(b);
  console.log(`  ${band.padEnd(11)} ${String(f.n).padStart(3)}  ${f.wrStr.padStart(6)} ${f.ciStr.padEnd(12)} $${f.pnl.toFixed(2).padStart(7)}`);
}

console.log(`\n── Entry × Phase Matrix ──`);
const types = Object.keys(byEntry).sort();
const phases = ['EARLY', 'MID', 'LATE', 'VERY_LATE'];
const cellW = 14;
let header = '             ';
for (const p of phases) header += p.padEnd(cellW);
console.log(header);
for (const t of types) {
  let row = t.padEnd(13);
  for (const p of phases) {
    const b = byEntryPhase[`${t}:${p}`];
    if (!b) { row += '-'.padEnd(cellW); continue; }
    const f = fmt(b);
    row += `${f.w}/${f.w + f.l} ${f.wrStr}`.padEnd(cellW);
  }
  console.log(row);
}

// Verdict guidance
console.log(`\n══════ INTERPRETATION ══════`);
const fokN = (byEntry.FOK?.w ?? 0) + (byEntry.FOK?.l ?? 0);
const limN = (byEntry.LIMIT?.w ?? 0) + (byEntry.LIMIT?.l ?? 0);
if (fokN + limN < 5) {
  console.log(`  Sample too small (n=${fokN + limN}). Need ≥10 for any conclusion.`);
} else if (fokN + limN < 10) {
  console.log(`  Sample size n=${fokN + limN} — partial signal only. Wait for n≥10.`);
} else {
  const overallWR = (byEntry.FOK?.w ?? 0) + (byEntry.LIMIT?.w ?? 0);
  const overallN = fokN + limN;
  const wr = overallWR / overallN;
  if (wr >= 0.75) console.log(`  ✅ v19 healthy (WR ${(wr * 100).toFixed(0)}% on ${overallN} trades). No tuning needed.`);
  else if (wr >= 0.60) console.log(`  ⚠️ v19 borderline (WR ${(wr * 100).toFixed(0)}% on ${overallN} trades). Consider tier-balanced tune.`);
  else console.log(`  🔴 v19 underperforming (WR ${(wr * 100).toFixed(0)}% on ${overallN} trades). Investigate before tuning. Consider rollback to v16.`);
}
console.log();
