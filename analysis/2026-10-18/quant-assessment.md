# Asesmen Kebutuhan Quantitative Finance — PolyBTC15

**Tugas C (quant-eval) · 2026-10-18 · READ-ONLY (tidak ada perubahan kode/config/deployment)**
Sumber utama: `CLAUDE.md` (bagian riset), `ml_registry/journal.jsonl` (88 event, 10 `evaluated`), `ml_registry/MODELS.md`, `bot/data/railway/trade_journal.jsonl` (458 baris, snapshot 2026-09-24T00:52Z), `bot/data/railway/state.json`, tape lokal `backtest/ml_training/tape/2026-09-24..27`, dan fakta log live dari BRIEF (Tugas A).

---

## Ringkasan eksekutif

**Jawaban singkat: tidak, bot ini TIDAK butuh quantitative finance yang sangat intens.** Bukti yang ada justru menunjukkan pasar 15-menit sudah efisien terhadap informasi yang tersedia: model ML v2 kalah dari harga pasar segar (Brier skill −1,4% s/d −2,5%), studi residual/stacking hanya menambah ~0,5–0,8% Brier skill (≈0,0014 nats, CI melewati 0), dan 211 varian aturan entry tidak ada yang mengalahkan aturan sekarang. Yang tersisa bukan masalah model, melainkan (i) biaya eksekusi yang besar relatif terhadap edge, (ii) sampel yang terlalu kecil untuk menyimpulkan apa pun, dan (iii) disiplin evaluasi/risiko.

Angka inti (dihitung ulang sendiri dari journal, bukan dikutip):

| Metrik | Nilai | Catatan |
|---|---|---|
| Trade dry-run v1 (2026-09-07..09-23) | 458 (448 directional + 10 premarket) | semua `dryRun`, 455/458 settlement terverifikasi |
| WR semua 458 | **67,0%** (Wilson 95% 62,6–71,2%) | |
| Breakeven biaya-tertimbang (fee resmi) | **64,5%** | `p + 0.07·p·(1−p)`, rata-rata harga 63,4c |
| Margin WR vs breakeven | **+2,5pp** | belum signifikan |
| PnL booking lama (fee lama) | **+$11,18** | termasuk premarket −$19,88 |
| PnL dengan fee taker resmi CLOB V2 | **−$1,86** | fee resmi = 2,52% turnover vs booking lama 0,63% |
| PnL directional (448), fee resmi | **+$19,42**, ROI agregat **+3,2%**, mean ROI/trade **+4,1%** | 95% CI mean ROI −2,8%..+11,0% (day-block: −1,6%..+10,2%) |
| Premarket long (10) | WR 30%, PnL −$19,88 (−47,6% ROI) | sudah dimatikan 2026-09-20; benar dimatikan |
| Klaim vs realisasi edge | klaim P(win) 86,0% vs aktual 67,0% vs harga 63,4%; klaim edge 22,9pp vs realisasi 3,7pp (**rasio 0,16**) | sama dengan evaluasi 2026-09-24 (24pp vs 4,1pp, rasio 0,17) |
| Target evaluasi 300 trade | **terlalu kecil** | n=300 → CI ROI ±8,4pp; butuh 540–680 trade untuk edge 8–10% (80% power), ~1.570–3.200 untuk WR vs breakeven |

**Level kuant yang dibutuhkan:** statistik terapan + studi mikrostruktur terbatas — sekitar **0,3–0,5 FTE selama 4–6 minggu** (5–10 hari-orang), bukan tim quant penuh, bukan deep learning/RL, bukan HFT. Prioritas kerja: (1) evaluasi statistik & forward test yang benar, (2) studi maker/adverse selection setelah tape 7 minggu, (3) kalibrasi risiko/position sizing. Yang sebaiknya **tidak** dilakukan: model/ML lebih dalam, retrain sekarang, rule mining tambahan, menaikkan size sebelum bukti, membeli data/infrastruktur mahal.

---

## 1. Data, metode, dan batasan

