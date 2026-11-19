import React, { memo, useEffect, useRef, useState } from 'react';
import { serverNow } from '../hooks/serverClock.ts';
import { formatNumber, fmtTimeLeft } from '../utils.ts';
import {
  buildTimeTicks,
  computeCanvasBackingSize,
  computeMonotoneSegments,
  computeYDomain,
  decodeSnapshotPoints,
  findNearestPointIndex,
  mergeChartSeries,
  resolvePillY,
  shouldHideAxisTick,
  type ChartEntryMarker,
  type ChartPoint,
  type PriceChartSnapshotLike,
  type XYPoint,
} from './priceChartMath.ts';

type ChartSeriesMode = 'both' | 'spot' | 'twap';

export interface PriceChartOpenPos {
  side: string;
  price: number | null;
  enteredAt: number | null;
}

export interface PriceChartPanelData {
  priceChart: PriceChartSnapshotLike | null;
  oraclePrice: number | null;
  settlePrice: number | null;
  twapNow: number | null;
  priceToBeat: number | null;
  ptbExact: boolean | null;
  ptbSource: string | null;
  settlementMs: number | null;
  timeLeftMin: number | null;
  marketSlug: string | null;
  marketUp: number | null;
  marketDown: number | null;
  openPosition: PriceChartOpenPos | null;
}

interface ChartPalette {
  green: string;
  red: string;
  amber: string;
  accent: string;
  text: string;
  muted: string;
  dim: string;
  panel: string;
}

const DEFAULT_PALETTE: ChartPalette = {
  green: '#34d399',
  red: '#fb7185',
  amber: '#fbbf24',
  accent: '#22d3ee',
  text: '#edf4ff',
  muted: '#94a3b8',
  dim: '#5d6c85',
  panel: '#0a1322',
};

const WINDOW_MS = 15 * 60_000;
const TWAP_ZONE_MS = 60_000;
const MAX_LIVE_TRAIL_POINTS = 900;
const LIVE_TRAIL_MIN_STEP_MS = 200;

function readThemePalette(el: HTMLElement | null): ChartPalette {
  if (!el || typeof window === 'undefined' || !window.getComputedStyle) return DEFAULT_PALETTE;
  const cs = window.getComputedStyle(el);
  const pick = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return {
    green: pick('--dash-green', DEFAULT_PALETTE.green),
    red: pick('--dash-red', DEFAULT_PALETTE.red),
    amber: pick('--dash-amber', DEFAULT_PALETTE.amber),
    accent: pick('--dash-accent', DEFAULT_PALETTE.accent),
    text: pick('--dash-text', DEFAULT_PALETTE.text),
    muted: pick('--dash-muted', DEFAULT_PALETTE.muted),
    dim: pick('--dash-dim', DEFAULT_PALETTE.dim),
    panel: pick('--dash-panel', DEFAULT_PALETTE.panel),
  };
}

