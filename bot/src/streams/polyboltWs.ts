/**
 * PolyBolt (ws-live-v2) reference-price feed — the replacement for RTDS price topics.
 *
 * Polymarket's docs moved prices from RTDS (`ws-live-data.polymarket.com`, topics
 * `crypto_prices_*`) to PolyBolt (`wss://ws-live-v2.polymarket.com/ws`, channels
 * `price.*`). RTDS price topics are deprecated — removal expected ~2026-10-23.
 * The series this bot lives on maps 1:1:
 *
 *   RTDS crypto_prices_twap_sixty {"symbol":"btc/usd"}
 *     -> price.crypto.twap {"symbol":"btcusd","window_seconds":60}    (Chainlink)
 *   RTDS crypto_prices_chainlink {"symbol":"btc/usd"}
 *     -> price.crypto      {"symbol":"btcusd","provider":"chainlink"} (Chainlink; Pyth
 *        is only an optional pin — every crypto symbol defaults to Chainlink)
 *
 * Verified live on 2026-10-19 against RTDS: both channels delivered identical
 * values for every overlapping second (TWAP 87/87 and spot 88/88 exact matches),
 * and the TWAP snapshot on subscribe carried ~117 points (the documented
 * preceding two minutes).
 *
 * Protocol (docs.polymarket.com/api-reference/wss/polybolt):
 *  - gate: every price channel needs CLOB L2 API credentials
 *    (apiKey/secret/passphrase — the bot's POLYMARKET_API_KEY/SECRET/PASSPHRASE);
 *  - send {"op":"auth","auth":{...}}, wait for {"op":"authed"}, then
 *    {"op":"subscribe","subscriptions":[{"channel","filter"}]};
 *  - frames are {"v":1,"channel","seq","ts","snapshot"?,"dropped"?,"payload"};
 *    a new subscription gets ONE snapshot with the preceding two minutes, then
 *    live points; seq is dense per channel and resets on reconnect;
 *  - the server sends WebSocket pings every 25 s (the ws client answers); a
 *    text PING like RTDS's is not needed. {"op":"ping"} is optional;
 *  - limits: 64 subscriptions, 20 subscribe frames/s, 64 KB frames, 8 auth
 *    frames; breaches close 4008. Close codes: 4001 auth, 4002 slow consumer,
 *    4003 draining (reconnect after 0-10 s jitter), 4008 policy;
 *  - the payload names its vendor in source. Prefer the exact decimal
 *    full_accuracy_value over the float value.
 *
 * Ticks are keyed by the timestamp the SOURCE put on them (whole seconds, ms in
 * the frame), not by arrival: the price to beat is "the TWAP stamped at second
 * T", and these frames arrive ~1 s after T. A missed second is recovered by a
 * reconnect — a fresh subscription replays the preceding two minutes — which is
 * what replay() does.
 *
 * Every public call is total: a bad frame is counted, never thrown.
 */

import { WebSocket } from 'ws';
import { createLogger } from '../logger.ts';
import { TickStore, type Tick } from './tickStore.ts';

export const POLYBOLT_DEFAULT_URL = 'wss://ws-live-v2.polymarket.com/ws';
export const POLYBOLT_TWAP_CHANNEL = 'price.crypto.twap';
export const POLYBOLT_CRYPTO_CHANNEL = 'price.crypto';

/** Minimum gap between replay() reconnects: each one re-authenticates the socket. */
export const POLYBOLT_REPLAY_MIN_GAP_MS = 20_000;

export type TwapFeedMode = 'polybolt' | 'rtds';

export interface PolyBoltCredentials {
  apiKey: string;
  secret: string;
  passphrase: string;
}

export interface PolyBoltSubscription {
  channel: string;
  filter: Record<string, unknown>;
}

export type PolyBoltAuthState = 'missing' | 'pending' | 'ok' | 'invalid' | 'unavailable';

