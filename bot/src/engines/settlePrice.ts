/**
 * The price a BTC 15m window will be judged on, as well as it can be known now.
 *
 * A window settles UP when Chainlink's 60-second TWAP stamped at its last second
 * is >= its price to beat. Two corrections follow for anything that measures
 * "how far is BTC from the price to beat":
 *
 *  1. Use Chainlink, not Binance. Over 116k tape snapshots (2026-09-24/25)
 *     Binance BTC/USDT sat $23.76 ABOVE Chainlink's BTC/USD (median; p5 $9.91,
 *     p95 $35.61), so Binance-minus-PTB read every window ~$24 more bullish than
 *     it was.
 *  2. In the last 60 s the answer is partly written already. The final TWAP
 *     averages the last minute, so with k seconds of it observed the expected
 *     final value is (sum of those k one-second prices + current price × the
 *     60 − k seconds still to come) / 60. Earlier than that, the best estimate of
 *     a future average of a martingale is simply the current price.
 *
 * When Chainlink spot is unavailable the Binance price is shifted by a slowly
 * tracked basis (Binance − Chainlink), never used raw.
 */

import type { Tick } from '../streams/tickStore.ts';
import { isBadTick } from '../../../src/indicators/quantMath.ts';

export const TWAP_WINDOW_MS = 60_000;

export interface SettleEstimateInput {
  nowMs: number;
  endMs: number | null;
  /** Latest Chainlink spot, or null. */
  spot: number | null;
  /** Chainlink spot ticks (timestamped by the source) covering the last minute. */
  spotTicks: readonly Tick[];
  /** Binance price, used only when spot is null. */
  binance: number | null;
  /** Tracked Binance − Chainlink basis, or null if never observed. */
  basis: number | null;
  /** Shift final TWAP window earlier in ms (e.g. 2000 for [b-62s, b-2s] per Polymarket strike audit). */
  windowOffsetMs?: number;
}

export interface SettleEstimate {
  price: number | null;
  source: 'chainlink' | 'chainlink_final_minute' | 'binance_minus_basis' | 'binance_raw' | 'none';
}

/** Expected final TWAP, or the current price when more than a minute remains. */
export function estimateSettlePrice(i: SettleEstimateInput): SettleEstimate {
  if (i.spot == null || !(i.spot > 0)) {
    if (i.binance != null && i.binance > 0) {
      return i.basis != null
        ? { price: i.binance - i.basis, source: 'binance_minus_basis' }
        : { price: i.binance, source: 'binance_raw' };
    }
    return { price: null, source: 'none' };
  }
  const offsetMs = Number.isFinite(i.windowOffsetMs) && (i.windowOffsetMs as number) > 0 ? (i.windowOffsetMs as number) : 0;
  const twapEndMs = i.endMs != null ? i.endMs - offsetMs : null;
  if (twapEndMs == null || i.nowMs <= twapEndMs - TWAP_WINDOW_MS || i.nowMs >= (i.endMs as number) + 5_000) {
    return { price: i.spot, source: 'chainlink' };
  }
  const windowStart = twapEndMs - TWAP_WINDOW_MS;
  const upto = Math.min(i.nowMs, twapEndMs);
  // One sample per whole second of the TWAP window; a second with no tick holds
  // the previous one (the last tick before the window seeds it).
  const rawTicks = [...i.spotTicks].filter(t => t.ts <= upto && Number.isFinite(t.value) && t.value > 0).sort((a, b) => a.ts - b.ts);
  const tickVals = rawTicks.map(t => t.value);
  const ticks = rawTicks.filter(t => !isBadTick(t.value, tickVals, 6.0));
  let held: number | null = null;
  let j = 0;
  let sum = 0;
  let seen = 0;
  for (let s = windowStart + 1_000; s <= twapEndMs; s += 1_000) {
    if (s > upto) break;
    while (j < ticks.length && ticks[j].ts <= s) held = ticks[j++].value;
    sum += held ?? i.spot;
    seen++;
  }
  const remaining = TWAP_WINDOW_MS / 1_000 - seen;
  return { price: (sum + i.spot * remaining) / (TWAP_WINDOW_MS / 1_000), source: 'chainlink_final_minute' };
}

/**
 * Compensate ~1-1.5s Chainlink relay lag using synchronous multi-venue delta
 * (equal-weighted Coinbase USD + Binance USDT when both exist, else whichever is
 * fresh; krabduke nowcast). Bounded to ±maxDeltaPct so exchange glitches cannot
 * distort fair value.
 */
