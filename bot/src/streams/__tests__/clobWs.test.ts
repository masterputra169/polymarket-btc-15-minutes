/**
 * CLOB WebSocket stream: what it reports about itself, and how it changes sockets.
 *
 * Two things this covers that the old implementation got wrong:
 *
 *   1. It exposed a single `lastUpdate` that only moved when a quote moved, so
 *      callers could not tell "the link is dead" from "the book is quiet".
 *      getFeedHealth() now separates the two (see clobFreshness.ts).
 *
 *   2. Every subscription change — including the watchdog's own reconnect —
 *      tore the socket down first and reconnected into a 300ms timer plus a
 *      fresh TLS handshake, with no data at all in between. It now opens the
 *      replacement first and promotes it once it has a book (make-before-break).
 *
 * The distinction that matters in #2: on a *market switch* the old book belongs
 * to a different market and must be dropped immediately; on a *health* reconnect
 * the old book is still the right market and must keep serving until the
 * replacement is ready.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { CLOB_QUIET_MS, CLOB_HARD_STALE_MS, evaluateClobFeed } from '../clobFreshness.ts';

const { sockets } = vi.hoisted(() => ({ sockets: [] as any[] }));

vi.mock('ws', () => {
  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;

    url: string;
    readyState = FakeWebSocket.CONNECTING;
    sent: string[] = [];
    handlers = new Map<string, ((...a: any[]) => void)[]>();

    constructor(url: string) {
      this.url = url;
      sockets.push(this);
    }

    on(event: string, fn: (...a: any[]) => void) {
      if (!this.handlers.has(event)) this.handlers.set(event, []);
      this.handlers.get(event)!.push(fn);
      return this;
    }

    send(data: string) {
      if (this.readyState !== FakeWebSocket.OPEN) throw new Error('not open');
      this.sent.push(data);
    }

    close() {
      if (this.readyState === FakeWebSocket.CLOSED) return;
      this.readyState = FakeWebSocket.CLOSED;
      this.emit('close');
    }

    // ── test drivers ──
    emit(event: string, ...args: any[]) {
      for (const fn of this.handlers.get(event) ?? []) fn(...args);
    }

    accept() {
      this.readyState = FakeWebSocket.OPEN;
      this.emit('open');
    }

    deliver(msg: unknown) {
      this.emit('message', JSON.stringify(msg));
    }

    get isOpen() {
      return this.readyState === FakeWebSocket.OPEN;
    }

    /** Token ids this socket subscribed to, in order of subscribe messages. */
    get subscriptions(): string[][] {
      return this.sent
        .filter(s => s !== 'PING')
        .map(s => JSON.parse(s).assets_ids);
    }
  }

  return { WebSocket: FakeWebSocket };
});

const UP = 'token-up-1';
const DOWN = 'token-down-1';
const UP2 = 'token-up-2';
const DOWN2 = 'token-down-2';

function book(assetId: string, bid: number, ask: number) {
  return {
    event_type: 'book',
    asset_id: assetId,
    bids: [{ price: String(bid), size: '500' }],
    asks: [{ price: String(ask), size: '500' }],
  };
}

let clob: typeof import('../clobWs.ts');

beforeEach(async () => {
  sockets.length = 0;
  vi.resetModules();
  vi.useFakeTimers();
  clob = await import('../clobWs.ts');
});

afterEach(() => {
  clob.disconnect();
  vi.useRealTimers();
});

/** Bring a feed up on UP/DOWN with a book in hand, and return the live socket. */
function bringUp() {
  clob.setTokenIds(UP, DOWN);
  clob.connect();
  const sock = sockets[sockets.length - 1];
  sock.accept();
  sock.deliver(book(UP, 0.48, 0.52));
  sock.deliver(book(DOWN, 0.47, 0.51));
  return sock;
}

