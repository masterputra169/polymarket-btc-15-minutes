/**
 * Polymarket CLOB WebSocket stream for Node.js bot.
 * Real-time market prices + orderbook updates.
 * Ported from usePolymarketClobStream.js — same protocol, no React.
 *
 * Two sockets can exist at once: `ws` serves data and `pending` is a
 * replacement being brought up. A replacement is only promoted once it has
 * produced a quote, so changing subscription — at a market rollover or after a
 * health check — never opens a hole in the feed (make-before-break). The old
 * path closed first and reconnected through a 300ms timer plus a fresh TLS
 * handshake, which guaranteed a gap at every 15-minute rollover.
 */

import { WebSocket } from 'ws';
import { CONFIG } from '../config.ts';
import { toNumber, depthNearTop } from '../../../src/utils.ts';
import { createLogger } from '../logger.ts';

const log = createLogger('ClobWS');

const WS_URL = CONFIG.polymarket?.clobWsUrl || 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const PING_MS = CONFIG.polymarket?.clobPingIntervalMs || 10_000;
const HEARTBEAT_DEAD_MS = 15_000;
const HEARTBEAT_CHECK_MS = 10_000;
const SUB_WATCHDOG_MS = 8_000;
const RECONNECT_MAX_MS = 10_000;

/**
 * Ceiling on the gap between replacement attempts that never produced a book.
 *
 * A market can accept the handshake and the subscription and still send
 * nothing — a partial outage, or a token that has just resolved. Retrying on
 * the bare watchdog cadence means a new connection every 8s indefinitely,
 * which is an un-throttled connection stream to the same host that places
 * orders. The bot serves REST in the meantime, so backing off costs nothing.
 */
const REPLACEMENT_MAX_BACKOFF_MS = 60_000;

/**
 * A book quiet this long gets re-verified with a replacement socket.
 *
 * A quiet book is usually just a quiet book, but Polymarket can also drop a
 * subscription while the socket keeps answering PONG, and the two look
 * identical from here. The replacement's `book` snapshot settles it — and
 * because it is make-before-break, re-verifying costs no data. Must stay under
 * CLOB_HARD_STALE_MS, or the feed would go unusable before the check ran.
 */
export const QUIET_RESYNC_MS = 25_000;

let ws = null;
let pending = null;
let reconnectTimer = null;
let reconnectMs = 500;
let replacementTimer = null;
let replacementBackoffMs = 0;
let pingTimer = null;
let hbTimer = null;
let lastMsgMs = 0;
let lastDataMsgMs = 0;
let subscribed = false;
let shuttingDown = false;
let quoteSeq = 0;
let _parseErrors = 0;

/** Per-socket bookkeeping — two sockets are live during a swap. */
const socketState = new Map();

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
export function getOrderbook() { return { up: { ..._orderbook.up }, down: { ..._orderbook.down } }; }
export function getLastUpdate() { return _lastUpdate; }
export function isClobConnected() { return _connected; }

/** A side is only usable once we hold both of its quotes. */
function twoSided(side) { return side.bestBid !== null && side.bestAsk !== null; }

/**
 * What the freshness decision needs, as four independent facts.
 * `lastFrameMs` moves on ANY inbound frame (PONG included) and proves the link;
 * `lastQuoteMs` moves only on a frame that carried a quote. Collapsing the two
 * is what made a quiet book look like a dead one. See clobFreshness.ts.
 */
export function getFeedHealth() {
  return {
    now: Date.now(),
    connected: _connected,
    bookValid: twoSided(_orderbook.up) || twoSided(_orderbook.down),
    lastFrameMs: lastMsgMs,
    lastQuoteMs: lastDataMsgMs,
  };
}

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

/** Is this asset one of the two we currently follow? */
function isFollowed(assetId) {
  return assetId === tokenIds.up || assetId === tokenIds.down;
}