export interface PolyBoltHealth {
  connected: boolean;
  authenticated: boolean;
  subscribed: boolean;
  authState: PolyBoltAuthState;
  /** Live ticks held in the store (not the cumulative count). */
  ticks: number;
  lastTick: Tick | null;
  /** Local ms the last tick-bearing frame arrived. */
  lastTickRecvMs: number;
  /** Local ms any frame arrived (acks and pongs included). */
  lastFrameRecvMs: number;
  reconnects: number;
  parseErrors: number;
  authErrors: number;
  policyErrors: number;
  /** Frames missed on this channel/connection, from the server's dense seq. */
  seqGaps: number;
  /** dropped counters reported by the server (slow consumer). */
  droppedFrames: number;
  lastSeq: number | null;
  snapshotPoints: number;
  source: string | null;
  provider: string | null;
  lastCloseCode: number | null;
}

export interface PolyBoltFeed {
  start(): void;
  stop(): void;
  /** Reconnect now so the new subscription's 2-minute snapshot fills a missed second. Rate-limited. */
  replay(reason: string): void;
  at(ts: number): number | null;
  latest(): Tick | null;
  between(from: number, to: number): Tick[];
  health(): PolyBoltHealth;
}

export interface PolyBoltFeedOptions {
  /** Logger tag, e.g. "TWAP" or "SPOT". */
  name: string;
  channel: string;
  filter: Record<string, unknown>;
  keepMs?: number;
  url?: string;
  now?: () => number;
  random?: () => number;
  /** Test seam: defaults to the CLOB L2 credentials read from process.env. */
  credentials?: () => PolyBoltCredentials | null;
  /** Test seam: builds the socket. */
  makeSocket?: (url: string) => WebSocket;
}

export interface PolyBoltDataFrame {
  ticks: Tick[];
  source: string | null;
  snapshot: boolean;
  seq: number | null;
  dropped: number;
}

// ── Pure helpers (exported for tests) ───────────────────────────────────────

/** CLOB L2 credential trio from env. Never logged. */
export function pickCredentials(env: NodeJS.ProcessEnv = process.env): PolyBoltCredentials | null {
  const apiKey = String(env.POLYMARKET_API_KEY ?? '').trim();
  const secret = String(env.POLYMARKET_API_SECRET ?? '').trim();
  const passphrase = String(env.POLYMARKET_API_PASSPHRASE ?? '').trim();
  if (!apiKey || !secret || !passphrase) return null;
  return { apiKey, secret, passphrase };
}

/**
 * Which TWAP feed runs: TWAP_FEED=polybolt|rtds. Unset/auto -> polybolt when
 * CLOB credentials exist, rtds otherwise (a bot with no credentials cannot
 * authenticate to PolyBolt). An explicit polybolt is honoured even without
 * credentials — chainlinkTwap.ts keeps the RTDS feed as a shadow fallback, so
 * the price to beat survives a bad auth.
 */
export function resolveTwapFeedMode(env: NodeJS.ProcessEnv = process.env): TwapFeedMode {
  const raw = String(env.TWAP_FEED ?? '').trim().toLowerCase();
  if (raw === 'rtds') return 'rtds';
  if (raw === 'polybolt') return 'polybolt';
  return pickCredentials(env) ? 'polybolt' : 'rtds';
}

/** In polybolt mode the RTDS feed stays connected as a fallback unless POLYBOLT_RTDS_FALLBACK=off. */
export function rtdsFallbackEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = String(env.POLYBOLT_RTDS_FALLBACK ?? '').trim().toLowerCase();
  return !(raw === 'off' || raw === 'false' || raw === '0' || raw === 'no');
}

export function buildAuthFrame(creds: PolyBoltCredentials, rid = 'a1'): Record<string, unknown> {
  return {
    op: 'auth',
    rid,
    auth: { apiKey: creds.apiKey, secret: creds.secret, passphrase: creds.passphrase },
  };
}

export function buildSubscribeFrame(subscriptions: PolyBoltSubscription[], rid = 's1'): Record<string, unknown> {
  return {
    op: 'subscribe',
    rid,
    subscriptions: subscriptions.map(s => ({ channel: s.channel, filter: s.filter })),
  };
}

