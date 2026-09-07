/**
 * The bot's own Postgres bootstrap must create everything the report API reads.
 *
 * Measured on the first Railway deploy (2026-09-07): /api/reports returned
 * internal_error, bot log "relation v_latest_bot_state does not exist". The
 * compose stack got its views from docker/postgres/init/002_analytics_views.sql
 * via docker-entrypoint-initdb.d; a managed Postgres has no such hook, and the
 * bot's SCHEMA_STATEMENTS only covered the tables.
 *
 * Contract: every v_* relation named in postgresReports.ts is created by the
 * SQL the bot runs at startup (tables + the init files it ships with).
 */

import { describe, test, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { SCHEMA_STATEMENTS, loadInitSql } from '../postgresSchema.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('postgres bootstrap covers the report views', () => {
  test('every view the report API queries is created at startup', () => {
    const reportSrc = readFileSync(resolve(__dirname, '..', 'postgresReports.ts'), 'utf-8');
    const wanted = [...new Set(reportSrc.match(/\bv_[a-z_]+\b/g) ?? [])].sort();
    expect(wanted.length).toBeGreaterThan(0);

    const bootstrap = [...SCHEMA_STATEMENTS, ...loadInitSql()].join('\n');
    const created = new Set([...bootstrap.matchAll(/CREATE OR REPLACE VIEW\s+([a-z_]+)/g)].map(m => m[1]));
    const missing = wanted.filter(v => !created.has(v));
    expect(missing).toEqual([]);
  });

  test('init SQL is idempotent so it can run on every start', () => {
    const sql = loadInitSql().join('\n');
    const creates = sql.match(/^CREATE\b[^\n]*/gm) ?? [];
    expect(creates.length).toBeGreaterThan(0);
    const nonIdempotent = creates.filter(l => !/IF NOT EXISTS|OR REPLACE/.test(l));
    expect(nonIdempotent).toEqual([]);
  });
});
