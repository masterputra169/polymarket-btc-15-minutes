# v19 Tuning Guide

Decision-driven config tuning untuk model v19. Goal: kalibrasi parameter
trade entry berdasarkan observed performance vs shadow expectations.

**Last updated:** 2026-05-14
**Related:** [V19_VALIDATION_PLAN.md](./V19_VALIDATION_PLAN.md)

---

## Tools

| Command | Fungsi |
|---|---|
| `node bot/scripts/v19_performance_report.mjs` | Lihat stats per phase/entry-type/ML-band |
| `node bot/scripts/tune_v19_config.mjs --list` | Lihat preset tuning yang tersedia |
| `node bot/scripts/tune_v19_config.mjs --apply <name>` | Apply preset (safety-gated) |
| `node bot/scripts/tune_v19_config.mjs --rollback` | Restore .env terakhir |

---

## Decision Tree

```
┌─────────────────────────────────────────────┐
│ Run v19_performance_report                  │
└────────────┬────────────────────────────────┘
             │
             ▼
       n < 10?  ─── YES ──► WAIT. Belum cukup data.
             │
            NO
             │
             ▼
        WR ≥ 75%? ── YES ──► ✅ HEALTHY. Keep conservative. No tune.
             │
            NO
             │
             ▼
        WR ≥ 60%? ── YES ──► Try `tier-balanced`. Re-evaluate after +10 trades.
             │
            NO  (WR < 60%)
             │
             ▼
       n ≥ 20? ─── NO ───► WAIT (still possibly noise)
             │
            YES
             │
             ▼
   FOK vs LIMIT split? 
             │
        ┌────┴────┐
        ▼         ▼
  FOK >> LIMIT   LIMIT >> FOK
     │              │
     ▼              ▼
  Try `fok-tight`  Investigate model
                    Consider `rollback`
```

---

## Presets

### `conservative` (default)
- Strict gates: ML conf ≥0.62 untuk LIMIT, 3 indicators agree untuk FOK
- High precision, low volume
- **Use:** Saat baru deploy model atau saat WR healthy (≥75%)

### `tier-balanced`
- Tighter limit-order discount tiers (5/8/12% → 4/7/10%)
- FOK threshold relaxed (3 agree → 2)
- **Use:** WR 60-75% pada n≥10 trades. Borderline performance.
- **Risk:** Trade volume naik ~30%, akurasi mungkin sedikit turun

### `aggressive`
- Lower ML conf threshold (0.62 → 0.55)
- Higher max entry price (0.58 → 0.62)
- FOK 2 agree, edge HC trust alone
- **Use:** WR ≥80% pada n≥30. Capture more medium-conf opportunities.
- **Risk:** Model accuracy must hold di lower-conf bands

### `fok-tight`
- LIMIT effectively disabled (need 99% conf, impossible)
- FOK only with ML ≥80% trust-alone
- **Use:** LIMIT WR consistently underperforms FOK by >10pp
- **Risk:** Volume drops drastis. Pure model trust path.

### `rollback`
- Marker untuk rollback ke v16 (file copy manual diperlukan setelahnya)
- **Use:** WR <55% pada n≥20 OR catastrophic failure
- **Action setelah apply:**
  ```bash
  cp public/ml/backups/v16_pre_v19_*/*.json public/ml/
  pm2 restart polymarket-bot
  ```

---

## Safety Mechanisms

### Backup
Setiap apply preset akan auto-backup `.env` ke `.env.backup-<timestamp>`.
Restore via `--rollback`.

### Guards
- **Sample size**: refuse apply preset (non-conservative) kalau n < 10
- **Healthy WR**: refuse apply kalau WR ≥75% (jangan tune yang sudah jalan)
- **Bypass**: gunakan `--force` flag jika kamu yakin

### Dry-run
Setiap preset bisa di-preview dengan `--dry-run`:
```bash
node bot/scripts/tune_v19_config.mjs --apply tier-balanced --dry-run
```

---

## Tuning Workflow

### Step 1 — Baseline (recommended setiap +6h)
```bash
node bot/scripts/v19_performance_report.mjs
```

Output akan show:
- Overall WR + Wilson 95% CI
- Per-phase comparison vs shadow expectations
- Per-entry-type breakdown (FOK / LIMIT / ARB)
- Per-ML-confidence-band breakdown
- Interpretation hint

### Step 2 — Decide
Apply decision tree di atas. Kalau ragu, **prefer not tuning** (Hippocratic principle).

### Step 3 — Apply (kalau perlu)
```bash
# Preview first
node bot/scripts/tune_v19_config.mjs --apply tier-balanced --dry-run

# Apply
node bot/scripts/tune_v19_config.mjs --apply tier-balanced

# Restart bot
pm2 restart polymarket-bot
```

### Step 4 — Re-evaluate
Wait 24-48h, run report lagi. Compare WR before vs after.

Kalau WR turun >5pp dari baseline:
```bash
node bot/scripts/tune_v19_config.mjs --rollback
pm2 restart polymarket-bot
```

---

## Environment Variables Reference

Variables yang di-controlled tuning script:

| Variable | Default | Range | Effect |
|---|---|---|---|
| `LIMIT_MIN_ML_CONF` | 0.62 | 0.55-0.85 | Min ML conf untuk place limit |
| `LIMIT_MAX_ENTRY_PRICE` | 0.58 | 0.50-0.65 | Max token price untuk limit entry |
| `LIMIT_DISCOUNT_HIGH_PCT` | 0.05 | 0.03-0.10 | Discount tier di ≥85% conf |
| `LIMIT_DISCOUNT_MID_PCT` | 0.08 | 0.05-0.15 | Discount tier di ≥70% conf |
| `FOK_MIN_AGREE` | 3 | 1-4 | Min indicators agree untuk FOK |
| `EDGE_MIN_AGREE_HC` | 0 | 0-3 | Min agree saat ML high-conf |
| `ML_TRUST_ALONE_THRESHOLD` | 0.85 | 0.75-0.95 | ML conf threshold for trust-alone |

---

## Anti-Patterns (JANGAN)

❌ Apply preset tanpa baca report dulu
❌ Apply preset based on 1-2 trades
❌ Apply preset saat WR sudah ≥75% (overfitting noise)
❌ Multiple tunings dalam 24 jam (no signal time)
❌ Tune saat market regime sedang transition
❌ Skip dry-run

---

## Emergency Procedures

### Bot losing money rapidly
1. `pm2 stop polymarket-bot` — immediate halt
2. `node bot/scripts/v19_performance_report.mjs` — diagnose
3. Kalau model issue: apply rollback preset + copy v16 files + restart
4. Kalau config issue: `--rollback` previous .env + restart

### Single bad trade
- Tidak perlu action — outliers terjadi. Wait for n≥5 sebelum react.

### Drift detector firing
- v19 baseline 77.49% auto-loaded. False positive mungkin dari rolling
  window yang mix v16 + v19 trades. Akan converge otomatis setelah 50+ v19 trades.

---

## Future Roadmap

- [ ] Per-session presets (Asia vs US sessions berbeda)
- [ ] Auto-tuning loop berdasarkan rolling 50-trade window
- [ ] A/B test framework (run conservative + tier-balanced parallel di forks)
- [ ] Phase-specific threshold tuning
