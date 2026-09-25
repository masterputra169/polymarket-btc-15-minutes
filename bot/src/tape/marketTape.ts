/**
 * Market tape recorder: a 1 Hz record of the Polymarket book (top N levels of
 * both tokens), every trade print, BTC from three feeds, and the bot's PTB —
 * plus the bot's own decision trail (`d` lines, decisionTrail.ts): one sampled
 * poll per second and every entry.
 *
 * Why: training rows can only use token prices as fresh as their source.
 * polymarket_lookup.json prints about once a minute, so offline market skill
 * can only be bounded (−2.1% .. +6.8% for the v2 model), and the orderbook
 * features are neutral in training because no history of them exists. This
 * tape is that history, going forward.
 *
 * Isolation from trading — every entry point here is total (never throws):
 *   - its own CLOB socket (clobTapeSocket.ts), never the one that prices trades;
 *   - reads the bot's feeds only through getters passed in by index.ts;
 *   - timers are unref'd, and file I/O errors are counted and logged, not raised;
 *   - the writer stops before the volume fills (state.json lives there too).
 *
 * Storage: hourly gzip files under bot/data/tape, uploaded to an S3-compatible
 * bucket (Cloudflare R2 recommended — no egress fees) and deleted locally once
 * stored. Without bucket credentials the files stay on the volume under a cap.
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createLogger } from '../logger.ts';
import { envInt } from '../utils/env.ts';
import { ClobTapeSocket, type TradeEvent } from './clobTapeSocket.ts';
import { TapeWriter } from './tapeWriter.ts';
import { createS3Store, describeStore, readS3Config, type S3Store, type S3Config } from './s3Store.ts';
import { hourStamp, makeBootId, type SnapshotLine } from './tapeFormat.ts';
import { DecisionTrail, type DecisionInput, type Stage } from './decisionTrail.ts';

const log = createLogger('Tape');
const __dirname = dirname(fileURLToPath(import.meta.url));

type Env = Record<string, string | undefined>;

export interface TapeConfig {
  enabled: boolean;
  dir: string;
  intervalMs: number;
  depth: number;
  flushMs: number;
  uploadEveryMs: number;
  maxLocalBytes: number;
  minFreeBytes: number;
  s3: S3Config | null;
  s3Problem: string | null;
}

export function readTapeConfig(env: Env): TapeConfig {
  const { config: s3, problem } = readS3Config(env);
  return {
    enabled: (env.TAPE_ENABLED ?? 'true').trim().toLowerCase() !== 'false',
    dir: env.TAPE_DIR ? resolve(env.TAPE_DIR) : resolve(__dirname, '..', '..', 'data', 'tape'),
    intervalMs: envInt(env.TAPE_INTERVAL_MS, 1_000, 250, 60_000),
    depth: envInt(env.TAPE_DEPTH, 10, 1, 50),
    flushMs: envInt(env.TAPE_FLUSH_MS, 60_000, 5_000, 600_000),
    uploadEveryMs: envInt(env.TAPE_UPLOAD_EVERY_MS, 300_000, 30_000, 3_600_000),
    maxLocalBytes: envInt(env.TAPE_MAX_LOCAL_MB, 1_500, 50, 100_000) * 1024 * 1024,
    minFreeBytes: envInt(env.TAPE_MIN_FREE_MB, 500, 50, 100_000) * 1024 * 1024,
    s3,
    s3Problem: problem,
  };
}

export interface TapeContext {
  btc: number | null;
  chainlink: number | null;
  polyLive: number | null;
  ptb: number | null;
  ptbSource: string | null;
  /** Latest Chainlink 60 s TWAP tick (what the market settles on), and its own timestamp. */
  twap?: number | null;
  twapTs?: number | null;
}

export interface TapeMarket {
  slug: string;
  conditionId: string | null;
  upTokenId: string;
  downTokenId: string;
  startMs: number | null;
  endMs: number | null;
}

export interface TapeDeps {
  getContext: () => TapeContext;
  config?: TapeConfig;
  store?: S3Store | null;
  socket?: ClobTapeSocket;
  now?: () => number;
}

