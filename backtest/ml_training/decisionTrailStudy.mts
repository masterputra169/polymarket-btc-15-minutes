/**
 * Decision-trail study — what the entry gates did to the signals the bot really
 * saw, scored against how each market actually resolved.
 *
 *   node backtest/ml_training/decisionTrailStudy.mts
 *   node backtest/ml_training/decisionTrailStudy.mts --since 2026-09-25T03:00Z --until 2026-10-15
 *   node backtest/ml_training/decisionTrailStudy.mts --relax ml_conf,late_ml --relax too_early
 *   node backtest/ml_training/decisionTrailStudy.mts --offline          # cached resolutions only
 *
 * Flags:
 *   --tape DIR            tape root (default backtest/ml_training/tape; `npm run tape:pull` fills it)
 *   --since / --until     ISO date or datetime, UTC; lines outside are ignored
 *   --offline             no network: markets not in the resolution cache count as unresolved
 *   --relax a,b           extra "relax these gates together" scenario for section (c); repeatable
 *   --ml-thresholds list  thresholds for section (d) (default 0.30,0.40,0.45,0.50,0.55,0.65)
 *   --slip X              added to the side's price for a simulated fill (default 0.01)
 *
 * Input: the market tape's `d` lines (bot/src/tape/decisionTrail.ts — one sampled
 * poll per second plus every entry) and `m` lines (conditionId). Outcomes come
 * from Polymarket through bot/src/engines/marketResolution.ts over DoH (this
 * host's resolver black-holes polymarket.com) and are cached in
 * <tape>/_resolutions.json, so a rerun is offline for every market already seen.
 *
 * What a simulated trade is, and is not: side `sd` at the price decide() used
 * (`pu`/`pd`) + slip, $1 stake, fee 0.072·c·(1−c) on the winning profit. The
 * gates after applyTradeFilters() (Monte Carlo, smart flow, validateTrade, FOK
 * depth) are not modelled, so every simulated set is an upper bound.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { gunzipSync, constants as zc } from 'zlib';
import { parseRelPath, type DecisionLine, type MarketLine } from '../../bot/src/tape/tapeFormat.ts';
import { fetchResolvedOutcome, type LookupOpts } from '../../bot/src/engines/marketResolution.ts';
import { fetchJsonWithPolymarketDoh } from '../../bot/src/services/polymarketHttp.ts';
import {
  GATE_IDS, isGateId, reasonShape, categorizeReason, scoreLine, isEvaluableEnter, soleGate,
  passesWithRelaxed, passesAtMlThreshold, passesMlRule, ML_RULE_CANDIDATES, firstPerMarket, simulateTrade, summarizeTrades,
  marketEndMs, stageMix, STAGES, DEFAULT_SLIPPAGE,
  type GateId, type ScoredLine, type SimTrade, type Side, type TradeSummary, type StageCounts,
} from './decisionTrailCore.mts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SMALL_N = 30;
const DEFAULT_ML_THRESHOLDS = [0.30, 0.40, 0.45, 0.50, 0.55, 0.65];
/** Do not ask Polymarket about a market until this long after it closed. */
const RESOLVE_GRACE_MS = 2 * 60_000;
const RESOLVE_CONCURRENCY = 6;

// ── CLI ──────────────────────────────────────────────────────────────────────

interface Args {
  tape: string;
  sinceMs: number;
  untilMs: number;
  offline: boolean;
  relax: GateId[][];
  mlThresholds: number[];
  slip: number;
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(2);
}

function parseIso(raw: string, flag: string): number {
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) fail(`${flag} "${raw}" is not an ISO date/datetime`);
  return ms;
}

