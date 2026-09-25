/**
 * Polymarket's own open/close for a BTC 15m window, on the 60-second TWAP the
 * market settles on — the fallback for the price to beat when the RTDS TWAP
 * tick for the window's first second did not arrive.
 *
 *   GET https://polymarket.com/api/crypto/crypto-price?symbol=BTC
 *       &eventStartTime=<ISO>&variant=fifteen&endDate=<ISO>
 *       &twapEnabled=true&twapLookbackSeconds=60
 *   → { openPrice, closePrice, completed, incomplete, cached, timestamp }
 *
 * The two twap parameters are the whole point: without them the endpoint
 * answers with the SPOT price at the boundary, which is not what settles
 * (several public bots get this wrong). openPrice is null until a few seconds
 * after the window opens and the response is cached ~10 s, so it is polled, not
 * trusted to be there at once. The endpoint is undocumented and answers 429
 * quickly, so calls are spaced MIN_GAP_MS apart process-wide and back off on 429.
 */

import { fetchTextWithPolymarketDoh } from '../services/polymarketHttp.ts';

export interface TwapWindowPrice {
  openPrice: number | null;
  closePrice: number | null;
  completed: boolean;
}

const BASE = 'https://polymarket.com/api/crypto/crypto-price';
const MIN_GAP_MS = 5_000;
const BACKOFF_429_MS = 30_000;

let nextAllowedMs = 0;

const iso = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z');

export function twapWindowPriceUrl(startMs: number, endMs: number): string {
  return `${BASE}?symbol=BTC&eventStartTime=${iso(startMs)}&variant=fifteen&endDate=${iso(endMs)}&twapEnabled=true&twapLookbackSeconds=60`;
}

/** Parse the endpoint's body. Exported for tests. */
export function parseTwapWindowPrice(body: string): TwapWindowPrice | null {
  let j: any;
  try { j = JSON.parse(body); } catch { return null; }
  if (!j || typeof j !== 'object') return null;
  const num = (v: unknown) => {
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
    return Number.isFinite(n) && n > 1_000 ? n : null;
  };
  return { openPrice: num(j.openPrice), closePrice: num(j.closePrice), completed: j.completed === true };
}

/**
 * Fetch the window's TWAP open/close. Returns null when the call is skipped
 * (spacing / 429 backoff) or fails — the caller simply tries again later.
 */
export async function fetchTwapWindowPrice(
  startMs: number,
  endMs: number,
  deps: { fetchText?: (url: string) => Promise<string>; now?: () => number } = {},
): Promise<TwapWindowPrice | null> {
  const now = deps.now ?? Date.now;
  if (now() < nextAllowedMs) return null;
  nextAllowedMs = now() + MIN_GAP_MS;
  const fetchText = deps.fetchText ?? ((url: string) => fetchTextWithPolymarketDoh(url, { timeoutMs: 8_000, label: 'TWAP window price' }));
  try {
    return parseTwapWindowPrice(await fetchText(twapWindowPriceUrl(startMs, endMs)));
  } catch (err) {
    if (/\b429\b/.test(String((err as Error)?.message ?? err))) nextAllowedMs = now() + BACKOFF_429_MS;
    return null;
  }
}

/** Test seam: clear the spacing/backoff state. */
export function resetTwapWindowPriceThrottle(): void {
  nextAllowedMs = 0;
}
