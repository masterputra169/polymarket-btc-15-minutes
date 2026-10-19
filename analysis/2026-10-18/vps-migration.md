# Kajian Migrasi Railway → VPS — PolyBTC15 (2026-10-18)

**Penulis:** v2-roadmap (task-6) · **Tanggal cek harga:** 2026-10-18 (Asia/Jakarta)
**Repo:** `A:\PolyBot BTC15\PolyBTC15` HEAD `abc1b56` · **Sifat:** READ-ONLY (tidak ada infra/kode/deployment yang diubah; tidak ada secret dicetak)
**Sumber fakta billing/live:** `analysis/2026-10-18/live-status.md` (Tugas A, audit GraphQL/CLI Railway 2026-10-18)
**Kurs acuan (open.er-api.com, 2026-10-18):** USD/IDR = 18.014 · EUR/USD ≈ 1,124

---

## 0. Ringkasan keputusan (TL;DR)

| Pertanyaan | Jawaban singkat |
|---|---|
| Berapa biaya Railway sekarang? | **±$0,60/hari = ±$18/bulan** (run-rate periode berjalan: $4,99 dalam 8,3 hari), ditagih sebagai **usage** di plan HOBBY (min $5, termasuk $5 kredit) + invoice **$24,58** periode 10 Sep–10 Okt yang belum dibayar. Proyeksi setahun **≈$215–295**. |
| Naik ke PRO menyelesaikan? | **Tidak lebih murah.** PRO = min $20/bulan **termasuk** $20 kredit usage → pada pemakaian $18–25 tetap bayar $18–25. PRO hanya menaikkan limit (48→1.000 vCPU) — limit bukan masalah; **masalahnya payment/PAST_DUE** yang menghentikan bot. |
| VPS lebih murah? | **Ya, untuk 2 vCPU/4 GB:** Biznet Gio Jakarta **Rp139.000 ≈ $7,7**; Hetzner Singapore **≈$9–10**; Vultr SGP **$20**; DO/Linode/Lightsail 2 vCPU/4 GB **$24**. Penghematan realistis **$8–17/bulan (±$100–200/tahun)** dengan provider murah, atau **netral** dengan DO/Linode/Lightsail. |
| Perlu resource berapa? | **2 vCPU / 4 GB RAM / 40–80 GB SSD** untuk satu VPS yang memuat bot + nginx + Postgres + Redis. **1 vCPU/2 GB tidak disarankan** (bot polling ±20×/detik + 3 service lain akan rebutan CPU). Tanpa Postgres/Redis, 1 vCPU/2 GB masih berisiko. |
| Ke mana? | **Rekomendasi: pindah** ke VPS 2 vCPU/4 GB, region **Singapore** (paritas dengan Railway asia-southeast1) atau **Jakarta** (Biznet Gio, harga IDR, latensi RI terbaik), **R2/S3 tetap** untuk tape. Simpan Railway 1 bulan sebagai rollback, baru dekomisi. |
| Jebakan terbesar | **Sudah tertangani sebagian oleh tim:** data volume Railway sudah diekspor lokal pada 2026-10-18 15:33–15:39Z ke `data/railway-export/` (manifest `manifest.json`; isi volume ±8,5 MB — `trade_journal.jsonl` 1,69 MB, `ptb_health.jsonl` 3,07 MB, `llm_regime.jsonl` 2,82 MB, `state.json` 21 KB, `state_audit.jsonl` 360 KB — plus arsip `volume-2026-10-18.tar.gz` 1,25 MB dan log 4,9 MB). **Konsekuensi:** migrasi **tidak** butuh resume Railway untuk menyelamatkan data; cukup verifikasi arsip. **Temuan penting:** isi volume nyata ±8,5 MB, sedangkan angka **677,9 MB** di Railway adalah metrik disk/usage — bukan ukuran data — sehingga disk VPS jauh lebih kecil dari dugaan. |

---

## 1. Biaya Railway sekarang & proyeksi

### 1.1 Fakta (dari live-status.md, 2026-10-18)

| Item | Nilai |
|---|---|
| Plan workspace | **HOBBY** (min $5/bulan, termasuk $5 kredit usage) |
| Subscription | **PAST_DUE** (pembayaran gagal) |
| Periode berjalan | 2026-10-10T07:15Z → 2026-11-10T07:15Z |
| Pemakaian periode berjalan | **$4,9916 dari $5,00** (99,83%) — habis 2026-10-18 14:27Z |
| Laju | **±$0,60/hari** (8,3 hari → $4,99) → **±$18/bulan** |
| Invoice belum dibayar | **$24,58** untuk 10 Sep–10 Okt |
| Service | bot, frontend, Postgres, Redis + volume `bot-volume` **677,9 MB** |
| Region | asia-southeast1 (Singapore) |
| Dampak | 2026-10-18 14:27Z bot & frontend **dihentikan platform** karena kredit habis + payment gagal; DB masih hidup |

