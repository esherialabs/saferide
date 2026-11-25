# SafeRide × HURIA partner dashboard (`apps/partner-web`)

The web app HURIA caseworkers use: sign-in (password, plus a TOTP code when the org requires MFA, the default), enrolment, "Choose a new password" for operator-issued passwords, the case queue, case detail (brief or packet, evidence links, status, notes, callback reveal) and sign-out with idle/absolute expiry. Design: section 4 of the HURIA dashboard design.

## Live coverage (migration 016)

An authenticated staff member can select **Start live coverage** on a trusted shift device. This explicitly replaces the normal idle limit with a rolling 12-hour lease. A CSRF-protected heartbeat every 60 seconds renews the database lease and HttpOnly cookie; polling alone never opts in. Summary polling continues when the tab is hidden, subject to browser throttling. The connection status confirms the last heartbeat, while the separate counts warning reports summary failures. A closed/suspended browser or lost network cannot guarantee live monitoring; after 12 hours without renewal the session expires.

**Stop live coverage** restores the normal 30-minute idle window. Manual sign-out, password resets, disabled users, suspended organisations and MFA requirements still apply. Mode generations reject stale responses, and a heartbeat cannot turn coverage back on, revive an expired session or extend a normal session. Ordinary sessions continue to follow the timing rules below.

## Browser notifications (migration 017)

The separate **Browser notifications** control asks permission only after the staff member chooses Enable. A service worker displays a fixed generic SafeRide message and opens `/cases/`; it has no fetch handler, cache, offline case data or arbitrary notification URL. The browser may persist its push subscription and worker registration; application case/session content remains in memory only. Endpoints and browser delivery keys are encrypted in the database under a distinct HKDF subkey. Each subscription belongs to one authenticated session and is removed after expiry/revocation/disablement or explicit unsubscribe. A new referral atomically creates a durable generic outbox job; consent withdrawal or acknowledgement suppresses pending delivery. Transient failures retry at most five times, with a 24-hour job limit; expired provider subscriptions are removed. Alerts are rate-limited per device and use a replacement notification tag.

Only the isolated push relay has provider egress (Google FCM, Mozilla Autopush, Apple Web Push). The API remains on internal networks, and the relay has no database/storage network, case data or partner master keys. The relay accepts only authenticated, bounded requests to allowlisted HTTPS provider endpoints and sends fixed encrypted payloads. Its private VAPID key never reaches the API. Test queuing and provider acceptance are shown separately: neither proves OS display or staff acknowledgement. Already dispatched notifications can arrive after sign-out. Staff must check a real test notification on each selected device and keep a monitored dashboard; browser/OS power saving, permission changes and connectivity can delay delivery.

Stack: Next 16 (Pages Router, static export, webpack build), React 18, Tailwind 3, TypeScript. No third-party scripts, font services or analytics; fonts and icons are self-hosted; QR codes drawn locally as SVG.

## Commands

```sh
npm ci
npm run build        # production export: next build --webpack, then scripts/check-static-export.mjs
npm run typecheck
npm run test:unit    # node --test (Node >= 22.18, type stripping)
npm run build:e2e    # the same export, but allowing the mock's evidence storage origin
npm run e2e          # Playwright against the build:e2e export + mock API
                     # (VISUAL_SCREENSHOT_DIR=<dir> saves the light/dark review screenshots from visual.spec.ts;
                     #  CASE_MGMT_SCREENSHOT_DIR=<dir> the case-management set)
npm run mock         # http://localhost:4320 (export + mock API) and :4321 (mock storage); synthetic data only
```

## Hosting (for P7)

