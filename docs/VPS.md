> **Current state (2026-10-21).** Public URL: https://poly15.dollarkilat.xyz/ (named Cloudflare Tunnel, not Quick Tunnel). Auth: custom login page + HttpOnly session cookie; nginx `auth_request` protects `/ws` and report APIs. Secure secrets backup: `polybot-secrets-backup.timer` at 06:35 to `/home/ubuntu/backups/secure/`. Some older sections below describe the former quick tunnel / Basic Auth setup and are kept as history.

# VPS Deployment (Tencent Lighthouse)

Bot Polymarket BTC-15m sekarang berjalan di VPS Tencent Lighthouse, menggantikan Railway.

| Item | Nilai |
|---|---|
| Instance | Lighthouse `lhins-5q6fepk0`, IP publik `43.129.33.237` |
| OS | Ubuntu 26.04 LTS, x86_64, 2 vCPU, RAM 1,9 GiB + swap 2 GiB, disk 39 GB |
| Aplikasi | `/opt/polybtc15` (git clone `main`, HEAD `abc1b56` saat migrasi) |
| User | `ubuntu` (sudo tanpa password); root login password dimatikan |
| Node | v25.9.0 di `/usr/local/bin/node` |
| Service | `polybtc15-bot` (systemd, `Restart=always`, `MemoryMax=1200M`) |
| Frontend | nginx `127.0.0.1:8080` → `/opt/polybtc15/dist`; proxy `/ws` → 3099, `/api/reports` + `/api/health/report` → 3101 |
| Port bot | status WS `127.0.0.1:3099`, report API `127.0.0.1:3101` (dormant tanpa Postgres) |
| Mode | `DRY_RUN=true`, poll 50 ms, TZ `Asia/Jakarta` |
| Data | state.json/journal dipulihkan dari export Railway (bankroll $57.40, 744 trade) |
| Tape | `/opt/polybtc15/bot/data/tape` → Cloudflare R2 `poly15btc` (`TAPE_S3_*`) |
| DB | Tanpa Postgres/Redis. Tanpa `DATABASE_URL` report API dormant; bot tetap jalan penuh |

## SSH

Dari PC ini:

```powershell
ssh polyvps          # alias di ~/.ssh/config -> ubuntu@43.129.33.237, pakai ~/.ssh/id_ed25519
ssh ubuntu@43.129.33.237   # alternatif
```

Login password masih aktif untuk sementara. **Segera ganti password** karena pernah dikirim lewat chat
(Lighthouse console → instance → Reset password), lalu opsional matikan `PasswordAuthentication` setelah
login key (`ssh polyvps`) dipastikan berjalan.

## Kontrol bot

```bash
sudo systemctl status polybtc15-bot
sudo systemctl restart polybtc15-bot
sudo systemctl stop polybtc15-bot
sudo systemctl start polybtc15-bot
journalctl -u polybtc15-bot -f          # log live
journalctl -u polybtc15-bot -n 200 --no-pager
```

## Dashboard (via SSH tunnel, tanpa membuka port ke internet)

```powershell
ssh -L 8080:127.0.0.1:8080 polyvps
```

Lalu buka `http://localhost:8080/?botStatusToken=<STATUS_AUTH_TOKEN>`. Token diambil dari VPS:

```bash
ssh polyvps "grep '^STATUS_AUTH_TOKEN=' /opt/polybtc15/bot/.env"
```

Token disimpan di localStorage dan otomatis dihapus dari address bar. Tanpa tunnel, port 8080 hanya
terikat ke localhost VPS sehingga tidak bisa diakses dari internet.

## Update kode

```bash
ssh polyvps
cd /opt/polybtc15
git pull
npm ci --prefix bot --no-audit --no-fund
sudo systemctl restart polybtc15-bot
```

## Backup

`/etc/cron.daily/polybtc15-backup` menyimpan `bot/data` + `bot/.env` harian ke
`/home/ubuntu/backups/polybtc15-data-YYYY-MM-DD.tar.gz` (retensi 14 hari, mode 600).
Tape di R2 sudah lengkap dan lokal (599+ objek); file lokal di VPS dihapus setelah upload per jam.

