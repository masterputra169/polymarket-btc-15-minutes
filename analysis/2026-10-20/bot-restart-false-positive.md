# Bot restart loop — root cause and fix (2026-10-20)

## Symptom

`polybtc15-bot` was restarted by `polybot-watchdog` at **10:00, 10:16 and 10:21 WIB**. Systemd showed `NRestarts=0` because the watchdog uses `systemctl restart` (manual restarts are not counted in `NRestarts`).

## Root cause

`botLiveness.mts` reads the newest `to` timestamp from `bot/data/ptb_health.jsonl` and treats a gap >10 minutes as "bot alive but blind". That file was only written after `applyTradeFilters()` was reached.

During the affected window the bot was **alive and polling every ~50 ms**, but held entries because the signal-confirmation gate was waiting for 180 stable polls (`Signal unstable, holding: confirm 90/180` in the log). `applyTradeFilters()` was never reached, so no rollup was written. After 10 minutes the watchdog interpreted the silence as a dead feed and restarted the bot.

Evidence: `ptb_health` had a rollup at 09:48, then nothing until 10:00:43 (the restart), then gaps until 10:21. The watchdog logged `liveness exit 2 — restarting polybtc15-bot` at 10:00, 10:16 and 10:21.

## Fix

- Added `recordPollHeartbeat()` in `bot/src/monitoring/ptbHealth.ts`.
- The loop calls it after it has a usable Polymarket snapshot, before any hold / transition / expiry return.
- It advances the durable `to` timestamp without counting as a filter evaluation (`heartbeat` count, `total=0`, `exactPct=null`).
- Regression test added to `ptbHealth.test.ts`.

## Verification

- After deploy, a heartbeat line advanced every ~60 s: `heartbeat=569, total=0`.
- `botLiveness` returned `{"status":"fresh","ageMin":0.7}`.
- Service remained `active (running)` with `NRestarts=0`, no watchdog restart.
- Targeted tests: 14/14 PASS. Full suite: see README latest update.