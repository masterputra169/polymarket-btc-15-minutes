# Update Teknis & Roadmap — PolyBTC15 (2026-10-18)

**Penulis:** v2-roadmap (Tugas B) · **Tanggal:** 2026-10-18 (Asia/Jakarta)
**Repo:** `A:\PolyBot BTC15\PolyBTC15` · HEAD `abc1b56` (main, 2026-09-29) · branch `feat/clob-v2` `8ba2108` (2026-09-27)
**Sifat:** READ-ONLY. Tidak ada deployment/service/kode/config yang diubah. Satu-satunya file yang ditulis: laporan ini.

---

## 0. Ringkasan eksekutif

1. **CLOB V2 (P0) — kode SELESAI tapi BELUM DI-MERGE.** Branch `feat/clob-v2` (commit `78c127a`, 22 file, +2846/−271) memindahkan seluruh jalur order live ke `@polymarket/clob-client-v2` **1.2.0** (di-pin persis), pUSD, CTF Exchange V2, plus penegakan tick 0.01 dan minimum 5 share. **Bukti uji:** typecheck 4/4 config lolos; vitest 72 file / 834 test → **832 lulus**, 2 timeout pada run pertama (cache transform dingin + `tsc` 4 config berjalan paralel), dan keduanya **lulus** saat file-nya dijalankan ulang sendiri (15/15, 5,4 s) ⇒ tidak ada kegagalan fungsional. **Belum siap fast-forward:** main sudah bergerak 6 commit setelah titik pisah, dan uji gabungan `git merge-tree` mendeteksi **2 konflik** (`bot/src/trading/clobClient.ts`, `bot/derive-credentials.ts`). Estimasi beres: **0,5–1 hari**.
2. **Go-live masih diblokir 3 hal non-kode** (bukan bug branch): (a) **sizing** — harga pasar hari ini 0,62 dan minimum 5 share berarti ~$3,10/order, sedangkan `MAX_BET_AMOUNT_USD=2,5` ⇒ order 4 share akan **ditolak** oleh jalur live baru; (b) **approval pUSD** (wrap USDC.e→pUSD + 2 transaksi approval) belum dilakukan dan tidak bisa diverifikasi dari mesin ini; (c) **journalReconciler** masih menghitung P&L on-chain **tanpa fee** → koreksi bankroll live akan naik ≈ fee tiap trade.
3. **RTDS (P1, deadline dekat) — 5 hari lagi.** Dokumentasi resmi: *"Deprecated RTDS price topics are planned for removal one month after the 0.11.0 release."* `@polymarket/client` 0.11.0 terbit **2026-09-23T13:25Z** (registry npm) ⇒ **~2026-10-23**. **Nol baris kode PolyBolt di repo** (grep `polybolt|ws-live-v2|price.crypto|op:auth` = 0 hit selain catatan CLAUDE.md). Fallback API PTB **sudah ada** (`twapWindowPrice.ts` + `ptbResolver.ts`, ada di main) sehingga trading tidak berhenti total, tapi menjadi beberapa detik lebih lambat dan estimasi/ settlement akhir jendela kehilangan tick TWAP detik-per-detik.
4. **Backlog:** hampir semua dokumen `bugs.txt`, `error.txt`, `ERROR LIMIT ORDER CANCELED.txt`, `docs/TIER1_AUDIT_REPORT.md`, `docs/BANKROLL_TRACKER_FIX_PLAN.md`, `docs/V19_*.md`, `insight polymarket/` adalah **artefak era JS/Mei–Juni 2026 yang sudah usang** (codebase sekarang TypeScript + typecheck CI; v19 sudah diganti model `20260924-p2`). Yang relevan: `paper/*.docx` (laporan riset pipeline v2, 2026-09-24) dan `docs/RAILWAY.md`/`DOCKER_STACK.md`.
5. **Urutan yang disarankan:** merge V2 + konflik → CI hijau → (paralel) operator menyiapkan pUSD/approval → keputusan sizing → smoke test 5 share → deploy dry-run dulu untuk RTDS-migration, baru flip live. Detail di §6.

---

## 1. Branch `feat/clob-v2`: isi, bukti, kesiapan merge

### 1.1 Commit & ukuran
```
$ git log --oneline main..feat/clob-v2
78c127a feat: move the live order path to CLOB V2 and enforce tick and minimum size
8ba2108 Merge remote-tracking branch 'origin/main' into feat/clob-v2

$ git diff --stat main...feat/clob-v2
22 file berubah, 2846 insertions(+), 271 deletions(-)
```
File baru: `docs/CLOB_V2_MIGRATION.md` (221 baris, checklist operator), `bot/src/trading/{clobV2Config,orderConstraints,v2Readiness}.ts`, 4 file test baru (269+183+197+98 baris), `bot/scripts/{clobV2Preflight,clobV2SmokeOrder}.mts`.
File diubah: `bot/src/trading/clobClient.ts` (431 baris diff), `bot/index.ts` (gate startup), `bot/src/adapters/dataFetcher.ts` (rekam tick/min), `bot/src/trading/positionManager.ts` (allowance null), `bot/derive-credentials.ts`, `bot/derive-builder-key.ts`, `bot/freshFetchJournal.ts`, `bot/package.json`/`package-lock.json`, `.github/workflows/ci.yml`, `CLAUDE.md`, `bot/.env.example`.
Worktree `...\.claude\worktrees\agent-acc1e931b8bdfa89a`: bersih, tip = `origin/feat/clob-v2` = `8ba2108`.

