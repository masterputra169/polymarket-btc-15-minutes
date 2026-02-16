import { useState, useEffect, useRef, useCallback } from 'react';
import { CONFIG, WS_DEFAULTS, WS_CHAINLINK } from '../config.js';
import { useThrottledPricePair } from './useThrottledState.js';

/**
 * ═══ Chainlink Direct WSS Stream — v4 (JSON-RPC 2.0) ═══
 * M5: Uses eth_call with latestRoundData() selector over WSS.
 * Fixed: config key polygonWssUrls (was wssUrl which doesn't exist).
 */

const POLL_MS           = WS_CHAINLINK.pingMs;            // 15s — reuse as poll interval
const HEARTBEAT_DEAD_MS = WS_CHAINLINK.heartbeatDeadMs;
const HEARTBEAT_CHK_MS  = WS_DEFAULTS.heartbeatCheckMs;
const RECONNECT_MAX_MS  = WS_DEFAULTS.reconnectMaxMs;
const THROTTLE_MS       = WS_DEFAULTS.throttleMs;

const IS_DEV = typeof process !== 'undefined' && process.env?.NODE_ENV === 'development';

// M5: latestRoundData() selector for JSON-RPC 2.0
const LATEST_ROUND_DATA_SELECTOR = '0xfeaf968c';
const AGGREGATOR = CONFIG.chainlink?.btcUsdAggregator ?? '';
const DECIMALS = CONFIG.chainlink?.decimals ?? 8;

/**
 * Parse latestRoundData() hex response.
 * answer is at offset 64..128 (2nd 32-byte word).
 */
function parseLatestRoundData(hex) {
  if (!hex || hex.length < 320) return null;
  const answerHex = hex.slice(64, 128);
  let answer = BigInt('0x' + answerHex);
  if (answer >= (1n << 255n)) answer = answer - (1n << 256n);
  return Number(answer) / (10 ** DECIMALS);
}

export function useChainlinkWssStream() {
  const { price, prevPrice, pushPrice } = useThrottledPricePair(THROTTLE_MS);
  const [connected, setConnected] = useState(false);

  const wsRef        = useRef(null);
  const reconnectRef = useRef(null);
  const reconMsRef   = useRef(1000);
  const pollRef      = useRef(null);
  const hbRef        = useRef(null);
  const lastDataRef  = useRef(Date.now());   // M5: Track data freshness, not any message
  const rpcIdRef     = useRef(1);

  function stopPoll() { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } }
  function stopHb()   { if (hbRef.current)   { clearInterval(hbRef.current);  hbRef.current   = null; } }
  function stopAll()  { stopPoll(); stopHb(); }

  const sendEthCall = useCallback((ws) => {
    if (!AGGREGATOR || !ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify({
        jsonrpc: '2.0',
        id: rpcIdRef.current++,
        method: 'eth_call',
        params: [{ to: AGGREGATOR, data: LATEST_ROUND_DATA_SELECTOR }, 'latest'],
      }));
    } catch (_e) { /* */ }
  }, []);

  const connect = useCallback(() => {
    // M5: Fix config key — was CONFIG.chainlink?.wssUrl (doesn't exist)
    const url = CONFIG.chainlink?.polygonWssUrls?.[0];
    if (!url) return;
    if (wsRef.current && wsRef.current.readyState <= 1) return;

    try {
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        if (IS_DEV) console.log('[Chainlink WSS] Connected');
        setConnected(true);
        reconMsRef.current = 1000;
        lastDataRef.current = Date.now();

        // M5: Poll latestRoundData() immediately and every POLL_MS
        sendEthCall(ws);
        stopPoll();
        pollRef.current = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) sendEthCall(ws);
        }, POLL_MS);

        // Heartbeat: check data freshness
        stopHb();
        hbRef.current = setInterval(() => {
          if (Date.now() - lastDataRef.current > HEARTBEAT_DEAD_MS) {
            if (wsRef.current !== ws) return;
            console.warn('[Chainlink WSS] Silent — forcing reconnect');
            try { ws.close(); } catch (_e) { /* */ }
          }
        }, HEARTBEAT_CHK_MS);
      };

      ws.onmessage = (evt) => {
        try {
          const data = JSON.parse(evt.data);

          // M5: Parse JSON-RPC 2.0 response from eth_call
          if (data.result && typeof data.result === 'string' && data.result.startsWith('0x')) {
            const hex = data.result.slice(2);
            const p = parseLatestRoundData(hex);
            if (p !== null && Number.isFinite(p) && p > 10_000 && p < 500_000) {
              pushPrice(p);
              lastDataRef.current = Date.now();
            }
          }
          // Ignore RPC errors silently — heartbeat handles staleness
        } catch (_e) { /* */ }
      };

      ws.onclose = (evt) => {
        if (IS_DEV) console.log(`[Chainlink WSS] Disconnected (code: ${evt.code})`);
        if (wsRef.current !== ws) return;
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
  }, [pushPrice, sendEthCall]);

  useEffect(() => {
    const h = () => {
      if (document.visibilityState !== 'visible') return;
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        if (IS_DEV) console.log('[Chainlink WSS] Tab visible — reconnecting…');
        clearTimeout(reconnectRef.current);
        reconMsRef.current = 1000;
        connect();
      } else {
        lastDataRef.current = Date.now();
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
