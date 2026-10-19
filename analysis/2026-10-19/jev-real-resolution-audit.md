# JEV vs real Polymarket resolutions — full audit 2026-10-19

## Scope & method

- All `jev_log.jsonl` calls: **55 calls / 38 unique markets**, 2026-10-19 03:41–12:45 UTC.
- Fresh resolution fetch at 12:48 UTC from Polymarket Gamma: `GET https://gamma-api.polymarket.com/markets/slug/<slug>`. Outcome = the outcome whose `outcomePrices` is 1 (labels "Up"/"Down"); `umaResolutionStatus=resolved`. All 38 requests HTTP 200, no errors.
- **52 calls / 36 markets resolved**; 3 calls / 2 markets still open at fetch time. Direction accuracy uses only calls with `UP`/`DOWN` (NO_EDGE counts as abstain).

## Headline

| Metric | Result |
| --- | --- |
| Calls resolved | 52 / 55 |
| Markets resolved | 36 / 38 |
| Direction accuracy (all calls with opinion) | **22 / 38 = 57.9%** (95% CI 42.2–72.1%) |
| NO_EDGE | 14 / 52 calls (26.9%) |
| Unique-market first-call accuracy | 19/31 = 61.3% |
| Unique-market latest-call accuracy | 15/25 = 60.0% |
| Confidence ≥0.60 | 14/20 = **70.0%** (CI 48.1–85.5%) |
| Confidence ≥0.70 | 4/8 = **50.0%** |
| Settle-up Brier | **0.3017** (n=52) |
| Market-price Brier | **0.1686** |
| ML Brier | **0.1884** |

Direction confusion (resolved calls):

| JEV direction | n | Actual UP | Actual DOWN | Accuracy |
| --- | ---: | ---: | ---: | ---: |
| UP | 15 | 10 | 5 | 66.7% |
| DOWN | 23 | 11 | 12 | 52.2% |
| NO_EDGE | 14 | 7 | 7 | abstain |

Down calls had essentially no edge; the overall 57.9% is carried by UP calls and by calls where the bot rules already had a side.

## The key problem: JEV is not an independent signal

| Subset | n | Correct | Accuracy |
| --- | ---: | ---: | ---: |
| Calls where `rules.side` was present | 21 | 15 | **71.4%** |
| Calls with no rule side | 17 | 7 | **41.2%** |
| Confidence ≥0.60 with rule side | 15 | 11 | 73.3% |
| Confidence ≥0.60 without rule side | 5 | 3 | 60.0% |

In all **21/21** calls where the bot already had a side, JEV direction agreed with that side. The prompt includes the market odds and the algo view, so these calls largely measure whether the rule side was right — not whether JEV adds independent information. When there is no rule side, JEV is **41.2%**, below a coin flip. That directly weakens the hypothesis “JEV decisions are good”: its apparent accuracy is mostly an echo of the bot’s own view.

## Settle probability is badly calibrated

JEV settle-up Brier **0.3017** vs market **0.1686** and ML **0.1884**. Calibration buckets:

| Predicted settle-up | n | Avg predicted | Actual UP rate |
| --- | ---: | ---: | ---: |
| 0–20% | 25 | 7.2% | **40.0%** |
| 80–100% | 27 | 90.2% | **66.7%** |

There are no calls in the 20–80% range; JEV answers almost binary 7% or 90% and is wrong in both directions. Direction vs settle conflict: only 5 calls, but settle-prob side was right 4/5 while JEV direction was right 1/5. The two JEV outputs are internally inconsistent (e.g. DOWN with settle-up 91%). The settle-probability output should not be used for edge, sizing, gate or primary.

## By regime and timing

| Regime | Opinion n | Correct | Accuracy |
| --- | ---: | ---: | ---: |
| trending_down | 10 | 7 | 70.0% |
| mean_reverting | 8 | 5 | 62.5% |
| trending_up | 8 | 5 | 62.5% |
| choppy | 12 | 5 | **41.7%** |

- 33 of the resolved opinion calls were made at **10–14.4 min left** — i.e. near market open; there is only 1 at 5–10 min and 4 below 5 min. The decision is cached and later used by veto, so the bot is often using a market-open opinion much later.
- High-confidence misses exist: DOWN 73% → UP, DOWN 72% → UP (twice), DOWN 70% → UP, UP 62% (settle 91%) → DOWN. Confidence is not monotonic: ≥0.60 is 70%, ≥0.70 is 50%.

## Verdict

**The hypothesis is not supported by the real resolutions.** JEV is a decent *echo* when the bot already has a side (71.4%), but with no rule side it is 41.2%; its settle probability is much worse than the market (Brier 0.302 vs 0.169) and badly calibrated. The overall direction accuracy (57.9%, n=38) is too noisy and too dependent on the rule side to call it an edge.

Implications for `JEV_MODE=veto`:

1. Do not promote to gate/primary and do not blend the settle probability into edge/sizing.
2. The veto cannot be validated from these logs alone: JEV is called early, while the eventual trade side is chosen later; the log’s `rules.side` is not the would-be entry side. The tape now has `jd` per poll, so a future study can reconstruct actual vetoed entries.
3. Given the evidence, **shadow mode is the safer default** until a refresh-at-decision version (call JEV when the bot is about to enter, not only at market open) is tested out of sample.
4. JEV is only 830 sole-blocker lines out of 113,954 filter lines, so changing it will not solve the trade-frequency problem; the price cap and early-time gate are much larger.

## Files

- `analysis/2026-10-19/jev-call-eval.csv`: every one of the 55 calls with slug, direction, confidence, settle probability, regime, market/ML prices, actual Gamma outcome and correctness.
- `analysis/2026-10-19/gateway-blockers-jev-quality.md`: filter blocker analysis.

*Resolution snapshot taken 2026-10-19T12:48:36Z. Two markets were still open and excluded; rerun after they close for n=38.*
