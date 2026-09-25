/**
 * The price to beat is Chainlink's 60-second TWAP stamped at the window's first
 * second (since 2026-08-07). These tests pin the pieces that get it: the tick
 * store, the RTDS frame parser, the crypto-price fallback, the source ranking and
 * the resolver's schedule. Fixture values are from the live probe of the
 * 2026-09-25 16:00 UTC window, where the TWAP tick and Polymarket's published
 * price to beat were 83743.8965356868 and the spot tick was 83778.83461303619.
 */
import { describe, test, expect, beforeEach } from 'vitest';
import { TickStore } from '../../streams/tickStore.ts';
import { parseRtdsFrame } from '../../streams/rtdsTickFeed.ts';
import {
  parseTwapWindowPrice, twapWindowPriceUrl, fetchTwapWindowPrice, resetTwapWindowPriceThrottle,
} from '../../adapters/twapWindowPrice.ts';
import { decidePtb, isExactPtbSource, EXACT_PTB_SOURCES } from '../ptbSources.ts';
import { resolveExactPtb, PTB_RESOLVER_TIMING } from '../ptbResolver.ts';

const START = 1790352000000; // 2026-09-25 16:00:00 UTC
const END = START + 900_000;
const PTB = 83743.8965356868;
const SPOT = 83778.83461303619;

describe('TickStore', () => {
  test('reads by the source timestamp and forgets what is older than its window', () => {
    const s = new TickStore(60_000);
    expect(s.add(START - 1000, 83740)).toBe(true);
    expect(s.add(START, PTB)).toBe(true);
    expect(s.add(START, PTB)).toBe(false);
    expect(s.at(START)).toBe(PTB);
    expect(s.at(START + 1000)).toBeNull();
    expect(s.latest()).toEqual({ ts: START, value: PTB });
    s.add(START + 60_000, 83750); // exactly the window: START stays, START-1s goes
    expect(s.at(START - 1000)).toBeNull();
    expect(s.at(START)).toBe(PTB);
    expect(s.between(START, START + 60_000).map(t => t.ts)).toEqual([START, START + 60_000]);
    expect(s.add(NaN, 1)).toBe(false);
    expect(s.add(START, -1)).toBe(false);
  });
});

describe('parseRtdsFrame', () => {
  const topic = 'crypto_prices_twap_sixty';
  test('a live update', () => {
    const raw = JSON.stringify({ topic, type: 'update', timestamp: START + 737, payload: { symbol: 'btc/usd', timestamp: START, value: PTB, full_accuracy_value: '83743896535686800000000', window_s: 60 } });
    expect(parseRtdsFrame(raw, topic, 'btc/usd')).toEqual([{ ts: START, value: PTB }]);
  });
  test('the replay batch sent on subscribe', () => {
    const raw = JSON.stringify({ payload: { data: [{ timestamp: START - 1000, value: 83741.1 }, { timestamp: START, value: PTB }] } });
    expect(parseRtdsFrame(raw, topic, 'btc/usd')).toEqual([{ ts: START - 1000, value: 83741.1 }, { ts: START, value: PTB }]);
  });
  test('other topics and symbols are ignored; garbage is reported as null', () => {
    expect(parseRtdsFrame(JSON.stringify({ topic: 'crypto_prices_chainlink', payload: { symbol: 'btc/usd', timestamp: START, value: SPOT } }), topic, 'btc/usd')).toEqual([]);
    expect(parseRtdsFrame(JSON.stringify({ topic, payload: { symbol: 'eth/usd', timestamp: START, value: 4000 } }), topic, 'btc/usd')).toEqual([]);
    expect(parseRtdsFrame('PONG-not-json', topic, 'btc/usd')).toBeNull();
    expect(parseRtdsFrame(JSON.stringify({ connection_id: 'x' }), topic, 'btc/usd')).toEqual([]);
  });
});

describe('crypto-price fallback', () => {
  beforeEach(() => resetTwapWindowPriceThrottle());
  test('asks for the TWAP, not the spot price', () => {
    const url = twapWindowPriceUrl(START, END);
    expect(url).toContain('eventStartTime=2026-09-25T16:00:00Z');
    expect(url).toContain('endDate=2026-09-25T16:15:00Z');
    expect(url).toContain('twapEnabled=true&twapLookbackSeconds=60');
  });
  test('parses open/close; null until published', () => {
    expect(parseTwapWindowPrice(`{"openPrice":${PTB},"closePrice":null,"completed":false,"incomplete":true}`))
      .toEqual({ openPrice: PTB, closePrice: null, completed: false });
    expect(parseTwapWindowPrice('{"openPrice":null,"closePrice":null}')).toEqual({ openPrice: null, closePrice: null, completed: false });
    expect(parseTwapWindowPrice('<html>')).toBeNull();
  });
  test('spaces calls and backs off after a 429', async () => {
    let t = 1_000_000;
    let calls = 0;
    const now = () => t;
    const ok = async () => { calls++; return `{"openPrice":${PTB}}`; };
    expect((await fetchTwapWindowPrice(START, END, { fetchText: ok, now }))?.openPrice).toBe(PTB);
    expect(await fetchTwapWindowPrice(START, END, { fetchText: ok, now })).toBeNull(); // too soon
    t += 5_000;
    const limited = async () => { calls++; throw new Error('TWAP window price: HTTP 429'); };
    expect(await fetchTwapWindowPrice(START, END, { fetchText: limited, now })).toBeNull();
    t += 10_000;
    expect(await fetchTwapWindowPrice(START, END, { fetchText: ok, now })).toBeNull(); // backing off
    t += 25_000;
    expect((await fetchTwapWindowPrice(START, END, { fetchText: ok, now }))?.openPrice).toBe(PTB);
    expect(calls).toBe(3);
  });
});

