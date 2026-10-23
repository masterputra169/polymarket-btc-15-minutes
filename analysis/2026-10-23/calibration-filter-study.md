# Calibration and forward-filter study — 2026-10-23

Data: current dry-run journal (833 state trades at review time). Record-only; no entry rule was hardcoded from this study.

## Calibration study

Time-ordered 60/40 split; one probability-shrink weight toward the market:

| Split | Model Brier | Market Brier | Shrunk Brier | Best shrink |
|---|---:|---:|---:|---:|
| Train (499) | 0.2583 | 0.2193 | 0.2183 | 0.15 |
| Test (333) | 0.2561 | 0.2286 | **0.2277** | 0.15 |

- Raw model probability is materially worse than the market (0.2561 vs 0.2286).
- Shrinking 85% toward market improves test Brier to 0.2277 — only narrowly better than market.
- Supports a sizing shrink around **0.15–0.18**, not a new entry threshold.
- Does not prove directional edge; model should not be trusted at full strength.

## Current model forward buckets

Current model: 370 settled trades, 61.4% WR, +$5.02, Brier skill -5.7% vs market.

| Dimension | Bucket | n | WR | Margin | PnL |
|---|---|---:|---:|---:|---:|
| Session | EU/US Overlap | 60 | 73.3% | +10.59pp | +$14.17 |
| Session | US | 104 | 63.5% | +3.32pp | +$6.37 |
| Session | Asia | 124 | 59.7% | -1.01pp | -$2.91 |
| Session | Europe | 53 | 49.1% | -10.35pp | -$12.09 |
| Session | Off-hours | 33 | 57.6% | -2.99pp | -$1.85 |
| Phase | EARLY | 209 | 64.1% | +3.52pp | +$16.06 |
| Phase | MID | 151 | 57.6% | -3.03pp | -$10.41 |
| Phase | LATE | 14 | 57.1% | -5.01pp | -$1.96 |
| Confidence | HIGH | 109 | 64.2% | +2.89pp | +$6.96 |
| Confidence | VERY_HIGH | 265 | 60.0% | -0.40pp | -$3.27 |

### Side-probability buckets

| Bucket | n | WR | Margin | PnL |
|---|---:|---:|---:|---:|
| 0.6–0.7 | 142 | 52.1% | -6.35pp | -$18.55 |
| 0.7–0.8 | 175 | 70.3% | +8.68pp | +$31.65 |
| 0.8–0.9 | 45 | 53.3% | -9.30pp | -$8.40 |
| 0.9+ | 9 | 88.9% | +13.87pp | +$2.47 |

## Recommendations

1. **Applied:** `KELLY_PROB_SHRINK=0.18` on the VPS. Reduces size; entry selection unchanged.
2. **Do not hardcode session filters yet.** Europe and MID are negative, but samples are small; run a paper-only forward test.
3. **Confidence guard should be advisory/shadow first** for the 0.6 and 0.8 buckets.
4. **Champion/challenger remains the right ML upgrade path.** New model must beat market Brier and current rule live.
5. **Keep DRY RUN.** Current model Brier skill is negative.

## Reproduce

~~~bash
cd /opt/polybtc15
sudo -u ubuntu node --env-file=bot/.env bot/scripts/calibrationStudy.mts
node --env-file=bot/.env bot/scripts/dryRunReport.mts --all
~~~