/**
 * Mark that a quote-bearing frame arrived. Bumped seq is how a swap knows the
 * replacement is live.
 *
 * Only frames for the CURRENT tokens count. During a rollover the outgoing
 * socket is still subscribed to the previous market and keeps delivering;
 * counting those would report a fresh quote for a market whose first book has
 * not arrived yet.
 */
function markQuote() {
  quoteSeq++;
  lastDataMsgMs = Date.now();
}

function handleBookEvent(data) {
  const assetId = data.asset_id;
  if (!isFollowed(assetId)) return;
  markQuote();
  const bids = Array.isArray(data.bids) ? data.bids : [];
  const asks = Array.isArray(data.asks) ? data.asks : [];
  const bestBid = bestFromLevels(bids, 'bid');
  const bestAsk = bestFromLevels(asks, 'ask');
  const spread = bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null;
  // Best levels first: the market channel lists both sides worst-first (see depthNearTop).
  const bookData = { bestBid, bestAsk, spread, bidLiquidity: depthNearTop(bids, 'bid'), askLiquidity: depthNearTop(asks, 'ask') };

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
  // W3: Only count this as a quote if there are actual price changes.
  // CLOB can send price_change events with an empty changes array — treating
  // those as quotes would mask a genuinely stale book.
  const all = Array.isArray(data.price_changes) ? data.price_changes : [];
  const changes = all.filter(c => isFollowed(c?.asset_id));
  if (changes.length === 0) return;

  markQuote();

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
  const assetId = data.asset_id;
  if (!isFollowed(assetId)) return;
  markQuote();

  const p = toNumber(data.price);
  if (p === null) return;
  if (assetId === tokenIds.up && _upPrice === null) { _upPrice = p; _lastUpdate = Date.now(); }
  else if (assetId === tokenIds.down && _downPrice === null) { _downPrice = p; _lastUpdate = Date.now(); }
}

// ── Socket bookkeeping ──────────────────────────────────────────────────────

function stateOf(socket) {
  let st = socketState.get(socket);
  if (!st) { st = { watchdog: null, gotQuote: false }; socketState.set(socket, st); }
  return st;
}

function clearWatchdog(socket) {
  const st = socketState.get(socket);
  if (st?.watchdog) { clearTimeout(st.watchdog); st.watchdog = null; }
}

/** Close a socket we no longer track. Its close handler finds it is neither `ws` nor `pending` and stays inert. */
function closeQuietly(socket) {
  if (!socket) return;
  clearWatchdog(socket);
  socketState.delete(socket);
  try { socket.close(); } catch {}
}

function stopTimers() {
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  if (hbTimer) { clearInterval(hbTimer); hbTimer = null; }
}

function startTimers() {
  stopTimers();
  // Ping both sockets during a swap — a standby that is never pinged can be
  // culled by the server before it has had a chance to deliver its first book.
  pingTimer = setInterval(() => {
    for (const s of [ws, pending]) {
      if (s && s.readyState === WebSocket.OPEN) {
        try { s.send('PING'); } catch {}
      }
    }
  }, PING_MS);
  hbTimer = setInterval(healthCheck, HEARTBEAT_CHECK_MS);
}

function healthCheck() {
  const now = Date.now();
  if (pending || replacementTimer) return; // a replacement is already on its way

  // No inbound frame at all, not even a PONG. Bring up a replacement rather
  // than tearing the link down — the current book stays usable meanwhile.
  if (now - lastMsgMs > HEARTBEAT_DEAD_MS) {
    log.warn('Silent — bringing up a replacement socket');
    openReplacement();
    return;
  }

  // Link is alive but no quote has moved. Cannot tell a quiet book from a
  // dropped subscription without asking, so ask — gaplessly.
  if (subscribed && lastDataMsgMs > 0 && now - lastDataMsgMs > QUIET_RESYNC_MS) {
    log.debug(`Book quiet ${Math.round((now - lastDataMsgMs) / 1000)}s — re-verifying with a replacement socket`);
    openReplacement();
  }
}

