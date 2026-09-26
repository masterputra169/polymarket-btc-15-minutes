# CLOB V2 migration — operator checklist

Polymarket's CLOB V2 went live on 2026-04-28. It rejects orders signed by the
V1 SDK (`@polymarket/clob-client`, EIP-712 domain version `"1"`), so until
branch `feat/clob-v2` every live order the bot sent would have been refused.
Dry run was never affected: it does not build the CLOB client.

This page lists what changed in the code, then the steps that stay manual
before the first live order: API key check, pUSD funding, two approval
transactions, and a 5-share smoke test.

Sources: docs.polymarket.com `/v2-migration`, `/resources/contracts`,
`/concepts/pusd`, `/trading/wallets-auth`, `/trading/place-orders` (read
2026-09-27), and the published `@polymarket/clob-client-v2` 1.2.0 package.

## What changed in the code

| Area | Before (V1) | Now (V2) |
|---|---|---|
| SDK | `@polymarket/clob-client` 5.8.1 | `@polymarket/clob-client-v2` **1.2.0, pinned exactly** |
| Constructor | 13 positional args, `chainId` | options object, `chain` (`clobV2Config.ts` → `buildClobClientOptions`) |
| Signer | ethers v6 wallet + `_signTypedData` shim | viem wallet client, signing locally |
| Signed order | `nonce`, `feeRateBps`, `taker`, domain `"1"`, exchange `0x4bFb…982E` | `timestamp` (ms), `metadata`, `builder`, domain `"2"`, CTF Exchange V2 `0xE111…B996B` |
| Fees | rate embedded in the signed order | charged by the protocol at match, takers only |
| Collateral | USDC.e | pUSD |
| `postOnly` | — | 4th argument of `createAndPostOrder`; `placeLimitBuyOrder({ …, postOnly })`, default `false` |
| API keys | L1/L2 auth | unchanged — existing keys keep working |

Unchanged: `clobClient.ts` exports the same functions as before, so `loop.ts`,
`tradePipeline.ts`, `limitOrderManager.ts`, `positionManager.ts`,
`fillTracker.ts` and `journalReconciler.ts` did not change. FOK entries are
market orders (`createAndPostMarketOrder`, amount in dollars), sells are FOK
market SELLs (amount in shares), and passive entries are GTD limit BUYs.

New behaviour on the live path only:

- **Price rounded to the market tick, inward.** A BUY price is a maximum, so it
  is rounded down; a SELL price is a minimum, so it is rounded up. Every level
  in the book sits on the tick grid, so the rounded order fills against exactly
  the levels the unrounded one would, and never at a worse price.
  `fokBuyPrice()` still rounds to 0.001, and the dry run still charges that
  price; only the live order is rounded.
- **Orders under the market minimum are refused, never upsized.** BTC 15m
  markets have `min_order_size` 5 shares and `tick_size` 0.01. The bot reads
  both from the REST `/book` and Gamma market it already fetches
  (`dataFetcher.ts` → `orderConstraints.ts`), and falls back to 5 / 0.01. A
  refused order logs `BUY rejected before signing: size 2 shares is below the
  market minimum of 5 …` and the trade is not taken.
- **GTD orders need 3 minutes of lead.** The CLOB rejects a GTD expiring less
  than 180 s ahead. The bot refuses it before signing, with a log line, and
  the limit path falls back to FOK. With the defaults (`LIMIT_MAX_ELAPSED_MIN`
  9, `LIMIT_EXPIRATION_BUFFER_SEC` 120) the latest placement still has 240 s of
  lead. Live startup warns when an override brings it under 180 s.
- **No wait for settlement hashes.** SDK 1.2.0's `postOrder` polls trades for
  up to 30 s after a match to collect settlement transaction hashes. That is
  longer than the bot's 15 s order timeout, so a filled FOK could have been
  logged as a failure and left untracked. The bot turns that wait off
  (`skipSettlementWait`), since fills are read from `makingAmount` /
  `takingAmount` and verified later. It overrides a private SDK method, which
  is why the SDK version is pinned; a test fails if a new version drops it, and
  live start refuses to proceed.
