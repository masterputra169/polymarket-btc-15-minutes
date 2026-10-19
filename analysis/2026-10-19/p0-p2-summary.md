# P0-P2 Execution Summary - 2026-10-19

## P0

| Item | Status | Evidence |
| --- | --- | --- |
| JEV as decision layer (OpenRouter `typesafe/jev-1.14`) | DONE, shadow | first live calls, `bot/data/jev_log.jsonl`, cost $0.000065/call |
| JEV full collaboration (modes + sizing + alerts + dashboard + evaluator) | DONE | `JEV_MODE=shadow|veto|gate|primary`; WS `jev`; `JevPanel`; `jevEvaluate` resolves all markets via Gamma |
| RTDS -> PolyBolt migration (deadline ~2026-10-23) | DONE, deployed | probe PASS TWAP/SPOT provider=chainlink; first post-cutover PTB `chainlink_twap, exact, +1.8s`; RTDS shadow fallback |
| LLM regime OpenRouter off (402) | DONE earlier | `LLM_REGIME_ENABLED=false`; JEV replaces it |

## P1

| Item | Status | Evidence |
| --- | --- | --- |
| CLOB V2 merge (go-live blocker) | DONE (merged) | main `92e8deb` + PolyBolt `eda6891`; `npm run typecheck` PASS; `npx vitest run` 83 files / 893 tests PASS |
| Evaluation window | RUNNING | n=~260+ of 300 target, ~61% WR, PnL +$4.2 at last check |
| JEV evaluation all markets | DONE | Gamma fallback; first n=3: settle Brier JEV 0.238 vs market 0.339 vs ML 0.331 (too early) |

## P2

| Item | Status | Evidence |
| --- | --- | --- |
| External watchdog | DONE | `polybot-watchdog.timer` every 5 min, `botLiveness.mts` -> restart |
| Dashboard JEV panel | DONE | dist rebuilt + deployed; WS `jev` verified |
| Permanent tunnel URL | PENDING (operator) | Cloudflare named tunnel + domain; current quick tunnel is kept in sync by timer |
| Railway cleanup | PENDING (operator) | project HOBBY PAST_DUE $24.58; data exported locally; volumes can be deleted after final review |
| Maker-fill study | WAITING for data (~7 weeks) | no action |

## Commit trail

- `271991e` JEV full collaboration (OpenRouter, modes, dashboard, evaluator, watchdog)
- `92e8deb` CLOB V2 merged into main (verified 874 tests in worktree)
- `eda6891` PolyBolt migration (deployed; merged tree verified 893 tests)

## Remaining operator decisions

1. JEV active mode: shadow -> veto/gate/primary after >=100 markets; switching resets `EVAL_WINDOW_START`.
2. CLOB V2 go-live: pUSD funding + two approval transactions + 5-share live smoke order, then deploy merged code to VPS (`npm ci --prefix bot`).
3. Railway project deletion / permanent dashboard tunnel.
