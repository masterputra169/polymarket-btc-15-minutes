/**
 * Which price-to-beat sources are exact, and which one wins.
 *
 * Since 2026-08-07 BTC 15m markets settle on Chainlink's BTC/USD 60-second TWAP
 * (Gamma `cryptoMarketConfig.id = "btc-15m-twap-60"`): the price to beat is the
 * TWAP stamped at the window's first second. Only sources that ARE that number
 * count as exact. Everything read from the SPOT price — the scheduled capture of
 * the live feed, the Data Streams adapter's default (spot) stream, on-chain
 * rounds, the current oracle price — is an approximation, however precisely
 * timed. Until 2026-09-25 the scheduled spot capture was on the exact list and
 * matched Polymarket in 0 of 130 markets (median $9.28 off).
 *
 * This is the one list. tradeFilters.ts (entry gate), ptbHealth.ts (health
 * rollup) and loop.ts (which value to keep) all read it.
 */

export const EXACT_PTB_SOURCES = [
  'chainlink_twap',       // RTDS crypto_prices_twap_sixty tick stamped at the window start
  'polymarket_twap_api',  // polymarket.com/api/crypto/crypto-price openPrice with twap params
  'polymarket_gamma',     // Gamma eventMetadata.priceToBeat (only after the window closes)
  'polymarket_page',      // the same field, scraped from the event page
  'polymarket_page_prev', // the previous window's eventMetadata.finalPrice
] as const;

/** Higher wins. Exact sources share one rank: the first exact value is kept. */
const RANK: Record<string, number> = {
  chainlink_twap: 100,
  polymarket_twap_api: 100,
  polymarket_gamma: 100,
  polymarket_page: 100,
  polymarket_page_prev: 100,
  scheduled_ws: 30,           // spot at the boundary — the best guess until the TWAP tick lands
  data_streams: 30,           // the adapter's default feed is the spot stream
  chainlink_round: 20,
  polymarket_page_approx: 10,
  oracle: 5,
  pending: 0,
};

export function isExactPtbSource(source: string | null | undefined): boolean {
  return source != null && (EXACT_PTB_SOURCES as readonly string[]).includes(source);
}

export function ptbSourceRank(source: string | null | undefined): number {
  return source == null ? -1 : RANK[source] ?? 0;
}

export interface PtbDecision {
  replace: boolean;
  /** Two exact sources that disagree — kept the first, but worth a warning. */
  conflict: boolean;
}

/**
 * Should `candidate` replace what the bot holds for this market? A higher rank
 * always wins; an equal exact rank never replaces (the first exact value
 * stands) but reports a conflict when the values differ.
 */
export function decidePtb(
  current: { value: number | null; source: string | null },
  candidate: { value: number; source: string },
): PtbDecision {
  if (!Number.isFinite(candidate.value) || candidate.value <= 0) return { replace: false, conflict: false };
  if (current.value == null || current.source == null) return { replace: true, conflict: false };
  const cur = ptbSourceRank(current.source);
  const next = ptbSourceRank(candidate.source);
  if (next > cur) return { replace: true, conflict: false };
  const bothExact = isExactPtbSource(current.source) && isExactPtbSource(candidate.source);
  return { replace: false, conflict: bothExact && Math.abs(current.value - candidate.value) > 1e-6 };
}