**Catatan data (2026-10-18 15:33–15:39Z):** tim sudah mengekspor volume + log ke `data/railway-export/` (deployment singkat `7bd7687a`, durasi 206 s, status SUCCESS lalu stopped). Ekspor memuat `trade_journal.jsonl` (1,69 MB), `state.json` (21 KB), `ptb_health.jsonl` (3,07 MB), `state_audit.jsonl`, `llm_regime.jsonl`, `drift_log.jsonl`, `tape/2026-10-18/…`, arsip `volume-2026-10-18.tar.gz` (1,25 MB), serta 11 file log (±4,9 MB) termasuk eval report penuh. Total paket 5,2 MB (manifest). Artinya **risiko kehilangan data evaluasi 252 trade sudah tidak ada**, asalkan arsip diverifikasi (tar bisa dibuka + jumlah file cocok).

### 1.2 Tarif Railway resmi (https://railway.com/pricing, dicek 2026-10-18)

| Resource | Tarif | Per bulan (×2.592.000 s) |
|---|---|---|
| CPU | $0,00000772 / vCPU-detik | **≈$20,01 / vCPU-bulan** |
| RAM | $0,00000386 / GB-detik | **≈$10,01 / GB-bulan** |
| Volume | $0,00000006 / GB-detik | **≈$0,156 / GB-bulan** → 677,9 MB ≈ **$0,11/bulan** |
| Egress | $0,05 / GB | tape ±0,4 GB/bulan ≈ $0,02 |
| Plan HOBBY | min $5/bulan, termasuk $5 kredit | bill = max($5, usage) |
| Plan PRO | min $20/bulan, termasuk $20 kredit | bill = max($20, usage) |

### 1.3 Dekomposisi biaya (estimasi, dikalibrasi ke $0,60/hari)

Tarif di atas menjelaskan burn $18/bulan kira-kira: **±0,7–0,8 vCPU + ±0,5–0,6 GB RAM rata-rata** setara biaya. Dengan bot ±60% burn (dari live-status):

| Komponen | Estimasi $/bulan | Dasar |
|---|---|---|
| Bot (Node 25, poll 50 ms → ±10–20 loop/detik, ML inference) | **$10–15** | ±55–65% burn; log loop 78–200 ms/iterasi ⇒ CPU nyata, bukan idle |
| Postgres (idle, mirror journal + report views) | **$3–5** | RAM ±0,2–0,3 GB + CPU rendah |
| Redis (cache status/health) | **$0,5–1** | RAM <0,1 GB |
| Frontend (nginx static) | **$1–2** | CPU/RAM sangat kecil |
| Volume 677,9 MB + egress | **$0,1–0,3** | tarif volume/egress |
| **Total** | **≈$15–23/bulan** (cocok dengan $18–24,6) | |

**Kesimpulan biaya:** yang mahal adalah **CPU 24/7 dari bot** (±$10–15/bulan), bukan database (idle), bukan volume (≈$0,11). Mengganti poll 50 ms → 500 ms akan memangkas biaya Railway secara signifikan **tetapi mengubah trade selection ⇒ me-restart eval window** — bukan jalan pintas yang gratis.

### 1.4 Proyeksi & skenario

| Skenario | Biaya/bulan | Biaya/tahun | Catatan |
|---|---|---|---|
| Railway HOBBY sekarang | **$18–25** | $215–295 | + risiko PAST_DUE/stop lagi (sudah terjadi) |
| Railway PRO | **$18–25** | $215–295 | min $20; hanya limit lebih besar, **bukan penghematan** |
| VPS 2 vCPU/4 GB murah (Biznet Gio / Hetzner SGP) | **$7,7–10** | $92–120 | hemat ±$100–200/tahun |
| VPS 2 vCPU/4 GB standar (Vultr/DO/Linode/Lightsail) | **$20–24** | $240–290 | ± setara Railway, tapi fixed & kontrol penuh |
| VPS 1 vCPU/2 GB murah | **$4,4–12** | $53–145 | **berisiko CPU**, hanya jika PG/Redis dibuang |

