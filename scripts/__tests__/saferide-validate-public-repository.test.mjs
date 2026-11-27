/**
 * Boundary tests for scripts/validate-public-repository.mjs.
 *
 * The validator is a top-level script, so each case builds a temporary
 * fixture tree and runs it with --root. Fixtures are generated here and
 * contain no secrets or personal data: blocked-extension files hold the
 * literal string "not-a-real-key".
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const validator = path.join(repoRoot, 'scripts', 'validate-public-repository.mjs');

const REQUIRED_FILES = [
  'LICENSE', 'NOTICE', 'README.md', 'OPEN_SOURCE.md', 'ASSET-LICENSES.md',
  'CONTENT-LICENSE.md', 'MODEL-DATA-LICENSES.md', 'TRADEMARKS.md',
  'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md', 'SECURITY.md', 'GOVERNANCE.md',
  'PROJECT_CHARTER.md', 'MAINTAINERS.md',
  '.github/ISSUE_TEMPLATE/bug.yml', '.github/ISSUE_TEMPLATE/feature.yml',
  '.github/ISSUE_TEMPLATE/documentation.yml',
  '.github/workflows/public-ci.yml', '.github/workflows/public-docs.yml',
  '.github/workflows/public-release.yml',
  'docs/open-source/README.md', 'docs/open-source/reproducible-builds.md',
];

const LICENSE_TEXT = 'Apache License\nVersion 2.0, January 2004\n';

function write(root, relativePath, contents) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

/** A minimal tree the validator accepts, used as the baseline to perturb. */
function validFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'saferide-public-'));
  for (const relativePath of REQUIRED_FILES) {
    write(root, relativePath, relativePath === 'LICENSE' ? LICENSE_TEXT : `# ${relativePath}\n`);
  }
  return root;
}

function run(root) {
  const result = spawnSync(process.execPath, [validator, '--root', root], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

test('a minimal well-formed tree passes', () => {
  const result = run(validFixture());
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Public repository validation passed/);
});

test('a restricted directory is reported by path', () => {
  const root = validFixture();
  write(root, 'docs/security/threat-model.md', '# internal\n');

  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Public repository validation failed:/);
  assert.match(result.stderr, /- restricted path is present: docs\/security\/threat-model\.md/);
});

for (const extension of ['.apk', '.keystore', '.safetensors', '.pem']) {
  test(`a blocked ${extension} artifact is reported by path`, () => {
    const root = validFixture();
    write(root, `artifacts/bundle${extension}`, 'not-a-real-key');

    const result = run(root);
    assert.equal(result.status, 1);
    assert.ok(
      result.stderr.includes(`restricted artifact extension is present: artifacts/bundle${extension}`),
      result.stderr,
    );
  });
}

test('a missing community file names the file', () => {
  const root = validFixture();
  fs.rmSync(path.join(root, 'CODE_OF_CONDUCT.md'));

  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /- missing required public repository file: CODE_OF_CONDUCT\.md/);
});

test('every required file is enforced individually', () => {
  for (const relativePath of REQUIRED_FILES) {
    const root = validFixture();
    fs.rmSync(path.join(root, relativePath));
    const result = run(root);
    assert.equal(result.status, 1, `removing ${relativePath} should fail validation`);
    assert.ok(
      result.stderr.includes(`missing required public repository file: ${relativePath}`),
      `expected a specific message for ${relativePath}`,
    );
  }
});

test('a stale canonical repository URL is reported by file', () => {
  const root = validFixture();
  write(root, 'docs/open-source/quickstart.md', 'Clone github.com/esherialabs/saferider today.\n');

  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /- stale repository URL remains in docs\/open-source\/quickstart\.md/);
});

test('a commercial site link is reported separately from a stale URL', () => {
  const root = validFixture();
  write(root, 'docs/open-source/links.md', 'See https://esheria.ai for more.\n');

  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /- commercial Esheria site linkage remains in docs\/open-source\/links\.md/);
});

test('the stale-URL scan ignores non-text extensions', () => {
  const root = validFixture();
  write(root, 'docs/open-source/notes.txt', 'github.com/esherialabs/saferider\n');

  assert.equal(run(root).status, 0);
});

test('a local .env file is rejected but .env.example is allowed', () => {
  const withEnv = validFixture();
  write(withEnv, '.env', 'TOKEN=placeholder\n');
  const rejected = run(withEnv);
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /- local environment file is present: \.env/);

  const withExample = validFixture();
  write(withExample, '.env.example', 'TOKEN=\n');
  assert.equal(run(withExample).status, 0);
});

test('a truncated LICENSE is rejected', () => {
  const root = validFixture();
  write(root, 'LICENSE', 'Apache License\n');

  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /- root LICENSE is not the complete Apache License 2\.0 text/);
});

test('a SHA256SUMS entry that does not match is reported', () => {
  const root = validFixture();
  write(root, 'SHA256SUMS.txt', `${'0'.repeat(64)}  README.md\n`);

  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /- SHA256SUMS mismatch: README\.md/);
});

test('a malformed SHA256SUMS line is reported verbatim', () => {
  const root = validFixture();
  write(root, 'SHA256SUMS.txt', 'not-a-digest README.md\n');

  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /- invalid SHA256SUMS entry: not-a-digest README\.md/);
});

test('an unclean provenance source tree is reported', () => {
  const root = validFixture();
  write(root, 'PUBLIC_MIRROR_PROVENANCE.json', JSON.stringify({ sourceTreeState: 'dirty' }));

  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /- public provenance source tree is dirty/);
});

test('the validator fails closed when the root does not exist', () => {
  const root = path.join(os.tmpdir(), 'saferide-public-does-not-exist-12345');
  const result = run(root);
  assert.notEqual(result.status, 0, 'a missing root must not pass');
  assert.match(result.stderr, /Public repository root is unavailable/);
});

test('several violations are all reported, not just the first', () => {
  const root = validFixture();
  write(root, 'docs/security/notes.md', '# internal\n');
  write(root, 'artifacts/app.apk', 'not-a-real-key');
  fs.rmSync(path.join(root, 'MAINTAINERS.md'));

  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /restricted path is present/);
  assert.match(result.stderr, /restricted artifact extension is present/);
  assert.match(result.stderr, /missing required public repository file: MAINTAINERS\.md/);
});