**Secure secrets backup (current):** `/opt/polybtc15/scripts/backup-secrets.sh` + `polybot-secrets-backup.timer` (daily 06:35) writes `/home/ubuntu/backups/secure/polybtc15-secrets-YYYY-MM-DD.tar.gz` (0600 root, 30-day retention). It contains `auth.env`, Cloudflare tunnel credentials/cert/config, the nginx site config, and auth/tunnel systemd units. Off-site local copy: `C:\Users\Asus\.poly15\backup\`. Restore drill: extract to a temp dir, compare `auth.env` SHA-256, then restore only the files you need.

## Yang belum ada (opsional)

- Postgres/Redis: tidak dipasang. Konsekuensi: `/api/reports` dan `/api/health/report` dormant → panel
  journal time-series di dashboard tidak terisi; data utama (WS snapshot) tetap jalan.
- Chainlink Data Streams: `CHAINLINK_DS_API_KEY` tidak diset (sama seperti Railway); PTB memakai
  `chainlink_twap` (RTDS) / `polymarket_twap_api` / `polymarket_gamma`.
- TLS/domain dashboard: belum; akses via SSH tunnel. Kalau mau publik, buka 80/443 di Lighthouse
  firewall + Caddy/nginx + token.
- External watchdog: mengandalkan `Restart=always` sistemd + liveness internal bot (exit bila
  tidak ada poll selesai 10 menit). Bisa ditambah systemd timer `botLiveness.mts` bila mau.

## Catatan migrasi

- Sumber data: `data/railway-export/` (volume Railway 9,5 MB + journal 744 trade + eval window).
- Tape historis: `backtest/ml_training/tape/` di PC (600 file, 380,72 MB, 25 hari) — tidak diperlukan runtime.
- Evaluasi window tetap berlanjut: `EVAL_WINDOW_START=2026-09-26T18:08:00Z`, `EVAL_TARGET_TRADES=300`.
- Railway sudah dimatikan untuk bot+frontend; Redis/Postgres Railway masih hidup (matikan/hapus via
  dashboard Railway untuk menghentikan usage, keputusan operator).

## Alert Telegram (verified 2026-10-18)

- Bot Telegram: `@PolyAlertMaster_Bot` (token + chat_id ada di `bot/.env`).
- **Aktif & teruji**: `getMe` OK, pesan uji terkirim ke chat operator (message id 8748), dan jalur notifier
  internal bot (`notify()`) juga teruji (`Notification sent (info)`).
- Yang dikirim melalui Telegram:
  - notifikasi trade entry/settlement (`TELEGRAM_NOTIFY_TRADES=true`)
  - peringatan critical/warn (circuit breaker, daily loss, consecutive losses, win-rate pause, drift/retrain)
  - laporan evaluasi harian window (default `EVAL_REPORT_HOUR_UTC=0` → **07:00 WIB** tiap hari)
- Tombol inline: `View Market` / `View Profile` selalu ada; tombol `View Web` **dihilangkan** selama
  `DASHBOARD_URL=http://localhost:8080` (host tanpa titik dianggap tidak bisa dibuka dari HP;
  warning muncul di log). Set `DASHBOARD_URL` ke domain publik kalau dashboard mau dibuka dari Telegram.
- Rate limit notifier: 1 pesan per level per 60 detik.
- Tes manual dari VPS:

```bash
ssh polyvps
TOKEN=$(grep '^TELEGRAM_BOT_TOKEN=' /opt/polybtc15/bot/.env | cut -d= -f2- | tr -d '"')
CHAT=$(grep '^TELEGRAM_CHAT_ID=' /opt/polybtc15/bot/.env | cut -d= -f2- | tr -d '"')
curl -s "https://api.telegram.org/bot$TOKEN/getMe" | head -c 200
curl -s -X POST "https://api.telegram.org/bot$TOKEN/sendMessage" \
  --data-urlencode "chat_id=$CHAT" --data-urlencode "text=Test alert dari VPS" | head -c 200
```

## Frontend / dashboard (verified 2026-10-18)

- nginx menyajikan build Vite di `127.0.0.1:8080` (index 200, asset JS/CSS 200, tidak ada URL Railway
  yang ter-bake di bundle), proxy `/ws` → 3099 dan `/api/reports`|`/api/health/report` → 3101.
- WebSocket dashboard lewat nginx sudah diuji: koneksi `ws://127.0.0.1:8080/ws?token=...` **OPEN** dan
  snapshot pertama diterima (`{"paused":false,"ts":...}`).
- **Akses dari PC**: buka tunnel `ssh -L 8080:127.0.0.1:8080 polyvps`, lalu
  `http://localhost:8080/?botStatusToken=<STATUS_AUTH_TOKEN>` (token dari `bot/.env`).
- Keterbatasan: tanpa Postgres, `/api/reports` dan `/api/health/report` mengembalikan 502 (report API
  dormant) → panel journal time-series tidak terisi; panel utama (status bot, posisi, harga, ML, tape,
  countdown) tetap jalan lewat WebSocket.
