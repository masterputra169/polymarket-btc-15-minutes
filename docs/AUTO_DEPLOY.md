# Auto-deploy (GitHub -> VPS)

## Status

**Active since 2026-10-21 22:03 WIB.** Last deployed commit: `751bbb2` (2026-10-23 13:10 WIB). Timer runs every 5 minutes. The first end-to-end run was blocked twice by an open paper position, then deployed automatically after settlement.

## What it does

A systemd timer on the VPS checks <code>origin/main</code> every **5 minutes**. When a new commit appears, it:

1. waits until **all GitHub Actions checks for that commit are successful**;
2. refuses to deploy when the bot is in **live money mode**, **paused**, or has an **open position**;
3. builds the target commit in a temporary git worktree (bot is not touched);
4. stops the bot only for the switch;
5. swaps the built <code>node_modules</code>/<code>dist</code>, resets tracked source to the target commit, and restarts;
6. health-checks the bot, auth gateway and dashboard HTML;
7. rolls back to the previous commit and node_modules/dist on failure;
8. sends a Telegram success/failure alert.

No GitHub SSH deploy secret is needed: the VPS pulls a public repository. Latency is up to ~5 minutes after CI finishes.

## Why pull instead of push

- No inbound deploy endpoint.
- No long-lived GitHub Actions SSH key.
- CI must finish before the VPS acts.
- The script can inspect the live bot state before restarting it.

## Safety guards

- **CI gate:** every check run for the commit must be completed and successful.
- **Dry-only:** <code>DRY_RUN=true</code> is required. Live trading is never auto-restarted.
- **No open position:** checked from <code>state.json</code> and the bot WebSocket snapshot.
- **Paused:** a paused bot is not restarted by the timer.
- **Dirty worktree:** if tracked files have local edits, the script refuses to overwrite them and alerts.
- **Docs-only commits:** <code>*.md</code>, <code>analysis/</code>, <code>docs/</code>, <code>ml_registry/</code>, <code>.github/</code> do not restart the bot; the SHA is marked seen.
- **Atomic-ish switch:** source, node_modules and dist are switched together; failure triggers rollback.

## Installed files

~~~text
/usr/local/sbin/poly15-auto-deploy                 # stable installed script
/etc/systemd/system/poly15-auto-deploy.service
/etc/systemd/system/poly15-auto-deploy.timer
/opt/polybtc15/.auto-deploy/state.json              # deployed/seen SHA
/opt/polybtc15/.auto-deploy/auto-deploy.log         # deploy log
~~~

Repository sources:

~~~text
scripts/auto-deploy.sh
scripts/poly15-auto-deploy.service
scripts/poly15-auto-deploy.timer
scripts/install-auto-deploy.sh
~~~

## Install / refresh

Run as root on the VPS:

~~~bash
cd /opt/polybtc15
sudo bash scripts/install-auto-deploy.sh
systemctl list-timers poly15-auto-deploy.timer
~~~

The installed <code>/usr/local/sbin/poly15-auto-deploy</code> is intentionally outside the git worktree, so a deploy cannot replace the running deploy script mid-switch. If the script itself changes in git, re-run the installer.

## Manual trigger

~~~bash
sudo systemctl start poly15-auto-deploy.service
journalctl -u poly15-auto-deploy.service -f
tail -f /opt/polybtc15/.auto-deploy/auto-deploy.log
cat /opt/polybtc15/.auto-deploy/state.json
~~~

The timer will also run it automatically every 5 minutes.

## Rollback

On a switch failure the script automatically:

1. resets tracked source to the previous SHA;
2. restores the previous <code>node_modules</code> and <code>dist</code>;
3. starts the bot;
4. restarts auth if it had changed;
5. writes <code>last_result=rolled-back</code> and alerts Telegram.

If the VPS itself is lost, use the daily secrets/data backups. The source is always recoverable from GitHub.

## Push-detection verification

- **2026-10-22 23:50 WIB** — code commit `4311ea4` auto-deployed; dirty-worktree guard blocked the first attempt after a manual chmod, then the clean release deployed successfully.

- **2026-10-21 22:03 WIB** — code commit `c24fa17` auto-deployed after the open paper position settled; health checks passed.
- **2026-10-21 22:08 WIB** — docs commit `bffb86a` detected, CI-green, classified docs-only; bot stayed up and source stayed on `c24fa17`.

## Troubleshooting

| Symptom | Check |
|---|---|
| No deploy after push | GitHub Actions status; CI must be green for that exact SHA |
| <code>worktree dirty</code> | <code>git -C /opt/polybtc15 status --porcelain --untracked-files=no</code>; clean tracked edits manually |
| <code>blocked: live mode</code> | expected; deploy is manual while <code>DRY_RUN=false</code> |
| <code>blocked: position open</code> | wait for settlement; next timer retries |
| <code>blocked: bot paused</code> | resume the bot first |
| <code>CI pending</code> | normal right after push; next timer retries |
| Build failed | build runs in a temp worktree; bot stays on the old release |
| Rolled back | inspect journal + log; push a fix; next commit is a new target |

## Notes

- Docs-only commits do not need a VPS restart; GitHub is the source of truth for docs.
- The script checks the public GitHub check-runs API. It reads no secrets from GitHub.
- The auto-deploy timer runs as <code>ubuntu</code>; system service control uses the existing passwordless sudo.
- Auto-deploy deliberately refuses live mode. Live deployment should be an explicit operator action.
- The password rotation hash, <code>auth.env</code>, <code>bot/.env</code>, <code>bot/data/</code> and backups are outside git and are preserved by the reset.
