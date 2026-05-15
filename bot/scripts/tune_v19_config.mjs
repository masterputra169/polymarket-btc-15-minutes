#!/usr/bin/env node
/**
 * v19 Config Tuning — preset-based env adjustment with safety guards.
 *
 * Usage:
 *   node bot/scripts/tune_v19_config.mjs --list                # show presets
 *   node bot/scripts/tune_v19_config.mjs --apply conservative  # current default
 *   node bot/scripts/tune_v19_config.mjs --apply tier-balanced --force  # bypass guards
 *   node bot/scripts/tune_v19_config.mjs --rollback            # restore previous .env
 *
 * Safety:
 *   - Backs up .env to .env.backup-<timestamp> before any change
 *   - Default refuses to apply if v19 has <10 resolved trades (force-flag bypasses)
 *   - Default refuses to apply if WR ≥75% (don't tune what's working — force-flag bypasses)
 *   - Each preset documented inline with rationale
 *
 * Created 2026-05-14.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const ENV_PATH = path.join(ROOT, 'bot', '.env');

// ────────────────────────────────────────────────────────────────────────────
// PRESETS — each maps a name to a set of env vars + rationale
// ────────────────────────────────────────────────────────────────────────────

const PRESETS = {
  conservative: {
    description: 'Current default. v19 strict gates — high precision, low volume.',
    appliesWhen: 'After model deploy, while observing baseline (n<10 trades).',
    env: {
      LIMIT_MIN_ML_CONF: '0.62',
      LIMIT_MAX_ENTRY_PRICE: '0.58',
      FOK_MIN_AGREE: '3',
      EDGE_MIN_AGREE_HC: '0',
    },
  },
  'tier-balanced': {
    description: 'Tier-discount aggression based on v19 ML conf. Place limit faster at high-conf tier, current at mid.',
    appliesWhen: 'After 10-20 trades when WR is 60-75% (borderline, not bad).',
    env: {
      LIMIT_MIN_ML_CONF: '0.62',
      LIMIT_MAX_ENTRY_PRICE: '0.60',
      LIMIT_DISCOUNT_HIGH_PCT: '0.04',  // was 0.05 — tighter discount at ≥85% conf
      LIMIT_DISCOUNT_MID_PCT:  '0.07',  // was 0.08 — tighter at ≥70%
      FOK_MIN_AGREE: '2',                // relax FOK requirement (was 3)
    },
  },
  aggressive: {
    description: 'Lower entry threshold + relax FOK. More volume, model accuracy must hold.',
    appliesWhen: 'After 30+ trades when WR ≥80%. Capture more medium-conf opportunities.',
    env: {
      LIMIT_MIN_ML_CONF: '0.55',
      LIMIT_MAX_ENTRY_PRICE: '0.62',
      FOK_MIN_AGREE: '2',
      EDGE_MIN_AGREE_HC: '0',
    },
  },
  'fok-tight': {
    description: 'Tighten FOK to high-conf only (≥80%). Skip limit. Pure model trust.',
    appliesWhen: 'When LIMIT WR consistently underperforms FOK by >10pp.',
    env: {
      LIMIT_MIN_ML_CONF: '0.99',       // effectively disable limit (need impossible conf)
      FOK_MIN_AGREE: '2',
      ML_TRUST_ALONE_THRESHOLD: '0.80',
    },
  },
  rollback: {
    description: 'Rollback to v16 model. Use as emergency exit if v19 underperforms.',
    appliesWhen: 'v19 WR <55% on n≥20 OR catastrophic failure.',
    env: {
      // Marker env var — actual model swap requires file copy outside this script
      ROLLBACK_TO_V16_PENDING: 'true',
    },
    extraNote: 'After --apply rollback, ALSO run: cp public/ml/backups/v16_pre_v19_*/*.json public/ml/ && pm2 restart polymarket-bot',
  },
};

// ────────────────────────────────────────────────────────────────────────────
// CLI parsing
// ────────────────────────────────────────────────────────────────────────────

const args = (() => {
  const o = { _: [] };
  for (let i = 2; i < process.argv.length; i++) {
    const k = process.argv[i];
    if (k === '--list') { o.list = true; continue; }
    if (k === '--rollback') { o.rollback = true; continue; }
    if (k === '--force') { o.force = true; continue; }
    if (k === '--apply' && i + 1 < process.argv.length) { o.apply = process.argv[++i]; continue; }
    if (k === '--dry-run') { o.dryRun = true; continue; }
    if (k.startsWith('--')) o[k.slice(2)] = true;
    else o._.push(k);
  }
  return o;
})();

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function loadEnvFile(p) {
  const txt = fs.readFileSync(p, 'utf-8');
  return txt.split('\n');
}

function getEnvVal(lines, key) {
  for (const l of lines) {
    const m = l.match(new RegExp(`^${key}\\s*=\\s*(.*)$`));
    if (m) return m[1].trim();
  }
  return null;
}

function setEnvVal(lines, key, val) {
  let found = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].match(new RegExp(`^${key}\\s*=`))) {
      lines[i] = `${key}=${val}`;
      found = true;
      break;
    }
  }
  if (!found) lines.push(`${key}=${val}`);
  return lines;
}

