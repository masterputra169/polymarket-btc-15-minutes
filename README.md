# Polymarket BTC 15-Minute Trading Bot

> Automated trading bot for Polymarket's BTC 15-minute binary prediction markets.
> Combines XGBoost/LightGBM ML ensemble, 10 technical indicators, smart order routing, and real-time risk management.

**Stack:** React 19 + Vite 7 (dashboard) · Node.js + PM2 (bot) · XGBoost + LightGBM (ML) · Polymarket CLOB API

---

## Recent Updates (Mar 2026)

| Date | Change |
|------|--------|
| Mar 29 | **Fix:** Limit orders on weekends were always blocked — weekend filter incorrectly treated intentionally-omitted `mlConfidence` (limit path uses its own 60% ML gate) as "ML unavailable". Now only blocks when model is truly not loaded. |
| Mar 29 | **Fix:** Signal stability flip gate (`MAX_FLIPS_TO_ENTER`) now scales with `POLL_INTERVAL_MS`. At 50ms polling, stable signals produce 4–7 micro-oscillation flips in 15s; the old hardcoded limit of 3 blocked valid FOK entries. Now: ≤100ms → 10, ≤1s → 6, >1s → 3. |
| Mar 28 | **Fix:** PTB (Price to Beat) mismatch on bot restart — added `schedulePtbPageUpgrade()` which retries at +15min and +30min to upgrade PTB from approximate source to exact `finalPrice` once Polymarket publishes it. |
| Mar 28 | **Fix:** PTB consensus buffer widened 0.05% → 0.3% to restore limit order fill rate after PTB accuracy improvements. |
| Mar 28 | **Fix:** Profit target baseline symmetry — daily baseline now resets correctly on WIB date boundary. |
| Mar 29 | **Revert:** ML rolled back to v16 (84.07% acc, 0.9248 AUC) — v20 underperformed due to choppy BTC regime. v16's 180-day training window with 86% real Polymarket labels remains the most reliable. |

---

## What Is This?

Every 15 minutes, Polymarket runs a binary market: **"Will BTC be higher in 15 minutes?"** You bet YES or NO at the current market price (e.g., 65¢ for YES), and collect $1.00 if correct.

This bot automates that process — it reads BTC price data from 4 live sources, runs an ML ensemble to predict direction, calculates edge vs. market price, and places orders if conditions are favorable. It runs 24/7 and manages its own risk.

---

## Key Features

- **ML Ensemble (v16)** — XGBoost + LightGBM, Platt-calibrated, trained on 45K Polymarket markets (86% real labels)
- **15 Trade Filters** — ML confidence, spread gates, VPIN, session quality, blackout hours, and more
- **Smart Order Router** — decides between FOK (instant) and Limit orders (passive, better price)
- **Kelly Sizing** — confidence-tiered fractional Kelly with hard bankroll caps
- **Cut-Loss System** — 13-gate evaluator; philosophy: hold to settlement wins 87.5% of the time
- **Auto-Retrain Pipeline** — weekly ML retraining with Optuna HPO, quality gates, auto-rollback
- **Concept Drift Detection** — CUSUM + hard threshold alerts when model degrades in real time
- **AI Agent (optional)** — OpenRouter-powered post-trade analysis and self-optimization
- **Telegram Alerts** — every trade, circuit breaker, daily P&L summary
- **React Dashboard** — 12 live panels: signals, positions, ML confidence, bet sizing, accuracy

---

## Architecture

```
Binance BTC Price (WebSocket) ─┐
Polymarket Orderbook (WebSocket) ─┤
Chainlink Oracle (WebSocket) ─────┤──→ Signal Computation ──→ 15 Trade Filters
Polymarket LiveData (WebSocket) ──┘         │
                                    10 TA Indicators
                                    ML Ensemble (XGB+LGB)
                                    Regime Detection
                                            │
                                   ┌────────▼────────┐
                                   │   Edge Engine    │
                                   │  phase-based     │
                                   │  thresholds      │
                                   └────────┬────────┘
                                            │
                                   ┌────────▼────────┐
                                   │  Order Router    │
                                   │  FOK / LIMIT     │
                                   └────────┬────────┘
                                            │
                                   Polymarket CLOB API
                                   (place → monitor → settle)
```

