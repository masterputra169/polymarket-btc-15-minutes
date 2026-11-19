/**
 * Pure math helpers for the live BTC 15m Polymarket-style chart.
 * Kept DOM/React-free so every geometry invariant is directly unit-testable.
 */

export type ChartPointTuple = [number, number | null, number | null];

export interface ChartEntryMarker {
  ts: number;
  btcPrice: number;
  side: 'UP' | 'DOWN';
  tokenPrice: number | null;
}

export interface PriceChartSnapshotLike {
  slug?: string | null;
  startMs?: number | null;
  endMs?: number | null;
  ptb?: number | null;
  ptbExact?: boolean;
  ptbSource?: string | null;
  points?: ChartPointTuple[] | null;
  entry?: ChartEntryMarker | null;
}

export interface ChartPoint {
  tsMs: number;
  spot: number | null;
  twap: number | null;
}

export interface XYPoint {
  x: number;
  y: number;
}

export interface CubicSegment {
  cp1x: number;
  cp1y: number;
  cp2x: number;
  cp2y: number;
  x: number;
  y: number;
}

export interface YDomain {
  min: number;
  max: number;
  ticks: number[];
}

export interface TimeTick {
  tsMs: number;
  offsetMin: number;
}

function isValidPrice(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

export function decodeSnapshotPoints(snapshot: PriceChartSnapshotLike | null | undefined): ChartPoint[] {
  const tuples = snapshot?.points;
  if (!Array.isArray(tuples) || tuples.length === 0) return [];
  const out: ChartPoint[] = [];
  for (let i = 0; i < tuples.length; i++) {
    const row = tuples[i];
    if (!Array.isArray(row) || row.length < 3) continue;
    const sec = Number(row[0]);
    if (!Number.isFinite(sec) || sec <= 0) continue;
    const spot = isValidPrice(row[1]) ? row[1] : null;
    const twap = isValidPrice(row[2]) ? row[2] : null;
    if (spot == null && twap == null) continue;
    out.push({ tsMs: Math.round(sec * 1000), spot, twap });
  }
  out.sort((a, b) => a.tsMs - b.tsMs);
  return dedupeSortedPoints(out);
}

function dedupeSortedPoints(sorted: ChartPoint[]): ChartPoint[] {
  if (sorted.length <= 1) return sorted;
  const deduped: ChartPoint[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i];
    const prev = deduped[deduped.length - 1];
    if (cur.tsMs === prev.tsMs) {
      deduped[deduped.length - 1] = {
        tsMs: cur.tsMs,
        spot: cur.spot ?? prev.spot,
        twap: cur.twap ?? prev.twap,
      };
    } else {
      deduped.push(cur);
    }
  }
  return deduped;
}

/**
 * Combines the bot's 1 Hz window snapshot with fresher browser-observed live ticks.
 * Only appends live trail points strictly newer than the snapshot's last point so
 * historical shapes always match the authoritative bot tick stores.
 */
export function mergeChartSeries(
  snapshot: PriceChartSnapshotLike | null | undefined,
  liveTrail: readonly ChartPoint[],
): ChartPoint[] {
  const base = decodeSnapshotPoints(snapshot);
  const lastSnapTs = base.length > 0 ? base[base.length - 1].tsMs : -Infinity;
  const endMs = snapshot?.endMs ?? Infinity;

  if (liveTrail.length === 0) return base;

  const combined = base.slice();
  for (let i = 0; i < liveTrail.length; i++) {
    const pt = liveTrail[i];
    if (!Number.isFinite(pt.tsMs) || pt.tsMs <= lastSnapTs) continue;
    if (endMs != null && Number.isFinite(endMs) && pt.tsMs > endMs) continue;
    const spot = isValidPrice(pt.spot) ? pt.spot : null;
    const twap = isValidPrice(pt.twap) ? pt.twap : null;
    if (spot == null && twap == null) continue;
    combined.push({ tsMs: pt.tsMs, spot, twap });
  }

  combined.sort((a, b) => a.tsMs - b.tsMs);
  return dedupeSortedPoints(combined);
}

function niceStep(rawStep: number): number {
  if (!Number.isFinite(rawStep) || rawStep <= 0) return 10;
  const pow = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / pow;
  const mult = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  return mult * pow;
}

/**
 * Computes a padded Y domain that always keeps `ptb` and every curve point inside view,
 * enforces a minimum vertical span to prevent calm-market amplification jitter,
 * and returns 4–5 clean rounded grid ticks.
 */
export function computeYDomain(
  values: readonly (number | null | undefined)[],
  ptb: number | null | undefined,
  minSpanFloor = 40,
): YDomain {
  let lo = Infinity;
  let hi = -Infinity;

  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (isValidPrice(v)) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  if (isValidPrice(ptb)) {
    if (ptb < lo) lo = ptb;
    if (ptb > hi) hi = ptb;
  }

  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    return { min: 0, max: 100, ticks: [20, 40, 60, 80] };
  }

  const mid = (lo + hi) / 2;
  const ref = isValidPrice(ptb) ? ptb : mid;
  const floorSpan = Math.max(minSpanFloor, ref * 0.00045);
  const rawSpan = hi - lo;
  const span = Math.max(rawSpan, floorSpan);
  const half = span / 2;

  // Ensure both data extrema and PTB sit comfortably inside before applying padding.
  const spanLo = rawSpan >= floorSpan ? lo : Math.min(lo, mid - half);
  const spanHi = rawSpan >= floorSpan ? hi : Math.max(hi, mid + half);
  const pad = Math.max(4, (spanHi - spanLo) * 0.16);
  const min = spanLo - pad;
  const max = spanHi + pad;

  const step = niceStep((max - min) / 4.2);
  const firstTick = Math.ceil((min + step * 0.18) / step) * step;
  const maxTick = max - step * 0.18;
  const ticks: number[] = [];
  for (let t = firstTick; t <= maxTick + 1e-6 && ticks.length < 7; t += step) {
    ticks.push(Math.round(t * 100) / 100);
  }
  if (ticks.length === 0) {
    ticks.push(Math.round(mid));
  }

  return { min, max, ticks };
}

