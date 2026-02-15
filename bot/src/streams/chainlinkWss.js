/**
 * Chainlink Direct WSS stream for Node.js bot.
 * Real-time BTC/USD price via Polygon WebSocket RPC.
 * Ported from useChainlinkWssStream.js — same protocol, no React.
 */

import { WebSocket } from 'ws';
import { CONFIG, WS_CHAINLINK, WS_DEFAULTS } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('ChainlinkWSS');

const WS_URLS = CONFIG.chainlink?.polygonWssUrls || ['wss://polygon-bor-rpc.publicnode.com'];
const PING_MS = WS_CHAINLINK.pingMs;                     // 15s
const HEARTBEAT_DEAD_MS = WS_CHAINLINK.heartbeatDeadMs;  // 45s
const HEARTBEAT_CHECK_MS = WS_DEFAULTS.heartbeatCheckMs;  // 10s
const RECONNECT_MAX_MS = WS_DEFAULTS.reconnectMaxMs;      // 10s

let ws = null;
let reconnectTimer = null;
let reconnectMs = 1000;
let pingTimer = null;
let hbTimer = null;
let lastMsgMs = 0;
let urlIdx = 0;
let intentionalClose = false; // H4: Prevent zombie reconnect on shutdown

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
  // Rotate to next URL on reconnect
  urlIdx = (urlIdx + 1) % WS_URLS.length;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, reconnectMs);
  reconnectMs = Math.min(RECONNECT_MAX_MS, reconnectMs * 2);
}

export function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  intentionalClose = false; // L: Reset before attempt — prevents stuck flag after disconnect+failed connect

  const url = WS_URLS[urlIdx];
  if (!url) return;

  try {
    const socket = new WebSocket(url);
    ws = socket;

    socket.on('open', () => {
      // Stale socket guard
      if (ws !== socket) { try { socket.close(); } catch {} return; }

      log.info(`Connected to ${url}`);
      _connected = true;
      reconnectMs = 1000;
      lastMsgMs = Date.now();

      // Ping every 15s (use module-level ws, not local socket, to survive reconnect race)
      stopPing();
      pingTimer = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          try { ws.send(JSON.stringify({ type: 'ping' })); } catch {}
        }
      }, PING_MS);

      // Heartbeat: 45s dead timeout
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

      // Subscribe to BTC/USD feed
      try {
        socket.send(JSON.stringify({ type: 'subscribe', feed: 'BTC/USD' }));
      } catch {}
    });

    socket.on('message', (raw) => {
      lastMsgMs = Date.now();
      try {
        const str = typeof raw === 'string' ? raw : raw.toString();
        const data = JSON.parse(str);
        let p = null;

        // Multiple possible formats from different Polygon WSS providers
        if (data.answer !== undefined) {
          p = Number(data.answer);
          // W6: Default decimals to 8 (Chainlink standard) — without this,
          // a provider returning raw answer (e.g. 5000000000000) without decimals
          // field would be treated as a valid price of 5 trillion
          const decimals = Number(data.decimals ?? 8);
          p = p / Math.pow(10, decimals);
        } else if (data.price !== undefined) {
          p = Number(data.price);
        } else if (data.result !== undefined) {
          p = Number(data.result);
        } else if (data.data?.price !== undefined) {
          p = Number(data.data.price);
        } else if (data.params?.result?.answer !== undefined) {
          p = Number(BigInt(data.params.result.answer)) / 1e8;
        }

        // M12: BTC price range validation — reject obviously wrong values
        if (p !== null && Number.isFinite(p) && p > 10_000 && p < 500_000) {
          _prevPrice = _price;
          _price = p;
          _lastUpdate = Date.now();
        }
      } catch {}
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

    socket.on('error', () => {
      try { socket.close(); } catch {}
    });
  } catch {
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
