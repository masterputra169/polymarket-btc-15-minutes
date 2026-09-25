/**
 * Price ticks keyed by the timestamp the SOURCE put on them, not by when they
 * arrived. Polymarket's Chainlink feeds stamp every tick on a whole second and
 * deliver it about a second later, so "the latest value we hold" at second T is
 * the value for T-1 or T-2 — the reason the bot's price to beat was never the
 * one Polymarket settles on. Anything that needs "the value AT second T" reads it
 * here with at(T).
 *
 * Pure and bounded: a fixed retention window, no timers, no I/O.
 */

export interface Tick {
  ts: number;
  value: number;
}

export class TickStore {
  private readonly byTs = new Map<number, number>();
  private newest = 0;
  private readonly keepMs: number;

  constructor(keepMs: number) {
    this.keepMs = keepMs;
  }

  /** Record a tick. Non-finite or non-positive input is ignored. Returns true if it was new. */
  add(ts: number, value: number): boolean {
    if (!Number.isFinite(ts) || !Number.isFinite(value) || value <= 0) return false;
    const isNew = !this.byTs.has(ts);
    this.byTs.set(ts, value);
    if (ts > this.newest) {
      this.newest = ts;
      this.prune();
    }
    return isNew;
  }

  /** The value stamped exactly at `ts`, or null. */
  at(ts: number): number | null {
    return this.byTs.get(ts) ?? null;
  }

  latest(): Tick | null {
    if (!this.newest) return null;
    const value = this.byTs.get(this.newest);
    return value == null ? null : { ts: this.newest, value };
  }

  /** Ticks with from <= ts <= to, oldest first. */
  between(from: number, to: number): Tick[] {
    const out: Tick[] = [];
    for (const [ts, value] of this.byTs) if (ts >= from && ts <= to) out.push({ ts, value });
    return out.sort((a, b) => a.ts - b.ts);
  }

  get size(): number {
    return this.byTs.size;
  }

  private prune(): void {
    const cutoff = this.newest - this.keepMs;
    for (const ts of this.byTs.keys()) if (ts < cutoff) this.byTs.delete(ts);
  }
}
