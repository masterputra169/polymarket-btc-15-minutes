# Feedback streak corruption — root cause & fix (2026-10-19)

## Symptom

The Accuracy card showed `Streak (sample) 4L` while the journal reported `currentStreak 1L`.

## Root cause (confirmed with data)

`autoSettle()` settles a prediction from BTC spot ~3 seconds before expiry. The journal then resolves
the market on the Chainlink/TWAP outcome and `fallbackVerifier` corrects the journal row. That
correction never touched the feedback cache, so Accuracy/streak/calibration kept the wrong outcomes.

Concrete cache before the fix (5 settled predictions):

| Slug | Side | Feedback result | Verified journal |
| --- | --- | --- | --- |
| …1792381500 | DOWN | UP (loss) | **DOWN (win)** |
| …1792382400 | DOWN | UP (loss) | **DOWN (win)** |
| …1792396800 | DOWN | UP (loss) | **DOWN (win)** |
| …1792398600 | DOWN | UP (loss) | UP (loss) |

So the true sample was 4W/1L (80%, streak 1L); the card showed 1W/4L (20%, streak 4L).

## Fix

- New `reconcilePrediction(marketSlug, verifiedOutcome)` in `src/engines/feedback/store.ts`: corrects settled predictions and their `actualResult`; does not double-count signal-performance counters.
- `fallbackVerifier` calls it on every verified resolution (both `confirmed` and `corrected`), so future corrections reach the feedback cache automatically.
- One-off backlog tool `bot/scripts/reconcileFeedback.mts` (run on the VPS with the bot stopped): reconciled **3 predictions** against 746 verified journal outcomes; cache now 4/5 correct, streak 1L.
- Because the feedback sample feeds the confidence multiplier / sizing / probability modifiers, the evaluation window was reset again: `EVAL_WINDOW_START=2026-10-19T12:25:44Z`.

## Verification

- Dashboard snapshot after restart: `feedbackStats.accuracy=0.8`, `total=5`, `correct=4`, `streak={loss,1}`, `label="🔥 Hot (80% of last 5)"`; `detailedFeedback.streak={loss,1}`.
- `npm run typecheck` PASS; `npx vitest run` **86 files / 917 tests PASS** (2 reconcile tests added).

## Caveat

The streak/sample still comes from the 24 h prediction cache (n=5). It is now **correct**, but small;
the reliable long-run number is the **Trade accuracy — full journal** section (749 trades, 64.8% WR).
