# Pre-registered filter and champion rules — 2026-10-23

This file fixes the decision rules **before** forward data accumulates. Changing a rule starts a new evaluation window.

## Baseline

- Baseline entry rule: unchanged as of 2026-10-23.
- Evaluation data: live dry-run journal only; pre-registry rows are not used for current-model decisions.
- No filter is promoted from the 2026-10-23 historical split alone.

## Registered candidates

| ID | Rule |
|---|---|
| F1 | Exclude Europe session |
| F2 | Exclude MID phase |
| F3 | Exclude Europe and MID |
| F4 | Exclude side-probability 0.6–0.7 bucket |
| F5 | F3 + F4 combined |

`no-LATE` and `no-sideProb-0.8` are **rejected** and are not registered.

## Primary endpoints

For each candidate, after the rule is frozen:

1. fee-adjusted WR minus average breakeven (margin),
2. PnL with taker fee,
3. Wilson 95% interval for WR,
4. model Brier vs market (where applicable),
5. sample count per session/bucket.

## Sequential checkpoints

- Check at 100 settled forward trades.
- Check again at 150 and 200.
- Per-session/bucket candidate needs at least 30 forward trades before a decision.
- If a candidate fails at 100 and the confidence interval is clearly below breakeven, stop it early.
- If it is inconclusive, extend to 200; do not repeatedly re-test after every few trades.

## Promotion rule

All must hold:

- forward margin > 0;
- forward PnL > 0;
- Wilson 95% lower bound above 0 for the relevant sample (or a clearly pre-declared equivalent);
- no single session/regime drives the entire gain;
- minimum 30 forward trades in the affected bucket.

If a rule fails, it is retired rather than retuned on the same data.

## Champion/challenger gate

A challenger model may replace the champion only if:

- >=100 settled shadow trades;
- live Brier < market Brier;
- positive margin after fees;
- calibration not worse than champion;
- no entry-rule changes in the same window.

No challenger is currently registered.

## Freeze

- Baseline frozen: 2026-10-23 21:20 WIB.
- First forward checkpoint: 2026-10-31 (≈100 new trades at the current rate).
- Second: 2026-11-06 to 2026-11-13 (150–200 new trades).
- Any change to entry/exit selection resets the window.
