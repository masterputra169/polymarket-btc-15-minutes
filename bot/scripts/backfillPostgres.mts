import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as dotenvConfig } from 'dotenv';
import { SCHEMA_STATEMENTS } from '../src/services/postgresSchema.ts';
import type { PgModule, PgPool } from '../src/services/pgTypes.ts';

const require = createRequire(import.meta.url);
const { Pool } = require('pg') as PgModule;

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: resolve(__dirname, '..', '.env') });

const DATA_DIR = process.env.BOT_DATA_DIR || resolve(__dirname, '..', 'data');
const DATABASE_URL = process.env.DATABASE_URL || '';

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch (_err) {
    return JSON.stringify({ serializationError: true });
  }
}

function hashRecord(value: unknown): string {
  return createHash('sha256').update(safeJson(value)).digest('hex').slice(0, 24);
}

function numberOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function dateFromMs(value: unknown): Date | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? new Date(n) : null;
}

function readJson(fileName: string): any | null {
  const filePath = resolve(DATA_DIR, fileName);
  if (!existsSync(filePath)) return null;
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

function readJsonLines(fileName: string): any[] {
  const filePath = resolve(DATA_DIR, fileName);
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf-8')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (err) {
        console.warn(`Skipping invalid JSONL line ${fileName}:${index + 1}: ${err.message}`);
        return null;
      }
    })
    .filter(Boolean);
}

function fileMtimeMs(fileName: string): number {
  const filePath = resolve(DATA_DIR, fileName);
  if (!existsSync(filePath)) return Date.now();
  return Math.round(statSync(filePath).mtimeMs);
}

async function ensureSchema(pool: PgPool) {
  // Canonical DDL lives in bot/src/services/postgresSchema.ts (shared with
  // runtimeIntegrations.ts). Keep docker/postgres/init/001_runtime_schema.sql in sync.
  for (const statement of SCHEMA_STATEMENTS) {
    await pool.query(statement);
  }
}

async function importTradeJournal(pool: PgPool) {
  const records = readJsonLines('trade_journal.jsonl');
  let imported = 0;

  for (const record of records) {
    const entry = record.entry ?? {};
    const analysis = record.analysis ?? {};
    const recordKey = String(record._ts ?? hashRecord(record));
    await pool.query(
      `INSERT INTO trade_journal_records (record_key, market_slug, side, outcome, pnl, raw)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       ON CONFLICT (record_key) DO UPDATE SET
         market_slug = EXCLUDED.market_slug,
         side = EXCLUDED.side,
         outcome = EXCLUDED.outcome,
         pnl = EXCLUDED.pnl,
         raw = EXCLUDED.raw`,
      [
        recordKey,
        entry.marketSlug ?? null,
        entry.side ?? null,
        analysis.outcome ?? null,
        numberOrNull(analysis.pnl),
        safeJson(record),
      ],
    );
    imported++;
  }

  return imported;
}

async function importVerifiedJournal(pool: PgPool) {
  const records = readJsonLines('verified_journal.jsonl');
  let imported = 0;

  for (const record of records) {
    const recordKey = String(record.conditionId || record.marketSlug || hashRecord(record));
    await pool.query(
      `INSERT INTO verified_journal_records
        (record_key, market_slug, condition_id, market_time_ms, resolved, net_pnl, local_pnl, discrepancy, raw, fetched_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
       ON CONFLICT (record_key) DO UPDATE SET
         market_slug = EXCLUDED.market_slug,
         condition_id = EXCLUDED.condition_id,
         market_time_ms = EXCLUDED.market_time_ms,
         resolved = EXCLUDED.resolved,
         net_pnl = EXCLUDED.net_pnl,
         local_pnl = EXCLUDED.local_pnl,
         discrepancy = EXCLUDED.discrepancy,
         raw = EXCLUDED.raw,
         fetched_at = EXCLUDED.fetched_at,
         updated_at = now()`,
      [
        recordKey,
        record.marketSlug ?? null,
        record.conditionId ?? null,
        numberOrNull(record.marketTime),
        typeof record.resolved === 'boolean' ? record.resolved : null,
        numberOrNull(record.netPnl),
        numberOrNull(record.localPnl),
        numberOrNull(record.discrepancy),
        safeJson(record),
        dateFromMs(record._fetchedAt),
      ],
    );
    imported++;
  }

  return imported;
}

