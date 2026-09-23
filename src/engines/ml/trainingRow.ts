/**
 * Offline side of the shared ML feature pipeline: turns historical Binance 1m
 * candles plus one Polymarket market's price history into the same
 * FeatureSnapshot the live bot builds, for exactly one instant.
 *
 * Used by backtest/ml_training/generateTrainingData.mts. It lives under src/
 * so it is typechecked and unit-tested with the live code it must agree with
 * (see featureInputs.ts for why the two sides share one builder).
 *
 * The rules that keep a row honest:
 *   - The instant is a candle CLOSE (openTime + 60s). Every candle in the row
 *     has closed by then; nothing after it is read.
 *   - Price to beat is the open of the candle that starts the market window,
 *     the price the market resolves against, from the same Binance feed.
 *   - Token prices are the last print at or before the instant. No
 *     interpolation, because interpolating toward the next print reads the
 *     future.
 */

import type { MarketCandle } from '../../hooks/computeIndicators.ts';
import { buildMlFeatureInputs, MARKET_MOMENTUM_WINDOW_MS, WINDOW_MINUTES, type FeatureSnapshot } from './featureInputs.ts';
import { extractLiveFeaturesInPlace, featureBuf } from './featureExtract.ts';

export interface HistoricalCandle extends MarketCandle {
  /** Candle open, epoch ms. */
  openTime: number;
}

/** One market from polymarket_lookup.json. `prices` = [secondsIntoWindow, upPrice][], ascending. */
export interface LookupMarket {
  label: number;
  prices: Array<[number, number]>;
  spread?: number;
}

const MINUTE_MS = 60_000;
const FIVE_MIN_MS = 5 * MINUTE_MS;
const WINDOW_SECS = WINDOW_MINUTES * 60;

/** Same depth as the live fetch (fetchKlines limit 240 / 48). */
export const CANDLES_1M = 240;
export const CANDLES_5M = 48;

/** Earliest and latest instant a row may describe, in seconds into the window. */
export const MIN_SECS_INTO_WINDOW = 60;
export const MAX_SECS_INTO_WINDOW = WINDOW_SECS - 60;

/**
 * Last recorded UP price at or before `secs` into the window, or null if the
 * market had not printed yet. Never looks past `secs`.
 */
export function priceAtOrBefore(prices: ReadonlyArray<[number, number]>, secs: number): number | null {
  let found: number | null = null;
  for (const [t, p] of prices) {
    if (t > secs) break;
    if (Number.isFinite(p)) found = p;
  }
  return found;
}

/**
 * Aggregate 1m candles into 5m candles aligned to 5-minute boundaries. The
 * last bucket may be partial, the same as the forming 5m candle a live fetch
 * returns.
 */
export function aggregate5m(candles1m: ReadonlyArray<HistoricalCandle>): HistoricalCandle[] {
  const out: HistoricalCandle[] = [];
  for (const c of candles1m) {
    const bucket = Math.floor(c.openTime / FIVE_MIN_MS) * FIVE_MIN_MS;
    const last = out[out.length - 1];
    if (last && last.openTime === bucket) {
      out[out.length - 1] = {
        ...last,
        high: Math.max(last.high, c.high),
        low: Math.min(last.low, c.low),
        close: c.close,
        volume: last.volume + c.volume,
        takerBuyVolume: (last.takerBuyVolume ?? 0) + (c.takerBuyVolume ?? 0),
      };
    } else {
      out.push({
        openTime: bucket, open: c.open, high: c.high, low: c.low, close: c.close,
        volume: c.volume, takerBuyVolume: c.takerBuyVolume ?? 0,
      });
    }
  }
  return out;
}

/** Start of the 15-minute window containing `ms`, epoch seconds. */
export function windowStartSecs(ms: number): number {
  return Math.floor(ms / 1000 / WINDOW_SECS) * WINDOW_SECS;
}

/**
 * Indices of candles whose close falls inside the tradeable part of the window
 * starting at `slugTs` (seconds), given candles sorted by openTime.
 */
export function candidateIndices(candles1m: ReadonlyArray<HistoricalCandle>, slugTs: number): number[] {
  const startMs = slugTs * 1000;
  const out: number[] = [];
  let lo = 0;
  let hi = candles1m.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (candles1m[mid].openTime < startMs) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo; i < candles1m.length; i++) {
    const secsInto = (candles1m[i].openTime + MINUTE_MS) / 1000 - slugTs;
    if (secsInto > MAX_SECS_INTO_WINDOW) break;
    if (secsInto >= MIN_SECS_INTO_WINDOW) out.push(i);
  }
  return out;
}

/**
 * Snapshot at the close of candle `idx`, or null when the row cannot be built
 * honestly: not enough history, a gap in the candles, the instant outside the
 * tradeable part of the window, or no token print yet.
 */
export function buildTrainingSnapshot({
  candles1m, idx, slugTs, market, fundingRatePct = null,
}: {
  candles1m: ReadonlyArray<HistoricalCandle>;
  idx: number;
  slugTs: number;
  market: LookupMarket;
  fundingRatePct?: number | null;
}): FeatureSnapshot | null {
  if (idx < CANDLES_1M - 1 || idx >= candles1m.length) return null;
  const candle = candles1m[idx];
  const nowMs = candle.openTime + MINUTE_MS;
  const secsInto = nowMs / 1000 - slugTs;
  if (secsInto < MIN_SECS_INTO_WINDOW || secsInto > MAX_SECS_INTO_WINDOW) return null;

  // The candle that opens the window, found by position and then verified, so
  // a gap in the data can never pass a neighbouring candle off as the PTB.
  const openIdx = idx - Math.round(secsInto / 60) + 1;
  if (openIdx < 0 || candles1m[openIdx]?.openTime !== slugTs * 1000) return null;

  const slice = candles1m.slice(idx - CANDLES_1M + 1, idx + 1);
  // A gap anywhere in the history would silently stretch every indicator.
  if (slice[slice.length - 1].openTime - slice[0].openTime !== (CANDLES_1M - 1) * MINUTE_MS) return null;

  const prices = market?.prices;
  if (!Array.isArray(prices) || prices.length === 0) return null;
  const marketUp = priceAtOrBefore(prices, secsInto);
  if (marketUp == null) return null;
  const lagSecs = secsInto - MARKET_MOMENTUM_WINDOW_MS / 1000;
  const marketUpLag = lagSecs >= 0 ? priceAtOrBefore(prices, lagSecs) : null;

  return {
    candles1m: slice,
    candles5m: aggregate5m(slice).slice(-CANDLES_5M),
    lastPrice: candle.close,
    windowOpenPrice: candles1m[openIdx].open,
    minutesLeft: (WINDOW_SECS - secsInto) / 60,
    nowMs,
    marketUp,
    marketUpLag,
    fundingRate: fundingRatePct != null && Number.isFinite(fundingRatePct) ? { ratePct: fundingRatePct } : null,
  };
}

/**
 * The base feature vector for a snapshot, through exactly the calls the live
 * predictor makes. Returns a copy; featureBuf is reused on the next call.
 */
export function buildTrainingFeatures(snapshot: FeatureSnapshot, baseFeatureCount: number): number[] {
  const { marketState, ruleProbUp } = buildMlFeatureInputs(snapshot);
  extractLiveFeaturesInPlace({
    ...marketState,
    ruleProbUp,
    ruleConfidence: Math.abs(ruleProbUp - 0.5) * 2,
  });
  return Array.from(featureBuf.subarray(0, baseFeatureCount));
}
