# SafeRide Website Launch Readiness Checklist

> **Status (1 Nov 2026):** historical note. The first-party SafeRide API is live and the HURIA pilot runs on it; text below describing a Supabase prototype or a planned API is out of date.

This checklist tracks the implementation state for the SafeRide Public Website Launch project.

## Verified In This Branch

- Homepage implements the Mozilla Foundation-inspired editorial structure: sticky white navigation, accordion hero, editorial pillar cards, impact band, community spotlight, CTA, and footer.
- Public routes render concrete content for `/what-we-do`, `/how-it-works`, `/for-survivors`, `/open-source`, `/partner-dashboard`, `/partners`, `/story`, `/impact`, and `/privacy-safety-trust`.
- Website copy has been re-audited against repo evidence: `README.md`, mobile screens in `src/screens/`, local data packs in `assets/data/`, `src/lib/localAssistant/modelRegistry.ts`, `SUPABASE_HANDOFF.md`, and the current Next.js site.
- `/blog` and `/download` now render launch-specific content instead of generic `Coming soon` stubs.
- Route stubs have been removed from launch-critical pages; Playwright checks assert these pages do not show `Coming soon`.
- SEO basics exist through page-level metadata, `sitemap.xml`, `robots.txt`, Open Graph/Twitter defaults, and canonical site configuration.
- Accessibility basics are covered by a single homepage `h1`, skip link, keyboard-reachable navigation controls, semantic headings, alt-safe decorative treatment, and mobile overflow checks.
- The partner page includes a direct inquiry CTA using `mailto:pilot@esherialabs.com` until a production form backend is approved.

## Launch Smoke Tests

Run before public review:

```bash
npm --prefix web run lint
npm --prefix web run build
npm --prefix web exec playwright test
```

The Playwright suite covers route availability, homepage structure, mobile overflow, `sitemap.xml`, `robots.txt`, CSP header presence, single homepage `h1`, and launch-page completion checks.

## Explicit Non-Claims

- No production analytics are enabled in this branch.
- No contact form stores data yet; partner inquiry uses email to avoid collecting sensitive content without a reviewed backend.
- No public page claims SafeRide replaces emergency services, police, lawyers, clinics, or psychosocial support providers.
- Supabase remains the documented prototype backend in the repo. The public site now documents the intended move to a first-party SafeRide API, but this branch intentionally makes no app or backend implementation changes for that migration.
- Real Nairobi field photography and approved device screenshots should replace illustrative launch visuals before broader public campaign use.

## Required Pre-Launch Approvals

- Safeguarding/content review for survivor-facing claims and language.
- Privacy review for data lifecycle, retention, evidence handling, and analytics decisions.
- Partner/referral review before listing any real service providers.
- Product owner review for APK availability, pilot eligibility, and partner inquiry routing.

## Remaining Launch Risks

- Dedicated form backend, spam protection, and data destination are intentionally deferred until privacy review is complete.
- Some route content is editorially complete but still needs final field evidence and approved imagery.
- Public impact metrics should remain framed as pilot targets or validation questions until measured in deployment.
- The first-party API migration needs its own architecture/specification workstream covering authentication, encrypted evidence, retention/deletion, moderation, observability, and access-control parity with the Supabase prototype.
