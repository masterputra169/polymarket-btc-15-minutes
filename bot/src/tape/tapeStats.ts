/**
 * Coverage summary of tape lines — what a reader needs to know before trusting
 * a stretch of tape for training: how many seconds had a live book, where the
 * gaps are, how many markets and trades it spans.
 */

import type { TapeLine } from './tapeFormat.ts';

export interface TapeSummary {
  snapshots: number;
  /** Snapshots with a live book on both tokens. */
  live: number;
  trades: number;
  markets: number;
  resyncs: number;
  /** Socket (re)subscriptions: one per market switch, plus reconnects and resyncs. */
  subscriptions: number;
  firstMs: number | null;
  lastMs: number | null;
  /** Longest run without a live-book snapshot, seconds. */
  longestGapSec: number;
}

export function summarizeTape(lines: TapeLine[]): TapeSummary {
  const sorted = [...lines].sort((a, b) => a.t - b.t);
  const markets = new Set<string>();
  const s: TapeSummary = {
    snapshots: 0, live: 0, trades: 0, markets: 0, resyncs: 0, subscriptions: 0,
    firstMs: null, lastMs: null, longestGapSec: 0,
  };
  let lastLiveMs: number | null = null;
  for (const l of sorted) {
    s.firstMs ??= l.t;
    s.lastMs = l.t;
    if (l.k === 's') {
      s.snapshots++;
      if (l.m) markets.add(l.m);
      if (l.ok === 1) {
        if (lastLiveMs !== null) s.longestGapSec = Math.max(s.longestGapSec, Math.round((l.t - lastLiveMs) / 1000) - 1);
        lastLiveMs = l.t;
        s.live++;
      }
    } else if (l.k === 'x') s.trades++;
    else if (l.k === 'm') markets.add(l.m);
    else if (l.k === 'i') {
      if (l.ev === 'resync') s.resyncs++;
      else if (l.ev === 'subscribed') s.subscriptions++;
    }
  }
  s.markets = markets.size;
  return s;
}
