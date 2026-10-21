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
 *   - If DRIFT_AUTO_RETRAIN=true: spawn autoRetrain.ts --force
 *   - Enforce cooldown (default 7 days) between retrain triggers
 *
 * Config (bot/.env):
 *   DRIFT_WINDOW=50              Rolling window for accuracy (trades)
 *   DRIFT_BASELINE_WINDOW=200    Older same-model trades used as the live baseline
 *   DRIFT_MIN_REFERENCE=50       Minimum live baseline trades before a check
 *   DRIFT_MIN_TRADES=30          Min window trades before evaluation
 *   DRIFT_WR_DROP_PP=15          Hard threshold: pp drop from baseline
 *   DRIFT_CUSUM_THRESHOLD=5      CUSUM threshold (higher = less sensitive)
 *   DRIFT_CONF_DROP=0.08         Confidence drop to flag (e.g. 0.08 = 8pp)
 *   DRIFT_COOLDOWN_DAYS=7        Days between auto-retrain triggers
 *   DRIFT_AUTO_RETRAIN=false     Set true to auto-trigger retrain
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync, statSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync, spawn } from 'child_process';
import { createLogger } from '../logger.ts';
import { notify } from './notifier.ts';
import { BOT_CONFIG } from '../config.ts';

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
  baselineWindow:  envNum('DRIFT_BASELINE_WINDOW', 200, 50, 1000),
  minReference:    envNum('DRIFT_MIN_REFERENCE', 50, 20, 500),
  minTrades:       envNum('DRIFT_MIN_TRADES', 30, 10, 200),
  wrDropPp:        envNum('DRIFT_WR_DROP_PP', 15, 5, 50),          // hard threshold pp
  cusumThreshold:  envNum('DRIFT_CUSUM_THRESHOLD', 5, 1, 30),       // CUSUM sensitivity
  confDrop:        envNum('DRIFT_CONF_DROP', 0.08, 0.02, 0.30),     // confidence drop
  cooldownDays:    envNum('DRIFT_COOLDOWN_DAYS', 7, 1, 30),
  autoRetrain:     process.env.DRIFT_AUTO_RETRAIN === 'true',
  // Trades older than this cannot say anything about the CURRENT model. Without
  // the guard the detector compared 109-day-old trades from a previous model
  // against the freshly deployed model's baseline and reported a 16.6pp "drift"
  // every poll — a false alarm that spams alerts and can trigger a needless
  // retrain, while masking the real signal when it eventually appears.
  maxTradeAgeDays: envNum('DRIFT_MAX_TRADE_AGE_DAYS', 21, 1, 365),
};

// ── CUSUM in-memory state (persisted across calls) ──
let cusumState = {
  sum: 0,           // CUSUM accumulator (negative = model underperforming)
  lastReset: 0,
};

// ── Load model baseline accuracy ──
function loadCurrentModelId(): string | null {
  try {
    const norm = JSON.parse(readFileSync(resolve(ML_DIR, 'norm_browser.json'), 'utf-8'));
    return typeof norm?.model_id === 'string' && norm.model_id ? norm.model_id : null;
  } catch {
    return null;
  }
}

function loadBaseline() {
  // Try reading from deployed model's embedded metrics
  try {
    const xgb = JSON.parse(readFileSync(resolve(ML_DIR, 'xgboost_model.json'), 'utf-8'));
    if (xgb?.metrics?.accuracy && xgb.metrics.accuracy > 0.5) {
      return xgb.metrics.accuracy;
    }
  } catch { /* fallback */ }

  // Fallback: v16 deployed accuracy (180d, 86% real labels, Mar 2026)
  return 0.8407;
}

/**
 * When the deployed model file was written — no earlier trade was made by it.
 * 0 when unknown, which leaves only the age window. Added 2026-09-24: a model
 * on a new feature pipeline replaced one whose trades filled the last 21 days,
 * and scoring those against the new baseline would have read as weeks of drift.
 */
