import { useState, useEffect, useRef, useCallback } from 'react';
import { CONFIG, WS_DEFAULTS, WS_CHAINLINK } from '../config.js';
import { useThrottledPricePair } from './useThrottledState.js';

/**
 * ═══ Chainlink Direct WSS Stream — v3 (Memory Optimized) ═══
 */

const PING_MS           = WS_CHAINLINK.pingMs;
const HEARTBEAT_DEAD_MS = WS_CHAINLINK.heartbeatDeadMs;
const HEARTBEAT_CHK_MS  = WS_DEFAULTS.heartbeatCheckMs;
const RECONNECT_MAX_MS  = WS_DEFAULTS.reconnectMaxMs;
const THROTTLE_MS       = WS_DEFAULTS.throttleMs;

const IS_DEV = typeof process !== 'undefined' && process.env?.NODE_ENV === 'development';

export function useChainlinkWssStream() {
  const { price, prevPrice, pushPrice } = useThrottledPricePair(THROTTLE_MS);
  const [connected, setConnected] = useState(false);

  const wsRef        = useRef(null);
  const reconnectRef = useRef(null);
  const reconMsRef   = useRef(1000);
  const pingRef      = useRef(null);
  const hbRef        = useRef(null);
  const lastMsgRef   = useRef(Date.now());

  function stopPing() { if (pingRef.current) { clearInterval(pingRef.current); pingRef.current = null; } }
  function stopHb()   { if (hbRef.current)   { clearInterval(hbRef.current);  hbRef.current   = null; } }
  function stopAll()  { stopPing(); stopHb(); }

  const connect = useCallback(() => {
    const url = CONFIG.chainlink?.wssUrl;
    if (!url) return;
    if (wsRef.current && wsRef.current.readyState <= 1) return;

    try {
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        if (IS_DEV) console.log('[Chainlink WSS] ✅ Connected');
        setConnected(true);
        reconMsRef.current = 1000;
        lastMsgRef.current = Date.now();

        stopPing();
        pingRef.current = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            try { ws.send(JSON.stringify({ type: 'ping' })); } catch (_e) { /* */ }
          }
        }, PING_MS);

        stopHb();
        hbRef.current = setInterval(() => {
          if (Date.now() - lastMsgRef.current > HEARTBEAT_DEAD_MS) {
            console.warn('[Chainlink WSS] ⚠️ Silent — forcing reconnect');
            try { ws.close(); } catch (_e) { /* */ }
          }
        }, HEARTBEAT_CHK_MS);

        try { ws.send(JSON.stringify({ type: 'subscribe', feed: 'BTC/USD' })); } catch (_e) { /* */ }
      };

      ws.onmessage = (evt) => {
        lastMsgRef.current = Date.now();
        try {
          const data = JSON.parse(evt.data);
          let p = null;

          if (data.answer !== undefined) {
            p = Number(data.answer);
            if (data.decimals) p = p / Math.pow(10, Number(data.decimals));
          } else if (data.price !== undefined) {
            p = Number(data.price);
          } else if (data.result !== undefined) {
            p = Number(data.result);
          } else if (data.data?.price !== undefined) {
            p = Number(data.data.price);
          } else if (data.params?.result?.answer !== undefined) {
            p = Number(BigInt(data.params.result.answer)) / 1e8;
          }

          if (p !== null && Number.isFinite(p) && p > 0) {
            pushPrice(p);   // ← ref only
          }
        } catch (_e) { /* */ }
      };

      ws.onclose = (evt) => {
        if (IS_DEV) console.log(`[Chainlink WSS] ❌ Disconnected (code: ${evt.code})`);
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
        if (IS_DEV) console.log('[Chainlink WSS] 👁️ Tab visible — reconnecting…');
        clearTimeout(reconnectRef.current);
        reconMsRef.current = 1000;
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