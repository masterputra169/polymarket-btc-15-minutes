import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  priceToBeat: number | null;
  timeLeftMin: number | null;
  marketUp: number | null;
  marketDown: number | null;
  bankroll: number | null;
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
      version: 4,
      layout: parsed.layout as LayoutMap,
      hidden: Array.isArray(parsed.hidden) ? parsed.hidden.filter((x): x is string => typeof x === 'string') : [],
      accent: (parsed.accent === 'mint' || parsed.accent === 'ember' || parsed.accent === 'violet') ? parsed.accent : 'cyan',
      density: parsed.density === 'compact' ? 'compact' : 'comfortable',
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
function rectStyle(rect: Rect, colWidth: number, rowHeight: number): CSSProperties {
  return {
    left: rect.x * (colWidth + GAP),
    top: rect.y * (rowHeight + GAP),
    width: rect.w * colWidth + (rect.w - 1) * GAP,
    height: rect.h * rowHeight + (rect.h - 1) * GAP,
    zIndex: 1,
  };
}

export default function DashboardShell({ widgets, status, loading, onToggleBot, onReconnect }: DashboardShellProps) {
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
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [preview, setPreview] = useState<{ id: string; rect: Rect } | null>(null);
  const [canvasWidth, setCanvasWidth] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const widgetsKey = widgets.map(w => w.id + ':' + w.defaultW + ':' + w.defaultH).join('|');
  const rowHeight = density === 'compact' ? ROW_COMPACT : ROW_COMFORT;
  const isCompact = canvasWidth > 0 && canvasWidth < 980;
  const colWidth = canvasWidth > 0 ? Math.max(28, (canvasWidth - GAP * (DASHBOARD_COLS - 1)) / DASHBOARD_COLS) : 72;
  const visibleWidgets = useMemo(() => widgets.filter(w => !hidden.includes(w.id)), [widgets, hidden]);
  const heightLayout = visibleLayout(layout, visibleWidgets.map(w => w.id));
  const canvasHeight = isCompact ? 0 : Math.max(520, bottomOf(heightLayout) * (rowHeight + GAP) + 8);

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
    const t = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 4, layout, hidden, accent, density }));
      } catch { /* localStorage disabled */ }
    }, 250);
    return () => clearTimeout(t);
  }, [layout, hidden, accent, density]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2200);
    return () => clearTimeout(t);
  }, [toast]);

  const showToast = (msg: string) => setToast(msg);

  const startDrag = useCallback((event: React.PointerEvent<HTMLElement>, id: string) => {
    if (!editMode || isCompact || event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest('button, a, input, select, textarea')) return;
    const origin = layout[id];
    if (!origin) return;
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startY = event.clientY;
    let last = origin;
    setPreview({ id, rect: origin });
    const onMove = (e: PointerEvent) => {
      const nx = Math.round(origin.x + (e.clientX - startX) / (colWidth + GAP));
      const ny = Math.round(origin.y + (e.clientY - startY) / (rowHeight + GAP));
      last = clampRect({ ...origin, x: nx, y: ny });
      setPreview({ id, rect: last });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (isAreaFree(layout, last, id)) setLayout(prev => ({ ...prev, [id]: last }));
      else showToast('That space is occupied — drop on a free area');
      setPreview(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
  }, [editMode, isCompact, layout, colWidth, rowHeight]);

  const startResize = useCallback((event: React.PointerEvent<HTMLElement>, id: string, widget: DashboardWidget) => {
    if (!editMode || isCompact || event.button !== 0) return;
    const origin = layout[id];
    if (!origin) return;
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startY = event.clientY;
    let last = origin;
    setPreview({ id, rect: origin });
    const onMove = (e: PointerEvent) => {
      const dw = Math.round((e.clientX - startX) / (colWidth + GAP));
      const dh = Math.round((e.clientY - startY) / (rowHeight + GAP));
      const minW = widget.minW ?? 3;
      const minH = widget.minH ?? 2;
      last = clampRect({
        ...origin,
        w: Math.max(minW, Math.min(DASHBOARD_COLS - origin.x, origin.w + dw)),
        h: Math.max(minH, origin.h + dh),
      });
      setPreview({ id, rect: last });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (isAreaFree(layout, last, id)) setLayout(prev => ({ ...prev, [id]: last }));
      else showToast('Resize blocked — the new size overlaps another widget');
      setPreview(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
  }, [editMode, isCompact, layout, colWidth, rowHeight]);

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
    const payload = { version: 4, exportedAt: new Date().toISOString(), accent, density, layout, hidden };
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
      showToast('Layout imported');
    } catch {
      showToast('Import failed — invalid layout file');
    }
  };

  const priceTone = status.btcPrice != null && status.priceToBeat != null
    ? (status.btcPrice >= status.priceToBeat ? 'up' : 'down')
    : 'flat';

  return (
    <div className="dash-shell" data-accent={accent} data-density={density}>
      <header className="dash-topbar">
        <div className="tb-brand">
          <div className="tb-mark">₿</div>
          <div className="tb-brand__text">
            <strong>POLY<span>//</span>15</strong>
            <small>BTC 15m control terminal</small>
          </div>
          <span className={cx('tb-mode', status.dryRun ? 'is-dry' : 'is-live')} title={status.dryRun ? 'DRY RUN: simulated bankroll, no real orders' : 'LIVE orders enabled'}>{status.dryRun ? 'DRY RUN' : 'LIVE'}</span>
        </div>

        <div className="tb-market">
          <div className={cx('tb-price', 'tb-price--' + priceTone)}>
            <span className="tb-kicker">BTC / USD</span>
            <strong>{fmtNum(status.btcPrice)}</strong>
          </div>
          <div className="tb-metric"><span>PTB</span><b>{fmtNum(status.priceToBeat)}</b></div>
          <div className="tb-metric"><span>LEFT</span><b className={status.timeLeftMin != null && status.timeLeftMin < 2 ? 'is-warn' : ''}>{fmtClock(status.timeLeftMin)}</b></div>
          <div className="tb-odds">
            <span className="is-up">UP {pct(status.marketUp)}</span>
            <span className="is-down">DOWN {pct(status.marketDown)}</span>
          </div>
        </div>

        <div className="tb-actions">
          <div className="tb-pills">
            <span className={cx('tb-pill', status.binanceConnected ? 'is-on' : 'is-off')}><i />BINANCE</span>
            <span className={cx('tb-pill', status.chainlinkConnected ? 'is-on' : 'is-off')}><i />CHAINLINK</span>
            <span className={cx('tb-pill', status.clobLabel ? 'is-on' : 'is-warn')}><i />{status.clobLabel?.short ?? 'CLOB'}</span>
            <span className={cx('tb-pill', status.mlReady ? 'is-on' : 'is-off')}><i />ML</span>
            <span className={cx('tb-pill', status.botConnected ? 'is-on' : 'is-off')}><i />BOT</span>
          </div>
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
        <div className="preset-group">
          <span className="subbar-label">WORKSPACE</span>
          {PRESETS.map(preset => (
            <button key={preset.id} className="preset-btn" onClick={() => applyPreset(preset)}>{preset.label}</button>
          ))}
        </div>
        <div className="subbar-actions">
          <button className={cx('subbar-btn', editMode ? 'is-active' : false)} onClick={() => setEditMode(v => !v)}>
            <span className="subbar-btn__icon">⠿</span>{editMode ? 'Editing' : 'Edit layout'}
          </button>
          <button className="subbar-btn" onClick={() => setLibraryOpen(true)}>Widgets <span className="count-badge">{widgets.length - hidden.length}</span></button>
          <button className="subbar-btn" onClick={autoArrange}>Auto arrange</button>
          <button className="subbar-btn" onClick={resetLayout}>Reset</button>
          <button className="subbar-btn" onClick={exportLayout}>Export</button>
          <button className="subbar-btn" onClick={() => fileRef.current?.click()}>Import</button>
          <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={e => { const f = e.target.files?.[0]; if (f) void importLayout(f); e.currentTarget.value = ''; }} />
          <div className="accent-group" aria-label="Accent theme">
            {ACCENTS.map(a => <button key={a.id} className={cx('accent-dot', 'accent-dot--' + a.id, accent === a.id ? 'is-active' : false)} title={a.label} onClick={() => setAccent(a.id)} />)}
          </div>
          <button className="subbar-btn subbar-btn--density" onClick={() => setDensity(d => d === 'compact' ? 'comfortable' : 'compact')}>
            {density === 'compact' ? 'Comfort' : 'Compact'}
          </button>
        </div>
      </div>

      {editMode && (
        <div className="edit-banner">
          <span>⠿ Drag any widget header to move it. Pull the bottom-right corner to resize. Use Widgets to show or hide panels.</span>
          <button onClick={() => setEditMode(false)}>Done editing</button>
        </div>
      )}
      {!status.botConnected && (
        <div className="dash-banner dash-banner--warn">
          <span>Bot disconnected — retrying automatically; showing the last received snapshot.</span>
          {onReconnect && <button onClick={onReconnect}>Reconnect now</button>}
        </div>
      )}
      {status.error && <div className="dash-banner dash-banner--error">{status.error}</div>}

      <main className={cx('dash-main', editMode ? 'is-editing' : false)}>
        <div className="canvas-scroll">
          <div ref={canvasRef} className={cx('dash-canvas', isCompact ? 'is-compact' : false)} style={{ height: isCompact ? undefined : canvasHeight }}>

            {visibleWidgets.map(widget => {
              const rect = (preview?.id === widget.id ? preview.rect : layout[widget.id]) ?? { x: 0, y: 0, w: widget.defaultW, h: widget.defaultH };
              const style = isCompact ? undefined : rectStyle(rect, colWidth, rowHeight);
              const isPreview = preview?.id === widget.id;
              return (
                <section
                  key={widget.id}
                  className={cx('dash-widget', 'dash-widget--' + (widget.accent ?? 'cyan'), isPreview ? 'is-preview' : false)}
                  style={style}
                  data-widget-id={widget.id}
                >
                  <header
                    className="dash-widget__head"
                    onPointerDown={e => startDrag(e, widget.id)}
                    title={editMode ? 'Drag to move' : widget.description}
                  >
                    <span className="dash-widget__grip">⠿</span>
                    <span className="dash-widget__icon">{widget.icon}</span>
                    <div className="dash-widget__titles">
                      <h3>{widget.title}</h3>
                      {widget.description && <p>{widget.description}</p>}
                    </div>
                    <span className="dash-widget__cat">{widget.category}</span>
                    {editMode && (
                      <button className="dash-widget__hide" onPointerDown={e => e.stopPropagation()} onClick={() => toggleWidget(widget.id)} title="Hide widget">×</button>
                    )}
                  </header>
                  <div className="dash-widget__body">{widget.content}</div>
                  {editMode && !isCompact && (
                    <div
                      className="dash-widget__resize"
                      onPointerDown={e => startResize(e, widget.id, widget)}
                      title="Drag to resize"
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
        <span>POLY//15 · operator console</span>
        <span>Not financial advice · built for the BTC 15m book</span>
        <span>{status.wins != null && status.losses != null ? String(status.wins) + 'W / ' + String(status.losses) + 'L' : '—'} · {status.dryRun ? 'PAPER BANKROLL ' : 'BANKROLL '}{fmtMoney(status.bankroll)} · {status.dryRun ? 'PAPER PnL ' : 'PnL '}{fmtMoney(status.dailyPnl)}</span>
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
      {toast && <div className="dash-toast">{toast}</div>}
    </div>
  );
}