### 1.2 Apa yang berubah (dari `docs/CLOB_V2_MIGRATION.md` + kode)

| Area | Sebelum (main) | Di branch |
|---|---|---|
| SDK | `@polymarket/clob-client` 5.8.1 (V1, EIP-712 domain "1") | `@polymarket/clob-client-v2` **1.2.0 exact pin** |
| Signer | ethers v6 wallet + shim `_signTypedData` | viem wallet client (signing lokal) |
| Order | nonce/feeRateBps/taker, exchange V1 | domain "2", CTF Exchange V2 `0xE111…B996B`, timestamp/metadata/builder; fee di-charge saat match |
| Collateral | USDC.e | pUSD `0xC011…2DFB` |
| Batasan order | tidak ada | tick 0.01 dibulatkan **ke dalam** (BUY floor, SELL ceil); ukuran < 5 share **ditolak, tidak pernah di-upsize**; GTD < 180 s ditolak → fallback FOK |
| Startup | `updateBalanceAllowance` (hanya sync cache) | gate `verifyClobV2Readiness()` fails-closed: saldo pUSD > 0, `pUSD.approve(ExchangeV2)`, `setApprovalForAll(ExchangeV2)`, `/version == 2` (view call saja, tanpa transaksi) |
| Settlement wait SDK | — | `skipSettlementWait` mematikan polling hashes 30 s di `postOrder` (timeout bot 15 s; kalau tidak, FOK yang fill bisa dilaporkan gagal) — meng-override method privat ⇒ SDK **wajib** di-pin, ada test yang gagal bila versi baru menghapusnya |
| Builder key | tidak dipakai | tetap tidak dipakai (tidak ada `builderCode`; builder code bisa menambah fee taker) — `derive-builder-key.ts` hanya dokumentasi |

Hal yang **tidak** berubah (per klaim dokumen, saya verifikasi lewat diff): `loop.ts`, `tradePipeline.ts`, `limitOrderManager.ts`, `fillTracker.ts`, `journalReconciler.ts` tidak tersentuh; dry-run tidak pernah memanggil `initClobClient()` sehingga perilakunya identik.

### 1.3 Bukti uji (dijalankan lokal, read-only)

| Perintah | Hasil |
|---|---|
| `npm run typecheck` (worktree) | **LULUS** 4/4: `tsc -p tsconfig.frontend/bot/bot.core/scripts.json` tanpa error (exit 0) |
| `npx vitest run` (worktree) | **832/834 lulus**; 2 timeout 30 s di `bot/src/trading/__tests__/clobClient.v2.test.ts` ("order functions throw…" 44 s, "builds the V2 client…" 54 s) — terjadi saat `tsc` 4 config berjalan bersamaan (kompetisi CPU + transform cache dingin; file itu sendiri sudah menaikkan timeout ke 30 s dengan komentar "first import is slow on a cold transform cache") |
| `npx vitest run bot/src/trading/__tests__/clobClient.v2.test.ts` (ulang, tanpa beban lain) | **15/15 lulus**, 5,36 s (file) / 7,26 s (total) — **konfirmasi kegagalan tadi artefak lingkungan, bukan bug** |
| Jumlah suite | 72 file / 834 test (branch) |

Catatan: `clobClient.v2.test.ts` mem-mock `@polymarket/clob-client-v2` dengan recorder, jadi **tidak ada order/transaksi nyata** — yang diuji adalah bentuk argumen (userOrder, {tickSize}, orderType[, postOnly]), pembulatan tick, penolakan <5 share, penolakan GTD <180 s, dan pembacaan `allowances` per-spender.

### 1.4 Kesiapan merge — **belum fast-forward, 2 konflik**

```
$ git merge-base main feat/clob-v2   → 43dfca4
$ git log --oneline feat/clob-v2..main
abc1b56 Merge pull request #2 ...            (2026-09-29)
211540a test+docs: sellPosition ownership, token stripping; document the 2026-09-29 audit
1bfb6d1 security: redact credentials from logs and alerts; rename stale Chainstack identifiers
f2ff8e4 fix: bounded env parsing for poll interval / FOK share floors, shutdown hard-exit, RPC override
3b8c873 fix: usdc-sync race, atomic writes, idle heartbeat for the external watchdog, CI permissions
fa47cfc fix: audit — stale ARB settlement, token price used as BTC price, status WS hardening, ML-off gate
$ git merge-tree --write-tree --name-only main feat/clob-v2   → exit 1
CONFLICT (content): bot/src/trading/clobClient.ts
CONFLICT (content): bot/derive-credentials.ts
```
Branch berumur 21 hari dan **tidak memuat audit 2026-09-29** (6 commit di main). Uji gabungan: 7 file beririsan, 5 auto-merge, 2 konflik:

