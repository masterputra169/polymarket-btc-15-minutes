#!/usr/bin/env bash
# Off-repo, root-only backup of dashboard auth + named-tunnel + nginx config.
# Archives are AES-256 encrypted; the key is /root/.poly15-backup.key (0600).
set -euo pipefail
umask 077

STAMP=$(date +%F)
OUT=/home/ubuntu/backups/secure
KEY=/root/.poly15-backup.key
ARCHIVE="$OUT/polybtc15-secrets-$STAMP.tar.gz.enc"
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

install -d -m 700 -o root -g root "$OUT"
if [ ! -f "$KEY" ]; then
  openssl rand -base64 48 > "$KEY"
  chmod 600 "$KEY"
  chown root:root "$KEY"
fi

tar -czf "$TMP" -C / --dereference \
  opt/polybtc15/auth.env \
  opt/polybtc15/dashboard-password.hash \
  home/ubuntu/.cloudflared \
  etc/cloudflared/config.yml \
  etc/nginx/sites-available/polybtc15 \
  etc/systemd/system/polybot-dashboard-auth.service \
  etc/systemd/system/cloudflared-named.service

openssl enc -aes-256-cbc -salt -pbkdf2 -iter 200000 -in "$TMP" -out "$ARCHIVE" -pass file:"$KEY"
chmod 600 "$ARCHIVE"
chown root:root "$ARCHIVE"
# Verify the archive can be decrypted before reporting success.
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in "$ARCHIVE" -pass file:"$KEY" | tar -tzf - >/dev/null

# Keep 30 days of secure backups (plaintext and encrypted).
find "$OUT" -maxdepth 1 -type f -name 'polybtc15-secrets-*' -mtime +30 -delete
logger -t polybot "encrypted secure backup written: $ARCHIVE"
echo "$ARCHIVE"
