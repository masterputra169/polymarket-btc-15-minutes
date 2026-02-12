# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Dev Commands

```bash
npm run dev      # Start Vite dev server on port 3000
npm run build    # Production build to dist/
npm run preview  # Preview production build
```

No test runner, linter, or TypeScript configured. The project uses vanilla JavaScript/JSX with ES modules.

### ML Model Training Pipeline (backtest/ml_training/)

```bash
# Full pipeline
./runTraining.sh --tune --deploy          # Optuna HPO + auto-deploy to public/ml/

# Step by step
node generateTrainingData.mjs --days 365  # Step 1: fetch Binance data to CSV
python trainXGBoost_v3.py --input training_data.csv --tune --tune-trials 100  # Step 2: train
# Outputs: output/xgboost_model.json, output/norm_browser.json → copy to public/ml/

# Backtest P&L simulation
python backtestPnL.py --threshold-sweep                     # Sweep 0.50-0.80
python backtestPnL.py --threshold 0.60 --bankroll 1000      # Single threshold
```

Trained model outputs (`xgboost_model.json`, `norm_browser.json`) go to `public/ml/`.

## Architecture

Real-time BTC 15-minute prediction terminal for Polymarket. React 19 + Vite 7, single-page with no router.

### Data Flow Pipeline

```
4 WebSocket Streams (Binance, Polymarket LiveData, Chainlink WSS, CLOB Orderbook)
        |
  useMarketData hook (src/hooks/useMarketData.js) -- central orchestrator, recalculates every 5s
        |
  10 Technical Indicators (src/indicators/) + 6 Decision Engines (src/engines/)
        |
  XGBoost ML inference (src/engines/Mlpredictor.js) -- 74-feature vector, browser-side tree traversal
        |
  7 Dashboard Panels (src/components/)
```

### Key Layers

- **`src/hooks/useMarketData.js`** -- The core hook (~600 lines). Orchestrates all WebSocket streams, polls Binance klines, runs indicator calculations, ML inference, feedback tracking, and assembles the final state object consumed by every component. Changes here affect everything.
- **`src/hooks/useBinanceStream.js`, `usePolymarketChainlinkStream.js`, `useChainlinkWssStream.js`, `usePolymarketClobStream.js`** -- Each manages one WebSocket connection with reconnect logic, heartbeat detection, and throttled state flushing (writes to refs, flushes to state 2x/sec).
- **`src/hooks/useCountdown.js`, `useClock.js`, `useThrottledState.js`** -- Utility hooks for smooth countdown timer, 1s clock, and throttled state updates.
- **`src/data/`** -- HTTP fetchers for Binance klines (`binance.js`), Polymarket market discovery (`polymarket.js`), and Chainlink RPC (`chainlinkRpc.js`). All HTTP calls go through Vite proxy (see `vite.config.js`).
- **`src/indicators/`** -- Pure functions computing technical indicators. Each returns a result object consumed by `useMarketData`:
  - `rsi.js` -- RSI (period 8) + RSI series + slope
  - `macd.js` -- MACD (6/13/5)
  - `vwap.js` -- Session VWAP + VWAP series (60-candle lookback)
  - `bollinger.js` -- Bollinger Bands (20, 2) + squeeze detection
  - `atr.js` -- ATR (14) + ATR ratio
  - `heikenAshi.js` -- Heiken Ashi candles + consecutive count
  - `emacross.js` -- EMA 8/21 crossover
  - `stochrsi.js` -- Stochastic RSI (14, 14, 3, 3)
  - `volumedelta.js` -- Volume delta (buy/sell pressure)
  - `fundingrate.js` -- Funding rate (Binance FAPI with Bybit fallback, cached 5min)
- **`src/engines/`** -- Decision and ML logic:
  - `probability.js` -- 21-point weighted scoring system
  - `edge.js` -- Model prob minus market price, phase-aware thresholds with regime-adaptive adjustment (trending relaxes, choppy tightens)
  - `regime.js` -- Market regime detection (trending/choppy/mean-reverting/moderate) with confidence scores
  - `Mlpredictor.js` -- XGBoost browser-side tree traversal with named feature splits, Platt calibration, pre-allocated Float64Array buffers
  - `feedback.js` -- Rolling accuracy tracking, per-regime stats, calibration buckets, streak tracking, slug-aware cleanup
  - `orderbook.js` -- Orderbook imbalance analysis
  - `multitf.js` -- Multi-timeframe (1m + 5m) confirmation
  - `volatility.js` -- Volatility profiling + realized vol