* `bot/src/trading/clobClient.ts` — konflik **semantik, bukan sekadar teks**. Main menambah `assertOrderParams()` (+dipanggil di 3 fungsi order) dan mengganti nama `_CHAINSTACK`→`_POLYGON_RPC`; branch menulis ulang ketiga fungsi itu dan menambahkan `prepareOrThrow()`/`prepareOrder()`. `prepareOrder` sudah memvalidasi price/size, **tapi tidak memvalidasi `tokenId`** — resolusi yang benar: pertahankan struktur branch + port validasi `tokenId` (atau panggil `assertOrderParams` sebelum `prepareOrThrow`), dan pakai nama `_POLYGON_RPC`. Kalau tidak, salah satu perbaikan audit hilang (regresi keamanan: order dengan price NaN/∞ bisa ditandatangani).
* `bot/derive-credentials.ts` — keduanya menambah guard "private key wajib ada"; ambil versi branch (viem) + guard, buang versi lama. Trivial.

Sisanya auto-merge dan perlu **verifikasi semantik**, bukan hanya git: `bot/index.ts` (main: `envInt` poll bounds + hard-exit 20 s; branch: gate readiness + warning GTD lead), `bot/src/trading/positionManager.ts` (main: `polygonRpcUrl()`; branch: allowance `null`), `CLAUDE.md`, `.github/workflows/ci.yml`, `bot/.env.example`.

**Estimasi merge + resolusi + uji ulang: 0,5–1 hari kerja.** Sesudah merge wajib: `npm ci && npm ci --prefix bot`, `npm run typecheck`, `npm test` penuh (main menambah `redact.test.ts`, `statusServer.*`, `settlement.audit`, `usdcSync.race`, dll. — otomatis ikut ter-merge).

### 1.5 Yang belum terverifikasi (butuh kredensial / jaringan non-blokir)

Sesuai `docs/CLOB_V2_MIGRATION.md` §"Not verified without live credentials", dan tidak bisa saya tutup dari mesin ini:
1. API key lama benar autentikasi ke V2 (`GET /api-keys` lewat `clobV2Preflight.mts`).
2. Bentuk persis `/balance-allowance` V2 (`{balance, allowances:{spender:amount}}`) — kode membaca dua bentuk (`readAllowance()`), gate startup membaca chain, jadi risiko rendah.
3. Apakah `makingAmount` FOK BUY **termasuk** fee taker (dasar untuk memutuskan blocker journalReconciler).
4. Aturan minimum 5 share diterapkan CLOB pada market BUY (bot mengecek `amount/price ≥ 5`).
5. Aturan GTD 3 menit (dari dokumentasi, belum diuji).

**Kendala lingkungan:** dari mesin ini TLS ke `docs.polymarket.com`/`clob.polymarket.com` diintersepsi ISP (respons berupa halaman "Safesurf"). Saya memakai helper repo `fetchTextWithPolymarketDoh` (DoH) untuk pembacaan read-only; perintah SDK (`clobV2Preflight.mts`) memakai HTTP biasa sehingga **tidak bisa dijalankan dari sini** — harus dari Railway shell/container atau jaringan lain.

---

## 2. Status go-live blockers CLOB V2 (per hari ini)

| # | Blocker (dari CLAUDE.md 2026-09-26) | Status | Bukti / angka |
|---|---|---|---|
| 1 | SDK V1 tidak bisa order di V2 | ✅ **Selesai di kode** (belum merge) | `GET https://clob.polymarket.com/version` → `{"version":2}` (dibaca 2026-10-18 15:21Z via DoH). SDK V2 `1.2.0` = versi terakhir (terbit 2026-09-25, belum ada rilis baru per hari ini); V1 `5.8.1` terakhir 2026-03-23 |
| 2 | Min size 5 share, tick 0.01 | ✅ Kode siap; ⚠️ **sizing bot belum cocok** | Live 2026-10-18: Gamma `orderMinSize=5`, `orderPriceMinTickSize=0.01`, `negRisk=false`; CLOB `/book` `tick_size=0.01`, `min_order_size=5`; bid/ask 0,61/0,62. 5 share × 0,62 = **$3,10** + fee ≈ $0,082. `MAX_BET_AMOUNT_USD=2,5` ⇒ maks 4 share ⇒ **ditolak** `orderConstraints.ts` |
| 3 | Fee taker CLOB V2 | ✅ Selesai di main | `fee = shares × 0,07 × p × (1−p)`; Gamma `feeSchedule {rate 0.07, exponent 1, takerOnly true, rebateRate 0.2}` dikonfirmasi live hari ini; sudah dipakai settlement/bankroll/breakeven/edge/Kelly/arb |
| 4 | `journalReconciler` tanpa fee | ❌ **Masih terbuka** (tidak disentuh branch) | `journalReconciler.ts:787` `feeBps = parseFloat(t.fee_rate_bps) || 0` hanya **disimpan** di record; `:809-833` `netPnl = totalPayout + totalProceeds − totalCost` **tanpa fee**. P&L lokal sudah termasuk fee ⇒ setiap trade live akan selisih ≈ fee, dan reconciler "mengoreksi" bankroll live **naik** |
| 5 | pUSD funding + 2 approval | ❌ **Manual, belum ada bukti** | `docs/CLOB_V2_MIGRATION.md` §3–4: wrap USDC.e→pUSD (CollateralOnramp) lalu `pUSD.approve(CTF Exchange V2, MaxUint256)` + `CTF.setApprovalForAll(CTF Exchange V2, true)` dari funder (Safe bila `POLYMARKET_PROXY_ADDRESS` di-set). Gate startup *fails-closed* tanpa itu |
| 6 | Builder key | ✅ **Tidak diperlukan** | Bot tidak meng-attach `builderCode` (bisa menambah builder fee); HMAC builder key hanya untuk Relayer. Tidak ada variabel builder yang dibutuhkan |
| 7 | Smoke test 5 share | ⏳ Belum | `clobV2SmokeOrder.mts`: (a) post-only GTD BUY 5 @ 0,20 lalu cancel (gratis), (b) FOK BUY 5 di/atas ask (≈$3,1+fee). Langkah (3) mencatat `makingAmount` vs perubahan pUSD on-chain dan `usdcSize` data API — **ini yang memutuskan blocker #4**. Tidak boleh dijalankan sementara bot live (startup bot membatalkan semua open order) |

