/**
 * Authenticated Polymarket CLOB User WebSocket (`wss://ws-subscriptions-clob.polymarket.com/ws/user`).
 *
 * Streams private order lifecycle events (PLACEMENT / UPDATE / CANCELLATION) and
 * trade fills (MATCHED / MINED / CONFIRMED) in real time so live limit orders do not
 * rely solely on REST polling and 8s grace waits. Dormant in DRY_RUN mode unless forced.
 */

import { WebSocket, type RawData } from 'ws';
import { BOT_CONFIG } from '../config.ts';
import { createLogger } from '../logger.ts';
import { pickCredentials } from './polyboltWs.ts';

const log = createLogger('ClobUserWS');

export const CLOB_USER_WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/user';
const PING_INTERVAL_MS = 10_000;
const HEARTBEAT_DEAD_MS = 30_000;
const HEARTBEAT_CHECK_MS = 5_000;
const RECONNECT_MAX_MS = 15_000;
const MAX_TRACKED_ORDERS = 200;
const ALLOWED_TRADE_STATUSES = new Set(['', 'MATCHED', 'MINED', 'CONFIRMED']);

export interface ClobUserOrderState {
  orderId: string;
  status: 'OPEN' | 'PARTIAL' | 'MATCHED' | 'CANCELLED';
  originalSize: number | null;
  sizeMatched: number;
  price: number | null;
  side: string | null;
  assetId: string | null;
  txHash: string | null;
  updatedAt: number;
}

const orderStates = new Map<string, ClobUserOrderState>();
let ws: WebSocket | null = null;
let connected = false;
let lastMsgMs = 0;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let hbTimer: ReturnType<typeof setInterval> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectMs = 500;
let intentionalClose = false;
let forceConnect = false;
let _parseErrors = 0;

