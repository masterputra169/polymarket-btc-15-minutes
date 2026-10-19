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

### Dashboard publik (Cloudflare Quick Tunnel)

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
- Env in `/opt/polybtc15/bot/.env`: `JEV_ENABLED=true`, `JEV_SHADOW=true`, `JEV_MODEL=jev-latest`, `JEV_INTERVAL_MS=0`, `TYPESAFE_API_KEY=` (empty until a key is added).
- Status: bot logs `JEV: enabled but TYPESAFE_API_KEY is not set` and makes no calls. Add a key from https://console.typesafe.ai/keys, then `sudo systemctl restart polybtc15-bot`.
- Verify: `ssh polyvps "cd /opt/polybtc15 && node bot/scripts/jevSmokeTest.mts"` (must print answers; exit 2 = no key).
- Shadow log: `/opt/polybtc15/bot/data/jev_log.jsonl` (one line per market). Score later with `node bot/scripts/jevEvaluate.mts`.
- Active veto only after `JEV_SHADOW=false`; that changes trade selection, so reset `EVAL_WINDOW_START` at the same time.
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
- JEV veto active: `JEV_MODE=veto`, `JEV_SHADOW=false`, `JEV_MIN_CONF=0.60`; `EVAL_WINDOW_START=2026-10-19T05:03:02Z`. Previous window archived: 260 trades, 61.5% WR.
- Railway project `polybtc15` deletion requested (scheduled for 2026-10-21T05:03Z; data exported locally). Permanent dashboard hostname still pending a Cloudflare named tunnel (`cloudflared tunnel login` requires the operator).

