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
export const SIGNAL_CONFIRM_POLLS = 2;  // v3: 3→2 polls (2 × 3s = 6s) — faster entry, 9s was too slow for 15-min markets
const FLIP_WINDOW_MS = 15_000;          // Track flips in last 15 seconds
const MAX_FLIPS_TO_ENTER = 4;           // v3: 3→4 — 15-min markets are naturally flippy, 3 was too strict

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
 */
export function isSignalStable() {
  return signalConfirmCount >= SIGNAL_CONFIRM_POLLS && signalFlipHistory.length <= MAX_FLIPS_TO_ENTER;
}

/**
 * Get reasons why signal is unstable (for logging when blocked).
 * @returns {string[]}
 */
export function getInstabilityReasons() {
  const reasons = [];
  if (signalConfirmCount < SIGNAL_CONFIRM_POLLS) {
    reasons.push(`confirm ${signalConfirmCount}/${SIGNAL_CONFIRM_POLLS}`);
  }
  if (signalFlipHistory.length > MAX_FLIPS_TO_ENTER) {
    reasons.push(`${signalFlipHistory.length} flips in ${FLIP_WINDOW_MS / 1000}s`);
  }
  return reasons;
}

/**
 * Get status object for dashboard broadcast.
 */
export function getSignalStabilityStatus() {
  return {
    confirmCount: signalConfirmCount,
    confirmNeeded: SIGNAL_CONFIRM_POLLS,
    confirmSide: signalConfirmSide,
    recentFlips: signalFlipHistory.length,
    maxFlips: MAX_FLIPS_TO_ENTER,
    stable: isSignalStable(),
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
