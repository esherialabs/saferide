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

## Documentation checks

```bash
npm run docs:public:check
```

Checks the Markdown under `docs/open-source/` and the static site in
`docs/open-source/site/` for broken internal links, link text that says nothing
out of context, and four page-level accessibility regressions: exactly one
`main` landmark, a non-empty `<title>`, a `lang` on `<html>`, and an `alt` on
every image.

It runs offline. Every rule is decided from files in the checkout, so external
URLs, `mailto:` links and same-page anchors are deliberately not resolved --
a gate that needs the network is a gate that fails for reasons unrelated to
the change under review.

The same command runs in `.github/workflows/public-docs.yml` before the site is
assembled, so a broken link stops the deploy rather than shipping.

To check a directory other than the repository root:

```bash
node scripts/saferide-public-docs-check.mjs --root path/to/tree
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
