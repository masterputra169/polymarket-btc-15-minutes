import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { CSSProperties, ReactNode } from 'react';
import {
  bottomOf, clampRect, findFreeSlot, isAreaFree, packLayout, visibleLayout,
  DASHBOARD_COLS,
} from './layout.ts';
import type { LayoutMap, Rect } from './layout.ts';

export type WidgetCategory = 'market' | 'strategy' | 'analytics' | 'system';
export type AccentName = 'cyan' | 'mint' | 'ember' | 'violet';
export type DensityName = 'comfortable' | 'compact';

export interface DashboardWidget {
  id: string;
  title: string;
  icon: string;
  description?: string;
  category: WidgetCategory;
  accent?: AccentName;
  defaultW: number;
  defaultH: number;
  minW?: number;
  minH?: number;
  defaultRect?: Rect;
  content: ReactNode;
}

export interface ShellStatus {
  btcPrice: number | null;
  binancePrice: number | null;
  oraclePrice: number | null;
  oracleSource: string | null;
  priceToBeat: number | null;
  timeLeftMin: number | null;
  marketUp: number | null;
  marketDown: number | null;
  bankroll: number | null;
  equity: number | null;
  dailyPnl: number | null;
  wins: number | null;
  losses: number | null;
  dryRun: boolean;
  paused: boolean;
  botConnected: boolean;
  binanceConnected: boolean;
  chainlinkConnected: boolean;
  mlReady: boolean;
  clobLabel: { short: string; dotClass?: string } | null;
  error?: string | null;
}

interface DashboardShellProps {
  widgets: DashboardWidget[];
  status: ShellStatus;
  loading: boolean;
  onToggleBot: () => void;
  onReconnect?: () => void;
  onLogout?: () => void;
  onSetTradingMode?: (mode: 'live' | 'dry', confirm: string) => Promise<any>;
}

const STORAGE_KEY = 'btc15.dashboard.layout.v4';
const GAP = 14;
const ROW_COMFORT = 82;
const ROW_COMPACT = 70;

interface SavedLayout {
  version: number;
  layout: LayoutMap;
  hidden: string[];
  accent: AccentName;
  density: DensityName;
  order?: string[];
  heights?: Record<string, number>;
}

const PRESETS: { id: string; label: string; ids: string[] }[] = [
  { id: 'terminal', label: 'Terminal', ids: ['market', 'bot', 'prediction', 'edge', 'polymarket', 'ta', 'ml', 'jev', 'position', 'betSizing', 'accuracy', 'journal', 'tape', 'session', 'limitOrder', 'traderDiscovery'] },
  { id: 'focus', label: 'Focus', ids: ['market', 'bot', 'prediction', 'edge', 'position', 'ta', 'ml', 'jev'] },
  { id: 'analytics', label: 'Analytics', ids: ['market', 'bot', 'accuracy', 'journal', 'ml', 'ta', 'tape', 'betSizing'] },
  { id: 'clean', label: 'Clean', ids: ['market', 'bot', 'prediction', 'position', 'edge'] },
];

const ACCENTS: { id: AccentName; label: string }[] = [
  { id: 'cyan', label: 'Cyan' },
  { id: 'mint', label: 'Mint' },
  { id: 'ember', label: 'Ember' },
  { id: 'violet', label: 'Violet' },
];

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

function loadSaved(): SavedLayout | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SavedLayout>;
    if (!parsed || typeof parsed !== 'object' || !parsed.layout) return null;
    return {
      version: 5,
      layout: parsed.layout as LayoutMap,
      hidden: Array.isArray(parsed.hidden) ? parsed.hidden.filter((x): x is string => typeof x === 'string') : [],
      accent: (parsed.accent === 'mint' || parsed.accent === 'ember' || parsed.accent === 'violet') ? parsed.accent : 'cyan',
      density: parsed.density === 'compact' ? 'compact' : 'comfortable',
      order: Array.isArray(parsed.order) ? parsed.order.filter((x): x is string => typeof x === 'string') : undefined,
      heights: parsed.heights && typeof parsed.heights === 'object'
        ? Object.fromEntries(Object.entries(parsed.heights).filter((entry): entry is [string, number] => typeof entry[0] === 'string' && typeof entry[1] === 'number' && Number.isFinite(entry[1])))
        : undefined,
    };
  } catch { return null; }
}

function fmtNum(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
function fmtMoney(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return '$' + n.toFixed(2);
}
function fmtClock(min: number | null | undefined): string {
  if (min == null || !Number.isFinite(min)) return '--:--';
  const total = Math.max(0, Math.round(min * 60));
  return String(Math.floor(total / 60)).padStart(2, '0') + ':' + String(total % 60).padStart(2, '0');
}
function pct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return Math.round(n * 100) + '%';
}
function defaultLayout(widgets: DashboardWidget[]): LayoutMap {
  const layout: LayoutMap = {};
  for (const w of widgets) {
    layout[w.id] = w.defaultRect ? clampRect(w.defaultRect) : findFreeSlot(layout, w.defaultW, w.defaultH);
  }
  return layout;
}
type FrameTask<T> = (value: T) => void;
function frameThrottle<T>(fn: FrameTask<T>): FrameTask<T> {
  let frame = 0;
  let pending: T;
  return value => {
    pending = value;
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; fn(pending); });
  };
}

