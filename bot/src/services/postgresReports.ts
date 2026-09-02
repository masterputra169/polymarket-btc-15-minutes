import type { PgPool } from './pgTypes.ts';

export type ReportOptions = {
  days?: number;
  limit?: number;
};

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

export function normalizeReportOptions(options: ReportOptions = {}) {
  return {
    days: clampInt(options.days, 30, 1, 365),
    limit: clampInt(options.limit, 50, 1, 500),
  };
}

export async function buildPostgresReport(pool: PgPool, options: ReportOptions = {}) {
  const { days, limit } = normalizeReportOptions(options);

  const [
    counts,
    latestState,
    dailyPnl,
    outcomeSummary,
    sideSummary,
    executionSummary,
    phaseSummary,
    discrepancySummary,
    recentTrades,
    topDiscrepancies,
  ] = await Promise.all([
    pool.query(`
      SELECT 'trade_journal_records' AS table_name, count(*)::int AS records FROM trade_journal_records
      UNION ALL SELECT 'verified_journal_records', count(*)::int FROM verified_journal_records
      UNION ALL SELECT 'bot_trade_events', count(*)::int FROM bot_trade_events
      UNION ALL SELECT 'bot_state_snapshots', count(*)::int FROM bot_state_snapshots
      UNION ALL SELECT 'bot_position_snapshots', count(*)::int FROM bot_position_snapshots
      UNION ALL SELECT 'bot_signal_perf_snapshots', count(*)::int FROM bot_signal_perf_snapshots
      ORDER BY table_name
    `),
    pool.query('SELECT * FROM v_latest_bot_state'),
    pool.query(
      `SELECT *
       FROM v_trade_daily_pnl
       WHERE trade_day >= ((now() AT TIME ZONE 'Asia/Jakarta')::date - ($1::int - 1))
       ORDER BY trade_day DESC`,
      [days],
    ),
    pool.query('SELECT * FROM v_trade_outcome_summary'),
    pool.query('SELECT * FROM v_trade_side_summary'),
    pool.query('SELECT * FROM v_trade_execution_summary'),
    pool.query('SELECT * FROM v_trade_phase_summary'),
    pool.query('SELECT * FROM v_verified_discrepancy_summary'),
    pool.query(
      `SELECT record_key, market_slug, side, outcome, pnl, execution_type, phase, exited_at
       FROM v_trade_journal_enriched
       WHERE outcome <> 'DRY_RUN'
       ORDER BY exited_at DESC
       LIMIT $1`,
      [limit],
    ),
    pool.query(
      `SELECT record_key, market_slug, condition_id, resolved, net_pnl, local_pnl, discrepancy, fetched_at
       FROM verified_journal_records
       WHERE discrepancy IS NOT NULL
       ORDER BY abs(discrepancy) DESC NULLS LAST, fetched_at DESC NULLS LAST
       LIMIT $1`,
      [limit],
    ),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    window: { days, limit },
    counts: counts.rows,
    latestState: latestState.rows[0] ?? null,
    dailyPnl: dailyPnl.rows,
    outcomeSummary: outcomeSummary.rows,
    sideSummary: sideSummary.rows,
    executionSummary: executionSummary.rows,
    phaseSummary: phaseSummary.rows,
    discrepancySummary: discrepancySummary.rows[0] ?? null,
    recentTrades: recentTrades.rows,
    topDiscrepancies: topDiscrepancies.rows,
  };
}
