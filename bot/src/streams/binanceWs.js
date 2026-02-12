/**
 * Binance WebSocket stream for Node.js bot.
 * Real-time BTC price via miniTicker — ~100ms latency vs 5s REST poll.
 * Uses native WebSocket (Node 22+).
 */

import { WebSocket } from 'ws';
import { createLogger } from '../logger.js';

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

// Public state — read by loop.js
let _price = null;
let _prevPrice = null;
let _connected = false;

export function getPrice() { return _price; }
export function getPrevPrice() { return _prevPrice; }
export function isConnected() { return _connected; }

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

  try {
    ws = new WebSocket(WS_URL);

    ws.on('open', () => {
      log.info('Connected');
      _connected = true;
      reconnectMs = 500;
      lastMsgMs = Date.now();

      stopHb();
      hbTimer = setInterval(() => {
        if (Date.now() - lastMsgMs > HEARTBEAT_DEAD_MS) {
          log.warn('Silent — forcing reconnect');
          try { ws.close(); } catch {}
        }
      }, HEARTBEAT_CHECK_MS);
    });

    ws.on('message', (raw) => {
      lastMsgMs = Date.now();
      try {
        const data = JSON.parse(raw);
        const p = Number(data.c);
        if (Number.isFinite(p) && p > 0) {
          _prevPrice = _price;
          _price = p;
        }
      } catch {}
    });

    ws.on('close', () => {
      log.debug('Disconnected');
      _connected = false;
      ws = null;
      stopHb();
      scheduleReconnect();
    });

    ws.on('error', () => {
      try { ws.close(); } catch {}
    });
  } catch {
    scheduleReconnect();
  }
}

export function disconnect() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  stopHb();
  if (ws) { try { ws.close(); } catch {} ws = null; }
  _connected = false;
}
