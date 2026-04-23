/**
 * deploy_v18.mjs — Manual deploy script for ML v18
 *
 * Usage:
 *   node deploy_v18.mjs           # quality gate + deploy + PM2 restart
 *   node deploy_v18.mjs --dry-run # gate check only, no copy
 *   node deploy_v18.mjs --force   # skip quality gate, deploy anyway
 *
 * What it does:
 *   1. Verify output_v18/ has all 3 model files
 *   2. Parse metrics from model JSON + training_report.txt
 *   3. Quality gate vs current deployed model
 *   4. Backup current → public/ml/backups/v18_prev_*
 *   5. Copy output_v18/* to public/ml/
 *   6. Write deploy marker to bot/data/last_deploy.json
 *   7. PM2 restart polymarket-bot
 */

import {
  existsSync, copyFileSync, readFileSync, writeFileSync,
  mkdirSync, readdirSync, unlinkSync,
} from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TRAINING_DIR = __dirname;
const ROOT         = resolve(__dirname, '..', '..');           // frontend/
const OUTPUT_V18   = resolve(TRAINING_DIR, 'output_v18');
const ML_DIR       = resolve(ROOT, 'public', 'ml');
const BACKUP_DIR   = resolve(ML_DIR, 'backups');
const DATA_DIR     = resolve(ROOT, 'bot', 'data');
const DEPLOY_MARKER = resolve(DATA_DIR, 'last_deploy.json');

const MODEL_FILES = ['xgboost_model.json', 'lightgbm_model.json', 'norm_browser.json'];

const DRY_RUN = process.argv.includes('--dry-run');
const FORCE   = process.argv.includes('--force');

// ── Quality gate floors (match autoRetrain defaults) ──
const MIN_ACCURACY = 0.70;
const MIN_AUC      = 0.80;
const MAX_ACC_DROP = 0.02;   // 2pp max regression
const MAX_AUC_DROP = 0.01;   // 100bp max regression

// ── Helpers ──
function log(msg)  { console.log(`[deploy_v18] ${msg}`); }
function warn(msg) { console.warn(`[deploy_v18] WARN  ${msg}`); }
function err(msg)  { console.error(`[deploy_v18] ERROR ${msg}`); }

function readMetricsFrom(dir) {
  const result = { xgb: null, lgb: null, ensemble: null };
  for (const [key, file] of [['xgb', 'xgboost_model.json'], ['lgb', 'lightgbm_model.json']]) {
    const p = resolve(dir, file);
    if (!existsSync(p)) continue;
    try {
      const d = JSON.parse(readFileSync(p, 'utf-8'));
      result[key] = d.metrics || null;
    } catch { /* skip */ }
  }

  let w = { xgb: 0.75, lgb: 0.25 };
  try {
    const norm = JSON.parse(readFileSync(resolve(dir, 'norm_browser.json'), 'utf-8'));
    if (norm.ensemble_weights) w = norm.ensemble_weights;
  } catch { /* defaults */ }

  if (result.xgb && result.lgb) {
    result.ensemble = {
      accuracy: w.xgb * result.xgb.accuracy + w.lgb * result.lgb.accuracy,
      auc:      w.xgb * result.xgb.auc      + w.lgb * result.lgb.auc,
    };
  } else if (result.xgb) {
    result.ensemble = { accuracy: result.xgb.accuracy, auc: result.xgb.auc };
  }

  return result;
}

function parseReport(dir) {
  const reportPath = resolve(dir, 'training_report.txt');
  if (!existsSync(reportPath)) return null;
  const txt = readFileSync(reportPath, 'utf-8');
  const acc  = txt.match(/Accuracy:\s*([\d.]+)%/)?.[1];
  const auc  = txt.match(/AUC:\s*([\d.]+)/)?.[1];
  const hcWr = txt.match(/High-conf:.*?\(([\d.]+)%,/)?.[1];
  const hcCov = txt.match(/High-conf:.*?,\s*([\d.]+)%\)/)?.[1];
  return {
    accuracy: acc ? parseFloat(acc) / 100 : null,
    auc:      auc ? parseFloat(auc) : null,
    highConfWr:  hcWr  ? parseFloat(hcWr)  : null,
    highConfCov: hcCov ? parseFloat(hcCov) : null,
    raw: txt,
  };
}