interface HourStats {
  snaps: number; ok: number; trades: number; resyncs: number; repairsAtStart: number; decisions: number; entered: number;
  /** Decision lines written this hour, by the furthest stage their poll reached. */
  stages: Partial<Record<Stage, number>>;
}

const UPLOAD_BACKOFF_MAX_MS = 60 * 60_000;

let state: {
  cfg: TapeConfig;
  writer: TapeWriter;
  socket: ClobTapeSocket;
  store: S3Store | null;
  getContext: () => TapeContext;
  now: () => number;
  timers: ReturnType<typeof setInterval>[];
  market: TapeMarket | null;
  hour: string;
  stats: HourStats;
  lastHour: TapeHourSummary | null;
  filesSeen: { at: number; count: number; bytes: number } | null;
  uploading: boolean;
  uploadBackoffMs: number;
  nextUploadAt: number;
  uploaded: number;
  uploadedBytes: number;
  lastUploadError: string | null;
  errors: number;
  trail: DecisionTrail;
} | null = null;

function freshStats(): HourStats {
  return { snaps: 0, ok: 0, trades: 0, resyncs: 0, repairsAtStart: state?.socket.repairs ?? 0, decisions: 0, entered: 0, stages: {} };
}

function round(x: number | null | undefined, dp: number): number | null {
  if (x === null || x === undefined || !Number.isFinite(x)) return null;
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}

