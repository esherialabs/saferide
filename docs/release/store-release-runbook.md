# SafeRide Store Release Runbook

Issue: ESH-3994
Current Android entry point: [release/deployment playbook](android-release-playbook.md).
It reconstructs the local externally signed August release, separates version
and signing lineages, and supplies the mandatory artifact consistency gate.
Historical target: `feat/app-local-infra-phase-1`. Resolve current source base
and actual PR target under root `AGENTS.md` and current human instructions.

This runbook coordinates SafeRide store-managed distribution. It does not approve a release, start an EAS build, submit to any store, deploy AWS, publish EAS Update, or replace survivor-safety review.

## Release Boundaries

SafeRide handles survivor reports, evidence, location data, chat history, and release artifacts. Treat every candidate as sensitive.

- Verify the private saferide-internal repository/remote, source base ref/SHA,
  scoped implementation branch, and actual PR target separately.
- Internal `main` is eligible as a verified source base or reviewed PR target.
  Verify required dependencies and reconcile missing migration work before
  integration; do not commit or push implementation directly to shared targets.
- A reviewed PR merge does not authorize a build, store submission, deployment,
  or rollout. Existing release/artifact approval gates still apply.
- Keep implementation branches named `codex/esh-<issue-number>-<short-slug>`.
- Do not run EAS builds, EAS submits, AWS deploys, Docker resets, OTA publishes, or rollout changes without matching direct human authorization.
- Do not paste secrets, private env values, credentials, connection strings, keystores, provisioning profiles, passwords, tokens, or private EAS/AWS values into docs, comments, PRs, or logs.
- Record evidence without survivor narratives, evidence contents, raw location traces, or full request/response payloads.

## Distribution Paths

| Path | Purpose | Artifact | Store-managed? | Approval needed |
| --- | --- | --- | --- | --- |
| Tuned-model release APK | Direct install and device QA before store upload | Android APK from `android-release-apk` profile | No | Yes, before build |
| Google Play tuned-model internal testing | Internal tester distribution through Play Console | Android AAB from `android-internal-ai` profile | Yes | Yes, before build and submit |
| Google Play closed/open/production | Wider Android rollout after internal evidence passes | Promoted AAB release | Yes | Yes, release-owner decision |
| iOS TestFlight | Internal/external iOS testing through App Store Connect | iOS archive from `production` or approved iOS profile | Yes | Yes, before build and submit |
| App Store production | Public iOS release | Promoted App Store build | Yes | Yes, release-owner decision |
| EAS Update | OTA JavaScript/native-compatible update | Update group/channel | Managed by EAS, not app stores | Yes, plus code-signing or risk gate for production |

Do not upload preview APKs to Google Play. Store testing must use store-suitable artifacts and the approved app identity.

## Preflight

Run these from a clean issue branch before requesting any build or submit approval:

```bash
git remote -v
git fetch <verified-private-remote>
git branch --show-current
git status --short --branch
test -f apps/api/package.json
test -f infra/local/docker-compose.yml
test -f docs/migration/architecture.md
npm run release:preflight
npm test
npx tsc --noEmit
npm --prefix apps/api run typecheck
npm run secrets:scan
git diff --check
```

Run Expo readiness with the approved public release-like Expo environment already configured in the shell or EAS environment. Do not print those values:

```bash
npx expo-doctor
```

If `expo-doctor` reports SDK patch drift, fix it or document the exact drift in the handoff before requesting a store artifact.

Only run the remote smoke gate after release owners confirm AWS staging is deployed from the selected release head:

```bash
npm run release:preflight:smoke
```

The `Mobile Release Preflight` GitHub workflow can run the release config/source
gate from a PR or manual dispatch. It does not run EAS Build, EAS Submit, or EAS
Update publish commands.

## Version And Identity Gate

Before any store artifact request, record:

- Branch and commit SHA.
- App version and platform build numbers.
- Android package name.
- iOS bundle identifier.
- EAS project ID and owner.
- EAS profile.
- Runtime environment family, without printing private values.
- Whether local assistant is enabled and which reviewed model id is configured.
- Whether Azure/OpenAI direct client access is disabled for the candidate.