function parseArgs(argv: string[]): Args {
  const multi = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) fail(`unexpected argument "${a}" (see the header of this file for usage)`);
    const key = a.slice(2);
    const next = argv[i + 1];
    const isValue = next !== undefined && !next.startsWith('--');
    if (isValue) i++;
    multi.set(key, [...(multi.get(key) ?? []), isValue ? next : 'true']);
  }
  const one = (k: string): string | undefined => multi.get(k)?.at(-1);
  const known = new Set(['tape', 'since', 'until', 'offline', 'relax', 'ml-thresholds', 'slip', 'help']);
  for (const k of multi.keys()) if (!known.has(k)) fail(`unknown flag --${k}`);
  if (one('help')) {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
    process.exit(0);
  }

  const relax = (multi.get('relax') ?? []).map((group) => {
    const ids = group.split(',').map((s) => s.trim()).filter(Boolean);
    const bad = ids.filter((g) => !isGateId(g));
    if (ids.length === 0 || bad.length) fail(`--relax "${group}": unknown gate id(s) ${bad.join(', ')}. Known: ${GATE_IDS.join(', ')}`);
    return ids as GateId[];
  });

  const thrRaw = one('ml-thresholds');
  const mlThresholds = thrRaw ? thrRaw.split(',').map(Number) : DEFAULT_ML_THRESHOLDS;
  if (mlThresholds.some((x) => !Number.isFinite(x) || x < 0 || x > 1)) fail(`--ml-thresholds "${thrRaw}": numbers in 0..1, comma-separated`);

  const slip = one('slip') != null ? Number(one('slip')) : DEFAULT_SLIPPAGE;
  if (!Number.isFinite(slip) || slip < 0 || slip > 0.2) fail('--slip must be a number in 0..0.2');

  const sinceMs = one('since') ? parseIso(one('since')!, '--since') : -Infinity;
  const untilMs = one('until') ? parseIso(one('until')!, '--until') : Infinity;
  if (sinceMs >= untilMs) fail('--since must be before --until');

  return {
    tape: resolve(one('tape') ?? join(ROOT, 'backtest', 'ml_training', 'tape')),
    sinceMs, untilMs, offline: one('offline') === 'true', relax, mlThresholds, slip,
  };
}

// ── Tape loading ─────────────────────────────────────────────────────────────

interface Loaded {
  files: number;
  unreadableFiles: string[];
  badLines: number;
  decisions: DecisionLine[];
  markets: MarketLine[];
}

/**
 * Only `d` and `m` lines are parsed: a day of 1 Hz book snapshots is far larger
 * than everything this study reads. The substring test does not depend on key
 * order; the parsed `k` is checked again.
 */
function decodeSelected(buf: Buffer, out: Loaded, args: Args): void {
  // SYNC_FLUSH: a gzip member torn by a crash yields what it holds (as decodeTape does).
  const text = gunzipSync(buf, { finishFlush: zc.Z_SYNC_FLUSH }).toString('utf8');
  for (const raw of text.split('\n')) {
    if (raw === '') continue;
    const isD = raw.includes('"k":"d"');
    if (!isD && !raw.includes('"k":"m"')) continue;
    let obj: unknown;
    try { obj = JSON.parse(raw); } catch { out.badLines++; continue; }
    const l = obj as { k?: unknown; t?: unknown };
    if (!l || typeof l !== 'object' || !Number.isFinite(l.t as number)) { out.badLines++; continue; }
    const t = l.t as number;
    if (t < args.sinceMs || t > args.untilMs) continue;
    if (l.k === 'd') out.decisions.push(obj as DecisionLine);
    else if (l.k === 'm') out.markets.push(obj as MarketLine);
  }
}

function loadTape(args: Args): Loaded {
  const out: Loaded = { files: 0, unreadableFiles: [], badLines: 0, decisions: [], markets: [] };
  if (!existsSync(args.tape)) fail(`No tape at ${args.tape} — run \`npm run tape:pull\` first.`);
  for (const day of readdirSync(args.tape).sort()) {
    let names: string[];
    try { names = readdirSync(join(args.tape, day)).sort(); } catch { continue; } // _resolutions.json and other files
    for (const name of names) {
      const rel = `${day}/${name}`;
      const parsed = parseRelPath(rel);
      if (!parsed) continue;
      const hourStart = Date.parse(`${parsed.date}T${parsed.hour}:00:00Z`);
      if (hourStart + 3_600_000 <= args.sinceMs || hourStart > args.untilMs) continue;
      try {
        decodeSelected(readFileSync(join(args.tape, rel)), out, args);
        out.files++;
      } catch (err) {
        out.unreadableFiles.push(`${rel}: ${(err as Error).message}`);
      }
    }
  }
  // Several processes can write the same hour; the study needs one timeline.
  out.decisions.sort((a, b) => a.t - b.t);
  out.markets.sort((a, b) => a.t - b.t);
  return out;
}

