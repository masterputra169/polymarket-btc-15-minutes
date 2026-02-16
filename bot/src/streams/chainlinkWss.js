/**
 * Chainlink Direct WSS stream for Node.js bot.
 * Real-time BTC/USD price via Polygon WebSocket RPC (JSON-RPC 2.0).
 * Uses eth_call with latestRoundData() selector over WSS every 15s.
 */

import { WebSocket } from 'ws';
import { CONFIG, WS_CHAINLINK, WS_DEFAULTS } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('ChainlinkWSS');

const WS_URLS = CONFIG.chainlink?.polygonWssUrls || ['wss://polygon-bor-rpc.publicnode.com'];
const AGGREGATOR = CONFIG.chainlink?.btcUsdAggregator ?? '';
const DECIMALS = CONFIG.chainlink?.decimals ?? 8;
const POLL_MS = WS_CHAINLINK.pingMs;                     // 15s — reuse as poll interval
const HEARTBEAT_DEAD_MS = WS_CHAINLINK.heartbeatDeadMs;  // 45s
const HEARTBEAT_CHECK_MS = WS_DEFAULTS.heartbeatCheckMs;  // 10s
const RECONNECT_MAX_MS = WS_DEFAULTS.reconnectMaxMs;      // 10s

// M5: latestRoundData() selector for JSON-RPC 2.0
const LATEST_ROUND_DATA_SELECTOR = '0xfeaf968c';

let ws = null;
let reconnectTimer = null;
let reconnectMs = 1000;
let pollTimer = null;
let hbTimer = null;
let lastDataMs = 0;   // M5: Track last DATA response, not any message
let urlIdx = 0;
let intentionalClose = false;
let _rpcId = 1;

// Public state — read by loop.js
let _price = null;
let _prevPrice = null;
let _connected = false;
let _lastUpdate = 0;

export function getPrice() { return _price; }
export function getPrevPrice() { return _prevPrice; }
export function isConnected() { return _connected; }
export function getLastUpdate() { return _lastUpdate; }

function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
function stopHb() { if (hbTimer) { clearInterval(hbTimer); hbTimer = null; } }
function stopTimers() { stopPoll(); stopHb(); }

/**
 * Parse latestRoundData() hex response.
 * Returns (roundId, answer, startedAt, updatedAt, answeredInRound)
 * answer is at offset 64..128 (2nd 32-byte word), updatedAt at 192..256 (4th word).
 */
function parseLatestRoundData(hex) {
  if (!hex || hex.length < 320) return null;
  const answerHex = hex.slice(64, 128);
  let answer = BigInt('0x' + answerHex);
  // Handle signed int256
  if (answer >= (1n << 255n)) answer = answer - (1n << 256n);
  const price = Number(answer) / (10 ** DECIMALS);
  const updatedAtHex = hex.slice(192, 256);
  const updatedAt = Number(BigInt('0x' + updatedAtHex)) * 1000;
  return { price, updatedAt };
}

function sendEthCall(socket) {
  if (!AGGREGATOR || !socket || socket.readyState !== WebSocket.OPEN) return;
  try {
    socket.send(JSON.stringify({
      jsonrpc: '2.0',
      id: _rpcId++,
      method: 'eth_call',
      params: [{ to: AGGREGATOR, data: LATEST_ROUND_DATA_SELECTOR }, 'latest'],
    }));
  } catch {}
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  urlIdx = (urlIdx + 1) % WS_URLS.length;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, reconnectMs);
  reconnectMs = Math.min(RECONNECT_MAX_MS, reconnectMs * 2);
}

export function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  intentionalClose = false;

  const url = WS_URLS[urlIdx];
  if (!url) return;

  try {
    const socket = new WebSocket(url);
    ws = socket;

    socket.on('open', () => {
      if (ws !== socket) { try { socket.close(); } catch {} return; }

      log.info(`Connected to ${url}`);
      _connected = true;
      reconnectMs = 1000;
      lastDataMs = Date.now();

      // M5: Poll latestRoundData() immediately and every POLL_MS
      sendEthCall(socket);
      stopPoll();
      pollTimer = setInterval(() => {
        if (ws === socket && socket.readyState === WebSocket.OPEN) {
          sendEthCall(socket);
        }
      }, POLL_MS);

      // Heartbeat: check data freshness
      stopHb();
      hbTimer = setInterval(() => {
        if (Date.now() - lastDataMs > HEARTBEAT_DEAD_MS) {
          log.warn('Silent — forcing reconnect');
          if (ws === socket) { ws = null; _connected = false; }
          stopTimers();
          try { socket.close(); } catch {}
          scheduleReconnect();
        }
      }, HEARTBEAT_CHECK_MS);
    });

    socket.on('message', (raw) => {
      try {
        const str = typeof raw === 'string' ? raw : raw.toString();
        const data = JSON.parse(str);

        // M5: Parse JSON-RPC 2.0 response from eth_call
        if (data.result && typeof data.result === 'string' && data.result.startsWith('0x')) {
          const hex = data.result.slice(2);
          const parsed = parseLatestRoundData(hex);
          if (parsed && Number.isFinite(parsed.price) && parsed.price > 10_000 && parsed.price < 500_000) {
            _prevPrice = _price;
            _price = parsed.price;
            _lastUpdate = Date.now();
            lastDataMs = Date.now();
          }
        } else if (data.error) {
          log.debug(`RPC error: ${JSON.stringify(data.error)}`);
        }
        // L7: Any valid JSON-RPC response (even error) means connection is alive.
        // Without this, persistent RPC errors (bad config) never update lastDataMs
        // → heartbeat triggers reconnect every 45s → infinite reconnect loop.
        lastDataMs = Date.now();
      } catch (err) {
        log.debug(`WS parse error: ${err.message}`);
      }
    });

    socket.on('close', () => {
      if (ws === socket) {
        log.debug('Disconnected');
        _connected = false;
        ws = null;
        stopTimers();
      }
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
  intentionalClose = true;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  stopTimers();
  if (ws) { try { ws.close(); } catch {} ws = null; }
  _connected = false;
}
