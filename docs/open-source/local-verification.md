# Local verification (checks without GitHub Actions)

## Why

GitHub Actions is unavailable for the `esherialabs` organisation: every run ends
with "The job was not started because your account is locked due to a billing
issue". The public repository's protected `main` branch requires two status
checks, **Typecheck, Test, Coverage, Public Safety** and **Reproducible Source
Archive**. Until Actions works again, the maintainers run the same checks on
their own server and report them under the same two names. Nothing else about
the review rules changed.

## Trust model

- **Who runs the checks:** the maintainers, on a server they control, using
  `scripts/public-verify.mjs`. This is not GitHub-hosted CI; a status says "the
  maintainers' machine ran these commands and they passed", and the evidence file
  lets anyone check that claim.
- **Where the commands come from:** the script reads the commands out of
  `.github/workflows/public-ci.yml`, so the local gate and the written gate cannot
  drift. A step type it does not understand stops the run instead of being
  skipped.
- **Evidence:** every run writes `public-verify-evidence.json` (plus a Markdown
  summary): the sha256 of the snapshot tree, the git tree id, the source commit
  from `PUBLIC_MIRROR_PROVENANCE.json`, each step's command, exit code, duration
  and log hash, the Node/npm/git versions, the lockfile hashes and the time. The
  file is signed with an SSH signature (namespace `saferide-public-verify`) by a
  dedicated verifier key that stays on the maintainers' server. The matching public
  key is published in `config/release/public-verify-allowed-signers`. The embedded
  sha256 alone proves nothing (anyone can recompute it); the signature is what makes
  a forged or edited file detectable, and it is only as good as the secrecy of that
  key and the honesty of whoever holds it. The evidence is attached to the pull
  request (it is not part of the repository tree).
- **Key handling:** the private key lives outside the repository
  (`$SAFERIDE_STATE_DIR/secrets/` or `~/.config/saferide/`, mode 0600), is created
  once with `--init-signer`, and is never printed. To rotate: run `--init-signer
  --signer-key <new path>`, replace the line in `allowed_signers` through a reviewed
  pull request, and treat evidence signed by the old key as historical. If the key
  may have leaked, rotate first, then re-verify anything still needed.
- **Commit statuses:** after a green run the maintainer posts the two statuses on
  the pull request head. The poster refuses unless the signature is valid against the
  `allowed_signers` file of the maintainers' own tree, every step passed, the run was
  from a clean `main` build of the private repository (or, for a contributor pull
  request, from that exact pinned head), the evidence is fresh, and the commit's git
  tree is exactly the verified tree. The status description carries the evidence hash.
- **Review is unchanged:** one approving review from someone other than the
  author, given after the last push, with conversations resolved.

## Fidelity to hosted CI

Plainly, this is close to the hosted jobs but not identical:

- The snapshot is checked as one synthetic commit with a fixed date, not the real
  history; the reproducible-archive check proves repeatability, and its hash differs
  from the archive of the real merge commit.
- Hosted CI checks the pull request merge commit; this checks the pull request head
  (a refresh snapshot) or the pinned head of a contributor pull request.
- There is no `setup-node` cache and the host's Node and npm are used if they match the
  pinned versions.
- The step commands are read from the workflow file, whose sha256 is pinned in
  `config/release/public-verify-workflow.v1.json`; an unreviewed change to
  `public-ci.yml` stops the run until the pin is updated in a reviewed pull request.
  Job keys other than `name`, `runs-on`, `timeout-minutes` and `steps`, and any
  unknown step key, are refused.

## The gates

Both jobs from `public-ci.yml`, in order (commands are read from that file; the
list below is what it contained when this page was written):

**Typecheck, Test, Coverage, Public Safety**

1. verify Node 24.18.1 and npm 11.16.0 (pinned versions; the host is not changed)
2. `npm ci` and `npm --prefix apps/api ci --ignore-scripts`
3. `npm run public:repository:check` (repository boundary validator)
4. `npm run secrets:scan`
5. `npm run security:dependency:check` (integrity and reviewed licenses)
6. API production audit against the reviewed exceptions (`npm run security:api-audit:check`)
7. `npm --prefix web audit --omit=dev --audit-level=high`
8. `npm run security:mobile-audit:check` (time-bounded build-tool exception)
9. `npx tsc --noEmit` and `npm --prefix apps/api run typecheck`
10. `npm run coverage:check:public` (global and critical coverage gates)

**Reproducible Source Archive**

1. build the source archive twice from the snapshot commit with
   `scripts/create-reproducible-source-bundle.mjs`
2. `cmp` the two tar files and `diff` their `SHA256SUMS.txt`

A failed step does not stop the run; later steps still execute so the evidence
shows every failing gate. Any failure means the run is red and no status is posted.

## Run it yourself

```bash
# Re-run every gate on a checkout or a built snapshot (Node 24.18.1, npm 11.16.0)
npm run verify:public -- --snapshot . --out ../saferide-verify

# Same, inside a sandbox: private HOME, no network except npm install/audit
npm run verify:public -- --snapshot . --out ../saferide-verify --sandbox

# Check a published evidence file: signature, hash, step logs (if the logs folder is next
# to it, or --logs DIR) and the tree of your checkout
npm run verify:public -- --check-evidence public-verify-evidence.json --snapshot .

# List the steps without running anything
npm run verify:public -- --snapshot . --dry-run
```

