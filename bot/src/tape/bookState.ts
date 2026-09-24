/**
 * One side-pair (bids + asks) of a Polymarket CLOB L2 book, rebuilt from the
 * market channel.
 *
 * `book` frames replace the whole book; `price_change` frames carry the NEW
 * aggregate size at one price level (size 0 removes it). Because sizes are
 * absolute, applying the same change twice is harmless — which is what makes a
 * book rebuilt from deltas trustworthy enough to record.
 *
 * Deliberately independent of streams/clobWs.ts: that module keeps only a
 * summary the trading path needs, and must not change while a dry-run
 * evaluation window is open.
 */

export type Level = [price: number, size: number];

export interface RawLevel { price?: unknown; size?: unknown }

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** Prices are quoted to at most 3-4 decimals; key them so 0.1 + 0.2 never splits a level. */
function priceKey(p: number): number {
  return Math.round(p * 1e6) / 1e6;
}

export class BookState {
  private bids = new Map<number, number>();
  private asks = new Map<number, number>();
  /** Local receive time of the last frame that touched this book; 0 = never. */
  updatedMs = 0;

  get valid(): boolean {
    return this.updatedMs > 0 && (this.bids.size > 0 || this.asks.size > 0);
  }

  clear(): void {
    this.bids.clear();
    this.asks.clear();
    this.updatedMs = 0;
  }

  /** Replace the book with a full snapshot. Malformed levels are skipped, not fatal. */
  applySnapshot(bids: unknown, asks: unknown, nowMs: number): void {
    this.bids = toMap(bids);
    this.asks = toMap(asks);
    this.updatedMs = nowMs;
  }

  /**
   * Apply one level change. `side` is the CLOB's order side: BUY rests on the
   * bid, SELL on the ask. Returns false if the change was unusable.
   */
  applyChange(side: unknown, price: unknown, size: unknown, nowMs: number): boolean {
    const p = num(price);
    const s = num(size);
    if (p === null || s === null || s < 0) return false;
    const book = side === 'BUY' ? this.bids : side === 'SELL' ? this.asks : null;
    if (!book) return false;
    const k = priceKey(p);
    if (s === 0) book.delete(k);
    else book.set(k, s);
    this.updatedMs = nowMs;
    return true;
  }

  /**
   * Drop levels the server says cannot exist: bids above its best bid, asks
   * below its best ask. A marketable order arrives as a `price_change` for its
   * resting remainder, but the opposite levels it consumed get no change of
   * their own (the next `book` frame carries them) — measured on Railway
   * 2026-09-24: 16 of 7,760 changes, always this pattern. Returns levels removed.
   */
  prune(serverBestBid: number | null, serverBestAsk: number | null, nowMs: number): number {
    let removed = 0;
    if (serverBestBid !== null && serverBestBid > 0) {
      for (const p of [...this.bids.keys()]) if (p > serverBestBid + 1e-9) { this.bids.delete(p); removed++; }
    }
    if (serverBestAsk !== null && serverBestAsk > 0) {
      for (const p of [...this.asks.keys()]) if (p < serverBestAsk - 1e-9) { this.asks.delete(p); removed++; }
    }
    if (removed > 0) this.updatedMs = nowMs;
    return removed;
  }

  bestBid(): number | null {
    let best: number | null = null;
    for (const p of this.bids.keys()) if (best === null || p > best) best = p;
    return best;
  }

  bestAsk(): number | null {
    let best: number | null = null;
    for (const p of this.asks.keys()) if (best === null || p < best) best = p;
    return best;
  }

  /** Best `depth` levels per side, best first: bids descending, asks ascending. */
  top(depth: number): { b: Level[]; a: Level[] } {
    return {
      b: [...this.bids].sort((x, y) => y[0] - x[0]).slice(0, depth),
      a: [...this.asks].sort((x, y) => x[0] - y[0]).slice(0, depth),
    };
  }
}

function toMap(levels: unknown): Map<number, number> {
  const out = new Map<number, number>();
  if (!Array.isArray(levels)) return out;
  for (const lvl of levels as RawLevel[]) {
    const p = num(lvl?.price);
    const s = num(lvl?.size);
    if (p === null || s === null || s <= 0) continue;
    out.set(priceKey(p), s);
  }
  return out;
}
