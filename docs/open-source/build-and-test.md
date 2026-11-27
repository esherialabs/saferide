# Build, test, and coverage

## Toolchain

The repository pins Node and Python versions in `.nvmrc` and
`.python-version`. Use the npm version recorded in the release manifest and CI.
Android builds additionally require the JDK, Android SDK, NDK, and CMake
versions named by the Android release workflow.

## Install

```bash
git clone https://github.com/esherialabs/saferide.git
cd saferide
npm ci
npm --prefix apps/api ci
```

Create local environment files from the checked-in examples. Never copy
production values into a public workspace.

```bash
cp .env.example .env.local
cp infra/local/.env.example infra/local/.env
```

## Smallest verification set

```bash
npx tsc --noEmit
npm --prefix apps/api run typecheck
npm run secrets:scan
npm test
```

## Coverage gates

```bash
npm run coverage:check:public
```

The checked-in policy requires at least 15% global branch/function/line/
statement coverage and at least 80% per-file coverage for named critical
privacy and safety modules. CI uploads the LCOV and JSON summaries as public
workflow artifacts. The current dated summary is stored in
`docs/open-source/evidence/coverage-report-2026-08-18.md` with a machine-readable
JSON companion.

The private release-integration repository additionally runs
`npm run test:coverage:critical:node` against restricted UNICEF evidence
contracts. Those records are deliberately not copied into the public snapshot.

### Human-readable summary

After a coverage run, render both summaries as a Markdown table:

```bash
npm run coverage:summary
```

It reads `coverage/all-source/coverage-summary.json` and
`coverage/critical-safety-privacy/coverage-summary.json`, and writes statements,
branches, functions and lines with covered/total counts and percentages to
stdout. Redirect it into a dated evidence file when refreshing
`docs/open-source/evidence/`.

The output is deterministic: fixed metric order and two-decimal percentages, so
two runs over the same input diff cleanly. The generator only reports -- it
asserts no threshold and does not affect the 15% global or 80% critical gates.
It exits 1 with the offending path if a summary is missing or malformed.

## Public snapshot verification

Maintainers generate and validate the clean snapshot outside the private
repository:

```bash
npm run public:mirror:build -- --out /tmp/saferide-public-release
node scripts/validate-public-repository.mjs --root /tmp/saferide-public-release
```

The validator checks required community files, the Apache license, canonical
URLs, restricted path/extension exclusions, and the generated SHA-256 ledger.

## Platform notes

Expo web is a layout and navigation QA aid, not the released product. Native
permissions, encrypted device persistence, media capture, model lifecycle, and
upgrade testing require Android hardware. iOS sources are included for ongoing
Swift/runtime integration but are not a released SafeRide target yet.
