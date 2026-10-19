# CLOB V2 — merge `feat/clob-v2` → `main`, verifikasi (belum deploy)

- **Tanggal:** 2026-10-19 (Asia/Jakarta)
- **Owner:** teammate `clobv2` — shared task `task-9`
- **Status:** **SELESAI & TERVERIFIKASI** — merge commit siap di branch terpisah. **`main` belum di-merge**, **VPS belum disentuh**, **main workspace (perubahan JEV) tidak diubah.**
- **Repo:** `A:\PolyBot BTC15\PolyBTC15` (Windows, Node v25.1.0)

## Ringkasan

| Item | Nilai |
|---|---|
| Worktree | `.claude/worktrees/clob-v2-merge` = `A:\PolyBot BTC15\PolyBTC15\.claude\worktrees\clob-v2-merge` |
| Branch | `merge/clob-v2` (lokal, belum di-push) |
| Base `main` | `abc1b569f97144fb7469562b5f2040c20f372160` — tidak berubah |
| Tip `feat/clob-v2` | `8ba2108fc46a256253a09d8a6add644da99b03ae` — tidak berubah |
| **Merge commit** | **`b5cbf590d426eb959bf0e1c5cff9712f384c9242`** (parents: `abc1b56` + `8ba2108`) |
| Fast-forward ke main | **Ya** — `main` adalah ancestor `merge/clob-v2`; `git merge --ff-only merge/clob-v2` menghasilkan tree `b5cbf59` tanpa commit tambahan |
| Diff vs main | **22 file, +2846 / −272** |
| `npm ci` | root: 94 package; bot: 161 package — lock konsisten |
| `npm run typecheck` | **PASS** — 4 project tsc (frontend, bot, bot.core, scripts) |
| `npx vitest run` | **PASS** — 80 test file / **863 test**, 50,51 s |
| Deploy | **TIDAK** — tanpa SSH/pm2/restart, tanpa `bot/data`, tanpa secret dicetak |

## 1. Worktree & perintah merge

```bash
# dari main workspace; tidak mengubah working tree main (JEV tetap utuh)
git worktree add .claude/worktrees/clob-v2-merge -b merge/clob-v2 main

# di worktree
git merge feat/clob-v2
# → CONFLICT (content): bot/derive-credentials.ts, bot/src/trading/clobClient.ts
# setelah resolusi:
git add bot/derive-credentials.ts bot/src/trading/clobClient.ts
# verifikasi typecheck + vitest (lihat §4), lalu:
git commit
```

Worktree `agent-acc1e931b8bdfa89a` (yang memegang `feat/clob-v2`) tidak disentuh. Tidak ada file main workspace yang diubah oleh operasi ini.

## 2. Konflik yang diselesaikan (2 file, 4 hunk)

### 2a. `bot/src/trading/clobClient.ts` — 3 hunk (semantik)

**Sisi main (sejak merge-base `43dfca4`):** menambahkan guard `assertOrderParams(action, {tokenId, price, size})` (tokenId harus string non-kosong, price finite di (0,1), size finite > 0), dipanggil di `placeBuyOrder` / `placeLimitBuyOrder` / `placeSellOrder`, plus rename `_CHAINSTACK` → `_POLYGON_RPC` (rename ini auto-merge, bukan konflik).

**Sisi `feat/clob-v2`:** menulis ulang order path ke CLOB V2: parameter bertipe (`OrderParams`/`LimitOrderParams`, `postOnly`), `requireClient()`, `prepareOrThrow()` (pembulatan harga ke tick inward + tolak ukuran < minimum pasar, tidak pernah upsizing), lalu `createAndPostMarketOrder`/`createAndPostOrder` V2.

**Resolusi — pertahankan validasi main + struktur V2:**

```ts
export async function placeBuyOrder({ tokenId, price, size }: OrderParams) {
  const c = requireClient();
  // Main's 2026-09-29 audit guard: tokenId/price/size must be sane before signing.
  // prepareOrder() below re-checks price/size, but not the tokenId.
  assertOrderParams('BUY', { tokenId, price, size });
  const order = prepareOrThrow('BUY', 'BUY', 'market', { tokenId, price, size });
  ...
```

- `placeLimitBuyOrder`: `const c = requireClient();` → `assertOrderParams('LIMIT_BUY', ...)` → cek expiry → `prepareOrThrow(...)` (tidak ada pemanggilan ganda).
- `placeSellOrder`: sama seperti BUY.
- Urutan `requireClient()` sebelum `assertOrderParams()` disengaja: jalur dry-run (client null) harus tetap melempar persis `'CLOB client not initialized'` — diuji `clobClient.v2.test.ts` ("order functions throw exactly as before").
- `assertOrderParams` tetap bernilai karena `orderConstraints.prepareOrder()` hanya memvalidasi price/size, **tidak** tokenId.
- Satu-satunya teks baru di luar resolusi murni: 2 baris komentar di atas pemanggilan BUY.
- Bukti tidak ada drift lain: `git diff b5cbf59^2 b5cbf59 -- bot/src/trading/clobClient.ts` = definisi `assertOrderParams` + 3 call + rename `_CHAINSTACK`→`_POLYGON_RPC` saja.

