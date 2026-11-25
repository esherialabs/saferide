# SafeRide public repository boundary

The canonical open-source repository is:

`https://github.com/esherialabs/saferide`

It is published as a clean, reviewed snapshot from the private SafeRide
release-integration repository. The public repository is authoritative for
community documentation, issues, project planning, pull requests, tags, and
open-source releases; private Git history is not part of the publication.

## Included

- Android/iOS mobile source and tests;
- owned API and local development infrastructure;
- the SafeRide website;
- public-safe model training, evaluation, manifest, and release scripts;
- schemas, synthetic/public-safe fixtures, documentation, and governance;
- public CI, coverage, source-provenance, and reproducible-build tooling.

## Excluded

- signing keys, keystores, credentials, ignored environment files, and private
  release-bucket records;
- real survivor/participant records, evidence, exact locations, consent/event
  logs, telemetry, or production payloads;
- partner agreements, risk/incident registers, restricted security evidence,
  private red-team material, and UNICEF submission records;
- production cloud infrastructure and account-specific operational records;
- model binaries, APK/AAB/IPA files, and large datasets stored in their
  separately governed release systems.

The generator records the private source commit, selected file count, byte
count, publication policy, and SHA-256 ledger. The public `LICENSE` and `NOTICE`
are substituted only into the clean snapshot; the restricted private
repository remains all rights reserved.

## Verification and publication procedure

GitHub Actions is unavailable for the organisation, so the two required checks are
run by `scripts/public-verify.mjs` on the maintainers' server (see
`docs/open-source/local-verification.md`). A refresh is published in this order:
merge the pending fixes privately; rebuild the snapshot from `main` (no
`--allow-non-main`); run `npm run verify:public -- --snapshot <snapshot>`; commit the
snapshot on a branch of the public repository and open a pull request with the
evidence attached; get one approving review from someone other than the author; post
the two statuses on the pull request head; merge with a merge commit; restore the
branch protection; record the public commit in the private release docs.

See `OPEN_SOURCE.md`, `CONTENT-LICENSE.md`, `MODEL-DATA-LICENSES.md`,
`ASSET-LICENSES.md`, and `TRADEMARKS.md` for the complete rights boundary.

The canonical Android download page is:
`https://saferide.esheria.org/download/`.