function fmtUsd(v: number, digits = 2): string {
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function fmtClockHm(tsMs: number): string {
  const d = new Date(tsMs);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function fmtClockHms(tsMs: number): string {
  const d = new Date(tsMs);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function traceCurve(ctx: CanvasRenderingContext2D, pts: readonly XYPoint[]): void {
  if (pts.length === 0) return;
  const segs = computeMonotoneSegments(pts);
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    ctx.bezierCurveTo(s.cp1x, s.cp1y, s.cp2x, s.cp2y, s.x, s.y);
  }
}

function traceArea(ctx: CanvasRenderingContext2D, pts: readonly XYPoint[], baseY: number): void {
  if (pts.length < 2) return;
  const segs = computeMonotoneSegments(pts);
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    ctx.bezierCurveTo(s.cp1x, s.cp1y, s.cp2x, s.cp2y, s.x, s.y);
  }
  ctx.lineTo(pts[pts.length - 1].x, baseY);
  ctx.lineTo(pts[0].x, baseY);
  ctx.closePath();
}

function drawAxisPill(
  ctx: CanvasRenderingContext2D,
  x: number,
  centerY: number,
  width: number,
  height: number,
  label: string,
  bg: string,
  border: string,
  textColor: string,
): void {
  const px = Math.round(x);
  const py = Math.round(centerY - height / 2);
  drawRoundedRect(ctx, px + 0.5, py + 0.5, width - 1, height - 1, 5);
  ctx.fillStyle = bg;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = border;
  ctx.stroke();

  ctx.fillStyle = textColor;
  ctx.font = '700 9.5px "JetBrains Mono", monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, px + width / 2, py + height / 2 + 0.5);
}

interface CanvasSizeState {
  width: number;
  height: number;
  scaleX: number;
  scaleY: number;
  lastDpr: number;
  lastVpScale: number;
}

function syncCanvasBacking(
  stage: HTMLDivElement,
  canvas: HTMLCanvasElement,
  sizeState: CanvasSizeState,
  w?: number,
  h?: number,
): CanvasSizeState {
  const cw = Math.max(0, Math.floor(w ?? stage.clientWidth));
  const ch = Math.max(0, Math.floor(h ?? stage.clientHeight));
  const dpr = window.devicePixelRatio || 1;
  const vpScale = window.visualViewport?.scale ?? 1;
  if (
    cw === sizeState.width &&
    ch === sizeState.height &&
    dpr === sizeState.lastDpr &&
    vpScale === sizeState.lastVpScale
  ) {
    return sizeState;
  }
  const backing = computeCanvasBackingSize(cw, ch, dpr, vpScale);
  if (canvas.width !== backing.bw) canvas.width = backing.bw;
  if (canvas.height !== backing.bh) canvas.height = backing.bh;
  canvas.style.width = `${cw}px`;
  canvas.style.height = `${ch}px`;
  return {
    width: cw,
    height: ch,
    scaleX: backing.scaleX,
    scaleY: backing.scaleY,
    lastDpr: dpr,
    lastVpScale: vpScale,
  };
}

interface RenderRuntimeState {
  snapshot: PriceChartSnapshotLike | null;
  liveTrail: ChartPoint[];
  liveSpot: number | null;
  liveTwap: number | null;
  ptb: number | null;
  ptbExact: boolean;
  startMs: number | null;
  endMs: number | null;
  mode: ChartSeriesMode;
  entry: ChartEntryMarker | null;
  slug: string | null;
}

function PriceChartPanel({ data }: { data: PriceChartPanelData | null }) {
  const [mode, setMode] = useState<ChartSeriesMode>('both');

  const stageRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const tooltipLinesRef = useRef<(HTMLDivElement | null)[]>([]);
  const tooltipCacheRef = useRef<{ visible: boolean; tx: number; ty: number; sig: string }>({
    visible: false,
    tx: 0,
    ty: 0,
    sig: '',
  });
  const sizeRef = useRef<CanvasSizeState>({ width: 0, height: 0, scaleX: 1, scaleY: 1, lastDpr: 1, lastVpScale: 1 });
  const paletteRef = useRef<ChartPalette>(DEFAULT_PALETTE);
  const lastPaletteReadRef = useRef<number>(0);

  const liveTrailRef = useRef<{ slug: string | null; points: ChartPoint[] }>({ slug: null, points: [] });
  const hoverRef = useRef<{ active: boolean; x: number; y: number }>({ active: false, x: 0, y: 0 });
  const animRef = useRef<{
    slug: string | null;
    yMin: number | null;
    yMax: number | null;
    tipSpot: number | null;
    tipTwap: number | null;
    lastFrameMs: number;
  }>({
    slug: null,
    yMin: null,
    yMax: null,
    tipSpot: null,
    tipTwap: null,
    lastFrameMs: 0,
  });

  const activeSlug = data?.marketSlug ?? data?.priceChart?.slug ?? null;
  const activeSnapshot = data?.priceChart && (!activeSlug || !data.priceChart.slug || data.priceChart.slug === activeSlug)
    ? data.priceChart
    : null;

  const liveSpot = data?.oraclePrice ?? data?.settlePrice ?? null;
  const liveTwap = data?.twapNow ?? null;
  const ptb = data?.priceToBeat ?? activeSnapshot?.ptb ?? null;
  const ptbExact = Boolean(data?.ptbExact ?? activeSnapshot?.ptbExact);
  const endMs = activeSnapshot?.endMs ?? data?.settlementMs ?? null;
  const startMs = activeSnapshot?.startMs ?? (endMs != null ? endMs - WINDOW_MS : null);

  // Resolve entry marker from snapshot or fall back to live openPosition
  let resolvedEntry: ChartEntryMarker | null = activeSnapshot?.entry ?? null;
  if (!resolvedEntry && data?.openPosition?.enteredAt && (data.openPosition.side === 'UP' || data.openPosition.side === 'DOWN')) {
    const fallbackPrice = liveSpot ?? ptb;
    if (fallbackPrice != null && Number.isFinite(fallbackPrice)) {
      resolvedEntry = {
        ts: data.openPosition.enteredAt,
        btcPrice: fallbackPrice,
        side: data.openPosition.side,
        tokenPrice: data.openPosition.price,
      };
    }
  }

  // Track sub-second live points per market slug cleanly (resets immediately on rollover)
  if (liveTrailRef.current.slug !== activeSlug) {
    liveTrailRef.current = { slug: activeSlug, points: [] };
  }
  const snapPoints = decodeSnapshotPoints(activeSnapshot);
  const lastSnapTs = snapPoints.length > 0 ? snapPoints[snapPoints.length - 1].tsMs : 0;
  if (lastSnapTs > 0 && liveTrailRef.current.points.length > 0) {
    // Drop points now superseded by the authoritative 1 Hz snapshot
    liveTrailRef.current.points = liveTrailRef.current.points.filter(p => p.tsMs > lastSnapTs);
  }
  const nowServerMs = serverNow();
  if (
    (liveSpot != null && Number.isFinite(liveSpot) && liveSpot > 0) ||
    (liveTwap != null && Number.isFinite(liveTwap) && liveTwap > 0)
  ) {
    const clampedNow = endMs != null ? Math.min(nowServerMs, endMs) : nowServerMs;
    const trail = liveTrailRef.current.points;
    const prev = trail[trail.length - 1];
    if (
      clampedNow > lastSnapTs &&
      (!prev || clampedNow - prev.tsMs >= LIVE_TRAIL_MIN_STEP_MS || prev.spot !== liveSpot || prev.twap !== liveTwap)
    ) {
      if (prev && clampedNow - prev.tsMs < 120) {
        trail[trail.length - 1] = { tsMs: clampedNow, spot: liveSpot, twap: liveTwap };
      } else {
        trail.push({ tsMs: clampedNow, spot: liveSpot, twap: liveTwap });
        if (trail.length > MAX_LIVE_TRAIL_POINTS) {
          trail.splice(0, trail.length - MAX_LIVE_TRAIL_POINTS);
        }
      }
    }
  }

  const runtimeRef = useRef<RenderRuntimeState>({
    snapshot: activeSnapshot,
    liveTrail: liveTrailRef.current.points,
    liveSpot,
    liveTwap,
    ptb,
    ptbExact,
    startMs,
    endMs,
    mode,
    entry: resolvedEntry,
    slug: activeSlug,
  });
  runtimeRef.current = {
    snapshot: activeSnapshot,
    liveTrail: liveTrailRef.current.points,
    liveSpot,
    liveTwap,
    ptb,
    ptbExact,
    startMs,
    endMs,
    mode,
    entry: resolvedEntry,
    slug: activeSlug,
  };

  // High-DPI ResizeObserver + pinch/browser zoom backing-store sync
  useEffect(() => {
    const stage = stageRef.current;
    const canvas = canvasRef.current;
    if (!stage || !canvas) return;

    const applySize = (w?: number, h?: number) => {
      sizeRef.current = syncCanvasBacking(stage, canvas, sizeRef.current, w, h);
    };

    applySize();
    paletteRef.current = readThemePalette(stage);

    const onViewportChange = () => applySize();
    const ro = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box) applySize(box.width, box.height);
    });
    ro.observe(stage);
    window.addEventListener('resize', onViewportChange);
    window.visualViewport?.addEventListener('resize', onViewportChange);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', onViewportChange);
      window.visualViewport?.removeEventListener('resize', onViewportChange);
    };
  }, []);

  // Persistent 60fps requestAnimationFrame render loop (pauses cleanly when tab hidden)
  useEffect(() => {
    let rafId = 0;
    let active = true;

    const renderFrame = (frameNowMs: number) => {
      if (!active) return;
      if (document.hidden) {
        rafId = 0;
        return;
      }

      const stage = stageRef.current;
      const canvas = canvasRef.current;
      if (stage && canvas) {
        sizeRef.current = syncCanvasBacking(stage, canvas, sizeRef.current);
      }

      const { width, height, scaleX, scaleY } = sizeRef.current;
      const st = runtimeRef.current;
      if (canvas && width > 40 && height > 40) {
        const ctx = canvas.getContext('2d');
        if (ctx) {
          if (frameNowMs - lastPaletteReadRef.current > 400) {
            paletteRef.current = readThemePalette(stageRef.current);
            lastPaletteReadRef.current = frameNowMs;
          }
          const tip = drawChartCanvas(
            ctx,
            width,
            height,
            scaleX,
            scaleY,
            frameNowMs,
            st,
            animRef.current,
            hoverRef.current,
            paletteRef.current,
          );
          syncDomTooltip(tooltipRef.current, tooltipLinesRef.current, tooltipCacheRef.current, tip);
        }
      }

      rafId = window.requestAnimationFrame(renderFrame);
    };

    const startLoop = () => {
      if (!active || document.hidden || rafId !== 0) return;
      animRef.current.lastFrameMs = performance.now();
      rafId = window.requestAnimationFrame(renderFrame);
    };

    const onVisibility = () => {
      if (!document.hidden) startLoop();
    };

    document.addEventListener('visibilitychange', onVisibility);
    startLoop();

    return () => {
      active = false;
      document.removeEventListener('visibilitychange', onVisibility);
      if (rafId !== 0) window.cancelAnimationFrame(rafId);
    };
  }, []);

  // Pointer hover handlers — update hoverRef without triggering React re-renders
  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    hoverRef.current = {
      active: true,
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
  };
  const handlePointerLeave = () => {
    hoverRef.current.active = false;
  };

  // Top telemetry calculations
  const displayPrice = mode === 'twap' ? (liveTwap ?? liveSpot) : (liveSpot ?? liveTwap);
  const delta = displayPrice != null && ptb != null ? displayPrice - ptb : null;
  const deltaPct = delta != null && ptb && ptb !== 0 ? (delta / ptb) * 100 : null;
  const deltaSign = delta != null ? (delta > 0 ? '+' : delta < 0 ? '-' : '') : '';
  const dirClass = delta == null ? 'is-flat' : delta > 0 ? 'is-up' : delta < 0 ? 'is-down' : 'is-flat';

  const timeColorCls = data?.timeLeftMin != null && data.timeLeftMin <= 1
    ? 'is-crit'
    : data?.timeLeftMin != null && data.timeLeftMin <= 5
      ? 'is-warn'
      : '';

  const openPosSide = data?.openPosition?.side === 'UP' || data?.openPosition?.side === 'DOWN'
    ? data.openPosition.side
    : null;
  const openPosCents = data?.openPosition?.price != null && Number.isFinite(data.openPosition.price)
    ? `${Math.round(data.openPosition.price * 100)}¢`
    : '';

  return (
    <div className="pchart">
      <div className="pchart__bar">
        <div className="pchart__readout">
          <div className={`pchart__price ${dirClass}`}>
            <span className="pchart__kicker">
              {mode === 'twap' ? '60S TWAP ORACLE' : 'CHAINLINK ORACLE'}
            </span>
            <strong>{displayPrice != null ? `$${formatNumber(displayPrice, 2)}` : '—'}</strong>
          </div>

          {delta != null && deltaPct != null && (
            <span className={`pchart__delta ${dirClass}`}>
              {delta >= 0 ? '▲' : '▼'} {deltaSign}${Math.abs(delta).toFixed(2)} ({deltaSign}{Math.abs(deltaPct).toFixed(3)}%)
            </span>
          )}

          <div className="pchart__ptb">
            <span className="pchart__kicker">
              PRICE TO BEAT
              <em className={`pchart__badge ${ptbExact ? 'is-exact' : 'is-est'}`}>
                {ptb != null ? (ptbExact ? 'EXACT' : 'EST') : 'WAIT'}
              </em>
            </span>
            <b>{ptb != null ? `$${formatNumber(ptb, 2)}` : 'Resolving...'}</b>
          </div>
        </div>

        <div className="pchart__controls">
          {openPosSide && (
            <span className={`pchart__pos ${openPosSide === 'UP' ? 'is-up' : 'is-down'}`}>
              {openPosSide === 'UP' ? '▲' : '▼'} {openPosSide} {openPosCents}
            </span>
          )}

          {data?.marketUp != null && data?.marketDown != null && (
            <div className="pchart__odds" aria-label="Token market odds">
              <span className="is-up">UP {Math.round(data.marketUp * 100)}¢</span>
              <span className="is-down">DN {Math.round(data.marketDown * 100)}¢</span>
            </div>
          )}

          <div className="pchart__seg" role="tablist" aria-label="Chart series mode">
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'spot'}
              className={`pchart__seg-btn ${mode === 'spot' ? 'is-active' : ''}`}
              onClick={() => setMode('spot')}
            >
              Spot
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'both'}
              className={`pchart__seg-btn ${mode === 'both' ? 'is-active' : ''}`}
              onClick={() => setMode('both')}
            >
              +TWAP
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'twap'}
              className={`pchart__seg-btn ${mode === 'twap' ? 'is-active' : ''}`}
              onClick={() => setMode('twap')}
            >
              TWAP
            </button>
          </div>

          <span className={`pchart__timer ${timeColorCls}`}>
            {data?.timeLeftMin != null ? fmtTimeLeft(data.timeLeftMin) : '--:--'}
          </span>
        </div>
      </div>

      <div className="pchart__stage" ref={stageRef}>
        <canvas
          ref={canvasRef}
          className="pchart__canvas"
          onPointerMove={handlePointerMove}
          onPointerDown={handlePointerMove}
          onPointerLeave={handlePointerLeave}
          onPointerCancel={handlePointerLeave}
        />
        <div ref={tooltipRef} className="pchart__tooltip" aria-hidden="true">
          <div ref={(el) => { tooltipLinesRef.current[0] = el; }} className="pchart__tooltip-line" />
          <div ref={(el) => { tooltipLinesRef.current[1] = el; }} className="pchart__tooltip-line" />
          <div ref={(el) => { tooltipLinesRef.current[2] = el; }} className="pchart__tooltip-line" />
          <div ref={(el) => { tooltipLinesRef.current[3] = el; }} className="pchart__tooltip-line" />
        </div>
      </div>
    </div>
  );
}

