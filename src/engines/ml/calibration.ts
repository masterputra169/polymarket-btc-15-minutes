/**
 * Platt sigmoid calibration for XGBoost predictions.
 *
 * v9: Two calibration paths:
 *   - calibrateLogit(logit): sigmoid(A*logit + B) — correct Platt scaling on raw logits
 *   - calibrate(rawProb): sigmoid(A*prob + B) — legacy double-sigmoid for old models
 *
 * The model's platt_on_logits flag determines which path is used.
 */

import * as S from './state.ts';

export type PhaseBucket = 'EARLY' | 'MID' | 'LATE' | 'VERY_LATE';
export type PlattPhaseEntry = { a: number; b: number; theta?: number };
export type PlattByPhaseMap = Partial<Record<PhaseBucket, PlattPhaseEntry>>;

const PHASE_KEYS: readonly PhaseBucket[] = ['EARLY', 'MID', 'LATE', 'VERY_LATE'];

// Module-level per-phase overrides (kept out of state.ts to avoid breaking vi.mock('../state.ts') test stubs)
let activePlattByPhase: PlattByPhaseMap | null = null;

/** Bucket remaining minutes identically to edge.ts and mltrain/calibration.py. */
export function getCalibrationPhase(minutesLeftNorm: number): PhaseBucket {
  const minutesLeft = minutesLeftNorm * 15;
  if (minutesLeft > 10) return 'EARLY';
  if (minutesLeft > 5) return 'MID';
  if (minutesLeft > 2) return 'LATE';
  return 'VERY_LATE';
}

/** Validate and normalise an optional `platt_by_phase` JSON map; returns null when absent/invalid. */
export function parsePlattByPhase(raw: unknown): PlattByPhaseMap | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const out: PlattByPhaseMap = {};
  let count = 0;
  for (const key of PHASE_KEYS) {
    const entry = obj[key] as Record<string, unknown> | undefined;
    if (!entry || typeof entry !== 'object') continue;
    const a = entry.a;
    const b = entry.b;
    if (typeof a === 'number' && Number.isFinite(a) && a > 0 && typeof b === 'number' && Number.isFinite(b)) {
      out[key] = {
        a,
        b,
        ...(typeof entry.theta === 'number' && Number.isFinite(entry.theta) ? { theta: entry.theta } : {}),
      };
      count++;
    }
  }
  return count > 0 ? out : null;
}

/** Set or clear active XGBoost per-phase Platt overrides. */
export function setPlattByPhase(map: PlattByPhaseMap | null): void {
  activePlattByPhase = map;
}

/** Return active XGBoost per-phase Platt overrides (primarily for inspection/tests). */
export function getPlattByPhase(): PlattByPhaseMap | null {
  return activePlattByPhase;
}

/**
 * Apply Platt scaling on a raw logit, selecting per-phase `(a, b)` when available
 * and `minutesLeftNorm` is finite, otherwise falling back cleanly to `(globalA, globalB)`.
 */
export function calibrateLogitWith(
  logit: number,
  globalA: number,
  globalB: number,
  byPhase: PlattByPhaseMap | null,
  minutesLeftNorm?: number,
): number {
  let a = globalA;
  let b = globalB;
  if (byPhase && minutesLeftNorm !== undefined && Number.isFinite(minutesLeftNorm)) {
    const entry = byPhase[getCalibrationPhase(minutesLeftNorm)];
    if (entry) {
      a = entry.a;
      b = entry.b;
    }
  }
  if (a !== 1.0 || b !== 0.0) {
    return 1 / (1 + Math.exp(-(a * logit + b)));
  }
  return 1 / (1 + Math.exp(-logit));
}

/**
 * Platt calibration on raw logit (v9+).
 * Applies sigmoid(A*logit + B) using phase overrides when loaded and `minutesLeftNorm` is given.
 */
export function calibrateLogit(logit: number, minutesLeftNorm?: number): number {
  return calibrateLogitWith(logit, S.plattA, S.plattB, activePlattByPhase, minutesLeftNorm);
}

/**
 * Legacy Platt calibration on post-sigmoid probability (v2 models).
 * Applies sigmoid(A*prob + B) — double-sigmoid, consistent with old training.
 */
export function calibrate(rawProb: number): number {
  if (S.plattA !== 1.0 || S.plattB !== 0.0) {
    return 1 / (1 + Math.exp(-(S.plattA * rawProb + S.plattB)));
  }
  return rawProb;
}
