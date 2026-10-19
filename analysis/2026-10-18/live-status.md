# Live Status Bot PolyBTC15 - 2026-10-18

Audit read-only (tanpa restart/redeploy/ubah konfigurasi) oleh anggota tim `live-status` (Tugas A).
Sumber utama: Railway GraphQL v2 (accessToken dari `C:\Users\Asus\.railway\config.json`, tidak pernah dicetak), Railway CLI 4.40.2, log deployment, dan listing S3 read-only (SigV4) ke bucket tape. Nilai secret tidak dicetak di laporan ini (hanya nama variabel).

## 1. Ringkasan eksekutif

- **Bot DOWN.** Container terakhir (deployment `3ae0876e-01c9-4881-9995-fa1ca1abac1a`) menerima **SIGTERM pada 2026-10-18 14:27:22 UTC** dan deployment berstatus **REMOVED pada 14:27:23 UTC**. Saat audit (15:11 UTC) tidak ada deployment aktif: `activeDeployments: []`, `deploymentStopped: true`.
- **Tidak ada deploy attempt baru** setelah 2026-09-29 07:58 UTC (19 hari). Tidak ada perubahan variabel sejak 2026-09-26. Jadi berhentinya **bukan** akibat deploy/rollout.
- **Bukan crash.** Log berhenti normal (loop terakhir sehat, #15633490, 78 ms), lalu SIGTERM -> graceful shutdown -> "State saved. Goodbye." -> "Stopping Container". Tidak ada OOM, restart-loop, atau error sebelum stop.
- **Penyebab paling mungkin: berhentinya platform karena billing/usage.** Workspace plan **HOBBY**, subscription state **PAST_DUE** (pembayaran gagal), pemakaian periode berjalan **$4,9916 dari kredit $5,00 (99,83%)**, `creditBalance: $0`. Deployment **frontend juga dihapus 9 detik sebelumnya** (14:27:14 UTC), sementara **Redis & Postgres tetap SUCCESS dan hidup** - pola "stop semua service aplikasi".
- **Data evaluasi selamat** (volume `bot-volume` 677,9 MB utuh, tape S3 lengkap). Angka window terakhir (laporan 2026-10-18 00:00 UTC): **252/300 trade (84%), WR 61,9% (Wilson 95% 56-68%), breakeven 60,5% -> +1,4 pp, PnL +$7,41, avg entry 58,8c, verdict `inconclusive`**.
- Resume aman: **perbaiki billing dulu**, lalu `railway up --service bot --ci` dari checkout ini (HEAD `abc1b56`, working tree bersih) - image identik dengan deployment terakhir, window evaluasi **tidak** restart (lihat bagian 6). Perintah tidak dieksekusi.

## 2. Status live - bukti

### 2.1 Deployment terakhir (GraphQL `deployments(first:60)`, 31 deployment bot)

| Deployment | Dibuat | Status | Berubah | Keterangan |
|---|---|---|---|---|
| `3ae0876e` | 2026-09-29T07:58:04Z | SUCCESS -> **REMOVED** | **2026-10-18T14:27:23Z** | commit `abc1b56`, builder DOCKERFILE `Dockerfile.bot`, imageDigest `sha256:e7c4169...`, mount `/app/bot/data`, region asia-southeast1, `source: CLI`; uptime 19,27 hari |
| `de5e4a8b` | 2026-09-26T17:59:53Z | REMOVED | 2026-09-29T07:58:52Z | digantikan `3ae0876e` |
| `b15f7d86` | 2026-09-26T16:43:57Z | REMOVED | 2026-09-26T18:00:20Z | |
| `cdddb941` | 2026-09-24T06:42:43Z | **FAILED** | 2026-09-24T06:42:58Z | error "Failed to create code snapshot"; `canRedeploy: false` |

- **Tidak ada deployment dibuat setelah 2026-09-29 07:58 UTC.** 30 dari 31 deployment berstatus REMOVED, satu FAILED (2026-09-24).
- **Klarifikasi "latestDeployment FAILED cdddb941"**: itu **artefak API, bukan penyebab**. Railway tidak menghitung deployment REMOVED dalam `latestDeployment`/`activeDeployments`, jadi yang tampil adalah deployment gagal terakhir (2026-09-24). Setelah kegagalan itu service **tetap** bisa deploy 5x lagi (e28cf3d9 06:58Z, ce6c7671 07:24Z, b15f7d86, de5e4a8b, 3ae0876e 2026-09-29). Konsekuensi praktis: `railway redeploy` akan menargetkan cdddb941 (FAILED) dan gagal - lihat bagian 5 opsi B.
- Service lain saat audit: **frontend** `48ac5a99` REMOVED (14:27:14Z); **Redis** `222bbd0c` dan **Postgres** `ecbf428d` **SUCCESS**, `deploymentStopped=false` (masih hidup).
- Volume: `railway volume list --json` -> `bot-volume` `04458665-...` mount `/app/bot/data`, **677,9 MB / 5000 MB** (data tetap ada).

### 2.2 Log shutdown (GraphQL `deploymentLogs(deploymentId: 3ae0876e...)`)

```
2026-10-18T14:27:22.095Z [Loop] #15633490 [78ms] | BTC $81377 | PTB $81173 | P:93% E:5.6% ML:97%/95% | WAIT ... | T:2.6m | $57 | choppy | WS+WS+CL:PolyWS
2026-10-18T14:27:22.139Z SIGTERM received - shutting down gracefully...
2026-10-18T14:27:22.144Z [Bot]   Session Summary
2026-10-18T14:27:22.144Z [Bot] Bankroll: $57.40
2026-10-18T14:27:22.144Z [Bot] Daily P&L: $-3.91 (-6.4%)
2026-10-18T14:27:22.144Z [Bot] Trades: 744 (481W/263L = 65%)
2026-10-18T14:27:22.144Z [Bot] State saved. Goodbye.
2026-10-18T14:27:23.484Z Stopping Container
```

Tidak ada baris error/OOM/crash sebelum SIGTERM. Kesimpulan: sinyal datang dari luar container (platform), bukan kegagalan aplikasi.

### 2.3 Mengapa berhenti - bukti billing/usage (GraphQL `workspace`/`customer`)

| Fakta | Nilai |
|---|---|
| Plan workspace | **HOBBY** |
| Subscription state | **PAST_DUE** (bukan ACTIVE/CANCELLED) |
| Pemakaian periode berjalan | **$4,991631** dari kredit $5,00 -> **99,83%** (sisa $0,0084) |
| `creditBalance` / `remainingUsageCreditBalance` | $0 / 1 (unit internal) |
| Periode billing | 2026-10-10T07:15:32Z -> 2026-11-10T07:15:32Z |
| Laju pemakaian | +/- $0,60/hari (seluruh workspace: bot + frontend + 2 DB + volume) |
| Sisa sebelum stop | $0,0084 -> habis dalam hitungan jam |

Timeline yang konsisten: kredit usage HOBBY habis tepat **2026-10-18 14:27 UTC**; karena payment method gagal (PAST_DUE) tidak ada overage yang bisa ditagih -> Railway menghentikan deployment service aplikasi (bot + frontend), database dibiarkan hidup.

**Bukti pendukung / yang perlu dicatat:**
- Audit log workspace (retensi 2 hari per plan limit) hanya memuat **2 event `ContainerAccess.tunnel` ke Postgres pada 14:27:26Z**; **tidak ada event penghapusan deployment dengan aktor**.
- `activeDeployments` bot kosong, tapi **Redis/Postgres masih SUCCESS** (konsisten dengan stop service aplikasi, bukan stop total akun).
- **Tidak bisa dikesampingkan 100%**: penghapusan manual dari dashboard/CLI (`railway down`) - dua deployment aplikasi dihapus 9 detik berurutan, lalu ada akses tunnel Postgres 3 detik setelahnya. Tidak ditemukan jejak CLI lokal pada jam itu (PSReadLine history terakhir 00:20 hari ini; prefetch Windows tidak tersedia), tetapi aksi dari browser/agen lain tidak bisa dibuktikan dari sini.
- **Tindakan verifikasi untuk operator**: buka dashboard Railway project `polybtc15` - cek banner "Past due"/"Usage limit", email Railway, dan Payment method. Ini akan memastikan mana dari dua hipotesis di atas.

## 3. Data evaluasi (window `EVAL_WINDOW_START=2026-09-26T18:08:00Z`, target 300 trade)

### 3.1 Laporan evaluasi harian (rekonstruksi dari log notifier 00:00 UTC; model `20260924-p2-0d88d4`)

| Tanggal (00:00Z) | Hari | Trade | WR | Wilson 95% | Breakeven | Margin | PnL | Avg entry | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| 2026-10-12 | 15,2 | 195 (65%) | 62,1% | 55-69% | 60,7% | +1,3 pp | +$6,57 | 59,1c | inconclusive |
| 2026-10-13 | 16,2 | 201 (67%) | 61,2% | 54-68% | 60,7% | +0,5 pp | +$3,47 | 59,0c | inconclusive |
| 2026-10-14 | 17,2 | 218 (73%) | 60,6% | 54-67% | 60,5% | +0,1 pp | +$0,64 | 58,8c | inconclusive |
| 2026-10-15 | 18,2 | 224 (75%) | 61,2% | 55-67% | 60,5% | +0,7 pp | +$3,31 | 58,8c | inconclusive |
| 2026-10-16 | 19,2 | 231 (77%) | 61,0% | 55-67% | 60,5% | +0,5 pp | +$2,62 | 58,9c | inconclusive |
| 2026-10-17 | 20,2 | 237 (79%) | 61,2% | 55-67% | 60,5% | +0,7 pp | +$3,46 | 58,8c | inconclusive |
| **2026-10-18** | **21,2** | **252 (84%)** | **61,9%** | **56-68%** | **60,5%** | **+1,4 pp** | **+$7,41** | **58,8c** | **inconclusive** |

Breakeven cocok dengan rumus fee taker CLOB V2: `p + 0,07*p*(1-p)` -> pada avg entry 58,8c sekitar 60,5%.

### 3.2 Rekonstruksi 14,4 jam terakhir (2026-10-18 00:00 -> 14:27Z)

Dari 62 baris `[Position] Position settled` di log (semua settlement yang tercatat 10-12 -> 10-18):

- 10-18 00:00-06:00Z: **5 settlement, 1W/4L, PnL -$3,91** (sama dengan "Daily P&L -$3.91" saat shutdown).
- **Perkiraan posisi window saat bot berhenti: n sekitar 257, 157W/100L, WR 61,1%, Wilson 95% sekitar 55,0-66,8%, PnL sekitar +$3,50, margin sekitar +0,6 pp di atas BE 60,5%, PnL/trade +$0,014.**
- Validasi silang: perubahan PnL antar-laporan harian **persis** sama dengan jumlah PnL settlement hari sebelumnya (delta: -3,10; -2,83; +2,67; -0,69; +0,84; +3,95) -> rekonstruksi konsisten. Bankroll: $60,47 (10-12 sekitar 00:45, sebelum settlement pertama) -> **$57,40** saat stop = -$3,07 = total PnL settlement 10-12..10-18 (-3,07). **Tidak ada koreksi bankroll** di periode itu.

### 3.3 Performa per segmen (laporan 2026-10-18 00:00 UTC)

| Segmen | Trade | WR | vs BE | PnL |
|---|---|---|---|---|
| US | 71 | 70,4% | +10,3 pp | +$14,65 |
| EU/US Overlap | 35 | 77,1% | +14,9 pp | +$11,48 |
| Asia | 82 | 58,5% | -2,2 pp | -$3,76 |
| Europe | 37 | 45,9% | -13,1 pp | -$10,33 |
| Off-hours | 27 | 51,9% | -8,8 pp | -$4,63 |
| **Total** | **252** | **61,9%** | **+1,4 pp** | **+$7,41** |

**Forward test softening 2026-09-26**: "Old rule would take" 68 trade, WR 64,7% (+0,8 pp), +$1,55; "Added by softening" 184 trade, WR 60,9% (+1,6 pp), +$5,86. Tambahan volume dari softening masih positif tapi margin tipis.

**Tren 6,5 hari terakhir (10-12 -> 18)**: 62 settlement, **36W/26L = 58,1%** (Wilson 45,7-69,5%), **PnL -$3,07** - di bawah breakeven 60,5%. Window sempat +$6,57 (10-12) dan +$7,41 (10-18 00:00), lalu turun ke sekitar +$3,50 saat stop karena 10-18 sendiri -$3,91. Ini sinyal pelemahan jangka pendek (n kecil, belum signifikan), bukan bukti edge hilang.

### 3.4 Status verifikasi settlement

- **62/62 settlement tercatat sebagai `price_fallback`** (`Position expired ... (price_fallback)`) - provisional by design: market switch membatalkan retry oracle saat expiry, verifier menyusul. **Tidak ada** baris "oracle" di 7 hari log.
- Tidak ditemukan log verifikasi ulang (kata kunci `verified`, `Verifier`, `provisional`, `unverified`, `corrected` = 0 baris dalam 7 hari). Status verified/corrected final harus diambil dari `npm run report:dryrun:railway` setelah container hidup (laporan itu mencetak split settlement source).

### 3.5 PTB health (verifikasi vs Gamma)

`[PtbVerify]` 10-12 -> 10-18: **634 market diperiksa, 623 exact (98,3%), 0 mismatch**, 10 tanpa hasil (unknown). Per hari: 93-96 exact dari 96 market. PTB exact `chainlink_twap` sehat sampai detik terakhir.

### 3.6 RTDS / TWAP

- Socket TWAP `crypto_prices_twap_sixty` hidup sampai 14:27Z: 17 "replay requested" dalam 6,5 hari (+/- 2,6/hari - normal, sekitar 3% detik hilang), **0 stall/putus/error**, 0 warning deprecation di log.
- Catatan: topik harga RTDS deprecated sekitar 2026-10-23 (5 hari lagi); sebelum itu fallback API TWAP masih memberi PTB exact (lebih lambat beberapa detik). Detail migrasi PolyBolt ada di laporan roadmap.

### 3.7 Tape / S3 (upload 19 hari)

- Bucket `poly15btc`, prefix `btc15/tape/`: **599 objek, +/- 363 MB**, rentang **2026-09-24 -> 2026-10-18 14:00Z**.
- **Setiap hari penuh 24/24 jam** dari 2026-09-25 s/d 2026-10-17; 2026-09-24 = 18/24 (mulai), 2026-10-18 = 14/24 (berhenti 14:27Z). **19 hari terakhir (09-30 -> 10-18) lengkap.**
- Upload terakhir 2026-10-18T14:00:01Z (jam 13Z, 0,6 MB); **0 kegagalan upload** ("Tape upload failed"/"upload failed" = 0 baris).
- Artinya data tape siap untuk studi maker-fill/adverse-selection; tidak ada tape yang tertinggal di volume (677,9 MB volume = state/journal/ptb_health + jam berjalan).

### 3.8 Angka lain

- Bankroll saat stop **$57,40**; daily P&L 10-18 **-$3,91 (-6,4%)**; counter lifetime **744 trade (481W/263L = 65%)** - ini counter seumur state, **bukan** angka window (snapshot lokal 09-24: 458 trade 307W/151L -> +286 trade dalam 24 hari sekitar 11,9/hari, konsisten dengan laju window).
- Laju window: **252 trade / 21,24 hari = 11,9 trade/hari**. Progres 84% dari target 300.

## 4. Batasan data (yang tidak bisa dibaca tanpa restart)

1. **Retensi log 7 hari** (plan limit `observability.logRetentionDays: 7`) -> laporan harian sebelum 10-12 hilang; 10-10/10-11 = 0 baris.
2. **Volume tidak bisa dibrowse tanpa container hidup**: `railway ssh` butuh deployment aktif; `railway volume` hanya metadata; backup volume Hobby `maxBackupsCount: 0`. Jadi `trade_journal.jsonl`/`state.json`/`ptb_health.jsonl` final **tidak** bisa diunduh sekarang (tidak ada restart, sesuai aturan).
3. **Teks penuh laporan evaluasi hanya dikirim ke Telegram**; log hanya 1 baris. Tabel 3.1 direkonstruksi dari baris notifier yang dipecah per baris oleh pipeline log - divalidasi silang dengan PnL settlement (3.2), jadi angka utama dapat dipercaya.
4. Angka window **otoritatif** (termasuk verified/corrected dan split settlement source) didapat dengan `npm run report:dryrun:railway` **setelah** bot hidup.

## 5. Opsi resume - rekomendasi, **JANGAN dieksekusi** (belum dijalankan)

**Prasyarat wajib (billing)** - tanpa ini bot akan berhenti lagi dalam hitungan jam:
- Perbaiki payment method / selesaikan PAST_DUE, atau upgrade **PRO** ($20/bulan termasuk $20 usage), atau tambah kredit.
- Kebutuhan: sisa kredit sekarang **$0,008**; untuk menyelesaikan 43 trade (sekitar 3,6 hari) butuh +/- **$1,3** (bot sekitar 60% dari burn workspace).
- Cek dashboard project `polybtc15` untuk banner "Past due"/"Usage limit" + email Railway - sekaligus memastikan apakah stop ini platform-side atau manual.

### Opsi A - REKOMENDASI: redeploy image yang sama via CLI
```powershell
# dari A:\PolyBot BTC15\PolyBTC15 (HEAD abc1b56, working tree bersih selain analysis/ + artefak untracked)
railway up --service bot --ci
# opsional, dashboard: railway up --service frontend --ci
```
- **Pro**: build dari commit yang sama dengan `3ae0876e` (Dockerfile.bot, `RAILWAY_DOCKERFILE_PATH`), image identik, volume `/app/bot/data` re-attach -> `state.json`+`trade_journal.jsonl` restored. **Tidak mengubah trade selection** -> window evaluasi lanjut tanpa reset.
- **Kontra/risiko**: rebuild sekitar 1 menit + biaya build; kalau billing belum beres akan di-stop lagi; pastikan tidak ada perubahan env/filter sebelum deploy.
- **Verifikasi setelah deploy**: `railway logs --service bot` cari `Mode: DRY_RUN`, `Liveness`, `[Loop] #`; lalu `npm run report:dryrun:railway`.

### Opsi B - fallback cepat, kemungkinan gagal
```powershell
railway redeploy --service bot --yes
```
- Menargetkan "latest deployment" = `cdddb941` **FAILED** dengan `canRedeploy: false` -> kemungkinan error. CLI 4.40.2 tidak punya flag `--deployment`; `3ae0876e` sudah REMOVED sehingga tidak otomatis jadi target. **Jangan diandalkan.**

### Opsi C - dashboard "Deploy"
- Service `bot` **tidak punya source Git** (`source.repo: null`; semua deployment `source: CLI`), jadi tombol Deploy dashboard tidak menyediakan build dari repo. Tidak direkomendasikan sebagai jalur utama.

### Opsi D - GitHub `main`
- Sama: service bot tidak terhubung GitHub. Menyambungkan repo akan mengubah mekanisme deploy (auto-deploy setiap push) -> risiko besar terhadap window/selection. Hindari untuk sekarang.

### Aturan saat resume
- **Jangan ubah `EVAL_WINDOW_START`** (tetap `2026-09-26T18:08:00Z`) - mengubahnya = restart window.
- Jangan ubah `FILTER_*` / env lain yang mengubah trade selection, jangan retrain/deploy model saat resume (model live `20260924-p2-0d88d4` harus tetap).
- Kalau memang perlu perubahan yang mengubah selection, lakukan **secara sadar** sebagai window baru (set `EVAL_WINDOW_START` ke waktu deploy baru).

## 6. Dampak ke eval window 300 trade

- Window **tidak batal** dan data tidak hilang: downtime hanya menunda. Perkiraan saat berhenti **257/300 (86%)**; sisa **43 trade sekitar 3,6 hari trading** -> ETA selesai sekitar **2026-10-22/23** bila resume 2026-10-19.
- Downtime 19 jam (sampai laporan ini) tidak membuang trade mana pun; baris provisional `price_fallback` akan diverifikasi verifier saat startup (sweep 7 hari - masih aman selama downtime <7 hari).
- Risiko terhadap window: (a) deploy yang mengubah selection -> window restart; (b) downtime >7 hari -> baris provisional tua tidak bisa diverifikasi dan permanen; (c) resume dengan kode 19 hari lalu **aman** karena tidak ada perubahan selection sejak 2026-09-29.
- Catatan statistik: dengan n sekitar 257 dan WR 61,1%, CI 95% sekitar 55-67% **masih memuat** breakeven 60,5% -> window 300 kemungkinan besar tetap `inconclusive`; jangan menaikkan target 300 tanpa analisis power (lihat `quant-assessment.md`).

## 7. Lampiran - perintah & sumber bukti

```powershell
railway status --json                      # latestDeployment bot = cdddb941 FAILED (artefak), activeDeployments []
railway volume list --json                 # bot-volume 677.9 MB @ /app/bot/data
railway --version                          # 4.40.2
# GraphQL https://backboard.railway.com/graphql/v2 (Bearer accessToken dari ~/.railway/config.json):
#   project(id) / deployments(first:60,input) / deployment(id) / serviceInstance(...)
#   deploymentEvents(id) / deploymentLogs(deploymentId, startDate, endDate, limit, filter)
#   workspace(workspaceId) { plan customer { state currentUsage creditBalance billingPeriod usageLimit } }
#   auditLogs(workspaceId, first:80) / events(projectId, first:40)
#   variables(projectId, environmentId, serviceId)   # hanya nama variabel yang dicetak
# S3 (read-only, SigV4 path-style): ListObjectsV2 bucket poly15btc prefix btc15/tape/
git rev-parse --short HEAD                 # abc1b56 (2026-09-29 14:39 +0700), tree bersih
```

**Yang tidak dijalankan (sesuai aturan read-only):** restart/redeploy/scale/delete deployment/service, `railway down`, `railway up`, `railway ssh` ke container, perubahan kode/config/.env, trading. Tidak ada sandbox escalation yang diminta.

## 8. Rekomendasi singkat

1. **Selesaikan billing Railway hari ini** (PAST_DUE + kredit usage habis) - ini akar masalah berhentinya bot; tanpa ini resume akan berhenti lagi.
2. Konfirmasi di dashboard/email apakah stop ini karena usage/billing atau aksi manual.
3. Setelah billing aman: **`railway up --service bot --ci`** dari checkout ini (image sama, window lanjut), lalu cek log startup + `npm run report:dryrun:railway`.
4. **Jangan ubah `EVAL_WINDOW_START`/filter** sampai window 300 selesai (sekitar 4 hari trading lagi).
5. Perhatikan deadline RTDS sekitar 2026-10-23 (lihat roadmap) - setelah resume, PTB masih exact via `chainlink_twap`, fallback API tersedia.
6. Untuk laporan evaluasi ke depan: kirim juga ringkasan ke log (bukan hanya Telegram) agar bisa diaudit dari log 7 hari.
