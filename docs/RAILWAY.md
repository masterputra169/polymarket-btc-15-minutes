# Railway deployment

The whole stack runs on Railway (project `polybtc15`, environment
`production`) so the bot no longer depends on a Windows box whose Docker
engine hangs. Design and decisions: `docs/superpowers/specs/2026-09-07-railway-deploy-design.md`.

Dashboard: https://frontend-production-d0bf1.up.railway.app

## Services

| Service | Built from | Reachability | State |
|---|---|---|---|
| `bot` | `Dockerfile.bot` (`RAILWAY_DOCKERFILE_PATH`) | private only, `bot.railway.internal` | volume `bot-volume` at `/app/bot/data` |
| `Postgres` | Railway plugin | private | own volume; schema created by the bot |
| `Redis` | Railway plugin | private | own volume |
| `frontend` | `Dockerfile.frontend` | public domain above, port 80 | stateless |

The bot listens on `::` (IPv6 + IPv4) so the frontend's nginx can reach it
over Railway's private network; `PORT=3101` points Railway's healthcheck at
the report API's unauthenticated `/health`. The frontend proxies `/ws` and
`/api/reports` to `bot.railway.internal`, re-resolving the hostname per
request (the nginx image's own `15-local-resolvers.envsh` exports
`NGINX_LOCAL_RESOLVERS`, used by `docker/nginx.conf.template`), so a bot
redeploy with a new private IP never strands the dashboard. nginx listens on
`[::]:80` as well as `80`: Railway reaches containers over IPv6.

## Variables

`bot` carries everything from `bot/.env` (copied by CLI, values never
printed) plus:

| Key | Value | Why |
|---|---|---|
| `DRY_RUN` | `true` | first stage collects evidence; live is a flip of this one variable |
| `DATABASE_URL` / `REDIS_URL` | `${{Postgres.DATABASE_URL}}` / `${{Redis.REDIS_URL}}` | reference variables → private hosts |
| `STATUS_AUTH_TOKEN`, `REPORT_AUTH_TOKEN` | fresh 32-byte hex, different from the local stack | the frontend build embeds the status token as `VITE_BOT_STATUS_TOKEN` |
| `STATUS_BIND_HOST`, `REPORT_BIND_HOST` | `::` | private networking is IPv6 |
| `STATUS_PORT`, `REPORT_PORT`, `PORT` | `3099`, `3101`, `3101` | `PORT` = healthcheck target |
| `RAILWAY_RUN_UID` | `0` | the volume is root-owned; the image runs as `node` |
| `RAILWAY_DOCKERFILE_PATH` | `Dockerfile.bot` | monorepo: two images from one repo |
| `POLYMARKET_DOH_ENABLED` | `false` | no ISP DNS block on Railway |
| `TZ` | `Asia/Jakarta` | log timestamps |

`frontend`: `RAILWAY_DOCKERFILE_PATH=Dockerfile.frontend`, `VITE_BOT_WS_URL=/ws`,
`VITE_BOT_STATUS_TOKEN=<same as bot STATUS_AUTH_TOKEN>`, `BOT_HOST=bot.railway.internal`,
`PORT=80`.

## Deploy

From this checkout (uploads the working tree, honouring `.gitignore` and
`.railwayignore`):

```bash
railway up --service bot --ci
railway up --service frontend --ci
```

`railway.json` applies to both services: Dockerfile builder, healthcheck
`/health`, `restartPolicyType: ON_FAILURE`. Variable changes redeploy
automatically unless set with `--skip-deploys`.

Git Bash mangles leading-slash arguments into Windows paths; prefix Railway
commands that take paths with `MSYS_NO_PATHCONV=1` (this is how `/ws` once
became `C:/Program Files/Git/ws`).

## Verify

```bash
railway logs --service bot | grep -E 'Mode:|loaded|Liveness|Loop\] #'
curl -s https://frontend-production-d0bf1.up.railway.app/health           # ok
curl -s https://frontend-production-d0bf1.up.railway.app/api/health/report  # {"ok":true,...}
npm run report:dryrun                                                     # once the journal fills
```

Liveness: the bot exits 1 after 10 minutes without a completed poll (5 min
grace after start, `LIVENESS_STALE_MIN` / `LIVENESS_GRACE_MIN`,
`LIVENESS_EXIT_ENABLED=false` to only log) and Railway restarts it. This is
the platform equivalent of `scripts/stack-watchdog.ps1`.

## Going live

1. Make sure nothing else trades the wallet: the local Docker bot must be
   stopped (`docker compose stop bot`) and the local watchdog paused
   (`bot/data/watchdog.paused` exists).
2. `railway variable set --service bot DRY_RUN=false` — this redeploys.
3. The paper bankroll in the volume's `state.json` is replaced by the
   on-chain USDC balance on the first live poll (startup balance reconciliation).

## Not on Railway

ML retraining (the image has no Python; models ship in the image, so a new
model is a rebuild), the PM2 processes, and the Windows watchdog.
