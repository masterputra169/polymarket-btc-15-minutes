# Alert system overhaul — 2026-10-19

## What changed

| Area | Before | Now |
| --- | --- | --- |
| Format | one line `ℹ️ [BTC15m Bot] text` | header line (`ℹ️ BTC15m`, `⚠️ BTC15m · WARN`, `🚨 BTC15m · CRITICAL`) + structured HTML blocks |
| Buttons | one extracted `<a>` link + Profile + Web (stale Railway default) | up to 3 extracted links + Profile + optional Web from `DASHBOARD_URL`; no hardcoded Railway fallback |
| Trade entry | one long line | template: side/price, shares/cost, edge, ML, JEV, phase/time left, regime, flow, bankroll, market button |
| Settlement | (already rich) | adds the JEV decision line for the settled market |
| Startup | none | formatted startup alert (mode, bankroll, JEV mode/provider, TWAP feed, CLOB V2); `TELEGRAM_NOTIFY_STARTUP=false` disables |
| Feed health | none | new `feedGuard.ts`: PTB not exact (120 s + 20 s observation), PolyBolt disconnected/stale (60 s), CLOB book down (60 s), with recovery messages |
| Discord | raw Telegram HTML | plain-text conversion (`label (url)`, tags stripped) |
| Safety | — | 3900-char cap, HTML-escaped dynamic values in templates, per-key 60 s rate limit, test reset helper |
| Watchdog | plain text | HTML alert with dashboard link and exit code |

## Files

- `bot/src/monitoring/alertTemplates.ts` — pure formatters (entry, startup, feed) + escaping.
- `bot/src/monitoring/feedGuard.ts` — transition-based feed alerts (never throws in the poll loop).
- `bot/src/monitoring/notifier.ts` — header, multi-button extraction, Discord conversion, truncation, boolean result.
- `bot/src/engines/tradePipeline.ts` — entry alerts use `tradeEntryAlert`.
- `bot/src/trading/tradeJournal.ts` — settlement alert includes JEV.
- `bot/src/loop.ts` — calls `checkFeedAlerts` each poll.
- `bot/index.ts` — startup alert.
- `bot/scripts/alertTest.mts` — sends one real test alert (`node --env-file=./.env scripts/alertTest.mts`).

## Verification

- `npm run typecheck` PASS; `npx vitest run` **85 files / 910 tests PASS** (7 feed-guard + 4 template tests added; notifier button tests rewritten).
- Deployed to the VPS and restarted: startup alert sent, no false feed alert after the PTB observation grace was added, bot DRY RUN + JEV veto active.
- One real test alert was sent to Telegram (`alert sent`, exit 0).
