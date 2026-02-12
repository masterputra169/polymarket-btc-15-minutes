import { useState, useEffect, useRef, useCallback } from 'react';
import { CONFIG, WS_DEFAULTS, WS_POLYMARKET_LIVE } from '../config.js';
import { useThrottledPricePair } from './useThrottledState.js';

/**
 * ═══ Polymarket Chainlink LiveData WS — v3 (Memory Optimized) ═══
 */

const PING_MS           = WS_POLYMARKET_LIVE.pingMs;
const HEARTBEAT_DEAD_MS = WS_POLYMARKET_LIVE.heartbeatDeadMs;
const HEARTBEAT_CHK_MS  = WS_DEFAULTS.heartbeatCheckMs;
const RECONNECT_MAX_MS  = WS_DEFAULTS.reconnectMaxMs;
const THROTTLE_MS       = WS_DEFAULTS.throttleMs;

const IS_DEV = typeof process !== 'undefined' && process.env?.NODE_ENV === 'development';

export function usePolymarketChainlinkStream() {
  const { price, prevPrice, pushPrice } = useThrottledPricePair(THROTTLE_MS);
  const [connected, setConnected] = useState(false);

  const wsRef        = useRef(null);
  const reconnectRef = useRef(null);
  const reconMsRef   = useRef(500);
  const pingRef      = useRef(null);
  const hbRef        = useRef(null);
  const lastMsgRef   = useRef(Date.now());

  function stopPing() { if (pingRef.current) { clearInterval(pingRef.current); pingRef.current = null; } }
  function stopHb()   { if (hbRef.current)   { clearInterval(hbRef.current);  hbRef.current   = null; } }
  function stopAll()  { stopPing(); stopHb(); }

  const connect = useCallback(() => {
    const url = CONFIG.polymarket?.liveDataWsUrl;
    if (!url) return;
    if (wsRef.current && wsRef.current.readyState <= 1) return;

    try {
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        if (IS_DEV) console.log('[Polymarket WS] ✅ Connected');
        setConnected(true);
        reconMsRef.current = 500;
        lastMsgRef.current = Date.now();

        // Ping
        stopPing();
        pingRef.current = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            try { ws.send(JSON.stringify({ action: 'ping' })); } catch (_e) { /* */ }
          }
        }, PING_MS);

        // Heartbeat
        stopHb();
        hbRef.current = setInterval(() => {
          if (Date.now() - lastMsgRef.current > HEARTBEAT_DEAD_MS) {
            if (wsRef.current !== ws) return; // stale — new WS already connected
            console.warn('[Polymarket WS] ⚠️ Silent — forcing reconnect');
            try { ws.close(); } catch (_e) { /* */ }
          }
        }, HEARTBEAT_CHK_MS);

        // Subscribe
        try {
          ws.send(JSON.stringify({
            action: 'subscribe',
            subscriptions: [{ topic: 'crypto_prices_chainlink', type: '*', filters: '' }],
          }));
        } catch (_e) { /* */ }
      };

      ws.onmessage = (evt) => {
        lastMsgRef.current = Date.now();
        try {
          const data = JSON.parse(evt.data);
          if (!data || data.topic !== 'crypto_prices_chainlink') return;
          const payload = typeof data.payload === 'string' ? JSON.parse(data.payload) : data.payload || {};
          const sym = String(payload.symbol || payload.pair || payload.ticker || '').toLowerCase();
          if (!sym.includes('btc')) return;
          const p = Number(payload.value ?? payload.price ?? payload.current ?? payload.data);
          if (!Number.isFinite(p)) return;
          pushPrice(p);   // ← ref only, no re-render
        } catch (_e) { /* */ }
      };

      ws.onclose = (evt) => {
        if (IS_DEV) console.log(`[Polymarket WS] ❌ Disconnected (code: ${evt.code})`);
        if (wsRef.current !== ws) return; // stale close from replaced WS
        setConnected(false);
        wsRef.current = null;
        stopAll();
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
  }, [pushPrice]);

  useEffect(() => {
    const h = () => {
      if (document.visibilityState !== 'visible') return;
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        if (IS_DEV) console.log('[Polymarket WS] 👁️ Tab visible — reconnecting…');
        clearTimeout(reconnectRef.current);
        reconMsRef.current = 500;
        connect();
      } else {
        lastMsgRef.current = Date.now();
      }
    };
    document.addEventListener('visibilitychange', h);
    return () => document.removeEventListener('visibilitychange', h);
  }, [connect]);

  useEffect(() => {
    connect();
    return () => { clearTimeout(reconnectRef.current); stopAll(); try { wsRef.current?.close(); } catch (_e) { /* */ } };
  }, [connect]);

  return { price, prevPrice, connected };
}