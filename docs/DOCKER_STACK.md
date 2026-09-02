# Docker Stack

This project can run as a Docker Compose stack:

- `frontend`: Vite build served by Nginx on `http://localhost:3010`
- `bot`: Node 25 bot process, internal WebSocket on `bot:3099`
- `postgres`: PostgreSQL runtime/event/journal mirror database
- `redis`: Redis cache for runtime health/events/status snapshots

## Files

- `docker-compose.yml`
- `Dockerfile.bot`
- `Dockerfile.frontend`
- `docker/nginx.conf`
- `docker/postgres/init/001_runtime_schema.sql`
- `.env.docker.example`

## Run

Use the existing `bot/.env` for bot secrets and strategy settings. For Docker-specific overrides:

```powershell
Copy-Item .env.docker.example .env
```

Then edit `.env` and set the three **required** secrets — compose refuses to start (with a clear error) while any of them is unset:

| Variable | Purpose | Generate with |
|----------|---------|---------------|
| `POSTGRES_PASSWORD` | PostgreSQL password for the stack | `openssl rand -hex 24` |
| `STATUS_AUTH_TOKEN` | Auth token for the bot status WebSocket (`:3099`) | `openssl rand -hex 32` |
| `REPORT_AUTH_TOKEN` | Auth token for the read-only report API (`:3101`) | `openssl rand -hex 32` |

```powershell
# Example: generate all three (Git Bash / WSL)
openssl rand -hex 24   # POSTGRES_PASSWORD
openssl rand -hex 32   # STATUS_AUTH_TOKEN
openssl rand -hex 32   # REPORT_AUTH_TOKEN
```

Start the stack:

```powershell
docker compose up -d --build
```

Open:

```text
http://localhost:3010
```

The frontend proxies WebSocket traffic from `/ws` to the internal bot service, so port `3099` is not exposed to the host by default.

### Network exposure

The frontend port is published on **loopback only** (`127.0.0.1`) by default, so the dashboard is reachable only from the host machine. To expose it on the LAN, set `FRONTEND_BIND=0.0.0.0` in `.env` as an explicit opt-in — and only on a trusted network.

### Dashboard auth token

`STATUS_AUTH_TOKEN` is passed to the frontend build as `VITE_BOT_STATUS_TOKEN` and is **embedded in the served JS bundle**. This protects the bot WebSocket against unauthenticated scanners and stray clients, but not against anyone who can load the dashboard itself — they can read the token from the bundle. Network restriction (the loopback-only default above, or a VPN/reverse-proxy auth layer) is the stronger control; the token is defense in depth. Rebuild the frontend image after rotating the token.

## Verify

```powershell
docker compose ps
docker compose logs -f bot
docker compose exec -T postgres psql -U polymarket -d polymarket -c "SELECT event_type, created_at FROM bot_runtime_events ORDER BY id DESC LIMIT 5;"
docker compose exec -T redis redis-cli KEYS "polymarket-bot:*"
```

Polymarket snapshot check:

```powershell
docker compose exec -T bot node -e "import('./bot/src/adapters/dataFetcher.ts').then(async m=>console.log(await m.fetchPolymarketSnapshot()))"
```

If normal DNS is redirected to `trustpositifkominfo` / `rpz.biznet`, the bot uses DNS-over-HTTPS for `*.polymarket.com` requests. This keeps Gamma/CLOB market discovery working without changing Binance or Chainlink DNS behavior.

```text
POLYMARKET_DOH_ENABLED=true
POLYMARKET_DOH_URL=https://cloudflare-dns.com/dns-query
```

## ML Quality

Audit the deployed model without retraining:

```powershell
docker compose exec -T bot node bot/scripts/mlQualityAudit.mts
```

Run a full retrain in dry-run mode from the host/dev environment. This may take a long time because it refreshes data, rebuilds training features, trains XGBoost/LightGBM, then runs the quality gate without deploying:

```powershell
npm run ml:retrain:dry
```

The default bot image stays focused on runtime stability and does not bundle the heavy Python ML training stack or historical backtest artifacts.

The retrain quality gate blocks auto-deploy when a model is weak, miscalibrated, or likely overfit. Defaults:

```text
RETRAIN_MIN_ACCURACY=0.70
RETRAIN_MIN_AUC=0.80
RETRAIN_MIN_HIGH_CONF_ACCURACY=0.78
RETRAIN_MIN_HIGH_CONF_COVERAGE=5
RETRAIN_MAX_HIGH_CONF_COVERAGE=98
RETRAIN_MAX_CALIBRATION_ECE=0.08
RETRAIN_MAX_CV_TEST_ACC_GAP=0.04
RETRAIN_MAX_TEST_HOLDOUT_ACC_GAP=0.08
RETRAIN_REQUIRE_STRICT_HOLDOUT=true
```

For BTC 15-minute markets, treat 90%+ all-sample accuracy as suspicious until it passes strict temporal holdout, calibration, coverage, and live/shadow validation. A realistic target is higher accuracy only on a smaller high-confidence subset.