**Yang saya pakai:**
- `bot/data/railway/trade_journal.jsonl` — 458 baris, `enteredAt` 2026-09-07T08:19Z s/d 2026-09-23T19:33Z, semua `entry.dryRun=true`; `fillModel`: 380 baris lama tanpa model fill, 78 baris `fok_limit` (sejak 2026-09-20); `exit.source` semuanya `price_fallback` (provisional), `verifiedSource`: 327 `gamma_oracle` + 128 `oracle` + 3 belum; outcome memakai `exit.verifiedOutcome` bila ada.
- `bot/data/railway/state.json` — bankroll $56,49, totalTrades 458, 307W/151L (konsisten: 45,31 + 11,18 = 56,49; env `BANKROLL=45.31`).
- `ml_registry/journal.jsonl` + `MODELS.md` — 88 event (23 registered, 24 deployed, 23 retired, 10 evaluated, 7 note, 1 gate).
- `backtest/ml_training/tape/` — tape lokal hanya 2026-09-24 s/d 09-27 (±3,5 hari, ±80 file jam).
- Fakta live dari BRIEF (Lead): container berhenti 2026-10-18 14:27Z; log terakhir bankroll $57,40, trades 744 (481W/263L), daily P&L −$3,91; env `EVAL_WINDOW_START=2026-09-26T18:08Z`, `EVAL_TARGET_TRADES=300`.

**Formula yang dipakai (diverifikasi ulang):**
- Payout settlement per share = $1 bila menang, $0 bila kalah; `cost = shares × p_fill`.
- Fee taker CLOB V2 (resmi): `fee = shares × 0.07 × p × (1−p)`, dibayar saat match, menang maupun kalah (dokumentasi Polymarket; Gamma `feeSchedule rate 0.07, takerOnly, rebateRate 0.2`).
- Breakeven WR: `p + 0.07·p·(1−p)` (mis. 61,68% di 60c; 65,3% di 63,7c).
- ROI/trade = `(payout − cost − fee)/cost`; CI 95% normal + day-block bootstrap (17 hari) untuk korelasi dalam hari.
- Booking lama diverifikasi cocok: `PnL = (shares−cost)·(1 − 0.072·p·(1−p))` bila menang, `−cost` bila kalah (selisih maksimum hanya pembulatan $0,005/baris). Booking lama **hanya membebankan fee pada profit kemenangan** — karena itu overstate PnL.

**Batasan penting (jujur):**
1. **Journal lokal adalah era model v1**, berhenti 2026-09-24T00:52Z — 37 menit sebelum model v2 deploy (01:29Z). Journal 2026-09-24 s/d 2026-10-18 tidak ada di mesin ini; container mati sehingga volume tidak terbaca dari sisi saya (itu ranah Tugas A). Fakta live 10-18 di atas dipakai sebagai **derivasi**, bukan hitungan baris-per-baris.
2. Angka live derivasi: 744−458 = **286 trade baru, 174W/112L = WR 60,8%**; bankroll 56,49 → 57,40 = **+$0,91** (~+0,2%/trade bila stake rata-rata $1,4–2,0). Dengan WR 60,8%, PnL ±0 hanya konsisten bila harga entry rata-rata tersirat ≈ **59c** (breakeven ≈60,7%) — yaitu **tepat di breakeven**. Ini indikasi, bukan kesimpulan: journal penuh (harga entry, stake, fee per baris) wajib diekstrak sebelum dipakai.
3. Sampel 458 trade berasal dari 17 hari dan tidak independen (regime BTC, sesi, jam). Karena itu semua CI utama memakai day-block bootstrap.
4. Backtest yang ada memakai harga print per detik (bagus: age median 1s, p90 8s) tetapi dengan asumsi biaya +1c; fill live belum pernah diuji dengan order nyata (dry-run tidak mengirim order).

---

## 2. Hasil hitungan journal (bukti utama)

### 2.1 Segmen

| Segmen | n | WR | Breakeven | Margin | PnL booking lama | PnL fee resmi | ROI agregat | Mean ROI/trade |
|---|---|---|---|---|---|---|---|---|
| Semua | 458 | 67,0% | 64,5% | +2,5pp | +$11,18 | **−$1,86** | −0,3% | +3,0% |
| Directional (tanpa premarket) | 448 | 67,9% | 65,6% | +2,3pp | +$30,92 | **+$19,42** | +3,2% | +4,1% |
| Premarket long | 10 | 30,0% | 50,3% | −20,3pp | −$19,88 | −$21,28 | −47,6% | −44,5% |
| Fill realistis (`fok_limit`, 78) | 78 | 70,5% | 65,9% | +4,7pp | +$5,96 | +$3,81 | +3,4% | +7,1% (95% CI −9,0%..+23,1%) |
| Entry ≥68c (di luar cap sekarang) | 137 | 75,2% | 73,5% | +1,7pp | +$6,78 | +$3,94 | +2,0% | +2,3% |
| Entry <68c | 321 | 63,6% | 60,6% | +3,0pp | +$4,40 | −$5,80 | −1,3% | +3,3% |

