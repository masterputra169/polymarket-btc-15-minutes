# POLY//15 — Update Log

**Purpose:** the single living file for every future change. Add new entries at the top; never rewrite history.
**Time zone:** WIB (Asia/Jakarta) unless stated otherwise.
**Rule:** no passwords, API keys, tokens, private keys, tunnel credentials, or personal secrets in this file.

---

## 2026-11-17 — Log Audit Cleanup (Hot-Path Log Throttle, Dry-Run Reconciler Skip, TWAP Close Settlement Quiet Verify & JEV Outcomes Persistence)

- **Hot-path `50ms` log throttling (`bot/src/safety/tradeFilters.ts`, `bot/src/engines/tradePipeline.ts`):** Rate-limited `[Filter] Filtered`, `[TradePipeline] Signal unstable, holding`, `Fast-entry`, and `Smart filter blocked` to log immediately on reason/key changes and at most once per `5s` (`10s` for `Fast-entry`) instead of `12–20×/s` (`87,192` journal lines observed in 8h) while leaving tape recording (`noteTapeStage` / `noteTapeFilters`) untouched.
- **Dry-run wallet reconciliation skip (`bot/src/trading/journalReconciler.ts`):** `reconcile()` now returns early when `BOT_CONFIG.dryRun` is `true` (eliminating `data-api fetch failed` fallback warnings after every dry-run settlement), and logs HTTP status / error detail when `data-api` fails in live mode.
- **Quiet `twap_close` fallback settlement (`bot/src/engines/settlement.ts`):** When fallback settlement uses `priceSource === 'twap_close'` (verified `8/8` matching Oracle) with `>= 0.05%` PTB gap, logs `Settlement twap_close` at `info` level without firing noisy `price_fallback` Telegram warnings; razor-close (`< 0.05%`) and non-TWAP fallbacks still warn and notify.
- **Persist JEV window outcomes (`bot/src/ai/jevAdvisor.ts`, `bot/src/ai/__tests__/jevAdvisor.test.ts`):** Added atomic `persistJevOutcome()` into `jev_outcomes.json` when initialized in runtime (disabled in `resetJevAdvisorForTests()`) and expanded `warmLoadBrierHistory()` scan tail so `brierGuard` survives restarts with fresh resolved outcomes.
- **VPS `.env` & security skill setup (`polyvps:/opt/polybtc15/bot/.env`, `.agents/skills/security-audit`):** Synced legacy `FILTER_ML_CONF_RELAXED=0.25`, `FILTER_HARD_ML_FLOOR=0.25`, and `FILTER_MID_PHASE_MAX_PRICE=0` in VPS `.env` to match the active `20261116-p2-ef8dfd` profile, and installed Cloudflare's `security-audit` skill.

## 2026-11-17 — JEV Layer v3 Upgrade (10-Bin Laplace Calibration, Bayesian Prior Anchoring, TypeSafe Risk Desk `score` & Brier Skill Guard)

- **10-bin Laplace + PAVA + piecewise `lerp` calibration (`bot/src/ai/jevSettleCalibration.ts` → `2026-11-17-laplace10-lerp`):**
  - Replaced `2026-10-26-pava-70` (which clamped every raw `0.08..0.86` probability to `0.4462` and prevented UP signal agreement) with 10-bin Laplace Beta(1,1) + PAVA monotone blocks and smooth linear interpolation (`lerp`) across bucket centers (`0.05..0.95`, `fitLaplaceCalibrationBins()` + `calibrateWithBins()`), adapted from `skharchikov/polymarket-bot/trading-bot/src/calibration.rs`.
  - Validated on chronological 70/30 OOS split across `2,429` resolved VPS `jev_log.jsonl` markets (`1,700` train / `729` OOS): raw Brier `0.25438` → old `pava-70` `0.24884` → **`laplace10-lerp` `0.24031`** (log-loss `0.70711 → 0.69082 → 0.67364`; `jev_decision.jsonl` `720`-mkt OOS Brier `0.25014 → 0.23593`).
- **Bayesian log-odds prior anchoring, Composite Risk Desk & Rolling Brier Skill Guard (`bot/src/ai/jevBayesian.ts`):**
  - Implemented `probToOdds`, `oddsToProb`, `dampenLr` (`LR^confidence`), and `computeBayesianAnchor` (`skharchikov/bayesian.rs`) anchoring calibrated JEV probabilities onto live `market_odds.up` (`JEV_BAYESIAN_MAX_WEIGHT=0.20`, OOS Brier `0.23447` vs `0.23454` raw market).
  - Implemented TypeSafe Composite Risk Desk (`computeCompositeRiskScore`: weighted `chopHazard` `0.40`, `exhaustionRisk` `0.35`, `flowContradiction` `0.25`) and 3-zone routing (`routeJevDecision`: `risk_veto` / `confident` / `uncertain_passthrough`, keeping `1arley/jev-advisor-gateway` fail-safe pass-through).
  - Implemented `evaluateBrierSkillGate` (`JEV_BRIER_GATE=true`, `window=100`, `minSamples=30`), automatically demoting active JEV veto/gate/sizing overrides whenever rolling JEV Brier trails market mid (`JEV_MODE=shadow` stays active in production while `v3` collects forward data).
- **v3 State, Risk Desk `score` Questions, Timing & Loop Settlement Hook (`bot/src/ai/jevAdvisor.ts`, `bot/src/config.ts`, `bot/src/loop.ts`):**
  - Fixed `buildJevState()` (`independent_v3` / `collaborative_v3`) to expose live `order_flow` microstructure (`vpin`, `ofi`, `microprice_edge_pct`, `depth_imbalance`, `top_imbalance`, `trade_imbalance`), `order_book` (`spread`, `bid_liquidity_usd`, `ask_liquidity_usd`), `settle_distance_to_ptb_usd` (Chainlink TWAP settle distance vs PTB), `binance_chainlink_basis_usd`, `twap_physics_z` / `twap_prob_up`, and Hybrid residual telemetry under `algo_view` (`independent=true` still strips `algo_view` cleanly).
  - Extended `buildJevQuestions()` with three atomic 5-level TypeSafe `score` questions (`chop_hazard`, `exhaustion_risk`, `flow_contradiction`) evaluated in the same System One call, backward-compatible `parseJevAnswers()`, `maxTimeLeftMin=14.2` early-noise gate (`~48s` open buffer), warm Brier loading in `initJevAdvisor()`, and exact TWAP close outcome recording via `verifyClosedMarketPtb()` → `recordJevWindowOutcome()`.
- **Dashboard telemetry (`src/components/JevPanel.tsx`, `src/App.tsx`):** Surfaced `bayesianProbUp`-prioritized `Settle UP`, color-coded `Risk Desk` composite hazard score (with breakdown tooltip), and Rolling Brier Skill badge (`BS WARM` / `PASS` / `DEMOTED`).
- **Tests (`bot/src/ai/__tests__/jevBayesian.test.ts`, `jevSettleCalibration.test.ts`, `jevAdvisor.test.ts`):** Added unit and end-to-end Brier auto-demotion coverage (`40` JEV AI tests passing across `5` files).

## 2026-11-17 — Remove Daily Profit Target Feature & Dashboard Target Bar

- **Bot safety & loop removal (`bot/src/safety/dailyProfitTarget.ts` deleted, `bot/src/loop.ts`, `bot/src/config.ts`, `bot/src/statusServer.ts`, `bot/src/trading/journalAnalytics.ts`):** Removed `dailyProfitTargetUsd` (`DAILY_PROFIT_TARGET_USD`), sticky WIB `profitTargetPaused` entry blocks across limit/arb/pre-market/directional gates, `resetProfitTarget` RPC handler, and `profit_target.json` reset creation (also cleaned `profit_target.json` and `DAILY_PROFIT_TARGET_USD` from local & VPS runtime configs so the false `+$30.00 / $30.00` dry-run pause never halts trading).
- **Dashboard UI (`src/components/BotPanel.tsx`, `src/App.tsx`):** Removed `Target` progress bar from `Position & Book` in `BOT CORE` (`BotPanel`) and dropped `profitTarget` / `profitTargetPaused` from snapshot memoization.
- **Tests (`bot/src/trading/__tests__/journalArchives.test.ts`):** Updated session archive reset expectations after removing `profit_target.json` creation.

## 2026-11-17 — Live CLOB Hardening (`GhostGuard`, Outage Latch, Warmup/Heartbeat), Pessimistic Queue Sim & GitHub Research Studies

- **Ghost-fill defense (`bot/src/trading/ghostGuard.ts`, `bot/src/trading/fillTracker.ts`, `bot/src/loop.ts`):** Added real-time `OrderBookTrade/GhostGuard` anomaly scoring (`scorePredictiveGhostFill`, `>= 0.65` warning after 5 samples) and non-blocking Polygon `eth_getTransactionReceipt` verification on matched trade `transaction_hash`es (`real` vs `ghost` `0x0` vs `pending` vs `rpc_error`). Confirmed on-chain reverts trigger immediate rejection (`ghostFill: true`), open-order cancel (`GHOST_GUARD_AUTO_CANCEL`), and position unwind instead of trusting ghost CLOB fills.
- **CLOB taker-outage cooldown latch (`bot/src/trading/clobOutageLatch.ts`, `bot/src/trading/clobClient.ts`, `bot/src/engines/tradePipeline.ts`):** Added self-expiring `90s` fail-open latch (`max 120s`, `djienne/clob_health` pattern) when order POSTs hit `post_only_mode`, HTTP `425`, or `503` so both live and dry-run skip attempts until exchange matching recovers.
- **CLOB V2 warmup & Dead-Man's-Switch (`bot/src/trading/clobClient.ts`, `bot/src/loop.ts`, `bot/index.ts`):** Verified `@polymarket/clob-client-v2@1.2.0` natively exposes `getClobMarketInfo()` and `postHeartbeat()`. Added deduplicated `warmupMarketMetadata(conditionId)` on market discovery and `syncClobHeartbeat()` (`4s` keepalive while resting open orders exist, opt-in via `CLOB_HEARTBEAT_ENABLED=true`, stopped cleanly on shutdown).
- **Pessimistic `queue_ahead` & quote freshness separation (`bot/src/engines/queueSim.ts`, `bot/src/streams/clobWs.ts`, `bot/src/engines/tradePipeline.ts`):** Added `getLastBookQuoteMs()` updated strictly on `book`/`price_change` (excluding `last_trade_price`), `queueSim.ts` FIFO queue-ahead simulator with `> 500ms` stale-book cancellation (`ItzJulkar` rules), shadow `queueAheadShares` / `queueBookFresh` telemetry in journal entries, and opt-in `DRY_RUN_QUEUE_SIM=true`.
- **Empirical GitHub studies (`backtest/ml_training/logitMicroStudy.py`, `cross5m15mStudy.mts`, plus `npm run tape:pull -- --since 2026-11-16`):**
  - `logitMicroStudy.py` (`63,952` rows / `5,074` mkts, `999`-mkt OOS Val): adding `holypolyfoundation/bs-p` logit-spread / VWM / curvature features (`Acc 74.49% / AUC 0.8308 / Brier 0.1678`) gave zero improvement over live `v4-hybrid-20261116` (`Acc 74.50% / AUC 0.8308 / Brier 0.1678`) and reduced 50–65c Taker PnL (`+$4.75 → -$0.06`), while `djienne` curved edge (`1 - (1 - p)^alpha`) lost money (`-$4.55` to `-$11.21`) — so both were cleanly rejected from live inference.
  - `cross5m15mStudy.mts`: live Polymarket `5m + 15m` boundary probe showed naive `ask5 + ask15 < 1` can trap `PTB_5m > PTB_15m` gap risk (observed on BTC/ETH `0.991`), while true PTB-covered butterfly opportunities (`SOL 5m_UP 96c + 15m_DOWN 0.1c = net 0.964`, `+3.62%` edge net of V2 fees) do appear near aligned window boundaries.

## 2026-11-17 — Fix GTD Limit Adverse-Selection JOIN & Edge Math, Hybrid Journal Telemetry & Retrain Coupling

- **Fix GTD Limit order adverse selection & `limitEdge` bug (`bot/src/engines/limitOrderManager.ts`, `bot/src/loop.ts`):**
  - Replaced the `-12%` deep-discount quote formula (`computeTargetPrice`) with `makerJoinPrice(bestBid, bestAsk, minPx, 0.01)` and passed `bestAskUp`/`bestAskDown` from `loop.ts`.
  - Fixed `evaluateLimitEntry` `limitEdge` calculation from `mlConfidence - targetPrice < 0.05` (which compared normalized confidence against token price and blocked calibrated `0.30` Hybrid entries) to `sideProb - targetPrice` where `sideProb = 0.5 + mlConfidence / 2` against `cfg.minRemainingEdge` (default `0.03`).
  - Backed by 1 Hz tape replay across `135/135` Hybrid v4 entry signals: `DISC_12PCT` `15s` suffered `-28.52%` adverse selection (`38.9%` filled WR, `-$9.13` SKIP), whereas `JOIN 15s` achieved `60.0%–68.1%` fill in `1.2–2.0s` median with `+6.18%..+7.46%` SKIP ROI (`+$13.08..+$15.58` w/ 5% FOK fallback); `45s JOIN` degraded SKIP to `+$5.37..+$12.07`.
- **Expose `maxEntryPrice` & `maxUnfilledSec` in profiles & UI (`bot/src/ml/modelProfiles.ts`, `src/components/ModelProfileDrawer.tsx`, `bot/data/model_profiles.json`):** Added bounds (`maxEntryPrice`: `0.45–0.75`, `maxUnfilledSec`: `10–120`) and configured `20261116-p2-ef8dfd.limitOrder` with `{ minMlConfidence: 0.30, maxEntryPrice: 0.64, maxUnfilledSec: 15 }`.
- **Hybrid journal telemetry (`bot/src/engines/tradePipeline.ts`, `bot/src/loop.ts`):** Persisted `baseMlProbUp`, `hybridDeltaProb`, `hybridActive`, and `hybridId` in `entryData` and `buildDecisionSignalBlock()` for both FOK and GTD LIMIT entries.
- **Retrain pipeline coupling (`bot/src/autoRetrain.ts`, `backtest/ml_training/runTraining.sh`):** Added `hybrid_residual_v4.json` to backup/prune/rollback and added automatic post-deploy overlay refresh (`buildTapeV4Dataset.mts --skip-network` + `exportHybridResidualV4.py` when `tape/` exists).
- **Ensemble `alpha` verified & kept (`3,674`-market 39d WF OOS):** Raising Hybrid ML weight hurt OOS PnL (`hyb_065` `+$11.34`/`+$14.59`, `hyb_075` `+$7.82`/`+$14.31`, `hyb_085` `+$11.50`/`+$12.18`, `pure_ml` `-$4.11`/`-$3.23`) vs keeping `src/engines/ml/ensemble.ts` `current` (`+$14.81` Taker `67.41%` WR / `+$21.51` Maker `66.55%` WR), so `ensemble.ts` remains unchanged.
- **Verification & unit tests (`limitOrderManager.hybrid.test.ts`, `modelProfiles.test.ts`, `tradePipeline.dryRunFill.test.ts`, `limitOrderJournal.test.ts`):** Covered `makerJoinPrice` JOIN pricing, `sideProb = 0.5 + mlConfidence / 2` `limitEdge` check, `maxEntryPrice`/`maxUnfilledSec` profile schema sanitization, and Hybrid journal snapshot persistence (`110` files / `1,058` vitest PASS, `npm run typecheck` PASS, `vite build` & `study:build` PASS).

## 2026-11-16 — Calibrate `20261116-p2-ef8dfd` Profile & Router Floors for Live Hybrid v4 (`30%` Conf)

- **Why:** In 54d 1 Hz tape OOS checks, `v4-hybrid-20261116` calibrates ECE down to `0.97%–1.41%` (vs `4.1%–4.3%` on base `v2`), so its 99th-percentile confidence inside the `50c–65c` band is `35.9%` (`P=68%`). Keeping legacy `v2` thresholds (`mlConfMin=0.55`, `hardMlFloor=0.45`, `ROUTER_LIMIT_ML=0.45`, `lateMlMin=0.80`, `midPhaseMaxPrice=0.62`) blocked nearly every calibrated entry (`0` entries over `999` recent markets / `10.5d`).
- **Threshold calibration (`bot/data/model_profiles.json` local & VPS):** Tuned `20261116-p2-ef8dfd` profile (`All-Time 395d + Hybrid v4 (30% · 65c)`) based on 39d 6-fold walk-forward OOS (`3,674` markets) + 10.5d Prod Val (`999` markets): `filters.mlConfMin=0.30`, `mlConfRelaxed=0.25`, `hardMlFloor=0.25`, `lateMlMin=0.35`, `lateMlRelaxed=0.28`, `trendingMlWith=0.32`, `trendingMlAgainst=0.42`, `midPhaseMaxPrice=0`, `orderRouter.limitMlThreshold=0.30`, `limitOrder.minMlConfidence=0.30` while preserving `65c` price discipline.
- **Plumbing & UI bounds (`bot/src/ml/modelProfiles.ts`, `bot/src/config.ts`, `src/components/ModelProfileDrawer.tsx`):** Lowered `orderRouter.limitMlThreshold` / `limitOrder.minMlConfidence` min bounds from `0.35`/`0.40` → `0.20`, lowered drawer HTML min bounds for ML confidence fields to `0.20`, and surfaced `midPhaseMaxPrice`, `trendingMlWith`, and `trendingMlAgainst` in `UI_FILTER_KEYS` and the profile drawer.

## 2026-11-16 — Study Portal Changelog Parser (`##`/`###`) & Live Hybrid v4 Cards

- **Changelog parser fix (`scripts/build-study-site.mjs`):** `parseUpdatesMd()` now parses both dated `## YYYY-MM-DD...` release headings and `### ...` entries while skipping the `## Current status` summary block cleanly, so all recent 2026-11-16 entries render at the top of `updates.json` / the `Changelog` tab on https://poly15-study.dollarkilat.xyz/.
- **Live Hybrid v4 metadata (`scripts/build-study-site.mjs`, `study-site/app.js`):** `buildStage2Bundle()` reads `public/ml/hybrid_residual_v4.json` (metadata/metrics/gains only, without embedding raw trees) into `stage2.json` (`liveHybridArtifact`) and `site.json` (`activeModelSummary.hybridOverlay`), and `Overview` + `Tahap 2 · v4 Lab` display the active `v4-hybrid-20261116` (`412` depth-2 trees) validation Acc/AUC/Brier/ECE/parity metrics alongside the active `20261116-p2-ef8dfd` base model.
- **Tests (`bot/src/__tests__/studySiteBuilder.test.ts`):** Extended `parseUpdatesMd` and `buildStudySite` unit assertions for mixed `##`/`###` release headers and `stage2.json.liveHybridArtifact`.

## 2026-11-16 — Live Pipeline v4 Hybrid Residual Overlay (`v4-hybrid-20261116` / Option 3)

- **Exported Production Hybrid Residual Overlay (`backtest/ml_training/exportHybridResidualV4.py`, `public/ml/hybrid_residual_v4.json`):**
  - Trained and exported **412 depth-2 XGBoost residual trees** (`197.1 KB`) anchored on `requires_base_model_id = "20261116-p2-ef8dfd"` (`base_margin = logit(v2_prob_up)`) over chronological 80%/20% market-grouped split (`64,963` snapshots / `5,074` resolved markets, 16-market embargo: `4,059` Train / `999` Val markets through `2026-11-16 11:45Z`).
  - Uses exact `13` Chainlink-native + TWAP + L2 orderbook residual features (`v2_minus_mkt_logit` `40.20%` gain, `oracle_ptb_dist_pct` `13.33%`, `basis_drift_pct` `7.33%`, `twap_physics_z` `6.44%`, `crowd_model_divergence` `5.58%`, `market_yes_price` `5.40%`, plus `basis_pct`, `cross_feed_lead`, `orderbook_imbalance`, `spread_pct`, `imb1`, `imb5`, `minutes_left_norm`).
  - Exported exact IEEE float32 split thresholds (`normalize_tree_f32`) with verified float32 traversal parity vs XGBoost C++ (`max_abs_diff = 3.16e-07 < 1e-5`).
  - Validation slice (`12,647` rows across newest `999` markets) improved `20261116-p2-ef8dfd`: Accuracy `73.68% → 74.93%` (`+1.25pp`), AUC `0.8252 → 0.8355` (`+103bp`), Brier `0.1723 → 0.1653`, LogLoss `0.5150 → 0.4954`, ECE `0.0411 → 0.0141`.
- **Live Bot + Dashboard Integration (`src/engines/ml/hybridResidual.ts`, `src/engines/Mlpredictor.ts`, `src/engines/ml/treeEval.ts`, `src/data/polymarket.ts`, `bot/src/config.ts`, `bot/src/adapters/mlLoader.ts`, `bot/src/engines/signalComputation.ts`, `bot/src/loop.ts`, `src/App.tsx`, `src/components/MlPanel.tsx`):**
  - Enabled by default (`ML_HYBRID_RESIDUAL_ENABLED !== 'false'`). Safely enforces `requires_base_model_id` — automatically stands down if the operator hot-swaps to an older registry model and re-activates when `20261116-p2-ef8dfd` is loaded.
  - Exposes level-1 `bidSize`/`askSize` on REST orderbook summaries cleanly alongside CLOB WS, passes `hybridInputs` when `clobUsable` and valid book prices exist, and surfaces live `baseProbUp → probUp (±X.Xpp)` in `ML Engine` + `[v4 HYBRID LIVE]` badge.
  - Added [hybridResidual.test.ts](bot/src/engines/__tests__/hybridResidual.test.ts) verifying exact logit arithmetic, model-id lock guard, toggle switch, and live loading atop `20261116-p2-ef8dfd`, plus bumped `studySiteBuilder.test.ts` bundle test timeout (`20s`) with `./data/stage2.json` assertions.

---

## 2026-11-16 — Tahap 2: Pipeline v4 Chainlink-Native Upgrade, 54d Tape Evaluation & Stage 2 Menu