Every ~50ms the bot:
1. Fetches real-time BTC price + Polymarket market data
2. Computes 10 technical indicators + ML prediction
3. Detects market regime (trending / choppy / mean-reverting)
4. Calculates edge (model probability − market price)
5. Applies 15 trade filters
6. Routes order: **LIMIT** (passive entry) · **FOK** (immediate) · **WAIT**
7. Monitors position: cut-loss gates, settlement detection
8. Broadcasts full state to React dashboard via WebSocket

---

## Dashboard Preview

```
┌─ Bot Status ─────────────────────────────┐  ┌─ ML Engine ──────────────────────────┐
│ RUNNING  │ DRY_RUN: OFF  │ Bankroll $104 │  │ XGBoost: UP 82%  LightGBM: UP 79%   │
│ Poll #48291  Daily P&L: +$3.42           │  │ Ensemble: UP 81.5%  HIGH confidence  │
└──────────────────────────────────────────┘  └──────────────────────────────────────┘
┌─ Price Card ─────────────────────────────┐  ┌─ Edge Engine ────────────────────────┐
│ BTC $87,234  ▲ +0.3%  │  Chainlink: OK  │  │ Edge: 16.5%  Prob: 81.5%             │
│ Market: will-btc-go-up-by-1usd-...      │  │ Regime: TRENDING  Phase: EARLY       │
│ ████████████░░░  11:42 remaining        │  │ RECOMMEND: UP ✓ ENTER                │
└──────────────────────────────────────────┘  └──────────────────────────────────────┘
```

---

## Prerequisites

| Requirement | Version | Notes |
|-------------|---------|-------|
| Node.js | >= 20 | Tested on 25.1.0 |
| Python | >= 3.10 | ML retraining only (3.13.0 tested) |
| PM2 | Latest | `npm install -g pm2` |

**Polymarket Requirements:**
- Polygon wallet (EOA) with USDC.e balance
- Recommended starting balance: **$50+ USDC.e** on Polygon
- No ETH needed — Polymarket uses gasless relays

---

## Installation

```bash
# 1. Clone
git clone https://github.com/masterputra169/polymarket-15-minutes.git
cd polymarket-15-minutes/frontend

# 2. Install frontend dependencies
npm install

# 3. Install bot dependencies
cd bot && npm install && cd ..

# 4. Install PM2
npm install -g pm2

# 5. Create bot config
cp bot/.env.example bot/.env   # then edit with your values
```

> If `.env.example` doesn't exist, create `bot/.env` manually — see [Configuration](#configuration).

---

## Wallet Setup

### Option A: New Wallet (Recommended)

```bash
node -e "
const { ethers } = require('ethers');
const w = ethers.Wallet.createRandom();
console.log('Address:    ', w.address);
console.log('Private Key:', w.privateKey);
"
```

1. Save private key to `bot/.env` as `POLYMARKET_PRIVATE_KEY=0x...`
2. Send USDC.e to this address on **Polygon network**
3. API credentials are auto-derived on first start

### Option B: Existing Polymarket Wallet (Browser/Magic Link)

Polymarket's web UI creates a Gnosis Safe proxy:

1. Find your proxy address: Polymarket UI → Settings → Wallet
2. Set `POLYMARKET_PROXY_ADDRESS=0x...` in `.env`
3. Set `POLYMARKET_PRIVATE_KEY=0x...` (the EOA controlling the proxy)

---

## Configuration

Create `bot/.env` — here are the essential variables:

### Required

```env
# Wallet
POLYMARKET_PRIVATE_KEY=0x...          # Your Polygon EOA private key
POLYMARKET_PROXY_ADDRESS=             # Gnosis Safe address (if using web UI wallet)

# Bankroll
BANKROLL=50                           # Starting capital in USD
DRY_RUN=true                          # ALWAYS start with true!

# Execution
POLL_INTERVAL_MS=50                   # Poll frequency (ms)
LOG_LEVEL=info
```

