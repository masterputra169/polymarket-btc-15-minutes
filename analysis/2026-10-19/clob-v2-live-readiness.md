# CLOB V2 live readiness — 2026-10-19

## What was verified on the VPS

| Check | Result |
| --- | --- |
| L2 auth against CLOB V2 | OK (API key listed on the account) |
| Closed-only mode | no |
| Open orders before/after | 0 / 0 |
| CLOB order version | 2 |
| CTF Exchange V2 | `0xE111180000d2663C0091e4f400237545B87B996B` |
| pUSD collateral | `0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB` |
| Funder pUSD balance | **$25.36** (USDC.e $0.00) |
| pUSD allowance to CTF Exchange V2 | max |
| CTF setApprovalForAll | yes |
| Neg Risk Exchange V2 allowance/approval | max / yes (unused by BTC 15m) |
| Polygon RPC | default `polygon-rpc.com` is disabled (401) -> set `POLYGON_RPC_URL=https://polygon-bor-rpc.publicnode.com` |
| 5-share post-only GTD smoke order | PASS — placed LIVE at 0.01 for 5 UP shares, then CANCELED, open orders 0 |

## Env changes

- `POLYGON_RPC_URL=https://polygon-bor-rpc.publicnode.com` (required for live readiness + on-chain reads).
- `FOK_MIN_SHARES_LOW=5` (matches the live market minimum; dry-run and live now agree).
- Evaluation window reset one more time after the min-share change: `EVAL_WINDOW_START=2026-10-19T11:07:51Z` (the previous 0-trade window was discarded).

## What is still required before `DRY_RUN=false`

1. **Bankroll sync**: internal bankroll is ~$59.75 (dry-run history) but the funder holds **$25.36 pUSD**. Live sizing must start from ~$25.36 (dashboard `setBankroll`) or the account must be funded further.
2. **Minimum size economics**: BTC 15m markets need **5 shares minimum**. At $25.36 bankroll a typical Kelly stake (~$1.25) is ~2.5 shares, so the live path will refuse most orders. Either fund the account (roughly $100+ makes normal sizing fit) or accept that live trading will be very selective. Do NOT upsize automatically.
3. Optional: a `--mode fok` smoke order (~$3) to confirm `makingAmount` vs the pUSD balance change and whether the reported cost includes the taker fee (the `journalReconciler` fee question).
4. Flip `DRY_RUN=false`, restart, watch the first sessions and the evaluation report. Rollback = `DRY_RUN=true` + restart.

## Already proven

- Signing, posting, and cancelling a real V2 order work through the bot's own `clobClient` functions.
- The bot stays DRY RUN; the smoke order was a separate process and left no position/order behind.