Biaya tersembunyi VPS (masuk hitungan): snapshot/backup $1–2/bulan, domain $10/tahun, IPv4 Hetzner ±€0,5/bulan, PPN/Pajak digital 0–11% tergantung provider, dan **waktu operator** (setup + observasi ±2–3 hari kerja).

---

## 2. Kebutuhan resource nyata (dari kode/config)

### 2.1 Batas yang dideklarasikan repo

| Komponen | Batas di repo | Sumber |
|---|---|---|
| Bot | PM2 `max_memory_restart 512M`; compose `mem_limit 768m`, `cpus 1.5` | `ecosystem.config.cts`, `docker-compose.yml` (bot) |
| Frontend | compose `mem_limit 128m`, `cpus 0.5`; image = nginx alpine serve `dist/` | `Dockerfile.frontend` (multi-stage: build Vite → nginx) |
| Postgres 17 | compose `mem_limit 512m`, `cpus 1.0` | `docker-compose.yml` |
| Redis 7 | compose `mem_limit 128m`, `cpus 0.5` | `docker-compose.yml` |
| Volume data | 677,9 MB **metrik Railway**; isi file nyata ±8,5 MB (ekspor 2026-10-18) | live-status + `data/railway-export/` |
| Model ML aktif | xgboost 0,76 MB + lightgbm 2,33 MB + norm 0,01 MB (JSON); `.bak` 451 MB **tidak** dipakai runtime | `public/ml/` |
| Repo di VPS | kode+binary ± 5–8 GB (node_modules 71+89 MB; `.git` 138 MB; **backtest 2,97 GB tidak perlu**); image Docker ±1–2 GB | ukuran lokal |

### 2.2 Apakah Postgres/Redis wajib? **Tidak.**

Dari `bot/src/services/runtimeIntegrations.ts`:
- `initPostgres()` **return lebih awal bila `DATABASE_URL` kosong**; `initRedis()` sama bila `REDIS_URL` kosong; `RUNTIME_INTEGRATIONS_ENABLED=false` mematikan keduanya.
- `reportServer.ts`: tanpa `DATABASE_URL` → log `Report API dormant` (endpoint `/reports` mati; `/health` tetap).
- Trade dry-run **tidak** masuk Postgres (hanya state/posisi yang di-mirror), jadi hilangnya PG **tidak** menghapus `trade_journal.jsonl` atau data evaluasi — journal tetap di volume `bot/data`.
- **Konsekuensi bila DB dibuang:** dashboard/report API (laporan Postgres, views analitik) mati; mirror posisi/trade event & backfill hilang; Redis hanya cache (bisa dibuang tanpa efek trading).
- **Rekomendasi:** bawa Postgres+Redis di **compose yang sama** (sudah ada, resource kecil) supaya parity; kalau ingin VPS paling murah, buang keduanya dulu (`RUNTIME_INTEGRATIONS_ENABLED=false`) dan hidupkan nanti.

### 2.3 Estimasi RAM/CPU minimum vs nyaman

| Profil | RAM | CPU | Disk | Penilaian |
|---|---|---|---|---|
| **Minimum (bot+nginx saja, tanpa PG/Redis)** | 1,0–1,5 GB | 1 vCPU **penuh** | 20–30 GB | Berisiko: poll 50 ms + ML bisa memakan 1 core; restart/GC membuat lag |
| **Disarankan (bot+nginx+PG+Redis)** | **2,5–3,5 GB** | **2 vCPU** | **40–80 GB** | Nyaman; headroom untuk build image & retrain manual |
| Nyaman-plus (retrain ML di VPS) | 4–6 GB | 2–4 vCPU | 80–100 GB | Retrain butuh CPU/RAM besar sesaat; lebih baik tetap di mesin lokal |

**Disk:** OS 8 GB + image Docker 2–3 GB + repo 6 GB + volume data **<0,1 GB** (isi nyata ±8,5 MB; 677,9 MB di Railway adalah metrik disk) + headroom build = **25 GB cukup, 40 GB nyaman** (80 GB hanya bila retrain/latihan ML dilakukan di VPS). **Bandwidth:** upload tape ±0,6 MB/jam ≈ **14 MB/hari ≈ 0,42 GB/bulan** (R2 menerima; egress R2 untuk unduh gratis) — semua paket VPS (1–4 TB) jauh lebih dari cukup.
**Catatan:** komposisi 677,9 MB tidak bisa diperiksa tanpa container hidup (live-status §4). Saat ekspor nanti jalankan `du -sh /app/bot/data/*` — kalau ternyata mayoritas tape yang belum terhapus, disk VPS bisa lebih kecil; kalau journal/backup menumpuk, rencanakan rotasi.

