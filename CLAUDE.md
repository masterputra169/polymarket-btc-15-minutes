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
npm run tape:pull                     # download the market tape from the bucket + per-day coverage (--stats-only, --since)

# Fresh-price historical backtest (backtest/ml_training/, 2026-09-25)
node fetchTradeHistory.mts --since <unixSec>        # per-second trade prints per market (data API, via DoH; resumable; offset cap 10k → busiest markets truncated)
node predictFreshPrices.mts --model <dir> --since <unixSec>   # re-predict every minute with FRESH token prices through the live feature path
python freshBacktest.py                            # event-driven entry-rule backtest (SELECT/VALIDATE) + day-block Monte Carlo of bankroll risk
node fetchPricePoints.mts                          # last print at seconds 0..840 per market (15 × limit=1&end=T queries) — all the generator needs
node generateTrainingData.mts --days 182 --trade-history ./trade_history --price-points ./price_points --output training_data_v3.csv   # pipeline v3 rows
python compareFreshModels.py --a <preds> --b <preds> --since <slug>   # head-to-head of two models on fresh prices, OOS for both
python hybridBacktest.py                           # v3 as a veto on v2's live rule (answer 2026-09-25: no — v3 agrees on every v2 entry)
node decisionTrailStudy.mts [--since YYYY-MM-DD]   # from the tape's d lines: which gates held signals, and would they have won (needs `npm run tape:pull`)
node ptbImpactStudy.mts [--until ISO] [--offline]  # what the wrong PTB / Binance comparison changed: who-is-ahead accuracy, filter replay (4c, 11c), last-minutes leader vs token price
node fetchTwapHistory.mts --days 30                 # per window: Polymarket 60 s TWAP path (price-history, 30-day limit) + Binance 1 s closes for the last ~400 s
node fetchTradeHistory.mts --since <s> --until <s> --all-windows   # trade prints for every window in range, not only training_data.csv's
python twapLateBacktest.py [--latency 2] [--min-price 0.4] [--max-age 5]   # buy the TWAP-aware leader late in the window — 2026-09-25: NO edge out of sample (≈ buying the favourite)
python ruleSearch.py [--curve]                     # 211 entry-rule variants on fresh prices, SELECT/VALIDATE — 2026-09-26: none beats CURRENT with >=1.5x trades
python twapModelStudy.py                           # TWAP-feature model vs market vs v2 (last 5 min) — 2026-09-26: no edge in the trading window; ~8% Brier skill only in the last 15-60 s
node exportFreshFeatures.mts [--days 182]           # every decision minute of every market: live feature vector + fresh price + v2 P(UP) -> fresh_features.csv (~200k rows)
python residualModelStudy.py                        # market-offset XGBoost (base_margin = logit fresh price), stacking, edge rule — 2026-09-26: +0.5-0.8% Brier skill at best
python tapeMicroStudy.py                            # order book vs price on the tape: microprice = mid at a 1c spread; imbalance adds ~nothing yet (first look)
python makerFillStudy.py                            # bot's ENTER signals as a resting bid vs FOK at the ask, on the tape: fills ~60% in 15 s, saves 1c + the taker fee, adverse selection unresolved (needs ~7 weeks)
```

TypeScript-first codebase. Source files use `.ts`, `.tsx`, `.mts`, and `.cts`; run `npm run typecheck` before shipping.

CI (`.github/workflows/ci.yml`) installs **both** packages — `npm ci` at the root and `npm ci --prefix bot` — then runs typecheck, vitest and the Vite build on Node 25, plus ruff / black / pytest (`--cov-fail-under=90`) for `backtest/ml_training`. The bot's dependencies (`ethers`, `@polymarket/clob-client`, `dotenv`, …) live only in `bot/package.json`; before 2026-09-23 CI installed the root alone and the typecheck step failed on every push.

## Architecture Overview

Two systems: a **React dashboard** (frontend) and a **Node.js trading bot** (bot/), connected via WebSocket.

```
┌─── Frontend (React 19 + Vite 7) ──────────────────────────────────┐
│  useBotData hook ←── WS :3099 ──→ Bot statusServer.ts             │
│  App.tsx (useMemo slices per panel) → 15 dashboard panels         │
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
- **`src/hooks/useBotData.ts`** — Connects to bot WS on `:3099`, receives full state snapshots. (The old browser-side `useMarketData` hook was deleted 2026-09-25.)
- **`src/hooks/useCountdown.ts`, `useClock.ts`, `useThrottledState.ts`** — Utility hooks for smooth countdown, 1s clock, throttled state.
- **`src/engines/`** — Browser-side decision logic: `edge.ts` (phase-based thresholds), `Mlpredictor.ts` (XGBoost tree traversal), `regime.ts`, `probability.ts`, `feedback.ts`, `orderbook.ts`, `multitf.ts`, `volatility.ts`.
- **`src/indicators/`** — Pure functions: RSI, MACD, VWAP, Bollinger, ATR, Heiken Ashi, EMA cross, StochRSI, volume delta, funding rate.
- **`src/components/`** — 14 panels: `BotPanel`, `PositionPanel`, `LimitOrderPanel`, `TraderDiscoveryPanel`, `CurrentPriceCard`, `PredictPanel`, `TAIndicators`, `PolymarketPanel`, `EdgePanel`, `MlPanel` (imported as `MLPanel`), `BetSizingPanel`, `AccuracyPanel`, `JournalTimeSeriesPanel` (journal analytics incl. margin vs breakeven), `TapePanel` (market tape recorder health — view logic in `tapeStatusView.ts`), `SessionInfo`.
- **`src/config.ts`** — Frontend tunable parameters: indicator periods, WebSocket URLs, Polymarket series ID, Chainlink contract.

