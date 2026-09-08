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
import { notify } from './notifier.ts';

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
let exiting = false;

/** How long the exit waits for the Telegram alert before giving up on it. */
const NOTIFY_TIMEOUT_MS = 5000;

export interface StaleDeps {
  exitEnabled: boolean;
  staleMin: number;
  notify: (level: 'critical' | 'warn' | 'info', message: string, opts?: { key?: string }) => Promise<unknown>;
  flush: () => void;
  exit: (code: number) => void;
  notifyTimeoutMs?: number;
}

const defaultStaleDeps = (): StaleDeps => ({
  exitEnabled: EXIT_ON_STALE,
  staleMin: STALE_MIN,
  notify,
  flush: flushPtbHealth,
  exit: (code) => process.exit(code),
  notifyTimeoutMs: NOTIFY_TIMEOUT_MS,
});

/**
 * The stale verdict's consequence: tell the operator (Telegram, bounded wait),
 * persist the partial PTB-health window, exit 1 for the supervisor. Without
 * the alert a crash loop that exhausts the supervisor's retries goes unnoticed
 * (2026-09-08: Railway stopped the service at 03:09Z, nothing in Telegram).
 */
export async function handleStale(v: ProcessLivenessVerdict, deps: StaleDeps = defaultStaleDeps()): Promise<void> {
  const age = v.ageMs == null ? 'no poll completed since start' : `${(v.ageMs / 60_000).toFixed(1)} min since last completed poll`;
  if (!deps.exitEnabled) {
    log.warn(`Bot is alive but blind (${age}); LIVENESS_EXIT_ENABLED=false so not exiting`);
    return;
  }
  log.error(`Bot is alive but blind (${age}, threshold ${deps.staleMin} min) — exiting 1 so the supervisor restarts it`);

  const message =
    `LIVENESS EXIT: bot is alive but blind (${age}, threshold ${deps.staleMin} min) — exiting so the supervisor restarts it. ` +
    `If this repeats, the supervisor may stop the service after its retry limit: check railway logs / pm2 logs.`;
  const timeoutMs = deps.notifyTimeoutMs ?? NOTIFY_TIMEOUT_MS;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<void>(resolve => { timeoutHandle = setTimeout(resolve, timeoutMs); });
  try {
    await Promise.race([deps.notify('critical', message, { key: 'liveness:exit' }), timeout]);
  } catch (err) {
    log.warn(`Liveness exit alert failed: ${err.message}`);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }

  try { deps.flush(); } catch { /* best effort */ }
  deps.exit(1);
}

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
    if (EXIT_ON_STALE) {
      if (exiting) return; // alert + exit already in flight
      exiting = true;
    }
    void handleStale(v);
  }, CHECK_MS);
  timer.unref?.();
  log.info(`Liveness watch: exit after ${STALE_MIN} min without a completed poll (grace ${GRACE_MIN} min, check every ${CHECK_MS / 1000}s)`);
}

export function stopLivenessWatch(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
