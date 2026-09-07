# Railway deployment — design (2026-09-07)

Approved in chat 2026-09-07. Scope: run the whole stack on Railway so the bot
stops depending on a Windows box whose Docker engine hangs. First stage runs
DRY_RUN with a fresh state; going live is a variable flip.

## Services (one project, environment `production`)

| Service | Source | Networking | Notes |
|---|---|---|---|
| `bot` | `Dockerfile.bot` via `RAILWAY_DOCKERFILE_PATH` | private only, `bot.railway.internal` | volume at `/app/bot/data`; `RAILWAY_RUN_UID=0` because the volume is root-owned and the image runs as `node`; `STATUS_BIND_HOST`/`REPORT_BIND_HOST` = `::`; `PORT=3101` so the healthcheck hits the report API `/health` |
| `Postgres` | Railway plugin | private | schema is created by the bot (`CREATE TABLE IF NOT EXISTS`) |
| `Redis` | Railway plugin | private | status mirror |
| `frontend` | `Dockerfile.frontend` | public domain → port 80 | nginx proxies `/ws` and `/api/reports` to `bot.railway.internal`; `VITE_BOT_STATUS_TOKEN` build arg comes from the service variable of the same name; `BOT_HOST=bot.railway.internal`, `PORT=80` |

Variables on `bot`: everything in `bot/.env` (copied by CLI, never printed),
`DRY_RUN=true`, `DATABASE_URL=${{Postgres.DATABASE_URL}}`,
`REDIS_URL=${{Redis.REDIS_URL}}`, fresh `STATUS_AUTH_TOKEN` and
`REPORT_AUTH_TOKEN`, `TZ`, `RUNTIME_INTEGRATIONS_ENABLED=true`,
`POLYMARKET_DOH_ENABLED=false` (no ISP DNS block on Railway).

## Decisions and alternatives

1. Dashboard → bot over the private network through nginx (chosen) rather than
   a public bot domain with the browser connecting by WSS. Keeps the bot off
   the internet; the token stays the only gate.
2. Volume permissions via `RAILWAY_RUN_UID=0` (Railway's documented path)
   rather than an entrypoint that chowns and drops privileges. Cost: the bot
   process is root inside its container on Railway.
3. Healthcheck and liveness are two different things. Railway's healthcheck
   (`/health` on the report API, now unauthenticated and DB-independent) says
   the process is up. The new in-process liveness watch says polls complete:
   10 min without a completed poll (5 min grace after start) → `exit 1` →
   `restartPolicyType: ON_FAILURE` restarts it. Same code path protects the
   local Docker stack and PM2.
4. nginx resolves the bot hostname per request through the resolver found in
   `/etc/resolv.conf` at container start (`docker/nginx-resolver.envsh`), so
   a bot redeploy with a new private IP does not leave the dashboard on a
   stale address. The same template serves compose (`BOT_HOST=bot`).

## Out of scope for this stage

Region pinning (default workspace region; move to US East in the dashboard),
GitHub auto-deploy (CLI upload now; link the repo later), ML retrain on
Railway (image has no Python; models ship with the image), arb dry-run
simulation (0 opportunities in 127k polls).

## Verification

Bot log shows `Mode: DRY RUN`, both models loaded, `[Loop] #` lines advancing,
`Liveness watch` line present. `/health` on the report API returns 200. The
dashboard on the public domain connects to `/ws` and renders live state.
Then: stop the local Docker bot and drop `bot/data/watchdog.paused`.
