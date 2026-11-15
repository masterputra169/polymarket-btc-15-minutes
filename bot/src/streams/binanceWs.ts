/**
 * Binance WebSocket stream for Node.js bot.
 * Real-time BTC price via miniTicker — ~100ms latency vs 5s REST poll.
 * Uses native WebSocket (Node 22+).
 */

import { WebSocket } from 'ws';
import { createLogger } from '../logger.ts';

const log = createLogger('BinanceWS');

// stream.binance.com blocked in some regions — vision domain works
const WS_URL = 'wss://data-stream.binance.vision/ws/btcusdt@miniTicker';
const HEARTBEAT_DEAD_MS = 20_000;
const HEARTBEAT_CHECK_MS = 5_000;
const RECONNECT_MAX_MS = 10_000;

let ws = null;
let reconnectTimer = null;
let reconnectMs = 500;
let hbTimer = null;
let lastMsgMs = 0;
let intentionalClose = false; // H4: Prevent zombie reconnect on shutdown
let _parseErrors = 0;

// Public state — read by loop.js
let _price = null;
let _prevPrice = null;
let _connected = false;

const TICK_BUFFER_KEEP_MS = 15_000;
const _recentTicks: Array<{ t: number; p: number }> = [];

export interface BinancePriceWindow {
  deltaUsd: number;
  deltaPct: number;
  tickCount: number;
  oldestPrice: number | null;
  latestPrice: number | null;
  windowSpanMs: number;
}

function pushPriceTick(price: number, ts: number) {
  _recentTicks.push({ t: ts, p: price });
  const cutoff = ts - TICK_BUFFER_KEEP_MS;
  while (_recentTicks.length > 1 && _recentTicks[0].t < cutoff) {
    _recentTicks.shift();
  }
}

export function getPrice() { return _price; }
export function getPrevPrice() { return _prevPrice; }
export function isConnected() { return _connected; }
/** Audit fix H: Expose last message timestamp for staleness check in loop.js */
export function getLastMsgTime() { return lastMsgMs; }

/**
 * Compute BTC price delta over a short millisecond lookback (default 3s) from live WS ticks.
 * Used by leadLagImpulse detection in signalComputation.ts.
 */
export function getRecentPriceWindow(windowMs = 3_000, now = Date.now()): BinancePriceWindow {
  const cutoff = now - windowMs;
  const slice = _recentTicks.filter((pt) => pt.t >= cutoff && pt.t <= now + 500);
  if (slice.length < 2) {
    const only = slice[slice.length - 1] ?? null;
    return {
      deltaUsd: 0,
      deltaPct: 0,
      tickCount: slice.length,
      oldestPrice: only?.p ?? null,
      latestPrice: only?.p ?? null,
      windowSpanMs: 0,
    };
  }
  const oldest = slice[0];
  const latest = slice[slice.length - 1];
  const deltaUsd = latest.p - oldest.p;
  const deltaPct = oldest.p > 0 ? (deltaUsd / oldest.p) * 100 : 0;
  return {
    deltaUsd,
    deltaPct,
    tickCount: slice.length,
    oldestPrice: oldest.p,
    latestPrice: latest.p,
    windowSpanMs: Math.max(0, latest.t - oldest.t),
  };
}

/** Deterministic helpers for unit tests. */
export function recordBinanceTickForTest(price: number, ts = Date.now()): void {
  if (Number.isFinite(price) && price > 0) {
    pushPriceTick(price, ts);
  }
}

export function clearBinanceTicksForTest(): void {
  _recentTicks.length = 0;
}

function stopHb() {
  if (hbTimer) { clearInterval(hbTimer); hbTimer = null; }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, reconnectMs);
  reconnectMs = Math.min(RECONNECT_MAX_MS, reconnectMs * 2);
}

export function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  intentionalClose = false; // L: Reset before attempt — prevents stuck flag after disconnect+failed connect

  try {
    const socket = new WebSocket(WS_URL);
    ws = socket;

    socket.on('open', () => {
      // Stale socket guard
      if (ws !== socket) { try { socket.close(); } catch {} return; }

      log.info('Connected');
      _connected = true;
      reconnectMs = 500;
      lastMsgMs = Date.now();

      stopHb();
      hbTimer = setInterval(() => {
        if (Date.now() - lastMsgMs > HEARTBEAT_DEAD_MS) {
          log.warn('Silent — forcing reconnect');
          if (ws === socket) { ws = null; _connected = false; }
          stopHb();
          try { socket.close(); } catch {}
          scheduleReconnect();
        }
      }, HEARTBEAT_CHECK_MS);
    });

    socket.on('message', (raw) => {
      lastMsgMs = Date.now();
      try {
        const data = JSON.parse(raw);
        const p = Number(data.c);
        if (Number.isFinite(p) && p > 10_000 && p < 500_000) {
          _prevPrice = _price;
          _price = p;
          pushPriceTick(p, lastMsgMs);
        }
      } catch (err) {
        _parseErrors++;
        if (_parseErrors === 1 || _parseErrors % 500 === 0) log.debug(`WS parse error #${_parseErrors}: ${err.message}`);
      }
    });

    socket.on('close', () => {
      if (ws === socket) {
        log.debug('Disconnected');
        _connected = false;
        ws = null;
        stopHb();
      }
      // H4: Don't reconnect if disconnect() was called intentionally
      if (!intentionalClose) scheduleReconnect();
    });

    socket.on('error', (err) => {
      log.debug(`WS error: ${err?.message || err}`);
      try { socket.close(); } catch {}
    });
  } catch (connErr) {
    log.debug(`Connect failed: ${connErr?.message || connErr}`);
    scheduleReconnect();
  }
}

export function disconnect() {
  intentionalClose = true; // H4: Signal to close handler not to reconnect
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  stopHb();
  if (ws) { try { ws.close(); } catch {} ws = null; }
  _connected = false;
}
