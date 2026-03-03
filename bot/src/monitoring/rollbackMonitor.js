/**
 * Post-deploy rollback monitor.
 *
 * Called from perfMonitor.js every 15 min. Checks if a recently-deployed model
 * has degraded live win rate beyond threshold, and auto-rollbacks if so.
 *
 * Reads: bot/data/last_deploy.json (written by autoRetrain.js)
 * Uses:  positionTracker stats for live WR, autoRetrain for rollback
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { createLogger } from '../logger.js';
import { getStats } from '../trading/positionTracker.js';
import { notify } from './notifier.js';

const log = createLogger('Rollback');

// ── Config from env ──
const WINDOW_HR = Number(process.env.RETRAIN_ROLLBACK_WINDOW_HR) || 48;
const WR_DROP_PP = Number(process.env.RETRAIN_ROLLBACK_WR_DROP) || 10;
const MIN_TRADES = 15;

// Import paths from autoRetrain (shared constants)
// We resolve manually to avoid circular dependency with autoRetrain's full pipeline
import { fileURLToPath } from 'url';
import { dirname } from 'path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, '..', '..', 'data');
const DEPLOY_MARKER = resolve(DATA_DIR, 'last_deploy.json');
const ML_DIR = resolve(__dirname, '..', '..', '..', 'public', 'ml');
const BACKUP_DIR = resolve(ML_DIR, 'backups');
const ROOT = resolve(__dirname, '..', '..', '..');
const MODEL_FILES = ['xgboost_model.json', 'lightgbm_model.json', 'norm_browser.json'];

import { execSync } from 'child_process';
import { copyFileSync } from 'fs';

/**
 * Check if a recently-deployed model needs rollback.
 * Called from perfMonitor.monitorCycle() every 15 min.
 */
export function checkRollback() {
  if (!existsSync(DEPLOY_MARKER)) return;

  let marker;
  try {
    marker = JSON.parse(readFileSync(DEPLOY_MARKER, 'utf-8'));
  } catch {
    return;
  }

  // Already accepted — stop checking
  if (marker.accepted) return;

  const elapsed = Date.now() - marker.deployedAt;
  const windowMs = WINDOW_HR * 60 * 60 * 1000;

  // Past monitoring window — mark as accepted
  if (elapsed > windowMs) {
    marker.accepted = true;
    writeFileSync(DEPLOY_MARKER, JSON.stringify(marker, null, 2));
    log.info(`Model accepted after ${WINDOW_HR}hr monitoring window`);
    return;
  }

  // Not enough trades yet
  const stats = getStats();
  const totalTrades = stats.wins + stats.losses;

  // Snapshot trades-at-deploy on first check
  if (marker.tradesAtDeploy === 0 && totalTrades > 0) {
    marker.tradesAtDeploy = totalTrades;
    writeFileSync(DEPLOY_MARKER, JSON.stringify(marker, null, 2));
    return; // First check — just record baseline
  }

  const newTrades = totalTrades - marker.tradesAtDeploy;
  if (newTrades < MIN_TRADES) {
    log.debug(`Rollback monitor: ${newTrades}/${MIN_TRADES} trades since deploy`);
    return;
  }

  // Check WR
  const liveWr = stats.winRate * 100;  // percentage
  const deployAcc = (marker.metrics?.accuracy ?? 0.70) * 100;
  const drop = deployAcc - liveWr;

  log.info(`Rollback check: live WR=${liveWr.toFixed(1)}%, expected=${deployAcc.toFixed(1)}%, drop=${drop.toFixed(1)}pp (threshold=${WR_DROP_PP}pp)`);

  if (drop < WR_DROP_PP) return;  // WR is OK

  // ── ROLLBACK ──
  log.error(`WIN RATE DEGRADED: ${drop.toFixed(1)}pp drop since deploy. Triggering auto-rollback.`);

  let restored = 0;
  for (const file of MODEL_FILES) {
    const src = resolve(BACKUP_DIR, `rollback_${file}`);
    const dst = resolve(ML_DIR, file);
    if (!existsSync(src)) continue;
    copyFileSync(src, dst);
    restored++;
  }

  if (restored === 0) {
    log.error('No rollback files found — cannot auto-rollback');
    notify('critical', 'Auto-rollback FAILED: no backup files found', { key: 'rollback' });
    // Mark accepted to stop repeated alerts
    marker.accepted = true;
    writeFileSync(DEPLOY_MARKER, JSON.stringify(marker, null, 2));
    return;
  }

  // Restart bot with old model
  try {
    execSync('npx pm2 restart polymarket-bot', { cwd: ROOT, timeout: 30_000, stdio: 'pipe' });
    log.info('Bot restarted with rolled-back model');
  } catch (err) {
    log.error(`PM2 restart failed during rollback: ${err.message}`);
  }

  const msg = `AUTO-ROLLBACK: live WR ${liveWr.toFixed(1)}% vs expected ${deployAcc.toFixed(1)}% (${drop.toFixed(1)}pp drop, ${newTrades} trades). Model reverted.`;
  notify('critical', msg, { key: 'rollback' });

  // Mark as accepted (reverted) to stop further checks
  marker.accepted = true;
  marker.rolledBack = true;
  marker.rollbackAt = Date.now();
  writeFileSync(DEPLOY_MARKER, JSON.stringify(marker, null, 2));
}