- CSP build ini memblokir Google Fonts (kosmetik, sama seperti konfigurasi Railway). Kalau perlu,
  tambah `fonts.googleapis.com`/`fonts.gstatic.com` ke `style-src`/`font-src`.

## Update final 2026-10-19 00:05 WIB — semua opsi dijalankan

### Dashboard publik (Cloudflare named tunnel)

- URL publik: **https://goto-invitations-suitable-metal.trycloudflare.com** (diverifikasi: index 200, asset 200, WebSocket `wss` OPEN, report API 200).
- Login: buka URL + `?botStatusToken=<STATUS_AUTH_TOKEN>` sekali (token di `bot/.env`); setelah itu browser menyimpannya.
- Service: `cloudflared-quick.service` (systemd, restart otomatis). URL quick tunnel **berubah** setiap cloudflared restart/reboot.
- Sinkronisasi otomatis: `polybot-tunnel-sync.timer` (tiap 5 menit) membaca URL terbaru dari journal cloudflared,
  memperbarui `DASHBOARD_URL` di `bot/.env`, dan me-restart bot hanya bila URL berubah — tombol `View Web` di
  Telegram ikut menyesuaikan.
- URL terkini kapan saja: `ssh polyvps "cat /opt/polybtc15/.tunnel-url"`.
- Batasan: quick tunnel gratis bersifat sementara (domain `*.trycloudflare.com`, bisa berubah). Untuk URL tetap:
  buka port 80/443 di Lighthouse firewall lalu pakai Caddy + domain/sslip.io, atau buat named tunnel Cloudflare
  dengan akun/domain sendiri.

### Postgres lokal + Report API (aktif)

- PostgreSQL **18** terpasang, database `polymarket` (user `polymarket`), URL ada di `/root/postgres-url.txt` (600).
- `DATABASE_URL` sudah ditambahkan ke `bot/.env`. Log startup: `[Runtime] PostgreSQL integration connected`,
  `[ReportAPI] Report API listening on 127.0.0.1:3101 (auth required)`; `/health` 200, `/reports?token=...` 200.
- Tabel sudah terisi: `bot_trade_events` 101, `bot_state_snapshots` 23, `bot_signal_perf_snapshots` 9, dll —
  panel journal time-series dashboard kini punya data.
- Redis tidak dipasang (tidak diperlukan; hanya cache).

### Telegram (aktif, teruji)

- Test alert terkirim; notifier menghasilkan tombol `View Web` setelah `DASHBOARD_URL` diisi URL publik.
- Chat bot: `@PolyAlertMaster_Bot`; laporan evaluasi harian 07:00 WIB.

### SSH password

- Password `ubuntu` **sudah dirotasi** (password lama tidak berlaku lagi).
- Password baru disimpan root-only di `/root/ssh-password-2026-10-18.txt`; ambil dengan:
  `ssh polyvps "sudo cat /root/ssh-password-2026-10-18.txt"`.
- Login utama tetap key (`ssh polyvps`). Root password login dimatikan (`PermitRootLogin prohibit-password`).

### Railway

- Semua deployment sudah dihentikan: bot & frontend REMOVED (18 Okt 14:27Z), **Redis & Postgres deploymentStop**
  (19 Okt 00:04 WIB) — `deploymentStopped: true` untuk semua. Usage komputasi berhenti; volume masih tersimpan
  (biaya storage kecil) sampai project dihapus.
- Invoice $24.58 (10 Sep-10 Okt) masih PAST_DUE — keputusan operator: bayar atau biarkan project ditutup.
- Data Railway sudah diarsipkan lokal: `data/railway-export/` + tape 600 file di `backtest/ml_training/tape/`.

## Fix dashboard 2026-10-19 08:0x WIB — login basic auth, token tidak lagi di URL

**Penyebab spinner "Receiving data ...":** URL yang dibuka masih memakai placeholder token
(`?botStatusToken=%3CTOKEN%3E`), jadi WebSocket ditolak status server (log: `Rejected unauthorized status WS`).

**Perbaikan:**
- nginx sekarang punya **HTTP Basic Auth** (`polybot` / password acak, root-only di `/root/dashboard-login.txt`;
  salinan lokal di `C:\Users\Asus\Dashboard-PolyBTC15.txt`).
- Token status **di-inject oleh nginx** ke `proxy_pass /ws?token=...`; token report di-inject sebagai
  `Authorization: Bearer ...` ke `/api/reports` dan `/api/health/report`. Jadi **URL dashboard tidak perlu
  token lagi** — buka URL publik, browser minta username/password sekali, lalu dashboard jalan.
- `STATUS_AUTH_TOKEN` dirotasi (token lama sudah tidak valid); nginx & bot disinkronkan dan diuji
  (`WS_OPEN`, snapshot diterima, `/api/reports` 200).
