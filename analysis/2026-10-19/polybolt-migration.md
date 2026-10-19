# Migrasi feed RTDS → PolyBolt (TWAP 60s + Chainlink spot)

**Status:** SELESAI — implementasi + unit test + typecheck + uji live dari PC lulus. **Belum di-deploy** (deploy/restart VPS = Lead). **Belum di-commit** (sesuai aturan; perubahan JEV di `main` tidak disentuh).
**Tanggal:** 2026-10-19 (WIB) · **Deadline RTDS:** ~2026-10-23 · **Shared task:** task-8

---

## 1. Ringkasan eksekutif

Feed TWAP Chainlink 60 detik (dasar price-to-beat / settlement BTC 15m) dipindahkan dari RTDS topic
`crypto_prices_twap_sixty` ke PolyBolt channel `price.crypto.twap`, dan feed **Chainlink spot** dari
`crypto_prices_chainlink` ke `price.crypto` (pin provider `chainlink`). Endpoint baru:
`wss://ws-live-v2.polymarket.com/ws`, autentikasi `{"op":"auth"}` dengan CLOB L2 credentials
(`POLYMARKET_API_KEY / POLYMARKET_API_SECRET / POLYMARKET_API_PASSPHRASE`, sudah ada di `bot/.env`).

**Kunci desain:** modul baru dipasang di balik antarmuka `chainlinkTwap.ts` / `polymarketLiveWs.ts`
yang sudah dipakai `loop.ts`, sehingga **`bot/index.ts` tidak perlu diubah sama sekali** — dan
`loop.ts`, `tradeFilters.ts`, `config.ts` tetap 0 perubahan. Saat mode PolyBolt, feed RTDS tetap
terhubung sebagai **shadow fallback** (`POLYBOLT_RTDS_FALLBACK=off` untuk mematikan): pembacaan
memilih PolyBolt per tick lalu jatuh ke RTDS, jadi kegagalan auth/socket PolyBolt selama rollout
tidak menghilangkan PTB exact.

Hasil verifikasi lapangan (PC ini, 2026-10-19 04:13–04:20 UTC):

| Uji | Hasil |
|---|---|
| Auth `op:auth` + subscribe TWAP & spot | PASS, ack `subscribed` dengan `provider:"chainlink"` |
| Snapshot saat subscribe | 117 titik per channel (≈ 2 menit, sesuai docs) |
| TWAP PolyBolt vs RTDS pada detik yang sama | **87/87 identik** (selisih 0.0e+0, presisi penuh) |
| Spot PolyBolt vs RTDS `crypto_prices_chainlink` | **88/88 identik** (Chainlink, bukan Pyth) |
| Laju tick live | ~1/detik, 58 tick dalam 60 detik terakhir |
| Latensi (second sumber → terima) | ~1.0–2.0 detik |
| parseErrors / seqGaps / reconnects | 0 / 0 / 0 |

---

## 2. Koreksi riset sebelumnya (penting)

Catatan tim sebelumnya menyebut **“PolyBolt `price.crypto` spot adalah Pyth (bukan Chainlink)”**.
Itu **tidak benar** untuk BTC/USD. Dokumentasi resmi
(`docs.polymarket.com/api-reference/live-data/overview`) menyatakan: *“Every `price.crypto` symbol
defaults to Chainlink … can also be pinned to `pyth`”*, dan halaman migrasi resmi
(`docs.polymarket.com/migrate/rtds-to-polybolt`) memetakan `crypto_prices_chainlink` →
`price.crypto {"symbol":"btcusd"}` dengan catatan *“Source stays Chainlink”*. Probe live
memastikannya: seluruh frame membawa `source:"chainlink"`, dan nilainya identik dengan RTDS
Chainlink di setiap detik yang tumpang tindih.

**Implikasi untuk settlement estimate:** `engines/settlePrice.ts` tetap memakai Chainlink spot,
jadi tidak ada pergeseran basis/produsen. Kalau asumsi “Pyth” dipakai, kita akan diam-diam
mengganti vendor untuk estimasi final-minute TWAP (Pyth ≠ Chainlink, dan Binance sudah pernah
terukur ~$23.76 di atas Chainlink) — risiko yang sekarang tidak ada. Pyth hanya relevan bila
secara eksplisit di-pin untuk symbol yang mendukung.

