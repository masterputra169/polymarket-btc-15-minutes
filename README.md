# Polymarket BTC 15-Minute Trading Bot

Automated trading bot for Polymarket's BTC 15-minute binary prediction markets. Combines XGBoost/LightGBM ML ensemble, 10 technical indicators, and smart order routing to trade UP/DOWN positions.

**Stack**: React 19 + Vite 7 (dashboard) | Node.js + PM2 (bot) | XGBoost + LightGBM (ML)

---

## Table of Contents

- [How It Works](#how-it-works)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Wallet Setup](#wallet-setup)
- [Configuration](#configuration)
- [Running the Bot](#running-the-bot)
- [Dashboard](#dashboard)
- [Trading Strategies](#trading-strategies)
- [Risk Management](#risk-management)
- [ML Model](#ml-model)
- [Monitoring & Alerts](#monitoring--alerts)
- [Troubleshooting](#troubleshooting)

---

## How It Works

```
Binance BTC Price (WebSocket) ─┐
Polymarket Orderbook (WebSocket) ─┤
Chainlink Oracle (WebSocket) ─────┤──→ Signal Computation ──→ 15 Trade Filters
Polymarket LiveData (WebSocket) ──┘         │
                                    10 TA Indicators
                                    ML Ensemble (XGB+LGB)
                                    Regime Detection
                                            │
                                    ┌───────▼────────┐
                                    │  Edge Engine    │
                                    │  (phase-based   │
                                    │   thresholds)   │
                                    └───────┬────────┘
                                            │
                                    ┌───────▼────────┐
                                    │  Order Router   │
                                    │  FOK / LIMIT    │
                                    └───────┬────────┘
                                            │
                                    Polymarket CLOB API
                                    (place order, monitor, settle)
```

Every ~50ms, the bot:
1. Fetches real-time BTC price + Polymarket market data
2. Computes 10 technical indicators + ML prediction (XGBoost + LightGBM ensemble)
3. Detects market regime (trending/choppy/mean-reverting)
4. Calculates edge (model probability minus market price)
5. Applies 15 trade filters (ML confidence, spreads, time window, session quality, etc.)
6. Routes order: **FOK** (immediate) or **Limit** (passive) or **WAIT**
7. Monitors position: cut-loss, take-profit, settlement
8. Broadcasts full state to React dashboard via WebSocket

---

## Prerequisites

| Requirement | Version | Notes |
|-------------|---------|-------|
| Node.js | >= 20 | Tested on 25.1.0 |
| Python | >= 3.10 | For ML training only (3.13.0 tested) |
| PM2 | Latest | `npm install -g pm2` |
| Git | Any | For cloning |

**Polymarket Requirements:**
- Polygon wallet (EOA) with USDC.e balance
- Minimum recommended: **$50 USDC.e** on Polygon
- No ETH needed (Polymarket uses gasless relays)

---

## Installation

```bash
# 1. Clone the repository
git clone https://github.com/your-username/polymarket-15-minutes.git
cd polymarket-15-minutes/frontend

# 2. Install frontend dependencies
npm install

# 3. Install bot dependencies
cd bot && npm install && cd ..

# 4. Install PM2 globally (if not already)
npm install -g pm2

# 5. Create bot environment file
cp bot/.env.example bot/.env   # Then edit with your values
```

If `.env.example` doesn't exist, create `bot/.env` manually (see [Configuration](#configuration)).

---

## Wallet Setup

### Option A: New Wallet (Recommended for Bot)

```bash
# Generate a new wallet (save the private key securely!)
node -e "const { ethers } = require('ethers'); const w = ethers.Wallet.createRandom(); console.log('Address:', w.address); console.log('Private Key:', w.privateKey);"
```

1. Save the private key to `bot/.env` as `POLYMARKET_PRIVATE_KEY=0x...`
2. Send USDC.e to this address on **Polygon network**
3. The bot will auto-derive API credentials on first start

### Option B: Existing Polymarket Wallet (Browser/Magic Link)

If you use Polymarket's web UI (Magic Link login), it creates a Gnosis Safe proxy:

1. Find your proxy address in Polymarket UI (Settings > Wallet)
2. Set `POLYMARKET_PROXY_ADDRESS=0x...` in `.env`
3. Set `POLYMARKET_PRIVATE_KEY=0x...` (your EOA that controls the proxy)
4. The bot signs with EOA but executes as the proxy

### API Credentials

**Auto-derive (easiest):** Leave `POLYMARKET_API_KEY`, `POLYMARKET_API_SECRET`, `POLYMARKET_API_PASSPHRASE` empty. The bot calls `createOrDeriveApiCreds()` on startup.

**Manual:** If you already have CLOB API credentials, set all three in `.env`.

---

## Configuration

Create `bot/.env` with the following variables:

### Required

```env
# ═══ WALLET ═══
POLYMARKET_PRIVATE_KEY=0x...          # Your Polygon EOA private key
POLYMARKET_PROXY_ADDRESS=             # Leave empty if using EOA directly

# ═══ BANKROLL ═══
BANKROLL=50                           # Starting capital in USD
DRY_RUN=true                          # Start with true! Switch to false when ready

# ═══ EXECUTION ═══
POLL_INTERVAL_MS=50                   # Bot poll frequency (ms)
LOG_LEVEL=info                        # debug|info|warn|error
```

### Risk Management

```env
# ═══ CIRCUIT BREAKERS ═══
MAX_DAILY_LOSS_PCT=15                 # Halt if daily loss >= 15%
MAX_CONSECUTIVE_LOSSES=7              # Halt after 7 straight losses
MAX_DRAWDOWN_PCT=25                   # Halt if peak drawdown >= 25%

# ═══ BET SIZING ═══
MAX_BET_AMOUNT_USD=2.50               # Hard cap per trade
```

### Strategy Toggles

```env
# ═══ CUT-LOSS (recommended: keep enabled) ═══
CUT_LOSS_ENABLED=true
CUT_LOSS_MIN_HOLD_SEC=480             # Hold at least 8 min before cutting
CUT_LOSS_MIN_TOKEN_DROP_PCT=45        # Only cut on catastrophic drops

# ═══ TAKE-PROFIT (recommended: disabled) ═══
TAKE_PROFIT_ENABLED=false             # Settlement WR 87.5% beats early exit

# ═══ LIMIT ORDERS (passive entry at better prices) ═══
LIMIT_ORDER_ENABLED=true

# ═══ RECOVERY BUY (re-enter after cut-loss) ═══
RECOVERY_BUY_ENABLED=true

# ═══ PRE-MARKET LONG (09:00-09:15 EST daily) ═══
PREMARKET_LONG_ENABLED=false          # Enable if you want daily LONG entry
```

### Optional: Notifications

```env
# ═══ TELEGRAM ═══
TELEGRAM_BOT_TOKEN=                   # From @BotFather
TELEGRAM_CHAT_ID=                     # Your chat ID
TELEGRAM_NOTIFY_TRADES=true           # Notify on every trade

# ═══ DISCORD ═══
DISCORD_WEBHOOK_URL=                  # Discord webhook URL
```

### Optional: Smart Money Oracle

```env
# ═══ METENGINE (costs ~$0.50-1.00/day in Solana USDC) ═══
METENGINE_ENABLED=false
SOLANA_PRIVATE_KEY=                   # Base58 Solana keypair
SOLANA_RPC_URL=https://solana-rpc.publicnode.com
```

### Optional: Monte Carlo Simulation

```env
MC_ENABLED=false                      # Enable GBM risk simulation
MC_NUM_PATHS=1000                     # Simulation paths
```

---

## Running the Bot

### Step 1: Dry Run (Test First!)

Always start in dry-run mode to verify everything works:

```bash
# Make sure DRY_RUN=true in bot/.env, then:
pm2 start ecosystem.config.cjs
pm2 logs polymarket-bot
```

Watch the logs. You should see:
```
CLOB client initialized (dry-run mode)
ML models loaded: XGBoost (1200 trees) + LightGBM
WebSocket connected: Binance, CLOB, PolyLive, Chainlink
Poll #1: BTC $97,234 | Market: will-btc-go-up-... | Signal: UP 72% | Edge: 8.2%
```

### Step 2: Go Live

Once dry-run looks good:

```bash
# Edit bot/.env
DRY_RUN=false

# Restart
pm2 restart polymarket-bot
pm2 logs polymarket-bot
```

### Common PM2 Commands

```bash
pm2 start ecosystem.config.cjs    # Start bot + auto-retrain
pm2 logs polymarket-bot            # Watch logs (Ctrl+C to exit)
pm2 logs polymarket-bot --lines 200  # Show last 200 lines
pm2 stop polymarket-bot            # Stop bot (graceful)
pm2 restart polymarket-bot         # Restart bot
pm2 monit                          # Real-time CPU/memory monitor
pm2 status                         # Process list
pm2 delete all                     # Remove all processes
```

### Step 3: Start Dashboard

In a separate terminal:

```bash
cd frontend
npm run dev
```

Open `http://localhost:3000` — the dashboard connects to bot via WebSocket on port 3099.

---

## Dashboard

The React dashboard shows real-time bot state:

| Panel | What It Shows |
|-------|---------------|
| **Bot Status** | Running/paused, dry-run indicator, poll count, bankroll, daily P&L |
| **Positions** | Open positions with live P&L, entry price, sell button |
| **Limit Order** | Active limit order status, target/market price, progress bar |
| **Price Card** | BTC price (Binance + Chainlink), countdown to settlement |
| **Prediction** | UP/DOWN probability, recommendation, score breakdown |
| **TA Indicators** | RSI, MACD, VWAP, Bollinger, ATR, Heiken Ashi, EMA, StochRSI |
| **Polymarket** | Market prices, orderbook depth, spread |
| **Edge** | Edge calculation, regime-aware thresholds, ML confidence |
| **ML Engine** | XGBoost/LightGBM status, confidence, rule vs ML comparison |
| **Bet Sizing** | Kelly-fraction sizing, risk level, bankroll display |
| **Accuracy** | Rolling accuracy (20/50/100 trades), per-regime stats, calibration |

**Dashboard Controls:**
- **START/STOP** button: Pause/resume the bot remotely
- **SELL** button: Manually sell any open position
- **Refresh**: Force position refresh from CLOB API

---

## Trading Strategies

### 1. Standard Directional (Main Strategy)

The bot evaluates each 15-minute BTC market:
- **ML Ensemble** predicts UP/DOWN with confidence level
- **Edge Engine** checks if model probability exceeds market price by enough margin
- **Order Router** decides execution mode:

| Condition | Action |
|-----------|--------|
| ML >= 80% + price <= 62c | FOK (immediate fill) |
| ML 65-79% + wide spread + price 50-60c | Limit order (passive, better price) |
| ML < 65% or no edge | WAIT (skip) |

### 2. Limit Order (Passive Entry)

Places GTD limit orders at 50-60c for better entry prices:
- Auto-cancels after 7 minutes if unfilled
- Falls back to FOK if cancelled
- Max 2 attempts per market (anti-loop protection)

### 3. Pre-Market LONG (Optional)

Daily UP entry at 09:00-09:15 EST:
- Exploits pre-NYSE volatility
- 5% bankroll risk, max 1/day
- Enable with `PREMARKET_LONG_ENABLED=true`

### 4. Recovery Buy (Optional)

Re-enters after cut-loss if signal stabilizes:
- Waits 10s baseline + 30s monitoring
- Requires ML still agrees, token rising/stable
- Max 50% of normal bet size (anti-revenge)

---

## Risk Management

### Circuit Breakers (Auto-Halt)

| Trigger | Default | What Happens |
|---------|---------|--------------|
| Daily loss >= 15% | `MAX_DAILY_LOSS_PCT=15` | Bot halts, 4-hour cooldown |
| Peak drawdown >= 25% | `MAX_DRAWDOWN_PCT=25` | Bot halts, 4-hour cooldown |
| 7 consecutive losses | `MAX_CONSECUTIVE_LOSSES=7` | Bot halts, 4-hour cooldown |
| Win rate <= 30% | Automatic | Bot halts until recovery |

### Cut-Loss Philosophy

**"Hold to settlement wins 87.5% of the time."**

The bot only cuts positions in extreme scenarios:
- Token drops >= 45% (catastrophic collapse)
- ML flips with >= 75% confidence
- Minimum 8-minute hold before any cut allowed

This is intentional. Journal data from 145+ verified trades shows settlement WR of 87.5% vs cut-loss WR of 23.3%.

### Trade Filters (15 Gates)

Every trade must pass all 15 filters:
1. ML confidence >= 62%
2. Market price not in 45-55c zone (coin flip territory)
3. Sufficient volatility (ATR check)
4. Time window: 0.75-14.5 minutes to settlement
5. Post-loss cooldown respected
6. Max 2 trades per market
7. Weekend liquidity check
8. Edge ceiling (< 20%)
9. Counter-trend momentum check
10. Blackout hours: 16:00-23:00 ET
11. Trending regime strictness
12. Spread width (< 8%)
13. ML accuracy degradation check
14. VPIN informed flow gate
15. Spread widening detection

---

## ML Model

### Current: v16 (XGBoost + LightGBM Ensemble)

| Metric | Value |
|--------|-------|
| Test Accuracy | 84.07% |
| Test AUC | 0.9248 |
| Holdout Accuracy | 94.12% |
| At >= 70% confidence | 98.4% WR (87.6% coverage) |
| At >= 80% confidence | 99.3% WR (79.4% coverage) |
| Features | 79 (54 base + 25 engineered) |
| Training data | 45,336 samples, 180-day window, 86% real Polymarket labels |
| Ensemble weights | XGBoost 0.75, LightGBM 0.25 |

### Retraining (Optional)

The bot includes an auto-retrain pipeline:

```bash
cd backtest/ml_training

# Update market lookup (scrape recent markets)
python quickUpdateLookup.py 7

# Generate training data
node generateTrainingData.mjs --days 180 --polymarket-lookup ./polymarket_lookup.json

# Train with Optuna HPO
python trainXGBoost_v3.py --input training_data.csv --tune --tune-trials 150

# Backtest
python backtestPnL.py --threshold-sweep

# Deploy (copy to public/ml/)
cp output/xgboost_model.json ../../public/ml/
cp output/lightgbm_model.json ../../public/ml/
cp output/norm_browser.json ../../public/ml/
```

Auto-retrain runs weekly (Sunday 3 AM UTC) via PM2 if configured.

---

## Monitoring & Alerts

### Telegram Setup

1. Create a bot via [@BotFather](https://t.me/botfather) on Telegram
2. Send `/newbot`, follow the prompts, save the token
3. Send any message to your bot, then visit:
   ```
   https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates
   ```
4. Find your `chat_id` in the response
5. Set in `.env`:
   ```env
   TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
   TELEGRAM_CHAT_ID=987654321
   TELEGRAM_NOTIFY_TRADES=true
   ```

### What Gets Notified

| Event | Channel |
|-------|---------|
| Trade placed (buy/sell) | Telegram + Discord |
| Position filled | Telegram |
| Cut-loss triggered | Telegram (urgent) |
| Circuit breaker halt | Telegram + Discord (critical) |
| Settlement result (win/loss) | Telegram |
| Limit order filled/cancelled | Telegram |
| Daily P&L summary | Telegram |

---

## Troubleshooting

### Bot won't start

```bash
# Check logs
pm2 logs polymarket-bot --lines 50

# Common issues:
# 1. Missing .env → "POLYMARKET_PRIVATE_KEY is required"
# 2. Missing dependencies → "Cannot find module '@polymarket/clob-client'"
#    Fix: cd bot && npm install
# 3. ML models missing → "Failed to load XGBoost model"
#    Fix: Ensure public/ml/xgboost_model.json exists
```

### Circuit breaker triggered

```bash
# Check state
cat bot/data/state.json | python -m json.tool

# Reset circuit breaker (set bankroll fields to actual on-chain balance):
pm2 stop polymarket-bot
# Edit bot/data/state.json: set bankroll, peakBankroll, dailyStartBankroll to actual balance
pm2 restart polymarket-bot
```

### Dashboard shows "Bot disconnected"

- Verify bot is running: `pm2 status`
- Check port 3099 is not blocked
- Bot broadcasts on `ws://localhost:3099`

### Bankroll mismatch

The bot auto-syncs bankroll with on-chain USDC balance. If out of sync:

```bash
pm2 stop polymarket-bot
# Edit bot/data/state.json → set all bankroll fields to your actual USDC.e balance
pm2 restart polymarket-bot
```

### "Order cancelled" errors in logs

Common causes:
- Insufficient USDC.e balance
- Market already settled
- Price moved too far (FOK rejected)
- Token approval needed (auto-handled on retry)

These are normal during operation. The bot retries with different strategies.

---

## Project Structure

```
frontend/
├── src/                          # React dashboard
│   ├── App.jsx                   # Root component, data slicing
│   ├── components/               # 12 dashboard panels
│   ├── engines/                  # Browser-side ML + decision logic
│   ├── indicators/               # 10 technical indicator functions
│   ├── hooks/                    # useBotData, useCountdown, etc.
│   └── config.js                 # Frontend configuration
├── bot/                          # Trading bot
│   ├── index.js                  # Entry point, startup sequence
│   ├── .env                      # Configuration (create this!)
│   └── src/
│       ├── loop.js               # Main trading loop (~2000 lines)
│       ├── config.js             # BOT_CONFIG parsed from .env
│       ├── statusServer.js       # WebSocket server for dashboard
│       ├── engines/              # Signal computation, order routing, limit orders
│       ├── trading/              # Position tracking, CLOB client, cut-loss
│       ├── safety/               # Trade filters, circuit breakers
│       └── monitoring/           # Telegram/Discord notifications
├── public/ml/                    # ML model files (XGBoost + LightGBM + normalization)
├── backtest/ml_training/         # ML training pipeline
├── ecosystem.config.cjs          # PM2 configuration
├── vite.config.js                # Vite dev server + API proxies
└── package.json
```

---

## Important Notes

- **Start with DRY_RUN=true** — Always test before going live
- **Settlement wins 87.5%** — Don't panic-sell. The bot's cut-loss is conservative by design
- **Blackout hours 16:00-23:00 ET** — Bot automatically skips low-WR hours
- **Min entry price 50c** — Bot avoids cheap tokens (historically negative EV)
- **Max bet $2.50** — Position sizing is capped regardless of bankroll
- **The bot does NOT need ETH** — Polymarket uses gasless relays on Polygon
- **Never run `node bot/index.js` directly** — Always use PM2 (handles .env loading correctly)

---

## License

This project is for educational and personal use. Trade at your own risk. Not financial advice.
