# SafeRide Website Repo Audit

> **Status (1 Nov 2026):** historical note. The first-party SafeRide API is live and the HURIA pilot runs on it; text below describing a Supabase prototype or a planned API is out of date.

Audit date: 2026-05-22.

## Sources Reviewed

- `README.md` for mission, feature set, product walkthrough, technical overview, privacy safeguards, and APK link.
- `src/screens/` for implemented mobile flows: onboarding, home, evidence, incident details, legal framing, pathway selection, consent, referrals, escalation, case tracking, settings, privacy, and chat.
- `src/utils/draftStorage.ts`, `src/utils/dataExport.ts`, `src/utils/decoyPin.ts`, and `src/utils/quickExit.ts` for local draft structure, export integrity, decoy mode, and quick-exit controls.
- `assets/data/tips.json`, `assets/data/providers.json`, and `assets/data/legal_tags.json` for local legal/support content counts and categories.
- `src/lib/localAssistant/modelRegistry.ts` and `src/screens/ChatLegalAid.tsx` for on-device Gemma configuration and assistant UX.
- `SUPABASE_HANDOFF.md` and `supabase/` for prototype backend schema, known limitations, and next steps.
- `web/src/` for existing website structure, routes, launch checklist, and image references.

## Repo Facts Now Reflected On The Website

- SafeRide is Android-first and local-first: users can begin with a local draft instead of a forced upload.
- The app’s reporting flow is broader than the old website copy: evidence, What Happened, Where/When, Legal Framing, Pathway Selection, Consent Gate, Referral Picker, Escalation Form, Statement Review, and Case Tracker all appear in the app code.
- The product has four pathway options: save privately, anonymous map update, referral, and escalation.
- Local data packs include 20 tips/rights cards, 15 legal tags, and 5 provider seed records.
- Survivor controls include retention choices, export, local encrypted backup concepts, two-step delete confirmation, redaction levels, decoy calculator PIN, app masking, and quick exit.
- On-device Gemma work is configured for guidance, audio transcription, and offence tagging, with model files/checksums and a survivor-centred prompt.
- Supabase is the prototype backend, with documented limitations around auth, moderation, evidence encryption, RLS regression testing, CI debt, and observability.

## Documentation-Only Backend Direction

The product direction is to move from Supabase to a first-party SafeRide API. This audit only updates website/docs language. It does not change `src/services/*`, `src/lib/supabaseClient.ts`, Supabase migrations, Edge Functions, app configuration, or runtime behaviour.

The future API workstream should cover:

- Auth and account recovery appropriate for high-sensitivity GBV workflows.
- Draft, case, attachment, chat, provider, tip, and legal-tag API contracts.
- Evidence encryption, signed upload/download, retention, deletion, and audit logs.
- Moderation/rate limiting for assistant flows.
- Observability that never logs survivor incident content.
- Access-control parity with the Supabase prototype’s RLS intent.
- Migration strategy for existing prototype data, if any production-adjacent data exists.

## Website Changes Driven By The Audit

- Homepage copy now emphasizes local drafts, consent, four pathways, local content packs, on-device Gemma scope, and first-party API direction.
- Interior pages now use repo-backed details instead of generic launch copy.
- `/blog` now renders concrete audit/update notes from `SITE.updates`.
- `/download` now includes the README APK link, install checklist, and pilot caveats.
- `web/IMAGE_PROMPTS.md` now lists every missing image asset with prompts, sizes, negative prompts, and safety guardrails.

## Remaining Content Risks

- Legal/medical copy from local tips still needs expert review before public campaign use.
- Public impact claims should remain pilot questions until real field measurements exist.
- Image assets must avoid implying emergency rescue, legal representation, police response, or real survivor stories.
- The first-party API migration needs a dedicated architecture document and implementation PR before the website can claim production backend readiness.