Detail protokol lain yang terkonfirmasi dari docs resmi + AsyncAPI
(`wss://ws-live-v2.polymarket.com/asyncapi.json`) + probe:
- Subscribe object: `{"op":"subscribe","subscriptions":[{"channel":"…","filter":{…}}]}` (filter **objek**, bukan string seperti RTDS).
- Satu snapshot per subscription (`snapshot:true`, berisi ≤2 menit history; batch `payload.data[]`, live = satu point).
- Envelope: `{v:1,channel,seq,ts,snapshot?,dropped?,payload}`; `seq` dense per channel per koneksi, reset saat reconnect.
- Payload memuat `full_accuracy_value` (string desimal exact) — **dipakai**, bukan float `value`.
- Tidak perlu text `PING`; server ping WebSocket tiap 25 s (library `ws` menjawab otomatis). Ada `{"op":"ping"}` opsional.
- Limit: 64 subscription/koneksi, 20 frame subscribe/detik, frame 64 KB, 8 auth frame/koneksi. Close: 4001 auth, 4002 slow consumer, 4003 draining (retry 0–10 s), 4008 policy. Error non-closing: `auth_required`, `auth_invalid`, `auth_unavailable`, `bad_filter`, dll.
- TWAP hanya window 60 s; symbol lowercase `btcusd` (bukan `btc/usd`/`btcusdt`). Frame legacy RTDS (`window_s`, fixed-point E18) **tidak** berlaku — PolyBolt memakai desimal string; terverifikasi nilainya sama dengan RTDS.

---

## 3. Arsitektur implementasi

```
bot/src/streams/
├── polyboltWs.ts        (BARU, 597 ln)  client PolyBolt generik: auth, subscribe, envelope,
│                                        TickStore by source-timestamp, reconnect/backoff,
│                                        replay = reconnect (snapshot 2 menit), health/seq/dropped
├── polyboltProbe.mts    (BARU, 117 ln)  smoke test read-only (tanpa secret) untuk PC/VPS
├── chainlinkTwap.ts     (UBAH, 111 ln)  seam TWAP: pilih PolyBolt vs RTDS, dual-run fallback,
│                                        getTwapAt/getLatestTwap/replay/health (API lama utuh)
├── polymarketLiveWs.ts  (UBAH, 236 ln)  spot: PolyBolt primary + RTDS shadow; tick store merge
│                                        per detik; getPrice/getPrevPrice/getSpotTicksBetween (API lama utuh)
└── __tests__/polyboltWs.test.ts (BARU, 398 ln, 19 test)
```

### Alur socket PolyBolt (`createPolyBoltFeed`)
1. `start()` → buka `wss://ws-live-v2.polymarket.com/ws`.
2. `open` → kirim `op:auth` (credentials dari env, **tidak pernah di-log**).
3. `authed` → kirim `op:subscribe` untuk channel+filter.
4. `subscribed` (+ `provider` dari ack) → snapshot (`snapshot:true`) di-seed ke `TickStore`, lalu point live ditambahkan per detik.
5. Supervisi: auth timeout 10 s, subscribe timeout 20 s, **stall 30 s tanpa tick** → reconnect; setelah 3 stall beruntun backoff sampai 5 menit (channel dianggap pensiun/diblokir).
6. Close handling: 4001 → backoff 5 menit + `authState:"invalid"`; 4003 → jitter 0–10 s; 4008 → backoff 60 s; 1006/4002 → exponential backoff 1 s→30 s full jitter.
7. `replay(reason)` = reconnect (subscription baru mengirim snapshot 2 menit), rate-limited 20 s — menggantikan `replay()` RTDS yang mengandalkan replay ~60 s.
8. Semua entry point total: frame rusak dihitung (`parseErrors`), tidak pernah throw.

`TickStore` tetap menyimpan tick berdasarkan **timestamp yang dicap sumber** (bulat detik, ms di frame), sehingga `getTwapAt(windowStartMs)` tetap “TWAP yang dicap tepat pada detik itu” — syarat PTB exact. Parser menormalkan timestamp ke detik terdekat (jaga-jaga bila format berubah; data live sekarang selalu bulat detik).