/** Errors inside the recorder are counted and logged at most once a minute. */
let lastErrLogMs = 0;
function recordError(where: string, err: unknown): void {
  if (!state) return;
  state.errors++;
  const now = Date.now();
  if (now - lastErrLogMs > 60_000) {
    lastErrLogMs = now;
    log.warn(`${where} failed (${state.errors} recorder errors so far, trading unaffected): ${(err as Error)?.message ?? err}`);
  }
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function startMarketTape(deps: TapeDeps): boolean {
  if (state) return true;
  const cfg = deps.config ?? readTapeConfig(process.env);
  if (!cfg.enabled) {
    log.info('Market tape disabled (TAPE_ENABLED=false)');
    return false;
  }
  const now = deps.now ?? Date.now;
  try {
    const writer = new TapeWriter({
      dir: cfg.dir,
      bootId: makeBootId(now()),
      maxLocalBytes: cfg.maxLocalBytes,
      minFreeBytes: cfg.minFreeBytes,
      now,
    });
    const store = deps.store !== undefined ? deps.store : cfg.s3 ? createS3Store(cfg.s3) : null;
    const socket = deps.socket ?? new ClobTapeSocket({ onTrade, onEvent, now });

    state = {
      cfg, writer, socket, store, getContext: deps.getContext, now,
      timers: [], market: null, hour: hourStamp(now()), stats: freshStats(), lastHour: null, filesSeen: null,
      uploading: false, uploadBackoffMs: 0, nextUploadAt: 0,
      uploaded: 0, uploadedBytes: 0, lastUploadError: null, errors: 0,
      trail: new DecisionTrail(),
    };

    const every = (ms: number, fn: () => void) => {
      const t = setInterval(fn, ms);
      t.unref?.();
      state!.timers.push(t);
    };
    every(cfg.intervalMs, sample);
    every(cfg.flushMs, flushNow);
    every(cfg.uploadEveryMs, () => { void uploadRound(); });
    socket.start();

    const dest = store && cfg.s3
      ? `→ ${describeStore(cfg.s3)}`
      : `local only (${cfg.s3Problem ? `S3 ${cfg.s3Problem}` : 'no TAPE_S3_* set'}), cap ${mb(cfg.maxLocalBytes)}`;
    log.info(`Market tape: ${cfg.intervalMs}ms, depth ${cfg.depth}, ${cfg.dir} ${dest}`);
    if (cfg.s3Problem) log.warn(`Market tape S3 config ${cfg.s3Problem} — recording locally only`);

    // Upload whatever a previous process left behind, once the bot has settled.
    const t = setTimeout(() => { void uploadRound(); }, 30_000);
    t.unref?.();
    return true;
  } catch (err) {
    log.warn(`Market tape failed to start (trading unaffected): ${(err as Error)?.message ?? err}`);
    if (state) {
      for (const t of state.timers) clearInterval(t);
      try { state.socket.stop(); } catch { /* never started */ }
    }
    state = null;
    return false;
  }
}

/** Called by the poll loop whenever it learns the market's tokens. Cheap and total. */
export function setTapeMarket(m: TapeMarket): void {
  if (!state) return;
  try {
    if (!m.upTokenId || !m.downTokenId) return;
    const prev = state.market;
    if (prev && prev.slug === m.slug && prev.upTokenId === m.upTokenId && prev.downTokenId === m.downTokenId) return;
    state.market = { ...m };
    state.writer.push({
      k: 'm', t: state.now(), m: m.slug, cid: m.conditionId,
      up: m.upTokenId, dn: m.downTokenId, start: m.startMs, end: m.endMs,
    });
    state.socket.setTokens(m.upTokenId, m.downTokenId);
  } catch (err) {
    recordError('setTapeMarket', err);
  }
}

function onTrade(t: TradeEvent): void {
  if (!state) return;
  try {
    state.stats.trades++;
    state.writer.push({
      k: 'x', t: t.recvMs, m: state.market?.slug ?? null, o: t.side,
      p: t.price, q: t.size, sd: t.orderSide, st: t.serverTs,
    });
  } catch (err) {
    recordError('trade', err);
  }
}

function onEvent(ev: string, note?: string): void {
  if (!state) return;
  try {
    if (ev === 'resync') state.stats.resyncs++;
    state.writer.push(note ? { k: 'i', t: state.now(), ev, note: note.slice(0, 200) } : { k: 'i', t: state.now(), ev });
  } catch (err) {
    recordError('event', err);
  }
}

function sample(): void {
  if (!state) return;
  try {
    const d = state.trail.takeSample();
    if (d) { state.writer.push(d); countDecision(d.st); }
  } catch (err) {
    recordError('decision', err);
  }
  try {
    const now = state.now();
    const hour = hourStamp(now);
    if (hour !== state.hour) closeHour(hour);

    const { socket, cfg } = state;
    const ctx = state.getContext();
    const ok = socket.live && socket.up.valid && socket.down.valid;
    const line: SnapshotLine = {
      k: 's', t: now, m: state.market?.slug ?? null, ok: ok ? 1 : 0,
      btc: round(ctx.btc, 2), cl: round(ctx.chainlink, 2), pl: round(ctx.polyLive, 2),
      ptb: round(ctx.ptb, 2), ps: ctx.ptbSource,
    };
    if (ctx.twap != null) { line.tw = round(ctx.twap, 4); line.twt = ctx.twapTs ?? null; }
    if (socket.up.valid) { line.u = socket.up.top(cfg.depth); line.ua = now - socket.up.updatedMs; }
    if (socket.down.valid) { line.d = socket.down.top(cfg.depth); line.da = now - socket.down.updatedMs; }
    state.writer.push(line);
    state.stats.snaps++;
    if (ok) state.stats.ok++;
  } catch (err) {
    recordError('sample', err);
  }
}

function countDecision(st: Stage): void {
  if (!state) return;
  state.stats.decisions++;
  state.stats.stages[st] = (state.stats.stages[st] ?? 0) + 1;
}

function summarizeHour(hour: string, s: HourStats): TapeHourSummary {
  return {
    hour,
    snapshots: s.snaps,
    liveBookPct: s.snaps ? Math.round((s.ok / s.snaps) * 1000) / 10 : null,
    trades: s.trades,
    resyncs: s.resyncs,
    decisions: s.decisions,
    entered: s.entered,
    stages: { ...s.stages },
  };
}

function closeHour(next: string): void {
  if (!state) return;
  const s = state.stats;
  state.lastHour = summarizeHour(state.hour, s);
  const pct = s.snaps ? ((s.ok / s.snaps) * 100).toFixed(1) : '0.0';
  log.info(`Tape ${state.hour}Z: ${s.snaps} snapshots (${pct}% with a live book), ${s.trades} trades, ${state.socket.repairs - s.repairsAtStart} book levels pruned, ${s.resyncs} resyncs, ${s.decisions} decisions (${s.entered} entries)`);
  state.hour = next;
  state.stats = freshStats();
  flushNow();
  void uploadRound();
}

function flushNow(): void {
  if (!state) return;
  try {
    const r = state.writer.flush();
    if (r.dropped > 0) {
      log.warn(`Tape: volume below ${mb(state.cfg.minFreeBytes)} free — dropped ${r.dropped} lines (${state.writer.totalDropped} total). Set TAPE_S3_* so files leave the volume.`);
    }
    if (r.evicted.length > 0) {
      log.warn(`Tape: local cap ${mb(state.cfg.maxLocalBytes)} reached — deleted ${r.evicted.length} oldest file(s): ${r.evicted.join(', ')}`);
    }
  } catch (err) {
    recordError('flush', err);
  }
}

async function uploadRound(): Promise<void> {
  if (!state || !state.store || state.uploading) return;
  const st = state;
  if (st.now() < st.nextUploadAt) return;
  st.uploading = true;
  try {
    flushNow();
    for (const f of st.writer.completedFiles()) {
      if (!state) return; // stopped mid-round
      let body: Buffer;
      try {
        body = readFileSync(f.path);
      } catch (err) {
        // Evicted by the size cap since the listing: nothing to upload, and no
        // reason to hold back the rest of the round.
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
        throw err;
      }
      try {
        await st.store!.put(`${st.cfg.s3!.prefix}${f.rel}`, body);
        st.writer.remove(f);
        st.uploaded++;
        st.uploadedBytes += f.bytes;
        st.uploadBackoffMs = 0;
        st.lastUploadError = null;
        log.info(`Tape uploaded ${f.rel} (${mb(f.bytes)})`);
      } catch (err) {
        st.uploadBackoffMs = st.uploadBackoffMs ? Math.min(UPLOAD_BACKOFF_MAX_MS, st.uploadBackoffMs * 2) : 60_000;
        st.nextUploadAt = st.now() + st.uploadBackoffMs;
        st.lastUploadError = (err as Error)?.message ?? String(err);
        log.warn(`Tape upload of ${f.rel} failed (file stays local), retry in ${Math.round(st.uploadBackoffMs / 60_000)} min: ${st.lastUploadError}`);
        return;
      }
    }
  } catch (err) {
    recordError('upload', err);
  } finally {
    st.uploading = false;
  }
}

// ── Decision trail (the tape's `d` lines) ────────────────────────────────
// Called from the poll loop and tradePipeline on every poll; each is total and
// a no-op until the tape is running.

/** Open this poll's decision record (right after decide()). */
export function noteTapeDecision(d: DecisionInput): void {
  if (!state) return;
  try { state.trail.begin(d); } catch (err) { recordError('noteTapeDecision', err); }
}

/** A stage this poll reached: 'pre' (with the loop preconditions that held it), 'unstable' (with reasons), 'arb'. */
export function noteTapeStage(stage: Exclude<Stage, 'wait' | 'filtered' | 'passed' | 'entered'>, detail?: unknown): void {
  if (!state) return;
  try { state.trail.stage(stage, detail); } catch (err) { recordError('noteTapeStage', err); }
}

/** applyTradeFilters() result for this poll. */
export function noteTapeFilters(pass: boolean, reasons: unknown): void {
  if (!state) return;
  try { state.trail.filters(pass, reasons); } catch (err) { recordError('noteTapeFilters', err); }
}

/** This poll entered a trade: written at once, never sampled away. */
export function noteTapeEntered(): void {
  if (!state) return;
  try {
    const d = state.trail.entered();
    if (d) { state.writer.push(d); countDecision(d.st); state.stats.entered++; }
  } catch (err) {
    recordError('noteTapeEntered', err);
  }
}

/** One hour of recording, as the dashboard shows it. */
export interface TapeHourSummary {
  hour: string;
  snapshots: number;
  /** Share of 1 Hz snapshots taken with a live book on both tokens; null before the first. */
  liveBookPct: number | null;
  trades: number;
  resyncs: number;
  decisions: number;
  entered: number;
  stages: Partial<Record<Stage, number>>;
}

export interface TapeStatus {
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
  destination: string | null;
  /** The hour being recorded (UTC), so far. */
  hour: TapeHourSummary | null;
  /** The last full hour, once one has closed in this process. */
  lastHour: TapeHourSummary | null;
}

/**
 * @param maxFileAgeMs how stale the local file count may be. The poll loop
 *   broadcasts every ~500 ms and a directory walk per poll is waste; the
 *   default (0) always lists, which is what tests and one-off callers want.
 */
export function getTapeStatus(maxFileAgeMs = 0): TapeStatus {
  if (!state) {
    return {
      running: false, market: null, bookLive: false, buffered: 0, localFiles: 0, localBytes: 0,
      uploaded: 0, uploadedBytes: 0, lastUploadError: null, errors: 0, destination: null,
      hour: null, lastHour: null,
    };
  }
  const now = state.now();
  let seen = state.filesSeen;
  if (!seen || now - seen.at >= maxFileAgeMs || now < seen.at) {
    const files = state.writer.listFiles();
    seen = { at: now, count: files.length, bytes: files.reduce((s, f) => s + f.bytes, 0) };
    state.filesSeen = seen;
  }
  return {
    running: true,
    market: state.market?.slug ?? null,
    bookLive: state.socket.live && state.socket.up.valid && state.socket.down.valid,
    buffered: state.writer.buffered,
    localFiles: seen.count,
    localBytes: seen.bytes,
    uploaded: state.uploaded,
    uploadedBytes: state.uploadedBytes,
    lastUploadError: state.lastUploadError,
    errors: state.errors,
    destination: state.store && state.cfg.s3 ? describeStore(state.cfg.s3) : null,
    hour: summarizeHour(state.hour, state.stats),
    lastHour: state.lastHour,
  };
}

/**
 * What the dashboard gets. The status broadcast reaches a public page, and the
 * R2 endpoint host carries the Cloudflare account id — so the destination
 * becomes a yes/no, and an upload error loses any host or 32-hex id it quotes.
 * The configured host is removed whatever it is; the pattern fallbacks are
 * R2-shaped, so a different S3 provider relies on the exact-host replacement.
 */
export interface TapeDashboardStatus extends Omit<TapeStatus, 'destination'> {
  uploadsConfigured: boolean;
}

export function scrubUploadError(msg: string | null, host: string | null): string | null {
  if (msg == null) return null;
  let out = msg;
  if (host) out = out.split(host).join('<store>');
  out = out.replace(/\b[\w-]+\.r2\.cloudflarestorage\.com\b/gi, '<store>').replace(/\b[0-9a-f]{32}\b/gi, '<id>');
  return out.length > 160 ? `${out.slice(0, 159)}…` : out;
}

export function getTapeDashboardStatus(maxFileAgeMs = 0): TapeDashboardStatus {
  const { destination, ...rest } = getTapeStatus(maxFileAgeMs);
  let host: string | null = null;
  try { host = state?.cfg.s3 ? new URL(state.cfg.s3.endpoint).host : null; } catch { host = null; }
  return { ...rest, uploadsConfigured: destination != null, lastUploadError: scrubUploadError(rest.lastUploadError, host) };
}

/** Stop recording and write out the buffer. Synchronous, so it fits a shutdown handler. */
export function stopMarketTape(): void {
  if (!state) return;
  try {
    for (const t of state.timers) clearInterval(t);
    state.socket.stop();
    state.writer.flush();
  } catch (err) {
    log.warn(`Tape stop: ${(err as Error)?.message ?? err}`);
  } finally {
    state = null;
  }
}
