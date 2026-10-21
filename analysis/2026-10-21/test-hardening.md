# Test & delivery hardening — 2026-10-21

## Drift detector

- Extracted `assessDrift()` as a pure function and added 5 gate tests: stable live baseline, hard drop, recent-20 drop, confidence-only warning, CUSUM-only trigger.
- Updated the existing dry-run drift test to provide a live reference window (200 older trades + 50 recent), matching the new same-model baseline design.
- Deployed fix; live check: `acc=66% vs live baseline 64.06%`, CUSUM 0, `driftDetected:false`.

## Auth

- Added HTTP-level tests for the auth gateway: wrong password rejected without cookie; right password gets a session; `/me` works; logout invalidates; tampered cookie rejected.

## Full suite

- `clobClient.v2` cold-import timeouts under full-suite CPU load raised from 30s to 120s; isolated 15/15 passes, and the final full suite is green.
- Full suite result: **90 files / 938 tests passed** (98 s).

## Frontend delivery

- CSP now allows the Cloudflare Insights beacon (`static.cloudflareinsights.com` / `cloudflareinsights.com`), removing the console error.
- Vite `manualChunks` split: app ~191 KB, react ~189 KB, motion ~139 KB, vendor ~4 KB; no >500 KB warning.