- **Full 54-Day 1 Hz Market Tape Pull & Extraction (`bot/scripts/tapePull.mts`, `backtest/ml_training/buildTapeV4Dataset.mts`):**
  - Added 12-worker concurrent R2 downloads, day-by-day memory-bounded stats (`--pull-only`, `--concurrency`), and pulled the complete 54-day Market Tape archive (`2026-09-24 .. 2026-11-16`, **1,408 files / 800.1 MB**, **4,587,177 1 Hz snapshots**, `89.2%` live L2 book, `100%` oracle, `97.3%` TWAP 60s across **5,076 unique resolved markets**, `4,939` exact PTB, `4,469,981` decision lines, `243` cross-feed blocks / `107` flips).
  - Measured empirical Binance − Chainlink basis across the 54-day tape: median **`+$90.42`** (`P05 = $14.27`, `P95 = $133.53`; near-PTB abs skew median `$6.61`, `P95 = $33.69`).
  - Built aligned Pipeline v4 datasets (`tape_v4_panel.csv` with **67,948 decision-second rows** across 5,076 markets; `training_data_v4.csv` with **4,937 single-per-market rows**, `63` base + `25` engineered = `88` features).
- **Pipeline v4 Chainlink-Native Contract & Live Telemetry (`src/engines/ml/`, `bot/src/engines/`):**
  - Added `FEATURE_PIPELINE_V4 = 4` (`V4_CHAINLINK_FI` in `featureMap.ts`, `computeChainlinkNativeFeatures` in `featureInputs.ts`): `[58] oracle_ptb_dist_pct`, `[59] twap_physics_z`, `[60] basis_pct`, `[61] basis_drift_pct`, `[62] cross_feed_lead`, plus live L2 `orderbookImbalance` & `spreadPct` enabled strictly for `featurePipeline >= 4` (leaving live `20261116-p2-ef8dfd` `v2` vectors unchanged).
  - Fixed `featureExtract.ts` buffer capacity to `96` slots and isolated legacy SM `[54..58]` strictly to `BASE_FEATURES === 59 && featurePipeline < 4` to prevent offset collisions with `58`-base Quant and `63`-base Pipeline v4.
  - Added `computeOracleDeltaWindowRatio` (`settlePrice.ts`) and live `v4Signals` emission in `signalComputation.ts` + `loop.ts`.
- **Stage 2 Empirical Evaluation (`backtest/ml_training/trainStage2PipelineV4.py`, `analysis/2026-11-16/tahap2-pipeline-v4-study.md`):**
  - Strictly market-grouped OOS evaluation (`64,963` filtered snapshots / `5,074` markets → `3,044` Train / `761` Val / **`1,237` strict Test OOS** `2026-11-03 .. 2026-11-16`, 16-market embargo):
    - **Normal window (`12m → 2m` left, `12,454` rows):** Baseline `v2` (`75.20%` Acc, `0.8397` AUC, `0.1656` Brier, `ECE 0.0439`, `-4.12%` skill vs fresh CLOB mid) → **Pipeline v4 Hybrid Residual** (`75.97%` Acc, `0.8468` AUC, `0.1597` Brier, `ECE 0.0177`, closing 90% of the Brier gap vs market mid) & **Calibrated Stack** (`76.17%` Acc, `0.8478` AUC, `0.1590` Brier, `+0.03%` skill, `ECE 0.0130`). Confirms `twapModelStudy.py`: Chainlink/TWAP does not beat market mid outright in 2–12m because CLOB makers track Chainlink + TWAP, while eliminating basis-drift error relative to Binance-only `v2`.
    - **Final minute (`15s–45s` left, `363` rows):** Baseline `v2` (`80.99%` Acc, `0.9014` AUC, `0.1277` Brier) → **Pipeline v4 Standalone** (`87.33%` Acc, `0.9477` AUC, `0.0903` Brier) & **Calibrated Stack** (`87.05%` Acc, `0.9509` AUC, `0.0874` Brier, `+0.26%` skill vs mid).
    - **Feature Attribution:** Top 2 features by XGBoost gain across all 88 features in `v4 Standalone` are **`#1 oracle_ptb_dist_pct` (`15.44%`)** and **`#2 twap_physics_z` (`15.44%`)**, followed by **`#6 basis_drift_pct` (`1.41%`)**. Production model remains **`20261116-p2-ef8dfd` (395d Quant)** as 4,937 single-row tape markets (Holdout `73.7%` Acc / `0.8216` AUC) remain 7x smaller than the 395d archive.
    - **Real L2 Ask Execution Replay (CLOB V2 taker fee):** On `58c Cap / Edge >= 6%`, **Gate 20f** blocked `42` mismatched markets (`48.15% → 52.38%` WR, cutting loss `71%` from `-$21.73 → -$6.30`, DD `$23.89 → $13.34`). On `65c Cap / Edge >= 6%`, `v4 Hybrid + Gate 20f` achieved **`80.0%` WR (`+15.97pp` margin above BE, `+$5.35` / `+26.77%` ROI, PF `2.30`)** over `10` strict-OOS filtered trades.
- **"Menu Tahap 2" UI (`study-site/`, `scripts/build-study-site.mjs`, `scripts/study/stage2_snapshot.json`, `src/components/MlPanel.tsx`, `src/App.tsx`):**
  - Added dedicated **`Tahap 2 · v4 Lab`** tab to `poly15-study.dollarkilat.xyz` (`./data/stage2.json`) with 54d Tape Coverage & Basis SVG chart (`drawTapeCoverageChart`), Normal vs Final-Minute Brier bar comparison (`drawStage2WindowBars`), Cross-Feed diagnostics, 5 Chainlink-Native feature cards, Real Ask + Gate 20f replay table, and gain/stack tables.
  - Added collapsible **`Tahap 2 · Chainlink-Native (v4)`** live telemetry drawer inside `ML Engine` on the terminal (`MlPanel.tsx`) displaying live `oracle_ptb_dist_pct`, `twap_physics_z`, `basis_pct`, `basis_drift_pct`, `cross_feed_lead`, and pipeline badge.

---

## 2026-11-16 — Study Portal DOM Null-Safety Hardening & CSP Script-Src Update

- **DOM Null-Safety & Cache-Race Hardening (`study-site/app.js`, `study-site/charts.js`, `study-site/markdown.js`):**
  - Added strict null guards (`if (!container) return;`) across all 9 SVG chart renderers in `study-site/charts.js` (`drawEquityChart`, `drawMetricBars`, `drawTierCurve`, `drawPhaseThetaChart`, `drawEvolutionChart`, `drawCalibrationCurve`, `drawConfidenceBuckets`, `drawPhaseResponseCurve`, `drawFeatureImportanceBars`) and in `study-site/markdown.js` (`renderMarkdown`).
  - Upgraded all `element.replaceChildren()` invocations in `study-site/app.js` to safe optional chaining (`element?.replaceChildren()`). This completely immunizes the portal against browser cache desynchronization (e.g., when an older cached `index.html` loads alongside newer `app.js` or before elements attach to the DOM).
- **Nginx Content-Security-Policy Script-Src Update (`scripts/nginx-polybtc15-study.conf`):**
  - Added `'unsafe-inline'` to `script-src` alongside `'self'` and `https://static.cloudflareinsights.com`. This allows Cloudflare's edge-injected Bot Challenge Platform (`/cdn-cgi/challenge-platform/...`) and analytics beacons to run cleanly without triggering inline script violation warnings in client browser DevTools.
- **Verification:**
  - `bot/src/__tests__/studySiteBuilder.test.ts` passed (4/4 tests).
  - Static bundle successfully compiled via `scripts/build-study-site.mjs` into `study-dist/`.
  - Full TypeScript typecheck passed cleanly (`npm run typecheck`).
  - Monitored `vps.dollarkilat.xyz` showing 19 managed units active and healthy.

---

## Current status

_Last updated: 2026-11-17 10:21 WIB_

| Area | State |
|---|---|
| Bot | active, **DRY RUN (DRY_RUN=true)**; evaluating All-Time Quant + Live Hybrid Residual v4 ($100 fresh test) |
| JEV / TypeSafe layer | **v3 LIVE in SHADOW** (`typesafe/jev-1.14` via OpenRouter, `JEV_MODE=shadow`, `independent_v3` state w/ order flow + Chainlink TWAP distance + Risk Desk 3× `score`, `2026-11-17-laplace10-lerp` cal + Bayesian prior anchor + Rolling Brier Skill Guard) |
| ML model | **`20261116-p2-ef8dfd` + `v4-hybrid-20261116` Overlay LIVE** (`83f` v2 base + `412` depth-2 Chainlink/TWAP/L2 residual trees; `ML_HYBRID_RESIDUAL_ENABLED=true`) · Val Acc `73.68% → 74.93%`, AUC `0.8252 → 0.8355`, Brier `0.1723 → 0.1653`, ECE `0.0411 → 0.0141` (parity `3.16e-07`) |
| Pipeline v4 / Stage 2 | **Hybrid Residual v4 LIVE + 54d Tape Lab** (`4,587,177` 1 Hz snapshots / `5,076` resolved mkts `2026-09-24 → 2026-11-16`) · Normal window OOS `75.97%` Acc / `0.1597` Brier; Final 15–45s `87.33%` Acc (`v4 Standalone`) & `0.0874` Brier (`v4 Stack`) |
| ML previous (395d / 365d / 180d) | **`20261115-p2-c3e0fd` (`395d` 83f)**, **`20261115-p2-5de02d` (`365d` 79f)** & **`20261114-p2-9384fe` (`180d` 79f)** — all available for 1-click hot-swap |
| Model switcher | **Live in dashboard (`ML Engine` panel)** · `20261116-p2-ef8dfd` profile tuned for Hybrid v4 (`mlConfMin=0.30`, `hardMlFloor=0.25`, `lateMlMin=0.35`, `limitMlThreshold=0.30`, `midPhaseMaxPrice=0`, `50c–65c` band) |
| Live bankroll | $13.15 (pUSD) · 11 trades total (4W / 7L, 36.4% WR) |
| Paper bankroll | **$100.00 fresh test run (0W / 0L)** · prior 926-trade history (`589W / 337L`, end `$17.53`) preserved in `bot/data/archive_20261116_pre_alltime_100/` + viewable in dashboard |
| Entry price cap | **65c widened cap (`50c–65c` band)** for `20261116-p2-ef8dfd` + Hybrid v4 (`softEntryCap=0.65`, `baseHardCap=0.65`, `trendingHardCap=0.65`, `ultraMlCap=0.68`, `midPhaseMaxPrice=0`, `DRY_RUN_HARD_ENTRY_CAP=0.65`) |
| Trade sizing | **5 shares min fixed (`FIXED_SHARE_SIZE=5` pre-validation bug fixed)** — resolved `Bet too small < $0.50` & `0 shares` deadlock when Kelly output < `$0.50` (`tradePipeline.ts`) |
| Early window | **13.5m ceiling** (`FILTER_DRY_RUN_MAX_TIME_LEFT=13.5`, `FILTER_TRENDING_MAX_TIME_LEFT=13.5`, enables cheap 50-65c early & trending entry discovery) |
| Order router | **Limit JOIN 15s + GhostGuard + Outage Latch** (`LIMIT_ORDER_ENABLED=true`, `ORDER_ROUTER_ENABLED=true`, profile `limitOrder: { minMlConfidence: 0.30, maxEntryPrice: 0.64, maxUnfilledSec: 15 }`, `GhostGuard` tx receipt checks, `90s` `425`/`post_only_mode` latch, `warmupMarketMetadata`, `queueSim` telemetry + opt-in `DRY_RUN_QUEUE_SIM`) |
| Blocked sessions | **Europe blocked** (`BLOCKED_SESSIONS=Europe`, eliminated historical -$38.72 leak) |
| Hard ML floor | **25% Hybrid floor (profile override)** (`hardMlFloor=0.25` overrides `.env` `0.45` for `v4-hybrid-20261116`; `mlConfMin=0.30`) |
| Mid-phase guard | **65c unified ceiling (Hybrid profile)** (`midPhaseMaxPrice=0` overrides `.env` `0.62` for calibrated Hybrid v4 entries in 5–11m MID window) |
| Trending protection| **50c–65c band** (`trendingMinToken=0.50`, `trendingMaxPrice=0.65`, widened from 54c–58c 4c slit) |
| Microstructure gates | **Gate 20a–20e active** (`FILTER_MIN_PATH_EFFICIENCY=0.08`, `FILTER_MIN_PEAK_GAP_RATIO=0.55`, `FILTER_MAX_OPPOSING_OB_IMBALANCE=0.30`, `FILTER_MAX_OPPOSING_TAKER_300S=0.22`, `FILTER_BLOCK_OPPOSING_LEAD_LAG=1`) |
| Quant signals | **300s/60s Taker Ratio + Deribit DVOL + 3s Lead-Lag** (`15/180` fast confirm on 3s BTC impulse, `60/180` on R4 5m taker surge, Deribit IV `pIv` in `twapPhysics`) + 4 ML features embedded directly (`QUANT_FI` 83f) |
| High-edge fast-entry | **90/180 polls** (`Math.ceil(SIGNAL_CONFIRM_POLLS / 2)`, fixed legacy `SIGNAL_CONFIRM_POLLS - 1` = `179/180` bug) |
| Circuit breaker | tightened: max daily loss 15%, max drawdown 25%, max 3 consec losses, cooldown 2hr |
| Dashboard | https://poly15.dollarkilat.xyz/ · 16 widgets · **Quant Terminal v5** UI + **Tahap 2 Chainlink-Native Telemetry** drawer + **Journal Archive Viewer** |
| Study portal | https://poly15-study.dollarkilat.xyz/ · **Tahap 2 · v4 Lab** (54d Tape + Gate 20f replay + 88f gain rank) + **ML Model Lab** + content-hashed assets + Cloudflare Insights CSP + Studies + Changelog + `$100` eval |
| Cross-feed guard | **Gate 20f active** (`FILTER_CROSS_FEED_SKEW_PCT=0.035%`), 21-sample median `BasisTracker`, `settlePrice` in `autoSettle()` + `chainlinkWss` spot fallback |
| Auth | session login; daily password rotation at 07:00 WIB via Telegram |
| Live/dry switch | available; **live active** |
| Drift | no drift ($0.00) verified on-chain |
| Tests | 115 files / 1,081 vitest PASS · 433 pytest PASS (98% `mltrain` cov) · `ruff`/`black` PASS |
| Disk | 18 GB used / 39 GB (47%); 20 GB free; journal `116 MB` (capped at 150 MB) |
| Swap | 6.1 GiB (`2G` `/swap.img` + `4.2G` `/swap-extra.img`, `1.6 GiB` active alongside `openbot`) |
| Health monitor | `poly15-health-alert.timer` every 5 min (Telegram on failed unit/disk/endpoint/auto-deploy) |
| Password sync | Windows task `Poly15 Sync Dashboard Password`, daily 07:05 WIB |
| Kelly shrink | **0.60** (`KELLY_PROB_SHRINK=0.60`, `MIN_BET_PCT=0.005`; resolved `Adjusted Kelly < min 2.0%` deadlock) |
| Eval window | **Since `2026-11-16T01:35:00Z`** (`EVAL_WINDOW_START`, `$100` fresh capital, hot-upgraded to `20261116-p2-ef8dfd`); old 926-row & 923-row journals archived & viewable in UI |
| Win rate alerts | throttled: alerts once per trade count change (6h cooldown) |
| Health state | clean; failed units cleared; `systemctl --failed` empty |
| Global risk | pilot live: RSS + macro + sentiment; snapshot JSONL; relevance filter added |
| Secrets backup | AES-256 encrypted local archive; key copied locally |
| Data backup | AES-256 encrypted archive; local offsite copy |
| Encrypted backup release | deployed via auto-deploy at 14:38 WIB |
| Auto-deploy | active; **worktree dirty throttled via block_deploy**; unit auto-sync enabled; source at `main` |
| Scheduled jobs | maintenance 04:30 WIB · secrets backup 06:35 WIB · password rotation 07:00 WIB · bot backup 07:15 WIB |

> This status block is the only section edited in place. Everything below is append-only.

---

### 2026-11-16 14:25 WIB — Study Portal Cloudflare Insights CSP & `vps.dollarkilat.xyz` Dynamic Managed Units Discovery

**What changed:**
1. **Study Portal CSP for Cloudflare Web Analytics ([nginx-polybtc15-study.conf](scripts/nginx-polybtc15-study.conf)):**
   - Updated `Content-Security-Policy` to permit `https://static.cloudflareinsights.com` in `script-src` and `https://cloudflareinsights.com` in `connect-src` (matching `polybtc15` dashboard without loosening XSS defense with `'unsafe-inline'`), removing browser console CSP blocks on Cloudflare's `beacon.min.js`.
2. **VPS Monitor Dynamic Managed Units (`/opt/vps-monitor/server.mjs` on VPS):**
   - Replaced the hardcoded 4-service array in `getServicesStatus()` with dynamic discovery (`systemctl list-unit-files` + `systemctl show` batch query cached 4 s) covering all `poly*`, `openbot*`, `alphabot`, `nginx`, `cloudflared*`, `postgresql*`, and `vps-monitor*` services & timers, with scrollable UI container (`max-h-80`) and live unit count badge.

**Files:** [nginx-polybtc15-study.conf](scripts/nginx-polybtc15-study.conf); [UPDATES.md](UPDATES.md) (plus VPS runtime `/opt/vps-monitor/server.mjs`).

---

### 2026-11-16 13:52 WIB — Study Portal Cache-Busting (`?v=<hash>`) & Nginx `no-cache` Header Fix

**What changed:**
1. **Root cause fixed (`Cannot read properties of null (reading 'replaceChildren')`):**
   - On `poly15-study.dollarkilat.xyz`, Cloudflare Edge CDN cached unversioned `/app.js` and `/charts.js` with `max-age=14400` (4 hours), while `/` (`index.html`) was served `DYNAMIC`. After updating the DOM in `index.html`, browsers loading the old cached `/app.js` referenced removed element IDs.
2. **Asset Content-Hashing ([build-study-site.mjs](scripts/build-study-site.mjs), [studySiteBuilder.test.ts](bot/src/__tests__/studySiteBuilder.test.ts)):**
   - Updated `copyStaticFrontend()` to hash `study-site/` assets (8-hex SHA-256) and emit `./styles.css?v=<hash>`, `./app.js?v=<hash>`, `./charts.js?v=<hash>`, and `./markdown.js?v=<hash>` in `study-dist/`, preventing HTML/JS version skew across any CDN or browser cache.
3. **Origin Cache-Control Headers ([nginx-polybtc15-study.conf](scripts/nginx-polybtc15-study.conf)):**
   - Moved `add_header Cache-Control "no-cache, must-revalidate" always;` to the `server` block so `/`, `.js`, `.css`, and `/data/*.json` all preserve security headers (`CSP`, `X-Frame-Options`, `X-Content-Type-Options`) while preventing Cloudflare 4-hour edge caching of stale bundles.

**Files:** [build-study-site.mjs](scripts/build-study-site.mjs); [nginx-polybtc15-study.conf](scripts/nginx-polybtc15-study.conf); [studySiteBuilder.test.ts](bot/src/__tests__/studySiteBuilder.test.ts); [UPDATES.md](UPDATES.md).

---

### 2026-11-16 13:35 WIB — Complete ML Model Lab Expansion on `poly15-study.dollarkilat.xyz`

**What changed:**
1. **Rich Tree & Calibration Metadata Extractor ([models.mjs](scripts/study/models.mjs), [build-study-site.mjs](scripts/build-study-site.mjs)):**
   - Added pure offline tree/calibration extraction over registered `xgboost_model.json(.gz)`, `lightgbm_model.json(.gz)`, and `norm_browser.json(.gz)` bundles: extracts per-feature XGBoost split counts, XGB split shares %, root-node splits, LightGBM split counts, LightGBM split gain shares %, normalization mean/std, semantic group classification, and TreeSHAP/pre-excluded/zero-split dispositions without bloating `models.json` with raw trees.
   - Added LightGBM test/CV metrics, XGBoost 5-fold CV & strict holdout gap metrics, Optuna hyperparameters (`xgb.params`), validation split config (`xgb.validation`), 10-decile calibration reliability bins (`calibration_bins`), 8 confidence band precision/coverage buckets (`confidence_buckets`), `signal_modifiers`, `phase_thresholds`, all 27 registered models (`timelineModels` incl. `v1`–`v3` archive rows parsed from `MODELS.md`), and all 13 `evaluated` experiment summaries from `ml_registry/journal.jsonl`.
2. **Full Visual ML Lab UI & SVG Chart Suite ([charts.js](study-site/charts.js), [index.html](study-site/index.html), [app.js](study-site/app.js), [styles.css](study-site/styles.css)):**
   - Added five pure-SVG interactive visualizations under strict `'self'` CSP (zero `innerHTML`, zero external libraries): 27-model chronological Accuracy & ROC-AUC evolution timeline (`drawEvolutionChart`), 10-decile calibration reliability curve against `y = x` (`drawCalibrationCurve`), 8-band confidence accuracy & coverage bars (`drawConfidenceBuckets`), 4-phase calibrated probability response curves (`drawPhaseResponseCurve`), and top-18 tree-extracted feature importance bars switchable across `XGB Splits` / `LGB Gain %` / `Root Splits` (`drawFeatureImportanceBars`).
   - Added interactive sticky Model Inspector bar, XGBoost vs LightGBM vs Ensemble breakdown table, CV/Holdout generalization audit & Optuna hyperparameter chips, searchable/filterable 83-feature catalog explorer, switchable `Full OOS (2,267)` / `Exact 2,175` preset sweep comparison, ML experiment/ablation ledger, toggleable v1 archive registry table, and quality gates + raw `training_report.txt` viewer.
3. **Verification ([studySiteBuilder.test.ts](bot/src/__tests__/studySiteBuilder.test.ts)):**
   - Expanded `buildStudySite` integration test assertions to cover `timelineModels`, `experiments`, `featureCatalog`, `calibrationBins`, `confidenceBuckets`, `metrics.lgb`, and `xgbParams`.

**Files:** [models.mjs](scripts/study/models.mjs); [build-study-site.mjs](scripts/build-study-site.mjs); [charts.js](study-site/charts.js); [index.html](study-site/index.html); [app.js](study-site/app.js); [styles.css](study-site/styles.css); [studySiteBuilder.test.ts](bot/src/__tests__/studySiteBuilder.test.ts); [UPDATES.md](UPDATES.md).

---

### 2026-11-16 12:05 WIB — Binance-vs-Chainlink Cross-Feed Alignment (Tahap 1) & Public Study Portal (`poly15-study.dollarkilat.xyz`)

