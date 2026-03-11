import { useState, useEffect, useRef, useCallback } from 'react';

/**
 * React hook that connects to the bot's status WebSocket server.
 * Returns { connected, data, lastUpdate }.
 *
 * Auto-reconnects with exponential backoff (500ms -> 10s).
 * Gracefully handles bot not running (stays disconnected, no errors).
 * Writes to ref + throttled state flush (same pattern as useBinanceStream).
 */

const BOT_WS_URL = `ws://${window.location.hostname}:3099`;  // dynamic: works from phone + localhost
const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 10_000;
const STALE_TIMEOUT_MS = 15_000;
const THROTTLE_MS = 500;

export function useBotStream() {
  const [connected, setConnected] = useState(false);
  const [data, setData] = useState(null);
  const [lastUpdate, setLastUpdate] = useState(null);

  const wsRef = useRef(null);
  const reconnectRef = useRef(null);
  const reconMsRef = useRef(RECONNECT_MIN_MS);
  const staleRef = useRef(null);
  const lastMsgRef = useRef(0);

  // Throttled state: write to ref, flush on interval
  const dataRef = useRef(null);
  const flushRef = useRef(null);
  const dirtyRef = useRef(false);

  // Start flush interval on mount
  useEffect(() => {
    flushRef.current = setInterval(() => {
      if (dirtyRef.current) {
        dirtyRef.current = false;
        setData(dataRef.current);
        setLastUpdate(lastMsgRef.current);
      }
    }, THROTTLE_MS);
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
        try {
          const parsed = JSON.parse(evt.data);
          dataRef.current = parsed;
          dirtyRef.current = true;
        } catch (_e) { /* */ }
      };

      ws.onclose = () => {
        if (wsRef.current !== ws) return; // H6: stale WS guard
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

  return { connected, data, lastUpdate };
}
