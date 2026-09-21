/**
 * CLOB feed freshness decision.
 *
 * This exists because the old rule conflated two different things: "the link is
 * alive" and "a quote changed recently". It read `now - lastUpdate > 15s` as
 * stale, where lastUpdate only advanced on book/price_change events. A book that
 * simply had no activity for 15s was therefore declared stale and the bot fell
 * back to `poly.prices` — a 30s Gamma cache (tieredCache MARKET_DISCOVERY_INTERVAL).
 * It rejected a 15s-old live book in favour of a snapshot that could be 30s old.
 *
 * The properties that matter: a quiet book is usable (nothing changed, so the
 * quotes ARE current), a silent *link* is not (the subscription may have died
 * while the socket still answers PONG), a book we have never received is not,
 * and there is still a hard ceiling past which no quote is tradeable.
 */

import { describe, test, expect } from 'vitest';
import {
  evaluateClobFeed,
  CLOB_LINK_DEAD_MS,
  CLOB_QUIET_MS,
  CLOB_HARD_STALE_MS,
} from '../clobFreshness.ts';

const NOW = 1_700_000_000_000;

/** A healthy feed: connected, book in hand, frame and quote both just arrived. */
function healthy(overrides = {}) {
  return {
    now: NOW,
    connected: true,
    bookValid: true,
    lastFrameMs: NOW - 200,
    lastQuoteMs: NOW - 200,
    ...overrides,
  };
}

describe('evaluateClobFeed', () => {
  test('a book with a fresh quote is live and usable', () => {
    const feed = evaluateClobFeed(healthy());
    expect(feed.usable).toBe(true);
    expect(feed.status).toBe('live');
  });

  test('a quiet book stays usable — no quote changed, so the quotes are current', () => {
    // The regression this whole module exists for. PING/PONG keeps the link
    // provably alive; the book simply had no activity.
    const quietMs = CLOB_QUIET_MS + 5_000;
    const feed = evaluateClobFeed(healthy({
      lastFrameMs: NOW - 1_000,       // PONG landed 1s ago — link is alive
      lastQuoteMs: NOW - quietMs,     // but no price moved for 20s
    }));

    expect(feed.usable, 'a quiet book must not fall back to the 30s REST cache').toBe(true);
    expect(feed.status).toBe('quiet');
    expect(feed.quietMs).toBe(quietMs);
  });

  test('a disconnected feed is down and unusable', () => {
    const feed = evaluateClobFeed(healthy({ connected: false }));
    expect(feed.usable).toBe(false);
    expect(feed.status).toBe('down');
    expect(feed.reason).toBe('disconnected');
  });

  test('a connected feed with no book snapshot yet is unusable', () => {
    // The window right after setTokenIds(): socket is up and subscribed, but the
    // first book for the NEW market has not landed. Serving the old market's
    // prices here would be worse than any REST fallback.
    const feed = evaluateClobFeed(healthy({ bookValid: false, lastQuoteMs: 0 }));
    expect(feed.usable).toBe(false);
    expect(feed.status).toBe('down');
    expect(feed.reason).toBe('no_book');
  });

  test('a silent link is unusable even while the book looks recent', () => {
    // No inbound frame at all — not even a PONG answer to our 10s PING. The
    // subscription may be dead; we cannot tell, so we must not trade on it.
    const feed = evaluateClobFeed(healthy({
      lastFrameMs: NOW - (CLOB_LINK_DEAD_MS + 1_000),
      lastQuoteMs: NOW - 500,
    }));
    expect(feed.usable).toBe(false);
    expect(feed.status).toBe('down');
    expect(feed.reason).toBe('link_silent');
  });

  test('a quote past the hard ceiling is unusable however alive the link is', () => {
    // Backstop: a market that has genuinely not traded in a minute is not a
    // market we price a 15-minute binary off.
    const feed = evaluateClobFeed(healthy({
      lastFrameMs: NOW - 500,
      lastQuoteMs: NOW - (CLOB_HARD_STALE_MS + 1),
    }));
    expect(feed.usable).toBe(false);
    expect(feed.status).toBe('down');
    expect(feed.reason).toBe('quote_expired');
  });

  test('the quiet threshold sits below the hard ceiling', () => {
    // If these ever cross, the feed would go unusable before it was ever
    // reported as quiet, and the dashboard's amber state would be unreachable.
    expect(CLOB_QUIET_MS).toBeLessThan(CLOB_HARD_STALE_MS);
  });
});
