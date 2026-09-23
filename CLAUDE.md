# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Frontend
npm run dev          # Vite dev server on port 3010 (vite.config.ts)
npm run build        # Production build to dist/
npm run preview      # Preview production build
npm run test         # vitest run (one-shot)
npm run test:watch   # vitest (watch mode)

# Bot (always via PM2 — never bare `node bot/index.ts`)
pm2 start ecosystem.config.cts       # Start bot + frontend (ml-retrain is commented out — retrain is manual)
pm2 logs polymarket-bot               # Watch bot logs
pm2 stop polymarket-bot               # Graceful stop
pm2 restart polymarket-bot            # Restart

# ML Training Pipeline (backtest/ml_training/)
./runTraining.sh --tune --deploy                                      # Full pipeline
node generateTrainingData.mts --days 180 --polymarket-lookup ./polymarket_lookup.json  # Step 1
python trainXGBoost_v3.py --input training_data.csv --tune --tune-trials 150           # Step 2
python backtestPnL.py --threshold-sweep                               # Backtest sweep
# Deploy: copy xgboost_model.json + lightgbm_model.json + norm_browser.json → public/ml/

npm run test:ml       # pytest suite for the training modules
npm run test:ml:cov   # same, with coverage (mltrain must stay >=90% — CI fails under it)
pip install -r backtest/ml_training/requirements-dev.txt   # pytest + pytest-cov
npm run ml:retrain:dry                # retrain without deploying; ml:retrain deploys if all gates pass
```

TypeScript-first codebase. Source files use `.ts`, `.tsx`, `.mts`, and `.cts`; run `npm run typecheck` before shipping.

CI (`.github/workflows/ci.yml`) installs **both** packages — `npm ci` at the root and `npm ci --prefix bot` — then runs typecheck, vitest and the Vite build on Node 25, plus ruff / black / pytest (`--cov-fail-under=90`) for `backtest/ml_training`. The bot's dependencies (`ethers`, `@polymarket/clob-client`, `dotenv`, …) live only in `bot/package.json`; before 2026-09-23 CI installed the root alone and the typecheck step failed on every push.

## Architecture Overview

Two systems: a **React dashboard** (frontend) and a **Node.js trading bot** (bot/), connected via WebSocket.

```
┌─── Frontend (React 19 + Vite 7) ──────────────────────────────────┐
│  useBotData hook ←── WS :3099 ──→ Bot statusServer.ts             │
│  App.tsx (useMemo slices per panel) → 14 dashboard panels         │
│  Browser-side: feedback tracking, signal perf, IndexedDB logger   │
└────────────────────────────────────────────────────────────────────┘

