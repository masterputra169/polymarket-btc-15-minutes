/**
 * Which slice of the journal a report scores.
 *
 * `--days N` is a rolling window, and that is a trap when the number is meant
 * as evidence: on 2026-09-20 the same unchanged journal read 85.7% WR over
 * `--days 1` and 66.1% over `--days 14`, purely because the window moved. The
 * go-live criterion agreed that day — "margin >= +2.5pp on the post-fix window
 * alone" — needs a boundary pinned to the deploy instant instead.
 *
 * Everything here refuses to guess. A boundary that cannot be parsed throws,
 * because a report that quietly scores the wrong period still prints a
 * plausible-looking number, and that is worse than one that will not run.
 */

export type ReportWindow = {
  /** Inclusive lower bound, epoch ms. 0 = open. */
  sinceMs: number;
  /** Exclusive upper bound, epoch ms. Infinity = open. */
  untilMs: number;
  /** Human label for the report header. */
  label: string;
  /** Machine-readable form for --json consumers. */
  tag: Record<string, unknown>;
};

type Args = Record<string, string | boolean | undefined>;

/**
 * Parse a CLI boundary: ISO-8601, or epoch milliseconds as a bare integer.
 * @throws if the flag was passed without a value, or cannot be parsed.
 */
function parseBoundary(value: string | boolean | undefined, flag: string): number {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`--${flag} needs a value: an ISO-8601 timestamp (2026-09-20T07:18:56Z) or epoch milliseconds`);
  }
  const raw = value.trim();
  // Epoch ms first: Date.parse('1789885136000') is NaN, but a bare integer is
  // the form the journal itself stores, so operators will paste it.
  if (/^\d{10,}$/.test(raw)) return Number(raw);
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`--${flag} is not a date I can read: "${raw}". Use ISO-8601 (2026-09-20T07:18:56Z) or epoch milliseconds.`);
  }
  return parsed;
}

/** ISO without the sub-second noise, for labels people paste into notes. */
function iso(ms: number): string {
  return new Date(ms).toISOString().replace('.000Z', 'Z');
}

/**
 * Resolve the reporting window from parsed CLI args.
 *
 * Precedence: --all beats everything; an explicit --since/--until beats --days
 * rather than intersecting with it, because a silent combination produces a
 * window that neither flag describes.
 */
export function resolveWindow(args: Args, now: number = Date.now()): ReportWindow {
  if (args.all) {
    return { sinceMs: 0, untilMs: Infinity, label: 'entire journal', tag: { all: true } };
  }

  const hasSince = args.since !== undefined;
  const hasUntil = args.until !== undefined;

  if (hasSince || hasUntil) {
    const sinceMs = hasSince ? parseBoundary(args.since, 'since') : 0;
    const untilMs = hasUntil ? parseBoundary(args.until, 'until') : Infinity;
    if (sinceMs >= untilMs) {
      throw new Error(`--since (${iso(sinceMs)}) must be before --until (${iso(untilMs)})`);
    }
    const label = hasSince && hasUntil
      ? `${iso(sinceMs)} → ${iso(untilMs)}`
      : hasSince ? `since ${iso(sinceMs)}` : `up to ${iso(untilMs)}`;
    return {
      sinceMs,
      untilMs,
      label,
      tag: { since: hasSince ? new Date(sinceMs).toISOString() : null, until: hasUntil ? new Date(untilMs).toISOString() : null },
    };
  }

  const daysRaw = args.days ?? '1';
  const days = Number(daysRaw);
  if (!Number.isFinite(days) || days <= 0) {
    throw new Error(`--days must be a positive number, got "${String(daysRaw)}"`);
  }
  return {
    sinceMs: now - days * 86_400_000,
    untilMs: Infinity,
    label: `last ${days} day(s)`,
    tag: { days },
  };
}

/**
 * Is this timestamp inside the window? Lower bound inclusive, upper exclusive.
 *
 * Both readers in a report — the journal rows and the PTB-health rollups — must
 * use this. On 2026-09-20 they were filtered by two separate inline conditions
 * and the second one silently ignored the upper bound, so a report with a fixed
 * --until printed trade numbers for one period and a PTB diagnostic for another,
 * side by side, with nothing saying they differed.
 */
export function inWindow(ts: number | null | undefined, w: Pick<ReportWindow, 'sinceMs' | 'untilMs'>): boolean {
  if (!Number.isFinite(ts)) return false;
  return (ts as number) >= w.sinceMs && (ts as number) < w.untilMs;
}
