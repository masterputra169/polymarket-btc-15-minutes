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
 * CRITICAL SAFETY PRINCIPLE for BUY fills: Default to "assumed filled" (conservative).
 * Unwinding a REAL position = permanent loss (shares exist on-chain but untracked).
 * Tracking a phantom position = minor cost (settles at expiry as a loss).
 * Only mark "rejected" with STRONG evidence (multiple failed verifications over 20s+).
 *
 * CRITICAL SAFETY PRINCIPLE for SELL fills (cut-loss/take-profit): Default to UNCERTAIN.
 * Assuming a sell filled when it didn't blocks cut-loss retry, stranding the position.
 * Better to retry a sell (worst case: "not enough balance" error) than strand a position.
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

// GTD (limit) orders: longer verification — they sit on the book, may fill minutes later
const GTD_VERIFY_FIRST_CHECK_MS = 15_000;   // Wait 15s before first check (CLOB indexing lag)
const GTD_VERIFY_DEADLINE_MS = 120_000;      // 2 min before giving up (order may sit on book)
const GTD_VERIFY_MIN_ATTEMPTS = 5;           // Need 5+ failed checks

// ── Module state ──
// M3: Support multiple concurrent pending orders (e.g. arb legs)
let pendingOrders = new Map();  // orderId → { orderId, tokenId, price, size, side, placedAt, confirmed, verifyAttempts }
let fillHistory = [];            // last N fills
let fillRate = 1.0;              // rolling fill rate (initially optimistic)
let uncertainFills = [];         // Track uncertain fills for manual review (sell orders that timed out)

/**
 * Record a newly placed order for tracking.
 * M3: Supports concurrent orders — each tracked independently by orderId.
 *
 * @param {string} orderId
 * @param {Object} info - Order details
 * @param {boolean} [info.confirmed] - If true, CLOB response included fill data (makingAmount/takingAmount).
 *   This is direct proof of fill — skip trade history verification entirely.
 */
