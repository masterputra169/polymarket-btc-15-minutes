/**
 * Pure entry-time sanity & microstructure invariant guard.
 *
 * Runs right before execution (and DRY_RUN FOK commit) as a hard failsafe
 * against one-sided books, empty asks, inverted/negative spreads, extreme
 * UP+DOWN book sum anomalies, quote/ask divergence, and stale-book contradictions.
 */

export interface EntryInvariantInput {
  side: string;
  entryPrice: number;
  sideBook?: {
    bestBid?: number | null;
    bestAsk?: number | null;
    spread?: number | null;
  } | null;
  marketUp?: number | null;
  marketDown?: number | null;
  twapPhysicsZ?: number | null;
  bestEdge?: number | null;
}

export type EntryInvariantCode =
  | 'invalid_price'
  | 'one_sided_book'
  | 'negative_spread'
  | 'book_sum_anomaly'
  | 'price_ask_divergence'
  | 'extreme_z_cheap_price';

export interface EntryInvariantResult {
  ok: boolean;
  code?: EntryInvariantCode;
  reason?: string;
}

/** Validate pre-entry market & book invariants. Pure, synchronous, never throws. */
export function checkEntryInvariants(input: EntryInvariantInput): EntryInvariantResult {
  const { side, entryPrice, sideBook, marketUp, marketDown, twapPhysicsZ, bestEdge } = input;

  if (!Number.isFinite(entryPrice) || entryPrice <= 0 || entryPrice >= 1) {
    return {
      ok: false,
      code: 'invalid_price',
      reason: `entryPrice=${String(entryPrice)} outside (0, 1)`,
    };
  }

  if (sideBook != null && (sideBook.bestBid === null || sideBook.bestAsk === null || sideBook.spread === null)) {
    return {
      ok: false,
      code: 'one_sided_book',
      reason: `${side} book one-sided/incomplete (bid=${sideBook.bestBid}, ask=${sideBook.bestAsk}, spread=${sideBook.spread})`,
    };
  }

  if (sideBook?.spread != null && (!Number.isFinite(sideBook.spread) || sideBook.spread < -1e-9)) {
    return {
      ok: false,
      code: 'negative_spread',
      reason: `${side} spread invalid (${sideBook.spread})`,
    };
  }

  if (
    typeof marketUp === 'number' &&
    Number.isFinite(marketUp) &&
    typeof marketDown === 'number' &&
    Number.isFinite(marketDown)
  ) {
    const sum = marketUp + marketDown;
    if (Math.abs(sum - 1.0) > 0.15) {
      return {
        ok: false,
        code: 'book_sum_anomaly',
        reason: `marketUp (${marketUp.toFixed(3)}) + marketDown (${marketDown.toFixed(3)}) = ${sum.toFixed(3)} (!= 1.0 +/- 0.15)`,
      };
    }
  }

  if (
    typeof sideBook?.bestAsk === 'number' &&
    Number.isFinite(sideBook.bestAsk) &&
    sideBook.bestAsk > 0 &&
    sideBook.bestAsk < 1 &&
    Math.abs(entryPrice - sideBook.bestAsk) > 0.05
  ) {
    return {
      ok: false,
      code: 'price_ask_divergence',
      reason: `entryPrice ${entryPrice.toFixed(3)} diverges >5c from bestAsk ${sideBook.bestAsk.toFixed(3)}`,
    };
  }

  if (
    typeof twapPhysicsZ === 'number' &&
    Number.isFinite(twapPhysicsZ) &&
    Math.abs(twapPhysicsZ) >= 4.0 &&
    entryPrice < 0.70 &&
    typeof bestEdge === 'number' &&
    Number.isFinite(bestEdge) &&
    bestEdge >= 0.20
  ) {
    return {
      ok: false,
      code: 'extreme_z_cheap_price',
      reason: `|z|=${Math.abs(twapPhysicsZ).toFixed(2)} >= 4.0 with cheap entry ${(entryPrice * 100).toFixed(1)}c and edge ${(bestEdge * 100).toFixed(1)}% (likely stale book)`,
    };
  }

  return { ok: true };
}
