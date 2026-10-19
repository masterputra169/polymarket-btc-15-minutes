import { describe, it, expect } from 'vitest';
import { clampRect, findFreeSlot, isAreaFree, overlaps, packLayout, placeWidget } from '../layout.ts';

describe('dashboard layout', () => {
  it('detects overlap and respects ignoreId', () => {
    const a = { x: 0, y: 0, w: 4, h: 2 };
    expect(overlaps(a, { x: 3, y: 1, w: 3, h: 2 })).toBe(true);
    expect(overlaps(a, { x: 4, y: 0, w: 2, h: 2 })).toBe(false);
    const layout = { a };
    expect(isAreaFree(layout, { x: 1, y: 0, w: 2, h: 2 })).toBe(false);
    expect(isAreaFree(layout, { x: 1, y: 0, w: 2, h: 2 }, 'a')).toBe(true);
  });

  it('clamps rectangles into the 12-column grid', () => {
    expect(clampRect({ x: -3, y: -2, w: 99, h: 0 })).toEqual({ x: 0, y: 0, w: 12, h: 1 });
    expect(clampRect({ x: 11, y: 4, w: 4, h: 2 })).toEqual({ x: 8, y: 4, w: 4, h: 2 });
  });

  it('packing never overlaps', () => {
    const layout = packLayout([
      { id: 'a', w: 8, h: 2 }, { id: 'b', w: 4, h: 2 },
      { id: 'c', w: 4, h: 3 }, { id: 'd', w: 4, h: 3 },
    ]);
    const entries = Object.entries(layout);
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        expect(overlaps(entries[i][1], entries[j][1])).toBe(false);
      }
    }
    expect(layout.a).toEqual({ x: 0, y: 0, w: 8, h: 2 });
    expect(layout.b).toEqual({ x: 8, y: 0, w: 4, h: 2 });
  });

  it('moves a colliding widget to the nearest free slot', () => {
    const layout = { a: { x: 0, y: 0, w: 6, h: 3 } };
    const moved = placeWidget(layout, 'b', { x: 0, y: 0, w: 4, h: 2 });
    expect(overlaps(moved.a, moved.b)).toBe(false);
    expect(moved.b).toEqual({ x: 6, y: 0, w: 4, h: 2 });
  });

  it('findFreeSlot fills the first hole', () => {
    const layout = { a: { x: 0, y: 0, w: 4, h: 2 }, b: { x: 8, y: 0, w: 4, h: 2 } };
    expect(findFreeSlot(layout, 4, 2)).toEqual({ x: 4, y: 0, w: 4, h: 2 });
  });
});