- Token placeholder lama yang tersimpan di localStorage browser **tidak masalah** karena query WS ditimpa nginx.

**Cara pakai:**
1. Buka `https://goto-invitations-suitable-metal.trycloudflare.com/` (tanpa query).
2. Login: username `polybot`, password dari `C:\Users\Asus\Dashboard-PolyBTC15.txt`
   (atau `ssh polyvps "sudo cat /root/dashboard-login.txt"`).
3. Jika URL quick tunnel berubah setelah reboot: `ssh polyvps "cat /opt/polybtc15/.tunnel-url"`.

**Ganti password dashboard kapan saja:**
```bash
ssh polyvps
sudo htpasswd -B /etc/nginx/polybot.htpasswd polybot   # masukkan password baru
sudo systemctl reload nginx
```


### OpenRouter route (2026-10-19, live in shadow)

- `JEV_PROVIDER=openrouter`, `JEV_MODEL=typesafe/jev-1.14`, key = `OPENROUTER_API_KEY` (no TypeSafe account needed).
  Endpoint: `POST https://openrouter.ai/api/v1/systemone` (same typed request/answers as TypeSafe direct).
- First live call verified: model `typesafe/jev-1.14-20261014`, 1,549 input tokens, 1,009 ms, **$0.000065**; log line in `/opt/polybtc15/bot/data/jev_log.jsonl`.
- Cost: $0.042 per 1M input tokens (output free) → ~96 calls/day ≈ **$0.006/day (~$0.19/month)**. Top up at https://openrouter.ai/settings/credits if calls start returning 402 (advisor pauses 10 min on 401/402).
- Guard: only called once the PTB is exact (`ptbSource` chainlink/polymarket TWAP) and the window is 0.5–14.4 min in; the first poll can still carry the approximate oracle PTB.
- Shadow mode: `JEV_SHADOW=true`; no trade impact. Score with `node bot/scripts/jevEvaluate.mts` before active veto (`JEV_SHADOW=false`).

## JEV / TypeSafe advisor (deployed 2026-10-19, SHADOW)

- Code: `bot/src/ai/typesafeClient.ts`, `bot/src/ai/jevAdvisor.ts`; hooked in `bot/src/loop.ts` after `decide()`.
- Env in `/opt/polybtc15/bot/.env`: `JEV_ENABLED=true`, `JEV_MODE=shadow`, `JEV_SHADOW=true`, `JEV_CALL_ON=entry`, `JEV_MODEL=typesafe/jev-1.14`, `JEV_INTERVAL_MS=0`.
- Status (2026-10-19 13:00 UTC): `JEV: enabled [SHADOW]` via OpenRouter; calls are made only on ENTER candidates (`JEV_CALL_ON=entry`), never during WAIT. No veto is active.
- Verify: `ssh polyvps "cd /opt/polybtc15 && node bot/scripts/jevSmokeTest.mts"` (must print answers; exit 2 = no key).
- Shadow log: `/opt/polybtc15/bot/data/jev_log.jsonl` (one line per market). Score later with `node bot/scripts/jevEvaluate.mts`.
- Veto/gate/primary are opt-in only: set `JEV_MODE=veto|gate|primary` (or `JEV_SHADOW=false` for veto) and reset `EVAL_WINDOW_START` at the same time. Current mode is **shadow**, so there is no gate impact.
- OpenRouter LLM regime is disabled (`LLM_REGIME_ENABLED=false`) — its key was out of credits; JEV is the LLM layer now.

### JEV full-collaboration controls (2026-10-19)

- `JEV_MODE=shadow|veto|gate|primary` (VPS currently **shadow**). `veto` blocks conflicting entries, `gate` requires agreement, `primary` lets a confident JEV direction override an ENTER side (`JEV_PRIMARY_MIN_CONF=0.70`, `JEV_PRIMARY_FORCE_ENTRY=false`).
- Sizing: `JEV_SIZING_WEIGHT=0.15` — small size boost only when JEV agrees with confidence; shadow mode ignores it.
- Dashboard: `JevPanel` shows mode, model, last direction/settle/regime, calls/errors/latency/cost. The WS snapshot now includes `jev: getJevStatus()`.
- Evaluate all markets (not just traded ones): `ssh polyvps "cd /opt/polybtc15 && node bot/scripts/jevEvaluate.mts"` (Gamma outcomes cached in `bot/data/jev_outcomes.json`).
- External watchdog: `polybot-watchdog.timer` (every 5 min) runs `scripts/watchdog.sh`; `botLiveness.mts` non-zero -> `systemctl restart polybtc15-bot`.
- Switching from shadow to veto/gate/primary changes trade selection: set `EVAL_WINDOW_START` to the switch time so the evaluation report restarts cleanly.

