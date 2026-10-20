# Smooth dashboard drag/resize on all viewports — 2026-10-20

## Problem

- Drag called `setPreview()` on every `pointermove`; the shell re-rendered the entire 16-widget canvas at 20 Hz bot-snapshot rate, so drag felt janky.
- Compact (<980 px) disabled drag and resize entirely; mobile had no way to reorder or size widgets.

## Desktop / wide

- The dragged panel is moved with **direct CSS `transform: translate3d(...)`**, scheduled on **requestAnimationFrame**. No React state update per pointer move.
- A translucent **snap ghost** shows the target grid cell; it only re-renders when the snapped cell changes.
- On drop, `flushSync` commits the final grid rect once; pointer capture handles cancel/snap-back.
- Resize also writes width/height directly during the gesture (re-applied after any live snapshot commit through `useLayoutEffect`), then commits the snapped rect on release.
- Inline width/height are pinned to the committed grid size so React (which only writes changed style props) cannot leave the panel at shrink-to-fit size.

## Tablet / mobile

- All sizes now have drag. Under 980 px the canvas is a vertical list: dragging a header reorders the compact list; a target outline shows the drop position.
- Auto-scroll near viewport edges while reordering.
- Bottom-right handle is now available on compact too and resizes **height**; hit target is 34 px on touch.
- `touch-action: none` only while editing; normal page scrolling is unaffected outside edit mode.

## Persistence

- Layout store bumped to **v5**: `order` (compact order) and `heights` (compact per-widget heights) persist in localStorage and in export/import.
- The pre-hydration empty canvas is no longer allowed to overwrite a saved layout/order (guards on the persistence and sync effects). Verified reorder survives reload.

## Verification

- Desktop 1600×1100: during drag `transform: translate3d(120px, 80px, 0)` and 1 snap ghost; drop into a free cell committed `bot: {x:0,y:5}`; resize shrink committed `market: {x:0,y:0,w:6,h:2}`.
- Tablet 820×1180: compact drag reordered `Bot Core` after `Prediction`; height resize 260 → 380 px.
- Mobile 390×844: pointer + real touch (CDP `Input.dispatchTouchEvent`) reorder persisted after reload; compact height resize worked.
- Frontend typecheck/build PASS.