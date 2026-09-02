/**
 * Canonical PostgreSQL schema for the bot's runtime mirror tables.
 * Imported by runtimeIntegrations.ts (bot startup) and
 * bot/scripts/backfillPostgres.mts (one-shot backfill).
 *
 * Canonical schema. Keep docker/postgres/init/001_runtime_schema.sql in sync.
 */

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
