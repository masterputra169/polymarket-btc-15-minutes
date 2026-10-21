# POLY//15 brand mark v2 — flat identity — 2026-10-21

## Why the change

The first mark was a glossy 3D-style P made of a clock ring, candlestick, arc and pulse. It read as generated/overworked and the neon glow made it look like a generic AI crypto brand.

The new mark strips that back to a **flat typographic monogram**:

- warm paper `#F2EEE5` tile;
- heavy ink `#111214` P, drawn as a simple geometric path;
- one safety-orange `#FF5A1F` square as the only accent;
- no gradients, no glow, no filters, no 15-segment ring, no extra iconography.

It reads as a design/print mark first and a trading product second — the wordmark and UI carry the trading context.

## Brand system

| Token | Value | Use |
|---|---|---|
| Paper | `#F2EEE5` | mark tile, OG background text |
| Ink | `#111214` | P, type |
| Signal orange | `#FF5A1F` | square, `//` slash, category kicker |
| UI cyan | existing dashboard accent | product UI, unchanged |

## Assets

- `public/brand/poly15-mark.svg` — master flat mark.
- `public/favicon.ico`, `public/favicon.svg` — browser tab.
- `public/brand/favicon-16.png`, `favicon-32.png`, `apple-touch-icon.png`.
- `public/brand/icon-192.png`, `icon-512.png`, `icon-1024.png` — PWA.
- `public/brand/og-image.png` — flat 1200×630 social card.
- `public/site.webmanifest`.

## Integration

- Login card mark and auth splash: flat mark; the splash pulses softly instead of spinning.
- Dashboard topbar: flat mark replaces the `₿` badge.
- Wordmark `//` accent changed from cyan to signal orange in the topbar and login brand.
- Favicon/asset queries bumped to `v=20261021` so existing tabs pick up the new mark.

## Verification

- `/favicon.ico?v=20261021` → `200 image/x-icon`.
- `/brand/poly15-mark.svg?v=20261021` → loaded in login and dashboard.
- `/brand/og-image.png` → `200 image/png`, 1200×630.
- `/site.webmanifest` → `200 application/manifest+json`.
- Login + dashboard screenshots reviewed with the new mark; 16 widgets still render; auth unaffected.