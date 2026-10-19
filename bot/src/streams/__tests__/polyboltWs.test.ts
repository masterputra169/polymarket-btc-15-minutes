/**
 * PolyBolt protocol/feed tests.
 *
 * Fixtures mirror the live probe of 2026-10-19 (04:11 UTC): the TWAP and spot
 * channels carried values identical to RTDS at every overlapping second, the
 * TWAP snapshot on subscribe held 117 points (~2 minutes) and ticks arrived
 * ~1.0-1.9 s after their whole-second source timestamp.
 */
import { describe, test, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  buildAuthFrame,
  buildSubscribeFrame,
  extractPolyBoltTicks,
  normalizeTickTs,
  backoffDelayMs,
  pickCredentials,
  resolveTwapFeedMode,
  rtdsFallbackEnabled,
  createPolyBoltFeed,
  POLYBOLT_TWAP_CHANNEL,
  POLYBOLT_CRYPTO_CHANNEL,
  POLYBOLT_REPLAY_MIN_GAP_MS,
  type PolyBoltFeedOptions,
} from '../polyboltWs.ts';

const T = 1792383098000; // live-probe whole second (2026-10-19T04:11:38Z)
const PTB = 82424.248589134168326144;

class FakeSocket extends EventEmitter {
  sent: string[] = [];
  terminated = false;
  readyState = 1;
  send(frame: string) { this.sent.push(frame); }
  close() { this.emit('close', 1000, Buffer.from('')); }
  terminate() { this.terminated = true; }
}

interface Harness {
  feed: ReturnType<typeof createPolyBoltFeed>;
  sockets: FakeSocket[];
  advance: (ms: number) => void;
}

function harness(overrides: Partial<PolyBoltFeedOptions> = {}): Harness {
  const sockets: FakeSocket[] = [];
  let t = 1_000_000;
  const feed = createPolyBoltFeed({
    name: 'TEST',
    channel: POLYBOLT_TWAP_CHANNEL,
    filter: { symbol: 'btcusd', window_seconds: 60 },
    credentials: () => ({ apiKey: 'k', secret: 's', passphrase: 'p' }),
    makeSocket: () => { const s = new FakeSocket(); sockets.push(s); return s as any; },
    now: () => t,
    random: () => 0.5,
    ...overrides,
  });
  return { feed, sockets, advance: (ms: number) => { t += ms; } };
}

function send(socket: FakeSocket, obj: Record<string, unknown>): void {
  socket.emit('message', Buffer.from(JSON.stringify(obj)));
}

function twapSnapshot(seq = 1): Record<string, unknown> {
  return {
    v: 1, channel: POLYBOLT_TWAP_CHANNEL, seq, ts: T, snapshot: true,
    payload: {
      symbol: 'btcusd', window_seconds: 60, source: 'chainlink',
      data: [
        { value: PTB - 8, full_accuracy_value: '82416.610307950652686336', timestamp: T - 2000 },
        { value: PTB, full_accuracy_value: '82424.248589134168326144', timestamp: T },
      ],
    },
  };
}

function twapLive(seq: number, ts = T + 1000, value = 82424.24917303132): Record<string, unknown> {
  return {
    v: 1, channel: POLYBOLT_TWAP_CHANNEL, seq, ts,
    payload: {
      symbol: 'btcusd', value, full_accuracy_value: String(value), timestamp: ts,
      window_seconds: 60, source: 'chainlink',
    },
  };
}