- **`src/components/`** -- 7 dashboard panels, all wrapped in `React.memo` with memoized prop slices:
  - `CurrentPriceCard.jsx` -- BTC price + countdown timer (full width)
  - `PredictPanel.jsx` -- Probability, recommendation, score breakdown
  - `TAIndicators.jsx` -- All technical indicator readings
  - `PolymarketPanel.jsx` -- Market prices, orderbook, CLOB source
  - `EdgePanel.jsx` -- Edge calculation, regime-aware thresholds, ML confidence
  - `MlPanel.jsx` -- ML engine status, rule vs ML comparison bars
  - `AccuracyPanel.jsx` -- Rolling accuracy (20/50/100), per-regime accuracy, calibration table, streak (full width)
  - `SessionInfo.jsx` -- ET time, trading session (full width)
- **`src/config.js`** -- All tunable parameters: indicator periods, WebSocket URLs, Polymarket series ID, Chainlink contract address.

### Vite Proxy Setup

Dev server proxies three APIs to avoid CORS:
- `/gamma-api` -> `https://gamma-api.polymarket.com` (market discovery)
- `/clob-api` -> `https://clob.polymarket.com` (orderbook/prices)
- `/binance-api` -> `https://data-api.binance.vision` (klines)

### ML Model

- **Model**: XGBoost v6, 74 features (49 base + 25 engineered), Platt-calibrated
- **Storage**: `public/ml/xgboost_model.json` (trees) + `public/ml/norm_browser.json` (normalization + Platt params)
- **Inference**: `src/engines/Mlpredictor.js` -- iterative tree traversal (no recursion), named feature splits via `featureNameToIdx` Map, only evaluates `best_iteration + 1` trees
- **Feature vector**: Assembled in `useMarketData.js`, passed to `Mlpredictor.predict()`
- **Training**: `backtest/ml_training/trainXGBoost_v3.py` -- Optuna Bayesian HPO (100 trials), walk-forward 3-fold CV, regime sample weighting, soft feature pruning, Platt calibration
- **Backtesting**: `backtest/ml_training/backtestPnL.py` -- P&L simulation with threshold sweep, per-regime breakdown, Sharpe ratio
- **Current metrics**: 63.93% accuracy, AUC 0.6777, high-conf (0.70+) = 73.9%

### Edge Engine (src/engines/edge.js)

Phase-based decision with quality gates + regime-adaptive thresholds:

| Phase     | Time Left | Base Min Edge | Base Min Prob | Min Agreement | MultiTF |
|-----------|-----------|---------------|---------------|---------------|---------|
| EARLY     | > 10 min  | 8%            | 60%           | 3             | prefer  |
| MID       | 5-10 min  | 10%           | 58%           | 3             | prefer  |
| LATE      | 2-5 min   | 12%           | 57%           | 2             | no      |
| VERY_LATE | < 2 min   | 15%           | 56%           | 2             | no      |

Regime adjustments (scaled by regime confidence):
- **Trending**: Relaxes minEdge/minProb by up to 2% (signals are clearer)
- **Choppy**: Tightens minEdge +3%, minProb +3% (noise protection)
- **Mean-reverting**: Tightens minEdge +1%
- **ML high-confidence**: Relaxes both by 2% when ML agrees with rules

### Feedback System (src/engines/feedback.js)

- `recordPrediction()` -- Stores side, prob, price, regime, mlConfidence per prediction
- `getAccuracyStats()` -- Rolling accuracy, streak, confidence multiplier (used in scoring)
- `getDetailedStats()` -- Detailed dashboard data: rolling 20/50/100, per-regime accuracy, calibration buckets, streak
- `autoSettle()` -- Settles predictions at market expiry
- `onMarketSwitch()` -- Cleanup on slug change (settle old, purge stale)
- Max 30 predictions, 24h expiry, debounced localStorage persistence

### Performance Patterns

- WebSocket data written to `useRef`, flushed to React state via throttled intervals (not on every message)
- All 7 components wrapped in `React.memo` with custom comparators and memoized prop slices in App.jsx
- ML inference uses `Float64Array` with in-place normalization
- `useMarketData` uses `shallowChanged()` diff to avoid unnecessary re-renders
- Tab visibility changes trigger immediate WebSocket reconnection
- Periodic cleanup hints every 60 polls (~5min) for GC

### Environment Notes

- Windows (MSYS/Git Bash), `.bashrc` has encoding errors (harmless, ignore)
- Binance FAPI + Bybit both blocked in user's region -- funding rate defaults to neutral
- Python 3.13.0, Node 25.1.0, xgboost 3.1.3
