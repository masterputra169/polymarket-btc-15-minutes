/**
 * Auto-Retrain ML Pipeline — weekly retrain, quality gate, auto-deploy, rollback.
 *
 * Modes:
 *   - Scheduler: `node bot/src/autoRetrain.js` (long-running, sleeps until RETRAIN_DAY/HOUR)
 *   - Manual:    `node bot/src/autoRetrain.js --force` (immediate retrain + deploy)
 *   - Dry-run:   `node bot/src/autoRetrain.js --force --dry-run` (train + gate, no deploy)
 *   - Rollback:  `node bot/src/autoRetrain.js --rollback` (restore last backup)
 *
 * Pipeline:
 *   1. Read current model metrics (baseline)
 *   2. python quickUpdateLookup.py 7 (refresh market lookup)
 *   3. node generateTrainingData.mjs --days N (fresh CSV)
 *   4. python trainXGBoost_v3.py --tune --tune-trials N (train XGB + LGB)
 *   5. Quality gate (absolute + relative checks)
 *   6. Backup current → deploy new → PM2 restart bot
 *   7. Write deploy marker for rollback monitor
 *
 * Requires: --env-file=./bot/.env (loaded by PM2 ecosystem or manually)
 */

import { execSync } from 'child_process';
import {
  readFileSync, writeFileSync, copyFileSync, appendFileSync,
  existsSync, mkdirSync, readdirSync, unlinkSync, rmSync,
} from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createLogger } from './logger.js';
import { notify } from './monitoring/notifier.js';
import { resetDriftState } from './monitoring/driftDetector.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const log = createLogger('AutoRetrain');

// ── Paths ──
const ROOT = resolve(__dirname, '..', '..');                    // frontend/
const ML_DIR = resolve(ROOT, 'public', 'ml');                  // deployed models
const BACKUP_DIR = resolve(ML_DIR, 'backups');                  // timestamped backups
const TRAINING_DIR = resolve(ROOT, 'backtest', 'ml_training');  // training scripts
const OUTPUT_DIR = resolve(TRAINING_DIR, 'output');             // training output
const DATA_DIR = resolve(__dirname, '..', 'data');              // bot/data/
const LOCK_FILE = resolve(DATA_DIR, 'retrain.lock');
const LOG_FILE = resolve(DATA_DIR, 'retrain_log.jsonl');
const DEPLOY_MARKER = resolve(DATA_DIR, 'last_deploy.json');

const MODEL_FILES = ['xgboost_model.json', 'lightgbm_model.json', 'norm_browser.json'];
const RL_WEIGHTS_FILE = 'rl_agent_weights.json';
const RL_WEIGHTS_OUTPUT = resolve(OUTPUT_DIR, RL_WEIGHTS_FILE);
const RL_WEIGHTS_DEPLOYED = resolve(ML_DIR, RL_WEIGHTS_FILE);

// ── Config from env ──
function envNum(key, def, min = -Infinity, max = Infinity) {
  const v = Number(process.env[key]);
  return Number.isFinite(v) && v >= min && v <= max ? v : def;
}

const CFG = {
  dayOfWeek:      envNum('RETRAIN_DAY_OF_WEEK', 0, 0, 6),       // 0=Sunday
  hourUtc:        envNum('RETRAIN_HOUR_UTC', 3, 0, 23),          // 3 AM UTC
  days:           envNum('RETRAIN_DAYS', 540, 30, 1500),
  tuneTrials:     envNum('RETRAIN_TUNE_TRIALS', 100, 10, 500),
  minAccuracy:    envNum('RETRAIN_MIN_ACCURACY', 0.70, 0.50, 0.99),
  minAuc:         envNum('RETRAIN_MIN_AUC', 0.80, 0.50, 0.99),
  maxAccDrop:     envNum('RETRAIN_MAX_ACC_DROP', 0.02, 0, 0.20),
  maxAucDrop:     envNum('RETRAIN_MAX_AUC_DROP', 0.01, 0, 0.10),
};

// ── CLI args ──
const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const DRY_RUN = args.includes('--dry-run');
const ROLLBACK = args.includes('--rollback');
const HELP = args.includes('--help') || args.includes('-h');

