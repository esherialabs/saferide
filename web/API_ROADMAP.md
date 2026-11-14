# SafeRide First-Party API Roadmap

> **Status (1 Nov 2026):** historical note. The first-party SafeRide API is live and the HURIA pilot runs on it; text below describing a Supabase prototype or a planned API is out of date.

This is a documentation-only planning note. The current branch does not change the mobile app, Supabase client, migrations, Edge Functions, or runtime behaviour.

## Current State

The repository currently documents and implements a Supabase prototype:

- Auth context and anonymous user flow in the mobile app.
- Tables for profiles, providers, legal tags, tips, drafts, cases, case events, attachments, chat sessions, and chat messages.
- Private evidence storage bucket policies under owner-scoped paths.
- `legal-chat` Edge Function wrapping remote assistant calls.
- Offline fallback and retry behaviour in mobile services and utilities.

Known limitations are captured in `SUPABASE_HANDOFF.md`: production auth, moderation, evidence encryption, RLS regression tests, CI typing debt, observability, and secret handling need hardening.

## Target Direction

Move sensitive production workflows to a first-party SafeRide API that preserves local-first product behaviour while giving the team direct control over security, retention, observability, and partner integrations.

## API Domains To Specify

- **Identity:** sign-in, account recovery, device sessions, anonymous/pseudonymous modes, partner/admin roles.
- **Catalog:** public providers, legal tags, tips, source metadata, localization, review status, and cache invalidation.
- **Draft Sync:** optional encrypted draft backup, conflict resolution, retry queues, deletion, and audit-safe metadata.
- **Cases:** submitted cases, status changes, timeline events, redaction state, partner handoffs, and deletion requests.
- **Evidence:** signed uploads/downloads, client-side encryption strategy, checksum verification, retention windows, and secure deletion.
- **Route Safety:** anonymous map updates, aggregation thresholds, geohash/coarse-location policy, and dashboard outputs.
- **Assistant:** on-device-first orchestration, remote fallback, moderation, rate limiting, source logging, and no incident-content analytics.
- **Notifications:** safe status updates, partner response events, and opt-in communication channels.

## Non-Negotiables

- The app must still start and save private drafts without a network connection.
- No endpoint should require raw survivor evidence unless the user selected a pathway that explicitly shares it.
- Logs, traces, analytics, and error reports must never store incident narratives, evidence files, exact survivor journeys, or private contact details.
- Delete and retention flows must cover database rows, object storage, derived indexes, partner queues, and backups.
- Access controls must meet or exceed the Supabase RLS intent documented in the prototype schema.

## Migration Workstream

1. Produce an API contract from the current Supabase schema and mobile service interfaces.
2. Threat-model survivor, partner, admin, attacker-with-device, and compromised-token scenarios.
3. Decide encryption boundaries for drafts, evidence, chat, and case packets.
4. Build staging API endpoints behind feature flags while keeping Supabase paths intact.
5. Add integration tests for ownership, negative access, retention, deletion, and offline retry.
6. Migrate catalog content first, then cases/evidence only after safeguarding and privacy sign-off.
7. Remove Supabase runtime dependencies only in a dedicated app/API migration PR.

## Website Messaging Rule

Until implementation lands, public website copy should say “planned first-party API” or “backend roadmap,” not “production API live.”