async function importState(pool: PgPool) {
  const state = readJson('state.json');
  if (!state) return { snapshots: 0, events: 0 };

  const snapshotKey = `backfill:state:${fileMtimeMs('state.json')}`;
  await pool.query(
    `INSERT INTO bot_state_snapshots
      (snapshot_key, source, bankroll, peak_bankroll, total_trades, wins, losses, consecutive_losses, current_position, raw)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb)
     ON CONFLICT (snapshot_key) DO UPDATE SET
       bankroll = EXCLUDED.bankroll,
       peak_bankroll = EXCLUDED.peak_bankroll,
       total_trades = EXCLUDED.total_trades,
       wins = EXCLUDED.wins,
       losses = EXCLUDED.losses,
       consecutive_losses = EXCLUDED.consecutive_losses,
       current_position = EXCLUDED.current_position,
       raw = EXCLUDED.raw`,
    [
      snapshotKey,
      'backfill_state',
      numberOrNull(state.bankroll),
      numberOrNull(state.peakBankroll),
      numberOrNull(state.totalTrades),
      numberOrNull(state.wins),
      numberOrNull(state.losses),
      numberOrNull(state.consecutiveLosses),
      safeJson(state.currentPosition ?? null),
      safeJson(state),
    ],
  );

  let events = 0;
  if (Array.isArray(state.trades)) {
    for (let i = 0; i < state.trades.length; i++) {
      const event = state.trades[i];
      const eventKey = `state:${event.timestamp ?? 'no-ts'}:${event.type ?? 'event'}:${event.marketSlug ?? ''}:${i}`;
      await pool.query(
        `INSERT INTO bot_trade_events
          (event_key, event_type, side, market_slug, pnl, bankroll_after, raw, happened_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
         ON CONFLICT (event_key) DO UPDATE SET
           event_type = EXCLUDED.event_type,
           side = EXCLUDED.side,
           market_slug = EXCLUDED.market_slug,
           pnl = EXCLUDED.pnl,
           bankroll_after = EXCLUDED.bankroll_after,
           raw = EXCLUDED.raw,
           happened_at = EXCLUDED.happened_at`,
        [
          eventKey,
          event.type ?? null,
          event.side ?? null,
          event.marketSlug ?? null,
          numberOrNull(event.pnl),
          numberOrNull(event.bankrollAfter),
          safeJson(event),
          dateFromMs(event.timestamp),
        ],
      );
      events++;
    }
  }

  return { snapshots: 1, events };
}

async function importPositions(pool: PgPool) {
  const snapshot = readJson('positions.json');
  if (!snapshot) return 0;

  const snapshotKey = `backfill:positions:${fileMtimeMs('positions.json')}`;
  const positions = Array.isArray(snapshot.positions) ? snapshot.positions : [];
  await pool.query(
    `INSERT INTO bot_position_snapshots
      (snapshot_key, source, last_update_ms, positions_count, raw)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (snapshot_key) DO UPDATE SET
       last_update_ms = EXCLUDED.last_update_ms,
       positions_count = EXCLUDED.positions_count,
       raw = EXCLUDED.raw`,
    [
      snapshotKey,
      'backfill_positions',
      numberOrNull(snapshot.lastUpdate),
      positions.length,
      safeJson(snapshot),
    ],
  );

  return 1;
}

async function importSignalPerf(pool: PgPool) {
  const snapshot = readJson('signal_perf.json');
  if (!snapshot) return 0;

  const snapshotKey = `backfill:signal_perf:${fileMtimeMs('signal_perf.json')}`;
  const signalsCount = Object.keys(snapshot.signals ?? {}).length;
  await pool.query(
    `INSERT INTO bot_signal_perf_snapshots
      (snapshot_key, source, version, updated_at_ms, signals_count, raw)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (snapshot_key) DO UPDATE SET
       version = EXCLUDED.version,
       updated_at_ms = EXCLUDED.updated_at_ms,
       signals_count = EXCLUDED.signals_count,
       raw = EXCLUDED.raw`,
    [
      snapshotKey,
      'backfill_signal_perf',
      numberOrNull(snapshot.version),
      numberOrNull(snapshot.updatedAt),
      signalsCount,
      safeJson(snapshot),
    ],
  );

  return 1;
}

async function main() {
  if (!DATABASE_URL) {
    console.error('DATABASE_URL is required. Run this inside the bot Compose service or set DATABASE_URL explicitly.');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: DATABASE_URL,
    max: 2,
    connectionTimeoutMillis: 10000,
    application_name: 'polymarket-bot-backfill',
  });

  try {
    await ensureSchema(pool);
    const state = await importState(pool);
    const positions = await importPositions(pool);
    const signalPerf = await importSignalPerf(pool);
    const tradeJournal = await importTradeJournal(pool);
    const verifiedJournal = await importVerifiedJournal(pool);

    console.log(JSON.stringify({
      dataDir: DATA_DIR,
      imported: {
        stateSnapshots: state.snapshots,
        stateTradeEvents: state.events,
        positionSnapshots: positions,
        signalPerfSnapshots: signalPerf,
        tradeJournalRecords: tradeJournal,
        verifiedJournalRecords: verifiedJournal,
      },
    }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
