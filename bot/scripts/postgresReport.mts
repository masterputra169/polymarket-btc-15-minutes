import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as dotenvConfig } from 'dotenv';
import { buildPostgresReport, normalizeReportOptions } from '../src/services/postgresReports.ts';

const require = createRequire(import.meta.url);
const { Pool } = require('pg');

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: resolve(__dirname, '..', '.env') });

function argValue(name: string, fallback = '') {
  const prefix = `--${name}=`;
  const direct = process.argv.find(a => a.startsWith(prefix));
  if (direct) return direct.slice(prefix.length);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

function printRows(title: string, rows: any[]) {
  console.log(`\n${title}`);
  if (!rows.length) {
    console.log('(no rows)');
    return;
  }
  console.table(rows);
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL || '';
  if (!databaseUrl) {
    console.error('DATABASE_URL is required. Run inside Compose bot service or set DATABASE_URL.');
    process.exit(1);
  }

  const options = normalizeReportOptions({
    days: Number(argValue('days', '30')),
    limit: Number(argValue('limit', '20')),
  });
  const json = process.argv.includes('--json');

  const pool = new Pool({
    connectionString: databaseUrl,
    max: 2,
    connectionTimeoutMillis: 10000,
    application_name: 'polymarket-postgres-report',
  });

  try {
    const report = await buildPostgresReport(pool, options);
    if (json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    console.log(`PostgreSQL Report (${report.generatedAt})`);
    console.log(`Window: ${report.window.days} days`);
    printRows('Table Counts', report.counts);
    printRows('Outcome Summary', report.outcomeSummary);
    printRows('Side Summary', report.sideSummary);
    printRows('Execution Summary', report.executionSummary);
    printRows('Phase Summary', report.phaseSummary);
    printRows('Daily PnL', report.dailyPnl);
    printRows('Verified Discrepancy Summary', report.discrepancySummary ? [report.discrepancySummary] : []);
    printRows('Recent Real Trades', report.recentTrades);
    printRows('Top Verified Discrepancies', report.topDiscrepancies);
  } finally {
    await pool.end();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
