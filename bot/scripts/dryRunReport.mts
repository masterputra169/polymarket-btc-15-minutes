#!/usr/bin/env node
/**
 * Daily summary of what the bot actually did — built for the go-live decision.
 *
 * The question that matters is not "what does the backtest say" (it scores the
 * model on the same historical distribution it trained on, and reports 84-95%)
 * but "how is the bot doing in TODAY's market". The live journal is the only
 * answer, and reading raw poll logs does not scale.
 *
 * The benchmark to beat is deliberately printed on every run: the last 100 real
 * trades before trading stopped on 2026-05-17 won 52% and LOST money. A dry-run
 * that lands near 52% means the retrain did not fix the decay.
 *
 * Usage:
 *   node bot/scripts/dryRunReport.mts [--days 1] [--journal <path>] [--all]
 *     --days N    look back N days (default 1)
 *     --all       ignore --days and report the whole journal
 *     --json      emit JSON instead of a table (for piping)
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');

/** The bar a dry-run has to clear: final 100 real trades, 2026-04-26 onward. */
const LIVE_BENCHMARK = { winRate: 52.0, pnl: -19.75, label: 'last 100 real trades (Apr-May 2026)' };

type Args = Record<string, string | boolean>;

function parseArgs(): Args {
  const out: Args = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { out[key] = next; i++; } else { out[key] = true; }
  }
  return out;
}

type Trade = {
  ts: number;
  dryRun: boolean;
  win: boolean | null;
  pnl: number;
  confidence: string | null;
  phase: string | null;
  session: string | null;
  price: number | null;
  mlProbUp: number | null;
};

