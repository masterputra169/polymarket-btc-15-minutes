/**
 * Pessimistic FIFO Queue-Ahead Simulator for Passive Maker Bids.
 *
 * Modeled after ItzJulkar/Polymarket-MM-Arb-Bot:
 *   1. A displayed bid does not guarantee a fill — a passive order placed at
 *      `targetPrice` enters behind `initialBookSizeAtBid` shares (`queueAhead`).
 *   2. Only aggressive SELL trades at `tradePrice <= targetPrice` occurring
 *      AFTER placement consume the queue (with optional L2 depth decrease check).
 *   3. Cancellations ahead NEVER shrink `queueAhead` (intentionally pessimistic).
 *   4. Book freshness must come from genuine quote frames (`book` / `price_change`),
 *      NEVER trade-only events; if book age exceeds `maxBookStaleMs` (default 500ms),
 *      the resting paper bid is stale-cancelled rather than catching ghost/stale fills.
 */

export const DEFAULT_MAX_BOOK_STALE_MS = 500;

export type QueueSimStatus = 'RESTING' | 'FILLED' | 'STALE_CANCELLED';

export interface QueueSimOrder {
  id: string;
  marketSlug: string;
  side: 'UP' | 'DOWN';
  targetPrice: number;
  shares: number;
  remainingShares: number;
  queueAhead: number;
  initialQueueAhead: number;
  placedAtMs: number;
  lastTradeCursorMs: number;
  status: QueueSimStatus;
  filledAtMs: number | null;
  cancelReason: string | null;
}

export interface QueueTradeTick {
  t: number;
  token: 'up' | 'down';
  side: 'BUY' | 'SELL' | null;
  price: number;
  size: number;
  /** Optional observed L2 bid size reduction at the resting bid price. */
  bookDecreaseAtBid?: number | null;
}

let activeOrder: QueueSimOrder | null = null;
let seq = 0;

/** Start tracking a pessimistic FIFO queue-ahead maker order. */
export function createQueueSimOrder(params: {
  marketSlug: string;
  side: 'UP' | 'DOWN';
  targetPrice: number;
  shares: number;
  initialBookSizeAtBid: number;
  nowMs?: number;
}): QueueSimOrder {
  const nowMs = params.nowMs ?? Date.now();
  const q = Number.isFinite(params.initialBookSizeAtBid) && params.initialBookSizeAtBid > 0
    ? params.initialBookSizeAtBid
    : 0;
  seq += 1;
  return {
    id: `qsim-${seq}`,
    marketSlug: params.marketSlug,
    side: params.side,
    targetPrice: params.targetPrice,
    shares: params.shares,
    remainingShares: params.shares,
    queueAhead: q,
    initialQueueAhead: q,
    placedAtMs: nowMs,
    lastTradeCursorMs: nowMs,
    status: 'RESTING',
    filledAtMs: null,
    cancelReason: null,
  };
}

/**
 * Evaluate a batch of ordered CLOB trade prints against a resting queue order.
 * Stale book check runs FIRST (strictly using `lastBookQuoteMs`, never trade-only ticks).
 */
export function stepQueueOrder(params: {
  order: QueueSimOrder;
  trades: readonly QueueTradeTick[];
  lastBookQuoteMs: number;
  nowMs?: number;
  maxBookStaleMs?: number;
}): QueueSimOrder {
  const { order } = params;
  if (order.status !== 'RESTING') return order;

  const nowMs = params.nowMs ?? Date.now();
  const maxStale = Math.max(50, params.maxBookStaleMs ?? DEFAULT_MAX_BOOK_STALE_MS);

  // Stale-book cancellation runs BEFORE allowing trades to fill a resting order.
  if (!(params.lastBookQuoteMs > 0) || (nowMs - params.lastBookQuoteMs) > maxStale) {
    order.status = 'STALE_CANCELLED';
    order.cancelReason = 'stale_book';
    return order;
  }

  const expectedToken = order.side === 'UP' ? 'up' : 'down';
  for (const tr of params.trades) {
    if (tr.token !== expectedToken) continue;
    if (tr.t <= order.placedAtMs || tr.t < order.lastTradeCursorMs) continue;
    order.lastTradeCursorMs = tr.t;

    // Require SELL aggressor when known; never fill on passive buys lifting the ask unless at/below bid.
    if (tr.side !== null && tr.side !== 'SELL') continue;
    if (!Number.isFinite(tr.price) || tr.price > order.targetPrice + 1e-9) continue;

    const rawSize = Number.isFinite(tr.size) && tr.size > 0 ? tr.size : 0;
    if (rawSize <= 0) continue;

    // If L2 depth corroboration is provided, take pessimistic min(tradeSize, bookDecreaseAtBid)
    const corroboratedSize = tr.bookDecreaseAtBid != null && Number.isFinite(tr.bookDecreaseAtBid)
      ? Math.max(0, Math.min(rawSize, tr.bookDecreaseAtBid))
      : rawSize;
    if (corroboratedSize <= 0) continue;

    let avail = corroboratedSize;
    if (order.queueAhead > 0) {
      const eatenAhead = Math.min(order.queueAhead, avail);
      order.queueAhead = Math.max(0, order.queueAhead - eatenAhead);
      avail -= eatenAhead;
    }
    if (avail > 0) {
      order.remainingShares = Math.max(0, order.remainingShares - avail);
      if (order.remainingShares <= 1e-9) {
        order.remainingShares = 0;
        order.status = 'FILLED';
        order.filledAtMs = tr.t;
        return order;
      }
    }
  }

  return order;
}

/** Immediate single-poll heuristic against recent sell volume already clearing the bid. */
export function estimateQueueFillFeasibility(params: {
  initialBookSizeAtBid: number;
  shares: number;
  spread: number | null;
  lastBookQuoteAgeMs: number | null;
  maxBookStaleMs?: number;
}): {
  queueAhead: number;
  bookFresh: boolean;
  expectedQueuePressure: number;
} {
  const q = Number.isFinite(params.initialBookSizeAtBid) && params.initialBookSizeAtBid > 0
    ? params.initialBookSizeAtBid
    : 0;
  const maxStale = params.maxBookStaleMs ?? DEFAULT_MAX_BOOK_STALE_MS;
  const bookFresh = params.lastBookQuoteAgeMs != null && Number.isFinite(params.lastBookQuoteAgeMs)
    ? params.lastBookQuoteAgeMs <= maxStale
    : true;
  const denom = Math.max(1, params.shares);
  const spreadBonus = params.spread != null && params.spread >= 0.02 ? 0.5 : 1.0;
  return {
    queueAhead: q,
    bookFresh,
    expectedQueuePressure: Number(((q / denom) * spreadBonus).toFixed(2)),
  };
}

export function setActiveQueueSimOrder(order: QueueSimOrder | null): void {
  activeOrder = order;
}

export function getActiveQueueSimOrder(): QueueSimOrder | null {
  return activeOrder;
}

export function resetQueueSim(): void {
  activeOrder = null;
  seq = 0;
}
