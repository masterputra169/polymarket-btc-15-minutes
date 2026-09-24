/**
 * The recorder's own connection to the Polymarket CLOB market channel.
 *
 * Separate from streams/clobWs.ts on purpose: that socket prices trades, and
 * nothing the recorder does — reconnecting, resyncing, falling over — may reach
 * it. The cost is one extra read-only subscription to a public channel.
 *
 * It keeps the full L2 book for both tokens (clobWs keeps only a summary) and
 * reports every trade print. A market switch reopens the socket; the ~1s gap at
 * the start of a window is before any training row (those start 60s in).
 *
 * Self-checks: `price_change` frames carry the server's best bid/ask after the
 * change. Levels the server says cannot exist (consumed by a marketable order,
 * which reports no change for them) are pruned locally — no reconnect. Only a
 * disagreement pruning cannot fix, and that no `book` frame clears within
 * DISAGREE_RESYNC_MS, reopens the socket, at most once per RESYNC_MIN_GAP_MS.
 */

import { WebSocket } from 'ws';
import { BookState } from './bookState.ts';

export const DEFAULT_CLOB_WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

const PING_MS = 10_000;
const CHECK_MS = 5_000;
/** No frame at all (not even PONG) for this long → the link is dead. */
const SILENT_MS = 30_000;
/** Subscribed but no book for this long → reopen. */
const NO_BOOK_MS = 15_000;
/** Still CONNECTING after this long → give up on the handshake (ws has no connect timeout of its own). */
const CONNECT_TIMEOUT_MS = 20_000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
/** A disagreement pruning cannot fix must outlive this before a reopen (`book` frames arrive ~1/s). */
const DISAGREE_RESYNC_MS = 60_000;
const RESYNC_MIN_GAP_MS = 300_000;

export interface TradeEvent {
  side: 'u' | 'd';
  price: number;
  size: number | null;
  orderSide: string | null;
  serverTs: number | null;
  recvMs: number;
}

export interface TapeSocketOpts {
  url?: string;
  onTrade: (t: TradeEvent) => void;
  onEvent: (ev: string, note?: string) => void;
  now?: () => number;
}

type WsLike = {
  readyState: number;
  on(ev: string, fn: (...a: any[]) => void): unknown;
  send(data: string): void;
  close(): void;
};

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

/**
 * A server best price is information only strictly inside (0, 1). An empty
 * side comes through as a boundary marker — seen on Railway 2026-09-24 near
 * resolution, UP at 0.99 with no asks: read as a price it kept the book
 * "disagreeing" until a resync. Unknown means: no prune, no disagreement.
 */
function inside(x: number | null): number | null {
  return x !== null && x > 0 && x < 1 ? x : null;
}

/** Does the book's best price agree with a server best price (null = server gave none)? */
function agrees(mine: number | null, server: number | null): boolean {
  if (server === null) return true;
  return mine !== null && Math.abs(mine - server) < 1e-9;
}

export class ClobTapeSocket {
  readonly up = new BookState();
  readonly down = new BookState();
  private ws: WsLike | null = null;
  private tokens: { up: string; down: string } | null = null;
  private stopped = true;
  private backoffMs = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private checkTimer: ReturnType<typeof setInterval> | null = null;
  private lastFrameMs = 0;
  private openedMs = 0;
  private subscribedMs = 0;
  private lastResyncMs = 0;
  private readonly url: string;
  private readonly now: () => number;
  /** When each book started disagreeing with the server in a way pruning could not fix. */
  private disagreeSince = new Map<BookState, number>();
  connected = false;
  resyncs = 0;
  /** Levels pruned because the server's best bid/ask ruled them out. */
  repairs = 0;
  // Not a parameter property: Node runs this file with type stripping, which rejects them.
  private readonly opts: TapeSocketOpts;

  constructor(opts: TapeSocketOpts) {
    this.opts = opts;
    this.url = opts.url ?? DEFAULT_CLOB_WS_URL;
    this.now = opts.now ?? Date.now;
  }