function rectStyle(rect: Rect, colWidth: number, rowHeight: number): CSSProperties {
  return {
    left: rect.x * (colWidth + GAP),
    top: rect.y * (rowHeight + GAP),
    width: rect.w * colWidth + (rect.w - 1) * GAP,
    height: rect.h * rowHeight + (rect.h - 1) * GAP,
    zIndex: 1,
  };
}

export default function DashboardShell({ widgets, status, loading, onToggleBot, onReconnect, onLogout, onSetTradingMode }: DashboardShellProps) {
  const initialSaved = useRef<SavedLayout | null | undefined>(undefined);
  if (initialSaved.current === undefined) initialSaved.current = loadSaved();
  const [layout, setLayout] = useState<LayoutMap>(() => {
    const saved = initialSaved.current;
    return saved?.layout ? { ...defaultLayout(widgets), ...saved.layout } : defaultLayout(widgets);
  });
  const [hidden, setHidden] = useState<string[]>(() => initialSaved.current?.hidden ?? []);
  const [accent, setAccent] = useState<AccentName>(initialSaved.current?.accent ?? 'cyan');
  const [density, setDensity] = useState<DensityName>(initialSaved.current?.density ?? 'comfortable');
  const [editMode, setEditMode] = useState(false);
  const [isScrolled, setIsScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [modeDialog, setModeDialog] = useState<'live' | 'dry' | null>(null);
  const [modeConfirm, setModeConfirm] = useState('');
  const [modeBusy, setModeBusy] = useState(false);
  const [modeError, setModeError] = useState<string | null>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [canvasWidth, setCanvasWidth] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [resizeId, setResizeId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ rect: Rect; valid: boolean } | null>(null);
  const [compactDragId, setCompactDragId] = useState<string | null>(null);
  const [compactTargetId, setCompactTargetId] = useState<string | null>(null);
  const [order, setOrder] = useState<string[]>(() => initialSaved.current?.order ?? widgets.map(w => w.id));
  const [heights, setHeights] = useState<Record<string, number>>(() => initialSaved.current?.heights ?? {});
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const gestureRef = useRef<{ el: HTMLElement; transform?: string; width?: number; height?: number; minHeight?: number } | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const widgetsKey = widgets.map(w => w.id + ':' + w.defaultW + ':' + w.defaultH).join('|');
  const rowHeight = density === 'compact' ? ROW_COMPACT : ROW_COMFORT;
  const isCompact = canvasWidth > 0 && canvasWidth < 980;
  const colWidth = canvasWidth > 0 ? Math.max(28, (canvasWidth - GAP * (DASHBOARD_COLS - 1)) / DASHBOARD_COLS) : 72;
  const orderIndex = useMemo(() => new Map(order.map((id, i) => [id, i])), [order]);
  const visibleWidgets = useMemo(() => widgets
    .filter(w => !hidden.includes(w.id))
    .sort((a, b) => (orderIndex.get(a.id) ?? 999) - (orderIndex.get(b.id) ?? 999)), [widgets, hidden, orderIndex]);
  const heightLayout = visibleLayout(layout, visibleWidgets.map(w => w.id));
  const canvasHeight = isCompact ? 0 : Math.max(520, bottomOf(heightLayout) * (rowHeight + GAP) + 8);

  useEffect(() => {
    const onScroll = () => setIsScrolled(window.scrollY > 6);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: PointerEvent) => {
      if (!(e.target as HTMLElement).closest('.subbar-menu')) setMenuOpen(false);
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [menuOpen]);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      setCanvasWidth(entries[0]?.contentRect.width ?? el.clientWidth);
    });
    ro.observe(el);
    setCanvasWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    // On first paint the bot snapshot may not have arrived yet; do not treat that
    // as "all widgets were removed" or the saved layout is wiped before hydration.
    if (widgets.length === 0) return;
    const ids = new Set(widgets.map(w => w.id));
    setLayout(prev => {
      const next = { ...prev };
      let changed = false;
      for (const id of Object.keys(next)) if (!ids.has(id)) { delete next[id]; changed = true; }
      for (const w of widgets) {
        if (!next[w.id]) { next[w.id] = w.defaultRect ? clampRect(w.defaultRect) : findFreeSlot(next, w.defaultW, w.defaultH); changed = true; }
      }
      return changed ? next : prev;
    });
    setHidden(prev => {
      const next = prev.filter(id => ids.has(id));
      return next.length === prev.length && next.every((id, i) => id === prev[i]) ? prev : next;
    });
  }, [widgetsKey]);

  useEffect(() => {
    // App only builds the widget list after the first bot snapshot. Do not
    // persist (or reorder) the empty pre-hydration canvas over a saved layout.
    if (widgets.length === 0) return;
    const t = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 5, layout, hidden, accent, density, order, heights }));
      } catch { /* localStorage disabled */ }
    }, 250);
    return () => clearTimeout(t);
  }, [layout, hidden, accent, density, order, heights, widgets.length]);

  useEffect(() => {
    if (widgets.length === 0) return;
    const ids = widgets.map(w => w.id);
    const idSet = new Set(ids);
    setOrder(prev => {
      const kept = prev.filter(id => idSet.has(id));
      const next = [...kept, ...ids.filter(id => !kept.includes(id))];
      return next.length === prev.length && next.every((id, i) => id === prev[i]) ? prev : next;
    });
    setHeights(prev => {
      const next = Object.fromEntries(Object.entries(prev).filter(([id]) => idSet.has(id)));
      return Object.keys(next).length === Object.keys(prev).length ? prev : next;
    });
  }, [widgetsKey]);

  // React can re-render every 50 ms from the bot snapshot. Re-apply the direct
  // gesture styles after each commit so that the live feed cannot reset a
  // resize frame while the pointer is down.
  useLayoutEffect(() => {
    const g = gestureRef.current;
    if (!g) return;
    if (g.transform !== undefined) g.el.style.transform = g.transform;
    if (g.width !== undefined) g.el.style.width = g.width + 'px';
    if (g.height !== undefined) g.el.style.height = g.height + 'px';
    if (g.minHeight !== undefined) g.el.style.minHeight = g.minHeight + 'px';
  });

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2200);
    return () => clearTimeout(t);
  }, [toast]);

  const showToast = (msg: string) => setToast(msg);

  const beginBodyDragClass = () => document.body.classList.add('is-widget-dragging');
  const endBodyDragClass = () => document.body.classList.remove('is-widget-dragging');

  const startDrag = useCallback((event: React.PointerEvent<HTMLElement>, id: string) => {
    if (!editMode || isCompact || event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest('button, a, input, select, textarea')) return;
    const el = (event.currentTarget as HTMLElement).closest('.dash-widget') as HTMLElement | null;
    const origin = layout[id];
    if (!el || !origin) return;
    event.preventDefault();
    event.stopPropagation();
    const pointerId = event.pointerId;
    const handle = event.currentTarget as HTMLElement;
    try { handle.setPointerCapture?.(pointerId); } catch { /* ignore */ }
    const startX = event.clientX;
    const startY = event.clientY;
    let active = true;
    let moved = false;
    let last = origin;
    let lastCell = origin.x + ':' + origin.y;
    el.style.transition = 'none';
    el.style.willChange = 'transform';
    gestureRef.current = { el, transform: 'translate3d(0px, 0px, 0)' };
    setDragId(id);
    setDropTarget({ rect: origin, valid: true });
    beginBodyDragClass();

    const schedule = frameThrottle((point: { x: number; y: number }) => {
      if (!active) return;
      const dx = point.x - startX;
      const dy = point.y - startY;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) moved = true;
      const transform = 'translate3d(' + dx + 'px, ' + dy + 'px, 0)';
      gestureRef.current = { el, transform };
      // Direct DOM update: the 20 Hz bot snapshot must not turn this into a React render loop.
      el.style.transform = transform;
      const nx = Math.round(origin.x + dx / (colWidth + GAP));
      const ny = Math.round(origin.y + dy / (rowHeight + GAP));
      last = clampRect({ ...origin, x: nx, y: ny });
      const cell = nx + ':' + ny;
      if (cell !== lastCell) {
        lastCell = cell;
        setDropTarget({ rect: last, valid: isAreaFree(layout, last, id) });
      }
    });

    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      schedule({ x: e.clientX, y: e.clientY });
    };
    const finish = (cancelled: boolean) => {
      if (!active) return;
      active = false;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      try { handle.releasePointerCapture?.(pointerId); } catch { /* ignore */ }
      const valid = isAreaFree(layout, last, id);
      gestureRef.current = null;
      setDragId(null);
      setDropTarget(null);
      endBodyDragClass();
      if (!cancelled && moved && valid) {
        flushSync(() => setLayout(prev => ({ ...prev, [id]: last })));
        el.style.transform = '';
      } else {
        // Leaving the old transform in place until the class is removed would
        // freeze the panel mid-air; reset it so the base transition snaps back.
        el.style.transform = '';
        if (!cancelled && moved) showToast('That space is occupied — drop on a free area');
      }
      el.style.transition = '';
      el.style.willChange = '';
    };
    const onUp = () => finish(false);
    const onCancel = () => finish(true);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
    window.addEventListener('pointercancel', onCancel, { once: true });
  }, [editMode, isCompact, layout, colWidth, rowHeight, showToast]);

  const startCompactDrag = useCallback((event: React.PointerEvent<HTMLElement>, id: string) => {
    if (!editMode || !isCompact || event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest('button, a, input, select, textarea, .dash-widget__resize')) return;
    const el = (event.currentTarget as HTMLElement).closest('.dash-widget') as HTMLElement | null;
    if (!el) return;
    event.preventDefault();
    event.stopPropagation();
    const pointerId = event.pointerId;
    const handle = event.currentTarget as HTMLElement;
    try { handle.setPointerCapture?.(pointerId); } catch { /* ignore */ }
    const startY = event.clientY;
    let active = true;
    let targetId: string | null = null;
    let targetBefore = true;
    el.style.transition = 'none';
    el.style.willChange = 'transform';
    gestureRef.current = { el, transform: 'translate3d(0px, 0px, 0)' };
    setCompactDragId(id);
    beginBodyDragClass();

    const schedule = frameThrottle((y: number) => {
      if (!active) return;
      const dy = y - startY;
      gestureRef.current = { el, transform: 'translate3d(0px, ' + dy + 'px, 0)' };
      el.style.transform = gestureRef.current.transform;
      // Auto-scroll while the finger is near a viewport edge.
      if (y < 90) window.scrollBy(0, -14);
      else if (y > window.innerHeight - 90) window.scrollBy(0, 14);
      const nodes = Array.from(el.parentElement?.querySelectorAll<HTMLElement>('.dash-widget[data-widget-id]') ?? [])
        .filter(node => node !== el && node.dataset.widgetId);
      let chosen: HTMLElement | null = null;
      for (const node of nodes) {
        const r = node.getBoundingClientRect();
        if (y < r.top + r.height / 2) { chosen = node; targetBefore = true; break; }
      }
      if (!chosen && nodes.length) { chosen = nodes[nodes.length - 1]; targetBefore = false; }
      targetId = chosen?.dataset.widgetId ?? null;
      setCompactTargetId(prev => prev === targetId ? prev : targetId);
    });

    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      schedule(e.clientY);
    };
    const finish = (cancelled: boolean) => {
      if (!active) return;
      active = false;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      try { handle.releasePointerCapture?.(pointerId); } catch { /* ignore */ }
      gestureRef.current = null;
      el.style.transform = '';
      el.style.transition = '';
      el.style.willChange = '';
      setCompactDragId(null);
      setCompactTargetId(null);
      endBodyDragClass();
      if (cancelled || !targetId) return;
      const chosen = targetId;
      const before = targetBefore;
      setOrder(prev => {
        const next = prev.filter(x => x !== id);
        const index = next.indexOf(chosen);
        if (index < 0) return prev;
        next.splice(index + (before ? 0 : 1), 0, id);
        return next;
      });
      showToast('Widget moved');
    };
    const onUp = () => finish(false);
    const onCancel = () => finish(true);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
    window.addEventListener('pointercancel', onCancel, { once: true });
  }, [editMode, isCompact, showToast]);

  const startResize = useCallback((event: React.PointerEvent<HTMLElement>, id: string, widget: DashboardWidget) => {
    if (!editMode || event.button !== 0) return;
    const el = (event.currentTarget as HTMLElement).closest('.dash-widget') as HTMLElement | null;
    if (!el) return;
    event.preventDefault();
    event.stopPropagation();
    const pointerId = event.pointerId;
    const handle = event.currentTarget as HTMLElement;
    try { handle.setPointerCapture?.(pointerId); } catch { /* ignore */ }
    const startX = event.clientX;
    const startY = event.clientY;
    const startRect = el.getBoundingClientRect();
    let active = true;
    el.style.transition = 'none';
    setResizeId(id);

    if (isCompact) {
      const startHeight = Math.max(220, Math.round(startRect.height));
      let nextHeight = startHeight;
      gestureRef.current = { el, minHeight: startHeight };
      setHeights(prev => ({ ...prev, [id]: startHeight }));
      const schedule = frameThrottle((y: number) => {
        if (!active) return;
        nextHeight = Math.max(220, Math.round(startHeight + (y - startY)));
        gestureRef.current = { el, minHeight: nextHeight };
        el.style.minHeight = nextHeight + 'px';
      });
      const onMove = (e: PointerEvent) => { if (e.pointerId === pointerId) schedule(e.clientY); };
      const finish = () => {
        if (!active) return;
        active = false;
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onCancel);
        try { handle.releasePointerCapture?.(pointerId); } catch { /* ignore */ }
        gestureRef.current = null;
        setHeights(prev => ({ ...prev, [id]: nextHeight }));
        setResizeId(null);
        el.style.minHeight = nextHeight + 'px';
        el.style.transition = '';
      };
      const onUp = () => finish();
      const onCancel = () => finish();
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp, { once: true });
      window.addEventListener('pointercancel', onCancel, { once: true });
      return;
    }

    const origin = layout[id];
    if (!origin) { setResizeId(null); return; }
    const minW = widget.minW ?? 3;
    const minH = widget.minH ?? 2;
    const minWpx = minW * colWidth + (minW - 1) * GAP;
    const minHpx = minH * rowHeight + (minH - 1) * GAP;
    let last = origin;
    gestureRef.current = { el, width: startRect.width, height: startRect.height };
    const schedule = frameThrottle((point: { x: number; y: number }) => {
      if (!active) return;
      const width = Math.max(minWpx, startRect.width + (point.x - startX));
      const height = Math.max(minHpx, startRect.height + (point.y - startY));
      gestureRef.current = { el, width, height };
      el.style.width = width + 'px';
      el.style.height = height + 'px';
      const w = Math.max(minW, Math.min(DASHBOARD_COLS - origin.x, Math.round((width + GAP) / (colWidth + GAP))));
      const h = Math.max(minH, Math.round((height + GAP) / (rowHeight + GAP)));
      last = clampRect({ ...origin, w, h });
    });
    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      schedule({ x: e.clientX, y: e.clientY });
    };
    const finish = (cancelled: boolean) => {
      if (!active) return;
      active = false;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      try { handle.releasePointerCapture?.(pointerId); } catch { /* ignore */ }
      gestureRef.current = null;
      setResizeId(null);
      const valid = !cancelled && isAreaFree(layout, last, id);
      if (valid) {
        flushSync(() => setLayout(prev => ({ ...prev, [id]: last })));
      } else if (!cancelled && (last.w !== origin.w || last.h !== origin.h)) {
        showToast('Resize blocked — the new size overlaps another widget');
      }
      // React only writes a style property when its previous prop changed. We
      // mutated width/height directly, so clearing them here would leave the
      // panel at its shrink-to-fit size. Pin them to the committed grid size;
      // a later viewport/density change still overrides them through the style prop.
      const finalRect = valid ? last : origin;
      el.style.width = (finalRect.w * colWidth + (finalRect.w - 1) * GAP) + 'px';
      el.style.height = (finalRect.h * rowHeight + (finalRect.h - 1) * GAP) + 'px';
      el.style.transition = '';
    };
    const onUp = () => finish(false);
    const onCancel = () => finish(true);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
    window.addEventListener('pointercancel', onCancel, { once: true });
  }, [editMode, isCompact, layout, colWidth, rowHeight, showToast]);

  const applyPreset = (preset: { id: string; label: string; ids: string[] }) => {
    const wanted = widgets.filter(w => preset.ids.includes(w.id));
    const wantedSet = new Set(wanted.map(w => w.id));
    setHidden(widgets.filter(w => !wantedSet.has(w.id)).map(w => w.id));
    setLayout(packLayout(wanted.map(w => ({ id: w.id, w: w.defaultW, h: w.defaultH }))));
    showToast('Workspace: ' + preset.label);
  };

  const autoArrange = () => {
    setLayout(packLayout(visibleWidgets.map(w => ({
      id: w.id,
      w: layout[w.id]?.w ?? w.defaultW,
      h: layout[w.id]?.h ?? w.defaultH,
    }))));
    showToast('Widgets auto-arranged');
  };

  const resetLayout = () => {
    setHidden([]);
    setLayout(defaultLayout(widgets));
    setOrder(widgets.map(w => w.id));
    setHeights({});
    showToast('Layout reset');
  };

  const toggleWidget = (id: string) => {
    const widget = widgets.find(w => w.id === id);
    if (!widget) return;
    if (hidden.includes(id)) {
      setHidden(prev => prev.filter(x => x !== id));
      setLayout(prev => prev[id] ? prev : { ...prev, [id]: findFreeSlot(prev, widget.defaultW, widget.defaultH) });
      showToast('Widget shown');
    } else {
      setHidden(prev => [...prev, id]);
      showToast('Widget hidden');
    }
  };

  const exportLayout = () => {
    const payload = { version: 5, exportedAt: new Date().toISOString(), accent, density, layout, hidden, order, heights };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'btc15-layout-' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
    URL.revokeObjectURL(url);
    showToast('Layout exported');
  };

  const importLayout = async (file: File) => {
    try {
      const parsed = JSON.parse(await file.text()) as Partial<SavedLayout>;
      if (!parsed.layout || typeof parsed.layout !== 'object') throw new Error('layout missing');
      const next: LayoutMap = {};
      for (const w of widgets) if (parsed.layout[w.id]) next[w.id] = clampRect(parsed.layout[w.id]);
      setLayout(next);
      setHidden(Array.isArray(parsed.hidden) ? parsed.hidden.filter(id => widgets.some(w => w.id === id)) : []);
      if (parsed.accent === 'mint' || parsed.accent === 'ember' || parsed.accent === 'violet' || parsed.accent === 'cyan') setAccent(parsed.accent);
      if (parsed.density === 'compact' || parsed.density === 'comfortable') setDensity(parsed.density);
      if (Array.isArray(parsed.order)) setOrder(parsed.order.filter((id): id is string => typeof id === 'string' && widgets.some(w => w.id === id)));
      if (parsed.heights && typeof parsed.heights === 'object') setHeights(Object.fromEntries(Object.entries(parsed.heights).filter((entry): entry is [string, number] => typeof entry[0] === 'string' && typeof entry[1] === 'number' && Number.isFinite(entry[1]))));
      showToast('Layout imported');
    } catch {
      showToast('Import failed — invalid layout file');
    }
  };

  const tonePrice = status.oraclePrice ?? status.btcPrice;
  const priceTone = tonePrice != null && status.priceToBeat != null
    ? (tonePrice >= status.priceToBeat ? 'up' : 'down')
    : 'flat';
  const feedChecks = [
    { label: 'Binance', ok: status.binanceConnected },
    { label: 'Chainlink', ok: status.chainlinkConnected },
    { label: 'CLOB', ok: !!status.clobLabel },
    { label: 'ML', ok: status.mlReady },
    { label: 'Bot', ok: status.botConnected },
  ];
  const allFeedsOk = feedChecks.every(f => f.ok);
  const feedTitle = feedChecks.map(f => `${f.label}: ${f.ok ? 'up' : 'down'}`).join(' · ');
  const oracleSourceLabel = status.oracleSource === 'polymarket_ws' ? 'POLYWS'
    : status.oracleSource === 'chainlink_wss' ? 'WSS'
      : status.oracleSource === 'RPC' ? 'RPC' : 'CHAINLINK';

  return (
    <div className="dash-shell" data-accent={accent} data-density={density}>
      <div className={cx('dash-scroll-veil', isScrolled ? 'is-visible' : false)} aria-hidden />
      <header className="dash-topbar">
        <div className="tb-brand">
          <img className="tb-mark" src="/brand/poly15-mark.svg?v=20261021" alt="" draggable={false} />
          <div className="tb-brand__text">
            <strong>POLY<span>//</span>15</strong>
          </div>
          <button
            className={cx('tb-mode', status.dryRun ? 'is-dry' : 'is-live')}
            onClick={() => { setModeDialog(status.dryRun ? 'live' : 'dry'); setModeConfirm(''); setModeError(null); }}
            disabled={!onSetTradingMode || !status.botConnected || status.paused}
            title={status.dryRun ? 'DRY RUN: simulated bankroll, no real orders — click to switch' : 'LIVE orders enabled — click to switch'}
          >{status.dryRun ? 'DRY RUN' : 'LIVE'}</button>
        </div>

        <div className="tb-market">
          <div className={cx('tb-price', 'tb-price--' + priceTone)} title={`Oracle ${oracleSourceLabel} — the Chainlink feed compared with PTB`}>
            <span className="tb-kicker">ORACLE</span>
            <strong>{fmtNum(status.oraclePrice ?? status.binancePrice ?? status.btcPrice)}</strong>
          </div>
          <div className="tb-metric"><span>PTB</span><b>{fmtNum(status.priceToBeat)}</b></div>
          <div className="tb-metric"><span>LEFT</span><b className={status.timeLeftMin != null && status.timeLeftMin < 2 ? 'is-warn' : ''}>{fmtClock(status.timeLeftMin)}</b></div>
          <div className="tb-odds">
            <span className="is-up">UP {pct(status.marketUp)}</span>
            <span className="is-down">DOWN {pct(status.marketDown)}</span>
          </div>
        </div>

        <div className="tb-actions">
          <div className={cx('tb-health', allFeedsOk ? 'is-ok' : 'is-warn')} title={feedTitle} aria-label={feedTitle}>
            <i />{allFeedsOk ? 'OK' : 'CHECK'}
          </div>
          {onLogout && <button className="tb-logout" onClick={onLogout} title="Sign out">⏻</button>}
          <button
            className={cx('tb-bot', status.paused ? 'is-resume' : 'is-pause')}
            disabled={!status.botConnected}
            onClick={onToggleBot}
            title={status.botConnected ? (status.paused ? 'Resume bot' : 'Pause bot') : 'Bot offline'}
          >
            <span>{status.paused ? '▶' : 'Ⅱ'}</span>{status.paused ? 'RESUME' : 'PAUSE'}
          </button>
        </div>
      </header>

      <div className="dash-subbar">
        <div className="preset-group" aria-label="Workspace presets">
          {PRESETS.map(preset => (
            <button key={preset.id} className="preset-btn" onClick={() => applyPreset(preset)}>{preset.label}</button>
          ))}
        </div>
        <div className="subbar-actions">
          <button className={cx('subbar-btn', editMode ? 'is-active' : false)} onClick={() => setEditMode(v => !v)}>
            <span className="subbar-btn__icon">⠿</span>{editMode ? 'Editing' : 'Edit layout'}
          </button>
          <button className="subbar-btn" onClick={() => setLibraryOpen(true)}>Widgets <span className="count-badge">{widgets.length - hidden.length}</span></button>
          <div className="subbar-menu">
            <button
              className={cx('subbar-btn subbar-icon', menuOpen ? 'is-active' : false)}
              onClick={() => setMenuOpen(v => !v)}
              aria-label="More layout actions"
              aria-expanded={menuOpen}
            >⋯</button>
            {menuOpen && (
              <div className="subbar-popover" role="menu">
                <button role="menuitem" onClick={() => { autoArrange(); setMenuOpen(false); }}>Auto arrange</button>
                <button role="menuitem" onClick={() => { resetLayout(); setMenuOpen(false); }}>Reset layout</button>
                <div className="subbar-popover__row">
                  <span>Accent</span>
                  <div className="accent-group" aria-label="Accent theme">
                    {ACCENTS.map(a => <button key={a.id} className={cx('accent-dot', 'accent-dot--' + a.id, accent === a.id ? 'is-active' : false)} title={a.label} onClick={() => { setAccent(a.id); setMenuOpen(false); }} />)}
                  </div>
                </div>
                <button role="menuitem" onClick={() => { setDensity(d => d === 'compact' ? 'comfortable' : 'compact'); setMenuOpen(false); }}>
                  {density === 'compact' ? 'Comfort spacing' : 'Compact spacing'}
                </button>
                <button role="menuitem" onClick={() => { setMenuOpen(false); exportLayout(); }}>Export layout</button>
                <button role="menuitem" onClick={() => { setMenuOpen(false); fileRef.current?.click(); }}>Import layout</button>
              </div>
            )}
          </div>
          <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={e => { const f = e.target.files?.[0]; if (f) void importLayout(f); e.currentTarget.value = ''; }} />
        </div>
      </div>
      {editMode && (
        <div className="edit-banner">
          <span>Drag to arrange · pull the corner to resize</span>
          <button onClick={() => setEditMode(false)}>Done editing</button>
        </div>
      )}
      {!status.botConnected && (
        <div className="dash-banner dash-banner--warn">
          <span>Connection lost · retrying</span>
          {onReconnect && <button onClick={onReconnect}>Reconnect now</button>}
        </div>
      )}
      {status.error && <div className="dash-banner dash-banner--error">{status.error}</div>}

      <main className={cx('dash-main', editMode ? 'is-editing' : false)}>
        <div className="canvas-scroll">
          <div ref={canvasRef} className={cx('dash-canvas', isCompact ? 'is-compact' : false)} style={{ height: isCompact ? undefined : canvasHeight }}>

            {!isCompact && dropTarget && (
              <div
                className={cx('dash-drop-ghost', dropTarget.valid ? 'is-valid' : 'is-invalid')}
                style={rectStyle(dropTarget.rect, colWidth, rowHeight)}
                aria-hidden
              />
            )}

            {visibleWidgets.map(widget => {
              const rect = layout[widget.id] ?? { x: 0, y: 0, w: widget.defaultW, h: widget.defaultH };
              const style = isCompact
                ? (heights[widget.id] ? { minHeight: heights[widget.id] } : undefined)
                : rectStyle(rect, colWidth, rowHeight);
              const className = cx(
                'dash-widget',
                'dash-widget--' + (widget.accent ?? 'cyan'),
                dragId === widget.id ? 'is-dragging' : false,
                resizeId === widget.id ? 'is-resizing' : false,
                compactDragId === widget.id ? 'is-compact-dragging' : false,
                compactTargetId === widget.id ? 'is-compact-target' : false,
              );
              return (
                <section
                  key={widget.id}
                  className={className}
                  style={style}
                  data-widget-id={widget.id}
                >
                  <header
                    className="dash-widget__head"
                    onPointerDown={e => (isCompact ? startCompactDrag(e, widget.id) : startDrag(e, widget.id))}
                    title={editMode ? (isCompact ? 'Drag to reorder' : 'Drag to move') : widget.description}
                  >
                    {editMode && <span className="dash-widget__grip">⠿</span>}
                    <span className="dash-widget__icon">{widget.icon}</span>
                    <div className="dash-widget__titles"><h3>{widget.title}</h3></div>
                    {editMode && (
                      <button className="dash-widget__hide" onPointerDown={e => e.stopPropagation()} onClick={() => toggleWidget(widget.id)} title="Hide widget">×</button>
                    )}
                  </header>
                  <div className="dash-widget__body">{widget.content}</div>
                  {editMode && (
                    <div
                      className="dash-widget__resize"
                      onPointerDown={e => startResize(e, widget.id, widget)}
                      title={isCompact ? 'Drag to change height' : 'Drag to resize'}
                    >
                      <span />
                    </div>
                  )}
                </section>
              );
            })}
            {visibleWidgets.length === 0 && !loading && (
              <div className="dash-empty">
                <div className="dash-empty__mark">◈</div>
                <h2>Your canvas is empty</h2>
                <p>Open the widget library and start with Market Pulse, Bot Core or Prediction.</p>
                <button onClick={() => setLibraryOpen(true)}>Open widget library</button>
              </div>
            )}
            {loading && visibleWidgets.length === 0 && (
              <div className="dash-loading">
                <div className="dash-loading__ring" />
                <span>Linking to the bot stream…</span>
              </div>
            )}
          </div>
        </div>
      </main>

      <footer className="dash-footer">
        <span>POLY//15</span>
        <span>{status.wins != null && status.losses != null ? `${status.wins}W/${status.losses}L` : '—'} · {status.dryRun ? 'PAPER' : 'LIVE'} · cash {fmtMoney(status.bankroll)} · pnl {fmtMoney(status.dailyPnl)}</span>
      </footer>

      {libraryOpen && (
        <div className="drawer-scrim" onClick={() => setLibraryOpen(false)}>
          <aside className="widget-drawer" onClick={e => e.stopPropagation()}>
            <div className="drawer-head">
              <div><span className="drawer-kicker">CUSTOMIZE</span><h2>Widget library</h2></div>
              <button className="drawer-close" onClick={() => setLibraryOpen(false)}>×</button>
            </div>
            <p className="drawer-copy">Toggle what lives on the canvas. Hidden widgets keep their position for when you bring them back.</p>
            <div className="widget-list">
              {widgets.map(w => {
                const visible = !hidden.includes(w.id);
                return (
                  <div key={w.id} className={cx('widget-row', visible ? 'is-visible' : false)}>
                    <span className="widget-row__icon">{w.icon}</span>
                    <div className="widget-row__meta"><strong>{w.title}</strong><span>{w.category}{w.description ? ' · ' + w.description : ''}</span></div>
                    <button className={cx('toggle', visible ? 'is-on' : false)} onClick={() => toggleWidget(w.id)} aria-label={(visible ? 'Hide ' : 'Show ') + w.title}><span /></button>
                  </div>
                );
              })}
              {widgets.length === 0 && <div className="drawer-empty">No widgets are registered yet.</div>}
            </div>
            <div className="drawer-foot">
              <button className="drawer-ghost" onClick={() => { setHidden([]); showToast('All widgets visible'); }}>Show all</button>
              <button className="drawer-primary" onClick={() => setLibraryOpen(false)}>Done</button>
            </div>
          </aside>
        </div>
      )}

      {modeDialog && (
        <div className="mode-scrim" onClick={() => { if (!modeBusy) setModeDialog(null); }}>
          <div className="mode-dialog" role="dialog" aria-modal="true" onClick={e => e.stopPropagation()}>
            <div className="mode-dialog__head">
              <span className="mode-dialog__kicker">TRADING MODE</span>
              <h2>{modeDialog === 'live' ? 'Enable live money?' : 'Return to dry run?'}</h2>
            </div>
            <p className="mode-dialog__copy">
              {modeDialog === 'live'
                ? 'This restarts the bot with real orders enabled. The bot preflights CLOB V2 readiness and pUSD balance first; if startup fails it automatically reverts to DRY RUN.'
                : 'This restarts the bot with simulated orders only. An open live position must be settled before switching.'}
            </p>
            <ul className="mode-dialog__list">
              {modeDialog === 'live' ? (
                <>
                  <li>Real pUSD will be used for entries and settlements.</li>
                  <li>Live journal and live position value use real fills, separate from paper history.</li>
                  <li>Open positions must be flat before switching.</li>
                </>
              ) : (
                <>
                  <li>New entries become simulated.</li>
                  <li>Live state and journal are kept separately.</li>
                  <li>Open positions must be settled first.</li>
                </>
              )}
            </ul>
            <label className="mode-dialog__label" htmlFor="mode-confirm">
              Type <b>{modeDialog === 'live' ? 'LIVE' : 'DRY'}</b> to confirm
            </label>
            <input
              id="mode-confirm"
              className="mode-dialog__input"
              value={modeConfirm}
              onChange={e => setModeConfirm(e.target.value)}
              placeholder={modeDialog === 'live' ? 'LIVE' : 'DRY'}
              autoComplete="off"
              autoFocus
              disabled={modeBusy}
            />
            {modeError && <div className="mode-dialog__error">{modeError}</div>}
            <div className="mode-dialog__actions">
              <button className="mode-dialog__cancel" onClick={() => setModeDialog(null)} disabled={modeBusy}>Cancel</button>
              <button
                className="mode-dialog__go"
                disabled={modeBusy || modeConfirm !== (modeDialog === 'live' ? 'LIVE' : 'DRY')}
                onClick={async () => {
                  if (!onSetTradingMode || !modeDialog) return;
                  setModeBusy(true); setModeError(null);
                  try {
                    const result = await onSetTradingMode(modeDialog, modeConfirm);
                    if (result?.ok) {
                      setModeDialog(null);
                      showToast(result?.restarting ? 'Restarting bot in ' + modeDialog.toUpperCase() + ' mode…' : 'Trading mode updated');
                    } else {
                      setModeError(result?.error || 'Mode switch rejected');
                    }
                  } catch (err) {
                    setModeError(err instanceof Error ? err.message : 'Mode switch failed');
                  } finally {
                    setModeBusy(false);
                  }
                }}
              >{modeBusy ? 'CHECKING…' : modeDialog === 'live' ? 'ENABLE LIVE' : 'RETURN TO DRY'}</button>
            </div>
          </div>
        </div>
      )}
      {toast && <div className="dash-toast">{toast}</div>}
    </div>
  );
}