function modelDeployedAtMs(): number {
  try {
    return statSync(resolve(ML_DIR, 'xgboost_model.json')).mtimeMs || 0;
  } catch {
    return 0;
  }
}

// ── Load recent trades with ML accuracy data from journal ──
function loadRecentMlTrades(limit: number) {
  const trades: { ts: number; mlWasRight: boolean; mlConf: number | null; outcome?: string }[] = [];
  const minTs = Date.now() - CFG.maxTradeAgeDays * 86_400_000;
  const currentModelId = loadCurrentModelId();
  const deployedAt = modelDeployedAtMs();
  let staleSkipped = 0;
  let otherModelSkipped = 0;

  try {
    if (!existsSync(BOT_CONFIG.journalFile)) return trades;
    const content = readFileSync(BOT_CONFIG.journalFile, 'utf-8').trim();
    if (!content) return trades;
    const lines = content.split('\n').filter(Boolean);

    // Scan from the newest trade backwards. A model swap must not make the old
    // model's trades look like drift of the new one, so match the deployed model
    // id first. The file mtime is only a fallback when a model has no model_id.
    for (let i = lines.length - 1; i >= 0 && trades.length < limit; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        const mlWasRight = entry.analysis?.mlWasRight;
        const mlConf = entry.entry?.mlConfidence ?? null;
        if (mlWasRight == null) continue;

        const ts = Number(entry._ts ?? entry.entry?.enteredAt ?? 0);
        if (ts && ts < minTs) { staleSkipped++; continue; }

        const modelId = entry.entry?.modelId ?? null;
        if (currentModelId) {
          if (modelId !== currentModelId) { otherModelSkipped++; continue; }
        } else if (deployedAt && ts && ts < deployedAt) {
          staleSkipped++;
          continue;
        }

        trades.unshift({
          ts,
          mlWasRight: mlWasRight === true,
          mlConf: Number.isFinite(Number(mlConf)) ? Number(mlConf) : null,
          outcome: entry.analysis?.outcome,
        });
      } catch { /* skip malformed */ }
    }
  } catch (err) {
    log.warn(`Failed to load journal for drift check: ${err.message}`);
  }

  if (otherModelSkipped > 0) {
    log.debug(`Drift check ignored ${otherModelSkipped} trades from other model generations`);
  }
  if (staleSkipped > 0 && trades.length === 0) {
    log.info(
      `Drift check skipped: journal has no current-model trades newer than ${CFG.maxTradeAgeDays}d ` +
      `(${staleSkipped} older entries ignored). Waiting for live evidence.`
    );
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
    const retrainScript = resolve(__dirname, '..', 'autoRetrain.ts');
    // Audit fix (2026-05-14 Tier-1): use spawn() with detached, NOT execSync.
    // execSync ignores `detached` option and blocks until completion. spawn()
    // with detached:true + unref() lets retrain run as background process so
    // bot continues trading without waiting hours for retrain to finish.
    const child = spawn(
      'node',
      [`--env-file=${resolve(ROOT, 'bot', '.env')}`, retrainScript, '--force'],
      { cwd: ROOT, detached: true, stdio: 'ignore' }
    );
    child.unref();  // Allow parent to exit independently
    log.info(`Auto-retrain process spawned (pid=${child.pid})`);
    return true;
  } catch (err) {
    log.error(`Failed to spawn retrain: ${err.message}`);
    return false;
  }
}

// ── Pure assessment (unit-testable; no file/state access) ──
export interface MlDriftTrade {
  ts: number;
  mlWasRight: boolean;
  mlConf: number | null;
  outcome?: string;
}

export interface DriftThresholds {
  wrDropPp: number;
  cusumThreshold: number;
  confDrop: number;
}

export interface DriftAssessment {
  trades: number;
  accuracy: number;
  recentAccuracy: number;
  avgConf: number | null;
  drop: number;
  hardFire: boolean;
  cusumFire: boolean;
  confFire: boolean;
  driftDetected: boolean;
}