/**
 * Snap a source timestamp to the whole second it describes. Chainlink stamps
 * whole seconds (delivered ~1 s later); the snap only guards against a future
 * format switch to true millisecond event times.
 */
export function normalizeTickTs(ts: number): number {
  return Math.round(ts / 1000) * 1000;
}

function pointPrice(r: any): number {
  const full = r?.full_accuracy_value;
  const exact = full != null && String(full).trim() !== '' ? Number(full) : NaN;
  if (Number.isFinite(exact) && exact > 0) return exact;
  return Number(r?.value ?? NaN);
}

/**
 * Parse one PolyBolt data envelope into ticks for expected, or null when the
 * frame is not data for this channel. Acknowledgements return null too.
 * Handles both shapes: a snapshot {symbol, source, data:[{timestamp,value,...}]}
 * and a live point {symbol, source, value, timestamp, ...}.
 */
export function extractPolyBoltTicks(msg: any, expected: { channel: string; symbol: string }): PolyBoltDataFrame | null {
  if (!msg || typeof msg !== 'object') return null;
  if (msg.op) return null; // ack / error / pong frame
  if (msg.channel !== expected.channel) return null;
  const p = msg.payload;
  if (!p || typeof p !== 'object') return null;
  const sym = p.symbol != null ? String(p.symbol).toLowerCase() : '';
  if (sym && sym !== expected.symbol) return null; // another symbol on a batch subscription
  const rows: any[] = Array.isArray(p.data) ? p.data : [p];
  const ticks: Tick[] = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const rawTs = Number(r.timestamp);
    const value = pointPrice(r);
    if (!Number.isFinite(rawTs) || rawTs <= 0 || !Number.isFinite(value) || value <= 0) continue;
    ticks.push({ ts: normalizeTickTs(rawTs), value });
  }
  const seq = Number(msg.seq);
  const dropped = Number(msg.dropped);
  return {
    ticks,
    source: p.source != null ? String(p.source) : null,
    snapshot: msg.snapshot === true,
    seq: Number.isFinite(seq) ? seq : null,
    dropped: Number.isFinite(dropped) && dropped > 0 ? dropped : 0,
  };
}

/** Exponential backoff with full jitter, 1 s base capped at 30 s (the docs' 1006 recipe). */
export function backoffDelayMs(attempt: number, random: () => number = Math.random): number {
  const cap = Math.min(30_000, 1_000 * 2 ** Math.min(8, Math.max(0, attempt)));
  return Math.max(250, Math.round(random() * cap));
}

// ── Feed ────────────────────────────────────────────────────────────────────

const AUTH_TIMEOUT_MS = 10_000;
const SUBSCRIBE_TIMEOUT_MS = 20_000;
const STALL_MS = 30_000;
const SUPERVISION_MS = 5_000;
/** After this many stalled reconnects, treat the channel as retired/blocked and back off. */
const STALL_BACKOFF_AFTER = 3;
const AUTH_INVALID_BACKOFF_MS = 5 * 60_000;
const POLICY_BACKOFF_MS = 60_000;

