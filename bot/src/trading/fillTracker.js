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
// M3: Support multiple concurrent pending orders (e.g. arb legs)
let pendingOrders = new Map();  // orderId → { orderId, tokenId, price, size, side, placedAt }
let fillHistory = [];            // last N fills
let fillRate = 1.0;              // rolling fill rate (initially optimistic)

/**
 * Record a newly placed order for tracking.
 * M3: Supports concurrent orders — each tracked independently by orderId.
 */
export function trackOrderPlacement(orderId, { tokenId, price, size, side }) {
  pendingOrders.set(orderId, { orderId, tokenId, price, size, side, placedAt: Date.now() });
  log.debug(`Tracking order ${orderId}: ${side} ${size}@${price} (${pendingOrders.size} pending)`);
}

/**
 * Check if pending orders have been filled or should be cancelled.
 * M3: Checks ALL pending orders, returns array of results.
 * Called every poll (~2s) — NON-BLOCKING async check.
 *
 * @returns {null | Array<{ orderId, filled: boolean, cancelled?: boolean, timeToFill?: number, adverseSelection?: boolean }>}
 */
export async function checkPendingFill() {
  if (pendingOrders.size === 0) return null;

  const results = [];

  try {
    const openOrders = await Promise.race([
      getOpenOrders(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('getOpenOrders timeout')), 5000))
    ]);
    const openIds = new Set(openOrders.map(o => o.id));

    for (const [orderId, pending] of pendingOrders) {
      const elapsed = Date.now() - pending.placedAt;

      if (!openIds.has(orderId) && elapsed < 3000) {
        // M9: Too early to conclude — FOK orders disappear immediately on reject/expire too.
        // Wait 3s (was 2s) before inferring fill. With FOK order type, rejected orders
        // vanish from open orders just like filled ones. 3s gives API time to propagate.
        continue;
      }

      if (!openIds.has(orderId)) {
        // M9: Order not in open orders after 3s. With FOK, this could be:
        // 1. Filled (most likely if order was valid + liquidity existed)
        // 2. Rejected/expired (FOK that couldn't fill immediately)
        // We assume filled but log a warning. positionTracker's confirmFill + actual
        // USDC balance checks provide secondary verification.
        const adverseSelection = elapsed < ADVERSE_SELECTION_MS;
        const fill = { orderId, filled: true, timeToFill: elapsed, adverseSelection };
        recordFill(fill);
        log.info(
          `Order ${orderId} not in open orders after ${(elapsed / 1000).toFixed(1)}s — assumed filled (FOK)` +
          (adverseSelection ? ' [ADVERSE SELECTION WARNING]' : '')
        );
        pendingOrders.delete(orderId);
        results.push(fill);
      } else if (elapsed > FILL_TIMEOUT_MS) {
        // Stale order — cancel it
        try {
          await cancelOrder(orderId);
          log.warn(`Stale order cancelled after ${(elapsed / 1000).toFixed(0)}s: ${orderId}`);
        } catch (err) {
          log.warn(`Failed to cancel stale order: ${err.message}`);
        }
        recordFill({ orderId, filled: false, timeToFill: elapsed, adverseSelection: false });
        pendingOrders.delete(orderId);
        results.push({ orderId, filled: false, cancelled: true });
      }
      // else: still pending, check next poll
    }
  } catch (err) {
    // API error — don't kill orders, just skip this check
    log.debug(`Fill check error: ${err.message}`);
  }

  // Evict stale pending orders (>10min) to prevent unbounded Map growth on API failures
  const STALE_ORDER_MS = 10 * 60 * 1000;
  const evictNow = Date.now();
  for (const [id, order] of pendingOrders) {
    if (evictNow - order.placedAt > STALE_ORDER_MS) {
      log.warn(`Evicting stale pending order ${id} (${Math.round((evictNow - order.placedAt) / 1000)}s old)`);
      pendingOrders.delete(id);
    }
  }

  return results.length > 0 ? results : null;
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
 * Whether there are any pending orders being tracked.
 */
export function hasPendingOrder() {
  return pendingOrders.size > 0;
}

/**
 * Get summary for dashboard broadcast.
 */
export function getFillTrackerStatus() {
  // Pick the oldest pending order for display (backward compat)
  let oldestPending = null;
  for (const p of pendingOrders.values()) {
    if (!oldestPending || p.placedAt < oldestPending.placedAt) oldestPending = p;
  }
  return {
    pending: pendingOrders.size > 0,
    pendingCount: pendingOrders.size,
    pendingOrderId: oldestPending?.orderId ?? null,
    pendingElapsedMs: oldestPending ? Date.now() - oldestPending.placedAt : 0,
    fillRate: Math.round(fillRate * 100) / 100,
    adverseSelectionRate: Math.round(getAdverseSelectionRate() * 100) / 100,
    totalTracked: fillHistory.length,
    lastFillTime: fillHistory.length > 0 ? fillHistory[fillHistory.length - 1].ts : null,
  };
}
