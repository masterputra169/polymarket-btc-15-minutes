/**
 * Online Recency ML Calibration with Rolling Brier Self-Guard.
 *
 * Reuses `fitOnlinePlatt()` / `calibrateWithPlatt()` from `jevSettleCalibration.ts`
 * to track recent resolved 15m windows (warm-loaded from `jev_log.jsonl` +
 * `jev_outcomes.json`) and fit a recency-weighted Platt calibrator on live ML
 * `probUp` outputs.
 *
 * Default mode is SHADOW: logs `rawMlBrier` vs `calMlBrier` vs `marketBrier`
 * without altering live ML predictions. In ACTIVE mode, applies calibration
 * ONLY when rolling calibrated Brier strictly beats raw ML Brier.
 */
import { existsSync, readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { BOT_CONFIG } from '../config.ts';
import { createLogger } from '../logger.ts';
import { calibrateWithPlatt, fitOnlinePlatt, type PlattParams } from '../ai/jevSettleCalibration.ts';

const log = createLogger('MlCalib');

const MAX_HISTORY = 300;
const BRIER_WINDOW = 100;
const REFIT_INTERVAL = 15;

export interface MlCalibrationObs {
  slug: string;
  ts: number;
  rawMlProbUp: number;
  marketProbUp: number;
  outcomeUp: 0 | 1;
}

export interface MlCalibrationEvaluation {
  samples: number;
  rawMlBrier: number | null;
  calMlBrier: number | null;
  marketBrier: number | null;
  improvementBrier: number | null;
  allowActive: boolean;
}

export interface MlCalibrationStatus extends MlCalibrationEvaluation {
  mode: 'shadow' | 'active';
  historySize: number;
  platt: PlattParams | null;
}

const _pendingBySlug = new Map<string, { rawMlProbUp: number; marketProbUp: number; ts: number }>();
const _seenSlugs = new Set<string>();
const _history: MlCalibrationObs[] = [];
let _platt: PlattParams | null = null;
let _outcomesSinceFit = 0;

function pushObs(obs: MlCalibrationObs): void {
  if (_seenSlugs.has(obs.slug)) return;
  if (!(obs.rawMlProbUp > 0.005 && obs.rawMlProbUp < 0.995)) return;
  if (!(obs.marketProbUp > 0.01 && obs.marketProbUp < 0.99)) return;
  _seenSlugs.add(obs.slug);
  _history.push(obs);
  while (_history.length > MAX_HISTORY) {
    const dropped = _history.shift();
    if (dropped) _seenSlugs.delete(dropped.slug);
  }
}

export function evaluateMlCalibration(
  history: readonly MlCalibrationObs[],
  platt: PlattParams | null,
  windowSize = BRIER_WINDOW,
): MlCalibrationEvaluation {
  const recent = history.slice(-Math.max(10, windowSize));
  const n = recent.length;
  if (n === 0) {
    return { samples: 0, rawMlBrier: null, calMlBrier: null, marketBrier: null, improvementBrier: null, allowActive: false };
  }
  let rawSum = 0;
  let calSum = 0;
  let mktSum = 0;
  for (const o of recent) {
    const rErr = o.rawMlProbUp - o.outcomeUp;
    const cProb = platt ? calibrateWithPlatt(o.rawMlProbUp, platt) : o.rawMlProbUp;
    const cErr = cProb - o.outcomeUp;
    const mErr = o.marketProbUp - o.outcomeUp;
    rawSum += rErr * rErr;
    calSum += cErr * cErr;
    mktSum += mErr * mErr;
  }
  const rawMlBrier = +(rawSum / n).toFixed(5);
  const calMlBrier = +(calSum / n).toFixed(5);
  const marketBrier = +(mktSum / n).toFixed(5);
  const improvementBrier = +(rawMlBrier - calMlBrier).toFixed(5);
  const minSamples = BOT_CONFIG.mlOnlineCalibration?.minSamples ?? 50;
  const allowActive = Boolean(platt && n >= minSamples && calMlBrier < rawMlBrier);
  return { samples: n, rawMlBrier, calMlBrier, marketBrier, improvementBrier, allowActive };
}

function refitPlatt(): void {
  const cfg = BOT_CONFIG.mlOnlineCalibration;
  const minSamples = cfg?.minSamples ?? 50;
  const halfLife = cfg?.recencyHalfLife ?? 50;
  const samples = _history.map((h) => ({ rawProb: h.rawMlProbUp, outcomeUp: h.outcomeUp }));
  _platt = fitOnlinePlatt(samples, { minSamples, recencyHalfLife: halfLife });
}

/** Record the first valid ML probability observed for a 15m window. */
export function noteMlWindowPrediction(
  slug: string | null | undefined,
  rawMlProbUp: number | null | undefined,
  marketProbUp: number | null | undefined,
): void {
  if (!slug || _pendingBySlug.has(slug) || _seenSlugs.has(slug)) return;
  if (rawMlProbUp == null || !Number.isFinite(rawMlProbUp) || rawMlProbUp <= 0.005 || rawMlProbUp >= 0.995) return;
  if (marketProbUp == null || !Number.isFinite(marketProbUp) || marketProbUp <= 0.01 || marketProbUp >= 0.99) return;
  _pendingBySlug.set(slug, { rawMlProbUp, marketProbUp, ts: Date.now() });
  if (_pendingBySlug.size > 200) {
    const oldest = _pendingBySlug.keys().next().value;
    if (oldest) _pendingBySlug.delete(oldest);
  }
}

/** Feed resolved 15m market outcome into rolling ML Platt calibrator. */
export function recordMlWindowOutcome(slug: string | null | undefined, outcome: 'UP' | 'DOWN' | 0 | 1): boolean {
  if (!slug) return false;
  const pred = _pendingBySlug.get(slug);
  if (!pred) return false;
  _pendingBySlug.delete(slug);
  const outcomeUp: 0 | 1 = outcome === 'UP' || outcome === 1 ? 1 : 0;
  pushObs({
    slug,
    ts: pred.ts,
    rawMlProbUp: pred.rawMlProbUp,
    marketProbUp: pred.marketProbUp,
    outcomeUp,
  });
  _outcomesSinceFit++;
  const minSamples = BOT_CONFIG.mlOnlineCalibration?.minSamples ?? 50;
  if (_history.length >= minSamples && (_platt == null || _outcomesSinceFit >= REFIT_INTERVAL)) {
    refitPlatt();
    _outcomesSinceFit = 0;
  }
  return true;
}

/** Warm-load recent resolved ML predictions from `jev_log.jsonl` + `jev_outcomes.json`. */
export function initMlOnlineCalibration(): MlCalibrationStatus {
  const logFile = BOT_CONFIG.jev?.logFile;
  if (logFile && existsSync(logFile)) {
    const outcomesFile = resolve(dirname(logFile), 'jev_outcomes.json');
    if (existsSync(outcomesFile)) {
      try {
        const outcomes = JSON.parse(readFileSync(outcomesFile, 'utf8')) as Record<string, 'UP' | 'DOWN'>;
        const lines = readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
        const tail = lines.slice(-2000);
        for (const line of tail) {
          let row: any = null;
          try { row = JSON.parse(line); } catch { row = null; }
          if (!row?.slug) continue;
          const out = outcomes[row.slug];
          if (out !== 'UP' && out !== 'DOWN') continue;
          const mlP = row.ml?.probUp;
          const mktP = row.market?.marketUp;
          if (typeof mlP !== 'number' || typeof mktP !== 'number') continue;
          pushObs({
            slug: row.slug,
            ts: Number(row.ts) || Date.now(),
            rawMlProbUp: mlP,
            marketProbUp: mktP,
            outcomeUp: out === 'UP' ? 1 : 0,
          });
        }
        refitPlatt();
      } catch {
        // Non-critical warmup; starts empty cleanly
      }
    }
  }
  const st = getMlOnlineCalibrationStatus();
  const plattTag = st.platt ? `${st.platt.version}(a=${st.platt.a},b=${st.platt.b},n=${st.platt.samples})` : 'warmup';
  log.info(
    `Online ML calibration [${st.mode.toUpperCase()}]: history=${st.historySize} platt=${plattTag}` +
    (st.rawMlBrier != null ? ` rawBrier=${st.rawMlBrier.toFixed(4)} calBrier=${st.calMlBrier?.toFixed(4)} mktBrier=${st.marketBrier?.toFixed(4)} allowActive=${st.allowActive}` : ''),
  );
  return st;
}

/** Calibrate a raw ML probability; applies live only in ACTIVE mode when Brier guard passes. */
export function calibrateMlProbUp(rawMlProbUp: number): {
  rawProbUp: number;
  calibratedProbUp: number;
  appliedProbUp: number;
  applied: boolean;
} {
  if (!Number.isFinite(rawMlProbUp)) {
    return { rawProbUp: 0.5, calibratedProbUp: 0.5, appliedProbUp: 0.5, applied: false };
  }
  const calibratedProbUp = _platt ? calibrateWithPlatt(rawMlProbUp, _platt) : rawMlProbUp;
  const evalRes = evaluateMlCalibration(_history, _platt);
  const mode = BOT_CONFIG.mlOnlineCalibration?.mode ?? 'shadow';
  const applied = mode === 'active' && evalRes.allowActive;
  return {
    rawProbUp: rawMlProbUp,
    calibratedProbUp: +calibratedProbUp.toFixed(4),
    appliedProbUp: applied ? +calibratedProbUp.toFixed(4) : rawMlProbUp,
    applied,
  };
}

export function getMlOnlineCalibrationStatus(): MlCalibrationStatus {
  const evalRes = evaluateMlCalibration(_history, _platt);
  return {
    mode: BOT_CONFIG.mlOnlineCalibration?.mode ?? 'shadow',
    historySize: _history.length,
    platt: _platt,
    ...evalRes,
  };
}

export function resetMlOnlineCalibrationForTests(): void {
  _pendingBySlug.clear();
  _seenSlugs.clear();
  _history.length = 0;
  _platt = null;
  _outcomesSinceFit = 0;
}
