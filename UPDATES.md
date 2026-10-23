# POLY//15 — Update Log

**Purpose:** the single living file for every future change. Add new entries at the top; never rewrite history.
**Time zone:** WIB (Asia/Jakarta) unless stated otherwise.
**Rule:** no passwords, API keys, tokens, private keys, tunnel credentials, or personal secrets in this file.

---

## Current status

_Last updated: 2026-10-21 21:25 WIB_

| Area | State |
|---|---|
| Bot | active, **DRY_RUN=true**, no real orders; no open position |
| Paper bankroll | $60.12 · 833 trades · 536W / 297L |
| Dashboard | https://poly15.dollarkilat.xyz/ · 16 widgets |
| Auth | session login; daily password rotation at 07:00 WIB via Telegram |
| Live/dry switch | available; **live not activated** |
| Drift | no drift at last check |
| Tests | 91 files / 941 tests PASS |
| Disk | 11 GB used / 39 GB (29%); 27 GB free; syslog 2.1 MB + 68 MB compressed; journal 940 MB |
| Swap | 4 GB total (2 GB existing + 2 GB new), /etc/fstab persisted |
| Health monitor | `poly15-health-alert.timer` every 5 min (Telegram on failed unit/disk/endpoint/auto-deploy) |
| Password sync | Windows task `Poly15 Sync Dashboard Password`, daily 07:05 WIB |
| Kelly shrink | 0.18 (from default 0.5) |
| Health state | no health issues; `systemctl --failed` clean |
| Global risk | pilot live: RSS + macro + sentiment; snapshot JSONL; relevance filter added |
| Secrets backup | AES-256 encrypted local archive; key copied locally |
| Data backup | AES-256 encrypted archive; local offsite copy |
| Encrypted backup release | deployed via auto-deploy at 14:38 WIB |
| Auto-deploy | active; VPS deployed `f54856f`; last result success |
| Scheduled jobs | secrets backup 06:35 WIB · password rotation 07:00 WIB · bot backup 07:15 WIB |

> This status block is the only section edited in place. Everything below is append-only.

---

## How to add the next update

1. Put a new entry directly below this line and above the previous newest entry.
2. Copy the template at the bottom.
3. Use one entry per deploy/change set, not one per commit.
4. Include verification evidence and the exact deployed state, or write **not deployed**.
5. Update the **Current status** table only.
6. Commit with: ~~~text
docs(updates): <short description>
~~~

If an earlier entry turns out to be wrong, add a **Correction** entry; do not silently edit the old one.

---

## Entries

### 2026-10-23 — Drag fallback deployed

**Status:** deployed / verified
**Area:** dashboard / UX
**What changed:** occupied-cell drops now move the widget to the nearest free slot instead of snapping back; this was the reason “custom move” looked broken on a nearly-full grid.
**Files / commits:** src/components/dashboard/DashboardShell.tsx; `f54856f`.
**Verification:** browser test: Global Risk dragged onto an occupied cell moved from x0 to x2; no page errors; auto-deploy success at 22:45:09 WIB.
**Deployment:** active.
**Risks / follow-up:** hard refresh once; use Edit layout and drag from the widget header; Auto arrange remains the cleanest reset.

---
### 2026-10-23 — Drag fallback for occupied cells

**Status:** implemented; deploy pending
**Area:** dashboard / UX
**What changed:** dragging a widget onto an occupied 12-column cell now moves it to the nearest free slot instead of snapping back and showing “occupied”.
**Files / commits:** src/components/dashboard/DashboardShell.tsx; UPDATES.md.
**Verification:** frontend typecheck/build PASS; full-grid drag test after deploy.
**Deployment:** pending CI/auto-deploy.
**Risks / follow-up:** drop-to-nearest is more forgiving but less precise; use Edit layout + Auto arrange for a clean layout.

---
### 2026-10-23 — Global Risk migration v2

**Status:** deployed
**Area:** dashboard / UX
**What changed:** bumped the one-time layout migration key so browsers that already ran the first migration also re-flow Global Risk after the visible-layout placement fix.
**Files / commits:** src/components/dashboard/DashboardShell.tsx; `4cafe74`.
**Verification:** auto-deployed at 22:35:56 WIB; source clean; services active.
**Deployment:** active.
**Risks / follow-up:** hard refresh required once; drag/auto-arrange remains available for custom layouts.

---
### 2026-10-23 — Global Risk layout gap fixed

