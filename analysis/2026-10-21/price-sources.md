# Price source clarification — 2026-10-21

## Why the dashboard showed two different BTC prices

The dashboard has two independent feeds:

| Feed | Value in screenshot | Role |
|---|---:|---|
| **Binance spot** | $82,936.01 | Fast exchange feed; useful for tape/price action, **not** the settlement reference. |
| **Chainlink spot via PolyWS** (`ORACLE`) | $82,845.03 | The oracle feed the bot compares with the price to beat. |
| **PTB** | $82,931.02 | Chainlink 60s TWAP captured at the window open. |

The gap (basis) was **+$90.98 (+0.11%)**, which is normal. Binance was above PTB while Chainlink was below it; Polymarket settles on Chainlink/TWAP, so the market correctly priced DOWN 95%.

## UI fix

- Topbar primary price is now **ORACLE · POLYWS** (the settlement feed), not Binance.
- Binance is shown as a secondary `BINANCE` metric with a tooltip.
- Price direction color now compares **oracle vs PTB** (it previously compared Binance vs Chainlink PTB, which was misleading).
- Market Pulse label now reads `CURRENT PRICE · POLYWS` (or Chainlink WSS/RPC) instead of the raw `polymarket_ws`.
- Binance difference under the Binance price is labeled **BASIS**.

## Verification

- Desktop 1362: `ORACLE 82,845.03 · BINANCE 82,936.01 · PTB 82,931.02`, down color, distance −$85.98 / −0.104%.
- Current Price card shows the same oracle value as the topbar; Binance remains visible with basis.
- Tablet 820 and mobile 390: no horizontal overflow.
- Frontend typecheck/build PASS.