### Mode & fallback
- `TWAP_FEED=polybolt|rtds`. Tidak diset/“auto” → **polybolt bila trio credential ada**, kalau tidak **rtds** (perilaku lama).
- Mode polybolt: PolyBolt jadi primary, RTDS tetap terhubung sebagai shadow fallback (kecuali `POLYBOLT_RTDS_FALLBACK=off`). `getTwapAt` = `polybolt.at(ts) ?? rtds.at(ts)`; `getLatestTwap` memilih tick dengan timestamp terbaru; `requestTwapReplay` memicu kedua feed (masing-masing rate-limited).
- Spot: modul `polymarketLiveWs` membuat feed PolyBolt `price.crypto {"symbol":"btcusd","provider":"chainlink"}` saat mode polybolt; pembacaan memakai PolyBolt bila `connected && subscribed` dan tick terakhir <15 s, jika tidak jatuh ke RTDS. `getSpotTicksBetween` menggabungkan kedua store per detik (PolyBolt menang pada detik yang sama; nilainya identik).
- Semua perubahan integrasi ada di dua modul itu; **`bot/index.ts` tidak berubah** (start/stop sudah lewat `startTwapFeed()`/`connectPolyLiveWs()` yang ada).

---

## 4. Env & operasional

| Env | Default | Fungsi |
|---|---|---|
| `TWAP_FEED` | auto | `polybolt` / `rtds`. Auto = polybolt bila credential ada, selain itu rtds. |
| `POLYBOLT_RTDS_FALLBACK` | on | `off/false/0/no` mematikan RTDS shadow (setelah RTDS benar-benar mati). |
| `POLYMARKET_API_KEY` / `POLYMARKET_API_SECRET` / `POLYMARKET_API_PASSPHRASE` | — | CLOB L2 credentials (sudah ada di `bot/.env` lokal; sama dengan yang dipakai CLOB client). Tidak dicetak di log/probe. |

Tidak ada dependency baru (`ws` sudah ada di `bot/package.json`). Endpoint default ada di konstanta
`POLYBOLT_DEFAULT_URL`; opsi `url` tersedia di factory untuk staging/test.

**Catatan DNS PC ini (bukan masalah VPS):** ISP memblokir `docs.polymarket.com`, `clob.polymarket.com`,
`gamma-api.polymarket.com`, dan `ws-live-v2.polymarket.com` (semua resolve ke `202.169.44.80` =
halaman blokir). Uji live dilakukan dengan resolve DoH (`https://1.1.1.1/dns-query`) lalu
`--host-ip <CloudFront IP>` pada probe (TLS/SNI tetap memakai hostname asli). Dokumentasi dibaca
via proxy `r.jina.ai`. VPS punya DNS normal, jadi tidak perlu trik ini; probe di VPS dijalankan
tanpa `--host-ip`.

---

## 5. Hasil test

| Perintah | Hasil |
|---|---|
| `npx vitest run bot/src/streams/__tests__/polyboltWs.test.ts` | **19/19 PASS** |
| `npm run typecheck` (frontend + bot + bot:core + scripts) | **PASS** (exit 0) |
| `npm run test` (seluruh repo) | **79 file / 837 test PASS** (33.8 s) |

Cakupan 19 unit test (`bot/src/streams/__tests__/polyboltWs.test.ts`, socket palsu deterministik):
1. frame auth (`rid`, trio credential) dan frame subscribe batch (filter objek, bukan string);
2. parsing snapshot TWAP (batch `data[]`, `full_accuracy_value` dipakai, timestamp dinormalkan);
3. parsing point TWAP live + snap sub-detik;
4. parsing snapshot/live spot (source batch-level vs point-level; `pyth` tetap terbaca sebagai source);
5. penolakan ack/channel lain/symbol lain/point invalid;
6. `normalizeTickTs`;
7. seleksi mode `TWAP_FEED` + validasi credential;
8. `POLYBOLT_RTDS_FALLBACK`;
9. backoff 1006/4002 (exponential, cap 30 s, jitter, minimum 250 ms);
10. lifecycle penuh: start → auth → subscribe → snapshot → live → health (`ticks`, `snapshotPoints`, `source`, `provider`, `seqGaps`);
11. `auth_required` → kirim ulang auth tanpa reconnect;
12. `auth_invalid` → tunggu 5 menit, `authState:"invalid"`;
13. close 4003 → reconnect setelah jitter 0–10 s;
14. close 1006 → reconnect setelah backoff lalu auth ulang di socket baru;
15. replay = reconnect dan rate-limit 20 s;
16. credential hilang → tanpa socket, tanpa retry storm;
17. seq gap + `dropped` dihitung;
18. channel senyap 30 s → reconnect;
19. seam `chainlinkTwap`: `TWAP_FEED=rtds` vs `polybolt` memilih feed yang benar tanpa mengubah loop/index.

