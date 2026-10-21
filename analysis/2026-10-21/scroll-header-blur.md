# Sticky header scroll artifact — blur veil fix (2026-10-21)

## Symptom

While scrolling, a light horizontal strip/smear appeared under the translucent sticky topbar. Widget content was passing behind the header and showing through its 8–12% transparent background, amplified by `backdrop-filter`.

## Fix

- Added `.dash-scroll-veil`: a fixed 156px top overlay with `backdrop-filter: blur(22px)`, dark vertical gradient and a mask fade. It only becomes visible after `window.scrollY > 6`, and has `pointer-events: none`.
- Raised topbar opacity to `~0.96–0.975` and backdrop blur to 30px.
- Raised subbar opacity to `0.93`, blur 24px and added a soft lower shadow.
- On mobile (`max-width: 980px`) the veil is hidden because the header is not sticky there.

## Verification

- Desktop 1362×900 at scrollY 520: white strip gone; topbar and subbar stay dark and separated.
- At scrollY 0 the veil is `opacity: 0`; after scroll it is `opacity: 1`, 1362×156 with `blur(22px)`.
- Mobile unaffected (veil display none, topbar relative).
- Frontend typecheck/build PASS.

Before: [scroll-header-before.png](scroll-header-before.png)  
After: [scroll-header-after.png](scroll-header-after.png)