// ── Resolutions ──────────────────────────────────────────────────────────────

interface CachedResolution { outcome: Side; source: string; conditionId: string | null; checkedAt: string }
interface ResolutionCache { version: 1; markets: Record<string, CachedResolution> }

function readCache(path: string): ResolutionCache {
  if (!existsSync(path)) return { version: 1, markets: {} };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    if (raw && raw.version === 1 && raw.markets && typeof raw.markets === 'object') return raw as ResolutionCache;
    throw new Error('unexpected shape');
  } catch (err) {
    const aside = `${path}.unreadable-${Date.now()}`;
    renameSync(path, aside);
    console.warn(`Resolution cache unreadable (${(err as Error).message}); moved to ${aside}, starting empty.`);
    return { version: 1, markets: {} };
  }
}

function writeCache(path: string, cache: ResolutionCache): void {
  const tmp = `${path}.part`;
  writeFileSync(tmp, JSON.stringify(cache, null, 1));
  renameSync(tmp, path);
}

/** marketResolution's fetch seam, over DoH. A non-2xx becomes { ok:false } like fetch; network errors throw. */
const dohFetch: NonNullable<LookupOpts['fetchImpl']> = async (url: string) => {
  try {
    const body = await fetchJsonWithPolymarketDoh(url, { timeoutMs: 10_000, label: 'resolution' });
    return { ok: true, status: 200, json: async () => body };
  } catch (err) {
    const m = /HTTP (\d{3})/.exec((err as Error).message);
    if (m) return { ok: false, status: Number(m[1]), json: async () => null };
    throw err;
  }
};

