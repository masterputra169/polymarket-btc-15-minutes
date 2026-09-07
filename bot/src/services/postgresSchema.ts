/**
 * Canonical PostgreSQL schema for the bot's runtime mirror tables.
 * Imported by runtimeIntegrations.ts (bot startup) and
 * bot/scripts/backfillPostgres.mts (one-shot backfill).
 *
 * Canonical schema. Keep docker/postgres/init/001_runtime_schema.sql in sync.
 */

import { readdirSync, readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * docker/postgres/init/*.sql, in order. On compose these run once through
 * docker-entrypoint-initdb.d; a managed Postgres (Railway) has no such hook,
 * so the bot runs them itself at startup. Every statement in them is
 * idempotent (IF NOT EXISTS / OR REPLACE — enforced by a test), so repeating
 * them on each start is cheap and safe. Dockerfile.bot ships the directory;
 * an absent directory (unusual layout) yields [] and the tables below still
 * get created — only the analytics views for the report API would be missing.
 */
export const INIT_SQL_DIR = resolve(__dirname, '..', '..', '..', 'docker', 'postgres', 'init');

export function loadInitSql(dir: string = INIT_SQL_DIR): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.toLowerCase().endsWith('.sql'))
    .sort()
    .map(f => readFileSync(resolve(dir, f), 'utf-8'));
}

export const SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS bot_runtime_events (
    id BIGSERIAL PRIMARY KEY,
    event_type TEXT NOT NULL,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,

  `CREATE TABLE IF NOT EXISTS trade_journal_records (
    id BIGSERIAL PRIMARY KEY,
    record_key TEXT NOT NULL UNIQUE,
    market_slug TEXT,
    side TEXT,
    outcome TEXT,
    pnl NUMERIC,
    raw JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,

  `CREATE TABLE IF NOT EXISTS verified_journal_records (
    id BIGSERIAL PRIMARY KEY,
    record_key TEXT NOT NULL UNIQUE,
    market_slug TEXT,
    condition_id TEXT,
    market_time_ms BIGINT,
    resolved BOOLEAN,
    net_pnl NUMERIC,
    local_pnl NUMERIC,
    discrepancy NUMERIC,
    raw JSONB NOT NULL,
    fetched_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,

  `CREATE TABLE IF NOT EXISTS bot_state_snapshots (
    id BIGSERIAL PRIMARY KEY,
    snapshot_key TEXT NOT NULL UNIQUE,
    source TEXT NOT NULL,
    bankroll NUMERIC,
    peak_bankroll NUMERIC,
    total_trades INTEGER,
    wins INTEGER,
    losses INTEGER,
    consecutive_losses INTEGER,
    current_position JSONB,
    raw JSONB NOT NULL,
    captured_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,

  `CREATE TABLE IF NOT EXISTS bot_trade_events (
    id BIGSERIAL PRIMARY KEY,
    event_key TEXT NOT NULL UNIQUE,
    event_type TEXT,
    side TEXT,
    market_slug TEXT,
    pnl NUMERIC,
    bankroll_after NUMERIC,
    raw JSONB NOT NULL,
    happened_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,

  `CREATE TABLE IF NOT EXISTS bot_position_snapshots (
    id BIGSERIAL PRIMARY KEY,
    snapshot_key TEXT NOT NULL UNIQUE,
    source TEXT NOT NULL,
    last_update_ms BIGINT,
    positions_count INTEGER,
    raw JSONB NOT NULL,
    captured_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,

  `CREATE TABLE IF NOT EXISTS bot_signal_perf_snapshots (
    id BIGSERIAL PRIMARY KEY,
    snapshot_key TEXT NOT NULL UNIQUE,
    source TEXT NOT NULL,
    version INTEGER,
    updated_at_ms BIGINT,
    signals_count INTEGER,
    raw JSONB NOT NULL,
    captured_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,

  `CREATE INDEX IF NOT EXISTS idx_bot_runtime_events_type_created
    ON bot_runtime_events (event_type, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_trade_journal_records_market
    ON trade_journal_records (market_slug, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_trade_journal_records_raw_gin
    ON trade_journal_records USING GIN (raw)`,
  `CREATE INDEX IF NOT EXISTS idx_verified_journal_records_market
    ON verified_journal_records (market_slug, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_verified_journal_records_condition
    ON verified_journal_records (condition_id)`,
  `CREATE INDEX IF NOT EXISTS idx_bot_state_snapshots_captured
    ON bot_state_snapshots (captured_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_bot_trade_events_happened
    ON bot_trade_events (happened_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_bot_trade_events_market
    ON bot_trade_events (market_slug, happened_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_bot_position_snapshots_captured
    ON bot_position_snapshots (captured_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_bot_signal_perf_snapshots_captured
    ON bot_signal_perf_snapshots (captured_at DESC)`,
];
