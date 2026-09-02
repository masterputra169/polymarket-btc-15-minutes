CREATE OR REPLACE VIEW v_trade_journal_enriched AS
SELECT
  record_key,
  market_slug,
  side,
  outcome,
  pnl,
  NULLIF(raw->'entry'->>'confidence', '') AS execution_type,
  NULLIF(raw->'entry'->>'phase', '') AS phase,
  NULLIF(raw->'entry'->>'reason', '') AS entry_reason,
  CASE
    WHEN raw->'entry'->>'enteredAt' ~ '^[0-9]+(\.[0-9]+)?$'
      THEN to_timestamp((raw->'entry'->>'enteredAt')::double precision / 1000.0)
    ELSE NULL
  END AS entered_at,
  CASE
    WHEN raw->'exit'->>'exitedAt' ~ '^[0-9]+(\.[0-9]+)?$'
      THEN to_timestamp((raw->'exit'->>'exitedAt')::double precision / 1000.0)
    ELSE created_at
  END AS exited_at,
  CASE
    WHEN raw->'entry'->>'btcPrice' ~ '^-?[0-9]+(\.[0-9]+)?$'
      THEN (raw->'entry'->>'btcPrice')::numeric
    ELSE NULL
  END AS btc_entry,
  CASE
    WHEN raw->'exit'->>'btcPrice' ~ '^-?[0-9]+(\.[0-9]+)?$'
      THEN (raw->'exit'->>'btcPrice')::numeric
    ELSE NULL
  END AS btc_exit,
  CASE
    WHEN raw->'analysis'->>'holdDurationSec' ~ '^-?[0-9]+(\.[0-9]+)?$'
      THEN (raw->'analysis'->>'holdDurationSec')::numeric
    ELSE NULL
  END AS hold_duration_sec,
  raw
FROM trade_journal_records;

CREATE OR REPLACE VIEW v_trade_daily_pnl AS
SELECT
  (exited_at AT TIME ZONE 'Asia/Jakarta')::date AS trade_day,
  count(*) AS total_records,
  count(*) FILTER (WHERE outcome <> 'DRY_RUN') AS real_trades,
  count(*) FILTER (WHERE outcome = 'DRY_RUN') AS dry_run_records,
  count(*) FILTER (WHERE outcome = 'WIN') AS wins,
  count(*) FILTER (WHERE outcome = 'LOSS') AS losses,
  count(*) FILTER (WHERE outcome = 'CUT_LOSS') AS cut_losses,
  round(coalesce(sum(pnl) FILTER (WHERE outcome <> 'DRY_RUN'), 0), 2) AS real_pnl,
  round(coalesce(sum(pnl), 0), 2) AS total_pnl,
  round(
    (count(*) FILTER (WHERE outcome = 'WIN'))::numeric
    / nullif((count(*) FILTER (WHERE outcome IN ('WIN', 'LOSS', 'CUT_LOSS', 'PARTIAL_CUT'))), 0),
    4
  ) AS win_rate
FROM v_trade_journal_enriched
GROUP BY 1
ORDER BY 1 DESC;

CREATE OR REPLACE VIEW v_trade_outcome_summary AS
SELECT
  outcome,
  count(*) AS records,
  round(coalesce(sum(pnl), 0), 2) AS pnl_sum,
  round(coalesce(avg(pnl), 0), 4) AS pnl_avg,
  round(coalesce(min(pnl), 0), 2) AS pnl_min,
  round(coalesce(max(pnl), 0), 2) AS pnl_max
FROM v_trade_journal_enriched
GROUP BY outcome
ORDER BY records DESC;

CREATE OR REPLACE VIEW v_trade_side_summary AS
SELECT
  coalesce(side, 'UNKNOWN') AS side,
  count(*) FILTER (WHERE outcome <> 'DRY_RUN') AS real_trades,
  count(*) FILTER (WHERE outcome = 'WIN') AS wins,
  count(*) FILTER (WHERE outcome IN ('LOSS', 'CUT_LOSS')) AS losses,
  round(coalesce(sum(pnl) FILTER (WHERE outcome <> 'DRY_RUN'), 0), 2) AS pnl_sum,
  round(
    (count(*) FILTER (WHERE outcome = 'WIN'))::numeric
    / nullif((count(*) FILTER (WHERE outcome IN ('WIN', 'LOSS', 'CUT_LOSS'))), 0),
    4
  ) AS win_rate
FROM v_trade_journal_enriched
GROUP BY side
ORDER BY side;

CREATE OR REPLACE VIEW v_trade_execution_summary AS
SELECT
  coalesce(execution_type, 'UNKNOWN') AS execution_type,
  count(*) FILTER (WHERE outcome <> 'DRY_RUN') AS real_trades,
  count(*) FILTER (WHERE outcome = 'WIN') AS wins,
  count(*) FILTER (WHERE outcome IN ('LOSS', 'CUT_LOSS')) AS losses,
  round(coalesce(sum(pnl) FILTER (WHERE outcome <> 'DRY_RUN'), 0), 2) AS pnl_sum,
  round(coalesce(avg(pnl) FILTER (WHERE outcome <> 'DRY_RUN'), 0), 4) AS pnl_avg,
  round(
    (count(*) FILTER (WHERE outcome = 'WIN'))::numeric
    / nullif((count(*) FILTER (WHERE outcome IN ('WIN', 'LOSS', 'CUT_LOSS'))), 0),
    4
  ) AS win_rate
FROM v_trade_journal_enriched
GROUP BY execution_type
ORDER BY real_trades DESC;

CREATE OR REPLACE VIEW v_trade_phase_summary AS
SELECT
  coalesce(phase, 'UNKNOWN') AS phase,
  count(*) FILTER (WHERE outcome <> 'DRY_RUN') AS real_trades,
  count(*) FILTER (WHERE outcome = 'WIN') AS wins,
  count(*) FILTER (WHERE outcome IN ('LOSS', 'CUT_LOSS')) AS losses,
  round(coalesce(sum(pnl) FILTER (WHERE outcome <> 'DRY_RUN'), 0), 2) AS pnl_sum,
  round(coalesce(avg(pnl) FILTER (WHERE outcome <> 'DRY_RUN'), 0), 4) AS pnl_avg,
  round(
    (count(*) FILTER (WHERE outcome = 'WIN'))::numeric
    / nullif((count(*) FILTER (WHERE outcome IN ('WIN', 'LOSS', 'CUT_LOSS'))), 0),
    4
  ) AS win_rate
FROM v_trade_journal_enriched
GROUP BY phase
ORDER BY real_trades DESC;

CREATE OR REPLACE VIEW v_verified_discrepancy_summary AS
SELECT
  count(*) AS records,
  count(*) FILTER (WHERE resolved IS TRUE) AS resolved_records,
  round(coalesce(sum(net_pnl), 0), 2) AS verified_net_pnl,
  round(coalesce(sum(local_pnl), 0), 2) AS local_pnl_sum,
  round(coalesce(sum(discrepancy), 0), 2) AS discrepancy_sum,
  round(coalesce(avg(discrepancy), 0), 4) AS discrepancy_avg,
  round(coalesce(max(abs(discrepancy)), 0), 2) AS max_abs_discrepancy
FROM verified_journal_records;

CREATE OR REPLACE VIEW v_latest_bot_state AS
SELECT
  captured_at,
  bankroll,
  peak_bankroll,
  total_trades,
  wins,
  losses,
  consecutive_losses,
  current_position,
  raw
FROM bot_state_snapshots
ORDER BY captured_at DESC
LIMIT 1;
