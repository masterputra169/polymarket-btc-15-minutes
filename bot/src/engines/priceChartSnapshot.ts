/**
 * Pure 15-minute price chart snapshot builder for the dashboard live chart.
 *
 * Combines Chainlink spot + 60s TWAP ticks inside the current market window,
 * preserves 1s resolution over the trailing 90 seconds, evenly downsamples
 * earlier history so WS broadcasts stay compact (~3–4 KB), and resolves any
 * open-position entry marker onto the active window curve.
 */

import type { Tick } from '../streams/tickStore.ts';

/** `[unixSec, spotUsd | null, twap60Usd | null]` */
export type PriceChartPointTuple = [number, number | null, number | null];

export interface PriceChartEntry {
  ts: number;
  btcPrice: number;
  side: 'UP' | 'DOWN';
  tokenPrice: number | null;
}

export interface PriceChartSnapshot {
  slug: string | null;
  startMs: number | null;
  endMs: number | null;
  ptb: number | null;
  ptbExact: boolean;
  ptbSource: string | null;
  points: PriceChartPointTuple[];
  entry: PriceChartEntry | null;
}

export interface PriceChartPositionLike {
  side?: string | null;
  marketSlug?: string | null;
  settled?: boolean;
  enteredAt?: number | null;
  price?: number | null;
}

export interface BuildPriceChartInput {
  slug: string | null;
  startMs: number | null;
  endMs: number | null;
  nowMs: number;
  ptb: number | null;
  ptbExact: boolean;
  ptbSource: string | null;
  spotTicks: Tick[];
  twapTicks: Tick[];
  liveSpot?: number | null;
  liveTwap?: number | null;
  position?: PriceChartPositionLike | null;
  maxPoints?: number;
  fullResTailSec?: number;
}

const DEFAULT_MAX_POINTS = 300;
const DEFAULT_TAIL_SEC = 90;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function inBounds(tsMs: number, startMs: number | null, endMs: number | null): boolean {
  if (startMs != null && tsMs < startMs) return false;
  if (endMs != null && tsMs > endMs) return false;
  return true;
}

function findNearestSpotPrice(
  rows: PriceChartPointTuple[],
  targetMs: number,
): number | null {
  const targetSec = Math.round(targetMs / 1000);
  let bestVal: number | null = null;
  let bestDist = Infinity;
  for (let i = 0; i < rows.length; i++) {
    const val = rows[i][1] ?? rows[i][2];
    if (val == null || !Number.isFinite(val)) continue;
    const dist = Math.abs(rows[i][0] - targetSec);
    if (dist < bestDist) {
      bestDist = dist;
      bestVal = val;
    }
  }
  return bestVal;
}