### 2.1 Konsekuensi sizing (butuh keputusan operator)

Jalur live baru menolak, bukan membesarkan, order < 5 share. Dengan `BANKROLL=45,31` dan `MAX_BET_AMOUNT_USD=2,5`:

* harga 0,62 → `floor(2,5/0,62)=4` share ⇒ **ditolak** (log: "BUY rejected before signing: size 4 shares is below the market minimum of 5");
* agar 5 share muat sampai batas harga entry 68c: 5 × 0,68 = **$3,40** + fee ≈ $0,076 ⇒ `MAX_BET_AMOUNT_USD` perlu **≥ ~3,5**;
* alternatif env-only: `FOK_MIN_SHARES_LOW=5` (default 3) — mekanisme "FOK confidence-tier bump" (`tradePipeline.ts:486-501`) akan menaikkan ukuran ke 5 share **bila** 5×price ≤ 15% bankroll (di $45 → $6,79, jadi lolos), tetapi bump hanya berlaku untuk LOW; MEDIUM/HIGH/VERY_HIGH sudah 5/6/7.
* **Dua-duanya mengubah seleksi trade** ⇒ aturan proyek: deploy yang mengubah seleksi **me-restart eval window** (`EVAL_WINDOW_START`). Jadi keputusan sizing harus diambil **sebelum** me-restart window, bukan sesudah.
* Catatan: dry-run tetap membukukan stake < 5 share (tidak berubah byte-per-byte), jadi **live dan dry-run akan berbeda** sampai sizing disamakan.

---

## 3. RTDS deprecation & migrasi PolyBolt

### 3.1 Deadline — terverifikasi

Kutipan resmi `docs.polymarket.com/migrate/rtds-to-polybolt` (dibaca 2026-10-18 via DoH):
> "PolyBolt support starts in `@polymarket/client` version `0.11.0`. **Deprecated RTDS price topics are planned for removal one month after the `0.11.0` release.**"

Registry npm (dibaca 2026-10-18): `@polymarket/client` **0.11.0 terbit 2026-09-23T13:25:49Z**. ⇒ **perkiraan removal ~2026-10-23**, yaitu **≈5 hari dari sekarang**. (Versi SDK itu sendiri sudah 0.13.0 sejak 2026-10-09; yang jadi patokan tetap tanggal rilis 0.11.0.) Kalimat "planned"/"expected" berarti tanggal bisa bergeser — perlakukan sebagai **soft deadline 23 Okt**, bukan kontrak.

### 3.2 Apa yang dipakai bot dari RTDS (dua feed, bukan satu)

| Modul | Topic RTDS | Dipakai untuk |
|---|---|---|
| `bot/src/streams/chainlinkTwap.ts` (+ `rtdsTickFeed.ts`, `tickStore.ts`) | `crypto_prices_twap_sixty`, filter `{"symbol":"btc/usd"}` | **PTB** (tick di detik pertama jendela) & TWAP penutup; sumber "exact" `chainlink_twap` |
| `bot/src/streams/polymarketLiveWs.ts` | `crypto_prices_chainlink` | Chainlink **spot** + tick bertimestamp untuk estimasi TWAP menit terakhir (`settlePrice.ts`) |

Sumber lain tetap ada: `binanceWs` (BTC/USDT, dipakai hanya setelah dikoreksi basis), `chainlinkWss` (on-chain `latestRoundData()` tiap 15 s via Polygon RPC), dan adapter Data Streams (opsional).

### 3.3 Status kode: **belum ada migrasi sama sekali**

