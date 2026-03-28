/**
 * Concept Drift Detector
 *
 * Detects when the ML model's live performance has drifted from its training
 * baseline due to market regime changes (e.g., choppy BTC from macro events).
 *
 * Algorithm: Dual-gate detection
 *   1. CUSUM (Page-Hinkley): Sensitive to gradual drift over many trades.
 *      Accumulates deviations from expected accuracy; fires when cumulative
 *      drop exceeds threshold.
 *   2. Hard threshold: Fires immediately if recent accuracy drops sharply
 *      below baseline (e.g., -15pp over last 30 trades).
 *   3. Confidence drop: Secondary signal when avg ML confidence falls,
 *      indicating the model is "less sure" — typical in choppy regimes.
 *
 * Actions on detection:
 *   - Always: log.warn + Telegram/Discord notification
 *   - If DRIFT_AUTO_RETRAIN=true: spawn autoRetrain.js --force
 *   - Enforce cooldown (default 7 days) between retrain triggers
 *
 * Config (bot/.env):
 *   DRIFT_WINDOW=50              Rolling window for accuracy (trades)
 *   DRIFT_MIN_TRADES=30          Min trades before evaluation
 *   DRIFT_WR_DROP_PP=15          Hard threshold: pp drop from baseline
 *   DRIFT_CUSUM_THRESHOLD=5      CUSUM threshold (higher = less sensitive)
 *   DRIFT_CONF_DROP=0.08         Confidence drop to flag (e.g. 0.08 = 8pp)
 *   DRIFT_COOLDOWN_DAYS=7        Days between auto-retrain triggers
 *   DRIFT_AUTO_RETRAIN=false     Set true to auto-trigger retrain
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { createLogger } from '../logger.js';
import { notify } from './notifier.js';
import { BOT_CONFIG } from '../config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const log = createLogger('DriftDetect');

// ── Paths ──
const DATA_DIR = resolve(__dirname, '..', '..', 'data');
const ML_DIR   = resolve(__dirname, '..', '..', '..', 'public', 'ml');
const ROOT     = resolve(__dirname, '..', '..', '..');
const DRIFT_LOG     = resolve(DATA_DIR, 'drift_log.jsonl');
const DRIFT_STATE   = resolve(DATA_DIR, 'drift_state.json');
const RETRAIN_LOCK  = resolve(DATA_DIR, 'retrain.lock');

// ── Config from env ──
function envNum(key, def, min = -Infinity, max = Infinity) {
  const v = Number(process.env[key]);
  return Number.isFinite(v) && v >= min && v <= max ? v : def;
}

const CFG = {
  window:          envNum('DRIFT_WINDOW', 50, 10, 500),
  minTrades:       envNum('DRIFT_MIN_TRADES', 30, 10, 200),
  wrDropPp:        envNum('DRIFT_WR_DROP_PP', 15, 5, 50),          // hard threshold pp
  cusumThreshold:  envNum('DRIFT_CUSUM_THRESHOLD', 5, 1, 30),       // CUSUM sensitivity
  confDrop:        envNum('DRIFT_CONF_DROP', 0.08, 0.02, 0.30),     // confidence drop
  cooldownDays:    envNum('DRIFT_COOLDOWN_DAYS', 7, 1, 30),
  autoRetrain:     process.env.DRIFT_AUTO_RETRAIN === 'true',
};

// ── CUSUM in-memory state (persisted across calls) ──
let cusumState = {
  sum: 0,           // CUSUM accumulator (negative = model underperforming)
  lastReset: 0,
};

// ── Load model baseline accuracy ──
function loadBaseline() {
  // Try reading from deployed model's embedded metrics
  try {
    const xgb = JSON.parse(readFileSync(resolve(ML_DIR, 'xgboost_model.json'), 'utf-8'));
    if (xgb?.metrics?.accuracy && xgb.metrics.accuracy > 0.5) {
      return xgb.metrics.accuracy;
    }
  } catch { /* fallback */ }

  // Fallback: v20 deployed accuracy (120d hl90, Mar 2026)
  return 0.8021;
}