┌─── Bot (Node.js, PM2-managed) ────────────────────────────────────┐
│  4 WS streams → signalComputation → filter gates 0-19 → decide() │
│  → orderRouter (LIMIT vs FOK) → tradePipeline → CLOB API         │
│  → positionTracker → cutLoss/takeProfit → settlement              │
│  Broadcasts full state to dashboard every poll (~50ms interval)   │
└────────────────────────────────────────────────────────────────────┘
```

### Frontend

- **`src/App.tsx`** — Root component. Each child panel gets a `useMemo` data slice keyed on specific fields to prevent unnecessary re-renders. All panels use `React.memo` with custom comparators.
- **`src/hooks/useBotData.ts`** — Connects to bot WS on `:3099`, receives full state snapshots. Replaces the old `useMarketData` hook (which ran indicators browser-side).
- **`src/hooks/useCountdown.ts`, `useClock.ts`, `useThrottledState.ts`** — Utility hooks for smooth countdown, 1s clock, throttled state.
- **`src/engines/`** — Browser-side decision logic: `edge.ts` (phase-based thresholds), `Mlpredictor.ts` (XGBoost tree traversal), `regime.ts`, `probability.ts`, `feedback.ts`, `orderbook.ts`, `multitf.ts`, `volatility.ts`.
- **`src/indicators/`** — Pure functions: RSI, MACD, VWAP, Bollinger, ATR, Heiken Ashi, EMA cross, StochRSI, volume delta, funding rate.
- **`src/components/`** — 14 panels: `BotPanel`, `PositionPanel`, `LimitOrderPanel`, `TraderDiscoveryPanel`, `CurrentPriceCard`, `PredictPanel`, `TAIndicators`, `PolymarketPanel`, `EdgePanel`, `MlPanel` (imported as `MLPanel`), `BetSizingPanel`, `AccuracyPanel`, `JournalTimeSeriesPanel` (journal analytics incl. margin vs breakeven), `SessionInfo`.
- **`src/config.ts`** — Frontend tunable parameters: indicator periods, WebSocket URLs, Polymarket series ID, Chainlink contract.

### Bot (`bot/src/`)

- **`bot/index.ts`** — Entry point. Polyfills browser APIs, inits CLOB client, loads ML models, starts 4 WS streams, starts status broadcast server, registers graceful shutdown.
- **`bot/src/loop.ts`** (~2800 lines) — Main orchestrator. Poll cycle: fetch data → compute signals → apply the trade filters → decide → route order → execute → monitor position → settle → broadcast state.
- **`bot/src/config.ts`** — `BOT_CONFIG` parsed from `.env` via `envNum()`/`envInt()` with bounds. Imports shared `CONFIG` from frontend `src/config.ts`.
- **`bot/src/statusServer.ts`** — WS server on port 3099, broadcasts state each poll, accepts RPC commands (botPause/botResume, setBankroll, resetDailyBaseline, getPositions, sellPosition, forceSettle, forceSync, trader tracking, …). The token also authorises these, which is why it is never embedded in a public bundle.
- **`bot/src/services/reportServer.ts`** — HTTP on port 3101: `/health` (public, the Railway healthcheck) and `/reports`, `/reports/summary` (Bearer `REPORT_AUTH_TOKEN` or `?token=`).

#### Bot Streams (`bot/src/streams/`)
- `clobWs.ts` — Polymarket CLOB market channel. Two sockets can be live at once: `ws` serves data, `pending` is a replacement that is promoted only once it delivers a quote for the current tokens (make-before-break). Used at every 15-min rollover, for the 25s quiet re-verify and for the silent-link path — so changing subscription never blanks the feed. Two invariants worth knowing before editing: **only the serving socket's frames set `lastMsgMs`** (a standby's handshake and PONGs refreshing it would disguise a black-holed `ws` — which never fires `close` — as alive for up to the 60s ceiling), and **replacement retries go through `scheduleReplacement()`**, an exponential backoff capped at 60s, because a market that accepts the subscription but never sends a book otherwise reconnects every 8s forever against the same host that places orders.
- `clobFreshness.ts` — `evaluateClobFeed()`, the pure verdict the bot prices off. Separates "link alive" (any frame, PONG included) from "quotes current" (book / price_change). Returns `live` | `quiet` | `down`.
- `binanceWs.ts`, `chainlinkWss.ts`, `polymarketLiveWs.ts` — BTC price, oracle round, live oracle price.

#### Bot Engines (`bot/src/engines/`)
- `signalComputation.ts` — Computes all indicators + ML + arbitrage + smart flow per poll. Takes `clobUsable` already decided; it does not judge freshness itself
- `tradePipeline.ts` — Execution logic: arb first, then directional (FOK/LIMIT), Kelly sizing
- `orderRouter.ts` — 7-rule decision tree: ML conf + price + spread + momentum → LIMIT/FOK/WAIT
- `limitOrderManager.ts` — Passive GTD order lifecycle: IDLE → PLACED → MONITORING → FILLED/CANCELLED. Anti-loop: max 2 attempts per market slug, 60s cancel cooldown
- `monteCarlo.ts` — GBM risk simulation (1000 paths), bypassed when ML >= 85%
- `settlement.ts` — Oracle query (7 retries), fallback to BTC price comparison, AbortController on market switch
- `preMarketLong.ts` — 09:00-09:15 EST weekdays, always UP, `PREMARKET_LONG_RISK_PCT` of bankroll (0.10 in deployed env, ~8x a normal trade), 1/day. **Disabled 2026-09-20** (`PREMARKET_LONG_ENABLED=false`): 10 Railway dry-run trades, 30% WR, -19.88 — 2.6% of trades, nearly all of the book's profit.

#### Bot Trading (`bot/src/trading/`)
- `positionTracker.ts` — Bankroll, position state, sell lock (45s timeout), mark-to-market, audit log
- `clobClient.ts` — Polymarket CLOB API: FOK + GTD orders, ethers.js v6, ERC-1155 approval
- `cutLoss.ts` — 13-gate evaluator. Philosophy: settlement WR 87.5% >> cut-loss 23.3%, only cut in extremis (>=70% token drop, 720s min hold — `CUT_LOSS_MIN_TOKEN_DROP_PCT` / `CUT_LOSS_MIN_HOLD_SEC`, same in code defaults and `bot/.env`)
- `takeProfit.ts` — 7-gate evaluator (DISABLED — settlement beats early exit)
- `recoveryBuy.ts` — Re-entry after cut-loss: state machine IDLE → SAMPLING → MONITORING → BUY
- `journalReconciler.ts` — On-chain trade verification against CLOB API
- `breakevenMargin.ts` — Win rate vs the win rate needed to break even. **Breakeven is solved from `computeSettlementPnl`, never re-derived**: the fee is charged on the winning *profit*, not on the cost, so breakeven is `p / ((1-p)(1-r) + p)` and not `p + r(p)` — a 1.0-1.3pp difference across the traded range, which on 2026-09-22 was enough to make a band sitting exactly at breakeven look like a 1.5pp loser and nearly justify a filter change for a result that was not there. `marginReport()` returns `lifetime` and `realistic`; the latter keeps only rows whose entry price reflects a fill a live order would have got (live rows, or dry-run rows marked `entry.fillModel: 'fok_limit'`), so the window is defined by the data rather than by a deploy timestamp that goes stale.

#### Bot Safety (`bot/src/safety/`)
- `tradeFilters.ts` — numbered gates 0-19 (several with a/b/c sub-gates): ML confidence, entry-price floor and 68c ceiling, spreads, time windows, session quality, VPIN, blackout hours, sentiment, macro events, LLM regime (shadow). Filter 0 is `BLOCKED_SESSIONS` (comma-separated, read once at module load): a hard gate placed ahead of every bypass in the module, because high-edge / oracle-lag / ML-confidence bypasses relax *signal* thresholds and a session we chose not to trade is not one.
- `guards.ts` — Circuit breaker: max daily loss, max consecutive losses, 4hr cooldown. The daily baseline it measures against rolls over via `positionTracker.rolloverDayIfNeeded()`, called from the poll loop — **not** only from `loadState()`. Before 2026-09-20 it rolled only at process start, so a bot up for 9.5 days was feeding a multi-day P&L to a per-day threshold.

#### Bot Monitoring (`bot/src/monitoring/`)
- `notifier.ts` — Telegram + Discord alerts (rate-limited)
- `perfMonitor.ts` — Win rate tracking, daily P&L monitoring

### Vite Proxy Setup

Dev server proxies to avoid CORS:
- `/gamma-api` → `https://gamma-api.polymarket.com`
- `/clob-api` → `https://clob.polymarket.com`
- `/binance-api` → `https://data-api.binance.vision`
- `/fapi-api` → `https://fapi.binance.com`
- `/bybit-api` → `https://api.bybit.com`

