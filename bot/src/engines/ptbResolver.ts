/**
 * Resolve the exact price to beat of one BTC 15m window.
 *
 * The window settles on Chainlink's 60-second TWAP, and its price to beat is the
 * TWAP tick stamped at the window's first second. That tick normally arrives on
 * the RTDS socket 0.7-1.3 s after the boundary. About 3% of seconds never arrive
 * live, so the resolver:
 *   1. checks the tick store every CHECK_MS from the boundary;
 *   2. once REPLAY_AFTER_MS has passed without it, asks the socket for a replay
 *      (a fresh subscribe re-sends the last ~60 s);
 *   3. from API_AFTER_MS, also asks polymarket.com's crypto-price endpoint (TWAP
 *      parameters) — spaced by the adapter, so at most one call per 5 s;
 *   4. gives up GIVE_UP_MS after it started (then the window has no exact PTB
 *      and is not traded: the entry gate requires an exact source).
 * Started mid-window (after a restart), the tick is past the replay horizon and
 * the API answers at once.
 * The first exact answer wins and is handed to onExact once.
 *
 * Everything time- or network-dependent is injected, so the schedule is tested
 * with fake timers.
 */

import type { TwapWindowPrice } from '../adapters/twapWindowPrice.ts';

export interface PtbResolverDeps {
  tickAt: (ts: number) => number | null;
  replay: (reason: string) => void;
  fetchWindow: (startMs: number, endMs: number) => Promise<TwapWindowPrice | null>;
  /** Still the market this resolution is for? Stops the resolver when false. */
  isCurrent: () => boolean;
  onExact: (value: number, source: 'chainlink_twap' | 'polymarket_twap_api', atMs: number) => void;
  onGiveUp?: (reason: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export const PTB_RESOLVER_TIMING = {
  CHECK_MS: 250,
  REPLAY_AFTER_MS: 2_500,
  API_AFTER_MS: 3_000,
  API_EVERY_MS: 5_000,
  GIVE_UP_MS: 5 * 60_000,
};

const defaultSleep = (ms: number) => new Promise<void>(r => { const t = setTimeout(r, ms); t.unref?.(); });

/**
 * Run until the exact PTB is found, the market changes, or GIVE_UP_MS passes.
 * Resolves to the source that answered, or null. Never throws.
 */
export async function resolveExactPtb(startMs: number, endMs: number, deps: PtbResolverDeps): Promise<string | null> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const T = PTB_RESOLVER_TIMING;
  const began = now();
  let replayed = false;
  let nextApiMs = startMs + T.API_AFTER_MS;
  let apiInFlight: Promise<void> | null = null;
  let apiValue: number | null = null;

  try {
    while (true) {
      if (!deps.isCurrent()) return null;
      const t = now();
      const tick = deps.tickAt(startMs);
      if (tick != null && tick > 0) {
        deps.onExact(tick, 'chainlink_twap', t);
        return 'chainlink_twap';
      }
      if (apiValue != null) {
        deps.onExact(apiValue, 'polymarket_twap_api', t);
        return 'polymarket_twap_api';
      }
      if (t - began >= T.GIVE_UP_MS) {
        deps.onGiveUp?.(`no TWAP tick at ${new Date(startMs).toISOString()} and no API openPrice after ${Math.round(T.GIVE_UP_MS / 1000)}s of trying`);
        return null;
      }
      if (!replayed && t - startMs >= T.REPLAY_AFTER_MS && t - startMs < 60_000) {
        replayed = true;
        deps.replay(`TWAP tick for ${new Date(startMs).toISOString()} missing after ${((t - startMs) / 1000).toFixed(1)}s`);
      }
      if (!apiInFlight && t >= nextApiMs) {
        nextApiMs = t + T.API_EVERY_MS;
        apiInFlight = deps.fetchWindow(startMs, endMs)
          .then(r => { if (r?.openPrice != null) apiValue = r.openPrice; })
          .catch(() => { /* try again next round */ })
          .finally(() => { apiInFlight = null; });
      }
      await sleep(T.CHECK_MS);
    }
  } catch (err) {
    deps.onGiveUp?.(`resolver error: ${(err as Error)?.message ?? err}`);
    return null;
  }
}
