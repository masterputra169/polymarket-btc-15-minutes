# Polymarket BTC 15-Minute Trading Bot

[![CI](https://github.com/masterputra169/polymarket-btc-15-minutes/actions/workflows/ci.yml/badge.svg)](https://github.com/masterputra169/polymarket-btc-15-minutes/actions/workflows/ci.yml)

> An automated trading bot for Polymarket's **"Bitcoin Up or Down — 15 minute"** binary markets, plus a real-time React dashboard.
> It combines an XGBoost + LightGBM ensemble, 10 technical indicators, a stack of entry filters, smart order routing and settlement-first risk management.

**Stack:** TypeScript end to end · React 19 + Vite 7 (dashboard) · Node.js 25 bot (PM2, Docker or Railway) · PostgreSQL + Redis (optional mirror/cache) · XGBoost + LightGBM (Python training, in-process TypeScript inference) · Polymarket CLOB API

> [!WARNING]
> This bot places real orders with real money once `DRY_RUN=false`. **Always start in dry run**, and read [Project status](#project-status) before you go live. A win rate on its own does not tell you whether the bot makes money. See [Win rate vs breakeven](#win-rate-vs-breakeven).

---

## Table of Contents

- [What is this?](#what-is-this)
- [Project status](#project-status)
- [Key features](#key-features)
- [Architecture](#architecture)
- [Dashboard](#dashboard)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Wallet setup](#wallet-setup)
- [Configuration](#configuration)
- [Running](#running)
- [Dry run and evaluation](#dry-run-and-evaluation)
- [Trading strategies](#trading-strategies)
- [Risk management](#risk-management)
- [Settlement and verification](#settlement-and-verification)
- [Market data feeds](#market-data-feeds)
- [ML model](#ml-model)
- [Monitoring, alerts and APIs](#monitoring-alerts-and-apis)
- [Testing and CI](#testing-and-ci)
- [Project structure](#project-structure)
- [Troubleshooting](#troubleshooting)
- [Changelog](#changelog)
- [Contributing](#contributing)
- [Disclaimer](#disclaimer)
- [License](#license)

---

## What is this?

Every 15 minutes Polymarket opens a binary market: **"Will BTC be higher at the end of this 15-minute window than at the start?"** The start price is the *Price to Beat* (PTB). You buy an UP or DOWN share at the market price (for example 63¢), and a winning share pays out $1.00 at settlement.

The bot automates that loop 24/7:

1. It streams BTC prices, the Polymarket order book and the Chainlink oracle over four WebSockets.
2. It computes indicators, runs the ML ensemble and detects the market regime.
3. It compares model probability with the market price, applies the entry filters and picks an order type.
4. It holds the position to settlement (early exit only in extreme cases), verifies the result against Polymarket's own resolution, and journals everything.

---

## Project status

*As of September 2026:*

| Area | State |
|------|-------|
| Deployment | Bot, dashboard, Postgres and Redis run on **Railway** (see [docs/RAILWAY.md](docs/RAILWAY.md)). A local Docker stack is also supported. |
| Mode | **`DRY_RUN=true`**. Dry run simulates fills at the price a live order would really pay (see [Dry run and evaluation](#dry-run-and-evaluation)). |
| Go-live gate | The bot needs a positive **margin over breakeven** on the clean evaluation window, scored with `--since` (not a rolling window). Plan: ~2 weeks of clean dry run to rule out a gross regression, then a mini-size live phase ($1–2 per trade) to measure real fills, then full sizing. |
| Disabled on evidence | Pre-market long (10 trades, 30% WR, −19.88), RL bet-sizing agent (inert weights), take-profit (settlement beats early exit). |
| Trading hours | **Every hour and session trades** since 2026-09-25 (operator decision). The ET blackout hours, weekend floor and Asia ML floors are off (`TIME_GATES_ENABLED=true` restores them), and Europe is no longer blocked (`BLOCKED_SESSIONS` empty). |

The edge is thin. Proving a ~2.5pp edge over breakeven with 80% power takes about **2,280 trades**, so a two-week dry run can catch a regression but cannot confirm profitability.

---

## Key features

- **ML ensemble**: XGBoost + LightGBM with Platt calibration on logits. Ensemble weights are chosen on out-of-fold CV and trained with embargoed walk-forward validation. Inference is iterative tree traversal in TypeScript.
- **Entry filters**: a numbered gate stack (0–19) covering ML confidence, price floor/ceiling, time window, spread, VPIN, session quality, blackout hours, macro events and more. Gate 0 is a **hard session block** that no bypass can override.
- **Smart order router**: LIMIT-first routing, with FOK only for high-confidence, cheap entries and WAIT otherwise.
- **Kelly sizing**: confidence-tiered fractional Kelly with a hard per-trade cap.
- **Settlement-first risk**: a 13-gate cut-loss that fires only in extremis, circuit breakers with a daily baseline that rolls over correctly, and a sell lock that prevents exit races.
- **Honest dry run**: simulated FOK fills at the live limit price, rejection of orders larger than the book, and journal rows tagged `fillModel: 'fok_limit'`.
- **Settlement verification**: provisional settlements are re-checked against Polymarket's real resolution, and wins/losses/bankroll are corrected when needed.
- **Breakeven-aware analytics**: the dashboard shows win rate *and* margin over breakeven, with a separate realistic-fill view.
- **Resilient CLOB feed**: make-before-break socket replacement, and a three-state freshness verdict (`live` / `quiet` / `down`) that keeps a quiet book from being mistaken for a stale one.
- **Ops tooling**: Telegram and Discord alerts, a liveness heartbeat, a stack watchdog, a Postgres journal mirror and a report API.

---

## Architecture

Two systems connected by a WebSocket: a **Node.js trading bot** (`bot/`) and a **React dashboard** (`src/`).

```
                ┌──────────────────────── Bot (Node.js 25) ────────────────────────┐
Binance WS ─────┤                                                                  │
Polymarket CLOB ┤→ clobFreshness (live/quiet/down)                                 │
Chainlink WSS ──┤→ signalComputation: 10 TA indicators · ML ensemble · regime ·    │
Poly LiveData ──┘    arbitrage · smart flow                                        │
                │        │                                                         │
                │        ▼                                                         │
                │  tradeFilters (gates 0–19) ─→ edge / decide ─→ orderRouter       │
                │                                               LIMIT · FOK · WAIT │
                │        │                                                         │
                │        ▼                                                         │
                │  tradePipeline (arb first, then directional, Kelly sizing)       │
                │        │                        │                                │
                │        ▼                        ▼                                │
                │  CLOB API (live)       simulated fill (DRY_RUN)                  │
                │        │                                                         │
                │        ▼                                                         │
                │  positionTracker → cutLoss → settlement → fallbackVerifier       │
                │        │                                                         │
                │        ├─→ trade_journal.jsonl ─→ Postgres mirror (live rows)    │
                │        ├─→ statusServer  WS :3099  (state + operator RPC)        │
                │        └─→ reportServer HTTP :3101 (/health, /reports)           │
                └──────────────────────────────────────────────────────────────────┘
                                   │ WebSocket
                                   ▼
                ┌──────────── Dashboard (React 19 + Vite 7) ───────────┐
                │ useBotData ← snapshot every poll → 14 memoized panels │
                └───────────────────────────────────────────────────────┘
```

**Each poll** (`POLL_INTERVAL_MS`; 50 ms in the deployed config), the bot:

1. Reads the latest BTC, order book and oracle data from the four streams.
2. Judges CLOB freshness, then computes the indicators, ML prediction, regime and arbitrage.
3. Calculates edge (model probability minus market price) against phase-based thresholds.
4. Runs every entry filter.
5. Routes the order: **LIMIT** (passive), **FOK** (immediate) or **WAIT**.
6. Monitors any open position (cut-loss gates, settlement detection).
7. Broadcasts the full state to the dashboard.

---

## Dashboard

The dashboard connects to the bot's status WebSocket and renders one snapshot per poll. Each panel gets its own `useMemo` data slice and a `React.memo` comparator, so a panel re-renders only when its own fields change.

| Panel | Shows |
|-------|-------|
| `BotPanel` | Running/paused state, DRY_RUN, bankroll, daily P&L, operator controls |
| `PositionPanel` | Open position, mark-to-market, manual sell |
| `LimitOrderPanel` | GTD limit order lifecycle (placed → monitoring → filled/cancelled) |
| `CurrentPriceCard` | BTC price, Price to Beat, countdown to settlement |
| `PolymarketPanel` | UP/DOWN prices, spread, CLOB source (`live` / `quiet` / `REST poll`) |
| `EdgePanel` | Edge, probability, phase, regime, recommendation |
| `MlPanel` | XGBoost / LightGBM / ensemble probabilities and confidence |
| `PredictPanel` | Combined directional prediction |
| `TAIndicators` | RSI, MACD, VWAP, Bollinger, ATR, Heiken Ashi, EMA cross, StochRSI, volume delta |
| `BetSizingPanel` | Kelly sizing breakdown |
| `AccuracyPanel` | Rolling signal accuracy |
| `JournalTimeSeriesPanel` | Journal analytics: win rate, **margin vs breakeven** (lifetime + realistic fills), sessions, day of week, equity curve |
| `TraderDiscoveryPanel` | Smart-money trader discovery and tracking |
| `SessionInfo` | Trading session, local clock and bot-clock skew |

**Server clock.** Every duration shown against a bot timestamp (countdowns, ages, "updated Xs ago") uses the bot's clock through `src/hooks/serverClock.ts`, not the browser's. A PC clock that drifts cannot freeze a countdown or show a 12-hour age.

**Auth.** The status token also authorizes control commands, so it is never baked into a public bundle. Open the dashboard once with `?botStatusToken=<STATUS_AUTH_TOKEN>`. The token is stored in that browser's localStorage and reused. Visitors without it see an empty dashboard.

---

## Prerequisites

| Requirement | Version | Notes |
|-------------|---------|-------|
| Node.js | **>= 25** | Runs `.ts` / `.mts` / `.cts` natively (tested on 25.1.0) |
| npm | bundled | |
| PM2 | latest | `npm install -g pm2` (local runs) |
| Python | >= 3.10 | ML training only (3.13 tested) |
| Docker | optional | For the Compose stack |
| Railway CLI | optional | For cloud deploys |

**Polymarket requirements**

- A Polygon wallet (EOA) with a **USDC.e** balance. $50+ is a sensible start.
- No ETH/MATIC is needed. Polymarket relays are gasless.

---

## Installation

```bash
# 1. Clone
git clone https://github.com/masterputra169/polymarket-btc-15-minutes.git
cd polymarket-btc-15-minutes

# 2. Dashboard + shared tooling (repo root)
npm install

# 3. Bot dependencies
cd bot && npm install && cd ..

# 4. Bot config
cp bot/.env.example bot/.env      # then edit (see Configuration)

# 5. Sanity check
npm run typecheck && npm test

# 6. (optional) ML training dependencies
pip install -r backtest/ml_training/requirements-dev.txt
```

---

## Wallet setup

### Option A: new wallet (recommended)

```bash
node -e "
const { ethers } = require('ethers');
const w = ethers.Wallet.createRandom();
console.log('Address:    ', w.address);
console.log('Private Key:', w.privateKey);
"
```

1. Save the key in `bot/.env` as `POLYMARKET_PRIVATE_KEY=0x...`
2. Send USDC.e to the address **on Polygon**.
3. API credentials are derived automatically on first start (`bot/derive-credentials.ts` can also do it by hand).

### Option B: existing Polymarket web wallet

Polymarket's web UI creates a Gnosis Safe proxy:

1. Find the proxy address under Polymarket → Settings → Wallet.
2. Set `POLYMARKET_PROXY_ADDRESS=0x...`
3. Set `POLYMARKET_PRIVATE_KEY=0x...` (the EOA that controls the proxy).

> Never commit `bot/.env`. It is already gitignored.

---

## Configuration

All bot settings live in `bot/.env`. Every numeric value goes through bounded parsing (`envNum()` / `envInt()`), so an out-of-range value falls back to the default instead of producing a surprise. `bot/.env.example` documents the newer blocks inline.

### Core

```env
POLYMARKET_PRIVATE_KEY=0x...          # Polygon EOA private key
POLYMARKET_PROXY_ADDRESS=             # Gnosis Safe (web-UI wallets only)

BANKROLL=100                          # Starting capital (USD)
DRY_RUN=true                          # ALWAYS start with true
POLL_INTERVAL_MS=50                   # Code default is 500; deployed config uses 50
LOG_LEVEL=info

# Status WebSocket (dashboard)
STATUS_BIND_HOST=127.0.0.1            # Local only by default
STATUS_PORT=3099
# STATUS_AUTH_TOKEN=<openssl rand -hex 32>   # Required before exposing beyond localhost

# Report API
# REPORT_PORT=3101
# REPORT_AUTH_TOKEN=<openssl rand -hex 32>
```

### Risk management

```env
MAX_DAILY_LOSS_PCT=15                 # Halt when today's loss >= 15% of the day's baseline
MAX_CONSECUTIVE_LOSSES=7              # Halt after 7 straight losses
MAX_DRAWDOWN_PCT=25                   # Halt at 25% drawdown from peak
CB_COOLDOWN_MS=14400000               # 4h cooldown after a circuit-breaker halt
MAX_BET_AMOUNT_USD=2.50               # Hard cap per trade
KELLY_PROB_SHRINK=0.5                 # Kelly sizes on price + shrink × (model − price); 1 = trust the model fully
```

### Session gate and strategy toggles

```env
# Sessions that never trade. Comma-separated, case-insensitive:
# Asia | Europe | EU/US Overlap | US | Off-hours. Hard gate, no bypass. Needs a restart.
# Empty since 2026-09-25: every session trades. (Europe was blocked 2026-09-20.)
BLOCKED_SESSIONS=

# ET blackout hours (16-23), weekend ML floor and Asia-session ML floors.
# Off by default since 2026-09-25; true restores all four. Needs a restart.
TIME_GATES_ENABLED=false

CUT_LOSS_ENABLED=true                 # default true
CUT_LOSS_MIN_HOLD_SEC=720             # hold >= 12 min before any cut
CUT_LOSS_MIN_TOKEN_DROP_PCT=70        # catastrophic drops only

TAKE_PROFIT_ENABLED=false             # default false: settlement beats early exit
LIMIT_ORDER_ENABLED=false             # default false: passive GTD entries
RECOVERY_BUY_ENABLED=false            # default false: re-entry after a cut-loss

PREMARKET_LONG_ENABLED=false          # disabled 2026-09-20 (30% WR over 10 trades)
PREMARKET_LONG_RISK_PCT=0.10

# Entry-filter thresholds: any of the 48 in bot/src/safety/filterThresholds.ts,
# as FILTER_<NAME>. Unset = the built-in default. Bad or inverted values are
# refused at startup with a warning. Changing one changes which trades are taken.
# FILTER_ML_CONF_MIN=0.65

# Daily Telegram evaluation report (off when unset): WR vs breakeven since this time.
EVAL_WINDOW_START=2026-09-25T13:28:12Z
EVAL_TARGET_TRADES=150
EVAL_REPORT_HOUR_UTC=0
```

### Dry-run only

```env
# Raises the 68c entry-price hard cap in DRY_RUN only, to collect evidence.
# Accepted range 0.68-0.95. Out-of-range or non-numeric values are REFUSED
# and logged at startup, not silently ignored. No effect when DRY_RUN=false.
# DRY_RUN_HARD_ENTRY_CAP=0.75
```

### Notifications

```env
TELEGRAM_BOT_TOKEN=                   # from @BotFather
TELEGRAM_CHAT_ID=
TELEGRAM_NOTIFY_TRADES=true
DISCORD_WEBHOOK_URL=                  # optional
DASHBOARD_URL=https://frontend-production-d0bf1.up.railway.app   # "View Web" button (this is the default)
```

### Optional integrations

```env
# Postgres journal mirror + Redis cache (both optional; set automatically on Railway/Docker)
DATABASE_URL=postgres://...
REDIS_URL=redis://...

# Chainlink Data Streams: exact PTB match with Polymarket's resolution source
# CHAINLINK_DS_API_KEY=
# CHAINLINK_DS_USER_SECRET=

# Macro event guard: block around high-impact USD events (CPI, FOMC, NFP)
MACRO_GUARD_ENABLED=true
MACRO_PRE_MIN=30
MACRO_POST_MIN=15

# LLM regime classifier (advisory, shadow by default) + AI agent (OpenRouter)
LLM_REGIME_ENABLED=false
LLM_REGIME_SHADOW=true
AI_AGENT_ENABLED=false
OPENROUTER_API_KEY=
AI_MODEL=google/gemini-2-flash

# Smart-money oracle (x402 micropayments, ~$0.50-1.00/day)
METENGINE_ENABLED=false
SOLANA_PRIVATE_KEY=

# Hosts where ISP DNS black-holes polymarket.com: use DNS-over-HTTPS
# POLYMARKET_DOH_ENABLED=true

# Market tape upload (S3-compatible; Cloudflare R2 recommended). Unset = local only.
# TAPE_S3_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
# TAPE_S3_BUCKET=polybtc15-tape
# TAPE_S3_ACCESS_KEY_ID=
# TAPE_S3_SECRET_ACCESS_KEY=

# Concept drift detection
DRIFT_WINDOW=50
DRIFT_MIN_TRADES=30
DRIFT_WR_DROP_PP=15
DRIFT_AUTO_RETRAIN=false
```

### Frontend

Frontend tunables (indicator periods, stream URLs, series ID, blackout hours, the fee function) live in `src/config.ts`. Build-time variables:

| Variable | Purpose |
|----------|---------|
| `VITE_BOT_WS_URL` | Bot status WebSocket URL (for example `/ws` behind nginx) |
| `VITE_BOT_STATUS_TOKEN` | Embed the token in the bundle. **Local builds only**, never on a public domain. |

---

## Running

### Local (PM2)

Always run the bot through PM2. It loads `bot/.env` with `--env-file` **before** ES module imports. Running `node bot/index.ts` directly would read an empty config.

```bash
pm2 start ecosystem.config.cts        # bot + dashboard (Vite on :3010)
pm2 logs polymarket-bot               # live bot logs
pm2 logs polymarket-bot --lines 200
pm2 restart polymarket-bot
pm2 stop polymarket-bot               # graceful stop
pm2 status
pm2 monit
```

Open **http://localhost:3010**. For LAN or phone access, set `STATUS_BIND_HOST=0.0.0.0` plus `STATUS_AUTH_TOKEN`, restart with `pm2 restart polymarket-bot --update-env`, and open the dashboard once with `?botStatusToken=<token>`.

Dashboard only, for development:

```bash
npm run dev        # Vite dev server on :3010
npm run build      # production build → dist/
npm run preview
```

### Docker Compose

A four-service stack: frontend (nginx, `:3010`), bot, Postgres, Redis. It uses loopback-only exposure by default and hardened containers.

```bash
cp .env.docker.example .env           # set POSTGRES_PASSWORD, STATUS_AUTH_TOKEN, REPORT_AUTH_TOKEN
docker compose up -d --build
```

Full guide: **[docs/DOCKER_STACK.md](docs/DOCKER_STACK.md)**. On Windows, `scripts/install-watchdog.ps1` schedules `scripts/stack-watchdog.ps1` every 10 minutes. The watchdog restarts a container that is "Up" but has stopped polling, and escalates to a Docker Desktop restart if that does not help.

### Railway (cloud)

Production runs on Railway as four services: `bot` (private network, volume at `/app/bot/data`), `frontend` (public, nginx proxying `/ws` and `/api/reports` to the bot), and the `Postgres` and `Redis` plugins. The bot's `/health` endpoint is the Railway healthcheck.

Runbook, variables and CLI gotchas: **[docs/RAILWAY.md](docs/RAILWAY.md)**.

### Going live

Only after the dry-run evidence supports it (see [Project status](#project-status)):

```env
DRY_RUN=false
MAX_BET_AMOUNT_USD=1.00        # start at mini size
```

```bash
pm2 restart polymarket-bot --update-env
```

---

## Dry run and evaluation

`DRY_RUN=true` runs the full decision path without ever initializing the CLOB client:

- **Simulated fills are priced like live orders.** The fill is charged at `fokBuyPrice(quote, spread)`, the same limit the live path submits, not at the quote. An order larger than the resting `askLiquidity` is rejected like a real FOK.
- **Full lifecycle.** Positions go through settlement, cut-loss and the journal exactly as in live trading. Rows carry `entry.dryRun: true` and never reach the Postgres mirror.
- **Comparable rows.** Rows carry `entry.fillModel: 'fok_limit'`, `expectedPrice` (the quote) and `actualPrice` (the fill). Older rows without `fillModel` were booked at the quote, which is the optimistic bound.

### Reports

```bash
npm run report:dryrun                  # last 24h (rolling)
npm run report:dryrun:all              # whole journal
npm run report:dryrun:railway          # pull the Railway volume's journal, last 7 days

# Evidence: ALWAYS pin the window. Rolling windows silently rescore as time passes.
node bot/scripts/dryRunReport.mts --since 2026-09-21T08:27:00Z [--until <t>] [--json]
```

Each report also prints **ML vs market** for the dry-run and live sets (premarket excluded): the edge the model claimed on the side it bought, the edge that was realised, their ratio, and the model's Brier score against the token price at entry. The ratio is the `KELLY_PROB_SHRINK` the results support once there are at least 100 rows. On the pipeline-v1 model's 438 Railway trades: claimed +24.0pp, realised +4.3pp, ratio 0.18, and the price predicted better than the model (skill −19%).

Rolling windows mislead. On 2026-09-20 the same unchanged journal read 85.7% WR over `--days 1` and 66.1% over `--days 14`. The evaluation window also restarts whenever a change alters *which* trades are taken, because rows from either side of such a change are not one sample. `bot/scripts/reportWindow.mts` handles the boundaries.

### Win rate vs breakeven

A win rate is not a verdict. Polymarket's crypto fee is `polyFeeRate(p) = 0.072 · p · (1 − p)` (max 1.80% at p = 0.50), and it is charged on the **winning profit**, not on the stake. Breakeven for an entry price `p` is therefore:

```
breakeven = p / (p + (1 − p)(1 − r))        where r = polyFeeRate(p)
```

It is **not** `p + r`, which overstates breakeven by 1.0–1.3pp across the traded range. That mistake has already nearly justified a filter change for an effect that did not exist. For example, a 63.2¢ entry needs **63.6%** to break even, not 64.9%.

`bot/src/trading/breakevenMargin.ts` does not restate the formula. It **solves** breakeven from `computeSettlementPnl`, the same function that books every trade, so the dashboard cannot drift from the bot's accounting. It reports two views:

- **lifetime**: every resolved row.
- **realistic**: only rows whose entry price reflects a fill a live order would have got (live rows, or dry-run rows marked `fok_limit`). This is the view to judge on. The dashboard marks it "n too small" below 385 trades.

---

## Trading strategies

### 1. Directional (main)

`bot/src/engines/orderRouter.ts` is a LIMIT-first decision tree. Roughly:

| ML confidence | Ask ≤ 52¢ | Ask 52–58¢ | Ask > 58¢ |
|---------------|-----------|------------|-----------|
| < 65% | WAIT | WAIT | WAIT |
| 65–87% | FOK | mostly LIMIT (FOK on tight spread / trend / momentum with ML ≥ 80%) | LIMIT / WAIT |
| ≥ 88% | FOK | FOK | LIMIT / WAIT |

Entries below the price floor wait. After the limit window has passed, the router can only choose FOK.

### 2. Limit orders (`LIMIT_ORDER_ENABLED`)

Passive GTD orders below the market (max entry `LIMIT_MAX_ENTRY_PRICE`, default 58¢). The lifecycle is IDLE → PLACED → MONITORING → FILLED/CANCELLED. Anti-loop protection allows at most 2 attempts per market slug and enforces a 60 s cooldown after a cancel.

### 3. Arbitrage

The trade pipeline checks arbitrage before the directional path. With a live CLOB book, sub-1% arbs are no longer suppressed.

### 4. Recovery buy (`RECOVERY_BUY_ENABLED`)

Re-entry after a cut-loss, run as a state machine: IDLE → SAMPLING → MONITORING → BUY. It requires the ML to still agree and uses a reduced size (anti-revenge sizing).

### 5. Pre-market long (**disabled**)

An unconditional UP entry from 09:00 to 09:15 ET on weekdays, at 8× the normal stake. It was disabled on 2026-09-20 after 10 dry-run trades at 30% WR (−19.88) consumed nearly the whole book's profit. It does not go through the session gate, so disable it with `PREMARKET_LONG_ENABLED`, not with `BLOCKED_SESSIONS`.

### Edge engine

Phase-based thresholds that adapt to the regime (`src/engines/edge.ts`):

| Phase | Time left | Min edge | Min prob | Min agreement |
|-------|-----------|----------|----------|---------------|
| EARLY | > 10 min | 6% | 60% | 3 |
| MID | 5–10 min | 7% | 58% | 3 |
| LATE | 2–5 min | 7% | 57% | 2 |
| VERY_LATE | < 2 min | 7% | 56% | 2 |

A trending regime relaxes these thresholds by up to 2%. A choppy regime tightens them by 3%. ML ≥ 85% relaxes them even when the rules disagree.

---

## Risk management

### Circuit breakers (`bot/src/safety/guards.ts`)

| Trigger | Default | Action |
|---------|---------|--------|
| Daily loss | `MAX_DAILY_LOSS_PCT=15` | Halt + 4h cooldown |
| Drawdown from peak | `MAX_DRAWDOWN_PCT=25` | Halt + 4h cooldown |
| Consecutive losses | `MAX_CONSECUTIVE_LOSSES=7` | Halt + 4h cooldown |

The daily baseline rolls over from the poll loop (`positionTracker.rolloverDayIfNeeded()`), not only at process start. A bot that stays up for days is therefore judged on *today's* P&L. A halted bot keeps its liveness heartbeat, and the `resetDailyBaseline` RPC exists for operator recovery.

### Cut-loss philosophy

Holding to settlement historically won **87.5%** of the time, against **23.3%** for cut-loss exits, so early selling destroys edge. The 13-gate evaluator (`bot/src/trading/cutLoss.ts`) exits only when all of these hold:

- the position has been held at least `CUT_LOSS_MIN_HOLD_SEC` (720 s by default),
- the token has dropped catastrophically (≥ 70% by default: crash, persistent-drop and trailing-stop variants),
- the signal is sustained over consecutive polls, and there is enough bid liquidity to sell into.

A 45-second **sell lock** prevents cut-loss, take-profit and manual sells from racing each other.

### Entry filters (`bot/src/safety/tradeFilters.ts`)

Every entry must pass every gate:

| # | Gate |
|---|------|
| 0 | **Blocked sessions**: hard gate, evaluated before every bypass |
| 1 | ML confidence (+ Asia minimum, 75–80% dead zone, PTB-source quality) |
| 2 | Coin-flip zone, extreme contrarian, entry-price floor, **68¢ entry-price ceiling** |
| 3 | Low volatility |
| 4 | Min/max time remaining, late-phase ML gate, BTC distance from PTB |
| 5 | Cooldown after a loss |
| 6 | Max trades per market + re-entry edge gate |
| 7 | Weekend low liquidity (off unless `TIME_GATES_ENABLED=true`) |
| 8 | Edge ceiling |
| 9 | Counter-trend momentum |
| 10 | Hour-of-day blackout (ET hours 16–23, `BLACKOUT_HOURS_ET` in `src/config.ts`; off unless `TIME_GATES_ENABLED=true`) |
| 11 | Trending-regime protection |
| 12 | Wide spread |
| 13 | ML rolling-accuracy degradation |
| 14 | VPIN (informed flow) |
| 15 | Sudden spread widening |
| 16 | Asia session ML floor (off unless `TIME_GATES_ENABLED=true`) |
| 17 | Extreme sentiment |
| 18 | Macro event guard (CPI / FOMC / NFP) |
| 19 | LLM regime advisory (shadow mode by default) |

At startup the bot logs which sessions `BLOCKED_SESSIONS` actually parsed. It also warns about names that match no known session, because a misspelled name blocks nothing. `EU/US Overlap` is a separate session from `Europe` and must be spelled in full.

---

## Settlement and verification

Settlement is **provisional by design**. At expiry the oracle retries start, and the switch to the next market aborts them so that settlement never blocks trading. Most rows are therefore first booked as `price_fallback` (Chainlink spot vs PTB), while Polymarket resolves on a 60-second TWAP.

`bot/src/trading/fallbackVerifier.ts` closes that gap:

- Every `price_fallback` / `unknown` row is re-checked against the real resolution on a backoff starting at **+90 s**. It queries the CLOB by `conditionId`, then Gamma `GET /markets/slug/<slug>`.
- When the result differs, it rewrites the journal row (`exit.verifiedAt`, `exit.correctedFrom`) and corrects wins, losses and consecutive losses. For dry-run rows it corrects the bankroll too; live bankroll stays with the on-chain reconciler.
- A startup sweep retries unverified rows from the last **7 days**. Older rows can never be verified, because the APIs stop answering for markets that old. The sweep reports them as `agedOut` and names them in a warning, so they are no longer skipped silently.

Live trades are additionally reconciled on chain (`journalReconciler.ts` → `verified_journal.jsonl`).

---

## Market data feeds

| Stream | File | Purpose |
|--------|------|---------|
| Polymarket CLOB | `streams/clobWs.ts` | Order book and quotes for the current UP/DOWN tokens |
| Binance | `streams/binanceWs.ts` | BTC spot price |
| Chainlink | `streams/chainlinkWss.ts` | Oracle rounds |
| Polymarket LiveData | `streams/polymarketLiveWs.ts` | Live oracle price |

**CLOB freshness** (`streams/clobFreshness.ts`) separates *link alive* (any frame, PONGs included) from *quotes current* (book / price_change), and returns one of three states:

- `live`: quotes are flowing.
- `quiet`: the link is alive but the book has not moved. After 25 s the bot re-verifies it with a **make-before-break** replacement socket, and the feed never blanks.
- `down`: the book is refused (past 60 s). Only then does the bot fall back to REST.

On the dashboard, `🔄 REST Poll` therefore means something is actually wrong. Replacement retries back off exponentially up to 60 s.

### Market tape (training data, `bot/src/tape/`)

Once a second the bot records the top 10 levels of both tokens' books, together with BTC from the three feeds and its PTB. It also records every trade print. The existing token-price history prints about once a minute, which is why the model's offline skill against the market can only be bounded (−2.1% to +6.8%). No orderbook history exists, so the orderbook features are neutral in training. The tape fills both gaps from now on.

- **Isolated.** It has its own read-only CLOB socket and total entry points, so it cannot change what the bot trades.
- **Crash-safe.** Hourly gzip files (`YYYY-MM-DD/HH-<boot>.jsonl.gz`) are appended one member per minute, so a crash loses at most a minute.
- **Stored in the cloud.** Finished hours are uploaded to an S3-compatible bucket and removed from the volume. **Cloudflare R2** is recommended: 10 GB free, no egress fees. Setup is in [docs/RAILWAY.md](docs/RAILWAY.md#market-tape-second-resolution-training-data).
- **Disk-safe.** Without a bucket, files stay local under `TAPE_MAX_LOCAL_MB`, and writing stops before the volume runs low.
- **`npm run tape:pull`** downloads the tape to `backtest/ml_training/tape/` (gitignored). It prints the coverage per day (live-book seconds, the longest gap, trades and markets) and the decision-trail stage mix.
- **Decision trail (`d` lines).** Once a second the tape also records the bot's own decision:
  - what `decide()` said (side, or why it waited);
  - ML P(UP) and confidence, the ensemble probability, the edge per side and the market prices;
  - which loop precondition held an ENTER;
  - every trade-filter reason, not just the first;
  - whether a trade was entered. Every entry is written, not sampled.

  With the book and the outcome, this lets any entry threshold be replayed on the signals the bot really saw. It is record-only: nothing it does changes a decision.

---

## ML model

### Live model — `20260924-p2-0d88d4` (feature pipeline v2), deployed 2026-09-24

Trained on the fixed pipeline; the id comes from the [model registry](#model-registry-and-journal).

| Metric | Value |
|--------|-------|
| Data | 14,607 markets, 2026-03-28 → 2026-09-23 UTC, 100% real Polymarket labels |
| Accuracy / AUC (test) | 76.9% / 0.854 |
| Calibration ECE | 0.022 (XGBoost), 0.034 (ensemble) |
| Ensemble weights | XGBoost 0.75 · LightGBM 0.25 (selected on OOF CV) |
| Features | 79 (54 base + 25 engineered), Platt scaling on logits |
| **Brier skill vs same-instant market** | **+7.0%** (test, n = 2,176) |
| Skill vs a market given up to 60 s of look-ahead | −2.1% (3,728 unseen rows) |
| Deploy gate | all checks pass; relative checks skipped (pipeline v1 → v2) |

Read the two skill rows together. The lookup records token prices about once a minute, so the offline "price at the instant" can be up to 60 s stale, which flatters the model. Interpolating it reads up to 60 s ahead, which flatters the market. Live prices are fresh, so live skill should land between −2.1% and +7.0%: roughly market-level, not a proven edge. The dry run's **ML vs market** report, split by model, is the measurement that settles it.

**Head to head with the previous model** (recorded as `evaluated` events in the journal):

| Test | Market | New (v2) | Previous (v1) |
|------|--------|----------|---------------|
| 448 Railway dry-run entry instants, fresh prices (Brier) | **0.2166** | 0.2276 | 0.2583 |
| 1,808 markets 2026-09-05 → 09-23, offline (Brier) | 0.1695 (last print) · 0.1532 (+60 s peek) | 0.1588 | 0.1708 |
| Claimed probability on the side bought (actual win rate 67.9%) | — | 71.3% | 87.7% |

The new model beats the previous one in both tests; the 95% CI for the Brier difference is [−0.047, −0.014] live and [−0.018, −0.006] offline. It is also far better calibrated. Neither model beats the market price.

### Previous model — `20260905-p1-3c517d` (feature pipeline v1), retired 2026-09-24

Kept for the record; its artifacts, report and data summary are in `ml_registry/models/20260905-p1-3c517d/`.

| Metric | Value |
|--------|-------|
| Accuracy | 78.3% |
| AUC | 0.8715 |
| Log loss / Brier | 0.4472 / 0.1468 |
| Calibration ECE | 0.0171 |
| Ensemble weights | XGBoost 0.60 · LightGBM 0.40 (selected on OOF CV) |
| Evaluation | 1,903 test + 1,343 strict-holdout samples |
| Training window | 180 days: 12,787 markets, 2026-03-08 → 2026-09-04 UTC |
| Trained / deployed | 2026-09-05 |
| Live dry run (448 trades) | claimed 87.7% on the side bought, won 67.9%; Brier 0.2583 vs price 0.2166 (skill −19%) |

Its offline numbers look better than the new model's because its training rows carried a 60-second look-ahead (see [One feature builder](#one-feature-builder-feature-pipeline-v2)). They are not comparable. Its training CSV was overwritten on 2026-09-24, before the registry existed.

> Earlier headline numbers (84.07% accuracy, 94.12% holdout) predate the embargo and OOF-selection fixes and were measured on a reused holdout. They are **not comparable**.

**Features:** BTC distance from the price to beat, returns and momentum over several horizons, RSI, MACD, VWAP, Bollinger, ATR, Heiken Ashi, EMA cross, StochRSI, volume delta, the rule engine's probability and edge, the Polymarket token price at the instant and its 60 s change, time to settlement, session, and the regime. Order book, spread and funding rate are held neutral in pipeline v2 because no historical source exists for them. Inference in `src/engines/Mlpredictor.ts` is iterative tree traversal over `Float64Array` buffers.

### One feature builder (feature pipeline v2)

Training rows and live predictions are built by **the same code**: `src/engines/ml/featureInputs.ts` (`buildMlFeatureInputs`, a pure function of a snapshot of what is known at one instant). Offline, `trainingRow.ts` builds that snapshot at a 1-minute candle close from Binance candles and the market's recorded token prices. Live, `signalComputation.ts` builds it from the bot's own feeds.

Why it matters: until 2026-09-23 the training generator re-implemented every feature by hand and had drifted from the live code:

- a 60-second BTC look-ahead (candle close used, candle open timestamped);
- a fake price-to-beat (the close 15 candles back instead of the window start);
- market features from the window-open token price, while live passed the current price;
- a different rule engine, indicator parameters and regime logic.

The resulting model reported 78% / AUC 0.87, yet the market price at the same instant predicted better (Brier 0.143 vs 0.147), and in the dry run it claimed 88% while winning 68%.

Rules that keep a row honest: every candle in the row has closed by the instant; the price to beat is the open of the window's first candle from the same Binance feed as the current price; the token price is the last print at or before the instant (no interpolation). Inputs that no offline source has (order book, feedback stats, live signal modifiers, funding rate) are neutral on **both** sides.

The model records `feature_pipeline` in `norm_browser.json`, and the bot builds features the v2 way only for a model that declares it, so code and model always ship as a matching pair.

### Training pipeline (`backtest/ml_training/`)

`trainXGBoost_v3.py` is a thin entrypoint over the unit-tested `mltrain/` package: `features.py`, `cv.py` (embargoed walk-forward CV), `sweeps.py` (threshold, phase-grid and ensemble-weight selection) and `metrics.py` (including `market_skill`, the model's Brier skill against the same-instant market price). `generateTrainingData.mts` writes `training_data.meta.json` next to the CSV; the trainer refuses a sidecar that does not match its CSV.

```bash
cd backtest/ml_training

./runTraining.sh --tune --deploy                                    # full pipeline

# or step by step
node fetchFreshMarkets.mts --days 60 --lookup ./polymarket_lookup.json
node generateTrainingData.mts --days 180 --polymarket-lookup ./polymarket_lookup.json
python trainXGBoost_v3.py --input training_data.csv --tune --tune-trials 150
python backtestPnL.py --threshold-sweep
# deploy: copy xgboost_model.json + lightgbm_model.json + norm_browser.json → public/ml/
```

**Validation hygiene**

- `--cv-embargo` (default 16 rows = 4 h) drops validation rows whose lookbacks overlap the training tail.
- **All** selection sweeps run on out-of-fold predictions.
- The 12.5% strict holdout is used for evaluation only.

**Keep `--days 180`.** A 600-day window diluted real Polymarket labels to 32% and failed. `RETRAIN_DAYS` must stay 180.

### Retraining and deploy gates

Retraining is **manual**. The PM2 `ml-retrain` process is commented out in `ecosystem.config.cts`.

```bash
npm run ml:retrain:dry     # full run, no deploy
npm run ml:retrain         # retrain + deploy if every gate passes
npm run ml:audit           # quality audit of the deployed models
```

The gate lives in `bot/src/retrainGate.ts` (pure and unit-tested) and **fails closed** on:

- accuracy and AUC floors;
- **market skill**: the ensemble must predict the resolution better than the Polymarket price at the same instant (`brier_skill_vs_market` > `RETRAIN_MIN_MARKET_SKILL`, default 0);
- high-confidence accuracy and coverage, ECE, the CV-test gap, the test-holdout gap and the strict-holdout flag;
- relative accuracy/AUC drops against the deployed model. These are skipped, with the reason logged, across a feature-pipeline change, because the old numbers were measured on rows with the look-ahead.

`tests/test_model_contract.py` reads the gate field names out of `retrainGate.ts` and asserts the trainer exports every one of them, so renaming a metric in Python fails a test instead of silently removing a gate. With `RETRAIN_REQUIRE_FRESH_DATA=true`, a retrain also fails closed when fresh Polymarket data cannot be fetched.

### Model registry and journal

Every trained model is kept, with its data, and everything that happens to it is logged, so models can be compared at any time. It lives in `ml_registry/` (tracked in git).

| Path | What |
|------|------|
| `ml_registry/journal.jsonl` | Append-only events: `registered`, `gate`, `evaluated`, `deployed`, `retired`, `rolled_back`, `note` |
| `ml_registry/MODELS.md` | Table of every model plus the journal, generated from the above (do not edit) |
| `ml_registry/models/<id>/` | Gzipped `xgboost_model` / `lightgbm_model` / `norm_browser` JSON, `manifest.json` (hashes, metrics, data range), and the training CSV, meta and report |

- **Ids** look like `20260924-p2-0d88d4`: date, feature pipeline and the first six hex digits of the XGBoost file's hash.
- **Trades name their model.** The registry copy of `norm_browser.json` carries `model_id`. The bot logs it at startup and stamps every trade with `entry.modelId`, so `npm run report:dryrun*` can split win rate, P&L and "ML vs market" per model.
- **Retraining records itself.** `autoRetrain` registers every trained model, even one that fails the gate, and journals the gate result, the deploy and any rollback. It fails closed if the model cannot be recorded.
- **History is backfilled.** All 17 models ever deployed through git are in the registry with their real deploy dates. The February–April ones are kept as `ref: git <commit>` to keep the repo small. Four experiments that only existed as local `.bak` files are stored in full as `archived`.

```bash
npm run ml:registry -- list                        # every model, status, metrics
npm run ml:registry -- deploy <id> --note "why"    # into public/ml (backs up what it replaces)
npm run ml:registry -- evaluate --ids <a>,<b> --file result.json --note "what was compared"
npm run ml:registry -- note <id> "free text"
npm run ml:registry -- register --dir <modelDir> --csv training_data.csv --meta training_data.meta.json --report training_report.txt
```

After a deploy, commit `public/ml` and `ml_registry/` together, then run `railway up --service bot --ci`.

---

## Monitoring, alerts and APIs

### Telegram / Discord

1. Create a bot with [@BotFather](https://t.me/botfather) (`/newbot`).
2. Get your `chat_id` from `https://api.telegram.org/bot<TOKEN>/getUpdates`.
3. Set `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` and `TELEGRAM_NOTIFY_TRADES=true`. `DISCORD_WEBHOOK_URL` is optional.

| Event | Severity |
|-------|----------|
| Trade placed, limit filled/cancelled, settlement, daily P&L | Info |
| Cut-loss triggered, concept drift | Warning |
| Circuit-breaker halt, liveness exit | Critical |

Alerts are rate-limited. Every Telegram message carries inline buttons:

```
┌──────────────────────┐
│   🔗 View Market     │   ← when the alert concerns a market
├──────────────────────┤
│   📊 View Profile    │   ← wallet on polymarketscan
├──────────────────────┤
│   🌐 View Web        │   ← the dashboard (DASHBOARD_URL)
└──────────────────────┘
```

The View Web link never includes the status token. The first time you open the dashboard in a browser (including Telegram's in-app browser), log in once with `?botStatusToken=<token>`.

### Status WebSocket (`:3099`)

The server broadcasts the full state every poll and accepts operator RPCs (all require the status token when one is set):

`botPause` · `botResume` · `setBankroll` · `resetDailyBaseline` · `resetProfitTarget` · `getPositions` · `sellPosition` · `forceSettle` · `forceSync` · `scanTraders` · `getTrackedTraders` · `getDiscoveredTraders` · `addTracker` · `removeTracker` · `simulateTrader` · `analyzeNow` · `optimizeNow`

### Report API (`:3101`)

| Route | Auth | Returns |
|-------|------|---------|
| `GET /health` | none | Liveness, used as the Railway healthcheck |
| `GET /reports`, `GET /reports/summary` | `Authorization: Bearer <REPORT_AUTH_TOKEN>` or `?token=` | Journal reports (`?days=30&limit=50`) |

### Health data

| File (`bot/data/`) | Purpose |
|--------------------|---------|
| `state.json` | Bankroll, positions, counters (rewritten each poll) |
| `state_audit.jsonl` | Append-only bankroll audit trail (1 MB rotation) |
| `trade_journal.jsonl` | Every trade with full signal context |
| `verified_journal.jsonl` | On-chain verified trades |
| `ptb_health.jsonl` | 1-minute rollups of PTB source mix; also the liveness heartbeat |
| `feedback.json` | Rolling accuracy per regime |
| `watchdog_state.json` | Last restart performed by the stack watchdog |

Postgres helpers: `npm run pg:backfill`, `npm run pg:report`.

---

## Testing and CI

```bash
npm run typecheck      # frontend + bot + bot core + scripts
npm test               # vitest: src/**/__tests__, bot/**/__tests__, bot/tests
npm run test:watch
npm run test:ml        # pytest for backtest/ml_training
npm run test:ml:cov    # with coverage
```

GitHub Actions (`.github/workflows/ci.yml`) runs on every push to `main` and on every PR:

- **TypeScript job** (Node 25): `npm ci` → `npm ci --prefix bot` → `typecheck` → `test` → `build`. The bot is a separate package, so both installs are required.
- **ML job**: `ruff` → `black --check` → `pytest` with `--cov-fail-under=90` for `mltrain`

---

## Project structure

```
.
├── src/                              # React 19 dashboard
│   ├── App.tsx                       # Root; per-panel useMemo slices
│   ├── components/                   # 14 panels (see Dashboard)
│   ├── engines/                      # Mlpredictor, edge, regime, probability, feedback, ...
│   ├── indicators/                   # RSI, MACD, VWAP, Bollinger, ATR, Heiken Ashi, ...
│   ├── hooks/                        # useBotData, serverClock, useCountdown, useClock, ...
│   └── config.ts                     # Frontend tunables + polyFeeRate()
│
├── bot/                              # Node.js trading bot
│   ├── index.ts                      # Entry: polyfills, CLOB client, models, streams, servers
│   ├── scripts/                      # dryRunReport, reportWindow, botLiveness, pg + audit tools
│   ├── data/                         # Runtime state + journals (gitignored)
│   └── src/
│       ├── loop.ts                   # Main poll orchestrator
│       ├── config.ts                 # BOT_CONFIG (bounded env parsing)
│       ├── statusServer.ts           # WS :3099: state broadcast + operator RPC
│       ├── autoRetrain.ts            # Retrain orchestrator with fail-closed gates
│       ├── services/reportServer.ts  # HTTP :3101: /health, /reports
│       ├── streams/                  # clobWs, clobFreshness, binanceWs, chainlinkWss, polymarketLiveWs
│       ├── engines/                  # signalComputation, tradePipeline, orderRouter,
│       │                             # limitOrderManager, settlement, settlementMath,
│       │                             # marketResolution, monteCarlo, arbitrage, ...
│       ├── trading/                  # positionTracker, clobClient, cutLoss, takeProfit,
│       │                             # recoveryBuy, fallbackVerifier, breakevenMargin,
│       │                             # journalAnalytics, journalReconciler, ...
│       ├── safety/                   # tradeFilters, guards, dailyProfitTarget
│       └── monitoring/               # notifier, perfMonitor, driftDetector, liveness,
│                                     # ptbHealth, macroCalendar, rollbackMonitor
│
├── public/ml/                        # Deployed models: xgboost, lightgbm, norm_browser.json
├── backtest/ml_training/             # Training pipeline + mltrain/ package + pytest suite
├── docker/                           # nginx template, Postgres init schema
├── docs/                             # DOCKER_STACK.md, RAILWAY.md, audits, specs
├── scripts/                          # Windows stack watchdog (PowerShell)
├── docker-compose.yml
├── Dockerfile.bot / Dockerfile.frontend
├── railway.json
├── ecosystem.config.cts              # PM2: bot + dashboard
├── vite.config.ts                    # Dev server (:3010) + CORS proxies
└── vitest.config.ts
```

The Vite dev server proxies `/gamma-api`, `/clob-api`, `/binance-api`, `/fapi-api` and `/bybit-api` to the upstream APIs to avoid CORS.

---

## Troubleshooting

**Bot won't start.** Check the startup errors with `pm2 logs polymarket-bot --lines 50`:

| Error | Fix |
|-------|-----|
| `POLYMARKET_PRIVATE_KEY not set` | `bot/.env` is missing or has no key (live mode) |
| `Cannot find module ...` | `cd bot && npm install` |
| `ML model not loaded — running rule-based only` | `public/ml/*.json` is missing or unreadable |
| Config values look ignored | You started with plain `node`. Use PM2 so `--env-file` loads first. |

**Dashboard says "Bot disconnected".**
- `pm2 status`: both `polymarket-bot` and `frontend` must be online.
- Port 3099 must be reachable. Off-localhost access needs `STATUS_BIND_HOST=0.0.0.0` + `STATUS_AUTH_TOKEN`, then open the dashboard with `?botStatusToken=`.
- If `frontend` shows `errored`, run `pm2 delete frontend && pm2 start ecosystem.config.cts --only frontend`.

**Countdowns stuck at 0 or ages in the thousands of seconds.** The host clock has probably drifted. Compare it with an HTTP `Date` header. The dashboard renders on the bot's clock, but a wrong *bot host* clock still matters.

**A session you blocked is still trading.** Read the startup log line `BLOCKED_SESSIONS active: [...]`. If the line is missing, the variable is not reaching the process. If it warns about unknown names, fix the spelling.

**Circuit breaker triggered or bankroll mismatch.**

```bash
pm2 stop polymarket-bot
# edit bot/data/state.json: bankroll, peakBankroll, startOfDayBankroll = real USDC.e balance
pm2 restart polymarket-bot
```

To reset only the daily baseline, send the `resetDailyBaseline` RPC instead.

**Polymarket domains don't resolve.** Some ISPs black-hole them. Set `POLYMARKET_DOH_ENABLED=true`. The training fetcher supports `--dns-mode auto`.

**Funding rate is always neutral.** Binance FAPI and Bybit are blocked in some regions. This is harmless.

---

## Changelog

| Date | Change |
|------|--------|
| 2026-09-25 | **Every hour and session trades**: ET blackout hours, the weekend floor and the Asia ML floors are behind `TIME_GATES_ENABLED` (default off), and Europe is unblocked. |
| 2026-09-25 | Entry-filter thresholds move to `bot/src/safety/filterThresholds.ts`, overridable as `FILTER_*` (golden test: no decision changed). Daily Telegram **evaluation report** (`EVAL_WINDOW_START`). Dashboard **Market Tape** panel. Decision-trail study (`decisionTrailStudy.mts`) and v2+v3 hybrid backtest (no gain). The RL bet-sizing agent is deleted. |
| 2026-09-24 | **Market tape**: 1 Hz book, trades and BTC feeds, uploaded hourly to Cloudflare R2 (`bot/src/tape/`, `npm run tape:pull`). |
| 2026-09-24 | **New model live**: `20260924-p2-0d88d4` (pipeline v2) replaces `20260905-p1-3c517d`. **Model registry and journal** added: every model, its data and every gate/evaluation/deploy is kept in `ml_registry/`, and trades record which model made them. |
| 2026-09-24 | **ML fix**: training and live features now come from one builder (feature pipeline v2). This removes the 60 s look-ahead, the fake price-to-beat and the window-open market price. New deploy gate: the model must beat the same-instant market price. Kelly sizes on a probability shrunk toward the price (`KELLY_PROB_SHRINK`). The dry-run report shows claimed vs realised edge. Drift detection only counts trades made by the deployed model. A pipeline-v2 model is trained and passes the gate. |
| 2026-09-23 | Telegram alerts gain a **🌐 View Web** button (below View Market and View Profile) that opens the dashboard. Configurable with `DASHBOARD_URL`. |
| 2026-09-23 | CI installs the bot package too (the TypeScript job had failed on every push without it) and runs on Node 25. MIT `LICENSE` file added. |
| 2026-09-23 | **Breakeven margin**: `breakevenMargin.ts` solves breakeven from the settlement math, and the dashboard shows margin vs breakeven (lifetime + realistic fills). The fallback sweep reports rows past its 7-day window as `agedOut`. An out-of-range `DRY_RUN_HARD_ENTRY_CAP` is refused and logged. `BLOCKED_SESSIONS` logs what it parsed and warns on unknown names. |
| 2026-09-21 | **CLOB freshness**: a quiet book is no longer treated as stale, and make-before-break socket replacement keeps the feed up through rollovers. |
| 2026-09-20 | Dry-run fills are charged at the live FOK limit (`fillModel: 'fok_limit'`), and reports can pin their window with `--since` / `--until`. |
| 2026-09-20 | The daily-loss baseline rolls over from the poll loop. `BLOCKED_SESSIONS` hard gate added. Pre-market long and the RL agent disabled. |
| 2026-09-09 | Dashboard durations use the bot's clock (`serverClock.ts`), and SessionInfo shows clock skew. |
| 2026-09-08 | `price_fallback` settlements verified against Polymarket's resolution. A halted bot keeps its heartbeat. Telegram alert before a liveness exit. |
| 2026-09-07 | Railway deployment. Dry run produces evidence (simulated fills, journaled dry rows, blind-bot detection). |
| 2026-09-02 – 09-05 | Retrained ensemble with embargoed CV and OOF-selected thresholds/weights. `mltrain/` package + pytest suite. Lint/format/CI. Stack watchdog. PTB source health. |

The full history is in `git log`.

---

## Contributing

Pull requests are welcome. For larger changes, open an issue first.

- **TypeScript-first.** Sources are `.ts` / `.tsx` / `.mts` / `.cts`. Run `npm run typecheck` and `npm test` before submitting.
- Use bounded env parsing (`envNum` / `envInt`), never a raw `parseInt(process.env.X)`.
- Don't compute durations with raw `Date.now()` against a bot timestamp. Use `serverNow()`.
- Any number that argues for a strategy change must be scored on a pinned window, against the correct breakeven.
- Test with `DRY_RUN=true`.
- Use conventional commits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`).

---

## Disclaimer

This software is for **educational and personal use only**. Trading prediction markets involves significant financial risk, including the loss of your entire stake. Backtests, dry-run results and past performance do not guarantee future results. The authors are not responsible for any financial losses. Check that prediction-market trading is legal where you live. **Trade at your own risk.**

---

## License

Released under the [MIT License](LICENSE).
