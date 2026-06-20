#!/usr/bin/env node
/**
 * v19 Unified Status Dashboard
 *
 * Single command showing complete bot state:
 *   - PM2 health (uptime, memory, restarts)
 *   - Bankroll + baseline + drift from peak
 *   - v19 deploy timing
 *   - Trades since deploy (per entry-type)
 *   - Recent errors (last 100 log lines)
 *   - Observation-mode window status
 *
 * Usage:
 *   node bot/scripts/v19_status.mts
 *   node bot/scripts/v19_status.mts --json
 *
 * Created 2026-05-14.
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const args = { json: process.argv.includes('--json') };

// ─── helpers ───
function safeCmd(cmd, opts = {}) {
  try { return execSync(cmd, { encoding: 'utf-8', timeout: 5000, ...opts }); }
  catch (e) { return null; }
}
function safeRead(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); }
  catch { return null; }
}
function safeStat(p) {
  try { return fs.statSync(p); } catch { return null; }
}
function fmtBytes(n) {
  if (!n) return '0';
  const u = ['B', 'KB', 'MB', 'GB']; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(1)}${u[i]}`;
}
function fmtDuration(ms) {
  if (!ms || ms < 0) return '0s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

// ─── data gathering ───

// 1. PM2 status
function getPm2() {
  const raw = safeCmd('pm2 jlist');
  if (!raw) return null;
  try {
    const arr = JSON.parse(raw);
    const bot = arr.find(p => p.name === 'polymarket-bot');
    if (!bot) return { found: false };
    return {
      found: true,
      pid: bot.pid,
      status: bot.pm2_env?.status,
      uptime: bot.pm2_env?.pm_uptime ? Date.now() - bot.pm2_env.pm_uptime : null,
      restarts: bot.pm2_env?.restart_time,
      memory: bot.monit?.memory,
      cpu: bot.monit?.cpu,
    };
  } catch { return null; }
}

// 2. Bankroll state
function getState() {
  const s = safeRead(path.join(ROOT, 'bot', 'data', 'state.json'));
  if (!s) return null;
  return {
    bankroll: s.bankroll,
    peak: s.peakBankroll,
    startOfDay: s.startOfDayBankroll,
    totalTrades: s.totalTrades,
    wins: s.wins,
    losses: s.losses,
    allTimeWR: s.wins + s.losses > 0 ? s.wins / (s.wins + s.losses) : null,
    consecutiveLosses: s.consecutiveLosses,
    drawdownFromPeak: s.peakBankroll > 0 ? (s.bankroll - s.peakBankroll) / s.peakBankroll : 0,
  };
}

// 3. v19 deploy time
function getV19Deploy() {
  const backupDir = path.join(ROOT, 'public', 'ml', 'backups', 'v16_pre_v19_2026-05-14T05-46-58');
  const st = safeStat(backupDir);
  return st ? Math.floor(st.ctimeMs) : 1778737618575;
}

// 4. v19 trades
function getV19Trades(sinceMs) {
  const p = path.join(ROOT, 'bot', 'data', 'trade_journal.jsonl');
  if (!fs.existsSync(p)) return {
    total: 0,
    fok: { w: 0, l: 0, p: 0 },
    limit: { w: 0, l: 0, p: 0 },
    arb: { w: 0, l: 0, p: 0 },
    pnl: 0,
  };
  const bucket = { fok: { w: 0, l: 0, p: 0 }, limit: { w: 0, l: 0, p: 0 }, arb: { w: 0, l: 0, p: 0 } };
  let total = 0, pnl = 0;
  for (const line of fs.readFileSync(p, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      const ts = (r.entry || {}).enteredAt || 0;
      if (ts < sinceMs) continue;
      total++;
      const reason = (r.entry || {}).reason || '';
      const out = (r.analysis || {}).outcome;
      const k = /limit/i.test(reason) ? 'limit' : /arb/i.test(reason) ? 'arb' : 'fok';
      if (out === 'WIN') bucket[k].w++;
      else if (out === 'LOSS') bucket[k].l++;
      else bucket[k].p++;
      pnl += (r.analysis || {}).pnl || 0;
    } catch {}
  }
  return { total, ...bucket, pnl };
}

// 5. Recent errors
function getRecentErrors() {
  const raw = safeCmd('pm2 logs polymarket-bot --lines 500 --nostream');
  if (!raw) return [];
  const errors = [];
  for (const line of raw.split('\n')) {
    if (/ERROR|ReferenceError|TypeError|CRASH|CIRCUIT BREAKER|HALT/i.test(line)) {
      if (!/ERROR_RATE/i.test(line)) {
        errors.push(line.replace(/^1\|polymark\s*\|\s*/, '').trim());
      }
    }
  }
  return errors.slice(-10);
}

// 6. Model fingerprint
function getModelSha() {
  try {
    const xgb = fs.readFileSync(path.join(ROOT, 'public', 'ml', 'xgboost_model.json'));
    const crypto = require('crypto');
    return crypto.createHash('sha256').update(xgb).digest('hex').slice(0, 12);
  } catch { return null; }
}

