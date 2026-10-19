/**
 * Anti-whipsaw signal stability engine.
 *
 * Two mechanisms (EMA smoothing REMOVED — it adds harmful lag):
 *   1. Signal confirmation: ENTER must persist N consecutive polls
 *   2. Flip detector: block if market is flipping too rapidly (indecisive)
 *
 * Extracted from loop.js lines 219-231, 973-984, 1267-1274, 1454-1465.
 */

// ── Constants ──
// Confirmation is ~9 SECONDS, derived from the bot's real poll interval (POLL_INTERVAL_MS,
// default 500 ms — same default/bounds as bot/index.ts). Before 2026-10-19 this used the
// browser CONFIG.pollIntervalMs (3 s), giving 3 polls ≈150 ms at the deployed 50 ms poll.
// Fixing it changes trade selection, so the evaluation window is reset on deploy.
import { envInt } from '../utils/env.ts';
const _actualPollMs = envInt(process.env.POLL_INTERVAL_MS, 500, 50, 60_000);
export const SIGNAL_CONFIRM_POLLS = Math.max(2, Math.round(9_000 / _actualPollMs));
const FLIP_WINDOW_MS = 15_000;          // Track flips in last 15 seconds

// v6: Scale flip tolerance with the same actual poll rate.
// At ≤100ms allow up to 10 flips in 15s; >1s the original 3.
const MAX_FLIPS_TO_ENTER = _actualPollMs <= 100 ? 10 : _actualPollMs <= 1000 ? 6 : 3;

// ── State ──
let signalConfirmCount = 0;
let signalConfirmSide = null;           // 'UP' | 'DOWN' | null
const signalFlipHistory = [];           // Array of { ts, from, to }
let lastSignalSide = null;

/**
 * Track signal flip events. Call every poll with the current ensemble side.
 * Purges old flips outside the window and caps max size.
 * @param {string} currentSide - 'UP' or 'DOWN'
 * @param {number} now - Current timestamp
 * @returns {number} recentFlipCount after update
 */
export function trackSignal(currentSide, now) {
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
 * Update confirmation counter when action === 'ENTER'.
 * @param {string} side - The side being confirmed ('UP' | 'DOWN')
 */
export function updateConfirmation(side) {
  if (signalConfirmSide === side) {
    signalConfirmCount++;
  } else {
    signalConfirmSide = side;
    signalConfirmCount = 1;
  }
}

/**
 * Decay confirmation when signal drops to WAIT/HOLD.
 * Tolerant: allows 1 gap poll (edge can flicker ENTER→WAIT→ENTER on borderline).
 * Only hard-resets if 2+ consecutive non-ENTER polls.
 */
export function decayConfirmation() {
  if (signalConfirmCount > 0) {
    signalConfirmCount--;
  }
  if (signalConfirmCount <= 0) {
    signalConfirmCount = 0;
    signalConfirmSide = null;
  }
}

/**
 * Check if signal meets stability requirements for entry.
 * Fix P2: When ML confidence >= 0.80, reduce required polls to 1 — high-confidence
 * signals don't need multi-poll confirmation, avoiding 10-20s entry lag.
 * @param {number} [requiredPolls] - Override required polls (default: SIGNAL_CONFIRM_POLLS)
 */
export function isSignalStable(requiredPolls = SIGNAL_CONFIRM_POLLS) {
  return signalConfirmCount >= requiredPolls && signalFlipHistory.length <= MAX_FLIPS_TO_ENTER;
}

/**
 * Get reasons why signal is unstable (for logging when blocked).
 * @param {number} [requiredPolls] - Override required polls (default: SIGNAL_CONFIRM_POLLS)
 * @returns {string[]}
 */
export function getInstabilityReasons(requiredPolls = SIGNAL_CONFIRM_POLLS) {
  const reasons = [];
  if (signalConfirmCount < requiredPolls) {
    reasons.push(`confirm ${signalConfirmCount}/${requiredPolls}`);
  }
  if (signalFlipHistory.length > MAX_FLIPS_TO_ENTER) {
    reasons.push(`${signalFlipHistory.length} flips in ${FLIP_WINDOW_MS / 1000}s`);
  }
  return reasons;
}

/**
 * Get status object for dashboard broadcast.
 * @param {number} [requiredPolls] - Override required polls (default: SIGNAL_CONFIRM_POLLS)
 */
export function getSignalStabilityStatus(requiredPolls = SIGNAL_CONFIRM_POLLS) {
  return {
    confirmCount: signalConfirmCount,
    confirmNeeded: requiredPolls,
    confirmSide: signalConfirmSide,
    recentFlips: signalFlipHistory.length,
    maxFlips: MAX_FLIPS_TO_ENTER,
    stable: isSignalStable(requiredPolls),
  };
}

/**
 * Reset all signal state (on market change).
 */
export function resetSignalState() {
  signalConfirmCount = 0;
  signalConfirmSide = null;
  signalFlipHistory.length = 0;
  lastSignalSide = null;
}

// Expose individual values for status logging
export function getConfirmCount() { return signalConfirmCount; }
export function getRecentFlipCount() { return signalFlipHistory.length; }
