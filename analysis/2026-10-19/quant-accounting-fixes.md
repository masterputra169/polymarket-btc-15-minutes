# Quant/accounting fixes — 2026-10-19

## 1. Early-exit taker fee (dry-run accounting bug) — FIXED

- `earlyExitPnl(pos, recoveredUsdc, exitFee = 0)` and `settleTradeEarlyExit(recoveredUsdc, exitFee = 0)` now subtract the sell-leg taker fee from both the journal P&L and the bankroll.
- Dry-run call sites pass `takerFee(shares, sellPrice)`: emergency cut, smart sell-first, cut-loss, take-profit, dashboard sell.
- Live early exits still pass 0 until a real V2 fill proves whether `takingAmount` is already net of fee (`journalReconciler` question remains open).
- Tests: existing P&L test still passes; new test asserts P&L and bankroll net of both fees (entry 0.17 + exit 0.17 on 10 shares @0.6).

## 2. Signal confirmation window (logic bug) — FIXED

- `signalStability.ts` used `CONFIG.pollIntervalMs` (browser default 3000 ms → 3 polls). At the deployed `POLL_INTERVAL_MS=50` that was ~150 ms, not the intended ~9 s.
- Now `SIGNAL_CONFIRM_POLLS = max(2, round(9000 / POLL_INTERVAL_MS))`: **180 polls at 50 ms** = 9 s.
- This changes trade selection → evaluation window reset. Archived window `2026-10-19T11:07:51Z → 12:04:33Z` had 0 trades.
- New window: `EVAL_WINDOW_START=2026-10-19T12:04:33Z`.

## 3. JEV direction vs settle probability (integration risk) — FIXED

- Baseline: 22 unique JEV markets, 2 mismatches (9.1%) where `direction` contradicted `settle_above_ptb`; both had confidence <0.60 so no wrong veto had fired.
- New config `JEV_SETTLE_MARGIN=0.05` (bounds 0–0.20). A veto/gate/primary/sizing agreement now requires:
  - UP with `settleUp >= 0.55`, or DOWN with `settleUp <= 0.45`.
- A contradictory high-confidence decision no longer vetoes/overrides.
- Unit tests added: veto ignores contradiction, gate blocks it, primary refuses it.

## Verification

- `npm run typecheck` PASS; `npx vitest run` **85 files / 915 tests PASS**.
- Deployed to VPS and restarted: bot active DRY RUN, JEV ACTIVE veto, PolyBolt connected, loop shows `Stab:x/180`.
- New eval window starts with the new selection logic; old window archived.

## Still open (not fixable before live)

- Live `takingAmount` gross/net (exit fee) must be measured with one real V2 fill.
- `journalReconciler` fee handling (same measurement).
- Bankroll internal $59.75 vs pUSD $25.36 and the 5-share minimum before going live.
