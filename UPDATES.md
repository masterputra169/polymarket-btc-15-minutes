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
| Paper bankroll | $61.45 · 814 trades · 525W / 289L |
| Dashboard | https://poly15.dollarkilat.xyz/ · 16 widgets |
| Auth | session login; daily password rotation at 07:00 WIB via Telegram |
| Live/dry switch | available; **live not activated** |
| Drift | no drift at last check |
| Tests | 91 files / 941 tests PASS |
| Disk | 8.2 GB used / 39 GB (22%); 29 GB free; logrotate daily/maxsize 100M |
| Auto-deploy | active; VPS deployed `c24fa17`; docs-only `c39f55a` seen |
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
