# Entry-price policy + JEV entry-time shadow + early-time probe — 2026-10-19

## 1. "Entry at the lowest possible price" — is it a good decision?

**No, not as a blanket rule.** A lower token price is not a better trade by itself: it reflects a lower win probability. The bot already has a 50c floor (`FILTER_ENTRY_FLOOR`) and a 0.08 edge bypass for sub-50 entries. On the journal:

| Entry bucket | n | WR | Net PnL |
| --- | ---: | ---: | ---: |
| <50c | 17 | 23.5% | −20.24 |
| 50–55c | 61 | 55.7% | +0.58 |
| 55–60c | 199 | 61.8% | +10.84 |
| 60–65c | 300 | 65.7% | +15.93 |

Lowering the floor to chase 45–50c adds trades with a historically catastrophic win rate. The current floor + edge bypass is the right structure; no floor change was made. If execution price improvement is the goal, the next honest test is a maker/limit entry (the existing makerFillStudy: ~60% fill in 15 s, saves ~1c + the taker fee, adverse selection unresolved) — not lowering the probability floor.

## 2. JEV logic changed to match the bot

The audit showed JEV was called at market open, often 10–14.4 min left, and then used much later; it also mostly echoed the bot rule side and had poor settle-probability calibration. Changes:

- `JEV_CALL_ON=entry` (new config): JEV is only called when `decide()` yields an `ENTER` candidate. No more WAIT/market-open calls, and the logged decision is about an actual trade candidate.
- `JEV_MODE=shadow` on the VPS: the unvalidated veto no longer blocks trades. JEV remains logged and the dashboard shows it, but it is not a gate.
- `JEV_SHADOW=true`, `JEV_CALL_ON=entry`; `JEV_CALL_ON=market` restores the old behaviour if needed.
- The JEV evaluation after the next entries should be scored separately; do not use `settle_above_ptb` for edge/sizing.

## 3. Which gate was loosened?

- **JEV veto** — removed (shadow). It was the one gate with direct evidence against it: direction 57.9% overall, 41.2% when no rule side, settle Brier 0.3017 vs market 0.1686.
- **Dry-run early-time probe**: `FILTER_DRY_RUN_MAX_TIME_LEFT=13` allows entries from 13 min instead of 12 in DRY_RUN only. Live keeps the validated 12-min gate because the 12–13 min band has no out-of-sample evidence yet.
- Price cap, ML gate and entry floor were **not** loosened.

This is deliberately an experiment, not a claim: the dry-run window was reset to `2026-10-19T12:58:17Z`; compare trade count, WR, Brier and PnL per bucket after enough samples. Revert by removing `FILTER_DRY_RUN_MAX_TIME_LEFT` (or set it to 12).

## 4. Deployment

- Bot files updated: `config.ts`, `ai/jevAdvisor.ts`, `safety/filterThresholds.ts`, `safety/tradeFilters.ts`, `bot/.env.example`.
- VPS env: `JEV_MODE=shadow`, `JEV_SHADOW=true`, `JEV_CALL_ON=entry`, `FILTER_DRY_RUN_MAX_TIME_LEFT=13`, `EVAL_WINDOW_START=2026-10-19T12:58:17Z`.
- Startup verified: `JEV: enabled [SHADOW]`, filter override warning includes `FILTER_DRY_RUN_MAX_TIME_LEFT=13`, JEV log stayed at 55 calls (no WAIT calls), service active.
- Typecheck PASS; full suite **86 files / 917 tests PASS**.

## Caveat

- `JEV_CALL_ON=entry` means no JEV data during long WAIT periods; that is intentional (the decision should be about the trade, not the market open).
- With JEV shadow and the early-time probe, the dry-run window will take a while to accumulate trades, especially while markets trade 80–88c. Do not judge for at least 30–50 trades.