### ML Model (v16)

- **Ensemble**: XGBoost + LightGBM, Platt-calibrated on logits. Weights are re-selected on OOF CV each retrain and stored in `norm_browser.json` (`ensemble_weights`) — the runtime reads them from there, so don't hardcode a ratio.
- **Features**: 79 (54 base + 25 engineered), 180-day training window. The deployed model trained on 12,787 markets from 2026-03-08 to 2026-09-04 UTC, **all** labeled from real Polymarket outcomes (`polymarket_lookup.json`; no simulated labels). The older "86% real labels" figure was v16-era.
- **Deployed = trained = Railway** (checked 2026-09-23): `public/ml/{xgboost_model,lightgbm_model,norm_browser}.json` are byte-identical to `backtest/ml_training/output/` and `candidates/20260905_oof/`, and sha256 matches inside the running Railway container (`railway ssh --service bot -- sha256sum /app/public/ml/...`; pass absolute paths, `sh -c '...'` gets split). No retrain since 2026-09-05. Retraining is manual, so the model does not see markets after its training cutoff until someone runs one.
- **Metrics** (deployed 2026-09-05, commit "deploy the OOF-selected model"; source of truth is `public/ml/norm_browser.json` → `ensemble_metrics`): ensemble acc 78.30%, AUC 0.8715, logloss 0.4472, Brier 0.1468, ECE 0.0171, MCE 0.052, weights XGB 0.60 / LGB 0.40 from OOF CV, 1,903 test + 1,343 strict-holdout rows. It replaced the 2026-09-02 model (78.50% / AUC 0.8774 / ECE 0.0328): slightly less sharp, materially better calibrated, and the first whose weights were not chosen on the holdout it reported. Earlier headline numbers (84.07% / holdout 94.12%) predate the embargo + OOF-selection fixes and were measured on a reused holdout — not comparable.
- **Storage**: `public/ml/xgboost_model.json` + `lightgbm_model.json` + `norm_browser.json`
- **Inference**: `src/engines/Mlpredictor.ts` — iterative tree traversal, `Float64Array` buffers, named feature splits via `featureNameToIdx` Map
- **Training**: `backtest/ml_training/trainXGBoost_v3.py` — thin entrypoint (argparse + orchestration) over the `mltrain/` package: `features.py` (25 engineered features), `cv.py` (embargoed walk-forward CV), `sweeps.py` (threshold / phase-grid / ensemble-weight selection), `metrics.py` (ECE, confidence buckets). Modules take every input explicitly — no module-level mutable state — and are unit-tested.
- **Validation hygiene**: `--cv-embargo` (default 16 rows = 4h) drops validation rows whose feature lookbacks overlap the training tail at every temporal boundary. ALL selection sweeps run on out-of-fold CV predictions; the 12.5% strict holdout is evaluation-only (multiple-testing fix, ML4T ch16). Soft feature pruning requires a feature to be weak in the final model AND every fold.
- **Deploy gates**: `bot/src/autoRetrain.ts` fails closed on 10 gates (accuracy, AUC, high-conf accuracy/coverage, ECE, cv-test gap, test-holdout gap, strict-holdout flag, relative drops). `tests/test_model_contract.py` reads those gate field names straight out of the TS and asserts the exported JSON still provides them — rename a metric in Python and the test fails instead of a gate silently going missing.
- **Key lesson**: `--days 180` optimal (v15 failed with `--days 600` — diluted real labels to 32%). `RETRAIN_DAYS` in `bot/.env` must stay 180.

