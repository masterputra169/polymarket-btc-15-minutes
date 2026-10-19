# Brief Tim: Cek Kondisi Bot PolyBTC15 - 2026-10-18

## Konteks umum
- Pemilik: operator (MasterPutra6969). Pertanyaan user: cek kondisi bot, apakah ada update ke depan, apakah perlu quantitative finance yang sangat intens.
- Repo: A:\PolyBot BTC15\PolyBTC15. Windows, Node 25. Akses file penuh, approval prompt dimatikan (jangan pernah minta sandbox escalation).
- Tanggal: 2026-10-18 (Asia/Jakarta). Git HEAD abc1b56 (2026-09-29), working tree bersih; tidak ada commit baru selama 19 hari.
- Bot: trading bot Polymarket BTC 15 menit, mode DRY_RUN=true, di Railway (project polybtc15, environment production, service bot). Railway CLI sudah login di mesin ini.

## Fakta awal yang sudah terverifikasi Lead (2026-10-18)
- Container bot berhenti hari ini pukul 14:27:22 UTC (log: SIGTERM received, graceful shutdown, Stopping Container).
- Ringkasan sesi terakhir di log: Bankroll $57.40, Daily P&L -$3.91 (-6.4%), Trades 744 (481W/263L = 65%).
- Deployment yang berjalan: 3ae0876e (commit abc1b56, dibuat 2026-09-29 07:58 UTC, volume mount /app/bot/data) sekarang berstatus REMOVED.
- railway status menunjukkan latestDeployment service bot = cdddb941, status FAILED, dibuat 2026-09-24, error "Failed to create code snapshot" - ini aneh dan perlu diklarifikasi.
- Service lain: Redis SUCCESS, Postgres SUCCESS, frontend tanpa status deployment.
- Env Railway penting: DRY_RUN=true, EVAL_WINDOW_START=2026-09-26T18:08:00Z, EVAL_TARGET_TRADES=300, BANKROLL=45.31, TZ=Asia/Jakarta, TAPE_S3_BUCKET=poly15btc, MAX_BET_AMOUNT_USD=2.5, MAX_DAILY_LOSS_PCT=15, FILTER_ML_CONF_RELAXED=0.20, FILTER_HIGH_EDGE_BYPASS=0.09, FILTER_BTC_DIST_MIN_PCT=0.01.
- Snapshot data live lama: bot/data/railway/state.json (mtime 2026-09-24, bankroll 56.49, 458 trade, 307W/151L), trade_journal.jsonl (s/d 2026-09-23), ptb_health.jsonl.
- CLAUDE.md adalah dokumen pengetahuan proyek yang sangat lengkap; baca bagian relevan sebelum menyimpulkan.

## Aturan untuk semua anggota
- READ-ONLY pada sistem: JANGAN restart/redeploy/scale/delete deployment atau service Railway, JANGAN ubah kode/config/.env, JANGAN jalankan trading. Jika butuh data live, cari cara baca yang aman.
- Jangan pernah mencetak nilai secret (private key, API key, token, password) ke output atau laporan. Boleh menyebut nama variabel saja.
- Satu-satunya file yang boleh kamu tulis: laporan di analysis/2026-10-18/ sesuai tugas. Jangan sentuh file lain.
- Laporan ditulis bahasa Indonesia, ringkas, berbasis bukti (sertakan perintah/angka/sumber). Akhiri dengan kiriman ringkasan final <=1200 kata ke Lead.
- Jika akses data live tidak mungkin tanpa restart, laporkan hambatannya dan gunakan data lokal/log; jangan memaksa.

## Tugas A - live deployment dan data evaluasi (pemilik: live-status)
Laporan: analysis/2026-10-18/live-status.md
1) Pastikan status live: railway status --json, railway deployment list --json, railway logs --service bot -n 300, railway logs --deployment <id>, Railway GraphQL di https://backboard.railway.com/graphql/v2 (accessToken ada di C:\Users\Asus\.railway\config.json, jangan cetak). Tentukan: apakah bot benar-benar mati, sejak kapan, deployment mana yang terakhir melayani, mengapa berhenti (platform/plan HOBBY/usage limit/error code snapshot/aksi manual), dan apakah ada deploy attempt setelah 2026-09-29.
2) Ambil data evaluasi bila mungkin tanpa restart: railway ssh --service bot -- ls -la /app/bot/data (kemungkinan gagal karena container mati), railway volume list --json, railway volume --help; atau baris laporan evaluasi harian di log (cari Evaluation report / EVAL WINDOW / realistic / Wilson).
3) Bila data live didapat: hitung trade sejak EVAL_WINDOW_START 2026-09-26T18:08:00Z: n, W/L, PnL, WR vs breakeven (fee taker = shares*0.07*p*(1-p)), Wilson 95% CI, trade/hari, split settlement verified vs price_fallback, PTB health (exact %), status feed RTDS/TWAP sampai 2026-10-18, upload tape/S3 19 hari terakhir.
4) Rekomendasi resume: opsi aman menyalakan lagi (railway redeploy vs railway up vs deploy GitHub main), risiko masing-masing (latestDeployment FAILED 09-24, Dockerfile.bot, volume /app/bot/data), perintah persisnya, dan konsekuensi terhadap eval window. JANGAN eksekusi.

