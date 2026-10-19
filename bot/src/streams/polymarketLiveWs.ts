/**
 * Polymarket Chainlink BTC/USD SPOT feed — used by the settlement estimate
 * (the final-minute TWAP path in engines/settlePrice.ts, via the timestamped
 * spot ticks), the tape and the dashboard.
 *
 * Since 2026-10-19 the primary source is PolyBolt channel `price.crypto`
 * (`provider:"chainlink"`, the default vendor for crypto symbols — Pyth is
 * only an optional pin, verified live 2026-10-19: PolyBolt and RTDS delivered
 * identical values for every overlapping second). RTDS topic
 * `crypto_prices_chainlink` (ws-live-data) is deprecated — removal expected
 * ~2026-10-23 — so it stays connected as a shadow fallback: reads prefer fresh
 * PolyBolt ticks and fall back to RTDS, and the tick stores are merged per
 * second. TWAP_FEED=rtds keeps the old RTDS-only behaviour.
 *
 * The exported surface is unchanged, so loop.ts / index.ts need no edit.
 */

import { WebSocket } from 'ws';
import { CONFIG, WS_POLYMARKET_LIVE, WS_DEFAULTS } from '../config.ts';
import { createLogger } from '../logger.ts';
import { TickStore, type Tick } from './tickStore.ts';
import {
  createPolyBoltFeed,
  POLYBOLT_CRYPTO_CHANNEL,
  resolveTwapFeedMode,
  type PolyBoltFeed,
  type PolyBoltHealth,
  type TwapFeedMode,
} from './polyboltWs.ts';

const log = createLogger('PolyLiveWS');

const WS_URL = CONFIG.polymarket?.liveDataWsUrl || 'wss://ws-live-data.polymarket.com';
const PING_MS = WS_POLYMARKET_LIVE.pingMs;               // 15s
const HEARTBEAT_DEAD_MS = WS_POLYMARKET_LIVE.heartbeatDeadMs; // 30s
const HEARTBEAT_CHECK_MS = WS_DEFAULTS.heartbeatCheckMs;  // 10s
const RECONNECT_MAX_MS = WS_DEFAULTS.reconnectMaxMs;      // 10s

// Reference-price migration (2026-10-19): the same switch that moves the TWAP
// feed decides whether PolyBolt carries Chainlink spot. RTDS keeps running as a
// shadow fallback while it still exists; reads prefer fresh PolyBolt ticks.
const FEED_MODE: TwapFeedMode = resolveTwapFeedMode(process.env);
/** A healthy Chainlink spot publishes every second; older than this hands reads back to RTDS. */
const POLYBOLT_FRESH_MS = 15_000;
const pbSpot: PolyBoltFeed | null = FEED_MODE === 'polybolt'
  ? createPolyBoltFeed({
      name: 'SPOT',
      channel: POLYBOLT_CRYPTO_CHANNEL,
      filter: { symbol: 'btcusd', provider: 'chainlink' },
      keepMs: 5 * 60_000,
    })
  : null;

let ws = null;
let reconnectTimer = null;
let reconnectMs = 500;
let pingTimer = null;
let hbTimer = null;
let lastMsgMs = 0;
let intentionalClose = false; // H4: Prevent zombie reconnect on shutdown
let _parseErrors = 0;

// Public state — read by loop.ts
let _price = null;
let _prevPrice = null;
let _connected = false;
let _lastUpdate = 0;

/** Fresh PolyBolt Chainlink spot, or null (then the RTDS values are used). */
function freshPolyBoltSpot(): { tick: Tick; recvMs: number } | null {
  if (!pbSpot) return null;
  const h = pbSpot.health();
  if (!h.connected || !h.subscribed) return null;
  const tick = pbSpot.latest();
  if (!tick || Date.now() - h.lastTickRecvMs > POLYBOLT_FRESH_MS) return null;
  return { tick, recvMs: h.lastTickRecvMs };
}

export function getPrice() {
  const pb = freshPolyBoltSpot();
  return pb ? pb.tick.value : _price;
}
export function getPrevPrice() {
  const pb = freshPolyBoltSpot();
  if (pb) {
    const recent = pbSpot.between(pb.tick.ts - 5_000, pb.tick.ts);
    return recent.length >= 2 ? recent[recent.length - 2].value : pb.tick.value;
  }
  return _prevPrice;
}
export function isConnected() { return freshPolyBoltSpot() != null || _connected; }
export function getLastUpdate() {
  const pb = freshPolyBoltSpot();
  return Math.max(pb?.recvMs ?? 0, _lastUpdate);
}

/** Which feed carries the reference prices ('polybolt' or 'rtds'), and PolyBolt's health. */
export function getSpotFeedMode(): TwapFeedMode { return FEED_MODE; }
export function getPolyBoltSpotHealth(): PolyBoltHealth | null { return pbSpot?.health() ?? null; }

// Spot ticks by the timestamp Chainlink put on them — the final-minute settlement
// estimate (engines/settlePrice.ts) averages these, and "latest received" is
// about a second behind them.
const _ticks = new TickStore(5 * 60_000);
/**
 * Spot ticks by source timestamp. PolyBolt and the RTDS fallback are merged per
 * second (PolyBolt wins on a shared second — the values are identical, verified
 * 2026-10-19), so one feed's missed second does not thin the settlement estimate.
 */
export function getSpotTicksBetween(from: number, to: number): Tick[] {
  const pbTicks = pbSpot?.between(from, to) ?? [];
  if (pbTicks.length === 0) return _ticks.between(from, to);
  const merged = new Map<number, number>();
  for (const t of _ticks.between(from, to)) merged.set(t.ts, t.value);
  for (const t of pbTicks) merged.set(t.ts, t.value);
  return [...merged.entries()].sort((a, b) => a[0] - b[0]).map(([ts, value]) => ({ ts, value }));
}
export function getSpotAt(ts: number): number | null { return pbSpot?.at(ts) ?? _ticks.at(ts); }

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
  pbSpot?.start();
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
        const ts = Number(payload.timestamp);
        if (Number.isFinite(ts) && ts > 0) _ticks.add(ts, p);
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
  pbSpot?.stop();
  intentionalClose = true; // H4: Signal to close handler not to reconnect
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  stopTimers();
  if (ws) { try { ws.close(); } catch {} ws = null; }
  _connected = false;
}