Review identity/version/build-number changes under the existing assigned
release issue and human authorization. A new issue is not required merely to
continue that work. Version-code increments do not isolate native OTA runtimes.

## Build Approval Wording

Use direct human authorization for the concrete build/source/profile:

```text
Approved to run an Android APK build for SafeRide from verified private branch <approved-source-ref> at commit <sha>, profile android-release-apk, for direct install QA only.
```

```text
Approved to run an Android AAB build for SafeRide from verified private branch <approved-source-ref> at commit <sha>, profile android-internal-ai, for Google Play internal testing only.
```

```text
Approved to run EAS iOS build for SafeRide from verified private branch <approved-source-ref> at commit <sha>, profile <profile>, for TestFlight only.
```

These are examples, not mandatory phrases. Direct human authorization in the
current chat or issue is sufficient within its recorded scope. Reuse existing
authorization; prepare concrete reviewable work before requesting a missing
release decision.

## Build Commands

Run only within matching direct human authorization recorded in the chat or issue.

Tuned-model APK for direct install QA:

```bash
npm run release:preflight
eas build --platform android --profile android-release-apk
```

Android AAB for Google Play internal testing:

```bash
npm run release:preflight:smoke
eas build --platform android --profile android-internal-ai
```

iOS build for TestFlight:

```bash
npm run release:preflight:smoke
eas build --platform ios --profile production
```

If a build starts from a source branch/commit outside its recorded release approval, stale runtime config, private/local endpoints, Supabase endpoints, or an unapproved profile, stop and mark the issue blocked. Internal `main` is not disqualified by its name; release approval must cover the exact source and artifact inputs.

## Submit Approval Wording

Build approval does not authorize store submission. Use separate approval before running submit commands:

```text
Approved to submit Android build <build-id> for SafeRide to Google Play internal testing from verified private branch <approved-source-ref> at commit <sha>.
```

```text
Approved to submit iOS build <build-id> for SafeRide to TestFlight from verified private branch <approved-source-ref> at commit <sha>.
```

Submit commands after approval only:

```bash
eas submit --platform android --profile android-internal-ai --id <build-id>
```

```bash
eas submit --platform ios --profile production --id <build-id>
```

Do not submit if store credentials, service-account permissions, bundle/package identity, export compliance, privacy labels, or app access details are missing or uncertain.

## Android Internal Testing

Use Google Play internal testing for store-managed Android validation after the
`android-release-apk` install smoke has passed.

Before Android submit:

- Confirm the AAB build came from the approved branch, commit, and `android-internal-ai` profile.
- Confirm the embedded model ID and tuned manifest match the physically tested
  candidate exactly; generic `prerelease` and `production` remain AI-disabled.
- Confirm the approved verification mode passed. If GitHub Actions remain
  intentionally disabled by owner decision, attach the equivalent local check
  results instead of claiming a CI run.
- Confirm `npm run release:preflight:smoke` passed against the intended staging/production-like backend.
- Confirm Play Console app identity matches the Android package.
- Confirm tester list, release notes, app access instructions, and data safety answers are current.
- Confirm no APK is being uploaded to Play.

After Android submit:

- Record Play track, release name/version code, rollout state, tester group, submitter, timestamp, and review status.
- Install through Play internal testing on at least one real Android device.
- Re-run first launch, onboarding/auth, report draft, evidence, offline queue, chat/local assistant preparation, privacy/delete copy, and quick-exit smoke.
- Keep promotion blocked until release owners review evidence.

## iOS TestFlight

Use TestFlight only after Apple app identity, signing, App Store Connect access, privacy details, and export-compliance answers are ready.
Use `docs/qa/apple-testflight-runbook.md` for the platform-specific setup checklist, approval wording, and submit evidence template.

Before iOS build or submit:

- Confirm the iOS bundle identifier and app record match.
- Confirm Apple Developer/App Store Connect access is available without sharing private credentials.
- Confirm camera, microphone, location, notifications, evidence, and local assistant behavior are accurately represented in review notes and privacy details.
- Confirm no unsupported native capability or OTA policy is implied.

After TestFlight submit:

