/**
 * Polymarket CLOB WebSocket stream for Node.js bot.
 * Real-time market prices + orderbook updates.
 * Ported from usePolymarketClobStream.js — same protocol, no React.
 */

import { WebSocket } from 'ws';
import { CONFIG } from '../config.js';
import { toNumber } from '../../../src/utils.js';
import { createLogger } from '../logger.js';

const log = createLogger('ClobWS');

const WS_URL = CONFIG.polymarket?.clobWsUrl || 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const PING_MS = CONFIG.polymarket?.clobPingIntervalMs || 10_000;
const HEARTBEAT_DEAD_MS = 15_000;
const HEARTBEAT_CHECK_MS = 10_000;
const DATA_STALE_MS = 20_000;
const SUB_WATCHDOG_MS = 8_000;
const RECONNECT_MAX_MS = 10_000;

let ws = null;
let reconnectTimer = null;
let reconnectMs = 500;
let pingTimer = null;
let hbTimer = null;
let subWatchdogTimer = null;
let lastMsgMs = 0;
let lastDataMsgMs = 0;
let subscribed = false;
let dataReceived = false;
let intentionalClose = false;

// Token IDs to subscribe
let tokenIds = { up: null, down: null };

// Public state
let _upPrice = null;
let _downPrice = null;
let _connected = false;
let _lastUpdate = 0;
const _orderbook = {
  up: { bestBid: null, bestAsk: null, spread: null, bidLiquidity: 0, askLiquidity: 0 },
  down: { bestBid: null, bestAsk: null, spread: null, bidLiquidity: 0, askLiquidity: 0 },
};

export function getUpPrice() { return _upPrice; }
export function getDownPrice() { return _downPrice; }
export function getOrderbook() { return _orderbook; }
export function getLastUpdate() { return _lastUpdate; }
export function isClobConnected() { return _connected; }

function bestFromLevels(levels, side) {
  if (!Array.isArray(levels) || levels.length === 0) return null;
  let best = null;
  for (const lvl of levels) {
    const p = toNumber(lvl.price);
    if (p === null) continue;
    if (best === null) { best = p; continue; }
    best = side === 'bid' ? Math.max(best, p) : Math.min(best, p);
  }
  return best;
}

function summarizeLevels(levels, depth = 5) {
  if (!Array.isArray(levels)) return 0;
  let liq = 0;
  const len = Math.min(levels.length, depth);
  for (let i = 0; i < len; i++) {
    const s = toNumber(levels[i]?.size);
    if (s) liq += s;
  }
  return liq;
}

function handleBookEvent(data) {
  dataReceived = true;
  lastDataMsgMs = Date.now();
  if (subWatchdogTimer) { clearTimeout(subWatchdogTimer); subWatchdogTimer = null; }

  const assetId = data.asset_id;
  const bids = Array.isArray(data.bids) ? data.bids : [];
  const asks = Array.isArray(data.asks) ? data.asks : [];
  const bestBid = bestFromLevels(bids, 'bid');
  const bestAsk = bestFromLevels(asks, 'ask');
  const spread = bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null;
  const bookData = { bestBid, bestAsk, spread, bidLiquidity: summarizeLevels(bids), askLiquidity: summarizeLevels(asks) };

  if (assetId === tokenIds.up) {
    Object.assign(_orderbook.up, bookData);
    if (bestBid !== null && bestAsk !== null) _upPrice = (bestBid + bestAsk) / 2;
  } else if (assetId === tokenIds.down) {
    Object.assign(_orderbook.down, bookData);
    if (bestBid !== null && bestAsk !== null) _downPrice = (bestBid + bestAsk) / 2;
  }
  _lastUpdate = Date.now();
}

function handlePriceChange(data) {
  dataReceived = true;
  lastDataMsgMs = Date.now();
  if (subWatchdogTimer) { clearTimeout(subWatchdogTimer); subWatchdogTimer = null; }

  const changes = Array.isArray(data.price_changes) ? data.price_changes : [];
  for (const change of changes) {
    const assetId = change.asset_id;
    const bestBid = toNumber(change.best_bid);
    const bestAsk = toNumber(change.best_ask);
    if (bestBid !== null && bestAsk !== null) {
      const mid = (bestBid + bestAsk) / 2;
      if (assetId === tokenIds.up) {
        _upPrice = mid;
        _orderbook.up.bestBid = bestBid;
        _orderbook.up.bestAsk = bestAsk;
        _orderbook.up.spread = bestAsk - bestBid;
      } else if (assetId === tokenIds.down) {
        _downPrice = mid;
        _orderbook.down.bestBid = bestBid;
        _orderbook.down.bestAsk = bestAsk;
        _orderbook.down.spread = bestAsk - bestBid;
      }
    }
  }
  _lastUpdate = Date.now();
}

