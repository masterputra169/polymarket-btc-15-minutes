/**
 * The bot's Chainlink BTC/USD 60-second TWAP feed — the series BTC 15m markets
 * settle on (see engines/ptbSources.ts). Started once from bot/index.ts; read by
 * the PTB resolver (price to beat = the tick stamped at the window start), the
 * settlement fallback (final price = the tick stamped at the window end) and the
 * status broadcast.
 */

import { createRtdsTickFeed, type RtdsTickFeedHealth } from './rtdsTickFeed.ts';

export const TWAP_TOPIC = 'crypto_prices_twap_sixty';

const feed = createRtdsTickFeed({ topic: TWAP_TOPIC, symbol: 'btc/usd', keepMs: 20 * 60_000 });

export function startTwapFeed(): void { feed.start(); }
export function stopTwapFeed(): void { feed.stop(); }
/** The TWAP stamped exactly at `ts` (ms, whole second), or null. */
export function getTwapAt(ts: number): number | null { return feed.at(ts); }
export function getLatestTwap(): { ts: number; value: number } | null { return feed.latest(); }
export function requestTwapReplay(reason: string): void { feed.replay(reason); }
export function getTwapFeedHealth(): RtdsTickFeedHealth { return feed.health(); }
