# Daily dashboard password rotation via Telegram — 2026-10-21

## Behaviour

- New random password every day at **07:00 WIB**.
- Telegram alert contains the new password; previous password message is deleted when possible, so the chat keeps only the latest.
- The auth service **does not restart** and existing sessions stay valid; the new password applies to the next login (old password stops working for new logins immediately).
- A root-only recovery copy is written to `/root/.poly15-dashboard-password-latest` in case Telegram delivery fails.

## Implementation

- `scripts/rotate-dashboard-password.mjs`
  - generates 20-char random suffix (`Poly15-…`),
  - scrypt hash, atomic hash-file write (`/opt/polybtc15/dashboard-password.hash`),
  - keeps `auth.env` hash in sync for service-restart fallback,
  - sends Telegram via existing `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`,
  - deletes previous password message id stored in `/root/.poly15-password-message.json`,
  - writes root-only plaintext fallback.
- `polybot-dashboard-password-rotate.service/timer` at 07:00 Asia/Jakarta, `Persistent=true` (if the VPS was off at 07:00 it runs once when it returns).
- `dashboard-auth-server.mjs` now reads the hash file on every login; no restart required.

## Verification

- `--dry-run` → `dry run ok` (no write, no send).
- `--test-notify` → Telegram test message sent (no password change).
- Hot-reload drill: wrote a temporary test hash → test password `200`, current password `401`; restored hash → current password `200`, no service restart.
- Timer: next run **Thu 2026-10-22 07:00 WIB**.
- Current password remains valid until the first rotation.

## Security note

Sending a password through Telegram means anyone with access to that Telegram chat/history can read it. The old message is deleted when possible, but Telegram retention/backups may still hold it. The fallback file is root-only; the hash is never logged.