# JEV stacking study - 2026-10-26

Record-only study. No runtime decision was changed.

## Design

- 618 matched markets.
- Time split: 432 train (first 70%), 186 test (last 30%).
- Baselines: market, ML, JEV calibrated.
- Stacks: logistic market+JEV and market+JEV+ML.
- 1,500 paired bootstrap resamples; coverage-aware Brier.

## Test results

| Model | Brier | Skill vs market |
|---|---:|---:|
| Market | 0.2409 | - |
| ML | 0.2496 | - |
| JEV calibrated | 0.2444 | - |
| Stack market+JEV | 0.2420 | -0.5% |
| Stack market+JEV+ML | 0.2407 | +0.07% |

Bootstrap stack vs market: mean -0.00009, 95% CI -0.00644 to +0.00607. The CI includes zero.

## Coverage-aware Brier

| Coverage | Model-conf Brier | Market-conf Brier |
|---:|---:|---:|
| 10% (n=18) | 0.1842 | 0.1659 |
| 20% (n=37) | 0.2099 | 0.2338 |
| 30% (n=55) | 0.2250 | 0.2343 |
| 50% (n=93) | 0.2352 | 0.2321 |
| 100% (n=186) | 0.2407 | 0.2409 |

## Verdict

- All-market Brier below 0.20: not achieved.
- Best stack beats market by only 0.07%; not significant.
- Sub-0.20 appears only at 10% coverage (n=18), too small to trust.
- JEV stays shadow; no gate/veto/sizing change.

## Next

- Wait for 100+ forward policy entries.
- Re-run on a future slice.
- Require paired CI below zero before promotion.