**What changed:**
1. **Cross-Feed Skew Telemetry & Gate 20f ([settlePrice.ts](bot/src/engines/settlePrice.ts), [filterThresholds.ts](bot/src/safety/filterThresholds.ts), [tradeFilters.ts](bot/src/safety/tradeFilters.ts), [decisionTrailCore.mts](backtest/ml_training/decisionTrailCore.mts)):**
   - Added `computeCrossFeedMetrics()` comparing ML's Binance-relative distance (`Binance_now - Binance_window_open`) against Polymarket's Chainlink settlement distance (`settlePrice - exactPtb`) so mid-window basis drift and pre-open 60s TWAP skew are measured separately from steady venue basis.
   - Added Gate `20f` (`FILTER_CROSS_FEED_SKEW_PCT=0.035%`): blocks entries when Binance exaggerates the signal side near PTB (`Cross-feed flip` if Oracle is on the opposite side of PTB, or `Cross-feed skew` if Oracle lead `< 0.035%` while skew `>= 0.035%`), while leaving steady-basis and strong aligned-Oracle leads unaffected and preserving all legacy golden hashes.
   - Wired through [signalComputation.ts](bot/src/engines/signalComputation.ts), [tradePipeline.ts](bot/src/engines/tradePipeline.ts) (recorded on `entryData` as `liveBasisUsd`, `crossFeedSkewUsd`, `binanceWindowOpen`), and [loop.ts](bot/src/loop.ts) limit filter checks.
   - Classified `/^Cross-feed /` under `cross_feed` in `decisionTrailCore.mts`.
2. **Median-Window `BasisTracker`, `autoSettle` & Chainlink Spot Fallback ([settlePrice.ts](bot/src/engines/settlePrice.ts), [loop.ts](bot/src/loop.ts)):**
   - Extended `BasisTracker` with optional rolling-median window (`new BasisTracker(0.15, 10, 21)` in `loop.ts`) so single-poll stale glitches are rejected while sustained basis regime moves (`+$24 → +$62`) track quickly if Chainlink spot drops.
   - Added fresh `chainlinkWss` (<15s) fallback for `clSpot` before falling back to `binance - basis`, and fixed `autoSettle(marketSlug, settlePrice, priceToBeat.value, timeLeftMin)` to evaluate predictions with Chainlink/TWAP `settlePrice` rather than raw Binance `lastPrice`.
3. **Public Visual Study & Report Portal ([study-site/](study-site/), [build-study-site.mjs](scripts/build-study-site.mjs), [redact.mjs](scripts/study/redact.mjs), [nginx-polybtc15-study.conf](scripts/nginx-polybtc15-study.conf)):**
   - Built a zero-external-dependency static Quant Terminal portal published at `https://poly15-study.dollarkilat.xyz/` with four tabs: **Overview & `$100` Eval** (SVG equity curve, phase/side/model breakdown, PTB health, strictly sanitized recent trades), **ML Model Lab** (interactive multi-model Accuracy/AUC/Skill/Brier/ECE bars, OOS confidence-tier curves, 4-phase Power-θ chart, TreeSHAP pruning chips & quality gates), **Studies & Reports** (searchable `analysis/` Markdown viewer + VPS quant JSON summaries), and **Changelog** (searchable `UPDATES.md` timeline).
   - Updated [auto-deploy.sh](scripts/auto-deploy.sh), [health-alert.sh](scripts/health-alert.sh), [backup-secrets.sh](scripts/backup-secrets.sh), and added [poly15-study-refresh.service](scripts/poly15-study-refresh.service) + [poly15-study-refresh.timer](scripts/poly15-study-refresh.timer) so commits (including docs/study-only pushes without restarting the bot) and VPS trade updates auto-publish within 2–5 minutes.

**Files:** [settlePrice.ts](bot/src/engines/settlePrice.ts); [filterThresholds.ts](bot/src/safety/filterThresholds.ts); [tradeFilters.ts](bot/src/safety/tradeFilters.ts); [decisionTrailCore.mts](backtest/ml_training/decisionTrailCore.mts); [signalComputation.ts](bot/src/engines/signalComputation.ts); [tradePipeline.ts](bot/src/engines/tradePipeline.ts); [loop.ts](bot/src/loop.ts); [settlePrice.test.ts](bot/src/engines/__tests__/settlePrice.test.ts); [filterThresholds.test.ts](bot/src/safety/__tests__/filterThresholds.test.ts); [decisionTrailStudy.test.ts](bot/tests/decisionTrailStudy.test.ts); [quantUpgrades.pipeline.test.ts](bot/src/engines/__tests__/quantUpgrades.pipeline.test.ts); [studySiteBuilder.test.ts](bot/src/__tests__/studySiteBuilder.test.ts); [build-study-site.mjs](scripts/build-study-site.mjs); [redact.mjs](scripts/study/redact.mjs); [study-site/](study-site/); [auto-deploy.sh](scripts/auto-deploy.sh); [poly15-study-refresh.service](scripts/poly15-study-refresh.service); [poly15-study-refresh.timer](scripts/poly15-study-refresh.timer); [nginx-polybtc15-study.conf](scripts/nginx-polybtc15-study.conf); [health-alert.sh](scripts/health-alert.sh); [backup-secrets.sh](scripts/backup-secrets.sh); [package.json](package.json); [.gitignore](.gitignore); [UPDATES.md](UPDATES.md).

---

### 2026-11-16 11:06 WIB — Group-1 ML Upgrades: Per-Phase Power Calibration, Constructor `feature_weights` Fix & Fold-Stable TreeSHAP Pruning (`20261116-p2-ef8dfd`)

**What changed:**
1. **Fixed Silent XGBoost 3.x `feature_weights` Bug ([cv.py](backtest/ml_training/mltrain/cv.py), [pruning.py](backtest/ml_training/mltrain/pruning.py), [trainXGBoost_v3.py](backtest/ml_training/trainXGBoost_v3.py)):**
   - Under `xgboost 3.1.3` (`hist`), assigning `dtrain.feature_weights = ...` *after* constructing `xgb.DMatrix(...)` was silently ignored by the histogram sampler, causing `--exclude-features` and soft-pruned columns (e.g. `ema_cross_signal` in `20261115-p2-c3e0fd`) to still receive splits. Passing `feature_weights` directly inside `xgb.DMatrix(...)` constructor enforces zero splits on excluded features.
2. **Exact TreeSHAP Audit & Fold-Stable Pruning ([pruning.py](backtest/ml_training/mltrain/pruning.py), [cv.py](backtest/ml_training/mltrain/cv.py)):**
   - Added zero-dependency exact TreeSHAP via `booster.predict(..., pred_contribs=True)` (`compute_shap_summary`) plus fold-stable TreeSHAP thresholding (`DEFAULT_SHAP_PRUNE_THRESHOLD = 0.0005`, `< 0.05%` across all CV folds, keeping the strict holdout AUC `-0.002` keep/reject safety rail).
   - Ablations on `34,962` rows tested and honestly **rejected** two Group-1 candidates that added variance without OOS improvement: causal Bayesian smoothed target encoding (`session x regime x phase`, `m=10/25`, Holdout/Test Skill flat/worse) and hourly historical Deribit DVOL + VRP spread (`Test LL 0.4680→0.4681`, `FullOOS Skill +6.03%→+5.72%`).
3. **4-Phase Power-$\theta$ Calibration in Python & TypeScript ([calibration.py](backtest/ml_training/mltrain/calibration.py), [lightgbm_stage.py](backtest/ml_training/mltrain/lightgbm_stage.py), [export.py](backtest/ml_training/mltrain/export.py), [lightgbm_export.py](backtest/ml_training/mltrain/lightgbm_export.py), [calibration.ts](src/engines/ml/calibration.ts), [Mlpredictor.ts](src/engines/Mlpredictor.ts), [lgbPredictor.ts](src/engines/ml/lgbPredictor.ts), [mlLoader.ts](bot/src/adapters/mlLoader.ts)):**
   - Fitted constrained 1-DOF per-phase temperature `theta` on OOF logits (`EARLY >10m`, `MID 5–10m`, `LATE 2–5m`, `VERY_LATE <=2m`, ridge `0.005`), exported cleanly as optional `platt_by_phase` on `xgboost_model.json` & `lightgbm_model.json` (preserving full backward compatibility with legacy global Platt models `180d`, `365d`, `20261115-p2-c3e0fd`).
   - Added pure-NumPy golden-section solver (`_golden_section_theta`) and strict holdout accept/reject gate in Python, matched 1:1 in browser & Node.js runtime (`calibrateLogitWith`).
4. **Trained, Registered & Promoted `20261116-p2-ef8dfd` (`Outperformed 20261115-p2-c3e0fd` on All 3 OOS Windows):**
   - Trained on `34,962` all-time rows (`60` XGB Optuna trials + `15` LGB Optuna trials via `--lgb-tune-trials`), pruned `16` dead/low-SHAP features -> `67` active (`895` XGB trees + `204` LGB trees, `0.7/0.3` OOF blend), fitted `thetas={'EARLY': 0.8872, 'MID': 0.9606, 'LATE': 0.9949, 'VERY_LATE': 1.2342}`.
   - Passed `11/11` `qualityGate` checks (`75.79%` Test Acc vs `75.67%`, `0.8532` AUC vs `0.8524`, `+6.38%` Skill vs `+5.95%`).
   - Head-to-head TypeScript OOS (`2026-10-22 → 2026-11-15`, `2,267` rows, CLOB V2 taker fee): `AUC 0.8463` (+11bp), `Brier 0.1606` (-10bp), `LogLoss 0.4752` (-33bp), `Skill +6.24%` (+0.63pp), `p55_65` `76.67% WR / 52.86% ROI / PF 3.19 / MaxDD $5.15` (vs `c3e0fd` `76.32% WR / 47.76% ROI / PF 2.96 / MaxDD $6.19`).

---

### 2026-11-16 08:34 WIB — Fix `FIXED_SHARE_SIZE` Validation Order, Widened `50c–65c` Band, Archive Viewer & `$100` Fresh Evaluation

**What changed:**
1. **Fix `FIXED_SHARE_SIZE` Ordering Bug ([tradePipeline.ts](bot/src/engines/tradePipeline.ts)):**
   - Diagnosed why 0 trades entered over 8.5 hours despite `20261115-p2-c3e0fd`: at `05:35 WIB` (`63x`) after bankroll fell to `$17.53`, Kelly sized a passing high-edge trade to `$0.28–$0.42`, which was rejected by `validateTrade` (`Bet too small < $0.50`) and `shares = Math.floor(betAmount / price) <= 0` **before** `FIXED_SHARE_SIZE=5` (`~$2.75`) ran.
   - Resolved `fixedShares` and `fixedOrderCost` before `validateTrade()`, skipping small-dollar Kelly reduction & `0 shares` rejection when `FIXED_SHARE_SIZE > 0` while still honoring `shouldBet` and `availableBankroll` checks. Added [tradePipeline.fixedShareSize.test.ts](bot/src/engines/__tests__/tradePipeline.fixedShareSize.test.ts).
2. **Widened Entry Price Band (`54c–58c` $\rightarrow$ `50c–65c`) for `20261115-p2-c3e0fd`:**
   - Previously `54c` trending floor + `58c` hard cap created a 4-cent bottleneck (`39,538` high-ML polls blocked above `58c`). Updated `20261115-p2-c3e0fd` profile (`softEntryCap=0.65`, `baseHardCap=0.65`, `trendingHardCap=0.65`, `ultraMlCap=0.68`, `trendingMinToken=0.50`, `trendingMaxPrice=0.65`, `midPhaseMaxPrice=0.62`) + VPS `DRY_RUN_HARD_ENTRY_CAP=0.65`.
3. **Frontend Journal Archive Viewer + `$100` Capital Reset ([journalAnalytics.ts](bot/src/trading/journalAnalytics.ts), [statusServer.ts](bot/src/statusServer.ts), [JournalTimeSeriesPanel.tsx](src/components/JournalTimeSeriesPanel.tsx), [App.tsx](src/App.tsx)):**
   - Added read-only archive discovery (`listJournalArchives`), on-demand computation (`getArchivedJournalAnalytics` validated against `ARCHIVE_ID_RE`), WS RPC commands (`listJournalArchives`, `getJournalArchive`), and atomic session archival/reset helper (`archiveSessionData`).
   - Added a **Dataset Switcher** in `JournalTimeSeriesPanel` so the main UI tracks the fresh `$100.00` evaluation (`0W/0L`) cleanly while all archived runs (926-trade pre-`$100` history in `archive_20261116_pre_alltime_100/` + `archive_model_20260924/`) remain 1-click viewable across Overview, Hourly, Events, and Equity tabs. Added [journalArchives.test.ts](bot/src/trading/__tests__/journalArchives.test.ts) and [statusServer.journalArchive.test.ts](bot/src/__tests__/statusServer.journalArchive.test.ts).
4. **Verification:**
   - Passed `npm run typecheck` (`frontend`, `bot`, `bot:core`, `scripts`), `npm test` (`105` files / `1,032` tests PASS), and `npm run build` (`493` modules).

---

### 2026-11-15 23:12 WIB — Option B: All-Time Quant ML Model (`20261115-p2-c3e0fd`, 83 Features / 34,962 Markets)

**What changed:**
1. **83-Feature Quant ML Pipeline (`QUANT_FI` 58 Base + 25 Engineered):**
   - Extended [featureMap.ts](src/engines/ml/featureMap.ts), [featureInputs.ts](src/engines/ml/featureInputs.ts), [featureExtract.ts](src/engines/ml/featureExtract.ts), [trainingRow.ts](src/engines/ml/trainingRow.ts), and [signalComputation.ts](bot/src/engines/signalComputation.ts) with 4 quant microstructure/regime base features: `vol_delta_buy_ratio_300s` (idx 54), `vol_delta_buy_ratio_60s` (idx 55), `hurst_exponent` (idx 56), and `realized_vol_15m_norm` (idx 57).
   - Preserved backward compatibility with `54`-base (`79`-feature) `180d` and `365d` models via dynamic `setBaseFeatureCount(baseCount)` in the live loader/predictor so users can hot-swap across all models in the dashboard without restart.
   - Added `--quant-features` support in [generateTrainingData.mts](backtest/ml_training/generateTrainingData.mts) and unit tests in [featurePipeline.test.ts](src/engines/ml/__tests__/featurePipeline.test.ts).
2. **All-Time Dataset Training (`2025-10-17` to `2026-11-15`, `34,962` Resolved Markets):**
   - Generated `training_data_alltime.csv` (`34,962` rows, `0` NaNs across all 4 quant columns; `UP=17,376` / `DOWN=17,586`).
   - Trained XGBoost (`100` Optuna trials, winner `#78`, `1,049` trees, recency `halflife=90d`: Test Acc `75.75%`, AUC `0.8526`, LogLoss `0.4680`, Brier `0.1572`, ECE `0.0245`) + LightGBM (`105` trees: Acc `75.58%`, AUC `0.8505`) -> Holdout-weighted Ensemble (`0.75 / 0.25`): Acc `75.67%`, AUC `0.8524`, ECE `0.0235`, Brier Skill `+5.95%`.
   - All 4 quant features were retained (0 pruned): `realized_vol_15m_norm` ranked `#14/73` in XGBoost (gain `7.34`, `297` splits) & `#6/70` in LightGBM (`84` splits), `vol_delta_buy_ratio_60s` `#39/73` XGB / `#10/70` LGB, `hurst_exponent` `#53/73` XGB, and `vol_delta_buy_ratio_300s` `#64/73` XGB / `#18/70` LGB.
3. **Head-to-Head OOS Comparison (`2026-10-22` to `2026-11-15`, `n=2,267`, CLOB V2 Taker Fee):**
   - **`20261114-p2-9384fe` (`180d`, 79f):** Acc `75.30%`, AUC `0.8421`, Brier `0.1630` (Skill `+4.81%`), ECE `0.0370` · `p55_58_06`: `27` trades, `70.37%` WR, `+$17.91` (`33.17%` ROI, PF `2.08`).
   - **`20261115-p2-5de02d` (`365d`, 79f):** Acc `75.74%`, AUC `0.8467`, Brier `0.1600` (Skill `+6.57%`), ECE `0.0263` · `p55_58_06`: `35` trades, `80.00%` WR, `+$47.08` (`67.26%` ROI, PF `4.25`).
   - **`20261115-p2-c3e0fd` (`All-Time 395d Quant`, 83f):** Acc `75.12%`, AUC `0.8452`, Brier `0.1616` (Skill `+5.61%`), ECE `0.0346` · `conf >= 0.80` Acc **`96.07%`** (`n=713`, highest) · `p55_58_06`: **`60` trades, `78.33%` WR, `+$90.63` (`75.53%` ROI, PF `4.37`, MaxDD `$4.15`)** · `p45_72_04`: **`356` trades, `73.60%` WR, `+$179.02`**.
   - Registered as `20261115-p2-c3e0fd`, deployed to `public/ml/`, added profile to `bot/data/model_profiles.json` (`mlConfMin=0.55`, `hardMlFloor=0.45`, `softEntryCap=0.58`, `baseHardCap=0.58`, `kellyProbShrink=0.60`, `fokMlThreshold=0.68`).
4. **Verification:**
   - Passed `npm run typecheck` (`frontend`, `bot`, `bot:core`, `scripts`), `npm test` (`102` files / `1,024` tests PASS), `npm run build` (`493` modules), `python -m ruff check` & `black --check` (`56` files unchanged), and `npm run test:ml:cov` (`424` passed, `98%` `mltrain` coverage including 83-feature `test_model_contract.py`).

---

### 2026-11-15 21:10 WIB — Top 3 GitHub Quant Upgrades: 300s Taker Flow, Deribit DVOL IV & 3s Lead-Lag Impulse

**What changed:**
1. **Upgrade 1 — 300s (5m) & 60s (1m) Binance Taker Buy Ratio (`src/indicators/volumedelta.ts`, `bot/src/safety/tradeFilters.ts` Gate `20d`):**
   - Adapted from `Bwijn/polymarket-btc-5m-quant` (`R4: bn_taker_buy_ratio_pre_300 >= 0.755`): extended `computeVolumeDelta` with rolling 5-candle `buyRatio300s`, 1-candle `buyRatio60s`, and regime flags `r4Bullish` (`>= 0.755`) / `r4Bearish` (`<= 0.245`).
   - Added Gate `20d` (`FILTER_MAX_OPPOSING_TAKER_300S=0.22` in `.env`, defaulting `0` to preserve `tradeFilters.golden.test.ts` invariants), blocking `UP` when 5m taker buy `< 28%` and `DOWN` when `> 72%`; aligned R4 flow accelerates confirmation to `60/180` polls.
2. **Upgrade 2 — Forward-Looking Deribit BTC Implied Volatility (`bot/src/adapters/deribitIv.ts`, `bot/src/engines/twapPhysics.ts`):**
   - Adapted from `djienne/POLYMARKET_UP_DOWN_DERIBIT_STRATEGY_15m`: added a zero-auth, 60s-cached background poller for Deribit's public BTC `DVOL` index, converting annualized `DVOL` (%) into spot-scaled `sigmaPerSec` (`$/sec`).
   - Extended `twapPhysics` with `dvolPct`, `sigmaIv`, and 50/50 realized+implied blended `pIv` while keeping baseline `p`, `z`, and `sd` invariant, and exposed `deribitIv` in the live `loop.ts` WebSocket broadcast.
3. **Upgrade 3 — 3-Second Binance $\rightarrow$ Polymarket Lead-Lag Impulse (`bot/src/streams/binanceWs.ts`, `bot/src/engines/signalComputation.ts`, `bot/src/engines/tradePipeline.ts`, Gate `20e`):**
   - Adapted from `gregyoung14/openmarket`: added a 15-second tick ring buffer in `binanceWs.ts` (`getRecentPriceWindow(3000)`) and `computeLeadLagImpulse()` detecting sharp 3s BTC moves (`|deltaPct| >= 0.035%`) before CLOB token momentum responds (`|marketMomentum| <= 0.015`).
   - Added Gate `20e` (`FILTER_BLOCK_OPPOSING_LEAD_LAG=1`, defaulting `0`) blocking entries against an active 3s BTC impulse, and accelerated aligned impulses (`edge >= 8%`) from `180` to `15` confirmation polls (~0.75s) to hit stale asks before repricing.
4. **Verification:**
   - Added [quantUpgrades.test.ts](bot/src/engines/__tests__/quantUpgrades.test.ts) & [quantUpgrades.pipeline.test.ts](bot/src/engines/__tests__/quantUpgrades.pipeline.test.ts).
   - Passed `npm run typecheck` (`frontend`, `bot`, `bot:core`, `scripts`), `npm test` (`102` files / `1021` tests PASS including `tradeFilters.golden.test.ts`), and `npm run build` (`493` modules).

---

### 2026-11-15 19:26 WIB — VPS Deploy & Live Activation of 1-Year Model (`20261115-p2-5de02d`)

**What changed:**
- Cleared filemode-only git noise on VPS (`git config core.fileMode false`), normalized `ubuntu:ubuntu` ownership on `dist/`, `node_modules/`, and `bot/node_modules/`, and seeded `/opt/polybtc15/bot/data/model_profiles.json`.
- Deployed commit `5c80cd7` via `poly15-auto-deploy.service` after GitHub CI passed; rebuilt frontend (`dist/assets/index-CkouUdfw.js`, verified serving `Select ML model`, `switchMlModel`, `Save Config`, and syncing fallback) and restarted `polybtc15-bot`.
- Switched the active live dry-run model on VPS via `switchMlModel` RPC to **`20261115-p2-5de02d`** (`365d Calibrated (OOS Top)` · 926 XGBoost trees / 558 LightGBM trees, effective `mlConfMin=0.55`, `fokMlThreshold=0.68`, `kellyProbShrink=0.60`, `58c` caps), and aligned repo default `public/ml/` + `ml_registry/` to `20261115-p2-5de02d` so VPS worktree remains clean for `poly15-auto-deploy`.

---

### 2026-11-15 19:20 WIB — Model Switcher UI Fallback Guard (`src/components/MlPanel.tsx`)

**What changed:**
- Updated `src/components/MlPanel.tsx` so the Model Switcher bar below `.card__header` stays visible with a lightweight `"Model switcher: syncing registry with bot…"` notice whenever `mlControl` has not arrived yet (`models.length === 0 && !activeModelId`), instead of hiding the bar completely if the frontend reloads before the bot WebSocket snapshot includes `mlControl`.
- Verified `npm run typecheck`, `npm test` (`100` files / `1013` tests PASS), `npm run build` (`vite build`, `493` modules), `python -m ruff check backtest/ml_training`, and `npm run test:ml:cov` (`424` passed, `98%` `mltrain` coverage).

---

### 2026-11-15 18:05 WIB — 1-Year (`365d`) ML Experiment (`20261115-p2-5de02d`), Dashboard Model Switcher & Per-Model Config Profiles