- **Live startup fails closed** unless the funder wallet holds pUSD, has
  approved CTF Exchange V2 for pUSD and for its outcome tokens, and the CLOB's
  `/version` is 2 (`verifyClobV2Readiness`, Polygon view calls only). The old
  startup call `updateBalanceAllowance` never approved anything: it only asks
  the CLOB to refresh its cached view of the allowance. It is still called,
  and the log now says so.

Nothing in this change wraps USDC.e, approves a token, or sends any other
transaction.

## Contracts (Polygon, chain id 137)

| Contract | Address |
|---|---|
| CTF Exchange V2 (standard markets; BTC 15m) | `0xE111180000d2663C0091e4f400237545B87B996B` |
| Neg Risk CTF Exchange V2 (not used by BTC 15m) | `0xe2222d279d744050d28e00520010520000310F59` |
| pUSD (collateral, 6 decimals) | `0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB` |
| Conditional Tokens (ERC-1155 outcome shares) | `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045` |
| CollateralOnramp (`wrap` USDC.e → pUSD) | `0x93070a847efEf7F70739046A929D47a521F5B8ee` |
| USDC.e (V1 collateral) | `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` |

Approvals are per spender. The V1 approvals named the old exchange
(`0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E`), so they do not carry over.

## 1. Environment variables (names only)

| Variable | Required | Purpose |
|---|---|---|
| `DRY_RUN` | yes | `false` to trade live. Leave `true` until step 5 passes. |
| `POLYMARKET_PRIVATE_KEY` | live | Signer key. Never printed or logged. |
| `POLYMARKET_API_KEY`, `POLYMARKET_API_SECRET`, `POLYMARKET_API_PASSPHRASE` | live | L2 API credentials. If absent the bot derives them at startup; the preflight script requires them. |
| `POLYMARKET_PROXY_ADDRESS` | if a smart wallet holds the funds | The funder (maker) wallet. Unset: the EOA trades for itself. |
| `POLYMARKET_SIGNATURE_TYPE` | no | Override: `0` EOA, `1` Polymarket proxy (Magic/Google), `2` Gnosis Safe (default when a proxy is set), `3` Deposit Wallet (accounts created on or after 2026-05-04). |
| `POLYGON_RPC_URL` | no | RPC for the readiness check's view calls. Default: the first of `CONFIG.chainlink.polygonRpcUrls`. |
| `FOK_MIN_SHARES_LOW` | sizing decision | Defaults to 3, below the market minimum: live LOW-confidence FOK trades of 3–4 shares are refused. `5` avoids that, and it also changes which dry-run trades are taken. |
| `AUTO_ACTIVATE_DEPOSITS` | no | Existing opt-in wrapper (`depositActivator.ts`): sends Safe transactions to wrap USDC.e into pUSD. Not part of this change. |

No builder variables are needed. The bot attaches no `builderCode`, because a
builder code can add a builder taker fee to every order.

EOA note: `/trading/wallets-auth` describes EOA trading for EOAs that are
allowlisted. The usual setup is an EOA signer with a Safe
(`POLYMARKET_PROXY_ADDRESS`).

## 2. Verify the API key

V2 kept L1/L2 authentication, so the key in `bot/.env` should still work.
Check it with the read-only preflight, which places no order, sends no
transaction, and does not create a key:

```bash
cd bot
node --env-file=./.env scripts/clobV2Preflight.mts
```

Expected output: `OK    L2 auth: API key accepted by CLOB V2`, then
`account is not in closed-only mode`, open orders, the CLOB's balance view, and
the readiness lines. If L2 auth fails, derive the key again (it is
deterministic for the wallet) and update `bot/.env` and the Railway variables:

```bash
node --env-file=./.env derive-credentials.ts   # prints the three values; paste them, do not commit them
```

## 3. Fund the funder with pUSD

The readiness lines show the funder's pUSD and USDC.e balances. V2 trades pUSD
only.

- **polymarket.com**: depositing through the site, or its "Activate Funds"
  button, wraps automatically.
- **By hand**: from the funder, `USDC.e.approve(CollateralOnramp, amount)`, then
  `CollateralOnramp.wrap(USDC.e, funder, amount)`. For a Safe these are Safe
  transactions. The existing `bot/scripts/activate_now.mts` does exactly this
  for a 1-of-1 Safe, and its gas is paid in POL by the EOA.

