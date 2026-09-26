/**
 * How likely is UP, from the TWAP arithmetic alone? Record-only.
 *
 * The window settles UP when the 60 s TWAP stamped at its end is >= the price to
 * beat. With the expected final TWAP S (engines/settlePrice.ts), Chainlink spot
 * moving as a random walk with per-second volatility σ, and L seconds left, the
 * final TWAP is normal around S with variance σ²·T_eff, where
 *   L > 60 s:  T_eff = (L − 60) + 20.5      (walk to the window, then its 60-sample mean)
 *   L ≤ 60 s:  T_eff = L(L+1)(2L+1) / 21600 (only the unseen part of the average moves)
 * so P(UP) = Φ((S − PTB) / (σ·√T_eff)).
 *
 * The 2026-09-26 study (twapModelStudy.py, 2,788 markets) found this adds nothing
 * the market price lacks in the bot's trading window, and ~8% Brier skill over the
 * market in the last 15–60 s — where a trading rule could not yet be told apart
 * from buying the favourite. So the bot only RECORDS it on the tape's decision
 * lines, to be re-tested against real asks once weeks of data exist.
 */

import type { Tick } from '../streams/tickStore.ts';

/** Effective variance horizon, in seconds of spot variance, for L seconds left. */
export function twapVarianceSeconds(secondsLeft: number): number {
  const L = Math.max(0, secondsLeft);
  if (L > 60) return L - 60 + 20.5;
  return (L * (L + 1) * (2 * L + 1)) / 21_600;
}

/** Per-second volatility of spot: RMS of consecutive changes, each scaled by √gap. */
export function spotVolPerSecond(ticks: readonly Tick[]): number | null {
  const t = [...ticks].sort((a, b) => a.ts - b.ts);
  let sum = 0;
  let n = 0;
  for (let i = 1; i < t.length; i++) {
    const gap = (t[i].ts - t[i - 1].ts) / 1000;
    if (!(gap > 0) || gap > 10) continue;
    const d = t[i].value - t[i - 1].value;
    sum += (d * d) / gap;
    n++;
  }
  return n >= 20 ? Math.sqrt(sum / n) : null;
}

/** Standard normal CDF (Abramowitz–Stegun 7.1.26 via erf; |error| < 1.5e-7). */
export function normCdf(x: number): number {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return x >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

/** The settlement estimate over the last minutes, to read its value 30 s ago. */
export class SettleHistory {
  private readonly pts: { t: number; v: number }[] = [];
  private readonly keepMs: number;
  constructor(keepMs: number) { this.keepMs = keepMs; }
  add(t: number, v: number): void {
    if (!Number.isFinite(t) || !Number.isFinite(v)) return;
    this.pts.push({ t, v });
    while (this.pts.length && this.pts[0].t < t - this.keepMs) this.pts.shift();
  }
  /** The last value at or before `t`, or null. */
  at(t: number): number | null {
    let out: number | null = null;
    for (const p of this.pts) { if (p.t <= t) out = p.v; else break; }
    return out;
  }
}

export interface TwapPhysics {
  /** P(UP) from the TWAP arithmetic. */
  p: number;
  /** (S − PTB) / (σ·√T_eff). */
  z: number;
  /** Change of the settlement estimate over the last 30 s, $ (null without history). */
  drift30: number | null;
}

export function twapPhysics(input: {
  settle: number | null;
  settle30sAgo: number | null;
  ptb: number | null;
  spotTicks: readonly Tick[];
  nowMs: number;
  endMs: number | null;
}): TwapPhysics | null {
  const { settle, ptb, endMs } = input;
  if (settle == null || ptb == null || endMs == null || !(ptb > 0)) return null;
  const left = (endMs - input.nowMs) / 1000;
  if (!(left > 0) || left > 900) return null;
  const sigma = spotVolPerSecond(input.spotTicks);
  if (sigma == null || !(sigma > 0)) return null;
  const sd = sigma * Math.sqrt(twapVarianceSeconds(left));
  if (!(sd > 0)) return null;
  const z = (settle - ptb) / sd;
  return { p: normCdf(z), z, drift30: input.settle30sAgo != null ? settle - input.settle30sAgo : null };
}
