# Shadow decision study — 2026-10-23

Record-only study. No entry rule was changed. Source: `bot/scripts/shadowDecisionStudy.mjs`.

## Current model baseline

| Metric | Current model | All settled |
|---|---:|---:|
| Trades | 374 | 832 |
| WR | 61.2% | 64.4% |
| Wilson 95% WR | 56.2–66.0% | 61.1–67.6% |
| Avg entry | 59.0c | 61.4c |
| Breakeven | 60.67c | 63.04c |
| Margin | +0.56pp | +1.38pp |
| PnL | +$3.69 | +$14.87 |
| Brier model/market | 0.2439 / 0.2305 | — |
| Brier skill | **-5.8%** | — |

## Time split

- Train: 224 trades (first 60%)
- Test: 150 trades (last 40%)

## Candidate filters

| Filter | Test n | Test WR | Test margin | Test PnL | Basic split |
|---|---:|---:|---:|---:|---|
| baseline | 150 | 60.7% | +0.37pp | -$0.29 | survived (barely) |
| no-Europe | 123 | 61.8% | +1.28pp | +$3.00 | survived |
| no-MID | 99 | 65.7% | +5.08pp | +$11.24 | survived |
| no-Europe+MID | 80 | 67.5% | +7.04pp | +$12.93 | survived |
| no-LATE | 142 | 59.9% | -0.33pp | -$2.37 | rejected |
| no-sideProb-0.6 | 81 | 71.6% | +9.86pp | +$16.29 | survived |
| no-sideProb-0.8 | 134 | 59.0% | -1.09pp | -$4.37 | rejected |
| combined small | 33 | 75.8% | +13.94pp | +$10.17 | survived, small n |

The combined filter has only 33 test trades, so it is not a promotion candidate yet.

## Model gate

| Model | n | WR | Margin | Brier model/market | Skill |
|---|---:|---:|---:|---|---:|
| pre-registry | 458 | 67.0% | +2.06pp | 0.2596 / 0.2169 | -19.7% |
| 20260924-p2-0d88d4 | 374 | 61.2% | +0.56pp | 0.2439 / 0.2305 | -5.8% |

Champion gate policy: a challenger needs **>=100 settled shadow trades**, Brier below the market, and a positive margin. No challenger model is currently supplied, so this is a gate for a future shadow model — not a deploy.

## Interpretation

- Europe and MID are the strongest filter candidates, but the test set is only 150 trades.
- The 0.6–0.7 side-probability bucket is a stronger candidate than the overall confidence label.
- The 0.8–0.9 bucket is not a filter candidate: it failed the split.
- Large apparent gains from the combined filter are not credible at n=33.

## Next

1. Freeze the baseline and register the candidates in `pre-registered-filter-rules.md`.
2. Re-run this script as new trades settle.
3. Apply no filter to live until forward criteria pass.
