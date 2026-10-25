/**
 * Dedicated order-flow history log.
 *
 * JEV is called once per market; that is too sparse for feature research.
 * This logger records the order-flow state every 15 seconds per market, with
 * the market/ML/JEV baseline fields needed to join outcomes later.
 *
 * Record-only: no trading code reads this file.
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OrderFlowFeatures } from '../engines/orderFlowFeatures.ts';

const DATA_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');
const FILE = resolve(DATA_DIR, 'orderflow.jsonl');
const INTERVAL_MS = 15_000;
const MAX_BYTES = 100 * 1024 * 1024;

export type OrderFlowLogInput = {
  slug: string | null;
  orderFlow: OrderFlowFeatures;
  market: {
    marketUp: number | null;
    marketDown: number | null;
    btcPrice: number | null;
    priceToBeat: number | null;
    timeLeftMin: number | null;
    phase: string | null;
    session: string | null;
  };
  ml: { probUp: number | null; confidence: number | null; side: string | null } | null;
  jev: {
    direction: string;
    directionConfidence: number;
    settleUpProbability: number;
    settleUpCalibrated?: number;
    regime: string;
  } | null;
};

let lastSlug: string | null = null;
let lastWriteMs = 0;
let lines = 0;
let errors = 0;
let bytes = 0;

export function maybeRecordOrderFlow(input: OrderFlowLogInput, now = Date.now()): boolean {
  try {
    if (!input?.orderFlow?.ok) return false;
    if (input.slug !== lastSlug) {
      lastSlug = input.slug;
      lastWriteMs = 0;
    }
    if (now - lastWriteMs < INTERVAL_MS) return false;
    lastWriteMs = now;
    mkdirSync(DATA_DIR, { recursive: true });
    if (existsSync(FILE) && statSync(FILE).size > MAX_BYTES) {
      try { renameSync(FILE, FILE + '.1'); } catch { /* best effort */ }
    }
    const row = {
      ts: now,
      iso: new Date(now).toISOString(),
      slug: input.slug,
      orderFlow: input.orderFlow,
      market: input.market,
      ml: input.ml,
      jev: input.jev,
    };
    const line = JSON.stringify(row) + String.fromCharCode(10);
    appendFileSync(FILE, line);
    lines++;
    bytes += line.length;
    return true;
  } catch {
    errors++;
    return false;
  }
}

export function getOrderFlowLogStats() {
  return { file: FILE, lines, errors, bytes, intervalMs: INTERVAL_MS };
}
