/**
 * JEV settle-probability calibration (10-bin Laplace + PAVA + piecewise linear interpolation).
 *
 * Adapted from skharchikov/polymarket-bot (trading-bot/src/calibration.rs):
 *   - 10 empirical probability buckets [0.0..0.1] .. [0.9..1.0]
 *   - Laplace Beta(1,1) smoothing (wins + 1) / (total + 2) followed by Pool Adjacent Violators
 *     (PAVA) to enforce monotonicity across sparse middle buckets (0.4..0.6)
 *   - Piecewise linear interpolation (`lerp`) across bucket centers (0.05 .. 0.95)
 *
 * Strictly chronological 70/30 OOS check on VPS `jev_log.jsonl` (2,429 resolved markets,
 * 2026-10-19..2026-11-17):
 *   - Raw settle_above_ptb OOS Brier  : 0.25438 (log-loss 0.70711)
 *   - Previous 2026-10-26-pava-70     : 0.24884 (log-loss 0.69082, froze 0.08..0.86 -> 0.4462)
 *   - Laplace-10 + PAVA + lerp OOS    : 0.24031 (log-loss 0.67364)
 *   - Polymarket mid OOS benchmark    : 0.23454 (log-loss 0.66121)
 * Because standalone calibrated JEV still trails market mid on historical state_v2,
 * production uses Bayesian market-anchored probabilities + rolling Brier skill gating.
 */
export const JEV_SETTLE_CALIBRATION_VERSION = '2026-11-17-laplace10-lerp';

export type CalibrationBlock = {
  lo: number;
  hi: number;
  center: number;
  mean: number;
};

// Fitted via 10-bin Laplace + PAVA on 2,429 pre-deploy resolved rows of jev_log.jsonl (2026-10-19..2026-11-17).
const BLOCKS: CalibrationBlock[] = [
  { lo: 0.00, hi: 0.10, center: 0.05, mean: 0.3690 },
  { lo: 0.10, hi: 0.20, center: 0.15, mean: 0.3710 },
  { lo: 0.20, hi: 0.30, center: 0.25, mean: 0.3893 },
  { lo: 0.30, hi: 0.40, center: 0.35, mean: 0.4579 },
  { lo: 0.40, hi: 0.50, center: 0.45, mean: 0.4579 },
  { lo: 0.50, hi: 0.60, center: 0.55, mean: 0.4579 },
  { lo: 0.60, hi: 0.70, center: 0.65, mean: 0.4579 },
  { lo: 0.70, hi: 0.80, center: 0.75, mean: 0.5670 },
  { lo: 0.80, hi: 0.90, center: 0.85, mean: 0.5670 },
  { lo: 0.90, hi: 1.00, center: 0.95, mean: 0.6228 },
];

/** Interpolate linearly across calibration bin centers (clamped at outer centers). */
export function calibrateWithBins(raw: number, bins: readonly CalibrationBlock[]): number {
  if (!Number.isFinite(raw)) return Number.NaN;
  if (bins.length === 0) return Math.max(0, Math.min(1, raw));
  const p = Math.max(0, Math.min(1, raw));
  if (p <= bins[0].center) return bins[0].mean;
  const last = bins[bins.length - 1];
  if (p >= last.center) return last.mean;
  for (let i = 0; i < bins.length - 1; i++) {
    const b0 = bins[i];
    const b1 = bins[i + 1];
    if (p >= b0.center && p <= b1.center) {
      const span = b1.center - b0.center;
      const t = span > 0 ? (p - b0.center) / span : 0;
      return b0.mean + t * (b1.mean - b0.mean);
    }
  }
  return last.mean;
}

export function calibrateJevSettleUp(raw: number): number {
  return calibrateWithBins(raw, BLOCKS);
}

export function getJevCalibrationBlocks(): CalibrationBlock[] {
  return BLOCKS.map((b) => ({ ...b }));
}

/** Fit monotone Laplace-smoothed probability bins from `(rawProb, outcomeUp)` pairs. */
export function fitLaplaceCalibrationBins(
  samples: ReadonlyArray<{ rawProb: number; outcomeUp: 0 | 1 }>,
  opts: { numBins?: number; priorStrength?: number; priorMean?: number; enforceMonotone?: boolean } = {},
): CalibrationBlock[] {
  const numBins = Math.max(2, Math.floor(opts.numBins ?? 10));
  const priorStrength = Math.max(0.1, opts.priorStrength ?? 2);
  const priorMean = Math.max(0.01, Math.min(0.99, opts.priorMean ?? 0.5));
  const enforceMonotone = opts.enforceMonotone ?? true;
  const alpha = priorMean * priorStrength;

  const counts = new Float64Array(numBins);
  const wins = new Float64Array(numBins);
  for (const s of samples) {
    if (!Number.isFinite(s.rawProb)) continue;
    const clamped = Math.max(0, Math.min(0.999999, s.rawProb));
    const idx = Math.min(numBins - 1, Math.floor(clamped * numBins));
    counts[idx] += 1;
    wins[idx] += s.outcomeUp === 1 ? 1 : 0;
  }

  const bins: CalibrationBlock[] = [];
  for (let i = 0; i < numBins; i++) {
    const lo = i / numBins;
    const hi = (i + 1) / numBins;
    const mean = (wins[i] + alpha) / (counts[i] + priorStrength);
    bins.push({ lo, hi, center: (lo + hi) / 2, mean });
  }

  if (enforceMonotone) {
    const pava = bins.map((b, i) => ({
      weight: counts[i] + priorStrength,
      weightedSum: (wins[i] + alpha),
      indices: [i],
    }));
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 0; i < pava.length - 1; i++) {
        const m0 = pava[i].weightedSum / pava[i].weight;
        const m1 = pava[i + 1].weightedSum / pava[i + 1].weight;
        if (m0 > m1) {
          pava[i].weight += pava[i + 1].weight;
          pava[i].weightedSum += pava[i + 1].weightedSum;
          pava[i].indices.push(...pava[i + 1].indices);
          pava.splice(i + 1, 1);
          changed = true;
          break;
        }
      }
    }
    for (const grp of pava) {
      const m = grp.weightedSum / grp.weight;
      for (const idx of grp.indices) {
        bins[idx].mean = +m.toFixed(4);
      }
    }
  }
  return bins;
}