Detail harga entry (directional): mean 63,7c, median 62,5c, q25 59,5c, q75 69,5c, maks 75c; **30,6% trade ≥68c** dan 24,8% ≥70c (padahal cap 68c baru berlaku belakangan — komposisi historis ini tidak akan terulang). Stake rata-rata $1,36.

### 2.2 Stabilitas dan konsentrasi

- Paruh pertama (224 trade): ROI agregat **+0,7%**; paruh kedua: **+5,6%** — arah positif tapi tidak stabil.
- 8 dari 17 hari profit; PnL harian mean +$1,14, sd $4,64.
- Top-5 trade = **36%** dari total PnL directional (+$6,92 dari +$19,42); tanpa top-5 tinggal +$12,50. Artinya edge sangat bergantung pada sedikit trade — konsisten dengan edge tipis.
- Day-block bootstrap (17 hari): mean ROI/trade 95% CI **−1,6%..+10,2%**; ROI agregat **−2,6%..+9,4%**. CI memuat 0.
- Bootstrap 300-trade (dari distribusi empiris): **P(mean ROI < 0) = 17%**, P5 −4,4%, median +2,8%, P95 +12,5%. Jadi bahkan bila distribusi masa lalu berulang, 1 dari 6 jendela 300-trade akan negatif.

### 2.3 Fee adalah biaya terbesar, bukan model

- Directional: laba kotor sebelum fee **$34,76**; fee resmi **$15,34 (2,52% dari turnover $608,24)**; PnL resmi **$19,42**.
- Booking lama hanya membebankan **$3,84 (0,63%)** → PnL lama overstate ~$11,5 pada 448 trade. Fee resmi menggerus sekitar **2,5pp ROI** — setara dengan sebagian besar edge yang diklaim.
- Untuk harga 50–68c, taker fee = 1,52–1,75c/share (2,2–3,5% dari stake). Spread 1c menambah 1,5–2%. Total **~4–5% ROI/trade** hilang ke biaya eksekusi taker — ini lebih besar dari estimasi edge live.

### 2.4 Klaim model vs realisasi

- Klaim P(menang pada sisi yang dibeli) rata-rata **86,0%**; aktual **67,0%**; harga pasar mengimplikasikan **63,4%**. Edge klaim 22,9pp; realisasi WR−harga = **3,7pp**; rasio realisasi/klaim **0,16** (konsisten dengan evaluasi 2026-09-24: 24pp klaim vs 4,1pp realisasi, rasio 0,17).
- Ini bukan bug baru: model v1 memang overconfident; v2 jauh lebih terkalibrasi (klaim 71% vs aktual 68% di 448 instan live), tetapi kalibrasi lebih baik **tidak** berarti edge lebih besar.

---

## 3. Bukti riset yang sudah ada (ringkas, angka kunci)

**Model.** v2 live `20260924-p2-0d88d4`: 14.607 market, test accuracy 76,9%, AUC 0,854, ECE 0,022–0,034; Brier skill **+7,0%** vs harga lookup basi tetapi **−2,1%** vs harga pasar terinterpolasi; di 448 instan entry live: Brier v2 0,2276 vs pasar 0,2166 (skill **−5,1%**). Uji 203.463 market-menit harga segar: v2 **kalah dari fresh price di setiap bulan**, termasuk bulan training (−1,4% s/d −2,5%) → bukan drift. v3 (training harga segar) gagal gate `market_skill` (−1,5%) dan hampir tidak trading; v2 vs v3 tidak berbeda signifikan. Residual/stacking: market-offset XGBoost +0,65% Brier skill (VALIDATE), stacking market 0,72/v2 0,17/fisika 0,13 +0,80%; kalibrasi pasar slope 1,056 (+0,11%) → **pasar sudah terkalibrasi, model hanya menambah sedikit**. Semua studi publik serupa berakhir ~0,0014 nats, CI melewati 0.