### Risk Management

```env
# Circuit breakers — bot halts + 4hr cooldown when triggered
MAX_DAILY_LOSS_PCT=15                 # Halt if daily loss >= 15%
MAX_CONSECUTIVE_LOSSES=7              # Halt after 7 straight losses
MAX_DRAWDOWN_PCT=30                   # Halt if peak drawdown >= 30%

# Bet sizing
MAX_BET_AMOUNT_USD=2.50               # Hard cap per trade (raise as bankroll grows)
```

### Strategy Toggles

```env
# Cut-loss (recommended: keep enabled)
CUT_LOSS_ENABLED=true
CUT_LOSS_MIN_HOLD_SEC=720             # Hold at least 12 min before cutting
CUT_LOSS_MIN_TOKEN_DROP_PCT=70        # Only cut on catastrophic drops (70%)

# Take-profit (recommended: disabled — settlement beats early exit)
TAKE_PROFIT_ENABLED=false

# Limit orders — passive entry at better prices
LIMIT_ORDER_ENABLED=true

# Recovery buy — re-enter after cut-loss if signal recovers
RECOVERY_BUY_ENABLED=true

# Pre-market LONG — daily UP entry at 09:00-09:15 EST
PREMARKET_LONG_ENABLED=false
PREMARKET_LONG_RISK_PCT=0.05          # 5% bankroll per trade
```

### Notifications (Optional)

```env
# Telegram
TELEGRAM_BOT_TOKEN=                   # From @BotFather
TELEGRAM_CHAT_ID=                     # Your chat ID
TELEGRAM_NOTIFY_TRADES=true
```

### Smart Money Oracle (Optional, ~$0.50-1.00/day)

```env
METENGINE_ENABLED=false
SOLANA_PRIVATE_KEY=                   # Base58 Solana keypair for x402 payments
```

### AI Agent (Optional, requires OpenRouter key)

```env
AI_AGENT_ENABLED=false
OPENROUTER_API_KEY=sk-or-...
AI_MODEL=google/gemini-2-flash        # Or any OpenRouter model
```

### Concept Drift Detection

```env
DRIFT_WINDOW=50                       # Rolling window (trades) to evaluate accuracy
DRIFT_MIN_TRADES=30                   # Min trades before check activates
DRIFT_WR_DROP_PP=15                   # Alert if accuracy drops 15pp from baseline
DRIFT_AUTO_RETRAIN=false              # Set true to auto-trigger retrain on drift
```

---

## Running the Bot

### Step 1: Dry Run First

```bash
# Ensure DRY_RUN=true in bot/.env, then:
pm2 start ecosystem.config.cjs
pm2 logs polymarket-bot
```

Expected output:
```
[Bot] CLOB client initialized (dry-run mode)
[Bot] ML models loaded: XGBoost v16 + LightGBM v16
[Bot] WebSocket streams connected: Binance · CLOB · PolyLive · Chainlink
[Bot] Poll #1 | BTC $87,234 | UP 81% | Edge 16.5% | ENTER (DRY)
```

### Step 2: Go Live

```bash
# In bot/.env:
DRY_RUN=false
MAX_BET_AMOUNT_USD=2.50               # Start small

pm2 restart polymarket-bot
pm2 logs polymarket-bot
```

### PM2 Commands

```bash
pm2 start ecosystem.config.cjs        # Start bot + frontend dashboard
pm2 logs polymarket-bot               # Bot live logs (Ctrl+C to exit)
pm2 logs frontend                     # Frontend live logs
pm2 logs polymarket-bot --lines 200   # Last 200 lines
pm2 stop polymarket-bot               # Graceful stop bot
pm2 restart polymarket-bot            # Restart bot
pm2 monit                             # CPU/memory monitor
pm2 status                            # Process list
```

### Step 3: Open Dashboard

