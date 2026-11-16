# Tahap 2 — Pipeline v4 (Chainlink-Native + 1 Hz Market Tape) Study

**Dataset:** 64,963 snapshots across **5,074 resolved BTC 15m markets** (`2026-09-24 07:00Z` → `2026-11-16 11:45Z`).  
**Strict Temporal Split (16-market embargo):** Train `3044` · Val `761` · Test OOS **`1237`** (`2026-11-03 11:00Z` → `2026-11-16 11:45Z`).

## 1. Normal Trading Window (12m → 2m left) vs Final Minute (15s–60s left)

| Model | Normal Acc | Normal AUC | Normal Brier | Normal Skill vs Mid | Final 15–45s Brier | Final 15–45s Skill vs Mid |
|---|---:|---:|---:|---:|---:|---:|
| CLOB L2 Mid (Fresh 1 Hz) | 76.25% | 0.8479 | 0.159 | +0.00% [+0.00, +0.00] | 0.0876 | +0.00% |
| Stoikov L2 Microprice | 76.26% | 0.848 | 0.159 | +0.02% [-0.02, +0.06] | 0.0877 | -0.11% |
| Recalibrated Market | 76.27% | 0.8479 | 0.159 | -0.00% [-0.21, +0.23] | 0.0876 | +0.08% |
| Baseline v2 395d (OOS) | 75.2% | 0.8397 | 0.1656 | -4.12% [-5.89, -2.59] | 0.1277 | -45.76% |
| TWAP Physics Z | 76.27% | 0.8387 | 0.1678 | -5.55% [-7.42, -3.74] | 0.102 | -16.42% |
| Pipeline v4 Standalone (88f) | 76.1% | 0.8449 | 0.1608 | -1.09% [-1.74, -0.47] | 0.0903 | -3.01% |
| Pipeline v4 Hybrid Residual | 75.97% | 0.8468 | 0.1597 | -0.40% [-0.83, -0.01] | 0.0982 | -12.02% |
| Pipeline v4 Calibrated Stack | 76.17% | 0.8478 | 0.159 | +0.03% [-0.25, +0.32] | 0.0874 | +0.26% |

## 2. Simulated Execution on Real CLOB Asks + CLOB V2 Taker Fee (Strict Test OOS)

| Preset | Model / Gate | Trades | Blocked (20f) | WR% | Breakeven% | Margin | PnL ($2/tr) | ROI% | PF | Max DD |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 65c Cap / Edge>=6% / Conf>=45% | v2 (no Gate 20f) | 255 | 58 | 60.39% | 62.38% | -1.99pp | $-16.87 | -3.31% | 0.92 | $36.29 |
| 65c Cap / Edge>=6% / Conf>=45% | v2 + Gate 20f | 218 | 58 | 61.01% | 63.45% | -2.44pp | $-16.84 | -3.86% | 0.9 | $31.53 |
| 65c Cap / Edge>=6% / Conf>=45% | v4 Standalone + 20f | 1 | 0 | 100.0% | 65.61% | +34.39pp | $+1.07 | +53.73% | 99.9 | $0.00 |
| 65c Cap / Edge>=6% / Conf>=45% | v4 Hybrid + 20f | 10 | 7 | 80.0% | 64.03% | +15.97pp | $+5.35 | +26.77% | 2.3 | $2.05 |
| 72c Cap / Edge>=4% / Conf>=45% | v2 (no Gate 20f) | 504 | 65 | 65.28% | 67.2% | -1.92pp | $-28.82 | -2.86% | 0.92 | $48.80 |
| 72c Cap / Edge>=4% / Conf>=45% | v2 + Gate 20f | 477 | 65 | 65.41% | 67.83% | -2.42pp | $-35.06 | -3.68% | 0.9 | $49.96 |
| 72c Cap / Edge>=4% / Conf>=45% | v4 Standalone + 20f | 10 | 0 | 50.0% | 69.03% | -19.03pp | $-5.56 | -27.78% | 0.46 | $7.24 |
| 72c Cap / Edge>=4% / Conf>=45% | v4 Hybrid + 20f | 24 | 10 | 70.83% | 67.96% | +2.87pp | $+2.55 | +5.32% | 1.18 | $5.40 |
| 58c Cap / Edge>=6% / Conf>=45% | v2 (no Gate 20f) | 81 | 42 | 48.15% | 55.89% | -7.74pp | $-21.73 | -13.41% | 0.75 | $23.89 |
| 58c Cap / Edge>=6% / Conf>=45% | v2 + Gate 20f | 42 | 42 | 52.38% | 57.03% | -4.65pp | $-6.30 | -7.50% | 0.85 | $13.34 |
| 58c Cap / Edge>=6% / Conf>=45% | v4 Standalone + 20f | 0 | 0 | —% | —% | — | $+0.00 | +0.00% | — | $0.00 |
| 58c Cap / Edge>=6% / Conf>=45% | v4 Hybrid + 20f | 1 | 7 | 100.0% | 53.75% | +46.25pp | $+1.78 | +88.95% | 99.9 | $0.00 |

## 3. Chainlink-Native Feature Ranks (Pipeline v4 Standalone Gain)

| Rank / 88 | Feature | Gain | Share % | Splits |
|---:|---|---:|---:|---:|
| #1 | `oracle_ptb_dist_pct` | 412.28 | 15.44% | 43 |
| #2 | `twap_physics_z` | 412.18 | 15.44% | 123 |
| #6 | `basis_drift_pct` | 37.56 | 1.41% | 21 |
| #37 | `basis_pct` | 17.81 | 0.67% | 18 |
| #39 | `orderbook_imbalance` | 17.19 | 0.64% | 1 |
| #61 | `cross_feed_lead` | 8.63 | 0.32% | 1 |
| #75 | `spread_pct` | 0.0 | 0.0% | 0 |