### Bot (`bot/src/`)

- **`bot/index.ts`** — Entry point. Polyfills browser APIs, inits CLOB client, loads ML models, starts 4 WS streams, starts status broadcast server, registers graceful shutdown.
- **`bot/src/loop.ts`** (~2800 lines) — Main orchestrator. Poll cycle: fetch data → compute signals → apply the trade filters → decide → route order → execute → monitor position → settle → broadcast state.
- **`bot/src/config.ts`** — `BOT_CONFIG` parsed from `.env` via `envNum()`/`envInt()` with bounds. Imports shared `CONFIG` from frontend `src/config.ts`.
- **`bot/src/statusServer.ts`** — WS server on port 3099, broadcasts state each poll, accepts RPC commands (botPause/botResume, setBankroll, resetDailyBaseline, getPositions, sellPosition, forceSettle, forceSync, trader tracking, …). The token also authorises these, which is why it is never embedded in a public bundle.
- **`bot/src/services/reportServer.ts`** — HTTP on port 3101: `/health` (public, the Railway healthcheck) and `/reports`, `/reports/summary` (Bearer `REPORT_AUTH_TOKEN` or `?token=`).

#### Bot Streams (`bot/src/streams/`)
- `clobWs.ts` — Polymarket CLOB market channel. Two sockets can be live at once: `ws` serves data, `pending` is a replacement that is promoted only once it delivers a quote for the current tokens (make-before-break). Used at every 15-min rollover, for the 25s quiet re-verify and for the silent-link path — so changing subscription never blanks the feed. Two invariants worth knowing before editing: **only the serving socket's frames set `lastMsgMs`** (a standby's handshake and PONGs refreshing it would disguise a black-holed `ws` — which never fires `close` — as alive for up to the 60s ceiling), and **replacement retries go through `scheduleReplacement()`**, an exponential backoff capped at 60s, because a market that accepts the subscription but never sends a book otherwise reconnects every 8s forever against the same host that places orders. **Book levels arrive worst-first on both sides** (bids ascending, asks descending): `bidLiquidity`/`askLiquidity` go through `depthNearTop()` (`src/utils.ts`, also used by the REST `summarizeOrderBook`), which orders best-first before summing five levels. Until commit 31f941c they summed the first five — the depth at 1-5c and 95-99c — which the dry-run FOK check, `orderbookFlow`, arb sizing and cut-loss all read.
- `clobFreshness.ts` — `evaluateClobFeed()`, the pure verdict the bot prices off. Separates "link alive" (any frame, PONG included) from "quotes current" (book / price_change). Returns `live` | `quiet` | `down`.
- `binanceWs.ts`, `chainlinkWss.ts`, `polymarketLiveWs.ts` — BTC price, oracle round, live oracle price. `polymarketLiveWs` (RTDS `crypto_prices_chainlink`) is Chainlink **spot**; since 2026-09-25 it also keeps spot ticks by their own timestamp (`getSpotTicksBetween`) for the settlement estimate.
- `chainlinkTwap.ts` (+ `rtdsTickFeed.ts`, `tickStore.ts`) — Chainlink BTC/USD **60 s TWAP**, RTDS topic `crypto_prices_twap_sixty`, on its own socket: the series the markets settle on. Ticks are stored by the timestamp Chainlink put on them (whole seconds, delivered ~1 s later); `getTwapAt(startMs)` is the price to beat. Traps built in: the filter must be exactly `{"symbol":"btc/usd"}` (a space → replay then silence), one topic per subscribe (a bad topic silences the array), ~3% of seconds never arrive live (a reconnect replays ~60 s: `replay()`), the socket can stall while open (judged on ticks). **RTDS price topics are deprecated — removal expected ~2026-10-23** (one month after `@polymarket/client` 0.11.0); the replacement is PolyBolt `price.crypto.twap` (`wss://ws-live-v2.polymarket.com/ws`, free CLOB API creds via `op:auth`; PolyBolt `price.crypto` spot is Pyth). Until migrated, the API fallback keeps the exact PTB working, a few seconds slower.