The dashboard starts automatically with PM2 alongside the bot. Open:

```
http://localhost:3000
```

The dashboard connects to the bot via WebSocket on port 3099.

---

## Trading Strategies

### 1. Standard Directional (Main)

The order router picks execution mode based on 7 rules:

| Condition | Action |
|-----------|--------|
| ML >= 85% + price <= 65¢ | FOK (immediate) |
| ML 65–84% + price <= 62¢ + wide spread | Limit order (passive) |
| ML < 62% or no edge | WAIT |

### 2. Limit Orders — Passive Entry

Places GTD orders at target price (typically 55–62¢ vs. market 65–75¢):
- Auto-cancels after 7 min if unfilled → falls back to FOK
- Max 2 attempts per market (anti-loop)
- At 58¢ entry: only needs 58% WR to break even vs. 72% at 72¢ FOK

### 3. Pre-Market LONG (Optional)

Daily UP entry during 09:00–09:15 EST:
- Exploits pre-NYSE open volatility
- 1 trade per day maximum
- Enable with `PREMARKET_LONG_ENABLED=true`

### 4. Recovery Buy (Optional)

Re-enters after cut-loss if signal stabilizes:
- 10s baseline + 30s monitoring period
- Requires ML still agrees, token rising or stable
- Reduced position size (anti-revenge sizing)

---

## Risk Management

### Circuit Breakers

| Trigger | Default | Action |
|---------|---------|--------|
| Daily loss ≥ 15% | `MAX_DAILY_LOSS_PCT=15` | Halt + 4hr cooldown |
| Peak drawdown ≥ 30% | `MAX_DRAWDOWN_PCT=30` | Halt + 4hr cooldown |
| 7 consecutive losses | `MAX_CONSECUTIVE_LOSSES=7` | Halt + 4hr cooldown |
| Win rate < 30% (rolling) | Automatic | Halt |

### Cut-Loss Philosophy

**"Hold to settlement wins 87.5% of the time."**

The bot only exits early in extreme scenarios:
- Token drops ≥ 70% (catastrophic collapse)
- ML flips direction with ≥ 92% confidence
- Minimum 12-minute hold before any cut

Data from 300+ live trades shows settlement WR of 87.5% vs. cut-loss WR of 23.3%. Early selling destroys edge.

### 15 Trade Filters

Every entry passes all 15 gates:

| # | Filter | Purpose |
|---|--------|---------|
| 1 | ML confidence ≥ 62% | Only act on high-confidence signals |
| 2 | Price not 45–55¢ | Avoid coin-flip zone |
| 3 | ATR volatility check | Avoid dead markets |
| 4 | Time window 0.75–14.5 min | Avoid too-early or too-late entries |
| 5 | Post-loss cooldown | Prevent revenge trading |
| 6 | Max 2 trades per market | Anti-overtrading |
| 7 | Weekend ML gate | Block on Sat/Sun if ML model not loaded or confidence < 65% |
| 8 | Edge ceiling < 20% | Avoid mispriced markets |
| 9 | Counter-trend momentum | Don't fight strong momentum |
| 10 | Blackout hours 16:00–23:00 ET | Skip historically low-WR hours |
| 11 | Regime strictness | Tighter thresholds in choppy markets |
| 12 | Spread < 8% | Avoid illiquid markets |
| 13 | ML rolling accuracy | Pause if model degrades |
| 14 | VPIN informed flow | Block if smart money detected |
| 15 | Spread widening | Block if sudden liquidity withdrawal |

---

## ML Model

### Current: v16 (XGBoost + LightGBM Ensemble)

| Metric | Value |
|--------|-------|
| Test Accuracy | 84.07% |
| Test AUC | 0.9248 |
| Holdout Accuracy | 94.12% |
| Training window | 180 days |
| Real Polymarket labels | 86% |
| Training samples | 45,336 |
| Ensemble weights | XGBoost 0.75, LightGBM 0.25 |
| Features | 79 (54 base + 25 engineered) |
| Calibration | Platt scaling on logits |
| At ≥80% confidence | 99.3% WR (79.4% coverage) |

