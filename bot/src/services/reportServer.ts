import { createRequire } from 'node:module';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { createLogger } from '../logger.ts';
import { envInt } from '../utils/env.ts';
import { isLocalBindHost } from '../utils/net.ts';
import { buildPostgresReport, normalizeReportOptions } from './postgresReports.ts';
import type { PgModule, PgPool } from './pgTypes.ts';

const require = createRequire(import.meta.url);
const log = createLogger('ReportAPI');

let server: Server | null = null;
let pool: PgPool | null = null;

function envFlag(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw == null) return defaultValue;
  return !['0', 'false', 'no', 'off'].includes(raw.trim().toLowerCase());
}

function writeJson(res: ServerResponse, status: number, payload: unknown) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

// Constant-time token comparison — same pattern as statusServer tokenMatches()
function tokenMatches(candidate: string): boolean {
  const token = (process.env.REPORT_AUTH_TOKEN || '').trim();
  if (!token || !candidate) return false;
  const expected = Buffer.from(token);
  const actual = Buffer.from(candidate);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function isAuthorized(req: IncomingMessage, url: URL) {
  const token = (process.env.REPORT_AUTH_TOKEN || '').trim();
  if (!token) return true;

  const header = String(req.headers.authorization || '');
  const bearer = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  return tokenMatches(bearer) || tokenMatches(url.searchParams.get('token') || '');
}

function parseOptions(url: URL) {
  return normalizeReportOptions({
    days: Number(url.searchParams.get('days') || 30),
    limit: Number(url.searchParams.get('limit') || 50),
  });
}

export function startReportServer() {
  if (server) return;
  if (!envFlag('REPORT_SERVER_ENABLED', true)) {
    log.info('Report API disabled by REPORT_SERVER_ENABLED=false');
    return;
  }

  const databaseUrl = process.env.DATABASE_URL || '';
  if (!databaseUrl) {
    log.info('Report API dormant (DATABASE_URL not set)');
    return;
  }

  const bindHost = (process.env.REPORT_BIND_HOST || '127.0.0.1').trim();
  const port = envInt(process.env.REPORT_PORT, 3101, 1, 65_535);
  const authToken = (process.env.REPORT_AUTH_TOKEN || '').trim();

  // Fail closed: an off-host bind without a token exposes trading P&L data.
  // The report API is an optional analytics sidecar — refuse to start it
  // rather than killing the bot. Loopback binds without a token still work.
  if (!authToken && !isLocalBindHost(bindHost)) {
    log.error(`Report API refuses to bind ${bindHost}:${port} without auth: set REPORT_AUTH_TOKEN or bind to 127.0.0.1. Report server NOT started.`);
    return;
  }

  const { Pool } = require('pg') as PgModule;
  pool = new Pool({
    connectionString: databaseUrl,
    max: envInt(process.env.REPORT_POSTGRES_POOL_MAX, 2, 1, 50),
    connectionTimeoutMillis: envInt(process.env.REPORT_POSTGRES_CONNECT_TIMEOUT_MS, 5000, 100, 120_000),
    idleTimeoutMillis: envInt(process.env.REPORT_POSTGRES_IDLE_TIMEOUT_MS, 30_000, 100, 600_000),
    application_name: process.env.REPORT_POSTGRES_APPLICATION_NAME || 'polymarket-report-api',
  });

  server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || `${bindHost}:${port}`}`);

      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        });
        res.end();
        return;
      }

      if (req.method !== 'GET') {
        writeJson(res, 405, { ok: false, error: 'method_not_allowed' });
        return;
      }

      if (!isAuthorized(req, url)) {
        writeJson(res, 401, { ok: false, error: 'unauthorized' });
        return;
      }

      if (url.pathname === '/health') {
        await pool.query('SELECT 1');
        writeJson(res, 200, { ok: true, service: 'report-api', ts: new Date().toISOString() });
        return;
      }

      if (url.pathname === '/reports' || url.pathname === '/reports/summary') {
        writeJson(res, 200, { ok: true, data: await buildPostgresReport(pool, parseOptions(url)) });
        return;
      }

      writeJson(res, 404, { ok: false, error: 'not_found' });
    } catch (err) {
      // Full detail stays server-side — never leak err.message to clients
      log.warn(`Report request failed: ${err.message}`);
      writeJson(res, 500, { ok: false, error: 'internal_error' });
    }
  });

  server.on('error', (err) => {
    log.warn(`Report API error: ${err.message}`);
  });

  server.listen(port, bindHost, () => {
    log.info(`Report API listening on ${bindHost}:${port}${authToken ? ' (auth required)' : ''}`);
  });
}

export async function stopReportServer() {
  const closeServer = server
    ? new Promise<void>((resolve) => server.close(() => resolve()))
    : Promise.resolve();
  server = null;

  await closeServer;
  if (pool) {
    try { await pool.end(); } catch { /* ignore */ }
    pool = null;
  }
}