---

## 3. Perbandingan opsi VPS (harga publik, dicek 2026-10-18)

### 3.1 2 vCPU / 4 GB (rekomendasi)

| Provider | Region | Harga | RAM/Disk | Bandwidth | Catatan | Sumber |
|---|---|---|---|---|---|---|
| **Biznet Gio** (NEO Lite) | Jakarta, ID | **Rp139.000 ≈ $7,7** | 2/4 GB | free bandwidth (promo) | IDR, support lokal, latensi RI terbaik | biznetgio.com/product/vps-murah-indonesia |
| **Hetzner Cloud** | Singapore (SIN) | **≈€6,5–8 ≈ $7,4–9,1** | 2/4 GB, 40–80 GB NVMe | 1–8 TB (SGP) | termurah internasional; harga SGP +20–40% dari EU; belum termasuk VAT, IPv4 ±€0,5 | hetzner.com/cloud + costgoat.com/pricing/hetzner |
| **Vultr** (Cloud Compute) | Singapore | **$20** (`vc2-2c-4gb`) | 2/4 GB, 80 GB SSD | 3 TB | API publik mengonfirmasi SGP tersedia; varian High-Frequency $24 | api.vultr.com/v2/plans |
| **Vultr** (High Frequency) | Singapore | $24 (`vhf-2c-4gb`) | 2/4 GB, 128 GB NVMe | 3 TB | NVMe, IOPS lebih baik | api.vultr.com/v2/plans |
| **Linode/Akamai** | Singapore | **$24** (`g6-standard-2`) | 2/4 GB, 80 GB SSD | 4 TB | API publik terverifikasi | api.linode.com/v4/linode/types |
| **DigitalOcean** | Singapore | **≈$24** (Basic 2 vCPU/4 GB) | 2/4 GB, 80 GB SSD | 4 TB | kolom $/bulan dirender dinamis; verifikasi saat beli | digitalocean.com/pricing/droplets |
| **AWS Lightsail** | Singapore | **$24** | 2/4 GB, 80 GB SSD | 4 TB | harga $24 terkonfirmasi di halaman; egress ekstra mahal ($0,09/GB) | aws.amazon.com/lightsail/pricing |

### 3.2 1 vCPU / 2 GB (opsi hemat, dengan catatan)

| Provider | Harga | Catatan |
|---|---|---|
| Biznet Gio | **Rp80.000 ≈ $4,4** | lokal, IDR |
| Hetzner SGP | **≈€4,4–5,3 ≈ $5–6** | CPX11/CX22 class, +20–40% vs EU |
| Vultr | **$10** (`vc2-1c-2gb`) | SGP tersedia |
| Linode | **$12** (`g6-standard-1`) | |
| DigitalOcean | **≈$12** | |
| AWS Lightsail | **$12** | |

**Yang tidak bisa diverifikasi hari ini:** IDCloudHost (halaman 403 saat diakses) dan Contabo (situs menolak akses/JS-only) — **jangan masukkan ke perbandingan final sebelum dicek manual**; IDCloudHost/Contabo biasanya kompetitif (Contabo sering ±$8–15 untuk 4 vCPU/8 GB), tapi klaim itu belum berbasis sumber hari ini.

### 3.3 Catatan pemilihan region

- **Railway sekarang di asia-southeast1 (Singapore).** Pindah ke **Singapore** = paritas latensi paling dekat; pindah ke **Jakarta** menambah ±10–20 ms ke Polymarket (tidak relevan untuk pasar 15 menit dan DRY_RUN, relevan sedikit untuk order live).
- Latensi terukur dari mesin operator (Jakarta, via DoH, 2026-10-18, n=5): `gamma-api.polymarket.com` **median 48 ms**; `clob.polymarket.com` **median 681 ms** (varian 221–2.846 ms — retest dari VPS saat pilot); `ws-live-data.polymarket.com` **median 392 ms**. Angka ini dari jaringan ISP yang memfilter, jadi **hanya pembanding kasar**; wajib uji ulang dari VPS kandidat (`curl -w '%{time_connect} %{time_total}'` ke clob/gamma + ping WS).
- **DNS/DoH:** bot memakai `POLYMARKET_DOH_ENABLED=true` (default) untuk host `.polymarket.com` karena DNS lokal dapat difilter (contoh nyata: dari mesin ini TLS polos ke docs/clob/gamma diintersepsi ISP dan mengembalikan halaman blokir; lewat DoH berhasil). **Yang tidak dilindungi DoH: koneksi WebSocket** (`clobWs`, RTDS/Chainlink TWAP) — mereka resolve lewat DNS sistem. **Risiko VPS Indonesia:** bila DNS provider memfilter domain Polymarket, WS putus terus. Mitigasi: (a) pilih VPS dengan resolver bersih (Singapore umumnya aman), atau (b) set resolver DoT/DoH di level OS (systemd-resolved `DNSOverTLS=yes`) atau /etc/hosts dari hasil DoH (SNI tetap benar). **Ini harus diuji sebelum memindahkan bot.**