/** Compare a recent ML window with a live same-model baseline. */
export function assessDrift(
  trades: MlDriftTrade[],
  baseline: number,
  baselineConf: number | null,
  cusumScore: number,
  cfg: DriftThresholds,
): DriftAssessment {
  const accuracyOf = (rows: MlDriftTrade[]) => rows.length ? rows.filter(t => t.mlWasRight).length / rows.length : 0;
  const confOf = (rows: MlDriftTrade[]) => {
    const confs = rows.map(t => t.mlConf).filter((c): c is number => c != null);
    return confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : null;
  };
  const accuracy = accuracyOf(trades);
  const recentAccuracy = accuracyOf(trades.slice(-20));
  const avgConf = confOf(trades);
  const drop = baseline - accuracy;
  const dropRecent = baseline - recentAccuracy;
  const hardFire = drop >= (cfg.wrDropPp / 100) || dropRecent >= ((cfg.wrDropPp + 5) / 100);
  const cusumFire = cusumScore >= cfg.cusumThreshold;
  const confFire = avgConf != null && baselineConf != null && (baselineConf - avgConf) >= cfg.confDrop;
  return {
    trades: trades.length,
    accuracy,
    recentAccuracy,
    avgConf,
    drop,
    hardFire,
    cusumFire,
    confFire,
    driftDetected: hardFire || cusumFire,
  };
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

  // The detector must compare like with like. The model file contains offline
  // test accuracy (76.8% for the deployed v2 model); live accuracy after the
  // entry filters is structurally lower (~65%). Comparing the two produced a
  // permanent false alarm at the 30-trade mark. Use a live reference window of
  // older trades from the SAME deployed model instead.
  const history = loadRecentMlTrades(CFG.window + CFG.baselineWindow);
  const trades = history.slice(-CFG.window);
  const reference = history.slice(0, Math.max(0, history.length - CFG.window));

  if (trades.length < CFG.minTrades) {
    log.debug(`Drift check skipped: only ${trades.length}/${CFG.minTrades} ML trades available`);
    return { status: 'insufficient_data', trades: trades.length, reference: reference.length };
  }
  if (reference.length < CFG.minReference) {
    log.info(
      `Drift check skipped: ${reference.length}/${CFG.minReference} live reference trades ` +
      `(need a same-model baseline before comparing a ${trades.length}-trade window)`
    );
    return { status: 'insufficient_baseline', trades: trades.length, reference: reference.length };
  }

  const pct = (x: number) => Math.round(x * 10000) / 100;
  const accuracyOf = (rows: MlDriftTrade[]) => rows.filter(t => t.mlWasRight).length / rows.length;
  const confOf = (rows: MlDriftTrade[]) => {
    const confs = rows.map(t => t.mlConf).filter((c): c is number => c != null);
    return confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : null;
  };

  // ── Live baseline: the recent window is scored against the older same-model trades ──
  const baseline = accuracyOf(reference);
  const baselineConf = confOf(reference);
  const recentConf = confOf(trades.slice(-20));

  // ── Update CUSUM with newest trade, using the live baseline ──
  const latestTrade = trades[trades.length - 1];
  if (latestTrade && latestTrade.ts > (state.cusumLastReset ?? 0)) {
    updateCusum(latestTrade.mlWasRight, baseline);
  }

  const assessment = assessDrift(trades, baseline, baselineConf, cusumState.sum, {
    wrDropPp: CFG.wrDropPp,
    cusumThreshold: CFG.cusumThreshold,
    confDrop: CFG.confDrop,
  });

  const { hardFire, cusumFire, confFire, avgConf } = assessment;

  const result: Record<string, any> = {
    ...assessment,
    status: 'ok',
    trades:          trades.length,
    referenceTrades: reference.length,
    accuracy:        pct(assessment.accuracy),
    recentAccuracy:  pct(assessment.recentAccuracy),
    baseline:        pct(baseline),
    baselineSource:  'live-same-model',
    drop:            pct(assessment.drop),
    avgConf:         assessment.avgConf != null ? pct(assessment.avgConf) : null,
    baselineConf:    baselineConf != null ? pct(baselineConf) : null,
    recentConf:      recentConf != null ? pct(recentConf) : null,
    cusumScore:      Math.round(cusumState.sum * 100) / 100,
  };

  log.info(
    `Drift check: acc=${result.accuracy}% (${result.drop > 0 ? '-' : '+'}${Math.abs(result.drop).toFixed(1)}pp vs live baseline ${result.baseline}%) ` +
    `| recent=${result.recentAccuracy}% | CUSUM=${result.cusumScore} | ` +
    `conf=${result.avgConf != null ? result.avgConf + '%' : 'N/A'} | ` +
    `${trades.length} window / ${reference.length} ref | drift=${result.driftDetected ? '⚠️ YES' : 'NO'}`
  );

  // ── Confidence drop is advisory only; never mix it into the trigger list ──
  if (confFire && !result.driftDetected) {
    log.warn(
      `ML confidence drop detected: avg=${result.avgConf}% vs live baseline ${result.baselineConf}%. ` +
      `Monitoring only; no drift trigger.`
    );
    logDriftEvent({
      type: 'CONF_DROP',
      avgConf,
      baselineConf,
      recentConf,
      trades: trades.length,
      referenceTrades: reference.length,
    });
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

  // Only the gates that actually trigger a drift can appear in the alert.
  // Confidence is advisory; it used to be listed here even when it was not a
  // trigger, which made the Telegram message look like three gates had fired.
  const gates = [
    hardFire  && `hard(drop=${result.drop.toFixed(1)}pp)`,
    cusumFire && `CUSUM(score=${result.cusumScore})`,
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
    `Gates: ${gates}. Live baseline ${result.baseline}% from ${reference.length} same-model trades. Market may have regime-shifted.`;
  notify('warn', notifyMsg, { key: 'drift' });

  logDriftEvent({
    type: 'DRIFT_DETECTED',
    gates,
    accuracy: result.accuracy,
    baseline: result.baseline,
    drop: result.drop,
    recentAccuracy: result.recentAccuracy,
    avgConf,
    baselineConf: result.baselineConf,
    referenceTrades: reference.length,
    baselineSource: 'live-same-model',
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
  const history = loadRecentMlTrades(CFG.window + CFG.baselineWindow);
  const trades = history.slice(-CFG.window);
  const reference = history.slice(0, Math.max(0, history.length - CFG.window));
  if (trades.length === 0) return { available: false };

  const pct = (x: number) => Math.round(x * 10000) / 100;
  const accuracy = trades.filter(t => t.mlWasRight).length / trades.length;
  const baseline = reference.length >= CFG.minReference
    ? reference.filter(t => t.mlWasRight).length / reference.length
    : null;
  const confs = trades.map(t => t.mlConf).filter((c): c is number => c != null);
  const avgConf = confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : null;
  const refConfs = reference.map(t => t.mlConf).filter((c): c is number => c != null);
  const baselineConf = refConfs.length ? refConfs.reduce((a, b) => a + b, 0) / refConfs.length : null;

  return {
    available:       true,
    trades:          trades.length,
    referenceTrades: reference.length,
    accuracy:        pct(accuracy),
    baseline:        baseline != null ? pct(baseline) : null,
    baselineSource:  baseline != null ? 'live-same-model' : 'insufficient',
    drop:            baseline != null ? pct(baseline - accuracy) : null,
    avgConf:         avgConf != null ? pct(avgConf) : null,
    baselineConf:    baselineConf != null ? pct(baselineConf) : null,
    modelBaseline:   pct(loadBaseline()),
    cusumScore:      Math.round(cusumState.sum * 100) / 100,
    cusumThreshold:  CFG.cusumThreshold,
    lastDriftTs:     state.lastDriftTs || null,
    lastRetrainTs:   state.lastRetrainTs || null,
    autoRetrain:     CFG.autoRetrain,
  };
}
