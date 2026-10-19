# JEV Full Collaboration Integration - 2026-10-19

Model: OpenRouter `typesafe/jev-1.14` (System One API, `POST https://openrouter.ai/api/v1/systemone`, `OPENROUTER_API_KEY`).

## What was built

| Layer | Integration |
| --- | --- |
| Client | `bot/src/ai/typesafeClient.ts` - provider `openrouter` (default) or `typesafe`, retry 429/529/5xx, timeout, sanitized logging |
| Advisor | `bot/src/ai/jevAdvisor.ts` - one call per market after PTB is exact (0.5-14.4 min in): direction Choice, settle-above-PTB Noul, regime Choice; log `bot/data/jev_log.jsonl`; 10-min pause on 401/402 |
| Modes | `shadow` (log only), `veto` (block conflicting entries), `gate` (require agreement), `primary` (override ENTER side; force only if `JEV_PRIMARY_FORCE_ENTRY=true`) |
| Filters | `tradeFilters.ts` gate 19b calls `checkJevAdvisory(side, marketSlug)`; no-op in shadow |
| Sizing | `getJevSizingMultiplier` scales the bet by up to +15% when JEV agrees; applied in `loop.ts` after `computeBetSizing` |
| Alerts | Telegram entry alerts append `JEV: dir conf% | settle p% | regime` (`getJevSummary`) |
| Tape/log | Every decision appended to `bot/data/jev_log.jsonl` with rules/ML/market context, probabilities, latency, tokens and USD cost |
| Dashboard | Broadcast includes `jev: getJevStatus()`; new `src/components/JevPanel.tsx`; dist rebuilt and deployed |
| Evaluation | `bot/scripts/jevEvaluate.mts` resolves outcomes for every market via Gamma fallback, reports direction accuracy, settle Brier vs market/ML, calibration, per-regime |
| Ops | External watchdog timer (`polybot-watchdog.timer`, 5 min) running `botLiveness.mts` and restarting the bot on failure |

## Live verification (VPS, 2026-10-19)

- `JEV: enabled [SHADOW] provider=openrouter model=typesafe/jev-1.14`; calls succeeded (e.g. model `typesafe/jev-1.14-20261014`, 1,541 input tokens, 1,981 ms, $0.000065).
- First four decisions logged; one sample: `NO_EDGE (51%) | settle_up 86% | trending_down`.
- `jevEvaluate`: 3 matched markets; settle Brier JEV 0.238 vs market 0.339 vs ML 0.331; direction 1/1 where JEV had an opinion (NO_EDGE 2/3). n is far too small to conclude.
- Dashboard: WS snapshot carries `jev` (`mode=shadow`, calls count); rebuilt `dist` served by nginx; `JevPanel` wired into App.
- Services: bot, nginx, cloudflared, tunnel-sync, watchdog timer all active.

## How to switch to full active use

1. Let shadow accumulate >=100 markets (1-2 days; ~96/day).
2. Evaluate: `node bot/scripts/jevEvaluate.mts` (on VPS). Require JEV settle Brier < market and direction accuracy meaningfully above 50% with coverage.
3. Set `JEV_MODE=veto` first (or `gate`), set `EVAL_WINDOW_START` to the switch timestamp, restart bot.
4. Only after a further forward window passes, consider `JEV_MODE=primary` (side override) - it changes selection the most.

## Cost

$0.042 per 1M input tokens, output free. Observed $0.000065/call; ~96 calls/day => $0.006/day (~$0.19/month).
