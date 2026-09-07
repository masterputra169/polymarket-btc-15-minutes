/**
 * In-process liveness: the bot judges itself and exits when it is alive but
 * blind, so whatever supervises the process (Railway ON_FAILURE, Docker
 * unless-stopped, PM2) brings back a bot that can see the market.
 *
 * Why this exists: on 2026-09-06 the container stayed "Up" for 11.8 hours
 * while every poll failed on fetch timeouts. A host-side watchdog
 * (scripts/stack-watchdog.ps1) now catches that on the Windows box, but a
 * hosted platform has no host to run one. The signal is the same as the
 * host watchdog's: time since the last poll that completed end to end.
 *
 * createProcessLiveness() is pure and unit-tested; the module-level singleton
 * below is what loop.ts beats and index.ts watches.
 */

import { createLogger } from '../logger.ts';
import { envNum } from '../utils/env.ts';
import { flush as flushPtbHealth } from './ptbHealth.ts';

const log = createLogger('Liveness');

export type ProcessLivenessStatus = 'grace' | 'fresh' | 'stale';

export interface ProcessLivenessVerdict {
  status: ProcessLivenessStatus;
  /** now − last completed poll, or null if no poll has completed yet. */
  ageMs: number | null;
}

export interface ProcessLiveness {
  /** Call once per poll that completed end to end. */
  beat(): void;
  verdict(): ProcessLivenessVerdict;
}

export function createProcessLiveness({ staleMs, graceMs, now = Date.now }: {
  staleMs: number;
  graceMs: number;
  now?: () => number;
}): ProcessLiveness {
  const startedAt = now();
  let lastBeat: number | null = null;
  return {
    beat() { lastBeat = now(); },
    verdict() {
      const t = now();
      if (lastBeat == null) {
        return { status: t - startedAt < graceMs ? 'grace' : 'stale', ageMs: null };
      }
      const ageMs = t - lastBeat;
      return { status: ageMs > staleMs ? 'stale' : 'fresh', ageMs };
    },
  };
}

// ── Process-wide instance, configured from env ──
const STALE_MIN = envNum(process.env.LIVENESS_STALE_MIN, 10, 1, 1440);
const GRACE_MIN = envNum(process.env.LIVENESS_GRACE_MIN, 5, 0, 1440);
const CHECK_MS = envNum(process.env.LIVENESS_CHECK_MS, 60_000, 5_000, 3_600_000);
const EXIT_ON_STALE = (process.env.LIVENESS_EXIT_ENABLED ?? 'true').toLowerCase() !== 'false';

const instance = createProcessLiveness({ staleMs: STALE_MIN * 60_000, graceMs: GRACE_MIN * 60_000 });
let timer: ReturnType<typeof setInterval> | null = null;

/** loop.ts: a poll got all the way to the summary line and broadcast. */
export function beatLiveness(): void {
  instance.beat();
}

export function livenessVerdict(): ProcessLivenessVerdict {
  return instance.verdict();
}

/**
 * index.ts: check every CHECK_MS; on stale, log loudly, persist the partial
 * PTB-health window and exit non-zero for the supervisor to restart us.
 * With LIVENESS_EXIT_ENABLED=false it only logs (useful when debugging).
 */
export function startLivenessWatch(): void {
  if (timer) return;
  timer = setInterval(() => {
    const v = instance.verdict();
    if (v.status !== 'stale') return;
    const age = v.ageMs == null ? 'no poll completed since start' : `${(v.ageMs / 60_000).toFixed(1)} min since last completed poll`;
    if (!EXIT_ON_STALE) {
      log.warn(`Bot is alive but blind (${age}); LIVENESS_EXIT_ENABLED=false so not exiting`);
      return;
    }
    log.error(`Bot is alive but blind (${age}, threshold ${STALE_MIN} min) — exiting 1 so the supervisor restarts it`);
    try { flushPtbHealth(); } catch { /* best effort */ }
    process.exit(1);
  }, CHECK_MS);
  timer.unref?.();
  log.info(`Liveness watch: exit after ${STALE_MIN} min without a completed poll (grace ${GRACE_MIN} min, check every ${CHECK_MS / 1000}s)`);
}

export function stopLivenessWatch(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
