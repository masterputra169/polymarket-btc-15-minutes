/**
 * Fill tracker & stale order management.
 *
 * From Math Part 2.5: Kelly assumes perfect execution. Real execution has:
 * - Spread cost (already handled in edge.js)
 * - Fill uncertainty (tracked here → feeds into Kelly execution multiplier)
 * - Adverse selection (quick fills often mean you got picked off)
 *
 * Tracks pending orders, detects fills/timeouts, computes rolling fill rate.
 *
 * CRITICAL SAFETY PRINCIPLE: Default to "assumed filled" (conservative).
 * Unwinding a REAL position = permanent loss (shares exist on-chain but untracked).
 * Tracking a phantom position = minor cost (settles at expiry as a loss).
 * Only mark "rejected" with STRONG evidence (multiple failed verifications over 20s+).
 */

import { getOpenOrders, cancelOrder, getTradeHistory } from './clobClient.js';
import { createLogger } from '../logger.js';
import { EXECUTION } from '../../../src/config.js';

const log = createLogger('FillTracker');

const { FILL_TIMEOUT_MS } = EXECUTION;
const MAX_HISTORY = 50;
const ADVERSE_SELECTION_MS = 5_000; // filled in <5s = likely adverse

// Fill verification timing — conservative to prevent false rejections
const FILL_VERIFY_FIRST_CHECK_MS = 5_000;  // Wait 5s before first trade history check
const FILL_VERIFY_DEADLINE_MS = 20_000;     // Give up verifying after 20s
const FILL_VERIFY_MIN_ATTEMPTS = 3;         // Need 3+ failed checks before concluding rejected

// ── Module state ──
// M3: Support multiple concurrent pending orders (e.g. arb legs)
let pendingOrders = new Map();  // orderId → { orderId, tokenId, price, size, side, placedAt, confirmed, verifyAttempts }
let fillHistory = [];            // last N fills
let fillRate = 1.0;              // rolling fill rate (initially optimistic)

/**
 * Record a newly placed order for tracking.
 * M3: Supports concurrent orders — each tracked independently by orderId.
 *
 * @param {string} orderId
 * @param {Object} info - Order details
 * @param {boolean} [info.confirmed] - If true, CLOB response included fill data (makingAmount/takingAmount).
 *   This is direct proof of fill — skip trade history verification entirely.
 */
export function trackOrderPlacement(orderId, { tokenId, price, size, side, confirmed = false }) {
  pendingOrders.set(orderId, {
    orderId, tokenId, price, size, side,
    placedAt: Date.now(),
    confirmed,         // CLOB response had fill data → skip verification
    verifyAttempts: 0, // Number of trade history checks attempted
  });
  log.debug(`Tracking order ${orderId}: ${side} ${size}@${price} confirmed=${confirmed} (${pendingOrders.size} pending)`);
}