export class ChainlinkNowcastTracker {
  private lastClSpot: number | null = null;
  private lastClUpdateMs = 0;
  private binanceAtCl: number | null = null;
  private coinbaseAtCl: number | null = null;
  private readonly maxLagMs: number;
  private readonly maxDeltaPct: number;

  constructor(maxLagMs = 15_000, maxDeltaPct = 0.005) {
    this.maxLagMs = maxLagMs;
    this.maxDeltaPct = maxDeltaPct;
  }

  update(
    clSpot: number | null,
    clUpdateMs: number,
    binanceNow: number | null,
    coinbaseNow: number | null = null,
  ): number | null {
    if (clSpot == null || !(clSpot > 0)) return null;
    if (clSpot !== this.lastClSpot || (clUpdateMs > 0 && clUpdateMs !== this.lastClUpdateMs)) {
      this.lastClSpot = clSpot;
      this.lastClUpdateMs = clUpdateMs > 0 ? clUpdateMs : Date.now();
      this.binanceAtCl = (binanceNow != null && binanceNow > 0) ? binanceNow : null;
      this.coinbaseAtCl = (coinbaseNow != null && coinbaseNow > 0) ? coinbaseNow : null;
    }
    if (this.lastClUpdateMs > 0 && Date.now() - this.lastClUpdateMs > this.maxLagMs) {
      return clSpot;
    }
    const binDelta = (binanceNow != null && binanceNow > 0 && this.binanceAtCl != null)
      ? binanceNow - this.binanceAtCl : null;
    const cbDelta = (coinbaseNow != null && coinbaseNow > 0 && this.coinbaseAtCl != null)
      ? coinbaseNow - this.coinbaseAtCl : null;

    const rawDelta = (binDelta != null && cbDelta != null)
      ? 0.5 * cbDelta + 0.5 * binDelta
      : (cbDelta ?? binDelta);
    if (rawDelta == null) return clSpot;

    const maxDelta = clSpot * this.maxDeltaPct;
    const delta = Math.max(-maxDelta, Math.min(maxDelta, rawDelta));
    return clSpot + delta;
  }
}

export interface CrossFeedMetricsInput {
  lastPrice: number | null | undefined;
  binanceWindowOpen: number | null | undefined;
  settlePrice: number | null | undefined;
  exactPtb: number | null | undefined;
  clSpot?: number | null | undefined;
}

export interface CrossFeedMetrics {
  binanceWindowOpen: number | null;
  binanceDistUsd: number | null;
  binanceDistPct: number | null;
  oracleDistUsd: number | null;
  oracleDistPct: number | null;
  liveBasisUsd: number | null;
  /** binanceDistUsd − oracleDistUsd = basis drift + pre-open TWAP skew. */
  crossFeedSkewUsd: number | null;
  crossFeedSkewPct: number | null;
}

const finitePos = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0;

/**
 * Measure alignment between ML's Binance-relative distance (Binance_now − Binance_open)
 * and Polymarket's Chainlink settlement distance (settlePrice − exact TWAP PTB).
 * Constant exchange basis cancels across both ends of the Binance distance; non-zero skew
 * reveals mid-window basis drift or pre-open TWAP divergence.
 */
export function computeCrossFeedMetrics(input: CrossFeedMetricsInput): CrossFeedMetrics {
  const { lastPrice, binanceWindowOpen, settlePrice, exactPtb, clSpot = null } = input;
  const hasBin = finitePos(lastPrice) && finitePos(binanceWindowOpen);
  const hasOra = finitePos(settlePrice) && finitePos(exactPtb);

  const binanceDistUsd = hasBin ? lastPrice - binanceWindowOpen : null;
  const binanceDistPct = hasBin ? (binanceDistUsd! / binanceWindowOpen) * 100 : null;

  const oracleDistUsd = hasOra ? settlePrice - exactPtb : null;
  const oracleDistPct = hasOra ? (oracleDistUsd! / exactPtb) * 100 : null;

  const liveBasisUsd = finitePos(lastPrice) && finitePos(clSpot) ? lastPrice - clSpot : null;

  const crossFeedSkewUsd =
    binanceDistUsd != null && oracleDistUsd != null ? binanceDistUsd - oracleDistUsd : null;
  const crossFeedSkewPct =
    binanceDistPct != null && oracleDistPct != null ? binanceDistPct - oracleDistPct : null;

  return {
    binanceWindowOpen: finitePos(binanceWindowOpen) ? binanceWindowOpen : null,
    binanceDistUsd,
    binanceDistPct,
    oracleDistUsd,
    oracleDistPct,
    liveBasisUsd,
    crossFeedSkewUsd,
    crossFeedSkewPct,
  };
}

