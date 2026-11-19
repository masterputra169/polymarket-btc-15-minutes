/**
 * Market-tape replay invariant auditor.
 *
 * Replays recorded 1 Hz market snapshots (`s` lines) and bot decision lines (`d`)
 * from `backtest/ml_training/tape/` and validates structural L2 orderbook
 * invariants plus `checkEntryInvariants()` on `entered` / `passed` signals.
 *
 * Usage:
 *   node backtest/ml_training/tapeInvariantAudit.mts [--days 14] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--tape DIR] [--strict]
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decodeTape,
  parseRelPath,
  type BookTop,
  type DecisionLine,
  type SnapshotLine,
} from '../../bot/src/tape/tapeFormat.ts';
import { checkEntryInvariants } from '../../bot/src/safety/entryInvariants.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MAX_JOIN_GAP_MS = 3_000;

interface CliArgs {
  tape: string;
  days: number;
  sinceDay: string | null;
  untilDay: string | null;
  strict: boolean;
}

interface BookSummary {
  bestBid: number | null;
  bestAsk: number | null;
  spread: number | null;
  bidLiquidity: number;
  askLiquidity: number;
  mid: number | null;
}

interface ViolationSample {
  t: string;
  market: string;
  code: string;
  detail: string;
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(2);
}

function parseArgs(argv: string[]): CliArgs {
  let tape = join(ROOT, 'backtest', 'ml_training', 'tape');
  let days = 14;
  let sinceDay: string | null = null;
  let untilDay: string | null = null;
  let strict = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--strict') {
      strict = true;
      continue;
    }
    if (!a.startsWith('--')) fail(`Unexpected argument "${a}"`);
    const key = a.slice(2);
    const val = argv[++i];
    if (val === undefined) fail(`Missing value for --${key}`);
    if (key === 'tape') tape = resolve(val);
    else if (key === 'days') {
      days = Number(val);
      if (!Number.isFinite(days) || days < 0) fail(`Invalid --days "${val}"`);
    } else if (key === 'since') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(val)) fail(`--since must be YYYY-MM-DD, got "${val}"`);
      sinceDay = val;
    } else if (key === 'until') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(val)) fail(`--until must be YYYY-MM-DD, got "${val}"`);
      untilDay = val;
    } else {
      fail(`Unknown flag --${key}`);
    }
  }
  return { tape, days, sinceDay, untilDay, strict };
}

function summarizeTop(top: BookTop | undefined): BookSummary | null {
  if (!top) return null;
  const bids: Array<[number, number]> = [];
  const asks: Array<[number, number]> = [];
  if (Array.isArray(top.b)) {
    for (const lvl of top.b) {
      const p = Number(lvl?.[0]);
      const q = Number(lvl?.[1]);
      if (Number.isFinite(p) && p > 0 && p < 1 && Number.isFinite(q) && q > 0) bids.push([p, q]);
    }
  }
  if (Array.isArray(top.a)) {
    for (const lvl of top.a) {
      const p = Number(lvl?.[0]);
      const q = Number(lvl?.[1]);
      if (Number.isFinite(p) && p > 0 && p < 1 && Number.isFinite(q) && q > 0) asks.push([p, q]);
    }
  }
  bids.sort((x, y) => y[0] - x[0]);
  asks.sort((x, y) => x[0] - y[0]);
  const bestBid = bids.length > 0 ? bids[0][0] : null;
  const bestAsk = asks.length > 0 ? asks[0][0] : null;
  const spread = bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null;
  const bidLiquidity = bids.slice(0, 5).reduce((s, l) => s + l[1], 0);
  const askLiquidity = asks.slice(0, 5).reduce((s, l) => s + l[1], 0);
  const mid = bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : (bestBid ?? bestAsk);
  return { bestBid, bestAsk, spread, bidLiquidity, askLiquidity, mid };
}

function incCount(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function recordSample(list: ViolationSample[], max: number, item: ViolationSample): void {
  if (list.length < max) list.push(item);
}

/** Find sorted bracketing snapshots (prev <= t < next) for one market within maxGapMs. */
function findBracketingSnapshots(
  snaps: readonly SnapshotLine[] | undefined,
  t: number,
  maxGapMs: number,
): SnapshotLine[] {
  if (!snaps || snaps.length === 0) return [];
  let lo = 0;
  let hi = snaps.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (snaps[mid].t <= t) lo = mid + 1;
    else hi = mid - 1;
  }
  const candidates: SnapshotLine[] = [];
  if (hi >= 0 && t - snaps[hi].t <= maxGapMs) candidates.push(snaps[hi]);
  if (hi + 1 < snaps.length && snaps[hi + 1].t - t <= maxGapMs) candidates.push(snaps[hi + 1]);
  candidates.sort((a, b) => Math.abs(a.t - t) - Math.abs(b.t - t));
  return candidates;
}