export function buildPriceChartSnapshot(input: BuildPriceChartInput): PriceChartSnapshot {
  const {
    slug,
    startMs,
    endMs,
    nowMs,
    ptb,
    ptbExact,
    ptbSource,
    spotTicks,
    twapTicks,
    liveSpot = null,
    liveTwap = null,
    position = null,
    maxPoints = DEFAULT_MAX_POINTS,
    fullResTailSec = DEFAULT_TAIL_SEC,
  } = input;

  const bySec = new Map<number, { spot: number | null; twap: number | null }>();

  const upsert = (tsMs: number, kind: 'spot' | 'twap', value: number | null | undefined) => {
    if (!Number.isFinite(tsMs) || value == null || !Number.isFinite(value) || value <= 0) return;
    if (!inBounds(tsMs, startMs, endMs)) return;
    const sec = Math.round(tsMs / 1000);
    const prev = bySec.get(sec);
    const rounded = round2(value);
    if (prev) {
      prev[kind] = rounded;
    } else {
      bySec.set(sec, kind === 'spot' ? { spot: rounded, twap: null } : { spot: null, twap: rounded });
    }
  };

  for (let i = 0; i < spotTicks.length; i++) {
    upsert(spotTicks[i].ts, 'spot', spotTicks[i].value);
  }
  for (let i = 0; i < twapTicks.length; i++) {
    upsert(twapTicks[i].ts, 'twap', twapTicks[i].value);
  }

  // Append latest live value at nowSec only if strictly fresher than or missing from stored ticks.
  const nowSec = Math.round(nowMs / 1000);
  if (inBounds(nowSec * 1000, startMs, endMs)) {
    const existingNow = bySec.get(nowSec);
    if (liveSpot != null && Number.isFinite(liveSpot) && liveSpot > 0 && !existingNow?.spot) {
      let latestSpotSec = -Infinity;
      for (const [sec, v] of bySec) {
        if (v.spot != null && sec > latestSpotSec) latestSpotSec = sec;
      }
      if (nowSec > latestSpotSec) {
        upsert(nowSec * 1000, 'spot', liveSpot);
      }
    }
    if (liveTwap != null && Number.isFinite(liveTwap) && liveTwap > 0 && !existingNow?.twap) {
      let latestTwapSec = -Infinity;
      for (const [sec, v] of bySec) {
        if (v.twap != null && sec > latestTwapSec) latestTwapSec = sec;
      }
      if (nowSec > latestTwapSec) {
        upsert(nowSec * 1000, 'twap', liveTwap);
      }
    }
  }

  const rawRows: PriceChartPointTuple[] = [...bySec.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([sec, v]) => [sec, v.spot, v.twap]);

  // Resolve entry before downsampling so it uses the sharpest spot timestamp available.
  let entry: PriceChartEntry | null = null;
  if (
    position &&
    !position.settled &&
    slug &&
    position.marketSlug === slug &&
    (position.side === 'UP' || position.side === 'DOWN') &&
    typeof position.enteredAt === 'number' &&
    Number.isFinite(position.enteredAt)
  ) {
    const entryBtc =
      findNearestSpotPrice(rawRows, position.enteredAt) ??
      (liveSpot != null && Number.isFinite(liveSpot) ? round2(liveSpot) : null) ??
      (ptb != null && Number.isFinite(ptb) ? round2(ptb) : null);
    if (entryBtc != null) {
      entry = {
        ts: position.enteredAt,
        btcPrice: entryBtc,
        side: position.side,
        tokenPrice: typeof position.price === 'number' && Number.isFinite(position.price) ? position.price : null,
      };
    }
  }

  const cap = Math.max(4, Math.floor(maxPoints));
  let points = rawRows;
  if (rawRows.length > cap) {
    const latestSec = rawRows[rawRows.length - 1][0];
    const tailCutoff = latestSec - Math.max(0, fullResTailSec);
    let splitIdx = rawRows.findIndex(r => r[0] >= tailCutoff);
    if (splitIdx < 0) splitIdx = rawRows.length - 1;

    const head = rawRows.slice(0, splitIdx);
    const tail = rawRows.slice(splitIdx);
    const headBudget = Math.max(2, cap - tail.length);

    if (head.length <= headBudget) {
      points = [...head, ...tail];
    } else {
      const sampledHead: PriceChartPointTuple[] = [];
      const stride = (head.length - 1) / Math.max(1, headBudget - 1);
      let lastPicked = -1;
      for (let i = 0; i < headBudget; i++) {
        const idx = i === headBudget - 1 ? head.length - 1 : Math.round(i * stride);
        if (idx !== lastPicked && idx < head.length) {
          sampledHead.push(head[idx]);
          lastPicked = idx;
        }
      }
      // Guarantee index 0 stays intact
      if (sampledHead.length === 0 || sampledHead[0][0] !== head[0][0]) {
        sampledHead.unshift(head[0]);
      }
      points = [...sampledHead, ...tail];
      if (points.length > cap) {
        // Trim extra oldest head samples after index 0 if tail consumed almost the whole cap
        const excess = points.length - cap;
        points = [points[0], ...points.slice(1 + excess)];
      }
    }
  }

  return {
    slug,
    startMs,
    endMs,
    ptb: ptb != null && Number.isFinite(ptb) ? round2(ptb) : null,
    ptbExact: Boolean(ptbExact),
    ptbSource,
    points,
    entry,
  };
}