```
grep -ri "polybolt|ws-live-v2|price.crypto|op:auth" repo   → hanya 1 hit: catatan CLAUDE.md
```
Artinya: tidak ada klien PolyBolt, tidak ada auth `op:auth`, tidak ada channel `price.crypto.twap`. Yang ada hanyalah **catatan** di CLAUDE.md bahwa migrasi ini tertunda.

### 3.4 Fallback API PTB — bagaimana bekerja tanpa RTDS (sudah ada di main)

1. `ptbResolver.ts` mulai dari batas jendela: cek tick store tiap 250 ms; pada +2,5 s minta `replay()` (subscribe ulang memutar ~60 s terakhir); mulai +3 s **juga** memanggil `adapters/twapWindowPrice.ts`:
   `GET https://polymarket.com/api/crypto/crypto-price?symbol=BTC&eventStartTime=<ISO>&variant=fifteen&endDate=<ISO>&twapEnabled=true&twapLookbackSeconds=60` ⇒ `openPrice` = **PTB exact**.
   Dua parameter `twapEnabled/twapLookbackSeconds` itu wajib — tanpanya endpoint menjawab **spot** (jebakan yang sudah didokumentasikan).
2. Endpoint tidak resmi, di-cache ~10 s, rate-limit 429 → panggilan diberi jarak ≥5 s proses-wide, backoff 30 s saat 429.
3. Menyerah setelah 5 menit → jendela **tidak ditradingkan** (gate entry mensyaratkan sumber exact).
⇒ PTB tetap **exact**, hanya **beberapa detik lebih lambat** (+3–8 s) daripada tick RTDS yang datang ~0,7–1,3 s setelah batas jendela.

**Yang tidak tercakup fallback (risiko nyata bila RTDS hilang sebelum migrasi):**
* **Tick TWAP detik-per-detik / tick penutup**: `settlement.ts` membandingkan TWAP tick di detik terakhir jendela (tunggu ≤3 s) dengan PTB; tanpa RTDS tick itu tidak ada ⇒ jatuh ke spot (Chainlink/basis Binance) ⇒ beberapa settlement `price_fallback` salah arah di sekitar batas, lalu **dikoreksi** `fallbackVerifier` mulai +90 s dari Gamma/CLOB. Jadi P&L harian dry-run akan makin "provisional", bukan macet.
* **Estimasi TWAP menit terakhir** (`settlePrice.ts`, dipakai filter/cut-loss/limit): kehilangan tick Chainlink per detik; pakai `chainlinkWss` (resolusi 15 s) atau Binance−basis ⇒ estimasi kurang presisi di <60 s terakhir.
* **Sinyal/fitur**: TIDAK terpengaruh — fitur ML v2 berbasis Binance dan PTB; PTB tetap exact via API.
* **Eval window**: kalau removal terjadi di tengah window 300 trade, volume dan komposisi entry berubah (PTB telat beberapa detik ⇒ fase EARLY berubah) ⇒ window **terkontaminasi**; lebih baik migrasi **sebelum** atau catat tanggal pemisah.

### 3.5 Kebutuhan migrasi PolyBolt (dari dokumentasi resmi, dibaca 2026-10-18)

| Hal | Detail |
|---|---|
| Endpoint | `wss://ws-live-v2.polymarket.com/ws` (RTDS: `wss://ws-live-data.polymarket.com`) |
| Auth | Baru: kirim `{"op":"auth","rid":"a1","auth":{"apiKey","secret","passphrase"}}` (kredensial CLOB L2 — bot **sudah punya**), tunggu `{"op":"authed"}`; error `auth_required/auth_invalid/auth_unavailable` |
| Channel TWAP | `price.crypto.twap`, filter `{"symbol":"btcusd","window_seconds":60}` (RTDS: `crypto_prices_twap_sixty` + `{"symbol":"btc/usd"}`) |
| Channel spot | `price.crypto`, filter `{"symbol":"btcusd"}` (Chainlink default; bisa `provider:"pyth"`) |
| Subtle | simbol **lowercase** `btcusd` (bukan `btc/usd`); `window_seconds` hanya 60 (tidak ada pengganti TWAP 30 s) |
| Envelope | `{"v":1,"channel","seq","ts","snapshot"?,"dropped"?,"payload"}`; payload live `{symbol,value,full_accuracy_value,timestamp,source}`; snapshot berisi **2 menit terakhir** `payload.data[]` |
| Jebakan | nilai lama TWAP RTDS E18 fixed-point; PolyBolt = **decimal string** — jangan konversi E18; timestamp ms; heartbeat: server ping tiap 25 s (bukan teks `PING` 5 s); batas 64 subscription, 20 frame/s, frame 64 KB, 8 auth/connection; close 4001/4002/4003/4008 |
| Keuntungan | snapshot 2 menit menggantikan trik `replay()` untuk ~3% detik yang hilang; `seq`/`dropped` mendeteksi frame hilang |

