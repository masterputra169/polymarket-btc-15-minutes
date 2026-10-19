/** Pure layout math for the draggable dashboard. No React here. */
export const DASHBOARD_COLS = 12;
export const MAX_LAYOUT_ROWS = 200;

export interface Rect { x: number; y: number; w: number; h: number; }
export interface WidgetSize { id: string; w: number; h: number; }
export type LayoutMap = Record<string, Rect>;

export function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export function isAreaFree(layout: LayoutMap, rect: Rect, ignoreId?: string, cols = DASHBOARD_COLS): boolean {
  if (rect.x < 0 || rect.y < 0 || rect.w < 1 || rect.h < 1) return false;
  if (rect.x + rect.w > cols) return false;
  for (const [id, other] of Object.entries(layout)) {
    if (id === ignoreId) continue;
    if (overlaps(rect, other)) return false;
  }
  return true;
}

export function clampRect(rect: Rect, cols = DASHBOARD_COLS): Rect {
  const w = Math.max(1, Math.min(cols, Math.round(rect.w)));
  const h = Math.max(1, Math.min(MAX_LAYOUT_ROWS, Math.round(rect.h)));
  const x = Math.max(0, Math.min(cols - w, Math.round(rect.x)));
  const y = Math.max(0, Math.min(MAX_LAYOUT_ROWS - h, Math.round(rect.y)));
  return { x, y, w, h };
}

/** First free slot scanning top-to-bottom, left-to-right. */
export function findFreeSlot(layout: LayoutMap, w: number, h: number, startX = 0, startY = 0, cols = DASHBOARD_COLS): Rect {
  const cw = Math.max(1, Math.min(cols, Math.round(w)));
  const ch = Math.max(1, Math.min(MAX_LAYOUT_ROWS, Math.round(h)));
  const sx = Math.max(0, Math.min(cols - cw, Math.round(startX)));
  const sy = Math.max(0, Math.round(startY));
  for (let y = sy; y < MAX_LAYOUT_ROWS; y++) {
    const rowStart = y === sy ? sx : 0;
    for (let x = rowStart; x <= cols - cw; x++) {
      const candidate = { x, y, w: cw, h: ch };
      if (isAreaFree(layout, candidate, undefined, cols)) return candidate;
    }
    // Once the starting row is exhausted, later rows scan from the left edge.
  }
  const bottom = Object.values(layout).reduce((max, r) => Math.max(max, r.y + r.h), 0);
  return { x: 0, y: bottom, w: cw, h: ch };
}

export function packLayout(items: WidgetSize[], cols = DASHBOARD_COLS): LayoutMap {
  const layout: LayoutMap = {};
  for (const item of items) {
    const slot = findFreeSlot(layout, item.w, item.h, 0, 0, cols);
    layout[item.id] = slot;
  }
  return layout;
}

/** Place at the requested slot; on collision, move to the nearest free slot. */
export function placeWidget(layout: LayoutMap, id: string, desired: Rect, cols = DASHBOARD_COLS): LayoutMap {
  const rect = clampRect(desired, cols);
  const next: LayoutMap = { ...layout };
  if (isAreaFree(next, rect, id, cols)) {
    next[id] = rect;
    return next;
  }
  const slot = findFreeSlot(next, rect.w, rect.h, rect.x, rect.y, cols);
  next[id] = slot;
  return next;
}

export function bottomOf(layout: LayoutMap): number {
  return Object.values(layout).reduce((max, r) => Math.max(max, r.y + r.h), 0);
}

export function visibleLayout(layout: LayoutMap, visibleIds: string[]): LayoutMap {
  const out: LayoutMap = {};
  for (const id of visibleIds) if (layout[id]) out[id] = layout[id];
  return out;
}