function parseNum(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function setOrderState(orderId: string, next: ClobUserOrderState): void {
  if (!orderStates.has(orderId) && orderStates.size >= MAX_TRACKED_ORDERS) {
    const oldest = orderStates.keys().next().value;
    if (oldest !== undefined) orderStates.delete(oldest);
  }
  orderStates.set(orderId, next);
}

function mergeOrderEvent(ev: Record<string, any>, now: number): void {
  const orderId = String(ev.id ?? ev.order_id ?? '').trim();
  if (!orderId) return;

  const prev = orderStates.get(orderId);
  const evType = String(ev.type ?? ev.status ?? '').toUpperCase();
  const parsedOrig = parseNum(ev.original_size ?? ev.size);
  const parsedMatched = parseNum(ev.size_matched);
  const parsedPrice = parseNum(ev.price);

  const originalSize = parsedOrig ?? prev?.originalSize ?? null;
  const sizeMatched = Math.max(prev?.sizeMatched ?? 0, parsedMatched ?? 0);
  const price = parsedPrice ?? prev?.price ?? null;
  const side = (typeof ev.side === 'string' && ev.side) ? ev.side : (prev?.side ?? null);
  const assetId = (typeof ev.asset_id === 'string' && ev.asset_id) ? ev.asset_id : (prev?.assetId ?? null);
  const txHash = (typeof ev.transaction_hash === 'string' && ev.transaction_hash) ? ev.transaction_hash : (prev?.txHash ?? null);

  let status: ClobUserOrderState['status'];
  if (evType === 'CANCELLATION' || evType === 'CANCELLED' || evType === 'CANCELED') {
    status = 'CANCELLED';
  } else if (evType === 'MATCHED' || (originalSize != null && originalSize > 0 && sizeMatched >= originalSize - 1e-6)) {
    status = 'MATCHED';
  } else if (sizeMatched > 0) {
    status = 'PARTIAL';
  } else {
    status = 'OPEN';
  }

  // Never downgrade terminal states back to OPEN/PARTIAL
  if (prev?.status === 'MATCHED') status = 'MATCHED';
  else if (prev?.status === 'CANCELLED' && status === 'OPEN') status = 'CANCELLED';

  setOrderState(orderId, {
    orderId,
    status,
    originalSize,
    sizeMatched,
    price,
    side,
    assetId,
    txHash,
    updatedAt: now,
  });
}

function mergeTradeFill(
  orderId: string,
  matchedAmount: number | null,
  price: number | null,
  side: string | null,
  assetId: string | null,
  txHash: string | null,
  isDirectTaker: boolean,
  now: number,
): void {
  const cleanId = orderId.trim();
  if (!cleanId) return;
  const prev = orderStates.get(cleanId);
  const orig = prev?.originalSize ?? null;
  const inc = matchedAmount != null && matchedAmount > 0 ? matchedAmount : 0;
  const nextMatched = (prev?.sizeMatched ?? 0) + inc;

  let status: ClobUserOrderState['status'];
  if (prev?.status === 'MATCHED') {
    status = 'MATCHED';
  } else if (orig != null && orig > 0) {
    status = nextMatched >= orig - 1e-6 ? 'MATCHED' : 'PARTIAL';
  } else if (isDirectTaker) {
    status = 'MATCHED';
  } else {
    status = nextMatched > 0 ? 'PARTIAL' : (prev?.status ?? 'PARTIAL');
  }

  setOrderState(cleanId, {
    orderId: cleanId,
    status,
    originalSize: orig,
    sizeMatched: nextMatched,
    price: price ?? prev?.price ?? null,
    side: side ?? prev?.side ?? null,
    assetId: assetId ?? prev?.assetId ?? null,
    txHash: txHash ?? prev?.txHash ?? null,
    updatedAt: now,
  });
}

function handleTradeEvent(ev: Record<string, any>, now: number): void {
  const tradeStatus = String(ev.status ?? '').toUpperCase();
  if (!ALLOWED_TRADE_STATUSES.has(tradeStatus)) return;

  const txHash = (typeof ev.transaction_hash === 'string' && ev.transaction_hash) ? ev.transaction_hash : null;
  const assetId = (typeof ev.asset_id === 'string' && ev.asset_id) ? ev.asset_id : null;
  const evPrice = parseNum(ev.price);
  const evSize = parseNum(ev.size);
  const evSide = (typeof ev.side === 'string' && ev.side) ? ev.side : null;

  if (typeof ev.taker_order_id === 'string' && ev.taker_order_id.trim()) {
    mergeTradeFill(ev.taker_order_id, evSize, evPrice, evSide, assetId, txHash, true, now);
  }

  if (Array.isArray(ev.maker_orders)) {
    for (const mo of ev.maker_orders) {
      if (!mo || typeof mo !== 'object') continue;
      const moId = String(mo.order_id ?? mo.id ?? '').trim();
      if (!moId) continue;
      const moAmount = parseNum(mo.matched_amount ?? mo.size);
      const moPrice = parseNum(mo.price) ?? evPrice;
      const moAsset = (typeof mo.asset_id === 'string' && mo.asset_id) ? mo.asset_id : assetId;
      mergeTradeFill(moId, moAmount, moPrice, (typeof mo.side === 'string' && mo.side) ? mo.side : evSide, moAsset, txHash, false, now);
    }
  }
}

/**
 * Ingest a raw frame from the CLOB user WebSocket. Exported for unit testing.
 */
export function ingestClobUserMessage(raw: RawData | string, now = Date.now()): void {
  lastMsgMs = now;
  const text = (typeof raw === 'string' ? raw : raw.toString()).trim();
  if (!text || text === 'PONG' || text === 'pong') return;

  try {
    const parsed = JSON.parse(text);
    const items = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const evType = String(item.event_type ?? '').toLowerCase();
      const rawType = String(item.type ?? '').toUpperCase();
      if (evType === 'order' || rawType === 'PLACEMENT' || rawType === 'UPDATE' || rawType === 'CANCELLATION') {
        mergeOrderEvent(item, now);
      } else if (evType === 'trade') {
        handleTradeEvent(item, now);
      }
    }
  } catch (err: any) {
    _parseErrors++;
    if (_parseErrors === 1 || _parseErrors % 200 === 0) {
      log.debug(`User WS parse error #${_parseErrors}: ${err?.message || err}`);
    }
  }
}