- Output: `apps/partner-web/out/`. Serve it with `try_files $uri $uri.html $uri/index.html =404;` and `error_page 404 /404.html;`. Routes: `/`, `/sign-in/`, `/enroll/`, `/change-password/`, `/cases/` (optionally `?view=attention|mine|unassigned|urgent`), `/case/?id=<referral id>`.
- Enrolment links are `https://<partner host>/enroll#token=…` (P2 `partnerAdmin.ts`); the page reads the token from the fragment and removes it from the address bar.
- The app calls the API same-origin under `/partner/v1/…` (P2 prefix), so the gateway routes `/partner/v1/` to the API on the partner host.
- Evidence links are accepted only on one origin, fixed at build time: `PARTNER_EVIDENCE_ORIGIN` (default `https://storage.saferide.esheria.org`; https only, http only for localhost). Build the deployed export with the default or the real storage origin, never with `build:e2e`.
- The export has no inline scripts or styles, and every served SVG (favicon, `public/brand/*.svg`) is inert: no scripts, event handlers or external references. Both are checked on every build, so the CSP can be:

  ```
  default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'
  ```

  plus `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex, nofollow`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store` on HTML (immutable caching is fine for `/_next/static/`). Add `upgrade-insecure-requests` and HSTS at the edge. Evidence downloads navigate to the presigned storage host, which CSP `connect-src` does not need to allow.

## Brand assets

The dashboard uses SafeRide's own brand, as on saferide.esheria.org:

- **SafeRide logo**: `src/components/brand/SafeRideLogo.tsx` inlines the official wordmark from `assets/logo.svg` / `assets/logo-inverted.svg` (same letters, highlight bars and colours; the letters follow the text colour, so one mark serves light and dark). Favicon: `public/favicon.svg`, a copy of `web/public/favicon.svg`. Use follows `TRADEMARKS.md`.
- **Colours, type, radii**: tokens at the top of `src/styles/globals.css`, mapped to Tailwind names in `tailwind.config.ts`. Appearance initially follows the device; the sun/moon button names the current light/dark mode and switches it. “Use device setting” restores automatic changes. The choice stays only in this tab’s memory across navigation and resets on reload; it writes no browser storage or session activity. Ink-on-paper with the wordmark's orange/blue/green/yellow as accents (`web/src/app/globals.css`); radii 12/14/16 px from `src/theme/tokens.ts`; 8-pt spacing; 16 px base text.
- **Fonts**: Mozilla Headline (600, 700) and Mozilla Text (400, 700), the website's fonts, self-hosted as woff2 in `public/fonts/` (copied from `web/public/fonts/`). SIL Open Font License 1.1, © 2024 The Mozilla Foundation: `public/fonts/OFL.txt`. The CSP therefore needs `font-src 'self'`.
- **Icons**: `src/components/icons.tsx`, inline SVG with path data from Heroicons 2.2.0 (MIT, © Tailwind Labs). No icon font or CDN.

### HURIA logo

The "SafeRide × HURIA" lockup (`src/components/brand/BrandLockup.tsx`) uses HURIA's logo exactly as the SafeRide website ships it on its partners page: `public/brand/huria-logo.png` is a byte-identical copy of `web/public/images/partners/human-rights-agenda.png` (320 × 197, transparent). Provenance is in `ASSET-LICENSES.md`. Text alternatives: "SafeRide" and "Human Rights Agenda (HURIA)". In dark mode the PNG sits on a light chip, because its lettering is black.

To replace it with a file HURIA provides:

1. Save it as `public/brand/huria-logo.svg` (preferred), `.png` or `.webp`. Remove the old `huria-logo.png` if the format changes (SVG wins over PNG). A raster file should be at least 480 px wide, with a transparent background.
2. Optional: add a version for dark backgrounds as `public/brand/huria-logo-dark.*`. The light chip is then dropped in dark mode.
3. Rebuild. `next.config.mjs` finds the files at build time; `src/components/brand/PartnerLogo.tsx` renders them (`data-logo-slot="huria"`). With no file at all, the lockup falls back to the text wordmark "HURIA — Human Rights Agenda".

Display height: 36 px in the header, and 64 px on the sign-in and enrolment cards (48 px on phones). The width follows the aspect ratio. Keep the file self-contained. An SVG with scripts, event handlers or external references fails `scripts/check-static-export.mjs`, and the build stops.

## API contract

All request and response shapes live in `src/lib/partnerApi.ts`.
- Auth follows P2: `/partner/v1/auth/*` and `/me`, with the CSRF header `x-saferide-partner-csrf`.
- Per-org MFA (migration 013): the login answer says what comes next. `mfaRequired` shows the code step; with `totpSetupRequired` the person first adds an authenticator (`POST /auth/totp/setup`, QR and key as at enrolment). With MFA off, a correct password signs straight in and no code step is shown. The sign-in page itself never mentions an authenticator, since it cannot know the org before sign-in.
- `mustChangePassword` (an operator issued the password with `user:set-password`): every page sends the person to `/change-password/`, and the API answers 403 `password_change_required` to everything but `/me`, `POST /auth/change-password` and logout. A successful change answers a new session (new cookie and CSRF token) and ends every other session of the person.
- Cases follow P3 (`apps/api/src/routes/partnerCases.ts`):
  - `GET /referrals?status=&pathway=&cursor=&limit=` returns `{referrals, nextCursor}`.
  - `GET /referrals/:id` returns `{referral, view, attachments, timeline, notes}`.
  - `POST .../status`, `.../notes`, `.../evidence/:attachmentId/url` and `.../callback` (caseworkers only; the button is hidden for admins).
- Case management follows #314 (`codex/partner-case-management`):
  - Queue rows and `referral` carry `priority` (`urgent` for escalations), `needsAttention` (urgent and still `new`), `assignee {id, name} | null`; rows also carry `onward {count, latest}`. Filters `assignee=me|unassigned|<userId>` and `priority=urgent|normal`.
  - `GET /summary` drives the attention banner, header count, favicon dot and title count ("(2) Cases", a count only). It is polled at most every 60 s, only in a visible tab, always without the activity flag, so idle sign-out still happens.
  - `GET /staff` fills the "In charge" picker. `POST .../assign {assigneeId, expectedAssigneeId}`: 409 `{reason: 'stale', currentAssignee}` shows who has it now and offers a reload; 400 `{reason: 'invalid_assignee'}` (only active staff).
  - "Acknowledge" is an explicit `POST .../status {to: 'acknowledged', expectedStatus: 'new'}`; opening a case never acknowledges it.
  - Onward referrals (`onwardReferrals` on the detail): `POST .../onward` and `POST .../onward/:onwardId/status {to, expectedStatus}`; the buttons follow each record's `allowedTransitions`.
  - Timeline `event`s `acknowledged`, `assigned`, `unassigned`, `onward_created`, `onward_status` name their `actor`.
  - No browser notifications (they show on lock screens). The optional chime is Web Audio only, off by default, held in memory, and off again after a reload.
- Referral IDs are UUIDs. Status moves come from `referral.allowedTransitions`.
- A referral that is no longer shared reads as a tombstone, and an action on it (410) reloads into the tombstone. This covers both a survivor's withdrawal and an operator's revoke (#304). Partners see only "No longer shared", with no cause, so the two can't be told apart.
- Evidence downloads are off in P3 by default. Items then carry `download: {available: false, reason: 'evidence_not_shareable_yet'}`, and the URL endpoint answers 409 with that reason. Both show "Evidence files can't be shared with partners yet. SafeRide keeps them safely." with no button.
- Closure reasons are exactly P3's `PARTNER_CLOSURE_REASONS` codes.
- 404 (including another org's referral) and 503 (including an audit failure) show neutral messages.
- User-driven GETs send P2's `x-saferide-partner-activity: interactive`, which extends the 30-minute idle timer (writes always do). The queue's periodic refresh, at most every 60 s, sends no flag, so an unattended screen still times out.

## Data handling

- Case data lives only in memory: no localStorage, sessionStorage, IndexedDB or readable cookies. The e2e tests assert this after every test.
- Page titles and URLs carry no case content, only the referral ID.
- Sign-out and expiry wipe the state and reload the sign-in page as a new document.
- Tabs share one session cookie, so they share activity and sign-out over a BroadcastChannel (`src/lib/sessionSync.ts`). The messages are content-free: a type, a reason code, and a yes/no for "unsaved note?".
- Sign-out or expiry in one tab wipes every tab at once.
- Idle time counts only from real input (keyboard or pointer, in any tab). A keep-alive (an interactive `/me`) is sent only at the moment of this tab's own input, when the server last heard from the tab 2 or more minutes ago. No timer, idle check or server answer sends one, so no interactive request follows the last real input. A tab signs out 28–30 minutes after the last input, never later.
- Before an idle sign-out, a tab checks with the server (`/me` without the activity flag) whether the session is still in use in another tab. It stays only if the server's deadline is later than its own requests explain. Without BroadcastChannel, the same check runs every 30 s.
- Sign-out and the expiry warnings say when an unsaved note would be lost.
- The note field turns off spellcheck, autocorrect and autocapitalise.
