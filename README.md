![SafeRide banner](./saferide-banner.png)

# SafeRide Mobile

[![Public Documentation](https://github.com/esherialabs/saferide/actions/workflows/public-docs.yml/badge.svg)](https://esherialabs.github.io/saferide/)
[![License](https://img.shields.io/badge/code-Apache--2.0-blue.svg)](LICENSE)

*From your pocket, capture, classify, and submit a harassment incident privately and fast.*

SafeRide is an Android-first development prototype that helps women capture evidence, get trauma-informed guidance, and prepare structured reports. The app is designed for offline-first use and explicit consent boundaries. The canonical public repository is open source under Apache-2.0, with separately scoped CC-BY-4.0 content and artifact-specific model/data terms. Publication does not claim production deployment, survivor-facing launch, emergency-service status, partner endorsement, or UNICEF approval.

**Release status:** [SafeRide 1.0.4 Android Preview (build 26)](https://saferide.esheria.org/download/) is a public testing preview. Its signed APK, SHA-256 checksum and signing certificate are published on the download page and in the [release record](web/public/releases/saferide-1.0.4-code26-android.json), which is the source of truth for the current build. Full handset acceptance is still pending, and the record carries no device test. Outside the supervised HURIA pilot, use synthetic reports only. The preview is signed with a different key from the August v0.5.8 preview, so Android will not install one over the other. It is not a production, emergency-service, survivor-facing, Google Play, or UNICEF-approved release. The APK is built from the private source commit named in the release record, not from this snapshot, so the two are not assumed to be byte-for-byte the same code.

Public surfaces:

- Website and APK verification: `https://saferide.esheria.org/download/`
- Open-source repository: `https://github.com/esherialabs/saferide`
- Public documentation: `https://esherialabs.github.io/saferide/`
- v0.5.8 LiteRT-LM model: `https://huggingface.co/esherialabs/saferide-gemma-4-e2b-v058-original-419806-litertlm`

## Mission & Approach

- Deliver trustworthy, trauma-informed support that works in hostile environments with limited connectivity.
- Preserve survivor agency with privacy-by-design features, consent gates, and clear local storage controls.
- Produce route-safety signals from consented map update records without attaching evidence files.
- Run on-device wherever possible, only reaching out to the owned SafeRide API for optional services such as sync, support chat, storage, or catalog refreshes.

## What SafeRide Delivers

- Private evidence capture (audio, video, photo, notes) with supported foreground stealth entry points.
- Guided incident reporting mapped to Kenyan legal frameworks and survivor pathways.
- Support content, statement drafting, and provider/referral workflows with explicit review boundaries.
- Case tracking and escalation tooling that works completely offline and syncs when it can.
- A repository-tested, default-disabled route-safety aggregation foundation for consented, minimized signals.

## Feature Set

### Incident Capture & Reporting
- Supported foreground stealth triggers for audio and image capture while SafeRide is open.
- Guided flow covering evidence intake, what happened, location/time, impact, witnesses, and legal framing.
- Auto-save drafts with resume support and offline queueing for submissions.
- Consent gate that lets survivors choose private save, support referral, map update record, or escalation.

### Safety & Privacy Controls
- Decoy calculator PIN experience that can return SafeRide to a calculator screen.
- Supported foreground triggers include shake and SafeRide logo tap patterns; volume-key, lock-screen, and Quick Settings triggers require native work.
- Configurable quick exit gestures with haptic confirmation.
- Evidence controls save face-blur, metadata-removal, and file-encryption requests; raw media processing is not complete in this Expo build.
- Sensitive draft and workflow records use authenticated encrypted local persistence; index metadata and raw media remain outside that encrypted payload boundary and require separate device review.
- The exact v0.5.8 tuned LiteRT-LM artifact is produced, hash-bound, downloadable in the Android testing preview, and physically observed on one over-8 GB handset. Production activation and the required lower-memory device matrix remain fail-closed.
- SHA-256 hashing and integrity checks for exported bundles.

### Legal & Support Tools
- Trauma-informed support chat with owned SafeRide API history sync and phone-local SafeRide assistant replies in the dedicated Android testing profiles.
- English statement drafting support that keeps summaries editable and reviewable. Kiswahili and Sheng statement generation is not enabled in this release build.
- English tips and rights education for the current build. Kiswahili and Sheng packs are blocked until reviewed language assets and an approved pack model exist.
- Provider-directory and referral workflows are present, but checked-in contacts and remote distribution remain non-actionable pending attributable source review, partner validation, and release attestation.

### Case Management
- Case tracker that merges local drafts with owned API case records.
- Case detail views with timeline events, attachment previews, and offline retry queues.
- Background sync manager that replays failed submissions once connectivity returns.

### Community Insights (Disabled Pending Approval)
- Route-safety signals are transformed to coarse cells on device and exclude narratives, media, and exact coordinates.
- Ingestion, release, export, retention, operator access, and dashboard controls are checked in as disabled.
- Low-count, complementary, triangulation, and differencing protections are repository-tested with synthetic fixtures; production privacy thresholds and approval are absent.

### Localization & Accessibility
- English is the only enabled app language in this release build. Kiswahili and Sheng are listed as unavailable until human-reviewed packs ship.
- Source-level labels, 48dp interaction targets, persisted high contrast, and reduced-motion controls are covered by static and unit gates; physical-device accessibility proof is pending.
- Voice navigation, narrative speech-to-text, and complete motor-accessible alternatives are not current release claims.

## Product Walkthrough

1. **Splash & Onboarding** — Orientation, permissions, and stealth trigger setup.
2. **Home** — Start new reports, resume drafts, access safety settings, and learn content.
3. **Evidence Intake** — Capture or attach media with privacy toggles and redaction guidance.
4. **Incident Details** — Capture narrative, impact, witnesses, and harm classification.
5. **Location & Time** — Coarse GPS or manual entry with accuracy controls.
6. **Legal Framing** — Map to Kenyan statutes, pick offense tags, and understand rights.
7. **Pathway Selection** — Choose private save, map update record, support referral, or escalation.
8. **Consent Gate & Submission** — Confirm sharing choices, trigger sync queue, and export bundles.
9. **Support & Follow-up** — Chat legal aid, statement review, case tracker, tips, and referrals.

## Technical Overview

Android build, versioning, signing and deployment work starts with the
[release playbook](docs/release/android-release-playbook.md).
Use `npm run release:android:check` before producing a candidate. The canonical
website preview and an EAS UI-test APK can have different signers and upgrade
compatibility; build success alone does not update the canonical release.
The current selected path is local Gradle builds and private GitHub Releases
for internal test downloads. See the playbook for draft preparation, immutable
versioned assets, checksums, access requirements and publication readback.

### Mobile App Stack
- React Native 0.85.3 with Expo SDK 56 and TypeScript 6.0.
- React Navigation 7 and React Native Paper 5 for navigation and UI.
- Expo-managed native modules for camera, audio, location, haptics, biometrics, and speech.

### Device & OS Integrations
- `expo-audio`, `expo-image-picker`, and `expo-file-system` for media capture and storage.
- `expo-local-authentication` for biometric gating of stealth mode.
- `expo-location`, `expo-network`, and `@react-native-community/netinfo` for context-aware features.
- `expo-haptics` and `expo-speech` for accessibility feedback.

### Data, Storage & Offline Sync
- Encrypted SQLite-backed persistence for sensitive drafts, queues, chat caches, and workflow state; AsyncStorage remains only for non-sensitive or migration-compatible state.
- SecureStore for sensitive tokens, decoy PINs, and stealth mode settings.
- Expo FileSystem for evidence blobs retained locally unless exported.
- Deterministic offline queue (`src/utils/offlineSync.ts`) that batches draft CRUD and case submissions.
- Transactional, resumable migrations move legacy draft formats into authenticated encrypted persistence.

### Backend & AI Services
- SafeRide API owns authentication boundaries, Postgres access, evidence storage signing, catalog reads, drafts, cases, chat, and audit events.
- Local Postgres, MinIO, Redis, local auth, API, WebSocket gateway, Prometheus, and Grafana run through `infra/local/docker-compose.yml`.
- Catalog, draft, case, and chat services (`src/services/*`) talk to the owned API with local cache/offline fallbacks where appropriate.
- Server-side schema and seed data live under the canonical owned migrations in `infra/postgres/migrations`; local Docker and AWS staging use the same files.

### On-Device AI Assistant
- SafeRide resolves `EXPO_PUBLIC_LOCAL_ASSISTANT_MODEL_ID` to the Gemma 4 E2B LiteRT-LM target, `litert-community/gemma-4-E2B-it-litert-lm`.
- Dedicated `android-release-apk` and `android-internal-ai` profiles bind the verified v0.5.8 manifest, checksum, LiteRT-LM 0.16.0 native bridge, and real runtime. Generic prerelease and production profiles still disable the tuned model.
- Qwen, Gemma 2, Gemma 3n, and GGUF entries are legacy development/runtime-test targets only and are not silent release fallbacks. Legal/offence-tag behavior must stay within reviewed catalog boundaries and is not legal advice.

### Security & Safeguards
- Local-first architecture: drafts stay local unless export, share, or submit is chosen through consent.
- Server-side authorization checks on all API-owned user data.
- Evidence uploads use signed MinIO/S3-compatible URLs, server-side metadata records, and hash verification.
- No advertising IDs are used. Precise GPS is not captured by default; coarse or saved location is included only when allowed.

## Local Development

The signed APK on the canonical download page is offered only as a public testing preview, as described in its release record. Building another artifact, publishing the AAB, submitting to a store, or promoting production still requires the release gates in `config/release/release-controls.v1.json` and explicit owner authority.

### Development Environment
**Prerequisites**
- Node.js 24.18.1 and npm 11.16.0
- Expo CLI (`npm install -g expo-cli`)
- Git
- Android Studio or an Android device (USB debugging enabled); iOS simulator optional
- Docker Desktop for the owned local backend

**Steps**
1. Clone the repository and change into it:
   ```bash
   git clone https://github.com/esherialabs/saferide.git
   cd saferide
   ```
2. Install dependencies:
   ```bash
   npm ci
   ```
3. Create local env files from the template:
   ```bash
   cp .env.example .env.local
   cp .env.example .env.development
   ```
   Populate the required `EXPO_PUBLIC_*` values locally. Do not commit these files.
4. Start the owned local migration stack:
   ```bash
   cp infra/local/.env.example infra/local/.env
   npm --prefix apps/api ci
   npm run local:up
   ```
   This starts local Postgres, MinIO, Redis, local auth, the SafeRide API, the WebSocket gateway, Prometheus, and Grafana. See `docs/migration/local-setup.md`.
5. Start the Expo development server:
   ```bash
   npm start
   # or
   expo start
   ```
6. Launch on your target platform:
   ```bash
   npm run android    # Android emulator or device
   npm run ios        # iOS simulator (requires macOS)
   npm run web        # Local visual QA preview only
   ```
7. In the app, sign in from the auth screen. The client points to the configured owned local services; if the API is offline, local draft-only flows remain available.

**Expo web preview:** SafeRide remains Android-first. Web preview is supported as a local visual QA aid for layout/navigation checks, not as a product or release target. Use the same public `EXPO_PUBLIC_*` values as local Expo development, set `EXPO_PUBLIC_LOCAL_ASSISTANT_ENABLED=false` and `EXPO_PUBLIC_LOCAL_ASSISTANT_PREFER_ON_DEVICE=false` in `.env.local` for web preview runs, then run `npm run web`. Native behavior such as Android permissions, SecureStore, media capture, offline replay after process restart, quick exit, and EAS artifacts still requires device QA.

**On-device local assistant:** Chat does not use a backend assistant in the Android testing preview. The `android-release-apk` and `android-internal-ai` profiles use the exact v0.5.8 manifest and LiteRT-LM runtime; generic prerelease and production profiles fail closed with local AI disabled. Qwen, Gemma 2, Gemma 3n, and GGUF entries remain retired or development-only aliases in `src/lib/localAssistant/modelRegistry.ts`.

**Headless usage:** Without the local API, the app continues bounded draft-only offline operation using the encrypted local store and local evidence files. Update ignored env files only for an authorized local or test environment.

## Configuration Reference

- `app.config.js` loads ignored local env files and passes validated runtime values through Expo `extra`.
- `src/config/env.ts` is the typed runtime source of truth. Missing required env values fail startup.
- `src/config/appConfig.ts` resolves API, auth, websocket, storage, and remote config settings from `src/config/env.ts`.
- `src/config/runtime/runtimeConfigStore.ts` can hydrate remote endpoint overrides so future local/staging/production switching does not require an app rebuild.
- Local owned-infrastructure migration docs live in `docs/migration/`.
- Additional context on backend integration, schema design, and operations lives in `docs/migration/`.

## Development Architecture

```
src/
├── components/        # Reusable UI primitives, dialogs, form controls, toasts
├── config/            # Runtime configuration helpers (API, auth, websocket, storage)
├── context/           # App-wide providers (Auth, Online, Onboarding)
├── hooks/             # Shared React hooks
├── lib/               # Core clients (catalog, auth storage adapters, HTTP)
│   └── localAssistant/ # Local SafeRide assistant runtime (model registry, storage, llama.rn wrapper)
├── navigation/        # Navigators, route definitions, deep link handling
├── screens/           # Screen implementations for the incident flow, chat, settings, learn
├── services/          # Domain logic for drafts, cases, chat and offline coordination
├── theme/             # Theming system and typography tokens
├── types/             # Shared TypeScript types and enums
└── utils/             # Cross-cutting utilities (offline sync, decoy PIN, quick exit, exports)
```

Additional roots of note:
- `App.tsx` boots providers, migrations, and the root navigator.
- `index.ts` ties into Expo entry points.
- `assets/` holds icons and splash screens. Reviewed localization bundles are not present in this release branch.
- `apps/api/` contains the owned API, repositories, routes, metrics, and WebSocket gateway.
- `infra/local/` contains the local Postgres, object storage, auth, cache, and observability stack.
- `Saferide_Design_Style_System.md` documents design decisions.
- APK/AAB and model binaries remain outside source commits. New internal-test APK downloads use private GitHub Release assets after local Gradle builds. The published August APK remains on the versioned website and public GitHub preview release; the AAB stays private and the model stays on Hugging Face.

## Privacy & Safeguarding

- Local-first design keeps drafts on-device unless a survivor chooses export, share, or submit through consent.
- Granular consent gates and explicit export steps guard sharing paths; independent device/privacy review remains required.
- Route-safety records use coarse or saved location fields when allowed; media metadata stripping is not complete in this Expo build.
- Code, content, models, datasets, evaluation assets, third-party media, and trademarks have explicit separate boundaries. Public code is Apache-2.0; enumerated original content is CC-BY-4.0; frozen v0.5.8 model/data terms are recorded in `MODEL-DATA-LICENSES.md`. Public testing of the signed APK does not authorize production or survivor-facing use.

## Quality & Testing

- Root regression tests run with Vitest:
  ```bash
  npm test
  ```
- Run `npm run coverage:check:public` for the public 15 percent global and 80 percent critical-module gates. Private release integration adds the restricted-evidence Node gate through `npm run coverage:check`.
- Run `npm run release:validators`, `npm run security:audit:high`, and `npm run sbom:check` for repository release evidence.
- `npm run release:evidence:check` validates the blocked evidence structure; `npm run release:evidence:release-check` must fail until every external release gate is real and current.
- Manual end-to-end testing prioritized on low-cost Android hardware (2–3GB RAM).
- Accessibility checks with TalkBack, high-contrast mode, and large text scaling.
- Performance and usability targets are acceptance goals, not established field or participant results.
- Security reviews include dependency scanning, API authorization validation, and incident response planning.

## Verification

GitHub Actions is currently unavailable for this organisation (billing lock), so the
required checks ("Typecheck, Test, Coverage, Public Safety" and "Reproducible Source
Archive") are run on the maintainers' server and posted as commit statuses, with an
evidence file you can check yourself. See
[local verification](docs/open-source/local-verification.md); run the gates locally with
`npm run verify:public -- --snapshot . --out ../saferide-verify`.

## Contributing

- Public issues and pull requests are welcome. Start with `CONTRIBUTING.md` and
  the [SafeRide Open Source Roadmap](https://github.com/orgs/esherialabs/projects/3).
- Preserve the offline-first and explicit-consent contracts; never use or log
  real survivor information.
- Use synthetic fixtures and include focused verification for behavior changes.
- Security vulnerabilities must use the private channel in `SECURITY.md`.

## License

The canonical public repository code is licensed under Apache-2.0. Enumerated original documentation, educational content, and guardrails are CC-BY-4.0. Models, datasets, media, fonts, and trademarks retain their separate terms. See `OPEN_SOURCE.md`, `CONTENT-LICENSE.md`, `MODEL-DATA-LICENSES.md`, `ASSET-LICENSES.md`, and `TRADEMARKS.md`.

The private full-history integration repository remains restricted and is not
relicensed by the clean public snapshot.

## Support & Resources

- Design system reference: `Saferide_Design_Style_System.md`
- Backend integration guide: `docs/migration/`
- English tips and rights assets: `Tips and legal aid.png`; reviewed localized packs are not present or enabled in this release branch.
- For public model/dataset maintenance or security disclosures, contact Franklin Sagini at `sagini@esheria.ai`.

**SafeRide** — empowering safer journeys through technology, privacy, and community action.
