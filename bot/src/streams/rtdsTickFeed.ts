/**
 * One Polymarket RTDS price topic, kept as timestamped ticks.
 *
 * Used for `crypto_prices_twap_sixty` — Chainlink's BTC/USD 60-second TWAP, the
 * series these markets settle on since 2026-08-07: the price to beat is the TWAP
 * stamped exactly at the window's first second, the final price the one stamped
 * at its last. A socket of its own, so this topic being retired (RTDS price
 * topics are deprecated, removal expected ~2026-10-23) or misbehaving cannot
 * silence the spot feed in polymarketLiveWs.ts.
 *
 * Protocol details that cost other people time (see docs/RAILWAY.md history):
 *  - the filter must be exactly `{"symbol":"btc/usd"}` — with a space the server
 *    sends the replay and then nothing, forever;
 *  - one unknown topic in a subscribe array silences every topic in it, so this
 *    subscribes to exactly one;
 *  - a subscribe replays about the last 60 s, which is how a missed tick (about
 *    3% of seconds never arrive live) can be recovered: replay() reconnects;
 *  - the socket can stall while staying open, so silence is judged on ticks,
 *    not on the connection.
 *
 * Every public call is total: a bad frame is counted, never thrown.
 */

import { WebSocket } from 'ws';
import { CONFIG } from '../config.ts';
import { createLogger } from '../logger.ts';
import { TickStore, type Tick } from './tickStore.ts';

export interface RtdsTickFeedHealth {
  connected: boolean;
  ticks: number;
  lastTick: Tick | null;
  /** Local ms of the last live tick received. */
  lastTickRecvMs: number;
  reconnects: number;
  parseErrors: number;
}

export interface RtdsTickFeed {
  start(): void;
  stop(): void;
  /** Reconnect now, so the server's replay can fill a missed second. Rate-limited. */
  replay(reason: string): void;
  at(ts: number): number | null;
  latest(): Tick | null;
  between(from: number, to: number): Tick[];
  health(): RtdsTickFeedHealth;
}

export interface RtdsTickFeedOptions {
  topic: string;
  symbol?: string;
  keepMs?: number;
  url?: string;
  now?: () => number;
  /** Test seam: builds the socket. */
  makeSocket?: (url: string) => WebSocket;
}

const PING_MS = 5_000;
const STALL_MS = 15_000;
const RECONNECT_MAX_MS = 10_000;
const REPLAY_MIN_GAP_MS = 20_000;

/** Parse one RTDS frame into ticks for `symbol`; null when the frame is not JSON. Exported for tests. */
export function parseRtdsFrame(raw: string, topic: string, symbol: string): Tick[] | null {
  let msg: any;
  try { msg = JSON.parse(raw); } catch { return null; }
  if (!msg || typeof msg !== 'object') return [];
  if (msg.topic && msg.topic !== topic) return [];
  let p = msg.payload;
  if (typeof p === 'string') { try { p = JSON.parse(p); } catch { return []; } }
  if (!p || typeof p !== 'object') return [];
  const sym = p.symbol != null ? String(p.symbol).toLowerCase() : null;
  if (sym && sym !== symbol) return [];
  const rows: any[] = Array.isArray(p.data) ? p.data : [p];
  const out: Tick[] = [];
  for (const r of rows) {
    const ts = Number(r?.timestamp);
    const value = Number(r?.value);
    if (Number.isFinite(ts) && ts > 0 && Number.isFinite(value) && value > 0) out.push({ ts, value });
  }
  return out;
}