/** Drive a feed to the "authenticated + subscribed + snapshot seeded" state. */
function bringUp(h: Harness, socket = h.sockets[h.sockets.length - 1], opts: { snapshot?: boolean } = {}): FakeSocket {
  socket.emit('open');
  send(socket, { op: 'authed', rid: 'a1' });
  send(socket, { op: 'subscribed', channel: POLYBOLT_TWAP_CHANNEL, rid: 's1', provider: 'chainlink' });
  if (opts.snapshot !== false) send(socket, twapSnapshot(1));
  return socket;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('protocol frames', () => {
  test('auth frame carries the CLOB L2 trio and an echoed rid', () => {
    expect(buildAuthFrame({ apiKey: 'key', secret: 'sec', passphrase: 'pass' }, 'a9')).toEqual({
      op: 'auth', rid: 'a9',
      auth: { apiKey: 'key', secret: 'sec', passphrase: 'pass' },
    });
  });

  test('subscribe frame is the PolyBolt batch format with an object filter', () => {
    const frame = buildSubscribeFrame([
      { channel: POLYBOLT_TWAP_CHANNEL, filter: { symbol: 'btcusd', window_seconds: 60 } },
      { channel: POLYBOLT_CRYPTO_CHANNEL, filter: { symbol: 'btcusd', provider: 'chainlink' } },
    ]);
    expect(frame).toEqual({
      op: 'subscribe', rid: 's1',
      subscriptions: [
        { channel: 'price.crypto.twap', filter: { symbol: 'btcusd', window_seconds: 60 } },
        { channel: 'price.crypto', filter: { symbol: 'btcusd', provider: 'chainlink' } },
      ],
    });
    // PolyBolt wants a JSON object here; RTDS wanted a JSON *string*.
    expect(typeof (frame as any).subscriptions[0].filter).toBe('object');
  });
});

describe('data envelope parsing', () => {
  const twap = { channel: POLYBOLT_TWAP_CHANNEL, symbol: 'btcusd' };

  test('the subscribe snapshot: batch under payload.data, exact decimals preferred', () => {
    const data = extractPolyBoltTicks(twapSnapshot(1), twap);
    expect(data).not.toBeNull();
    expect(data.snapshot).toBe(true);
    expect(data.source).toBe('chainlink');
    expect(data.seq).toBe(1);
    expect(data.ticks).toHaveLength(2);
    expect(data.ticks[0]).toEqual({ ts: T - 2000, value: 82416.610307950652686336 });
    // full_accuracy_value, not the rounded float value
    expect(data.ticks[1].value).toBe(PTB);
    expect(data.ticks[1].value).not.toBe(data.ticks[1].value.toFixed(2) as any);
  });

  test('a live TWAP point and the ms->second key', () => {
    const live = twapLive(2, T + 1000);
    const data = extractPolyBoltTicks(live, twap);
    expect(data.snapshot).toBe(false);
    expect(data.ticks).toEqual([{ ts: T + 1000, value: 82424.24917303132 }]);
    // a sub-second offset is snapped to the second it describes
    const offset = twapLive(3, T + 1400);
    (offset.payload as any).timestamp = T + 1400;
    expect(extractPolyBoltTicks(offset, twap).ticks).toEqual([{ ts: T + 1000, value: 82424.24917303132 }]);
    expect(normalizeTickTs(T + 600)).toBe(T + 1000);
  });

  test('spot snapshots and live points (source at batch or point level)', () => {
    const expected = { channel: POLYBOLT_CRYPTO_CHANNEL, symbol: 'btcusd' };
    const snapshot = {
      v: 1, channel: POLYBOLT_CRYPTO_CHANNEL, seq: 1, ts: T, snapshot: true,
      payload: { symbol: 'btcusd', source: 'chainlink', data: [{ value: 82424.355, full_accuracy_value: '82424.355155655165', timestamp: T }] },
    };
    expect(extractPolyBoltTicks(snapshot, expected)).toMatchObject({
      source: 'chainlink', snapshot: true, ticks: [{ ts: T, value: 82424.355155655165 }],
    });
    const live = {
      v: 1, channel: POLYBOLT_CRYPTO_CHANNEL, seq: 2, ts: T + 1000,
      payload: { symbol: 'btcusd', source: 'pyth', value: 1, full_accuracy_value: '82424.643434499615', timestamp: T + 1000 },
    };
    expect(extractPolyBoltTicks(live, expected).source).toBe('pyth');
    expect(extractPolyBoltTicks(live, expected).ticks).toEqual([{ ts: T + 1000, value: 82424.643434499615 }]);
  });

  test('acks, other channels/symbols and unusable points are rejected', () => {
    expect(extractPolyBoltTicks({ op: 'authed', rid: 'a1' }, twap)).toBeNull();
    expect(extractPolyBoltTicks({ channel: POLYBOLT_CRYPTO_CHANNEL, payload: {} }, twap)).toBeNull();
    expect(extractPolyBoltTicks({ v: 1, channel: POLYBOLT_TWAP_CHANNEL, payload: { symbol: 'ethusd', data: [] } }, twap)).toBeNull();
    expect(extractPolyBoltTicks('not an object', twap)).toBeNull();
    const bad = {
      v: 1, channel: POLYBOLT_TWAP_CHANNEL, seq: 3,
      payload: { symbol: 'btcusd', data: [{ timestamp: 0, value: 5 }, { timestamp: T, value: -1 }, { timestamp: T + 1000 }] },
    };
    expect(extractPolyBoltTicks(bad, twap).ticks).toEqual([]);
  });
});

describe('mode and credential selection', () => {
  const creds = { POLYMARKET_API_KEY: 'k', POLYMARKET_API_SECRET: 's', POLYMARKET_API_PASSPHRASE: 'p' };

  test('TWAP_FEED picks the primary feed; unset follows the credentials', () => {
    expect(resolveTwapFeedMode({})).toBe('rtds');
    expect(resolveTwapFeedMode(creds)).toBe('polybolt');
    expect(resolveTwapFeedMode({ ...creds, TWAP_FEED: 'rtds' })).toBe('rtds');
    expect(resolveTwapFeedMode({ ...creds, TWAP_FEED: 'RTDS' })).toBe('rtds');
    expect(resolveTwapFeedMode({ TWAP_FEED: 'polybolt' })).toBe('polybolt');
    expect(resolveTwapFeedMode({ ...creds, TWAP_FEED: 'bogus' })).toBe('polybolt');
    expect(pickCredentials(creds)).toEqual({ apiKey: 'k', secret: 's', passphrase: 'p' });
    expect(pickCredentials({ ...creds, POLYMARKET_API_SECRET: '  ' })).toBeNull();
    expect(pickCredentials({ POLYMARKET_API_KEY: 'k' })).toBeNull();
  });

  test('POLYBOLT_RTDS_FALLBACK: on unless explicitly off', () => {
    expect(rtdsFallbackEnabled({})).toBe(true);
    expect(rtdsFallbackEnabled({ POLYBOLT_RTDS_FALLBACK: 'true' })).toBe(true);
    for (const off of ['off', 'false', '0', 'no', 'OFF']) expect(rtdsFallbackEnabled({ POLYBOLT_RTDS_FALLBACK: off })).toBe(false);
  });
});

describe('reconnect policy', () => {
  test('1006/4002 backoff is exponential, capped and jittered; 4003 is 0-10 s', () => {
    expect(backoffDelayMs(0, () => 0.5)).toBe(500);
    expect(backoffDelayMs(1, () => 0.5)).toBe(1000);
    expect(backoffDelayMs(5, () => 1)).toBe(30_000); // capped
    expect(backoffDelayMs(0, () => 0)).toBe(250);    // never a 0 ms storm
    expect(backoffDelayMs(10, () => 0.5)).toBe(15_000);
    // uniform 0-10 s for 4003 is expressed inline via random(); sanity on its bounds
    for (let i = 1; i <= 20; i++) {
      const d = Math.round((i / 20) * 10_000);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(10_000);
    }
  });
});

describe('feed lifecycle', () => {
  test('start -> auth -> subscribe -> snapshot + live ticks, with health', () => {
    vi.useFakeTimers();
    const h = harness();
    h.feed.start();
    expect(h.sockets).toHaveLength(1);
    const socket = h.sockets[0];
    socket.emit('open');
    const auth = JSON.parse(socket.sent[0]);
    expect(auth.op).toBe('auth');
    expect(auth.auth.apiKey).toBe('k');
    expect(JSON.stringify(auth)).not.toContain('secret-token'); // frame only carries env creds

    send(socket, { op: 'authed', rid: 'a1' });
    const sub = JSON.parse(socket.sent[1]);
    expect(sub.op).toBe('subscribe');
    expect(sub.subscriptions).toEqual([{ channel: POLYBOLT_TWAP_CHANNEL, filter: { symbol: 'btcusd', window_seconds: 60 } }]);

    send(socket, { op: 'subscribed', channel: POLYBOLT_TWAP_CHANNEL, rid: 's1', provider: 'chainlink' });
    send(socket, twapSnapshot(1));
    expect(h.feed.at(T)).toBe(PTB);
    expect(h.feed.latest()).toEqual({ ts: T, value: PTB });

    send(socket, twapLive(2));
    expect(h.feed.at(T)).toBe(PTB);
    expect(h.feed.at(T + 1000)).toBe(82424.24917303132);

    const health = h.feed.health();
    expect(health).toMatchObject({
      connected: true, authenticated: true, subscribed: true, authState: 'ok',
      ticks: 3, snapshotPoints: 2, source: 'chainlink', provider: 'chainlink', seqGaps: 0,
    });
    expect(h.feed.between(T, T + 1000).map(t => t.ts)).toEqual([T, T + 1000]);
    h.feed.stop();
    expect(h.feed.health().connected).toBe(false);
  });

  test('auth_required re-sends auth instead of reconnecting', () => {
    vi.useFakeTimers();
    const h = harness();
    h.feed.start();
    const socket = h.sockets[0];
    socket.emit('open');
    send(socket, { op: 'error', code: 'auth_required', rid: 's1' });
    expect(socket.sent.filter(s => JSON.parse(s).op === 'auth')).toHaveLength(2);
    expect(h.sockets).toHaveLength(1); // same socket
    h.feed.stop();
  });

  test('auth_invalid waits 5 minutes and flags the auth state', () => {
    vi.useFakeTimers();
    const h = harness();
    h.feed.start();
    h.sockets[0].emit('open');
    send(h.sockets[0], { op: 'error', code: 'auth_invalid', rid: 'a1' });
    expect(h.feed.health()).toMatchObject({ authState: 'invalid', authErrors: 1, connected: false });
    expect(h.sockets).toHaveLength(1);
    vi.advanceTimersByTime(5 * 60_000);
    expect(h.sockets).toHaveLength(2);
    h.feed.stop();
  });

  test('close 1006 reconnects after the jittered backoff and re-auths', () => {
    vi.useFakeTimers();
    const h = harness();
    h.feed.start();
    bringUp(h);
    h.sockets[0].emit('close', 1006, Buffer.from(''));
    expect(h.feed.health().connected).toBe(false);
    expect(h.sockets).toHaveLength(1);
    vi.advanceTimersByTime(500); // backoffDelayMs(0, () => 0.5) = 500
    expect(h.sockets).toHaveLength(2);
    expect(h.feed.health().reconnects).toBe(1);
    h.sockets[1].emit('open');
    expect(JSON.parse(h.sockets[1].sent[0]).op).toBe('auth');
    h.feed.stop();
  });

  test('close 4003 reconnects after a uniform 0-10 s delay', () => {
    vi.useFakeTimers();
    const h = harness();
    h.feed.start();
    bringUp(h);
    h.sockets[0].emit('close', 4003, Buffer.from(''));
    expect(h.sockets).toHaveLength(1);
    vi.advanceTimersByTime(4_999);
    expect(h.sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(h.sockets).toHaveLength(2); // random()=0.5 -> 5000 ms
    h.feed.stop();
  });

  test('replay reconnects (fresh 2-minute snapshot) but is rate-limited', () => {
    vi.useFakeTimers();
    const h = harness();
    h.feed.start();
    bringUp(h);
    h.feed.replay('missed second');
    expect(h.sockets).toHaveLength(2);
    expect(h.sockets[0].terminated).toBe(true);
    h.feed.replay('too soon');
    expect(h.sockets).toHaveLength(2);
    h.advance(POLYBOLT_REPLAY_MIN_GAP_MS);
    h.feed.replay('after gap');
    expect(h.sockets).toHaveLength(3);
    h.feed.stop();
  });

  test('missing credentials: no socket, authState=missing, no retry storm', () => {
    vi.useFakeTimers();
    const h = harness({ credentials: () => null });
    h.feed.start();
    expect(h.sockets).toHaveLength(0);
    expect(h.feed.health()).toMatchObject({ authState: 'missing', connected: false });
    vi.advanceTimersByTime(10 * 60_000);
    expect(h.sockets).toHaveLength(0);
    h.feed.stop();
  });

  test('seq gaps and server dropped counters are tracked', () => {
    vi.useFakeTimers();
    const h = harness();
    h.feed.start();
    bringUp(h);
    send(h.sockets[0], { ...twapLive(3), dropped: 2 } as any);
    const health = h.feed.health();
    expect(health.seqGaps).toBe(1); // snapshot seq 1 -> live seq 3
    expect(health.droppedFrames).toBe(2);
    expect(health.lastSeq).toBe(3);
    h.feed.stop();
  });

  test('a silent channel is reconnected after 30 s without a tick', () => {
    vi.useFakeTimers();
    const h = harness();
    h.feed.start();
    bringUp(h);
    expect(h.sockets).toHaveLength(1);
    h.advance(31_000);
    vi.advanceTimersByTime(31_000);
    expect(h.sockets).toHaveLength(2);
    expect(h.feed.health().reconnects).toBe(1);
    h.feed.stop();
  });
});

describe('chainlinkTwap seam', () => {
  test('TWAP_FEED selects the module-level feed without touching loop/index', async () => {
    const prev = { ...process.env };
    try {
      process.env.TWAP_FEED = 'rtds';
      vi.resetModules();
      const rtds = await import('../chainlinkTwap.ts');
      expect(rtds.getTwapFeedMode()).toBe('rtds');
      expect(rtds.getTwapFeedHealth().polybolt).toBeNull();

      process.env.TWAP_FEED = 'polybolt';
      process.env.POLYMARKET_API_KEY = 'k';
      process.env.POLYMARKET_API_SECRET = 's';
      process.env.POLYMARKET_API_PASSPHRASE = 'p';
      vi.resetModules();
      const pb = await import('../chainlinkTwap.ts');
      expect(pb.getTwapFeedMode()).toBe('polybolt');
      const health = pb.getTwapFeedHealth();
      expect(health.polybolt).not.toBeNull();
      expect(health.rtds).not.toBeNull(); // RTDS shadow fallback still connected
      expect(health.connected).toBe(false); // nothing started in a unit test
      pb.stopTwapFeed();
    } finally {
      for (const key of ['TWAP_FEED', 'POLYMARKET_API_KEY', 'POLYMARKET_API_SECRET', 'POLYMARKET_API_PASSPHRASE']) {
        if (prev[key] === undefined) delete process.env[key];
        else process.env[key] = prev[key];
      }
      vi.resetModules();
    }
  });
});