/**
 * Fractional oracle return over the last ~windowMs (default 3s) from timestamped
 * Chainlink spot ticks. Mirrors binanceWs.getRecentPriceWindow() (returned as
 * a fractional ratio, e.g. 0.0003 for +0.03%, matching featureExtract units).
 */
export function computeOracleDeltaWindowRatio(
  spotTicks: readonly Tick[],
  nowMs: number,
  windowMs = 3_000,
): { deltaRatio: number; tickCount: number } {
  const cutoff = nowMs - windowMs;
  let oldest: Tick | null = null;
  let latest: Tick | null = null;
  let tickCount = 0;
  for (const t of spotTicks) {
    if (!Number.isFinite(t.ts) || !Number.isFinite(t.value) || t.value <= 0) continue;
    if (t.ts < cutoff || t.ts > nowMs + 500) continue;
    tickCount++;
    if (!oldest || t.ts < oldest.ts) oldest = t;
    if (!latest || t.ts > latest.ts) latest = t;
  }
  if (!oldest || !latest || tickCount < 2 || latest.ts <= oldest.ts) {
    return { deltaRatio: 0, tickCount };
  }
  return { deltaRatio: (latest.value - oldest.value) / oldest.value, tickCount };
}

/**
 * Binance − Chainlink, smoothed. Updated only when both prices are fresh; an
 * optional rolling median window rejects single-poll stale spikes while letting
 * sustained basis regime shifts (e.g. USDT discount widening) track rapidly.
 */
export class BasisTracker {
  private value: number | null = null;
  private readonly alpha: number;
  private readonly maxStep: number;
  private readonly medianWindow: number;
  private readonly recent: number[] = [];

  constructor(alpha = 0.02, maxStep = 5, medianWindow = 0) {
    this.alpha = alpha;
    this.maxStep = maxStep;
    this.medianWindow = Math.max(0, Math.floor(medianWindow));
  }

  update(binance: number | null, chainlink: number | null): void {
    if (binance == null || chainlink == null || !(binance > 0) || !(chainlink > 0)) return;
    const d = binance - chainlink;
    if (!Number.isFinite(d) || Math.abs(d) > 500) return;

    let target = d;
    if (this.medianWindow > 1) {
      this.recent.push(d);
      if (this.recent.length > this.medianWindow) this.recent.shift();
      const sorted = [...this.recent].sort((a, b) => a - b);
      target = sorted[Math.floor(sorted.length / 2)];
    }

    if (this.value == null) { this.value = target; return; }
    const step = Math.max(-this.maxStep, Math.min(this.maxStep, this.alpha * (target - this.value)));
    this.value += step;
  }

  get(): number | null {
    return this.value;
  }
}

export interface KinematicKalmanSnapshot {
  /** Filtered BTC price level ($) */
  price: number;
  /** Instantaneous drift velocity ($/sec) */
  velocityUsdPerSec: number;
  /** Latest measurement innovation (observed - predicted, $) */
  innovationUsd: number;
  /** Normalized innovation z-score (innovation / sqrt(S)) — spikes on genuine momentum breaks */
  innovationZ: number;
  /** Current position Kalman gain K_0 in (0, 1) */
  kalmanGain: number;
  /** Adaptive basis estimate (Binance - Chainlink, $), or null if no basis observed */
  adaptiveBasisUsd: number | null;
  /** Current scalar Kalman gain for adaptive basis tracker */
  basisKalmanGain: number | null;
  samples: number;
}

/**
 * 2-State Kinematic Kalman Filter `[price, velocity]` + 1D Adaptive Basis Kalman Filter.
 *
 * Strictly causal & O(1) per poll (~0.01 ms). Built as shadow telemetry first so
 * live entry/settle decisions remain untouched while recording zero-lag velocity
 * (`$/sec`), innovation z-score, and adaptive `Binance - Chainlink` basis tracking.
 */
export class KinematicKalmanTracker {
  private x0: number | null = null; // price ($)
  private x1 = 0;                   // velocity ($/sec)
  private p00 = 25;
  private p01 = 0;
  private p11 = 4;
  private lastTsMs = 0;
  private lastInnovation = 0;
  private lastInnovationZ = 0;
  private lastGain = 0;
  private samples = 0;

  // 1D Adaptive Basis Kalman state (Binance - Chainlink)
  private basisX: number | null = null;
  private basisP = 100;
  private basisK: number | null = null;

  private readonly qAccelVar: number;
  private readonly rMeasVar: number;
  private readonly basisQ: number;
  private readonly basisR: number;