function doSubscribe(socket) {
  const ids = [tokenIds.up, tokenIds.down].filter(Boolean);
  if (ids.length === 0) return;
  if (!socket || socket.readyState !== WebSocket.OPEN) return;

  const st = stateOf(socket);
  clearWatchdog(socket);
  try {
    socket.send(JSON.stringify({ assets_ids: ids, type: 'market' }));
    st.gotQuote = false;
    if (socket === ws) {
      subscribed = true;
      // Not Date.now(): subscribing is not a quote. Claiming one here would make
      // a feed that has never produced data look freshly quoted.
      lastDataMsgMs = 0;
    }
    st.watchdog = setTimeout(() => {
      st.watchdog = null;
      if (st.gotQuote) return;
      if (socket === pending) {
        log.warn('Replacement silent 8s after subscribe — discarding and retrying');
        pending = null;
        closeQuietly(socket);
        scheduleReplacement();
      } else if (socket === ws && !pending) {
        // Only when nothing is already in flight — otherwise the outgoing
        // socket's watchdog would cancel the replacement being brought up.
        log.warn('No data 8s after subscribe — bringing up a replacement socket');
        scheduleReplacement();
      }
    }, SUB_WATCHDOG_MS);
    log.debug(`Subscribed to ${ids.length} tokens`);
  } catch (err) {
    log.warn(`Subscribe failed: ${err.message}`);
    if (socket === pending) { pending = null; closeQuietly(socket); }
    scheduleReconnect();
  }
}

/** Retry a replacement on an exponential delay, so repeated failures do not hammer. */
function scheduleReplacement() {
  if (shuttingDown || replacementTimer || pending) return;
  replacementBackoffMs = replacementBackoffMs
    ? Math.min(REPLACEMENT_MAX_BACKOFF_MS, replacementBackoffMs * 2)
    : 500;
  replacementTimer = setTimeout(() => {
    replacementTimer = null;
    openReplacement();
  }, replacementBackoffMs);
}

function scheduleReconnect() {
  if (shuttingDown || reconnectTimer || pending) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, reconnectMs);
  reconnectMs = Math.min(RECONNECT_MAX_MS, reconnectMs * 2);
}

function invalidateOrderbook() {
  // Clear cached orderbook + prices on disconnect/reconnect so stale data is never used.
  // Only use orderbook data once fresh data arrives after reconnection.
  _upPrice = null;
  _downPrice = null;
  _orderbook.up = { bestBid: null, bestAsk: null, spread: null, bidLiquidity: 0, askLiquidity: 0 };
  _orderbook.down = { bestBid: null, bestAsk: null, spread: null, bidLiquidity: 0, askLiquidity: 0 };
  _lastUpdate = 0;
}

/**
 * Swap a proven replacement in. `ws` is reassigned BEFORE the outgoing socket is
 * closed, so the outgoing close handler sees a socket it no longer owns and does
 * not invalidate the book or schedule a reconnect.
 */
function promote(socket) {
  if (ws === socket) return;
  const outgoing = ws;
  ws = socket;
  pending = null;
  // It just delivered a quote, so its link is provably alive right now — it
  // must not inherit the silence of the socket it is replacing.
  lastMsgMs = Date.now();
  _connected = true;
  subscribed = true;
  reconnectMs = 500;
  replacementBackoffMs = 0;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  startTimers();
  closeQuietly(outgoing);
  log.debug('Replacement socket promoted');
}