### Bot State Files (`bot/data/`)

| File | Format | Purpose |
|------|--------|---------|
| `state.json` | JSON | Bankroll, positions, trade counts (rewritten each poll) |
| `state_audit.jsonl` | JSONL | Append-only bankroll audit trail (1MB rotation) |
| `trade_journal.jsonl` | JSONL | All trades with full details |
| `verified_journal.jsonl` | JSONL | On-chain verified trades from CLOB |
| `feedback.json` | JSON | Rolling accuracy stats per regime |
| `ptb_health.jsonl` | JSONL | 1-min rollups of the PTB source mix; also the liveness heartbeat the stack watchdog reads |
| `watchdog_state.json` | JSON | Last container / Docker restart the watchdog performed (escalation memory) |

### Edge Engine (`src/engines/edge.ts`)

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

- **App.tsx data slicing**: Every panel gets a `useMemo` slice with granular dependency arrays. Adding new data to a panel = add to its useMemo + dependency array.
- **Server clock, not browser clock**: durations shown against a bot timestamp (`settlementMs`, `enteredAt`, `placedAt`, `data.ts`) go through `src/hooks/serverClock.ts` — a module-level offset (`serverTs - localNow`) that `useBotData` refreshes from every snapshot's `ts`. Panels call `serverNow()` or `useServerNow(intervalMs)`; `useCountdown`/`useClock` already do. Raw `Date.now()` is correct only where both sides of the subtraction are browser-local (feedback store, stream heartbeats, fetch backoffs). Added 2026-09-09 after an operator PC ran 36 min slow and then exactly 12 h fast, which pinned every countdown at 0 and made ages read 43200s.
- **Bot .env loading**: `--env-file=./bot/.env` in PM2 ecosystem config loads env BEFORE ES module imports (prevents hoisting bug where `BOT_CONFIG` reads empty `process.env`).
- **`envNum()`/`envInt()` pattern**: All bot config uses bounded parsing — never raw `parseInt(process.env.X)`.
- **A quiet CLOB book is not a stale one**: `useClobWs` comes from `streams/clobFreshness.ts`, which reads four separate facts out of `clobWs.getFeedHealth()` — connected, book in hand, last *frame* (PONG counts), last *quote*. Before 2026-09-21 it was one number (`now - lastUpdate > 15s`, where lastUpdate only moved on a quote), so a live-but-quiet book was declared stale and the bot fell back to `poly.prices` — a 30s Gamma cache, i.e. strictly older than what it had just rejected, with sub-1% arbs suppressed on top. A book that has not moved is re-verified at 25s by a make-before-break replacement socket (the only thing that distinguishes a quiet book from a silently dropped subscription), and is refused outright past 60s. The dashboard shows all three states — a `🔄 REST Poll` now means something is actually wrong.
- **Sell lock**: `positionTracker.acquireSellLock()` prevents cut-loss/take-profit/manual-sell race conditions (45s timeout).
- **Anti-loop protection**: `limitOrderManager.ts` tracks attempts per market slug (max 2) and enforces 60s cancel cooldown.
- **DRY_RUN simulates fills**: the directional path books a position and runs settlement / cut-loss / journal exactly like live; journal rows carry `entry.dryRun: true`, never reach the Postgres mirror, and are what `npm run report:dryrun` scores. No order reaches the CLOB (client is not even initialised in dry run). Since 2026-09-20 the fill is charged at `fokBuyPrice(quote, spread)` — the same limit the live path submits — not at the quote, and an order larger than `askLiquidity` is rejected like a real FOK. Rows carry `entry.fillModel: 'fok_limit'`, `expectedPrice` (quote) and `actualPrice` (fill), so pre- and post-change rows stay comparable without a flag. Before that, all 378 Railway rows booked at the quote with `slippagePct: 0` — the optimistic bound.
- **Settlement is provisional by design, not by accident**: at expiry `handleExpiry` starts the oracle retries, then the market switch aborts them so `settlementPending` does not block trading on the new market — hence `price_fallback` on essentially every row and 0 from `oracle`. `fallbackVerifier` re-checks against the real resolution starting at +90s (`RETRY_DELAYS_MS`), which is when the oracle typically closes anyway, and corrects the journal row, counters and (dry-run) bankroll. The exposure window is ~90s. Do not "fix" the oracle path — it is this trade-off, and the verifier closes it. Known gap: rows still unresolved after ~47 min of retries wait for the startup sweep — and the sweep only reaches back `DEFAULT_SWEEP_MAX_AGE_MS` (7 days), so "they self-heal on the next deploy" holds only inside that window. Past it they stay provisional permanently, because CLOB/Gamma stop answering for markets that old. Since 2026-09-22 the sweep counts them (`agedOut`) and names them in a warning instead of skipping silently; three rows from 09-09 had sat unverified through two redeploys before anything said so.
- **price_fallback is provisional**: the market switch aborts the oracle retries at expiry, so most settlements are booked from Chainlink spot vs PTB while Polymarket resolves on a 60s TWAP (2026-09-07: one Railway row flipped WIN→LOSS). `bot/src/trading/fallbackVerifier.ts` re-checks every `price_fallback` / `unknown` row against the real resolution (`engines/marketResolution.ts`: CLOB by conditionId, then Gamma `GET /markets/slug/<slug>` — the `?slug=` list form returns `[]` for these markets) on a backoff after settlement and in a sweep at startup, rewrites the journal row (`exit.verifiedAt`, `exit.correctedFrom`) and corrects wins/losses/consecutiveLosses via `positionTracker.correctSettlement` (bankroll too for dry-run rows; live bankroll stays with the on-chain reconciler). The report prints the verified/corrected/unverified split.
- **Watchdog liveness**: `scripts/stack-watchdog.ps1` (scheduled every 10 min) also runs `bot/scripts/botLiveness.mts`; a container that is "Up" but has not completed a poll in 10 min gets restarted, and Docker Desktop is restarted if that did not help within 30 min.
- **Dynamic fee** (Mar 30, 2026): `polyFeeRate(p) = 0.072 * p * (1-p)` — Crypto category, max 1.80% at p=0.50. Maker rebate: 20% (limit orders effective ~0.0576 × p × (1−p)). `@polymarket/clob-client` v4 auto-handles `feeRateBps` in signing.

### Environment Notes

- Windows (MSYS/Git Bash), `.bashrc` has encoding errors (harmless, ignore)
- Binance FAPI + Bybit both blocked in user's region — funding rate defaults to neutral
- Python 3.13.0, Node 25.1.0, xgboost 3.1.3
- PM2 ecosystem: `ecosystem.config.cts` (512M bot, 512M frontend via `npm run dev`, auto-restart; the `ml-retrain` app is commented out)