  constructor(opts?: { qAccelVar?: number; rMeasVar?: number; basisQ?: number; basisR?: number }) {
    this.qAccelVar = opts?.qAccelVar ?? 2.5;   // ($/s^2)^2 process acceleration variance
    this.rMeasVar = opts?.rMeasVar ?? 16.0;    // ($)^2 observation noise variance (~$4 std)
    this.basisQ = opts?.basisQ ?? 0.35;        // ($)^2 per update basis drift variance
    this.basisR = opts?.basisR ?? 18.0;        // ($)^2 single-tick basis noise variance
  }

  update(
    price: number | null,
    nowMs = Date.now(),
    binancePrice: number | null = null,
    chainlinkPrice: number | null = null,
  ): KinematicKalmanSnapshot | null {
    // 1D Adaptive Basis Kalman update (independent of price)
    if (
      binancePrice != null && chainlinkPrice != null
      && Number.isFinite(binancePrice) && Number.isFinite(chainlinkPrice)
      && binancePrice > 0 && chainlinkPrice > 0
    ) {
      const obsBasis = binancePrice - chainlinkPrice;
      if (Math.abs(obsBasis) <= 500) {
        if (this.basisX == null) {
          this.basisX = obsBasis;
          this.basisP = this.basisR;
          this.basisK = 1;
        } else {
          // Adaptive Q inflation when sustained basis innovation exceeds 2σ (capped so single-tick spikes stay damped)
          const predP = this.basisP + this.basisQ;
          const innov = obsBasis - this.basisX;
          const S = predP + this.basisR;
          const nis = (innov * innov) / Math.max(1e-9, S);
          const adaptiveP = nis > 4 ? predP + Math.min(8, (nis - 4) * 0.15) : predP;
          const K = adaptiveP / (adaptiveP + this.basisR);
          this.basisX = this.basisX + K * innov;
          this.basisP = (1 - K) * adaptiveP;
          this.basisK = K;
        }
      }
    }

    if (price == null || !Number.isFinite(price) || !(price > 0)) {
      return this.getSnapshot();
    }

    if (this.x0 == null) {
      this.x0 = price;
      this.x1 = 0;
      this.p00 = this.rMeasVar;
      this.p01 = 0;
      this.p11 = 4;
      this.lastTsMs = nowMs;
      this.lastInnovation = 0;
      this.lastInnovationZ = 0;
      this.lastGain = 1;
      this.samples = 1;
      return this.getSnapshot();
    }

    const dt = Math.max(0.05, Math.min(30, (nowMs - this.lastTsMs) / 1000));
    this.lastTsMs = nowMs;

    // Predict: x_pred = F * x, F = [[1, dt], [0, 1]] (with slight velocity damping 0.98)
    const damp = Math.exp(-dt / 30);
    const pred0 = this.x0 + this.x1 * dt;
    const pred1 = this.x1 * damp;

    const dt2 = dt * dt;
    const dt3 = dt2 * dt;
    const dt4 = dt2 * dt2;
    const q00 = 0.25 * dt4 * this.qAccelVar;
    const q01 = 0.5 * dt3 * this.qAccelVar;
    const q11 = dt2 * this.qAccelVar;

    const p00 = this.p00 + 2 * dt * this.p01 + dt2 * this.p11 + q00;
    const p01 = (this.p01 + dt * this.p11) * damp + q01;
    const p11 = this.p11 * damp * damp + q11;

    // Update: H = [1, 0]
    const innov = price - pred0;
    const S = p00 + this.rMeasVar;
    const k0 = p00 / S;
    const k1 = p01 / S;

    this.x0 = pred0 + k0 * innov;
    this.x1 = pred1 + k1 * innov;
    this.p00 = Math.max(1e-6, (1 - k0) * p00);
    this.p01 = (1 - k0) * p01;
    this.p11 = Math.max(1e-6, p11 - k1 * p01);

    this.lastInnovation = innov;
    this.lastInnovationZ = innov / Math.sqrt(Math.max(1e-9, S));
    this.lastGain = k0;
    this.samples++;
    return this.getSnapshot();
  }

  getSnapshot(): KinematicKalmanSnapshot | null {
    if (this.x0 == null) return null;
    return {
      price: +this.x0.toFixed(2),
      velocityUsdPerSec: +this.x1.toFixed(3),
      innovationUsd: +this.lastInnovation.toFixed(2),
      innovationZ: +this.lastInnovationZ.toFixed(2),
      kalmanGain: +this.lastGain.toFixed(3),
      adaptiveBasisUsd: this.basisX != null ? +this.basisX.toFixed(2) : null,
      basisKalmanGain: this.basisK != null ? +this.basisK.toFixed(3) : null,
      samples: this.samples,
    };
  }
}