### PolyBolt price feed (P0, deployed 2026-10-19)

- `TWAP_FEED=polybolt` (VPS env): `polyboltWs.ts` connects to `wss://ws-live-v2.polymarket.com/ws`, authenticates with the CLOB L2 credentials (`op:auth`), subscribes `price.crypto.twap` (`{"symbol":"btcusd","window_seconds":60}`) + `price.crypto` (provider chainlink). RTDS remains a shadow fallback until its removal (~2026-10-23); `TWAP_FEED=rtds` is the code-free rollback.
- Read-only probe: `cd /opt/polybtc15/bot && sudo -u ubuntu node --env-file=.env src/streams/polyboltProbe.mts --seconds 20` — expected `TWAP: PASS` and `SPOT: PASS`, `provider=chainlink`.
- Verified after cutover: first market PTB `chainlink_twap, exact, +1.8s after open`; `twapFeed.mode=polybolt`, auth/subscribed ok, 0 seqGaps; `ptb_health` exactPct 100%.

### CLOB V2 (P1, code merged 2026-10-19; not yet deployed to VPS)

- `feat/clob-v2` merged into main (`92e8deb`) on top of JEV + PolyBolt; verified `npm run typecheck` PASS and `npx vitest run` 83 files / 893 tests PASS.
- Go-live still needs manual steps: fund the funder with pUSD, approve CTF Exchange V2 (`pUSD.approve` + `CTF.setApprovalForAll`), then one 5-share live V2 smoke order (`bot/scripts/clobV2SmokeOrder.mts`). See `docs/CLOB_V2_MIGRATION.md`.
- Not deployed to the VPS yet: the VPS bot node_modules would need `npm ci --prefix bot` (new `@polymarket/clob-client-v2` + `viem`); dry-run is unaffected by the code, but the dependency install + startup check should be done in a maintenance window.

### Rollout 2026-10-19

- CLOB V2 merged code deployed: `npm ci --prefix bot` on the VPS installed `@polymarket/clob-client-v2` + `viem`; DRY RUN is unaffected (readiness gate only runs live). Backup: `/opt/polybtc15/backups/pre-clobv2-*.tar.gz`.
- JEV veto was active 05:03–13:00 UTC, then **switched to shadow + entry-only**: `JEV_MODE=shadow`, `JEV_SHADOW=true`, `JEV_CALL_ON=entry`; window reset to `2026-10-19T12:58:17Z`. Previous window archived: 260 trades, 61.5% WR.
- Railway project `polybtc15` deletion requested (scheduled for 2026-10-21T05:03Z; data exported locally). Permanent dashboard hostname still pending a Cloudflare named tunnel (`cloudflared tunnel login` requires the operator).

### CLOB V2 preflight/smoke PASS (2026-10-19)

- `POLYGON_RPC_URL=https://polygon-bor-rpc.publicnode.com` in `bot/.env` (old `polygon-rpc.com` was disabled/401).
- Preflight: L2 auth OK, order version 2, no open orders, pUSD **$25.36**, USDC.e 0, allowance max, `setApprovalForAll` yes.
- Smoke: post-only GTD BUY 5 @ 0.01 placed LIVE and cancelled; open orders 0.
- `FOK_MIN_SHARES_LOW=5`; eval window reset `2026-10-19T11:07:51Z`.
- Before live: sync internal bankroll to ~$25.36 and remember the 5-share minimum makes many Kelly-sized orders too small; optional `--mode fok` test for the reconciler fee.
- Daily data backup: `polybot-backup.timer` (00:15 UTC, 14-day retention, `/opt/polybtc15/backups/data-*.tar.gz`).
- Watchdog now sends a Telegram alert when it restarts the bot (`polybot-watchdog.timer`).

### Alert system (2026-10-19)

- Templates: `bot/src/monitoring/alertTemplates.ts` (entry/startup/feed). Entry alerts include side, price, shares/cost, edge, ML, JEV, phase/time left, regime, flow, bankroll + market button.
- Notifier: header per severity, up to 3 link buttons + Profile + optional Web (`DASHBOARD_URL`; no hardcoded Railway fallback), 3900-char cap, Discord plain text.
- Feed guard: PTB not exact 120 s (+20 s observation), PolyBolt disconnected/stale 60 s, CLOB down 60 s, recovery messages. Called each poll; never throws.
- Startup alert on every boot (disable with `TELEGRAM_NOTIFY_STARTUP=false`).
- Test: `cd /opt/polybtc15/bot && sudo -u ubuntu node --env-file=./.env scripts/alertTest.mts` (sends one real alert, exit 0 = accepted).
- Watchdog alert is HTML and includes the dashboard URL from `/opt/polybtc15/.tunnel-url`.

