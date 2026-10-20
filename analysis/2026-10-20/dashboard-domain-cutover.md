# Dashboard domain cutover — 2026-10-20

## Result

- Public URL: **https://poly15.dollarkilat.xyz/**
- Cloudflare named tunnel: `polybtc15` (id `198cf192-95df-4707-b0fb-01cd9b72a25a`).
- Origin: `http://127.0.0.1:8080` (nginx Basic Auth).
- DNS: Cloudflare CNAME created by `cloudflared tunnel route dns`.
- Quick Tunnel `cloudflared-quick`: **disabled**.
- Old quick-tunnel URL sync timer `polybot-tunnel-sync.timer`: **disabled**, so it cannot overwrite `DASHBOARD_URL` with the old URL.
- `DASHBOARD_URL=https://poly15.dollarkilat.xyz/`; `/opt/polybtc15/.tunnel-url` updated.
- Bot restarted once to load the new alert URL; state loaded from disk (bankroll continuity preserved).

## Verification

- `curl https://poly15.dollarkilat.xyz/` → **401** without Basic Auth (expected; tunnel reaches nginx).
- Playwright with Basic Auth → **200**, 16 widgets, no disconnect banner.
- WebSocket `/ws` through the named tunnel delivered snapshots.
- Footer shows `PAPER CASH` and `PAPER EQUITY`.
- Apex `dollarkilat.xyz` remains untouched (existing Vercel site).

## Operations

- Named tunnel service: `cloudflared-named.service` (enabled, Restart=always).
- Quick tunnel service: disabled; keep the unit as rollback.
- Auth: nginx Basic Auth on page and `/ws`; token injection unchanged.
- Optional next hardening: Cloudflare Access (email OTP/service token) in front of the hostname.

## Notes

- Cloudflare injects its Insights beacon; the nginx CSP currently blocks it, producing a console-only CSP warning. It does not affect the dashboard. Add `https://static.cloudflareinsights.com` to `script-src` only if analytics is wanted.
- If the VPS is rebuilt, the named tunnel requires the Cloudflare certificate/credentials or a new connector token; do not commit `cert.pem` or tunnel credentials.