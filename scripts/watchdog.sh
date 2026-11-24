#!/bin/bash
CODE=0
node --env-file=/opt/polybtc15/bot/.env /opt/polybtc15/bot/scripts/botLiveness.mts >/tmp/polybot-liveness.json 2>/dev/null || CODE=$?
if [ "$CODE" != "0" ]; then
  logger -t polybot-watchdog "liveness exit $CODE — restarting polybtc15-bot"
  TOKEN=$(grep -m1 '^TELEGRAM_BOT_TOKEN=' /opt/polybtc15/bot/.env | cut -d= -f2- | tr -d '"')
  CHAT=$(grep -m1 '^TELEGRAM_CHAT_ID=' /opt/polybtc15/bot/.env | cut -d= -f2- | tr -d '"')
  DASH=$(cat /opt/polybtc15/.tunnel-url 2>/dev/null || true)
  if [ -n "$TOKEN" ] && [ -n "$CHAT" ]; then
    MSG="🚨 <b>PolyBTC15 watchdog</b>%0A🧠 liveness exit $CODE at $(date -u +%FT%TZ)%0A♻️ Restarting bot now."
    [ -n "$DASH" ] && MSG="$MSG%0A%0A🌐 <a href='$DASH'>Dashboard</a>"
    curl -s -m 10 -X POST "https://api.telegram.org/bot$TOKEN/sendMessage" -d chat_id="$CHAT" -d parse_mode=HTML --data-urlencode text="$(echo -e "$MSG" | sed 's/%0A/\n/g')" >/dev/null 2>&1 || true
  fi
  systemctl restart polybtc15-bot
fi
