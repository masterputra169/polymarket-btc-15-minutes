/**
 * Post-fill markout & adverse-selection toxicity tracker (record-only).
 *
 * Tracks token mid/market price relative to fillPrice across +5s / +15s / +30s / +60s
 * horizons, peak adverse excursion (MAE), peak favorable excursion (MFE), and rolling
 * EWMA toxicity so dry-run & live maker fills reveal adverse selection long before 15m settlement.
 */

export const MARKOUT_HORIZONS_SEC = [5, 15, 30, 60] as const;

export interface MarkoutSnapshot {
  fillPrice: number;
  fillModel: string | null;
  isMaker: boolean;
  m5s: number | null;
  m15s: number | null;
  m30s: number | null;
  m60s: number | null;
  adversePeak: number;
  favorablePeak: number;
}

export interface MarkoutStats {
  sampleCount: number;
  avg5s: number | null;
  avg15s: number | null;
  avg30s: number | null;
  avg60s: number | null;
  ewmaToxicity: number;
  lastMarkout: MarkoutSnapshot | null;
}

interface ActiveMarkoutSession {
  marketSlug: string;
  side: string;
  fillPrice: number;
  fillModel: string | null;
  isMaker: boolean;
  filledAt: number;
  m5s: number | null;
  m15s: number | null;
  m30s: number | null;
  m60s: number | null;
  adversePeak: number;
  favorablePeak: number;
}

const HISTORY_LIMIT = 50;
const EWMA_ALPHA = 0.25;

let activeSession: ActiveMarkoutSession | null = null;
const history: MarkoutSnapshot[] = [];
let ewmaToxicity = 0;

function round4(v: number): number {
  return Math.round(v * 10_000) / 10_000;
}

function snapshotFrom(s: ActiveMarkoutSession): MarkoutSnapshot {
  return {
    fillPrice: s.fillPrice,
    fillModel: s.fillModel,
    isMaker: s.isMaker,
    m5s: s.m5s,
    m15s: s.m15s,
    m30s: s.m30s,
    m60s: s.m60s,
    adversePeak: round4(s.adversePeak),
    favorablePeak: round4(s.favorablePeak),
  };
}

function avgField(items: ReadonlyArray<MarkoutSnapshot>, pick: (m: MarkoutSnapshot) => number | null): number | null {
  let sum = 0;
  let n = 0;
  for (const item of items) {
    const val = pick(item);
    if (val != null && Number.isFinite(val)) {
      sum += val;
      n++;
    }
  }
  return n > 0 ? round4(sum / n) : null;
}

export function startMarkoutTracking(params: {
  marketSlug: string;
  side: string;
  fillPrice: number;
  fillModel?: string | null;
  isMaker?: boolean;
  filledAt?: number;
}): void {
  const { marketSlug, side, fillPrice, fillModel = null, isMaker = false, filledAt = Date.now() } = params;
  if (!marketSlug || !side || !Number.isFinite(fillPrice) || fillPrice <= 0 || fillPrice >= 1) {
    activeSession = null;
    return;
  }
  activeSession = {
    marketSlug,
    side,
    fillPrice,
    fillModel,
    isMaker,
    filledAt,
    m5s: null,
    m15s: null,
    m30s: null,
    m60s: null,
    adversePeak: 0,
    favorablePeak: 0,
  };
}

export function sampleMarkout(params: {
  marketSlug: string | null | undefined;
  side: string | null | undefined;
  currentTokenPrice: number | null | undefined;
  now?: number;
}): void {
  if (!activeSession) return;
  const { marketSlug, side, currentTokenPrice, now = Date.now() } = params;
  if (!marketSlug || marketSlug !== activeSession.marketSlug || side !== activeSession.side) return;
  if (currentTokenPrice == null || !Number.isFinite(currentTokenPrice) || currentTokenPrice <= 0 || currentTokenPrice >= 1) return;

  const delta = currentTokenPrice - activeSession.fillPrice;
  if (delta < activeSession.adversePeak) activeSession.adversePeak = delta;
  if (delta > activeSession.favorablePeak) activeSession.favorablePeak = delta;

  const elapsedSec = (now - activeSession.filledAt) / 1000;
  if (elapsedSec < 0) return;

  if (activeSession.m5s === null && elapsedSec >= 5) activeSession.m5s = round4(delta);
  if (activeSession.m15s === null && elapsedSec >= 15) activeSession.m15s = round4(delta);
  if (activeSession.m30s === null && elapsedSec >= 30) activeSession.m30s = round4(delta);
  if (activeSession.m60s === null && elapsedSec >= 60) activeSession.m60s = round4(delta);
}

export function finalizeMarkout(marketSlug?: string | null): MarkoutSnapshot | null {
  if (!activeSession) return null;
  if (marketSlug && activeSession.marketSlug !== marketSlug) return null;

  const snap = snapshotFrom(activeSession);
  activeSession = null;

  history.push(snap);
  if (history.length > HISTORY_LIMIT) history.shift();

  const ref = snap.m30s ?? snap.m15s ?? snap.m5s;
  if (ref != null && Number.isFinite(ref)) {
    const tox = Math.max(0, -ref);
    ewmaToxicity = history.length === 1
      ? round4(tox)
      : round4(EWMA_ALPHA * tox + (1 - EWMA_ALPHA) * ewmaToxicity);
  }

  return snap;
}

export function getActiveMarkout(): MarkoutSnapshot | null {
  return activeSession ? snapshotFrom(activeSession) : null;
}

export function clearActiveMarkout(): void {
  activeSession = null;
}

export function getMarkoutStats(): MarkoutStats {
  return {
    sampleCount: history.length,
    avg5s: avgField(history, m => m.m5s),
    avg15s: avgField(history, m => m.m15s),
    avg30s: avgField(history, m => m.m30s),
    avg60s: avgField(history, m => m.m60s),
    ewmaToxicity,
    lastMarkout: history.length > 0 ? history[history.length - 1] : null,
  };
}

export function resetMarkoutTrackerForTest(): void {
  activeSession = null;
  history.length = 0;
  ewmaToxicity = 0;
}
