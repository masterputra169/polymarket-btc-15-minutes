# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Dev Commands

```bash
npm run dev      # Start Vite dev server on port 3000
npm run build    # Production build to dist/
npm run preview  # Preview production build
```

No test runner, linter, or TypeScript configured. The project uses vanilla JavaScript/JSX with ES modules.

### ML Model Retraining (backtest/ml_training/)

```bash
./runTraining.sh                          # Basic: 30 days, default params
./runTraining.sh --tune --deploy          # Tune + auto-copy to public/ml/
node generateTrainingData.mjs --days 30   # Step 1: fetch data to CSV
python trainXGBoost.py --input training_data.csv --tune  # Step 2: train
```

Trained model outputs (`xgboost_model.json`, `norm_browser.json`) go to `public/ml/`.

## Architecture

Real-time BTC 15-minute prediction terminal for Polymarket. React 19 + Vite 7, single-page with no router.

### Data Flow Pipeline

```
4 WebSocket Streams (Binance, Polymarket LiveData, Chainlink WSS, CLOB Orderbook)
        ↓
  useMarketData hook (src/hooks/useMarketData.js) — central orchestrator, recalculates every 5s
        ↓
  10+ Technical Indicators (src/indicators/) + 4 Decision Engines (src/engines/)
        ↓
  XGBoost ML inference (src/engines/Mlpredictor.js) — 42-feature vector, browser-side tree traversal
        ↓
  6 Dashboard Panels (src/components/)
```

### Key Layers

- **`src/hooks/useMarketData.js`** — The core hook (~500 lines). Orchestrates all WebSocket streams, polls Binance klines, runs indicator calculations, ML inference, and assembles the final state object consumed by every component. Changes here affect everything.
- **`src/hooks/useBinanceStream.js`, `usePolymarketChainlinkStream.js`, `useChainlinkWssStream.js`, `Usepolymarketclobstream.js`** — Each manages one WebSocket connection with reconnect logic, heartbeat detection, and throttled state flushing (writes to refs, flushes to state 2x/sec).
- **`src/data/`** — HTTP fetchers for Binance klines, Polymarket market discovery, and Chainlink RPC. All HTTP calls go through Vite proxy (see `vite.config.js`).
- **`src/indicators/`** — Pure functions computing technical indicators (RSI, MACD, VWAP, Bollinger, ATR, Heiken Ashi, EMA crossover, Stochastic RSI, volume delta, funding rate). Each returns a result object consumed by `useMarketData`.
- **`src/engines/`** — Decision logic: `probability.js` (21-point weighted scoring), `edge.js` (model prob minus market price, phase-aware thresholds), `regime.js` (trending/choppy/mean-reverting/moderate detection with confidence multipliers), `Mlpredictor.js` (XGBoost tree traversal with pre-allocated Float64Array buffers), `feedback.js` (rolling accuracy tracking).
- **`src/config.js`** — All tunable parameters: indicator periods, WebSocket URLs, Polymarket series ID, Chainlink contract address. Indicator parameters are tuned for 15-minute windows (RSI period 8, MACD 6/13/5, VWAP 60-candle lookback).

### Vite Proxy Setup

Dev server proxies three APIs to avoid CORS:
- `/gamma-api` → `https://gamma-api.polymarket.com` (market discovery)
- `/clob-api` → `https://clob.polymarket.com` (orderbook/prices)
- `/binance-api` → `https://data-api.binance.vision` (klines)

### ML Model

- XGBoost model stored as JSON in `public/ml/xgboost_model.json`, normalization params in `public/ml/norm_browser.json`
- Inference in `src/engines/Mlpredictor.js` uses iterative tree traversal (no recursion), pre-allocated buffers
- v1: 42 base features, v2: 58 features (42 base + 16 engineered interactions)
- Feature vector assembled in `useMarketData.js`, passed to `Mlpredictor.predict()`
- Model retraining recommended weekly; pipeline in `backtest/ml_training/`

### Performance Patterns

- WebSocket data written to `useRef`, flushed to React state via throttled intervals (not on every message)
- Components wrapped in `React.memo` with memoized prop objects to prevent unnecessary re-renders
- ML inference uses `Float64Array` with in-place normalization
- Tab visibility changes trigger immediate WebSocket reconnection