### Gemini/OpenRouter AI agent disabled (2026-10-19)

- `AI_AGENT_ENABLED=false`; `google/gemini-3-flash-preview` is no longer called. The 4-hourly post-trade analysis was advisory only and never applied (`AI_AUTO_OPTIMIZE=false`, `LLM_REGIME_ENABLED=false`).
- `OPENROUTER_API_KEY` is still required — JEV uses OpenRouter System One (`typesafe/jev-1.14`). Do not remove it.
- Dashboard `analyzeNow` / `optimizeNow` return `ai_disabled`. Re-enable with `AI_AGENT_ENABLED=true`.

### Quant fixes (2026-10-19)

- Early-exit P&L/bankroll now subtract the sell-leg taker fee in dry-run (entry + exit fees); live waits for a real fill to prove `takingAmount` net/gross.
- `SIGNAL_CONFIRM_POLLS` = 9000 / `POLL_INTERVAL_MS` → **180 polls at 50 ms ≈ 9 s** (was 3 polls ≈150 ms). Evaluation window reset: `EVAL_WINDOW_START=2026-10-19T12:04:33Z`.
- JEV decisions must agree with `settle_above_ptb` before veto/gate/primary/sizing act: `JEV_SETTLE_MARGIN=0.05` (UP ≥55%, DOWN ≤45%).
- Verify after deploy: loop shows `Stab:x/180`; no errors; JEV ACTIVE.

### JEV tape fields + Accuracy panel (2026-10-19)

- Tape `d` lines carry `jd` (U/D/N), `jc` confidence, `js` settle-up probability, `jg` regime — same-market JEV decision only, record-only. Verify with `zcat data/tape/<date>/<hour>-*.gz | grep ""jd""`.
- JEV dashboard panel shows **Edge vs mkt** in percentage points.
- Accuracy card: **Trade accuracy — full journal** (from journalAnalytics) + **Prediction sample — rolling (last 24h)** (bot feedback cache, `MAX_AGE_MS=24h`). The small sample is why n=5 and rolling bars can be empty.
- Entry rarity is filters/price caps/JEV, not the 9 s confirmation (`Stab` reaches hundreds). No gateway bottleneck; MetEngine disabled.

### Feedback streak reconciliation (2026-10-19)

- `fallbackVerifier` now calls `reconcilePrediction(slug, verifiedOutcome)` (adapter → shared feedback store) on every verified resolution; journal corrections reach Accuracy/streak automatically.
- One-off backlog: `cd /opt/polybtc15/bot && sudo -u ubuntu node --env-file=./.env scripts/reconcileFeedback.mts` (stop the bot first so it cannot overwrite the file). Reconciled 3 stale predictions.
- Snapshot: accuracy 0.8 (4/5), streak 1L, `Hot (80% of last 5)`. Evaluation window reset to `2026-10-19T12:25:44Z` (feedback feeds sizing).

### Brier/CRPS from journal (2026-10-19)

- Old dashboard CRPS came from browser localStorage; not real. New: `journalAnalytics.patterns.brier/brierN/logLoss/logLossN` computed from every directional journal row (entry `ensembleUp` for the chosen side, `exit.verifiedOutcome` first).
- Snapshot: Brier/CRPS 0.2583 (n=749), logloss 0.7548; market Brier 0.2229, base-rate 0.2282; mean predicted 82.9% vs realised 64.8% → calibration, not display, is the issue.
- Accuracy panel header/journal section shows `Brier/CRPS` and `logloss`; binary CRPS = Brier.
- Gate audit: 20 numbered gates; binding blocker is the price cap (dry-run 75c / live 68c), not the 9 s confirmation. Indicators: 10 TA modules, 79 ML features.

### Gateway blockers & JEV quality (2026-10-19)

- Filter log 05:03–12:45: 113,954 filtered lines. Largest sole blockers: entry-price hard cap 19,083; "Too early >12min" 10,705; ML conf 4,231; JEV 830. Price cap protects EV; early-time gate is the only high-volume lever worth a tape/backtest probe.
- JEV: direction 16/26 (61.5%); settle-up Brier **0.2907** vs market 0.1727; conf≥0.60 direction 14/19 (73.7%, CI wide), conf≥0.70 3/7. The later full 55-call audit (57.9%, no-side 41.2%) led to **shadow mode**; do not use JEV settle probability for gate/primary/edge/sizing.
- Report: `analysis/2026-10-19/gateway-blockers-jev-quality.md`.