---

## 4. Rencana migrasi

### 4.1 Arsitektur target (satu VPS)

```
VPS Ubuntu 24.04 (2 vCPU/4 GB, SGP atau JKT)
├── Caddy/nginx (80/443, TLS Let's Encrypt) ──► frontend (nginx static, compose)
│                                            └─► /ws ──► bot :3099
├── bot (Dockerfile.bot / node bot/index.ts, restart: unless-stopped)
│    └─ /app/bot/data (volume host ./data)   ← state/journal/ptb_health
├── postgres:17-alpine (opsional, volume)
├── redis:7-alpine (opsional, volume)
├── systemd timer: botLiveness + health check (pengganti scripts/stack-watchdog.ps1)
└── R2/S3 bucket poly15btc  ← tape (EKSISTING, tidak dipindah)
```
Frontend build **sudah** multi-stage → nginx; tidak perlu Vite dev server di produksi (di Railway memang begitu). `ecosystem.config.cts` (PM2) hanya untuk lokal; di VPS gunakan **Docker compose** yang sudah ada (paling dekat dengan image Railway) atau systemd unit Node 25 jika tidak ingin Docker.

### 4.2 Prasyarat P0 — data Railway (status: **SUDAH DIEKSPOR, tinggal verifikasi**)

> Ekspor sudah dilakukan tim pada 2026-10-18 15:33–15:39Z lewat deployment singkat `7bd7687a` (206 s) → `data/railway-export/` (volume + log + evidence + billing snapshot). Langkah di bawah adalah **verifikasi**, bukan ekspor ulang.

1. **Verifikasi arsip:** `data/railway-export/manifest.json` (5,2 MB total; volume ±8,5 MB + tar 1,25 MB + log 4,9 MB). Cek: `tar tzf data/railway-export/volume/volume-2026-10-18.tar.gz | head`, jumlah baris `trade_journal.jsonl` = jumlah trade window (≈252 + baris sebelum window), `state.json` bankroll ≈$57,40, `ptb_health.jsonl` terakhir 2026-10-18.
2. **Postgres:** kalau DB dibawa, `pg_dump -Fc` dari Railway **sebelum** dekomisi (pakai `DATABASE_PUBLIC_URL`; tidak perlu deploy bot). Kalau tidak dibawa, lewati — journal evaluasi tetap utuh di arsip volume.
3. **Billing:** putuskan bayar invoice **$24,58** (untuk menjaga opsi rollback & dekomisi bersih) atau biarkan akun ditutup. Tanpa resume, bot tetap mati; dengan VPS siap, resume Railway hanya opsi rollback.
4. **Jangan** mengandalkan satu salinan: simpan arsip juga ke R2 (`TAPE_S3_*` sudah ada) atau ke mesin lokal lain.

> Catatan: karena data sudah diekspor, **tidak ada lagi alasan menahan migrasi** karena takut kehilangan journal. Urgensi tinggal soal billing/rollback.

### 4.3 Checklist langkah VPS

