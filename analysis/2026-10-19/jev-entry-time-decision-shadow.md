# Entry-time JEV decision shadow — 2026-10-19

## What changed

The JEV policy sample is a fixed market-open call. It is intentionally unbiased, but it cannot answer "what would JEV say at the actual entry decision?" without a second, current-state call.

Added a separate **entry-time decision shadow** (`JEV_DECISION_SHADOW=true`):

- one JEV call at the first `ENTER` candidate of each market,
- record-only; fire-and-forget; no veto, no gate, no sizing change,
- separate log `data/jev_decision.jsonl`, so the fixed-policy sample in `jev_log.jsonl` stays clean,
- no update to the cached decision or policy candidate log.

Also tightened the policy sample: `JEV_POLICY_MIN_TIME_LEFT=13.5`, so a mid-window restart can no longer add a late, biased sample call. Policy samples are now taken only near market open; forced entry refreshes are still analysed separately.

## First decision record

2026-10-19 22:45:37 WIB, `btc-updown-15m-1792424700`:

- bot rule: `ENTER DOWN`, VERY_HIGH confidence, edge 20.8%, ML side DOWN (p(UP)=0.449),
- JEV independent: **DOWN 37%**, settle_up 7%, regime trending_down, latency 550 ms,
- policy sample at 22:45:36: DOWN 37% — same direction, confidence below the 0.60 candidate gate,
- therefore no policy candidate and no gate pass; trade remains bot-only (dry run).

## Resolution guard fix

The first report run treated a still-open Gamma market as resolved because its `outcomePrices` were 0.5/0.5. Fixed in `jevDecisionReport.mts`, `jevPolicyReport.mts` and `jevEvaluate.mts`:

- require `market.closed === true`,
- require the outcome prices to contain a winner ≥0.99 and a loser ≤0.01,
- an open market is never counted; the decision cache was cleared and the report now shows `resolved 0, open 1`.

## Status

- Service active, DRY RUN, JEV shadow.
- Fixed-policy sample: one market-open call at 22:45 (DOWN 37%, no candidate).
- Decision shadow: one entry-time call recorded; outcome pending until 23:00 WIB.
- Full suite: **87 files / 924 tests PASS**.

## What this enables

Once the decision sample grows, `jevDecisionReport.mts` can answer:

- agreement between market-open sample and entry-time decision,
- hypothetical fixed-policy PnL at the entry decision,
- how many bot entries JEV opposed, and whether the bot won those,
- whether an eventual JEV veto would have helped or hurt.

This is still **shadow**; nothing in the trade path consumes the decision call.