function stopTimers(): void {
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  if (hbTimer) { clearInterval(hbTimer); hbTimer = null; }
}

function scheduleReconnect(): void {
  if (reconnectTimer || intentionalClose) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectClobUserWs({ force: forceConnect });
  }, reconnectMs);
  reconnectMs = Math.min(RECONNECT_MAX_MS, reconnectMs * 2);
}

export function connectClobUserWs(opts?: { force?: boolean }): void {
  if (opts?.force !== undefined) forceConnect = opts.force;
  if (process.env.CLOB_USER_WS_ENABLED === 'false') return;
  if (BOT_CONFIG.dryRun && !forceConnect) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  const creds = pickCredentials();
  if (!creds) {
    log.debug('Skipping CLOB User WS — API credentials missing');
    return;
  }

  intentionalClose = false;
  try {
    const socket = new WebSocket(CLOB_USER_WS_URL);
    ws = socket;

    socket.on('open', () => {
      if (ws !== socket) { try { socket.close(); } catch {} return; }
      try {
        socket.send(JSON.stringify({
          auth: {
            apiKey: creds.apiKey,
            secret: creds.secret,
            passphrase: creds.passphrase,
          },
          type: 'user',
          markets: [],
        }));
      } catch (sendErr: any) {
        log.debug(`User WS auth subscribe failed: ${sendErr?.message || sendErr}`);
        try { socket.close(); } catch {}
        return;
      }

      connected = true;
      reconnectMs = 500;
      lastMsgMs = Date.now();
      log.info('Connected');

      stopTimers();
      pingTimer = setInterval(() => {
        if (ws === socket && socket.readyState === WebSocket.OPEN) {
          try { socket.send('PING'); } catch {}
        }
      }, PING_INTERVAL_MS);

      hbTimer = setInterval(() => {
        if (Date.now() - lastMsgMs > HEARTBEAT_DEAD_MS) {
          log.warn('Silent — forcing reconnect');
          if (ws === socket) { ws = null; connected = false; }
          stopTimers();
          try { socket.close(); } catch {}
          scheduleReconnect();
        }
      }, HEARTBEAT_CHECK_MS);
    });

    socket.on('message', (raw) => {
      ingestClobUserMessage(raw, Date.now());
    });

    socket.on('close', () => {
      if (ws === socket) {
        log.debug('Disconnected');
        connected = false;
        ws = null;
        stopTimers();
      }
      if (!intentionalClose) scheduleReconnect();
    });

    socket.on('error', (err: any) => {
      log.debug(`User WS error: ${err?.message || err}`);
      try { socket.close(); } catch {}
    });
  } catch (connErr: any) {
    log.debug(`User WS connect failed: ${connErr?.message || connErr}`);
    scheduleReconnect();
  }
}

export function disconnectClobUserWs(): void {
  intentionalClose = true;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  stopTimers();
  if (ws) { try { ws.close(); } catch {} ws = null; }
  connected = false;
}

export function isClobUserWsConnected(): boolean {
  return connected;
}

export function getUserOrderEvent(orderId: string | null | undefined): ClobUserOrderState | null {
  if (!orderId) return null;
  return orderStates.get(orderId) ?? null;
}

export function getClobUserWsHealth() {
  return {
    connected,
    lastMsgMs,
    trackedOrders: orderStates.size,
    parseErrors: _parseErrors,
  };
}

export function resetClobUserWsForTest(): void {
  disconnectClobUserWs();
  orderStates.clear();
  lastMsgMs = 0;
  reconnectMs = 500;
  forceConnect = false;
  _parseErrors = 0;
}