| # | Langkah | Detail/command (belum dieksekusi) |
|---|---|---|
| 1 | Provisioning | 2 vCPU/4 GB, Ubuntu 24.04 LTS, region SGP/JKT, SSH key (bukan password), firewall: hanya 22/80/443 |
| 2 | Hardening dasar | `ufw`, `fail2ban`, unattended-upgrades, user non-root + sudo, disable root login |
| 3 | Runtime | Docker + compose plugin (atau Node 25 + PM2). Sinkronkan zona waktu `Asia/Jakarta` |
| 4 | Kode | Clone repo (atau unggah tarball dari commit `abc1b56`), **tanpa** `backtest/` (2,97 GB) dan `.bak` model di `public/ml` (451 MB tak terpakai) |
| 5 | Secrets | Salin variabel dari Railway (nama saja, jangan di git): `DRY_RUN`, `POLYMARKET_*`, `TAPE_S3_*`, `*_AUTH_TOKEN`, `BANKROLL`, `EVAL_WINDOW_START`, `FILTER_*`, `DATABASE_URL`, `REDIS_URL`, `TZ`, dll. File `.env` 0600 |
| 6 | Data restore | Ekstrak `bot-data-railway-*.tgz` → `./data` (mounted ke `/app/bot/data`); restore `pg_dump` bila PG dibawa |
| 7 | Jalankan | `docker compose up -d --build` (bot+frontend+postgres+redis); healthcheck `/health` port 3101 |
| 8 | Web/TLS | Domain → A record VPS; Caddy reverse proxy 443 → frontend:80, `/ws` → bot:3099, `/reports` → bot:3101 (Bearer token); **jangan** expose 3099/5432/6379 ke internet |
| 9 | Verifikasi | Log startup: `Mode: DRY_RUN`, `[Loop] #`, tape aktif; dashboard live; `npm run report:dryrun` dari repo; `curl /health`; cek 3 WS feed hidup; PTB exact (chainlink_twap, fallback API siap) |
| 10 | Watchdog | Ganti `scripts/stack-watchdog.ps1` (Windows) dengan **systemd timer**: `bot/scripts/botLiveness.mts` + `docker compose restart bot` bila tidak ada poll 10 menit; atau watchdog di PC operator menembak `https://domain/health` |
| 11 | Backup | Snapshot mingguan provider (atau `pg_dump` + tar data harian ke R2); retensi 2–4 minggu |
| 12 | Observasi | 3–7 hari DRY_RUN penuh: cek trade/hari, PTB exact %, error log, upload tape, RAM/CPU (`docker stats`), disk |
| 13 | Rollback siap | Railway tetap hidup (billing aktif) 2–4 minggu; kalau VPS bermasalah: `railway up --service bot --ci` + re-attach volume → jalankan lagi. **Catatan:** trade yang terjadi di VPS setelah cutover tidak ada di volume Railway; rollback berarti salin balik `bot/data` VPS → volume Railway |
| 14 | Dekomisi | Setelah stabil: hentikan service Railway (bot/frontend/PG/Redis), hapus volume + project, batalkan langganan; simpan invoice |

### 4.4 Verifikasi keberhasilan (acceptance)

- Bot loop berjalan konsisten >24 jam tanpa restart, RAM bot < 600 MB, CPU total < 70% dari 2 vCPU.
- PTB health: exact ≥98% (paritas baseline 98,3%), 0 mismatch.
- Tape: 24/24 jam per hari terunggah ke R2, 0 kegagalan.
- Dashboard & report API (bila PG dibawa) merespons; `EVAL_WINDOW_START` **tidak berubah** ⇒ window 300 trade lanjut (sisa ±43 trade ≈ 3,6 hari trading).
- Biaya: total bulanan VPS + backup + domain **< $12** (provider murah) atau **<$26** (DO/Linode) dan **tidak ada tagihan platform yang bisa tiba-tiba mematikan bot**.

---

## 5. Risiko & mitigasi

| Risiko | Dampak | Mitigasi |
|---|---|---|
| **Arsip ekspor belum diverifikasi** (volume sudah diekspor 2026-10-18) | Restore dari arsip rusak → journal window hilang | Verifikasi tar/manifest (§4.2) + simpan salinan kedua di R2 sebelum dekomisi |
| **PAST_DUE berulang** bila menunda | Bot berhenti lagi kapan saja | Ambil keputusan cepat: bayar invoice atau pindah; jangan biarkan akun menggantung |
| **DNS/WS terfilter di VPS Indonesia** | WS CLOB/RTDS putus → sinyal stale | Uji `ws` ke `wss://ws-live-data.polymarket.com` + `clob.polymarket.com` dari VPS sebelum cutover; aktifkan DoH (sudah default) + DoT OS; kalau tetap gagal, pilih region Singapore |
| **SPOF 1 VPS** (VM host maintenance) | Bot mati sampai reboot | `restart: unless-stopped`, systemd timer liveness, alert Telegram, snapshot; Railway rollback 2–4 minggu |
| **CPU kurang** (1 vCPU) | Loop melambat, sinyal telat, tape drop | Pilih 2 vCPU; ukur `docker stats` hari pertama; jangan 1 vCPU bila PG/Redis ikut |
| **Latensi ke Polymarket** | Sedikit lebih lambat dari Railway SGP (JKT +10–20 ms) | Tidak relevan saat DRY_RUN; ukur ulang saat live; pilih SGP bila mau paritas |
| **Keamanan** (dashboard publik + control RPC) | `sellPosition`/`setBankroll` disalahgunakan | `STATUS_AUTH_TOKEN` wajib, origin check tetap, TLS, firewall, tanpa port DB terbuka, token tidak di URL publik |
| **Kehilangan tape** saat migrasi | Studi maker-fill terhambat | Tape sudah di R2 (599 objek ±363 MB, 19 hari lengkap) — **tidak** ikut pindah; verifikasi upload setelah cutover |
| **Eval window terkontaminasi** | Kesimpulan statistik lemah | Jangan ubah filter/sizing/`EVAL_WINDOW_START` saat migrasi; migrasi = restart proses saja, bukan perubahan seleksi |
| **Biaya tersembunyi** | $1–3/bulan ekstra | Hitung snapshot, IPv4, VAT/PPN, domain; tetap < Railway |
| **Jam operator** | 1–3 hari kerja | Lakukan di akhir pekan; sediakan runbook ini |

