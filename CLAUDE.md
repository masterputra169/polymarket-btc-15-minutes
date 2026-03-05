# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Frontend
npm run dev          # Vite dev server on port 3000
npm run build        # Production build to dist/
npm run preview      # Preview production build
npm run test         # vitest run (one-shot)
npm run test:watch   # vitest (watch mode)

# Bot (always via PM2 — never bare `node bot/index.js`)
pm2 start ecosystem.config.cjs       # Start bot + ml-retrain
pm2 logs polymarket-bot               # Watch bot logs
pm2 stop polymarket-bot               # Graceful stop
pm2 restart polymarket-bot            # Restart

# ML Training Pipeline (backtest/ml_training/)
./runTraining.sh --tune --deploy                                      # Full pipeline
node generateTrainingData.mjs --days 180 --polymarket-lookup ./polymarket_lookup.json  # Step 1
python trainXGBoost_v3.py --input training_data.csv --tune --tune-trials 150           # Step 2
python backtestPnL.py --threshold-sweep                               # Backtest sweep
# Deploy: copy xgboost_model.json + lightgbm_model.json + norm_browser.json → public/ml/
```

No linter or TypeScript. Vanilla JavaScript/JSX with ES modules.

## Architecture Overview

Two systems: a **React dashboard** (frontend) and a **Node.js trading bot** (bot/), connected via WebSocket.

```
┌─── Frontend (React 19 + Vite 7) ──────────────────────────────────┐
│  useBotData hook ←── WS :3099 ──→ Bot statusServer.js             │
│  App.jsx (useMemo slices per panel) → 12 dashboard panels         │
│  Browser-side: feedback tracking, signal perf, IndexedDB logger   │
└────────────────────────────────────────────────────────────────────┘

┌─── Bot (Node.js, PM2-managed) ────────────────────────────────────┐
│  4 WS streams → signalComputation → 15 trade filters → decide()  │
│  → orderRouter (LIMIT vs FOK) → tradePipeline → CLOB API         │
│  → positionTracker → cutLoss/takeProfit → settlement              │
│  Broadcasts full state to dashboard every poll (~50ms interval)   │
└────────────────────────────────────────────────────────────────────┘
```

### Frontend

- **`src/App.jsx`** — Root component. Each child panel gets a `useMemo` data slice keyed on specific fields to prevent unnecessary re-renders. All panels use `React.memo` with custom comparators.
- **`src/hooks/useBotData.js`** — Connects to bot WS on `:3099`, receives full state snapshots. Replaces the old `useMarketData` hook (which ran indicators browser-side).
- **`src/hooks/useCountdown.js`, `useClock.js`, `useThrottledState.js`** — Utility hooks for smooth countdown, 1s clock, throttled state.
- **`src/engines/`** — Browser-side decision logic: `edge.js` (phase-based thresholds), `Mlpredictor.js` (XGBoost tree traversal), `regime.js`, `probability.js`, `feedback.js`, `orderbook.js`, `multitf.js`, `volatility.js`.
- **`src/indicators/`** — Pure functions: RSI, MACD, VWAP, Bollinger, ATR, Heiken Ashi, EMA cross, StochRSI, volume delta, funding rate.
- **`src/components/`** — 12 panels: `BotPanel`, `PositionPanel`, `LimitOrderPanel`, `TraderDiscoveryPanel`, `CurrentPriceCard`, `PredictPanel`, `TAIndicators`, `PolymarketPanel`, `EdgePanel`, `MlPanel`, `BetSizingPanel`, `AccuracyPanel`, `SessionInfo`.
- **`src/config.js`** — Frontend tunable parameters: indicator periods, WebSocket URLs, Polymarket series ID, Chainlink contract.

### Bot (`bot/src/`)

- **`bot/index.js`** — Entry point. Polyfills browser APIs, inits CLOB client, loads ML models, starts 4 WS streams, starts status broadcast server, registers graceful shutdown.
- **`bot/src/loop.js`** (~2000 lines) — Main orchestrator. Poll cycle: fetch data → compute signals → apply 15 trade filters → decide → route order → execute → monitor position → settle → broadcast state.
- **`bot/src/config.js`** — `BOT_CONFIG` parsed from `.env` via `envNum()`/`envInt()` with bounds. Imports shared `CONFIG` from frontend `src/config.js`.
- **`bot/src/statusServer.js`** — WS server on port 3099, broadcasts state each poll, accepts RPC commands (pause/resume, setBankroll, sellPosition, getPositions).

#### Bot Engines (`bot/src/engines/`)
- `signalComputation.js` — Computes all indicators + ML + arbitrage + smart flow per poll
- `tradePipeline.js` — Execution logic: arb first, then directional (FOK/LIMIT), Kelly sizing
- `orderRouter.js` — 7-rule decision tree: ML conf + price + spread + momentum → LIMIT/FOK/WAIT
- `limitOrderManager.js` — Passive GTD order lifecycle: IDLE → PLACED → MONITORING → FILLED/CANCELLED. Anti-loop: max 2 attempts per market slug, 60s cancel cooldown
- `monteCarlo.js` — GBM risk simulation (1000 paths), bypassed when ML >= 85%
- `settlement.js` — Oracle query (7 retries), fallback to BTC price comparison, AbortController on market switch
- `preMarketLong.js` — 09:00-09:15 EST weekdays, always UP, 5% risk, 1/day

#### Bot Trading (`bot/src/trading/`)
- `positionTracker.js` — Bankroll, position state, sell lock (45s timeout), mark-to-market, audit log
- `clobClient.js` — Polymarket CLOB API: FOK + GTD orders, ethers.js v6, ERC-1155 approval
- `cutLoss.js` — 13-gate evaluator. Philosophy: settlement WR 87.5% >> cut-loss 23.3%, only cut in extremis (>=45% drop, 480s min hold)
- `takeProfit.js` — 7-gate evaluator (DISABLED — settlement beats early exit)
- `recoveryBuy.js` — Re-entry after cut-loss: state machine IDLE → SAMPLING → MONITORING → BUY
- `journalReconciler.js` — On-chain trade verification against CLOB API

#### Bot Safety (`bot/src/safety/`)
- `tradeFilters.js` — 15 filters: ML confidence, spreads, time windows, session quality, VPIN, blackout hours
- `guards.js` — Circuit breaker: max daily loss, max consecutive losses, 4hr cooldown

#### Bot Monitoring (`bot/src/monitoring/`)
- `notifier.js` — Telegram + Discord alerts (rate-limited)
- `perfMonitor.js` — Win rate tracking, daily P&L monitoring

### Vite Proxy Setup

Dev server proxies to avoid CORS:
- `/gamma-api` → `https://gamma-api.polymarket.com`
- `/clob-api` → `https://clob.polymarket.com`
- `/binance-api` → `https://data-api.binance.vision`
- `/fapi-api` → `https://fapi.binance.com`
- `/bybit-api` → `https://api.bybit.com`