---

## 6. Hasil uji live dari PC (read-only, 2026-10-19)

Perintah: `node --env-file=./bot/.env bot/src/streams/polyboltProbe.mts --seconds 20 --host-ip <DoH IP>`
(probe hanya mencetak panjang credential, tidak pernah nilainya; membuka socket sendiri, tidak menyentuh state bot).

Output ringkas 04:19 UTC (`18.161.97.96`):
```
[chainlink] connected=true auth=ok subscribed=true ticks=136 snapshotPoints=117
            source=chainlink provider=chainlink reconnects=0
TWAP: PASS  latestTs=1792383599000 value=82385.9961  latency=1007ms
SPOT: PASS  latestTs=1792383599000 value=82392.1323  last60s=58
```
- Snapshot kedua channel 117 titik; live ≈1/detik; 58 tick/60 s.
- TWAP vs spot selisih wajar (~$6) karena TWAP rata-rata 60 s.
- Perbandingan silang dengan RTDS (probe terpisah, 04:13 UTC): TWAP 87/87 dan spot 88/88 **identik sampai digit terakhir** → migrasi ini penggantian protokol, bukan perubahan data/series.
- Latensi ~1.0–2.0 s; `ptbResolver` menunggu tick sampai +2.5 s lalu `replay()` (snapshot 2 menit) dan API fallback `polymarket.com/api/crypto/crypto-price` tetap ada, jadi jadwal resolusi tidak berubah.

---

## 7. Risiko & mitigasi

| Risiko | Mitigasi |
|---|---|
| Credential CLOB tidak ada/kadaluarsa di VPS | Probe pre-deploy menangkap `auth_invalid`; feed backoff 5 menit (tidak hammer); RTDS shadow keeps PTB exact sampai diperbaiki. |
| Auth server-side sementara unavailable | `auth_unavailable` → retry 15 s; shadow RTDS tetap jalan. |
| Latensi PolyBolt sedikit lebih tinggi dari RTDS | Masih dalam jendela resolver (tick walau telat tetap masuk store per detik); API fallback tidak berubah. |
| Provider flip (Chainlink→Pyth) di sisi Polymarket | Spot di-pin `provider:"chainlink"`; ack `subscribed` menamai provider yang benar-benar dilayani; `source`/provider diekspos di health. |
| RTDS dihapus 23 Okt saat shadow masih aktif | Shadow akan stall → backoff sampai 5 menit (log error sekali), PolyBolt tetap primary; matikan dengan `POLYBOLT_RTDS_FALLBACK=off`. |
| Limit/kebijakan PolyBolt | Hanya 2 subscription (1 per koneksi), 1 auth/koneksi — jauh di bawah 64/8; pelanggaran (4008) di-backoff 60 s. |
| Secret bocor ke log | Credential hanya dipakai di frame auth; logger me-redact; probe tidak mencetak nilai. Unit test memeriksa frame yang dikirim, bukan isi secret. |
| Perubahan tak terkait (JEV) | Tidak menyentuh loop.ts/tradeFilters.ts/config.ts/index.ts; git status hanya 5 file di scope. |

**Rollback:** set `TWAP_FEED=rtds` di `bot/.env` dan restart service — kembali 100% ke perilaku RTDS tanpa revert kode. (Catatan: RTDS tetap berhenti ~23 Okt, jadi rollback ini hanya jembatan.) Alternatif revert file bila ada bug fatal.

---

## 8. Langkah deploy (dieksekusi Lead — JANGAN saya lakukan)