function newSocket() {
  try {
    const socket = new WebSocket(WS_URL);

    socket.on('open', () => {
      // Superseded while connecting — drop it.
      if (socket !== ws && socket !== pending) { try { socket.close(); } catch {} return; }

      // Only the SERVING socket's frames prove the feed is alive. A standby's
      // handshake and PONGs must not refresh this, or a black-holed `ws` —
      // which never fires 'close' and so keeps a frozen book — would look
      // healthy for as long as replacements keep connecting behind it.
      if (socket === ws) {
        lastMsgMs = Date.now();
        log.info('Connected');
        _connected = true;
        reconnectMs = 500;
        startTimers();
      }
      if (tokenIds.up || tokenIds.down) doSubscribe(socket);
    });

    socket.on('message', (raw) => {
      if (socket !== ws && socket !== pending) return;
      if (socket === ws) lastMsgMs = Date.now();
      try {
        const str = typeof raw === 'string' ? raw : raw.toString();
        if (str === 'PONG' || str === '') return;
        const msg = JSON.parse(str);
        const before = quoteSeq;
        switch (msg.event_type) {
          case 'book': handleBookEvent(msg); break;
          case 'price_change': handlePriceChange(msg); break;
          case 'last_trade_price': handleLastTradePrice(msg); break;
        }
        if (quoteSeq !== before) {
          stateOf(socket).gotQuote = true;
          clearWatchdog(socket);
          if (socket === pending) promote(socket);
          else if (socket === ws) replacementBackoffMs = 0; // feed is healthy again
        }
      } catch (err) {
        if (++_parseErrors % 100 === 1) log.debug(`WS parse error (${_parseErrors}): ${err.message}`);
      }
    });

    socket.on('close', () => {
      const wasServing = ws === socket;
      const wasPending = pending === socket;
      clearWatchdog(socket);
      socketState.delete(socket);

      if (wasPending) {
        pending = null;
        if (!ws) scheduleReconnect();
        return;
      }
      // Neither serving nor pending: superseded by a promotion. Stay inert.
      if (!wasServing) return;

      ws = null;
      _connected = false;
      subscribed = false;
      invalidateOrderbook();
      // A replacement already in flight will promote itself; don't race it —
      // and keep the ping running, because that standby is now the only socket
      // left and an unpinged one can be culled before it delivers its book.
      if (!pending) { stopTimers(); scheduleReconnect(); }
    });

    socket.on('error', (err) => {
      log.debug(`WS error: ${err?.message || err}`);
      try { socket.close(); } catch {}
    });

    return socket;
  } catch {
    return null;
  }
}

/** Bring up a standby socket alongside the serving one. */
function openReplacement() {
  if (shuttingDown) return;
  if (pending) closeQuietly(pending);
  pending = newSocket();
  if (!pending) scheduleReconnect();
  else if (!pingTimer) startTimers();
}

export function connect() {
  shuttingDown = false;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  if (pending) return;

  const socket = newSocket();
  if (!socket) { scheduleReconnect(); return; }
  ws = socket;
}

/**
 * Set token IDs and trigger fresh subscription.
 *
 * The outgoing book describes a different market, so it is dropped at once —
 * but the outgoing *socket* is kept until the replacement has a book, which
 * removes the reconnect gap from every rollover.
 */
export function setTokenIds(upTokenId, downTokenId) {
  const changed = tokenIds.up !== upTokenId || tokenIds.down !== downTokenId;
  if (!changed) return;
  log.info('Token IDs changed — re-subscribing');
  tokenIds = { up: upTokenId, down: downTokenId };
  invalidateOrderbook();
  lastDataMsgMs = 0;

  // A replacement already in flight is subscribed to the market we just left.
  // Re-point it: if it is open, resubscribe in place; if it is still
  // connecting, its own open handler will pick up the new tokenIds. Either way
  // it stays the path forward, so nothing else needs to be opened.
  if (pending) {
    if (pending.readyState === WebSocket.OPEN) doSubscribe(pending);
    return;
  }

  if (ws && ws.readyState === WebSocket.OPEN) {
    // Cold start: the socket is up but was connected before the market was
    // known, so there is no subscription to preserve and nothing to make
    // before we break. Subscribe in place.
    if (!subscribed) doSubscribe(ws);
    else openReplacement();
  } else connect();
}

export function disconnect() {
  shuttingDown = true;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (replacementTimer) { clearTimeout(replacementTimer); replacementTimer = null; }
  replacementBackoffMs = 0;
  stopTimers();
  const sockets = [ws, pending];
  ws = null;
  pending = null;
  for (const s of sockets) closeQuietly(s);
  socketState.clear();
  _connected = false;
}