**What changed:**
1. **1-Year (`365d`) Training & Shared OOS Head-to-Head (`backtest/ml_training/training_data_365d.csv`, `ml_registry/`):**
   - Generated `training_data_365d.csv` (`32,096` real-labeled pipeline-v2 rows across `2025-11-15 → 2026-11-14`; `UP=15,945 / DOWN=16,151`) and trained `./output_365d` with Optuna (`--days 365 --tune --tune-trials 100 --holdout-frac 0.125 --recency`, half-life `90d`).
   - Registered as `candidate` **`20261115-p2-5de02d`** (`76.35%` test acc, `0.8579` AUC, `0.0159` ECE, `+4.56%` skill vs market on its `4,799`-row test split; XGB weight `0.75`, LGB weight `0.25`; live `20261114-p2-9384fe` stays default on `public/ml/`).
   - Evaluated both `20261114-p2-9384fe` (`180d`) and `20261115-p2-5de02d` (`365d`) head-to-head on their exact overlapping OOS tail (`2,175` rows from `2026-10-22T21:30:00Z → 2026-11-14`, unseen by both models):
     - Overall metrics (`180d` vs `365d`): Acc `76.51%` vs `76.05%` | AUC `0.8535` vs **`0.8551`** | Brier `0.1562` vs **`0.1552`** | LogLoss `0.4687` vs **`0.4633`** | Skill vs lookup market `+5.47%` vs **`+6.12%`**.
     - Confidence-tier accuracy (`conf >= 0.45 / 0.55 / 0.65 / 0.80`): `180d` `87.95% / 90.28% / 92.47% / 95.31%` vs **`365d`** **`89.01% / 90.98% / 93.28% / 96.43%`**.
     - Simulated `lookup_1min` sweep with CLOB V2 taker fee (`settlementMath.ts`, `cap <= 58c`, caveat: offline `lookup_1min` prints are optimistic vs live L2 asks): at `confMin=0.45`, `365d` scored `78.43% WR` (`+$54.09`, `+53.03% ROI`, `n=51`) vs `180d` `72.22% WR` (`+$39.94`, `+36.98% ROI`, `n=54`); at `confMin=0.55`, `365d` scored `86.36% WR` (`+$30.08`, `+68.36% ROI`, `n=22`) vs `180d` `78.95% WR` (`+$16.56`, `+43.58% ROI`, `n=19`).
2. **Hot-Swap Model Switcher & Per-Model Config Profiles (`bot/src/ml/modelProfiles.ts`, `bot/src/safety/filterThresholds.ts`, `bot/src/safety/tradeFilters.ts`, `bot/src/adapters/mlLoader.ts`, `bot/src/engines/*`, `bot/src/loop.ts`, `bot/src/statusServer.ts`, `bot/index.ts`):**
   - Added persistent store `bot/data/model_profiles.json` mapping `modelId` to validated runtime overrides (`filters`, `sizing`, `orderRouter`, `limitOrder`, `phaseThresholds`, plus label/notes). Switching models atomically deploys artifacts from `ml_registry/models/`, reloads XGBoost + LightGBM + normaliser under a poll lock (`runWithModelSwitchLock`), blocks swaps during pending/limit orders, rolls back backups on failure, resets hysteresis, logs `deployed` in `ml_registry`, and layers that model's config overrides cleanly onto `.env` baselines.
   - Wired `orderRouter.ts`, `limitOrderManager.ts`, `tradePipeline.ts`, and `loop.ts` to read effective per-model getters (`getEffectivePhaseThresholds`, `getEffectiveKellyProbShrink`, `getEffectiveMaxBetAmountUsd`, `getEffectiveOrderRouterConfig`, `getEffectiveLimitOrderConfig`).
   - Added WebSocket RPC handlers (`listMlModels`, `switchMlModel`, `saveModelProfile`, `resetModelProfile`) and seeded profiles for `20261114-p2-9384fe` (`180d Live Baseline`) and `20261115-p2-5de02d` (`365d Calibrated (OOS Top)`, `mlConfMin=0.55`, `mlConfRelaxed=0.45`, `58c` caps).
3. **Frontend Switcher UI & Per-Model Config Drawer (`src/App.tsx`, `src/components/MlPanel.tsx`, `src/components/ModelProfileDrawer.tsx`):**
   - Added compact Model Switcher bar inside `ML Engine` (placed below `.card__header` to match widget header styling) with model selector dropdown, active/profile badges, OOS summary stats, **Switch** button, and **⚙ Config** portal drawer for editing, saving, switching, or resetting per-model parameters live.
   - Added unit tests in `bot/src/ml/__tests__/modelProfiles.test.ts`; verified `npm run typecheck`, `npm test` (`100` files / `1013` tests PASS), and `npm run build`.

---

### 2026-11-15 15:25 WIB — OrderRouter ML-floor fix, Gate 20c opposing L2 imbalance guard, Market Tape gate calibration & `.env` sync

**Context (diagnosed from live VPS audit `08:49–15:03 WIB`, `EVAL_WINDOW_START=2026-11-14T16:35:00Z`, 922 journal rows, and 4 days of R2 Market Tape `2026-11-12`..`2026-11-15`):**
- Two resolved eval trades (`btc-updown-15m-1794674700` at `mlConfidence=0.53`, `obImb=-0.36`; `btc-updown-15m-1794712500` at `mlConfidence=0.48`, `obImb=-0.44`) entered against strong opposing orderbook flow and both executed as taker `fok_limit` despite `LIMIT_ORDER_ENABLED=true`, because `OrderRouter` hardcoded `mlConf >= 0.65` in Rules 5 & 7 while `tradeFilters` relaxed high-edge entries (`edge >= 15%`) down to `0.45`.
- Decision-trail replay (`decisionTrailStudy.mts`, 305 resolved markets `2026-11-12`..`2026-11-15`) proved loosening the `58c` ceiling (`n=142`: `66.9% WR vs 74.1% breakeven`, `-12.8% ROI`) or unblocking `Europe` / `btc_dist` hurts EV, whereas solo Gate 20b (`Momentum fading: peak gap ratio < 75%`, `n=9` markets, `<30` caveat) blocked `7W-2L` (`77.8% WR`, `3/4 = 75.0%` in `55%–74%`).

**What changed:**
1. **`OrderRouter` ML threshold alignment (`bot/src/config.ts`, `bot/src/engines/orderRouter.ts`):**
   - Added `BOT_CONFIG.orderRouter.limitMlThreshold` (`ROUTER_LIMIT_ML`, default `0.45`, bounds `0.35–0.85`).
   - Updated `routeOrder()` Rules 5 & 7 to evaluate `mlConf >= limitMlThreshold` instead of hardcoded `0.65`, routing qualified `45%–64%` high-edge entries to `LIMIT` / `maker_join` rather than dropping to `WAIT` → taker `fok_limit`. Kept standalone `LIMIT_MIN_ML_CONF=0.62` for proactive passive bid placement in `limitOrderManager.ts`.
2. **Gate 20c opposing L2 orderbook imbalance filter (`bot/src/safety/filterThresholds.ts`, `bot/src/safety/tradeFilters.ts`, `bot/src/engines/tradePipeline.ts`):**
   - Added `maxOpposingObImbalance` spec (`FILTER_MAX_OPPOSING_OB_IMBALANCE`, default `0` so `tradeFilters.golden.test.ts` remains invariant).
   - Wired `orderbookSignal?.imbalance ?? null` from `executeDirectionalTrade()` into `applyTradeFilters()`, blocking `UP` when `orderbookImbalance < -T` and `DOWN` when `orderbookImbalance > T`. Audited on 922 journal trades (`thr=0.30` blocked `59.1% WR` / `-$17.24`, and `0W-5L` / `-$11.33` strictly at `> 0.30` in the latest 17 post-depth-fix trades); enabled at `0.30` in `.env`.
3. **Tape-backed Gate 20b tuning & JEV / Tape verification:**
   - Relaxed `FILTER_MIN_PEAK_GAP_RATIO` from `0.75` to `0.55` in `.env` while preserving all `0.58` price caps, `BLOCKED_SESSIONS=Europe`, and `FILTER_BTC_DIST_MIN_PCT=0.035`.
   - Kept `JEV_SHADOW=true` (`jevEvaluate` 2,577 markets: `60.0%` acc; `jev_policy.jsonl` empty because `cal 2026-10-26-pava-70` calibrates live predictions to `cal 45%` under `JEV_POLICY_MIN_CONF=0.60`); verified 53 days / 1,365 hourly files in R2 Market Tape (`2026-09-24`..`2026-11-15`).
4. **Environment sync & tests (`bot/.env` local + VPS, test files):**
   - Synced local `bot/.env` non-secret operational values with VPS (`LIMIT_ORDER_ENABLED=true`, `BLOCKED_SESSIONS=Europe`, `MAX_BET_AMOUNT_USD=2.10`, `FILTER_BTC_DIST_MIN_PCT=0.035`, `FOK_MIN_SHARES_*=5`, `JEV_*`, `EVAL_*`) and added `ROUTER_LIMIT_ML=0.45`, `FILTER_MAX_OPPOSING_OB_IMBALANCE=0.30`, `FILTER_MIN_PEAK_GAP_RATIO=0.55` to both local and VPS `.env`.
   - Added tests in `bot/src/engines/__tests__/orderRouter.limitFloor.test.ts`, `bot/src/engines/__tests__/tradePipeline.routerAndOb.test.ts`, and `bot/src/safety/__tests__/filterThresholds.test.ts`. Verified `npm run typecheck` and `npm test` (`99` files / `1010` tests PASS).

---

### 2026-11-15 08:48 WIB — Fix Kelly sizing deadlock (`MIN_BET_PCT`, `KELLY_PROB_SHRINK`) & align trending early window

**Root cause (diagnosed from 49,184 filtered polls / 147,536 live VPS log lines):**
- **Primary Blocker (`Adjusted Kelly < min 2.0%`):** `KELLY_PROB_SHRINK=0.25` combined with `KELLY_FRACTION=0.15`, `b` deducting taker fee + spread + slippage (~3.3pp break-even penalty), and `MIN_BET_PCT=0.020` pushed `safeFraction` into `0.63%–0.97%` even on `17%–20%` edge signals. All 97 polls across 2 valid setups that passed all 20 trade filters and Signal Stability (`90/90`) were blocked by `computeBetSizing()` returning `shouldBet=false`, even while `BET_SIZING_MODE=fixed_shares`.
- **Secondary Blocker (`Gate 11a`):** Default `FILTER_TRENDING_MAX_TIME_LEFT=10` blocked `17,693` early trending polls (`> 10m left`) despite `FILTER_DRY_RUN_MAX_TIME_LEFT=13.5`.

**What changed:**
1. **`src/config.ts` & `bot/src/config.ts`:**
   - Lowered `BET_SIZING.MIN_BET_PCT` from `0.020` to `0.005` (`0.5%`, matching `asymmetricBet.test.ts` and eliminating double-shrinkage rejection).
   - Raised `BOT_CONFIG.kellyProbShrink` default from `0.20` to `0.60`.
   - Kept `bot/src/safety/filterThresholds.ts` defaults unchanged so `tradeFilters.golden.test.ts` remains intact.
2. **Environment configuration (`bot/.env` local & VPS `/opt/polybtc15/bot/.env`):**
   - Set `KELLY_PROB_SHRINK=0.60` (from `0.25`).
   - Set `FILTER_TRENDING_MAX_TIME_LEFT=13.5` to align Gate 11a with `FILTER_DRY_RUN_MAX_TIME_LEFT=13.5`.

**Verification:**
- `npm run typecheck` (frontend, bot, bot-core, scripts): passed (exit 0).
- `npm test` (`vitest run`): 97 test files / 1005 tests passed.

---

### 2026-11-15 00:39 WIB — POLY//15 Quant Terminal v5 full UI overhaul

**What changed:**
1. **Design system & authentication chrome (`index.html`, `src/styles/global.css`, `src/styles/dashboard.css`, `src/styles/login.css`, `src/components/auth/LoginPage.tsx`):**
   - Loaded `Space Grotesk`, `Inter`, and `JetBrains Mono` typography with obsidian/deep-navy surfaces (`#040810`, `#0a1322`, `#0e1b2e`) and `#040810` theme color.
   - Added reusable `.qt-*` component primitives (`.qt-kicker`, `.qt-panel-section`, `.qt-stat-grid`, `.qt-stat-box*`, `.qt-badge*`, `.qt-banner*`, `.qt-progress*`, `.qt-tabs`, `.qt-tab`), tabular numerals across market prices/timers, and subtle engineering grid backdrop on `.dash-canvas`.
   - Updated the login glass card styling (`login.css`) and stack subtitle/metadata (`BTC 15M · QUANT TERMINAL V5`, `POLYBTC15 EXECUTION ENGINE`, `CLOB V2 · POLYBOLT TWAP · XGB+LGB V2`).
2. **Command topbar & workspace subbar (`src/components/dashboard/DashboardShell.tsx`):**
   - Upgraded `.dash-topbar` to surface live `ORACLE · {POLYBOLT/CL WSS/RPC}`, `PTB` + signed `.tb-delta` spread badge, `WINDOW` timer, `UP`/`DOWN` odds, `.tb-book` (`BOOK` equity, `DAY P&L`, `W-L` record), individual `.tb-pills` telemetry indicators (`BIN`, `CL`, `CLOB`, `ML`, `BOT`), `SYNC`/`CHECK` badge, Logout, and Pause/Resume.
   - Upgraded `.dash-subbar` with workspace preset buttons (`VIEWS`), inline `.accent-swatch` theme toggles (`cyan`, `mint`, `ember`, `violet`), quick `Compact`/`Comfort` density toggle, widget count badge, and category chips (`.dash-widget__cat`) on widget headers.
3. **Quant telemetry exposure & panel redesign (`src/App.tsx`, `CurrentPriceCard.tsx`, `BotPanel.tsx`, `PredictPanel.tsx`, `EdgePanel.tsx`, `MlPanel.tsx`, `PolymarketPanel.tsx`, `JournalTimeSeriesPanel.tsx`):**
   - Extended `App.tsx` memoized panel slices and panel `React.memo` comparators for `regimeInfo.{hurst, halfLife}`, `orderbookSignal.{upMicroprice, downMicroprice, imbalance, spreadHealth}`, and `journalAnalytics.margin.{lifetime, realistic}.{bayesianWinRatePct, zScore}`.
   - Redesigned `CurrentPriceCard` with a 3-column hero deck (`ABOVE/BELOW PTB` badge, `EARLY/MID/LATE` phase tag + 15m elapsed `.qt-progress` bar, Binance spot/basis) and bottom `PRICE TO BEAT` `.qt-banner` strip (`✓ TWAP EXACT` / `≈ APPROX`).
   - Upgraded `BotPanel` into `.qt-panel-section` blocks with an embedded Signal Stability progress bar (`confirmCount/confirmNeeded`), `PredictPanel` with Hurst `H` and OU Half-Life `t½`, `EdgePanel` with `.qt-stat-grid` and `.qt-badge` Quality Gates, `MlPanel` with ML vs Ensemble stat boxes and Rule/ML distribution bars, `PolymarketPanel` with `P_micro` (`μ`), Book Imbalance, and Spread Health badges, and `JournalTimeSeriesPanel` with `.qt-tabs`, `Bayesian WR`, `Binomial Z-Score`, and gradient-filled SVG equity sparkline.
4. **Verification:**
   - `npm run typecheck` (frontend, bot, bot-core, scripts): passed (exit 0).
   - `npm test` (`vitest run`): 97 test files / 1005 tests passed.
   - `npm run build` (`vite build`): 492 modules built cleanly to `dist/`.

---

### 2026-11-15 00:22 WIB — Preserve pre-retrain trade history, sync `.env` sizing/Kelly/eval window & verify dry-run evaluation

**What changed:**
1. **Preserved historical trades from prior ML models (`ubuntu@43.129.33.237`):**
   - Created permanent snapshot archive `/opt/polybtc15/bot/data/archive_model_20260924/` containing copies of `trade_journal.jsonl` (923 entries: 458 `pre-registry (pipeline v1)` at 67.0% WR / +11.18 PnL, 463 `20260924-p2-0d88d4` at 60.9% WR / -27.53 PnL, 1 `20261114-p2-9384fe` + 1 unresolved) and `state.json`.
   - Left live `/opt/polybtc15/bot/data/trade_journal.jsonl` and `/opt/polybtc15/bot/data/state.json` untouched so all lifetime history and cumulative stats remain accessible in the journal and dashboard.
2. **Option 1 — Synced `.env` on VPS (`/opt/polybtc15/bot/.env`) and local (`bot/.env`):**
   - `EVAL_WINDOW_START`: `2026-10-26T03:24:51Z` → `2026-11-14T16:35:00Z` (starts evaluation window reporting at live cutover of model `20261114-p2-9384fe` without deleting old journal entries).
   - `KELLY_PROB_SHRINK`: `0.9` → `0.25`.
   - `FIXED_SHARE_SIZE`: `3` → `5`, plus `FOK_MIN_SHARES_{LOW,MEDIUM,HIGH,VERY_HIGH}=5` on VPS to match the Polymarket CLOB V2 5-share minimum order constraint.
   - Restarted `polybtc15-bot.service` cleanly (`active`).
3. **Option 2 — Verified dry-run validation & margin separation (`breakevenMargin.ts` / `evaluationReport.ts` / `dryRunReport.mts`):**
   - Bot startup confirmed `[ML] Model id: 20261114-p2-9384fe`, `[Position] State loaded: bankroll=$25.87, peak=$29.45, trades=923, W/L=589/334`, and `[EvalReport] Evaluation report: window since 2026-11-14T16:35:00.000Z, target 300 trades, daily at 00:00 UTC`.
   - `dryRunReport.mts --all` & `marginReport()` confirmed lifetime history intact (`922` resolved: `63.88%` WR vs `63.46%` breakeven; `realistic` `542` trades: `62.18%` WR vs `62.53%` breakeven), while `--since 2026-11-14T16:35:00Z` & `buildEvaluation()` track the new model's evaluation window cleanly (`1` trade, `verdict=too_early`, PTB health `100.0%` exact).

**Verification:** `polybtc15-bot.service` active after restart; startup `journalctl` verified; `dryRunReport.mts --all` and `--since 2026-11-14T16:35:00Z` verified on VPS; `marginReport()` / `buildEvaluation()` verified on VPS.

### 2026-11-14 23:55 WIB — ML tooling cleanup: systemd restart, Gamma `limit=50` on backfill scripts, early `NaN` sanitization

**What changed:**
1. **`bot/src/autoRetrain.ts` (`restartBot`):** On Linux, checks `systemctl is-active --quiet polybtc15-bot.service` and restarts via `sudo -n systemctl restart polybtc15-bot.service` before falling back to `npx pm2 restart polymarket-bot`, so scheduled retrains restart the VPS systemd unit directly.
2. **`backtest/ml_training/backfillTickPrices.mts` & `bot/scripts/fill_missing_resolutions.py`:** Updated Gamma `/events` pagination to `PAGE_SIZE = 50` (avoiding `HTTP 406`), switched `backfillTickPrices.mts` to 14-day windows (avoiding `HTTP 422`) and `fetchJsonWithPolymarketDoh`, and added browser `Accept`/`User-Agent` headers to `fill_missing_resolutions.py`.
3. **`backtest/ml_training/mltrain/features.py` (`engineer_features`):** Sanitized `X_orig` via `np.nan_to_num(X_orig, nan=0.0, posinf=0.0, neginf=0.0)` at entry, eliminating intermediate `RuntimeWarning`s in `test_features.py`.

**Verification:** `npm run typecheck` PASS. `npm test` PASS (97 files / 1005 tests). `npm run test:ml` PASS (424 pytest tests; 0 `features.py` warnings).

### 2026-11-14 23:33 WIB — Fix auto-retrain pipeline & deploy refreshed ML model (`20261114-p2-9384fe`)

**Root cause of stale ML model & failed auto-retrain:**
1. Deployed model `20260924-p2-0d88d4` had become 52 days stale (`2026-03-28 → 2026-09-23`).
2. `backtest/ml_training/fetchFreshMarkets.mts` failed against Gamma API with `HTTP 406` because Gamma now rejects `limit=100` (`limit=50` succeeds) and rejects `offset >= 3000` with `HTTP 422` while `/events/keyset` ignores cursor pagination; TLS requests via `dohLookup` also lacked explicit `servername` SNI and browser-standard headers.
3. `bot/src/autoRetrain.ts` ran `execSync` with Node's default 1 MB `maxBuffer` (`ENOBUFS` crash on verbose script output) and used a static `CFG.enrichDays` that could miss older gaps.

