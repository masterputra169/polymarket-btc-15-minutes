/**
 * Market resolution lookups — "how did Polymarket actually resolve this market?"
 *
 * Two sources, tried in order:
 *   1. CLOB `GET /markets/<conditionId>`: `closed` + `tokens[].winner`.
 *   2. Gamma `GET /markets/slug/<slug>`: `closed` + `outcomePrices` ("1"/"0").
 *
 * Measured 2026-09-08: Gamma `GET /markets?slug=<slug>` returns `[]` for the
 * 15-minute BTC markets, which is why the bot's old secondary oracle never
 * resolved anything. The path form returns the market object; the list form
 * is kept only as a fallback.
 */

import { createLogger } from '../logger.ts';
import { CONFIG } from '../config.ts';

const log = createLogger('MarketResolution');

export type Outcome = 'UP' | 'DOWN';
export type Resolution = { outcome: Outcome; source: 'oracle' | 'gamma_oracle' };
type FetchLike = (url: string, init?: any) => Promise<{ ok: boolean; status?: number; json(): Promise<any> }>;
export type LookupOpts = { timeoutMs?: number; fetchImpl?: FetchLike };

const DEFAULT_TIMEOUT_MS = 8000;

function fetchOf(opts: LookupOpts): FetchLike {
  return opts.fetchImpl ?? ((globalThis as any).fetch as FetchLike);
}

async function getJson(url: string, opts: LookupOpts): Promise<any> {
  const res = await fetchOf(opts)(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) });
  if (!res.ok) return null;
  return res.json();
}

function parseList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try { const v = JSON.parse(raw); return Array.isArray(v) ? v : []; } catch { return []; }
  }
  return [];
}

function asOutcome(raw: unknown): Outcome | null {
  const v = String(raw ?? '').toUpperCase();
  return v === 'UP' || v === 'DOWN' ? v : null;
}

/**
 * Winner of a closed market from either API shape; null while open, unresolved
 * or when the payload has no winner priced at 1.
 */
export function outcomeFromMarket(market: any): Outcome | null {
  if (!market || market.closed !== true) return null;

  const tokens = Array.isArray(market.tokens) ? market.tokens : [];
  const winner = tokens.find((t: any) => t?.winner === true);
  if (winner?.outcome) return asOutcome(winner.outcome);

  const outcomes = parseList(market.outcomes);
  const prices = parseList(market.outcomePrices);
  for (let i = 0; i < outcomes.length; i++) {
    if (parseFloat(String(prices[i])) > 0.99) return asOutcome(outcomes[i]);
  }
  return null;
}

/** Gamma market by slug: path form first, the (often empty) list form as fallback. */
export async function fetchGammaMarketBySlug(slug: string, opts: LookupOpts = {}): Promise<any | null> {
  const base = CONFIG.gammaBaseUrl;
  const enc = encodeURIComponent(slug);
  try {
    const market = await getJson(`${base}/markets/slug/${enc}`, opts);
    if (market && typeof market === 'object' && !Array.isArray(market)) return market;
  } catch (err) {
    log.debug(`Gamma /markets/slug/${slug} failed: ${err.message}`);
  }
  try {
    const list = await getJson(`${base}/markets?slug=${enc}`, opts);
    if (Array.isArray(list) && list[0]) return list[0];
  } catch (err) {
    log.debug(`Gamma /markets?slug=${slug} failed: ${err.message}`);
  }
  return null;
}

/**
 * Resolved outcome of a market, or null if no source has closed it yet.
 * CLOB is authoritative when a conditionId is known; Gamma covers the rest.
 */
export async function fetchResolvedOutcome(
  { conditionId, marketSlug }: { conditionId?: string | null; marketSlug?: string | null },
  opts: LookupOpts = {},
): Promise<Resolution | null> {
  if (conditionId) {
    try {
      const outcome = outcomeFromMarket(await getJson(`${CONFIG.clobBaseUrl}/markets/${encodeURIComponent(conditionId)}`, opts));
      if (outcome) return { outcome, source: 'oracle' };
    } catch (err) {
      log.debug(`CLOB /markets/${conditionId} failed: ${err.message}`);
    }
  }
  if (marketSlug) {
    const outcome = outcomeFromMarket(await fetchGammaMarketBySlug(marketSlug, opts));
    if (outcome) return { outcome, source: 'gamma_oracle' };
  }
  return null;
}
