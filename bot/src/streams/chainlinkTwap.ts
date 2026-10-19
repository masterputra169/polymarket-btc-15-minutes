/**
 * The bot's Chainlink BTC/USD 60-second TWAP feed — the series BTC 15m markets
 * settle on (see engines/ptbSources.ts). Started once from bot/index.ts; read by
 * the PTB resolver (price to beat = the tick stamped at the window start), the
 * settlement fallback (final price = the tick stamped at the window end) and the
 * status broadcast.
 *
 * Since 2026-10-19 the primary source is PolyBolt channel `price.crypto.twap`
 * (`wss://ws-live-v2.polymarket.com/ws`, CLOB-authenticated) — the documented
 * replacement for RTDS topic `crypto_prices_twap_sixty`, whose removal is
 * expected ~2026-10-23. The RTDS feed stays connected as a shadow fallback
 * unless `POLYBOLT_RTDS_FALLBACK=off`, and every read prefers PolyBolt while
 * falling back to RTDS per tick: during the rollout neither socket's outage can
 * cost the exact price to beat.
 *
 * Which feed is primary: `TWAP_FEED=polybolt|rtds`. Unset/auto → polybolt when
 * the CLOB L2 credentials are present, rtds otherwise.
 *
 * This module is the seam: loop.ts and index.ts import the same functions as
 * before, so the migration needs no change there.
 */

import { createLogger } from '../logger.ts';
import { createRtdsTickFeed, type RtdsTickFeed, type RtdsTickFeedHealth } from './rtdsTickFeed.ts';
import {
  createPolyBoltFeed,
  POLYBOLT_TWAP_CHANNEL,
  resolveTwapFeedMode,
  rtdsFallbackEnabled,
  type PolyBoltFeed,
  type PolyBoltHealth,
  type TwapFeedMode,
} from './polyboltWs.ts';
import type { Tick } from './tickStore.ts';

export const TWAP_TOPIC = 'crypto_prices_twap_sixty';
const KEEP_MS = 20 * 60_000;
const log = createLogger('TWAP');

const mode: TwapFeedMode = resolveTwapFeedMode(process.env);
const keepRtds = mode === 'rtds' || rtdsFallbackEnabled(process.env);

const rtds: RtdsTickFeed | null = keepRtds
  ? createRtdsTickFeed({ topic: TWAP_TOPIC, symbol: 'btc/usd', keepMs: KEEP_MS })
  : null;

const polybolt: PolyBoltFeed | null = mode === 'polybolt'
  ? createPolyBoltFeed({
      name: 'TWAP',
      channel: POLYBOLT_TWAP_CHANNEL,
      filter: { symbol: 'btcusd', window_seconds: 60 },
      keepMs: KEEP_MS,
    })
  : null;

export interface TwapFeedHealth extends RtdsTickFeedHealth {
  mode: TwapFeedMode;
  polybolt: PolyBoltHealth | null;
  rtds: RtdsTickFeedHealth | null;
}

/** Which source is primary ('polybolt' or 'rtds'); fixed for the process life. */
export function getTwapFeedMode(): TwapFeedMode { return mode; }

export function startTwapFeed(): void {
  if (polybolt) {
    polybolt.start();
    log.info(`TWAP source: PolyBolt price.crypto.twap btcusd/60s${rtds ? ' (RTDS shadow fallback connected)' : ''}`);
  } else {
    log.info('TWAP source: RTDS crypto_prices_twap_sixty (PolyBolt disabled)');
  }
  rtds?.start();
}

export function stopTwapFeed(): void {
  polybolt?.stop();
  rtds?.stop();
}

/** The TWAP stamped exactly at `ts` (ms, whole second), or null. */
export function getTwapAt(ts: number): number | null {
  return polybolt?.at(ts) ?? rtds?.at(ts) ?? null;
}

export function getLatestTwap(): Tick | null {
  const pb = polybolt?.latest() ?? null;
  const rd = rtds?.latest() ?? null;
  if (pb && rd) return pb.ts >= rd.ts ? pb : rd;
  return pb ?? rd;
}

export function requestTwapReplay(reason: string): void {
  polybolt?.replay(reason);
  rtds?.replay(reason);
}

export function getTwapFeedHealth(): TwapFeedHealth {
  const pb = polybolt?.health() ?? null;
  const rd = rtds?.health() ?? null;
  return {
    mode,
    connected: (pb?.connected ?? false) || (rd?.connected ?? false),
    ticks: (pb?.ticks ?? 0) + (rd?.ticks ?? 0),
    lastTick: getLatestTwap(),
    lastTickRecvMs: Math.max(pb?.lastTickRecvMs ?? 0, rd?.lastTickRecvMs ?? 0),
    reconnects: (pb?.reconnects ?? 0) + (rd?.reconnects ?? 0),
    parseErrors: (pb?.parseErrors ?? 0) + (rd?.parseErrors ?? 0),
    polybolt: pb,
    rtds: rd,
  };
}
