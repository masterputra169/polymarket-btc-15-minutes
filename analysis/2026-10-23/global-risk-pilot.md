# Global Risk Pilot — 2026-10-23

Record-only pilot. No trade decision uses this data yet.

## Sources

| Source | What | Status |
|---|---|---|
| Google News RSS — crypto | crypto headlines | keyless, tested |
| Google News RSS — geopolitics | war/sanctions/tariff headlines | keyless, tested |
| Cointelegraph RSS | crypto headlines | keyless, tested |
| ForexFactory (existing) | macro calendar | existing |
| Alternative.me + CoinGecko (existing) | Fear & Greed / BTC dominance | existing |

GDELT was attempted but returned HTTP 429 from the VPS IP; it is not in the critical path. FRED/CryptoPanic/ACLED/UCDP need credentials or approval and are deferred.

## Output

- Snapshot: `bot/data/global_risk.jsonl` (5-minute refresh, max 2 MB with rotation).
- Dashboard: `Global Risk` widget — risk level, macro window, sentiment, headlines, freshness.
- Study: `node bot/scripts/globalRiskStudy.mjs` joins settled trades to the latest snapshot at/before entry.

## Scoring

- macro active => +80; high-impact macro within 60 min => +40; otherwise +8
- negative headlines: up to +40
- extreme Fear & Greed: up to +25
- overall capped at 100; high >=70, medium >=40

## Limitations

- Headlines are noisy and may duplicate; scoring is keyword-based, not a trained model.
- RSS has no financial timestamp precision beyond publish time.
- No historical GDELT/FRED snapshots yet; forward data is the evidence.
- Macro surprise/consensus is not included.
- Not used for entry, sizing, or exits.

## Next

1. Accumulate 1-2 weeks of snapshots.
2. Run `globalRiskStudy.mjs` at 30+ joined trades.
3. If high-risk windows show a stable effect, pre-register a risk gate.
4. Only then wire it to `applyTradeFilters` (shadow first).