**Status:** deployed / verified
**Area:** dashboard / UX
**What changed:**
- Removed the fixed y:16 default slot that placed Global Risk at the bottom of saved layouts.
- Added a one-time migration for layouts that already stored the old y:16 position.
- Auto-placement for new widgets now uses the **visible** widget layout, so hidden widgets no longer reserve old slots and create a large vertical gap.
**Files / commits:** src/App.tsx; src/components/dashboard/DashboardShell.tsx; UPDATES.md; `bad63db`.
**Verification:** simulated saved layout with 11 hidden widgets + Global Risk at y:16 → after reload Global Risk is at y:5, only 14px below the last visible widget; no page errors.
**Deployment:** active via auto-deploy.
**Risks / follow-up:** the migration runs once per browser; a hard refresh is required to load the new bundle.

---
### 2026-10-23 — Global Risk layout placement fix

**Status:** implemented; deploy pending
**Area:** dashboard / UX
**What changed:**
- Removed the fixed `y:16` default position from the Global Risk widget; new widgets now use the first free 4x3 slot.
- Added a one-time migration for already-saved layouts that placed Global Risk at the old y:16 slot, so it is re-flowed instead of leaving a large gap.
**Files / commits:** src/App.tsx; src/components/dashboard/DashboardShell.tsx; UPDATES.md.
**Verification:** frontend typecheck/build PASS; needs browser verification after deploy.
**Deployment:** pending CI/auto-deploy.
**Risks / follow-up:** users with heavily customized layouts may still prefer to drag the widget; the migration only removes the old default position once.

---
### 2026-10-23 — Global risk pilot deployed

**Status:** deployed / verified
**Area:** monitoring / analytics
**What changed:**
- Auto-deployed `34ef67d` at 22:17:55 WIB; collector, panel and event-study script are live.
- Collector pulls Google News RSS (crypto + market-relevant geopolitics) and Cointelegraph, combines existing ForexFactory macro and F&G sentiment, and writes 5-minute snapshots to `bot/data/global_risk.jsonl`.
- First live snapshot: risk MEDIUM (48), F&G 50 neutral, macro clear, 14 negative headlines.
- Headlines are filtered to the last 24h and geopolitical items require a market/policy relevance keyword.
- Dashboard Global Risk panel renders with no page errors. No entry/sizing/exit rule uses this data.
**Files / commits:** bot/src/monitoring/globalRisk.ts; src/components/GlobalRiskPanel.tsx; bot/scripts/globalRiskStudy.mjs; analysis/2026-10-23/global-risk-pilot.md; `34ef67d`.
**Verification:** source clean at `34ef67d`; bot/auth/nginx/health/auto-deploy active; no failed units; collector log + JSONL observed; panel rendered; event study currently 0 joined trades (snapshots younger than trades).
**Deployment:** active.
**Risks / follow-up:** GDELT returned 429 from the VPS; FRED/CryptoPanic/ACLED/UCDP need credentials/approval; keyword risk scoring is heuristic. Do not use as a gate until forward evaluation.

---
### 2026-10-23 — Global-risk relevance filter

**Status:** implemented; deploy pending
**Area:** monitoring / analytics
**What changed:**
- Geopolitical RSS results now require a market/policy relevance keyword (oil, energy, dollar, Fed, sanctions, tariff, trade, China, Russia, etc.).
- Generic conflict headlines no longer inflate the risk score.
- The Global Risk panel remains record-only; no trading rule uses it.
**Files / commits:** bot/src/monitoring/globalRisk.ts; UPDATES.md.
**Verification:** build/typecheck pending; snapshot after deploy will show the filtered count.
**Deployment:** pending CI/auto-deploy.
**Risks / follow-up:** keyword filtering is a heuristic; continue collecting forward snapshots.

---
### 2026-10-23 — Global risk collector live

**Status:** deployed; quality patch pending auto-deploy
**Area:** monitoring / analytics
**What changed:**
- `globalRisk.ts` started with the bot: 5-minute snapshots, RSS headlines, existing macro calendar and F&G sentiment.
- First snapshot: MEDIUM, 24 headlines, 11 negative; stored in `bot/data/global_risk.jsonl`.
- Global Risk panel is visible in the dashboard and shows macro, sentiment, headlines and freshness.
- Follow-up patch filters headlines to the last 24h and fetches sentiment on first refresh.
**Files / commits:** bot/src/monitoring/globalRisk.ts; src/components/GlobalRiskPanel.tsx; bot/scripts/globalRiskStudy.mjs; analysis/2026-10-23/global-risk-pilot.md; UPDATES.md.
**Verification:** collector log + JSONL observed; panel rendered; no page errors; bot/frontend typecheck/build PASS.
**Deployment:** collector deployed at 22:08 WIB; quality patch pending CI/auto-deploy.
**Risks / follow-up:** keyword scoring is noisy; GDELT was 429 from VPS; no historical snapshots yet. Record-only, not a gate.

