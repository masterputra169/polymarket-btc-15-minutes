/**
 * Fill tracker & stale order management.
 *
 * From Math Part 2.5: Kelly assumes perfect execution. Real execution has:
 * - Spread cost (already handled in edge.js)
 * - Fill uncertainty (tracked here → feeds into Kelly execution multiplier)
 * - Adverse selection (quick fills often mean you got picked off)
 *
 * Tracks pending orders, detects fills/timeouts, computes rolling fill rate.
 */

import { getOpenOrders, cancelOrder } from './clobClient.js';
import { createLogger } from '../logger.js';
import { EXECUTION } from '../../../src/config.js';

const log = createLogger('FillTracker');

const { FILL_TIMEOUT_MS } = EXECUTION;
const MAX_HISTORY = 50;
const ADVERSE_SELECTION_MS = 5_000; // filled in <5s = likely adverse

// ── Module state ──
let pendingOrder = null;   // { orderId, tokenId, price, size, side, placedAt }
let fillHistory = [];       // last N fills
let fillRate = 1.0;         // rolling fill rate (initially optimistic)

/**
 * Record a newly placed order for tracking.
 */
export function trackOrderPlacement(orderId, { tokenId, price, size, side }) {
  pendingOrder = { orderId, tokenId, price, size, side, placedAt: Date.now() };
  log.debug(`Tracking order ${orderId}: ${side} ${size}@${price}`);
}

/**
 * Check if pending order has been filled or should be cancelled.
 * Called every poll (~2s) — NON-BLOCKING async check.
 *
 * @returns {null | { filled: boolean, cancelled?: boolean, timeToFill?: number, adverseSelection?: boolean }}
 */
export async function checkPendingFill() {
  if (!pendingOrder) return null;

  const elapsed = Date.now() - pendingOrder.placedAt;

  try {
    const openOrders = await getOpenOrders();
    const stillOpen = openOrders.some(o => o.id === pendingOrder.orderId);

    if (!stillOpen) {
      // Order no longer open = filled (or cancelled externally)
      const adverseSelection = elapsed < ADVERSE_SELECTION_MS;
      const fill = { filled: true, timeToFill: elapsed, adverseSelection };
      recordFill(fill);
      log.info(
        `Order filled in ${(elapsed / 1000).toFixed(1)}s` +
        (adverseSelection ? ' [ADVERSE SELECTION WARNING]' : '')
      );
      pendingOrder = null;
      return fill;
    }

    if (elapsed > FILL_TIMEOUT_MS) {
      // Stale order — cancel it
      try {
        await cancelOrder(pendingOrder.orderId);
        log.warn(`Stale order cancelled after ${(elapsed / 1000).toFixed(0)}s: ${pendingOrder.orderId}`);
      } catch (err) {
        log.warn(`Failed to cancel stale order: ${err.message}`);
      }
      recordFill({ filled: false, timeToFill: elapsed, adverseSelection: false });
      pendingOrder = null;
      return { filled: false, cancelled: true };
    }
  } catch (err) {
    // API error — don't kill the order, just skip this check
    log.debug(`Fill check error: ${err.message}`);
  }

  return null; // Still pending, check next poll
}

/**
 * Record a fill result and update rolling stats.
 */
function recordFill(fill) {
  fillHistory.push({ ...fill, ts: Date.now() });
  if (fillHistory.length > MAX_HISTORY) fillHistory = fillHistory.slice(-MAX_HISTORY);

  // Update rolling fill rate
  const recent = fillHistory.slice(-20); // last 20 orders
  const filled = recent.filter(f => f.filled).length;
  fillRate = recent.length > 0 ? filled / recent.length : 1.0;
}

/**
 * Get current fill rate (0-1). Used by Kelly execution multiplier.
 */
export function getFillRate() {
  return fillRate;
}

/**
 * Get adverse selection rate from recent fills.
 */
export function getAdverseSelectionRate() {
  const filled = fillHistory.filter(f => f.filled);
  if (filled.length === 0) return 0;
  return filled.filter(f => f.adverseSelection).length / filled.length;
}

/**
 * Whether there's a pending order being tracked.
 */
export function hasPendingOrder() {
  return pendingOrder !== null;
}

/**
 * Get summary for dashboard broadcast.
 */
export function getFillTrackerStatus() {
  return {
    pending: pendingOrder !== null,
    pendingOrderId: pendingOrder?.orderId ?? null,
    pendingElapsedMs: pendingOrder ? Date.now() - pendingOrder.placedAt : 0,
    fillRate: Math.round(fillRate * 100) / 100,
    adverseSelectionRate: Math.round(getAdverseSelectionRate() * 100) / 100,
    totalTracked: fillHistory.length,
    lastFillTime: fillHistory.length > 0 ? fillHistory[fillHistory.length - 1].ts : null,
  };
}