**Estimasi implementasi: 2–3 hari** (feed generik baru ~300–400 baris + auth/seq + test, adaptor ke `tickStore`, wiring 2 feed, pertahankan fallback API, deploy dry-run). Bisa lebih cepat karena `rtdsTickFeed.ts` sudah dipisah rapi di balik antarmuka (topic/symbol) dan `tickStore` tidak berubah.

**Alternatif sadar-risiko (jika 5 hari tidak cukup):** biarkan fallback API berjalan, dan perbaiki dua hal minimal — (a) tambahkan alert saat `ptbResolver` jatuh ke `polymarket_twap_api` (saat ini hanya tercatat di source mix `ptb_health.jsonl`), (b) catat tanggal kontaminasi eval window di laporan evaluasi. Ini **tidak** menyelesaikan hilangnya tick spot/TWAP penutup.

---

## 4. Triage backlog (relevan vs usang)

| Item | Tanggal | Isi | Status |
|---|---|---|---|
| `bugs.txt` | 2026-02-16 | Audit 24 bug logika pada codebase **`.js`** (EdgePanel.jsx, clobClient.js, positionTracker.js…) — H1 threshold terbalik, H2 GTC partial fill, H3 fee ARB, H4 WS race | **USANG sebagai daftar kerja.** Codebase sekarang TS-first; H2 sudah FOK, H4 sudah make-before-break, H3 sudah diganti fee CLOB V2. Simpan sebagai arsip sejarah saja |
| `error.txt` | 2026-02-20 | Log konsol browser: `PositionPanel.jsx useRef is not defined`, WS `ws://localhost:3099` gagal | **USANG.** File `.jsx` sudah tidak ada (TSX); WS URL kini lewat helper `botWsUrl` |
| `ERROR LIMIT ORDER CANCELED.txt` | 2026-03-04 | Log GTD limit order dicancel (era V1, sebelum fee V2) | **USANG/low.** `LIMIT_ORDER_ENABLED=false` di produksi; kalau jalur limit dihidupkan lagi, yang relevan justru aturan baru GTD ≥180 s di branch V2 |
| `docs/TIER1_AUDIT_REPORT.md` | 2026-05-14 | `tsc --checkJs` atas 294 error di file JS; 3 kritis (TDZ) | **USANG.** Repo sudah TS + CI typecheck; laporan ini menggambarkan kode yang sudah tidak ada |
| `docs/BANKROLL_TRACKER_FIX_PLAN.md` | 2026-06-20 | Rencana menambah saldo USDC.e on-chain ke bankroll pUSD (issue #37) | **SUDAH DIIMPLEMENTASI** di main: `clobClient.ts` punya `readUsdceOnChain()` via `polygonRpcUrl()` dan menjumlahkannya ke `balanceCache.balance`. Dokumen bisa diarsipkan |
| `docs/V19_OBSERVATION_BASELINE.md`, `V19_TUNING_GUIDE.md`, `V19_VALIDATION_PLAN.md` | 2026-05-14 / 06-20 | Dokumentasi model v19, tools `v19_performance_report`/`tune_v19_config`, aturan tuning | **USANG.** Model live sekarang `20260924-p2-0d88d4`; RL/v19 shadow capture dihapus 2026-09-25; script v19 tidak lagi jadi acuan |
| `insight polymarket/*.txt` + gambar | 2026-02-19 | Catatan riset/thread (dataset 400m trades, dsb.) | **USANG/opsional membaca.** Bukan backlog teknis; tidak ada aksi |
| `paper/Paper_Pipeline_Fitur_v2_BTC15(.revisi).docx` | 2026-09-24 | Laporan riset internal: kebocoran look-ahead, satu feature builder untuk training+live, evaluasi vs harga pasar | **RELEVAN (dokumentasi).** Pakai versi `_revisi`; isinya konsisten dengan CLAUDE.md. Bukan item kerja |
| `docs/RAILWAY.md`, `docs/DOCKER_STACK.md` | 2026-09-26 / 09-07 | Setup Railway (termasuk `TAPE_S3_*`) dan stack Docker lokal | **RELEVAN** (rujukan operasional) |
| `CLAUDE.md` §"Go-live blockers 2026-09-26" | 2026-09-29 | 4 blocker (SDK V2, min size, fee, reconciler) | **RELEVAN** — statusnya diperbarui di §2 laporan ini |
| Eval window `EVAL_WINDOW_START=2026-09-26T18:08Z`, `EVAL_TARGET_TRADES=300` | env | Uji forward realism-fill WR vs breakeven | **RELEVAN, tapi terpotong** bot mati 2026-10-18 14:27Z; deploy yang mengubah seleksi (sizing/V2/RTDS) **me-restart** window |
| Maker-fill study (`makerFillStudy.py`) | 2026-09-26 | Sinyal ENTER sebagai resting bid vs FOK: fill ~60% dalam 15 s, hemat 1c + fee, adverse selection belum terjawab | **RELEVAN, tunggu data.** Butuh ~7 minggu tape; tape mulai 2026-09-24 ⇒ **sekitar 2026-11-12**. Lokal tidak ada file tape (0 file) — data ada di bucket R2 (`poly15btc`), ditarik `npm run tape:pull` |
| `%SystemDrive%/` (dir untracked di root repo) | — | Artefak perintah yang salah (terlihat di `git status`) | **Housekeeping** (bukan prioritas; jangan dihapus sebelum dicek isinya) |

---

## 5. Roadmap P0 / P1 / P2

Bobot: **P0** = menghalangi go-live / tidak ada fallback; **P1** = deadline eksternal atau kualitas evaluasi; **P2** = nilainya belum waktunya / housekeeping.

| # | Item | Effort | Risiko bila tidak | Deadline | Urutan |
|---|---|---|---|---|---|
| **P0-1** | Merge `feat/clob-v2` → main: selesaikan 2 konflik (port `tokenId` validation + `_POLYGON_RPC`), jalankan `typecheck` + `vitest` penuh, review semantik file auto-merge | **0,5–1 hari** | Tanpa ini tidak ada jalur order live valid sama sekali (V1 ditolak CLOB: `/version=2`); bot hanya bisa dry-run | sebelum go-live | 1 |
| **P0-2** | Sizing vs minimum 5 share: putuskan `MAX_BET_AMOUNT_USD` ~3,5 **atau** `FOK_MIN_SHARES_LOW=5`; sadari ini mengubah seleksi ⇒ restart `EVAL_WINDOW_START` | **1–2 jam** + keputusan | Order live 4 share ditolak; trade hilang / log penolakan berulang | sebelum smoke test | 2 |
| **P0-3** | Rantai operator pUSD: wrap USDC.e→pUSD, `pUSD.approve(CTF Exchange V2, max)`, `CTF.setApprovalForAll(CTF Exchange V2, true)` dari funder/Safe; lalu `clobV2Preflight.mts` sampai `OK wallet ready` | **0,5 hari** (butuh operator + dana + jaringan non-blokir/Railway) | Gate startup fails-closed: bot live **exit(1)** | sebelum smoke test | 3 (paralel P0-1) |
| **P0-4** | Smoke test 5 share: (a) post-only GTD rest-and-cancel, (b) FOK 5 share; catat `makingAmount` vs Δ pUSD on-chain + `usdcSize` data API | **1–2 jam** | Tidak ada bukti signing/posting V2 benar; blocker #4 tidak bisa diputuskan | sebelum flip live | 4 |
| **P0-5** | `journalReconciler` fee: pakai hasil P0-4; jika `usdcSize` tidak fee-inclusive, kurangi fee (`shares×0,07×p×(1−p)`) di `netPnl` atau jangan biarkan reconciler menaikkan bankroll | **0,5–1 hari** | Bankroll live terinflasi ≈ fee per trade; P&L rekonsiliasi vs lokal tidak cocok → evaluasi live bias | sebelum/tak lama setelah live | 5 |
| **P1-1** | Migrasi RTDS → PolyBolt: feed baru (auth `op:auth`, channel `price.crypto.twap` + `price.crypto`, simbol `btcusd`, decimal string, seq/dropped, snapshot 2 menit), wiring 2 feed, pertahankan fallback API | **2–3 hari** | PTB turun ke API (exact tapi +3–8 s); tick spot/TWAP penutup hilang → settlement lebih sering `price_fallback`; eval window terkontaminasi | **~2026-10-23 (5 hari)** | 6 — **harus mulai sekarang**, sejajar P0 |
| **P1-2** | Resume service bot (redeploy main / merge) + re-baseline eval window; keputusan operasional ada di laporan Tugas A | 0,5 hari | Bot tetap mati sejak 2026-10-18 14:27Z: tidak ada data evaluasi baru | sesegera mungkin | tergantung keputusan operator |
| **P1-3** | Verifikasi feed: alert saat PTB jatuh ke `polymarket_twap_api` dan saat feed RTDS diam (sudah ada log backoff, belum ada alert Telegram) | 0,5 hari | Kehilangan RTDS tidak terdeteksi sampai window tidak ditradingkan | sebelum 10-23 | bersama P1-1 |
| **P2-1** | Maker-fill study final (resting bid vs FOK, adverse selection) saat tape ~7 minggu | 1–2 hari analisis | Keputusan maker vs taker tertunda; hemat 1c + fee per trade berpotensi | **~2026-11-12** | setelah eval window |
| **P2-2** | Keputusan retrain / rule re-selection setelah eval window 300 trade | 1–2 hari | Model makin tua (cutoff 2026-09-23); tapi bukti 2026-09-26: retrain tidak menambah edge, rule & model harus sepasang | setelah 300 trade | setelah P1-2 |
| **P2-3** | Housekeeping: arsipkan dokumen usang (§4) ke `docs/archive/`, bersihkan `%SystemDrive%/`, perbarui `CLAUDE.md` setelah merge V2 & RTDS | 0,5 hari | Kebingungan operator baru; bukan risiko trading | kapan saja | terakhir |

### Urutan eksekusi yang disarankan
```
Hari 1        : P0-1 merge+konflik+CI,  P1-1 mulai (feed PolyBolt),  P0-3 mulai (dana/approval)
Hari 1-2      : P0-2 sizing decision → P0-4 smoke test → P0-5 reconciler
Hari 2-4      : P1-1 selesai + P1-3 alert → deploy DRY_RUN (main sudah termasuk V2? lihat keputusan #1)
Hari 4-5      : P1-2 resume eval window (set EVAL_WINDOW_START baru) → monitoring
Setelah 23 Okt: verifikasi RTDS memang hilang / PolyBolt stabil; sesuaikan source mix PTB
~12 Nov       : P2-1 maker-fill study, lalu P2-2 retrain decision
```
**Paralelisasi aman:** P0-3 (operator/dana) dan P1-1 (kode feed) tidak menyentuh file yang sama; P0-1 dan P1-1 sama-sama menyentuh `bot/index.ts`/`CLAUDE.md` ⇒ sebaiknya satu orang/urutan (merge V2 dulu, lalu RTDS).

---

## 6. Keputusan yang dibutuhkan operator

1. **Lane prioritas:** (a) merge V2 lalu deploy supaya jalur live valid, atau (b) nyalakan ulang bot dry-run **sekarang** dari main (tanpa V2) untuk lanjut mengumpulkan data evaluasi, V2 menyusul. (b) mempertahankan window berjalan tetapi memperpanjang risiko RTDS; (a) menunda data tapi menyelesaikan blocker.
2. **Anggaran per trade:** terima `MAX_BET_AMOUNT_USD` naik 2,5 → ~3,5 (+40% risiko/trade, perlu 5 share) **atau** `FOK_MIN_SHARES_LOW=5` (seleksi berubah, volume turun) **atau** biarkan live menolak trade kecil (live dan dry-run tidak setara). Pilih satu; ukur dampaknya ke eval window.
3. **pUSD:** berapa USDC.e yang di-wrap ke pUSD dan dari wallet mana (EOA vs Safe `POLYMARKET_PROXY_ADDRESS`)? Siapa yang mengirim 2 transaksi approval?
4. **RTDS go/no-go:** setuju mengerjakan migrasi PolyBolt sebelum 23 Okt (2–3 hari) — atau menerima fallback API + alert dan menandai eval window setelah 23 Okt sebagai terkontaminasi?
5. **Apakah go-live (DRY_RUN=false) memang target setelah V2 selesai**, atau tetap dry-run sampai window 300 trade selesai? (Semua blocker di §2 tetap harus ditutup sebelum `DRY_RUN=false`.)
6. **Siapa yang menjalankan preflight/smoke test** dari lingkungan non-blokir (Railway shell) — mesin ini tidak bisa (TLS ISP diintersepsi).

---

## 7. Lampiran: perintah & bukti ringkas

```text
# Branch & diff
git log --oneline main..feat/clob-v2        → 78c127a, 8ba2108
git diff --stat main...feat/clob-v2         → 22 files, +2846 / -271
git worktree list                           → worktree agent-acc1e931b8bdfa89a 8ba2108 [feat/clob-v2]

# Uji (di worktree)
npm run typecheck                           → exit 0 (frontend, bot, bot.core, scripts)
npx vitest run                              → 832/834; 2 timeout (cold cache + tsc paralel)
npx vitest run bot/src/trading/__tests__/clobClient.v2.test.ts → 15/15 lulus (5,36 s)

# Merge readiness
git merge-base main feat/clob-v2            → 43dfca4
git log --oneline feat/clob-v2..main        → 6 commit (audit 2026-09-29)
git merge-tree --write-tree --name-only main feat/clob-v2 → exit 1
  CONFLICT bot/src/trading/clobClient.ts
  CONFLICT bot/derive-credentials.ts

# Live, read-only (via DoH helper repo; 2026-10-18 15:21Z)
GET https://clob.polymarket.com/version      → {"version":2}
GET gamma /markets/slug/btc-updown-15m-1792336500
   → orderMinSize=5, orderPriceMinTickSize=0.01, negRisk=false,
     feeSchedule {rate 0.07, exponent 1, takerOnly true, rebateRate 0.2}
GET clob /book?token_id=<UP>
   → tick_size=0.01, min_order_size=5, bid 0.61 / ask 0.62

# RTDS → PolyBolt
docs.polymarket.com/migrate/rtds-to-polybolt → "removal one month after the 0.11.0 release"
registry.npmjs.org/@polymarket/client         → 0.11.0 = 2026-09-23T13:25:49Z  ⇒ ~2026-10-23
registry.npmjs.org/@polymarket/clob-client-v2 → latest 1.2.0 (2026-09-25)
grep -ri "polybolt|ws-live-v2|price.crypto|op:auth" repo → 0 implementasi (hanya catatan CLAUDE.md)
```

**Keterbatasan / yang tidak saya lakukan:** tidak merestart/redeploy/mengubah apa pun di Railway; tidak menyentuh kode, config, atau `.env`; tidak menjalankan trading/preflight/smoke test (butuh kredensial + jaringan non-blokir); tidak mencetak nilai secret apa pun (hanya nama variabel). Angka live diambil lewat GET read-only.
