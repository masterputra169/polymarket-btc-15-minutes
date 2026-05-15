# v19 Observation-Mode Baseline

**Snapshot:** 2026-05-14 18:19 GMT+7
**Mode:** Hands-off observation for 12-24 hours
**Rationale:** Bot received 7 restarts today during intervention work — need stable runtime to gather honest performance data.

## Baseline State

### Bot
- PID 20640, uptime 42m (latest restart was for TDZ fix)
- Memory 247 MB, CPU stable
- Frontend dashboard: uptime 17h, online

### Bankroll
| Metric | Value |
|---|---|
| bankroll | $42.49 |
| peak | $46.95 |
| startOfDay (stale) | $30.75 |
| consecutiveLosses | 2 |
| all-time trades | 928 |

### v19 Trades Since Deploy
- Deploy time: 2026-05-14 12:46:58 (~5.5h elapsed)
- Trades: **5** (was 4 at +4.89h check, +1 baru terjadi)
- All LIMIT type, 0 FOK
- WR 25% (CI [5-70%] — too noisy)

### Live Models
- xgb: `7deb6215f36a` (v19, confirmed)
- lgb: `e445d4961a4c`

### Config Flags (do not modify)
```
DRY_RUN=false
AUTO_ACTIVATE_DEPOSITS=true
SHADOW_CAPTURE=false
```

## Rules of Observation Mode

### ❌ DO NOT (next 24 hours)
- Restart bot (`pm2 restart polymarket-bot` forbidden)
- Apply config tuning (`tune_v19_config.mjs --apply` forbidden)
- Modify any code in `bot/src/`
- Modify `.env`
- Manually edit `state.json`
- Touch model files in `public/ml/`

### ✅ ALLOWED
- Read trade journal (`v19_performance_report.mjs`)
- Read logs (`pm2 logs --nostream`)
- Inspect on-chain balances (`check_balances.mjs`)
- Update memory/docs
- Diagnose issues by reading (no writes)

### 🚨 EMERGENCY OVERRIDES (only if active loss)
| Trigger | Action |
|---|---|
| Daily PnL < -25% on $46.95 base ($35 threshold) | `pm2 stop` + investigate |
| Bot crash loop (>3 restarts/hr) | `pm2 stop` + investigate |
| Consecutive losses ≥ 5 (n≥5 FOK) | Apply rollback preset |
| Model file corrupted | Restore from v16_pre_v19 backup |

## Next Checkpoints

| Time | Action |
|---|---|
| ~00:47 D+1 (+12h from deploy) | Brief read-only status check |
| ~12:47 D+1 (+24h from deploy) | **Final verdict** — full performance report + decision |

## Expected Behavior (No Intervention)

- **Trade rate:** 1-3 trades/hour at v19 conservative settings
- **FOK trigger:** still rare due to strict gate (3 indicators agree)
- **WR convergence:** with n=10-20 trades by +24h, Wilson CI should tighten to ±15-20pp
- **Drift detector:** will continue flagging until 50 v19 trades resolve (rolling window converges)
- **Bankroll trajectory:** depends on WR; expected range $38-$52 by +24h

## Post-Observation Decision Tree (at +24h)

```
if n >= 10 and WR >= 70%:
    → KEEP v19, observation success
elif n >= 10 and WR 50-70%:
    → Tune (likely `tier-balanced`)
elif n >= 10 and WR < 50%:
    → Rollback to v16
elif n < 5:
    → Extend observation, evaluate gate config (FOK_MIN_AGREE too tight?)
elif n 5-9:
    → Wait 12 more hours, retry
```
