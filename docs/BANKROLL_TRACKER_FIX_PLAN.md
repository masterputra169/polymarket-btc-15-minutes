# Bankroll Tracker Fix Plan (#37)

**Status:** DRAFT — apply after +24h verdict
**Issue:** Bot's bankroll metric = pUSD only. USDC.e accumulated from settlements
is invisible → false drawdown alerts (~$14 ghost in 8h yesterday).

## Root Cause

`getUsdcBalance()` di `clobClient.js` queries Polymarket CLOB API:
```js
client.getBalanceAllowance({ asset_type: 'COLLATERAL' })
```

This returns ONLY pUSD (the collateral). USDC.e sitting in proxy wallet
(returned by settlement redemption) is **not** in this query.

## Fix Design

### Approach: Side-channel on-chain USDC.e read

Add new helper `getUsdceBalance()` di clobClient.js (or new file)
that uses ethers JsonRpcProvider to read USDC.e ERC-20 balance from
proxy wallet, then **add** it to pUSD before returning.

### File Changes

**1. `bot/src/trading/clobClient.js`** — extend `getUsdcBalance()`:

```js
// Add at top
import { ethers } from 'ethers';
const USDCE_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const CHAINSTACK_HTTP = 'https://polygon-mainnet.core.chainstack.com/...';
const POLYGON_NETWORK = new ethers.Network('matic', 137);
const ERC20_BALANCE_ABI = ['function balanceOf(address) view returns (uint256)'];

let _usdceProvider = null;
function getUsdceProvider() {
  if (!_usdceProvider) {
    _usdceProvider = new ethers.JsonRpcProvider(CHAINSTACK_HTTP, POLYGON_NETWORK, { staticNetwork: true, batchMaxCount: 1 });
  }
  return _usdceProvider;
}

async function readUsdceOnChain(proxyAddr) {
  try {
    const provider = getUsdceProvider();
    const usdce = new ethers.Contract(USDCE_ADDRESS, ERC20_BALANCE_ABI, provider);
    const raw = await usdce.balanceOf(proxyAddr);
    return Number(raw) / 1e6;
  } catch (e) {
    log.debug(`USDC.e on-chain read failed: ${e.message}`);
    return 0; // Treat unavailable as 0 (will retry next poll)
  }
}

// Inside getUsdcBalance(), AFTER successful pUSD fetch:
if (balanceCache) {
  const proxyAddr = process.env.POLYMARKET_PROXY_ADDRESS;
  if (proxyAddr) {
    const usdceBal = await readUsdceOnChain(proxyAddr);
    if (usdceBal > 0.01) {
      log.debug(`Bankroll includes USDC.e ghost: pUSD=$${balanceCache.balance.toFixed(2)} + USDC.e=$${usdceBal.toFixed(2)}`);
      balanceCache.balance += usdceBal;
      balanceCache.usdceGhost = usdceBal; // expose for monitoring
    }
  }
}
```

**2. No other file changes needed** — `usdcSync.js`, `loop.js`, etc. consume
`balance` field which now includes USDC.e.

## Effects

### Before
- pUSD $32, USDC.e $14 → bot reports bankroll = **$32**
- Drawdown 30% from peak $46 → emergency triggered
- $14 invisible

### After
- pUSD $32, USDC.e $14 → bot reports bankroll = **$46** ✅
- Drawdown 0% → no false emergency
- Total wallet always visible

## Side Effects

- **Slightly slower** getUsdcBalance (extra RPC call ~100-300ms)
  - Mitigation: cached with same TTL (BALANCE_CACHE_TTL)
- **Periodic activate becomes redundant for accounting** but still useful for
  trading (need pUSD to place orders, USDC.e can't be used directly)
- Activator stays — wraps USDC.e → pUSD for trade-ability

## Risks

1. **Chainstack RPC down** — fallback to 0 USDC.e (matches current behavior)
2. **RPC rate limit** — cache TTL prevents storm
3. **State.json snapshot** — bankroll now matches total wallet, settings unchanged

## Test Plan (post-deploy)

1. Restart bot, verify log: `Bankroll includes USDC.e ghost: pUSD=$X + USDC.e=$Y`
2. Manual deposit small USDC.e amount → verify bankroll reflects immediately
3. Periodic activate fires → USDC.e=0 → log line disappears, bankroll unchanged
4. Monitor 24h — no false emergency cuts despite settlement→USDC.e returns

## Apply Steps

```bash
# 1. Apply diff to clobClient.js
# 2. Syntax check
node --check bot/src/trading/clobClient.ts
# 3. TypeScript check
npm run typecheck
# 4. Restart bot
pm2 restart polymarket-bot
# 5. Verify log shows accurate bankroll
pm2 logs polymarket-bot --lines 50 | grep "Bankroll includes USDC.e"
```

## Rollback Plan

Revert clobClient.js to previous commit. No state changes required.

## Estimated Effort

30-60 min implementation + 30 min testing = **~1.5 hours total**

## Why Wait Until Post-Verdict

- Currently in observation mode for v19 model assessment
- Modifying bankroll source mid-observation introduces noise
- Verdict due at ~12:47 today (in ~2 hours from this draft)
- Apply at +24h verdict point or after