// ── Load recent trades with ML accuracy data from journal ──
function loadRecentMlTrades(windowSize) {
  const trades = [];

  try {
    if (!existsSync(BOT_CONFIG.journalFile)) return trades;
    const content = readFileSync(BOT_CONFIG.journalFile, 'utf-8').trim();
    if (!content) return trades;

    const lines = content.split('\n').filter(Boolean);

    // Scan from end (most recent) until we have windowSize ML trades
    for (let i = lines.length - 1; i >= 0 && trades.length < windowSize; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        const mlWasRight = entry.analysis?.mlWasRight;
        const mlConf     = entry.entry?.mlConfidence ?? null;

        // Skip DRY_RUN and trades without ML data
        if (entry.entry?.dryRun) continue;
        if (mlWasRight == null) continue;

        trades.unshift({
          ts:          entry._ts ?? entry.entry?.enteredAt ?? 0,
          mlWasRight:  mlWasRight === true,
          mlConf:      mlConf,
          outcome:     entry.analysis?.outcome,
        });
      } catch { /* skip malformed */ }
    }
  } catch (err) {
    log.warn(`Failed to load journal for drift check: ${err.message}`);
  }

  return trades;
}

// ── Load persisted drift state ──
function loadDriftState() {
  try {
    if (existsSync(DRIFT_STATE)) {
      const d = JSON.parse(readFileSync(DRIFT_STATE, 'utf-8'));
      // Restore CUSUM accumulator
      if (typeof d.cusumSum === 'number') cusumState.sum = d.cusumSum;
      if (typeof d.cusumLastReset === 'number') cusumState.lastReset = d.cusumLastReset;
      return d;
    }
  } catch { /* fresh start */ }
  return { lastRetrainTs: 0, lastDriftTs: 0, cusumSum: 0, cusumLastReset: 0 };
}

function saveDriftState(state) {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(DRIFT_STATE, JSON.stringify({
      ...state,
      cusumSum: cusumState.sum,
      cusumLastReset: cusumState.lastReset,
      _updated: Date.now(),
    }, null, 2));
  } catch (err) {
    log.warn(`Failed to save drift state: ${err.message}`);
  }
}

// ── Log drift event ──
function logDriftEvent(entry) {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    appendFileSync(DRIFT_LOG, JSON.stringify({ ...entry, _ts: Date.now() }) + '\n');
  } catch { /* non-fatal */ }
}

// ── Trigger auto-retrain ──
function triggerRetrain(reason) {
  if (!CFG.autoRetrain) {
    log.warn(`Drift retrain suppressed (DRIFT_AUTO_RETRAIN=false). Reason: ${reason}`);
    return false;
  }

  if (existsSync(RETRAIN_LOCK)) {
    log.warn('Drift retrain skipped: retrain already in progress (lock file exists)');
    return false;
  }

  log.info('Triggering auto-retrain due to concept drift...');
  try {
    const retrainScript = resolve(__dirname, '..', 'autoRetrain.js');
    execSync(
      `node --env-file="${resolve(ROOT, 'bot', '.env')}" "${retrainScript}" --force`,
      { cwd: ROOT, timeout: 0, detached: true, stdio: 'ignore' }
    );
    log.info('Auto-retrain process spawned');
    return true;
  } catch (err) {
    log.error(`Failed to spawn retrain: ${err.message}`);
    return false;
  }
}

// ── CUSUM update ──
// Each correct prediction = +1 deviation from (baseline - slack)
// Each wrong prediction   = -(baseline - slack)
// Accumulates negatively when model underperforms → fires at -threshold
function updateCusum(mlWasRight, baseline) {
  const slack = 0.03; // allow 3pp below baseline before CUSUM starts accumulating
  const expected = baseline - slack;  // e.g. 0.84 - 0.03 = 0.81
  const observation = mlWasRight ? 1 : 0;
  const deviation = observation - expected;  // positive = better, negative = worse
  cusumState.sum = Math.max(0, cusumState.sum - deviation);  // CUSUM+ (lower = worse performance)
  return cusumState.sum;
}

