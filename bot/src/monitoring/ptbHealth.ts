/**
 * PTB source health — durable record of how often the price-to-beat is usable.
 *
 * Why this exists: the PTB-source gate (tradeFilters filter 1c) blocks entries
 * outright with no ML or edge override, by design. That makes it the one filter
 * that can silently end an observation period: if the exact source degrades from
 * ~1.5% of polls to 30%, the dry run collects nothing and the only symptom is a
 * report full of zeros, days later. Nothing durable recorded the source before
 * this (feature_capture.jsonl has `ptb` but not its source, and has not been
 * written since 2026-05-14), so "why zero trades?" meant grepping container logs
 * that vanish on restart.
 *
 * Design: count in memory, append one rollup line per flush interval. At ~4
 * polls/sec a per-poll write would be 350k lines/day; one line per minute is
 * 1,440 and answers the same question.
 */

import { appendFileSync, existsSync, mkdirSync, statSync, renameSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { envNum } from '../utils/env.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Redirectable so tests never append to the production data file.
const HEALTH_PATH = process.env.PTB_HEALTH_PATH
  ? resolve(process.env.PTB_HEALTH_PATH)
  : resolve(__dirname, '..', '..', 'data', 'ptb_health.jsonl');
const DATA_DIR = dirname(HEALTH_PATH);

/** Sources the entry gate accepts. Kept in sync with EXACT_PTB_TRUST by test. */
export const EXACT_PTB_SOURCES = [
  'data_streams', 'polymarket_gamma', 'polymarket_page', 'polymarket_page_prev', 'scheduled_ws',
];

const FLUSH_MS = envNum(process.env.PTB_HEALTH_FLUSH_MS, 60_000, 1_000, 3_600_000);
const MAX_BYTES = envNum(process.env.PTB_HEALTH_MAX_BYTES, 5_000_000, 100_000, 100_000_000);

let counts: Record<string, number> = {};
let windowStart = Date.now();
let lastFlush = Date.now();

/**
 * Record the PTB source seen on one filter evaluation.
 * Safe to call on every poll — it only touches an in-memory counter until the
 * flush interval elapses, and never throws into the trading path.
 */
export function recordPtbSource(source: string | null | undefined): void {
  const key = source || 'missing';
  counts[key] = (counts[key] || 0) + 1;
  if (Date.now() - lastFlush >= FLUSH_MS) flush();
}

/** Append the current window as one line and start a new window. */
export function flush(): void {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total === 0) { lastFlush = Date.now(); return; }

  const exact = Object.entries(counts)
    .filter(([src]) => EXACT_PTB_SOURCES.includes(src))
    .reduce((a, [, n]) => a + n, 0);

  const line = {
    from: windowStart,
    to: Date.now(),
    total,
    exact,
    exactPct: Number(((exact / total) * 100).toFixed(2)),
    bySource: counts,
  };

  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    // Rotate before the file grows without bound (same policy as state_audit).
    if (existsSync(HEALTH_PATH) && statSync(HEALTH_PATH).size > MAX_BYTES) {
      renameSync(HEALTH_PATH, `${HEALTH_PATH}.1`);
    }
    appendFileSync(HEALTH_PATH, JSON.stringify(line) + '\n');
  } catch {
    // Monitoring must never break trading. A lost health line is acceptable;
    // a thrown exception inside the filter path is not.
  }

  counts = {};
  windowStart = Date.now();
  lastFlush = windowStart;
}

/** Current unflushed window — for tests and for the status broadcast. */
export function getPendingCounts(): Readonly<Record<string, number>> {
  return { ...counts };
}

/** Reset module state. Tests only. */
export function _reset(): void {
  counts = {};
  windowStart = Date.now();
  lastFlush = windowStart;
}