## Tugas B - roadmap update teknis (pemilik: v2-roadmap)
Laporan: analysis/2026-10-18/upcoming-updates.md
1) Branch feat/clob-v2 (origin/feat/clob-v2, worktree A:\PolyBot BTC15\PolyBTC15\.claude\worktrees\agent-acc1e931b8bdfa89a, commit 8ba2108): baca docs/CLOB_V2_MIGRATION.md, git log --oneline main..feat/clob-v2, git diff --stat main...feat/clob-v2, file kunci bot/src/trading/clobClient.ts, clobV2Config.ts, orderConstraints.ts, v2Readiness.ts, bot/scripts/clobV2Preflight.mts, clobV2SmokeOrder.mts, bot/package.json. Jalankan test relevan yang aman (npm test di root = vitest; npm run typecheck). Nilai kesiapan merge, test hijau/tidak, yang belum diverifikasi (live order, approval pUSD, builder key, min size 5 shares, tick 0.01), dan risiko go-live tersisa (fee, journalReconciler, dsb).
2) Deadline RTDS: CLAUDE.md menyebut topik harga RTDS deprecated sekitar 2026-10-23 (5 hari lagi) dan penggantinya PolyBolt price.crypto.twap. Verifikasi ke dokumentasi resmi Polymarket (docs.polymarket.com, cari RTDS/PolyBolt/TWAP) dan cek kode: apakah migrasi PolyBolt sudah ada (grep polybolt, price.crypto.twap, op:auth), bagaimana fallback API PTB bekerja tanpa RTDS, dan apa yang harus dikerjakan sebelum deadline.
3) Backlog: docs/TIER1_AUDIT_REPORT.md, docs/BANKROLL_TRACKER_FIX_PLAN.md, docs/V19_*.md, bugs.txt, error.txt, insight polymarket/, paper/. Pisahkan relevan vs usang. Sertakan go-live blockers 2026-09-26 dari CLAUDE.md, eval window 300 trade, dan maker-fill study (~7 minggu tape).
4) Output: roadmap P0/P1/P2 dengan effort, risiko, deadline, urutan eksekusi, keputusan yang dibutuhkan operator.

## Tugas C - asesmen quantitative finance (pemilik: quant-eval)
Laporan: analysis/2026-10-18/quant-assessment.md
1) Baca CLAUDE.md bagian riset (model v2/v3, market_skill, residual/stacking, ruleSearch 211 varian, studi TWAP, maker fill, fee CLOB V2, backtest fresh price, decision trail, training window) + ml_registry/journal.jsonl + ml_registry/MODELS.md. Ringkas angka kunci: edge klaim vs realisasi, Brier skill vs market, ROI + CI, n trade, P(loss) Monte Carlo.
2) Hitung sendiri dari data lokal: bot/data/railway/trade_journal.jsonl (snapshot s/d 2026-09-23/24) serta hasil backtest yang sudah ada (jangan training berat). Hitung WR vs breakeven, ROI/trade, distribusi entry price, PnL, dan power analysis: dengan target 300 trade dan edge klaim +8-10% ROI, seberapa lebar CI dan berapa trade untuk signifikan?
3) Nilai opsi kuant lebih intens: (a) model/ML lebih dalam (deep learning, RL, fitur baru), (b) eksekusi/mikrostruktur (maker fill study, adverse selection, ~7 minggu tape), (c) evaluasi statistik/forward test, (d) manajemen risiko/position sizing. Beri biaya-manfaat dan batasan data (market 15 menit, resolusi TWAP 60 detik, tape 1 Hz baru ~3-4 minggu, 4-20 trade/hari).
4) Kesimpulan: level kuant yang benar-benar dibutuhkan, pekerjaan konkret 2-4 minggu ke depan, dan yang sebaiknya TIDAK dilakukan.

## Output akhir
Setiap anggota: tulis laporan sesuai path di atas, lalu kirim ringkasan final (<=1200 kata) ke Lead. Lead menyusun jawaban final untuk user dalam bahasa Indonesia.