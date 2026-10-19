# JEV fixed-policy forward shadow — 2026-10-19

## Why

After the GitHub pattern review, the useful next step was a **fixed-policy forward test**, not choosing a threshold from the same 47 markets:

- `confidence > 0.60`
- `ask <= 0.70`
- `pSide - ask >= 0.10` (pSide = JEV direction probability for the chosen side)
- one candidate per market
- no orders; no effect on bot selection

## Implementation

- `JEV_CALL_ON=policy` calls JEV once per market at the first eligible poll (exact PTB, 0.5–14.4 min left), independent of the bot ENTER decision. Cost ≈ $0.006/day at ~96 markets/day.
- `bot/src/ai/jevPolicyShadow.ts` is pure policy evaluation + append-only `data/jev_policy.jsonl`. It has no order path and never throws into the loop.
- `bot/src/ai/jevAdvisor.ts` calls it only for non-`entryRefresh` policy calls; the final-fill refresh is still recorded separately for bot-entry analysis.
- Env: `JEV_CALL_ON=policy`, `JEV_POLICY_SHADOW=true`, `JEV_POLICY_MIN_CONF=0.60`, `JEV_POLICY_MAX_ASK=0.70`, `JEV_POLICY_MIN_EDGE=0.10`.
- Report: `bot/scripts/jevPolicyReport.mts` resolves candidates from the journal/Gamma, computes outcome/win/fee/PnL, Brier vs market, progress to 100 resolved markets, and bot overlap (same slug).

## Current status (deployed 2026-10-19 15:15 UTC)

- Service active, JEV `[SHADOW]`, `JEV_CALL_ON=policy`.
- JEV log continues to record each market; the 22:15 WIB market call was 53% confidence (<0.60), so no policy candidate was written — correct behavior.
- `data/jev_policy.jsonl` will appear with the first market that clears all three gates.
- Test suite: **87 files / 922 tests PASS** (new `jevPolicy.test.ts`, 5 tests).

## How to inspect

```bash
ssh polyvps "cd /opt/polybtc15/bot && sudo -u ubuntu node --env-file=./.env scripts/jevPolicyReport.mts"
```

Outputs `data/jev_policy_report.json` and prints candidate count, resolved/open, direction accuracy, Brier, WR, PnL/share, ROI, avg ask, bot overlap, progress to 100.

## Decision rule (pre-registered)

- Collect **at least 100 resolved markets**.
- Do not tune thresholds mid-sample; the fixed policy is above.
- Compare JEV policy vs market Brier and vs the bot on overlapping markets.
- Only if direction CI is clearly above 50%, PnL/ROI survives fees, and the fixed policy is stable across the sample: consider a pre-entry gate/primary. Until then JEV remains shadow.

## What is deliberately not included

- No orders, no size, no bankroll impact.
- No news/research LLM, maker orders, or SDK migration yet.
- No threshold changes after seeing results.