### ML Model (v16)

- **Ensemble**: XGBoost (0.75) + LightGBM (0.25), Platt-calibrated on logits
- **Features**: 79 (54 base + 25 engineered), 180-day training window, 86% real Polymarket labels
- **Metrics**: 84.07% accuracy, AUC 0.9248, holdout 94.12%. At >=80% conf: 99.3% WR
- **Storage**: `public/ml/xgboost_model.json` + `lightgbm_model.json` + `norm_browser.json`
- **Inference**: `src/engines/Mlpredictor.js` — iterative tree traversal, `Float64Array` buffers, named feature splits via `featureNameToIdx` Map
- **Training**: `backtest/ml_training/trainXGBoost_v3.py` — Optuna HPO, walk-forward 3-fold CV, regime sample weighting
- **Key lesson**: `--days 180` optimal (v15 failed with `--days 600` — diluted real labels to 32%)

### Bot State Files (`bot/data/`)

| File | Format | Purpose |
|------|--------|---------|
| `state.json` | JSON | Bankroll, positions, trade counts (rewritten each poll) |
| `state_audit.jsonl` | JSONL | Append-only bankroll audit trail (1MB rotation) |
| `trade_journal.jsonl` | JSONL | All trades with full details |
| `verified_journal.jsonl` | JSONL | On-chain verified trades from CLOB |
| `feedback.json` | JSON | Rolling accuracy stats per regime |

### Edge Engine (`src/engines/edge.js`)

Phase-based decision with regime-adaptive thresholds:

| Phase | Time Left | Base Min Edge | Base Min Prob | Min Agreement |
|-------|-----------|---------------|---------------|---------------|
| EARLY | > 10 min | 6% | 60% | 3 |
| MID | 5-10 min | 7% | 58% | 3 |
| LATE | 2-5 min | 7% | 57% | 2 |
| VERY_LATE | < 2 min | 7% | 56% | 2 |

- **Trending**: Relaxes minEdge/minProb by up to 2%
- **Choppy**: Tightens minEdge +3%, minProb +3%
- **ML high-confidence** (>=85%): Relaxes thresholds even if `mlAgreesWithRules=false`, `minAgreement=0`

### Key Patterns

- **App.jsx data slicing**: Every panel gets a `useMemo` slice with granular dependency arrays. Adding new data to a panel = add to its useMemo + dependency array.
- **Bot .env loading**: `--env-file=./bot/.env` in PM2 ecosystem config loads env BEFORE ES module imports (prevents hoisting bug where `BOT_CONFIG` reads empty `process.env`).
- **`envNum()`/`envInt()` pattern**: All bot config uses bounded parsing — never raw `parseInt(process.env.X)`.
- **Sell lock**: `positionTracker.acquireSellLock()` prevents cut-loss/take-profit/manual-sell race conditions (45s timeout).
- **Anti-loop protection**: `limitOrderManager.js` tracks attempts per market slug (max 2) and enforces 60s cancel cooldown.
- **Dynamic fee**: `polyFeeRate(p) = 0.25 * (p*(1-p))^2` replaces flat 2% in edge + sizing calculations.

### Environment Notes

- Windows (MSYS/Git Bash), `.bashrc` has encoding errors (harmless, ignore)
- Binance FAPI + Bybit both blocked in user's region — funding rate defaults to neutral
- Python 3.13.0, Node 25.1.0, xgboost 3.1.3
- PM2 ecosystem: `ecosystem.config.cjs` (512M bot, 1G ml-retrain, auto-restart)
