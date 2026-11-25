# SafeRide public documentation

This is the entry point for building, reviewing, and contributing to SafeRide.
The canonical repository is `https://github.com/esherialabs/saferide` and the
canonical Android download page is `https://saferide.esheria.org/download/`.

## Documentation map

- `architecture.md` — mobile, API, local infrastructure, website, and on-device
  AI boundaries.
- `build-and-test.md` — repeatable local setup, typechecking, tests, coverage,
  and public-repository validation.
- `reproducible-builds.md` — deterministic source bundles, checksums, tagged
  releases, and Android artifact verification.
- `restricted-material.md` — what must never enter public issues, fixtures,
  commits, logs, or release assets.
- `community-roadmap.md` — issue labels, project-board workflow, release
  milestones, and good-first-issue expectations.
- `local-verification.md` — how the required checks run without GitHub Actions,
  the evidence file, and how to reproduce a result.
- `../migration/local-setup.md` — owned local API, Postgres, MinIO, Redis, auth,
  and observability stack.
- `../../CONTRIBUTING.md` — public contribution process.
- `../../SECURITY.md` — private vulnerability reporting.

## Current release posture

SafeRide v0.5.8 is an Android controlled-testing preview. It has physical-device
evidence for model download, pause/resume, verification, restart persistence,
and synthetic chat on one arm64 device. It is not a production,
survivor-facing, emergency-service, Google Play, or UNICEF-approved release.

Use synthetic data for every development, test, issue, and demonstration flow.