interface TooltipOverlaySpec {
  hx: number;
  hy: number;
  padL: number;
  padT: number;
  plotRight: number;
  plotBottom: number;
  lines: { text: string; color: string }[];
}

function syncDomTooltip(
  el: HTMLDivElement | null,
  lineEls: (HTMLDivElement | null)[],
  cache: { visible: boolean; tx: number; ty: number; sig: string },
  spec: TooltipOverlaySpec | null,
): void {
  if (!el) return;
  if (!spec || spec.lines.length === 0) {
    if (cache.visible) {
      cache.visible = false;
      el.style.opacity = '0';
    }
    return;
  }

  let sig = '';
  for (let i = 0; i < 4; i++) {
    const line = spec.lines[i];
    sig += line ? `${line.text}|${line.color};` : ';';
  }
  if (sig !== cache.sig) {
    cache.sig = sig;
    for (let i = 0; i < 4; i++) {
      const node = lineEls[i];
      if (!node) continue;
      const line = spec.lines[i];
      if (line) {
        node.textContent = line.text;
        node.style.color = line.color;
      } else {
        node.textContent = '';
      }
    }
  }

  const tipW = el.offsetWidth || 175;
  const tipH = el.offsetHeight || 68;
  const placeLeft = spec.hx + 12 + tipW > spec.plotRight;
  const rawX = placeLeft ? spec.hx - tipW - 12 : spec.hx + 12;
  const rawY = spec.hy - tipH / 2;
  const tx = Math.round(Math.max(spec.padL + 4, Math.min(spec.plotRight - tipW - 4, rawX)));
  const ty = Math.round(Math.max(spec.padT + 4, Math.min(spec.plotBottom - tipH - 4, rawY)));

  if (!cache.visible) {
    cache.visible = true;
    el.style.opacity = '1';
  }
  if (tx !== cache.tx || ty !== cache.ty) {
    cache.tx = tx;
    cache.ty = ty;
    el.style.transform = `translate3d(${tx}px, ${ty}px, 0)`;
  }
}

