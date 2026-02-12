import { useState, useEffect, useRef, useCallback } from 'react';
import { CONFIG, WS_DEFAULTS, WS_BINANCE } from '../config.js';
import { useThrottledPricePair } from './useThrottledState.js';

/**
 * ═══ Binance WebSocket Stream — v3 (Memory Optimized) ═══
 */

const HEARTBEAT_DEAD_MS = WS_BINANCE.heartbeatDeadMs;
const HEARTBEAT_CHK_MS  = WS_BINANCE.heartbeatCheckMs;
const RECONNECT_MAX_MS  = WS_DEFAULTS.reconnectMaxMs;
const THROTTLE_MS       = WS_DEFAULTS.throttleMs;

const IS_DEV = typeof process !== 'undefined' && process.env?.NODE_ENV === 'development';

export function useBinanceStream() {
  const { price, prevPrice, pushPrice } = useThrottledPricePair(THROTTLE_MS);
  const [connected, setConnected] = useState(false);

  const wsRef        = useRef(null);
  const reconnectRef = useRef(null);
  const reconMsRef   = useRef(500);
  const hbRef        = useRef(null);
  const lastMsgRef   = useRef(Date.now());

  function stopHb() { if (hbRef.current) { clearInterval(hbRef.current); hbRef.current = null; } }

  const connect = useCallback(() => {
    const symbol = (CONFIG.binance?.symbol || 'btcusdt').toLowerCase();
    const url = `wss://stream.binance.com:9443/ws/${symbol}@miniTicker`;
    if (wsRef.current && wsRef.current.readyState <= 1) return;

    try {
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        if (IS_DEV) console.log('[Binance WS] ✅ Connected');
        setConnected(true);
        reconMsRef.current = 500;
        lastMsgRef.current = Date.now();

        stopHb();
        hbRef.current = setInterval(() => {
          if (Date.now() - lastMsgRef.current > HEARTBEAT_DEAD_MS) {
            console.warn('[Binance WS] ⚠️ Silent — forcing reconnect');
            try { ws.close(); } catch (_e) { /* */ }
          }
        }, HEARTBEAT_CHK_MS);
      };

      ws.onmessage = (evt) => {
        lastMsgRef.current = Date.now();
        try {
          const data = JSON.parse(evt.data);
          const p = Number(data.c);
          if (Number.isFinite(p) && p > 0) {
            pushPrice(p);   // ← writes to ref only, no re-render
          }
        } catch (_e) { /* */ }
      };

      ws.onclose = (evt) => {
        if (IS_DEV) console.log(`[Binance WS] ❌ Disconnected (code: ${evt.code})`);
        setConnected(false);
        wsRef.current = null;
        stopHb();
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
        if (IS_DEV) console.log('[Binance WS] 👁️ Tab visible — reconnecting…');
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
    return () => { clearTimeout(reconnectRef.current); stopHb(); try { wsRef.current?.close(); } catch (_e) { /* */ } };
  }, [connect]);

  return { price, prevPrice, connected };
}