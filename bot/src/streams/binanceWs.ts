/**
 * Binance WebSocket stream for Node.js bot.
 * Real-time BTC mid price via bookTicker (<20ms) + live 1m kline stream
 * maintaining an in-memory 240-candle buffer (eliminates hot-loop REST fetchKlines).
 * Uses `ws` WebSocket client.
 */

import { WebSocket, type RawData } from 'ws';
import { createLogger } from '../logger.ts';

const log = createLogger('BinanceWS');

// stream.binance.com blocked in some regions — vision domain works
const WS_URL = 'wss://data-stream.binance.vision/stream?streams=btcusdt@bookTicker/btcusdt@kline_1m';
const HEARTBEAT_DEAD_MS = 20_000;
const HEARTBEAT_CHECK_MS = 5_000;
const RECONNECT_MAX_MS = 10_000;
const KLINE_BUFFER_LIMIT = 240;
const KLINE_MIN_READY = 120;
const TICK_SAMPLE_MIN_MS = 50;

export interface BinanceKlineBar {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
  takerBuyVolume: number;
}

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectMs = 500;
let hbTimer: ReturnType<typeof setInterval> | null = null;
let lastMsgMs = 0;
let intentionalClose = false; // H4: Prevent zombie reconnect on shutdown
let _parseErrors = 0;

// Public state — read by loop.ts
let _price: number | null = null;
let _prevPrice: number | null = null;
let _connected = false;

// In-memory 1m klines seeded via REST once at startup / reconnect and updated live via WS
let _klines1m: BinanceKlineBar[] = [];
let _lastKlineMsgMs = 0;
let _lastSeedMs = 0;
let _klinesNeedResync = true;
let _lastSampledTickMs = 0;

const TICK_BUFFER_KEEP_MS = 15_000;
const _recentTicks: Array<{ t: number; p: number }> = [];

export interface BinancePriceWindow {
  deltaUsd: number;
  deltaPct: number;
  tickCount: number;
  oldestPrice: number | null;
  latestPrice: number | null;
  windowSpanMs: number;
}

function pushPriceTick(price: number, ts: number) {
  _recentTicks.push({ t: ts, p: price });
  const cutoff = ts - TICK_BUFFER_KEEP_MS;
  while (_recentTicks.length > 1 && _recentTicks[0].t < cutoff) {
    _recentTicks.shift();
  }
}

function upsertKline1m(bar: BinanceKlineBar): void {
  if (_klines1m.length === 0) {
    _klines1m.push(bar);
    return;
  }
  const last = _klines1m[_klines1m.length - 1];
  if (bar.openTime === last.openTime) {
    _klines1m[_klines1m.length - 1] = bar;
  } else if (bar.openTime === last.openTime + 60_000) {
    _klines1m.push(bar);
    if (_klines1m.length > KLINE_BUFFER_LIMIT) _klines1m.shift();
  } else if (bar.openTime > last.openTime + 60_000) {
    _klines1m.push(bar);
    if (_klines1m.length > KLINE_BUFFER_LIMIT) {
      _klines1m.splice(0, _klines1m.length - KLINE_BUFFER_LIMIT);
    }
    _klinesNeedResync = true;
  }
}

export function getPrice() { return _price; }
export function getPrevPrice() { return _prevPrice; }
export function isConnected() { return _connected; }
/** Audit fix H: Expose last message timestamp for staleness check in loop.ts */
export function getLastMsgTime() { return lastMsgMs; }
export function getLastKlineMsgTime() { return _lastKlineMsgMs; }

/** Return a shallow copy of the in-memory 1m kline buffer if enough bars are ready. */
export function getKlines1m(): BinanceKlineBar[] | null {
  return _klines1m.length >= KLINE_MIN_READY ? _klines1m.slice() : null;
}

/** Whether 1m klines need a REST backfill (cold buffer, WS reconnect/gap, or stale kline stream). */
export function needsKlinesResync(now = Date.now(), maxStaleMs = 15_000): boolean {
  if (_klines1m.length < KLINE_MIN_READY || _klinesNeedResync || !_connected) return true;
  const refMs = _lastKlineMsgMs > 0 ? _lastKlineMsgMs : _lastSeedMs;
  return refMs <= 0 || (now - refMs) >= maxStaleMs;
}