/**
 * Fritsch–Carlson monotone cubic Hermite spline converted to canvas cubic Bezier segments.
 * Guarantees each segment stays strictly bounded by its endpoint Y values (zero overshoot).
 */
export function computeMonotoneSegments(pts: readonly XYPoint[]): CubicSegment[] {
  const n = pts.length;
  if (n < 2) return [];

  if (n === 2) {
    const p0 = pts[0];
    const p1 = pts[1];
    const dx = p1.x - p0.x;
    const dy = p1.y - p0.y;
    return [{
      cp1x: p0.x + dx / 3,
      cp1y: p0.y + dy / 3,
      cp2x: p0.x + (2 * dx) / 3,
      cp2y: p0.y + (2 * dy) / 3,
      x: p1.x,
      y: p1.y,
    }];
  }

  const dx = new Array<number>(n - 1);
  const d = new Array<number>(n - 1);
  for (let i = 0; i < n - 1; i++) {
    const spanX = Math.max(1e-4, pts[i + 1].x - pts[i].x);
    dx[i] = spanX;
    d[i] = (pts[i + 1].y - pts[i].y) / spanX;
  }

  const m = new Array<number>(n).fill(0);
  m[0] = d[0];
  m[n - 1] = d[n - 2];

  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] === 0 || d[i] === 0 || d[i - 1] * d[i] <= 0) {
      m[i] = 0;
    } else {
      const w1 = 2 * dx[i] + dx[i - 1];
      const w2 = dx[i] + 2 * dx[i - 1];
      m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
    }
  }

  // Clamp tangents to prevent any local extrema overshoot inside intervals.
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const h = a * a + b * b;
    if (h > 9) {
      const tau = 3 / Math.sqrt(h);
      m[i] = tau * a * d[i];
      m[i + 1] = tau * b * d[i];
    }
  }

  const segments: CubicSegment[] = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    const thirdDx = dx[i] / 3;
    segments[i] = {
      cp1x: pts[i].x + thirdDx,
      cp1y: pts[i].y + m[i] * thirdDx,
      cp2x: pts[i + 1].x - thirdDx,
      cp2y: pts[i + 1].y - m[i + 1] * thirdDx,
      x: pts[i + 1].x,
      y: pts[i + 1].y,
    };
  }
  return segments;
}

/** O(log N) binary search for nearest timestamp index. */
export function findNearestPointIndex(points: readonly { tsMs: number }[], targetTsMs: number): number {
  const n = points.length;
  if (n === 0 || !Number.isFinite(targetTsMs)) return -1;
  if (targetTsMs <= points[0].tsMs) return 0;
  if (targetTsMs >= points[n - 1].tsMs) return n - 1;

  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].tsMs <= targetTsMs) lo = mid;
    else hi = mid;
  }
  return Math.abs(targetTsMs - points[lo].tsMs) <= Math.abs(points[hi].tsMs - targetTsMs) ? lo : hi;
}

/** Build evenly spaced 3-minute ticks across `[startMs, endMs]`. */
export function buildTimeTicks(startMs: number, endMs: number, stepMinutes = 3): TimeTick[] {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return [];
  const totalMin = Math.round((endMs - startMs) / 60_000);
  const step = Math.max(1, stepMinutes);
  const ticks: TimeTick[] = [];
  for (let m = 0; m <= totalMin; m += step) {
    const tsMs = startMs + m * 60_000;
    if (tsMs <= endMs) ticks.push({ tsMs, offsetMin: m });
  }
  return ticks;
}

/**
 * Separates the live price badge from the PTB anchor badge on the right axis
 * so they never visually collide when BTC hovers right around Price to Beat.
 */
export function resolvePillY(
  preferredY: number,
  anchorY: number | null,
  minY: number,
  maxY: number,
  minGap = 20,
): number {
  const clampY = (y: number) => Math.max(minY, Math.min(maxY, y));
  let y = clampY(preferredY);
  if (anchorY == null || !Number.isFinite(anchorY)) return y;

  const diff = y - anchorY;
  if (Math.abs(diff) >= minGap) return y;

  // Push cleanly away on whichever side fits best, flipping if pinned against border.
  const goAbove = diff <= 0;
  const firstChoice = goAbove ? anchorY - minGap : anchorY + minGap;
  if (firstChoice >= minY && firstChoice <= maxY) return firstChoice;

  const altChoice = goAbove ? anchorY + minGap : anchorY - minGap;
  return clampY(altChoice);
}

/**
 * Returns true when an axis grid tick label is close enough to any right-axis pill
 * (`live` or `PTB`) that drawing both would cause text overlap.
 */
export function shouldHideAxisTick(
  tickY: number,
  pillYs: readonly (number | null | undefined)[],
  minClearance = 16,
): boolean {
  if (!Number.isFinite(tickY)) return false;
  for (let i = 0; i < pillYs.length; i++) {
    const py = pillYs[i];
    if (py != null && Number.isFinite(py) && Math.abs(tickY - py) < minClearance) {
      return true;
    }
  }
  return false;
}
