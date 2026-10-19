/**
 * Market order constraints for the live CLOB V2 order path: the price tick and
 * the minimum order size.
 *
 * BTC 15m markets have `min_order_size` 5 shares and `tick_size` 0.01 (CLOB
 * `/book`, Gamma `orderMinSize` / `orderPriceMinTickSize`, CLOB
 * `/clob-markets/<conditionId>` `mos` / `mts` — checked 2026-09-27). An order
 * below the minimum is rejected by the CLOB, and a price off the tick grid is
 * rejected too (docs.polymarket.com/trading/place-orders).
 *
 * Everything here except the small per-token registry at the bottom is pure.
 * The registry is fed by the data fetcher from the REST book and Gamma market
 * it already fetches, and read only by clobClient.ts's live order functions,
 * so the dry-run path is unchanged: it never reaches those functions.
 *
 * What this module never does: upsize an order. A size under the market
 * minimum is refused with a reason; changing the stake is the operator's call.
 */

export const DEFAULT_TICK_SIZE = 0.01;
export const DEFAULT_MIN_ORDER_SIZE = 5;

/** Share quantities carry 2 decimals at every tick size (place-orders rounding table). */
export const SIZE_DECIMALS = 2;

/** USD amounts of a market BUY are rounded down to 2 decimals by the SDK. */
export const BUY_AMOUNT_DECIMALS = 2;

/**
 * GTD orders must expire at least 3 minutes in the future; the CLOB rejects
 * sooner expirations and expires GTD orders 1 minute before their stated time
 * (docs.polymarket.com/trading/place-orders, "Limit Orders").
 */
export const GTD_MIN_LEAD_SEC = 180;

/** Tick sizes the V2 SDK can sign with (its `TickSize` union). */
export const KNOWN_TICK_SIZES = ['0.1', '0.01', '0.005', '0.0025', '0.001', '0.0001'] as const;
export type TickSizeString = typeof KNOWN_TICK_SIZES[number];

export type OrderSide = 'BUY' | 'SELL';
export type OrderKind = 'market' | 'limit';
export type ConstraintSource = 'book' | 'gamma' | 'default';

export interface OrderConstraints {
  readonly tickSize: number;
  readonly minOrderSize: number;
  readonly tickSource: ConstraintSource;
  readonly minSizeSource: ConstraintSource;
}

export const DEFAULT_ORDER_CONSTRAINTS: OrderConstraints = Object.freeze({
  tickSize: DEFAULT_TICK_SIZE,
  minOrderSize: DEFAULT_MIN_ORDER_SIZE,
  tickSource: 'default',
  minSizeSource: 'default',
});

/** The fields of a CLOB `/book` response this module reads. */
export interface BookConstraintFields {
  readonly tick_size?: unknown;
  readonly min_order_size?: unknown;
}

/** The fields of a Gamma market this module reads. */
export interface GammaConstraintFields {
  readonly orderPriceMinTickSize?: unknown;
  readonly orderMinSize?: unknown;
}

const EPS = 1e-9;
const MAX_SANE_MIN_ORDER_SIZE = 1_000_000;

