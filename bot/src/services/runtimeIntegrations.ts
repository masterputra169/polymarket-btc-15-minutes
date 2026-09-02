import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { createLogger } from '../logger.ts';
import { envInt } from '../utils/env.ts';
import { SCHEMA_STATEMENTS } from './postgresSchema.ts';
import type { PgModule, PgPool } from './pgTypes.ts';

const require = createRequire(import.meta.url);
const log = createLogger('Runtime');

const STATUS_CACHE_KEY = process.env.REDIS_STATUS_KEY || 'polymarket-bot:status:last';
const HEALTH_CACHE_KEY = process.env.REDIS_HEALTH_KEY || 'polymarket-bot:runtime:health';
const EVENT_CACHE_KEY = process.env.REDIS_EVENT_KEY || 'polymarket-bot:runtime:last_event';

// Shutdown drain: wait at most this long for in-flight mirror writes before pool.end()
const SHUTDOWN_DRAIN_MS = 3_000;
// Multi-row trade event INSERT chunk size (8 params per row → 800 placeholders max)
const TRADE_EVENT_CHUNK = 100;

let pgPool: PgPool | null = null;
let redisClient: any = null;
let initPromise: Promise<void> | null = null;
let postgresReady = false;
let redisReady = false;

// In-flight mirror/cache writes — drained (bounded) in shutdownRuntimeIntegrations()
// so fire-and-forget `void mirror*(...)` calls don't race pgPool.end() and lose
// the final pre-restart snapshot.
const inFlightWrites = new Set<Promise<unknown>>();

function trackWrite<T>(promise: Promise<T>): Promise<T> {
  inFlightWrites.add(promise);
  void promise
    .finally(() => inFlightWrites.delete(promise))
    .catch(() => { /* settled — errors are handled inside each write impl */ });
  return promise;
}

function envFlag(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw == null) return defaultValue;
  return !['0', 'false', 'no', 'off'].includes(raw.trim().toLowerCase());
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch (_err) {
    return JSON.stringify({ serializationError: true });
  }
}

function parsePnl(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseDateFromMs(value: unknown): Date | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? new Date(n) : null;
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function ensurePostgresSchema(pool: PgPool) {
  for (const statement of SCHEMA_STATEMENTS) {
    await pool.query(statement);
  }
}

async function initPostgres() {
  const databaseUrl = process.env.DATABASE_URL || '';
  if (!databaseUrl) return;

  const maxAttempts = envInt(process.env.POSTGRES_CONNECT_ATTEMPTS, 8, 1, 50);
  const retryMs = envInt(process.env.POSTGRES_CONNECT_RETRY_MS, 2500, 100, 120_000);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { Pool } = require('pg') as PgModule;
      pgPool = new Pool({
        connectionString: databaseUrl,
        max: envInt(process.env.POSTGRES_POOL_MAX, 4, 1, 50),
        connectionTimeoutMillis: envInt(process.env.POSTGRES_CONNECT_TIMEOUT_MS, 5000, 100, 120_000),
        idleTimeoutMillis: envInt(process.env.POSTGRES_IDLE_TIMEOUT_MS, 30_000, 100, 600_000),
        application_name: process.env.POSTGRES_APPLICATION_NAME || 'polymarket-bot',
      });

      await pgPool.query('SELECT 1');
      await ensurePostgresSchema(pgPool);

      postgresReady = true;
      log.info('PostgreSQL integration connected');
      return;
    } catch (err) {
      postgresReady = false;
      if (pgPool) {
        try { await pgPool.end(); } catch { /* ignore */ }
      }
      pgPool = null;

      if (attempt < maxAttempts) {
        log.warn(`PostgreSQL connect attempt ${attempt}/${maxAttempts} failed: ${err.message}`);
        await sleep(retryMs);
      } else {
        log.warn(`PostgreSQL integration disabled: ${err.message}`);
      }
    }
  }
}

async function initRedis() {
  const redisUrl = process.env.REDIS_URL || '';
  if (!redisUrl) return;

  try {
    const { createClient } = require('redis');
    redisClient = createClient({ url: redisUrl });
    redisClient.on('error', (err: Error) => {
      redisReady = false;
      log.warn(`Redis error: ${err.message}`);
    });
    redisClient.on('ready', () => {
      redisReady = true;
    });
    redisClient.on('end', () => {
      redisReady = false;
    });

    await redisClient.connect();
    await redisClient.ping();
    await redisClient.set(HEALTH_CACHE_KEY, safeJson({
      service: 'polymarket-bot',
      status: 'ready',
      startedAt: new Date().toISOString(),
    }), { EX: 86400 });

    redisReady = true;
    log.info('Redis integration connected');
  } catch (err) {
    redisReady = false;
    redisClient = null;
    log.warn(`Redis integration disabled: ${err.message}`);
  }
}