/**
 * Seed the in-memory 1m kline ring buffer from a REST fetchKlines snapshot.
 * Preserves a newer or higher-volume forming candle received live from WS.
 */
export function seedKlines1m(bars: ReadonlyArray<BinanceKlineBar>, now = Date.now()): void {
  if (!Array.isArray(bars) || bars.length === 0) return;
  const byOpenTime = new Map<number, BinanceKlineBar>();
  for (const b of bars) {
    if (
      !b ||
      !Number.isFinite(b.openTime) || !Number.isFinite(b.closeTime) ||
      !Number.isFinite(b.open) || b.open <= 0 ||
      !Number.isFinite(b.high) || !Number.isFinite(b.low) || b.high < b.low ||
      !Number.isFinite(b.close) || b.close <= 0 ||
      !Number.isFinite(b.volume) || b.volume < 0
    ) {
      continue;
    }
    byOpenTime.set(b.openTime, {
      openTime: b.openTime,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.volume,
      closeTime: b.closeTime,
      takerBuyVolume: Number.isFinite(b.takerBuyVolume) && b.takerBuyVolume >= 0 ? b.takerBuyVolume : 0,
    });
  }
  if (byOpenTime.size === 0) return;

  const prevLast = _klines1m[_klines1m.length - 1];
  const next = Array.from(byOpenTime.values()).sort((a, b) => a.openTime - b.openTime);
  if (next.length > KLINE_BUFFER_LIMIT) {
    next.splice(0, next.length - KLINE_BUFFER_LIMIT);
  }

  if (prevLast && next.length > 0) {
    const seededLast = next[next.length - 1];
    if (prevLast.openTime === seededLast.openTime && prevLast.volume >= seededLast.volume) {
      next[next.length - 1] = prevLast;
    } else if (prevLast.openTime === seededLast.openTime + 60_000) {
      next.push(prevLast);
      if (next.length > KLINE_BUFFER_LIMIT) next.shift();
    }
  }

  _klines1m = next;
  _klinesNeedResync = false;
  _lastSeedMs = now;
}

/**
 * Process a raw Binance WS frame (combined stream wrapper or raw stream payload).
 * Exported for deterministic unit testing.
 */
export function ingestBinanceMessage(raw: RawData | string, now = Date.now()): void {
  lastMsgMs = now;
  try {
    const text = typeof raw === 'string' ? raw : raw.toString();
    const parsed = JSON.parse(text);
    const payload = (
      parsed &&
      typeof parsed === 'object' &&
      'data' in parsed &&
      parsed.data &&
      typeof parsed.data === 'object'
    ) ? parsed.data : parsed;

    if (!payload || typeof payload !== 'object') return;

    if (payload.e !== 'kline' && payload.b != null && payload.a != null) {
      const bid = Number(payload.b);
      const ask = Number(payload.a);
      if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 10_000 && ask >= bid && ask < 500_000) {
        const mid = (bid + ask) / 2;
        _prevPrice = _price;
        _price = mid;
        if (_recentTicks.length === 0 || now - _lastSampledTickMs >= TICK_SAMPLE_MIN_MS || now < _lastSampledTickMs) {
          pushPriceTick(mid, now);
          _lastSampledTickMs = now;
        }
      }
      return;
    }

    if (payload.e === 'kline' && payload.k && payload.k.i === '1m') {
      const k = payload.k;
      const openTime = Number(k.t);
      const open = Number(k.o);
      const high = Number(k.h);
      const low = Number(k.l);
      const close = Number(k.c);
      const volume = Number(k.v);
      const closeTime = Number(k.T);
      const takerBuyVolume = Number(k.V);
      if (
        Number.isFinite(openTime) && Number.isFinite(closeTime) &&
        open > 10_000 && close > 10_000 && close < 500_000 &&
        Number.isFinite(high) && Number.isFinite(low) && high >= low &&
        Number.isFinite(volume) && volume >= 0 &&
        Number.isFinite(takerBuyVolume) && takerBuyVolume >= 0
      ) {
        _lastKlineMsgMs = now;
        upsertKline1m({ openTime, open, high, low, close, volume, closeTime, takerBuyVolume });
        if (_price == null) _price = close;
      }
      return;
    }

    if (payload.c != null && payload.e !== 'kline') {
      const p = Number(payload.c);
      if (Number.isFinite(p) && p > 10_000 && p < 500_000) {
        _prevPrice = _price;
        _price = p;
        pushPriceTick(p, now);
      }
    }
  } catch (err: any) {
    _parseErrors++;
    if (_parseErrors === 1 || _parseErrors % 500 === 0) {
      log.debug(`WS parse error #${_parseErrors}: ${err?.message || err}`);
    }
  }
}