- Record build ID, bundle version/build number, TestFlight group, submitter, timestamp, processing status, and tester availability.
- Install from TestFlight on a real device before any external tester expansion.
- Capture smoke evidence for onboarding/auth, report draft, evidence permissions, offline recovery, chat/local assistant state, privacy/delete copy, and quick exit where supported.

## Production Promotion

Production promotion requires human release-owner approval after internal evidence passes.

Minimum evidence before promotion:

- Source checks and secret scan passed.
- Expo readiness passed or exact accepted caveat is recorded.
- Store artifact built from approved branch and commit.
- Approved verification mode passed: hosted checks when selected, or the
  owner-authorized local checks and recorded receipts. Do not require re-enabling
  intentionally disabled Actions as the only release path.
- Owned API/runtime-config smoke passed for the intended backend.
- At least one Android internal or TestFlight install smoke passed for the platform being promoted.
- Manual survivor-safety, privacy, evidence, deletion-copy, and quick-exit checks are attached.
- Known caveats and rollback plan are accepted.

Promotion commands or console actions must be performed by an authorized release owner. Agents should not expand rollout, release to production, or change store tracks without explicit approval.

## EAS Update Policy

> **Superseded for now (November 2026):** over-the-air updates are switched off, so the paragraph below describes the earlier configuration. See [eas-update-policy.md](eas-update-policy.md).

EAS Update is configured for newly built binaries through `expo-updates`,
`runtimeVersion.policy=appVersion`, the `preview` channel, and the `production`
channel. See `docs/release/eas-update-policy.md` and
`docs/release/eas-update-runbook.md`.

Do not publish OTA updates, change channels, relink channels, republish update
groups, or run rollout controls without matching direct human authorization.
Production OTA also requires configured/rehearsed code signing or written
release-owner risk acceptance for the specific unsigned update.

EAS Update is only for narrow JavaScript/static asset fixes compatible with the
installed binary runtime. Require a store build for native/config/runtime,
privacy, evidence, auth, storage, offline queue, local assistant, emergency,
provider/referral, and safety-critical changes.

## Rollback Decision Points

Stop rollout expansion and escalate if any of these occur:

- Source branch/commit differs from the recorded release approval, including an
  unapproved change to internal `main` or any other candidate source.
- Runtime config points to localhost, private/LAN hosts, `http`, `ws`, Supabase, or stale backend targets.
- App crashes before onboarding/auth.
- Drafts, evidence records, offline queue, auth state, or local assistant model state are lost or misreported.
- Evidence upload shows success while required files failed.
- Privacy, redaction, encryption, deletion, legal, medical, provider, police, emergency, or AI copy overclaims current behavior.
- Quick exit or decoy unlock strands the user.
- Store review metadata misstates sensitive data collection, permissions, or support workflows.

Rollback levers:

- Halt store rollout expansion or pause the release in the store console.
- Keep the previous approved artifact available where possible.
- Use runtime config only to redirect to an already-approved compatible owned backend.
- Ship a focused recovery build for client-side defects; do not tell users to clear app data as the first response.
- Do not run destructive database or object-storage actions against staging or production from local scripts.

## Evidence Template

Attach this evidence to the relevant Multica issue and PR:

| Field | Value |
| --- | --- |
| Issue | Pending |
| PR | Pending |
| Platform | Pending |
| Distribution path | Pending |
| Branch | Pending |
| Commit SHA | Pending |
| App version/build | Pending |
| EAS profile | Pending |
| EAS build ID | Pending |
| Artifact type | Pending |
| Store submit ID/status | Pending |
| Track/group | Pending |
| Checks run | Pending |
| Device model/OS | Pending |
| Tester | Pending |
| Install result | Pending |
| Smoke result | Pending |
| Caveats | Pending |
| Release-owner decision | Pending |

## Multica Status Rules

- Move the issue to `in_progress` only after the required preflight succeeds.
- Move the issue to `in_review` when the runbook or release artifact PR is ready and verified.
- Move the issue to `done` only after a verified PR merge into its resolved private target and satisfaction of acceptance criteria. Record repository/remote, PR URL, merge time/SHA, checks, and actual target, including internal `main` when selected. A runbook PR alone does not complete an issue requiring release/device evidence.
- Move the issue to `blocked` if approval, credentials, backend readiness, store access, signing, or required verification is missing.
