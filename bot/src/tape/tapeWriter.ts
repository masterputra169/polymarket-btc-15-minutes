/**
 * Buffers tape lines in memory and appends them to the hourly file as one gzip
 * member per flush.
 *
 * The data volume also holds state.json and the trade journal, so this module
 * treats disk as the bot's, not its own: it stops writing when free space runs
 * low, and deletes its own oldest finished files past a size cap. Losing tape
 * is acceptable; failing a state.json write is not.
 */

import { appendFileSync, mkdirSync, readdirSync, rmdirSync, statSync, statfsSync, unlinkSync } from 'fs';
import { dirname, join } from 'path';
import { gzipSync } from 'zlib';
import { hourStamp, parseRelPath, relPathFor, type TapeLine } from './tapeFormat.ts';

export interface TapeFile {
  rel: string;
  path: string;
  bytes: number;
  stamp: string;
  bootId: string;
  mtimeMs: number;
}

export interface TapeWriterOpts {
  dir: string;
  bootId: string;
  maxLocalBytes: number;
  minFreeBytes: number;
  now?: () => number;
  /** Free bytes on the volume holding `dir`; injectable for tests. */
  freeBytes?: (dir: string) => number;
  /**
   * Another process's file counts as finished only once untouched this long.
   * A live writer appends every flush (60s), so this covers two processes
   * briefly sharing the volume: the newer one never uploads-and-deletes a file
   * the older one is still appending to (a recreated file would then overwrite
   * the good upload under the same key).
   */
  foreignIdleMs?: number;
}

export interface FlushResult {
  lines: number;
  bytes: number;
  /** Lines discarded because the volume was short on space. */
  dropped: number;
  /** Finished files deleted to stay under the size cap. */
  evicted: string[];
}

/** Flush early rather than let a stalled timer grow the buffer without bound. */
const MAX_BUFFER_LINES = 20_000;
const DEFAULT_FOREIGN_IDLE_MS = 180_000;
/** Full directory rescan for the size cap at most this often, unless the running estimate says we are over. */
const CAP_RESCAN_MS = 10 * 60_000;

function volumeFreeBytes(dir: string): number {
  const s = statfsSync(dir);
  return Number(s.bavail) * Number(s.bsize);
}

export class TapeWriter {
  private buf: { t: number; line: string }[] = [];
  /** Highest `t` routed so far: files are chosen by max(t, this) so a clock step back never reopens an uploaded hour. */
  private routeFloorMs = 0;
  private readonly now: () => number;
  private readonly freeBytes: (dir: string) => number;
  /** Bytes on disk as of the last scan plus what was appended since; null = scan next time. */
  private approxBytes: number | null = null;
  private lastScanMs = 0;
  totalDropped = 0;
  // Not a parameter property: Node runs this file with type stripping, which rejects them.
  private readonly opts: TapeWriterOpts;

  constructor(opts: TapeWriterOpts) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.freeBytes = opts.freeBytes ?? volumeFreeBytes;
    mkdirSync(opts.dir, { recursive: true });
  }

  get bootId(): string { return this.opts.bootId; }
  get buffered(): number { return this.buf.length; }

  push(obj: TapeLine): void {
    this.buf.push({ t: obj.t, line: JSON.stringify(obj) });
    if (this.buf.length >= MAX_BUFFER_LINES) this.flush();
  }

  flush(): FlushResult {
    const result: FlushResult = { lines: 0, bytes: 0, dropped: 0, evicted: [] };
    if (this.buf.length === 0) return result;
    const pending = this.buf;
    this.buf = [];

    if (this.freeBytes(this.opts.dir) < this.opts.minFreeBytes) {
      result.dropped = pending.length;
      this.totalDropped += pending.length;
      return result;
    }

    const byFile = new Map<string, string[]>();
    for (const { t, line } of pending) {
      this.routeFloorMs = Math.max(this.routeFloorMs, t);
      const rel = relPathFor(this.routeFloorMs, this.opts.bootId);
      let arr = byFile.get(rel);
      if (!arr) { arr = []; byFile.set(rel, arr); }
      arr.push(line);
    }
    for (const [rel, lines] of byFile) {
      const path = join(this.opts.dir, rel);
      mkdirSync(dirname(path), { recursive: true });
      const gz = gzipSync(lines.join('\n') + '\n');
      appendFileSync(path, gz);
      result.lines += lines.length;
      result.bytes += gz.length;
    }
    if (this.approxBytes !== null) this.approxBytes += result.bytes;
    result.evicted = this.enforceCap();
    return result;
  }

  /** Every tape file on disk, oldest first. */
  listFiles(): TapeFile[] {
    const out: TapeFile[] = [];
    let days: string[];
    try { days = readdirSync(this.opts.dir); } catch { return out; }
    for (const day of days) {
      let names: string[];
      try { names = readdirSync(join(this.opts.dir, day)); } catch { continue; }
      for (const name of names) {
        const rel = `${day}/${name}`;
        const parsed = parseRelPath(rel);
        if (!parsed) continue;
        const path = join(this.opts.dir, day, name);
        try {
          const st = statSync(path);
          out.push({ rel, path, bytes: st.size, stamp: parsed.stamp, bootId: parsed.bootId, mtimeMs: st.mtimeMs });
        } catch { /* vanished between readdir and stat */ }
      }
    }
    return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  }

  /**
   * Files no line will ever be appended to again: this process's files for
   * hours before the current one, and other processes' files once idle for
   * `foreignIdleMs`. Call after flush(), otherwise the buffer may still hold
   * lines for the hour that just ended.
   */
  completedFiles(files: TapeFile[] = this.listFiles()): TapeFile[] {
    const now = this.now();
    const current = hourStamp(Math.max(now, this.routeFloorMs));
    const idle = this.opts.foreignIdleMs ?? DEFAULT_FOREIGN_IDLE_MS;
    return files.filter(f => (f.bootId === this.opts.bootId ? f.stamp < current : now - f.mtimeMs >= idle));
  }

  /** Delete a finished file (after upload, or to make room) and its day directory once empty. */
  remove(file: TapeFile): void {
    try {
      unlinkSync(file.path);
    } catch (err) {
      // Already gone (the cap and an upload can race for the same file) is the goal state.
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
    }
    if (this.approxBytes !== null) this.approxBytes = Math.max(0, this.approxBytes - file.bytes);
    try { rmdirSync(dirname(file.path)); } catch { /* not empty */ }
  }

  /**
   * Keep the directory under the cap. Scanning is synchronous, so it runs only
   * when the running estimate crosses the cap or every CAP_RESCAN_MS (to pick
   * up files other processes left behind), not on every flush.
   */
  private enforceCap(): string[] {
    const now = this.now();
    const due = this.approxBytes === null || this.approxBytes > this.opts.maxLocalBytes || now - this.lastScanMs >= CAP_RESCAN_MS;
    if (!due) return [];
    const all = this.listFiles();
    let total = all.reduce((s, f) => s + f.bytes, 0);
    this.approxBytes = total;
    this.lastScanMs = now;
    if (total <= this.opts.maxLocalBytes) return [];
    const evicted: string[] = [];
    for (const f of this.completedFiles(all)) {
      if (total <= this.opts.maxLocalBytes) break;
      try {
        this.remove(f);
        total -= f.bytes;
        evicted.push(f.rel);
      } catch { /* leave it; next flush retries */ }
    }
    this.approxBytes = total;
    return evicted;
  }
}
