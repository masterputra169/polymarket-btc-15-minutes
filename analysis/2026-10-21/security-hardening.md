# Security hardening & secret backups — 2026-10-21

## Password rotation

- Rotated the dashboard password after the old one appeared in chat.
- New password is **not** in this repo, not on the VPS in plaintext, and not in the final chat message.
- Local copy: `C:\Users\Asus\.poly15\dashboard-password.txt` (user profile, outside the repo).
- VPS: only the scrypt hash in `/opt/polybtc15/auth.env` (0600).
- Verified: new login → 200 + session; old password → 401; `/auth/me` → 200 with the new session.

## Secure backup

Added `scripts/backup-secrets.sh` plus `polybot-secrets-backup.service/timer` (daily 06:35, root-only).

Archive contents:
- `/opt/polybtc15/auth.env` (password hash + session secret);
- `/home/ubuntu/.cloudflared/` (named-tunnel certificate + tunnel credentials);
- `/etc/cloudflared/config.yml`;
- `/etc/nginx/sites-available/polybtc15` (including status/report tokens);
- dashboard/auth + named-tunnel systemd units.

Storage: `/home/ubuntu/backups/secure/polybtc15-secrets-YYYY-MM-DD.tar.gz`, mode 0600 root, 30-day retention. Off-site local copy under `C:\Users\Asus\.poly15\backup\`.

Restore drill completed: archive extracted to a temp directory; auth.env SHA-256 matched the live file; all four config groups were present.

## Still optional

- Cloudflare Access (email OTP) in front of the login page requires Cloudflare account/API access; not enabled here.
- Do not commit `auth.env`, tunnel credentials, or the local password file.