describe('getFeedHealth', () => {
  test('reports no book until a book snapshot arrives', () => {
    clob.setTokenIds(UP, DOWN);
    clob.connect();
    sockets[0].accept();

    expect(clob.getFeedHealth().connected).toBe(true);
    expect(clob.getFeedHealth().bookValid, 'subscribed is not the same as having a book').toBe(false);
  });

  test('reports a valid book once a snapshot for a subscribed token arrives', () => {
    const sock = bringUp();
    expect(sock.subscriptions.at(-1)).toEqual([UP, DOWN]);

    const health = clob.getFeedHealth();
    expect(health.bookValid).toBe(true);
    expect(health.lastQuoteMs).toBeGreaterThan(0);
    expect(clob.getUpPrice()).toBeCloseTo(0.50, 10);
  });

  test('a PONG proves the link without pretending a quote arrived', () => {
    // The whole point of splitting the two timestamps: PING/PONG keeps proving
    // the socket is alive during a quiet book, so the feed stays usable.
    const sock = bringUp();
    const afterBook = clob.getFeedHealth();

    vi.advanceTimersByTime(12_000);
    sock.emit('message', 'PONG');

    const afterPong = clob.getFeedHealth();
    expect(afterPong.lastFrameMs, 'a PONG is a frame').toBeGreaterThan(afterBook.lastFrameMs);
    expect(afterPong.lastQuoteMs, 'a PONG is not a quote').toBe(afterBook.lastQuoteMs);
  });

  test('a price_change with no changes is a frame but not a quote', () => {
    // CLOB sends these; treating them as quotes would mask a truly stale book.
    const sock = bringUp();
    const afterBook = clob.getFeedHealth();

    vi.advanceTimersByTime(5_000);
    sock.deliver({ event_type: 'price_change', price_changes: [] });

    const after = clob.getFeedHealth();
    expect(after.lastFrameMs).toBeGreaterThan(afterBook.lastFrameMs);
    expect(after.lastQuoteMs).toBe(afterBook.lastQuoteMs);
  });

  test('a price_change carrying quotes updates both timestamps and the book', () => {
    const sock = bringUp();
    const afterBook = clob.getFeedHealth();

    vi.advanceTimersByTime(5_000);
    sock.deliver({
      event_type: 'price_change',
      price_changes: [{ asset_id: UP, best_bid: '0.60', best_ask: '0.64' }],
    });

    expect(clob.getFeedHealth().lastQuoteMs).toBeGreaterThan(afterBook.lastQuoteMs);
    expect(clob.getUpPrice()).toBeCloseTo(0.62, 10);
  });
});

describe('a half-open serving socket', () => {
  test('is not disguised as alive by the replacement\'s own frames', () => {
    // A black-holed connection never fires 'close', so readyState stays OPEN
    // forever and the book freezes. The only thing that gives it away is the
    // absence of inbound frames — which is worthless if a standby's handshake
    // and PONGs are allowed to refresh the same liveness clock. This is
    // precisely the failure the file sets out to catch: a subscription that
    // dies while the socket still looks fine.
    const zombie = bringUp();

    vi.advanceTimersByTime(21_000); // past HEARTBEAT_DEAD_MS: a replacement is raised
    const standby = sockets[sockets.length - 1];
    expect(standby, 'a replacement should have been raised').not.toBe(zombie);

    standby.accept();               // connects and answers pings, but no book yet
    vi.advanceTimersByTime(1_000);
    standby.emit('message', 'PONG');

    const feed = evaluateClobFeed(clob.getFeedHealth());
    expect(feed.usable, 'a frozen book must not be priced off').toBe(false);
    expect(feed.reason).toBe('link_silent');
  });

  test('recovers its liveness the moment a replacement is promoted', () => {
    // The flip side: once the replacement proves itself, the feed must be
    // usable again immediately rather than inheriting the zombie's silence.
    const zombie = bringUp();
    vi.advanceTimersByTime(21_000);
    const standby = sockets[sockets.length - 1];
    standby.accept();
    standby.deliver(book(UP, 0.55, 0.59));

    const feed = evaluateClobFeed(clob.getFeedHealth());
    expect(feed.usable).toBe(true);
    expect(feed.status).toBe('live');
    expect(zombie.isOpen).toBe(false);
  });
});

