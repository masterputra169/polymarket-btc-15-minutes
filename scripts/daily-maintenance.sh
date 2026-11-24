#!/usr/bin/env bash
# ==============================================================================
# daily-maintenance.sh
# PolyBTC15 VPS automated daily housekeeping & maintenance script.
# - Cleans PostgreSQL snapshot records older than 7 days
# - Runs non-blocking online VACUUM on snapshot tables
# - Caps & rotates orderflow.jsonl if larger than 10MB
# - Vacuums systemd journal logs older than 3 days
# - Cleans APT download cache
# ==============================================================================
set -euo pipefail

LOG_TAG="[DailyMaintenance]"
echo "$LOG_TAG Starting daily maintenance: $(date -Iseconds)"

# 1. PostgreSQL snapshots retention (delete > 7 days)
if command -v psql >/dev/null 2>&1; then
    echo "$LOG_TAG Purging PostgreSQL snapshots older than 7 days..."
    sudo -u postgres psql -d polymarket -v ON_ERROR_STOP=1 << 'EOSQL'
DELETE FROM bot_state_snapshots WHERE captured_at < now() - interval '7 days';
DELETE FROM bot_signal_perf_snapshots WHERE captured_at < now() - interval '7 days';
DELETE FROM bot_position_snapshots WHERE captured_at < now() - interval '7 days';
VACUUM bot_state_snapshots;
VACUUM bot_signal_perf_snapshots;
VACUUM bot_position_snapshots;
CHECKPOINT;
EOSQL
    echo "$LOG_TAG PostgreSQL snapshot cleanup complete."
fi

# 2. Bot data files maintenance
BOT_DATA_DIR="/opt/polybtc15/bot/data"
if [ -d "$BOT_DATA_DIR" ]; then
    echo "$LOG_TAG Checking bot data files in $BOT_DATA_DIR..."
    
    # Cap orderflow.jsonl to last 10,000 lines if > 10MB
    ORDERFLOW_FILE="$BOT_DATA_DIR/orderflow.jsonl"
    if [ -f "$ORDERFLOW_FILE" ]; then
        FILESIZE=$(stat -c%s "$ORDERFLOW_FILE" 2>/dev/null || stat -f%z "$ORDERFLOW_FILE" 2>/dev/null || echo 0)
        if [ "$FILESIZE" -gt 10485760 ]; then # 10 MB
            echo "$LOG_TAG Rotating $ORDERFLOW_FILE (current size: $((FILESIZE / 1024 / 1024)) MB)..."
            tail -n 10000 "$ORDERFLOW_FILE" > "$ORDERFLOW_FILE.tmp" && mv "$ORDERFLOW_FILE.tmp" "$ORDERFLOW_FILE"
        fi
    fi

    # Clean leftover rotated files or temporary files
    find "$BOT_DATA_DIR" -maxdepth 1 -type f \( -name "*.jsonl.1" -o -name "*.bak_repair" -o -name "*.tmp" \) -mtime +2 -delete 2>/dev/null || true
fi

# 3. Systemd journal cleanup
if command -v journalctl >/dev/null 2>&1; then
    echo "$LOG_TAG Vacuuming journalctl logs older than 3 days (max 150M)..."
    journalctl --vacuum-time=3d --vacuum-size=150M >/dev/null 2>&1 || true
fi

# 4. Clean APT package cache
if command -v apt-get >/dev/null 2>&1; then
    apt-get clean >/dev/null 2>&1 || true
fi

echo "$LOG_TAG Daily maintenance completed successfully: $(date -Iseconds)"
