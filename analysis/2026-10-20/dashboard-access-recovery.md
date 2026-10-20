# Dashboard access recovery — 2026-10-20

## Symptom

The public dashboard rendered its shell but showed `Bot disconnected`, `Widgets 0`, all feed pills offline and an endless `Linking to the bot stream...` state.

## Root cause

- The bot was healthy: systemd active, status port `127.0.0.1:3099` listening, and a direct local WebSocket returned a snapshot.
- nginx injected a **stale `STATUS_AUTH_TOKEN`** into `proxy_pass .../ws?token=...`; the bot's `.env` token had changed.
- `/ws` returned **401**, so no snapshot reached the browser. The static page worked, which made it look like a frontend bug.
- While fixing it, a backup nginx file was briefly placed in `sites-enabled`, causing a duplicate `limit_req_zone`; it was moved to `/etc/nginx/backups/`.

## Fix

1. nginx `/ws` and report bearer tokens are now synchronised from `bot/.env`.
2. Installed `polybot-dashboard-auth-sync.timer` (every 2 min) + oneshot service; it only reloads nginx when the rendered config actually changes.
3. `/ws` stays protected by nginx **HTTP Basic Auth**; Chromium sends the cached Basic credentials on the WebSocket handshake once the page is authenticated. No unauthenticated control socket.
4. Frontend `useBotData` no longer gives up after 5 failures: it keeps probing at the 30 s ceiling. Added a **Reconnect now** button to the disconnected banner.

## Verification

- nginx WS with the browser's Basic credentials: 101, snapshot bytes returned.
- Direct local WS: snapshot bytes returned.
- Public Playwright check through the Cloudflare URL: **16 widgets**, no disconnect banner, no page errors.
- Token sync service + timer installed and active.
- Typecheck PASS; production build PASS.
- Full suite: 928/929 passed on the first run; the one failure (`clobClient.v2.test.ts`) was a timeout under load and passed in isolation (15/15).

## Remaining operational note

The dashboard uses a **Cloudflare Quick Tunnel**; the URL can change if `cloudflared-quick` restarts. The current URL is in `/opt/polybtc15/.tunnel-url`. A stable custom hostname requires a one-time `cloudflared tunnel login` + named tunnel; no origin certificate exists on the VPS yet.