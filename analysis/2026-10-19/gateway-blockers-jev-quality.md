> **Update 13:00 UTC:** after the full 55-call / 38-market real-resolution audit, JEV was switched to shadow + entry-only; the veto recommendation below is superseded. See `jev-real-resolution-audit.md` and `entry-price-jev-shadow-probe.md`.

# Gateway blockers & JEV quality — deep analysis 2026-10-19

## Method

- Filter log window: `journalctl -u polybtc15-bot --since "2026-10-19 05:03:00"` → **113,954** `[Filter] Filtered:` lines. These are poll-level (50 ms), so line counts are not trade counts; “sole” means the poll had exactly one reason; “minutes” is distinct minute buckets.
- JEV: `bot/scripts/jevEvaluate.mts` plus a join of `jev_log.jsonl` with resolved Gamma outcomes.

## 1. What most often blocks a trade

Top exact reasons (normalised numbers):

| Reason | Lines | Sole-blocker lines |
| --- | ---: | ---: |
| Too early: >12 min left (price discovery) | 43,141 | 10,705 |
| Entry price > soft ceiling (ML too low) | 31,486 | 8,896 |
| Entry price > hard cap [dry-run cap] | 24,255 | 12,529 |
| ML confidence < threshold | 15,678 | 2,607 |
| ML confidence < relaxed threshold (edge bypass) | 15,661 | 1,324 |
| Trending + EARLY blocked (>10 min) | 13,104 | — |
| BTC too close to PTB (coin flip) | 10,664 | 561 |
| Market near 50/50 | 10,627 | 216 |
| Trending + low price blocked | 8,610 | 801 |
| LATE-phase ML gate | 8,455 (+3,556 relaxed) | 470 (+331) |
| ML dead zone (75–80% conf, edge too low) | 7,448 | — |
| JEV disagrees with side | 6,859 | 830 |
| Hard cap with ultra-ML / trending premium | 4,977 / 3,893 / 3,139 | 3,820 / 1,594 / 1,140 |
| Edge ceiling | 3,558 | — |

Grouped:

- **Price gates**: soft ceiling 31,486 lines (+8,896 sole), hard-cap variants **36,264** lines (**19,083 sole**) — the largest sole blocker.
- **Too early**: 43,141 lines, 10,705 sole, 144 distinct minutes.
- **ML/confidence gates**: ~53k lines combined (conf, relaxed, dead zone, LATE-phase, trending-low-ML); ~4.2k sole.
- **JEV**: 7,542 lines containing JEV (6,859 with the standard “disagrees” wording), only **830 sole**, 43 distinct minutes.
- **Near 50/50**: 10,627 lines, 216 sole; **BTC distance**: 10,664 lines, 561 sole.

Context from the journal:

- Phase: EARLY 64.5% WR / +4.79 (n=335), MID 66.2% / +17.29 (n=364), LATE 56.0% / −7.98 (n=50). So “too early” is not obviously a bad gate for the 10–12 min band that still enters; late entries are the worse bucket.
- Price bucket: 55–65c is the core (499 trades, 64–66% WR, +26.8 PnL), 68–72c is 76.7% WR / +6.75 (n=60), but 72–75c is 73.6% / −0.32 and ≥75c is only 12 trades. Raising the cap to admit 80–88c is not supported.

**Conclusion:** the dominant blockers are the entry-price cap and the early-time gate, then ML gates. JEV is a secondary blocker. “Loosening the gateway” is not one lever: the price cap protects EV; the early gate is the only high-volume lever worth testing, and the ML gates are already softened.

## 2. JEV quality (hypothesis test)

`jevEvaluate` on 37 resolved markets, 26 with a direction (NO_EDGE 11, coverage 70.3%):

- direction accuracy: **16/26 = 61.5%**
- JEV settle-up Brier: **0.2907** (n=37) vs **market 0.1727** vs **ML 0.1944** — JEV is clearly worse calibrated.
- Calibration: 0–20% bucket n=16, avg 0.07, actual up-rate **44%**; 80–100% bucket n=21, avg 0.90, actual up-rate **71%** — both badly miscalibrated.
- By regime: choppy 40%, mean-reverting 30%, trending-down 55.6%, trending-up 50%.

Confidence breakdown (resolved calls, direction only):

| Threshold | n | Correct | Accuracy |
| --- | ---: | ---: | ---: |
| any opinion | 36 | 22 | 61.1% |
| ≥0.40 | 26 | 18 | 69.2% |
| ≥0.50 | 22 | 15 | 68.2% |
| **≥0.60 (veto threshold)** | **19** | **14** | **73.7%** |
| ≥0.70 | 7 | 3 | 42.9% |

Latest call per market: ≥0.60 → **71.4% (10/14)**. So the direction signal at the veto threshold is plausibly better than a coin flip, but the CI is wide (approx. 54–94% at n=19) and the high-confidence bucket is not reliable. One tape market where JEV blocked a DOWN entry (JEV UP, outcome UP) shows the veto was right, but n=1 is not evidence.

**Verdict on the hypothesis:** _partially, and not yet proven_. Direction at conf ≥0.60 looks promising (73.7%, n=19); settle-probability output is **not good** (Brier 0.291 vs market 0.173; calibration buckets far off) and should not be blended into edge/sizing/gate. Keep JEV in **veto-only** mode for now; do not promote to gate/primary and do not use `settle_above_ptb` as a probability. To test properly, collect ≥100 resolved markets and measure the veto counterfactual (would the blocked trade have won?) via the tape `jd` fields.

## 3. Recommendation

1. **Do not raise the live price cap** — 72c+ is breakeven/negative after fees.
2. **Test the early-time gate** (`MAX_TIME_LEFT_MIN` 12 → 13/14) on the tape/backtest first; it is the biggest quality-uncertain blocker, but the journal’s EARLY 10–12 min bucket is positive, so it is worth a controlled probe.
3. **Do not loosen ML gates further**; they are already relaxed and the model is overconfident (mean 82.9% vs 64.8% realised).
4. **Keep JEV veto** as protection; its direction accuracy at threshold is the only part with signal. Shadow/gate experiments should wait for ≥100 markets. Its settle probability is not usable.
5. The real lever for volume is a separate, explicitly lower-quality **volume strategy**; mixing it into the validated rule makes evaluation uninterpretable.
