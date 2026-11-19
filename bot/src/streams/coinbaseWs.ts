/**
 * Coinbase Exchange public WebSocket stream for BTC-USD spot mid-price.
 * Used as a USD-native companion to Binance USDT for multi-venue Chainlink nowcast.
 */

import { WebSocket, type RawData } from 'ws';
import { createLogger } from '../logger.ts';

const log = createLogger('CoinbaseWS');

const WS_URL = 'wss://ws-feed.exchange.coinbase.com';
const HEARTBEAT_DEAD_MS = 25_000;
const HEARTBEAT_CHECK_MS = 5_000;
const RECONNECT_MAX_MS = 15_000;

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectMs = 500;
let hbTimer: ReturnType<typeof setInterval> | null = null;
let lastMsgMs = 0;
let intentionalClose = false;
let _parseErrors = 0;

let _price: number | null = null;
let _prevPrice: number | null = null;
let _connected = false;

export function getPrice(): number | null { return _price; }
export function getPrevPrice(): number | null { return _prevPrice; }
export function isConnected(): boolean { return _connected; }
export function getLastMsgTime(): number { return lastMsgMs; }

/**
 * Ingest a raw Coinbase ticker WS message. Exported for unit testing.
 */
export function ingestCoinbaseMessage(raw: RawData | string, now = Date.now()): void {
  lastMsgMs = now;
  try {
    const text = typeof raw === 'string' ? raw : raw.toString();
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || parsed.type !== 'ticker') return;

    const bid = Number(parsed.best_bid);
    const ask = Number(parsed.best_ask);
    const last = Number(parsed.price);

    let px: number | null = null;
    if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 10_000 && ask >= bid && ask < 500_000) {
      px = (bid + ask) / 2;
    } else if (Number.isFinite(last) && last > 10_000 && last < 500_000) {
      px = last;
    }

    if (px != null) {
      _prevPrice = _price;
      _price = px;
    }
  } catch (err: any) {
    _parseErrors++;
    if (_parseErrors === 1 || _parseErrors % 500 === 0) {
      log.debug(`WS parse error #${_parseErrors}: ${err?.message || err}`);
    }
  }
}

function stopHb(): void {
  if (hbTimer) { clearInterval(hbTimer); hbTimer = null; }
}

function scheduleReconnect(): void {
  if (reconnectTimer || intentionalClose) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, reconnectMs);
  reconnectMs = Math.min(RECONNECT_MAX_MS, reconnectMs * 2);
}

export function connect(): void {
  if (process.env.COINBASE_WS_ENABLED === 'false') return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  intentionalClose = false;

  try {
    const socket = new WebSocket(WS_URL);
    ws = socket;

    socket.on('open', () => {
      if (ws !== socket) { try { socket.close(); } catch {} return; }
      try {
        socket.send(JSON.stringify({
          type: 'subscribe',
          product_ids: ['BTC-USD'],
          channels: ['ticker'],
        }));
      } catch (sendErr: any) {
        log.debug(`Subscribe failed: ${sendErr?.message || sendErr}`);
        try { socket.close(); } catch {}
        return;
      }

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
      ingestCoinbaseMessage(raw, Date.now());
    });

    socket.on('close', () => {
      if (ws === socket) {
        log.debug('Disconnected');
        _connected = false;
        ws = null;
        stopHb();
      }
      if (!intentionalClose) scheduleReconnect();
    });

    socket.on('error', (err: any) => {
      log.debug(`WS error: ${err?.message || err}`);
      try { socket.close(); } catch {}
    });
  } catch (connErr: any) {
    log.debug(`Connect failed: ${connErr?.message || connErr}`);
    scheduleReconnect();
  }
}

export function disconnect(): void {
  intentionalClose = true;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  stopHb();
  if (ws) { try { ws.close(); } catch {} ws = null; }
  _connected = false;
}

export function resetCoinbaseForTest(): void {
  disconnect();
  _price = null;
  _prevPrice = null;
  _connected = false;
  lastMsgMs = 0;
  reconnectMs = 500;
  _parseErrors = 0;
}
