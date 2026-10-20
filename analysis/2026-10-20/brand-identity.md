# POLY//15 brand identity — 2026-10-20

## Concept

The mark is a **15-minute clock ring + a candlestick that forms the P of POLY//15**.

- **15 ticks** around the badge = the 15-minute market window.
- One **amber tick + arc** = the active window / the BTC side.
- **Amber candlestick stem** with wick = Bitcoin, the asset being traded.
- **Cyan P bowl** wraps the candle in a 15-minute arc = the bot / the clock.
- **Pulse line inside the bowl** = signal, execution and review.
- Dark terminal badge, cyan + amber accents match the dashboard and login page.

## Assets

| File | Use |
|---|---|
| `public/brand/poly15-mark.svg` | master mark; topbar, login, splash, favicon.svg |
| `public/favicon.svg` | SVG favicon |
| `public/favicon.ico` | 16/24/32/48/64 multi-size favicon |
| `public/brand/favicon-16.png`, `favicon-32.png` | PNG favicon fallbacks |
| `public/brand/apple-touch-icon.png` | iOS home screen (180 px) |
| `public/brand/icon-192.png`, `icon-512.png`, `icon-1024.png` | PWA / manifest icons |
| `public/brand/og-image.png` | 1200×630 social preview |
| `public/site.webmanifest` | PWA metadata |

## Integration

- `index.html`: favicon, apple touch icon, manifest, OG/Twitter metadata, theme color.
- `DashboardShell.tsx`: topbar mark replaces the old `₿` text badge.
- `LoginPage.tsx`: login card mark + auth splash are the new mark; the splash gently pulses instead of rotating.
- nginx serves `.webmanifest` as `application/manifest+json`.

## Verification

- `/favicon.ico?v=20261020` → `200 image/x-icon` (cache-busted so existing tabs pick up the new icon).
- `/favicon.svg`, `/brand/poly15-mark.svg` → `200 image/svg+xml`.
- `/brand/og-image.png` → `200 image/png` (1200×630).
- `/site.webmanifest` → `200 application/manifest+json`.
- Playwright: login mark and dashboard topbar mark load; 16 widgets still render; login/auth unaffected.