### JEV real-resolution audit (2026-10-19)

- Fresh Gamma resolutions for all 55 calls / 38 markets: 52 calls / 36 markets resolved. Direction 22/38 = 57.9% (NO_EDGE 14/52); conf≥0.60 14/20 = 70%; conf≥0.70 4/8 = 50%.
- All 21 calls with `rules.side` agreed with it (71.4%); calls without a rule side 7/17 = 41.2% — JEV mostly echoes the bot rules. Settle Brier 0.3017 vs market 0.1686; calibration buckets badly off (0–20% → actual 40%; 80–100% → actual 66.7%).
- Keep JEV out of gate/primary/sizing; shadow mode is the safer default; veto counterfactual still needs tape. Full CSV: `analysis/2026-10-19/jev-call-eval.csv`; report: `analysis/2026-10-19/jev-real-resolution-audit.md`.

### Entry price / JEV shadow / early-time probe (2026-10-19)

- Do **not** lower the 50c entry floor: <50c journal WR 23.5% (−20.24), 50–55c 55.7% (+0.58); the 0.08 edge bypass is the only sub-50 path.
- JEV is shadow now (`JEV_MODE=shadow`, `JEV_SHADOW=true`) and called only on ENTER candidates (`JEV_CALL_ON=entry`), not at market open. The JEV veto was the gate removed; price cap/ML/floor unchanged.
- Dry-run-only probe: `FILTER_DRY_RUN_MAX_TIME_LEFT=13` (live stays 12). Window reset `EVAL_WINDOW_START=2026-10-19T12:58:17Z`. Revert = remove the variable.
- Startup verified: `JEV: enabled [SHADOW]`, override `FILTER_DRY_RUN_MAX_TIME_LEFT=13`, JEV log stayed at 55 (no WAIT calls). 86 files / 917 tests PASS.

### JEV final-fill refresh (2026-10-19 14:56 UTC)

- `loop.ts` calls JEV on the ENTER candidate, then force-refreshes once after the actual fill (`entryRefresh: true`, final `side`). Forced calls bypass the once-per-market guard but respect in-flight/pause/PTB checks; in-flight candidates queue the forced snapshot.
- Journal entries now carry `jevDirection`, `jevConfidence`, `jevSettleUp`, `jevRegime`, `jevCallTs`, `jevConflict` at the actual fill.
- Deployed and service active; 86 files / 917 tests PASS. No new trade yet after deploy, so the next entry should be the first row with the new fields and an `entryRefresh` JEV log row.

### GitHub patterns applied (2026-10-19)

- Adopted policy-in-code/JEV-judgment, shadow gate policy, benchmark-first, final-fill journaling. Rejected live-threshold copying, news layer, maker entry and SDK migration for now.
- `jevEvaluate.mts` now prints a JEV-only shadow policy simulation. 47 resolved markets: direction 61.1%; settle Brier 0.2825 vs market 0.1819. conf>0.60: 17 trades, WR 70.6%, ROI +14.3%; conf>0.70: 7 trades, WR 57.1%, ROI −5.6%; >0.80/0.90 no trades.
- Treat as hypothesis: n=17 and threshold-sensitive. Next: fixed-policy (conf>0.60, ask≤0.70, edge≥0.10) forward shadow for ≥100 markets; do not enable live gate yet.

### JEV fixed-policy forward shadow (2026-10-19)

- `JEV_CALL_ON=policy`; one JEV call per market at first eligible poll. Fixed gates: conf > 0.60, ask ≤ 0.70, pSide − ask ≥ 0.10, one candidate/market. No orders.
- Candidates: `data/jev_policy.jsonl`; report: `sudo -u ubuntu node --env-file=./.env scripts/jevPolicyReport.mts` → `data/jev_policy_report.json` (progress to 100 resolved markets, Brier, WR, PnL, bot overlap).
- Env: `JEV_POLICY_SHADOW=true`, `JEV_POLICY_MIN_CONF=0.60`, `JEV_POLICY_MAX_ASK=0.70`, `JEV_POLICY_MIN_EDGE=0.10`.
- 22:15 WIB call was 53% confidence, so no candidate yet; next eligible market will sample. 87 files / 922 tests PASS.

### JEV independent v2 + calibration study (2026-10-19)