---
### 2026-10-23 — Global risk pilot (record-only)

**Status:** implemented; deploy/verification pending
**Area:** monitoring / analytics
**What changed:**
- Added `bot/src/monitoring/globalRisk.ts`: 5-minute keyless RSS collector (Google News crypto/geopolitics + Cointelegraph), combining existing ForexFactory macro and F&G/CoinGecko sentiment.
- Stores timestamped snapshots in `bot/data/global_risk.jsonl`; no trading behavior uses it.
- Added `GlobalRiskPanel` to the dashboard (risk level, macro window, sentiment, headlines, freshness).
- Added `bot/scripts/globalRiskStudy.mjs` to evaluate trades during risk windows once forward data exists.
**Files / commits:** bot/src/monitoring/globalRisk.ts; bot/index.ts; bot/src/loop.ts; src/components/GlobalRiskPanel.tsx; src/App.tsx; bot/scripts/globalRiskStudy.mjs; analysis/2026-10-23/global-risk-pilot.md; UPDATES.md.
**Verification:** bot/frontend typecheck PASS; RSS endpoints tested from VPS; GDELT returned 429 and is deferred.
**Deployment:** pending CI + auto-deploy.
**Risks / follow-up:** keyword scoring is noisy; no historical snapshots; do not use as a gate until forward evidence.

---
### 2026-10-23 — Shadow study release auto-deployed

**Status:** deployed / verified
**Area:** analytics / deployment
**What changed:**
- Auto-deployed commit `4345b9f` at 21:21:11 WIB; source is clean at `4345b9f`.
- Shadow decision study script and pre-registered filter rules are now on the VPS.
- Auto-deploy used the normal CI-gated path; no manual source copy was needed after the worktree was clean.
**Verification:** bot/auth/nginx/tunnel/health/auto-deploy active; `systemctl --failed` clean; source clean; study JSON written; bot still DRY RUN, 833 trades, no open position.
**Deployment:** active.
**Risks / follow-up:** forward checkpoints, a real challenger candidate, remote offsite/Cloudflare credentials, and live readiness remain.

---
### 2026-10-23 — Shadow decision study and pre-registration

**Status:** implemented / record-only
**Area:** ML / analytics
**What changed:**
- Added `bot/scripts/shadowDecisionStudy.mjs`: current-model time split 60/40, Wilson intervals, candidate filter comparison, and a champion/challenger gate.
- On 374 current-model trades (train 224 / test 150):
  - `no-Europe+MID`: test 80 trades, 67.5% WR, +7.04pp margin, +$12.93
  - `no-sideProb-0.6`: test 81 trades, 71.6% WR, +9.86pp margin, +$16.29
  - `no-LATE` and `no-sideProb-0.8`: failed the split
  - combined small filter: 75.8% but only 33 test trades — not promoted
- Added `analysis/2026-10-23/pre-registered-filter-rules.md` with frozen candidates, sequential checkpoints, promotion rules and champion gate.
**Files / commits:** bot/scripts/shadowDecisionStudy.mjs; analysis/2026-10-23/shadow-decision-study.md; analysis/2026-10-23/pre-registered-filter-rules.md; UPDATES.md.
**Verification:** script executed on the VPS journal and wrote `bot/data/shadow_decision_study.json`; no trading rule was changed.
**Deployment:** record-only; source will be deployed by the normal auto-deploy path.
**Risks / follow-up:** split results are selection/validation on the same model history; forward checkpoints are still required. No champion candidate exists yet.

---
### 2026-10-23 — Encrypted backup release auto-deployed

**Status:** deployed / verified
**Area:** backup / security / deployment
**What changed:**
- Auto-deployed commit `9878a22` at 14:38:16 WIB after CI success; source is clean at `9878a22`.
- Encrypted secrets and data backup scripts are now the live versions.
- Dirty-worktree guard blocked the first attempt because the scripts had been installed manually; after cleaning, the normal release path succeeded.
**Verification:** bot/auth/nginx/tunnel/health/auto-deploy active; `systemctl --failed` clean; `DRY_RUN=true`; Kelly 0.18; no open position; backup scripts executable.
**Deployment:** active.
**Risks / follow-up:** key loss means backup loss; remote offsite still needs credentials. Confidence guard/champion and forward filters still need a forward sample.

---
### 2026-10-23 — Encrypted data backup and local offsite copy

