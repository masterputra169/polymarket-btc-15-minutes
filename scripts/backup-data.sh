#!/bin/bash
# Daily bot-data backup; AES-256 encrypted, 14-day retention.
set -euo pipefail
umask 077
DEST=/opt/polybtc15/backups
DATA=/opt/polybtc15/bot/data
KEY=/root/.poly15-backup.key
mkdir -p "$DEST"
if [ ! -f "$KEY" ]; then
  openssl rand -base64 48 > "$KEY"
  chmod 600 "$KEY"
  chown root:root "$KEY"
fi
TS=$(date -u +%Y%m%d-%H%M%S)
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT
cd "$DATA"
FILES=""
for f in state.json trade_journal.jsonl verified_journal.jsonl ptb_health.jsonl feedback.json jev_log.jsonl jev_outcomes.json; do
  [ -f "$f" ] && FILES="$FILES $f"
done
if [ -z "$FILES" ]; then
  echo "no data files found"
  exit 1
fi
tar -czf "$TMP" $FILES
OUT="$DEST/data-$TS.tar.gz.enc"
openssl enc -aes-256-cbc -salt -pbkdf2 -iter 200000 -in "$TMP" -out "$OUT" -pass file:"$KEY"
chmod 600 "$OUT"
chown root:root "$OUT"
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in "$OUT" -pass file:"$KEY" | tar -tzf - >/dev/null
find "$DEST" -maxdepth 1 -type f -name 'data-*' -mtime +14 -delete
logger -t polybot "encrypted data backup written: $OUT"
echo "$OUT"