function qualityGate(current, fresh) {
  const checks = [];
  const ens = fresh.ensemble;
  if (!ens) {
    err('No ensemble metrics in new model — aborting');
    return false;
  }

  checks.push({ name: 'abs_accuracy', pass: ens.accuracy >= MIN_ACCURACY,
    detail: `${(ens.accuracy*100).toFixed(2)}% >= ${(MIN_ACCURACY*100).toFixed(0)}%` });
  checks.push({ name: 'abs_auc', pass: ens.auc >= MIN_AUC,
    detail: `${ens.auc.toFixed(4)} >= ${MIN_AUC.toFixed(2)}` });

  if (current.ensemble) {
    const accDrop = current.ensemble.accuracy - ens.accuracy;
    const aucDrop = current.ensemble.auc      - ens.auc;
    checks.push({ name: 'rel_accuracy', pass: accDrop <= MAX_ACC_DROP,
      detail: `drop ${(accDrop*100).toFixed(2)}pp <= ${(MAX_ACC_DROP*100).toFixed(0)}pp` });
    checks.push({ name: 'rel_auc', pass: aucDrop <= MAX_AUC_DROP,
      detail: `drop ${(aucDrop*10000).toFixed(0)}bp <= ${(MAX_AUC_DROP*10000).toFixed(0)}bp` });
  }

  let passed = true;
  for (const c of checks) {
    const icon = c.pass ? '✓' : '✗';
    log(`  ${icon} ${c.name.padEnd(16)} ${c.detail}`);
    if (!c.pass) passed = false;
  }
  return passed;
}

function backupCurrent(tag) {
  if (!existsSync(BACKUP_DIR)) mkdirSync(BACKUP_DIR, { recursive: true });
  for (const file of MODEL_FILES) {
    const src = resolve(ML_DIR, file);
    if (!existsSync(src)) continue;
    copyFileSync(src, resolve(BACKUP_DIR, `${tag}_${file}`));
    copyFileSync(src, resolve(BACKUP_DIR, `rollback_${file}`));
  }
  log(`Backup saved: ${tag}`);
}

function pruneBackups(keep = 5) {
  if (!existsSync(BACKUP_DIR)) return;
  const files = readdirSync(BACKUP_DIR).filter(f => f.startsWith('2') && f.includes('_xgboost'));
  const tags = [...new Set(files.map(f => f.split('_xgboost')[0]))].sort();
  if (tags.length <= keep) return;
  const toRemove = tags.slice(0, tags.length - keep);
  for (const tag of toRemove) {
    for (const file of MODEL_FILES) {
      try { unlinkSync(resolve(BACKUP_DIR, `${tag}_${file}`)); } catch { /* ok */ }
    }
  }
  log(`Pruned ${toRemove.length} old backup(s), kept last ${keep}`);
}

// ── Main ──
log('=== ML v18 Deploy Script ===');
if (DRY_RUN) log('DRY-RUN mode — no files will be copied');
if (FORCE)   warn('FORCE mode — quality gate bypassed');

// Step 1: Verify output_v18 files
log('\nStep 1: Verifying output_v18/...');
const missing = MODEL_FILES.filter(f => !existsSync(resolve(OUTPUT_V18, f)));
if (missing.length > 0) {
  err(`Missing files in output_v18/: ${missing.join(', ')}`);
  err('Training may not be complete yet. Run: cat /tmp/train_v18.txt | tail -20');
  process.exit(1);
}
log('  All 3 model files present');

