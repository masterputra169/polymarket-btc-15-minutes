# Polymarket BTC 15-Minute Trading Bot

<p align="center"><img src="analysis/2026-10-21/brand/poly15-logo.png" width="128" alt="POLY//15 mark"></p>

[![CI](https://github.com/masterputra169/polymarket-btc-15-minutes/actions/workflows/ci.yml/badge.svg)](https://github.com/masterputra169/polymarket-btc-15-minutes/actions/workflows/ci.yml)

> An automated trading bot for Polymarket's **"Bitcoin Up or Down — 15 minute"** binary markets, plus a real-time React dashboard and static research portal (`study-dist/`).
> It runs a zero-await `3–4 ms` TypeScript loop at 20 Hz (`50 ms` poll), combining a 67-feature XGBoost + LightGBM ensemble (`20261116-p2-ef8dfd`), a Chainlink-native residual overlay (`v4-hybrid-20261116`), 20+ microstructure/macro entry filters (`gates 0–21`), maker-first `postOnly` routing, unified-CTF FIFO dry-run simulation and settlement-first risk management.

**Stack:** TypeScript end to end · React 19 + Vite 7 (dashboard + Study Site) · Node.js 25 bot (`3–4 ms/poll` @ 20 Hz, systemd/PM2/Docker) · 6 WebSocket feeds (Binance `bookTicker`+`kline_1m`, Coinbase `BTC-USD`, CLOB market & `ws/user`, PolyBolt 60s TWAP & spot, Chainlink WSS) · PostgreSQL 18 + Redis (optional mirror/cache) · XGBoost + LightGBM (Python training, in-process TypeScript inference) · Polymarket CLOB V2 (`postOnly`)

> [!WARNING]
> This bot places real orders with real money once `DRY_RUN=false`. **Always start in dry run**, and read [Project status](#project-status) before you go live. A win rate on its own does not tell you whether the bot makes money. See [Win rate vs breakeven](#win-rate-vs-breakeven).

---

## Table of Contents

- [What is this?](#what-is-this)
- [Latest update (2026-11-19)](#latest-update-2026-11-19)
- [Project status](#project-status)
- [Key features](#key-features)
- [Architecture](#architecture)
- [Dashboard](#dashboard)
- [JEV decision layer (TypeSafe System One)](#jev-decision-layer-typesafe-system-one)
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

## Latest update (2026-11-19)

> Current operational state at commit `fccf2be` (`2026-11-19`). The September project-status table below is kept as the historical baseline; this section supersedes it.
>
> **Living update log:** [UPDATES.md](UPDATES.md) — date-stamped changes, verification and operations.  
> **Archived snapshot:** [docs/updates/2026-10-21.md](docs/updates/2026-10-21.md).

### Where it runs now

- **VPS:** Tencent Cloud CVM (`ap-jakarta-1`), Ubuntu 26.04, Node 25.9, systemd unit `polybtc15-bot.service` (`DRY_RUN=true`, `DRY_RUN_QUEUE_SIM=true`, `CUT_LOSS_ENABLED=false`, `MemoryMax=1200M`).
- **Auto-deploy:** `poly15-auto-deploy.service` polls GitHub `main`, waits for green CI, builds `dist/` & `study-dist/`, blocks deployment if a position is currently open, and restarts with rollback safety. See [docs/AUTO_DEPLOY.md](docs/AUTO_DEPLOY.md).
- **Dashboard & Study Site:** nginx on `127.0.0.1:8080`, exposed through a **named Cloudflare Tunnel** at **https://poly15.dollarkilat.xyz/**. A custom Motion login page issues a session cookie; nginx `auth_request` protects `/ws` and report APIs. Setup: [docs/DOMAIN.md](docs/DOMAIN.md).
- **Database:** Local PostgreSQL 18 mirrors live journal records; Redis is optional.

### Highlights since the October baseline

| Area | Change |
|------|--------|
| Ultra-low-latency loop | Eliminated per-poll REST `fetchKlines('1m')` / `fetchKlines('5m')` blocking (`~93 ms` → **`3–4 ms/poll`** at exact `50 ms` / 20 Hz cadence) via combined Binance `btcusdt@bookTicker/btcusdt@kline_1m` WS + 240-bar RAM ring buffer + RAM `aggregate5m()`. Background single-flight refreshes for 30s Polymarket discovery (`polyRefreshGen`-guarded) & Chainlink RPC, plus wall-clock `9.0 s` anti-whipsaw confirmation (`signalStability.ts`). |
| Live CLOB V2 & Execution safety | `postOnly: true` enforcement on GTD limit orders (`LIMIT_POST_ONLY`), authenticated Polymarket User WebSocket (`clobUserWs.ts` on `ws/user`, dormant in dry run), `2c` runaway ask haircut (`EXECUTION_MAX_RUNAWAY`), `+5%` fill-size clip guard (`isFillSizeWithinClip`), `GhostGuard` on-chain tx receipt verification, CLOB outage latch, metadata warmup & heartbeat, one-shot limit attempts (`LIMIT_MAX_ATTEMPTS_PER_MARKET=1`), and calibrated TWAP adverse pull (`-15pp` early / `-5pp` late). |
| Multi-venue nowcast & telemetry | Public Coinbase `BTC-USD` WebSocket (`coinbaseWs.ts`) blended 50/50 with Binance USDT inside `ChainlinkNowcastTracker`, `[b-62s, b-2s)` TWAP strike window offset, `1.4×` fat-tail fair value + Deribit DVOL blend + closed-form `studentTCdf` (`pStudentT` telemetry, benchmarked on 377 tape windows), post-fill `+5s/+15s/+30s/+60s` markout & EWMA toxicity (`markoutTracker.ts` → `analysis.markout`), unified-CTF FIFO queue simulator (`DRY_RUN_QUEUE_SIM=true`), edge-death auto-tripwire, and IPv4-first retry Telegram/Discord notifier. |
| ML v4 Hybrid & Model Profiles | Live model upgraded to **`20261116-p2-ef8dfd`** (34,962 markets, 67 TreeSHAP-pruned features, `+6.4%` Brier skill vs market, 4-phase power calibration) paired with **`v4-hybrid-20261116`** Chainlink-native residual overlay, hot model switcher + per-model profile overrides (`bot/data/model_profiles.json`), and static Study Site (`npm run study:build`). |
| JEV v3 shadow | Upgraded to `2026-11-17-laplace10-lerp` (10-bin Laplace+PAVA+`lerp` calibration, Bayesian prior anchoring, Composite Risk Desk, Brier skill guard). Across `n = 2,868` resolved markets, calibrated JEV Brier (`0.2404`) still trails market odds (`0.2358`), so `JEV_MODE` remains `shadow`. |
| Security & ops hardening | Model ID allowlist + `.gz` SHA-256 verification before decompression, `http(s)` URL scheme guard on RSS feeds, x402 `$0.05` atomic payment cap, `extra` secret redaction in `logger.ts`, bounded auth-gateway maps, and 5s/10s hot-path log throttling. |

### Verification

- `npm run typecheck` (frontend, bot, bot:core, scripts) **PASS**.
- GitHub Actions CI run [`44445042190`](https://github.com/masterputra169/polymarket-btc-15-minutes/actions/runs/44445042190) (Node 25 Ubuntu): **122 test files / 1,122 tests PASS**; ML pipeline (`ruff`, `black --check`, `pytest --cov-fail-under=90`) **PASS**.
- `npm run build` & `npm run study:build` **PASS** (`493` modules, `8` models, `49` studies).
- Live `polyvps` telemetry (`fccf2be`): `polybtc15-bot.service` active, `0` errors/warnings, all streams connected (`BinanceWS` combined, `CoinbaseWS`, `ClobWS`, `PolyLiveWS`, `ChainlinkWSS`), hot loop **`3–4 ms/poll`** at exact **`50 ms` cadence (20 Hz)**, RAM `~357 MB` inside `MemoryMax=1200M`.

### Reports from recent passes

- [Dashboard v4 report + preview](analysis/2026-10-19/dashboard-v4-redesign.md)
- [JEV independent v2 + calibration study](analysis/2026-10-19/jev-independent-v2-calibration-study.md)
- [Entry-time decision shadow](analysis/2026-10-19/jev-entry-time-decision-shadow.md)
- [Fixed-policy forward shadow](analysis/2026-10-19/jev-fixed-policy-forward-shadow.md)

---

## What is this?

Every 15 minutes Polymarket opens a binary market: **"Will BTC be higher at the end of this 15-minute window than at the start?"** Settlement compares Chainlink's 60-second TWAP at window close against the window-start 60-second TWAP (*Price to Beat*, PTB). Winning UP or DOWN shares redeem for `$1.00`.

The bot automates that loop 24/7 at 20 Hz (`3–4 ms` per poll in steady state):

1. Streams real-time BTC quotes (`BinanceWS` `bookTicker`+`kline_1m`, `CoinbaseWS` `BTC-USD`), Polymarket CLOB depth (`ClobWS` + authenticated `ClobUserWS`), PolyBolt 60s TWAP & spot, and Polygon Chainlink WSS.
2. Computes technical indicators, the 67-feature ML ensemble + Chainlink-native v4 Hybrid overlay, and market regime in RAM with zero hot-loop REST blocking.
3. Compares model probability against live CLOB ask/bid prices and runs entry gates `0–21` plus wall-clock `9.0 s` stability confirmation.
4. Routes passive `postOnly` GTD limit orders first (joining `bestBid` with TWAP adverse-selection pulls) or selective FOK taker orders with a `2¢` runaway check.
5. Holds to expiry by default (`CUT_LOSS_ENABLED=false`), tracks post-fill `+5s/+15s/+30s/+60s` markout toxicity, verifies `price_fallback` settlements against Polymarket's real outcome, and journals everything.

---

## Project status

*Historical baseline + current VPS target ([Latest update](#latest-update-2026-11-19)).*

| Area | State |
|------|-------|
| Deployment | **Tencent Cloud CVM (`ap-jakarta-1`)** via CI-gated `poly15-auto-deploy.service` + nginx + Cloudflare Tunnel. Local PM2 and Docker Compose stacks remain supported. |
| Mode | **`DRY_RUN=true` + `DRY_RUN_QUEUE_SIM=true`**. Paper maker bids rest on live CLOB trade prints (`queueSim.ts`) and FOK orders price against live L2 liquidity (`fok_limit`). |
| Go-live gate | Positive margin over CLOB V2 breakeven (`p + 0.07·p·(1−p)`) across `100–150+` clean queue-sim trades + `analysis.markout` audit, followed by micro-live sizing (`$1–$5/trade`). |
| Exit policy | **`CUT_LOSS_ENABLED=false`** and **`TAKE_PROFIT_ENABLED=false`**: empirical Hold-to-Expiry outperforms early crossing exits under spread + taker fees. Pre-market long & RL bandit are removed/disabled. |
| Trading hours | **Every hour and session trades** (or filtered per runtime `.env`, e.g., optional `BLOCKED_SESSIONS` / `TIME_GATES_ENABLED`). |

---

## Key features

- **Zero-await 20 Hz hot loop (`3–4 ms/poll`)**: Binance combined `bookTicker`+`kline_1m` WS updates a 240-candle ring buffer in memory and derives 5m candles via `aggregate5m()` in RAM; periodic 30s Polymarket discovery and Chainlink RPC run asynchronously in single-flight background tasks.
- **ML ensemble + v4 Hybrid overlay**: XGBoost + LightGBM (`20261116-p2-ef8dfd`, 67 TreeSHAP-pruned features, 4-phase calibration) + Chainlink-native `v4-hybrid-20261116` residual overlay running iteratively in TypeScript, plus live model switching and per-model threshold profiles (`modelProfiles.ts`).
- **Execution safety (CLOB V2 + `ws/user`)**: `postOnly: true` GTD enforcement, real-time fill/cancel notifications over `clobUserWs.ts`, `2c` pre-submit runaway ask guard (`isAskRunaway`), `+5%` fill-size sanity clip (`isFillSizeWithinClip`), `GhostGuard` on-chain tx verification, and `clobOutageLatch`.
- **Anti-adverse-selection maker engine**: Joins `bestBid` cleanly (`makerJoinPrice`), pulls resting quotes immediately on 50/50 Coinbase+Binance Chainlink nowcast reversals (`shouldCancelTwapAdverse`), and logs post-fill `+5s/+15s/+30s/+60s` markout & EWMA toxicity (`markoutTracker.ts`).
- **Entry filter stack (`gates 0–21`)**: Covers session blocks, ML floors, PTB distance, 15s spread/VPIN/path-efficiency/peak-gap microstructure guards, L2 orderbook imbalance, 300s R4 taker ratio, 3s Binance lead-lag impulse, cross-feed Binance/Oracle skew, TWAP `z` lead, macro calendar, sentiment and JEV shadow/advisory.
- **Honest simulation (`DRY_RUN_QUEUE_SIM=true`)**: Unified-CTF FIFO queue simulator consumes real CLOB same-token sells and complementary opposite-token buys (`seq`-deduplicated) rather than synthetic hash draws.
- **JEV v3 shadow layer**: 10-bin Laplace + PAVA + `lerp` calibration, Bayesian prior anchoring, Composite Risk Desk, and automatic Brier skill guard (strictly shadow until OOS Brier beats market).
- **Dashboard v4 & Study Site**: 16 draggable/resizable `React.memo` panels over authenticated WebSocket `:3099`, server-clock sync, breakeven-margin analytics, market tape panel, plus static Study Site (`study-dist/`).
- **Ops & safety tooling**: IPv4-first Telegram/Discord alerts with inline buttons, `evaluationReport.ts` edge-death auto-tripwire, Postgres journal mirror, market tape 1 Hz gzip + R2 upload, and liveness watchdogs.

---

## Architecture

Two systems connected by a WebSocket: a **Node.js trading bot** (`bot/`) and a **React dashboard** (`src/`).

```
                 ┌───────────────────────── Bot (Node.js 25, 3-4ms @ 20Hz) ─────────────────────────┐
Binance Combined ┤ (bookTicker + kline_1m → 240×1m RAM buffer → RAM aggregate5m)                    │
Coinbase BTC-USD ┤→ Multi-venue ChainlinkNowcastTracker (50/50 USD+USDT) & TWAP physics (+Student-t)│
PolyBolt TWAP/Spt┤→ signalComputation: 10 TA · ML v4 Hybrid · regime · 3s lead-lag · 300s R4 taker  │
Polymarket CLOB  ┤→ clobFreshness (live/quiet/down) → clobUserWs (ws/user live fill/cancel push)    │
Chainlink WSS ───┘                                                                                  │
                 │        ▼                                                                         │
                 │  signalStability (9.0s wall-clock) → tradeFilters (gates 0–21) → decide()        │
                 │        │                                                                         │
                 │        ▼                                                                         │
                 │  orderRouter (LIMIT postOnly / FOK w/ 2c runaway guard / WAIT) → tradePipeline   │
                 │        │                                       │                                 │
                 │        ▼                                       ▼                                 │
                 │  CLOB V2 API + GhostGuard (live)      queueSim / fok_limit (DRY_RUN)             │
                 │        │                                       │                                 │
                 │        └───────────────┬───────────────────────┘                                 │
                 │                        ▼                                                         │
                 │  positionTracker → markoutTracker (+5..60s) → settlement → fallbackVerifier      │
                 │        │                                                                         │
                 │        ├─→ trade_journal.jsonl ─→ Postgres mirror (live rows)                    │
                 │        ├─→ bot/data/tape/      ─→ 1Hz book/trades/decisions + R2 upload          │
                 │        ├─→ statusServer  WS :3099 (state + markout + operator RPC)               │
                 │        └─→ reportServer HTTP :3101 (/health, /reports)                           │
                 └──────────────────────────────────────────────────────────────────────────────────┘
                                    │ WebSocket
                                    ▼
                 ┌──────────── Dashboard (React 19 + Vite 7) ──────────────┐
                 │ useBotData ← snapshot every poll → 16 widget panels     │
                 │ drag/drop · resize · presets · localStorage layout      │
                 └─────────────────────────────────────────────────────────┘
```

JEV v3 runs on a **parallel shadow branch**: it reads the same snapshot and writes separate policy/decision logs (`jev_log.jsonl`, `jev_decision.jsonl`, `jev_policy.jsonl`) without blocking or sizing orders.

**Each poll** (`POLL_INTERVAL_MS=50` in production, `~3–4 ms` execution in steady state):

1. Reads in-memory Binance 1m/5m candles, Binance+Coinbase quotes, CLOB orderbook, and Chainlink TWAP/spot streams (zero REST wait unless cold boot or market expiry).
2. Evaluates CLOB freshness, runs technical indicators, `20261116-p2-ef8dfd` + `v4-hybrid-20261116` inference, regime detection, arbitrage check, and TWAP physics (`twapPhysics.ts`).
3. Evaluates phase-based edge and wall-clock `9.0 s` anti-whipsaw confirmation (`signalStability.ts`).
4. Runs `applyTradeFilters` (`gates 0–21`) and `orderRouter` (`LIMIT` / `FOK` / `WAIT`).
5. Manages active maker orders (instant `clobUserWs` or FIFO `queueSim`, plus TWAP adverse pulls) or open positions (mark-to-market + `markoutTracker` sampling + expiry settlement).
6. Broadcasts state snapshots to the dashboard and writes 1 Hz tape lines.

---

## Dashboard

> **Dashboard v4:** Draggable/resizable widget workspace. Every panel can be moved, resized, hidden or brought back; layouts persist per browser in `localStorage` under `btc15.dashboard.layout.v5` and can be exported/imported as JSON.

The dashboard connects to `:3099` and renders one snapshot per poll. Each panel receives a keyed `useMemo` slice and a `React.memo` comparator so panels only re-render when their own fields change.

| Panel | Shows |
|-------|-------|
| `BotPanel` | Running/paused state, DRY_RUN, bankroll, daily P&L, stability progress, operator controls |
| `PositionPanel` | Open position, mark-to-market, manual sell |
| `LimitOrderPanel` | GTD limit order lifecycle (placed → monitoring → filled/cancelled) |
| `CurrentPriceCard` | Chainlink oracle & Binance price, basis, Price to Beat, countdown to settlement |
| `PolymarketPanel` | UP/DOWN prices, spread, CLOB source (`live` / `quiet` / `REST poll`) |
| `EdgePanel` | Edge, probability, phase, regime, recommendation |
| `MlPanel` | XGBoost / LightGBM / Hybrid overlay probabilities, confidence & model switcher |
| `PredictPanel` | Combined directional prediction |
| `TAIndicators` | RSI, MACD, VWAP, Bollinger, ATR, Heiken Ashi, EMA cross, StochRSI, volume delta |
| `BetSizingPanel` | Kelly sizing breakdown |
| `AccuracyPanel` | Rolling signal accuracy |
| `JevPanel` | JEV / TypeSafe mode, provider, last direction, settle probability, latency and cost |
| `TapePanel` | Market-tape recorder health, coverage and upload status |
| `JournalTimeSeriesPanel` | Journal analytics: win rate, **margin vs breakeven** (lifetime + realistic fills), sessions, day of week, equity curve |
| `TraderDiscoveryPanel` | Smart-money trader discovery and tracking |
| `SessionInfo` | Trading session, local clock and bot-clock skew |

**Server clock.** Durations shown against bot timestamps use the bot's clock through `src/hooks/serverClock.ts`, not the browser's.

**Auth.** Production nginx (`127.0.0.1:8080`) sits behind `scripts/dashboard-auth-server.mjs` with a Motion login UI, HttpOnly/Secure 12 h cookie, and `nginx auth_request` gating `/ws` and `/api/reports`. Local development can use `?botStatusToken=<STATUS_AUTH_TOKEN>`.

---

## JEV decision layer (TypeSafe System One)

JEV is an LLM **judgment layer**, not the owner of the trading system. The deterministic bot computes probabilities, filters, sizing and execution; JEV operates as a **shadow** observer (`JEV_MODE=shadow`).

- **Provider:** OpenRouter (`typesafe/jev-1.14-20261014`, ~$0.00009/call).
- **Calibration v3 (`2026-11-17-laplace10-lerp`):** 10-bin Laplace Beta(1,1) + PAVA monotone calibration + piecewise `lerp`, Bayesian log-odds prior anchoring onto live market odds (`JEV_BAYESIAN_MAX_WEIGHT=0.20`), Composite Risk Desk score, and automatic rolling Brier skill guard (`evaluateBrierSkillGate`).
- **Guard:** Only fires when the Chainlink 60 s TWAP PTB is **exact** (`0.5–14.4 min` left).

### Two call paths

| Path | When | Log | Effect |
|------|------|-----|--------|
| **Policy sample** | Once per market near open (`JEV_CALL_ON=policy`; `>= JEV_POLICY_MIN_TIME_LEFT`, default 13.5 min) | `bot/data/jev_log.jsonl` | Record-only unbiased direction/Brier audit |
| **Entry decision** | Once at the first `ENTER` candidate for the market | `bot/data/jev_decision.jsonl` | Record-only shadow vs bot entries |

### Status & Evaluation tools

Across `2,868` resolved markets audited via `jevEvaluate.mts`, calibrated JEV Brier (**0.2404**) still trails market odds (**0.2358**), so `JEV_MODE=shadow` stays active (never vetoes, gates, or overrides).

```bash
node bot/scripts/jevSmokeTest.mts          # single test call
node bot/scripts/jevEvaluate.mts           # direction, Brier, calibration buckets, policy sim
node bot/scripts/jevPolicyReport.mts       # fixed-policy candidates + PnL
node bot/scripts/jevDecisionReport.mts     # entry-time direction/Brier, overlap analysis
```

---

## Prerequisites

| Requirement | Version | Notes |
|-------------|---------|-------|
| Node.js | **>= 25** | Runs `.ts` / `.mts` / `.cts` natively |
| npm | bundled | Install root + `bot/` packages |
| PM2 | latest | `npm install -g pm2` (for PM2 local runs) |
| Python | >= 3.10 | ML training & pytest (`requirements-dev.txt`) |
| Docker | optional | For local Compose stack |

**Polymarket requirements**

- A Polygon wallet (EOA or Gnosis Safe proxy) with a **pUSD / USDC.e** balance (`$50+` recommended).
- Polymarket relayers handle gasless execution; L2 CLOB credentials are derived via `bot/derive-credentials.ts` or on first live startup.

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
2. Fund the address on **Polygon** with USDC.e / pUSD.
3. API credentials are derived automatically on first start (or manually with `bot/derive-credentials.ts`).

### Option B: existing Polymarket web wallet

1. Copy your proxy wallet address from Polymarket → Settings → Wallet.
2. Set `POLYMARKET_PROXY_ADDRESS=0x...` and `POLYMARKET_PRIVATE_KEY=0x...` (controlling EOA) in `bot/.env`.

> Never commit `bot/.env`. It is gitignored.

---

## Configuration

All bot settings live in `bot/.env` and are parsed via bounded helpers (`envNum()` / `envInt()`). See `bot/.env.example` for full inline docs.

### Core

```env
POLYMARKET_PRIVATE_KEY=0x...          # Polygon EOA private key
POLYMARKET_PROXY_ADDRESS=             # Gnosis Safe (web-UI wallets only)

BANKROLL=100                          # Starting capital (USD)
DRY_RUN=true                          # ALWAYS start with true
DRY_RUN_QUEUE_SIM=true                # FIFO resting maker queue sim against live CLOB trade prints
POLL_INTERVAL_MS=50                   # Code default 500; production runs 50 ms (3-4ms loop time)
LOG_LEVEL=info

# Status WebSocket (dashboard)
STATUS_BIND_HOST=127.0.0.1            # Local only by default
STATUS_PORT=3099
# STATUS_AUTH_TOKEN=<openssl rand -hex 32>

# Report API
# REPORT_PORT=3101
# REPORT_AUTH_TOKEN=<openssl rand -hex 32>
```

### Feeds, Limit Orders & Execution Safety

```env
LIMIT_ORDER_ENABLED=true              # Passive maker-first GTD entries
LIMIT_POST_ONLY=true                  # Enforce postOnly=true (reject book-cross instead of paying taker fee)
LIMIT_MAX_ATTEMPTS_PER_MARKET=1       # One-shot maker bid per 15m window
EXECUTION_MAX_RUNAWAY=0.02            # Abort FOK if ask jumped >2c above decision quote
CLOB_USER_WS_ENABLED=true             # Authenticated ws/user push fill/cancel stream (dormant in DRY_RUN)
COINBASE_WS_ENABLED=true              # Public Coinbase BTC-USD WS for multi-venue Chainlink nowcast
TWAP_FEED=polybolt                    # polybolt (primary) | rtds (fallback)
```

### JEV v3 / TypeSafe System One (shadow)

```env
JEV_ENABLED=true
JEV_MODE=shadow                       # shadow | veto | gate | primary
JEV_PROVIDER=openrouter
JEV_MODEL=typesafe/jev-1.14
OPENROUTER_API_KEY=

JEV_CALL_ON=policy                    # entry | market | policy
JEV_POLICY_SHADOW=true
JEV_INDEPENDENT_STATE=true
JEV_DECISION_SHADOW=true
JEV_BRIER_GATE=true                   # Auto-demote if rolling Brier trails market
```

### Risk Management & Strategy Toggles

```env
MAX_DAILY_LOSS_PCT=15                 # Halt when today's loss >= 15% of baseline
MAX_CONSECUTIVE_LOSSES=7              # Halt after 7 straight losses
MAX_DRAWDOWN_PCT=25                   # Halt at 25% drawdown from peak
CB_COOLDOWN_MS=14400000               # 4h cooldown after circuit-breaker halt
MAX_BET_AMOUNT_USD=2.50               # Hard cap per trade
KELLY_PROB_SHRINK=0.5                 # Shrink model prob toward market price for Kelly

BLOCKED_SESSIONS=                     # Optional hard session block (e.g. Europe)
TIME_GATES_ENABLED=false              # Weekend / ET blackout / Asia time gates

CUT_LOSS_ENABLED=false                # Production Hold-to-Expiry (13-gate cut-loss kept for extremis only)
CUT_LOSS_MIN_HOLD_SEC=720
CUT_LOSS_MIN_TOKEN_DROP_PCT=70
TAKE_PROFIT_ENABLED=false             # Settlement beats early exit
RECOVERY_BUY_ENABLED=false            # Re-entry after cut-loss (inactive while CUT_LOSS_ENABLED=false)
PREMARKET_LONG_ENABLED=false          # Disabled 2026-09-20 (30% WR)

# Overridable filter thresholds (see bot/src/safety/filterThresholds.ts)
# FILTER_ML_CONF_MIN=0.30
# FILTER_MIN_TWAP_Z=0

# Evaluation reporting & edge-death tripwire
# EVAL_WINDOW_START=2026-11-18T14:56:00Z
EVAL_TARGET_TRADES=150
EVAL_TRIPWIRE_MIN_TRADES=100
EVAL_TRIPWIRE_PAUSE=false
```

### Notifications & Integrations

```env
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
TELEGRAM_NOTIFY_TRADES=true           # Uses IPv4-first DNS + 10s timeout + 3x retry
DISCORD_WEBHOOK_URL=
DASHBOARD_URL=https://<your-dashboard-host>/

DATABASE_URL=postgres://...
REDIS_URL=redis://...
TAPE_S3_ENDPOINT=                     # Cloudflare R2 or S3-compatible bucket for 1 Hz tape
TAPE_S3_BUCKET=polybtc15-tape
```

---

## Running

### Local (PM2)

Always launch via PM2 (loads `bot/.env` with `--env-file` before ESM imports):

```bash
pm2 start ecosystem.config.cts        # bot + Vite dev server (:3010)
pm2 logs polymarket-bot
pm2 restart polymarket-bot
pm2 stop polymarket-bot
```

Dashboard-only development & Study Site build:

```bash
npm run dev            # Vite dev server (:3010)
npm run build          # Production build → dist/
npm run study:build    # Static research portal → study-dist/
```

### Docker Compose

Four-service stack (`frontend` nginx, `bot`, `postgres`, `redis`) with loopback exposure and container hardening:

```bash
cp .env.docker.example .env
docker compose up -d --build
```

Full guide: **[docs/DOCKER_STACK.md](docs/DOCKER_STACK.md)**.

### Production VPS deployment

Runs on Tencent Cloud CVM (`ap-jakarta-1`) under `polybtc15-bot.service` + nginx + Cloudflare Tunnel + `poly15-auto-deploy.service`:

- Pushing to `origin/main` triggers GitHub Actions CI.
- Once CI turns green, `poly15-auto-deploy.service` pulls `main`, builds `dist/` and `study-dist/`, verifies no position is open, and restarts `polybtc15-bot.service`.
- Operational runbook: **[docs/VPS.md](docs/VPS.md)** and **[docs/AUTO_DEPLOY.md](docs/AUTO_DEPLOY.md)**.

### Going live

Only after dry-run queue-sim & markout evidence confirm positive margin over breakeven:

```env
DRY_RUN=false
MAX_BET_AMOUNT_USD=2.00        # start with micro-live sizing
```

Also ensure `CLOB_USER_WS_ENABLED=true` and `LIMIT_POST_ONLY=true` remain enabled, then complete the CLOB V2 readiness check in [docs/CLOB_V2_MIGRATION.md](docs/CLOB_V2_MIGRATION.md).

---

## Dry run and evaluation

`DRY_RUN=true` runs the full production pipeline without initializing live CLOB keys:

- **Realistic FOK & FIFO Maker simulation:** FOK entries pay `fokBuyPrice(quote, spread)` (`fillModel: 'fok_limit'`), reject undersized liquidity, and honor `EXECUTION_MAX_RUNAWAY=0.02`. With `DRY_RUN_QUEUE_SIM=true`, maker bids rest in `queueSim.ts` across polls and only fill when real CLOB market trade prints consume queue ahead (`allowComplementaryBuys: true`, deduplicated by monotonic `seq`) or `bestAsk < targetPrice`.
- **Markout & adverse selection telemetry:** Every entry records `+5s`, `+15s`, `+30s`, and `+60s` token price deltas (`analysis.markout`) plus MAE/MFE into `trade_journal.jsonl` so maker toxicity is visible immediately.
- **Full journal parity:** Dry rows carry `entry.dryRun: true` (never mirrored to Postgres `trade_journal_records`).

### Reports

```bash
npm run report:dryrun                  # last 24h
npm run report:dryrun:all              # whole journal
node bot/scripts/dryRunReport.mts --since 2026-11-18T14:56:00Z [--until <t>] [--json]
```

Always pin windows with `--since` after rule/model changes — rolling windows shift silently over time. `bot/scripts/reportWindow.mts` tracks window boundaries.

### Win rate vs breakeven

Since `2026-09-26`, Polymarket CLOB V2 charges crypto **taker** fees on share matching (win or lose):

```
takerFee(shares, p) = shares × 0.07 × p × (1 − p)
breakeven_taker(p)  = p + 0.07 × p × (1 − p)     (e.g. 61.68% WR at 60¢; max +1.75pp at 50¢)
breakeven_maker(p)  = p                           (0% taker fee for postOnly makers)
```

`bot/src/trading/breakevenMargin.ts` solves breakeven directly from `computeSettlementPnl()` (`settlementMath.ts`) so dashboard analytics, `dryRunReport.mts`, and backtests stay identical.

---

## Trading strategies

### 1. Directional & Smart Order Router (`bot/src/engines/orderRouter.ts`)

LIMIT-first 7-rule router combining ML confidence, ask price, spread width, 3m momentum, and regime:

- `regime === 'choppy'` enforces elevated ML confidence (`>= 40%`) or forces `WAIT`.
- Otherwise, `LIMIT` (`makerJoinPrice` + `postOnly: true`) is preferred whenever the book spread allows passive entry; `FOK` is reserved for cheap/high-conviction fills with live runaway guard (`<= 2¢`).
- Signals route cleanly without leaking `WAIT` into FOK fallback.

### 2. Passive Limit Orders (`bot/src/engines/limitOrderManager.ts` & `makerFillGate.ts`)

- Joins `bestBid` safely (`makerJoinPrice`) capped by `LIMIT_MAX_ENTRY_PRICE` (no `-12%` crash-trap discount).
- Enforces `postOnly: true` in live mode and one-shot per market by default (`LIMIT_MAX_ATTEMPTS_PER_MARKET=1`).
- Continuously monitors unfilled bids via `clobUserWs.ts` (live) or `queueSim.ts` (dry run), cancelling on signal flip, edge erosion (`< 3pp`), `maxUnfilledSec` timeout (`45 s`), or live TWAP adverse selection (`shouldCancelTwapAdverse`: `-15pp` deficit `>300s` left, `-5pp` inside `<=300s`, `<3pp` edge inside `<=180s`).
- Blocks chasing with FOK after TWAP adverse cancellation or when `mlConfidence < 0.32`.

### 3. Arbitrage & Pre-Market Long

- `arbitrage.ts` scans combined UP + DOWN ask costs minus fees before directional execution.
- `preMarketLong.ts` remains **disabled** (`PREMARKET_LONG_ENABLED=false`) after empirical loss (`30%` WR).

### 4. Edge & Signal Stability

- Phase thresholds (`EARLY`, `MID`, `LATE`, `VERY_LATE`) in `src/engines/edge.ts` adapt dynamically to regime (`trending` vs `choppy`) and model calibration (`modelProfiles.ts`).
- `signalStability.ts` enforces a **wall-clock `9.0 s`** persistence requirement (`SIGNAL_CONFIRM_TARGET_MS=9_000`, proportional fast-entry scaling for `>=80%` ML, high edge, 300s R4 taker surges, or 3s Binance lead-lag impulses) plus a 15-second flip-rate guard.

---

## Risk management

### Circuit breakers (`bot/src/safety/guards.ts`)

| Trigger | Default | Action |
|---------|---------|--------|
| Daily loss | `MAX_DAILY_LOSS_PCT=15` | Halt + 4h cooldown |
| Drawdown from peak | `MAX_DRAWDOWN_PCT=25` | Halt + 4h cooldown |
| Consecutive losses | `MAX_CONSECUTIVE_LOSSES=7` | Halt + 4h cooldown |

Daily baseline rolls over cleanly at midnight via `rolloverDayIfNeeded()`. Edge-death auto-tripwire (`evaluationReport.ts`) fires a critical Telegram alert when `n >= EVAL_TRIPWIRE_MIN_TRADES` (`100`) sits below breakeven (with optional auto-pause via `EVAL_TRIPWIRE_PAUSE=true`).

### Cut-loss philosophy (`Hold-to-Expiry`)

Empirical data confirmed Hold-to-Expiry beats mid-window panic exits (`87.5%` historical settlement WR vs `23.3%` cut-loss accuracy, and `69.23%` WR in current dry run with cut-loss off). Production runs **`CUT_LOSS_ENABLED=false`**; the 13-gate evaluator (`cutLoss.ts`) remains available only for extreme drops (`minHoldSec=720`, `minTokenDropPct=70`). A 45-second sell lock prevents exit races.

### Entry filters (`bot/src/safety/tradeFilters.ts` — Gates `0–21`)

All thresholds live in `bot/src/safety/filterThresholds.ts` and are overridable via `FILTER_*` env vars or per-model profiles (`bot/data/model_profiles.json`):

| # | Gate |
|---|------|
| 0 | **Blocked sessions** (`BLOCKED_SESSIONS`, hard block with no bypass) |
| 1 | **ML confidence floor** (`mlConfMin`, `mlConfRelaxed`, `hardMlFloor`, `75–80%` dead zone, PTB quality gate) |
| 2 / 2b | **Market price zone** (`50/50` coin-flip block, `50¢` price floor, `baseHardCap` / `trendingHardCap` / `midPhaseMaxPrice`, extreme contrarian) |
| 3 | **Low volatility** (`atrRatioMin`) |
| 4 / 4c | **Time remaining & PTB distance** (min/max time left, late-phase ML gate, `btcDistMinPct` from Chainlink/TWAP vs PTB) |
| 5 | **Loss cooldown** |
| 6 | **Max trades per market** & re-entry edge gate |
| 7 | **Weekend low-liquidity** (`TIME_GATES_ENABLED`) |
| 8 | **Edge ceiling** (`edgeCeiling`) |
| 9 | **Counter-trend momentum** |
| 10 | **ET blackout hours** (`TIME_GATES_ENABLED`) |
| 11 | **Trending-regime & cheap-token protection** |
| 12 | **Wide spread gate** |
| 13 | **Rolling ML accuracy degradation** |
| 14 | **VPIN informed flow** |
| 15 | **Sudden spread widening** |
| 16 | **Asia session ML floor** (`TIME_GATES_ENABLED`) |
| 17 | **Extreme sentiment** (Fear & Greed) |
| 18 | **Macro event guard** (CPI / FOMC / NFP blackout) |
| 19 / 19b | **LLM regime** & **JEV v3 advisory** (shadow unless configured) |
| 20a / 20b | **Chop microstructure**: BTC `pathEfficiency` floor & `peakGapRatio` anti-retrace |
| 20c / 20d | **Order flow opposition**: L2 `orderbookImbalance` cap & 300s R4 Binance taker ratio cap |
| 20e / 20f | **Microsecond / cross-feed integrity**: 3s Binance `leadLagImpulse` opposition block & Binance-vs-Oracle `crossFeedSkewPct` guard |
| 21 | **Volatility-normalized TWAP lead** (`minTwapZ` floor, bypassed at high ML conf) |

---

## Settlement and verification

Settlement is **provisional by design** so oracle delays never block the next 15-minute window:

- Expiry triggers background oracle polling (`settlement.ts`) with instant abort + `twap_close` / `price_fallback` calculation on market switch.
- `fallbackVerifier.ts` re-verifies every `price_fallback` / `unknown` row against Polymarket's official resolution (`CLOB` + `Gamma`), correcting wins/losses/bankroll automatically when needed (with a 7-day startup sweep).
- Live trades are reconciled against on-chain/CLOB trade history (`journalReconciler.ts`).

---

## Market data feeds

| Stream | File | Purpose |
|--------|------|---------|
| Binance Combined | `bot/src/streams/binanceWs.ts` | `btcusdt@bookTicker` (`<20ms` mid) + `btcusdt@kline_1m` (240-bar RAM ring buffer + RAM `aggregate5m`) |
| Coinbase Spot | `bot/src/streams/coinbaseWs.ts` | Public `BTC-USD` ticker mid-price for 50/50 USD+USDT Chainlink nowcast |
| Polymarket CLOB Book | `bot/src/streams/clobWs.ts` | L2 orderbook (`depthNearTop`), best bid/ask, trade prints w/ monotonic `seq`, make-before-break reconnect |
| Polymarket CLOB User | `bot/src/streams/clobUserWs.ts` | Authenticated `ws/user` order (`PLACEMENT`/`UPDATE`/`CANCELLATION`) & trade (`MATCHED`/`CONFIRMED`) stream (live mode) |
| PolyBolt TWAP + Spot | `bot/src/streams/polyboltWs.ts`, `chainlinkTwap.ts`, `polymarketLiveWs.ts` | Chainlink 60s TWAP (exact settlement & PTB series) + Chainlink spot (`RTDS` shadow fallback kept automatically) |
| Polygon Chainlink WSS | `bot/src/streams/chainlinkWss.ts` | On-chain oracle round fallback |

**CLOB freshness (`clobFreshness.ts`):** Distinguishes `live`, `quiet` (link alive, triggers 25s make-before-break re-verify without blanking quotes), and `down` (past 60s, falls back cleanly).

### Market tape (`bot/src/tape/`)

Records 1 Hz snapshots of top-10 CLOB L2 levels, every trade print, BTC feeds, TWAP, PTB, `twapPhysics` (`tp`/`tz`/`dr`), JEV shadow outputs, and per-poll `decisionTrail.ts` (`d` lines covering every filter & precondition stage) into hourly `YYYY-MM-DD/HH-<boot>.jsonl.gz` files, with optional S3/Cloudflare R2 upload and `npm run tape:pull`.

---

## ML model

### Live model — `20261116-p2-ef8dfd` (Pipeline v2) + `v4-hybrid-20261116` Overlay

| Metric | Value |
|--------|-------|
| Training dataset | **34,962 markets**, `2025-10-17 → 2026-11-15`, 100% real Polymarket labels |
| Active features | **67** (pruned from 83 via fold-stable TreeSHAP `< 0.05%` + gain) |
| Test / Full OOS Accuracy | **75.8%** (test) · **75.21%** (`fullOos`, n = 2,267) |
| AUC / ECE | **0.8532** AUC · **0.0242** ECE (test, 4-phase power-theta calibration) |
| **Brier skill vs same-instant market** | **+6.4%** (exact2175 `+6.46%` · fullOOS `+6.24%`) |
| Residual overlay | **`v4-hybrid-20261116`**: Chainlink-native L2/cross-feed residual adjustment (`hybridResidual.ts`) |
| Hot switching & profiles | Supported live via `modelProfiles.ts` & `bot/data/model_profiles.json` |

### Retired historical baseline — `20260924-p2-0d88d4`

Replaced by `20261114` → `20261115` → **`20261116-p2-ef8dfd`**. All archived models, manifests, and evaluation logs are tracked in `ml_registry/` ([ml_registry/MODELS.md](ml_registry/MODELS.md)).

### Shared feature pipeline & Training (`backtest/ml_training/`)

Training rows (`src/engines/ml/trainingRow.ts`) and live predictions (`bot/src/engines/signalComputation.ts`) share **`src/engines/ml/featureInputs.ts`**, eliminating train-serve skew and future peeking. Offline 1 Hz market tape utilities include `decisionTrailStudy.mts`, `makerFillStudy.py`, `tapeMicroStudy.py`, `twapModelStudy.py`, and `residualModelStudy.py`.

```bash
npm run ml:retrain:dry     # retrain + evaluate fail-closed gates (no deploy)
npm run ml:retrain         # retrain + deploy only if every gate in retrainGate.ts passes
npm run ml:audit           # quality audit of deployed models
npm run ml:registry -- list
```

Retrain gates (`bot/src/retrainGate.ts`, verified by `tests/test_model_contract.py`) fail closed on accuracy, AUC, **market Brier skill (`> 0`)**, high-confidence accuracy/coverage, ECE, CV/test/holdout gaps, and regressions against the live model.

---

## Monitoring, alerts and APIs

- **Telegram / Discord (`bot/src/monitoring/notifier.ts`):** IPv4-first DNS (`setDefaultResultOrder('ipv4first')`), `10s` timeout, `3×` exponential backoff retries, rate-limit rollback on total delivery failure, HTML escaping, and inline **View Market / View Profile / View Web** buttons.
- **Status WebSocket (`:3099`, `bot/src/statusServer.ts`):** Broadcasts full poll state + `markout` telemetry + operator RPCs (`botPause`, `botResume`, `setBankroll`, `resetDailyBaseline`, `switchMlModel`, `saveModelProfile`, `sellPosition`, `forceSettle`, `forceSync`, etc.) protected by token & Origin allowlist checks.
- **Report HTTP API (`:3101`, `bot/src/services/reportServer.ts`):** `GET /health` + authenticated `GET /reports` / `GET /reports/summary`.

---

## Testing and CI

Current GitHub Actions suite (`44445042190`): **122 test files / 1,122 tests PASS** + `npm run typecheck` + `vite build` + Python `pytest` (`>=90%` coverage).

```bash
npm run typecheck      # frontend + bot + bot:core + scripts
npm test               # vitest: src/**/__tests__, bot/**/__tests__, bot/tests
npm run build          # Vite production build → dist/
npm run study:build    # Static research portal → study-dist/
npm run test:ml        # pytest for backtest/ml_training
npm run test:ml:cov    # pytest with coverage (--cov-fail-under=90)
```

*(Note on Windows: Hyper-V/WinNAT commonly reserves TCP ports around `3188–3287`, which can cause local `EACCES` binds in `statusServer.*.test.ts`; the full suite runs cleanly on Ubuntu CI.)*

GitHub Actions (`.github/workflows/ci.yml`) runs on every push to `main` and PR:

- **TypeScript job** (Node 25): `npm ci` → `npm ci --prefix bot` → `typecheck` → `test` → `build`.
- **ML job**: `ruff` → `black --check` → `pytest` (`--cov-fail-under=90`).

---

## Project structure

```
.
├── src/                              # React 19 dashboard + shared quant/ML modules
│   ├── App.tsx                       # Root; keyed useMemo slices
│   ├── components/                   # 16 widget panels + dashboard v4 shell
│   ├── hooks/                        # useBotData, serverClock, computeIndicators, ...
│   ├── engines/ml/                   # featureInputs, featureExtract, trainingRow, Mlpredictor
│   ├── indicators/                   # RSI, MACD, VWAP, BB, ATR, HA, EMA, StochRSI, volDelta
│   └── config.ts                     # Shared tunables & fee helpers
│
├── bot/                              # Node.js 25 trading bot
│   ├── index.ts                      # Entry: DNS IPv4-first, CLOB V2, streams, servers
│   ├── scripts/                      # dryRunReport, JEV reports, tapePull, pg tools
│   ├── data/                         # Runtime state, journals, tape (gitignored except profiles)
│   └── src/
│       ├── loop.ts                   # Zero-await 20 Hz orchestrator
│       ├── statusServer.ts           # WS :3099: state broadcast + operator RPC
│       ├── ml/                       # modelProfiles, hybridResidual
│       ├── ai/                       # JEV v3, regimeClassifier, postTradeAnalyst
│       ├── streams/                  # binanceWs (combined), coinbaseWs, clobWs, clobUserWs,
│       │                             # polyboltWs, chainlinkTwap, polymarketLiveWs, chainlinkWss
│       ├── engines/                  # signalComputation, signalStability, tradePipeline,
│       │                             # orderRouter, limitOrderManager, makerFillGate, queueSim,
│       │                             # settlePrice, twapPhysics, settlement, settlementMath, ...
│       ├── trading/                  # clobClient (V2), ghostGuard, clobOutageLatch, fillTracker,
│       │                             # positionTracker, cutLoss, fallbackVerifier, breakevenMargin, ...
│       ├── safety/                   # tradeFilters (0–21), filterThresholds, guards
│       ├── monitoring/               # markoutTracker, evaluationReport, ptbHealth, ptbVerifier,
│       │                             # notifier, feedGuard, liveness, driftDetector, globalRisk
│       └── tape/                     # 1 Hz recorder, decisionTrail, bookState, s3Store (R2)
│
├── public/ml/                        # Deployed models: xgboost, lightgbm, norm_browser.json
├── ml_registry/                      # Model manifests, metrics, journal & MODELS.md
├── backtest/ml_training/             # Training pipeline + mltrain/ + pytest + tape studies
├── scripts/                          # build-study-site, dashboard-auth-server, watchdogs
├── docs/                             # VPS, AUTO_DEPLOY, CLOB_V2_MIGRATION, DOMAIN, DOCKER_STACK
└── analysis/                         # Research reports & previews
```

---

## Troubleshooting

**Bot won't start / no logs locally.** Always start through PM2 or `node --env-file=bot/.env bot/index.ts`. Bare `node bot/index.ts` skips loading `.env` before imports.

**Dashboard says "Bot disconnected".** Check `systemctl status polybtc15-bot` (VPS) or `pm2 status` (local), port `3099` reachability, and `STATUS_AUTH_TOKEN` / session cookie.

**No trades for 30+ minutes.** Inspect `FILTER_REASONS` / `[Filter] Filtered` logs: common causes are high token price (`>65¢`), low ML confidence (`<30%`), coin-flip zone near PTB, choppy path efficiency, or opposing L2/300s taker flow.

**Polymarket domains fail to resolve.** Set `POLYMARKET_DOH_ENABLED=true`.

---

## Changelog

Recent highlights (full entry history in [UPDATES.md](UPDATES.md)):

| Date | Change |
|------|--------|
| 2026-11-19 | **Zero-await `3–4 ms` loop & Execution/Quant pack (`169ad3a`, `fccf2be`):** Combined Binance `bookTicker`+`kline_1m` WS + 240-bar RAM ring buffer + RAM `aggregate5m`, non-blocking 30s background refreshes, wall-clock `9.0 s` signal stability, `+5s..+60s` post-fill `markoutTracker`, live `LIMIT_POST_ONLY=true`, authenticated `clobUserWs` (`ws/user`), Coinbase `BTC-USD` 50/50 Chainlink nowcast, closed-form `studentTCdf` (`pStudentT` telemetry, benchmarked on 377 tape windows), early TWAP pull calibration (`-15pp`), and hot-loop log throttling. |
| 2026-11-18 | **FIFO Queue-Sim, Quant Hardening & IPv4 Notifier (`561ff68`..`cfd8c32`):** Wired unified-CTF FIFO `queueSim` under `DRY_RUN_QUEUE_SIM=true` w/ `seq` dedup, Chainlink+Binance nowcast + `[b-62s, b-2s)` TWAP offset + fat-tail `1.4×`, `2c` runaway ask haircut, fill-size clip guard, one-shot limit bids, `EVAL_TRIPWIRE_PAUSE` edge-death alert, IPv4-first Telegram/Discord retry notifier, security audit hardening (9 fixes), and WR filter refinements (`WAIT` leak fix, `>=32%` FOK fallback, MID `63c`, choppy `40%`). |
| 2026-11-17 | **JEV v3 & Log Audit (`0482eaf`, `7d668dc`):** 10-bin Laplace+PAVA+`lerp` calibration (`laplace10-lerp`), Bayesian anchoring, Composite Risk Desk, Brier skill guard, 5s log throttling, persistent `jev_outcomes.json`. |
| 2026-11-16 | **ML `20261116-p2-ef8dfd` & Hybrid v4 (`0ed8212`..`9c12faa`):** 34,962-market TreeSHAP 67-feature model (`+6.4%` Brier skill), `v4-hybrid-20261116` residual overlay, GhostGuard tx receipt verification, CLOB outage latch, Study Site (`study-dist/`), and per-model profile overrides. |
| 2026-10-20 | **Dashboard v4 + VPS Ops:** Animated auth gateway, 16-panel drag/resize workspace, CI-gated `poly15-auto-deploy`, watchdog liveness fixes, and public Cloudflare named tunnel (`poly15.dollarkilat.xyz`). |
| 2026-09-25 | **Exact Chainlink TWAP PTB & Pipeline v2:** Fixed PTB resolution to exact 60s TWAP, shared feature builder `featureInputs.ts`, `ml_registry/`, CLOB V2 taker fee math (`0.07·p·(1−p)`), 1 Hz market tape (`bot/src/tape/`), and disabled pre-market long / RL agent. |

The full history is in [UPDATES.md](UPDATES.md) and `git log`.

---

## Contributing

Pull requests are welcome. For larger changes, open an issue first.

- **TypeScript-first.** Sources are `.ts` / `.tsx` / `.mts` / `.cts`. Run `npm run typecheck`, `npm test`, and `npm run build` before submitting.
- Use bounded env parsing (`envNum` / `envInt`), never raw `parseInt(process.env.X)`.
- Compare bot durations via `serverNow()`, never raw browser `Date.now()`.
- Test strategies on pinned windows (`--since`) against solved CLOB V2 breakeven.
- Test with `DRY_RUN=true`.
- Use conventional commits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`).

---

## Disclaimer

This software is for **educational and personal use only**. Trading prediction markets involves significant financial risk, including the loss of your entire stake. Backtests, dry-run results and past performance do not guarantee future results. The authors are not responsible for any financial losses. Check that prediction-market trading is legal where you live. **Trade at your own risk.**

---

## License

Released under the [MIT License](LICENSE).
