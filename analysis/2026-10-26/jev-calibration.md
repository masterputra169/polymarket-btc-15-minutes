# JEV settle calibration — 2026-10-26

## Problem

JEV raw `settle_above_ptb` output was sharply miscalibrated on the shadow log:
- 0–20% predicted bucket: actual up-rate 38%
- 80–100% predicted bucket: actual up-rate 59%
- raw Brier 0.3331 vs market 0.2279 and ML 0.2317

## Fix

Added a time-split, monotone (PAVA) calibration map:
- fit on first 70% of markets by timestamp (431)
- evaluated on last 30% (186)
- raw test Brier 0.3451 → calibrated 0.2437

The map is coarse and versioned (`2026-10-26-pava-70`). It is used for diagnostics and the shadow decision record; it does **not** activate JEV.

## Still true

Calibrated Brier 0.2437 is still worse than the market 0.2279 and ML 0.2317. Calibration fixes overconfidence, not the absence of incremental edge. JEV remains shadow.

## Direction

Direction accuracy was 210/351 = 59.8% (Wilson 95% CI 54.6–64.8), but the existing rule side was 214/349 = 61.3%. No incremental directional evidence yet.

## Next

- Keep `JEV_MODE=shadow`.
- Collect 100+ policy entries before reconsidering a gate.
- Re-fit calibration only on historical data and validate on a future slice.