// ── Main check function (called from perfMonitor.monitorCycle) ──
export function checkDrift() {
  const state = loadDriftState();
  const baseline = loadBaseline();
  const trades   = loadRecentMlTrades(CFG.window);

  if (trades.length < CFG.minTrades) {
    log.debug(`Drift check skipped: only ${trades.length}/${CFG.minTrades} ML trades available`);
    return { status: 'insufficient_data', trades: trades.length };
  }

  // ── Compute metrics over rolling window ──
  const correct = trades.filter(t => t.mlWasRight).length;
  const accuracy = correct / trades.length;

  const confs = trades.map(t => t.mlConf).filter(c => c != null);
  const avgConf = confs.length > 0 ? confs.reduce((a, b) => a + b, 0) / confs.length : null;

  // Recent 20 trades for faster signal
  const recent = trades.slice(-20);
  const recentCorrect = recent.filter(t => t.mlWasRight).length;
  const recentAccuracy = recentCorrect / recent.length;

  // ── Update CUSUM with newest trade ──
  const latestTrade = trades[trades.length - 1];
  if (latestTrade && latestTrade.ts > (state.cusumLastReset ?? 0)) {
    updateCusum(latestTrade.mlWasRight, baseline);
  }

  // ── Gate 1: Hard threshold ──
  const drop     = baseline - accuracy;         // pp drop from baseline (full window)
  const dropRecent = baseline - recentAccuracy; // pp drop from baseline (recent 20)
  const hardFire = drop >= (CFG.wrDropPp / 100) || dropRecent >= ((CFG.wrDropPp + 5) / 100);

  // ── Gate 2: CUSUM threshold ──
  const cusumFire = cusumState.sum >= CFG.cusumThreshold;

  // ── Gate 3: Confidence drop ──
  const baselineConf = 0.72; // typical avg confidence for v20 (lower accuracy → less extreme probs)
  const confFire = avgConf != null && (baselineConf - avgConf) >= CFG.confDrop;

  // ── Build result object ──
  const result = {
    status: 'ok',
    trades:          trades.length,
    accuracy:        Math.round(accuracy * 10000) / 100,        // pct
    recentAccuracy:  Math.round(recentAccuracy * 10000) / 100,
    baseline:        Math.round(baseline * 10000) / 100,
    drop:            Math.round(drop * 10000) / 100,
    avgConf:         avgConf != null ? Math.round(avgConf * 10000) / 100 : null,
    cusumScore:      Math.round(cusumState.sum * 100) / 100,
    hardFire,
    cusumFire,
    confFire,
    driftDetected:   hardFire || cusumFire,
  };

  log.info(
    `Drift check: acc=${result.accuracy}% (${result.drop > 0 ? '-' : '+'}${Math.abs(result.drop).toFixed(1)}pp vs baseline) ` +
    `| recent=${result.recentAccuracy}% | CUSUM=${result.cusumScore} | ` +
    `conf=${result.avgConf != null ? result.avgConf + '%' : 'N/A'} | ` +
    `${trades.length} trades | drift=${result.driftDetected ? '⚠️ YES' : 'NO'}`
  );

  // ── Confidence drop warning (non-blocking) ──
  if (confFire && !result.driftDetected) {
    log.warn(
      `ML confidence drop detected: avg=${result.avgConf}% ` +
      `(baseline ~${Math.round(baselineConf * 100)}%). ` +
      `Possible regime change — monitoring closely.`
    );
    logDriftEvent({ type: 'CONF_DROP', avgConf, baseline: baselineConf, trades: trades.length });
  }

  // ── No drift ──
  if (!result.driftDetected) {
    saveDriftState({ ...state });
    return result;
  }

  // ── Drift detected ──
  result.status = 'drift';

  const cooldownMs = CFG.cooldownDays * 24 * 60 * 60 * 1000;
  const timeSinceLast = Date.now() - (state.lastDriftTs ?? 0);
  const onCooldown = timeSinceLast < cooldownMs;

  const gates = [
    hardFire  && `hard(drop=${result.drop.toFixed(1)}pp)`,
    cusumFire && `CUSUM(score=${result.cusumScore})`,
    confFire  && `conf(drop=${result.avgConf != null ? (baselineConf * 100 - result.avgConf).toFixed(1) : '?'}pp)`,
  ].filter(Boolean).join(', ');

  log.warn(
    `CONCEPT DRIFT DETECTED [${gates}] — ` +
    `acc=${result.accuracy}% vs baseline=${result.baseline}% ` +
    `(${trades.length} trades)${onCooldown ? ' [COOLDOWN]' : ''}`
  );

  // Notify (always, regardless of cooldown)
  const notifyMsg =
    `⚠️ Concept Drift: ML acc=${result.accuracy}% vs baseline=${result.baseline}% ` +
    `(drop ${result.drop.toFixed(1)}pp, ${trades.length} trades). ` +
    `Gates: ${gates}. Market may have regime-shifted.`;
  notify('warn', notifyMsg, { key: 'drift' });

  logDriftEvent({
    type: 'DRIFT_DETECTED',
    gates,
    accuracy: result.accuracy,
    baseline: result.baseline,
    drop: result.drop,
    recentAccuracy: result.recentAccuracy,
    avgConf,
    cusumScore: cusumState.sum,
    trades: trades.length,
    onCooldown,
  });

  // Reset CUSUM after detection to avoid repeated triggering
  cusumState.sum = 0;
  cusumState.lastReset = Date.now();

  // ── Trigger retrain (if off cooldown and enabled) ──
  if (!onCooldown) {
    state.lastDriftTs = Date.now();
    const triggered = triggerRetrain(gates);
    if (triggered) {
      state.lastRetrainTs = Date.now();
      result.retrainTriggered = true;
      log.info('Auto-retrain triggered by drift detector');
    }
  } else {
    const hoursLeft = Math.round((cooldownMs - timeSinceLast) / 3_600_000);
    log.warn(`Drift retrain on cooldown — ${hoursLeft}h remaining`);
    result.cooldownHoursLeft = hoursLeft;
  }

  saveDriftState({ ...state });
  return result;
}