export async function initRuntimeIntegrations() {
  if (!envFlag('RUNTIME_INTEGRATIONS_ENABLED', true)) {
    log.info('Runtime integrations disabled by RUNTIME_INTEGRATIONS_ENABLED=false');
    return;
  }
  if (initPromise) return initPromise;

  initPromise = (async () => {
    await Promise.allSettled([initPostgres(), initRedis()]);
    await recordRuntimeEvent('bot_runtime_integrations_ready', getRuntimeIntegrationStatus());
  })();

  return initPromise;
}

export function getRuntimeIntegrationStatus() {
  return {
    postgres: postgresReady,
    redis: redisReady,
    databaseUrlConfigured: Boolean(process.env.DATABASE_URL),
    redisUrlConfigured: Boolean(process.env.REDIS_URL),
  };
}

export function recordRuntimeEvent(eventType: string, details: Record<string, unknown> = {}): Promise<void> {
  return trackWrite(recordRuntimeEventImpl(eventType, details));
}

async function recordRuntimeEventImpl(eventType: string, details: Record<string, unknown>) {
  const payload = {
    ...details,
    pid: process.pid,
    ts: new Date().toISOString(),
  };

  if (postgresReady && pgPool) {
    try {
      await pgPool.query(
        'INSERT INTO bot_runtime_events (event_type, details) VALUES ($1, $2::jsonb)',
        [eventType, safeJson(payload)],
      );
    } catch (err) {
      postgresReady = false;
      log.warn(`PostgreSQL runtime event write failed: ${err.message}`);
    }
  }

  if (redisReady && redisClient) {
    try {
      await redisClient.set(EVENT_CACHE_KEY, safeJson({ eventType, ...payload }), { EX: 86400 });
    } catch (err) {
      redisReady = false;
      log.warn(`Redis runtime event write failed: ${err.message}`);
    }
  }
}

export function mirrorTradeJournalRecord(record: Record<string, any>): Promise<void> {
  return trackWrite(mirrorTradeJournalRecordImpl(record));
}