function handleLastTradePrice(data) {
  dataReceived = true;
  lastDataMsgMs = Date.now();
  if (subWatchdogTimer) { clearTimeout(subWatchdogTimer); subWatchdogTimer = null; }

  const assetId = data.asset_id;
  const p = toNumber(data.price);
  if (p === null) return;
  if (assetId === tokenIds.up && _upPrice === null) { _upPrice = p; _lastUpdate = Date.now(); }
  else if (assetId === tokenIds.down && _downPrice === null) { _downPrice = p; _lastUpdate = Date.now(); }
}

function stopTimers() {
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  if (hbTimer) { clearInterval(hbTimer); hbTimer = null; }
  if (subWatchdogTimer) { clearTimeout(subWatchdogTimer); subWatchdogTimer = null; }
}

function doSubscribe(socket) {
  const ids = [tokenIds.up, tokenIds.down].filter(Boolean);
  if (ids.length === 0) return;
  try {
    socket.send(JSON.stringify({ assets_ids: ids, type: 'market' }));
    subscribed = true;
    dataReceived = false;
    lastDataMsgMs = Date.now();
    // Watchdog: if no data 8s after subscribe, reconnect
    subWatchdogTimer = setTimeout(() => {
      subWatchdogTimer = null;
      if (!dataReceived && subscribed) {
        log.warn('No data 8s after subscribe — forcing reconnect');
        forceReconnect();
      }
    }, SUB_WATCHDOG_MS);
    log.debug(`Subscribed to ${ids.length} tokens`);
  } catch (err) {
    log.warn(`Subscribe failed: ${err.message}`);
    forceReconnect();
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, reconnectMs);
  reconnectMs = Math.min(RECONNECT_MAX_MS, reconnectMs * 2);
}

function forceReconnect() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (ws) {
    intentionalClose = true;
    stopTimers();
    try { ws.close(); } catch {}
    ws = null;
  }
  reconnectMs = 500;
  subscribed = false;
  _connected = false;
  reconnectTimer = setTimeout(connect, 300);
}

export function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  try {
    ws = new WebSocket(WS_URL);
    subscribed = false;
    dataReceived = false;

    ws.on('open', () => {
      log.info('Connected');
      _connected = true;
      reconnectMs = 500;
      lastMsgMs = Date.now();
      intentionalClose = false;

      // Ping
      if (pingTimer) clearInterval(pingTimer);
      pingTimer = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          try { ws.send('PING'); } catch {}
        }
      }, PING_MS);

      // Heartbeat
      if (hbTimer) clearInterval(hbTimer);
      hbTimer = setInterval(() => {
        const now = Date.now();
        if (now - lastMsgMs > HEARTBEAT_DEAD_MS) {
          log.warn('Silent — forcing reconnect');
          forceReconnect();
          return;
        }
        if (subscribed && lastDataMsgMs > 0 && now - lastDataMsgMs > DATA_STALE_MS) {
          log.warn(`No price data for ${Math.round((now - lastDataMsgMs) / 1000)}s — forcing reconnect`);
          lastDataMsgMs = now;
          forceReconnect();
        }
      }, HEARTBEAT_CHECK_MS);

      if (tokenIds.up || tokenIds.down) doSubscribe(ws);
    });

    ws.on('message', (raw) => {
      lastMsgMs = Date.now();
      try {
        const str = typeof raw === 'string' ? raw : raw.toString();
        if (str === 'PONG' || str === '') return;
        const msg = JSON.parse(str);
        switch (msg.event_type) {
          case 'book': handleBookEvent(msg); break;
          case 'price_change': handlePriceChange(msg); break;
          case 'last_trade_price': handleLastTradePrice(msg); break;
        }
      } catch {}
    });

    ws.on('close', () => {
      _connected = false;
      ws = null;
      subscribed = false;
      stopTimers();
      if (intentionalClose) { intentionalClose = false; return; }
      scheduleReconnect();
    });

    ws.on('error', () => { try { ws.close(); } catch {} });
  } catch {
    scheduleReconnect();
  }
}

/**
 * Set token IDs and trigger fresh subscription.
 */
export function setTokenIds(upTokenId, downTokenId) {
  const changed = tokenIds.up !== upTokenId || tokenIds.down !== downTokenId;
  if (!changed) return;
  log.info('Token IDs changed — re-subscribing');
  tokenIds = { up: upTokenId, down: downTokenId };
  _upPrice = null;
  _downPrice = null;
  _orderbook.up = { bestBid: null, bestAsk: null, spread: null, bidLiquidity: 0, askLiquidity: 0 };
  _orderbook.down = { bestBid: null, bestAsk: null, spread: null, bidLiquidity: 0, askLiquidity: 0 };
  forceReconnect();
}

export function disconnect() {
  intentionalClose = true;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  stopTimers();
  if (ws) { try { ws.close(); } catch {} ws = null; }
  _connected = false;
}
