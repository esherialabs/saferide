# Contributing to SafeRide

Thank you for helping improve SafeRide. The project welcomes public issues,
documentation changes, tests, accessibility work, and focused code
contributions through `https://github.com/esherialabs/saferide`.

SafeRide handles unusually sensitive safety, evidence, and location workflows.
Protecting people takes priority over convenience or speed.

## Before you contribute

- Read `CODE_OF_CONDUCT.md`, `SECURITY.md`, `GOVERNANCE.md`, and
  `docs/open-source/restricted-material.md`.
- Search existing issues and the public project board before opening a new one.
- Use synthetic examples only. Never submit survivor or participant details,
  evidence, exact private locations, credentials, raw prompts/completions,
  private security findings, consent/event logs, or partner-confidential data.
- Report vulnerabilities privately through GitHub Security Advisories rather
  than a public issue.
- Keep capability and privacy wording truthful. Do not solve implementation
  gaps by weakening warnings or making unsupported readiness claims.

## Development setup

```bash
git clone https://github.com/esherialabs/saferide.git
cd saferide
npm ci
npm --prefix apps/api ci
cp .env.example .env.local
cp infra/local/.env.example infra/local/.env
npx tsc --noEmit
npm --prefix apps/api run typecheck
npm test
```

The local stack is described in `docs/migration/local-setup.md`. Do not use
production credentials or real records in development.

## Issues

Use the supplied issue forms. A good issue states the affected public revision,
uses a synthetic reproduction, defines expected behavior, and identifies any
safety, privacy, accessibility, or compatibility impact.

Issues suitable for new contributors carry the `good first issue` label. A
maintainer may reserve an issue before substantial work begins.

## Pull requests

1. Fork the public repository and branch from `main`.
2. Keep the change focused on one public issue.
3. Add or update tests and public documentation where behavior changes.
4. Run the smallest relevant checks, plus:

   ```bash
   npx tsc --noEmit
   npm --prefix apps/api run typecheck
   npm run secrets:scan
   npm test
   ```

5. Optionally run the full public gates before you open the pull request
   (Node 24.18.1, npm 11.16.0; takes several minutes and needs a quiet machine):

   ```bash
   npm run verify:public -- --snapshot . --out ../saferide-verify
   ```

   Paste `../saferide-verify/public-verify-summary.md` into the pull request if you like; it is self-reported and helps reviewers, but it is not proof (maintainers re-run the gates).
6. Include behavior, safety/privacy impact, verification, limitations, and
   rollback notes in the pull request.
7. Add a `Signed-off-by:` line using `git commit -s` to certify the Developer
   Certificate of Origin 1.1.

### How pull requests are verified

GitHub Actions is unavailable for the organisation (billing lock), so GitHub will not
show a green check on its own. After a maintainer has read your diff, they run the
same checks on the maintainers' server (`npm run verify:public:pr -- <number>`) and
post the two required statuses on your pull request head, together with an evidence
file. Those steps are manual, so verification can take a little longer than hosted CI.
If you push again, the statuses must be posted again for the new head. Your code is
treated as untrusted: it runs in a sandbox with no tokens, a private home directory and no network except the dependency install (audit data is fetched by the maintainers' runner). Details:
`docs/open-source/local-verification.md`.

Release, model, privacy, security, and safeguarding changes require the
independent reviews described in `GOVERNANCE.md`. Maintainers may port an
accepted public contribution into the private release-integration repository
before it appears in the next generated public snapshot.

## Contribution license

Unless marked “Not a Contribution,” code intentionally submitted for inclusion
is licensed under Apache-2.0 under section 5 of that license. Original public
documentation and content contributions are licensed under CC-BY-4.0. No
contribution grants rights to trademarks or restricted material.