export function createRtdsTickFeed(opts: RtdsTickFeedOptions): RtdsTickFeed {
  const topic = opts.topic;
  const symbol = (opts.symbol ?? 'btc/usd').toLowerCase();
  const url = opts.url ?? CONFIG.polymarket?.liveDataWsUrl ?? 'wss://ws-live-data.polymarket.com';
  const now = opts.now ?? Date.now;
  const makeSocket = opts.makeSocket ?? ((u: string) => new WebSocket(u));
  const log = createLogger(`RTDS:${topic}`);
  const store = new TickStore(opts.keepMs ?? 20 * 60_000);

  let ws: WebSocket | null = null;
  let running = false;
  let connected = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectMs = 500;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let stallTimer: ReturnType<typeof setInterval> | null = null;
  let lastTickRecvMs = 0;
  let reconnects = 0;
  let parseErrors = 0;
  let lastReplayMs = 0;
  let stallStreak = 0;

  const clearTimers = () => {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    if (stallTimer) { clearInterval(stallTimer); stallTimer = null; }
  };

  const drop = (socket: WebSocket | null) => {
    if (!socket) return;
    try { socket.removeAllListeners(); } catch { /* already gone */ }
    try { socket.terminate(); } catch { /* already gone */ }
  };

  const scheduleReconnect = () => {
    if (!running || reconnectTimer) return;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; open(); }, reconnectMs);
    reconnectTimer.unref?.();
    reconnectMs = Math.min(RECONNECT_MAX_MS, reconnectMs * 2);
  };

  function open(): void {
    if (!running) return;
    let socket: WebSocket;
    try {
      socket = makeSocket(url);
    } catch (err) {
      log.debug(`connect failed: ${(err as Error)?.message ?? err}`);
      scheduleReconnect();
      return;
    }
    ws = socket;
    socket.on('open', () => {
      if (ws !== socket) return;
      connected = true;
      reconnectMs = 500;
      try {
        socket.send(JSON.stringify({
          action: 'subscribe',
          subscriptions: [{ topic, type: '*', filters: JSON.stringify({ symbol }) }],
        }));
      } catch (err) {
        log.warn(`subscribe failed: ${(err as Error)?.message ?? err}`);
      }
      clearTimers();
      pingTimer = setInterval(() => { try { socket.send('PING'); } catch { /* reconnect handles it */ } }, PING_MS);
      pingTimer.unref?.();
      const openedAt = now();
      stallTimer = setInterval(() => {
        const last = Math.max(lastTickRecvMs, openedAt);
        if (now() - last > STALL_MS) {
          stallStreak++;
          if (stallStreak <= 3) {
            log.warn(`no tick for ${Math.round((now() - last) / 1000)}s — reconnecting`);
            reconnect();
          } else {
            // Silent across reconnects: the topic may have been retired. Back off
            // (up to 5 min) instead of reconnecting every 15 s forever.
            const waitMs = Math.min(5 * 60_000, STALL_MS * 2 ** (stallStreak - 3));
            if (stallStreak === 4) log.error(`${topic}: no ticks across 3 reconnects — topic retired or blocked? retrying with backoff; the PTB falls back to the crypto-price API`);
            const old = ws;
            ws = null;
            connected = false;
            clearTimers();
            drop(old);
            if (!reconnectTimer && running) {
              reconnectTimer = setTimeout(() => { reconnectTimer = null; reconnects++; open(); }, waitMs);
              reconnectTimer.unref?.();
            }
          }
        }
      }, 5_000);
      stallTimer.unref?.();
    });
    socket.on('message', (raw) => {
      if (ws !== socket) return;
      const text = typeof raw === 'string' ? raw : raw.toString();
      if (text === 'PONG' || text === '') return;
      const ticks = parseRtdsFrame(text, topic, symbol);
      if (ticks == null) { parseErrors++; return; }
      if (!ticks.length) return; // acks, other symbols
      for (const t of ticks) store.add(t.ts, t.value);
      lastTickRecvMs = now();
      stallStreak = 0;
    });
    socket.on('close', () => {
      if (ws !== socket) return;
      connected = false;
      ws = null;
      clearTimers();
      scheduleReconnect();
    });
    socket.on('error', (err) => {
      log.debug(`socket error: ${(err as Error)?.message ?? err}`);
      try { socket.close(); } catch { /* close handler reconnects */ }
    });
  }

  function reconnect(): void {
    const old = ws;
    ws = null;
    connected = false;
    clearTimers();
    drop(old);
    reconnects++;
    open();
  }

  return {
    start() {
      if (running) return;
      running = true;
      open();
      log.info(`subscribing to ${topic} (${symbol})`);
    },
    stop() {
      running = false;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      clearTimers();
      drop(ws);
      ws = null;
      connected = false;
    },
    replay(reason: string) {
      if (!running) return;
      const t = now();
      if (t - lastReplayMs < REPLAY_MIN_GAP_MS) return;
      lastReplayMs = t;
      log.info(`replay requested (${reason})`);
      reconnect();
    },
    at: (ts) => store.at(ts),
    latest: () => store.latest(),
    between: (from, to) => store.between(from, to),
    health: () => ({
      connected, ticks: store.size, lastTick: store.latest(), lastTickRecvMs, reconnects, parseErrors,
    }),
  };
}
