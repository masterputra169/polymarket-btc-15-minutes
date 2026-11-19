/**
 * Anti-whipsaw signal stability engine.
 *
 * Two mechanisms (EMA smoothing REMOVED — it adds harmful lag):
 *   1. Signal confirmation: ENTER must persist N wall-clock seconds (~9s default)
 *   2. Flip detector: block if market is flipping too rapidly (indecisive)
 *
 * Extracted from loop.js lines 219-231, 973-984, 1267-1274, 1454-1465.
 */

// ── Constants ──
// Confirmation target is 9 SECONDS in wall-clock time (derived from POLL_INTERVAL_MS
// for poll-count UI/logging parity, while enforcement uses actual elapsed ms so slower
// or faster polls never stretch or compress the confirmation window).
import { envInt } from '../utils/env.ts';
const _actualPollMs = envInt(process.env.POLL_INTERVAL_MS, 500, 50, 60_000);
export const SIGNAL_CONFIRM_TARGET_MS = 9_000;
export const SIGNAL_CONFIRM_POLLS = Math.max(2, Math.round(SIGNAL_CONFIRM_TARGET_MS / _actualPollMs));
const FLIP_WINDOW_MS = 15_000;          // Track flips in last 15 seconds

// v6: Scale flip tolerance with the same actual poll rate.
// At ≤100ms allow up to 10 flips in 15s; >1s the original 3.
const MAX_FLIPS_TO_ENTER = _actualPollMs <= 100 ? 10 : _actualPollMs <= 1000 ? 6 : 3;

// Cap per-poll dt increment so a long GC/network pause cannot satisfy confirmation in 2 ticks.
const MAX_CONFIRM_STEP_MS = Math.max(1_500, _actualPollMs * 2);

// ── State ──
let signalConfirmCount = 0;
let signalConfirmMs = 0;
let lastConfirmUpdateMs: number | null = null;
let signalConfirmSide: string | null = null;           // 'UP' | 'DOWN' | null
const signalFlipHistory: Array<{ ts: number; from: string; to: string }> = [];
let lastSignalSide: string | null = null;

function requiredMsForPolls(requiredPolls: number): number {
  if (requiredPolls <= 1) return 0;
  return Math.round((requiredPolls / SIGNAL_CONFIRM_POLLS) * SIGNAL_CONFIRM_TARGET_MS);
}

function effectiveConfirmCount(): number {
  if (signalConfirmCount <= 0) return 0;
  return Math.min(
    SIGNAL_CONFIRM_POLLS,
    Math.max(1, Math.round((signalConfirmMs / SIGNAL_CONFIRM_TARGET_MS) * SIGNAL_CONFIRM_POLLS)),
  );
}

/**
 * Track signal flip events. Call every poll with the current ensemble side.
 * Purges old flips outside the window and caps max size.
 */
export function trackSignal(currentSide: string, now: number): number {
  if (lastSignalSide !== null && currentSide !== lastSignalSide) {
    signalFlipHistory.push({ ts: now, from: lastSignalSide, to: currentSide });
  }
  lastSignalSide = currentSide;
  // Purge old flips outside the window + cap max size to prevent unbounded growth
  while (signalFlipHistory.length > 0 && now - signalFlipHistory[0].ts > FLIP_WINDOW_MS) {
    signalFlipHistory.shift();
  }
  while (signalFlipHistory.length > 50) signalFlipHistory.shift();
  return signalFlipHistory.length;
}

/**
 * Update confirmation progress when action === 'ENTER'.
 */
export function updateConfirmation(side: string, now = Date.now()): void {
  if (signalConfirmSide === side) {
    signalConfirmCount++;
    const rawDt = lastConfirmUpdateMs != null ? Math.max(0, now - lastConfirmUpdateMs) : 0;
    signalConfirmMs += Math.min(rawDt, MAX_CONFIRM_STEP_MS);
    lastConfirmUpdateMs = now;
  } else {
    signalConfirmSide = side;
    signalConfirmCount = 1;
    signalConfirmMs = 0;
    lastConfirmUpdateMs = now;
  }
}

/**
 * Decay confirmation when signal drops to WAIT/HOLD.
 * Tolerant: allows brief flicker gaps; only hard-resets when fully drained.
 */
export function decayConfirmation(now = Date.now()): void {
  if (signalConfirmCount > 0) {
    const rawDt = lastConfirmUpdateMs != null ? Math.max(0, now - lastConfirmUpdateMs) : _actualPollMs;
    const step = Math.max(_actualPollMs, Math.min(rawDt, MAX_CONFIRM_STEP_MS));
    signalConfirmCount--;
    signalConfirmMs = Math.max(0, signalConfirmMs - step);
    lastConfirmUpdateMs = now;
  }
  if (signalConfirmCount <= 0) {
    signalConfirmCount = 0;
    signalConfirmMs = 0;
    lastConfirmUpdateMs = null;
    signalConfirmSide = null;
  }
}

/**
 * Check if signal meets stability requirements for entry (wall-clock duration + min polls + flip cap).
 */
export function isSignalStable(requiredPolls = SIGNAL_CONFIRM_POLLS): boolean {
  const reqMs = requiredMsForPolls(requiredPolls);
  const minPolls = requiredPolls <= 1 ? 1 : 2;
  return (
    signalConfirmCount >= minPolls &&
    signalConfirmMs >= reqMs &&
    signalFlipHistory.length <= MAX_FLIPS_TO_ENTER
  );
}

/**
 * Get reasons why signal is unstable (for logging when blocked).
 */
export function getInstabilityReasons(requiredPolls = SIGNAL_CONFIRM_POLLS): string[] {
  const reasons: string[] = [];
  const reqMs = requiredMsForPolls(requiredPolls);
  const minPolls = requiredPolls <= 1 ? 1 : 2;
  if (signalConfirmCount < minPolls || signalConfirmMs < reqMs) {
    const eff = effectiveConfirmCount();
    reasons.push(`confirm ${eff}/${requiredPolls} (${(signalConfirmMs / 1000).toFixed(1)}s/${(reqMs / 1000).toFixed(1)}s)`);
  }
  if (signalFlipHistory.length > MAX_FLIPS_TO_ENTER) {
    reasons.push(`${signalFlipHistory.length} flips in ${FLIP_WINDOW_MS / 1000}s`);
  }
  return reasons;
}

/**
 * Get status object for dashboard broadcast.
 */
export function getSignalStabilityStatus(requiredPolls = SIGNAL_CONFIRM_POLLS) {
  return {
    confirmCount: effectiveConfirmCount(),
    confirmNeeded: requiredPolls,
    confirmMs: signalConfirmMs,
    confirmTargetMs: requiredMsForPolls(requiredPolls),
    confirmSide: signalConfirmSide,
    recentFlips: signalFlipHistory.length,
    maxFlips: MAX_FLIPS_TO_ENTER,
    stable: isSignalStable(requiredPolls),
  };
}

/**
 * Reset all signal state (on market change).
 */
export function resetSignalState(): void {
  signalConfirmCount = 0;
  signalConfirmMs = 0;
  lastConfirmUpdateMs = null;
  signalConfirmSide = null;
  signalFlipHistory.length = 0;
  lastSignalSide = null;
}

// Expose individual values for status logging
export function getConfirmCount(): number { return effectiveConfirmCount(); }
export function getConfirmMs(): number { return signalConfirmMs; }
export function getRecentFlipCount(): number { return signalFlipHistory.length; }