Evidence is signed by default; `--unsigned` gives a report that cannot be used for statuses. Create the key once with `npm run verify:public -- --init-signer`. Heavy steps wait until the host load is below 8 (`--max-load`, `--wait-for-load MINUTES`,
`--ignore-load`). The coverage tests contain timing-sensitive tests (for example the
PBKDF2 `decoyPin` tests); on a busy machine they can time out. That is a red result:
rerun on a quiet machine, do not loosen the test.

## Checking a contributor pull request (maintainers)

```bash
gh pr diff 14 -R esherialabs/saferide          # read the whole diff first
npm run verify:public:pr -- 14                  # lists the changed files, then stops
npm run verify:public:pr -- 14 --i-have-reviewed-the-diff [--post-statuses]
```

Contributor code is untrusted and the tests execute it, so this mode is strict:

- it refuses to run without `--i-have-reviewed-the-diff` (it prints the changed files and
  marks with `!` files that can change what the gates do: `scripts/`, `package.json`,
  `package-lock.json`, `vitest*.mjs`, `config/`, `.npmrc`, `.github/`). The flag is an
  assertion by the maintainer; the tool cannot check that the diff was really read.
  If any gate-related file changed, statuses are refused unless `--allow-gate-file-changes`
  is also given, and that choice is recorded in the evidence;
- the head commit is pinned when the file list is shown; if the PR moves, it stops;
- the gate commands come from the **base** commit, never from the pull request;
- the clone runs with hooks disabled, then `.git` is removed from the working copy; the
  checkout is size-capped (300 MB, 30,000 files), any `.npmrc` in it is deleted, and
  provenance comes from the base commit, not the pull request;
- installs use `--ignore-scripts` (also `npm_config_ignore_scripts=true`), a forced
  registry and no user or global npm config;
- every step runs under `bwrap` (bubblewrap) with a cleared environment (no tokens),
  a private HOME, a private `/tmp`, and a systemd user scope capping memory (10 GB) and
  tasks (768). If the caps are unavailable the run aborts. Inside the sandbox the
  checkout, that private HOME and the temporary git directory are writable; the system
  directories are read-only and only the needed `/etc` entries are visible;
- the network is given only to the exact `npm ci --ignore-scripts` install lines. The npm
  audit data is fetched by the trusted runner from copies of the lockfiles, and the
  tree's own audit-check scripts then read that saved JSON offline. Typecheck, tests,
  coverage, secret scan and the archive build run with **no network**. Contributor
  code never gets the host network;
- the tool reads files from the contributor tree on the host only through symlink-refusing,
  path-checked reads;
- free disk below 15 GB aborts the run before it starts;
- statuses are never posted for a failed run, a moved head, an unsigned or invalidly
  signed file, or a different commit.

The summary a contributor pastes from their own run (`public-verify-summary.md`) is
self-reported and is not proof; only a signed evidence file from the maintainers is.

Residual risk, plainly: a bubblewrap sandbox is not a virtual machine. It does not
defend against a kernel exploit, and the install step needs the npm registry. Code
that is only reviewed by reading a diff can hide behaviour. Run this mode on a
machine with nothing valuable on it, and treat a green result as "the gates passed",
not "the code is safe". This is also why self-hosted GitHub runners are discouraged
for public repositories.

## Branch protection

Before: the two required checks were bound to the GitHub Actions app
(`app_id` 15368). After the switch (only while Actions is unavailable): the same two
check names accept a status from any source (`app_id` -1; GitHub documents "Pass -1 to
explicitly allow any app to set the status"). GitHub documents this, but the behaviour
for commit statuses is untested on this repository until it is first used. Everything else is unchanged: one approving review
(stale reviews dismissed, approval required after the last push), conversation
resolution, branches must be up to date, administrators included, no force pushes,
no deletions.

Consequence: while this is on, anyone with write access could post a status with
those names. The review, the evidence file and the short time the setting is on
are the controls. The maintainers switch it on for a merge and switch it back after.

## Switching back to GitHub Actions

When the billing issue is fixed: run `restore-protection.NOT-RUN.sh` from the
maintainers' publish kit (after removing its guard lines). It rebuilds the original
settings from the recorded `protection-before.json` and checks the result byte for
byte. Then re-run a pull request's workflows from the GitHub UI. The workflows in
`.github/workflows/` were kept for this reason and for forks.

## How this relates to the maintainers' private checks

The maintainers also run their own private-repository checks (their local CI) on the
private source before a snapshot is built; that tooling is not part of this repository.
This public verification is separate: it checks the public tree itself, with the public
repository's own required checks. A refresh needs both: private checks green on `main`,
then public verification of the built snapshot.

## Limits and honest caveats

- Checks are only as trustworthy as the maintainers' server, the verifier key and the people
  with write access; they are not independent of the maintainers the way GitHub-hosted runs were.
- While "any source" is on, anyone with write access could post a status with these names;
  the signature on the evidence, not the status, is the record to check.
- Runs may take longer than hosted CI (a queue, a quiet-host wait, a human step).
- Audit steps use live advisory data: a run can turn red when a new advisory appears,
  with no change in the code.
- The reproducibility check uses a local commit with a fixed date; it proves the build
  is repeatable, and the archive hash will differ from the one for the real merge commit.
- Dependabot and CodeQL runs also depend on Actions billing and can fail while it is locked.
