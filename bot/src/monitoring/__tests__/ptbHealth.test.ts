/**
 * PTB source health recorder.
 *
 * This exists to answer one question after a silent observation period: was the
 * market quiet, or was the bot structurally unable to enter? The PTB gate has no
 * override, so a degraded source produces zero trades and no other symptom.
 *
 * The properties that matter: the exact-source list must stay in sync with the
 * gate it mirrors (otherwise the health line lies), counting must be cheap and
 * must never throw into the trading path, and a flush must produce a line that
 * dryRunReport can add up.
 */

import { describe, test, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { readFileSync, existsSync, rmSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

// Point the recorder at a scratch file BEFORE importing it — the module resolves
// its path at load time, and a test must never append to bot/data.
const TMP_DIR = mkdtempSync(join(tmpdir(), 'ptbhealth-'));
const HEALTH_PATH = join(TMP_DIR, 'ptb_health.jsonl');
process.env.PTB_HEALTH_PATH = HEALTH_PATH;

const { recordPtbSource, flush, getPendingCounts, _reset, EXACT_PTB_SOURCES } = await import('../ptbHealth.ts');

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Read the lines this test appended, newest last. */
function readLines() {
  if (!existsSync(HEALTH_PATH)) return [];
  return readFileSync(HEALTH_PATH, 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}

beforeEach(() => { _reset(); });
afterEach(() => { _reset(); });
afterAll(() => { rmSync(TMP_DIR, { recursive: true, force: true }); });

describe('ptbHealth', () => {
  test('the exact-source list matches the gate it mirrors', () => {
    // If tradeFilters' EXACT_PTB_TRUST changes and this does not, every health
    // line silently misreports. Read the gate's list straight out of the source.
    const src = readFileSync(resolve(__dirname, '..', '..', 'safety', 'tradeFilters.ts'), 'utf-8');
    const m = src.match(/const EXACT_PTB_TRUST = \[([^\]]+)\]/);
    expect(m, 'EXACT_PTB_TRUST not found in tradeFilters.ts').toBeTruthy();
    const gateList = m![1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    expect([...EXACT_PTB_SOURCES].sort()).toEqual([...gateList].sort());
  });

  test('counts in memory without writing until flushed', () => {
    const before = readLines().length;
    recordPtbSource('scheduled_ws');
    recordPtbSource('scheduled_ws');
    recordPtbSource('chainlink_round');
    expect(getPendingCounts()).toEqual({ scheduled_ws: 2, chainlink_round: 1 });
    expect(readLines().length).toBe(before);   // nothing written yet
  });

  test('flush writes one line with the exact/total split', () => {
    const before = readLines().length;
    for (let i = 0; i < 7; i++) recordPtbSource('scheduled_ws');
    for (let i = 0; i < 3; i++) recordPtbSource('chainlink_round');
    flush();

    const lines = readLines();
    expect(lines.length).toBe(before + 1);
    const last = lines[lines.length - 1];
    expect(last.total).toBe(10);
    expect(last.exact).toBe(7);
    expect(last.exactPct).toBeCloseTo(70, 5);
    expect(last.bySource).toEqual({ scheduled_ws: 7, chainlink_round: 3 });
    expect(last.to).toBeGreaterThanOrEqual(last.from);
  });

  test('flush resets the window so counts are not double reported', () => {
    recordPtbSource('scheduled_ws');
    flush();
    expect(getPendingCounts()).toEqual({});
    const before = readLines().length;
    flush();                                    // nothing pending
    expect(readLines().length).toBe(before);    // no empty line appended
  });

  test('a null or undefined source is recorded as missing, not dropped', () => {
    recordPtbSource(null);
    recordPtbSource(undefined);
    expect(getPendingCounts()).toEqual({ missing: 2 });
    flush();
    const last = readLines().pop();
    expect(last.exact).toBe(0);
    expect(last.total).toBe(2);
  });

  test('an unknown source counts toward total but never toward exact', () => {
    recordPtbSource('some_new_oracle');
    recordPtbSource('scheduled_ws');
    flush();
    const last = readLines().pop();
    expect(last.total).toBe(2);
    expect(last.exact).toBe(1);
  });
});