const snapHalf = (v: number) => Math.round(v) + 0.5;

function drawChartCanvas(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  scaleX: number,
  scaleY: number,
  frameNowMs: number,
  st: RenderRuntimeState,
  anim: {
    slug: string | null;
    yMin: number | null;
    yMax: number | null;
    tipSpot: number | null;
    tipTwap: number | null;
    lastFrameMs: number;
  },
  hover: { active: boolean; x: number; y: number },
  palette: ChartPalette,
): TooltipOverlaySpec | null {
  const dtRaw = anim.lastFrameMs > 0 ? (frameNowMs - anim.lastFrameMs) / 1000 : 1 / 60;
  const dt = Math.min(0.1, Math.max(0.001, dtRaw));
  anim.lastFrameMs = frameNowMs;

  if (anim.slug !== st.slug) {
    anim.slug = st.slug;
    anim.yMin = null;
    anim.yMax = null;
    anim.tipSpot = st.liveSpot;
    anim.tipTwap = st.liveTwap;
  }

  ctx.save();
  ctx.setTransform(scaleX, 0, 0, scaleY, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const serverMs = serverNow();
  const winEndMs = st.endMs ?? (Math.ceil(serverMs / WINDOW_MS) * WINDOW_MS);
  const winStartMs = st.startMs ?? (winEndMs - WINDOW_MS);
  const winSpanMs = Math.max(60_000, winEndMs - winStartMs);

  const rawSeries = mergeChartSeries(st.snapshot, st.liveTrail);

  // Smooth tip interpolation using frame-delta exponential damping
  const targetSpot = st.liveSpot ?? (rawSeries.length > 0 ? rawSeries[rawSeries.length - 1].spot : null);
  const targetTwap = st.liveTwap ?? (rawSeries.length > 0 ? rawSeries[rawSeries.length - 1].twap : null);

  if (targetSpot != null && Number.isFinite(targetSpot)) {
    if (anim.tipSpot == null || !Number.isFinite(anim.tipSpot)) {
      anim.tipSpot = targetSpot;
    } else {
      const kSpot = 1 - Math.exp(-dt * 14);
      anim.tipSpot += (targetSpot - anim.tipSpot) * kSpot;
    }
  } else {
    anim.tipSpot = null;
  }

  if (targetTwap != null && Number.isFinite(targetTwap)) {
    if (anim.tipTwap == null || !Number.isFinite(anim.tipTwap)) {
      anim.tipTwap = targetTwap;
    } else {
      const kTwap = 1 - Math.exp(-dt * 12);
      anim.tipTwap += (targetTwap - anim.tipTwap) * kTwap;
    }
  } else {
    anim.tipTwap = null;
  }

  // Plot geometry
  const padL = 8;
  const padR = width < 400 ? 70 : 80;
  const padT = 12;
  const padB = 24;
  const plotW = Math.max(40, width - padL - padR);
  const plotH = Math.max(40, height - padT - padB);
  const plotRight = padL + plotW;
  const plotBottom = padT + plotH;

  const tsToX = (tsMs: number) => padL + ((tsMs - winStartMs) / winSpanMs) * plotW;

  // Build smoothed display series ending cleanly at live clock X and eased live price
  const primaryDisplayPts: { tsMs: number; val: number }[] = [];
  const twapDisplayPts: { tsMs: number; val: number }[] = [];

  for (let i = 0; i < rawSeries.length; i++) {
    const p = rawSeries[i];
    const isLast = i === rawSeries.length - 1;
    const primaryVal = st.mode === 'twap' ? p.twap : (p.spot ?? p.twap);
    if (primaryVal != null) {
      const smoothedLast = isLast
        ? (st.mode === 'twap' ? (anim.tipTwap ?? primaryVal) : (anim.tipSpot ?? primaryVal))
        : primaryVal;
      primaryDisplayPts.push({ tsMs: p.tsMs, val: smoothedLast });
    }
    if (st.mode === 'both' && p.twap != null) {
      const smoothedTwap = isLast && anim.tipTwap != null ? anim.tipTwap : p.twap;
      twapDisplayPts.push({ tsMs: p.tsMs, val: smoothedTwap });
    }
  }

  const liveTipVal = st.mode === 'twap' ? anim.tipTwap : (anim.tipSpot ?? anim.tipTwap);
  const lastHistTs = primaryDisplayPts.length > 0 ? primaryDisplayPts[primaryDisplayPts.length - 1].tsMs : winStartMs;
  const liveTipTs = Math.max(winStartMs, Math.min(winEndMs, Math.max(lastHistTs, serverMs)));

  if (liveTipVal != null && Number.isFinite(liveTipVal)) {
    if (primaryDisplayPts.length === 0) {
      primaryDisplayPts.push({ tsMs: Math.max(winStartMs, liveTipTs - 1000), val: liveTipVal });
      primaryDisplayPts.push({ tsMs: liveTipTs, val: liveTipVal });
    } else if (liveTipTs - lastHistTs > 250) {
      primaryDisplayPts.push({ tsMs: liveTipTs, val: liveTipVal });
    } else {
      primaryDisplayPts[primaryDisplayPts.length - 1] = { tsMs: liveTipTs, val: liveTipVal };
    }
  }

  if (st.mode === 'both' && anim.tipTwap != null && Number.isFinite(anim.tipTwap)) {
    const lastTwapTs = twapDisplayPts.length > 0 ? twapDisplayPts[twapDisplayPts.length - 1].tsMs : winStartMs;
    const twapTipTs = Math.max(winStartMs, Math.min(winEndMs, Math.max(lastTwapTs, serverMs)));
    if (twapDisplayPts.length > 0 && twapTipTs - lastTwapTs > 250) {
      twapDisplayPts.push({ tsMs: twapTipTs, val: anim.tipTwap });
    } else if (twapDisplayPts.length > 0) {
      twapDisplayPts[twapDisplayPts.length - 1] = { tsMs: twapTipTs, val: anim.tipTwap };
    }
  }

  // Target Y domain includes all visible series points, PTB anchor, and entry price
  const allYValues: (number | null)[] = [];
  for (let i = 0; i < primaryDisplayPts.length; i++) allYValues.push(primaryDisplayPts[i].val);
  for (let i = 0; i < twapDisplayPts.length; i++) allYValues.push(twapDisplayPts[i].val);
  if (st.entry?.btcPrice != null) allYValues.push(st.entry.btcPrice);

  const targetDomain = computeYDomain(allYValues, st.ptb, 40);
  if (anim.yMin == null || anim.yMax == null || !Number.isFinite(anim.yMin) || !Number.isFinite(anim.yMax)) {
    anim.yMin = targetDomain.min;
    anim.yMax = targetDomain.max;
  } else {
    const kDom = 1 - Math.exp(-dt * 9);
    anim.yMin += (targetDomain.min - anim.yMin) * kDom;
    anim.yMax += (targetDomain.max - anim.yMax) * kDom;
  }

  const yMin = anim.yMin;
  const yMax = Math.max(yMin + 1, anim.yMax);
  const valToY = (v: number) => padT + ((yMax - v) / (yMax - yMin)) * plotH;

  // Empty state before ticks arrive
  if (primaryDisplayPts.length === 0 && st.ptb == null) {
    ctx.fillStyle = palette.muted;
    ctx.font = '600 11px "Inter", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Waiting for Chainlink BTC ticks...', padL + plotW / 2, padT + plotH / 2);
    ctx.restore();
    return null;
  }

  // Precompute curve XY & right-axis pill Y slots before grid text so axis ticks yield cleanly
  const primaryXY: XYPoint[] = primaryDisplayPts.map(p => ({ x: tsToX(p.tsMs), y: valToY(p.val) }));
  const ptbValid = st.ptb != null && Number.isFinite(st.ptb);
  const ptbY = ptbValid ? valToY(st.ptb!) : null;
  const safePtbY = ptbY != null ? Math.max(padT + 10, Math.min(plotBottom - 10, ptbY)) : null;
  const liveTipXY = primaryXY.length > 0 ? primaryXY[primaryXY.length - 1] : null;
  const livePillY = liveTipXY != null && liveTipVal != null
    ? resolvePillY(liveTipXY.y, safePtbY, padT + 10, plotBottom - 10, 20)
    : null;

  // 1. Final 60s TWAP settlement zone shading on right side
  const twapStartX = Math.max(padL, Math.min(plotRight, tsToX(winEndMs - TWAP_ZONE_MS)));
  if (twapStartX < plotRight - 2) {
    const zoneGrad = ctx.createLinearGradient(twapStartX, padT, plotRight, padT);
    zoneGrad.addColorStop(0, 'rgba(251, 191, 36, 0.04)');
    zoneGrad.addColorStop(1, 'rgba(251, 191, 36, 0.10)');
    ctx.fillStyle = zoneGrad;
    ctx.fillRect(twapStartX, padT, plotRight - twapStartX, plotH);

    ctx.save();
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = 'rgba(251, 191, 36, 0.30)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(snapHalf(twapStartX), padT);
    ctx.lineTo(snapHalf(twapStartX), plotBottom);
    ctx.stroke();
    ctx.restore();

    if (plotRight - twapStartX >= 32) {
      ctx.fillStyle = 'rgba(251, 191, 36, 0.72)';
      ctx.font = '700 8px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText('60s TWAP', (twapStartX + plotRight) / 2, padT + 4);
    }
  }

  // 2. Horizontal dollar grid + right Y-axis labels (suppressed where axis pills sit)
  ctx.font = '600 9.5px "JetBrains Mono", monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < targetDomain.ticks.length; i++) {
    const tv = targetDomain.ticks[i];
    const gy = valToY(tv);
    if (gy < padT + 6 || gy > plotBottom - 6) continue;

    ctx.strokeStyle = 'rgba(148, 163, 184, 0.09)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, snapHalf(gy));
    ctx.lineTo(plotRight, snapHalf(gy));
    ctx.stroke();

    if (!shouldHideAxisTick(gy, [safePtbY, livePillY], 16)) {
      ctx.fillStyle = palette.dim;
      ctx.fillText(fmtUsd(tv, 0), plotRight + 6, Math.round(gy));
    }
  }

  // Bottom border line + subtle elapsed progress bar + X-axis 3-minute ticks
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.16)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padL, snapHalf(plotBottom));
  ctx.lineTo(plotRight, snapHalf(plotBottom));
  ctx.stroke();

  const elapsedX = Math.max(padL, Math.min(plotRight, tsToX(serverMs)));
  ctx.fillStyle = 'rgba(34, 211, 238, 0.45)';
  ctx.fillRect(padL, plotBottom - 1.5, elapsedX - padL, 1.5);

  const timeTicks = buildTimeTicks(winStartMs, winEndMs, 3);
  ctx.font = '600 9px "JetBrains Mono", monospace';
  ctx.textBaseline = 'top';
  for (let i = 0; i < timeTicks.length; i++) {
    const tk = timeTicks[i];
    const tx = tsToX(tk.tsMs);
    const isFirst = i === 0;
    const isLast = i === timeTicks.length - 1;
    ctx.textAlign = isFirst ? 'left' : isLast ? 'right' : 'center';
    ctx.fillStyle = tk.tsMs <= serverMs ? palette.muted : palette.dim;
    ctx.fillText(fmtClockHm(tk.tsMs), tx, plotBottom + 6);

    ctx.strokeStyle = 'rgba(148, 163, 184, 0.18)';
    ctx.beginPath();
    ctx.moveTo(tx, plotBottom);
    ctx.lineTo(tx, plotBottom + 3);
    ctx.stroke();
  }

  // 3. Curve coordinates & PTB status precomputed above for axis pill clearance

  // 4. Polymarket split-at-PTB area fills and monotone strokes
  if (primaryXY.length >= 2) {
    if (ptbY != null) {
      const clampedClipY = Math.max(padT, Math.min(plotBottom, ptbY));

      // Above PTB region (Emerald)
      if (clampedClipY > padT) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(padL - 2, padT - 4, plotW + 4, clampedClipY - padT + 4);
        ctx.clip();

        traceArea(ctx, primaryXY, clampedClipY);
        const upGrad = ctx.createLinearGradient(0, padT, 0, clampedClipY);
        upGrad.addColorStop(0, 'rgba(52, 211, 153, 0.28)');
        upGrad.addColorStop(1, 'rgba(52, 211, 153, 0.02)');
        ctx.fillStyle = upGrad;
        ctx.fill();

        traceCurve(ctx, primaryXY);
        ctx.strokeStyle = palette.green;
        ctx.lineWidth = 1.9;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.shadowColor = 'rgba(52, 211, 153, 0.22)';
        ctx.shadowBlur = 2.5;
        ctx.stroke();
        ctx.restore();
      }

      // Below PTB region (Crimson)
      if (clampedClipY < plotBottom) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(padL - 2, clampedClipY, plotW + 4, plotBottom - clampedClipY + 4);
        ctx.clip();

        traceArea(ctx, primaryXY, clampedClipY);
        const dnGrad = ctx.createLinearGradient(0, clampedClipY, 0, plotBottom);
        dnGrad.addColorStop(0, 'rgba(251, 113, 133, 0.02)');
        dnGrad.addColorStop(1, 'rgba(251, 113, 133, 0.28)');
        ctx.fillStyle = dnGrad;
        ctx.fill();

        traceCurve(ctx, primaryXY);
        ctx.strokeStyle = palette.red;
        ctx.lineWidth = 1.9;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.shadowColor = 'rgba(251, 113, 133, 0.22)';
        ctx.shadowBlur = 2.5;
        ctx.stroke();
        ctx.restore();
      }
    } else {
      // No PTB yet: render neutral accent cyan curve + gradient
      ctx.save();
      ctx.beginPath();
      ctx.rect(padL - 2, padT - 4, plotW + 4, plotH + 8);
      ctx.clip();

      traceArea(ctx, primaryXY, plotBottom);
      const flatGrad = ctx.createLinearGradient(0, padT, 0, plotBottom);
      flatGrad.addColorStop(0, 'rgba(34, 211, 238, 0.22)');
      flatGrad.addColorStop(1, 'rgba(34, 211, 238, 0.01)');
      ctx.fillStyle = flatGrad;
      ctx.fill();

      traceCurve(ctx, primaryXY);
      ctx.strokeStyle = palette.accent;
      ctx.lineWidth = 2.1;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.stroke();
      ctx.restore();
    }
  }

  // 5. Optional 60s TWAP thin dashed overlay when in '+TWAP' mode
  if (st.mode === 'both' && twapDisplayPts.length >= 2) {
    const twapXY: XYPoint[] = twapDisplayPts.map(p => ({ x: tsToX(p.tsMs), y: valToY(p.val) }));
    ctx.save();
    ctx.beginPath();
    ctx.rect(padL - 2, padT - 4, plotW + 4, plotH + 8);
    ctx.clip();
    traceCurve(ctx, twapXY);
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = 'rgba(251, 191, 36, 0.85)';
    ctx.lineWidth = 1.4;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();
    ctx.restore();
  }

  // 6. Dashed horizontal Price-to-Beat reference line + right-axis pill
  if (ptbY != null && ptbValid && safePtbY != null) {
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = st.ptbExact ? 'rgba(237, 244, 255, 0.56)' : 'rgba(251, 191, 36, 0.55)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, snapHalf(ptbY));
    ctx.lineTo(plotRight, snapHalf(ptbY));
    ctx.stroke();
    ctx.restore();

    // Subtle inline tag at left edge of PTB line
    const tagText = st.ptbExact ? 'PRICE TO BEAT' : 'PTB (EST)';
    ctx.save();
    ctx.font = '700 8px "JetBrains Mono", monospace';
    const tagW = Math.ceil(ctx.measureText(tagText).width) + 10;
    const tagY = Math.round(ptbY > padT + 18 ? ptbY - 15 : ptbY + 3);
    drawRoundedRect(ctx, padL + 4.5, tagY + 0.5, tagW, 13, 4);
    ctx.fillStyle = '#0a1322';
    ctx.fill();
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.28)';
    ctx.lineWidth = 0.8;
    ctx.stroke();
    ctx.fillStyle = st.ptbExact ? palette.text : palette.amber;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(tagText, padL + 9, tagY + 6.7);
    ctx.restore();

    drawAxisPill(
      ctx,
      plotRight + 4,
      safePtbY,
      padR - 6,
      17,
      fmtUsd(st.ptb!, 2),
      '#112038',
      st.ptbExact ? 'rgba(237, 244, 255, 0.45)' : 'rgba(251, 191, 36, 0.45)',
      palette.text,
    );
  }

  // 7. Bot open-position entry pin on curve
  if (st.entry && st.entry.ts >= winStartMs && st.entry.ts <= winEndMs) {
    const ex = tsToX(st.entry.ts);
    const ey = Math.max(padT + 8, Math.min(plotBottom - 8, valToY(st.entry.btcPrice)));
    const isUp = st.entry.side === 'UP';
    const pinColor = isUp ? palette.green : palette.red;
    const cents = st.entry.tokenPrice != null ? ` ${Math.round(st.entry.tokenPrice * 100)}¢` : '';
    const label = `${isUp ? '▲ UP' : '▼ DN'}${cents}`;

    ctx.save();
    ctx.setLineDash([2, 2]);
    ctx.strokeStyle = isUp ? 'rgba(52, 211, 153, 0.45)' : 'rgba(251, 113, 133, 0.45)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(ex, padT + 4);
    ctx.lineTo(ex, plotBottom - 2);
    ctx.stroke();
    ctx.restore();

    ctx.beginPath();
    ctx.arc(ex, ey, 4, 0, Math.PI * 2);
    ctx.fillStyle = pinColor;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = palette.panel;
    ctx.stroke();

    ctx.font = '700 8.5px "JetBrains Mono", monospace';
    const bw = ctx.measureText(label).width + 10;
    const bx = Math.max(padL + 2, Math.min(plotRight - bw - 2, ex - bw / 2));
    const by = ey > padT + 26 ? ey - 22 : ey + 8;
    drawRoundedRect(ctx, bx, by, bw, 15, 4);
    ctx.fillStyle = isUp ? 'rgba(6, 78, 59, 0.92)' : 'rgba(136, 19, 55, 0.92)';
    ctx.fill();
    ctx.strokeStyle = pinColor;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, bx + bw / 2, by + 7.8);
  }

  // 8. Pulsing live tip beacon + collision-avoided right-axis live price pill
  if (liveTipXY != null && liveTipVal != null && livePillY != null) {
    const tipXY = liveTipXY;
    const tipColor = ptbValid
      ? (liveTipVal > st.ptb! ? palette.green : liveTipVal < st.ptb! ? palette.red : palette.accent)
      : palette.accent;
    const tipRgb = tipColor === palette.green
      ? '52, 211, 153'
      : tipColor === palette.red
        ? '251, 113, 133'
        : '34, 211, 238';
    const livePillBg = tipColor === palette.green
      ? '#0b2922'
      : tipColor === palette.red
        ? '#2d101b'
        : '#0a2231';

    const pulse = 0.5 + 0.5 * Math.sin(frameNowMs / 240);
    const haloRadius = 6 + pulse * 6;
    ctx.beginPath();
    ctx.arc(tipXY.x, tipXY.y, haloRadius, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${tipRgb}, ${(0.28 - pulse * 0.18).toFixed(3)})`;
    ctx.fill();

    ctx.beginPath();
    ctx.arc(tipXY.x, tipXY.y, 3.8, 0, Math.PI * 2);
    ctx.fillStyle = tipColor;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = palette.panel;
    ctx.stroke();

    if (Math.abs(livePillY - tipXY.y) > 2) {
      ctx.strokeStyle = `rgba(${tipRgb}, 0.45)`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(tipXY.x, tipXY.y);
      ctx.lineTo(plotRight + 4, livePillY);
      ctx.stroke();
    }
    drawAxisPill(
      ctx,
      plotRight + 4,
      livePillY,
      padR - 6,
      17,
      fmtUsd(liveTipVal, 2),
      livePillBg,
      tipColor,
      palette.text,
    );
  }

  // 9. Zero-lag interactive crosshair + crisp vector DOM tooltip spec
  let tooltipSpec: TooltipOverlaySpec | null = null;
  if (
    hover.active &&
    rawSeries.length > 0 &&
    hover.x >= padL &&
    hover.x <= plotRight &&
    hover.y >= padT &&
    hover.y <= plotBottom
  ) {
    const hoverTsMs = winStartMs + ((hover.x - padL) / plotW) * winSpanMs;
    const idx = findNearestPointIndex(rawSeries, hoverTsMs);
    if (idx >= 0) {
      const pt = rawSeries[idx];
      const hx = tsToX(pt.tsMs);
      const hVal = st.mode === 'twap' ? (pt.twap ?? pt.spot) : (pt.spot ?? pt.twap);
      if (hVal != null) {
        const hy = Math.max(padT, Math.min(plotBottom, valToY(hVal)));

        ctx.save();
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = 'rgba(237, 244, 255, 0.35)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(snapHalf(hx), padT);
        ctx.lineTo(snapHalf(hx), plotBottom);
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(padL, snapHalf(hy));
        ctx.lineTo(plotRight, snapHalf(hy));
        ctx.stroke();
        ctx.restore();

        // Point highlight rings
        ctx.beginPath();
        ctx.arc(hx, hy, 4.2, 0, Math.PI * 2);
        ctx.fillStyle = palette.text;
        ctx.fill();
        ctx.lineWidth = 1.8;
        ctx.strokeStyle = palette.panel;
        ctx.stroke();

        if (st.mode === 'both' && pt.twap != null) {
          const ty = Math.max(padT, Math.min(plotBottom, valToY(pt.twap)));
          ctx.beginPath();
          ctx.arc(hx, ty, 3, 0, Math.PI * 2);
          ctx.fillStyle = palette.amber;
          ctx.fill();
        }

        const remSec = Math.max(0, Math.round((winEndMs - pt.tsMs) / 1000));
        const remStr = `${String(Math.floor(remSec / 60)).padStart(2, '0')}:${String(remSec % 60).padStart(2, '0')}`;
        const lines: { text: string; color: string }[] = [
          { text: `${fmtClockHms(pt.tsMs)}  (T-${remStr})`, color: palette.muted },
        ];
        if (pt.spot != null) lines.push({ text: `Spot  ${fmtUsd(pt.spot, 2)}`, color: palette.text });
        if (pt.twap != null) lines.push({ text: `TWAP  ${fmtUsd(pt.twap, 2)}`, color: palette.amber });
        if (ptbValid && hVal != null) {
          const d = hVal - st.ptb!;
          const dp = st.ptb! !== 0 ? (d / st.ptb!) * 100 : 0;
          const sg = d >= 0 ? '+' : '-';
          lines.push({
            text: `vs PTB ${sg}$${Math.abs(d).toFixed(2)} (${sg}${Math.abs(dp).toFixed(3)}%)`,
            color: d >= 0 ? palette.green : palette.red,
          });
        }

        tooltipSpec = { hx, hy, padL, padT, plotRight, plotBottom, lines };
      }
    }
  }

  ctx.restore();
  return tooltipSpec;
}

export default memo(PriceChartPanel, (prev, next) => {
  const a = prev.data;
  const b = next.data;
  if (a === b) return true;
  if (!a || !b) return false;
  const aPts = a.priceChart?.points;
  const bPts = b.priceChart?.points;
  const aLastTs = aPts && aPts.length > 0 ? aPts[aPts.length - 1][0] : null;
  const bLastTs = bPts && bPts.length > 0 ? bPts[bPts.length - 1][0] : null;
  return (
    a.oraclePrice === b.oraclePrice &&
    a.settlePrice === b.settlePrice &&
    a.twapNow === b.twapNow &&
    a.priceToBeat === b.priceToBeat &&
    a.ptbExact === b.ptbExact &&
    a.settlementMs === b.settlementMs &&
    a.timeLeftMin === b.timeLeftMin &&
    a.marketSlug === b.marketSlug &&
    a.marketUp === b.marketUp &&
    a.marketDown === b.marketDown &&
    a.openPosition?.side === b.openPosition?.side &&
    a.openPosition?.enteredAt === b.openPosition?.enteredAt &&
    a.priceChart?.slug === b.priceChart?.slug &&
    a.priceChart?.entry?.ts === b.priceChart?.entry?.ts &&
    (aPts?.length ?? 0) === (bPts?.length ?? 0) &&
    aLastTs === bLastTs
  );
});