  /** Link up, subscribed, and heard from recently. */
  get live(): boolean {
    return this.connected && this.subscribedMs > 0 && this.now() - this.lastFrameMs < SILENT_MS;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.pingTimer = setInterval(() => this.ping(), PING_MS);
    this.checkTimer = setInterval(() => this.check(), CHECK_MS);
    this.pingTimer.unref?.();
    this.checkTimer.unref?.();
    if (this.tokens) this.open();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.checkTimer) clearInterval(this.checkTimer);
    this.reconnectTimer = this.pingTimer = this.checkTimer = null;
    this.drop();
  }

  setTokens(up: string, down: string): void {
    if (this.tokens?.up === up && this.tokens?.down === down) return;
    this.tokens = { up, down };
    this.up.clear();
    this.down.clear();
    this.disagreeSince.clear();
    this.backoffMs = 0;
    if (!this.stopped) this.reopen();
  }

  private ping(): void {
    const s = this.ws;
    if (s && s.readyState === WebSocket.OPEN) {
      try { s.send('PING'); } catch { /* close handler takes it from here */ }
    }
  }

  private check(): void {
    if (this.stopped || !this.ws) return;
    const now = this.now();
    if (!this.connected) {
      if (now - this.openedMs > CONNECT_TIMEOUT_MS) {
        this.opts.onEvent('connect_timeout');
        this.reconnectLater();
      }
      return;
    }
    if (now - this.lastFrameMs > SILENT_MS) {
      this.opts.onEvent('silent');
      this.reconnectLater();
    } else if (this.subscribedMs > 0 && !(this.up.valid && this.down.valid) && now - this.subscribedMs > NO_BOOK_MS) {
      this.opts.onEvent('no_book');
      this.reconnectLater();
    } else {
      for (const since of this.disagreeSince.values()) {
        if (now - since > DISAGREE_RESYNC_MS) { this.resync(); break; }
      }
    }
  }

  /** Close the current socket so its handlers go inert. */
  private drop(): void {
    const s = this.ws;
    this.ws = null;
    this.connected = false;
    this.subscribedMs = 0;
    if (s) { try { s.close(); } catch { /* already gone */ } }
  }

  private reopen(): void {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.drop();
    this.open();
  }

  private reconnectLater(): void {
    this.drop();
    if (this.stopped || this.reconnectTimer) return;
    this.backoffMs = this.backoffMs ? Math.min(BACKOFF_MAX_MS, this.backoffMs * 2) : BACKOFF_MIN_MS;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, this.backoffMs);
    this.reconnectTimer.unref?.();
  }

  private open(): void {
    if (this.stopped || !this.tokens) return;
    let socket: WsLike;
    try {
      socket = new WebSocket(this.url) as unknown as WsLike;
    } catch (err) {
      this.opts.onEvent('open_failed', (err as Error)?.message);
      this.reconnectLater();
      return;
    }
    this.ws = socket;
    this.openedMs = this.now();
    const tokens = this.tokens;

    socket.on('open', () => {
      if (this.ws !== socket) return;
      this.connected = true;
      this.lastFrameMs = this.now();
      try {
        socket.send(JSON.stringify({ assets_ids: [tokens.up, tokens.down], type: 'market' }));
        this.subscribedMs = this.now();
        this.opts.onEvent('subscribed');
      } catch (err) {
        this.opts.onEvent('subscribe_failed', (err as Error)?.message);
        this.reconnectLater();
      }
    });

    socket.on('message', (raw: unknown) => {
      if (this.ws !== socket) return;
      this.lastFrameMs = this.now();
      let text: string;
      try { text = typeof raw === 'string' ? raw : String(raw); } catch { return; }
      if (text === 'PONG' || text === '') return;
      let msg: unknown;
      try { msg = JSON.parse(text); } catch { return; }
      for (const ev of Array.isArray(msg) ? msg : [msg]) this.handle(ev);
    });

    socket.on('close', () => {
      if (this.ws !== socket) return;
      this.opts.onEvent('closed');
      this.reconnectLater();
    });

    socket.on('error', (err: unknown) => {
      if (this.ws !== socket) return;
      this.opts.onEvent('error', (err as Error)?.message);
      try { socket.close(); } catch { /* close handler reconnects */ }
    });
  }

  private bookFor(assetId: unknown): { book: BookState; side: 'u' | 'd' } | null {
    if (!this.tokens) return null;
    if (assetId === this.tokens.up) return { book: this.up, side: 'u' };
    if (assetId === this.tokens.down) return { book: this.down, side: 'd' };
    return null;
  }

  private handle(ev: any): void {
    if (!ev || typeof ev !== 'object') return;
    const now = this.now();
    switch (ev.event_type) {
      case 'book': {
        const target = this.bookFor(ev.asset_id);
        if (!target) return;
        target.book.applySnapshot(ev.bids, ev.asks, now);
        this.disagreeSince.delete(target.book);
        if (this.up.valid && this.down.valid) this.backoffMs = 0;
        return;
      }
      case 'price_change': {
        // Current shape: price_changes[] each with its own asset_id and the
        // server's best bid/ask after the change. Older shape: one asset_id
        // and changes[] without best prices.
        const changes: any[] = Array.isArray(ev.price_changes)
          ? ev.price_changes
          : Array.isArray(ev.changes) ? ev.changes.map((c: any) => ({ ...c, asset_id: ev.asset_id })) : [];
        const lastServerTop = new Map<BookState, { bid: number | null; ask: number | null }>();
        for (const c of changes) {
          const target = this.bookFor(c?.asset_id);
          if (!target) continue;
          target.book.applyChange(c.side, c.price, c.size, now);
          if (c.best_bid !== undefined || c.best_ask !== undefined) {
            lastServerTop.set(target.book, { bid: inside(num(c.best_bid)), ask: inside(num(c.best_ask)) });
          }
        }
        for (const [book, top] of lastServerTop) {
          if (!book.valid) continue;
          this.repairs += book.prune(top.bid, top.ask, now);
          if (agrees(book.bestBid(), top.bid) && agrees(book.bestAsk(), top.ask)) this.disagreeSince.delete(book);
          else if (!this.disagreeSince.has(book)) this.disagreeSince.set(book, now);
        }
        return;
      }
      case 'last_trade_price': {
        const target = this.bookFor(ev.asset_id);
        const price = num(ev.price);
        if (!target || price === null) return;
        const ts = num(ev.timestamp);
        this.opts.onTrade({
          side: target.side,
          price,
          size: num(ev.size),
          orderSide: typeof ev.side === 'string' ? ev.side : null,
          serverTs: ts,
          recvMs: now,
        });
        return;
      }
      default:
        return;
    }
  }

  /** The rebuilt book disagrees with the server: fetch a fresh snapshot. */
  private resync(): void {
    const now = this.now();
    if (now - this.lastResyncMs < RESYNC_MIN_GAP_MS) return;
    this.lastResyncMs = now;
    this.resyncs++;
    this.opts.onEvent('resync', 'book disagreed with server best bid/ask for 60s');
    this.up.clear();
    this.down.clear();
    this.disagreeSince.clear();
    this.reopen();
  }
}