/**
 * Compute BTC price delta over a short millisecond lookback (default 3s) from live WS ticks.
 * Used by leadLagImpulse detection in signalComputation.ts.
 */
export function getRecentPriceWindow(windowMs = 3_000, now = Date.now()): BinancePriceWindow {
  const cutoff = now - windowMs;
  const slice = _recentTicks.filter((pt) => pt.t >= cutoff && pt.t <= now + 500);
  if (slice.length < 2) {
    const only = slice[slice.length - 1] ?? null;
    return {
      deltaUsd: 0,
      deltaPct: 0,
      tickCount: slice.length,
      oldestPrice: only?.p ?? null,
      latestPrice: only?.p ?? null,
      windowSpanMs: 0,
    };
  }
  const oldest = slice[0];
  const latest = slice[slice.length - 1];
  const deltaUsd = latest.p - oldest.p;
  const deltaPct = oldest.p > 0 ? (deltaUsd / oldest.p) * 100 : 0;
  return {
    deltaUsd,
    deltaPct,
    tickCount: slice.length,
    oldestPrice: oldest.p,
    latestPrice: latest.p,
    windowSpanMs: Math.max(0, latest.t - oldest.t),
  };
}

/** Deterministic helpers for unit tests. */
export function recordBinanceTickForTest(price: number, ts = Date.now()): void {
  if (Number.isFinite(price) && price > 0) {
    pushPriceTick(price, ts);
  }
}

export function clearBinanceTicksForTest(): void {
  _recentTicks.length = 0;
  _lastSampledTickMs = 0;
}

export function resetBinanceKlinesForTest(): void {
  _klines1m = [];
  _lastKlineMsgMs = 0;
  _lastSeedMs = 0;
  _klinesNeedResync = true;
  _price = null;
  _prevPrice = null;
  _connected = false;
  lastMsgMs = 0;
  _parseErrors = 0;
  clearBinanceTicksForTest();
}

export function setBinanceConnectedForTest(connected: boolean): void {
  _connected = connected;
}

function stopHb() {
  if (hbTimer) { clearInterval(hbTimer); hbTimer = null; }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, reconnectMs);
  reconnectMs = Math.min(RECONNECT_MAX_MS, reconnectMs * 2);
}

export function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  intentionalClose = false; // L: Reset before attempt — prevents stuck flag after disconnect+failed connect

  try {
    const socket = new WebSocket(WS_URL);
    ws = socket;

    socket.on('open', () => {
      // Stale socket guard
      if (ws !== socket) { try { socket.close(); } catch {} return; }

      log.info('Connected');
      _connected = true;
      _klinesNeedResync = true;
      reconnectMs = 500;
      lastMsgMs = Date.now();

      stopHb();
      hbTimer = setInterval(() => {
        if (Date.now() - lastMsgMs > HEARTBEAT_DEAD_MS) {
          log.warn('Silent — forcing reconnect');
          if (ws === socket) { ws = null; _connected = false; }
          stopHb();
          try { socket.close(); } catch {}
          scheduleReconnect();
        }
      }, HEARTBEAT_CHECK_MS);
    });

    socket.on('message', (raw) => {
      ingestBinanceMessage(raw, Date.now());
    });

    socket.on('close', () => {
      if (ws === socket) {
        log.debug('Disconnected');
        _connected = false;
        ws = null;
        stopHb();
      }
      // H4: Don't reconnect if disconnect() was called intentionally
      if (!intentionalClose) scheduleReconnect();
    });

    socket.on('error', (err) => {
      log.debug(`WS error: ${err?.message || err}`);
      try { socket.close(); } catch {}
    });
  } catch (connErr: any) {
    log.debug(`Connect failed: ${connErr?.message || connErr}`);
    scheduleReconnect();
  }
}

export function disconnect() {
  intentionalClose = true; // H4: Signal to close handler not to reconnect
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  stopHb();
  if (ws) { try { ws.close(); } catch {} ws = null; }
  _connected = false;
}
