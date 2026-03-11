/**
 * AI Self-Optimizer — reads AI recommendations, validates, applies to .env.
 *
 * Safety gates:
 * - ALLOWED_PARAMS whitelist with min/max bounds
 * - Max 20% change per cycle per parameter
 * - Backup .env before every write
 * - Change log to ai_optimization_log.jsonl
 * - Requires AI_AUTO_OPTIMIZE=true
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { BOT_CONFIG } from '../config.js';
import { createLogger } from '../logger.js';
import { getLastAnalysis } from './postTradeAnalyst.js';

const log = createLogger('SelfOptimizer');

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_FILE = resolve(__dirname, '..', '..', '.env');
const BACKUP_DIR = resolve(__dirname, '..', '..', 'data');
const OPT_LOG_FILE = resolve(BOT_CONFIG.dataDir, 'ai_optimization_log.jsonl');

/** Whitelist of tunable parameters with bounds and env key mapping. */
const ALLOWED_PARAMS = {
  CUT_LOSS_MIN_HOLD_SEC:      { envKey: 'CUT_LOSS_MIN_HOLD_SEC',      min: 60,   max: 900,  type: 'int' },
  CUT_LOSS_MIN_TOKEN_DROP_PCT: { envKey: 'CUT_LOSS_MIN_TOKEN_DROP_PCT', min: 20,   max: 90,   type: 'num' },
  LIMIT_MIN_ML_CONF:          { envKey: 'LIMIT_MIN_ML_CONF',          min: 0.40, max: 0.90, type: 'num' },
  LIMIT_MAX_ENTRY_PRICE:      { envKey: 'LIMIT_MAX_ENTRY_PRICE',      min: 0.45, max: 0.75, type: 'num' },
  ROUTER_FOK_ML:              { envKey: 'ROUTER_FOK_ML',              min: 0.70, max: 0.95, type: 'num' },
  ROUTER_FOK_MAX_PRICE:       { envKey: 'ROUTER_FOK_MAX_PRICE',       min: 0.50, max: 0.75, type: 'num' },
  MAX_BET_AMOUNT_USD:         { envKey: 'MAX_BET_AMOUNT_USD',         min: 1.00, max: 10.0, type: 'num' },
  MAX_DAILY_LOSS_PCT:         { envKey: 'MAX_DAILY_LOSS_PCT',         min: 5,    max: 30,   type: 'num' },
};

const MAX_DELTA_PCT = 0.20; // max 20% change per parameter per cycle

let _lastOptimizeMs = 0;
let _optimizing = false;

/**
 * Attempt to apply AI recommendations if auto-optimize is enabled.
 * Called periodically from bot index.js.
 */
export async function maybeOptimize() {
  if (_optimizing) return;
  if (!BOT_CONFIG.ai.autoOptimize) return;

  const analysis = getLastAnalysis();
  if (!analysis || !analysis.recommendations || analysis.recommendations.length === 0) return;

  // Only optimize once per analysis cycle
  if (_lastOptimizeMs >= (analysis.analyzedAt ?? 0)) return;

  _optimizing = true;
  try {
    await applyRecommendations(analysis.recommendations);
  } catch (err) {
    log.warn(`Optimization failed: ${err.message}`);
  } finally {
    _optimizing = false;
    _lastOptimizeMs = Date.now();
  }
}

/**
 * Apply validated recommendations to .env file.
 */
