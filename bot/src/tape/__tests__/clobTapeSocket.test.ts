import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const { sockets } = vi.hoisted(() => ({ sockets: [] as any[] }));

vi.mock('ws', () => {
  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;
    readyState = 0;
    sent: string[] = [];
    handlers = new Map<string, ((...a: any[]) => void)[]>();
    url: string;
    constructor(url: string) { this.url = url; sockets.push(this); }
    on(ev: string, fn: (...a: any[]) => void) {
      if (!this.handlers.has(ev)) this.handlers.set(ev, []);
      this.handlers.get(ev)!.push(fn);
      return this;
    }
    send(d: string) { if (this.readyState !== 1) throw new Error('not open'); this.sent.push(d); }
    close() { if (this.readyState === 3) return; this.readyState = 3; this.emit('close'); }
    emit(ev: string, ...a: any[]) { for (const fn of this.handlers.get(ev) ?? []) fn(...a); }
    accept() { this.readyState = 1; this.emit('open'); }
    deliver(msg: unknown) { this.emit('message', Buffer.from(JSON.stringify(msg))); }
  }
  return { WebSocket: FakeWebSocket, default: FakeWebSocket };
});

import { ClobTapeSocket } from '../clobTapeSocket.ts';

const BOOK_UP = { event_type: 'book', asset_id: 'UP', bids: [{ price: '0.55', size: '10' }], asks: [{ price: '0.57', size: '12' }] };
const BOOK_DN = { event_type: 'book', asset_id: 'DN', bids: [{ price: '0.43', size: '8' }], asks: [{ price: '0.45', size: '9' }] };

let trades: any[];
let events: string[];
let sock: ClobTapeSocket;
const last = () => sockets[sockets.length - 1];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 8, 24, 3, 0, 0));
  sockets.length = 0;
  trades = [];
  events = [];
  sock = new ClobTapeSocket({ onTrade: t => trades.push(t), onEvent: ev => events.push(ev) });
});
afterEach(() => {
  sock.stop();
  vi.useRealTimers();
});

function liveOn(up = 'UP', dn = 'DN') {
  sock.setTokens(up, dn);
  sock.start();
  last().accept();
  last().deliver([BOOK_UP, BOOK_DN]); // the initial snapshot arrives as an array
}

describe('ClobTapeSocket', () => {
  test('does not connect until it knows the tokens, then subscribes to both', () => {
    sock.start();
    expect(sockets).toHaveLength(0);
    sock.setTokens('UP', 'DN');
    last().accept();
    expect(JSON.parse(last().sent[0])).toEqual({ assets_ids: ['UP', 'DN'], type: 'market' });
    expect(events).toContain('subscribed');
  });

  test('builds both books from an array-shaped initial snapshot', () => {
    liveOn();
    expect(sock.live).toBe(true);
    expect(sock.up.top(5)).toEqual({ b: [[0.55, 10]], a: [[0.57, 12]] });
    expect(sock.down.bestAsk()).toBe(0.45);
  });

  test('applies price_change levels; a change that agrees with the server top does not resync', () => {
    liveOn();
    last().deliver({
      event_type: 'price_change',
      price_changes: [{ asset_id: 'UP', side: 'BUY', price: '0.56', size: '5', best_bid: '0.56', best_ask: '0.57' }],
    });
    expect(sock.up.bestBid()).toBe(0.56);
    expect(sock.resyncs).toBe(0);
    expect(sockets).toHaveLength(1);
  });

  test('a book that disagrees with the server top is re-fetched, at most once per 30s', () => {
    liveOn();
    const wrong = { event_type: 'price_change', price_changes: [{ asset_id: 'UP', side: 'BUY', price: '0.30', size: '1', best_bid: '0.56', best_ask: '0.57' }] };
    last().deliver(wrong);
    expect(sock.resyncs).toBe(1);
    expect(sockets).toHaveLength(2); // reopened for a fresh snapshot
    expect(sock.up.valid).toBe(false);
    last().accept();
    last().deliver([BOOK_UP, BOOK_DN]);
    last().deliver(wrong);
    expect(sock.resyncs).toBe(1); // rate-limited
    vi.advanceTimersByTime(31_000);
    last().deliver(wrong);
    expect(sock.resyncs).toBe(2);
  });

  test('reports trade prints for the followed tokens only', () => {
    liveOn();
    last().deliver({ event_type: 'last_trade_price', asset_id: 'DN', price: '0.44', size: '25', side: 'BUY', timestamp: '1790000000000' });
    last().deliver({ event_type: 'last_trade_price', asset_id: 'OTHER', price: '0.9', size: '1' });
    expect(trades).toEqual([{ side: 'd', price: 0.44, size: 25, orderSide: 'BUY', serverTs: 1790000000000, recvMs: Date.now() }]);
  });

  test('a market switch drops the old book and resubscribes on a new socket', () => {
    liveOn();
    const old = last();
    sock.setTokens('UP2', 'DN2');
    expect(old.readyState).toBe(3);
    expect(sock.up.valid).toBe(false);
    last().accept();
    expect(JSON.parse(last().sent[0]).assets_ids).toEqual(['UP2', 'DN2']);
    old.deliver(BOOK_UP); // late frame from the closed socket
    expect(sock.up.valid).toBe(false);
  });

  test('silence and closes reconnect with a growing backoff; a full book resets it', () => {
    liveOn();
    vi.advanceTimersByTime(35_000); // no frames (pings go unanswered)
    expect(events).toContain('silent');
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1_000);
    expect(sockets).toHaveLength(2); // first retry after 1s
    last().close();
    vi.advanceTimersByTime(1_999);
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(3); // second retry after 2s
  });

  test('subscribed but no book within 15s → reopen', () => {
    sock.setTokens('UP', 'DN');
    sock.start();
    last().accept();
    last().emit('message', 'PONG');
    vi.advanceTimersByTime(20_000);
    expect(events).toContain('no_book');
  });

  test('a handshake that never completes is abandoned after 20s (ws has no connect timeout)', () => {
    sock.setTokens('UP', 'DN');
    sock.start();
    expect(sockets).toHaveLength(1); // stays CONNECTING: no open, close or error ever fires
    vi.advanceTimersByTime(25_000);
    expect(events).toContain('connect_timeout');
    vi.advanceTimersByTime(1_000);
    expect(sockets).toHaveLength(2);
  });

  test('garbage frames are ignored', () => {
    liveOn();
    expect(() => last().emit('message', '{not json')).not.toThrow();
    expect(() => last().deliver({ event_type: 'price_change', price_changes: 'x' })).not.toThrow();
    expect(() => last().deliver(null)).not.toThrow();
    expect(sock.up.valid).toBe(true);
  });
});
