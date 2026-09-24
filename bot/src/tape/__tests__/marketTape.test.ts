/**
 * The recorder end to end, with a fake book source and a fake bucket: what it
 * writes each second, when it uploads, what it does when the upload fails, and
 * that nothing it does can throw into the poll loop.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync, readdirSync, mkdirSync, writeFileSync, unlinkSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { BookState } from '../bookState.ts';
import { decodeTape, type SnapshotLine } from '../tapeFormat.ts';
import {
  readTapeConfig, startMarketTape, stopMarketTape, setTapeMarket, getTapeStatus, type TapeConfig,
} from '../marketTape.ts';

const H3 = Date.UTC(2026, 8, 24, 3, 59, 0);

let dir: string;
let puts: { key: string; body: Uint8Array }[];
let putFails: boolean;

function fakeSocket() {
  const up = new BookState();
  const down = new BookState();
  return {
    up, down, live: true, resyncs: 0, repairs: 0,
    start: vi.fn(), stop: vi.fn(), setTokens: vi.fn(),
    fill() {
      up.applySnapshot([{ price: '0.55', size: '10' }], [{ price: '0.57', size: '12' }], Date.now());
      down.applySnapshot([{ price: '0.43', size: '8' }], [{ price: '0.45', size: '9' }], Date.now());
    },
  };
}

function config(over: Partial<TapeConfig> = {}): TapeConfig {
  return {
    ...readTapeConfig({}),
    dir, intervalMs: 1_000, depth: 5, flushMs: 10_000, uploadEveryMs: 300_000,
    maxLocalBytes: 100 * 1024 * 1024, minFreeBytes: 0,
    s3: { endpoint: 'https://x.r2.cloudflarestorage.com', bucket: 'b', region: 'auto', accessKeyId: 'a', secretAccessKey: 's', prefix: 'btc15/tape/' },
    ...over,
  };
}

const store = {
  put: vi.fn(async (key: string, body: Uint8Array) => {
    if (putFails) throw new Error('HTTP 503');
    puts.push({ key, body });
  }),
  get: vi.fn(), list: vi.fn(),
};

const ctx = { btc: 63150.123, chainlink: 63148.2, polyLive: null, ptb: 63100.456, ptbSource: 'scheduled_ws' };

function allLines() {
  const out: any[] = [];
  for (const day of existsSync(dir) ? readdirSync(dir) : []) {
    for (const f of readdirSync(join(dir, day))) out.push(...decodeTape(readFileSync(join(dir, day, f))).lines);
  }
  for (const p of puts) out.push(...decodeTape(p.body).lines);
  return out.sort((a, b) => a.t - b.t);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(H3);
  dir = mkdtempSync(join(tmpdir(), 'market-tape-'));
  puts = [];
  putFails = false;
  store.put.mockClear();
});
afterEach(() => {
  stopMarketTape();
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

const MARKET = { slug: 'btc-updown-15m-1790222400', conditionId: '0xabc', upTokenId: 'UP', downTokenId: 'DN', startMs: H3, endMs: H3 + 900_000 };

describe('market tape', () => {
  test('writes a market line, then one snapshot a second with book top and BTC feeds', () => {
    const socket = fakeSocket();
    expect(startMarketTape({ getContext: () => ctx, config: config(), store, socket: socket as any })).toBe(true);
    setTapeMarket(MARKET);
    setTapeMarket(MARKET); // same market again: no second line, no resubscribe
    expect(socket.setTokens).toHaveBeenCalledTimes(1);
    socket.fill();
    vi.advanceTimersByTime(3_000);
    stopMarketTape();

    const lines = allLines();
    expect(lines.filter(l => l.k === 'm')).toEqual([{ k: 'm', t: H3, m: MARKET.slug, cid: '0xabc', up: 'UP', dn: 'DN', start: H3, end: H3 + 900_000 }]);
    const snaps = lines.filter(l => l.k === 's') as SnapshotLine[];
    expect(snaps).toHaveLength(3);
    expect(snaps[0]).toMatchObject({
      m: MARKET.slug, ok: 1, btc: 63150.12, cl: 63148.2, pl: null, ptb: 63100.46, ps: 'scheduled_ws',
      u: { b: [[0.55, 10]], a: [[0.57, 12]] }, d: { b: [[0.43, 8]], a: [[0.45, 9]] },
    });
  });

  test('a snapshot without a live book is still written, marked ok:0, so gaps are countable', () => {
    const socket = fakeSocket();
    startMarketTape({ getContext: () => ctx, config: config(), store, socket: socket as any });
    vi.advanceTimersByTime(1_000);
    stopMarketTape();
    const [snap] = allLines().filter(l => l.k === 's');
    expect(snap.ok).toBe(0);
    expect(snap.u).toBeUndefined();
  });

  test('at the hour boundary the finished file is uploaded under the prefix and deleted locally', async () => {
    const socket = fakeSocket();
    startMarketTape({ getContext: () => ctx, config: config(), store, socket: socket as any });
    setTapeMarket(MARKET);
    socket.fill();
    await vi.advanceTimersByTimeAsync(61_000); // crosses 04:00:00
    expect(store.put).toHaveBeenCalledTimes(1);
    const { key, body } = puts[0];
    expect(key).toMatch(/^btc15\/tape\/2026-09-24\/03-[a-z0-9]{9}\.jsonl\.gz$/);
    // 03:59:01 .. 03:59:59 — the 04:00:00 sample opens the next file.
    expect(decodeTape(body).lines.filter(l => l.k === 's').length).toBe(59);
    expect(existsSync(join(dir, key.replace('btc15/tape/', '')))).toBe(false);
    expect(getTapeStatus()).toMatchObject({ running: true, uploaded: 1, lastUploadError: null, destination: 'x.r2.cloudflarestorage.com/b/btc15/tape/' });
  });

  test('a failed upload keeps the file and backs off instead of retrying every round', async () => {
    putFails = true;
    const socket = fakeSocket();
    startMarketTape({ getContext: () => ctx, config: config({ uploadEveryMs: 30_000 }), store, socket: socket as any });
    await vi.advanceTimersByTimeAsync(71_000); // fails at 04:00:00; 04:00:10 flush opens the 04h file
    expect(store.put).toHaveBeenCalledTimes(1);
    expect(getTapeStatus().lastUploadError).toBe('HTTP 503');
    expect(getTapeStatus().localFiles).toBe(2); // the 03h file (kept) and the 04h file (open)
    await vi.advanceTimersByTimeAsync(20_000); // the 04:00:30 round is inside the 60s backoff
    expect(store.put).toHaveBeenCalledTimes(1);
    putFails = false;
    await vi.advanceTimersByTimeAsync(30_000); // 04:01:00 round retries
    expect(store.put).toHaveBeenCalledTimes(2);
    expect(getTapeStatus()).toMatchObject({ uploaded: 1, lastUploadError: null, localFiles: 1 });
  });

  test('a file evicted by the cap mid-round is skipped; the rest of the round still uploads', async () => {
    const old = new Date(H3 - 3_600_000);
    mkdirSync(join(dir, '2026-09-23'), { recursive: true });
    for (const name of ['01-boot0.jsonl.gz', '02-boot0.jsonl.gz', '03-boot0.jsonl.gz']) {
      writeFileSync(join(dir, '2026-09-23', name), 'x');
      utimesSync(join(dir, '2026-09-23', name), old, old);
    }
    // While the first file uploads, the cap evicts the second.
    store.put.mockImplementationOnce(async (key: string, body: Uint8Array) => {
      unlinkSync(join(dir, '2026-09-23/02-boot0.jsonl.gz'));
      puts.push({ key, body });
    });
    startMarketTape({ getContext: () => ctx, config: config(), store, socket: fakeSocket() as any });
    await vi.advanceTimersByTimeAsync(31_000); // startup round at +30s
    expect(puts.map(p => p.key)).toEqual(['btc15/tape/2026-09-23/01-boot0.jsonl.gz', 'btc15/tape/2026-09-23/03-boot0.jsonl.gz']);
    expect(getTapeStatus()).toMatchObject({ uploaded: 2, lastUploadError: null });
  });

  test('without a bucket the files stay on disk', async () => {
    startMarketTape({ getContext: () => ctx, config: config({ s3: null }), store: null, socket: fakeSocket() as any });
    await vi.advanceTimersByTimeAsync(71_000);
    expect(getTapeStatus()).toMatchObject({ destination: null, uploaded: 0, localFiles: 2 });
  });

  test('nothing throws into the caller: a broken context getter or bad market is absorbed', () => {
    startMarketTape({ getContext: () => { throw new Error('boom'); }, config: config(), store, socket: fakeSocket() as any });
    expect(() => vi.advanceTimersByTime(3_000)).not.toThrow();
    expect(() => setTapeMarket({ ...MARKET, upTokenId: '' })).not.toThrow();
    expect(getTapeStatus().errors).toBe(3);
  });

  test('setTapeMarket before start is a no-op; TAPE_ENABLED=false does not start', () => {
    expect(() => setTapeMarket(MARKET)).not.toThrow();
    expect(startMarketTape({ getContext: () => ctx, config: config({ enabled: false }) })).toBe(false);
    expect(getTapeStatus().running).toBe(false);
  });

  test('readTapeConfig bounds every number and reads TAPE_ENABLED', () => {
    const c = readTapeConfig({ TAPE_INTERVAL_MS: '5', TAPE_DEPTH: '500', TAPE_MAX_LOCAL_MB: '200', TAPE_ENABLED: 'FALSE' });
    expect(c).toMatchObject({ intervalMs: 1_000, depth: 10, maxLocalBytes: 200 * 1024 * 1024, enabled: false, s3: null, s3Problem: null });
  });
});
