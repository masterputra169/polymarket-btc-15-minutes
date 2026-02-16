import { useState, useEffect, useRef, useCallback } from 'react';
import { CONFIG, WS_DEFAULTS, WS_CLOB } from '../config.js';
import { toNumber } from '../utils.js';

/**
 * ═══ Polymarket CLOB WebSocket stream — v3.1 (Market Switch Fix) ═══
 */

const HEARTBEAT_DEAD_MS   = WS_CLOB.heartbeatDeadMs;
const HEARTBEAT_CHK_MS    = WS_DEFAULTS.heartbeatCheckMs;
const RECONNECT_MAX_MS    = WS_DEFAULTS.reconnectMaxMs;
const FLUSH_MS            = WS_DEFAULTS.throttleMs;
const SUB_WATCHDOG_MS     = WS_CLOB.subWatchdogMs;
const DATA_STALE_MS       = WS_CLOB.dataStaleMs;

const IS_DEV = typeof process !== 'undefined' && process.env?.NODE_ENV === 'development';

/* ── pure helpers (outside hook) ── */
function parsePriceLevel(level) {
  if (!level) return null;
  return { price: toNumber(level.price), size: toNumber(level.size) };
}

function bestFromLevels(levels, side) {
  if (!Array.isArray(levels) || levels.length === 0) return null;
  const parsed = levels.map(parsePriceLevel).filter((l) => l && l.price !== null);
  if (parsed.length === 0) return null;
  return side === 'bid' ? Math.max(...parsed.map((l) => l.price)) : Math.min(...parsed.map((l) => l.price));
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

const EMPTY_BOOK = { bestBid: null, bestAsk: null, spread: null, bidLiquidity: 0, askLiquidity: 0 };

export function usePolymarketClobStream() {
  /* ── State (flushed from refs at FLUSH_MS interval) ── */
  const [upPrice, setUpPrice]             = useState(null);
  const [downPrice, setDownPrice]         = useState(null);
  const [upPrevPrice, setUpPrevPrice]     = useState(null);
  const [downPrevPrice, setDownPrevPrice] = useState(null);
  const [orderbook, setOrderbook]         = useState({ up: EMPTY_BOOK, down: EMPTY_BOOK });
  const [connected, setConnected]         = useState(false);
  const [lastUpdate, setLastUpdate]       = useState(null);

  /* ── Refs: written by WS on every tick (no re-render) ── */
  const upPriceRef    = useRef(null);
  const downPriceRef  = useRef(null);
  const upPrevRef     = useRef(null);
  const downPrevRef   = useRef(null);
  const orderbookRef  = useRef({ up: { ...EMPTY_BOOK }, down: { ...EMPTY_BOOK } });
  const dirtyRef      = useRef(false);
  const flushRef      = useRef(null);

  /* ── Infra refs ── */
  const wsRef              = useRef(null);
  const reconnectRef       = useRef(null);
  const reconMsRef         = useRef(500);
  const pingRef            = useRef(null);
  const hbRef              = useRef(null);
  const lastMsgRef         = useRef(Date.now());
  const lastDataMsgRef     = useRef(0);        // Last REAL data event (not PONG)
  const tokenIdsRef        = useRef({ up: null, down: null });
  const subscribedRef      = useRef(false);
  const subWatchdogRef     = useRef(null);    // NEW: subscription health check
  const dataReceivedRef    = useRef(false);    // NEW: tracks if real data arrived
  const intentionalCloseRef = useRef(false);   // NEW: distinguish deliberate vs server close

  /* ── plain helpers ── */
  function stopPing()     { if (pingRef.current)       { clearInterval(pingRef.current);       pingRef.current       = null; } }
  function stopHb()       { if (hbRef.current)         { clearInterval(hbRef.current);         hbRef.current         = null; } }
  function stopFlush()    { if (flushRef.current)      { clearInterval(flushRef.current);      flushRef.current      = null; } }
  function stopWatchdog() { if (subWatchdogRef.current) { clearTimeout(subWatchdogRef.current); subWatchdogRef.current = null; } }
  function stopTimers()   { stopPing(); stopHb(); stopWatchdog(); }

  function clearPrices() {
    upPriceRef.current = null; downPriceRef.current = null;
    upPrevRef.current = null; downPrevRef.current = null;
    orderbookRef.current = { up: { ...EMPTY_BOOK }, down: { ...EMPTY_BOOK } };
    dirtyRef.current = true;
  }

  /**
   * ═══ FIX 3: Subscription watchdog ═══
   * After subscribe, wait 8s. If no real data (book/price_change/last_trade)
   * arrives, the subscription failed silently → force reconnect.
   */
  function startSubWatchdog() {
    stopWatchdog();
    dataReceivedRef.current = false;

    subWatchdogRef.current = setTimeout(() => {
      subWatchdogRef.current = null;
      if (!dataReceivedRef.current && subscribedRef.current) {
        console.warn('[CLOB WS] ⚠️ No data 8s after subscribe — forcing reconnect...');
        forceReconnect();
      }
    }, SUB_WATCHDOG_MS);
  }

  function subscribe(ws) {
    const { up, down } = tokenIdsRef.current;
    if (!up && !down) return;
    const ids = [up, down].filter(Boolean);
    try {
      ws.send(JSON.stringify({ assets_ids: ids, type: 'market' }));
      subscribedRef.current = true;
      dataReceivedRef.current = false;
      lastDataMsgRef.current = Date.now(); // Reset so heartbeat stale check doesn't fire on old timestamp
      startSubWatchdog();
      if (IS_DEV) console.log('[CLOB WS] 📡 Subscribed to', ids.length, 'tokens — watchdog started');
    } catch (err) {
      console.warn('[CLOB WS] ❌ Subscribe send failed:', err.message);
      subscribedRef.current = false;
      // Retry via force reconnect
      forceReconnect();
    }
  }

  /* ── WS event handlers → write to REFS only ── */
  function handleBookEvent(data) {
    dataReceivedRef.current = true;
    lastDataMsgRef.current = Date.now();
    stopWatchdog();

    const assetId = data.asset_id;
    const { up, down } = tokenIdsRef.current;
    const bids = Array.isArray(data.bids) ? data.bids : [];
    const asks = Array.isArray(data.asks) ? data.asks : [];
    const bestBid = bestFromLevels(bids, 'bid');
    const bestAsk = bestFromLevels(asks, 'ask');
    const spread = bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null;
    const bookData = { bestBid, bestAsk, spread, bidLiquidity: summarizeLevels(bids), askLiquidity: summarizeLevels(asks) };

    if (assetId === up) {
      orderbookRef.current.up = bookData;
      if (bestBid !== null && bestAsk !== null) {
        upPrevRef.current = upPriceRef.current;
        upPriceRef.current = (bestBid + bestAsk) / 2;
      }
    } else if (assetId === down) {
      orderbookRef.current.down = bookData;
      if (bestBid !== null && bestAsk !== null) {
        downPrevRef.current = downPriceRef.current;
        downPriceRef.current = (bestBid + bestAsk) / 2;
      }
    }
    dirtyRef.current = true;
  }

  function handlePriceChange(data) {
    dataReceivedRef.current = true;
    lastDataMsgRef.current = Date.now();
    stopWatchdog();

    const changes = Array.isArray(data.price_changes) ? data.price_changes : [];
    const { up, down } = tokenIdsRef.current;
    for (const change of changes) {
      const assetId = change.asset_id;
      const bestBid = toNumber(change.best_bid);
      const bestAsk = toNumber(change.best_ask);
      if (bestBid !== null && bestAsk !== null) {
        const mid = (bestBid + bestAsk) / 2;
        if (assetId === up) {
          upPrevRef.current = upPriceRef.current;
          upPriceRef.current = mid;
          const side = orderbookRef.current.up;
          side.bestBid = bestBid; side.bestAsk = bestAsk; side.spread = bestAsk - bestBid;
        } else if (assetId === down) {
          downPrevRef.current = downPriceRef.current;
          downPriceRef.current = mid;
          const side = orderbookRef.current.down;
          side.bestBid = bestBid; side.bestAsk = bestAsk; side.spread = bestAsk - bestBid;
        }
      }
    }
    dirtyRef.current = true;
  }

  function handleLastTradePrice(data) {
    dataReceivedRef.current = true;
    lastDataMsgRef.current = Date.now();
    stopWatchdog();

    const assetId = data.asset_id;
    const p = toNumber(data.price);
    const { up, down } = tokenIdsRef.current;
    if (p === null) return;
    // Only use last trade price as fallback when no book/price_change midpoint exists.
    // Book midpoint is more representative than a single (possibly stale) trade.
    if (assetId === up && upPriceRef.current === null) {
      upPrevRef.current = upPriceRef.current;
      upPriceRef.current = p;
      dirtyRef.current = true;
    } else if (assetId === down && downPriceRef.current === null) {
      downPrevRef.current = downPriceRef.current;
      downPriceRef.current = p;
      dirtyRef.current = true;
    }
  }

  /* ── Flush timer: ref → state (single batch) ── */
  useEffect(() => {
    flushRef.current = setInterval(() => {
      if (!dirtyRef.current) return;
      dirtyRef.current = false;
      setUpPrice(upPriceRef.current);
      setDownPrice(downPriceRef.current);
      setUpPrevPrice(upPrevRef.current);
      setDownPrevPrice(downPrevRef.current);
      setOrderbook({ up: { ...orderbookRef.current.up }, down: { ...orderbookRef.current.down } });
      setLastUpdate(Date.now());
    }, FLUSH_MS);
    return () => stopFlush();
  }, []);

  /* ── connect (opens NEW WebSocket) ── */
  const connect = useCallback(() => {
    const url = CONFIG.polymarket?.clobWsUrl;
    if (!url) return;

    // ═══ FIX 2: Smarter guard — only skip if truly connected ═══
    const existingWs = wsRef.current;
    if (existingWs) {
      if (existingWs.readyState === WebSocket.OPEN) return;       // Already connected
      if (existingWs.readyState === WebSocket.CONNECTING) return;  // Still opening
      wsRef.current = null; // CLOSING or CLOSED — clear stale ref
    }

    try {
      const ws = new WebSocket(url);
      wsRef.current = ws;
      subscribedRef.current = false;
      dataReceivedRef.current = false;

      ws.onopen = () => {
        if (IS_DEV) console.log('[CLOB WS] ✅ Connected (fresh)');
        setConnected(true);
        reconMsRef.current = 500;
        lastMsgRef.current = Date.now();
        intentionalCloseRef.current = false;

        // Ping
        stopPing();
        pingRef.current = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            try { ws.send('PING'); } catch (_e) { /* */ }
          }
        }, CONFIG.polymarket?.clobPingIntervalMs || 10_000);

        // Heartbeat — checks BOTH message liveness AND data freshness
        stopHb();
        hbRef.current = setInterval(() => {
          const now = Date.now();
          // Check 1: No messages at all (WS truly dead)
          if (now - lastMsgRef.current > HEARTBEAT_DEAD_MS) {
            console.warn('[CLOB WS] ⚠️ Silent — forcing reconnect');
            forceReconnect();
            return;
          }
          // Check 2: PONG flowing but no REAL data for 45s (subscription silently dropped)
          if (subscribedRef.current && lastDataMsgRef.current > 0 &&
              now - lastDataMsgRef.current > DATA_STALE_MS) {
            console.warn(`[CLOB WS] ⚠️ No price data for ${Math.round((now - lastDataMsgRef.current) / 1000)}s (PONG still alive) — forcing reconnect`);
            lastDataMsgRef.current = now; // Prevent rapid re-triggers
            forceReconnect();
          }
        }, HEARTBEAT_CHK_MS);

        // Subscribe to current tokens
        if (tokenIdsRef.current.up || tokenIdsRef.current.down) {
          subscribe(ws);
        }
      };

      ws.onmessage = (evt) => {
        lastMsgRef.current = Date.now();
        try {
          const raw = evt.data;
          if (typeof raw === 'string' && (raw === 'PONG' || raw === '')) return;
          const msg = JSON.parse(raw);
          switch (msg.event_type) {
            case 'book':             handleBookEvent(msg);       break;
            case 'price_change':     handlePriceChange(msg);     break;
            case 'last_trade_price': handleLastTradePrice(msg);  break;
            default: break;
          }
        } catch (_e) { /* */ }
      };

      ws.onclose = (evt) => {
        // H4: Guard against race condition — if forceReconnect already opened a new WS,
        // this old onclose must NOT clear the new connection's state (wsRef, subscribedRef).
        if (wsRef.current !== null && wsRef.current !== ws) {
          if (IS_DEV) console.log(`[CLOB WS] ❌ Old connection closed (code: ${evt.code}) — new connection exists, skipping cleanup`);
          return;
        }

        if (IS_DEV) console.log(`[CLOB WS] ❌ Closed (code: ${evt.code}, intentional: ${intentionalCloseRef.current})`);
        setConnected(false);
        wsRef.current = null;
        subscribedRef.current = false;
        stopTimers();

        // ═══ FIX 1: Skip auto-reconnect if WE closed it (forceReconnect handles its own) ═══
        if (intentionalCloseRef.current) {
          intentionalCloseRef.current = false;
          return;
        }

        const wait = reconMsRef.current;
        reconMsRef.current = Math.min(RECONNECT_MAX_MS, Math.floor(wait * 2));
        reconnectRef.current = setTimeout(connect, wait);
      };

      ws.onerror = () => { try { ws.close(); } catch (_e) { /* */ } };
    } catch (_e) {
      const wait = reconMsRef.current;
      reconMsRef.current = Math.min(RECONNECT_MAX_MS, Math.floor(wait * 2));
      reconnectRef.current = setTimeout(connect, wait);
    }
  }, []);

  /**
   * ═══ FIX 1: Force reconnect — kill old WS, open fresh ═══
   * Used by: setTokenIds, heartbeat timeout, subscription watchdog
   */
  function forceReconnect() {
    if (IS_DEV) console.log('[CLOB WS] 🔄 Force reconnect...');

    clearTimeout(reconnectRef.current);
    reconnectRef.current = null;

    // Kill existing connection cleanly
    const ws = wsRef.current;
    if (ws) {
      intentionalCloseRef.current = true;
      stopTimers();
      try { ws.close(); } catch (_e) { /* */ }
      wsRef.current = null;
    }

    // Reset (deliberate reconnect = not a failure)
    reconMsRef.current = 500;
    subscribedRef.current = false;
    setConnected(false);

    // Short delay to let server process close, then fresh connect
    reconnectRef.current = setTimeout(connect, 300);
  }

  /**
   * ═══ FIX 1: setTokenIds — force fresh connection ═══
   * Old: re-subscribe on same WS → server rejects → WS dies
   * New: close old WS → open fresh → subscribe on new connection
   */
  const setTokenIds = useCallback((upTokenId, downTokenId) => {
    const changed = tokenIdsRef.current.up !== upTokenId || tokenIdsRef.current.down !== downTokenId;
    if (!changed) return;

    console.log('[CLOB WS] 🔄 Token IDs changed → force fresh connection');
    tokenIdsRef.current = { up: upTokenId, down: downTokenId };
    clearPrices();
    forceReconnect();
  }, []);

  // Visibility recovery
  useEffect(() => {
    const h = () => {
      if (document.visibilityState !== 'visible') return;
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        if (IS_DEV) console.log('[CLOB WS] 👁️ Tab visible — reconnecting…');
        clearTimeout(reconnectRef.current);
        reconMsRef.current = 500;
        if (ws && ws.readyState === WebSocket.CONNECTING) {
          intentionalCloseRef.current = true;
          try { ws.close(); } catch (_e) { /* */ }
          wsRef.current = null;
        }
        connect();
      } else {
        lastMsgRef.current = Date.now();
        if (!subscribedRef.current && (tokenIdsRef.current.up || tokenIdsRef.current.down)) {
          subscribe(ws);
        }
      }
    };
    document.addEventListener('visibilitychange', h);
    return () => document.removeEventListener('visibilitychange', h);
  }, [connect]);

  // Initial connect
  useEffect(() => {
    connect();
    return () => {
      intentionalCloseRef.current = true;
      clearTimeout(reconnectRef.current);
      stopTimers();
      stopFlush();
      try { wsRef.current?.close(); } catch (_e) { /* */ }
    };
  }, [connect]);

  return { upPrice, downPrice, upPrevPrice, downPrevPrice, orderbook, connected, lastUpdate, setTokenIds };
}