**Status:** deployed / verified
**Area:** backup / security
**What changed:**
- `backup-data.sh` now writes `/opt/polybtc15/backups/data-YYYYMMDD-HHMMSS.tar.gz.enc` with the same root-only AES-256 key.
- Old plaintext data archives are retained until normal 14-day retention.
- Latest encrypted secrets and data archives were copied to the local machine as a simple offsite copy.
**Files / commits:** scripts/backup-data.sh; docs/VPS.md; UPDATES.md.
**Verification:** manual run produced a 905 KB encrypted archive; decrypt + tar-list check passed; local key is ACL-restricted to the current user.
**Deployment:** active; next timer run uses the encrypted script.
**Risks / follow-up:** key loss means archive loss. Remote offsite storage still requires credentials.

---
### 2026-10-23 — Encrypted secrets backup

**Status:** deployed / verified
**Area:** security / backup
**What changed:**
- `backup-secrets.sh` now encrypts the archive with AES-256-CBC/PBKDF2 and verifies it can be decrypted before reporting success.
- New archive format: `/home/ubuntu/backups/secure/polybtc15-secrets-YYYY-MM-DD.tar.gz.enc`.
- Key generated root-only at `/root/.poly15-backup.key`; a secure local copy was written to `C:\Users\Asus\.poly15\backup\backup.key` without printing it.
- Existing unencrypted archives are retained until normal 30-day retention; new backups are encrypted.
**Files / commits:** scripts/backup-secrets.sh; docs/VPS.md; UPDATES.md.
**Verification:** manual run produced `.enc`; decrypt + tar-list check passed; key length/ownership verified; no secret printed.
**Deployment:** active on VPS; next timer uses it.
**Risks / follow-up:** key loss means backup loss; key must be stored securely. Off-site replication still needs a destination/credentials. Data backups remain separate.

---
### 2026-10-23 — Monitoring/calibration release auto-deployed

**Status:** deployed / verified
**Area:** ops / monitoring / risk
**What changed:**
- Auto-deployed commit `751bbb2` at 13:10:31 WIB after CI success; source is clean at `751bbb2`.
- Health alert timer is active (failed units, critical services, disk/swap, bot/auth endpoints, auto-deploy result).
- Windows password sync task is tested (last result 0; next run 2026-10-24 07:05 WIB).
- `KELLY_PROB_SHRINK=0.18` remains active after restart.
- Calibration/filter study is stored at analysis/2026-10-23/calibration-filter-study.md.
**Verification:** bot active in DRY RUN, 833 trades / 536W-297L, no open position; boot/auth/nginx/tunnel/health/auto-deploy timers active; `systemctl --failed` clean; no health issues recorded.
**Deployment:** active via auto-deploy.
**Risks / follow-up:** confidence guard and champion/challenger need a forward holdout; session filters were not hardcoded; external Cloudflare/offsite credentials and live-readiness work remain separate.

---
### 2026-10-23 — Health alerting and daily password sync

**Status:** deployed / verified
**Area:** ops / security
**What changed:**
- Added `poly15-health-alert.timer`: checks failed systemd units, critical services, disk >=85%, swap >=80%, bot/auth health endpoints and auto-deploy last result. Sends Telegram only when the issue set changes.
- Installed and tested the health timer; current state has zero issues.
- Added `scripts/sync-dashboard-password.ps1` and a Windows scheduled task at 07:05 WIB to pull the rotated password fallback without printing it.
- Updated the local SSH known-host entry after verifying the VPS ED25519 fingerprint via an authenticated channel.
**Files / commits:** scripts/health-alert.sh; scripts/poly15-health-alert.service; .timer; scripts/install-health-alert.sh; scripts/sync-dashboard-password.ps1; UPDATES.md.
**Verification:** health service exit 0, timer active, `systemctl --failed` clean; scheduled task last result 0. New task next run 2026-10-24 07:05 WIB.
**Deployment:** active.
**Risks / follow-up:** health alert is host-local; password task depends on the local SSH key.

---

### 2026-10-23 — Calibration study and Kelly shrink 0.18

**Status:** analysis complete; sizing applied
**Area:** ML / risk
**What changed:**
- Ran the 60/40 calibration study on 832 rows: best shrink 0.15; test Brier model 0.2561, market 0.2286, shrunk 0.2277.
- Set `KELLY_PROB_SHRINK=0.18` on the VPS (was absent/default 0.5); bot restarted cleanly in DRY RUN.
- Documented current-model forward buckets: Europe and MID negative; side-probability 0.6 and 0.8 buckets negative; 0.7 bucket positive. No hard entry filter was added.
**Files / commits:** analysis/2026-10-23/calibration-filter-study.md; UPDATES.md; VPS `bot/.env`.
**Verification:** bot active, 833 trades / 536W-297L, no open position; calibration report generated; no code entry-rule change.
**Deployment:** sizing active; analysis record-only.
**Risks / follow-up:** confidence guard and champion/challenger still need a held-out forward sample; do not hardcode Europe/MID filters yet.

