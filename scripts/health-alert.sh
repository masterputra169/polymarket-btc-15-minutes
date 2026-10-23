#!/usr/bin/env bash
# POLY//15 health alert: failed units, service health, disk/swap, auto-deploy state.
set -Eeuo pipefail
REPO="/opt/polybtc15"
BOT_ENV="$REPO/bot/.env"
AUTO_STATE="$REPO/.auto-deploy/state.json"
STATE_DIR="/var/lib/poly15-health"
STATE_FILE="$STATE_DIR/last-issues.txt"
mkdir -p "$STATE_DIR"

TOKEN=""
CHAT=""
if [ -f "$BOT_ENV" ]; then
  TOKEN=$(grep -m1 '^TELEGRAM_BOT_TOKEN=' "$BOT_ENV" | cut -d= -f2- | tr -d '\r"' || true)
  CHAT=$(grep -m1 '^TELEGRAM_CHAT_ID=' "$BOT_ENV" | cut -d= -f2- | tr -d '\r"' || true)
fi

ISSUES=""
add_issue() { ISSUES="$ISSUES$1"$'\n'; }

for unit in $(systemctl --failed --no-legend --plain 2>/dev/null | awk '{print $1}'); do
  add_issue "unit failed: $unit"
done

for unit in polybtc15-bot polybot-dashboard-auth nginx cloudflared-named poly15-auto-deploy.timer; do
  if ! systemctl is-active --quiet "$unit" 2>/dev/null; then add_issue "unit inactive: $unit"; fi
done

DISK_PCT=$(df -P / | awk 'NR==2 {gsub("%", "", $5); print $5}')
if [ -n "$DISK_PCT" ] && [ "$DISK_PCT" -ge 85 ]; then add_issue "disk $DISK_PCT% used"; fi

SWAP_TOTAL=$(awk '/^SwapTotal:/{print $2}' /proc/meminfo)
SWAP_FREE=$(awk '/^SwapFree:/{print $2}' /proc/meminfo)
if [ -n "$SWAP_TOTAL" ] && [ "$SWAP_TOTAL" -gt 0 ]; then
  SWAP_USED_PCT=$(( (SWAP_TOTAL - SWAP_FREE) * 100 / SWAP_TOTAL ))
  if [ "$SWAP_USED_PCT" -ge 80 ]; then add_issue "swap $SWAP_USED_PCT% used"; fi
fi

curl -fsS --max-time 5 http://127.0.0.1:3101/health >/dev/null 2>&1 || add_issue "bot report health endpoint down"
curl -fsS --max-time 5 http://127.0.0.1:3102/health >/dev/null 2>&1 || add_issue "auth health endpoint down"

if [ -f "$AUTO_STATE" ]; then
  RESULT=$(sed -n 's/.*"last_result":"\([^"]*\)".*/\1/p' "$AUTO_STATE" | head -1)
  case "$RESULT" in
    failed*|rolled-back) add_issue "auto-deploy last result: $RESULT" ;;
  esac
fi

PREV=""
if [ -f "$STATE_FILE" ]; then PREV=$(cat "$STATE_FILE"); fi

notify() {
  [ -n "$TOKEN" ] || return 0
  [ -n "$CHAT" ] || return 0
  curl -fsS --max-time 10 -X POST "https://api.telegram.org/bot$TOKEN/sendMessage" \
    --data-urlencode "chat_id=$CHAT" \
    --data-urlencode "text=$1" >/dev/null 2>&1 || true
}

if [ "$ISSUES" != "$PREV" ]; then
  if [ -n "$ISSUES" ]; then notify "🚨 POLY//15 health alert
$ISSUES"; elif [ -n "$PREV" ]; then notify "✅ POLY//15 health recovered"; fi
  printf '%s' "$ISSUES" > "$STATE_FILE"
fi

if [ -n "$ISSUES" ]; then printf '%s\n' "$ISSUES"; exit 1; fi
exit 0