// 7. Observation mode flags (last config snapshot)
function getEnvFlags() {
  const p = path.join(ROOT, 'bot', '.env');
  if (!fs.existsSync(p)) return {};
  const lines = fs.readFileSync(p, 'utf-8').split('\n');
  const want = ['DRY_RUN', 'AUTO_ACTIVATE_DEPOSITS', 'SHADOW_CAPTURE'];
  const o = {};
  for (const line of lines) {
    const m = line.match(/^([A-Z_]+)\s*=\s*(.*)$/);
    if (m && want.includes(m[1])) o[m[1]] = m[2].trim();
  }
  return o;
}

// ─── build snapshot ───
const v19DeployMs = getV19Deploy();
const v19ElapsedMs = Date.now() - v19DeployMs;
const snapshot = {
  ts: Date.now(),
  pm2: getPm2(),
  state: getState(),
  v19: {
    deployMs: v19DeployMs,
    elapsedHours: v19ElapsedMs / 3600000,
    trades: getV19Trades(v19DeployMs),
  },
  modelSha: null, // populated below (require has circular issues with crypto in some Node versions)
  errors: getRecentErrors(),
  env: getEnvFlags(),
};
try {
  const crypto = await import('crypto');
  const xgb = fs.readFileSync(path.join(ROOT, 'public', 'ml', 'xgboost_model.json'));
  snapshot.modelSha = crypto.createHash('sha256').update(xgb).digest('hex').slice(0, 12);
} catch {}

if (args.json) { console.log(JSON.stringify(snapshot, null, 2)); process.exit(0); }

// ─── human format ───
function header(s) { console.log(`\n══════ ${s} ══════`); }

console.log(`v19 Status Dashboard @ ${new Date().toISOString()}`);

header('Bot Process');
if (!snapshot.pm2) console.log('  PM2 unreachable — bot daemon may be down');
else if (!snapshot.pm2.found) console.log('  ⚠️  polymarket-bot NOT in PM2 list — bot likely stopped');
else {
  const p = snapshot.pm2;
  const statusIcon = p.status === 'online' ? '🟢' : '🔴';
  console.log(`  ${statusIcon} Status: ${p.status} | PID ${p.pid}`);
  console.log(`  Uptime: ${fmtDuration(p.uptime)} | Restarts: ${p.restarts}`);
  console.log(`  Memory: ${fmtBytes(p.memory)} | CPU: ${p.cpu}%`);
}

header('Bankroll');
const s = snapshot.state;
if (!s) console.log('  state.json unreadable');
else {
  const drawdownPct = s.drawdownFromPeak * 100;
  const drawdownEmoji = drawdownPct < -10 ? '🔴' : drawdownPct < -5 ? '🟡' : '🟢';
  console.log(`  Current:    $${s.bankroll?.toFixed(2)}`);
  console.log(`  Peak:       $${s.peak?.toFixed(2)}`);
  console.log(`  Drawdown:   ${drawdownEmoji} ${drawdownPct.toFixed(1)}% from peak`);
  console.log(`  StartOfDay: $${s.startOfDay?.toFixed(2)} ${s.startOfDay < s.bankroll - 5 ? '(stale)' : ''}`);
  console.log(`  Consec L:   ${s.consecutiveLosses}`);
  console.log(`  All-time:   ${s.totalTrades} trades, ${s.wins}W/${s.losses}L, WR ${(s.allTimeWR * 100).toFixed(1)}%`);
}

header('v19 Window');
const v = snapshot.v19;
const deployDt = new Date(v.deployMs).toISOString();
console.log(`  Deploy:     ${deployDt}`);
console.log(`  Elapsed:    ${v.elapsedHours.toFixed(2)}h`);
console.log(`  Model SHA:  ${snapshot.modelSha ?? '?'}`);
console.log(`  Trades:     ${v.trades.total} total`);
console.log(`    FOK:      ${v.trades.fok.w}W/${v.trades.fok.l}L (${v.trades.fok.p} pending)`);
console.log(`    LIMIT:    ${v.trades.limit.w}W/${v.trades.limit.l}L (${v.trades.limit.p} pending)`);
console.log(`    ARB:      ${v.trades.arb.w}W/${v.trades.arb.l}L (${v.trades.arb.p} pending)`);
console.log(`  PnL:        $${v.trades.pnl.toFixed(2)}`);

header('Config Flags');
for (const [k, vl] of Object.entries(snapshot.env)) console.log(`  ${k}=${vl}`);

header('Recent Errors / Alerts (last 10)');
if (snapshot.errors.length === 0) console.log('  🟢 None');
else for (const e of snapshot.errors) console.log(`  ${e.slice(0, 160)}`);

header('Quick Actions');
console.log(`  Performance:  node bot/scripts/v19_performance_report.mts`);
console.log(`  Tuning list:  node bot/scripts/tune_v19_config.mts --list`);
console.log(`  Balances:     node bot/scripts/check_balances.mts`);
console.log(`  Logs live:    pm2 logs polymarket-bot --lines 20`);
console.log(`  Stop bot:     pm2 stop polymarket-bot`);
console.log();
