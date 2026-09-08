/**
 * Source contract: a corrected journal row must overwrite its Postgres mirror.
 *
 * The mirror keyed on record_key with ON CONFLICT DO NOTHING, so once a row was
 * mirrored, a later correction (fallback verifier) could never reach the
 * dashboard's report API. The insert has to upsert outcome, pnl and raw.
 */
import { test, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

test('trade_journal_records mirror upserts outcome/pnl/raw on record_key conflict', () => {
  const src = readFileSync(resolve(__dirname, '..', 'runtimeIntegrations.ts'), 'utf-8');
  const start = src.indexOf('INSERT INTO trade_journal_records');
  expect(start).toBeGreaterThan(-1);
  const backtick = String.fromCharCode(96);
  const insert = src.slice(start);
  const clause = insert.slice(0, insert.indexOf(backtick));
  expect(clause).toMatch(/ON CONFLICT \(record_key\) DO UPDATE SET/);
  for (const col of ['outcome', 'pnl', 'raw']) {
    expect(clause).toMatch(new RegExp(`${col}\\s*=\\s*EXCLUDED\\.${col}`));
  }
});