**Aturan entry.** `ruleSearch.py`: 211 varian di 3.707 market harga segar, dipilih SELECT, diuji VALIDATE — **tidak ada** yang trading ≥1,5× dengan total PnL ≥ aturan sekarang. Aturan sekarang (v2 + rule live) adalah satu-satunya yang mengalahkan baseline "favorit tanpa ML" di kedua paruh OOS: all-OOS n=230 ROI **+10,7%** CI [+1,3%, +19,5%]; VALIDATE (paruh kedua) n=192 ROI **+8,8%** CI [−1,8%, +18,4%]. Setelah fee resmi: aturan yang dilembutkan (softened 2026-09-26) VALIDATE n=466, WR 63,5%, harga bayar 58,1c, ROI **+6,5%** CI [+0,8%, +12,6%] (fee lama: +8,6% CI [+2,9, +14,3]). **Live v1 448 trade dengan fee resmi: ROI +3,2%** (di bawah backtest, konsisten dengan rasio klaim/realisasi ~0,2).

**Studi TWAP.** Membeli "leader" TWAP di 30–60 detik terakhir: VALIDATE ROI +3,5% CI [−7,3%, +13,6%] (n=99, latensi 2 detik) — tidak berbeda dari baseline favorit; +2c biaya menyisakan ~+1%. Model fitur TWAP: tidak ada edge di jendela 2–12 menit; ~8% Brier skill hanya di 15–60 detik terakhir, di mana biaya 1–2c menghapusnya. Fitur ordebook: spread 1c pada 92% snapshot; microprice = mid; imbalance top-5 hanya menambah ~0,001 logloss — **belum ada edge ordebook** pada tape 1 Hz.

**Mikrostruktur/maker.** Studi awal pada tape (baru ±3,5 hari saat itu): order beli pasif (maker) **terisi ~60% dalam 15 detik**, menghemat 1c spread + fee taker (total ~4–5% ROI/trade di 58–60c); **adverse selection belum terukur** (butuh ~7 minggu tape). Ini satu-satunya sumber perbaikan yang berpotensi sebesar edge itu sendiri — tapi belum terbukti.

**Monte Carlo.** Backtest 500 trade, stake tetap, bankroll $56: P(loss) 0,0–0,8%, maxDD p95 23,8–32% — **tetapi** resample hanya satu bulan yang menguntungkan (bahkan baseline tanpa ML +4,8%); jadi angka ini menggambarkan "jika edge seperti bulan itu", bukan risiko unconditional. Dengan edge 0, P(loss 500 trade) ≈ 50%.

**Training/retrain.** Recency tidak menambah apa pun (Δ Brier +0,0003 CI [−0,0006, +0,0012]); window lebih panjang menghasilkan probabilitas lebih baik tetapi **PnL aturan lebih kecil** (180d +$40,3 vs 240d +$11,5 vs 287d +$6,7); perbaikan early-stopping menghasilkan model lebih terkalibrasi tetapi butuh rule baru (269 trade +$21,2 vs 466 trade +$40,1). Kesimpulan riset: **jangan retrain sekarang**.

---

## 4. Power analysis: 300 trade cukup atau tidak?

Unit analisis: ROI per trade dari 448 trade directional (fee resmi). **sd ROI/trade = 74,6%**, mean +4,09%, SE = 3,53pp.

| n | 95% CI half-width | Lebar CI | MDE (80% power, 2 sisi) |
|---|---|---|---|
| 150 | ±11,9pp | 23,9pp | 17,1pp |
| **300** | **±8,4pp** | **16,9pp** | **12,1pp** |
| 500 | ±6,5pp | 13,1pp | 9,3pp |
| 1.000 | ±4,6pp | 9,3pp | 6,6pp |

**Power pada n=300** (uji dua sisi 5%): edge sejati +4,1% → **16%**; +6,5% → **33%**; +8,6% → **51%**; +10% → **64%**. Artinya dengan target 300 trade, peluang "berhasil membuktikan" edge 8–10% hanya sekitar **½ hingga ⅔** — seperti melempar koin.

| Edge sejati (ROI) | n untuk 80% power | n agar 95% CI lower > 0 (dengan mean observasi) |
|---|---|---|
| +5% | ~1.750 | ~1.280 (mean +4,1%) |
| +8% | ~685 | — |
| +9% | ~540 | — |
| +10% | ~440 | — |
| +4,1% (live) | ~2.960 | ~1.280 |

**Perbandingan dua aturan** (deteksi beda 5pp ROI, 80% power): **~3.500 trade per arm** (konsisten dengan catatan riset "~4.000 per arm").