function loadTrades(journalPath: string, sinceMs: number): Trade[] {
  if (!existsSync(journalPath)) return [];
  const trades: Trade[] = [];
  for (const line of readFileSync(journalPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let e: any;
    try { e = JSON.parse(trimmed); } catch { continue; }  // torn line — skip
    const ts = e._ts ?? e.entry?.enteredAt ?? 0;
    if (!ts || ts < sinceMs) continue;
    const outcome = e.analysis?.outcome;
    trades.push({
      ts,
      dryRun: e.entry?.dryRun === true,
      win: outcome === 'WIN' ? true : outcome === 'LOSS' ? false : null,
      pnl: Number(e.analysis?.pnl) || 0,
      confidence: e.entry?.confidence ?? null,
      phase: e.entry?.phase ?? null,
      session: e.entry?.session ?? null,
      price: Number(e.entry?.tokenPrice) || null,
      mlProbUp: Number(e.entry?.mlProbUp) || null,
    });
  }
  return trades.sort((a, b) => a.ts - b.ts);
}

function summarise(trades: Trade[]) {
  const resolved = trades.filter(t => t.win !== null);
  const wins = resolved.filter(t => t.win).length;
  const pnl = resolved.reduce((s, t) => s + t.pnl, 0);
  return {
    total: trades.length,
    resolved: resolved.length,
    wins,
    losses: resolved.length - wins,
    winRate: resolved.length ? (wins / resolved.length) * 100 : null,
    pnl,
    withMlContext: trades.filter(t => t.mlProbUp != null).length,
  };
}

function groupBy(trades: Trade[], key: keyof Trade) {
  const groups = new Map<string, Trade[]>();
  for (const t of trades) {
    const g = String(t[key] ?? 'unknown');
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(t);
  }
  return groups;
}

function pct(v: number | null): string {
  return v == null ? '   n/a' : `${v.toFixed(1)}%`;
}

/**
 * PTB source health over the window.
 *
 * The PTB-source gate blocks entries with no ML or edge override, so a degraded
 * source is the one failure that turns an observation period into silence. When
 * the report shows zero trades, this line says whether the market was quiet or
 * the bot was structurally unable to enter.
 */
function ptbHealth(sinceMs: number): { total: number; exact: number; bySource: Record<string, number> } | null {
  const p = resolve(ROOT, 'bot', 'data', 'ptb_health.jsonl');
  if (!existsSync(p)) return null;
  let total = 0, exact = 0;
  const bySource: Record<string, number> = {};
  for (const line of readFileSync(p, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let e: any;
    try { e = JSON.parse(trimmed); } catch { continue; }   // torn line — skip
    if (!e.to || e.to < sinceMs) continue;
    total += e.total || 0;
    exact += e.exact || 0;
    for (const [src, n] of Object.entries(e.bySource || {})) bySource[src] = (bySource[src] || 0) + (n as number);
  }
  return total ? { total, exact, bySource } : null;
}

function printPtbHealth(sinceMs: number): void {
  const h = ptbHealth(sinceMs);
  console.log(`\n  ${'-'.repeat(60)}`);
  if (!h) {
    console.log('  PTB source health: no data yet (bot/data/ptb_health.jsonl empty —');
    console.log('                     needs a bot running the ptbHealth instrumentation)');
    return;
  }
  const okPct = (h.exact / h.total) * 100;
  const verdict = okPct >= 95 ? 'healthy'
    : okPct >= 80 ? 'degraded — some entries were blocked at the PTB gate'
    : 'BROKEN — the PTB gate is blocking most entries, trades cannot happen';
  console.log(`  PTB source health: ${okPct.toFixed(1)}% exact of ${h.total.toLocaleString()} evaluations — ${verdict}`);
  const sorted = Object.entries(h.bySource).sort((a, b) => b[1] - a[1]);
  console.log(`    ${sorted.map(([s, n]) => `${s}=${((n / h.total) * 100).toFixed(1)}%`).join('  ')}`);
}

function main(): void {
  const args = parseArgs();
  const journalPath = typeof args.journal === 'string'
    ? args.journal
    : resolve(ROOT, 'bot', 'data', 'trade_journal.jsonl');
  const days = args.all ? Infinity : Number(args.days ?? 1);
  const sinceMs = args.all ? 0 : Date.now() - days * 86_400_000;

  const all = loadTrades(journalPath, sinceMs);
  const dry = all.filter(t => t.dryRun);
  const live = all.filter(t => !t.dryRun);

  if (args.json) {
    console.log(JSON.stringify({
      window: args.all ? 'all' : `${days}d`,
      dryRun: summarise(dry),
      live: summarise(live),
      ptb: ptbHealth(sinceMs),
      benchmark: LIVE_BENCHMARK,
    }, null, 2));
    return;
  }

  const window = args.all ? 'entire journal' : `last ${days} day(s)`;
  console.log(`\n${'='.repeat(64)}`);
  console.log(`  Dry-run report — ${window}`);
  console.log(`  Journal: ${journalPath}`);
  console.log('='.repeat(64));

  if (all.length === 0) {
    console.log('\n  No journal entries in this window.');
    console.log('  If the bot is running, filters are blocking every entry —');
    console.log('  check the live log for the "Filtered:" lines to see which.');
    printPtbHealth(sinceMs);
    console.log('');
    return;
  }

  for (const [label, set] of [['DRY-RUN', dry], ['LIVE', live]] as const) {
    if (set.length === 0) continue;
    const s = summarise(set);
    console.log(`\n  ${label}: ${s.total} entries | ${s.resolved} resolved | ` +
                `${s.wins}W-${s.losses}L | WR ${pct(s.winRate)} | PnL ${s.pnl >= 0 ? '+' : ''}${s.pnl.toFixed(2)}`);
    if (s.total > 0) {
      const covered = ((s.withMlContext / s.total) * 100).toFixed(0);
      console.log(`  ML context recorded on ${s.withMlContext}/${s.total} entries (${covered}%)`);
    }

    for (const key of ['confidence', 'phase', 'session'] as const) {
      const groups = groupBy(set.filter(t => t.win !== null), key);
      if (groups.size <= 1) continue;
      console.log(`\n    by ${key}:`);
      for (const [name, group] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
        const g = summarise(group);
        console.log(`      ${name.slice(0, 18).padEnd(18)} n=${String(g.resolved).padStart(3)}  ` +
                    `WR ${pct(g.winRate)}  PnL ${g.pnl >= 0 ? '+' : ''}${g.pnl.toFixed(2)}`);
      }
    }
  }

  printPtbHealth(sinceMs);

  const d = summarise(dry);
  console.log(`\n  ${'-'.repeat(60)}`);
  console.log(`  Benchmark to beat: ${LIVE_BENCHMARK.winRate}% WR, ${LIVE_BENCHMARK.pnl} PnL`);
  console.log(`                     (${LIVE_BENCHMARK.label})`);
  if (d.resolved >= 30 && d.winRate != null) {
    const delta = d.winRate - LIVE_BENCHMARK.winRate;
    const verdict = delta > 10 ? 'clearly better — retrain looks to have helped'
      : delta > 0 ? 'better, but inside noise at this sample size'
      : 'NOT better — do not go live on this evidence';
    console.log(`  Dry-run so far:    ${pct(d.winRate)} (${delta >= 0 ? '+' : ''}${delta.toFixed(1)}pp) — ${verdict}`);
  } else {
    console.log(`  Dry-run so far:    ${d.resolved} resolved trades — need >=30 before this means anything`);
  }
  console.log('');
}

main();
