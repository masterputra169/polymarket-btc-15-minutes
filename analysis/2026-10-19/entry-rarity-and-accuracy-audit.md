# Entry rarity & Accuracy panel — audit 2026-10-19

## Entry rarity: what the data says

- Since the 12:04 UTC deploy (9 s confirmation), the log shows `Stab` reaching **535/180**; the confirmation window is **not** the binding constraint.
- 0 trades since the window reset. The top filter reasons in the same period are:
  - entry price above the dry-run 75c hard cap (84c/82c/83c/87c …),
  - extreme price outside 15–85c,
  - market near 50/50 (47–53c),
  - JEV veto: `JEV DOWN (69%) disagrees with UP` (591 log occurrences; repeated each poll, so far fewer unique decisions).
- There is **no network “gateway” bottleneck**: MetEngine is disabled (`METENGINE_ENABLED=false`); the only external decision gate is JEV, and the rest are local filters.
- The bot is by design selective (~4–8 trades/day historically); dry-run additionally refuses >75c entries, and current markets often trade 80–88c, so stretches with no entry are expected.

## Accuracy panel: what was wrong

- The panel read `feedbackStats` / `detailedFeedback`, whose history is filtered to the **last 24 h** (and predictions are only recorded on entry). Current snapshot: n=5 settled, accuracy 20%, rolling 20/50/100 null.
- The real journal has **749 settled trades, 64.8% win rate, +14.10 net P&L**. The panel showed only the tiny prediction sample with no context, so it looked “wrong”.
- Browser-only `signalPerf` / CRPS are typically empty on a fresh browser, adding to the confusion.
- Fix: the Accuracy card now leads with **Trade accuracy — full journal** (trades, WR, net P&L, ROI, W/L, avg win/loss, hold), and labels the adaptive sample as **Prediction sample — rolling (last 24h)** with n. Regime/calibration sections are explicitly part of that sample.

## JEV additions (record-only)

- Tape `d` lines now carry `jd` (U/D/N), `jc` (confidence), `js` (settle-up probability), `jg` (regime) from the latest cached JEV decision for the same market; verified `"jd":"D"` in the current tape file (57 lines).
- Dashboard JEV panel shows **Edge vs mkt**: `settleUp − marketUp` for UP and `(1−settleUp) − marketDown` for DOWN (percentage points).
- No change to trade selection; no window reset needed.

## Verification

- `npm run typecheck` PASS; `npx vitest run` **85 files / 915 tests PASS**.
- Deployed to the VPS, bot active; dashboard bundle contains “Trade accuracy — full journal”.