/**
 * Check if pending orders have been filled or should be cancelled.
 * M3: Checks ALL pending orders, returns array of results.
 * Called every poll (~500ms) — NON-BLOCKING async check.
 *
 * SAFETY: Uses multi-attempt verification with conservative defaults.
 * Only marks "rejected" after FILL_VERIFY_MIN_ATTEMPTS failed checks
 * over FILL_VERIFY_DEADLINE_MS. Otherwise assumes filled.
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

      if (openIds.has(orderId)) {
        // Order still open — check for stale timeout
        if (elapsed > FILL_TIMEOUT_MS) {
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
        // else: still open, still pending — check next poll
        continue;
      }

      // Order NOT in open orders — could be filled or rejected (FOK)

      // ── Fast path: CLOB response had fill data → confirmed immediately ──
      if (pending.confirmed) {
        const adverseSelection = elapsed < ADVERSE_SELECTION_MS;
        const fill = { orderId, filled: true, rejected: false, verified: true, timeToFill: elapsed, adverseSelection };
        recordFill(fill);
        log.info(`Order ${orderId} fill CONFIRMED via CLOB response data (${(elapsed / 1000).toFixed(1)}s)${adverseSelection ? ' [ADVERSE]' : ''}`);
        pendingOrders.delete(orderId);
        results.push(fill);
        continue;
      }

      // ── Wait before first trade history check ──
      if (elapsed < FILL_VERIFY_FIRST_CHECK_MS) {
        continue;
      }

      // ── Trade history verification (multi-attempt) ──
      const adverseSelection = elapsed < ADVERSE_SELECTION_MS;
      let tradeFound = false;
      let apiError = false;

      try {
        const trades = await Promise.race([
          getTradeHistory({ assetId: pending.tokenId, after: pending.placedAt - 5000 }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('trade history timeout')), 5000))
        ]);
        // Match by tokenId + time window + price proximity
        const matchingTrade = Array.isArray(trades) && trades.find(t => {
          const matchTime = t.match_time ? new Date(t.match_time).getTime() : (t.timestamp ?? 0);
          const assetMatch = (t.asset_id === pending.tokenId) || (t.token_id === pending.tokenId);
          const inWindow = matchTime >= pending.placedAt - 5000 && matchTime <= pending.placedAt + 60000;
          const tradePrice = parseFloat(t.price ?? t.fill_price ?? 0);
          const priceOk = !tradePrice || Math.abs(tradePrice - pending.price) / pending.price < 0.05;
          return assetMatch && inWindow && priceOk;
        });

        if (matchingTrade) {
          tradeFound = true;
        }
      } catch (err) {
        apiError = true;
        log.debug(`Trade history check failed (${err.message}) — will retry or assume filled`);
      }

      pending.verifyAttempts = (pending.verifyAttempts || 0) + 1;

      if (tradeFound) {
        // ── Confirmed via trade history ──
        const fill = { orderId, filled: true, rejected: false, verified: true, timeToFill: elapsed, adverseSelection };
        recordFill(fill);
        log.info(`Order ${orderId} fill CONFIRMED via trade history (attempt ${pending.verifyAttempts}, ${(elapsed / 1000).toFixed(1)}s)${adverseSelection ? ' [ADVERSE]' : ''}`);
        pendingOrders.delete(orderId);
        results.push(fill);
      } else if (!apiError && elapsed >= FILL_VERIFY_DEADLINE_MS && pending.verifyAttempts >= FILL_VERIFY_MIN_ATTEMPTS) {
        // ── Strong evidence of rejection: multiple failed checks, no API errors, past deadline ──
        const fill = { orderId, filled: false, rejected: true, verified: false, timeToFill: elapsed, adverseSelection: false };
        recordFill(fill);
        log.warn(`Order ${orderId} REJECTED: not found after ${pending.verifyAttempts} checks over ${(elapsed / 1000).toFixed(1)}s`);
        pendingOrders.delete(orderId);
        results.push(fill);
      } else if (elapsed >= FILL_VERIFY_DEADLINE_MS * 2) {
        // ── Absolute deadline (40s): assume filled (conservative safety net) ──
        // If API keeps failing and we can't verify, better to track phantom than lose real position
        const fill = { orderId, filled: true, rejected: false, verified: false, timeToFill: elapsed, adverseSelection: false };
        recordFill(fill);
        log.warn(`Order ${orderId} ASSUMED FILLED: verification inconclusive after ${(elapsed / 1000).toFixed(1)}s (${pending.verifyAttempts} attempts, API errors present) — defaulting to filled for safety`);
        pendingOrders.delete(orderId);
        results.push(fill);
      } else {
        // ── Keep checking on next poll ──
        log.debug(`Order ${orderId} unverified (attempt ${pending.verifyAttempts}, ${(elapsed / 1000).toFixed(1)}s) — will retry`);
      }
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
      log.warn(`Evicting stale pending order ${id} (${Math.round((evictNow - order.placedAt) / 1000)}s old) — assuming filled`);
      recordFill({ orderId: id, filled: true, verified: false, timeToFill: evictNow - order.placedAt, adverseSelection: false });
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
 * Register an externally-discovered pending order for fill tracking.
 * Used by startup reconciliation to inject CLOB open orders found at boot.
 * Uses Date.now() as placedAt to prevent premature fill inference (the 5s
 * minimum-elapsed guard in checkPendingFill won't false-positive).
 */
export function registerPendingOrder(orderId, { tokenId, price, size, side }) {
  if (pendingOrders.has(orderId)) {
    log.debug(`registerPendingOrder: ${orderId} already tracked — skipping`);
    return;
  }
  pendingOrders.set(orderId, { orderId, tokenId, price, size, side, placedAt: Date.now(), confirmed: false, verifyAttempts: 0 });
  log.info(`Registered existing order for tracking: ${orderId} (${side} ${size}@${price})`);
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