async function mirrorTradeJournalRecordImpl(record: Record<string, any>) {
  if (!postgresReady || !pgPool || !record) return;

  const entry = record.entry ?? {};
  const analysis = record.analysis ?? {};
  const recordKey = String(record._ts ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`);

  try {
    await pgPool.query(
      `INSERT INTO trade_journal_records (record_key, market_slug, side, outcome, pnl, raw)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       ON CONFLICT (record_key) DO NOTHING`,
      [
        recordKey,
        entry.marketSlug ?? null,
        entry.side ?? null,
        analysis.outcome ?? null,
        parsePnl(analysis.pnl),
        safeJson(record),
      ],
    );
  } catch (err) {
    postgresReady = false;
    log.warn(`PostgreSQL journal mirror failed: ${err.message}`);
  }
}

export function mirrorVerifiedJournalRecord(record: Record<string, any>): Promise<void> {
  return trackWrite(mirrorVerifiedJournalRecordImpl(record));
}

async function mirrorVerifiedJournalRecordImpl(record: Record<string, any>) {
  if (!postgresReady || !pgPool || !record) return;

  const recordKey = String(record.conditionId || record.marketSlug || record._fetchedAt || `${Date.now()}`);

  try {
    await pgPool.query(
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
        Number.isFinite(Number(record.marketTime)) ? Number(record.marketTime) : null,
        typeof record.resolved === 'boolean' ? record.resolved : null,
        parsePnl(record.netPnl),
        parsePnl(record.localPnl),
        parsePnl(record.discrepancy),
        safeJson(record),
        parseDateFromMs(record._fetchedAt),
      ],
    );
  } catch (err) {
    postgresReady = false;
    log.warn(`PostgreSQL verified journal mirror failed: ${err.message}`);
  }
}

export function mirrorStateSnapshot(snapshot: Record<string, any>, source = 'runtime'): Promise<void> {
  return trackWrite(mirrorStateSnapshotImpl(snapshot, source));
}

async function mirrorStateSnapshotImpl(snapshot: Record<string, any>, source: string) {
  if (!postgresReady || !pgPool || !snapshot) return;

  // randomUUID suffix: same-millisecond snapshots must not collide on the
  // ON CONFLICT (snapshot_key) DO NOTHING key (rows were silently dropped)
  const snapshotKey = `${source}:${Date.now()}:${randomUUID()}`;

  try {
    await pgPool.query(
      `INSERT INTO bot_state_snapshots
        (snapshot_key, source, bankroll, peak_bankroll, total_trades, wins, losses, consecutive_losses, current_position, raw)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb)
       ON CONFLICT (snapshot_key) DO NOTHING`,
      [
        snapshotKey,
        source,
        parsePnl(snapshot.bankroll),
        parsePnl(snapshot.peakBankroll),
        Number.isFinite(Number(snapshot.totalTrades)) ? Number(snapshot.totalTrades) : null,
        Number.isFinite(Number(snapshot.wins)) ? Number(snapshot.wins) : null,
        Number.isFinite(Number(snapshot.losses)) ? Number(snapshot.losses) : null,
        Number.isFinite(Number(snapshot.consecutiveLosses)) ? Number(snapshot.consecutiveLosses) : null,
        safeJson(snapshot.currentPosition ?? null),
        safeJson(snapshot),
      ],
    );

    if (Array.isArray(snapshot.trades)) {
      const events: Array<{ event: Record<string, any>; eventKey: string }> = [];
      for (let i = 0; i < snapshot.trades.length; i++) {
        const event = snapshot.trades[i];
        if (!event || typeof event !== 'object') continue;
        const eventKey = `${source}:${event.timestamp ?? 'no-ts'}:${event.type ?? 'event'}:${event.marketSlug ?? ''}:${i}`;
        events.push({ event, eventKey });
      }
      // Single multi-row INSERT (chunked) — the previous per-row loop issued up
      // to 100 sequential queries per saveState() on a max-4-connection pool.
      await mirrorStateTradeEventsBatch(events);
    }
  } catch (err) {
    postgresReady = false;
    log.warn(`PostgreSQL state snapshot mirror failed: ${err.message}`);
  }
}

const TRADE_EVENT_UPSERT_SUFFIX = `
       ON CONFLICT (event_key) DO UPDATE SET
         event_type = EXCLUDED.event_type,
         side = EXCLUDED.side,
         market_slug = EXCLUDED.market_slug,
         pnl = EXCLUDED.pnl,
         bankroll_after = EXCLUDED.bankroll_after,
         raw = EXCLUDED.raw,
         happened_at = EXCLUDED.happened_at`;

function tradeEventParams(event: Record<string, any>, eventKey: string): unknown[] {
  return [
    eventKey,
    event.type ?? null,
    event.side ?? null,
    event.marketSlug ?? null,
    parsePnl(event.pnl),
    parsePnl(event.bankrollAfter),
    safeJson(event),
    parseDateFromMs(event.timestamp),
  ];
}

async function mirrorStateTradeEventsBatch(events: Array<{ event: Record<string, any>; eventKey: string }>) {
  if (!postgresReady || !pgPool || events.length === 0) return;

  for (let start = 0; start < events.length; start += TRADE_EVENT_CHUNK) {
    const chunk = events.slice(start, start + TRADE_EVENT_CHUNK);
    const valueTuples: string[] = [];
    const params: unknown[] = [];
    for (let i = 0; i < chunk.length; i++) {
      const base = i * 8;
      valueTuples.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}::jsonb, $${base + 8})`);
      params.push(...tradeEventParams(chunk[i].event, chunk[i].eventKey));
    }
    await pgPool.query(
      `INSERT INTO bot_trade_events
        (event_key, event_type, side, market_slug, pnl, bankroll_after, raw, happened_at)
       VALUES ${valueTuples.join(', ')}${TRADE_EVENT_UPSERT_SUFFIX}`,
      params,
    );
  }
}

export function mirrorStateTradeEvent(event: Record<string, any>, eventKey: string): Promise<void> {
  return trackWrite(mirrorStateTradeEventImpl(event, eventKey));
}

