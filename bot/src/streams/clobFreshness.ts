/**
 * Is the CLOB feed good enough to price off right now?
 *
 * Two independent questions, which the previous rule collapsed into one:
 *
 *   1. Is the link alive?     — answered by ANY inbound frame, PONG included.
 *   2. Are the quotes current? — answered by the last book / price_change.
 *
 * A book with no activity for 20s is not stale data: nothing moved, so the
 * quotes we hold are exactly the live ones. Declaring it stale sent the bot to
 * `poly.prices`, a 30s Gamma cache — strictly older than what it just rejected.
 *
 * What genuinely makes the feed unusable is a dead link (Polymarket can drop a
 * subscription while the socket still answers PONG), a market whose first book
 * has not arrived yet, or a quote so old that even "nothing moved" stops being
 * a credible explanation.
 */

/** No inbound frame at all for this long — PING runs every 10s, so this is a missed answer. */
export const CLOB_LINK_DEAD_MS = 15_000;

/** No quote change for this long: still usable, but worth surfacing as amber. */
export const CLOB_QUIET_MS = 15_000;

/** No quote change for this long: "the book is just quiet" is no longer credible. */
export const CLOB_HARD_STALE_MS = 60_000;

export type ClobFeedStatus = 'live' | 'quiet' | 'down';

export interface ClobFeedHealth {
  now: number;
  /** Socket is open. */
  connected: boolean;
  /** A book snapshot for the CURRENT token IDs is held. */
  bookValid: boolean;
  /** Last inbound frame of any kind, PONG included. */
  lastFrameMs: number;
  /** Last frame that actually carried a quote (book / price_change / last_trade). */
  lastQuoteMs: number;
}

export interface ClobFeedVerdict {
  /** Safe to price and size trades off the WS book. */
  usable: boolean;
  status: ClobFeedStatus;
  /** How long the book has gone without a quote change. */
  quietMs: number;
  /** Why it is unusable — null when it is. */
  reason: 'disconnected' | 'no_book' | 'link_silent' | 'quote_expired' | null;
}

export function evaluateClobFeed({
  now,
  connected,
  bookValid,
  lastFrameMs,
  lastQuoteMs,
}: ClobFeedHealth): ClobFeedVerdict {
  const quietMs = lastQuoteMs > 0 ? now - lastQuoteMs : Infinity;
  const down = (reason: ClobFeedVerdict['reason']): ClobFeedVerdict =>
    ({ usable: false, status: 'down', quietMs, reason });

  if (!connected) return down('disconnected');
  if (!bookValid) return down('no_book');
  if (now - lastFrameMs > CLOB_LINK_DEAD_MS) return down('link_silent');
  if (quietMs > CLOB_HARD_STALE_MS) return down('quote_expired');

  return {
    usable: true,
    status: quietMs > CLOB_QUIET_MS ? 'quiet' : 'live',
    quietMs,
    reason: null,
  };
}