---
### 2026-10-23 — Logrotate repair and manual password rotation

**Status:** deployed / verified
**Area:** ops / security
**What changed:**
- Removed `rsyslog.bak-*` from `/etc/logrotate.d`; logrotate was failing because the backup was parsed as a duplicate config.
- `logrotate.service` now exits successfully; `systemctl --failed` is clean.
- An audit command exposed a password fallback; the password was rotated immediately, the old password invalidated, and the local password file resynced without printing the new value.
**Files / commits:** UPDATES.md; VPS `/root/rsyslog.bak-*`; rotation script output.
**Verification:** logrotate debug has no errors; old local password 401, new password 200; services active; bot 829 trades / 534W-295L, WR 64.5%, PnL +$15.75, no open position, DRY RUN.
**Deployment:** active.
**Risks / follow-up:** never print secret-file contents in audit output. Consider a safer password sync mechanism. Model Brier remains -5.7% vs market.

---
### 2026-10-23 — Swap increased to 4 GB

**Status:** deployed / verified
**Area:** ops / capacity
**What changed:**
- Added `/swap2.img` 2 GB, enabled it, and persisted it in `/etc/fstab`.
- Existing `/swap.img` 2 GB is unchanged.
- Total swap is now 4 GB; no application or service change.
**Files / commits:** UPDATES.md; VPS `/swap2.img`; `/etc/fstab`.
**Verification:** `free -h` shows 4.0 GiB total; `swapon --show` lists both files; `/proc/swaps` active; disk 11 GB used / 39 GB (29%), 27 GB free; bot/auth/nginx/auto-deploy all active.
**Deployment:** active; persistent across reboot.
**Risks / follow-up:** swap is slower than RAM; monitor `free -h` and `vmstat` (`si/so`). If swap is heavily active, add RAM instead. Disk cost is 2 GB.

---
### 2026-10-22 — Log-throttle release auto-deployed

**Status:** deployed / verified
**Area:** bot / ops / monitoring
**What changed:**
- Auto-deployed commit `4311ea4` at 23:50:14 WIB after CI success; source is clean at `4311ea4`.
- The per-poll INFO summary is now emitted once every 200 polls (debug mode keeps every poll), reducing syslog generation drastically.
- `scripts/nginx-token-sync.sh` mode is fixed in git (0755); auth-sync service now completes successfully.
- Logrotate is daily + maxsize 100M + rotate 7 with `su root syslog`; old syslog compressed to 68 MB.
**Verification:**
- Bot 815 trades, 526W/289L, paper bankroll $62.18, no open position, DRY RUN.
- Services active: bot, auth, nginx, rsyslog, auto-deploy timer; `systemctl --failed` clean.
- Disk 8.2 GB used / 39 GB (22%), 29 GB free; journal 940 MB; active syslog 2.1 MB.
- The dirty-worktree guard also caught the temporary manual `chmod` at 23:48 and blocked the deploy until it was cleaned.
**Files / commits:** bot/src/loop.ts; scripts/nginx-token-sync.sh; UPDATES.md; `4311ea4`.
**Deployment:** active via auto-deploy.
**Risks / follow-up:** logrotate is host-local; old source backups remain intentionally.

---
### 2026-10-22 — Disk pressure root cause, auth-sync repair, log throttle

**Status:** implemented; auto-deploy verification pending
**Area:** ops / monitoring / bot
**What changed:**
- Found `/var/log/syslog` at 1.4 GB because the bot logged a full poll summary every ~50 ms; `/var/log` was also group-writable, so logrotate had been refusing to rotate.
- Fixed logrotate: daily + maxsize 100M + rotate 7 + `su root syslog`; rotated and compressed old syslog (1.4 GB → 68 MB). Journal capped/vacuumed to ~940 MB; apt cache cleaned.
- Fixed `polybot-dashboard-auth-sync.service`: `scripts/nginx-token-sync.sh` lost its execute bit after the bootstrap reset; restored 0755 and reset the failed quick-tunnel unit.
- Reduced per-poll INFO logging to one summary every 200 polls (debug mode still logs every poll); this is the code change deployed by auto-deploy.
**Files / commits:** bot/src/loop.ts; scripts/nginx-token-sync.sh mode; UPDATES.md; VPS logrotate config.
**Verification:** auth-sync service completes 0/SUCCESS; `systemctl --failed` clean; disk 8.2 GB used (22%); syslog rotation debug clean; bot still DRY RUN.
**Deployment:** ops fixes active; bot log-throttle code awaiting CI/auto-deploy.
**Risks / follow-up:** logrotate config is host-local; re-check after OS upgrades. Old bootstrap source backups remain intentionally.