- VPS: `JEV_INDEPENDENT_STATE=true`, `JEV_CALL_ON=policy`, `JEV_POLICY_SHADOW=true`. JEV state omits bot `algo_view`; log rows carry `stateVariant=independent_v2`.
- First independent call 22:30 WIB: DOWN 33% → no policy candidate (correct).
- `calibrationStudy.mts`: 753 rows, time split 60/40. Test Brier model 0.2638 / market 0.2321 / shrunk(w=0.15) 0.2318; model mean p 78.2% vs realised 61.3%. Calibration is needed but the OOS gain vs market is a tie; no selection change.
- 87 files / 924 tests PASS. Report: `analysis/2026-10-19/jev-independent-v2-calibration-study.md`.

### Entry-time JEV decision shadow (2026-10-19)

- `JEV_DECISION_SHADOW=true`: one record-only JEV call at the first `ENTER` candidate per market, separate `data/jev_decision.jsonl`; no veto/sizing/execution effect.
- Policy sample is restricted to market open (`JEV_POLICY_MIN_TIME_LEFT=13.5`); mid-window restarts no longer add biased sample calls.
- First decision 22:45:37 WIB: bot ENTER DOWN, JEV DOWN 37%, sample DOWN 37%, no candidate. Outcome pending.
- Report: `sudo -u ubuntu node --env-file=./.env scripts/jevDecisionReport.mts` → `data/jev_decision_report.json`.
- Reports now require a closed Gamma market with 1/0 prices; an open 0.5/0.5 placeholder is never resolved. 87 files / 924 tests PASS.

#### Dashboard v4 widget workspace (2026-10-19)

- New draggable/resizable widget dashboard: 16 panels, edit mode, widget library, presets, accent themes, density, localStorage persistence and layout export/import.
- Frontend-only change; bot/JEV/trading untouched. `npm run build` output deployed to `/opt/polybtc15/dist` behind the existing nginx Basic Auth + tunnel.
- Verification: 88 files / 929 tests PASS; browser checks drag/resize/persistence/preset/theme; 390px mobile no horizontal overflow.
- Report + preview: `analysis/2026-10-19/dashboard-v4-redesign.md`.

### Dashboard auth sync + reconnect (2026-10-20)

- nginx injects `STATUS_AUTH_TOKEN` into `/ws` and the report bearer token into `/api/reports`; both are synced from `bot/.env` by `scripts/nginx-token-sync.sh`.
- systemd: `polybot-dashboard-auth-sync.service` (oneshot) + `.timer` every 2 minutes. It reloads nginx only when the config changes.
- `/ws` stays behind nginx HTTP Basic Auth; the browser sends cached Basic credentials on the WS handshake.
- Frontend reconnect never stops; it retries at the 30s ceiling and shows a **Reconnect now** button in the disconnected banner.
- If the dashboard is empty but the page opens: check `/ws` for 401 first, then run `systemctl start polybot-dashboard-auth-sync.service`.
- Quick-tunnel URL can change when cloudflared restarts; a stable hostname needs a named tunnel (`cloudflared tunnel login`).

### Liveness heartbeat fix (2026-10-20)

- `ptb_health.jsonl` used to be written only after `applyTradeFilters`, so a long signal-confirmation hold looked like a blind bot and `polybot-watchdog` restarted it every few minutes.
- `recordPollHeartbeat()` now runs after every completed poll that has a Polymarket snapshot; it advances the watchdog's `to` timestamp without counting as a filter evaluation.
- Verified: heartbeat line every ~60s (`heartbeat=569, total=0`), `botLiveness` fresh, no watchdog restart.

### Public domain cutover (2026-10-20)

- URL: https://poly15.dollarkilat.xyz/ (Cloudflare named tunnel `polybtc15`, service `cloudflared-named.service`).
- Quick Tunnel `cloudflared-quick` is disabled; `polybot-tunnel-sync.timer` is disabled so the old URL cannot overwrite `DASHBOARD_URL`.
- Origin: nginx `127.0.0.1:8080`, Basic Auth. To roll back, re-enable `cloudflared-quick` and run `sync-tunnel-url.sh` manually; do not leave both timers enabled.
- Cloudflare certificate/credentials live under `/home/ubuntu/.cloudflared/` (never commit).

### Dashboard login gate (2026-10-20)

- URL: https://poly15.dollarkilat.xyz/
- Custom Motion login page; auth gateway `polybot-dashboard-auth.service` on `127.0.0.1:3102`.
- Password hash + session secret: `/opt/polybtc15/auth.env` (0600; never commit).
- nginx `/auth/` proxies login/me/logout; internal `/_dashboard_auth` is used by `auth_request` on `/ws` and report APIs.
- Session cookie: HttpOnly, Secure, SameSite=Lax, 12h; topbar sign-out.
- Basic Auth prompt was removed; static bundle is public, market data/control is not.
- To reset the password: regenerate `DASHBOARD_PASSWORD_HASH` and restart `polybot-dashboard-auth.service`.
