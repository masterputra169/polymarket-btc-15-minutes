/**
 * Pure core of the PTB-impact study (ptbImpactStudy.mts): what the bot's
 * decisions would have been with the price to beat Polymarket actually settles
 * on (Chainlink's 60 s TWAP at the window open) and with Chainlink, not Binance,
 * as the price compared with it.
 *
 * Only the pieces of the decision that can be recomputed EXACTLY from the tape
 * are replayed: filter 4c (BTC distance from the PTB) and 11c (trending ML floor,
 * whose threshold depends on which side of the PTB BTC sits). The rule score's
 * PTB-distance indicator is reported as a direction change only — its effect on
 * the family agreement count needs indicator votes the tape does not carry.
 */

import { estimateSettlePrice } from '../../bot/src/engines/settlePrice.ts';
import { readFilterThresholds } from '../../bot/src/safety/filterThresholds.ts';
import { categorizeReason, type GateId } from './decisionTrailCore.mts';

export type Side = 'UP' | 'DOWN';

const T = readFilterThresholds({}).values;

/** The market's real outcome: UP when the closing TWAP >= the price to beat. */
export function officialOutcome(ptb: number | null, final: number | null): Side | null {
  if (ptb == null || final == null || !Number.isFinite(ptb) || !Number.isFinite(final)) return null;
  return final >= ptb ? 'UP' : 'DOWN';
}

export interface SpotSample { t: number; pl: number }

/**
 * Chainlink-based settlement estimate at `nowMs` from the tape's 1 Hz Chainlink
 * spot samples (`pl`), exactly as the bot now computes it live
 * (bot/src/engines/settlePrice.ts). Sample times are local receive times, about
 * a second after Chainlink's stamps — close enough at 1 Hz.
 */
export function settleFromTape(samples: readonly SpotSample[], nowMs: number, endMs: number): number | null {
  let spot: number | null = null;
  for (const s of samples) if (s.t <= nowMs) spot = s.pl; else break;
  if (spot == null) return null;
  const ticks = samples.filter(s => s.t >= endMs - 61_000 && s.t <= nowMs).map(s => ({ ts: s.t, value: s.pl }));
  return estimateSettlePrice({ nowMs, endMs, spot, spotTicks: ticks, binance: null, basis: null }).price;
}

/** Filter 4c as tradeFilters.ts applies it (same thresholds module). */
export function btcDistBlocks(price: number | null, ptb: number | null, mlConf: number | null, timeLeftMin: number | null): boolean {
  if (!T.btcDistMinPct || price == null || ptb == null || !(ptb > 0)) return false;
  const distPct = Math.abs(price - ptb) / ptb * 100;
  const mlBypass = mlConf != null && mlConf >= T.btcDistMlBypass;
  const need = timeLeftMin != null && timeLeftMin > T.btcDistEarlyTimeLeft
    ? T.btcDistMinPct * T.btcDistEarlyFactor
    : timeLeftMin != null && timeLeftMin > T.btcDistMidTimeLeft
      ? T.btcDistMinPct * T.btcDistMidFactor
      : T.btcDistMinPct;
  return !mlBypass && distPct < need;
}

/** Filter 11c (trending regime ML floor), as tradeFilters.ts applies it. */
export function trendingMlBlocks(
  regime: string | null, side: Side | null, price: number | null, ptb: number | null,
  mlConf: number | null, bestEdge: number | null,
): boolean {
  if (regime !== 'trending' || mlConf == null) return false;
  if (bestEdge != null && bestEdge >= T.trendingEdgeBypass) return false;
  const favorsUp = price != null && ptb != null && price > ptb;
  const favorsDown = price != null && ptb != null && price < ptb;
  const aligned = (side === 'UP' && favorsUp) || (side === 'DOWN' && favorsDown);
  return mlConf < (aligned ? T.trendingMlWith : T.trendingMlAgainst);
}

/** The rule score's PTB-distance indicator direction, with the default thresholds. */
export function ptbIndicator(price: number | null, ptb: number | null): 'UP' | 'DOWN' | 'NEUTRAL' | null {
  if (price == null || ptb == null || !(ptb > 0)) return null;
  const d = (price - ptb) / ptb;
  if (Math.abs(d) <= 0.0005) return 'NEUTRAL';
  return d > 0 ? 'UP' : 'DOWN';
}

export interface Replay {
  /** Gates that blocked this decision with the bot's values (from the tape). */
  oldGates: GateId[];
  /** The same set with 4c and 11c recomputed on the corrected values. */
  newGates: GateId[];
  oldPass: boolean;
  newPass: boolean;
}

/**
 * Re-run the PTB-dependent gates of one decision. `fr` is the full reason list
 * the bot recorded; every other gate is kept as it was.
 */
export function replayGates(
  fr: readonly string[],
  corrected: { price: number | null; ptb: number | null },
  ctx: { side: Side | null; mlConf: number | null; timeLeftMin: number | null; regime: string | null; bestEdge: number | null },
): Replay {
  const oldGates = fr.map(categorizeReason);
  const kept = oldGates.filter(g => g !== 'btc_dist' && g !== 'trending_ml');
  const newGates: GateId[] = [...kept];
  if (btcDistBlocks(corrected.price, corrected.ptb, ctx.mlConf, ctx.timeLeftMin)) newGates.push('btc_dist');
  if (trendingMlBlocks(ctx.regime, ctx.side, corrected.price, corrected.ptb, ctx.mlConf, ctx.bestEdge)) newGates.push('trending_ml');
  return { oldGates, newGates, oldPass: oldGates.length === 0, newPass: newGates.length === 0 };
}