async function mirrorStateTradeEventImpl(event: Record<string, any>, eventKey: string) {
  if (!postgresReady || !pgPool || !event) return;

  try {
    await pgPool.query(
      `INSERT INTO bot_trade_events
        (event_key, event_type, side, market_slug, pnl, bankroll_after, raw, happened_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)${TRADE_EVENT_UPSERT_SUFFIX}`,
      tradeEventParams(event, eventKey),
    );
  } catch (err) {
    postgresReady = false;
    log.warn(`PostgreSQL state trade event mirror failed: ${err.message}`);
  }
}

export function mirrorPositionsSnapshot(snapshot: Record<string, any>, source = 'runtime'): Promise<void> {
  return trackWrite(mirrorPositionsSnapshotImpl(snapshot, source));
}

async function mirrorPositionsSnapshotImpl(snapshot: Record<string, any>, source: string) {
  if (!postgresReady || !pgPool || !snapshot) return;

  const snapshotKey = `${source}:${Date.now()}:${randomUUID()}`;
  const positions = Array.isArray(snapshot.positions) ? snapshot.positions : [];

  try {
    await pgPool.query(
      `INSERT INTO bot_position_snapshots
        (snapshot_key, source, last_update_ms, positions_count, raw)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (snapshot_key) DO NOTHING`,
      [
        snapshotKey,
        source,
        Number.isFinite(Number(snapshot.lastUpdate)) ? Number(snapshot.lastUpdate) : null,
        positions.length,
        safeJson(snapshot),
      ],
    );
  } catch (err) {
    postgresReady = false;
    log.warn(`PostgreSQL positions snapshot mirror failed: ${err.message}`);
  }
}

export function mirrorSignalPerfSnapshot(snapshot: Record<string, any>, source = 'runtime'): Promise<void> {
  return trackWrite(mirrorSignalPerfSnapshotImpl(snapshot, source));
}

async function mirrorSignalPerfSnapshotImpl(snapshot: Record<string, any>, source: string) {
  if (!postgresReady || !pgPool || !snapshot) return;

  const snapshotKey = `${source}:${Date.now()}:${randomUUID()}`;
  const signalsCount = Object.keys(snapshot.signals ?? {}).length;

  try {
    await pgPool.query(
      `INSERT INTO bot_signal_perf_snapshots
        (snapshot_key, source, version, updated_at_ms, signals_count, raw)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       ON CONFLICT (snapshot_key) DO NOTHING`,
      [
        snapshotKey,
        source,
        Number.isFinite(Number(snapshot.version)) ? Number(snapshot.version) : null,
        Number.isFinite(Number(snapshot.updatedAt)) ? Number(snapshot.updatedAt) : null,
        signalsCount,
        safeJson(snapshot),
      ],
    );
  } catch (err) {
    postgresReady = false;
    log.warn(`PostgreSQL signal perf snapshot mirror failed: ${err.message}`);
  }
}

export function cacheStatusSnapshot(snapshot: Record<string, any>): Promise<void> {
  return trackWrite(cacheStatusSnapshotImpl(snapshot));
}

async function cacheStatusSnapshotImpl(snapshot: Record<string, any>) {
  if (!redisReady || !redisClient || !snapshot) return;

  try {
    await redisClient.set(STATUS_CACHE_KEY, safeJson({
      cachedAt: new Date().toISOString(),
      snapshot,
    }), { EX: envInt(process.env.REDIS_STATUS_TTL_SEC, 120, 5, 86_400) });
  } catch (err) {
    redisReady = false;
    log.warn(`Redis status cache write failed: ${err.message}`);
  }
}

export async function shutdownRuntimeIntegrations() {
  await recordRuntimeEvent('bot_shutdown', getRuntimeIntegrationStatus());

  // Drain in-flight fire-and-forget mirror writes before closing connections.
  // Without this, `void mirror*(...)` calls race pgPool.end() — the "pool after
  // end" error was swallowed and the final pre-restart snapshot silently lost.
  // Bounded by SHUTDOWN_DRAIN_MS so shutdown can never hang.
  const pending = [...inFlightWrites];
  if (pending.length > 0) {
    await Promise.race([Promise.allSettled(pending), sleep(SHUTDOWN_DRAIN_MS)]);
  }

  if (redisClient) {
    try {
      await redisClient.quit();
    } catch (_err) {
      try { redisClient.disconnect(); } catch { /* ignore */ }
    }
  }
  redisClient = null;
  redisReady = false;

  if (pgPool) {
    try {
      await pgPool.end();
    } catch (_err) { /* ignore */ }
  }
  pgPool = null;
  postgresReady = false;
  initPromise = null;
}