> v16 uses a 180-day training window — enough data for robust regime coverage without diluting real Polymarket labels. v20 (120d, 34K samples) was rolled back after underperforming in the current market regime.

### Features Used

- **BTC Price:** Returns (1m/5m/15m/30m/1h/4h), Z-score, momentum
- **Technical:** RSI, MACD, VWAP, Bollinger Bands, ATR, Heiken Ashi, EMA Cross, StochRSI
- **Polymarket:** Token price, bid/ask spread, time to settlement, orderbook imbalance
- **Volume:** Delta, funding rate, VPIN estimate
- **Regime:** Choppy/trending/mean-revert classification

### Retraining

The bot includes a full retraining pipeline with quality gates and auto-rollback:

```bash
cd backtest/ml_training

# 1. Update market data
python quickUpdateLookup.py 7

# 2. Generate training data
node generateTrainingData.mjs --days 120 --polymarket-lookup ./polymarket_lookup.json

# 3. Train with Optuna HPO (150 trials)
python trainXGBoost_v3.py --input training_data.csv --tune --tune-trials 150

# 4. Backtest
python backtestPnL.py --threshold-sweep

# 5. Deploy (if quality gates pass)
cp output/xgboost_model.json ../../public/ml/
cp output/lightgbm_model.json ../../public/ml/
cp output/norm_browser.json ../../public/ml/
```

Or configure **auto-retrain** — runs weekly (Sunday 3 AM UTC) via PM2:
```env
RETRAIN_DAY_OF_WEEK=0
RETRAIN_HOUR_UTC=3
RETRAIN_DAYS=120
RETRAIN_TUNE_TRIALS=100
```

### Concept Drift Detection

The bot monitors model performance in real time. If live accuracy drops significantly from baseline:
- **Telegram alert** sent immediately
- CUSUM algorithm detects gradual drift early
- Optional: auto-triggers retraining (`DRIFT_AUTO_RETRAIN=true`)

---

## Monitoring & Alerts

### Telegram Setup

