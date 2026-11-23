/**
 * Causal Forward-Only 3-State Gaussian Hidden Markov Model (HMM) for Market Regimes.
 *
 * Hidden states:
 *   0: mean_reverting (quiet range, low volatility, low directional drift)
 *   1: trending       (persistent directional drift, high 3-bar path efficiency)
 *   2: choppy         (high-volatility whipsaw / reversal hazard, low net efficiency)
 *
 * Uses strictly causal forward filtering (no Viterbi / backward smoothing -> zero lookahead).
 * Complexity: O(T * K^2) with K=3, T<=60 (<0.05 ms per poll, zero external dependencies).
 */

export type HmmStateLabel = 'mean_reverting' | 'trending' | 'choppy' | 'moderate';

export interface HmmRegimeOutput {
  pMeanReverting: number;
  pTrending: number;
  pChoppy: number;
  dominantState: HmmStateLabel;
  confidence: number;
  /** Normalized Shannon entropy in [0, 1] (0 = crisp regime, 1 = maximum regime ambiguity). */
  entropy: number;
  /** 1 - max(p_k), measuring regime transition / uncertainty risk. */
  transitionRisk: number;
}

// High diagonal self-transition probabilities prevent single-candle regime flicker
const TRANSITION_MATRIX: readonly [readonly [number, number, number], readonly [number, number, number], readonly [number, number, number]] = [
  [0.84, 0.08, 0.08], // from 0: mean_reverting
  [0.07, 0.85, 0.08], // from 1: trending
  [0.09, 0.07, 0.84], // from 2: choppy
];

const INITIAL_PRIOR: readonly [number, number, number] = [0.34, 0.33, 0.33];

// Diagonal Gaussian emission parameters on [absReturnZ, efficiency3]
const EMISSION_MEANS: readonly [readonly [number, number], readonly [number, number], readonly [number, number]] = [
  [0.55, 0.42], // 0: mean_reverting (small moves, mild efficiency)
  [1.25, 0.82], // 1: trending       (active moves, high directional efficiency)
  [1.35, 0.22], // 2: choppy         (active/volatile moves, low net efficiency = whipsaw)
];

const EMISSION_STDS: readonly [readonly [number, number], readonly [number, number], readonly [number, number]] = [
  [0.45, 0.25],
  [0.65, 0.20],
  [0.70, 0.20],
];

const LN3 = Math.log(3);

function gaussianPdf2D(x0: number, x1: number, mu: readonly [number, number], sd: readonly [number, number]): number {
  const z0 = (x0 - mu[0]) / sd[0];
  const z1 = (x1 - mu[1]) / sd[1];
  const exponent = -0.5 * (z0 * z0 + z1 * z1);
  const norm = 1 / (2 * Math.PI * sd[0] * sd[1]);
  return Math.max(1e-12, norm * Math.exp(exponent));
}

/**
 * Run causal forward HMM filtering over recent close prices (at least 10 needed).
 */
export function computeHmmRegime(closes: readonly number[] | null | undefined): HmmRegimeOutput | null {
  if (!closes || closes.length < 10) return null;

  const maxBars = Math.min(closes.length, 60);
  const start = closes.length - maxBars;
  const returns: number[] = [];
  for (let i = start + 1; i < closes.length; i++) {
    const prev = closes[i - 1];
    const cur = closes[i];
    if (!Number.isFinite(prev) || !Number.isFinite(cur) || prev <= 0 || cur <= 0) continue;
    returns.push(Math.log(cur / prev));
  }
  if (returns.length < 8) return null;

  // Baseline return scale (robust RMS with floor to avoid zero-division on flat tape)
  let sumSq = 0;
  for (const r of returns) sumSq += r * r;
  const rms = Math.max(1e-5, Math.sqrt(sumSq / returns.length));

  let alpha0 = INITIAL_PRIOR[0];
  let alpha1 = INITIAL_PRIOR[1];
  let alpha2 = INITIAL_PRIOR[2];

  for (let t = 2; t < returns.length; t++) {
    const r0 = returns[t];
    const r1 = returns[t - 1];
    const r2 = returns[t - 2];

    const absReturnZ = Math.min(3.5, Math.abs(r0) / rms);
    const net3 = Math.abs(r0 + r1 + r2);
    const path3 = Math.abs(r0) + Math.abs(r1) + Math.abs(r2);
    const efficiency3 = path3 > 1e-9 ? Math.max(0, Math.min(1, net3 / path3)) : 0.4;

    // 1-step state prediction: prior = alpha * A
    const p0 = alpha0 * TRANSITION_MATRIX[0][0] + alpha1 * TRANSITION_MATRIX[1][0] + alpha2 * TRANSITION_MATRIX[2][0];
    const p1 = alpha0 * TRANSITION_MATRIX[0][1] + alpha1 * TRANSITION_MATRIX[1][1] + alpha2 * TRANSITION_MATRIX[2][1];
    const p2 = alpha0 * TRANSITION_MATRIX[0][2] + alpha1 * TRANSITION_MATRIX[1][2] + alpha2 * TRANSITION_MATRIX[2][2];

    // Bayes update with emission density
    const u0 = p0 * gaussianPdf2D(absReturnZ, efficiency3, EMISSION_MEANS[0], EMISSION_STDS[0]);
    const u1 = p1 * gaussianPdf2D(absReturnZ, efficiency3, EMISSION_MEANS[1], EMISSION_STDS[1]);
    const u2 = p2 * gaussianPdf2D(absReturnZ, efficiency3, EMISSION_MEANS[2], EMISSION_STDS[2]);

    const norm = u0 + u1 + u2;
    if (norm > 0 && Number.isFinite(norm)) {
      alpha0 = u0 / norm;
      alpha1 = u1 / norm;
      alpha2 = u2 / norm;
    }
  }

  const maxP = Math.max(alpha0, alpha1, alpha2);
  let rawEntropy = 0;
  for (const p of [alpha0, alpha1, alpha2]) {
    if (p > 1e-12) rawEntropy -= p * Math.log(p);
  }
  const entropy = Math.max(0, Math.min(1, rawEntropy / LN3));

  let dominantState: HmmStateLabel = 'moderate';
  if (maxP >= 0.48) {
    if (alpha1 === maxP) dominantState = 'trending';
    else if (alpha2 === maxP) dominantState = 'choppy';
    else dominantState = 'mean_reverting';
  }

  return {
    pMeanReverting: +alpha0.toFixed(4),
    pTrending: +alpha1.toFixed(4),
    pChoppy: +alpha2.toFixed(4),
    dominantState,
    confidence: +maxP.toFixed(4),
    entropy: +entropy.toFixed(4),
    transitionRisk: +(1 - maxP).toFixed(4),
  };
}