describe('setTokenIds — make-before-break', () => {
  test('subscribes on the open socket when it has nothing to replace', () => {
    // Cold start: bot/index.ts connects before the market is known, so the
    // first setTokenIds() arrives at an open but unsubscribed socket. There is
    // no subscription to preserve, so opening a second socket is pure waste.
    clob.connect();
    const sock = sockets[0];
    sock.accept();
    expect(sock.subscriptions, 'nothing to subscribe to yet').toEqual([]);

    clob.setTokenIds(UP, DOWN);

    expect(sockets.length, 'no replacement socket should be opened').toBe(1);
    expect(sock.subscriptions.at(-1)).toEqual([UP, DOWN]);
  });

  test('re-points an in-flight replacement at the new market', () => {
    // Reachable state: the serving socket really died while a replacement was
    // being raised, leaving ws=null with a pending that is subscribed to the
    // market we are now leaving. Neither arm of setTokenIds used to fire, so
    // the feed sat on REST until that replacement's own 8s watchdog expired —
    // a hole at exactly the rollover boundary make-before-break exists to close.
    const zombie = bringUp();
    vi.advanceTimersByTime(21_000);
    const standby = sockets[sockets.length - 1];
    standby.accept();
    expect(standby.subscriptions.at(-1)).toEqual([UP, DOWN]);

    zombie.close();                // serving socket is genuinely gone
    const socketsBefore = sockets.length;

    clob.setTokenIds(UP2, DOWN2);

    expect(standby.subscriptions.at(-1), 'the in-flight socket should follow the new market').toEqual([UP2, DOWN2]);
    expect(sockets.length, 'no third socket is needed').toBe(socketsBefore);

    standby.deliver(book(UP2, 0.30, 0.34));
    expect(clob.getUpPrice()).toBeCloseTo(0.32, 10);
  });

  test('backs off instead of hammering when replacements never deliver a book', () => {
    // A market can accept the handshake and the subscription and still never
    // send a book (partial outage, or a token that just resolved). The retry
    // path went straight to newSocket() with no delay, so it reconnected every
    // 8s forever — an un-throttled connection stream to Polymarket that risks
    // rate-limiting the same host that places orders.
    clob.setTokenIds(UP, DOWN);
    clob.connect();

    let accepted = 0;
    for (let t = 0; t < 120_000; t += 1_000) {
      while (accepted < sockets.length) sockets[accepted++].accept();
      vi.advanceTimersByTime(1_000);
    }

    // Un-throttled this is ~15 (one per SUB_WATCHDOG_MS); backing off is ~7.
    expect(sockets.length, 'retries must slow down, not repeat every 8s').toBeLessThanOrEqual(8);
    expect(sockets.length, 'but must not give up entirely').toBeGreaterThan(2);
  });

  test('drops the outgoing market book the instant the tokens change', () => {
    // Non-negotiable: the previous market's quotes describe a different
    // question. They must never survive into the new market, however briefly.
    bringUp();
    expect(clob.getUpPrice()).not.toBeNull();

    clob.setTokenIds(UP2, DOWN2);

    expect(clob.getUpPrice()).toBeNull();
    expect(clob.getDownPrice()).toBeNull();
    expect(clob.getFeedHealth().bookValid).toBe(false);
  });

  test('subscribes the replacement socket before closing the outgoing one', () => {
    // The old path closed first and reconnected through a 300ms timer plus a
    // fresh TLS handshake — a guaranteed data gap at every 15-minute rollover.
    const old = bringUp();
    const socketsBefore = sockets.length;

    clob.setTokenIds(UP2, DOWN2);
    const standby = sockets[sockets.length - 1];
    standby.accept();

    expect(sockets.length, 'a replacement socket should have been opened').toBe(socketsBefore + 1);
    expect(standby).not.toBe(old);
    expect(standby.subscriptions.at(-1)).toEqual([UP2, DOWN2]);
    expect(old.isOpen, 'the outgoing socket must still be open while the replacement subscribes').toBe(true);
  });

  test('promotes the replacement and closes the outgoing socket once a book arrives', () => {
    const old = bringUp();
    clob.setTokenIds(UP2, DOWN2);
    const standby = sockets[sockets.length - 1];
    standby.accept();

    standby.deliver(book(UP2, 0.30, 0.34));

    expect(clob.getUpPrice()).toBeCloseTo(0.32, 10);
    expect(clob.getFeedHealth().bookValid).toBe(true);
    expect(old.isOpen, 'the outgoing socket must be closed after promotion').toBe(false);
    expect(sockets.filter(s => s.isOpen)).toEqual([standby]);
  });

  test('a closing outgoing socket does not drag the promoted one into a reconnect', () => {
    // The old socket's 'close' handler used to schedule a reconnect
    // unconditionally. After promotion it must be inert.
    bringUp();
    clob.setTokenIds(UP2, DOWN2);
    const standby = sockets[sockets.length - 1];
    standby.accept();
    standby.deliver(book(UP2, 0.30, 0.34));

    const openAfterPromotion = sockets.length;
    vi.advanceTimersByTime(5_000);

    expect(sockets.length, 'no extra socket should have been opened').toBe(openAfterPromotion);
    expect(clob.getUpPrice()).toBeCloseTo(0.32, 10);
  });

  test('re-verifies a quiet book with a replacement instead of dropping the current one', () => {
    // A quiet book is usable (see clobFreshness) but the subscription could
    // also have died silently while the socket still answers PONG. The old code
    // resolved that by tearing the socket down every 20s of quiet — correct,
    // but it blanked the feed each time, which is the flapping being fixed.
    // A replacement socket re-verifies AND refreshes on the same channel.
    const old = bringUp();
    const priceBefore = clob.getUpPrice();

    // Link stays provably alive; only the book is quiet.
    for (let elapsed = 0; elapsed < clob.QUIET_RESYNC_MS + 2_000; elapsed += 5_000) {
      vi.advanceTimersByTime(5_000);
      old.emit('message', 'PONG');
      expect(clob.getUpPrice(), 'the book must keep serving all through the resync').toBe(priceBefore);
    }

    const standby = sockets[sockets.length - 1];
    expect(standby, 'a resync should have opened a replacement').not.toBe(old);
    expect(old.isOpen, 'the current socket must stay up until the replacement proves itself').toBe(true);

    standby.accept();
    standby.deliver(book(UP, 0.55, 0.59));

    expect(clob.getUpPrice()).toBeCloseTo(0.57, 10);
    expect(old.isOpen).toBe(false);
  });

  test('resyncs a quiet book before the freshness rule would call it unusable', () => {
    // If the resync fired after the hard ceiling, the feed would go unusable
    // first and the resync would be pointless. Ordering is the contract.
    expect(clob.QUIET_RESYNC_MS).toBeLessThan(CLOB_HARD_STALE_MS);
    expect(clob.QUIET_RESYNC_MS).toBeGreaterThanOrEqual(CLOB_QUIET_MS);
  });

  test('does not count the outgoing market\'s frames as quotes', () => {
    // The outgoing socket stays subscribed to the old tokens until it is
    // closed, so it keeps delivering. Those frames describe a market we no
    // longer follow: counting them would report a fresh quote for the new
    // market while we are still waiting for its first book.
    const old = bringUp();
    clob.setTokenIds(UP2, DOWN2);
    const quietAfterSwitch = clob.getFeedHealth().lastQuoteMs;

    vi.advanceTimersByTime(2_000);
    old.deliver(book(UP, 0.49, 0.53));

    expect(clob.getFeedHealth().lastQuoteMs, 'an old-market book is not a quote').toBe(quietAfterSwitch);
    expect(clob.getFeedHealth().bookValid).toBe(false);
    expect(clob.getUpPrice()).toBeNull();
  });

  test('the outgoing socket\'s watchdog does not cancel the replacement in flight', () => {
    // The outgoing socket stops producing usable quotes the moment the tokens
    // change, so its 8s subscribe watchdog fires. It must not tear down the
    // replacement that is already being brought up.
    // Subscribed but never quoted, so its watchdog is still armed.
    clob.setTokenIds(UP, DOWN);
    clob.connect();
    const old = sockets[0];
    old.accept();

    vi.advanceTimersByTime(5_000);
    clob.setTokenIds(UP2, DOWN2);
    const standby = sockets[sockets.length - 1];
    standby.accept();

    // t=9s: the outgoing socket's 8s watchdog fires with a replacement in flight.
    vi.advanceTimersByTime(4_000);

    expect(sockets[sockets.length - 1], 'the in-flight replacement must survive').toBe(standby);
    expect(standby.isOpen).toBe(true);

    standby.deliver(book(UP2, 0.30, 0.34));
    expect(clob.getUpPrice()).toBeCloseTo(0.32, 10);
    expect(old.isOpen).toBe(false);
  });

  test('keeps pinging the replacement when the serving socket dies mid-swap', () => {
    // The worst moment to stop pinging: the primary is genuinely gone and the
    // replacement is the only thing standing. An unpinged standby can be culled
    // by the server before it has delivered its first book, which would turn a
    // recoverable swap into an outage.
    const old = bringUp();

    vi.advanceTimersByTime(6_000);
    clob.setTokenIds(UP2, DOWN2);
    const standby = sockets[sockets.length - 1];
    standby.accept();

    old.close(); // network drop, not a promotion

    vi.advanceTimersByTime(5_000); // past the 10s ping tick, before the 8s sub watchdog
    expect(standby.sent, 'the standby must still be pinged').toContain('PING');
  });

  test('discards a replacement that never delivers a book and tries again', () => {
    // Make-before-break must not become wait-forever: if the standby is silent,
    // the subscribe watchdog has to give up on it and start over.
    bringUp();
    clob.setTokenIds(UP2, DOWN2);
    const standby = sockets[sockets.length - 1];
    standby.accept();

    vi.advanceTimersByTime(9_000);

    expect(standby.isOpen, 'a silent replacement must be discarded').toBe(false);
    expect(sockets.length, 'a fresh attempt should have been started').toBeGreaterThan(
      sockets.indexOf(standby) + 1
    );
  });
});
