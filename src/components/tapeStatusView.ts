/**
 * How the dashboard reads the market tape's health.
 *
 * The tape is the second-resolution history the next retrain depends on, and it
 * fails quietly: a dropped book subscription still writes snapshots (marked
 * `ok:0`), and an upload that keeps failing leaves files piling up on the
 * container's disk until the local cap starts evicting them. Neither changes a
 * trade, so neither shows up anywhere an operator looks — this is that place.
 *
 * Pure: the bot's `tape` status object in, labels and a tone out.
 */

export type TapeTone = 'ok' | 'warn' | 'down';

export interface TapeHour {
  hour: string;
  snapshots: number;
  liveBookPct: number | null;
  trades: number;
  resyncs: number;
  decisions: number;
  entered: number;
  stages: Record<string, number | undefined>;
}

export interface TapeStatusMsg {
  running: boolean;
  market: string | null;
  bookLive: boolean;
  buffered: number;
  localFiles: number;
  localBytes: number;
  uploaded: number;
  uploadedBytes: number;
  lastUploadError: string | null;
  errors: number;
  uploadsConfigured: boolean;
  hour: TapeHour | null;
  lastHour: TapeHour | null;
}

export interface TapeView {
  tone: TapeTone;
  badge: string;
  /** Why the tone is not `ok`; null when it is. */
  problem: string | null;
  storage: string;
  local: string;
  hour: TapeHourView | null;
  lastHour: TapeHourView | null;
}

export interface TapeHourView {
  label: string;
  /** The share, plus a word when it is short — the tone is never carried by colour alone. */
  liveBook: string;
  liveBookTone: TapeTone;
  counts: string;
  /** Decision lines by the furthest stage their poll reached, biggest first. */
  stages: Array<{ stage: string; count: number }>;
}

/** Below this share of seconds with a live book, an hour is not good training data. */
export const LIVE_BOOK_WARN_PCT = 95;

const STAGE_ORDER = ['entered', 'passed', 'filtered', 'unstable', 'arb', 'pre', 'wait'];

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function fmtInt(n: number): string {
  return Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '—';
}

function hourView(h: TapeHour | null, label: string): TapeHourView | null {
  if (!h) return null;
  const pct = h.liveBookPct;
  const liveBookTone: TapeTone = pct == null ? 'warn' : pct >= LIVE_BOOK_WARN_PCT ? 'ok' : pct >= 50 ? 'warn' : 'down';
  const stages = STAGE_ORDER
    .map(stage => ({ stage, count: Number(h.stages?.[stage] ?? 0) }))
    .filter(s => s.count > 0);
  return {
    label: `${label} · ${h.hour.slice(11, 13)}:00 UTC`,
    liveBook: pct == null ? '—' : `${pct.toFixed(1)}%${liveBookTone === 'ok' ? '' : liveBookTone === 'warn' ? ` (low, < ${LIVE_BOOK_WARN_PCT}%)` : ' (poor)'}`,
    liveBookTone,
    counts: `${fmtInt(h.snapshots)} snaps · ${fmtInt(h.trades)} trades · ${fmtInt(h.decisions)} decisions (${fmtInt(h.entered)} entered)${h.resyncs ? ` · ${h.resyncs} resyncs` : ''}`,
    stages,
  };
}

export function describeTape(t: TapeStatusMsg | null | undefined): TapeView | null {
  if (!t) return null;
  const hour = hourView(t.hour, 'This hour');
  const lastHour = hourView(t.lastHour, 'Last hour');

  let tone: TapeTone = 'ok';
  let problem: string | null = null;
  if (!t.running) {
    tone = 'down';
    problem = 'Recorder is off (TAPE_ENABLED=false, or it failed to start — see the bot log).';
  } else if (t.lastUploadError) {
    tone = 'warn';
    problem = `Upload failing: ${t.lastUploadError}. Files stay on disk and retry with backoff.`;
  } else if (!t.bookLive) {
    tone = 'warn';
    problem = 'No live book right now — snapshots are written as ok:0 until it returns.';
  } else if (!t.uploadsConfigured) {
    tone = 'warn';
    problem = 'No bucket configured (TAPE_S3_*) — recording to local disk only, capped and evicted oldest-first.';
  }

  const badge = !t.running ? 'OFF' : tone === 'ok' ? 'RECORDING' : t.lastUploadError ? 'UPLOAD ERROR' : !t.bookLive ? 'NO BOOK' : 'LOCAL ONLY';

  return {
    tone,
    badge,
    problem,
    storage: t.uploadsConfigured
      ? `${fmtInt(t.uploaded)} files · ${formatBytes(t.uploadedBytes)} uploaded this run`
      : 'local only',
    local: `${fmtInt(t.localFiles)} files · ${formatBytes(t.localBytes)} on disk · ${fmtInt(t.buffered)} lines buffered${t.errors ? ` · ${fmtInt(t.errors)} errors` : ''}`,
    hour,
    lastHour,
  };
}