export function createPolyBoltFeed(opts: PolyBoltFeedOptions): PolyBoltFeed {
  const url = opts.url ?? POLYBOLT_DEFAULT_URL;
  const now = opts.now ?? Date.now;
  const random = opts.random ?? Math.random;
  const makeSocket = opts.makeSocket ?? ((u: string) => new WebSocket(u));
  const log = createLogger('PolyBolt:' + opts.name);
  const store = new TickStore(opts.keepMs ?? 20 * 60_000);
  const expected = { channel: opts.channel, symbol: String(opts.filter.symbol ?? '').toLowerCase() };

  let ws: WebSocket | null = null;
  let running = false;
  let connected = false;
  let authenticated = false;
  let subscribed = false;
  let authState: PolyBoltAuthState = 'missing';
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let timers: ReturnType<typeof setInterval>[] = [];
  let opens = 0;
  let reconnects = 0;
  let backoffAttempt = 0;
  let parseErrors = 0;
  let authErrors = 0;
  let policyErrors = 0;
  let seqGaps = 0;
  let droppedFrames = 0;
  let lastSeq: number | null = null;
  let snapshotPoints = 0;
  let source: string | null = null;
  let provider: string | null = null;
  let lastTickRecvMs = 0;
  let lastFrameRecvMs = 0;
  let lastCloseCode: number | null = null;
  let lastReplayMs = 0;
  let stallStreak = 0;
  let credsCache: PolyBoltCredentials | null = null;

  const clearTimers = () => {
    for (const t of timers) clearInterval(t);
    timers = [];
  };

  const drop = (socket: WebSocket | null) => {
    if (!socket) return;
    try { socket.removeAllListeners(); } catch { /* already gone */ }
    try { socket.terminate(); } catch { /* already gone */ }
  };

  const scheduleReconnect = (delayMs: number, why: string) => {
    if (!running || reconnectTimer) return;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; open(); }, Math.max(0, delayMs));
    reconnectTimer.unref?.();
    if (why !== 'backoff') log.debug(expected.channel + ': reconnecting in ' + Math.max(0, Math.round(delayMs)) + 'ms (' + why + ')');
  };

  const scheduleBackoff = () => {
    const delay = backoffDelayMs(backoffAttempt, random);
    if (backoffAttempt < 8) backoffAttempt++;
    scheduleReconnect(delay, 'backoff');
  };

  const countParseError = (why: string) => {
    parseErrors++;
    if (parseErrors === 1 || parseErrors % 500 === 0) log.debug(expected.channel + ': unparsable frame #' + parseErrors + ' (' + why + ')');
  };

  function sendAuth(): void {
    const socket = ws;
    if (!socket || !credsCache) return;
    try {
      socket.send(JSON.stringify(buildAuthFrame(credsCache)));
    } catch (err) {
      log.warn(expected.channel + ': auth send failed: ' + ((err as Error)?.message ?? err));
      forceReconnect(undefined, 'auth send failed');
    }
  }

  function sendSubscribe(): void {
    const socket = ws;
    if (!socket) return;
    try {
      socket.send(JSON.stringify(buildSubscribeFrame([{ channel: opts.channel, filter: opts.filter }])));
    } catch (err) {
      log.warn(expected.channel + ': subscribe send failed: ' + ((err as Error)?.message ?? err));
      forceReconnect(undefined, 'subscribe send failed');
    }
  }

  function onAck(msg: any): void {
    const rid = msg.rid != null ? ' rid=' + msg.rid : '';
    switch (msg.op) {
      case 'authed':
        authenticated = true;
        authState = 'ok';
        log.info(expected.channel + ': authenticated' + rid);
        sendSubscribe();
        return;
      case 'subscribed':
        subscribed = true;
        if (msg.provider) provider = String(msg.provider);
        log.info(expected.channel + ': subscribed' + rid + (provider ? ' (provider ' + provider + ')' : ''));
        return;
      case 'error':
        onErrorAck(msg);
        return;
      case 'pong':
      case 'unsubscribed':
        return;
      default:
        log.debug(expected.channel + ': ack ' + String(msg.op) + rid);
    }
  }

  function onErrorAck(msg: any): void {
    const code = String(msg.code ?? 'error');
    if (code === 'auth_required') {
      authenticated = false;
      authState = 'pending';
      log.warn(expected.channel + ': auth_required — authenticating first');
      sendAuth();
      return;
    }
    if (code === 'auth_invalid') {
      authErrors++;
      authState = 'invalid';
      log.error(expected.channel + ': auth_invalid — Polymarket rejected POLYMARKET_API_KEY/SECRET/PASSPHRASE; retrying in 5 min');
      forceReconnect(AUTH_INVALID_BACKOFF_MS, 'auth_invalid');
      return;
    }
    if (code === 'auth_unavailable') {
      authErrors++;
      authState = 'unavailable';
      log.warn(expected.channel + ': auth_unavailable — verifier unreachable, retrying soon');
      forceReconnect(15_000, 'auth_unavailable');
      return;
    }
    policyErrors++;
    log.error(expected.channel + ': server error ' + code + ' — client bug or limit breach; backing off ' + POLICY_BACKOFF_MS / 1000 + 's');
    forceReconnect(POLICY_BACKOFF_MS, 'policy ' + code);
  }

  function onFrame(raw: any): void {
    lastFrameRecvMs = now();
    const text = typeof raw === 'string' ? raw : raw?.toString?.() ?? '';
    let msg: any;
    try { msg = JSON.parse(text); } catch { countParseError('not JSON'); return; }
    if (!msg || typeof msg !== 'object') { countParseError('not an object'); return; }
    if (msg.op) { onAck(msg); return; }
    const data = extractPolyBoltTicks(msg, expected);
    if (!data) {
      if (msg.channel === expected.channel) countParseError('unusable ' + expected.channel + ' frame');
      return;
    }
    if (data.source && data.source !== source) {
      source = data.source;
      log.info(expected.channel + ': source=' + source);
    }
    if (data.ticks.length > 0) {
      for (const t of data.ticks) store.add(t.ts, t.value);
      lastTickRecvMs = now();
      stallStreak = 0;
    }
    if (data.snapshot) {
      snapshotPoints += data.ticks.length;
      log.info(expected.channel + ': snapshot with ' + data.ticks.length + ' point(s)');
    }
    droppedFrames += data.dropped;
    if (data.seq != null) {
      if (lastSeq != null && data.seq > lastSeq + 1) {
        seqGaps += data.seq - lastSeq - 1;
        if (seqGaps <= 2 || seqGaps % 100 === 0) log.warn(expected.channel + ': seq gap ' + (data.seq - lastSeq - 1) + ' (total ' + seqGaps + ')');
      }
      lastSeq = data.seq;
    }
  }

  function onClose(code: number): void {
    ws = null;
    connected = false;
    authenticated = false;
    subscribed = false;
    lastCloseCode = code;
    clearTimers();
    if (!running) return;
    if (code === 4001) {
      authErrors++;
      authState = 'invalid';
      log.error(expected.channel + ': close 4001 — authentication failed; retrying in 5 min (fix credentials)');
      scheduleReconnect(AUTH_INVALID_BACKOFF_MS, 'close 4001');
      return;
    }
    if (code === 4003) {
      const delay = Math.round(random() * 10_000);
      log.info(expected.channel + ': close 4003 — server draining; reconnecting in ' + delay + 'ms');
      scheduleReconnect(delay, 'close 4003');
      return;
    }
    if (code === 4008) {
      policyErrors++;
      log.error(expected.channel + ': close 4008 — policy violation; backing off ' + POLICY_BACKOFF_MS / 1000 + 's instead of reconnecting blindly');
      scheduleReconnect(POLICY_BACKOFF_MS, 'close 4008');
      return;
    }
    log.debug(expected.channel + ': closed ' + code + ' — retrying with backoff');
    scheduleBackoff();
  }

  function forceReconnect(delayMs?: number, why = 'reconnect'): void {
    const old = ws;
    ws = null;
    connected = false;
    authenticated = false;
    subscribed = false;
    clearTimers();
    drop(old);
    if (!running) return;
    if (why !== 'backoff') log.info(expected.channel + ': reconnecting (' + why + ')');
    if (delayMs != null) scheduleReconnect(delayMs, why);
    else open();
  }

  function startSupervision(socket: WebSocket): void {
    clearTimers();
    const openedAt = now();
    const timer = setInterval(() => {
      if (ws !== socket) return;
      const t = now();
      if (!authenticated && t - openedAt > AUTH_TIMEOUT_MS) {
        log.warn(expected.channel + ': no authed after ' + AUTH_TIMEOUT_MS / 1000 + 's — reconnecting');
        forceReconnect(undefined, 'auth timeout');
        return;
      }
      if (authenticated && !subscribed && t - openedAt > SUBSCRIBE_TIMEOUT_MS) {
        log.warn(expected.channel + ': no subscribed after ' + SUBSCRIBE_TIMEOUT_MS / 1000 + 's — reconnecting');
        forceReconnect(undefined, 'subscribe timeout');
        return;
      }
      if (!subscribed) return;
      const last = Math.max(lastTickRecvMs, openedAt);
      if (t - last <= STALL_MS) return;
      stallStreak++;
      if (stallStreak < STALL_BACKOFF_AFTER) {
        log.warn(expected.channel + ': no tick for ' + Math.round((t - last) / 1000) + 's — reconnecting');
        forceReconnect(undefined, 'stalled');
        return;
      }
      const wait = Math.min(5 * 60_000, 30_000 * 2 ** (stallStreak - STALL_BACKOFF_AFTER));
      if (stallStreak === STALL_BACKOFF_AFTER) {
        log.error(expected.channel + ': no ticks across ' + stallStreak + ' reconnect(s) — channel retired or blocked? backing off; the PTB falls back to the crypto-price API');
      }
      forceReconnect(wait, 'stalled');
    }, SUPERVISION_MS);
    timer.unref?.();
    timers.push(timer);
  }

  function open(): void {
    if (!running || ws) return;
    credsCache = (opts.credentials ?? (() => pickCredentials()))();
    if (!credsCache) {
      authState = 'missing';
      log.error('no CLOB L2 credentials (POLYMARKET_API_KEY/SECRET/PASSPHRASE) — cannot subscribe to ' + expected.channel);
      running = false;
      return;
    }
    let socket: WebSocket;
    try {
      socket = makeSocket(url);
    } catch (err) {
      log.warn(expected.channel + ': connect failed: ' + ((err as Error)?.message ?? err));
      scheduleBackoff();
      return;
    }
    ws = socket;
    opens++;
    if (opens > 1) reconnects++;
    socket.on('open', () => {
      if (ws !== socket) return;
      connected = true;
      authenticated = false;
      subscribed = false;
      authState = 'pending';
      lastFrameRecvMs = now();
      backoffAttempt = 0;
      stallStreak = 0;
      sendAuth();
      startSupervision(socket);
    });
    socket.on('message', (raw: any) => {
      if (ws !== socket) return;
      onFrame(raw);
    });
    socket.on('close', (code: number) => {
      if (ws !== socket) return;
      onClose(code);
    });
    socket.on('error', (err: Error) => {
      log.debug(expected.channel + ': socket error: ' + (err?.message ?? err));
      try { socket.close(); } catch { /* close handler reconnects */ }
    });
  }

  return {
    start() {
      if (running) return;
      running = true;
      log.info(expected.channel + ': connecting to ' + url + ' (filter ' + JSON.stringify(opts.filter) + ')');
      open();
    },
    stop() {
      running = false;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      clearTimers();
      drop(ws);
      ws = null;
      connected = false;
      authenticated = false;
      subscribed = false;
    },
    replay(reason: string) {
      if (!running) return;
      const t = now();
      if (t - lastReplayMs < POLYBOLT_REPLAY_MIN_GAP_MS) return;
      lastReplayMs = t;
      log.info(expected.channel + ': replay requested (' + reason + ')');
      forceReconnect(undefined, 'replay');
    },
    at: (ts) => store.at(ts),
    latest: () => store.latest(),
    between: (from, to) => store.between(from, to),
    health: () => ({
      connected,
      authenticated,
      subscribed,
      authState,
      ticks: store.size,
      lastTick: store.latest(),
      lastTickRecvMs,
      lastFrameRecvMs,
      reconnects,
      parseErrors,
      authErrors,
      policyErrors,
      seqGaps,
      droppedFrames,
      lastSeq,
      snapshotPoints,
      source,
      provider,
      lastCloseCode,
    }),
  };
}