/**
 * Reset CUSUM state (call when model is manually redeployed).
 */
export function resetDriftState() {
  cusumState.sum = 0;
  cusumState.lastReset = Date.now();
  const state = loadDriftState();
  saveDriftState({ ...state, lastRetrainTs: Date.now() });
  log.info('Drift state reset (CUSUM cleared)');
}

/**
 * Get current drift status (for dashboard broadcast).
 */
export function getDriftStatus() {
  const state = loadDriftState();
  const baseline = loadBaseline();
  const trades   = loadRecentMlTrades(Math.min(CFG.window, 50));

  if (trades.length === 0) return { available: false };

  const correct  = trades.filter(t => t.mlWasRight).length;
  const accuracy = Math.round((correct / trades.length) * 10000) / 100;
  const drop     = Math.round((baseline - correct / trades.length) * 10000) / 100;
  const confs    = trades.map(t => t.mlConf).filter(c => c != null);
  const avgConf  = confs.length > 0
    ? Math.round(confs.reduce((a, b) => a + b, 0) / confs.length * 10000) / 100
    : null;

  return {
    available:    true,
    trades:       trades.length,
    accuracy,
    baseline:     Math.round(baseline * 10000) / 100,
    drop,
    avgConf,
    cusumScore:   Math.round(cusumState.sum * 100) / 100,
    cusumThreshold: CFG.cusumThreshold,
    lastDriftTs:  state.lastDriftTs || null,
    lastRetrainTs: state.lastRetrainTs || null,
    autoRetrain:  CFG.autoRetrain,
  };
}