async function mapPool<T>(items: readonly T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

interface ResolveStats { cached: number; fetched: number; notEnded: number; noResult: number; errors: string[] }

async function resolveOutcomes(slugs: readonly string[], mLines: readonly MarketLine[], args: Args): Promise<{ outcomes: Map<string, Side>; stats: ResolveStats }> {
  const cachePath = join(args.tape, '_resolutions.json');
  const cache = readCache(cachePath);
  const bySlug = new Map<string, MarketLine>();
  for (const m of mLines) if (m.m) bySlug.set(m.m, m);

  const outcomes = new Map<string, Side>();
  const stats: ResolveStats = { cached: 0, fetched: 0, notEnded: 0, noResult: 0, errors: [] };
  const todo: string[] = [];
  const now = Date.now();
  for (const slug of slugs) {
    const hit = cache.markets[slug];
    if (hit && (hit.outcome === 'UP' || hit.outcome === 'DOWN')) { outcomes.set(slug, hit.outcome); stats.cached++; continue; }
    const end = marketEndMs(slug, bySlug.get(slug)?.end);
    if (end != null && now < end + RESOLVE_GRACE_MS) { stats.notEnded++; continue; }
    todo.push(slug);
  }

  if (todo.length && args.offline) {
    stats.noResult += todo.length;
    return { outcomes, stats };
  }
  if (todo.length) process.stdout.write(`Resolving ${todo.length} market(s) via Polymarket (DoH) ...`);
  const fresh: Record<string, CachedResolution> = {};
  await mapPool(todo, RESOLVE_CONCURRENCY, async (slug) => {
    const conditionId = bySlug.get(slug)?.cid ?? null;
    try {
      const res = await fetchResolvedOutcome({ conditionId, marketSlug: slug }, { fetchImpl: dohFetch, timeoutMs: 10_000 });
      if (!res) { stats.noResult++; return; }
      outcomes.set(slug, res.outcome);
      fresh[slug] = { outcome: res.outcome, source: res.source, conditionId, checkedAt: new Date().toISOString() };
      stats.fetched++;
    } catch (err) {
      stats.errors.push(`${slug}: ${(err as Error).message}`);
    }
  });
  if (todo.length) process.stdout.write(' done\n');
  if (Object.keys(fresh).length) writeCache(cachePath, { version: 1, markets: { ...cache.markets, ...fresh } });
  return { outcomes, stats };
}

// ── Formatting ───────────────────────────────────────────────────────────────

const pct = (x: number | null | undefined, dp = 1): string => (x == null || !Number.isFinite(x) ? '-' : `${(x * 100).toFixed(dp)}%`);
const signed = (x: number | null | undefined, dp = 1, unit = ''): string =>
  (x == null || !Number.isFinite(x) ? '-' : `${x >= 0 ? '+' : ''}${x.toFixed(dp)}${unit}`);
const flag = (n: number): string => (n === 0 ? 'no data' : n < SMALL_N ? `n<${SMALL_N}` : '');

function table(headers: string[], rows: string[][], leftCols = 1): void {
  const w = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const fmt = (cells: string[]): string => cells
    .map((c, i) => (i < leftCols ? (c ?? '').padEnd(w[i]) : (c ?? '').padStart(w[i])))
    .join('  ')
    .trimEnd();
  console.log(`  ${fmt(headers)}`);
  console.log(`  ${w.map((x) => '-'.repeat(x)).join('  ')}`);
  for (const r of rows) console.log(`  ${fmt(r)}`);
}

function section(title: string): void {
  console.log(`\n${'='.repeat(100)}\n${title}\n${'='.repeat(100)}`);
}

/** Columns shared by every outcome table. */
const SUMMARY_HEADERS = ['n', 'WR', '95% CI', 'breakeven', 'margin', 'ROI/$1', 'avg c', 'flag'];
function summaryCells(s: TradeSummary): string[] {
  return [
    String(s.n),
    pct(s.winRate),
    s.ci ? `${pct(s.ci[0], 0)}-${pct(s.ci[1], 0)}` : '-',
    pct(s.breakeven),
    signed(s.marginPp, 1, 'pp'),
    signed(s.roi == null ? null : s.roi * 100, 1, '%'),
    s.avgPrice == null ? '-' : `${(s.avgPrice * 100).toFixed(1)}c`,
    flag(s.n),
  ];
}

// ── Sections ─────────────────────────────────────────────────────────────────

function stageRow(label: string, c: StageCounts): string[] {
  return [label, String(c.total), ...STAGES.map((s) => String(c.stages[s])), String(c.enter), pct(c.total ? c.stages.filtered / c.total : null)];
}
const STAGE_HEADERS = ['group', 'lines', ...STAGES, 'ENTER', '%filtered'];

function sectionStages(decisions: readonly DecisionLine[]): void {
  section('(a) Stage mix — every d line (1 sampled poll/s + every entry)');
  const overall = stageMix(decisions, () => 'all').get('all');
  if (!overall) { console.log('  no d lines'); return; }
  console.log(`  stages: wait = decide() said WAIT; pre = ENTER held by a loop precondition; arb; unstable = confirmation hold;`);
  console.log(`          filtered / passed = applyTradeFilters() ran; entered. Gates below can only be judged on filtered/passed/entered.\n`);
  table(STAGE_HEADERS, [stageRow('all', overall), ['share', '', ...STAGES.map((s) => pct(overall.stages[s] / overall.total)), pct(overall.enter / overall.total), '']]);

  console.log('\n  by session');
  const bySession = stageMix(decisions, (l) => l.ss);
  table(STAGE_HEADERS, [...bySession.entries()].sort((a, b) => b[1].total - a[1].total).map(([k, c]) => stageRow(k, c)));

  console.log('\n  by UTC hour');
  const byHour = stageMix(decisions, (l) => new Date(l.t).toISOString().slice(11, 13));
  table(STAGE_HEADERS, [...byHour.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, c]) => stageRow(`${k}h`, c)));

  const count = (xs: Iterable<string>): string => {
    const m = new Map<string, number>();
    for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ') || '-';
  };
  console.log(`\n  pre reasons (ENTER lines): ${count(decisions.flatMap((l) => (l.st === 'pre' ? l.pre ?? [] : [])))}`);
  console.log(`  unstable holds:            ${count(decisions.flatMap((l) => (l.st === 'unstable' ? (l.hold ?? []).map(reasonShape) : [])))}`);
}

