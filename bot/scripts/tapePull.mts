/**
 * Download the market tape from the bucket and print its coverage.
 *
 *   npm run tape:pull                      # download new files, then summarise
 *   npm run tape:pull -- --since 2026-09-25
 *   npm run tape:pull -- --stats-only      # summarise what is already local
 *   npm run tape:pull -- --out D:/tape
 *
 * Credentials: the same TAPE_S3_* variables the bot uses, read from bot/.env
 * (gitignored). Use a token that can read the bucket; the bot's write token
 * works too. Files land in backtest/ml_training/tape/ (gitignored) under the
 * same YYYY-MM-DD/HH-<boot>.jsonl.gz paths they have in the bucket.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, renameSync } from 'fs';
import { resolve, dirname, join, sep } from 'path';
import { fileURLToPath } from 'url';
import { config as loadEnv } from 'dotenv';
import { createS3Store, describeStore, readS3Config } from '../src/tape/s3Store.ts';
import { decodeTape, parseRelPath, type TapeLine } from '../src/tape/tapeFormat.ts';
import { summarizeTape } from '../src/tape/tapeStats.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
loadEnv({ path: resolve(ROOT, 'bot', '.env'), quiet: true });

function flags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[argv[i].slice(2)] = 'true';
    else { out[argv[i].slice(2)] = next; i++; }
  }
  return out;
}

const args = flags(process.argv.slice(2));
const OUT = resolve(args.out ?? join(ROOT, 'backtest', 'ml_training', 'tape'));
const SINCE = args.since ?? '0000-00-00';
if (args.since && !/^\d{4}-\d{2}-\d{2}$/.test(args.since)) {
  console.error('--since must be YYYY-MM-DD');
  process.exit(2);
}

/** Resolve a tape path inside OUT, refusing anything that would land elsewhere. */
function localPath(rel: string): string {
  if (!parseRelPath(rel)) throw new Error(`not a tape path: ${rel}`);
  const p = resolve(OUT, rel);
  if (!p.startsWith(OUT + sep)) throw new Error(`refusing to write outside ${OUT}: ${rel}`);
  return p;
}

async function pull(): Promise<void> {
  const { config, problem } = readS3Config(process.env);
  if (!config) {
    console.error(problem
      ? `TAPE_S3_* in bot/.env is ${problem}.`
      : 'No TAPE_S3_* in bot/.env — set TAPE_S3_ENDPOINT, TAPE_S3_BUCKET, TAPE_S3_ACCESS_KEY_ID, TAPE_S3_SECRET_ACCESS_KEY (or use --stats-only).');
    process.exit(2);
  }
  const store = createS3Store(config);
  console.log(`Listing ${describeStore(config)} ...`);
  const objects = await store.list(config.prefix);

  let fetched = 0, skipped = 0, bytes = 0;
  const ignored: string[] = [];
  for (const o of objects) {
    const rel = o.key.slice(config.prefix.length);
    const parsed = parseRelPath(rel);
    if (!parsed) { ignored.push(o.key); continue; }
    if (parsed.date < SINCE) continue;
    const dest = localPath(rel);
    if (existsSync(dest) && statSync(dest).size === o.size) { skipped++; continue; }
    const body = await store.get(o.key);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(`${dest}.part`, body);
    renameSync(`${dest}.part`, dest);
    fetched++;
    bytes += body.length;
    process.stdout.write(`\r  ${fetched} downloaded (${(bytes / 1024 / 1024).toFixed(1)} MB)`);
  }
  if (fetched) process.stdout.write('\n');
  console.log(`${objects.length} objects in bucket: ${fetched} downloaded, ${skipped} already local${ignored.length ? `, ${ignored.length} not tape files (ignored)` : ''}`);
}

function stats(): void {
  if (!existsSync(OUT)) { console.log(`No tape at ${OUT}`); return; }
  const byDay = new Map<string, { files: number; bytes: number; lines: TapeLine[]; bad: number }>();
  for (const day of readdirSync(OUT).sort()) {
    let names: string[];
    try { names = readdirSync(join(OUT, day)).sort(); } catch { continue; }
    for (const name of names) {
      const rel = `${day}/${name}`;
      if (!parseRelPath(rel) || day < SINCE) continue;
      const buf = readFileSync(join(OUT, rel));
      const { lines, bad } = decodeTape(buf);
      const d = byDay.get(day) ?? { files: 0, bytes: 0, lines: [], bad: 0 };
      d.files++; d.bytes += buf.length; d.bad += bad;
      for (const l of lines) d.lines.push(l);
      byDay.set(day, d);
    }
  }
  if (byDay.size === 0) { console.log(`No tape files in ${OUT}`); return; }

  console.log(`\nTape at ${OUT}`);
  console.log('day          files     MB   snapshots  live-book  of-day  trades  markets  longest-gap  resyncs  bad');
  let tot = { snaps: 0, live: 0, trades: 0, mb: 0, decisions: 0 };
  const stageLines: string[] = [];
  for (const [day, d] of byDay) {
    const s = summarizeTape(d.lines);
    const mb = d.bytes / 1024 / 1024;
    const pctDay = (s.live / 86_400) * 100;
    tot = { snaps: tot.snaps + s.snapshots, live: tot.live + s.live, trades: tot.trades + s.trades, mb: tot.mb + mb, decisions: tot.decisions + s.decisions };
    if (s.decisions > 0) {
      const order = ['wait', 'pre', 'arb', 'unstable', 'filtered', 'passed', 'entered'];
      const parts = order.filter(k => s.stages[k]).map(k => `${k} ${s.stages[k]} (${((s.stages[k] / s.decisions) * 100).toFixed(1)}%)`);
      stageLines.push(`${day}  ${s.decisions} decisions: ${parts.join(', ')}`);
    }
    console.log(
      `${day}  ${String(d.files).padStart(5)}  ${mb.toFixed(1).padStart(5)}  ${String(s.snapshots).padStart(10)}  ` +
      `${(s.snapshots ? (s.live / s.snapshots) * 100 : 0).toFixed(1).padStart(8)}%  ${pctDay.toFixed(1).padStart(5)}%  ` +
      `${String(s.trades).padStart(6)}  ${String(s.markets).padStart(7)}  ${`${s.longestGapSec}s`.padStart(11)}  ` +
      `${String(s.resyncs).padStart(7)}  ${String(d.bad).padStart(3)}`,
    );
  }
  console.log(`total: ${tot.snaps} snapshots, ${tot.live} with a live book, ${tot.trades} trades, ${tot.decisions} decisions, ${tot.mb.toFixed(1)} MB`);
  if (stageLines.length) {
    console.log("\nDecision trail (one line per second of the bot's decisions; every entry kept):");
    for (const l of stageLines) console.log(l);
  }
  console.log('"of-day" = live-book seconds / 86,400 — the share of the day usable as second-resolution market price.');
}

if (args['stats-only'] !== 'true') await pull();
stats();
