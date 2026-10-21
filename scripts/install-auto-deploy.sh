#!/usr/bin/env bash
# Install/refresh the POLY//15 pull-based auto-deploy unit. Run as root.
set -Eeuo pipefail
REPO="/opt/polybtc15"

install -m 0755 -o root -g root "$REPO/scripts/auto-deploy.sh" /usr/local/sbin/poly15-auto-deploy
install -m 0644 -o root -g root "$REPO/scripts/poly15-auto-deploy.service" /etc/systemd/system/poly15-auto-deploy.service
install -m 0644 -o root -g root "$REPO/scripts/poly15-auto-deploy.timer" /etc/systemd/system/poly15-auto-deploy.timer
mkdir -p "$REPO/.auto-deploy"
chown -R ubuntu:ubuntu "$REPO/.auto-deploy"
systemctl daemon-reload
systemctl enable --now poly15-auto-deploy.timer
systemctl list-timers poly15-auto-deploy.timer --no-pager | sed -n '1,3p'
echo "installed /usr/local/sbin/poly15-auto-deploy"