**Uji berbasis WR** (seperti laporan evaluasi sekarang, Wilson CI vs breakeven): margin live v1 hanya +2,3pp; perlu **~1.570 trade (95%) / ~3.200 trade (80% power)** agar CI WR melewati breakeven. Pada n=300, half-width ±5,3pp — mustahil menutup margin 2,3pp. Jadi **target 300 trade milik laporan evaluasi tidak akan pernah bisa menyatakan "di atas breakeven" untuk edge sekecil ini**; laporan akan terus bilang "too early" — dan itu benar secara statistik.

**Konsekuensi waktu** (rate live v2 era ~11,6 trade/hari; backtest softened 20,5/hari; v1 26,4/hari):

| Target | Hari @12/hari | Hari @20/hari |
|---|---|---|
| 300 trade | 25 | 15 |
| 600 trade | 50 | 30 |
| 1.300 trade | 108 | 65 |
| 2.000 trade | 167 | 100 |
| 3.500/arm | 292 | 175 |

**Forward slice v2 (derivasi):** 286 trade, WR 60,8%, PnL +$0,91 (≈breakeven bila harga entry tersirat ~59c). Bandingkan dengan backtest VALIDATE +6,5% (n=466): selisih −6,3pp, tetapi SE selisih ≈5,4pp → **z ≈ −1,2, tidak signifikan**. Jadi data forward **belum membuktikan backtest gagal, juga belum mengonfirmasinya**. Yang jelas: point estimate jauh lebih rendah, dan ini perlu diverifikasi dari journal penuh.

**Kesimpulan power:** 300 trade hanya cukup untuk mendeteksi kegagalan besar (mis. ROI ≤ −10%, atau WR jauh di bawah breakeven). Untuk menyimpulkan edge +8–10%, butuh **540–680 trade** (80% power) dan **~1.300 trade** untuk 95% CI di atas 0 pada level edge realistis; untuk WR vs breakeven butuh **1.500–3.200 trade**. Pada 12–20 trade/hari itu berarti **1,5–5,5 bulan** berjalan terus-menerus. Setiap perubahan rule/model/fee me-reset jam — dan sejak 2026-09-24 sudah ada tiga perubahan (v2, fee, softening). Itulah alasan utama kenapa "bukti" akan selalu lambat.

---

## 5. Batasan data yang membatasi seberapa "quant-intens" pekerjaan yang masuk akal

1. **Market 15 menit, 96 market/hari, 4–20 trade/hari.** Sampel lambat (lihat §4), dan trade berkorelasi dalam hari/sesi/regime BTC → butuh day-block/sequential testing, bukan CI iid.
2. **Resolusi TWAP 60 detik, bukan spot.** Outcome ditentukan TWAP 60s; edge "last 15–60 detik" ada (~8% Brier skill) tetapi tidak bisa diambil setelah fee/spread 1–2c. Settlement sering `price_fallback` (provisional; 455/458 terverifikasi belakangan) → kualitas label bergantung verifikasi.
3. **Tape 1 Hz baru mulai 2026-09-24.** Per 2026-10-18 = 24 hari (~3,4 minggu); **file lokal hanya 3,5 hari** — sisanya di bucket (tidak saya unduh: akan menulis file di luar scope laporan dan butuh kredensial). Studi adverse selection butuh **~7 minggu** → paling cepat sekitar **2026-11-12**. Karena bot berhenti 2026-10-18, **jam tape berhenti**; tanpa restart dry-run, data 7 minggu tidak akan pernah terkumpul.
4. **Data training historis terbatas**: lookup Polymarket ~1 print/menit (stale rata-rata 10,6c dari fresh print; >5c di 57% baris). Backtest harga segar (data API per detik) sudah jauh lebih baik, tetapi offset cap 10.000 membuat market tersibuk terpotong; fitur ordebook netral di training; tape 1 Hz terlalu kasar untuk posisi antrean/microburst.
5. **Biaya dan eksekusi**: taker fee 0,07p(1−p) = 2,2–3,5% stake; spread 1c = 1,5–2%; fill dry-run (`fok_limit`) hanya model, bukan fill nyata; `orderMinSize` 5 share padahal stake dry-run rata-rata $1,36 (~2 share) → **sizing live harus berubah** (min $2,5–3,4/trade di 50–68c).
6. **Structural breaks**: migrasi CLOB V2 (SDK/approval/min size), perubahan fee 2026-09-26, softening gate 2026-09-26, deprecation RTDS ~2026-10-23. Sampel historis tidak sepenuhnya sebanding; forward test harus dimulai ulang di tiap perubahan (sudah dilakukan untuk eval window).
7. **Data live penuh tidak dapat saya akses** (container mati; volume tidak terbaca; tugas itu milik Tugas A). Semua klaim tentang 2026-09-24..10-18 di laporan ini adalah derivasi dari 3 angka BRIEF dan harus diverifikasi.

