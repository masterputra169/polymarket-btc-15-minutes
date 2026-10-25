# JEV target study - 2026-10-26

Record-only walk-forward study. No runtime decision changed.

## Design

- 619 unique JEV markets with resolved outcomes.
- 6 expanding folds: first train 40%, then test 10% per fold; 62 test markets each.
- 372 out-of-fold predictions.
- Models: market baseline, stack3 (market+JEV calibrated+ML), stack5 (+direction confidence, market confidence, edge).
- Paired bootstrap: 2,000 resamples, fixed seed.

## Primary target

| Model | Brier | Skill vs market |
|---|---:|---:|
| Market | 0.2290 | - |
| Stack3 | 0.2349 | -2.58% |
| Stack5 | 0.2350 | -2.60% |

Bootstrap difference (stack minus market):

```text
stack3 mean +0.00582  CI +0.00125 .. +0.01039
stack5 mean +0.00583  CI +0.00125 .. +0.01056
```

Positive difference means the stack is worse. The lower bound is above zero, so there is no evidence the model beats the market.

Primary target: **NOT achieved.**

## Secondary target

Coverage-aware OOF Brier (selection by model confidence):

| Coverage | n | Market Brier | Stack3 Brier | Stack5 Brier |
|---:|---:|---:|---:|---:|
| 10% | 37 | 0.1140 | 0.2023 | 0.1959 |
| 20% | 74 | 0.1887 | 0.1997 | 0.2040 |
| 30% | 111 | **0.1953** | 0.2121 | 0.2148 |
| 50% | 186 | 0.2112 | 0.2239 | 0.2234 |
| 100% | 372 | 0.2290 | 0.2349 | 0.2350 |

The only 30%-coverage slice below 0.20 is the **market baseline** (0.1953, n=111), not the stack. That is market selectivity, not a JEV edge.

Secondary target: **NOT achieved by the stack with n >= 100.**

## Verdict

- Primary: failed; stack is significantly worse than market.
- Secondary: failed for stack at 30% coverage; 20% slice is n=74 (<100).
- JEV remains shadow; no gate/veto/sizing change.

## Next

1. Add features not present in the JEV log: order-flow/microstructure, exact PTB distance, volatility/tape features.
2. Fit a dedicated outcome model; use JEV only as one feature.
3. Collect 100+ forward policy entries and re-run walk-forward.
4. Do not select features or thresholds on the test folds.