#### Market tape (`bot/src/tape/`, added 2026-09-24)
1 Hz record of the book (top `TAPE_DEPTH`=10 levels of both tokens), every `last_trade_price`, BTC from the three feeds and the bot's PTB — the second-resolution history training lacks (the lookup prints ~1/min, orderbook features are neutral for want of history). `marketTape.ts` orchestrates; `clobTapeSocket.ts` is its **own** CLOB socket and L2 book (`bookState.ts`, resynced when the rebuilt top disagrees with the server's `best_bid`/`best_ask`); `tapeWriter.ts` appends one gzip member per minute to `bot/data/tape/YYYY-MM-DD/HH-<bootId>.jsonl.gz`; `s3Store.ts` uploads finished hours (aws4fetch SigV4, path-style; Cloudflare R2 intended) and the file is deleted once stored. Invariants: **every entry point is total** (errors counted, never thrown — the loop calls `setTapeMarket` each poll and a dry-run window must not change), **the tape loses to state.json** (stops writing under `TAPE_MIN_FREE_MB`, evicts its own oldest finished files over `TAPE_MAX_LOCAL_MB`), **a restart never overwrites** (one file per process per hour; lines are routed by `max(t, highest t seen)` so a clock step back cannot reopen an uploaded hour), and **TAPE_S3_* are read only here**, never into `BOT_CONFIG`. `npm run tape:pull` downloads to `backtest/ml_training/tape/` and prints per-day coverage. Setup: docs/RAILWAY.md. The poll broadcast carries `tape: getTapeDashboardStatus(10_000)` for the dashboard's `TapePanel` — this hour and the last full hour (live-book %, trades, decision lines by stage), uploads, local files (listed at most every 10 s). It goes to a public page, so it never includes the bucket host (the R2 host carries the Cloudflare account id): `uploadsConfigured` is a yes/no and upload errors are scrubbed.
**Decision trail (`d` lines, 2026-09-25)**: `decisionTrail.ts` keeps one record per poll — `noteTapeDecision` right after `decide()` in the loop (side, ML P(UP)/confidence, ensemble, edge per side, market prices, phase, time left, regime, session), `noteTapeStage('pre', [...])` when an ENTER is held by a loop precondition, `'arb'`, `'unstable'` (tradePipeline's confirmation hold), `noteTapeFilters` (every `applyTradeFilters` reason, not just the first), `noteTapeEntered` when `executeDirectionalTrade` returns true. The tape writes the last *finished* poll once a second, and every entry immediately. Why: re-running an entry threshold needs the signals the bot really saw and all the gates that held them — most gates depend on live state the tape lacks (2026-09-25 threshold study, `ml_registry` journal). Record-only: no call changes a decision.

#### Bot Engines (`bot/src/engines/`)
- `signalComputation.ts` — Computes all indicators + ML + arbitrage + smart flow per poll. Takes `clobUsable` already decided; it does not judge freshness itself. Takes `featurePipeline` (the loaded model's, from `loop.ts`): for v2 it builds the ML features through `src/engines/ml/featureInputs.ts` (Binance window-open as PTB, token price 60s ago from a timestamped history, neutral rule inputs); for v1 it sends the exact legacy vector
- `tradePipeline.ts` — Execution logic: arb first, then directional (FOK/LIMIT), Kelly sizing
- `orderRouter.ts` — 7-rule decision tree: ML conf + price + spread + momentum → LIMIT/FOK/WAIT
- `limitOrderManager.ts` — Passive GTD order lifecycle: IDLE → PLACED → MONITORING → FILLED/CANCELLED. Anti-loop: max 2 attempts per market slug, 60s cancel cooldown
- `monteCarlo.ts` — GBM risk simulation (1000 paths), bypassed when ML >= 85%
- `settlement.ts` — Oracle query (7 retries), fallback to BTC price comparison, AbortController on market switch. The fallback compares the **TWAP tick stamped at the window end** (`opts.getCloseTwap`, waited ≤3 s) with the PTB; spot only when that tick is missing. Still labelled `price_fallback` so `fallbackVerifier` confirms it.
- `ptbSources.ts` — the one list of exact price-to-beat sources and their ranking (`decidePtb`), read by the entry gate, `ptbHealth` and `loop.ts`'s `offerPtb()` (the only writer of `priceToBeat`). Exact = TWAP-derived: `chainlink_twap`, `polymarket_twap_api`, `polymarket_gamma`, `polymarket_page`, `polymarket_page_prev`. `scheduled_ws` (spot at the boundary) and `data_streams` (the adapter's default feed is spot) are approximations.
- `ptbResolver.ts` — per market: wait for the TWAP tick at the window start (~1 s), ask the socket for a replay at +2.5 s if missing, from +3 s poll `adapters/twapWindowPrice.ts` (`polymarket.com/api/crypto/crypto-price` **with** `&twapEnabled=true&twapLookbackSeconds=60` — without them it returns spot; spaced 5 s, backs off on 429), give up after 5 min (then the market is not traded).
- `twapPhysics.ts` — record-only: P(UP) = Φ((settle − PTB)/(σ·√T_eff)) with the exact TWAP variance horizon, and the 30 s drift of the settlement estimate, written on every tape `d` line as `tp`/`tz`/`dr` (exact PTB only). It changes no decision: twapModelStudy.py found it adds nothing the market lacks in the 2–12 min window and ~8% Brier skill only in the last 15–60 s, to be re-tested on real asks.
- `settlePrice.ts` — what BTC is compared with the PTB by (rule scoring's PTB term via `ptbComparePrice`, filters, cut-loss, limit orders, Monte Carlo): Chainlink spot, and in the last 60 s the expected final TWAP (seconds already seen + current price for the rest). Binance ran **$23.76 above Chainlink** (median over 116k tape snapshots) so it is never compared raw; without Chainlink it is shifted by a tracked basis. ML v2 features are untouched (they are Binance-relative, as in training).
- `preMarketLong.ts` — 09:00-09:15 EST weekdays, always UP, `PREMARKET_LONG_RISK_PCT` of bankroll (0.10 in deployed env, ~8x a normal trade), 1/day. **Disabled 2026-09-20** (`PREMARKET_LONG_ENABLED=false`): 10 Railway dry-run trades, 30% WR, -19.88 — 2.6% of trades, nearly all of the book's profit.
- *(removed 2026-09-25)* The RL bet-sizing bandit (`rlAgent.ts`, `trainRLAgent.py`, its weights, narrative and the v19 shadow capture) never functioned — saturated softmax, constant action, reward loop never closed — and had been off since 2026-09-20. `RL_*` variables are no longer read; old journal rows keep their `rlScalar` fields, which `postTradeAnalyst` / `perfMonitor` still read.

#### Bot Trading (`bot/src/trading/`)
- `positionTracker.ts` — Bankroll, position state, sell lock (45s timeout), mark-to-market, audit log
- `clobClient.ts` — Polymarket CLOB API: FOK + GTD orders, ethers.js v6, ERC-1155 approval
- `cutLoss.ts` — 13-gate evaluator. Philosophy: settlement WR 87.5% >> cut-loss 23.3%, only cut in extremis (>=70% token drop, 720s min hold — `CUT_LOSS_MIN_TOKEN_DROP_PCT` / `CUT_LOSS_MIN_HOLD_SEC`, same in code defaults and `bot/.env`)
- `takeProfit.ts` — 7-gate evaluator (DISABLED — settlement beats early exit)
- `recoveryBuy.ts` — Re-entry after cut-loss: state machine IDLE → SAMPLING → MONITORING → BUY
- `journalReconciler.ts` — On-chain trade verification against CLOB API
- `breakevenMargin.ts` — Win rate vs the win rate needed to break even. **Breakeven is solved from `computeSettlementPnl`, never re-derived.** Since 2026-09-26 that books the CLOB V2 taker fee — `shares × 0.07 × p × (1−p)` at match, win or lose (`settlementMath.takerFee`, docs.polymarket.com/trading/fees) — so breakeven is `p + 0.07·p·(1−p)` (61.68% at 60c). The fee-on-the-winning-profit model it replaced (`p / ((1-p)(1-r) + p)`) was about a quarter of the real fee: breakeven 1.0-1.3pp too low and ROI ~2pp too high, in the bot's P&L and in every backtest (`freshBacktest.py`, `decisionTrailCore.mts`). Rows booked before the change keep their old P&L. `marginReport()` returns `lifetime` and `realistic`; the latter keeps only rows whose entry price reflects a fill a live order would have got (live rows, or dry-run rows marked `entry.fillModel: 'fok_limit'`), so the window is defined by the data rather than by a deploy timestamp that goes stale.

#### Bot Safety (`bot/src/safety/`)
- `tradeFilters.ts` — numbered gates 0-19 (several with a/b/c sub-gates): ML confidence, entry-price floor and 68c ceiling, spreads, time windows, session quality, VPIN, blackout hours, sentiment, macro events, LLM regime (shadow). Filter 0 is `BLOCKED_SESSIONS` (comma-separated, read once at module load): a hard gate placed ahead of every bypass in the module, because high-edge / oracle-lag / ML-confidence bypasses relax *signal* thresholds and a session we chose not to trade is not one. **Time gates are off by default since 2026-09-25** (operator decision: every hour and session trades): the ET blackout hours (filter 10, `BLACKOUT_HOURS_ET` in `src/config.ts`), the weekend ML floor (7) and the two Asia ML floors (1a, 16) only run with `TIME_GATES_ENABLED=true`, and `BLOCKED_SESSIONS` is empty (`,` on Railway, which rejects an empty value). `SESSION_QUALITY` (bet-size multiplier) and the ±1–2pp session threshold nudges in `src/engines/edge.ts` still apply; they block nothing.
- `filterThresholds.ts` — every number `tradeFilters.ts` compares against (48 of them), each with a default, bounds and an env override `FILTER_<NAME>` read once at load. Defaults are the former literals: `__tests__/tradeFilters.golden.test.ts` hashes 20k seeded filter outputs recorded before the move and must stay green. An override that is not a number, out of bounds, or inverts an ordered pair (dead-zone lo/hi, late ML relaxed/min, BTC-distance time bands) is **refused at startup with a warning**, never silently defaulted. Changing one changes trade selection, so during an evaluation window it restarts the window. The dashboard still reads `TRADE_FILTERS` and does not see overrides.
- `guards.ts` — Circuit breaker: max daily loss, max consecutive losses, 4hr cooldown. The daily baseline it measures against rolls over via `positionTracker.rolloverDayIfNeeded()`, called from the poll loop — **not** only from `loadState()`. Before 2026-09-20 it rolled only at process start, so a bot up for 9.5 days was feeding a multi-day P&L to a per-day threshold.

#### Bot Monitoring (`bot/src/monitoring/`)
- `notifier.ts` — Telegram + Discord alerts (rate-limited). Telegram messages get inline buttons: `🔗 View Market` (lifted from an `<a href>` in the text), `📊 View Profile`, `🌐 View Web` (`DASHBOARD_URL`, default the Railway dashboard). The web link never carries `botStatusToken` (it authorises control RPCs and messages get forwarded), and an unusable `DASHBOARD_URL` drops only that button, because Telegram 400s the whole message on one bad button URL.
- `perfMonitor.ts` — Win rate tracking, daily P&L monitoring
- `evaluationReport.ts` — daily Telegram message (at `EVAL_REPORT_HOUR_UTC`, default 00:00) on the evaluation window since `EVAL_WINDOW_START`: realistic-fill WR vs breakeven (`breakevenMargin.ts`), a Wilson 95% interval, a verdict that says "too early" under 30 trades and only calls above/below breakeven when the interval clears it, by session, last 24 h, progress to `EVAL_TARGET_TRADES` (150). Off when `EVAL_WINDOW_START` is unset; record-only. When the window restarts (a deploy that changes trade selection), set the variable to the new deploy time.
- `ptbVerifier.ts` — after each market closes, compares the PTB the bot used with Gamma's `eventMetadata.priceToBeat` (published a minute or two after the close) and records it in `ptb_health.jsonl` as `verified` (checked / exact / mismatch / maxAbsDiff, by source). That is the PTB health number to trust; `exactPct` only says which source label was held. Until 2026-09-25 the label said 99.5% exact while the value matched 0 of 130 markets.
- `driftDetector.ts` — live ML accuracy vs the deployed model's baseline. Only trades made since the deployed `xgboost_model.json` was written count (plus the 21-day age cap), so a model swap does not read the previous model's trades as drift

### Vite Proxy Setup

Dev server proxies to avoid CORS:
- `/gamma-api` → `https://gamma-api.polymarket.com`
- `/clob-api` → `https://clob.polymarket.com`
- `/binance-api` → `https://data-api.binance.vision`
- `/fapi-api` → `https://fapi.binance.com`
- `/bybit-api` → `https://api.bybit.com`

### ML Model — live: `20260924-p2-0d88d4` (feature pipeline v2), deployed 2026-09-24

Every model, its data and its history live in **`ml_registry/`** (see "Model registry" below). The entries that follow keep the notes for the previous model as well — it is retired, not forgotten.

- **Ensemble**: XGBoost + LightGBM, Platt-calibrated on logits. Weights are re-selected on OOF CV each retrain and stored in `norm_browser.json` (`ensemble_weights`) — the runtime reads them from there, so don't hardcode a ratio.
- **Live model `20260924-p2-0d88d4`** (pipeline v2): 14,607 markets 2026-03-28 → 09-23; test acc 76.9%, AUC 0.854, ECE 0.022 (XGB) / 0.034 (ens), weights XGB 0.75 / LGB 0.25; Brier skill vs same-instant market **+7.0%** on its test split but **−2.1%** vs a look-ahead-interpolated market (3,728 unseen rows) — the lookup prints ~1/min, so live truth lies between: market-level, not a proven edge. Head to head vs the previous model: on the 448 Railway dry-run entry instants (fresh prices) Brier 0.2276 vs 0.2583 (CI of the difference [−0.047, −0.014]) but still worse than the market (0.2166); on 1,808 offline markets 0.1588 vs 0.1708. Much better calibrated (claims 71% where the old model claimed 88%, actual 68%). All numbers are `evaluated` events in `ml_registry/journal.jsonl`.
- **Previous model `20260905-p1-3c517d`** (pipeline v1, retired 2026-09-24; notes kept): 79 features (54 base + 25 engineered), 180-day training window. It trained on 12,787 markets from 2026-03-08 to 2026-09-04 UTC, **all** labeled from real Polymarket outcomes (`polymarket_lookup.json`; no simulated labels). The older "86% real labels" figure was v16-era.
- **v1: deployed = trained = Railway** (checked 2026-09-23, while v1 was live): `public/ml/{xgboost_model,lightgbm_model,norm_browser}.json` are byte-identical to `backtest/ml_training/output/` and `candidates/20260905_oof/`, and sha256 matches inside the running Railway container (`railway ssh --service bot -- sha256sum /app/public/ml/...`; pass absolute paths, `sh -c '...'` gets split). No retrain since 2026-09-05. Retraining is manual, so the model does not see markets after its training cutoff until someone runs one.
- **v1 metrics** (deployed 2026-09-05, commit "deploy the OOF-selected model"; source of truth is `public/ml/norm_browser.json` → `ensemble_metrics`): ensemble acc 78.30%, AUC 0.8715, logloss 0.4472, Brier 0.1468, ECE 0.0171, MCE 0.052, weights XGB 0.60 / LGB 0.40 from OOF CV, 1,903 test + 1,343 strict-holdout rows. It replaced the 2026-09-02 model (78.50% / AUC 0.8774 / ECE 0.0328): slightly less sharp, materially better calibrated, and the first whose weights were not chosen on the holdout it reported. Earlier headline numbers (84.07% / holdout 94.12%) predate the embargo + OOF-selection fixes and were measured on a reused holdout — not comparable.
- **Model registry (`ml_registry/`, tracked in git, 2026-09-24)**: `journal.jsonl` is append-only — `registered`, `gate`, `evaluated`, `deployed`, `retired`, `rolled_back`, `note` — and `MODELS.md` is generated from it (never hand-edit). `models/<id>/` holds the gzipped model JSONs, `manifest.json` (source + stored sha256, metrics, data range), and the training CSV/meta/report when they exist; a missing CSV is recorded with the reason. Ids are `<yyyymmdd>-p<pipeline>-<xgb sha6>`, and the registry copy of `norm_browser.json` carries `model_id`, which the bot logs at load and stamps on every trade (`entry.modelId`, `entry.featurePipeline`) — `dryRunReport` splits WR/PnL and "ML vs market" by model. Backfilled from git history (all 17 models ever deployed, with their real deploy dates; Feb–Apr ones as `ref: git <commit>` to keep the repo small) plus four local-only `.bak` models (`archived`). `autoRetrain` registers every trained model (fails closed if it cannot), journals the gate, deploys and rollbacks. CLI: `npm run ml:registry -- list | register | deploy <id> | evaluate | note | render` (logic in `bot/src/modelRegistry.ts`, tested). `ml_registry/` is in `.railwayignore`/`.dockerignore`. The v1 model's training CSV was overwritten on 2026-09-24 before the registry existed — the reason this was built.
- **Pipeline v3 candidate `20260925-p3-53da43` (2026-09-25, NOT deployed, kept in `ml_registry/`)**:
  - **What it is.** The same feature builder, but training market prices come from per-second trade prints (`fetchTradeHistory.mts` / `fetchPricePoints.mts`, the data API: `end` is inclusive, newest first, 10k per page, offset capped at 10k). 14,585 markets.
  - **What it showed about v2.** v2's lookup price had been 10.6c off the fresh print on average, and more than 5c off in 57% of rows.
  - **Gate.** FAIL on `market_skill` −1.5% against the fresh same-instant market; every other check passed.
  - **Head to head on 3,687 markets out-of-sample for both, fresh prices** (`compareFreshModels.py`):
    - Brier: market 0.1520, v2 0.1537, v3 0.1533. No difference is significant.
    - Under the live entry rule v3 almost never trades (8 entries), because it defers to the market.
    - v2 + the live rule: ROI +10.7% (CI +1.3%..+19.5%, n=230), ahead of the no-ML favourite (+2.5%) in both halves.
  - **Decision.** v2 stays live. Training on fresh prices removes the disagreement the live rule trades on; it does not add edge.
  - **Evidence.** `evaluated` events in `ml_registry/journal.jsonl`.
  - **Hybrid (v3 as a veto on v2's entries, `hybridBacktest.py`)**: no. At every v2 entry v3 already gives v2's side ≥ 0.58 (median 0.70), so thresholds up to 0.55 remove nothing; the only one that bites (0.60, second half) removed 5 trades that all won.
- **Storage**: `public/ml/xgboost_model.json` + `lightgbm_model.json` + `norm_browser.json`
- **Inference**: `src/engines/Mlpredictor.ts` — iterative tree traversal, `Float64Array` buffers, named feature splits via `featureNameToIdx` Map
- **One feature builder (feature pipeline v2, 2026-09-23)**: training rows and live features both go through `src/engines/ml/featureInputs.ts` (`buildMlFeatureInputs`, pure in its snapshot) — offline via `trainingRow.ts` (snapshot at a candle close, real window-open PTB, last token print at or before the instant, no interpolation), live via `signalComputation.ts`. `generateTrainingData.mts` no longer re-implements any indicator. Why: the hand-mirrored generator had a 60s BTC look-ahead (candle close, candle-open timestamp), a fake PTB (close 15 candles back), window-open market prices vs live current prices, and a different rule engine; the resulting model reported 78% / AUC 0.87 yet the same-instant market price predicted better (Brier 0.143 vs 0.147), and live it claimed 88% and won 68%. The generator writes `training_data.meta.json` (`feature_pipeline: 2`), the trainer stamps it into `norm_browser.json`, and the bot uses the shared builder only for a model that declares it — code and model ship as a pair. Inputs no offline source has (orderbook, feedback stats, live signal modifiers, funding) are neutral on both sides by design. Live 5m candles are aggregated from the poll's 1m slice (as training does), not taken from the separately cached 5m fetch. Known residuals: rows sit on 1m candle closes, live polls can land inside a forming candle (smaller `delta_1m`) — under-reaction only; and the 60s token-price history is in memory, so for ~60s after a restart mid-market `market_price_momentum` reads 0.
- **Training**: `backtest/ml_training/trainXGBoost_v3.py` — thin entrypoint (argparse + orchestration) over the `mltrain/` package: `features.py` (25 engineered features), `cv.py` (embargoed walk-forward CV), `sweeps.py` (threshold / phase-grid / ensemble-weight selection), `metrics.py` (ECE, confidence buckets, `market_skill` — Brier/logloss skill vs the same-instant market price). Modules take every input explicitly — no module-level mutable state — and are unit-tested.
- **Early stopping follows log loss (fixed 2026-09-26)**: XGBoost stops on the LAST metric of `eval_metric`, and the list was `["logloss", "auc"]` — every fit stopped on AUC. It is now `XGB_EVAL_METRIC = ("auc", "logloss")` in `mltrain/configs.py`, and LightGBM's early stopping has `first_metric_only=True` (its first metric is `binary_logloss`). `tests/test_early_stopping.py` pins the library behaviour. A/B on the v2 training data (no tuning): XGB 103 → 317 trees at the same Brier, LightGBM calibrated Brier 0.1636 → 0.1575 and ECE 0.078 → 0.034, ensemble ECE 0.031 → 0.021. Takes effect at the next retrain. Optuna still maximises CV AUC.
- **What the 2026-09-26 research says about the model** (4 web agents + `residualModelStudy.py` on 203k fresh-price market-minutes): v2 is *worse* than the fresh print in every month, including its training months (Brier skill −1.4% to −2.5%) — it never beat the fresh price, so this is not drift. A market-offset XGBoost (trees learn only the correction to logit(price)) reaches +0.65% on VALIDATE and ≈0 on SELECT; stacking market 0.72 / v2 0.17 / Φ(z) 0.13 reaches +0.80%. Every public study of these contracts lands in the same place (best: 0.0014 nats, CI across 0). What v2 has is *disagreement that pays*: the live rule wins on both sides (VALIDATE UP +10.0%, DOWN +8.0% — not BTC drift). So do not retrain toward the market (the v3 lesson) and do not ship an offset model for +0.5%. The fee turned out to be the bigger error: see "Taker fee" below — the booked model was optimistic, not conservative.
- **Retrain? Not now (tested 2026-09-26 on fresh prices, VALIDATE Sep 1-23).** (1) *Recency adds nothing*: the same pipeline with a holdout of 5% instead of 12.5% (fit 2-3 weeks later) scores Brier +0.0003 [−0.0006, +0.0012] vs the earlier fit. (2) *The early-stopping fix makes a better-calibrated model that trades less*: new-ES vs old-ES Brier −0.0009 [−0.0016, −0.0001], but under the live (softened) rule it takes 269 trades instead of 466 and makes +21 instead of +40 — rule thresholds are sized to a model's confidence scale, so model and rule ship as a pair and a new model needs its own rule selection. (3) `--no-strict-holdout` early-stops and Platt-calibrates on rows it trained on: the resulting model scored −5.8% vs the market (LightGBM ran to 1,200 trees). Production retrains (`autoRetrain.ts`, `runTraining.sh`) keep the strict holdout.
- **Go-live blockers found 2026-09-26 (not ML; dry run is unaffected because it never builds the CLOB client)**: (1) `@polymarket/clob-client` 5.8.1 signs orders with EIP-712 domain version `"1"`; CLOB V2 has been live since 2026-04-28 and "legacy V1 SDKs and V1-signed orders are no longer supported" (docs.polymarket.com/v2-migration) — every live order would be rejected until the bot moves to `@polymarket/clob-client-v2` (pUSD collateral, V2 exchange approvals, `postOnly` is the 4th argument of `createAndPostOrder`). (2) BTC 15m markets have `orderMinSize 5` shares and tick 0.01 — today's ~2-share dry-run stakes could not be placed. (3) The fee model above. (4) `journalReconciler.ts` computes on-chain net P&L without any fee (it parses `feeBps` and never uses it) while local P&L now includes it; if the data API's `usdcSize` is not fee-inclusive, every live trade shows a discrepancy ≈ the fee and the reconciler "corrects" live bankroll back up. Check against a real V2 fill before going live.
- **Validation hygiene**: `--cv-embargo` (default 16 rows = 4h) drops validation rows whose feature lookbacks overlap the training tail at every temporal boundary. ALL selection sweeps run on out-of-fold CV predictions; the 12.5% strict holdout is evaluation-only (multiple-testing fix, ML4T ch16). Soft feature pruning requires a feature to be weak in the final model AND every fold.
- **Deploy gates**: `bot/src/retrainGate.ts` (pure, unit-tested; `autoRetrain.ts` calls it and starts a scheduler on import, so the logic cannot live there) fails closed on: accuracy, AUC, **market_skill** (ensemble `brier_skill_vs_market` > `RETRAIN_MIN_MARKET_SKILL`, default 0 — the model must beat the same-instant price), high-conf accuracy/coverage, ECE, cv-test gap, test-holdout gap, strict-holdout flag, and relative accuracy/AUC drops — the relative pair is skipped (with the reason) across a feature-pipeline change, since pipeline-v1 numbers carried the look-ahead. `tests/test_model_contract.py` reads the gate field names out of `retrainGate.ts` and asserts the trainer exports every one; a field may be absent from the *deployed* model only if the trainer now exports it.
- **Kelly shrink**: bet sizing uses `price + KELLY_PROB_SHRINK × (model − price)` (default 0.5; `computeBetSizing` param `probShrinkToMarket`, dashboard unaffected). `npm run report:dryrun*` prints "ML vs market": claimed vs realised edge, their ratio (= the shrink the results support, shown from 100 rows), and model-vs-price Brier. On the pipeline-v1 model's 438 Railway trades: claimed +24.0pp, realised +4.3pp, ratio 0.18, skill −19%.
- **Key lesson**: `--days 180` optimal (v15 failed with `--days 600` — diluted real labels to 32%). `RETRAIN_DAYS` in `bot/.env` must stay 180.

### Why the bot trades rarely (2026-09-26 — by design, not a bug)

v1 took 20–44 trades/day, v2 takes ~4–8. The ML gate `conf >= 0.65` (p >= 0.825) was sized for the overconfident v1; v2 is calibrated (claims 71% where v1 claimed 88%), so it clears it rarely. The fresh-price backtest that validated the live rule predicted this volume. What was tested to raise it, and why it was not shipped: `ruleSearch.py` (211 rule variants: lower thresholds, edge rules, price bands, unions — none trades ≥1.5× with total PnL ≥ CURRENT out of sample; conf ≥ 0.45 trades 1.36× and makes less), relaxing the 68c cap (buys ~82c favourites: 73.5% WR, −11% ROI), and a TWAP-feature model (`twapModelStudy.py`: no edge where the bot trades). A higher win rate is easy to buy at a higher price and loses money — judge by margin over breakeven. `decisionTrailStudy.mts` section (e) scores candidate ML gates forward on the tape (the edge-bypass variant `FILTER_ML_CONF_RELAXED=0.20` + `FILTER_HIGH_EDGE_BYPASS=0.12` is the one to watch). If more volume is wanted anyway, `FILTER_ML_CONF_MIN=0.45` is the env-only lever — at a lower expected return.

**Softened 2026-09-26 (operator request, env-only):** `FILTER_ML_CONF_RELAXED=0.20`, `FILTER_HIGH_EDGE_BYPASS=0.10`, `FILTER_BTC_DIST_MIN_PCT=0.01` on Railway. Chosen by SELECT total PnL from a declared 10-variant family (2 ML gates × 5 BTC-distance multipliers) on 3,707 fresh-price markets: VALIDATE 20.5 trades/day vs 8.5, ROI +8.6% CI [+2.9%, +14.3%], PnL +40.1 vs +16.9; +2c cost still +6.8% [+1.3, +12.6]; neighbours all positive; top 5 trades 4.7 of 40.1; Monte Carlo P(loss) 0.0%. The backtest's 12pp edge is 10pp on the bot's fee- and ask-adjusted edge. Softening the BTC distance ALONE (with the old ML gate) lowers PnL — the two go together. The daily evaluation report splits trades into "old rule would take" vs "added by softening" (`passedPreSofteningRule`), and `decisionTrailStudy.mts` (e) replays the old gate: the forward test. Revert = delete the three variables.

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
| `tape/YYYY-MM-DD/HH-<boot>.jsonl.gz` | gzip JSONL | Market tape; only hours not yet uploaded (deleted once stored in the bucket) |

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
- **The price to beat is Chainlink's 60 s TWAP, not spot (since 2026-08-07)**: Gamma `cryptoMarketConfig.id = "btc-15m-twap-60"`, resolution source `data.chain.link/streams/btc-usd-twap-60s-streams`. PTB = the TWAP stamped at the window's first second = the previous window's `finalPrice` (129/129). The bot used the spot capture until 2026-09-25: 0 of 130 markets exact, median $9.28 off, max $94, 7 of 129 outcomes flipped. Anything that needs "the price at second T" must read the tick stamped T, not the latest value received. Research and sources: memory `ptb-twap-resolution`.
- **price_fallback is provisional**: the market switch aborts the oracle retries at expiry, so most settlements are booked from Chainlink spot vs PTB while Polymarket resolves on a 60s TWAP (2026-09-07: one Railway row flipped WIN→LOSS). `bot/src/trading/fallbackVerifier.ts` re-checks every `price_fallback` / `unknown` row against the real resolution (`engines/marketResolution.ts`: CLOB by conditionId, then Gamma `GET /markets/slug/<slug>` — the `?slug=` list form returns `[]` for these markets) on a backoff after settlement and in a sweep at startup, rewrites the journal row (`exit.verifiedAt`, `exit.correctedFrom`) and corrects wins/losses/consecutiveLosses via `positionTracker.correctSettlement` (bankroll too for dry-run rows; live bankroll stays with the on-chain reconciler). The report prints the verified/corrected/unverified split.
- **Watchdog liveness**: `scripts/stack-watchdog.ps1` (scheduled every 10 min) also runs `bot/scripts/botLiveness.mts`; a container that is "Up" but has not completed a poll in 10 min gets restarted, and Docker Desktop is restarted if that did not help within 30 min.
- **Taker fee (CLOB V2, verified 2026-09-26)**: `fee = shares × 0.07 × p × (1−p)` per taker fill, charged at match whether the trade wins or loses; makers pay nothing and share 20% of the taker fees as a daily rebate (Gamma `feeSchedule {rate 0.07, exponent 1, takerOnly, rebateRate 0.2}`). Settlement, bankroll and breakeven book it (`polyTakerFeePerShare` / `settlementMath.takerFee`). Entry *selection* — `edge.ts`, `asymmetricBet.ts`, `arbitrage.ts`, and `limitOrderManager.ts`'s Kelly (which also charges makers 80% of the taker rate, though makers pay nothing) — still uses the old `polyFeeRate(p) = 0.072·p·(1−p)` as a rate on profit; switching it changes which trades are taken, so it waits for a planned evaluation-window restart.

### Environment Notes

- Windows (MSYS/Git Bash), `.bashrc` has encoding errors (harmless, ignore)
- Binance FAPI + Bybit both blocked in user's region — funding rate defaults to neutral
- Python 3.13.0, Node 25.1.0, xgboost 3.1.3
- PM2 ecosystem: `ecosystem.config.cts` (512M bot, 512M frontend via `npm run dev`, auto-restart; the `ml-retrain` app is commented out)