---

## 6. Penilaian opsi kuant (biaya-manfaat)

| Opsi | Biaya | Nilai yang diharapkan | Bukti | Putusan |
|---|---|---|---|---|
| **(a) Model/ML lebih dalam** (deep learning, RL, fitur baru, retrain) | 4–8 minggu orang; risiko overfit | ~0; probabilitas lebih baik tidak menambah PnL aturan | v2 kalah dari fresh price tiap bulan; residual/stacking <1% Brier; RL v19 sudah gagal (saturasi, tidak pernah berfungsi); data 15-menit terbatas | **Jangan** |
| **(b) Eksekusi/mikrostruktur** (maker fill, adverse selection, limit order path) | 2–4 minggu kerja + wajib tunggu ~7 minggu tape | Potensi **+2–4,5pp ROI/trade** (fee 2,2–3,5% + spread 1,5–2%) bila terisi & AS ringan; bisa 0 bila AS besar | fill ~60% dalam 15s (first look 3,5 hari tape); AS belum terukur; limit order manager sudah ada tapi disabled | **Ya — upside terbesar, tapi menunggu data** |
| **(c) Evaluasi statistik/forward test** | 2–5 hari | Mencegah go-live/abandon yang salah; menghitung n yang benar; memisahkan model vs rule vs fee | Laporan evaluasi sekarang berbasis WR Wilson dan target 300; §4 menunjukkan underpowered | **Ya — prioritas #1** |
| **(d) Risiko/position sizing** | 2–3 hari | Membatasi drawdown; menyelaraskan Kelly shrink 0,5 dengan bukti (0,18–0,21); MC dengan edge 0 | Kelly optimal VALIDATE 0,133 (current) / 0,071 (no-ML); MC backtest bias bulan profit; min order 5 share belum masuk hitungan | **Ya — cepat, murah** |

Yang **tidak perlu**: HFT/colocation/latensi rendah (horizon menit; kendala di fee+signal, bukan latensi), data alternatif mahal, model arsitektur baru, leverage/naikkan ukuran, atau menambah market lain sebelum biaya dan eksekusi beres.

---

## 7. Kesimpulan dan pekerjaan konkret 2–4 minggu

**Level kuant yang benar-benar dibutuhkan: "applied quant lite".** Satu orang part-time (0,3–0,5 FTE) dengan kompetensi statistik terapan (bootstrap, CI, power, pre-registration, sequential monitoring) + pemahaman microstructure, dibantu engineer untuk logging. Estimasi total 5–10 hari-orang dalam 2–4 minggu. Tidak perlu PhD quant, tidak perlu research desk, tidak perlu membeli data.

**Rencana 2–4 minggu (konkret, berurutan):**

