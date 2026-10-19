# GitHub patterns applied to this bot — 2026-10-19

## What was adopted

1. **Policy in code, JEV only as a judgment** — from `buberlo/jev-trader` and `BrunooMoniz/polymarket-btc-5m-agent`. The bot keeps deterministic filters, risk and execution; JEV remains shadow and cannot own the trade.
2. **Explicit shadow policy gates** — from `VGabriel45/polymarket-btc5m-jev-trading` / `Polytutor-AI-Labs/polymarket-5min-btc-Jev-trading-bot`: confidence threshold, max ask, minimum edge, one entry per market, taker fee included. Implemented as a **shadow policy simulation in `bot/scripts/jevEvaluate.mts`**, not as a live gate.
3. **Benchmark first** — from `bnskaggs/jev-vs-polymarket` and `lazuli111/jev-polymarket-desk`: score against real resolved markets, Brier/calibration, never infer from one or two outcomes.
4. **Final-fill evidence** — from the same shadow-first pattern: `tradePipeline` now journals `jevDirection/jevConfidence/jevSettleUp/jevRegime/jevCallTs/jevConflict` at the actual fill, and `loop.ts` force-refreshes JEV after the fill (`entryRefresh: true`).

## What was rejected (for now)

- **Copying a live bot or its thresholds** — the GitHub bots trade 5m markets, mostly with confidence >0.90 and no out-of-sample proof on our 15m book.
- **A news/research LLM layer** — `jevymarket` adds a web-search researcher, but our 15m BTC market and our cost/latency budget do not justify it.
- **Maker/post-only entry** — `BrunooMoniz` uses it well, but our maker-fill/adverse-selection evidence is incomplete (`makerFillStudy.py`).
- **Polymarket SDK migration** — official `Polymarket/ts-sdk` / `py-sdk` are current, but our V2 path works; migration is a separate project.
- **Archived `Polymarket/agents`** and low-license repos — reference only, no code copying.

## Shadow policy result (JEV-only, not live)

Script: `bot/scripts/jevEvaluate.mts`; 47 resolved markets; latest JEV call per market; gates: `confidence > threshold`, ask ≤ 0.70, `pSide − ask ≥ 0.10`, one entry per market, fee = 0.07·ask·(1−ask).

| Confidence | Trades | WR | PnL/share | ROI | Avg ask |
| --- | ---: | ---: | ---: | ---: | ---: |
| >0.50 | 20 | 65.0% | +0.796 | +6.7% | 0.594 |
| >0.60 | 17 | 70.6% | +1.463 | +14.3% | 0.603 |
| >0.70 | 7 | 57.1% | −0.232 | −5.6% | 0.588 |
| >0.80 | 0 | n/a | n/a | n/a | n/a |
| >0.90 | 0 | n/a | n/a | n/a | n/a |

Context: direction 22/36 = 61.1% (NO_EDGE 11, coverage 76.6%); JEV settle Brier 0.2825 vs market 0.1819.

**Read this as a hypothesis, not an edge.** n=17, thresholds were inspected as a group, and 0.70 reverses sign. The next step is a fixed-policy forward shadow test over ≥100 markets (conf>0.60, ask≤0.70, edge≥0.10), not an immediate gate.

## Files

- `bot/scripts/jevEvaluate.mts` — benchmark + policy simulation.
- `bot/src/ai/jevAdvisor.ts`, `bot/src/loop.ts`, `bot/src/engines/tradePipeline.ts` — final-fill refresh and journal fields.
- `analysis/2026-10-19/gateway-blockers-jev-quality.md`, `jev-real-resolution-audit.md`, `jev-open-position-conflicts.md` — evidence base.

## Sources (GitHub)

- https://github.com/VGabriel45/polymarket-btc5m-jev-trading
- https://github.com/Polytutor-AI-Labs/polymarket-5min-btc-Jev-trading-bot
- https://github.com/buberlo/jev-trader
- https://github.com/BrunooMoniz/polymarket-btc-5m-agent
- https://github.com/lazuli111/jev-polymarket-desk
- https://github.com/bnskaggs/jev-vs-polymarket
- https://github.com/markusbug/jevymarket
- https://github.com/Polymarket/ts-sdk
- https://github.com/Polymarket/py-sdk
- https://github.com/Polymarket/real-time-data-client
- https://github.com/doge-8/btc5m-web