if (HELP) {
  console.log(`
Auto-Retrain ML Pipeline

Usage:
  node bot/src/autoRetrain.js                 Scheduler (long-running, weekly)
  node bot/src/autoRetrain.js --force         Immediate retrain + deploy
  node bot/src/autoRetrain.js --force --dry-run  Train + gate check, no deploy
  node bot/src/autoRetrain.js --rollback      Restore last backup

Env vars (in bot/.env):
  RETRAIN_DAY_OF_WEEK=0   RETRAIN_HOUR_UTC=3    RETRAIN_DAYS=540
  RETRAIN_TUNE_TRIALS=100  RETRAIN_MIN_ACCURACY=0.70  RETRAIN_MIN_AUC=0.80
  RETRAIN_MAX_ACC_DROP=0.02  RETRAIN_MAX_AUC_DROP=0.01
`);
  process.exit(0);
}

// ── Lock ──
function acquireLock() {
  if (existsSync(LOCK_FILE)) {
    const lockData = JSON.parse(readFileSync(LOCK_FILE, 'utf-8'));
    const age = Date.now() - lockData.ts;
    if (age < 8 * 60 * 60 * 1000) {  // <8hr: still active (training can take up to 3hr + data gen 10min)
      log.warn(`Retrain already running (locked ${Math.round(age / 60000)}min ago). Skipping.`);
      return false;
    }
    log.warn('Stale lock detected (>6hr). Overriding.');
  }
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(LOCK_FILE, JSON.stringify({ ts: Date.now(), pid: process.pid }));
  return true;
}

function releaseLock() {
  try { unlinkSync(LOCK_FILE); } catch { /* ignore */ }
}

// ── Audit log ──
function logEntry(entry) {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  appendFileSync(LOG_FILE, JSON.stringify({ ...entry, _ts: Date.now() }) + '\n');
}

// ── Read current model metrics ──
function readCurrentMetrics() {
  const result = { xgb: null, lgb: null, ensemble: null };

  for (const [key, file] of [['xgb', 'xgboost_model.json'], ['lgb', 'lightgbm_model.json']]) {
    const p = resolve(ML_DIR, file);
    if (!existsSync(p)) continue;
    try {
      const d = JSON.parse(readFileSync(p, 'utf-8'));
      result[key] = d.metrics || null;
    } catch { /* skip */ }
  }

  // Ensemble = weighted average using norm_browser weights
  if (result.xgb && result.lgb) {
    const normPath = resolve(ML_DIR, 'norm_browser.json');
    let w = { xgb: 0.45, lgb: 0.55 };
    try {
      const norm = JSON.parse(readFileSync(normPath, 'utf-8'));
      if (norm.ensemble_weights) w = norm.ensemble_weights;
    } catch { /* use defaults */ }
    result.ensemble = {
      accuracy: w.xgb * result.xgb.accuracy + w.lgb * result.lgb.accuracy,
      auc: w.xgb * result.xgb.auc + w.lgb * result.lgb.auc,
    };
  } else if (result.xgb) {
    result.ensemble = { accuracy: result.xgb.accuracy, auc: result.xgb.auc };
  }

  return result;
}

// ── Read new model metrics (from training output) ──
function readNewMetrics() {
  return readMetricsFrom(OUTPUT_DIR);
}

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

  if (result.xgb && result.lgb) {
    const normPath = resolve(dir, 'norm_browser.json');
    let w = { xgb: 0.45, lgb: 0.55 };
    try {
      const norm = JSON.parse(readFileSync(normPath, 'utf-8'));
      if (norm.ensemble_weights) w = norm.ensemble_weights;
    } catch { /* defaults */ }
    result.ensemble = {
      accuracy: w.xgb * result.xgb.accuracy + w.lgb * result.lgb.accuracy,
      auc: w.xgb * result.xgb.auc + w.lgb * result.lgb.auc,
    };
  } else if (result.xgb) {
    result.ensemble = { accuracy: result.xgb.accuracy, auc: result.xgb.auc };
  }

  return result;
}

