# Dashboard login gate + animated login page — 2026-10-20

## What changed

- The public dashboard now has a **custom login page** at `https://poly15.dollarkilat.xyz/`.
- Login is backed by a **session cookie** (`HttpOnly`, `Secure`, `SameSite=Lax`, 12 h) from `scripts/dashboard-auth-server.mjs`; the password is checked against a scrypt hash and rate-limited per real client IP.
- nginx Basic Auth was removed from the page. `auth_request` now protects `/ws` and `/api/reports`; the page/static bundle can load, but market data and control actions require a valid session.
- `/auth/login`, `/auth/me`, `/auth/logout` are proxied to the loopback auth service on `127.0.0.1:3102`.
- The topbar has a sign-out button; logout clears the cookie and invalidates the session.

## Login UI

- Motion (Framer Motion successor) background: animated orbs, perspective grid, scanline and candlestick field.
- Glass card, show/hide password, inline error and loading state.
- Auth splash while `/auth/me` is being checked.
- `prefers-reduced-motion` disables the ambient motion.
- Preview: [login-page-preview.png](login-page-preview.png).

## Verification

- Without a session: login page, 0 dashboard widgets; `/auth/me` 401; `/ws` 401.
- Wrong password: inline `invalid password`.
- Correct password: cookie set; dashboard loads; 16 widgets; WebSocket receives snapshots.
- Reload: session persists; dashboard stays open.
- Logout: login page returns; 0 widgets.
- nginx `/ws` without cookie returns 401; with cookie it opens and returns snapshot bytes.
- Frontend typecheck/build PASS.

## Files

- `src/components/auth/LoginPage.tsx`, `src/hooks/useDashboardAuth.ts`, `src/styles/login.css`.
- `src/App.tsx` — auth wrapper; dashboard mounts only after session verification.
- `src/components/dashboard/DashboardShell.tsx` — sign-out button.
- `scripts/dashboard-auth-server.mjs`, `scripts/polybot-dashboard-auth.service` — auth gateway.
- nginx: `/auth/`, internal `/_dashboard_auth`, `auth_request` on `/ws` + report APIs.

## Security notes

- Static bundle is public; data/control is not.
- The auth service binds loopback only; nginx is the only ingress.
- Session cookie is HttpOnly/Secure; logout invalidates the server-side session map.
- In-memory sessions reset on auth-service restart (users must log in again).
- Cloudflare Access can be layered on top for email OTP; nginx/session auth already protects the control plane.