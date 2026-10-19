# Gate / indicator / CRPS audit — 2026-10-19

## 1. "Gateway" scan: what is actually blocking entries

`bot/src/safety/tradeFilters.ts` has **20 numbered gates (0–19)**, several with a/b/c sub-gates, plus preconditions outside the filter list (signal confirmation ~9 s, edge/probability thresholds, JEV veto). The main blockers in the logs after the last restart:

- entry price above the hard cap — dry run is 75c via `DRY_RUN_HARD_ENTRY_CAP`; the production cap stays **68c**;
- extreme price outside 15–85c;
- market near 50/50 (47–53c);
- JEV veto (`JEV DOWN (69%) disagrees with UP`) — 7,241 filter log lines contain JEV, 3,319 without the main price/extreme/near-50 reasons (poll-level, so unique markets are far fewer);
- too early (>12 min left), ML confidence, spread, time/VPIN/session gates and the rest.

The 9 s confirmation is **not** the binding gate: `Stab` has reached 535/180 in the logs.

**Do not simply raise the live price cap.** The codebase already records the analysis (tradeFilters.ts lines 68–96): with the CLOB V2 fee, entry buckets score

| Entry price | n | WR | Breakeven | Margin | PnL |
| --- | --- | --- | --- | --- | --- |
| 0.50–0.575 | 71 | 63.4% | 55.7% | +7.7pp | +5.42 |
| 0.575–0.65 | 180 | 64.4% | 61.4% | +3.0pp | +12.88 |
| 0.65–0.68 | 27 | 63.0% | 66.6% | −3.7pp | −1.95 |
| 0.68–0.72 | 58 | 77.6% | 70.4% | +7.2pp | +7.56 |
| 0.72+ | 65 | 73.8% | 73.8% | +0.0pp | −0.10 |

Raising the cap to admit the current 80–88c favourites buys roughly breakeven trades. The dry-run-only cap can be raised for sample collection (`DRY_RUN_HARD_ENTRY_CAP=0.85`), but that contaminates the evaluation window and cannot be used live. Better levers, in order: wait for 50–72c markets (zero strategy change), reduce the JEV veto only after its evaluation, or lower the already-softened ML/edge thresholds (historical evidence says lower quality).

## 2. Technical indicators in use

`src/indicators/` contains **10 indicator modules**: ATR, Bollinger, EMA cross, funding rate, Heiken Ashi, MACD, RSI, StochRSI, Volume Delta, VWAP (plus `math.ts` helpers). `computeIndicators()` also derives: volume recent/average, realized volatility, volatility profile, regime/autocorrelation, multi-timeframe confirmation, 5-candle momentum, volatility change ratio, price consistency, failed-VWAP reclaim, VWAP cross count. Microstructure adds orderbook imbalance, spread, VPIN and orderbook flow; funding is externally blocked so it is neutral. `twapPhysics` (P(UP) from distance-to-PTB / vol) is record-only.

The ML model uses **79 features** (`public/ml/norm_browser.json`): the 10 indicators plus engineered interactions, regime/session one-hots, market price/momentum, orderbook imbalance, spread and funding. So: **10 classical TA indicators, ~15 derived quant/microstructure signals, 79 model inputs.**

## 3. Add more indicators?

No — not for trade frequency, and not without an out-of-sample gate. The current model already has 79 features but is **worse than the market on Brier**: entry-side predictions average 82.9% while the realised win rate is 64.8%. More correlated RSI/MACD-style features would mostly add overfitting.

Quant-appropriate additions, if any, are not classic TA: distance-to-PTB in volatility units (already computed record-only as `twapPhysics`), realised variance/EWMA volatility (already), orderbook microprice/imbalance (already; first tape study says little edge), time-to-expiry interactions, cross-venue basis. Add them only if they clear the retrain gate (`market_skill > 0`), not because they are familiar indicators. The bigger win is **probability calibration** (shrink the 82.9% claims toward the 64.8% reality) and execution, not more indicators.

## 4. CRPS: was it real?

**Before: no.** The dashboard computed `overallCRPS` in the browser from `computeOverallCRPS(loadHistory())`, i.e. localStorage populated only while the dashboard was open, auto-settled from spot ~3 s before expiry, 24 h retention, never reconciled with the verified journal. It could be null, stale or wrong. Also, for a binary outcome CRPS is the Brier score, so the label was numerically the Brier formula but the data source was not the bot.

**Now: yes.** `journalAnalytics.computePatterns()` computes Brier/log loss from every directional journal row using the entry-time ensemble probability for the chosen side and the verified outcome. Dashboard reads `journalAnalytics.patterns.brier`.

Live snapshot: **Brier/CRPS = 0.2583, n = 749, logloss = 0.7548**. Baselines on the same rows:

- model mean predicted = **82.9%**, realised win rate = **64.8%**;
- market-price Brier = **0.2229**;
- constant-base-rate Brier = **0.2282**.

So the number is real, and it says the model is **overconfident** and worse calibrated than both the market and a constant 65% forecast. Trade selection still profits (net +14.10, WR 64.8%), but the probability output shouldbe shrunk for sizing/edge display; more indicators will not fix that.
