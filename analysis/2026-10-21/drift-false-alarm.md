# Concept-drift alert was a false positive — 2026-10-21

## Alert

```text
⚠️ Concept Drift: ML acc=64.52% vs baseline=76.84%
(drop 12.3pp, 31 trades). Gates: CUSUM(score=5.17), conf(drop=32.7pp).
```

## What the data actually says

- The deployed model `20260924-p2-0d88d4` has **243 live ML-labelled trades in the last 21 days** (not 31).
- Live accuracy: **64.2% overall**, **66.0% last 200**, **64.0% last 100**, **64.0% last 50**.
- Live reference window (193 older same-model trades): **64.25%**.
- Recent-50 accuracy: **64.0%**, i.e. **−0.25pp**, not −12.3pp.
- Confidence: recent 43.2% vs live baseline 44.7%, not a 32.7pp collapse.

## Root causes of the false alert

1. **Wrong baseline.** `loadBaseline()` uses the model file's offline test accuracy (76.84%). Live accuracy after entry filters and on the live distribution is structurally lower (~64%). Comparing them guarantees a permanent "drop".
2. **Wrong model-age cutoff.** The detector used the model *file mtime* (2026-10-18 copy) as a deployment boundary, so it saw only 31 trades. The same model ID actually had 243 live trades in 21 days.
3. **Stale confidence baseline.** Confidence was compared with a hardcoded 0.78 (v16-era). The calibrated v2 model has live confidence ~43–45%, so `conf(drop=32.7pp)` was always true.
4. **Misleading alert gates.** `confFire` was included in the alert text even though drift is triggered only by hard-drop/CUSUM. It looked like three gates fired when only CUSUM did.

## Fix deployed

- Detector loads trades by **current model id** from `norm_browser.json` (matches `20260924-p2-0d88d4`), not file mtime.
- Uses a **live same-model reference window** (`DRIFT_BASELINE_WINDOW=200`, default) as baseline; requires at least `DRIFT_MIN_REFERENCE=50` older live trades, otherwise it skips instead of firing on a cold start.
- Window accuracy is compared with that live baseline; CUSUM uses the same baseline.
- Confidence baseline is computed from the live reference; confidence remains **advisory only** and is not listed as a drift trigger.
- Alert includes the live baseline and reference sample size.

## Verification

```json
{"status":"ok","trades":50,"referenceTrades":193,"accuracy":64,
 "baseline":64.25,"baselineSource":"live-same-model","drop":0.25,
 "avgConf":43.19,"baselineConf":44.7,"cusumScore":0,
 "hardFire":false,"cusumFire":false,"confFire":false,"driftDetected":false}
```

- Bot restarted and healthy after the fix.
- `DRIFT_AUTO_RETRAIN=false`; no retrain was triggered.

## Remaining interpretation

- This was **not a market regime shift**. The live model has been flat around 64% for weeks.
- It does say the offline 76.84% baseline is not a useful live expectation. The bot's live edge is thinner than the offline test number suggests; that remains a model/rule evaluation question, not an emergency.