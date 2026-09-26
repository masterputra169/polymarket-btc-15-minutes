/**
 * Per-poll decision accumulator for the market tape's `d` lines.
 *
 * The loop opens a record per poll (`begin`), the stages it reaches are added
 * as they happen (`stage`, `filters`, `entered`), and the tape samples the last
 * *finished* record once a second — finished, so a sample never catches a poll
 * halfway through its filters. A poll that entered is handed back at once, so
 * every entry is on the tape regardless of the sampling.
 *
 * Pure bookkeeping: no I/O, no clocks of its own, nothing that can throw on odd
 * input (numbers that are not finite become null).
 */

import type { DecisionLine } from './tapeFormat.ts';

export type Stage = DecisionLine['st'];

export interface DecisionInput {
  t: number;
  slug: string | null;
  action: string | null | undefined;
  side: string | null | undefined;
  phase: string | null | undefined;
  reason: string | null | undefined;
  mlUp: number | null | undefined;
  mlConf: number | null | undefined;
  ensembleUp: number | null | undefined;
  edgeUp: number | null | undefined;
  edgeDown: number | null | undefined;
  marketUp: number | null | undefined;
  marketDown: number | null | undefined;
  timeLeftMin: number | null | undefined;
  regime: string | null | undefined;
  session: string | null | undefined;
  /** TWAP arithmetic (record-only); omitted from the line when absent. */
  twapP?: number | null;
  twapZ?: number | null;
  drift30?: number | null;
}

/** Furthest stage wins; a later, lesser note never downgrades a record. */
const RANK: Record<Stage, number> = { wait: 0, pre: 1, arb: 2, unstable: 3, filtered: 4, passed: 4, entered: 5 };

const MAX_REASONS = 20;
const MAX_REASON_CHARS = 120;
const MAX_WHY_CHARS = 160;

function r(x: number | null | undefined, dp: number): number | null {
  if (typeof x !== 'number' || !Number.isFinite(x)) return null;
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}

function text(x: unknown, max: number): string | null {
  if (typeof x !== 'string' || x === '') return null;
  return x.length > max ? `${x.slice(0, max - 1)}…` : x;
}

function list(xs: unknown): string[] {
  if (!Array.isArray(xs)) return [];
  const out: string[] = [];
  for (const x of xs) {
    const s = text(typeof x === 'string' ? x : String(x), MAX_REASON_CHARS);
    if (s) out.push(s);
    if (out.length >= MAX_REASONS) break;
  }
  return out;
}

interface Rec { seq: number; line: DecisionLine }

export class DecisionTrail {
  private cur: Rec | null = null;
  private done: Rec | null = null;
  private seq = 0;
  private emittedSeq = 0;

  /** Open the record for a new poll; the previous one is now finished. */
  begin(d: DecisionInput): void {
    if (this.cur) this.done = this.cur;
    const enter = d.action === 'ENTER';
    this.cur = {
      seq: ++this.seq,
      line: {
        k: 'd',
        t: Number.isFinite(d.t) ? d.t : 0,
        m: d.slug ?? null,
        a: enter ? 'E' : 'W',
        sd: d.side === 'UP' ? 'U' : d.side === 'DOWN' ? 'D' : null,
        ph: text(d.phase, 16),
        why: text(d.reason, MAX_WHY_CHARS),
        ml: r(d.mlUp, 4),
        mc: r(d.mlConf, 3),
        en: r(d.ensembleUp, 4),
        eu: r(d.edgeUp, 4),
        ed: r(d.edgeDown, 4),
        pu: r(d.marketUp, 3),
        pd: r(d.marketDown, 3),
        tl: r(d.timeLeftMin, 2),
        rg: text(d.regime, 24),
        ss: text(d.session, 24),
        st: 'wait',
        ...(d.twapP != null ? { tp: r(d.twapP, 4), tz: r(d.twapZ, 3), dr: r(d.drift30, 2) } : {}),
      },
    };
  }

  /** Record a stage this poll reached (`pre` / `unstable` carry their reasons). */
  stage(stage: Stage, detail?: unknown): void {
    const rec = this.cur;
    if (!rec) return;
    // Reasons travel with the stage: a lesser, later note must not replace the
    // payload of a stage that already won.
    if (RANK[stage] < RANK[rec.line.st]) return;
    if (stage === 'pre') rec.line.pre = list(detail);
    if (stage === 'unstable') rec.line.hold = list(detail);
    rec.line.st = stage;
  }

  /** applyTradeFilters() result, all reasons kept. */
  filters(pass: boolean, reasons: unknown): void {
    const rec = this.cur;
    if (!rec) return;
    rec.line.fp = pass ? 1 : 0;
    rec.line.fr = list(reasons);
    this.stage(pass ? 'passed' : 'filtered');
  }

  /** This poll entered: returns its line to write now (never sampled away). */
  entered(): DecisionLine | null {
    const rec = this.cur;
    if (!rec) return null;
    this.stage('entered');
    this.emittedSeq = Math.max(this.emittedSeq, rec.seq);
    return { ...rec.line };
  }

  /** The last finished record, once; null if already written or none yet. */
  takeSample(): DecisionLine | null {
    const rec = this.done;
    if (!rec || rec.seq <= this.emittedSeq) return null;
    this.emittedSeq = rec.seq;
    return { ...rec.line };
  }
}