---
### 2026-10-22 — Daily health check and storage cleanup

**Status:** verified
**Area:** ops / docs
**What changed:**
- Rotated dashboard password ran successfully at 07:00 WIB; old local password returned 401, new fallback password returned 200; local password file resynced without exposing it in chat.
- Journald capped at 1 GB (`/etc/systemd/journald.conf.d/90-poly15.conf`); journal usage went from 2.4 GB to ~981 MB, disk from 32% to 27% used.
- Reviewed the latest dry-run report and services.
**Files / commits:** UPDATES.md; VPS config `/etc/systemd/journald.conf.d/90-poly15.conf`.
**Verification:**
- Bot: 814 trades, 525W/289L, WR 64.6%, paper bankroll $61.45, no open position, DRY RUN.
- Latest report: 813 resolved, +$16.20; current model 355 trades, 61.4% WR, +$5.02; Brier skill vs market -5.6% (still negative).
- Services active: bot, auth, nginx, tunnel, watchdog, auto-deploy timer; bot NRestarts=0 since 2026-10-21 22:02 WIB.
- Daily data backups through 2026-10-22 and secure secrets backups through 2026-10-22 exist.
**Deployment:** docs/ops only; no code change.
**Risks / follow-up:** model still has negative Brier skill and Europe remains weak; keep DRY RUN. Auto-deploy remains dry-only/guarded.

---
### 2026-10-21 — Auto-deploy push detection verified

**Status:** verified
**Area:** ops / deployment
**What changed:** pushed docs commit `bffb86a`; the VPS timer detected it at 22:08:10 WIB after CI success and classified it as **docs-only**, so the bot was not restarted. State kept `deployed_sha=c24fa17` and advanced `last_seen_sha=bffb86a`.
**Files / commits:** UPDATES.md; docs/AUTO_DEPLOY.md; `bffb86a`.
**Verification:** `.auto-deploy/auto-deploy.log` shows `docs-only; no server deploy`; bot remained active; source stayed at `c24fa17`.
**Deployment:** timer active every 5 minutes.
**Risks / follow-up:** code commits still wait for no open position; live mode and paused state block auto deploy by design.

---
### 2026-10-21 — Auto-deploy active and verified

**Status:** deployed / verified
**Area:** ops / deployment / security
**What changed:**
- VPS was bootstrapped from the stale 370-commit-behind worktree to a clean `c24fa17` checkout; source backup was taken first.
- Installed the CI-gated pull timer `poly15-auto-deploy.timer` (every 5 minutes).
- The timer refused to deploy while a paper position was open (21:52 and 21:57) and deployed automatically after settlement.
- Successful auto-deploy at 22:02:43–22:03:05 WIB: temp-worktree build, guarded switch, health checks, state `success`.
- Bot restarted in DRY RUN; auth, nginx and password timer remain active.
**Files / commits:** scripts/auto-deploy.sh; systemd units; scripts/install-auto-deploy.sh; docs/AUTO_DEPLOY.md; feature commit `c24fa17`.
**Verification:** full auto path observed in the journal and `.auto-deploy/auto-deploy.log`; git worktree clean at `c24fa17`; auth/bot health OK; current password login 200; Telegram success alert sent.
**Deployment:** active on the VPS.
**Risks / follow-up:** auto-deploy is deliberately disabled in live mode and while paused; deploy script changes require re-running the installer; dirty tracked worktree blocks deploy.

---
### 2026-10-21 — GitHub auto-deploy (pull timer)

**Status:** implemented; bootstrap pending
**Area:** ops / deployment / security
**What changed:** VPS systemd timer checks origin/main every 5 minutes; requires all GitHub Actions checks green, builds in a temp worktree, refuses live/paused/open-position deploys, switches source/node_modules/dist with rollback, and sends Telegram alerts.
**Files / commits:** scripts/auto-deploy.sh; scripts/poly15-auto-deploy.service; scripts/poly15-auto-deploy.timer; scripts/install-auto-deploy.sh; docs/AUTO_DEPLOY.md.
**Verification:** bash -n PASS; CI will run on the commit; end-to-end deploy test pending.
**Deployment:** not yet installed/timer not yet active.
**Risks / follow-up:** live mode is deliberately manual; dirty worktree blocks deploy; installed script must be refreshed manually when the script itself changes.