interface GateUse { lines: number; markets: Set<string>; soleLines: number; soleMarkets: Set<string> }

function tradesFrom(picks: Map<string, ScoredLine<DecisionLine>>, outcomes: Map<string, Side>, slip: number): { trades: SimTrade[]; unresolved: number } {
  const trades: SimTrade[] = [];
  let unresolved = 0;
  for (const [slug, s] of picks) {
    const tr = simulateTrade(s.line, outcomes.get(slug), slip);
    if (tr) trades.push(tr);
    else unresolved++;
  }
  return { trades, unresolved };
}

function sectionGates(scored: readonly ScoredLine<DecisionLine>[], outcomes: Map<string, Side>, args: Args): GateId[] {
  section('(b) Gates — ENTER signals held by each gate, and alone');
  const evaluable = scored.filter((s) => isEvaluableEnter(s.line));
  const blocked = evaluable.filter((s) => s.gates.length > 0);
  const use = new Map<GateId, GateUse>();
  for (const s of blocked) {
    const sole = soleGate(s);
    for (const g of s.gates) {
      const u = use.get(g) ?? { lines: 0, markets: new Set<string>(), soleLines: 0, soleMarkets: new Set<string>() };
      u.lines++;
      if (s.line.m) u.markets.add(s.line.m);
      if (sole === g) {
        u.soleLines++;
        if (s.line.m) u.soleMarkets.add(s.line.m);
      }
      use.set(g, u);
    }
  }
  const evalMarkets = new Set(evaluable.map((s) => s.line.m).filter(Boolean)).size;
  console.log(`  evaluable ENTER lines (filters ran): ${evaluable.length} in ${evalMarkets} markets; held by >=1 gate: ${blocked.length}`);
  console.log('  "alone" = every reason on the line belongs to that gate. Shares are of the held lines.\n');

  const order = GATE_IDS.filter((g) => use.has(g)).sort((a, b) => use.get(b)!.lines - use.get(a)!.lines);
  table(
    ['gate', 'held lines', 'share', 'markets', 'alone lines', 'alone mkts'],
    order.map((g) => {
      const u = use.get(g)!;
      return [g, String(u.lines), pct(blocked.length ? u.lines / blocked.length : null), String(u.markets.size), String(u.soleLines), String(u.soleMarkets.size)];
    }),
  );

  console.log(`\n  Outcome had the bot entered at the FIRST second each gate held the market alone`);
  console.log(`  (side sd, price pu/pd + ${Math.round(args.slip * 100)}c, $1; one trade per market; resolved markets only):\n`);
  const rows: string[][] = [];
  for (const g of order) {
    const picks = firstPerMarket(scored, (s) => soleGate(s) === g);
    if (picks.size === 0) continue;
    const { trades, unresolved } = tradesFrom(picks, outcomes, args.slip);
    rows.push([g, String(picks.size), String(unresolved), ...summaryCells(summarizeTrades(trades))]);
  }
  if (rows.length) table(['gate', 'mkts', 'unres', ...SUMMARY_HEADERS], rows);
  else console.log('  no gate held any market alone');

  const unknown = new Map<string, number>();
  for (const s of scored) for (const r of s.line.fr ?? []) if (categorizeReason(r) === 'other') unknown.set(reasonShape(r), (unknown.get(reasonShape(r)) ?? 0) + 1);
  if (unknown.size) {
    console.log(`\n  UNRECOGNISED reasons (counted as 'other' — add a rule in decisionTrailCore.mts RULES):`);
    for (const [k, v] of [...unknown.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`    ${String(v).padStart(6)}  ${k}`);
  } else {
    console.log(`\n  every filter reason was recognised (no 'other').`);
  }
  return order;
}

interface ScenarioRow { label: string; picks: Map<string, ScoredLine<DecisionLine>> }

function compareRows(rows: ScenarioRow[], actual: Map<string, ScoredLine<DecisionLine>>, outcomes: Map<string, Side>, args: Args): void {
  const out: string[][] = [];
  for (const r of rows) {
    const all = tradesFrom(r.picks, outcomes, args.slip);
    const addedPicks = new Map([...r.picks].filter(([slug]) => !actual.has(slug)));
    const added = tradesFrom(addedPicks, outcomes, args.slip);
    const sa = summarizeTrades(added.trades);
    out.push([
      r.label, String(r.picks.size), String(all.unresolved), ...summaryCells(summarizeTrades(all.trades)),
      String(r.picks.size - addedPicks.size), String(addedPicks.size), String(sa.n), pct(sa.winRate), pct(sa.breakeven),
      signed(sa.roi == null ? null : sa.roi * 100, 1, '%'), flag(sa.n),
    ]);
  }
  table(['scenario', 'mkts', 'unres', ...SUMMARY_HEADERS, 'same', '+mkts', '+n', '+WR', '+BE', '+ROI', '+flag'], out);
}

function sectionRelax(scored: readonly ScoredLine<DecisionLine>[], outcomes: Map<string, Side>, gates: GateId[], args: Args,
  actual: Map<string, ScoredLine<DecisionLine>>): void {
  section('(c) Counterfactual: relax one gate — first ENTER per market that clears every OTHER recorded reason');
  console.log('  same = markets the bot actually entered (the relaxed entry may come earlier, at another price);');
  console.log('  +... = markets the bot did NOT enter — the trades relaxing the gate would add.\n');
  const rows: ScenarioRow[] = [
    { label: 'actual (st=entered)', picks: actual },
    { label: 'none relaxed', picks: firstPerMarket(scored, (s) => passesWithRelaxed(s, new Set())) },
  ];
  const quiet: GateId[] = [];
  for (const g of gates) {
    const picks = firstPerMarket(scored, (s) => passesWithRelaxed(s, new Set([g])));
    if (picks.size === rows[1].picks.size && [...picks.keys()].every((k) => rows[1].picks.has(k))) { quiet.push(g); continue; }
    rows.push({ label: g, picks });
  }
  for (const group of args.relax) {
    rows.push({ label: group.join('+'), picks: firstPerMarket(scored, (s) => passesWithRelaxed(s, new Set(group))) });
  }
  compareRows(rows, actual, outcomes, args);
  const extra = rows[1].picks.size - [...rows[1].picks.keys()].filter((k) => actual.has(k)).length;
  console.log(`\n  "none relaxed" vs actual: ${extra} market(s) had a line that passed every filter but no entry — held downstream`);
  console.log('  (Monte Carlo / smart-flow / validateTrade / FOK depth) or by a precondition on the following polls; the tape does not say which.');
  if (quiet.length) console.log(`  Never the only blocker, so relaxing alone adds nothing: ${quiet.join(', ')}`);
}

function sectionMlSweep(scored: readonly ScoredLine<DecisionLine>[], outcomes: Map<string, Side>, args: Args,
  actual: Map<string, ScoredLine<DecisionLine>>): void {
  section('(d) ML-confidence threshold sweep — ml_conf gate replaced by mc >= T, every other recorded reason must be absent');
  console.log('  Live rule for comparison: mc >= 0.65, relaxed to 0.45 when edge >= 15% (tradeFilters.ts filter 1).');
  console.log('  dead_zone, late_ml and trending_ml are separate gates and still apply as recorded.\n');
  const nullMc = scored.filter((s) => isEvaluableEnter(s.line) && s.line.mc == null).length;
  const rows: ScenarioRow[] = args.mlThresholds.map((T) => ({
    label: `T=${T.toFixed(2)}`,
    picks: firstPerMarket(scored, (s) => passesAtMlThreshold(s, T)),
  }));
  compareRows(rows, actual, outcomes, args);
  if (nullMc) console.log(`\n  ${nullMc} evaluable ENTER line(s) had no ML confidence; they pass at every T, as the bot's gate needs ML.`);
}

function sectionMlRules(scored: readonly ScoredLine<DecisionLine>[], outcomes: Map<string, Side>, args: Args,
  actual: Map<string, ScoredLine<DecisionLine>>): void {
  section('(e) Candidate ML rules, scored forward — the full ML gate (min / relaxed at edge >= bypass), other reasons absent');
  console.log('  The 30-day rule search (ruleSearch.py, 2026-09-26) found no rule that beat the live one out of sample;');
  console.log('  the edge-bypass variant looked promising only after seeing VALIDATE, so it is tested here on markets it never saw.\n');
  const rows: ScenarioRow[] = ML_RULE_CANDIDATES.map((rule) => ({
    label: rule.label,
    picks: firstPerMarket(scored, (s) => passesMlRule(s, rule)),
  }));
  compareRows(rows, actual, outcomes, args);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const loaded = loadTape(args);
  const decisions = loaded.decisions;

  section('Decision-trail study');
  console.log(`  tape ${args.tape}`);
  console.log(`  window ${Number.isFinite(args.sinceMs) ? new Date(args.sinceMs).toISOString() : '(start)'} .. ${Number.isFinite(args.untilMs) ? new Date(args.untilMs).toISOString() : '(end)'}`);
  console.log(`  files ${loaded.files}${loaded.unreadableFiles.length ? `, UNREADABLE ${loaded.unreadableFiles.length}` : ''}; bad d/m lines ${loaded.badLines}; m lines ${loaded.markets.length}`);
  for (const u of loaded.unreadableFiles) console.log(`    ${u}`);
  if (decisions.length === 0) { console.log('\n  No d lines in this window (decision lines exist from 2026-09-25 ~03:00 UTC).'); return; }
  console.log(`  d lines ${decisions.length}: ${new Date(decisions[0].t).toISOString()} .. ${new Date(decisions[decisions.length - 1].t).toISOString()}`);

  const slugs = [...new Set(decisions.map((d) => d.m).filter((m): m is string => !!m))];
  const { outcomes, stats } = await resolveOutcomes(slugs, loaded.markets, args);
  console.log(`  markets with d lines ${slugs.length}: resolved ${outcomes.size} (cache ${stats.cached}, fetched ${stats.fetched}); ` +
    `UNRESOLVED ${slugs.length - outcomes.size} (not yet closed ${stats.notEnded}, no result${args.offline ? ' / offline' : ''} ${stats.noResult}, errors ${stats.errors.length}) — skipped in every outcome table`);
  for (const e of stats.errors.slice(0, 10)) console.log(`    error ${e}`);
  const up = [...outcomes.values()].filter((o) => o === 'UP').length;
  console.log(`  resolved outcomes: UP ${up}, DOWN ${outcomes.size - up}`);
  console.log(`  simulated fill = side price (pu/pd) + ${args.slip.toFixed(2)}; $1 stake; fee 0.072*c*(1-c) on profit; breakeven = n/(n + sum win-profit).`);
  console.log(`  Rows flagged n<${SMALL_N} are anecdotes, not evidence — do not change a gate on them.`);

  const scored = decisions.map(scoreLine);
  const actual = firstPerMarket(scored, (s) => s.line.st === 'entered');

  sectionStages(decisions);
  const gates = sectionGates(scored, outcomes, args);
  sectionRelax(scored, outcomes, gates, args, actual);
  sectionMlSweep(scored, outcomes, args, actual);
  sectionMlRules(scored, outcomes, args, actual);

  const enteredLines = decisions.filter((d) => d.st === 'entered').length;
  console.log(`\n  actual entries: ${enteredLines} entered line(s) in ${actual.size} market(s)` +
    (enteredLines !== actual.size ? ' (more lines than markets: two processes or a re-entry — one trade per market is scored)' : ''));
}

main().catch((err) => {
  console.error(err?.stack ?? err);
  process.exit(1);
});
