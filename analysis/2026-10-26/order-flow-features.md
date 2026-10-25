# Order-flow features P0 - 2026-10-26

Record-only. No entry, sizing, or exit rule uses these features yet.

## Features

- OFI: change in best bid size minus change in best ask size, normalized.
- Top imbalance: (bid size - ask size) / (bid size + ask size).
- Depth imbalance: 5-level bid liquidity vs ask liquidity.
- Microprice and microprice edge: size-weighted touch price vs mid.
- Trade imbalance: bullish vs bearish followed-token volume in the last 5 minutes.
- VPIN proxy: average absolute volume-bucket imbalance over up to 10 buckets.

## Inputs

- CLOB best bid/ask and best-level sizes (clobWs).
- Existing 5-level bid/ask liquidity.
- Recent last_trade_price prints for the two followed tokens.

## Output

- Broadcast field: orderFlow.
- JEV log features.orderFlow.
- Values: ok, sampleCount, updatedAt, spread, mid, microprice, micropriceEdgePct, ofi, depthImbalance, topImbalance, tradeImbalance, vpin, tradeCount, buyVolume, sellVolume.

## Next validation

1. Accumulate forward rows with orderFlow populated.
2. Add these features to the outcome-model study.
3. Use purged walk-forward and compare Brier skill vs market.
4. Only then consider a filter or sizing input.

## References

- Order-flow imbalance and VPIN concepts: github.com/stefanoviana/deepalpha
- L2/trade normalization: github.com/bmoscon/cryptofeed
- Event-driven microstructure: github.com/nautechsystems/nautilus_trader
