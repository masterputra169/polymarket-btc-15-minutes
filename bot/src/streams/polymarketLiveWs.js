/**
 * Polymarket LiveData WebSocket stream for Node.js bot.
 * Real-time Chainlink BTC/USD price via Polymarket's LiveData feed.
 * Ported from usePolymarketChainlinkStream.js — same protocol, no React.
 */

import { WebSocket } from 'ws';
import { CONFIG, WS_POLYMARKET_LIVE, WS_DEFAULTS } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('PolyLiveWS');

const WS_URL = CONFIG.polymarket?.liveDataWsUrl || 'wss://ws-live-data.polymarket.com';
const PING_MS = WS_POLYMARKET_LIVE.pingMs;               // 15s
const HEARTBEAT_DEAD_MS = WS_POLYMARKET_LIVE.heartbeatDeadMs; // 30s
const HEARTBEAT_CHECK_MS = WS_DEFAULTS.heartbeatCheckMs;  // 10s
const RECONNECT_MAX_MS = WS_DEFAULTS.reconnectMaxMs;      // 10s

let ws = null;
let reconnectTimer = null;
let reconnectMs = 500;
let pingTimer = null;
let hbTimer = null;
let lastMsgMs = 0;
let intentionalClose = false; // H4: Prevent zombie reconnect on shutdown
let _parseErrors = 0;

// Public state — read by loop.js
let _price = null;
let _prevPrice = null;
let _connected = false;
let _lastUpdate = 0;

export function getPrice() { return _price; }
export function getPrevPrice() { return _prevPrice; }
export function isConnected() { return _connected; }
export function getLastUpdate() { return _lastUpdate; }

function stopPing() { if (pingTimer) { clearInterval(pingTimer); pingTimer = null; } }
function stopHb() { if (hbTimer) { clearInterval(hbTimer); hbTimer = null; } }
function stopTimers() { stopPing(); stopHb(); }

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

      // Ping every 15s (use module-level ws, not local socket, to survive reconnect race)
      stopPing();
      pingTimer = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          try { ws.send(JSON.stringify({ action: 'ping' })); } catch {}
        }
      }, PING_MS);

      // Heartbeat: 30s dead timeout
      stopHb();
      hbTimer = setInterval(() => {
        if (Date.now() - lastMsgMs > HEARTBEAT_DEAD_MS) {
          log.warn('Silent — forcing reconnect');
          if (ws === socket) { ws = null; _connected = false; }
          stopTimers();
          try { socket.close(); } catch {}
          scheduleReconnect();
        }
      }, HEARTBEAT_CHECK_MS);

      // Subscribe to Chainlink crypto prices
      try {
        socket.send(JSON.stringify({
          action: 'subscribe',
          subscriptions: [{ topic: 'crypto_prices_chainlink', type: '*', filters: '' }],
        }));
      } catch (subErr) {
        log.warn(`Subscribe failed: ${subErr.message}`);
      }
    });

    socket.on('message', (raw) => {
      lastMsgMs = Date.now();
      try {
        const str = typeof raw === 'string' ? raw : raw.toString();
        const data = JSON.parse(str);

        if (!data || data.topic !== 'crypto_prices_chainlink') return;

        const payload = typeof data.payload === 'string' ? JSON.parse(data.payload) : data.payload || {};
        const sym = String(payload.symbol || payload.pair || payload.ticker || '').toLowerCase();
        if (!sym.startsWith('btc') && !sym.includes('/btc') && !sym.includes('_btc')) return;

        const p = Number(payload.value ?? payload.price ?? payload.current ?? payload.data);
        if (!Number.isFinite(p) || p <= 0) return;

        _prevPrice = _price;
        _price = p;
        _lastUpdate = Date.now();
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
        stopTimers();
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
    if (!intentionalClose) scheduleReconnect();
  }
}

export function disconnect() {
  intentionalClose = true; // H4: Signal to close handler not to reconnect
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  stopTimers();
  if (ws) { try { ws.close(); } catch {} ws = null; }
  _connected = false;
}