function positiveNumber(raw: unknown): number | null {
  if (raw == null || raw === '') return null;
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** The SDK tick string for a numeric tick, or null when the SDK cannot sign with it. */
export function tickSizeString(tick: number): TickSizeString | null {
  if (!Number.isFinite(tick) || tick <= 0) return null;
  for (const known of KNOWN_TICK_SIZES) {
    if (Math.abs(Number(known) - tick) < EPS) return known;
  }
  return null;
}

function validTick(raw: unknown): number | null {
  const n = positiveNumber(raw);
  return n != null && tickSizeString(n) != null ? n : null;
}

function validMinSize(raw: unknown): number | null {
  const n = positiveNumber(raw);
  return n != null && n <= MAX_SANE_MIN_ORDER_SIZE ? n : null;
}

/**
 * Constraints from the data the bot already has: the CLOB book first (it is
 * what the matching engine enforces), then the Gamma market, then the
 * defaults (5 shares, 0.01). Each field falls back on its own. Takes the raw
 * `/book` response and Gamma market (any shape). Never throws.
 */
export function parseOrderConstraints(bookInput?: unknown, marketInput?: unknown): OrderConstraints {
  const book = (bookInput && typeof bookInput === 'object' ? bookInput : {}) as BookConstraintFields;
  const market = (marketInput && typeof marketInput === 'object' ? marketInput : {}) as GammaConstraintFields;
  const bookTick = validTick(book.tick_size);
  const gammaTick = validTick(market.orderPriceMinTickSize);
  const bookMin = validMinSize(book.min_order_size);
  const gammaMin = validMinSize(market.orderMinSize);

  return Object.freeze({
    tickSize: bookTick ?? gammaTick ?? DEFAULT_TICK_SIZE,
    tickSource: bookTick != null ? 'book' : gammaTick != null ? 'gamma' : 'default',
    minOrderSize: bookMin ?? gammaMin ?? DEFAULT_MIN_ORDER_SIZE,
    minSizeSource: bookMin != null ? 'book' : gammaMin != null ? 'gamma' : 'default',
  });
}

function decimalsOf(tick: number): number {
  const s = String(tick);
  if (s.includes('e-')) return Number(s.split('e-')[1]);
  const dot = s.indexOf('.');
  return dot < 0 ? 0 : s.length - dot - 1;
}

/**
 * Round a limit price onto the tick grid, inward: a BUY (a maximum price)
 * rounds down, a SELL (a minimum price) rounds up.
 *
 * Every resting level sits on the grid, so a BUY at p can only fill against
 * asks at or below floor(p) anyway — rounding down loses no fill and never
 * pays more than asked. Symmetrically for a SELL and ceil(p).
 */
export function roundPriceToTick(price: number, tick: number, side: OrderSide): number {
  const units = price / tick;
  const whole = side === 'BUY' ? Math.floor(units + EPS) : Math.ceil(units - EPS);
  return Number((whole * tick).toFixed(decimalsOf(tick)));
}

/** Round a share quantity down to the CLOB's size precision. */
export function floorShares(size: number): number {
  const f = 10 ** SIZE_DECIMALS;
  return Math.floor(size * f + EPS) / f;
}

/** Dollars to spend on a market BUY of `shares` at `price`, rounded down as the SDK does. */
export function marketBuyAmount(shares: number, price: number): number {
  const f = 10 ** BUY_AMOUNT_DECIMALS;
  return Math.floor(shares * price * f + EPS) / f;
}

export interface PrepareOrderInput {
  readonly side: OrderSide;
  readonly kind: OrderKind;
  readonly price: number;
  readonly size: number;
  readonly constraints: OrderConstraints;
}

export type PreparedOrder =
  | {
    readonly ok: true;
    /** Price on the tick grid. */
    readonly price: number;
    /** Shares, at CLOB precision. For a market BUY: the shares the dollar amount buys at `price`. */
    readonly size: number;
    /** Market BUY only: the USD amount the SDK signs (shares × price, rounded down). */
    readonly buyAmountUsd: number | null;
    /** Tick string for the SDK's `tickSize` option, or null to let the SDK resolve it. */
    readonly tickSize: TickSizeString | null;
  }
  | { readonly ok: false; readonly reason: string };

/**
 * Validate and normalise an order before it is signed. Returns the rounded
 * price and size, or a reason to refuse it — never a larger order.
 */
export function prepareOrder(input: PrepareOrderInput): PreparedOrder {
  const { side, kind, price, size, constraints } = input;
  const tick = constraints.tickSize;
  const minSize = constraints.minOrderSize;

  if (!Number.isFinite(price) || price <= 0 || price >= 1) {
    return { ok: false, reason: `price ${price} is not a probability in (0, 1)` };
  }
  if (!Number.isFinite(size) || size <= 0) {
    return { ok: false, reason: `size ${size} is not a positive number of shares` };
  }

  const roundedPrice = roundPriceToTick(price, tick, side);
  const maxPrice = Number((1 - tick).toFixed(decimalsOf(tick)));
  if (roundedPrice < tick - EPS || roundedPrice > maxPrice + EPS) {
    return {
      ok: false,
      reason: `price ${price} rounds to ${roundedPrice} on tick ${tick}, outside [${tick}, ${maxPrice}]`,
    };
  }

  const shares = floorShares(size);
  let buyAmountUsd: number | null = null;
  let effectiveShares = shares;
  if (side === 'BUY' && kind === 'market') {
    buyAmountUsd = marketBuyAmount(shares, roundedPrice);
    effectiveShares = buyAmountUsd / roundedPrice;
  }

  if (effectiveShares + EPS < minSize) {
    return {
      ok: false,
      reason:
        `size ${Number(effectiveShares.toFixed(4))} shares is below the market minimum of ${minSize} ` +
        `(${constraints.minSizeSource}) — not upsizing, the stake is the operator's decision`,
    };
  }

  return {
    ok: true,
    price: roundedPrice,
    size: shares,
    buyAmountUsd,
    tickSize: tickSizeString(tick),
  };
}

/**
 * Smallest GTD lead the limit-order strategy can produce: it places up to
 * `maxElapsedMin` into a market and expires `expirationBufferSec` before the
 * market ends. Below GTD_MIN_LEAD_SEC, late placements are refused.
 */
export function worstCaseLimitLeadSec(maxElapsedMin: number, expirationBufferSec: number, marketSec = 900): number {
  return Math.floor(marketSec - maxElapsedMin * 60 - expirationBufferSec);
}

/** Reason to refuse a GTD expiration (unix seconds), or null when the CLOB will accept it. */
export function checkGtdExpiration(expirationSec: number, nowSec: number): string | null {
  if (!Number.isFinite(expirationSec)) return `GTD expiration ${expirationSec} is not a unix timestamp`;
  const lead = expirationSec - nowSec;
  if (lead < GTD_MIN_LEAD_SEC) {
    return `GTD expiration is ${lead}s ahead; CLOB V2 requires at least ${GTD_MIN_LEAD_SEC}s`;
  }
  return null;
}

// ── Per-token registry (fed by the data fetcher, read by the live order path) ──

const MAX_TRACKED_TOKENS = 16;
const registry = new Map<string, OrderConstraints>();

/** Remember the constraints last seen for a token. Never throws. */
export function recordOrderConstraints(tokenId: unknown, constraints: OrderConstraints | null | undefined): void {
  if (typeof tokenId !== 'string' || tokenId === '' || !constraints) return;
  registry.delete(tokenId);
  registry.set(tokenId, constraints);
  while (registry.size > MAX_TRACKED_TOKENS) {
    const oldest = registry.keys().next().value;
    if (oldest === undefined) break;
    registry.delete(oldest);
  }
}

/** Constraints last seen for a token, or the defaults (5 shares, 0.01). */
export function getOrderConstraints(tokenId: string): OrderConstraints {
  return registry.get(tokenId) ?? DEFAULT_ORDER_CONSTRAINTS;
}

/** Test helper: forget every recorded token. */
export function clearOrderConstraints(): void {
  registry.clear();
}