---

## 6. Rekomendasi

1. **Pindah ke VPS 2 vCPU / 4 GB**, region **Singapore** (Vultr $20 / Hetzner ≈$9–10) **atau Jakarta** (Biznet Gio Rp139.000 ≈ $7,7). Pilihan termurah yang layak: **Biznet Gio** (IDR, support lokal, latensi RI) atau **Hetzner SGP** (harga terbaik internasional); pilihan paling "aman/terdokumentasi": **Vultr SGP $20** atau **Linode $24**.
2. **Tetap pakai R2/S3 untuk tape** (sudah berjalan; tidak ada perubahan kode) → **hybrid**: compute di VPS, storage di R2.
3. **Jangan buang Postgres/Redis di awal** — bawa di compose yang sama (resource kecil, parity penuh); buang hanya bila ingin menekan RAM/CPU ke 1 vCPU/2 GB (tidak disarankan).
4. **Urutan eksekusi:**
   ```
   H+0  : Verifikasi arsip data/railway-export (§4.2) + putuskan bayar invoice $24,58 / rollback
   H+0–1: Provisioning VPS + hardening + compose up (DRY_RUN=true, env identik) + restore arsip
   H+1–2: Verifikasi 24 jam (loop, PTB, tape, dashboard, CPU/RAM)
   H+3–7: Observasi 3–7 hari → putuskan dekomisi Railway
   H+30 : Hapus volume/project Railway, langganan berhenti (atau lebih cepat bila yakin)
   ```
5. **Jangan** melakukannya bersamaan dengan perubahan lain yang mengubah trade selection (CLOB V2 merge, sizing 5 share, RTDS→PolyBolt). Migrasi harus "kode & env sama, hanya mesin yang berubah" agar window evaluasi tetap sahih. Kalau digabung, set `EVAL_WINDOW_START` baru secara sadar.
6. **Kalau memilih tinggal di Railway:** pindah ke PRO $20 (bukan penghematan, hanya menghindari batas Hobby) dan pastikan payment method tidak gagal — tapi akar masalah (biaya CPU 24/7 + tagihan variabel + risiko stop) tetap.

---

## 7. Keputusan yang dibutuhkan operator