async function applyRecommendations(recommendations) {
  if (!existsSync(ENV_FILE)) {
    log.warn('.env file not found — skipping optimization');
    return;
  }

  // Read current .env
  const envContent = readFileSync(ENV_FILE, 'utf-8');
  const envLines = envContent.split('\n');

  // Parse current values
  const currentEnv = {};
  for (const line of envLines) {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (match) currentEnv[match[1]] = match[2];
  }

  const applied = [];
  const rejected = [];

  for (const rec of recommendations) {
    const paramDef = ALLOWED_PARAMS[rec.parameter];
    if (!paramDef) {
      rejected.push({ param: rec.parameter, reason: 'not_in_whitelist' });
      continue;
    }

    // Validate confidence threshold
    if (rec.confidence == null || rec.confidence < 0.5) {
      rejected.push({ param: rec.parameter, reason: `low_confidence: ${rec.confidence}` });
      continue;
    }

    // Parse suggested value
    const suggested = paramDef.type === 'int' ? Math.round(Number(rec.suggested)) : Number(rec.suggested);
    if (!Number.isFinite(suggested)) {
      rejected.push({ param: rec.parameter, reason: 'invalid_suggested_value' });
      continue;
    }

    // Bounds check
    if (suggested < paramDef.min || suggested > paramDef.max) {
      rejected.push({ param: rec.parameter, reason: `out_of_bounds: ${suggested} not in [${paramDef.min}, ${paramDef.max}]` });
      continue;
    }

    // Get current value
    const currentRaw = currentEnv[paramDef.envKey];
    const current = currentRaw != null ? Number(currentRaw) : Number(rec.current);
    if (!Number.isFinite(current) || current === 0) {
      rejected.push({ param: rec.parameter, reason: 'cannot_determine_current_value' });
      continue;
    }

    // Max delta check (20% change limit)
    const deltaPct = Math.abs(suggested - current) / Math.abs(current);
    if (deltaPct > MAX_DELTA_PCT) {
      // Clamp to max delta
      const clamped = current > 0
        ? current * (1 + Math.sign(suggested - current) * MAX_DELTA_PCT)
        : current * (1 - Math.sign(suggested - current) * MAX_DELTA_PCT);
      const finalVal = paramDef.type === 'int' ? Math.round(clamped) : Math.round(clamped * 1000) / 1000;
      applied.push({
        param: rec.parameter, envKey: paramDef.envKey,
        from: current, to: finalVal, requestedTo: suggested,
        reason: rec.reason, confidence: rec.confidence, clamped: true,
      });
    } else {
      const finalVal = paramDef.type === 'int' ? suggested : Math.round(suggested * 1000) / 1000;
      applied.push({
        param: rec.parameter, envKey: paramDef.envKey,
        from: current, to: finalVal, requestedTo: suggested,
        reason: rec.reason, confidence: rec.confidence, clamped: false,
      });
    }
  }

  if (applied.length === 0) {
    log.info(`No applicable recommendations (${rejected.length} rejected)`);
    logOptimization({ applied: [], rejected, ts: Date.now() });
    return;
  }

  // Backup .env
  const backupFile = resolve(BACKUP_DIR, `.env.backup_${Date.now()}`);
  try {
    copyFileSync(ENV_FILE, backupFile);
    log.info(`Backed up .env to ${backupFile}`);
  } catch (err) {
    log.warn(`Failed to backup .env: ${err.message} — aborting optimization`);
    return;
  }

  // Apply changes to .env
  let newEnvContent = envContent;
  for (const change of applied) {
    const regex = new RegExp(`^${change.envKey}=.*$`, 'm');
    const newLine = `${change.envKey}=${change.to}`;
    if (regex.test(newEnvContent)) {
      newEnvContent = newEnvContent.replace(regex, newLine);
    } else {
      // Append if key doesn't exist
      newEnvContent += `\n${newLine}`;
    }
  }

  try {
    writeFileSync(ENV_FILE, newEnvContent);
    log.info(`Applied ${applied.length} parameter changes (${rejected.length} rejected). Restart bot to take effect.`);
  } catch (err) {
    log.warn(`Failed to write .env: ${err.message}`);
    // Restore backup
    try { copyFileSync(backupFile, ENV_FILE); } catch (_) { /* */ }
    return;
  }

  // Log changes
  logOptimization({ applied, rejected, ts: Date.now(), backupFile });

  // Notify
  const changeList = applied.map(c =>
    `${c.param}: ${c.from} → ${c.to}${c.clamped ? ' (clamped 20%)' : ''}`
  ).join('\n');
  log.info(`Parameter changes:\n${changeList}`);
}

function logOptimization(entry) {
  try {
    const line = JSON.stringify(entry) + '\n';
    writeFileSync(OPT_LOG_FILE, line, { flag: 'a' });
  } catch (_) { /* */ }
}

/** Get optimizer status for dashboard. */
export function getOptimizerStatus() {
  return {
    enabled: BOT_CONFIG.ai.autoOptimize,
    lastOptimizeMs: _lastOptimizeMs,
    optimizing: _optimizing,
  };
}