// ── Quality Gate ──
function qualityGate(current, fresh) {
  const checks = [];
  const ens = fresh.ensemble;
  if (!ens) return { pass: false, checks: [{ name: 'no_metrics', pass: false, detail: 'No ensemble metrics in trained model' }] };

  // Absolute floors
  checks.push({
    name: 'abs_accuracy',
    pass: ens.accuracy >= CFG.minAccuracy,
    detail: `${(ens.accuracy * 100).toFixed(2)}% >= ${(CFG.minAccuracy * 100).toFixed(0)}%`,
  });
  checks.push({
    name: 'abs_auc',
    pass: ens.auc >= CFG.minAuc,
    detail: `${ens.auc.toFixed(4)} >= ${CFG.minAuc.toFixed(2)}`,
  });

  // Relative checks (vs current deployed model)
  if (current.ensemble) {
    const accDrop = current.ensemble.accuracy - ens.accuracy;
    const aucDrop = current.ensemble.auc - ens.auc;
    checks.push({
      name: 'rel_accuracy',
      pass: accDrop <= CFG.maxAccDrop,
      detail: `drop ${(accDrop * 100).toFixed(2)}pp <= ${(CFG.maxAccDrop * 100).toFixed(0)}pp`,
    });
    checks.push({
      name: 'rel_auc',
      pass: aucDrop <= CFG.maxAucDrop,
      detail: `drop ${(aucDrop * 10000).toFixed(0)}bp <= ${(CFG.maxAucDrop * 10000).toFixed(0)}bp`,
    });
  } else {
    checks.push({ name: 'rel_skip', pass: true, detail: 'No current model to compare' });
  }

  return { pass: checks.every(c => c.pass), checks };
}

// ── Backup & Deploy ──
function backupCurrent(tag) {
  if (!existsSync(BACKUP_DIR)) mkdirSync(BACKUP_DIR, { recursive: true });

  for (const file of [...MODEL_FILES, RL_WEIGHTS_FILE]) {
    const src = resolve(ML_DIR, file);
    if (!existsSync(src)) continue;
    // Timestamped backup
    copyFileSync(src, resolve(BACKUP_DIR, `${tag}_${file}`));
    // Quick-rollback copy
    copyFileSync(src, resolve(BACKUP_DIR, `rollback_${file}`));
  }
  log.info(`Backup saved: ${tag}`);
}

function deployNew() {
  for (const file of MODEL_FILES) {
    const src = resolve(OUTPUT_DIR, file);
    const dst = resolve(ML_DIR, file);
    if (!existsSync(src)) {
      log.warn(`Training output missing: ${file} — skipping`);
      continue;
    }
    copyFileSync(src, dst);
    log.info(`Deployed: ${file}`);
  }
  // Deploy RL weights if training succeeded
  if (existsSync(RL_WEIGHTS_OUTPUT)) {
    copyFileSync(RL_WEIGHTS_OUTPUT, RL_WEIGHTS_DEPLOYED);
    log.info(`Deployed: ${RL_WEIGHTS_FILE}`);
  }
}

function pruneBackups(keep = 5) {
  if (!existsSync(BACKUP_DIR)) return;
  const files = readdirSync(BACKUP_DIR).filter(f => f.startsWith('2') && f.includes('_xgboost'));
  const tags = [...new Set(files.map(f => f.split('_xgboost')[0]))].sort();
  if (tags.length <= keep) return;

  const toRemove = tags.slice(0, tags.length - keep);
  for (const tag of toRemove) {
    for (const file of MODEL_FILES) {
      const p = resolve(BACKUP_DIR, `${tag}_${file}`);
      try { unlinkSync(p); } catch { /* ignore */ }
    }
  }
  log.info(`Pruned ${toRemove.length} old backup(s)`);
}

function writeDeployMarker(metrics) {
  const marker = {
    deployedAt: Date.now(),
    metrics,
    tradesAtDeploy: 0,  // rollback monitor fills from positionTracker
    accepted: false,
  };
  writeFileSync(DEPLOY_MARKER, JSON.stringify(marker, null, 2));
  log.info('Deploy marker written');
}

// ── Rollback ──
function rollback() {
  log.info('Rolling back to last backup...');
  let restored = 0;
  for (const file of MODEL_FILES) {
    const src = resolve(BACKUP_DIR, `rollback_${file}`);
    const dst = resolve(ML_DIR, file);
    if (!existsSync(src)) {
      log.warn(`Rollback file missing: rollback_${file}`);
      continue;
    }
    copyFileSync(src, dst);
    restored++;
  }
  if (restored === 0) {
    log.error('No rollback files found! Cannot rollback.');
    return false;
  }
  log.info(`Rolled back ${restored} model file(s)`);
  return true;
}

