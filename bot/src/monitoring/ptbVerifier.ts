/**
 * After a market closes, check the price to beat the bot used against the one
 * Polymarket published (Gamma eventMetadata.priceToBeat, which appears within a
 * few minutes of the close). The result goes into ptb_health.jsonl as
 * `verified`, so "is our PTB right?" is answered by Polymarket, not by the name
 * of the source we trusted — that name said "exact" for months while the value
 * matched in 0 of 130 markets.
 *
 * Record-only: nothing here changes a decision. Never throws.
 */

import { createLogger } from '../logger.ts';
import { fetchJsonWithPolymarketDoh } from '../services/polymarketHttp.ts';
import { recordPtbVerification } from './ptbHealth.ts';

const log = createLogger('PtbVerify');

/** Gamma fills eventMetadata a minute or two after the close; later tries cover a slow day. */
export const VERIFY_DELAYS_MS = [120_000, 300_000, 900_000];

export interface PtbCheck {
  slug: string;
  used: number | null;
  usedSource: string | null;
}

export async function fetchOfficialPtb(
  slug: string,
  fetchJson: (url: string) => Promise<any> = (u) => fetchJsonWithPolymarketDoh(u, { timeoutMs: 10_000, label: 'Gamma event' }),
): Promise<number | null> {
  const ev = await fetchJson(`https://gamma-api.polymarket.com/events/slug/${encodeURIComponent(slug)}`);
  const v = Number(ev?.eventMetadata?.priceToBeat);
  return Number.isFinite(v) && v > 1_000 ? v : null;
}

/** Compare once the official value is out; returns the absolute difference, or null if never found. */
export async function verifyPtb(
  check: PtbCheck,
  deps: { fetchOfficial?: (slug: string) => Promise<number | null>; sleep?: (ms: number) => Promise<void> } = {},
): Promise<number | null> {
  const fetchOfficial = deps.fetchOfficial ?? ((s: string) => fetchOfficialPtb(s));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(r => { const t = setTimeout(r, ms); t.unref?.(); }));
  let waited = 0;
  for (const at of VERIFY_DELAYS_MS) {
    await sleep(at - waited);
    waited = at;
    let official: number | null = null;
    try { official = await fetchOfficial(check.slug); } catch { /* next try */ }
    if (official == null) continue;
    const diff = recordPtbVerification(check.used, check.usedSource, official);
    if (diff == null) {
      log.warn(`PTB ${check.slug}: official $${official.toFixed(2)}, bot had none`);
    } else if (diff < 1e-6) {
      log.info(`PTB ${check.slug}: exact (${check.usedSource})`);
    } else {
      log.warn(`PTB ${check.slug}: OFF by $${diff.toFixed(2)} — bot $${check.used!.toFixed(2)} (${check.usedSource}), official $${official.toFixed(2)}`);
    }
    return diff;
  }
  log.debug(`PTB ${check.slug}: no official value after ${Math.round(waited / 60_000)} min`);
  return null;
}

/** Fire and forget from the market-switch path. */
export function scheduleOfficialPtbCheck(check: PtbCheck): void {
  void verifyPtb(check).catch(() => { /* record-only */ });
}