function auditTape(args: CliArgs) {
  if (!existsSync(args.tape)) fail(`No tape directory at ${args.tape} — run \`npm run tape:pull\` first.`);

  let days = readdirSync(args.tape)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();

  if (args.sinceDay) days = days.filter((d) => d >= args.sinceDay!);
  if (args.untilDay) days = days.filter((d) => d <= args.untilDay!);
  if (!args.sinceDay && args.days > 0 && days.length > args.days) {
    days = days.slice(-args.days);
  }

  let files = 0;
  let unreadableFiles = 0;
  let badLines = 0;
  let snapshots = 0;
  let decisionsChecked = 0;
  let enteredChecked = 0;
  let passedChecked = 0;
  let unmatchedDecisions = 0;

  const snapAnomalies = new Map<string, number>();
  const decisionViolations = new Map<string, number>();
  const samples: ViolationSample[] = [];

  for (const day of days) {
    const dir = join(args.tape, day);
    let names: string[];
    try { names = readdirSync(dir).sort(); } catch { continue; }

    const hourSnaps: SnapshotLine[] = [];
    const hourDecisions: DecisionLine[] = [];

    for (const name of names) {
      const parsed = parseRelPath(`${day}/${name}`);
      if (!parsed) continue;
      files++;
      try {
        const res = decodeTape(readFileSync(join(dir, name)));
        badLines += res.bad;
        for (const line of res.lines) {
          if (line.k === 's') hourSnaps.push(line);
          else if (line.k === 'd') hourDecisions.push(line);
        }
      } catch {
        unreadableFiles++;
      }
    }

    hourSnaps.sort((a, b) => a.t - b.t);
    hourDecisions.sort((a, b) => a.t - b.t);

    // 1. Validate 1 Hz snapshot invariants and index by market for bracketing lookup
    const snapsByMarket = new Map<string, SnapshotLine[]>();
    for (const s of hourSnaps) {
      checkSnapshot(s);
      if (!s.m) continue;
      let list = snapsByMarket.get(s.m);
      if (!list) {
        list = [];
        snapsByMarket.set(s.m, list);
      }
      list.push(s);
    }

    for (const d of hourDecisions) {
      if (d.st !== 'entered' && d.st !== 'passed') continue;
      const isUp = d.sd === 'U';
      const isDown = d.sd === 'D';
      if (!isUp && !isDown) continue;

      decisionsChecked++;
      if (d.st === 'entered') enteredChecked++;
      else passedChecked++;

      const bracketing = d.m ? findBracketingSnapshots(snapsByMarket.get(d.m), d.t, MAX_JOIN_GAP_MS) : [];
      if (bracketing.length === 0) {
        unmatchedDecisions++;
        continue;
      }

      const side = isUp ? 'UP' : 'DOWN';
      const entryPrice = isUp ? d.pu : d.pd;
      const bestEdge = isUp ? d.eu : d.ed;

      let passedAnyBracket = false;
      let closestFail: { code?: string; reason?: string } | null = null;
      for (const snap of bracketing) {
        const up = summarizeTop(snap.u);
        const dn = summarizeTop(snap.d);
        const inv = checkEntryInvariants({
          side,
          entryPrice: entryPrice ?? NaN,
          sideBook: isUp ? up : dn,
          marketUp: d.pu,
          marketDown: d.pd,
          twapPhysicsZ: d.tz ?? null,
          bestEdge,
        });
        if (inv.ok) {
          passedAnyBracket = true;
          break;
        }
        if (!closestFail) closestFail = inv;
      }

      if (!passedAnyBracket && closestFail?.code) {
        const key = `${d.st}:${closestFail.code}`;
        incCount(decisionViolations, key);
        recordSample(samples, 20, {
          t: new Date(d.t).toISOString(),
          market: d.m ?? '?',
          code: key,
          detail: closestFail.reason ?? '',
        });
      }
    }

    function checkSnapshot(s: SnapshotLine): void {
      snapshots++;
      const up = summarizeTop(s.u);
      const dn = summarizeTop(s.d);
      for (const [label, bk] of [['up', up], ['down', dn]] as const) {
        if (!bk) continue;
        if (bk.spread !== null && bk.spread < -1e-9) {
          incCount(snapAnomalies, `${label}_inverted_spread`);
        }
        if (bk.bestBid === null || bk.bestAsk === null) {
          incCount(snapAnomalies, `${label}_one_sided_or_empty`);
        }
        if (bk.bestAsk !== null && bk.askLiquidity <= 0) {
          incCount(snapAnomalies, `${label}_zero_ask_liquidity`);
        }
      }
      if (up?.mid != null && dn?.mid != null && Math.abs(up.mid + dn.mid - 1.0) > 0.15) {
        incCount(snapAnomalies, 'book_sum_anomaly');
      }
    }
  }

  console.log('=== Market Tape Invariant Audit ===');
  console.log(`Days scanned (${days.length}): ${days[0] ?? 'none'} .. ${days[days.length - 1] ?? 'none'}`);
  console.log(`Files: ${files} (unreadable: ${unreadableFiles}, bad lines: ${badLines})`);
  console.log(`Snapshots (1 Hz): ${snapshots.toLocaleString()}`);
  console.log(
    `Decisions checked: ${decisionsChecked.toLocaleString()} (entered=${enteredChecked.toLocaleString()}, passed=${passedChecked.toLocaleString()}, unmatched=${unmatchedDecisions.toLocaleString()})`,
  );

  console.log('\nSnapshot microstructure observations:');
  if (snapAnomalies.size === 0) {
    console.log('  (none)');
  } else {
    for (const [k, v] of [...snapAnomalies.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  - ${k}: ${v.toLocaleString()}`);
    }
  }

  let enteredViolationTotal = 0;
  console.log('\nEntry invariant violations (checkEntryInvariants on d+s join <=3s):');
  if (decisionViolations.size === 0) {
    console.log('  - ZERO violations across all replayed decisions!');
  } else {
    for (const [k, v] of [...decisionViolations.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  - ${k}: ${v.toLocaleString()}`);
      if (k.startsWith('entered:')) enteredViolationTotal += v;
    }
  }

  if (samples.length > 0) {
    console.log(`\nFirst ${samples.length} decision invariant sample(s):`);
    for (const smp of samples) {
      console.log(`  [${smp.t}] ${smp.market} (${smp.code}): ${smp.detail}`);
    }
  }

  const hardBookBugs = (snapAnomalies.get('up_inverted_spread') ?? 0) + (snapAnomalies.get('down_inverted_spread') ?? 0);
  if (args.strict && (hardBookBugs > 0 || enteredViolationTotal > 0)) {
    process.exit(1);
  }
}

auditTape(parseArgs(process.argv.slice(2)));