### 2b. `bot/derive-credentials.ts` — 1 hunk (trivial)

- **main:** guard `if (!privateKey)` + shim kompatibilitas ethers v6 `_signTypedData` (`WalletCompat`).
- **feat:** file ditulis ulang memakai signer viem V2: `createClobSigner` + `buildClobClientOptions` (juga punya guard null).
- **Resolusi:** ambil jalur V2 feat (guard + `createClobSigner`); shim ethers `Wallet/_signTypedData` dibuang karena V2 config membangun viem signer dan file hasil merge tidak lagi meng-import `Wallet` (kalau dipertahankan justru gagal typecheck). Tidak ada perilaku yang hilang: `deriveApiKey()` tetap sama; auth L1/L2 V2 tidak berubah.

Tidak ada conflict marker tersisa (`git status` bersih setelah commit; grep `<<<<<<<`/`>>>>>>>` = 0).

## 3. Review file auto-merge (tanpa konflik, semantik dicek)

| File | Hasil merge | Catatan |
|---|---|---|
| `.github/workflows/ci.yml` | main `permissions: contents: read` + feat update komentar deps V2 | Keduanya ada; tidak ada job/step berubah |
| `CLAUDE.md` | bagian "Audit fixes of 2026-09-29" (main) + paragraf CLOB V2/pipeline (feat) | Keduanya utuh, tidak duplikat |
| `bot/.env.example` | union: main (POLL_INTERVAL_MS bounds, ALLOW_RULE_ONLY_TRADING, STATUS_ALLOWED_ORIGINS) + feat (POLYMARKET_PROXY_ADDRESS, POLYMARKET_SIGNATURE_TYPE, POLYGON_RPC_URL, catatan V2) | Tidak ada var yang hilang |
| `bot/index.ts` | main (`envInt` POLL_MS, hard-exit shutdown 20 s + early save) + feat (`verifyClobV2Readiness()` fail-closed di startup live, warning GTD lead <180 s) | Urutan wajar: readiness setelah auto-activate, sebelum `startReconciler()` |
| `bot/src/trading/positionManager.ts` | main (`polygonRpcUrl()` untuk query on-chain) + feat (CTF allowance `null` dianggap belum approve) | Independen, kompatibel |
| `bot/package.json` + lock | `@polymarket/clob-client ^5.8.1` → `@polymarket/clob-client-v2 1.2.0` (pinned) + `viem` | `npm ci --prefix bot` sukses → lock sinkron |
| `docs/CLOB_V2_MIGRATION.md` (baru) | checklist operator | Dicek konsisten dengan kode hasil merge (tick rounding, min 5 share, GTD 180 s, `skipSettlementWait`, readiness gate) |
| `bot/derive-builder-key.ts`, `bot/freshFetchJournal.ts`, `bot/src/adapters/dataFetcher.ts` | feat-only (pindah ke signer/kontrak V2; dataFetcher mencatat order constraints) | Tidak berinteraksi dengan perubahan main |

## 4. Verifikasi di worktree merge (Node v25.1.0)

```bash
npm ci                    # "added 94 packages, audited 95"   (~3 mnt)
npm ci --prefix bot       # "added 161 packages, audited 162" (~4 mnt)
npm run typecheck         # 4 project: frontend, bot, bot.core, scripts — tanpa error
npx vitest run            # 80 test file / 863 test lulus, 50,51 s
```

- Exit code 0 untuk typecheck & vitest (tidak ada marker kegagalan).
- 4 test file V2 baru ikut lulus; run terarah: `clobClient.v2.test.ts` (15), `orderConstraints.test.ts` (22), `clobV2Config.test.ts` (10), `v2Readiness.test.ts` (9) = **56 test, 7,57 s**.
- npm audit (informasional, bukan gate): root 7 vulnerability (3 moderate, 4 high), bot 13 (12 low, 1 high) — tidak ada dependency baru di root; tidak ada perubahan dependency di luar paket bot yang memang dibawa feat.
- Vite build tidak dijalankan lokal; merge tidak menyentuh `src/` frontend (hanya bot/docs/CLAUDE) dan CI tetap menjalankan build. `vitest` sudah mencakup test frontend (`src/**`).

## 5. Diff ringkas vs `main` (22 file, +2846/−272)

- **Baru:** `bot/src/trading/{clobV2Config,orderConstraints,v2Readiness}.ts`, 4 test V2 (`bot/src/trading/__tests__/*`), `bot/scripts/{clobV2Preflight,clobV2SmokeOrder}.mts`, `docs/CLOB_V2_MIGRATION.md`
- **Ditulis ulang:** `bot/src/trading/clobClient.ts` (V2 order path + guard main), `bot/derive-credentials.ts`, `bot/derive-builder-key.ts`, `bot/freshFetchJournal.ts`
- **Diubah:** `bot/index.ts` (readiness gate), `bot/package.json` + `package-lock.json`, `bot/src/trading/positionManager.ts`, `bot/src/adapters/dataFetcher.ts`, `bot/.env.example`, `.github/workflows/ci.yml`, `CLAUDE.md`
- **Tidak ada perubahan di** `bot/src/loop.ts`, `tradePipeline.ts`, `tradeFilters.ts` (dry-run path byte-for-byte tetap; order path live saja).