---
### 2026-10-21 — Update-log policy enforced

**Status:** implemented
**Area:** docs / process
**What changed:** added a mandatory update-log policy to CLAUDE.md. Every future change affecting behaviour, deployment, security, data, configuration or user-visible docs must append a dated entry to UPDATES.md in the same session, newest first; a task is not complete until that entry exists.
**Files / commits:** CLAUDE.md; UPDATES.md.
**Verification:** policy is at the top of CLAUDE.md; entry format follows the template below; no secrets included.
**Deployment:** docs only.
**Risks / follow-up:** keep entries factual and secret-free; corrections are new entries, not rewrites.

---
### 2026-10-21 — Living update log

**Status:** implemented
**Area:** docs / operations
**What changed:** replaced the one-off snapshot with this append-only update log; archived the detailed 2026-10-21 snapshot.
**Files / commits:** UPDATES.md; docs/updates/2026-10-21.md; README link.
**Verification:** links checked; document contains no secrets.
**Deployment:** docs only.
**Risks / follow-up:** update this file for every future change.

---

### 2026-10-21 — Live / dry-run switch from the dashboard

**Status:** deployed; live mode NOT activated
**Area:** trading / dashboard / security
**What changed:**
- Topbar DRY RUN / LIVE badge is now a button with a typed-confirmation dialog.
- Live preflight: CLOB V2 init + readiness/allowance + non-zero pUSD.
- Open positions block switching; paused/disconnected blocks the button.
- Live and dry-run use separate state, audit, journal, verified-journal and entry-snapshot files.
- Live bankroll is seeded from pUSD; live journal and position value use real fills.
- If live startup fails, the bot persists DRY_RUN=true and restarts into safe paper mode.
- Backend command is token-protected through the dashboard WebSocket.
**Files / commits:** bot/src/trading/tradingMode.ts; bot/src/statusServer.ts; bot/index.ts; bot/src/config.ts; src/components/dashboard/DashboardShell.tsx; src/App.tsx; f905d0d.
**Verification:** modal test (did not confirm live); guard tests; live/dry paths checked; full suite 91/941 PASS.
**Deployment:** VPS deployed; bot restarted in DRY RUN; no live order.
**Risks / follow-up:** pUSD ~$25 and 5-share minimum; JEV shadow; do not enable live yet. See detailed report.

---

### 2026-10-21 — Daily dashboard password rotation via Telegram

**Status:** deployed
**Area:** security / auth / ops
**What changed:**
- New random password every day at 07:00 WIB.
- scrypt hash written atomically to /opt/polybtc15/dashboard-password.hash.
- Auth server reads the hash per login; no restart and no session invalidation on rotation.
- Telegram delivery via existing bot token/chat; previous password message deleted when possible.
- Root-only fallback at /root/.poly15-dashboard-password-latest.
- Persistent systemd timer catches up once after downtime.
**Files / commits:** scripts/rotate-dashboard-password.mjs; scripts/dashboard-auth-server.mjs; service/timer; scripts/backup-secrets.sh; 029ace2.
**Verification:** dry run OK; Telegram test sent; hot-reload drill test password 200 → restore current password 200; timer next 2026-10-22 07:00 WIB.
**Deployment:** timer active.
**Risks / follow-up:** Telegram chat access exposes the password; fallback is root-only. First real rotation is the next 07:00 WIB.

---

### 2026-10-21 — Security hardening, clean UI, delivery and test hardening

**Status:** deployed
**Area:** security / UI / tests / delivery
**What changed:**
- Dashboard password rotated; previous password invalidated.
- Root-only daily secrets backup (auth.env, Cloudflare tunnel, nginx, units); restore drill passed.
- Clean UI pass: compact health indicator, overflow menu, removed descriptions/categories/duplicate titles, softer canvas.
- Drift gate tests and auth gateway HTTP tests added; CLOB cold-import timeout raised.
- Cloudflare Insights CSP fixed; Vite bundles split.
**Files / commits:** a5a9a7a.
**Verification:** 90 files / 938 tests PASS at that commit; browser checks; restore drill.
**Deployment:** VPS + nginx; bot active.
**Risks / follow-up:** model/trading unchanged; see the detailed snapshot.

---

### 2026-10-21 — Drift false-positive fix