1. **Minggu 1 — ukur dengan benar (prioritas #1).**
   - Ekstrak journal penuh 2026-09-24..10-18 dari Railway (volume/log) — **Tugas A**; rekonsiliasi counter log (744/481/263) vs bankroll (+$0,91) vs baris journal. Tanpa ini, angka forward tidak bisa dipercaya.
   - Hitung ulang metrik per versi (v1/v2, rule lama/softened, fee lama/resmi) memakai `dryRunReport`/`marginReport`, dengan day-block bootstrap + CI PnL, bukan hanya Wilson WR.
   - Perbaiki `evaluationReport.ts` (record-only, aman): tambahkan CI berbasis PnL, "n needed untuk margin saat ini", subset realistic-fill, dan pemisahan model/rule; jangan mengubah keputusan trading.
   - Tetapkan aturan keputusan **pra-registrasi**: go-live kecil hanya bila realistic ROI 95% CI lower > 0 (n≥600) dan blocker CLOB V2 (SDK, min 5 share, fee di reconciler) ditutup; stop bila CI upper < 0 pada n≥300; jangan menilai per hari/minggu.
2. **Minggu 2–3 — jalankan ulang dry-run & kumpulkan tape (aman, tidak butuh CLOB V2; keputusan restart = Tugas A).** Target: tape menuju 6–7 minggu (dari 2026-09-24 → sekitar 2026-11-12). Jangan pasang maker/limit order live sebelum studi selesai.
   - Saat tape cukup: jalankan `makerFillStudy.py` versi penuh; ukur fill rate per sisa waktu, markout 60s, adverse selection, dan net PnL maker vs taker (termasuk `orderMinSize` 5 share). Ini keputusan biner: maker menghemat ~4% ROI/trade atau tidak.
   - Perluas `decisionTrailStudy.mts` (e) untuk scoring gate forward dengan n yang dilaporkan (jangan menyimpulkan dari n=7–10).
3. **Minggu 3–4 — kalibrasi risiko dan checkpoint keputusan.**
   - Set `KELLY_PROB_SHRINK` 0,18–0,21 (bukan 0,5) atau sizing tetap; hitung ulang MC dengan asumsi edge 0%, 4%, 8%; masukkan korelasi harian, orderMinSize, max stake $2,5, daily loss 15%.
   - Tentukan kill-switch: drawdown bankroll (mis. 20%), 10 loss beruntun, atau ROI CI upper < 0 pada n≥300.
   - Checkpoint minggu 4: lanjut dry-run / go-live kecil / hentikan — berdasarkan aturan pra-registrasi, bukan WR mentah.

**Yang sebaiknya TIDAK dilakukan (eksplisit):**
- **Jangan** deep learning/RL/model arsitektur baru/fitur baru sekarang: bukti market efisien di horizon ini, residual <1% Brier, RL v19 sudah gagal, dan data 15-menit adalah plafon.
- **Jangan** retrain/deploy model: recency tidak menambah; window lebih panjang menurunkan PnL aturan; early-stopping fix butuh rule baru (model+rule harus satu paket).
- **Jangan** menambah rule mining di 3.707 market yang sama: 211 varian sudah diuji, tidak ada yang lebih baik; mengulang di data yang sama = overfitting.
- **Jangan** menaikkan stake/leverage atau go-live penuh sebelum (a) CI dan (b) blocker CLOB V2 selesai; MC backtest bias karena hanya bulan yang menguntungkan; stake dry-run 2 share tidak bisa live (min 5 share).
- **Jangan** menganggap target 300 trade sebagai bukti — itu checkpoint operasional; bukti butuh 540–680 trade untuk edge 8–10% dan ~1.500–3.200 untuk WR vs breakeven.
- **Jangan** membeli data mahal atau infrastruktur HFT: kendala bukan latensi, melainkan fee (2,5% turnover) dan edge tipis.

**Satu kalimat untuk operator:** bot ini sudah cukup "quant" untuk levelnya; yang kurang bukan model yang lebih pintar, tetapi pengukuran yang jujur (sampel, fee, fill) dan satu eksperimen eksekusi (maker fill) yang harus menunggu ±7 minggu tape. Jangan tambah kompleksitas model sebelum biaya eksekusi dan bukti statistik dibereskan.

---

### Lampiran — sumber & perintah yang dipakai
- Baca: `CLAUDE.md` (baris riset: 50–52 maker/micro/residual; 164–181 model/gate; 187–189 softening; 244 fee), `ml_registry/journal.jsonl` (10 `evaluated`, 7 `note`), `ml_registry/MODELS.md` (tabel 23 model; v2 live, v3 candidate), `bot/src/monitoring/evaluationReport.ts`.
- Hitung (Node 25, read-only): parse `bot/data/railway/trade_journal.jsonl` (458 baris) → agregasi per segmen, bucket harga, CI Wilson, bootstrap 20.000–50.000 draw (seed mulberry32), day-block 17 hari, power normal-approx; parse `ml_registry/journal.jsonl` (88 event); verifikasi model booking lama (maks selisih $0,005).
- Fakta live 10-18 diambil dari `analysis/2026-10-18/BRIEF.md` (hasil verifikasi Lead), bukan dari akses langsung ke Railway.
- Tidak ada nilai secret (private key/API key/token/password) yang dibaca, dicetak, atau ditulis dalam laporan ini. Tidak ada perubahan pada kode, config, .env, deployment, atau service Railway.