function restartBot() {
  try {
    log.info('Restarting polymarket-bot via PM2...');
    execSync('npx pm2 restart polymarket-bot', { cwd: ROOT, timeout: 30_000, stdio: 'pipe' });
    log.info('Bot restarted');
  } catch (err) {
    log.error(`PM2 restart failed: ${err.message}`);
  }
}

// ── Run shell command ──
function run(cmd, opts = {}) {
  const { cwd = TRAINING_DIR, timeout = 30 * 60 * 1000 } = opts;
  log.info(`> ${cmd}`);
  const output = execSync(cmd, { cwd, timeout, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
  return output;
}

// ── Main Pipeline ──
async function runPipeline() {
  const startTime = Date.now();
  const tag = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  log.info('');
  log.info('='.repeat(50));
  log.info(`  Auto-Retrain Pipeline — ${tag}`);
  log.info(`  Mode: ${DRY_RUN ? 'DRY-RUN' : 'LIVE'}`);
  log.info('='.repeat(50));

  // Step 1: Read current metrics
  log.info('Step 1/7: Reading current model metrics...');
  const currentMetrics = readCurrentMetrics();
  if (currentMetrics.ensemble) {
    log.info(`  Current: acc=${(currentMetrics.ensemble.accuracy * 100).toFixed(2)}% AUC=${currentMetrics.ensemble.auc.toFixed(4)}`);
  } else {
    log.info('  No current model metrics (first deploy)');
  }

  // Step 2: Refresh Polymarket lookup
  log.info('Step 2/7: Refreshing Polymarket lookup...');
  try {
    run('python quickUpdateLookup.py 7');
    log.info('  Lookup updated');
  } catch (err) {
    log.warn(`  Lookup update failed (non-fatal): ${err.message.slice(0, 200)}`);
  }

  // Step 3: Generate training data
  log.info('Step 3/7: Generating training data...');
  const polyLookup = resolve(TRAINING_DIR, 'polymarket_lookup.json');
  const polyFlag = existsSync(polyLookup) ? `--polymarket-lookup "${polyLookup}"` : '';
  run(`node "${resolve(TRAINING_DIR, 'generateTrainingData.mjs')}" --days ${CFG.days} ${polyFlag}`.trim(), { timeout: 10 * 60 * 1000 });

  // Step 4: Train
  log.info('Step 4/7: Training models (XGB + LGB)...');
  const trainCmd = [
    `python "${resolve(TRAINING_DIR, 'trainXGBoost_v3.py')}"`,
    `--input "${resolve(TRAINING_DIR, 'training_data.csv')}"`,
    `--output-dir "${OUTPUT_DIR}"`,
    '--tune',
    `--tune-trials ${CFG.tuneTrials}`,
    '--holdout-frac 0.125',
    '--recency',
  ].join(' ');
  run(trainCmd, { timeout: 180 * 60 * 1000 });  // 3hr — 100 Optuna trials takes 60-120min on this machine

  // Step 4b: Train RL Agent (non-blocking — failure doesn't abort ML deploy)
  log.info('Step 4b/7: Training RL Agent...');
  try {
    const rlScript = resolve(TRAINING_DIR, 'trainRLAgent.py');
    const journalFile = resolve(DATA_DIR, 'trade_journal.jsonl');
    const rlCmd = [
      `python "${rlScript}"`,
      `--journal "${journalFile}"`,
      `--output "${RL_WEIGHTS_OUTPUT}"`,
      '--augment',
    ].join(' ');
    run(rlCmd, { cwd: TRAINING_DIR, timeout: 10 * 60 * 1000 });
    log.info('  RL Agent trained');
  } catch (err) {
    log.warn(`  RL training failed (non-fatal, ML deploy continues): ${err.message.slice(0, 200)}`);
  }

  // Step 5: Quality gate
  log.info('Step 5/7: Quality gate...');
  const newMetrics = readNewMetrics();
  const gate = qualityGate(currentMetrics, newMetrics);

  for (const c of gate.checks) {
    log.info(`  [${c.pass ? 'PASS' : 'FAIL'}] ${c.name}: ${c.detail}`);
  }

  if (!gate.pass) {
    const msg = `Retrain BLOCKED by quality gate — ${gate.checks.filter(c => !c.pass).map(c => c.name).join(', ')}`;
    log.warn(msg);
    await notify('warn', msg, { key: 'retrain' });
    logEntry({ run: tag, outcome: 'GATE_FAIL', currentMetrics: currentMetrics.ensemble, newMetrics: newMetrics.ensemble, gate: gate.checks, durationMs: Date.now() - startTime });
    return;
  }

  if (DRY_RUN) {
    log.info('DRY-RUN: Quality gate PASSED. Skipping deploy.');
    logEntry({ run: tag, outcome: 'DRY_RUN_PASS', currentMetrics: currentMetrics.ensemble, newMetrics: newMetrics.ensemble, gate: gate.checks, durationMs: Date.now() - startTime });
    return;
  }

  // Step 6: Backup + Deploy + Restart
  log.info('Step 6/7: Backing up current model...');
  backupCurrent(tag);
  pruneBackups(5);

  log.info('Step 6/7: Deploying new model...');
  deployNew();

  restartBot();

  // Step 7: Deploy marker + reset drift state
  log.info('Step 7/7: Writing deploy marker...');
  writeDeployMarker(newMetrics.ensemble);
  try { resetDriftState(); } catch { /* non-fatal */ }

  const elapsed = Math.round((Date.now() - startTime) / 1000);
  const msg = `Retrain SUCCESS — acc: ${(newMetrics.ensemble.accuracy * 100).toFixed(1)}% AUC: ${newMetrics.ensemble.auc.toFixed(4)} (${elapsed}s)`;
  log.info(msg);
  await notify('info', msg, { key: 'retrain' });
  logEntry({ run: tag, outcome: 'DEPLOYED', currentMetrics: currentMetrics.ensemble, newMetrics: newMetrics.ensemble, gate: gate.checks, durationMs: Date.now() - startTime });
}

// ── Scheduler ──
function msUntilNext() {
  const now = new Date();
  const target = new Date(now);
  target.setUTCHours(CFG.hourUtc, 0, 0, 0);

  // Find next occurrence of target day of week
  const daysAhead = (CFG.dayOfWeek - target.getUTCDay() + 7) % 7;
  target.setUTCDate(target.getUTCDate() + daysAhead);

  // If today is the day but we're past the hour, skip to next week
  if (target <= now) {
    target.setUTCDate(target.getUTCDate() + 7);
  }

  return target.getTime() - now.getTime();
}

async function schedulerLoop() {
  log.info(`Scheduler started: retrain every ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][CFG.dayOfWeek]} at ${CFG.hourUtc}:00 UTC`);

  while (true) {
    const waitMs = msUntilNext();
    log.info(`Next retrain in ${Math.round(waitMs / 3600000)}h ${Math.round((waitMs % 3600000) / 60000)}m`);

    await new Promise(r => setTimeout(r, waitMs));

    if (!acquireLock()) continue;
    try {
      await runPipeline();
    } catch (err) {
      log.error(`Pipeline failed: ${err.message}`);
      await notify('critical', `Retrain FAILED: ${err.message.slice(0, 200)}`, { key: 'retrain' });
      logEntry({ run: new Date().toISOString(), outcome: 'ERROR', error: err.message.slice(0, 500) });
    } finally {
      releaseLock();
    }
  }
}

// ── Entrypoint ──
async function main() {
  if (ROLLBACK) {
    const ok = rollback();
    if (ok) {
      restartBot();
      await notify('critical', 'ML model ROLLED BACK (manual)', { key: 'retrain' });
      logEntry({ run: new Date().toISOString(), outcome: 'MANUAL_ROLLBACK' });
    }
    process.exit(ok ? 0 : 1);
  }

  if (FORCE) {
    if (!acquireLock()) process.exit(1);
    try {
      await runPipeline();
    } catch (err) {
      log.error(`Pipeline failed: ${err.message}`);
      await notify('critical', `Retrain FAILED: ${err.message.slice(0, 200)}`, { key: 'retrain' });
      logEntry({ run: new Date().toISOString(), outcome: 'ERROR', error: err.message.slice(0, 500) });
    } finally {
      releaseLock();
    }
    process.exit(0);
  }

  // Default: scheduler mode
  await schedulerLoop();
}

main().catch(err => {
  log.error(`Fatal: ${err.message}`);
  releaseLock();
  process.exit(1);
});

// Export for testing
export { readCurrentMetrics, readNewMetrics, qualityGate, rollback, DEPLOY_MARKER };