export function trackOrderPlacement(orderId, { tokenId, price, size, side, confirmed = false, gtd = false }) {
  // M9: Cap pending orders to prevent unbounded growth if checkPendingFill fails repeatedly
  const MAX_PENDING = 20;
  if (pendingOrders.size >= MAX_PENDING && !pendingOrders.has(orderId)) {
    // Evict oldest entry
    const oldest = pendingOrders.keys().next().value;
    log.warn(`Pending orders at cap (${MAX_PENDING}) — evicting oldest: ${oldest}`);
    pendingOrders.delete(oldest);
  }
  pendingOrders.set(orderId, {
    orderId, tokenId, price, size, side,
    placedAt: Date.now(),
    confirmed,         // CLOB response had fill data → skip verification
    gtd,               // GTD limit order → longer verification, default to assumed-filled (not rejected)
    verifyAttempts: 0, // Number of trade history checks attempted
  });
  log.debug(`Tracking order ${orderId}: ${side} ${size}@${price} confirmed=${confirmed} gtd=${gtd} (${pendingOrders.size} pending)`);
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
    // H3 FIX: Handle all Polymarket order ID field names (API returns o.id OR o.orderID OR o.order_id)
    const openIds = new Set(openOrders.map(o => o.id ?? o.orderID ?? o.order_id));

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
      // GTD orders get longer wait — CLOB indexing lag for limit orders is longer
      const firstCheckMs = pending.gtd ? GTD_VERIFY_FIRST_CHECK_MS : FILL_VERIFY_FIRST_CHECK_MS;
      if (elapsed < firstCheckMs) {
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
        // Match by tokenId + time window + price proximity + size proximity
        const matchingTrade = Array.isArray(trades) && trades.find(t => {
          const matchTime = t.match_time ? new Date(t.match_time).getTime() : (t.timestamp ?? 0);
          const assetMatch = (t.asset_id === pending.tokenId) || (t.token_id === pending.tokenId);
          const inWindow = matchTime >= pending.placedAt - 5000 && matchTime <= pending.placedAt + 60000;
          const tradePrice = parseFloat(t.price ?? t.fill_price ?? 0);
          const priceOk = !tradePrice || Math.abs(tradePrice - pending.price) / pending.price < 0.05;
          // FINTECH: Verify fill size matches expected — prevents matching tiny partial fills as full orders
          const tradeSize = parseFloat(t.size ?? t.amount ?? 0);
          const sizeOk = !tradeSize || Math.abs(tradeSize - pending.size) / pending.size < 0.10; // 10% tolerance
          return assetMatch && inWindow && priceOk && sizeOk;
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
      } else if (!apiError && !pending.gtd && elapsed >= FILL_VERIFY_DEADLINE_MS && pending.verifyAttempts >= FILL_VERIFY_MIN_ATTEMPTS) {
        // ── Strong evidence of rejection: multiple failed checks, no API errors, past deadline ──
        // NOTE: GTD orders skip this path — they default to assumed-filled (conservative safety)
        const fill = { orderId, filled: false, rejected: true, verified: false, timeToFill: elapsed, adverseSelection: false };
        recordFill(fill);
        log.warn(`Order ${orderId} REJECTED: not found after ${pending.verifyAttempts} checks over ${(elapsed / 1000).toFixed(1)}s`);
        pendingOrders.delete(orderId);
        results.push(fill);
      } else if (pending.gtd && !apiError && elapsed >= GTD_VERIFY_DEADLINE_MS && pending.verifyAttempts >= GTD_VERIFY_MIN_ATTEMPTS) {
        // ── GTD order deadline: default to assumed-filled (conservative) ──
        // GTD orders were accepted by CLOB → they sat on the book. If not in openOrders AND not in
        // trade history after 2 min, most likely filled but trade history has lag. Better to track a
        // phantom than unwind a real position.
        const fill = { orderId, filled: true, rejected: false, verified: false, timeToFill: elapsed, adverseSelection: false };
        recordFill(fill);
        log.warn(`GTD order ${orderId} ASSUMED FILLED: not found after ${pending.verifyAttempts} checks over ${(elapsed / 1000).toFixed(1)}s — defaulting to filled (conservative)`);
        pendingOrders.delete(orderId);
        results.push(fill);
      } else if (elapsed >= (pending.gtd ? GTD_VERIFY_DEADLINE_MS : FILL_VERIFY_DEADLINE_MS) * 2) {
        // ── Absolute deadline (40s) ──
        // SELL orders: Mark as UNCERTAIN and release sell lock so cut-loss can retry.
        // Assuming a sell filled when it didn't blocks cut-loss protection entirely.
        // BUY orders: Assume filled (conservative — better to track phantom than lose real position).
        const isSellOrder = pending.side === 'SELL' || pending.side === 'CUT_LOSS' || pending.side === 'TAKE_PROFIT';
        if (isSellOrder) {
          const fill = { orderId, filled: false, rejected: false, uncertain: true, verified: false, timeToFill: elapsed, adverseSelection: false };
          recordFill(fill);
          uncertainFills.push({ orderId, tokenId: pending.tokenId, price: pending.price, size: pending.size, side: pending.side, placedAt: pending.placedAt, uncertainAt: Date.now(), elapsed });
          if (uncertainFills.length > 50) uncertainFills = uncertainFills.slice(-50);
          log.warn(`Order ${orderId} UNCERTAIN (sell): verification inconclusive after ${(elapsed / 1000).toFixed(1)}s (${pending.verifyAttempts} attempts) — releasing sell lock for cut-loss retry`);
          pendingOrders.delete(orderId);
          results.push(fill);
        } else {
          // BUY order: assume filled (conservative safety net)
          const fill = { orderId, filled: true, rejected: false, verified: false, timeToFill: elapsed, adverseSelection: false };
          recordFill(fill);
          log.warn(`Order ${orderId} ASSUMED FILLED (buy): verification inconclusive after ${(elapsed / 1000).toFixed(1)}s (${pending.verifyAttempts} attempts, API errors present) — defaulting to filled for safety`);
          pendingOrders.delete(orderId);
          results.push(fill);
        }
      } else {
        // ── Keep checking on next poll ──
        log.debug(`Order ${orderId} unverified (attempt ${pending.verifyAttempts}, ${(elapsed / 1000).toFixed(1)}s) — will retry`);
      }
    }
  } catch (err) {
    // API error — don't kill orders, just skip this check
    log.debug(`Fill check error: ${err.message}`);
  }

  // Evict stale pending orders (>10min) — H2: do ONE final CLOB verification before assuming filled.
  // Without this, a 10-min network outage followed by recovery would silently create phantom fills.
  const STALE_ORDER_MS = 10 * 60 * 1000;
  const evictNow = Date.now();
  for (const [id, order] of pendingOrders) {
    if (evictNow - order.placedAt > STALE_ORDER_MS) {
      const elapsed = evictNow - order.placedAt;
      let finalFilled = true; // default: assume filled (conservative for BUY orders)
      let finalVerified = false;
      try {
        const finalTrades = await Promise.race([
          getTradeHistory({ assetId: order.tokenId, after: order.placedAt - 5000 }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('final-verify timeout')), 3000)),
        ]);
        const found = Array.isArray(finalTrades) && finalTrades.find(t => {
          const matchTime = t.match_time ? new Date(t.match_time).getTime() : (t.timestamp ?? 0);
          return (t.asset_id === order.tokenId || t.token_id === order.tokenId) &&
            matchTime >= order.placedAt - 5000 && matchTime <= order.placedAt + 600_000;
        });
        if (found) {
          finalVerified = true;
          log.warn(`Stale order ${id} (${Math.round(elapsed / 1000)}s) — final verify: FOUND in trade history`);
        } else {
          // No match found — mark as NOT filled (safer than phantom position)
          finalFilled = false;
          log.warn(`Stale order ${id} (${Math.round(elapsed / 1000)}s) — final verify: NOT in trade history — marking REJECTED`);
        }
      } catch (verifyErr) {
        // API error — fall back to conservative default (assume filled for BUY orders)
        log.warn(`Stale order ${id} final verify failed: ${verifyErr.message} — defaulting to assumed filled`);
      }
      recordFill({ orderId: id, filled: finalFilled, verified: finalVerified, timeToFill: elapsed, adverseSelection: false });
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
 * H2 audit fix: Clear all pending orders on market switch.
 * Old orders for previous market's tokens should not be tracked against new market.
 * The 10-minute stale eviction handles this eventually, but stale orders could match wrong trades.
 */
export function clearPendingOrders() {
  if (pendingOrders.size > 0) {
    log.info(`Clearing ${pendingOrders.size} pending orders (market switch)`);
    pendingOrders.clear();
  }
}

/**
 * Get uncertain fills for manual review.
 * These are sell orders that couldn't be verified within the deadline.
 */
export function getUncertainFills() {
  return [...uncertainFills];
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
    uncertainFillCount: uncertainFills.length,
    lastFillTime: fillHistory.length > 0 ? fillHistory[fillHistory.length - 1].ts : null,
  };
}