1. **Pastikan credential ada di VPS** (bot DRY_RUN tidak memakainya, jadi belum tentu terisi):
   `grep -c '^POLYMARKET_API_KEY=' bot/.env` (dst; cek keberadaan saja, jangan cetak nilai).
2. **Bawa 5 file ke VPS** sesuai mekanisme deploy tim (commit + `git pull`, atau rsync):
   `bot/src/streams/polyboltWs.ts`, `polyboltProbe.mts`, `__tests__/polyboltWs.test.ts`,
   `chainlinkTwap.ts`, `polymarketLiveWs.ts`.
3. **Smoke test di VPS sebelum restart** (read-only, tidak mengganggu bot):
   `node --env-file=/opt/polybtc15/bot/.env /opt/polybtc15/bot/src/streams/polyboltProbe.mts --seconds 20`
   → harus **PASS TWAP + SPOT**, `provider=chainlink`. (Tanpa `--host-ip`; DNS VPS normal.)
4. **Restart**: `systemctl restart polybtc15-bot` (perintah Lead).
5. **Verifikasi log** (`journalctl -u polybtc15-bot -f` atau log PM2):
   - `TWAP source: PolyBolt price.crypto.twap btcusd/60s (RTDS shadow fallback connected)`
   - `[PolyBolt:TWAP] … authenticated` → `subscribed (provider chainlink)` → `snapshot with ~1xx point(s)`
   - `[PolyBolt:SPOT] … subscribed (provider chainlink)`
   - batas window berikutnya: `PTB: $… → $… (chainlink_twap, exact, +x.xs after open)`
6. **Verifikasi state**: `twapNow` non-null di dashboard/state; `twapFeed.mode="polybolt"`, `polybolt.authState="ok"`, `polybolt.seqGaps` rendah, `rtds.connected=true`; setelah beberapa window cek `ptb_health.jsonl` (exactPct + verifier) dan tape `tw`/PTB.
7. **Rollback bila perlu**: `TWAP_FEED=rtds` + restart (langkah 4).
8. **Setelah ~1 minggu / RTDS mati**: set `POLYBOLT_RTDS_FALLBACK=off` (dan cleanup RTDS code/bagian CLAUDE.md di follow-up, bukan di task ini).

Tidak ada perubahan pada `ecosystem.config.cts`/systemd yang dibutuhkan — env baru cukup di `bot/.env` (atau default otomatis).

---

## 9. File yang berubah

| File | Status | Keterangan |
|---|---|---|
| `bot/src/streams/polyboltWs.ts` | baru (597 ln) | client PolyBolt + parser + feed + health |
| `bot/src/streams/polyboltProbe.mts` | baru (117 ln) | smoke test read-only PC/VPS |
| `bot/src/streams/__tests__/polyboltWs.test.ts` | baru (398 ln, 19 test) | unit test |
| `bot/src/streams/chainlinkTwap.ts` | ubah (111 ln) | seam TWAP: PolyBolt primary + RTDS shadow; API sama |
| `bot/src/streams/polymarketLiveWs.ts` | ubah (236 ln) | spot PolyBolt primary + RTDS shadow; API sama |

**Tidak diubah:** `bot/index.ts`, `loop.ts`, `tradeFilters.ts`, `config.ts`, `bot/package.json`, `.env` apa pun.
Tidak ada commit/deploy/restart VPS. Perubahan JEV yang sudah di-commit (`271991e`) tidak disentuh.

---

## 10. Follow-up (di luar task-8)

1. Set `POLYBOLT_RTDS_FALLBACK=off` setelah PolyBolt terbukti stabil dan RTDS resmi mati; hapus jalur RTDS (chainlinkTwap/polymarketLiveWs/rtdsTickFeed) di task terpisah.
2. Update narasi CLAUDE.md yang masih menyebut “PolyBolt `price.crypto` spot adalah Pyth” → Chainlink default; dan RTDS deprecation sudah termigrasi.
3. Pertimbangkan menambah `twapFeed`/spot health ke dashboard (sekarang hanya ada di state broadcast JSON; tidak wajib).
4. Optional: pakai satu koneksi PolyBolt untuk TWAP+spot (sekarang 2 koneksi, 1 subscription masing-masing) — tidak perlu selama limit 64/koneksi.