1. Create a bot via [@BotFather](https://t.me/botfather) → `/newbot`
2. Get your `chat_id`:
   ```
   https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates
   ```
3. Set in `.env`:
   ```env
   TELEGRAM_BOT_TOKEN=123456789:ABC-...
   TELEGRAM_CHAT_ID=987654321
   TELEGRAM_NOTIFY_TRADES=true
   ```

### Notification Events

| Event | Severity |
|-------|----------|
| Trade placed (buy/sell) | Info |
| Limit order filled/cancelled | Info |
| Settlement result (win/loss) | Info |
| Daily P&L summary | Info |
| Cut-loss triggered | Warning |
| Circuit breaker halt | Critical |
| Concept drift detected | Warning |

---

## Troubleshooting

### Bot won't start

```bash
pm2 logs polymarket-bot --lines 50
```

Common causes:
- `POLYMARKET_PRIVATE_KEY is required` → check `bot/.env` exists and has the key
- `Cannot find module` → run `cd bot && npm install`
- `Failed to load XGBoost model` → ensure `public/ml/xgboost_model.json` exists

### Circuit breaker triggered

```bash
pm2 stop polymarket-bot
# Edit bot/data/state.json — set bankroll, peakBankroll, startOfDayBankroll to actual USDC.e balance
pm2 restart polymarket-bot
```

### "Bot disconnected" on dashboard

- Check `pm2 status` — both `polymarket-bot` and `frontend` must be running
- Verify port 3099 is not blocked
- Dashboard connects to `ws://localhost:3099`
- If `frontend` shows `errored`: `pm2 delete frontend && pm2 start ecosystem.config.cjs --only frontend`

### Bankroll mismatch

```bash
pm2 stop polymarket-bot
# Edit bot/data/state.json → update all bankroll fields to your actual on-chain balance
pm2 restart polymarket-bot
```

---

## Project Structure

```
frontend/
├── src/                          # React 19 dashboard
│   ├── App.jsx                   # Root, per-panel useMemo data slicing
│   ├── components/               # 12 dashboard panels
│   ├── engines/                  # Browser-side ML + decision engines
│   │   ├── Mlpredictor.js        # XGBoost tree traversal (Float64Array)
│   │   ├── edge.js               # Phase-based edge thresholds
│   │   ├── asymmetricBet.js      # Kelly fraction sizing
│   │   └── regime.js             # Choppy/trending/mean-revert classifier
│   ├── indicators/               # 10 TA functions (RSI, MACD, VWAP, ...)
│   ├── hooks/                    # useBotData, useCountdown, useClock
│   └── config.js                 # Frontend parameters + polyFeeRate()
│
├── bot/                          # Node.js trading bot (PM2-managed)
│   ├── index.js                  # Entry point + startup sequence
│   └── src/
│       ├── loop.js               # Main poll loop (~2000 lines)
│       ├── config.js             # BOT_CONFIG from .env
│       ├── statusServer.js       # WebSocket broadcast server :3099
│       ├── autoRetrain.js        # Weekly ML retraining orchestrator
│       ├── engines/
│       │   ├── signalComputation.js   # All indicators per poll
│       │   ├── tradePipeline.js       # Order execution + Kelly sizing
│       │   ├── orderRouter.js         # 7-rule LIMIT/FOK/WAIT decision
│       │   ├── limitOrderManager.js   # GTD order lifecycle
│       │   └── settlement.js          # Settlement detection + P&L
│       ├── trading/
│       │   ├── positionTracker.js     # Bankroll + position state
│       │   ├── cutLoss.js             # 13-gate cut-loss evaluator
│       │   └── recoveryBuy.js         # Re-entry after cut-loss
│       ├── safety/
│       │   ├── tradeFilters.js        # 15 entry filters
│       │   └── guards.js              # Circuit breaker
│       └── monitoring/
│           ├── perfMonitor.js         # Rolling win rate + daily P&L
│           ├── driftDetector.js       # CUSUM concept drift detection
│           ├── rollbackMonitor.js     # Post-deploy WR monitor
│           └── notifier.js            # Telegram + Discord alerts
│
├── public/ml/                    # Deployed ML models
│   ├── xgboost_model.json        # XGBoost ensemble (v16)
│   ├── lightgbm_model.json       # LightGBM ensemble (v16)
│   └── norm_browser.json         # Feature normalization params
│
├── backtest/ml_training/         # ML training pipeline
│   ├── trainXGBoost_v3.py        # Main trainer (Optuna HPO)
│   ├── generateTrainingData.mjs  # Feature engineering
│   ├── backtestPnL.py            # Threshold sweep backtest
│   └── quickUpdateLookup.py      # Scrape recent Polymarket markets
│
├── ecosystem.config.cjs          # PM2: bot + frontend processes
├── vite.config.js                # Dev server + CORS proxies
└── package.json
```

---

## Important Notes

- **Always start with `DRY_RUN=true`** — verify everything works before going live
- **Never run `node bot/index.js` directly** — always use PM2 (handles `.env` loading)
- **The bot does not need ETH** — Polymarket uses gasless relays on Polygon
- **Settlement beats early exit** — the cut-loss is intentionally conservative by design
- **Blackout hours 16:00–23:00 ET** — bot automatically skips historically low-WR hours
- **Binance FAPI and Bybit are blocked in some regions** — funding rate defaults to neutral (harmless)

---

## Contributing

Pull requests welcome. For major changes, open an issue first.

When contributing:
- No TypeScript — vanilla JavaScript/JSX with ES modules
- No linter configured — keep style consistent with surrounding code
- Test with `DRY_RUN=true` before submitting

---

## Disclaimer

This software is for **educational and personal use only**. Trading prediction markets involves significant financial risk. Past performance does not guarantee future results. The authors are not responsible for any financial losses. **Trade at your own risk.**

---

## License

MIT License — see [LICENSE](LICENSE) for details.