**What changed:**
1. **`backtest/ml_training/fetchFreshMarkets.mts`:**
   - Added TLS SNI (`servername: target.hostname`), `Host` header, `Accept-Encoding: identity`, and browser `User-Agent` to `httpsGetJson` and `fetch` fallback.
   - Reduced page size from `100` to `50` and switched series discovery to 14-day `[start_date_min .. end_date_max]` windows (keeping `offset` well below Gamma's 3000 limit).
   - Fixed slug-sweep upper bound (`endSec`) to exclude the currently open 15-minute window, and tuned defaults (`PRICE_CONCURRENCY` default 12 / cap 24, `PRICE_DELAY_MS` default 20).
2. **`bot/src/autoRetrain.ts`:**
   - Added `maxBuffer: 64 * 1024 * 1024` to `execSync` in `run()`.
   - Dynamically expands `effectiveEnrichDays` in Step 2 from the age of the latest priced market in `polymarket_lookup.json`.
3. **Full ML Retrain & Registration (`npm run ml:retrain`):**
   - Refreshed `polymarket_lookup.json` with 4,685 new markets (4,685/4,685 with CLOB ticks; 34,909 total in lookup up to `2026-11-14T15:15:00Z`).
   - Generated fresh 180-day dataset (`14,606` rows, `2026-05-18 → 2026-11-14`, Pipeline v2) and trained XGBoost + LightGBM via 100 Optuna trials with strict holdout + `--recency`.
   - New model **`20261114-p2-9384fe`** passed all 11 `qualityGate()` checks (`abs_accuracy` 76.18%, `abs_auc` 0.8473, `market_skill` +0.0518 Brier skill vs same-instant market, `high_conf_accuracy` 78.24% @ 91.91% coverage, `calibration_ece` 0.0309 [ensemble 0.0331], `cv_test_acc_gap` 0.16pp, `test_holdout_acc_gap` -0.51pp, `rel_accuracy` -0.70pp, `rel_auc` -68bp), retired `20260924-p2-0d88d4`, deployed to `public/ml/`, and registered in `ml_registry/`.

**Verification:** `npm run typecheck` PASS (frontend, bot, bot:core, scripts). `npm test` PASS (97 files / 1005 tests). `npm run test:ml` PASS (424 pytest tests).

### 2026-11-11 22:05 WIB — Maker fill gate + dry-run maker sim + fixed-share live floor

**Not deployed.**

**What changed:**
1. `makerFillGate.ts` — pure gates: unfilled timeout (default 45 s), edge erosion at the resting limit (P − limit under 3 pp), and FOK fallback only after unfilled/time-cutoff when fee-adjusted edge is at least 5 pp. Signal flip / market switch / thin edge → no FOK chase for the rest of the market (`fokFallbackDeniedForSlug` also blocks smart-routed FOK).
2. `limitOrderManager.monitorLimitOrder` cancels on unfilled timeout and edge erosion; `loop.ts` applies the FOK fallback gate and stamps `maker_fok_denied` on the tape when blocked.
3. Dry-run maker JOIN only when `routeOrder` would choose LIMIT (not merely `LIMIT_ORDER_ENABLED`). Fill rate default 0.60 (`maker_join`, fee 0). Miss → FOK only if the fallback gate passes (`fok_after_maker_miss`); else skip.
4. Positions carry `isMaker`; settlement / early-exit / forceSettle / fallbackVerifier charge entry fee 0 for makers. `isRealisticFill` accepts `maker_join` and `fok_after_maker_miss`.
5. When `FIXED_SHARE_SIZE` is set, size is always `max(env, 5)` in dry-run and live so paper selection matches the CLOB minimum.

**Env (optional):** `LIMIT_MAX_UNFILLED_SEC`, `LIMIT_MIN_REMAINING_EDGE`, `LIMIT_FOK_FALLBACK_MIN_EDGE`, `DRY_RUN_MAKER_SIM`, `DRY_RUN_MAKER_FILL_RATE`. Set `FIXED_SHARE_SIZE=5` (or unset and rely on FOK mins) on deploy. Reset `EVAL_WINDOW_START`. Prefer `KELLY_PROB_SHRINK=0.20–0.30` (VPS still at 0.9).

**Verification:** `npm run typecheck` PASS. Engine + trading tests PASS after Codex review fixes.

### 2026-11-11 14:03 WIB — Correction: live sell fee uses the match price

**Not deployed.**

The 13:54 entry booked the live sell-leg taker fee from the order's minimum price. A FOK sell can match higher. `sellFillFee` now uses gross `takingAmount / makingAmount` (the size sent, when `makingAmount` is absent). The limit is only the fallback when proceeds are missing. Zero proceeds books no sell fee. The response has no per-fill prices, so the fee uses that one aggregate price.

Live paths: emergency cut, smart sell, cut-loss, take-profit, dashboard sell. Dry-run still books the simulated limit, which is its fill.

**Verification:** `npm run typecheck` PASS. `npm test` 96 files / 989 tests PASS.

### 2026-11-11 13:54 WIB — Quant audit: taker fee on reconciler and live exits, Kelly 0.20, MC noise gate, FOK floor 5

**Not deployed.** Code defaults only. A VPS env value still wins (`KELLY_PROB_SHRINK`, `FOK_MIN_SHARES_*`, `FIXED_SHARE_SIZE`). Current status above is the running env, unchanged by this edit.

**What changed:**
1. `journalReconciler` books the CLOB V2 taker fee `shares × 0.07 × p × (1−p)` on gross `price × size` (CLOB trades, and the data-api path when `usdcSize` is missing). A positive `usdcSize` is kept — it already includes the protocol fee — so the formula is not applied again. Maker fills (`trader_side=MAKER`) pay 0. `fee_rate_bps` is not the V2 match fee.
2. Live early exits (emergency cut, smart sell, cut-loss, take-profit, dashboard sell) pass the same sell-leg `takerFee` into `earlyExitPnl` / `settleTradeEarlyExit` as dry-run. `takingAmount` is treated as gross proceeds. A phantom unwind (no fill) stays fee 0.
3. `KELLY_PROB_SHRINK` default `0.5` → `0.20` (realised/claimed edge ~0.18).
4. Monte Carlo noise gate (token vs MC fair value, divergence > 15pp) no longer skips when ML confidence is ≥ 85%.
5. `FOK_MIN_SHARES_LOW` default `3` → `5`, matching the live 5-share minimum. Unknown confidence tiers use 5 as well.
6. `settlementMath.takerFee` rounds to 5 decimal places (0.00001). Settlement P&L and the bankroll ledger stay cent-rounded after that fee.

**Operator:** deploying this changes bet size (Kelly default), which trades clear the share floor, and which noisy books the Monte Carlo gate blocks. Set `EVAL_WINDOW_START` to the deploy timestamp. Fee booking changes live early-exit P&L and reconciler discrepancies; it does not by itself change who is entered.

**Verification:** `npm run typecheck` PASS (frontend, bot, bot core, scripts). `npm test` 96 files / 987 tests PASS.

### 2026-11-09 15:45 WIB — Quantitative Mathematics Core Engine Integration (Options B & C)

**What changed:**
1. **New Quant Math Library (`src/indicators/quantMath.ts` & `src/indicators/__tests__/quantMath.test.ts`):**
   - Implemented pure, zero-dependency, high-precision quantitative formulas tailored for binary options and high-frequency trading:
     - **Stage 1.3:** EWMA Volatility (`computeEwmaVolatility`, RiskMetrics $\lambda = 0.94$).
     - **Stage 1.5:** Robust Outlier Rejection (`isBadTick`, Median Absolute Deviation / Hampel filter 5-sigma rejection) preventing crash/spike ticks from polluting settlement estimates.
     - **Stage 3.4:** Hurst Exponent (`computeHurstExponent`, Rescaled Range R/S analysis on price series) to quantitatively distinguish trending ($H > 0.58$), random walk ($0.46 \le H \le 0.54$), and mean-reverting ($H < 0.45$) dynamics.
     - **Stage 4.5:** Bayesian Win Rate (`bayesianWinRate`, Beta prior $\alpha=12, \beta=8$) shrinking small trade samples toward prior expectation to prevent over-optimism.
     - **Stage 6.2:** Order Book Microprice (`computeMicroprice`, volume-weighted fair value accounting for top-of-book depth imbalance).
     - **Stage 7.5:** Analytical Risk of Ruin & Max Bet Sizing (`maxBetForRiskOfRuin`, analytical bet cap guaranteeing ruin probability $R \le 0.005$ given bankroll and edge).
     - **Option C Adaptations for Binary Options:**
       - **C-1:** Expiry-Scaled Volatility (`expiryScaledVol`, $\sigma_{1s} \sqrt{T_{left}}$).
       - **C-2:** Ornstein-Uhlenbeck AR(1) Mean-Reversion Half-Life (`computeHalfLife`, finite half-life confirmation).
       - **C-4:** Late Binary Gamma Sizing Dampener (`gammaSizingDampener`, scales bet size by $\min(1.0, \sqrt{T_{left}/5.0})$ in the final 5 minutes to mitigate explosive binary option gamma).
       - **C-7:** Binomial Z-Test & Significance (`binomialZTest`, normal CDF $p$-value for win rate vs breakeven).
       - **C-11:** Multiple Hypothesis Testing Corrections (`bonferroniAlpha`, `familyWiseErrorRate`, `expectedMaxNoiseSharpe`).
2. **Subsystem Wiring & Runtime Integrations:**
   - **`src/engines/orderbook.ts`:** Integrated `computeMicroprice` exposing `upMicroprice` and `downMicroprice`.
   - **`bot/src/engines/settlePrice.ts`:** Wrapped Chainlink / Binance tick streams with `isBadTick` robust outlier filtering in `estimateSettlePrice`.
   - **`bot/src/trading/breakevenMargin.ts`:** Integrated `bayesianWinRate` and `binomialZTest` into `MarginSummary` and `summarizeMargin()`.
   - **`src/engines/regime.ts` & `src/hooks/computeIndicators.ts`:** Wired automated Hurst exponent and half-life confirmation to boost/dampen regime confidence.
   - **`bot/src/engines/twapPhysics.ts`:** Added `spotVolPerSecondEwma` and exposed expiry-scaled variance `sd`.
   - **`bot/src/engines/tradePipeline.ts`:** Added late-window `gammaSizingDampener` and `maxBetForRiskOfRuin` caps, with guards ensuring FOK confidence-tier bumps do not bypass quant risk caps.
3. **Verification:**
   - Vitest suite: 96 test files, 985 tests passed 100% (including 23 quant math tests, 3 regime tests, 26 trade pipeline tests, 15 breakeven margin tests, 7 settle price tests, 9 twap physics tests).
   - TypeScript typechecks: 4/4 packages cleanly passed (`typecheck:frontend`, `typecheck:bot`, `typecheck:bot:core`, `typecheck:scripts`).

## How to add the next update

1. Put a new entry directly below this line and above the previous newest entry.
2. Copy the template at the bottom.
3. Use one entry per deploy/change set, not one per commit.
4. Include verification evidence and the exact deployed state, or write **not deployed**.
5. Update the **Current status** table only.
6. Commit with: ~~~text
docs(updates): <short description>
~~~

If an earlier entry turns out to be wrong, add a **Correction** entry; do not silently edit the old one.

---

## Entries

### 2026-11-08 21:25 WIB — Bugfix: High-Edge Fast-Entry Confirmation Scaling (`90/180` vs Legacy `179/180`)
- **Scope:** `bot/src/engines/tradePipeline.ts`, `UPDATES.md`.
- **Motivation:**
  - Live log audit during the US session open (`21:00–21:15 WIB`) showed `Fast-entry: high edge 18% ≥ 15% → confirm 179/180 polls` firing on every unstable poll.
  - Root cause: `tradePipeline.ts` line 279 used `Math.max(1, SIGNAL_CONFIRM_POLLS - 1)` from when `SIGNAL_CONFIRM_POLLS` was `3` (`3 - 1 = 2` polls, i.e., half/two-thirds confirmation window). After `SIGNAL_CONFIRM_POLLS` was scaled to `180` polls for the 50ms loop on `2026-10-19`, `180 - 1` became `179` polls (saving only 0.05s instead of ~50% confirmation time, and causing tokens at `54¢–58¢` to drift above `60¢` before confirmation finished).
  - Additionally, `Fast-entry` was logged before `isSignalStable(requiredPolls)` was checked, spamming the journal on every unstable poll.
- **Changes Applied:**
  1. Replaced `Math.max(1, SIGNAL_CONFIRM_POLLS - 1)` with `Math.max(1, Math.ceil(SIGNAL_CONFIRM_POLLS / 2))` (`90/180` polls at 50ms loop, matching `limStabPolls` in `loop.ts:2158`, while preserving `2/3` when `SIGNAL_CONFIRM_POLLS=3` in unit tests).
  2. Moved the `Fast-entry:` info log after `if (!deps.isSignalStable(requiredPolls))` so it logs only once the signal has actually confirmed.
- **Verification:**
  - `npx vitest run bot/src/engines/__tests__/tradePipeline*.ts`: all tests pass.
  - Deployed to VPS (`ubuntu@43.129.33.237`) and restarted `polybtc15-bot.service`.
- **Rollback:** Revert git commit.

### 2026-11-08 12:20 WIB — Microstructure Upgrade (v14): 58c Universal Cap, 60s Path Efficiency Anti-Chop & Directional Peak Gap Anti-Retrace
- **Scope:** `bot/src/safety/filterThresholds.ts`, `bot/src/safety/tradeFilters.ts`, `bot/src/engines/signalComputation.ts`, `bot/src/engines/tradePipeline.ts`, `bot/src/loop.ts`, `bot/src/safety/__tests__/filterThresholds.test.ts`, `bot/.env`, VPS `/opt/polybtc15/bot/.env`.
- **Motivation:**
  1. **Post-Upgrade Trade Audit (05:01–09:47 WIB):** Out of 5 trades under the new rules, entries at $\le 58\text{¢}$ ($0.55, $0.58) achieved **2W / 0L (100% WR, +$2.51)**, whereas entries at $60\text{¢}–62\text{¢}$ ($0.60, $0.62, $0.62) suffered **0W / 3L (0% WR, -$5.67)**.
  2. **GitHub Quantitative Research Benchmark:** Cross-referenced against `gregyoung14/openmarket` (v14 signal engine), `KaustubhPatange/polymarket-trade-engine`, and `libuyi543-lang/polymarket-btc15m-research` (4,501 resolved 15m BTC markets):
     - Market makers price BTC direction accurately by minute 2–3, leaving zero net edge above 58¢ after CLOB V2's 7% taker fee.
     - Choppy sawing price action (`pathEfficiency < 0.08`) and fading intra-window displacement (`peakGapRatio < 0.75`) are the primary causes of late-window TWAP settlement reversals.
- **Changes Applied:**
  1. **58c Universal Entry Price Cap Across All Phases & Regimes:**
     - Set `DRY_RUN_HARD_ENTRY_CAP=0.58`, `FILTER_BASE_HARD_CAP=0.58`, `FILTER_TRENDING_HARD_CAP=0.58`, `FILTER_ULTRA_ML_CAP=0.58`, `FILTER_SOFT_ENTRY_CAP=0.58`, `FILTER_MID_PHASE_MAX_PRICE=0.58`, and `FILTER_TRENDING_MAX_PRICE=0.58`.
     - Updated Gate 4d (`midPhaseMaxPrice`) high-edge ceiling in `tradeFilters.ts` to `Math.min(0.62, T.baseHardCap)` so lowering `FILTER_BASE_HARD_CAP` to `0.58` also caps MID-phase high-edge entries at 58¢.
     - Set `FILTER_TRENDING_MIN_TOKEN=0.54` (down from `0.60`) so trending regime trades cleanly within the `[54¢, 58¢]` window.
  2. **Gate 20a — 60s Path Efficiency Anti-Chop Filter (`FILTER_MIN_PATH_EFFICIENCY=0.08`):**
     - Added `recordBtcMicrostructure()` in `signalComputation.ts`, sampling 1 Hz BTC settlement prices (`settlePrice ?? lastPrice`) over a rolling 60-second window and computing `pathEfficiency = |net 60s displacement| / sum(|1s step|)`.
     - Rejects entries when `pathEfficiency < 0.08` (choppy back-and-forth price action).
  3. **Gate 20b — Directional Peak Gap Ratio Anti-Retrace Filter (`FILTER_MIN_PEAK_GAP_RATIO=0.75`):**
     - Tracks directional `peakUpGap` and `peakDownGap` per 15m market slug (active once directional excursion reaches $\ge \$15$ from PTB).
     - Rejects entries when `currentGap / peakGap < 0.75` in the signal direction (momentum fading / retracing >25% toward PTB).
- **Verification:**
  - `npm run typecheck`: clean across all packages.
  - `npx vitest run`: all test suites pass (including `tradeFilters.golden.test.ts` and new Gate 20a/20b unit tests in `filterThresholds.test.ts`).
  - Deployed to VPS (`ubuntu@43.129.33.237`), `.env` updated, `polymarket-bot` restarted and verified active.
- **Rollback:** Revert git commit and restore previous `FILTER_*` values in `.env`.

### 2026-11-08 00:25 WIB — Optimization: Early Discovery Window Expansion & Live Maker Order Router Readiness
- **Scope:** `bot/src/loop.ts`, `UPDATES.md`, VPS configuration (`/opt/polybtc15/bot/.env`).
- **Motivation:** Operator requested applying all tactical optimizations to prevent trade starvation while maintaining the strict 65c hard cap and leak filters.
- **Changes Applied:**
  1. **Early Discovery Window:** Set `FILTER_DRY_RUN_MAX_TIME_LEFT=13.5` on VPS `.env`. Extends early discovery from 12.0m to 13.5m left, enabling the bot to detect and enter trades when tokens are still priced at base levels (50c-54c) before market expansion.
  2. **Soft Entry Cap:** Adjusted `FILTER_SOFT_ENTRY_CAP=0.62` to allow standard ML entries up to 62c (below the 65c hard cap).
  3. **Maker Limit Router Live Guard:** In `bot/src/loop.ts`, added `!BOT_CONFIG.dryRun` guard to limit order placement (`BOT_CONFIG.limitOrder.enabled && !BOT_CONFIG.dryRun`). Enabled `LIMIT_ORDER_ENABLED=true` and `ORDER_ROUTER_ENABLED=true` in VPS `.env`.
     - In dry run: safely executes simulated FOK fills without attempting uninitialized CLOB API calls.
     - In live mode (`DRY_RUN=false`): automatically engages GTD post-only maker limit orders to save spread and 7% taker fees.
- **Verification:**
  - `npm run typecheck`: clean across all 4 packages.
  - Deployed to VPS: git pulled, `.env` updated, service restarted.
  - Logs verified: clean startup, 0 crashes, early discovery window active.
- **Rollback:** Revert git commit and restore `.env`.

### 2026-11-08 00:10 WIB — Brutal Upgrade: 4-Fase Empirical Leak Plug & Risk Guard Overhaul
- **Scope:** bot codebase (`filterThresholds.ts`, `tradeFilters.ts`, `tradePipeline.ts`, `config.ts`), tests (`tradeFilters.test.ts`, `tradePipeline.dryRunFill.test.ts`), VPS deployment (`/opt/polybtc15/bot/.env`).
- **Motivation:** Complete forensic audit of 889 historical trades (`trade_journal.jsonl`) revealed 4 structural leaks totaling -$117.98:
  1. Europe session: 185 trades, 54.1% WR, **-$38.72** loss.
  2. ML Confidence < 0.40: 155 trades, 49.7% WR, **-$41.91** loss (coin-flip bypasses).
  3. MID Phase (5m-11m left): 416 trades, **-$20.91** loss due to inflated token prices.
  4. Trending regime chasing: 166 trades, **-$27.03** loss (buying tops at 68c-75c).
- **Changes Applied:**
  1. **Fase 1 (P0 Filter Gates):**
     - Activated `BLOCKED_SESSIONS=Europe` (blocks European session fake breakouts).
     - Added `FILTER_HARD_ML_FLOOR=0.45` in `filterThresholds.ts` and `tradeFilters.ts` (Gate 1): absolute floor rejecting any signal with ML confidence < 0.45, with zero bypass tolerance.
     - Added Gate 4d in `tradeFilters.ts` with `FILTER_MID_PHASE_MAX_PRICE=0.58` and `FILTER_MID_PHASE_MIN_EDGE=0.08`: in MID phase (< 11m left), tokens priced > 58c require >= 8% edge, capped at 62c ceiling.
  2. **Fase 2 (P1 Execution & Sizing):**
     - Added `FIXED_SHARE_SIZE=3` in `tradePipeline.ts`: strictly locks trade size to 3 shares ($1.80 - $1.95 risk per trade in dry-run; enforces CLOB min 5 if live). Eliminates oversized 5-7 share confidence bumps.
  3. **Fase 3 (P2 Intelligence & Regime Guard):**
     - Added Gate 11d in `tradeFilters.ts` with `FILTER_TRENDING_MAX_PRICE=0.60`: hard price cap preventing the bot from buying trending tops (> 60c).
  4. **Fase 4 (P3 Risk Guards):**
     - Tightened `MAX_CONSECUTIVE_LOSSES` default in `config.ts` and `.env` from 7 to 3 (stops runaway tilt).
     - Tightened `MAX_DRAWDOWN_PCT` to 25% and `CB_COOLDOWN_MS` to 7,200,000 ms (2 hours).
- **Verification:**
  - `npm run typecheck`: clean across all 4 packages (frontend, bot, bot:core, scripts).
  - `npm test`: 94 test files, 954 tests pass (100% PASS, including new filter and sizing unit tests).
  - Verified on VPS: `.env` updated with all 9 parameters, service restarted, logs confirm `BLOCKED_SESSIONS active: [europe]`, filter overrides active, 3-share sizing locked, and bot running smoothly.
- **Rollback:** Revert commit and remove parameters from `.env`.

### 2026-11-07 — Tighten entry price hard cap to 65c and enforce 3-share sizing ($2.10 max bet)

- **Problem:**
  Between Nov 5 ($64.83 peak) and Nov 7 ($34.58), paper bankroll dropped -$30.25 (-46.7% drawdown) despite an overall 63.2% win rate. Breakdown analysis revealed that 29 trades were entered at 76¢–81¢ and 5 trades at 71¢–75¢, incurring -$30.11 net losses across those buckets. At 80¢, a win yields only +$0.94 while a loss costs -$4.06 (breakeven requires >81% WR; 69% WR lost money). Sizing of 5 shares risked $4.05+ per trade (~7-10% of bankroll). Root cause was loose override `DRY_RUN_HARD_ENTRY_CAP=0.8` and `FOK_MIN_SHARES_*=5` on VPS.
- **Change:**
  1. Updated VPS `/opt/polybtc15/bot/.env`:
     - Lowered `DRY_RUN_HARD_ENTRY_CAP` from `0.8` to `0.65`.
     - Set `FILTER_BASE_HARD_CAP=0.65`, `FILTER_TRENDING_HARD_CAP=0.65`, and `FILTER_ULTRA_ML_CAP=0.65` so all entry paths (including trending and ultra-ML bypasses) are capped at 65¢.
     - Set `FOK_MIN_SHARES_LOW=3`, `FOK_MIN_SHARES_MEDIUM=3`, `FOK_MIN_SHARES_HIGH=3`, and `FOK_MIN_SHARES_VERY_HIGH=3` to enforce 3-share minimum sizing.
     - Lowered `MAX_BET_AMOUNT_USD` from `3.50` to `2.10` so maximum trade cost is capped at $1.95 (3 shares × 65¢ max).
  2. Restarted `polybtc15-bot.service` via systemd.
- **Verification:**
  - Live VPS journal verified blocking expensive entries:
    `Smart filter blocked: Entry price 81c > 65c hard cap (need 81% WR) [dry-run cap]`
    `Smart filter blocked: Entry price 80c > 65c hard cap (need 80% WR) [dry-run cap]`.
  - Max trade cost reduced from $4.10 to $1.95.


### 2026-11-07 — Fix auto-deploy worktree dirty spam and failed unit alert loop

- **Problem:**
  Telegram was receiving duplicate, alternating alert messages every 2-3 minutes:
  1. `POLY//15 auto-deploy: worktree dirty; manual cleanup required` (from `poly15-auto-deploy.service`)
  2. `🚨 POLY//15 health alert unit failed: poly15-auto-deploy.service` (from `poly15-health-alert.service`)
  Root causes:
  - `scripts/auto-deploy.sh` on VPS had uncommitted edits, causing `git status --porcelain --untracked-files=no` to report a dirty worktree.
  - When dirty worktree was detected, `auto-deploy.sh` called `notify` on every single run without deduplication or state tracking, and exited with `exit 1`.
  - Exiting with `exit 1` marked the oneshot unit `poly15-auto-deploy.service` as failed in systemd.
  - `poly15-health-alert.timer` (running every 5 min) detected `poly15-auto-deploy.service` in `systemctl --failed` and generated the health alert.
  - Each timer trigger cleared then re-failed the unit, triggering state change alerts endlessly.
- **Change:**
  1. Updated `scripts/auto-deploy.sh`: replaced unthrottled `exit 1` with `block_deploy "worktree dirty ($DIRTY_FILES); manual cleanup required"`. This deduplicates notifications via `$STATE_DIR/last-block` (alerts only ONCE per target commit) and exits with `0` so the systemd service does not enter a failed state.
  2. Added `rm -f "$STATE_DIR/last-block"` upon successful deployment.
  3. Added `.auto-deploy/`, `.tunnel-url`, `auth.env*`, and `dashboard-password.hash` to `.gitignore` to prevent runtime state cluttering git status.
  4. Tracked VPS external watchdog unit and script (`scripts/watchdog.sh`, `scripts/polybot-watchdog.service`, `scripts/polybot-watchdog.timer`) in git.
  5. Cleaned VPS worktree: reset tracked uncommitted modifications, reset systemd failed unit state (`systemctl reset-failed poly15-auto-deploy.service`), and verified health check is completely green.
- **Verification:**
  - `systemctl is-failed poly15-auto-deploy.service` returned active/clean (not failed).
  - `/usr/local/sbin/poly15-health-alert` executed with 0 issues; `systemctl --failed` empty.
  - Deployed cleanly to VPS and tested.


### 2026-11-05 — Add automatic systemd unit synchronization to auto-deploy

- **Problem:** When new systemd services or timers were added to `scripts/`, `poly15-auto-deploy` only pulled code and restarted the bot/auth server. It did not install or activate new `.service` or `.timer` files, requiring manual SSH intervention.
- **Change:**
  1. Updated `scripts/auto-deploy.sh` with `sync_systemd_units()`: automatically iterates over `scripts/*.service` and `scripts/*.timer`, ensures scripts are executable, copies new/modified units to `/etc/systemd/system/`, enables units containing `[Install]`, restarts timers, and triggers `systemctl daemon-reload`.
  2. Added self-update logic so `/usr/local/sbin/poly15-auto-deploy` refreshes itself whenever `scripts/auto-deploy.sh` is updated in Git.
  3. Deployed and verified on VPS (`/usr/local/sbin/poly15-auto-deploy`).
- **Evidence:** `bash -n /usr/local/sbin/poly15-auto-deploy` PASS; permissions 0755 root:root verified.

### 2026-11-05 — VPS Disk & Memory cleanup, journal limit, and automated daily maintenance timer

- **Problem:** VPS disk and memory usage was steadily swelling. Analysis revealed `bot_state_snapshots` in PostgreSQL had grown to 916 MB (214k+ rows) and `bot_signal_perf_snapshots` to 76 MB due to 120-poll (~10s) periodic snapshots without a retention policy. Systemd journal was consuming 1.0 GB on disk and holding 228 MB RSS in `systemd-journald`. A redundant `swap2.img` consumed 2 GB.
- **Actions executed on VPS:**
  1. Vacuumed systemd journal logs and placed a permanent size cap (`SystemMaxUse=150M`, `RuntimeMaxUse=50M`) in `/etc/systemd/journald.conf.d/00-size-limit.conf`. `systemd-journald` memory dropped from 228 MB to 19 MB.
  2. Purged PostgreSQL snapshot records older than 7 days (214,261 state snapshots, 71,329 signal perf snapshots) and executed `VACUUM FULL`. `bot_state_snapshots` shrank from 916 MB to 276 MB.
  3. Capped `orderflow.jsonl` to 10k lines, cleaned temporary/rotated files, and cleaned apt cache.
  4. Deactivated and removed redundant `/swap2.img` (2 GB reclaimed), updated `/etc/fstab`.
  5. Flushed inactive page cache (`vm.drop_caches=3`). Free RAM jumped from 207 MB to 902 MB. Disk usage dropped from 12 GB (32%) to 9.0 GB (25%), saving 3.0 GB of disk.
  6. Created and installed automated daily maintenance service and timer (`scripts/daily-maintenance.sh`, `polybot-maintenance.service`, `polybot-maintenance.timer`) on VPS, running daily at 04:30 WIB to prevent future snapshot/log accumulation. Tested with code 0.
- **Evidence:** `systemctl status polybot-maintenance.timer` active; `df -h` shows 9.0G used (29G available); `free -m` shows 902 MB free / 957 MB available; bot `polybtc15-bot` running continuously and unaffected.

### 2026-11-04 — Repair dry-run bankroll accounting baseline and profit-target state ($61.99)

- **What:**
  1. Repaired dry-run position tracking state in `/opt/polybtc15/bot/data/state.json`: restored true baseline `bankroll: 61.99`, `peakBankroll: 63.76`, `startOfDayBankroll: 60.12`, and updated the settled trade array record `bankrollAfter: 61.99`.
  2. Cleaned `/opt/polybtc15/bot/data/state_audit.jsonl`: corrected settlement entry `bankrollAfter: 61.99` and removed erroneous `STATE_LOADED: 27.23` line.
  3. Reset `/opt/polybtc15/bot/data/profit_target.json`: updated `baseline: 60.12` and `targetReached: false` so that the artificial delta from the $13.15 live baseline does not falsely trigger a profit pause.
- **Why:**
  On 2026-10-28, when configuring live trading with $25.36 wallet balance, $25.36 was saved into dry-run `state.json` via dashboard input. When the bot returned to dry run today, trade 834 (+$1.87 win) settled onto the $25.36 baseline -> $27.23. In `JournalTimeSeriesPanel.tsx` -> `computeEquityCurve()`, all historical SETTLE events (1..833, $44 -> $60.12) were plotted directly followed by today's trade with `bankrollAfter: 27.23`, creating a visual 38% cliff drop despite the trade being a profitable win (+1.87).
- **Verification:**
  - Bot stopped cleanly, files repaired, bot restarted via systemd.
  - Startup log confirmed: `Position state: bankroll=61.99, trades=834, W/L=537/297`.
  - Equity curve points re-computed: 834 points, Start $44.06, Peak $63.76, Now $61.99 (+40.7% net profit).
  - Trading loop active, evaluating signals with zero false circuit breaker or profit pause.
- **Deployed:** Yes (live on VPS).


### 2026-11-04 — Strengthen trade filters with ML direction consensus gate and VPS threshold hardening

- **What:**
  1. Added **Gate 1d (ML Direction Consensus)** in `bot/src/safety/tradeFilters.ts`: If the ML model is available and has an active side prediction (`mlSide`), the bot is strictly prevented from entering in the opposing direction (`mlSide !== signalSide`).
  2. Plumbed `mlSide` through `bot/src/engines/tradePipeline.ts` into `applyTradeFilters()`.
  3. Extended tape decision trail category in `backtest/ml_training/decisionTrailCore.mts` to recognize `ML direction conflict:` as `ml_conf`.
  4. Added unit test in `bot/tests/tradeFilters.test.ts` verifying that directional conflict triggers a filter block.
  5. Hardened VPS `.env` threshold overrides: tightened loose values that permitted coin-flip and opposing-direction entries during live trading.
- **Why:**
  Analysis of the 11 live trades (4W / 7L, 36.4% WR) revealed that Trade 11 entered `UP` while the ML model predicted `DOWN` (`mlProbUp = 39.2%`, `mlSide = "DOWN"`) due to a rule-engine oscillator spike (`ruleUp = 0.89`) and a loose VPS bypass (`FILTER_ML_CONF_RELAXED=0.20`, `FILTER_HIGH_EDGE_BYPASS=0.09`). The new gate ensures the bot never trades against the ML model.
- **Verification:**
  - `npm run typecheck` passed (frontend, bot, bot:core, scripts).
  - `npm test`: 94 test files / 952 tests PASS, including `tradeFilters.golden.test.ts` (0 hash drift) and `tradeFilters.test.ts`.
- **Deployed:** Yes (code committed, pushed, pulled to VPS, `.env` updated, bot restarted).


### 2026-11-04 — Fix win-rate alert spam with trade-aware deduplication and cooldown

**Status:** implemented & tested; deploying to VPS
**Area:** monitoring / alerts
**What changed:**
- `bot/src/monitoring/perfMonitor.ts`: added `lastWarnedTrades` and 6-hour `WARN_ALERT_COOLDOWN_MS` throttle to `checkWinRate()`.
- Alerts are now sent only when trade count changes (i.e. a newly settled trade) or when the 6-hour cooldown expires, eliminating repetitive 15-minute Telegram spam when win rate remains unchanged.
- Added comprehensive unit tests in `bot/src/monitoring/__tests__/perfMonitor.test.ts` (4 passing tests).
**Why:**
- When live win rate fell to 36.4% (4W/7L) on Nov 2, `checkWinRate()` sent `Win rate LOW: 36.4% (4W/7L)` every 15 minutes continuously because the trade count was static at 11 trades and no deduplication existed.
**Verification:**
- Vitest 4/4 PASS in `perfMonitor.test.ts`.
- Full typecheck PASS across all packages.
**Files / commits:** `bot/src/monitoring/perfMonitor.ts`; `bot/src/monitoring/__tests__/perfMonitor.test.ts`; UPDATES.md.
**Deployment:** pending VPS git pull & restart.

---

### 2026-10-28 — Set Kelly shrink to 0.9

**Status:** deployed / active on VPS
**Area:** risk / bet sizing
**What changed:**
- Set `KELLY_PROB_SHRINK=0.9` in `/opt/polybtc15/bot/.env` (raised from 0.75 per operator request).
- Restarted `polybtc15-bot.service` cleanly in LIVE mode with $18.61 bankroll.
**Why:**
- Operator requested increasing model conviction weighting to 90% in the Kelly sizing equation ($p = \text{price} + 0.9 \times (\text{model} - \text{price})$).
**Verification:**
- Service restarted cleanly; PID 3804608.
- Feeds connected WS+WS+CL; no open position; loop running normally.
**Files / commits:** `/opt/polybtc15/bot/.env` (VPS); UPDATES.md.
**Deployment:** active.

---

### 2026-10-28 — Fix RPC 403, repair circuit breaker halt, set Kelly shrink 0.75

**Status:** deployed / active on VPS
**Area:** risk / network / live execution
**What changed:**
- Set `KELLY_PROB_SHRINK=0.75` in `/opt/polybtc15/bot/.env` (from 0.8).
- Fixed Polygon RPC 403 Forbidden: replaced broken `https://polygon-bor-rpc.publicnode.com` with `https://polygon.drpc.org`, eliminating the "Archive requests require personal token" warning.
- Set `AUTO_ACTIVATE_DEPOSITS=false` since wallet already holds pure pUSD.
- Repaired Circuit Breaker:
  - Discovered `state.live.json` had an inflated `peakBankroll: 30.45` caused by a delayed reconciler spike earlier in the day, which made current $19.34 calculate as a 36.5% drawdown and halted the bot for 240 minutes.
  - Reset `state.live.json` bankroll, peak, and start-of-day baseline to verified on-chain pUSD balance **$21.45**.
  - Relaxed circuit breaker thresholds in `.env` for small live bankroll ($21): `MAX_DAILY_LOSS_PCT=50`, `MAX_DRAWDOWN_PCT=50`, and `CB_COOLDOWN_MS=1800000` (30 minutes instead of 4 hours).
- Clarified minimum share constraint: Polymarket CLOB exchange protocol strictly requires 5 shares minimum per order on BTC 15m; orders under 5 shares are rejected by the exchange.
**Verification:**
- V2 readiness check PASSED on `https://polygon.drpc.org` (pUSD balance $21.45, allowances max).
- Bot restarted cleanly in LIVE mode (PID 3788009); on-chain USDC drift $0.00.
- No circuit breaker halt; feeds connected; poll loop active.
**Files / commits:** `/opt/polybtc15/bot/.env` (VPS); `data/state.live.json` (VPS); UPDATES.md.
**Deployment:** active.

---

### 2026-10-28 — Set Kelly shrink to 0.8

**Status:** deployed / active on VPS
**Area:** risk / bet sizing
**What changed:**
- Set `KELLY_PROB_SHRINK=0.8` in `/opt/polybtc15/bot/.env` (raised from 0.5 per operator request).
- Restarted `polybtc15-bot.service` cleanly in LIVE mode with $25.36 bankroll.
**Why:**
- Operator requested higher model conviction weighting in the Kelly sizing equation ($p = \text{price} + 0.8 \times (\text{model} - \text{price})$), which yields higher Kelly fractions and clears the 2% min bet threshold on qualifying signals.
**Verification:**
- Service restarted cleanly; PID 3681125.
- Feeds connected WS+WS+CL; no open position; signal evaluation active.
**Files / commits:** `/opt/polybtc15/bot/.env` (VPS only); UPDATES.md.
**Deployment:** active.

---

### 2026-10-28 — Restore Kelly shrink 0.5 and align FOK min shares to 5

**Status:** deployed / active on VPS
**Area:** risk / bet sizing / live execution
**What changed:**
- Restored `KELLY_PROB_SHRINK=0.5` in `/opt/polybtc15/bot/.env` (was 0.18).
- Set `FOK_MIN_SHARES_MEDIUM=5`, `FOK_MIN_SHARES_HIGH=5`, and `FOK_MIN_SHARES_VERY_HIGH=5` (were 2) to match exchange minimum 5 shares.
- Restarted `polybtc15-bot.service` cleanly in LIVE mode with $25.36 bankroll.
**Why:**
- `KELLY_PROB_SHRINK=0.18` pulled model probabilities so close to market that adjusted Kelly fell below `MIN_BET_PCT=0.02` on all candidate trades since 2026-10-23, causing 0 entries for 5 days.
- In live mode, Polymarket CLOB requires a 5-share minimum order; having medium/high confidence floors at 2 shares caused risk of order rejection.
**Verification:**
- .env backup created at `/opt/polybtc15/bot/.env.bak_20261028_142624`.
- Service restarted cleanly; PID 3671221; feed authenticated, connected WS+WS+CL.
- No active position; USDC on-chain and local synced at $25.36; loop running.
**Files / commits:** `/opt/polybtc15/bot/.env` (VPS only); UPDATES.md.
**Deployment:** active.
**Risks / follow-up:** Monitor the first live fill with Kelly shrink 0.5; max daily loss remains protected by circuit breaker.

---

### 2026-10-26 - Browser console warning cleanup

**Status:** implemented; deploy pending
**Area:** frontend meta
**What changed:**
- Added the standard `mobile-web-app-capable` meta tag alongside the legacy Apple tag.
**Why:** Chrome reported the Apple-only tag as deprecated; this removes that console warning without changing app behavior.
**Files / commits:** index.html; UPDATES.md.
**Verification:** frontend build/CI pending.
**Deployment:** pending auto-deploy.
**Risks / follow-up:** the other console lines are external: wallet extension `requestProvider.js` and an adblock-blocked Cloudflare Insights beacon. They are not app code.

---
### 2026-10-26 - Live-state pollution incident and repair

**Status:** repaired; bot running in DRY RUN
**Area:** state integrity / circuit breaker
**What happened:**
- At 10:34 WIB the dashboard changed the dry `state.json` bankroll from 60.12 to 25.36 (`SET_BANKROLL source=dashboard`).
- The daily baseline remained 60.12, so the circuit breaker computed -57.8% and halted trading for 240 min.
- CLOB WS reconnect loop was a symptom: the halted loop did not finish market subscription.
- No live trade was placed; live state remained 25.36 with 0 trades.
**Repair:**
- Stopped the bot and backed up state.json outside the repo.
- Restored dry bankroll 60.12, start-of-day 60.12, peak 63.76.
- Restarted DRY RUN; loop resumed (#200, ENTER signal evaluated), CLOB returned to WS+WS+CL.
- Appended a STATE_REPAIRED audit entry.
**Files / commits:** VPS state/audit data only; UPDATES.md.
**Verification:** Mode DRY RUN; bankroll 60.12; no active position; no new halt; CLOB feed normal.
**Risks / follow-up:** do not set dry bankroll to the live balance; that recreates the circuit-breaker false positive. Live state is preserved separately, but live mode is not active now.

---
### 2026-10-26 - LIVE mode activated

**Status:** live; no live trades yet
**Area:** trading mode / risk
**What changed:**
- Operator switched the dashboard from DRY RUN to LIVE at 10:34 WIB; live preflight passed.
- pUSD balance 25.36, CTF Exchange V2 allowance max, L2 auth OK, open orders 0.
- `MAX_BET_AMOUNT_USD` raised 2.50 -> 3.50 because the market minimum is 5 shares (5 x 0.70 = 3.50).
- Live state is separate (`state.live.json`); no live journal/position yet.
**Verification:** service log shows Mode: LIVE TRADING; pUSD seeded 25.36; CLOB V2 readiness OK; no open orders/positions.
**Files / commits:** /opt/polybtc15/bot/.env (VPS only); UPDATES.md.
**Risks / follow-up:** auto-deploy now refuses to deploy while DRY_RUN=false, so code updates need manual deployment. Live risk: max daily loss 15% (~$3.80), max bet $3.50, min 5 shares. JEV/order-flow are not validated gates; filters remain in control. Monitor the first live fill and reconcile fee/settlement.

---
### 2026-10-26 - Dry-run soft entry cap 70c

**Status:** active
**Area:** configuration / trade selection
**What changed:**
- Added `FILTER_SOFT_ENTRY_CAP=0.70` on the VPS (previous default 0.63).
- Reset `EVAL_WINDOW_START` to 2026-10-26T03:24:51Z because trade selection changed.
- Restarted the bot with no open position.
**Why:** after raising the dry-run hard cap to 80c, 807 ENTER signals still failed; the dominant binding gates were the 63c soft ceiling, ML confidence/dead-zone and late-phase gates.
**Verification:** startup log confirms override FILTER_SOFT_ENTRY_CAP=0.7 (default 0.63); bot active DRY RUN. At 10:26 WIB the live market was 81c, still above the 80c hard cap, so no entry yet.
**Files / commits:** /opt/polybtc15/bot/.env (VPS only); UPDATES.md.
**Risks / follow-up:** this is a dry-run selection experiment, not validated edge. Do not lower all gates together. If there is still no entry after 24h, review the hard cap/ML dead-zone/LATE gates separately.

---
### 2026-10-26 - Order-flow history logger deployed

**Status:** deployed / verified
**Area:** data collection / backup
**What changed:**
- bot/data/orderflow.jsonl now receives a record every 15 seconds per market, independent of JEV calls.
- Each line contains orderFlow, market baseline, ML baseline and current JEV baseline.
- scripts/backup-data.sh now includes orderflow.jsonl in the encrypted daily backup.
**Verification:** deployed ec82dde at 23:05:00 WIB; file created immediately; 2 samples in the first ~35 seconds; first live sample has orderFlow.ok=true, marketUp 0.105, mlProbUp 0.0489, sampleCount 119; bot active with no errors.
**Files / commits:** bot/src/monitoring/orderFlowLogger.ts; bot/src/loop.ts; scripts/backup-data.sh; ec82dde.
**Deployment:** active.
**Risks / follow-up:** old JEV rows have no orderFlow; only new rows can train the new features. Sample is far too small for model training; wait for enough forward markets.

---
### 2026-10-26 - Order-flow history logger + backup

**Status:** implemented; deploy pending
**Area:** data collection / backup
**What changed:**
- Added bot/src/monitoring/orderFlowLogger.ts: writes bot/data/orderflow.jsonl every 15 seconds per market with order-flow, market/ML and JEV baseline fields.
- Logger is independent of JEV call cadence; record-only and never throws.
- Added orderflow.jsonl to the daily encrypted data backup list.
**Why:** audit found only 5 order-flow rows, all created as a side effect of JEV calls. That is too sparse for feature research and would lose data if JEV were disabled.
**Files / commits:** bot/src/monitoring/orderFlowLogger.ts; bot/src/loop.ts; scripts/backup-data.sh; analysis/2026-10-26/order-flow-features.md; UPDATES.md.
**Verification:** bot typecheck PASS; 24 tests PASS; build PASS.
**Deployment:** pending CI/auto-deploy.
**Risks / follow-up:** old JEV rows lack orderFlow; only new order-flow rows can train the new features. The 100 MB rotation keeps about a month at current cadence.

---
### 2026-10-26 - Order-flow features deployed

**Status:** deployed / verified
**Area:** signal features / AI data
**What changed:**
- OFI, top imbalance, depth imbalance, microprice edge, trade imbalance and VPIN proxy now flow from CLOB book/trades into the orderFlow broadcast and JEV features.
- No entry/sizing/exit rule reads these values.
**Verification:** deployed f216792 at 21:58:16 WIB; bot active; no errors; live JEV call at 15:00:36Z logged orderFlow.ok=true, sampleCount 265, tradeCount 55, vpin 0.4984, depthImbalance 0.0835.
**Files / commits:** f216792; analysis/2026-10-26/order-flow-features.md.
**Deployment:** active.
**Risks / follow-up:** OFI can be zero when best-level sizes did not change between polls; trade-side labels can be missing. Validate incremental Brier before using in decisions.

---
### 2026-10-26 - Order-flow features P0 (record-only)

**Status:** implemented; deploy pending
**Area:** signal features / AI data
**What changed:**
- Added orderFlowFeatures.ts: OFI, top imbalance, depth imbalance, microprice, microprice edge, trade imbalance, VPIN proxy.
- clobWs now exposes best-level sizes and a 500-trade ring buffer of last_trade_price prints for followed tokens.
- signalComputation feeds the order-flow state every poll; loop broadcasts orderFlow and writes it to JEV features.
- No entry/sizing/exit rule reads these features.
**Files / commits:** bot/src/engines/orderFlowFeatures.ts; bot/src/streams/clobWs.ts; bot/src/engines/signalComputation.ts; bot/src/loop.ts; bot/src/ai/jevAdvisor.ts; bot/src/engines/__tests__/orderFlowFeatures.test.ts; analysis/2026-10-26/order-flow-features.md; UPDATES.md.
**Verification:** bot typecheck PASS; 24 tests PASS; production build PASS.
**Deployment:** pending CI/auto-deploy.
**Risks / follow-up:** record-only. Validate incremental Brier before using it in decisions. Trade-side data may be missing on some prints; features fail soft to zero.

---
### 2026-10-26 - JEV feature update deployed

**Status:** deployed / verified
**Area:** AI / data collection
**What changed:**
- JEV logs now include 30 snapshot features (momentum, volatility, oscillators, order-flow proxies, regime, ML/market state).
- Settle prompt now requests a calibrated probability with market odds as prior and warns against extremes.
- JEV remains shadow; no gate/veto/sizing change.
**Verification:** deployed `799814b` at 21:44:21 WIB; next JEV call at 14:45:36Z logged 30 feature keys; bot/auth/nginx active; no failed units.
**Files / commits:** bot/src/ai/jevAdvisor.ts; `799814b`.
**Deployment:** active.
**Risks / follow-up:** prompt change is not validated edge; target study still failed. Wait for enough feature-rich forward samples before refitting.

---
### 2026-10-26 - JEV feature collection and prompt update

**Status:** implemented; deploy pending
**Area:** AI / data collection
**What changed:**
- JEV log records now include the full available snapshot feature set: momentum, volatility, oscillators, order-flow proxies, regime, signals, ML and market state.
- Settle question now explicitly asks for a calibrated probability, using market odds as prior and warning against extreme 0/1 answers.
- No runtime decision changes; JEV remains shadow.
**Why:** target study failed with the old feature set, and historical tape is unavailable (only the current hour). New enriched logs are required before a dedicated outcome model can be tested.
**Files / commits:** bot/src/ai/jevAdvisor.ts; UPDATES.md.
**Verification:** bot typecheck PASS; JEV tests 20/20 PASS; build PASS.
**Deployment:** pending CI/auto-deploy.
**Risks / follow-up:** prompt change affects future JEV outputs only; do not interpret it as validated edge. Re-run the target study after enough feature-rich forward samples.

---
### 2026-10-26 - JEV walk-forward target study (record-only)

**Status:** completed; no production change
**Area:** AI / evaluation
**What changed:**
- Added bot/scripts/jevTargetStudy.mts: 6 expanding walk-forward folds, 372 OOF predictions, market/stack models, paired bootstrap, coverage-aware Brier.
- Primary target failed: stack Brier 0.2349/0.2350 vs market 0.2290; bootstrap lower bound above zero (stack significantly worse).
- Secondary target failed for stack at n>=100; 30% slice (n=111) is market 0.1953, stack 0.2121/0.2148. 20% stack slice is 0.1997 but n=74.
- JEV remains shadow; no gate/veto/sizing change.
**Files / commits:** bot/scripts/jevTargetStudy.mts; analysis/2026-10-26/jev-target-study.md; UPDATES.md.
**Verification:** bot typecheck PASS; study run on VPS with 619 markets.
**Deployment:** analysis-only; no runtime behavior change.
**Risks / follow-up:** current JEV features do not beat market. Add new features and retrain/refit on future data; do not activate JEV.

---
### 2026-10-26 - JEV stacking study (record-only)

**Status:** completed; no production change
**Area:** AI / evaluation
**What changed:**
- Added bot/scripts/jevStackStudy.mts: time-split logistic stacking of market, JEV calibrated and ML, with paired bootstrap and coverage-aware Brier.
- Test Brier: market 0.2409, JEV 0.2444, ML 0.2496, best stack 0.2407 (skill +0.07%, 95% CI -0.00644 to +0.00607).
- All-market Brier below 0.20 not achieved; only top 10% confidence slice is below 0.20 (n=18).
- JEV remains shadow; gate/veto/sizing unchanged.
**Files / commits:** bot/scripts/jevStackStudy.mts; analysis/2026-10-26/jev-stacking-study.md; UPDATES.md.
**Verification:** bot typecheck PASS; study run on VPS with 618 matched markets (432 train / 186 test).
**Deployment:** analysis-only script; no runtime behavior change.
**Risks / follow-up:** CI includes zero; do not activate JEV. Re-run on 100+ future policy entries and require the lower CI below zero.

---
### 2026-10-26 — JEV calibration deployed

**Status:** deployed / verified
**Area:** AI / evaluation
**What changed:**
- Monotone PAVA calibration for JEV settle probabilities is live (`2026-10-26-pava-70`).
- Raw and calibrated settle values are both recorded; gate/veto/sizing use calibrated when available.
- Dashboard JEV panel shows calibrated settle and calibrated edge vs market.
- Evaluator now prints raw vs calibrated Brier, calibrated buckets and direction-normalized Brier.
**Verification:** deployed `376de5b` at 21:12:46 WIB; bot active; JEV shadow; evaluator matched 617 markets: raw settle Brier 0.3331 → calibrated 0.2331; market 0.2279; ML 0.2317; direction 59.8% vs rule 61.3%.
**Files / commits:** bot/src/ai/jevSettleCalibration.ts; bot/src/ai/jevAdvisor.ts; bot/scripts/jevEvaluate.mts; src/components/JevPanel.tsx; tests; analysis/2026-10-26/jev-calibration.md; `376de5b`.
**Deployment:** active.
**Risks / follow-up:** calibrated probability is still worse than the market and the OOS test was 0.2437. Do not activate JEV gate/veto; collect 100+ policy entries and re-fit on a future slice.

---
### 2026-10-26 — JEV settle calibration + shadow guard

**Status:** implemented; deploy pending
**Area:** AI / evaluation
**What changed:**
- Added monotone PAVA calibration for JEV settle probabilities (`jevSettleCalibration.ts`); raw and calibrated values are both recorded.
- JEV gate/veto/sizing now uses the calibrated value when present; older injected/test decisions fall back to raw.
- JEV panel shows the calibrated settle value and calibrated edge vs market.
- `jevEvaluate.mts` now reports raw vs calibrated Brier, calibration buckets and direction-normalized Brier.
**Evidence:** time-split (431 train / 186 test) raw Brier 0.3451 → calibrated 0.2437; market 0.2279. Calibration improves overconfidence but JEV remains worse than market.
**Files / commits:** bot/src/ai/jevSettleCalibration.ts; bot/src/ai/jevAdvisor.ts; bot/src/ai/__tests__/jevSettleCalibration.test.ts; bot/src/ai/__tests__/jevAdvisor.test.ts; bot/scripts/jevEvaluate.mts; src/components/JevPanel.tsx; analysis/2026-10-26/jev-calibration.md; UPDATES.md.
**Verification:** bot/frontend typecheck PASS; JEV tests 20/20 PASS; build PASS.
**Deployment:** pending CI/auto-deploy.
**Risks / follow-up:** calibration is fitted on a short 2026-10-19..25 sample and does not create an edge. Keep JEV in shadow; JEV gate/veto must not be activated until 100+ forward entries show incremental value.

---
### 2026-10-25 — Dry-run entry cap raised to 80c

**Status:** active
**Area:** configuration / trade selection
**What changed:**
- `DRY_RUN_HARD_ENTRY_CAP` changed from `0.75` to `0.80` in `/opt/polybtc15/bot/.env`; bot restarted with no open position.
- `EVAL_WINDOW_START` reset to `2026-10-25T13:54:17Z` because the entry selection changed.
- `TIME_GATES_ENABLED=false` and `BLOCKED_SESSIONS=","`; there is no weekend or session blackout gate.
**Files / commits:** `/opt/polybtc15/bot/.env` (VPS only); UPDATES.md.
**Verification:** startup warning confirms dry-run hard cap 68c → 80c; bot active; no position at restart; feed startup normal.
**Risks / follow-up:** dry-run only—live base cap remains 0.68; soft 63c ceiling still applies unless the high-edge/ML bypass clears it. Raising the cap adds lower-quality trades; evaluate the new window separately.

---
### 2026-10-26 — FRED integration deployed

**Status:** deployed / verified
**Area:** monitoring / data
**What changed:**
- FRED macro adapter is live on the VPS; credential read from protected `/etc/poly15/global-risk.env`.
- Snapshot now carries CPI, Fed funds, 10Y, VIX and unemployment, plus upcoming CPI/NFP/GDP/PCE/PPI/retail releases (6-hour cache).
- Release calendar is deduplicated and filtered to real release names; noisy daily FOMC rows were removed.
- Global Risk panel shows the FRED series and next release. No trading behavior uses this data.
**Files / commits:** bot/src/monitoring/fredClient.ts; bot/src/monitoring/globalRisk.ts; src/components/GlobalRiskPanel.tsx; `2e2df4e`, `848a6cb`.
**Verification:** FRED status `ok`; CPI 3.72% y/y, FED 3.75%, 10Y 4.96%, VIX 19.03, unemployment 4.20%; next releases GDP/PCE on 2026-10-29; panel rendered with no page errors; auto-deploy success at 20:07:36 WIB.
**Deployment:** active.
**Risks / follow-up:** FRED observations are latest revisions (not vintage/point-in-time); release dates have no time-of-day; key was exposed in chat and should be rotated later.

---
### 2026-10-26 — FRED macro integration

**Status:** implemented; deploy pending
**Area:** monitoring / data
**What changed:**
- Added `bot/src/monitoring/fredClient.ts`: reads `FRED_API_KEY` from env or protected `/etc/poly15/global-risk.env` / `~/.poly15/global-risk.env`.
- Caches CPI, Fed funds, 10Y, VIX, unemployment and upcoming CPI/NFP/FOMC/GDP/PCE/PPI/retail releases for 6 hours.
- Global Risk snapshots now include `fred`; dashboard panel shows the latest series and next release.
- No trading behavior changed; event gate remains inactive.
**Files / commits:** bot/src/monitoring/fredClient.ts; bot/src/monitoring/globalRisk.ts; src/components/GlobalRiskPanel.tsx; UPDATES.md.
**Verification:** bot/frontend typecheck PASS; production build PASS; live FRED CPIAUCSL and release-dates requests returned HTTP 200.
**Deployment:** pending CI/auto-deploy.
**Risks / follow-up:** released values are latest revisions, not point-in-time vintages; release dates have no time-of-day. Key was exposed in chat earlier; rotate later if desired.

---
### 2026-10-25 — Global Risk paused; FRED credential stored

**Status:** paused; credential stored and validated
**Area:** monitoring / configuration / security
**What changed:**
- Global Risk work paused per operator request; no further ACLED/GDELT integration or event-gate changes.
- FRED API credential stored outside the repository in `/etc/poly15/global-risk.env` (VPS, mode 640 root:ubuntu) and a local user-only copy under `%USERPROFILE%\.poly15`.
- FRED key validated with a read-only CPIAUCSL series request (HTTP 200).
- No trading behavior changed; collector remains record-only.
**Files / commits:** UPDATES.md only; no code changes.
**Verification:** VPS file mode 640 root:ubuntu; local ACL only current user; FRED series lookup returned CPIAUCSL; key not written to git.
**Deployment:** docs-only; auto-deploy will skip server restart.
**Risks / follow-up:** FRED key was exposed in chat; rotate it later if desired and update both stored copies. Global Risk panel remains present but paused.

---
### 2026-10-23 — Hidden widgets no longer block drag (deployed)

**Status:** deployed / verified
**Area:** dashboard / UX
**What changed:** collision checks for drag/resize now use the visible layout. Slots occupied by hidden widgets are treated as free.
**Files / commits:** src/components/dashboard/DashboardShell.tsx; `25cd873`.
**Verification:** hid `limitOrder`, dragged Global Risk from x0/y15 into its old x4/y13 slot — move succeeded; no red occupied guideline.
**Deployment:** active at 22:54:36 WIB.
**Risks / follow-up:** hard refresh; hidden widgets remain recoverable from Widgets library.

---
### 2026-10-23 — Hidden widgets no longer block drag

**Status:** implemented; deploy pending
**Area:** dashboard / UX
**What changed:**
- Drag/resize collision checks now use only visible widgets; slots occupied by hidden widgets are treated as free.
- This removes the red “occupied” guideline over visually empty areas.
**Files / commits:** src/components/dashboard/DashboardShell.tsx; UPDATES.md.
**Verification:** frontend typecheck/build PASS; browser test after deploy.
**Deployment:** pending CI/auto-deploy.
**Risks / follow-up:** hard refresh; hidden widgets remain recoverable from the widget library.

---
### 2026-10-23 — Drag fallback deployed

**Status:** deployed / verified
**Area:** dashboard / UX
**What changed:** occupied-cell drops now move the widget to the nearest free slot instead of snapping back; this was the reason “custom move” looked broken on a nearly-full grid.
**Files / commits:** src/components/dashboard/DashboardShell.tsx; `f54856f`.
**Verification:** browser test: Global Risk dragged onto an occupied cell moved from x0 to x2; no page errors; auto-deploy success at 22:45:09 WIB.
**Deployment:** active.
**Risks / follow-up:** hard refresh once; use Edit layout and drag from the widget header; Auto arrange remains the cleanest reset.

---
### 2026-10-23 — Drag fallback for occupied cells

**Status:** implemented; deploy pending
**Area:** dashboard / UX
**What changed:** dragging a widget onto an occupied 12-column cell now moves it to the nearest free slot instead of snapping back and showing “occupied”.
**Files / commits:** src/components/dashboard/DashboardShell.tsx; UPDATES.md.
**Verification:** frontend typecheck/build PASS; full-grid drag test after deploy.
**Deployment:** pending CI/auto-deploy.
**Risks / follow-up:** drop-to-nearest is more forgiving but less precise; use Edit layout + Auto arrange for a clean layout.

---
### 2026-10-23 — Global Risk migration v2

**Status:** deployed
**Area:** dashboard / UX
**What changed:** bumped the one-time layout migration key so browsers that already ran the first migration also re-flow Global Risk after the visible-layout placement fix.
**Files / commits:** src/components/dashboard/DashboardShell.tsx; `4cafe74`.
**Verification:** auto-deployed at 22:35:56 WIB; source clean; services active.
**Deployment:** active.
**Risks / follow-up:** hard refresh required once; drag/auto-arrange remains available for custom layouts.

---
### 2026-10-23 — Global Risk layout gap fixed

**Status:** deployed / verified
**Area:** dashboard / UX
**What changed:**
- Removed the fixed y:16 default slot that placed Global Risk at the bottom of saved layouts.
- Added a one-time migration for layouts that already stored the old y:16 position.
- Auto-placement for new widgets now uses the **visible** widget layout, so hidden widgets no longer reserve old slots and create a large vertical gap.
**Files / commits:** src/App.tsx; src/components/dashboard/DashboardShell.tsx; UPDATES.md; `bad63db`.
**Verification:** simulated saved layout with 11 hidden widgets + Global Risk at y:16 → after reload Global Risk is at y:5, only 14px below the last visible widget; no page errors.
**Deployment:** active via auto-deploy.
**Risks / follow-up:** the migration runs once per browser; a hard refresh is required to load the new bundle.

---
### 2026-10-23 — Global Risk layout placement fix

**Status:** implemented; deploy pending
**Area:** dashboard / UX
**What changed:**
- Removed the fixed `y:16` default position from the Global Risk widget; new widgets now use the first free 4x3 slot.
- Added a one-time migration for already-saved layouts that placed Global Risk at the old y:16 slot, so it is re-flowed instead of leaving a large gap.
**Files / commits:** src/App.tsx; src/components/dashboard/DashboardShell.tsx; UPDATES.md.
**Verification:** frontend typecheck/build PASS; needs browser verification after deploy.
**Deployment:** pending CI/auto-deploy.
**Risks / follow-up:** users with heavily customized layouts may still prefer to drag the widget; the migration only removes the old default position once.

---
### 2026-10-23 — Global risk pilot deployed

**Status:** deployed / verified
**Area:** monitoring / analytics
**What changed:**
- Auto-deployed `34ef67d` at 22:17:55 WIB; collector, panel and event-study script are live.
- Collector pulls Google News RSS (crypto + market-relevant geopolitics) and Cointelegraph, combines existing ForexFactory macro and F&G sentiment, and writes 5-minute snapshots to `bot/data/global_risk.jsonl`.
- First live snapshot: risk MEDIUM (48), F&G 50 neutral, macro clear, 14 negative headlines.
- Headlines are filtered to the last 24h and geopolitical items require a market/policy relevance keyword.
- Dashboard Global Risk panel renders with no page errors. No entry/sizing/exit rule uses this data.
**Files / commits:** bot/src/monitoring/globalRisk.ts; src/components/GlobalRiskPanel.tsx; bot/scripts/globalRiskStudy.mjs; analysis/2026-10-23/global-risk-pilot.md; `34ef67d`.
**Verification:** source clean at `34ef67d`; bot/auth/nginx/health/auto-deploy active; no failed units; collector log + JSONL observed; panel rendered; event study currently 0 joined trades (snapshots younger than trades).
**Deployment:** active.
**Risks / follow-up:** GDELT returned 429 from the VPS; FRED/CryptoPanic/ACLED/UCDP need credentials/approval; keyword risk scoring is heuristic. Do not use as a gate until forward evaluation.

---
### 2026-10-23 — Global-risk relevance filter

**Status:** implemented; deploy pending
**Area:** monitoring / analytics
**What changed:**
- Geopolitical RSS results now require a market/policy relevance keyword (oil, energy, dollar, Fed, sanctions, tariff, trade, China, Russia, etc.).
- Generic conflict headlines no longer inflate the risk score.
- The Global Risk panel remains record-only; no trading rule uses it.
**Files / commits:** bot/src/monitoring/globalRisk.ts; UPDATES.md.
**Verification:** build/typecheck pending; snapshot after deploy will show the filtered count.
**Deployment:** pending CI/auto-deploy.
**Risks / follow-up:** keyword filtering is a heuristic; continue collecting forward snapshots.

---
### 2026-10-23 — Global risk collector live

**Status:** deployed; quality patch pending auto-deploy
**Area:** monitoring / analytics
**What changed:**
- `globalRisk.ts` started with the bot: 5-minute snapshots, RSS headlines, existing macro calendar and F&G sentiment.
- First snapshot: MEDIUM, 24 headlines, 11 negative; stored in `bot/data/global_risk.jsonl`.
- Global Risk panel is visible in the dashboard and shows macro, sentiment, headlines and freshness.
- Follow-up patch filters headlines to the last 24h and fetches sentiment on first refresh.
**Files / commits:** bot/src/monitoring/globalRisk.ts; src/components/GlobalRiskPanel.tsx; bot/scripts/globalRiskStudy.mjs; analysis/2026-10-23/global-risk-pilot.md; UPDATES.md.
**Verification:** collector log + JSONL observed; panel rendered; no page errors; bot/frontend typecheck/build PASS.
**Deployment:** collector deployed at 22:08 WIB; quality patch pending CI/auto-deploy.
**Risks / follow-up:** keyword scoring is noisy; GDELT was 429 from VPS; no historical snapshots yet. Record-only, not a gate.

---
### 2026-10-23 — Global risk pilot (record-only)

**Status:** implemented; deploy/verification pending
**Area:** monitoring / analytics
**What changed:**
- Added `bot/src/monitoring/globalRisk.ts`: 5-minute keyless RSS collector (Google News crypto/geopolitics + Cointelegraph), combining existing ForexFactory macro and F&G/CoinGecko sentiment.
- Stores timestamped snapshots in `bot/data/global_risk.jsonl`; no trading behavior uses it.
- Added `GlobalRiskPanel` to the dashboard (risk level, macro window, sentiment, headlines, freshness).
- Added `bot/scripts/globalRiskStudy.mjs` to evaluate trades during risk windows once forward data exists.
**Files / commits:** bot/src/monitoring/globalRisk.ts; bot/index.ts; bot/src/loop.ts; src/components/GlobalRiskPanel.tsx; src/App.tsx; bot/scripts/globalRiskStudy.mjs; analysis/2026-10-23/global-risk-pilot.md; UPDATES.md.
**Verification:** bot/frontend typecheck PASS; RSS endpoints tested from VPS; GDELT returned 429 and is deferred.
**Deployment:** pending CI + auto-deploy.
**Risks / follow-up:** keyword scoring is noisy; no historical snapshots; do not use as a gate until forward evidence.

---
### 2026-10-23 — Shadow study release auto-deployed

**Status:** deployed / verified
**Area:** analytics / deployment
**What changed:**
- Auto-deployed commit `4345b9f` at 21:21:11 WIB; source is clean at `4345b9f`.
- Shadow decision study script and pre-registered filter rules are now on the VPS.
- Auto-deploy used the normal CI-gated path; no manual source copy was needed after the worktree was clean.
**Verification:** bot/auth/nginx/tunnel/health/auto-deploy active; `systemctl --failed` clean; source clean; study JSON written; bot still DRY RUN, 833 trades, no open position.
**Deployment:** active.
**Risks / follow-up:** forward checkpoints, a real challenger candidate, remote offsite/Cloudflare credentials, and live readiness remain.

---
### 2026-10-23 — Shadow decision study and pre-registration

**Status:** implemented / record-only
**Area:** ML / analytics
**What changed:**
- Added `bot/scripts/shadowDecisionStudy.mjs`: current-model time split 60/40, Wilson intervals, candidate filter comparison, and a champion/challenger gate.
- On 374 current-model trades (train 224 / test 150):
  - `no-Europe+MID`: test 80 trades, 67.5% WR, +7.04pp margin, +$12.93
  - `no-sideProb-0.6`: test 81 trades, 71.6% WR, +9.86pp margin, +$16.29
  - `no-LATE` and `no-sideProb-0.8`: failed the split
  - combined small filter: 75.8% but only 33 test trades — not promoted
- Added `analysis/2026-10-23/pre-registered-filter-rules.md` with frozen candidates, sequential checkpoints, promotion rules and champion gate.
**Files / commits:** bot/scripts/shadowDecisionStudy.mjs; analysis/2026-10-23/shadow-decision-study.md; analysis/2026-10-23/pre-registered-filter-rules.md; UPDATES.md.
**Verification:** script executed on the VPS journal and wrote `bot/data/shadow_decision_study.json`; no trading rule was changed.
**Deployment:** record-only; source will be deployed by the normal auto-deploy path.
**Risks / follow-up:** split results are selection/validation on the same model history; forward checkpoints are still required. No champion candidate exists yet.

---
### 2026-10-23 — Encrypted backup release auto-deployed

**Status:** deployed / verified
**Area:** backup / security / deployment
**What changed:**
- Auto-deployed commit `9878a22` at 14:38:16 WIB after CI success; source is clean at `9878a22`.
- Encrypted secrets and data backup scripts are now the live versions.
- Dirty-worktree guard blocked the first attempt because the scripts had been installed manually; after cleaning, the normal release path succeeded.
**Verification:** bot/auth/nginx/tunnel/health/auto-deploy active; `systemctl --failed` clean; `DRY_RUN=true`; Kelly 0.18; no open position; backup scripts executable.
**Deployment:** active.
**Risks / follow-up:** key loss means backup loss; remote offsite still needs credentials. Confidence guard/champion and forward filters still need a forward sample.

---
### 2026-10-23 — Encrypted data backup and local offsite copy

**Status:** deployed / verified
**Area:** backup / security
**What changed:**
- `backup-data.sh` now writes `/opt/polybtc15/backups/data-YYYYMMDD-HHMMSS.tar.gz.enc` with the same root-only AES-256 key.
- Old plaintext data archives are retained until normal 14-day retention.
- Latest encrypted secrets and data archives were copied to the local machine as a simple offsite copy.
**Files / commits:** scripts/backup-data.sh; docs/VPS.md; UPDATES.md.
**Verification:** manual run produced a 905 KB encrypted archive; decrypt + tar-list check passed; local key is ACL-restricted to the current user.
**Deployment:** active; next timer run uses the encrypted script.
**Risks / follow-up:** key loss means archive loss. Remote offsite storage still requires credentials.

---
### 2026-10-23 — Encrypted secrets backup

**Status:** deployed / verified
**Area:** security / backup
**What changed:**
- `backup-secrets.sh` now encrypts the archive with AES-256-CBC/PBKDF2 and verifies it can be decrypted before reporting success.
- New archive format: `/home/ubuntu/backups/secure/polybtc15-secrets-YYYY-MM-DD.tar.gz.enc`.
- Key generated root-only at `/root/.poly15-backup.key`; a secure local copy was written to `C:\Users\Asus\.poly15\backup\backup.key` without printing it.
- Existing unencrypted archives are retained until normal 30-day retention; new backups are encrypted.
**Files / commits:** scripts/backup-secrets.sh; docs/VPS.md; UPDATES.md.
**Verification:** manual run produced `.enc`; decrypt + tar-list check passed; key length/ownership verified; no secret printed.
**Deployment:** active on VPS; next timer uses it.
**Risks / follow-up:** key loss means backup loss; key must be stored securely. Off-site replication still needs a destination/credentials. Data backups remain separate.

---
### 2026-10-23 — Monitoring/calibration release auto-deployed

**Status:** deployed / verified
**Area:** ops / monitoring / risk
**What changed:**
- Auto-deployed commit `751bbb2` at 13:10:31 WIB after CI success; source is clean at `751bbb2`.
- Health alert timer is active (failed units, critical services, disk/swap, bot/auth endpoints, auto-deploy result).
- Windows password sync task is tested (last result 0; next run 2026-10-24 07:05 WIB).
- `KELLY_PROB_SHRINK=0.18` remains active after restart.
- Calibration/filter study is stored at analysis/2026-10-23/calibration-filter-study.md.
**Verification:** bot active in DRY RUN, 833 trades / 536W-297L, no open position; boot/auth/nginx/tunnel/health/auto-deploy timers active; `systemctl --failed` clean; no health issues recorded.
**Deployment:** active via auto-deploy.
**Risks / follow-up:** confidence guard and champion/challenger need a forward holdout; session filters were not hardcoded; external Cloudflare/offsite credentials and live-readiness work remain separate.

---
### 2026-10-23 — Health alerting and daily password sync

**Status:** deployed / verified
**Area:** ops / security
**What changed:**
- Added `poly15-health-alert.timer`: checks failed systemd units, critical services, disk >=85%, swap >=80%, bot/auth health endpoints and auto-deploy last result. Sends Telegram only when the issue set changes.
- Installed and tested the health timer; current state has zero issues.
- Added `scripts/sync-dashboard-password.ps1` and a Windows scheduled task at 07:05 WIB to pull the rotated password fallback without printing it.
- Updated the local SSH known-host entry after verifying the VPS ED25519 fingerprint via an authenticated channel.
**Files / commits:** scripts/health-alert.sh; scripts/poly15-health-alert.service; .timer; scripts/install-health-alert.sh; scripts/sync-dashboard-password.ps1; UPDATES.md.
**Verification:** health service exit 0, timer active, `systemctl --failed` clean; scheduled task last result 0. New task next run 2026-10-24 07:05 WIB.
**Deployment:** active.
**Risks / follow-up:** health alert is host-local; password task depends on the local SSH key.

---

### 2026-10-23 — Calibration study and Kelly shrink 0.18

**Status:** analysis complete; sizing applied
**Area:** ML / risk
**What changed:**
- Ran the 60/40 calibration study on 832 rows: best shrink 0.15; test Brier model 0.2561, market 0.2286, shrunk 0.2277.
- Set `KELLY_PROB_SHRINK=0.18` on the VPS (was absent/default 0.5); bot restarted cleanly in DRY RUN.
- Documented current-model forward buckets: Europe and MID negative; side-probability 0.6 and 0.8 buckets negative; 0.7 bucket positive. No hard entry filter was added.
**Files / commits:** analysis/2026-10-23/calibration-filter-study.md; UPDATES.md; VPS `bot/.env`.
**Verification:** bot active, 833 trades / 536W-297L, no open position; calibration report generated; no code entry-rule change.
**Deployment:** sizing active; analysis record-only.
**Risks / follow-up:** confidence guard and champion/challenger still need a held-out forward sample; do not hardcode Europe/MID filters yet.

---
### 2026-10-23 — Logrotate repair and manual password rotation

**Status:** deployed / verified
**Area:** ops / security
**What changed:**
- Removed `rsyslog.bak-*` from `/etc/logrotate.d`; logrotate was failing because the backup was parsed as a duplicate config.
- `logrotate.service` now exits successfully; `systemctl --failed` is clean.
- An audit command exposed a password fallback; the password was rotated immediately, the old password invalidated, and the local password file resynced without printing the new value.
**Files / commits:** UPDATES.md; VPS `/root/rsyslog.bak-*`; rotation script output.
**Verification:** logrotate debug has no errors; old local password 401, new password 200; services active; bot 829 trades / 534W-295L, WR 64.5%, PnL +$15.75, no open position, DRY RUN.
**Deployment:** active.
**Risks / follow-up:** never print secret-file contents in audit output. Consider a safer password sync mechanism. Model Brier remains -5.7% vs market.

---
### 2026-10-23 — Swap increased to 4 GB

**Status:** deployed / verified
**Area:** ops / capacity
**What changed:**
- Added `/swap2.img` 2 GB, enabled it, and persisted it in `/etc/fstab`.
- Existing `/swap.img` 2 GB is unchanged.
- Total swap is now 4 GB; no application or service change.
**Files / commits:** UPDATES.md; VPS `/swap2.img`; `/etc/fstab`.
**Verification:** `free -h` shows 4.0 GiB total; `swapon --show` lists both files; `/proc/swaps` active; disk 11 GB used / 39 GB (29%), 27 GB free; bot/auth/nginx/auto-deploy all active.
**Deployment:** active; persistent across reboot.
**Risks / follow-up:** swap is slower than RAM; monitor `free -h` and `vmstat` (`si/so`). If swap is heavily active, add RAM instead. Disk cost is 2 GB.

---
### 2026-10-22 — Log-throttle release auto-deployed

**Status:** deployed / verified
**Area:** bot / ops / monitoring
**What changed:**
- Auto-deployed commit `4311ea4` at 23:50:14 WIB after CI success; source is clean at `4311ea4`.
- The per-poll INFO summary is now emitted once every 200 polls (debug mode keeps every poll), reducing syslog generation drastically.
- `scripts/nginx-token-sync.sh` mode is fixed in git (0755); auth-sync service now completes successfully.
- Logrotate is daily + maxsize 100M + rotate 7 with `su root syslog`; old syslog compressed to 68 MB.
**Verification:**
- Bot 815 trades, 526W/289L, paper bankroll $62.18, no open position, DRY RUN.
- Services active: bot, auth, nginx, rsyslog, auto-deploy timer; `systemctl --failed` clean.
- Disk 8.2 GB used / 39 GB (22%), 29 GB free; journal 940 MB; active syslog 2.1 MB.
- The dirty-worktree guard also caught the temporary manual `chmod` at 23:48 and blocked the deploy until it was cleaned.
**Files / commits:** bot/src/loop.ts; scripts/nginx-token-sync.sh; UPDATES.md; `4311ea4`.
**Deployment:** active via auto-deploy.
**Risks / follow-up:** logrotate is host-local; old source backups remain intentionally.

---
### 2026-10-22 — Disk pressure root cause, auth-sync repair, log throttle

**Status:** implemented; auto-deploy verification pending
**Area:** ops / monitoring / bot
**What changed:**
- Found `/var/log/syslog` at 1.4 GB because the bot logged a full poll summary every ~50 ms; `/var/log` was also group-writable, so logrotate had been refusing to rotate.
- Fixed logrotate: daily + maxsize 100M + rotate 7 + `su root syslog`; rotated and compressed old syslog (1.4 GB → 68 MB). Journal capped/vacuumed to ~940 MB; apt cache cleaned.
- Fixed `polybot-dashboard-auth-sync.service`: `scripts/nginx-token-sync.sh` lost its execute bit after the bootstrap reset; restored 0755 and reset the failed quick-tunnel unit.
- Reduced per-poll INFO logging to one summary every 200 polls (debug mode still logs every poll); this is the code change deployed by auto-deploy.
**Files / commits:** bot/src/loop.ts; scripts/nginx-token-sync.sh mode; UPDATES.md; VPS logrotate config.
**Verification:** auth-sync service completes 0/SUCCESS; `systemctl --failed` clean; disk 8.2 GB used (22%); syslog rotation debug clean; bot still DRY RUN.
**Deployment:** ops fixes active; bot log-throttle code awaiting CI/auto-deploy.
**Risks / follow-up:** logrotate config is host-local; re-check after OS upgrades. Old bootstrap source backups remain intentionally.

---
### 2026-10-22 — Daily health check and storage cleanup

**Status:** verified
**Area:** ops / docs
**What changed:**
- Rotated dashboard password ran successfully at 07:00 WIB; old local password returned 401, new fallback password returned 200; local password file resynced without exposing it in chat.
- Journald capped at 1 GB (`/etc/systemd/journald.conf.d/90-poly15.conf`); journal usage went from 2.4 GB to ~981 MB, disk from 32% to 27% used.
- Reviewed the latest dry-run report and services.
**Files / commits:** UPDATES.md; VPS config `/etc/systemd/journald.conf.d/90-poly15.conf`.
**Verification:**
- Bot: 814 trades, 525W/289L, WR 64.6%, paper bankroll $61.45, no open position, DRY RUN.
- Latest report: 813 resolved, +$16.20; current model 355 trades, 61.4% WR, +$5.02; Brier skill vs market -5.6% (still negative).
- Services active: bot, auth, nginx, tunnel, watchdog, auto-deploy timer; bot NRestarts=0 since 2026-10-21 22:02 WIB.
- Daily data backups through 2026-10-22 and secure secrets backups through 2026-10-22 exist.
**Deployment:** docs/ops only; no code change.
**Risks / follow-up:** model still has negative Brier skill and Europe remains weak; keep DRY RUN. Auto-deploy remains dry-only/guarded.

---
### 2026-10-21 — Auto-deploy push detection verified

**Status:** verified
**Area:** ops / deployment
**What changed:** pushed docs commit `bffb86a`; the VPS timer detected it at 22:08:10 WIB after CI success and classified it as **docs-only**, so the bot was not restarted. State kept `deployed_sha=c24fa17` and advanced `last_seen_sha=bffb86a`.
**Files / commits:** UPDATES.md; docs/AUTO_DEPLOY.md; `bffb86a`.
**Verification:** `.auto-deploy/auto-deploy.log` shows `docs-only; no server deploy`; bot remained active; source stayed at `c24fa17`.
**Deployment:** timer active every 5 minutes.
**Risks / follow-up:** code commits still wait for no open position; live mode and paused state block auto deploy by design.

---
### 2026-10-21 — Auto-deploy active and verified

**Status:** deployed / verified
**Area:** ops / deployment / security
**What changed:**
- VPS was bootstrapped from the stale 370-commit-behind worktree to a clean `c24fa17` checkout; source backup was taken first.
- Installed the CI-gated pull timer `poly15-auto-deploy.timer` (every 5 minutes).
- The timer refused to deploy while a paper position was open (21:52 and 21:57) and deployed automatically after settlement.
- Successful auto-deploy at 22:02:43–22:03:05 WIB: temp-worktree build, guarded switch, health checks, state `success`.
- Bot restarted in DRY RUN; auth, nginx and password timer remain active.
**Files / commits:** scripts/auto-deploy.sh; systemd units; scripts/install-auto-deploy.sh; docs/AUTO_DEPLOY.md; feature commit `c24fa17`.
**Verification:** full auto path observed in the journal and `.auto-deploy/auto-deploy.log`; git worktree clean at `c24fa17`; auth/bot health OK; current password login 200; Telegram success alert sent.
**Deployment:** active on the VPS.
**Risks / follow-up:** auto-deploy is deliberately disabled in live mode and while paused; deploy script changes require re-running the installer; dirty tracked worktree blocks deploy.

---
### 2026-10-21 — GitHub auto-deploy (pull timer)

**Status:** implemented; bootstrap pending
**Area:** ops / deployment / security
**What changed:** VPS systemd timer checks origin/main every 5 minutes; requires all GitHub Actions checks green, builds in a temp worktree, refuses live/paused/open-position deploys, switches source/node_modules/dist with rollback, and sends Telegram alerts.
**Files / commits:** scripts/auto-deploy.sh; scripts/poly15-auto-deploy.service; scripts/poly15-auto-deploy.timer; scripts/install-auto-deploy.sh; docs/AUTO_DEPLOY.md.
**Verification:** bash -n PASS; CI will run on the commit; end-to-end deploy test pending.
**Deployment:** not yet installed/timer not yet active.
**Risks / follow-up:** live mode is deliberately manual; dirty worktree blocks deploy; installed script must be refreshed manually when the script itself changes.

---
### 2026-10-21 — Update-log policy enforced

**Status:** implemented
**Area:** docs / process
**What changed:** added a mandatory update-log policy to CLAUDE.md. Every future change affecting behaviour, deployment, security, data, configuration or user-visible docs must append a dated entry to UPDATES.md in the same session, newest first; a task is not complete until that entry exists.
**Files / commits:** CLAUDE.md; UPDATES.md.
**Verification:** policy is at the top of CLAUDE.md; entry format follows the template below; no secrets included.
**Deployment:** docs only.
**Risks / follow-up:** keep entries factual and secret-free; corrections are new entries, not rewrites.

---
### 2026-10-21 — Living update log

**Status:** implemented
**Area:** docs / operations
**What changed:** replaced the one-off snapshot with this append-only update log; archived the detailed 2026-10-21 snapshot.
**Files / commits:** UPDATES.md; docs/updates/2026-10-21.md; README link.
**Verification:** links checked; document contains no secrets.
**Deployment:** docs only.
**Risks / follow-up:** update this file for every future change.

---

### 2026-10-21 — Live / dry-run switch from the dashboard

**Status:** deployed; live mode NOT activated
**Area:** trading / dashboard / security
**What changed:**
- Topbar DRY RUN / LIVE badge is now a button with a typed-confirmation dialog.
- Live preflight: CLOB V2 init + readiness/allowance + non-zero pUSD.
- Open positions block switching; paused/disconnected blocks the button.
- Live and dry-run use separate state, audit, journal, verified-journal and entry-snapshot files.
- Live bankroll is seeded from pUSD; live journal and position value use real fills.
- If live startup fails, the bot persists DRY_RUN=true and restarts into safe paper mode.
- Backend command is token-protected through the dashboard WebSocket.
**Files / commits:** bot/src/trading/tradingMode.ts; bot/src/statusServer.ts; bot/index.ts; bot/src/config.ts; src/components/dashboard/DashboardShell.tsx; src/App.tsx; f905d0d.
**Verification:** modal test (did not confirm live); guard tests; live/dry paths checked; full suite 91/941 PASS.
**Deployment:** VPS deployed; bot restarted in DRY RUN; no live order.
**Risks / follow-up:** pUSD ~$25 and 5-share minimum; JEV shadow; do not enable live yet. See detailed report.

---

### 2026-10-21 — Daily dashboard password rotation via Telegram

**Status:** deployed
**Area:** security / auth / ops
**What changed:**
- New random password every day at 07:00 WIB.
- scrypt hash written atomically to /opt/polybtc15/dashboard-password.hash.
- Auth server reads the hash per login; no restart and no session invalidation on rotation.
- Telegram delivery via existing bot token/chat; previous password message deleted when possible.
- Root-only fallback at /root/.poly15-dashboard-password-latest.
- Persistent systemd timer catches up once after downtime.
**Files / commits:** scripts/rotate-dashboard-password.mjs; scripts/dashboard-auth-server.mjs; service/timer; scripts/backup-secrets.sh; 029ace2.
**Verification:** dry run OK; Telegram test sent; hot-reload drill test password 200 → restore current password 200; timer next 2026-10-22 07:00 WIB.
**Deployment:** timer active.
**Risks / follow-up:** Telegram chat access exposes the password; fallback is root-only. First real rotation is the next 07:00 WIB.

---

### 2026-10-21 — Security hardening, clean UI, delivery and test hardening

**Status:** deployed
**Area:** security / UI / tests / delivery
**What changed:**
- Dashboard password rotated; previous password invalidated.
- Root-only daily secrets backup (auth.env, Cloudflare tunnel, nginx, units); restore drill passed.
- Clean UI pass: compact health indicator, overflow menu, removed descriptions/categories/duplicate titles, softer canvas.
- Drift gate tests and auth gateway HTTP tests added; CLOB cold-import timeout raised.
- Cloudflare Insights CSP fixed; Vite bundles split.
**Files / commits:** a5a9a7a.
**Verification:** 90 files / 938 tests PASS at that commit; browser checks; restore drill.
**Deployment:** VPS + nginx; bot active.
**Risks / follow-up:** model/trading unchanged; see the detailed snapshot.

---

### 2026-10-21 — Drift false-positive fix

**Status:** deployed
**Area:** monitoring / ML
**What changed:** drift detector now compares live accuracy to a live same-model baseline, not offline test accuracy, and uses a minimum 50-trade reference window.
**Files / commits:** bot/src/monitoring/driftDetector.ts; 214489b.
**Verification:** 5 gate tests; last check 50-trade acc 66% vs live baseline 64.06%, CUSUM 0, driftDetected:false.
**Deployment:** active.
**Risks / follow-up:** confidence is advisory only; no auto-action.

---

### 2026-10-21 — Price-source clarity, sticky-header blur, flat brand

**Status:** deployed
**Area:** UI / dashboard
**What changed:**
- ORACLE is the primary price source; Binance remains in Market Pulse with a BASIS label.
- Scroll blur veil prevents content smearing under the sticky header.
- Flat P monogram replaces the glossy mark; favicon/PWA/OG updated.
**Files / commits:** ab78886; 2faa995; 5377c17; c39b9a4.
**Verification:** browser screenshots and scrolled checks; 16/16 widgets.
**Deployment:** frontend deployed.
**Risks / follow-up:** none operational.

---

### 2026-10-20 — Dashboard cutover, login/session auth, bankroll labels, watchdog fix

**Status:** deployed
**Area:** infrastructure / auth / bot / UI
**What changed:**
- Dashboard moved to https://poly15.dollarkilat.xyz/ via a named Cloudflare Tunnel; Quick Tunnel disabled.
- Custom animated login page + session-auth gateway; nginx auth_request protects /ws and report APIs.
- Public dashboard WS auth recovery/reconnect improved.
- Startup log now distinguishes configured bankroll from loaded state; paper labels clarified.
- Bot heartbeat now advances on every completed poll, fixing false watchdog restarts during long signal holds.
- Smooth requestAnimationFrame drag/resize and mobile compact reorder.
**Files / commits:** be68356; b36642a; 59e7a4b; 28e2dc3; 9f00bbe; 792c161; e6b57ca; c20db0c; 2e577ca.
**Verification:** public URL, login/wrong-password/session/reload/logout, 16 widgets, desktop/tablet/mobile; bot stable.
**Deployment:** VPS + nginx + tunnel.
**Risks / follow-up:** named tunnel requires Cloudflare config; see docs/DOMAIN.md and docs/VPS.md.

---

### 2026-10-19 — JEV shadow layer, dashboard v4, CLOB V2/VPS cutover

**Status:** deployed; JEV shadow only
**Area:** trading / dashboard / infrastructure
**What changed:**
- JEV independent-v2 state through OpenRouter; entry-time decisions logged; no veto/size/execute.
- Dashboard v4 draggable/resizable widget workspace, presets, widget library, accent/density, layout persistence.
- CLOB V2 code deployed; live path still gated by pUSD funding, 5-share minimum and a final smoke order.
- Railway shut down; VPS is production.
- Dry-run-only early-time entry probe; live ceiling remains 68c (dry-run 75c).
**Files / commits:** e636fe1; 26c933c; cae3877; 4621106; 4f08eb1; and related 2026-10-19 commits.
**Verification:** dashboard interactions, JEV shadow logs, CLOB preflight read-only checks.
**Deployment:** VPS; bot DRY RUN.
**Risks / follow-up:** JEV sample too small; keep shadow until at least 100 resolved markets. Model/rule edge remains thin.

---

## Older detailed snapshots

- [2026-10-21 complete snapshot](docs/updates/2026-10-21.md) — detailed status, security, live/dry mode, ML metrics, verification and operations.
- [JEV independent-v2 calibration study](analysis/2026-10-19/jev-independent-v2-calibration-study.md)
- [Dashboard v4 report](analysis/2026-10-19/dashboard-v4-redesign.md)

---

## Entry template

~~~markdown
### YYYY-MM-DD — <short title>

**Status:** planned | implemented | deployed | verified | reverted
**Area:** dashboard / trading / ML / security / ops / docs
**What changed:**
- ...
**Files / commits:** ...
**Verification:** ...
**Deployment:** ...
**Risks / follow-up:** ...
~~~

## Rules

1. **Newest first** under `## Entries`
2. Update the **Current status** table at the top of the file in the same commit.
3. Every bullet must have evidence: a test run, an API response, a process status, or a dashboard observation. "Implemented X" is not an entry; "Implemented X; `npm run test` 92 passed; deployed to VPS; `pm2 logs` confirms Y" is.
4. A task that touched code or config is **not done** until its entry is in this file.
`.
2. **Append-only**: old entries stay; corrections are new entries titled `YYYY-MM-DD — Correction: ...`.
3. **One entry per change set**, not one per commit.
4. **State the truth**: if it is coded but not deployed, say so. If verified, say how.
5. **No secrets** — no password, token, key, cookie, tunnel credential, or private wallet data.
6. **Link evidence** — detailed report, screenshot, test count, commit hash.
7. **Update the current status table** when bot/security/ops state changes.
8. **Use WIB** for times; include UTC in parentheses only when needed.
9. **Definition of done:** before the final response, confirm the new UPDATES.md entry exists and matches the deployed state.