// Step 2: Parse training report
log('\nStep 2: Training report...');
const report = parseReport(OUTPUT_V18);
if (report) {
  log(`  Accuracy:       ${report.accuracy ? (report.accuracy*100).toFixed(2)+'%' : 'N/A'}`);
  log(`  AUC:            ${report.auc ? report.auc.toFixed(4) : 'N/A'}`);
  log(`  High-conf WR:   ${report.highConfWr ? report.highConfWr+'%' : 'N/A'} (${report.highConfCov ? report.highConfCov+'%' : 'N/A'} coverage)`);
} else {
  warn('  training_report.txt not found — relying on model JSON metrics');
}

// Step 3: Read metrics
log('\nStep 3: Reading model metrics...');
const currentMetrics = readMetricsFrom(ML_DIR);
const newMetrics     = readMetricsFrom(OUTPUT_V18);

if (currentMetrics.ensemble) {
  log(`  Current deployed: acc=${(currentMetrics.ensemble.accuracy*100).toFixed(2)}% auc=${currentMetrics.ensemble.auc.toFixed(4)}`);
}
if (newMetrics.ensemble) {
  log(`  v18 new:          acc=${(newMetrics.ensemble.accuracy*100).toFixed(2)}% auc=${newMetrics.ensemble.auc.toFixed(4)}`);
} else {
  warn('  No ensemble metrics in v18 output (metrics not embedded in model JSON)');
  log('  Falling back to training_report.txt values...');
  if (report?.accuracy && report?.auc) {
    newMetrics.ensemble = { accuracy: report.accuracy, auc: report.auc };
    log(`  v18 new:          acc=${(newMetrics.ensemble.accuracy*100).toFixed(2)}% auc=${newMetrics.ensemble.auc.toFixed(4)} (from report)`);
  }
}

// Step 4: Quality gate
log('\nStep 4: Quality gate...');
const gatePass = qualityGate(currentMetrics, newMetrics);

if (!gatePass && !FORCE) {
  err('Quality gate FAILED. Use --force to deploy anyway, or investigate training output.');
  process.exit(1);
} else if (!gatePass && FORCE) {
  warn('Quality gate FAILED but --force set. Proceeding anyway.');
} else {
  log('  Quality gate PASSED');
}

if (DRY_RUN) {
  log('\nDRY-RUN: All checks passed. Exiting without deploying.');
  process.exit(0);
}

// Step 5: Backup current
log('\nStep 5: Backing up current deployed models...');
const tag = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
backupCurrent(tag);
pruneBackups(5);

// Step 6: Deploy
log('\nStep 6: Deploying v18 to public/ml/...');
for (const file of MODEL_FILES) {
  const src = resolve(OUTPUT_V18, file);
  const dst = resolve(ML_DIR, file);
  copyFileSync(src, dst);
  log(`  Copied: ${file}`);
}

// Step 7: Write deploy marker
log('\nStep 7: Writing deploy marker...');
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
writeFileSync(DEPLOY_MARKER, JSON.stringify({
  deployedAt: Date.now(),
  version: 'v18',
  trainingData: 'training_data_v18.csv',
  metrics: newMetrics,
  reportSummary: report ? {
    accuracy: report.accuracy,
    auc: report.auc,
    highConfWr: report.highConfWr,
    highConfCov: report.highConfCov,
  } : null,
  backupTag: tag,
  tradesAtDeploy: 0,
  accepted: false,
}, null, 2));
log('  Deploy marker written to bot/data/last_deploy.json');

// Step 8: PM2 restart
log('\nStep 8: Restarting polymarket-bot via PM2...');
try {
  execSync('npx pm2 restart polymarket-bot', { cwd: ROOT, timeout: 30_000, stdio: 'inherit' });
  log('  Bot restarted successfully');
} catch (e) {
  warn(`  PM2 restart failed: ${e.message}`);
  warn('  Restart manually: pm2 restart polymarket-bot');
}

log('\n=== Deploy v18 COMPLETE ===');
if (newMetrics.ensemble) {
  log(`  Deployed: acc=${(newMetrics.ensemble.accuracy*100).toFixed(2)}% | auc=${newMetrics.ensemble.auc.toFixed(4)}`);
}
log('  Monitor rollback: pm2 logs polymarket-bot | grep rollback');