function backupEnv() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const bk = `${ENV_PATH}.backup-${ts}`;
  fs.copyFileSync(ENV_PATH, bk);
  return bk;
}

function getTradeStatsSinceV19() {
  // Quick stats: count v19 trades + WR
  const journal = path.join(ROOT, 'bot', 'data', 'trade_journal.jsonl');
  if (!fs.existsSync(journal)) return { n: 0, wins: 0, losses: 0 };

  // v19 deploy time = ctime of backup folder
  const backupDir = path.join(ROOT, 'public', 'ml', 'backups', 'v16_pre_v19_2026-05-14T05-46-58');
  const sinceMs = fs.existsSync(backupDir) ? Math.floor(fs.statSync(backupDir).ctimeMs) : 0;

  let w = 0, l = 0, p = 0;
  for (const line of fs.readFileSync(journal, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      const ts = (r.entry || {}).enteredAt || 0;
      if (ts < sinceMs) continue;
      const o = (r.analysis || {}).outcome;
      if (o === 'WIN') w++;
      else if (o === 'LOSS') l++;
      else p++;
    } catch {}
  }
  return { n: w + l, wins: w, losses: l, pending: p, wr: w + l > 0 ? w / (w + l) : null };
}

// ────────────────────────────────────────────────────────────────────────────
// Commands
// ────────────────────────────────────────────────────────────────────────────

if (args.list || (!args.apply && !args.rollback)) {
  console.log('Available presets:\n');
  for (const [name, p] of Object.entries(PRESETS)) {
    console.log(`  ${name}`);
    console.log(`    ${p.description}`);
    console.log(`    Use when: ${p.appliesWhen}`);
    console.log(`    Vars: ${Object.entries(p.env).map(([k, v]) => `${k}=${v}`).join(', ')}`);
    if (p.extraNote) console.log(`    NOTE: ${p.extraNote}`);
    console.log();
  }
  console.log('Usage:');
  console.log('  node bot/scripts/tune_v19_config.mjs --apply <preset> [--force] [--dry-run]');
  console.log('  node bot/scripts/tune_v19_config.mjs --rollback           # restore latest backup');
  process.exit(0);
}

if (args.rollback) {
  // Find latest .env.backup-*
  const dir = path.dirname(ENV_PATH);
  const backups = fs.readdirSync(dir)
    .filter(f => f.startsWith('.env.backup-'))
    .map(f => ({ name: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (backups.length === 0) { console.error('No backup found.'); process.exit(1); }
  const latest = backups[0];
  console.log(`Rolling back to ${latest.name}...`);
  if (args.dryRun) { console.log('[DRY] Would restore. Exit.'); process.exit(0); }
  fs.copyFileSync(path.join(dir, latest.name), ENV_PATH);
  console.log('Restored .env. Restart bot to apply: pm2 restart polymarket-bot');
  process.exit(0);
}

// Apply preset
const presetName = args.apply;
const preset = PRESETS[presetName];
if (!preset) {
  console.error(`Unknown preset: ${presetName}`);
  console.error(`Available: ${Object.keys(PRESETS).join(', ')}`);
  process.exit(1);
}

// Safety guards (skip with --force)
const stats = getTradeStatsSinceV19();
console.log(`v19 trade stats: n=${stats.n} (${stats.wins}W/${stats.losses}L, pending=${stats.pending}, WR=${stats.wr != null ? (stats.wr * 100).toFixed(0) + '%' : 'n/a'})`);
console.log();

if (!args.force && presetName !== 'conservative' && presetName !== 'rollback') {
  if (stats.n < 10) {
    console.error(`SAFETY: Refusing to apply '${presetName}' with only ${stats.n} resolved trades.`);
    console.error(`        Need n≥10 for sample sufficiency. Use --force to override.`);
    process.exit(1);
  }
  if (stats.wr != null && stats.wr >= 0.75) {
    console.error(`SAFETY: Refusing to apply '${presetName}' — current WR ${(stats.wr * 100).toFixed(0)}% is healthy.`);
    console.error(`        Don't tune what's working. Use --force to override.`);
    process.exit(1);
  }
}

console.log(`Applying preset: ${presetName}`);
console.log(`  ${preset.description}`);
console.log();

let lines = loadEnvFile(ENV_PATH);
const changes = [];
for (const [key, val] of Object.entries(preset.env)) {
  const old = getEnvVal(lines, key);
  changes.push({ key, old, new: val });
  lines = setEnvVal(lines, key, val);
}

console.log('Changes:');
for (const c of changes) {
  console.log(`  ${c.key}: ${c.old ?? '<unset>'} → ${c.new}`);
}

if (args.dryRun) {
  console.log('\n[DRY-RUN] No file written. Exit.');
  process.exit(0);
}

const backupPath = backupEnv();
console.log(`\nBackup created: ${backupPath}`);

fs.writeFileSync(ENV_PATH, lines.join('\n'));
console.log(`Updated: ${ENV_PATH}`);

if (preset.extraNote) console.log(`\nNOTE: ${preset.extraNote}`);

console.log(`\nNext: restart bot to apply — pm2 restart polymarket-bot`);
console.log(`Rollback: node bot/scripts/tune_v19_config.mjs --rollback`);