1. **Pindah atau tinggal?** Rekomendasi: pindah ke VPS 2 vCPU/4 GB; hitung penghematan $8–17/bulan dengan provider murah.
2. **Provider & region:** Biznet Gio JKT (IDR, termurah) vs Hetzner SGP (termurah internasional) vs Vultr SGP $20 (paling teruji). Perlu kartu pembayaran yang cocok.
3. **Bayar invoice Railway $24,58?** Ini **prasyarat** ekspor data volume; tanpa itu journal 252 trade hilang. Alternatif: hubungi support Railway untuk ekspor volume (lambat).
4. **Postgres/Redis dibawa atau dibuang?** Bawa = parity + report API; buang = lebih ringan/hemat, kehilangan mirror & report API.
5. **Domain & TLS:** pakai domain siapa untuk dashboard (Let's Encrypt via Caddy)?
6. **Rollback window:** berapa lama Railway dipertahankan (rekomendasi 2–4 minggu; biaya ±$20–25)?

---

## Lampiran A — Perintah & sumber bukti (semua read-only)

```text
# Fakta billing/live (live-status.md; GraphQL https://backboard.railway.com/graphql/v2)
railway status --json ; railway volume list --json
workspace { plan customer { state currentUsage creditBalance billingPeriod usageLimit } }
  → HOBBY / PAST_DUE / $4,991631 dari $5,00 / periode 2026-10-10 07:15Z–11-10
  → volume bot-volume 677,9 MB / 5000 MB

# Tarif Railway (https://railway.com/pricing, dicek 2026-10-18)
Memory $0.00000386/GB/s (≈$10,01/GB-bulan)
CPU    $0.00000772/vCPU/s (≈$20,01/vCPU-bulan)
Volumes $0.00000006/GB/s (≈$0,156/GB-bulan)
Egress $0.05/GB ; Object storage $0.015/GB-month
HOBBY min $5 (incl $5 kredit) ; PRO min $20 (incl $20 kredit)

# Harga VPS (dicek 2026-10-18)
Vultr  : GET https://api.vultr.com/v2/plans → vc2-1c-1gb $5; vc2-1c-2gb $10;
         vc2-2c-4gb $20; vhf-2c-4gb $24; SGP tersedia
Linode : GET https://api.linode.com/v4/linode/types → g6-nanode-1 $5;
         g6-standard-1 $12; g6-standard-2 $24
DO     : https://www.digitalocean.com/pricing/droplets → $0,024/jam (1 vCPU/1 GB),
         $0,052/jam (2 vCPU/4 GB); harga bulanan 1 GB $6 / 2 GB $12 / 2vCPU-4GB $24
Lightsail: https://aws.amazon.com/lightsail/pricing/ → $5 / $7 / $12 / $24 / $44 dst.
Hetzner: https://www.hetzner.com/cloud/ + costgoat.com/pricing/hetzner →
         mulai €5,49 (CX23), Singapore +20–40%; harga bulanan EU CPX/CX €4,35–6,53
Biznet Gio: https://www.biznetgio.com/product/vps-murah-indonesia →
         1/1 GB Rp59.000; 1/2 GB Rp80.000; 2/2 GB Rp109.000; 2/4 GB Rp139.000
Kurs: https://open.er-api.com/v6/latest/USD → USD/IDR 18.014 (2026-10-18)

# Batas resource (repo)
docker-compose.yml: bot mem_limit 768m/cpus 1.5; postgres 512m/1.0;
                    redis 128m/0.5; frontend 128m/0.5
ecosystem.config.cts: bot max_memory_restart 512M
Dockerfile.bot: node:25-bookworm-slim, npm ci --omit=dev (root+bot), CMD node bot/index.ts
Dockerfile.frontend: build Vite → nginx:1.27-alpine (static)
runtimeIntegrations.ts: DATABASE_URL/REDIS_URL kosong → integration dimatikan;
                        RUNTIME_INTEGRATIONS_ENABLED=false mematikan keduanya
reportServer.ts: tanpa DATABASE_URL → "Report API dormant"

# Latensi dari mesin operator (Jakarta, via DoH, n=5, 2026-10-18)
gamma-api.polymarket.com : median 48 ms (36–106)
clob.polymarket.com     : median 681 ms (221–2.846, varians tinggi)
ws-live-data.polymarket.com : median 392 ms (269–1.088)
(dari jaringan operator yang memfilter; wajib uji ulang dari VPS kandidat)
```

## Lampiran B — Yang tidak diverifikasi hari ini

- **IDCloudHost** dan **Contabo**: situs menolak akses (403/JS-only) dari jaringan ini → harga belum berbasis sumber hari ini; cek manual sebelum memutuskan.
- **Harga bulanan DigitalOcean**: kolom $/bulan dirender dinamis; angka $6/$12/$24 adalah daftar standar yang lazim, verifikasi di halaman saat pembelian.
- **Hetzner Singapore**: harga persis per plan SGP tidak tampil di halaman yang bisa saya baca; dipakai estimasi +20–40% dari harga EU (sumber: costgoat.com) — verifikasi di akun Hetzner.
- **Spesifikasi persis Lightsail**: harga terkonfirmasi ($5/$7/$12/$24), pemetaan RAM/disk dari katalog standar AWS — verifikasi saat pembelian.
- **Angka 677,9 MB** volume Railway (metrik disk/usage) vs **isi nyata ±8,5 MB** dari ekspor 2026-10-18 — selisih belum dijelaskan (kemungkinan blok terhapus/overhead metrik); bukan penghalang, tetapi jangan pakai 677,9 MB untuk sizing disk.
- **Latensi dari VPS kandidat**: belum diukur; angka dari mesin operator hanya pembanding kasar karena jaringan operator memfilter.
- **Tidak dijalankan:** restart/redeploy/scale/delete Railway, `railway up`, `railway ssh`, perubahan kode/config/.env, trading, maupun provisioning VPS mana pun.