describe('PTB sources', () => {
  test('only TWAP-derived sources are exact; the spot capture and the spot Data Streams feed are not', () => {
    expect(EXACT_PTB_SOURCES).toContain('chainlink_twap');
    expect(isExactPtbSource('polymarket_twap_api')).toBe(true);
    expect(isExactPtbSource('scheduled_ws')).toBe(false);
    expect(isExactPtbSource('data_streams')).toBe(false);
    expect(isExactPtbSource(null)).toBe(false);
  });
  test('an exact value replaces an approximation, never the other way; exact conflicts are reported', () => {
    expect(decidePtb({ value: SPOT, source: 'scheduled_ws' }, { value: PTB, source: 'chainlink_twap' })).toEqual({ replace: true, conflict: false });
    expect(decidePtb({ value: PTB, source: 'chainlink_twap' }, { value: SPOT, source: 'scheduled_ws' })).toEqual({ replace: false, conflict: false });
    expect(decidePtb({ value: PTB, source: 'chainlink_twap' }, { value: PTB, source: 'polymarket_twap_api' })).toEqual({ replace: false, conflict: false });
    expect(decidePtb({ value: PTB, source: 'chainlink_twap' }, { value: PTB + 1, source: 'polymarket_gamma' })).toEqual({ replace: false, conflict: true });
    expect(decidePtb({ value: null, source: null }, { value: SPOT, source: 'oracle' }).replace).toBe(true);
    expect(decidePtb({ value: 1, source: 'oracle' }, { value: NaN, source: 'chainlink_twap' }).replace).toBe(false);
  });
});

describe('resolveExactPtb', () => {
  function harness(opts: { tickAtMs?: number; replayFills?: boolean; apiOpenAtMs?: number; startedAt?: number; current?: () => boolean }) {
    let t = opts.startedAt ?? START + 300;
    const ticks = new Map<number, number>();
    const log: string[] = [];
    let apiCalls = 0;
    const deps = {
      now: () => t,
      sleep: async (ms: number) => {
        t += ms;
        if (opts.tickAtMs != null && t >= START + opts.tickAtMs) ticks.set(START, PTB);
      },
      tickAt: (ts: number) => ticks.get(ts) ?? null,
      replay: (why: string) => { log.push(`replay@${t - START}`); if (opts.replayFills) ticks.set(START, PTB); },
      fetchWindow: async () => {
        apiCalls++;
        log.push(`api@${t - START}`);
        return { openPrice: opts.apiOpenAtMs != null && t >= START + opts.apiOpenAtMs ? PTB : null, closePrice: null, completed: false };
      },
      isCurrent: opts.current ?? (() => true),
      onExact: (v: number, src: string) => log.push(`exact ${src} ${v}`),
      onGiveUp: (why: string) => log.push(`gave up`),
    };
    return { deps, log, apiCalls: () => apiCalls, time: () => t };
  }

  test('the normal case: the TWAP tick lands about a second after the boundary', async () => {
    const h = harness({ tickAtMs: 1_000 });
    expect(await resolveExactPtb(START, END, h.deps)).toBe('chainlink_twap');
    expect(h.log).toEqual([`exact chainlink_twap ${PTB}`]);
    expect(h.time() - START).toBeLessThan(1_600);
  });

  test('a missed tick: one replay, and the replay recovers it', async () => {
    const h = harness({ replayFills: true });
    expect(await resolveExactPtb(START, END, h.deps)).toBe('chainlink_twap');
    expect(h.log[0]).toMatch(/^replay@2[5-9]\d\d$/);
    expect(h.apiCalls()).toBe(0);
  });

  test('tick never comes: the API answers once Polymarket has published openPrice', async () => {
    const h = harness({ apiOpenAtMs: 9_000 });
    expect(await resolveExactPtb(START, END, h.deps)).toBe('polymarket_twap_api');
    expect(h.log.filter(l => l.startsWith('replay'))).toHaveLength(1);
    expect(h.log.filter(l => l.startsWith('api')).map(l => Number(l.slice(4)))).toEqual([3_050, 8_050, 13_050]);
    expect(h.log.at(-1)).toBe(`exact polymarket_twap_api ${PTB}`);
  });

  test('started mid-window after a restart: no replay, straight to the API', async () => {
    const h = harness({ startedAt: START + 7 * 60_000, apiOpenAtMs: 0 });
    expect(await resolveExactPtb(START, END, h.deps)).toBe('polymarket_twap_api');
    expect(h.log.some(l => l.startsWith('replay'))).toBe(false);
  });

  test('stops when the market moves on, and gives up after its time budget', async () => {
    let n = 0;
    const moved = harness({ current: () => ++n < 5 });
    expect(await resolveExactPtb(START, END, moved.deps)).toBeNull();
    const never = harness({});
    expect(await resolveExactPtb(START, END, never.deps)).toBeNull();
    expect(never.log.at(-1)).toBe('gave up');
    expect(never.time() - START).toBeGreaterThanOrEqual(PTB_RESOLVER_TIMING.GIVE_UP_MS);
  });
});
