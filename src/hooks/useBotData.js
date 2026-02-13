import { useState, useEffect, useRef, useCallback } from 'react';

/**
 * useBotData — Pure display-layer hook (memory-optimized).
 *
 * Replaces useMarketData + 4 WebSocket hooks. The bot does ALL
 * fetching, computation, ML inference, etc. This hook just:
 *   1. Connects to bot status WS on localhost:3099
 *   2. Receives raw JSON strings (NO parse on every message)
 *   3. Parses + flushes to React state on interval (1/sec)
 *   4. Tracks prevPrice for Binance tick animation
 *   5. Provides setBankroll (sends WS message to bot)
 *
 * Memory optimization: raw WS messages stored as string ref,
 * only JSON.parse'd on flush. Cuts object allocation by ~50%.
 */

const BOT_WS_URL = 'ws://localhost:3099';
const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 10_000;
const STALE_TIMEOUT_MS = 15_000;
const FLUSH_MS = 500; // Parse + flush to React 2x/sec

export function useBotData() {
  const [connected, setConnected] = useState(false);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const wsRef = useRef(null);
  const reconnectRef = useRef(null);
  const reconMsRef = useRef(RECONNECT_MIN_MS);
  const staleRef = useRef(null);
  const lastMsgRef = useRef(0);

  // Store raw JSON string — only parse on flush
  const rawRef = useRef(null);
  const flushRef = useRef(null);
  const dirtyRef = useRef(false);
  const firstMsgRef = useRef(false);

  // Track previous Binance price for tick animation
  const binancePriceRef = useRef(null);
  const binancePrevPriceRef = useRef(null);

  // Expose current prices via state for re-render
  const [binancePrice, setBinancePrice] = useState(null);
  const [binancePrevPrice, setBinancePrevPrice] = useState(null);

  // Parse raw JSON + flush to React state
  function flushToState() {
    const raw = rawRef.current;
    if (!raw) return;
    rawRef.current = null; // Release string for GC

    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // Track Binance price for tick animation
    const newPrice = msg.lastPrice ?? msg.btcPrice;
    if (newPrice != null && newPrice !== binancePriceRef.current) {
      binancePrevPriceRef.current = binancePriceRef.current;
      binancePriceRef.current = newPrice;
    }

    setData(msg);
    setLoading(false);
    setBinancePrice(binancePriceRef.current);
    setBinancePrevPrice(binancePrevPriceRef.current);
  }

  // Start flush interval on mount
  useEffect(() => {
    flushRef.current = setInterval(() => {
      if (dirtyRef.current) {
        dirtyRef.current = false;
        flushToState();
      }
    }, FLUSH_MS);
    return () => clearInterval(flushRef.current);
  }, []);

  function stopStaleCheck() {
    if (staleRef.current) { clearInterval(staleRef.current); staleRef.current = null; }
  }

  const connect = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState <= 1) return;

    try {
      const ws = new WebSocket(BOT_WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        reconMsRef.current = RECONNECT_MIN_MS;
        lastMsgRef.current = Date.now();
        firstMsgRef.current = false; // Reset so first message on new connection flushes immediately

        // Stale check: if no message for 15s, force reconnect
        stopStaleCheck();
        staleRef.current = setInterval(() => {
          if (Date.now() - lastMsgRef.current > STALE_TIMEOUT_MS) {
            try { ws.close(); } catch (_e) { /* */ }
          }
        }, 5_000);
      };

      ws.onmessage = (evt) => {
        lastMsgRef.current = Date.now();
        // Store raw string only — NO JSON.parse here (memory optimization)
        rawRef.current = evt.data;
        dirtyRef.current = true;

        // First message: flush immediately (don't wait for interval)
        if (!firstMsgRef.current) {
          firstMsgRef.current = true;
          dirtyRef.current = false;
          flushToState();
        }
      };

      ws.onclose = () => {
        setConnected(false);
        wsRef.current = null;
        stopStaleCheck();
        const wait = reconMsRef.current;
        reconMsRef.current = Math.min(RECONNECT_MAX_MS, Math.floor(wait * 2));
        reconnectRef.current = setTimeout(connect, wait);
      };

      ws.onerror = () => {
        try { ws.close(); } catch (_e) { /* */ }
      };
    } catch (_e) {
      const wait = reconMsRef.current;
      reconMsRef.current = Math.min(RECONNECT_MAX_MS, Math.floor(wait * 2));
      reconnectRef.current = setTimeout(connect, wait);
    }
  }, []);

  useEffect(() => {
    connect();
    return () => {
      clearTimeout(reconnectRef.current);
      stopStaleCheck();
      clearInterval(flushRef.current);
      rawRef.current = null;
      try { wsRef.current?.close(); } catch (_e) { /* */ }
    };
  }, [connect]);

  // Reconnect on tab focus
  useEffect(() => {
    const h = () => {
      if (document.visibilityState !== 'visible') return;
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        clearTimeout(reconnectRef.current);
        reconMsRef.current = RECONNECT_MIN_MS;
        connect();
      }
    };
    document.addEventListener('visibilitychange', h);
    return () => document.removeEventListener('visibilitychange', h);
  }, [connect]);

  // setBankroll: send message to bot via WS
  const setBankroll = useCallback((value) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'setBankroll', value }));
    }
  }, []);

  return {
    data,
    loading,
    error: null,
    setBankroll,
    botConnected: connected,
    binancePrice,
    binancePrevPrice,
  };
}
