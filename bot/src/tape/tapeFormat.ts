/**
 * Market tape — file layout and line format, shared by the recorder and every
 * reader (pull script, training).
 *
 * One file per UTC hour per process: `YYYY-MM-DD/HH-<bootId>.jsonl.gz`, the
 * same relative path locally and in the bucket (under a prefix). A restart
 * mid-hour therefore produces a second file for that hour instead of
 * overwriting the first; readers merge all files of an hour and sort by `t`.
 *
 * Each file is a concatenation of gzip members (one per flush), so a crash
 * loses at most the unflushed buffer and never corrupts what was written
 * before it. `decodeTape` tolerates a truncated final member.
 */

import { gunzipSync, constants as zc } from 'zlib';
import type { Level } from './bookState.ts';

export interface BookTop { b: Level[]; a: Level[] }

/** 1 Hz snapshot. `ok` = recorder socket connected and both books fresh. */
export interface SnapshotLine {
  k: 's';
  t: number;
  m: string | null;
  ok: 0 | 1;
  u?: BookTop;
  d?: BookTop;
  /** ms since the UP / DOWN book last changed. */
  ua?: number;
  da?: number;
  /** Binance BTC, Chainlink (Polygon WSS), Polymarket live oracle price. */
  btc?: number | null;
  cl?: number | null;
  pl?: number | null;
  /** The bot's price-to-beat and its source, as the bot held it at `t`. */
  ptb?: number | null;
  ps?: string | null;
  /** Chainlink 60 s TWAP (the settlement series) and the timestamp Chainlink put on it; since 2026-09-25. */
  tw?: number | null;
  twt?: number | null;
}

/** Written when the recorder moves to a new market. */
export interface MarketLine {
  k: 'm';
  t: number;
  m: string;
  cid: string | null;
  up: string;
  dn: string;
  start: number | null;
  end: number | null;
}

/** Every `last_trade_price` event for the followed tokens. */
export interface TradeLine {
  k: 'x';
  t: number;
  m: string | null;
  o: 'u' | 'd';
  p: number;
  q: number | null;
  sd: string | null;
  /** Server timestamp of the trade, ms. */
  st: number | null;
}

/**
 * What the bot decided on one poll, sampled once a second (every poll that
 * entered is written, unsampled). Pairs with the snapshots and the market's
 * outcome to replay any threshold on the signals the bot really saw — the tape
 * alone cannot, because most entry gates depend on live state it lacks.
 *
 * Stages, furthest reached: wait (decide() said WAIT) · pre (ENTER, but a
 * loop precondition stopped it — see `pre`) · arb (arbitrage took the poll) ·
 * unstable (signal-confirmation hold) · filtered / passed (applyTradeFilters
 * ran; `fr` lists every reason, not just the first) · entered.
 */
export interface DecisionLine {
  k: 'd';
  t: number;
  m: string | null;
  /** 'E' ENTER or 'W' WAIT, from decide(). */
  a: 'E' | 'W';
  sd: 'U' | 'D' | null;
  ph: string | null;
  /** decide()'s reason (why WAIT, or what qualified the ENTER). */
  why: string | null;
  /** ML P(UP), ML confidence (|p − 0.5| × 2), ensemble P(UP). */
  ml: number | null;
  mc: number | null;
  en: number | null;
  /** Edge per side and the market's UP / DOWN prices the decision used. */
  eu: number | null;
  ed: number | null;
  pu: number | null;
  pd: number | null;
  /** Minutes left, regime, session. */
  tl: number | null;
  rg: string | null;
  ss: string | null;
  st: 'wait' | 'pre' | 'arb' | 'unstable' | 'filtered' | 'passed' | 'entered';
  pre?: string[];
  hold?: string[];
  /** applyTradeFilters(): pass and every reason. */
  fp?: 0 | 1;
  fr?: string[];
  /**
   * TWAP arithmetic (engines/twapPhysics.ts), record-only, since 2026-09-26:
   * P(UP) = Φ(z), z = (settlement estimate − PTB) / (σ·√T_eff), and the 30 s drift
   * of the settlement estimate. Present only with an exact PTB and spot history.
   */
  tp?: number | null;
  tz?: number | null;
  dr?: number | null;
}

/** Recorder life events (connect, resync, ...), so gaps can be explained later. */
export interface InfoLine {
  k: 'i';
  t: number;
  ev: string;
  note?: string;
}

export type TapeLine = SnapshotLine | MarketLine | TradeLine | InfoLine | DecisionLine;

const REL_RE = /^(\d{4}-\d{2}-\d{2})\/(\d{2})-([a-z0-9]{1,16})\.jsonl\.gz$/;

export interface HourKey { date: string; hour: string }

export function hourOf(ms: number): HourKey {
  const iso = new Date(ms).toISOString();
  return { date: iso.slice(0, 10), hour: iso.slice(11, 13) };
}

/** Sortable `YYYY-MM-DDTHH` for comparing hours. */
export function hourStamp(ms: number): string {
  const { date, hour } = hourOf(ms);
  return `${date}T${hour}`;
}

export function relPathFor(ms: number, bootId: string): string {
  const { date, hour } = hourOf(ms);
  return `${date}/${hour}-${bootId}.jsonl.gz`;
}

export interface ParsedRel { date: string; hour: string; bootId: string; stamp: string }

/** Parse a tape relative path; null for anything that is not one (also the path-traversal guard). */
export function parseRelPath(rel: string): ParsedRel | null {
  const m = REL_RE.exec(rel);
  if (!m) return null;
  return { date: m[1], hour: m[2], bootId: m[3], stamp: `${m[1]}T${m[2]}` };
}

/** Process id for file names: base36 ms, fixed width, so names sort by boot time. */
export function makeBootId(ms: number): string {
  return Math.floor(ms).toString(36).padStart(9, '0');
}

/**
 * Decode a tape file. Returns the parsed lines and how many were unreadable
 * (a torn last line after a crash is expected; many are not).
 */
export function decodeTape(buf: Uint8Array): { lines: TapeLine[]; bad: number } {
  // SYNC_FLUSH instead of FINISH: a member cut short by a crash yields what it
  // holds instead of throwing away the whole file.
  const text = gunzipSync(buf, { finishFlush: zc.Z_SYNC_FLUSH }).toString('utf8');
  const lines: TapeLine[] = [];
  let bad = 0;
  for (const raw of text.split('\n')) {
    if (raw === '') continue;
    try {
      const obj = JSON.parse(raw);
      if (obj && typeof obj === 'object' && typeof obj.k === 'string' && Number.isFinite(obj.t)) lines.push(obj);
      else bad++;
    } catch {
      bad++;
    }
  }
  return { lines, bad };
}