## Stop

```powershell
docker compose down
```

Keep volumes:

```powershell
docker compose down
```

Remove PostgreSQL and Redis data volumes:

```powershell
docker compose down -v
```

## Runtime Data

The bot still persists its existing file state through bind mounts:

- `./bot/data:/app/bot/data`
- `./public/ml:/app/public/ml`

PostgreSQL is currently integrated as a runtime event store and a dual-write mirror for new trade journal records. Redis stores runtime health/events and status snapshots when the bot broadcasts them. File storage remains the primary source of truth until the bot storage layer is migrated table by table.

Current PostgreSQL tables:

- `bot_runtime_events`: startup, shutdown, integration readiness, session summaries
- `trade_journal_records`: trade journal mirror from `trade_journal.jsonl`
- `verified_journal_records`: on-chain verified journal mirror from `verified_journal.jsonl`
- `bot_state_snapshots`: point-in-time `state.json` snapshots
- `bot_trade_events`: recent trade events extracted from `state.json`
- `bot_position_snapshots`: `positions.json` snapshots
- `bot_signal_perf_snapshots`: `signal_perf.json` snapshots

Backfill existing file data into PostgreSQL:

```powershell
docker compose exec -T bot node bot/scripts/backfillPostgres.mts
```

Quick table counts:

```powershell
docker compose exec -T postgres psql -U polymarket -d polymarket -c "SELECT 'trade_journal_records' AS table_name, count(*) FROM trade_journal_records UNION ALL SELECT 'verified_journal_records', count(*) FROM verified_journal_records UNION ALL SELECT 'bot_state_snapshots', count(*) FROM bot_state_snapshots UNION ALL SELECT 'bot_trade_events', count(*) FROM bot_trade_events;"
```

## Reports

The bot exposes a read-only PostgreSQL report API internally on `bot:3101`; Nginx proxies it through the frontend:

```text
http://localhost:3010/api/reports
http://localhost:3010/api/reports?days=30&limit=20
http://localhost:3010/api/health/report
```

The report includes:

- table counts
- latest bot state snapshot
- daily PnL
- outcome summary
- side summary
- execution summary
- phase summary
- verified/local PnL discrepancy summary
- recent real trades
- top verified discrepancies

CLI report:

```powershell
docker compose exec -T bot npm run pg:report -- --days 30 --limit 20
docker compose exec -T bot npm run pg:report -- --days 30 --json
```

Analytics views are defined in:

```text
docker/postgres/init/002_analytics_views.sql
```

For an already-running database, apply/re-apply them with:

```powershell
docker compose exec -T postgres psql -U polymarket -d polymarket -f /docker-entrypoint-initdb.d/002_analytics_views.sql
```

## PostgreSQL Backup

One-shot local backup from the PostgreSQL container:

```powershell
New-Item -ItemType Directory -Force backups/postgres
docker compose exec -T postgres pg_dump -U polymarket -d polymarket -Fc > backups/postgres/polymarket_latest.dump
```

Automatic backup service:

```powershell
docker compose --profile backup up -d postgres-backup
```

Backups are written to:

```text
backups/postgres/
```

Retention and interval are controlled by:

```text
POSTGRES_BACKUP_RETENTION_DAYS=14
POSTGRES_BACKUP_INTERVAL_SEC=86400
```

### Backup data at rest

Backup dumps contain the **full trade history and bankroll data** in plaintext. The backup service sets `umask 077` so new dumps are readable only by their owner, but treat the directory itself as sensitive:

- Restrict permissions on `backups/postgres/` to the operating user only.
- Encrypt dumps (for example with `age` or `gpg`) before copying them off-host or into any cloud storage.
- Apply the same retention/deletion discipline to off-host copies as to the local directory.

### PostgreSQL hardening

The role created by compose (`polymarket`) is the **instance superuser** — it owns the cluster, not just the app database. That is acceptable for a single-purpose local stack, but for hardened deployments create a least-privilege application role (CONNECT + table-level DML on the app schema only) and point `DATABASE_URL` at that role instead, keeping the superuser for migrations and maintenance only.

## Safety

Check `DRY_RUN` in `bot/.env` before starting the stack. Compose uses the same bot environment file as local PM2/manual runs.

Do not share `docker compose config` output publicly because it expands `bot/.env` secrets. It also expands `POSTGRES_PASSWORD` into the printed `DATABASE_URL` (and into the `postgres` / `postgres-backup` environment blocks), so the rendered config contains every secret in the clear.

The stack serves plain HTTP; HSTS is deliberately not set in `docker/nginx.conf`. If you put the dashboard behind a TLS-terminating reverse proxy, add HSTS (and TLS redirects) on that proxy, not here.

Images are pinned to minor versions (`postgres:17-alpine`, `redis:7-alpine`, `nginx:1.27-alpine`, `node:25-bookworm-slim`). For production immutability, pin by digest (`image@sha256:...`) instead so a retagged upstream image cannot change what you run.
