# JEV independent v2 + bot calibration study — 2026-10-19

## 1. JEV independent state v2 (deployed)

The collaborative prompt included the bot rules, ML side, edges and provisional action. That made JEV echo the bot: 21/21 calls with a rule side agreed with it, and only 41.2% accuracy when no rule side existed.

Added `JEV_INDEPENDENT_STATE=true` (shadow only):

- `buildJevState(snapshot, independent)` omits `algo_view` (ML, rules, edges, provisional action) and sets `state_variant: independent_v2`.
- `buildJevQuestions(independent)` tells JEV it gets market odds + technical/order-flow state and **no bot recommendation**.
- The JEV log records `stateVariant` so collaborative and independent calls do not get mixed in analysis.

VPS now runs `JEV_INDEPENDENT_STATE=true`, `JEV_CALL_ON=policy`, `JEV_POLICY_SHADOW=true`. First independent call: 22:30 WIB, `stateVariant=independent_v2`, DOWN confidence 0.33, no policy candidate (correct: confidence below 0.60).

## 2. Bot calibration study

Script: `bot/scripts/calibrationStudy.mts`; 753 settled directional entries with entry `ensembleUp` and market odds; time-ordered 60/40 train/test. Model p = probability of the chosen side; market p = chosen-side ask; shrink `p = market + w·(model − market)`.

| Split | Model Brier | Market Brier | Best shrunk Brier | Best w |
| --- | ---: | ---: | ---: | ---: |
| Train (451) | 0.2538 | 0.2166 | 0.2152 | 0.15 |
| Test (302) | 0.2638 | 0.2321 | 0.2318 | 0.15 |

Test means: model predicts 78.2% vs realised 61.3%; market predicts 58.5%. Shrinking to 15% model weight barely beats the market (0.2318 vs 0.2321) — statistically a tie.

**Conclusion:** the model is heavily overconfident; calibration should be much closer to market. But because the OOS Brier improvement over market is essentially zero, this is **not** yet a reason to change trade selection. The next valid step is to use the calibration only in a recorded/Kelly-sizing study after the forward sample, not to re-optimise filters on the same journal.

## 3. Status

- Service active, JEV independent v2 shadow, policy logger waiting for the first candidate that clears `conf>0.60`, `ask≤0.70`, `pSide−ask≥0.10`.
- The fixed-policy forward sample is now on independent JEV; no candidates yet.
- Full suite: **87 files / 924 tests PASS**.

## 4. What is deliberately not changed

- No trade-selection change from the calibration study (Brier tie vs market).
- No JEV gate/primary; JEV remains shadow.
- No threshold tuning during the forward sample.

## Next

1. Collect independent-v2 policy candidates (≥30) and resolved markets (≥100).
2. Compare direction, Brier and PnL vs market and vs bot on overlap.
3. If the independent variant does not beat the collaborative one, stop using JEV direction and keep only regime/uncertainty.
4. Only then consider calibrated probabilities in Kelly sizing or a gate.