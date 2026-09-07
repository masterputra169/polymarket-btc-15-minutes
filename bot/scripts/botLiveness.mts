#!/usr/bin/env node
/**
 * Is the bot alive AND seeing the market? Exit code for the stack watchdog.
 *
 * Reads bot/data/ptb_health.jsonl (one rollup per minute while the bot can
 * evaluate its trade filters) and judges the newest rollup's age:
 *   exit 0  fresh    — last rollup within --stale-min (default 10)
 *   exit 2  stale    — bot process is up but has not completed a poll in a while
 *   exit 3  no_data  — file missing or empty (fresh container, or never polled)
 * Prints one JSON line either way, for the watchdog log.
 *
 * Usage: node bot/scripts/botLiveness.mts [--stale-min 10] [--file <path>]
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { assessLiveness } from '../src/monitoring/liveness.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const staleMin = Number(arg('stale-min') ?? 10);
const file = arg('file') ?? resolve(ROOT, 'bot', 'data', 'ptb_health.jsonl');
const content = existsSync(file) ? readFileSync(file, 'utf-8') : '';

const verdict = assessLiveness(content, {
  now: Date.now(),
  staleMs: (Number.isFinite(staleMin) && staleMin > 0 ? staleMin : 10) * 60_000,
});

console.log(JSON.stringify({
  ...verdict,
  lastTo: verdict.lastTo != null ? new Date(verdict.lastTo).toISOString() : null,
  ageMin: verdict.ageMs != null ? Number((verdict.ageMs / 60_000).toFixed(1)) : null,
  staleMin,
  file,
}));

process.exit(verdict.status === 'fresh' ? 0 : verdict.status === 'stale' ? 2 : 3);