## 6. Sisa risiko go-live (belum dihilangkan oleh merge — langkah operasional/manual)

1. **pUSD & approval manual (blocker utama live).** Funder (proxy/Safe) harus pegang **pUSD** (wrap USDC.e via CollateralOnramp; bot tidak wrap sendiri), lalu `pUSD.approve(CTF Exchange V2 0xE111…B996B, MaxUint256)` dan `CTF.setApprovalForAll(CTF Exchange V2, true)`. `verifyClobV2Readiness()` (view call Polygon) membuat startup **live fail-closed** bila belum; dry-run tidak terpengaruh (client tidak dibuat). Jalankan `bot/scripts/clobV2Preflight.mts`.
2. **Sizing minimum 5 share.** BTC 15m: `min_order_size=5`, tick `0.01`. Live order <5 share **ditolak** (tidak pernah di-upsize) dengan log; dry-run **tetap** membukukan stake 3–4 share (`FOK_MIN_SHARES_LOW` default 3) → live vs dry-run berbeda sampai operator memasang mis. `FOK_MIN_SHARES_LOW=5` (ini juga mengubah seleksi trade dry-run → restart window evaluasi). Limit/GTD path juga tunduk minimum + lead ≥180 s.
3. **Fee di `journalReconciler.ts`.** Reconciler on-chain menghitung net P&L **tanpa fee** (mem-parse `feeBps` tapi tidak dipakai) sedangkan P&L lokal sudah memuat taker fee V2 `shares×0.07×p×(1−p)`; bila `usdcSize` data API tidak fee-inclusive, tiap trade live menunjukkan selisih ≈ fee dan reconciler bisa "mengoreksi" bankroll live naik. **Belum bisa dipastikan tanpa fill V2 nyata** — ukur saat smoke test: bandingkan `makingAmount` vs perubahan pUSD on-chain dan `usdcSize` data API.
4. **Belum terverifikasi tanpa kredensial:** apakah API key lama authenticate ke V2 (L1/L2 dijanjikan tidak berubah), bentuk `/balance-allowance` V2, apakah `makingAmount` FOK BUY sudah termasuk fee, semantik minimum 5 share untuk market BUY, dan aturan GTD 3 menit (dari docs, belum diuji). Tersedia preflight + `clobV2SmokeOrder.mts` (rest-cancel lalu 1 fill 5 share; wajib `--confirm`, jalankan saat bot stop/DRY_RUN karena startup live membatalkan semua open order).
5. **RTDS price topics deprecated ~2026-10-23** (4 hari) — tidak terkait merge ini, tapi tetap risiko operasional terpisah yang perlu dijadwalkan.
6. **Tidak ada fallback V1:** V1 SDK tidak bisa trading di produksi. Rollback = revert commit + `DRY_RUN=true`.

## 7. Yang TIDAK dilakukan (sesuai batasan task)

- `main` **tidak** di-merge / tidak di-push; `merge/clob-v2` hanya lokal di worktree.
- **Tidak** deploy/restart VPS (tanpa SSH/pm2), tidak menyentuh `bot/data`, tidak mencetak secret/`bot/.env`.
- Tidak mengubah file main workspace (perubahan JEV yang belum commit tetap apa adanya; hash file JEV dicek — file `bot/src/ai/jevAdvisor.ts` & `bot/scripts/jevEvaluate.mts` berubah **oleh pekerjaan JEV paralel Lead/teammate lain**, bukan oleh task ini).
- Tidak mengubah `bot/src/loop.ts` / `bot/src/safety/tradeFilters.ts`; tidak menambah dependency baru (hanya `npm ci` di worktree).
- `analysis/2026-10-19/` (laporan ini) adalah satu-satunya tulisan di main workspace.

## 8. Langkah berikutnya untuk Lead

1. Review commit `b5cbf59` / diff `main..merge/clob-v2` di worktree `.claude/worktrees/clob-v2-merge`.
2. Setelah perubahan JEV di main workspace di-commit (di luar scope task ini), merge dengan fast-forward:
   ```bash
   git merge --ff-only merge/clob-v2   # dari main workspace; hasil tree = b5cbf59
   ```
3. Deploy tetap manual sesuai `docs/CLOB_V2_MIGRATION.md` (pUSD + 2 approval → preflight → smoke order 5 share → verifikasi fee → baru `DRY_RUN=false`).
4. Opsional setelah merge: `git worktree remove .claude/worktrees/clob-v2-merge` (dan `git branch -d merge/clob-v2`).

---
*Dibuat oleh teammate `clobv2` untuk shared task `task-9`. Verifikasi: typecheck + vitest di worktree merge, 2026-10-19 ~11:11 WIB.*
