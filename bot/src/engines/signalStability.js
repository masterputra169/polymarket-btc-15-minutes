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
// M10: Derive from poll interval instead of hardcoding (assumes 3s poll).
// At 3s poll: 9s confirmation. At 5s poll: 10s confirmation. Scales correctly.
import { CONFIG } from '../../../src/config.js';
const POLL_INTERVAL_S = (CONFIG.pollIntervalMs ?? 3000) / 1000;
export const SIGNAL_CONFIRM_POLLS = Math.max(2, Math.round(9 / POLL_INTERVAL_S));  // ~9s of confirmation
const FLIP_WINDOW_MS = 15_000;          // Track flips in last 15 seconds
const MAX_FLIPS_TO_ENTER = 3;           // v5: 2→3 — with lower edge thresholds, signal oscillates less but still needs some tolerance; 2 was too strict with LATE phase natural flickering

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
