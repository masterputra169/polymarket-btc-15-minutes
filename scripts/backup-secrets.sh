#!/usr/bin/env bash
# Off-repo, root-only backup of dashboard auth + named-tunnel + nginx config.
set -euo pipefail

STAMP=$(date +%F)
OUT=/home/ubuntu/backups/secure
ARCHIVE="$OUT/polybtc15-secrets-$STAMP.tar.gz"
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

install -d -m 700 -o root -g root "$OUT"

tar -czf "$TMP" -C / --dereference \
  opt/polybtc15/auth.env \
  opt/polybtc15/dashboard-password.hash \
  home/ubuntu/.cloudflared \
  etc/cloudflared/config.yml \
  etc/nginx/sites-available/polybtc15 \
  etc/systemd/system/polybot-dashboard-auth.service \
  etc/systemd/system/cloudflared-named.service

install -m 600 -o root -g root "$TMP" "$ARCHIVE"
# Keep 30 days of secure backups.
find "$OUT" -maxdepth 1 -type f -name 'polybtc15-secrets-*.tar.gz' -mtime +30 -delete
logger -t polybot "secure backup written: $ARCHIVE"
echo "$ARCHIVE"