If the funder holds USDC.e and no pUSD, live startup stops with the wrap
instruction in the log. It never wraps by itself.

## 4. Approve CTF Exchange V2 (one-time, from the funder)

| Token | Call | Needed for |
|---|---|---|
| pUSD `0xC011…2DFB` | `approve(0xE111180000d2663C0091e4f400237545B87B996B, MaxUint256)` | BUY (entries) |
| Conditional Tokens `0x4D97…6045` | `setApprovalForAll(0xE111180000d2663C0091e4f400237545B87B996B, true)` | SELL (cut-loss, manual sell) |

The Neg Risk Exchange V2 approvals are optional; BTC 15m markets are not
neg-risk.

- **Safe (signature type 2)**: send both calls as Safe transactions, for
  example through the Safe web app with the EOA as owner. polymarket.com asks
  for a one-time approval when it activates funds; whichever route you use,
  confirm the result with the preflight.
- **EOA (0)**: send both transactions from the EOA; it needs POL for gas.
- **Deposit Wallet (3)**: approvals go through Polymarket's gasless relayer
  (`setupTradingApprovals()` in `@polymarket/client`). This bot does not
  implement that.

Then run the preflight again. `OK    wallet ready` means the live startup gate
will pass too.

## 5. Smoke test with a 5-share order

Run this with the bot stopped or in `DRY_RUN=true`. A live bot starting up
cancels every open order, the test order included. The script uses the bot's
own order functions and the current BTC 15m market's UP token, prints the
best ask and the market's tick and minimum, and refuses to run without
`--confirm`.

1. **Rest-and-cancel (costs nothing unless it fills).** Pick a price well
   under the best ask. A post-only GTD BUY of 5 shares is placed, checked, and
   cancelled:

   ```bash
   node --env-file=./.env scripts/clobV2SmokeOrder.mts --price 0.20 --confirm
   ```

   Expected: `Placed post-only GTD BUY 5 @ 0.2 … status live`, then a cancelled
   status. This proves V2 signing, posting and cancelling. If the market trades
   down to the price during those seconds, you own 5 shares at 0.20 ($1).

2. **One real fill.** Use a maximum price at or just above the printed best
   ask:

   ```bash
   node --env-file=./.env scripts/clobV2SmokeOrder.mts --mode fok --price 0.56 --confirm
   ```

   Expected: `status matched`, `takingAmount 5`. It costs about 5 × ask plus
   the taker fee, `5 × 0.07 × p × (1 − p)` (about $0.09 at p = 0.55). The
   shares settle at market end like any position.

3. **Write down two numbers.** First, `makingAmount` against the funder's
   on-chain pUSD change: this says whether the reported cost includes the
   fee. Second, the data API's `usdcSize` for the same trade. Together they
   settle go-live blocker (4) in CLAUDE.md, which is about the
   `journalReconciler` fee.

4. **Go live.** Size so the stakes clear 5 shares (see `FOK_MIN_SHARES_LOW`),
   set `DRY_RUN=false`, and restart. In the startup log, check for
   `CLOB order version 2`, the `CLOB V2 readiness:` lines ending in `OK`, and
   the absence of `rejected before signing` on the first trades.

## Not verified without live credentials

- That the existing API key authenticates against V2 (step 2 checks it).
- The exact shape of V2 `/balance-allowance`. SDK 1.2.0 types it as
  `{ balance, allowances: { <spender>: amount } }`, and `readAllowance()`
  accepts that shape and the V1 one. The startup gate reads the chain instead,
  so it does not depend on this shape.
- Whether `makingAmount` on a FOK BUY includes the taker fee (step 5.3).
- How the CLOB applies the 5-share minimum to a market BUY. The bot checks
  `amount / price ≥ 5` after rounding the amount down to cents, which is what
  the SDK signs.
- The 3-minute GTD rule is taken from the docs, not tested.

## Rollback

Revert the commit and leave `DRY_RUN=true`. The V1 SDK cannot trade on
production, so there is no live V1 fallback.
