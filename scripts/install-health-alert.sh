#!/usr/bin/env bash
set -Eeuo pipefail
REPO="/opt/polybtc15"
install -m 0755 -o root -g root "$REPO/scripts/health-alert.sh" /usr/local/sbin/poly15-health-alert
install -m 0644 -o root -g root "$REPO/scripts/poly15-health-alert.service" /etc/systemd/system/poly15-health-alert.service
install -m 0644 -o root -g root "$REPO/scripts/poly15-health-alert.timer" /etc/systemd/system/poly15-health-alert.timer
mkdir -p /var/lib/poly15-health
chown root:root /var/lib/poly15-health
systemctl daemon-reload
systemctl enable --now poly15-health-alert.timer
systemctl list-timers poly15-health-alert.timer --no-pager | sed -n '1,3p'