**Status:** deployed
**Area:** monitoring / ML
**What changed:** drift detector now compares live accuracy to a live same-model baseline, not offline test accuracy, and uses a minimum 50-trade reference window.
**Files / commits:** bot/src/monitoring/driftDetector.ts; 214489b.
**Verification:** 5 gate tests; last check 50-trade acc 66% vs live baseline 64.06%, CUSUM 0, driftDetected:false.
**Deployment:** active.
**Risks / follow-up:** confidence is advisory only; no auto-action.

---

### 2026-10-21 — Price-source clarity, sticky-header blur, flat brand

**Status:** deployed
**Area:** UI / dashboard
**What changed:**
- ORACLE is the primary price source; Binance remains in Market Pulse with a BASIS label.
- Scroll blur veil prevents content smearing under the sticky header.
- Flat P monogram replaces the glossy mark; favicon/PWA/OG updated.
**Files / commits:** ab78886; 2faa995; 5377c17; c39b9a4.
**Verification:** browser screenshots and scrolled checks; 16/16 widgets.
**Deployment:** frontend deployed.
**Risks / follow-up:** none operational.

---

### 2026-10-20 — Dashboard cutover, login/session auth, bankroll labels, watchdog fix

**Status:** deployed
**Area:** infrastructure / auth / bot / UI
**What changed:**
- Dashboard moved to https://poly15.dollarkilat.xyz/ via a named Cloudflare Tunnel; Quick Tunnel disabled.
- Custom animated login page + session-auth gateway; nginx auth_request protects /ws and report APIs.
- Public dashboard WS auth recovery/reconnect improved.
- Startup log now distinguishes configured bankroll from loaded state; paper labels clarified.
- Bot heartbeat now advances on every completed poll, fixing false watchdog restarts during long signal holds.
- Smooth requestAnimationFrame drag/resize and mobile compact reorder.
**Files / commits:** be68356; b36642a; 59e7a4b; 28e2dc3; 9f00bbe; 792c161; e6b57ca; c20db0c; 2e577ca.
**Verification:** public URL, login/wrong-password/session/reload/logout, 16 widgets, desktop/tablet/mobile; bot stable.
**Deployment:** VPS + nginx + tunnel.
**Risks / follow-up:** named tunnel requires Cloudflare config; see docs/DOMAIN.md and docs/VPS.md.

---

### 2026-10-19 — JEV shadow layer, dashboard v4, CLOB V2/VPS cutover

**Status:** deployed; JEV shadow only
**Area:** trading / dashboard / infrastructure
**What changed:**
- JEV independent-v2 state through OpenRouter; entry-time decisions logged; no veto/size/execute.
- Dashboard v4 draggable/resizable widget workspace, presets, widget library, accent/density, layout persistence.
- CLOB V2 code deployed; live path still gated by pUSD funding, 5-share minimum and a final smoke order.
- Railway shut down; VPS is production.
- Dry-run-only early-time entry probe; live ceiling remains 68c (dry-run 75c).
**Files / commits:** e636fe1; 26c933c; cae3877; 4621106; 4f08eb1; and related 2026-10-19 commits.
**Verification:** dashboard interactions, JEV shadow logs, CLOB preflight read-only checks.
**Deployment:** VPS; bot DRY RUN.
**Risks / follow-up:** JEV sample too small; keep shadow until at least 100 resolved markets. Model/rule edge remains thin.

---

## Older detailed snapshots

- [2026-10-21 complete snapshot](docs/updates/2026-10-21.md) — detailed status, security, live/dry mode, ML metrics, verification and operations.
- [JEV independent-v2 calibration study](analysis/2026-10-19/jev-independent-v2-calibration-study.md)
- [Dashboard v4 report](analysis/2026-10-19/dashboard-v4-redesign.md)

---

## Entry template

~~~markdown
### YYYY-MM-DD — <short title>

**Status:** planned | implemented | deployed | verified | reverted
**Area:** dashboard / trading / ML / security / ops / docs
**What changed:**
- ...
**Files / commits:** ...
**Verification:** ...
**Deployment:** ...
**Risks / follow-up:** ...
~~~

## Rules

1. **Newest first** under `## Entries`.
2. **Append-only**: old entries stay; corrections are new entries titled `YYYY-MM-DD — Correction: ...`.
3. **One entry per change set**, not one per commit.
4. **State the truth**: if it is coded but not deployed, say so. If verified, say how.
5. **No secrets** — no password, token, key, cookie, tunnel credential, or private wallet data.
6. **Link evidence** — detailed report, screenshot, test count, commit hash.
7. **Update the current status table** when bot/security/ops state changes.
8. **Use WIB** for times; include UTC in parentheses only when needed.
9. **Definition of done:** before the final response, confirm the new UPDATES.md entry exists and matches the deployed state.
