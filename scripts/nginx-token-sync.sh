#!/usr/bin/env bash
# Keep nginx's injected dashboard WS/report tokens in sync with bot/.env.
# Runs as root from polybot-dashboard-auth-sync.timer.
set -euo pipefail

ENV_FILE=/opt/polybtc15/bot/.env
NGINX_FILE=/etc/nginx/sites-enabled/polybtc15
[ -r "$ENV_FILE" ] || exit 0
[ -r "$NGINX_FILE" ] || exit 0

STATUS=$(grep -E '^STATUS_AUTH_TOKEN=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '\r"')
REPORT=$(grep -E '^REPORT_AUTH_TOKEN=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '\r"')
[ -n "$STATUS" ] || exit 0
[ -n "$REPORT" ] || exit 0

TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT
cp "$NGINX_FILE" "$TMP"

python3 - "$TMP" "$STATUS" "$REPORT" <<'PY'
import re, sys
path, status, report = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(path).read()
s = re.sub(r'(proxy_pass http://127\.0\.0\.1:3099/ws\?token=)[^;]+', r'\g<1>' + status, s)
s = re.sub(r'(proxy_set_header Authorization "Bearer )[^"]+(")', r'\g<1>' + report + r'\g<2>', s)
open(path, 'w').write(s)
PY

if cmp -s "$TMP" "$NGINX_FILE"; then exit 0; fi
install -m 0644 "$TMP" "$NGINX_FILE"
if nginx -t; then systemctl reload nginx; fi
