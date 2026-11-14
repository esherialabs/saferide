import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  REQUIRED_CONTEXTS, canonicalJson, checkEvidence, checkPlanContexts, commitSnapshot, evidenceHash, overallStatus,
  acquireLock, assertSandboxPaths, auditExitFromReport, checkWorkflowPin, initSigner, isWebAudit, jobPassed, logProblems, needsNetworkTrustedTree,
  offlineAuditRewrite, pinEntryFor, safeReadFile, signEvidence, signatureProblems,
  buildSandboxArgv, hardenCommandForPr, needsNetwork, scrubbedEnv, summarizeChangedFiles,
  parseArgs, parseWorkflow, planFromWorkflow, postBlockers, postStatuses, renderSummary, sealEvidence, treeDigest, lockfileHashes,
} from '../lib/public-verify.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ok = () => [];
const SHA = 'a'.repeat(40);
const TREE = 'b'.repeat(40);

const WORKFLOW = `name: X
env:
  NODE_VERSION: '24.18.1'
  NPM_VERSION: '11.16.0'
jobs:
  verify:
    name: Typecheck, Test, Coverage, Public Safety
    timeout-minutes: 45
    steps:
      - name: Checkout
        uses: actions/checkout@abc # v7
        with:
          fetch-depth: 0
      - name: Pin
        run: |
          npm install --global "npm@\${NPM_VERSION}" --ignore-scripts
          test "$(npm --version)" = "\${NPM_VERSION}"
      - name: Single
        run: npm run one
      - name: Upload
        if: always()
        uses: actions/upload-artifact@def
        with:
          name: saferide-coverage-\${{ github.sha }}
          path: coverage
  reproducibility:
    name: Reproducible Source Archive
    timeout-minutes: 15
    steps:
      - name: Build twice
        run: |
          node a
          node b
`;

function evidence(overrides = {}) {
  const jobs = REQUIRED_CONTEXTS.map(context => ({ context, steps: [{ name: 's', command: 'c', exitCode: 0, durationMs: 5 }, { name: 'skip', skipped: true, reason: 'r' }] }));
  return sealEvidence({
    schema: 'saferide-public-verify-evidence-v1',
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    host: { loadAverageAtStart: 1, cpus: 8 },
    toolchain: { node: 'v24.18.1', npm: '11.16.0', git: 'git version 2.43.0' },
    provenance: { sourceBranch: 'main', sourceTreeState: 'clean', sourceCommit: SHA },
    snapshot: { treeSha256: 'c'.repeat(64), gitTreeSha: TREE, unchangedByRun: true, fileCount: 1 },
    jobs,
    status: 'passed',
    ...overrides,
  });
}

test('parses env, jobs and steps, including run blocks and nested with keys', () => {
  const wf = parseWorkflow(WORKFLOW);
  assert.deepEqual(wf.env, { NODE_VERSION: '24.18.1', NPM_VERSION: '11.16.0' });
  assert.deepEqual(wf.jobs.map(j => j.name), ['Typecheck, Test, Coverage, Public Safety', 'Reproducible Source Archive']);
  assert.equal(wf.jobs[0].timeoutMinutes, 45);
  const names = wf.jobs[0].steps.map(s => s.name);
  assert.deepEqual(names, ['Checkout', 'Pin', 'Single', 'Upload'], 'a nested with.name must not rename the step');
  assert.equal(wf.jobs[1].steps[0].run, 'node a\nnode b');
});

test('plans: skips GitHub-only steps, keeps run commands, drops the global npm install', () => {
  const plan = planFromWorkflow(parseWorkflow(WORKFLOW));
  checkPlanContexts(plan);
  const steps = plan.jobs[0].steps;
  assert.equal(steps[0].skipped, true);
  assert.equal(steps[1].command, 'test "$(npm --version)" = "${NPM_VERSION}"');
  assert.match(steps[1].note, /Global npm install skipped/);
  assert.equal(steps[2].command, 'npm run one');
  assert.equal(steps[3].skipped, true);
});

test('refuses unknown actions, conditions on run steps and expressions in commands', () => {
  const bad = body => planFromWorkflow(parseWorkflow(`jobs:\n  j:\n    name: J\n    steps:\n${body}`));
  assert.throws(() => bad('      - name: A\n        uses: someone/else@v1\n'), /Unrecognised action/);
  assert.throws(() => bad('      - name: A\n        if: always()\n        run: echo hi\n'), /condition/);
  assert.throws(() => bad('      - name: A\n        run: echo ${{ secrets.X }}\n'), /expression/);
  assert.throws(() => bad('      - name: A\n        shell: pwsh\n        run: echo hi\n'), /unsupported key/);
});

test('plan must carry exactly the two required contexts', () => {
  const plan = planFromWorkflow(parseWorkflow(WORKFLOW));
  assert.doesNotThrow(() => checkPlanContexts(plan));
  assert.throws(() => checkPlanContexts({ jobs: [plan.jobs[0]] }), /Reproducible Source Archive/);
  assert.throws(() => checkPlanContexts({ jobs: [...plan.jobs, { context: 'Extra' }] }), /Extra/);
});

test('the real public workflow files parse and match the required contexts', () => {
  const root = path.resolve(here, '..', '..');
  const candidates = ['public-repository/.github/workflows/public-ci.yml', '.github/workflows/public-ci.yml']
    .map(p => path.join(root, p)).filter(p => fs.existsSync(p));
  assert.ok(candidates.length > 0, 'no public-ci.yml found');
  for (const file of candidates) {
    const plan = planFromWorkflow(parseWorkflow(fs.readFileSync(file, 'utf8')));
    checkPlanContexts(plan);
    assert.ok(plan.jobs[0].steps.some(s => !s.skipped && /coverage:check:public/.test(s.command)));
    assert.ok(plan.jobs[1].steps.some(s => !s.skipped && /create-reproducible-source-bundle/.test(s.command)));
  }
});

test('treeDigest is stable, ignores node_modules/.git/coverage/dist, and sees edits, modes and renames', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-tree-'));
  try {
    fs.mkdirSync(path.join(dir, 'a'));
    fs.writeFileSync(path.join(dir, 'a', 'x.txt'), 'x');
    fs.writeFileSync(path.join(dir, 'y.txt'), 'y');
    const base = treeDigest(dir);
    assert.equal(base.fileCount, 2);
    for (const ignored of ['node_modules', '.git', 'coverage', 'dist']) {
      fs.mkdirSync(path.join(dir, ignored));
      fs.writeFileSync(path.join(dir, ignored, 'z'), 'z');
    }
    fs.mkdirSync(path.join(dir, 'a', 'node_modules'));
    fs.writeFileSync(path.join(dir, 'a', 'node_modules', 'q'), 'q');
    assert.equal(treeDigest(dir).sha256, base.sha256);
    fs.mkdirSync(path.join(dir, 'a', 'coverage'));
    fs.writeFileSync(path.join(dir, 'a', 'coverage', 'k'), 'k');
    assert.notEqual(treeDigest(dir).sha256, base.sha256, 'only top-level coverage/dist are ignored');
    fs.rmSync(path.join(dir, 'a', 'coverage'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'y.txt'), 'Y');
    assert.notEqual(treeDigest(dir).sha256, base.sha256);
    fs.writeFileSync(path.join(dir, 'y.txt'), 'y');
    assert.equal(treeDigest(dir).sha256, base.sha256);
    fs.chmodSync(path.join(dir, 'y.txt'), 0o755);
    assert.notEqual(treeDigest(dir).sha256, base.sha256);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('commitSnapshot makes a deterministic commit outside the snapshot', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-git-'));
  const snap = path.join(dir, 'snap');
  fs.mkdirSync(snap);
  fs.writeFileSync(path.join(snap, 'f.txt'), 'hello');
  try {
    const a = commitSnapshot(snap, path.join(dir, 'a.git'), '2026-11-10T19:24:44+01:00');
    const b = commitSnapshot(snap, path.join(dir, 'b.git'), '2026-11-10T19:24:44+01:00');
    assert.equal(a.commit, b.commit);
    assert.equal(fs.existsSync(path.join(snap, '.git')), false);
    assert.equal(a.files, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('evidence is tamper-evident', () => {
  const e = evidence();
  assert.deepEqual(checkEvidence(e), []);
  assert.equal(e.evidenceSha256, evidenceHash(e));
  const edited = structuredClone(e);
  edited.jobs[0].steps[0].exitCode = 1;
  assert.ok(checkEvidence(edited).some(p => /edited/.test(p)));
  const flipped = structuredClone(e);
  flipped.status = 'failed';
  assert.ok(checkEvidence(flipped).length > 0);
  assert.ok(checkEvidence(e, { snapshotTree: 'd'.repeat(64) }).some(p => /tree sha256 differs/.test(p)));
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }], u: undefined }), '{"a":[2,{"c":2,"d":1}],"b":1}');
});

test('overall status needs both jobs green; skipped steps do not count as failures', () => {
  const ok = evidence();
  assert.equal(overallStatus(ok.jobs), 'passed');
  assert.equal(overallStatus(ok.jobs.slice(0, 1)), 'failed');
  const bad = structuredClone(ok.jobs);
  bad[1].steps[0].exitCode = 2;
  assert.equal(overallStatus(bad), 'failed');
});

test('posting is blocked for failures, review builds, dirty trees, changed snapshots and stale evidence', () => {
  assert.deepEqual(postBlockers(evidence()), []);
  const failedJobs = structuredClone(evidence().jobs);
  failedJobs[0].steps[0].exitCode = 1;
  assert.ok(postBlockers(evidence({ jobs: failedJobs, status: 'failed' })).some(p => /step failed/.test(p)));
  assert.ok(postBlockers(evidence({ provenance: { sourceBranch: 'detached@abc', sourceTreeState: 'clean', sourceCommit: SHA } })).some(p => /not main/.test(p)));
  assert.ok(postBlockers(evidence({ provenance: { sourceBranch: 'main', sourceTreeState: 'dirty-test-only', sourceCommit: SHA } })).some(p => /not clean/.test(p)));
  assert.ok(postBlockers(evidence({ snapshot: { treeSha256: 'c', gitTreeSha: TREE, unchangedByRun: false } })).some(p => /changed while/.test(p)));
  assert.ok(postBlockers(evidence({ finishedAt: '2026-01-01T00:00:00.000Z' })).some(p => /not fresh/.test(p)));
});

test('postStatuses uses the exact context names and an injected gh, and checks the commit tree', () => {
  const calls = [];
  const gh = args => { calls.push(args); return args.includes('--jq') ? `${TREE}\n` : '{}'; };
  const result = postStatuses({ signatureCheck: ok, evidence: evidence(), repo: 'esherialabs/saferide', sha: SHA, gh });
  assert.deepEqual(result.posted, [...REQUIRED_CONTEXTS]);
  const posts = calls.filter(c => c.includes('POST'));
  assert.equal(posts.length, 2);
  for (const [i, call] of posts.entries()) {
    assert.ok(call.includes(`repos/esherialabs/saferide/statuses/${SHA}`));
    assert.ok(call.includes(`context=${REQUIRED_CONTEXTS[i]}`));
    assert.ok(call.includes('state=success'));
    assert.ok(!call.some(a => a.startsWith('target_url=')), 'no target_url unless asked');
  }
  assert.ok(posts[0].find(a => a.startsWith('description=')).length <= 'description='.length + 140);
  const withUrl = [];
  postStatuses({ signatureCheck: ok, evidence: evidence(), repo: 'o/r', sha: SHA, targetUrl: 'https://example.test/e', gh: a => { withUrl.push(a); return TREE; } });
  assert.ok(withUrl.some(a => a.includes('target_url=https://example.test/e')));
});

test('postStatuses posts nothing when blocked or when the commit tree differs', () => {
  const calls = [];
  const gh = args => { calls.push(args); return 'e'.repeat(40); };
  assert.throws(() => postStatuses({ signatureCheck: ok, evidence: evidence(), repo: 'o/r', sha: SHA, gh }), /tree/);
  assert.equal(calls.filter(c => c.includes('POST')).length, 0);
  const jobs = structuredClone(evidence().jobs);
  jobs[1].steps[0].exitCode = 1;
  const failed = evidence({ jobs, status: 'failed' });
  const gh2 = () => { throw new Error('gh must not be called'); };
  assert.throws(() => postStatuses({ signatureCheck: ok, evidence: failed, repo: 'o/r', sha: SHA, gh: gh2 }), /Refusing to post statuses/);
  assert.throws(() => postStatuses({ signatureCheck: ok, evidence: evidence(), repo: 'o/r', sha: 'short', gh: gh2 }), /40-character/);
  assert.throws(() => postStatuses({ signatureCheck: ok, evidence: evidence(), repo: 'not a repo', sha: SHA, gh: gh2 }), /owner\/name/);
  assert.throws(() => postStatuses({ signatureCheck: ok, evidence: evidence(), repo: "o/r", sha: SHA }), /injected gh/);
});

test('argument parsing keeps posting opt-in and explicit', () => {
  assert.equal(parseArgs(['--snapshot', 'x']).postStatuses, false);
  assert.throws(() => parseArgs(['--snapshot', 'x', '--repo', 'o/r', '--sha', SHA]), /only apply with --post-statuses/);
  assert.throws(() => parseArgs(['--snapshot', 'x', '--post-statuses']), /needs --repo/);
  assert.throws(() => parseArgs(['--snapshot', 'x', '--post-statuses', '--repo', 'o/r', '--sha', SHA, '--dry-run']), /dry-run/);
  assert.throws(() => parseArgs(['--bogus']), /Unknown argument/);
  assert.throws(() => parseArgs(['--snapshot']), /needs a value/);
  const ok = parseArgs(['--snapshot', 'x', '--post-statuses', '--repo', 'o/r', '--sha', SHA]);
  assert.equal(ok.postStatuses, true);
});

test('summary names both jobs, the evidence hash and the check command', () => {
  const text = renderSummary(evidence());
  for (const c of REQUIRED_CONTEXTS) assert.ok(text.includes(c));
  assert.ok(text.includes(evidence().evidenceSha256) || /Evidence sha256: `[0-9a-f]{64}`/.test(text));
  assert.match(text, /--check-evidence/);
  assert.match(text, /PASSED/);
});


// ------------------------------------------------------------ new coverage ---

const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
function signerFixture() {
  const dir = tmp('pv-key-');
  const keyPath = path.join(dir, 'k');
  const info = initSigner(keyPath);
  const allowed = path.join(dir, 'allowed_signers');
  fs.writeFileSync(allowed, `${info.allowedSignersLine}\n`);
  return { dir, keyPath, allowed, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const workflowWith = extra => `jobs:\n  j:\n    name: J\n${extra}    steps:\n      - name: A\n        run: echo hi\n`;

test('workflow parser rejects unknown job keys, wherever they sit, and unknown top-level keys', () => {
  for (const key of ['needs: x', 'if: always()', 'env:', 'strategy:', 'container: x', 'services:', 'defaults:', 'permissions: write-all']) {
    assert.throws(() => parseWorkflow(workflowWith(`    ${key}\n`)), /unsupported key/, key);
  }
  assert.throws(() => parseWorkflow(`${workflowWith('')}    needs: other\n`), /unsupported key/);
  assert.doesNotThrow(() => parseWorkflow(workflowWith('    runs-on: ubuntu-24.04\n    timeout-minutes: 5\n')));
  assert.throws(() => parseWorkflow(`on: push\ndefaults:\n  run: x\n`), /top-level/);
});

test('a job with no runnable step is refused, and an empty job never counts as passed', () => {
  const onlyUses = 'jobs:\n  j:\n    name: J\n    steps:\n      - name: C\n        uses: actions/checkout@abc\n';
  assert.throws(() => planFromWorkflow(parseWorkflow(onlyUses)), /no runnable step/);
  assert.equal(jobPassed({ steps: [] }), false);
  assert.equal(jobPassed({ steps: [{ skipped: true }] }), false);
  assert.equal(jobPassed({ steps: [{ skipped: true }, { exitCode: 0 }] }), true);
  const empty = evidence().jobs.map(j => ({ ...j, steps: [{ name: 'skip', skipped: true, reason: 'r' }] }));
  assert.equal(overallStatus(empty), 'failed');
  assert.ok(postBlockers(evidence({ jobs: empty })).some(p => /no executed step/.test(p)));
});

test('the workflow pin accepts the reviewed file and rejects a changed file or step list', () => {
  const plan = planFromWorkflow(parseWorkflow(WORKFLOW));
  const pin = { accepted: [pinEntryFor(WORKFLOW, plan, 'test')] };
  assert.doesNotThrow(() => checkWorkflowPin(WORKFLOW, plan, pin));
  const changed = `${WORKFLOW}\n`;
  assert.throws(() => checkWorkflowPin(changed, planFromWorkflow(parseWorkflow(changed)), pin), /not a workflow public-verify has been reviewed for/);
  const entry = pinEntryFor(WORKFLOW, plan, 'x');
  entry.requiredSteps['Reproducible Source Archive'] = ['Something else'];
  assert.throws(() => checkWorkflowPin(WORKFLOW, plan, { accepted: [entry] }), /differ from the pinned list/);
});

test('the shipped pin file covers the repository workflow', () => {
  const root = path.resolve(here, '..', '..');
  const pin = JSON.parse(fs.readFileSync(path.join(root, 'config/release/public-verify-workflow.v1.json'), 'utf8'));
  const candidate = ['public-repository/.github/workflows/public-ci.yml', '.github/workflows/public-ci.yml'].map(f => path.join(root, f)).find(f => fs.existsSync(f));
  const text = fs.readFileSync(candidate, 'utf8');
  assert.doesNotThrow(() => checkWorkflowPin(text, planFromWorkflow(parseWorkflow(text)), pin));
});

test('host-side reads of the untrusted tree refuse symlinks and escapes', () => {
  const dir = tmp('pv-sym-');
  try {
    const root = path.join(dir, 'tree');
    fs.mkdirSync(path.join(root, 'dist', 'repro-a'), { recursive: true });
    const secret = path.join(dir, 'secret.txt');
    fs.writeFileSync(secret, 'host secret');
    fs.writeFileSync(path.join(root, 'ok.txt'), 'fine');
    assert.equal(safeReadFile(root, 'ok.txt').toString(), 'fine');
    fs.symlinkSync(secret, path.join(root, 'dist', 'repro-a', 'SHA256SUMS.txt'));
    assert.throws(() => safeReadFile(root, 'dist/repro-a/SHA256SUMS.txt'), /symbolic link/);
    fs.symlinkSync(dir, path.join(root, 'linkdir'));
    assert.throws(() => safeReadFile(root, 'linkdir/secret.txt'), /symbolic link/);
    assert.throws(() => safeReadFile(root, '../secret.txt'), /outside the snapshot/);
    assert.throws(() => safeReadFile(root, 'dist'), /non-regular/);
    fs.symlinkSync(secret, path.join(root, 'package-lock.json'));
    assert.throws(() => lockfileHashes(root), /symbolic link/);
    assert.throws(() => safeReadFile(root, 'PUBLIC_MIRROR_PROVENANCE.json'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('signed evidence verifies; edited, forged-and-resealed, unsigned and wrong-key files fail', () => {
  const k = signerFixture();
  const other = signerFixture();
  try {
    const signed = signEvidence(evidence(), k.keyPath);
    assert.deepEqual(signatureProblems(signed, k.allowed), []);
    assert.deepEqual(checkEvidence(signed), []);
    // Edited without resealing: hash check fails.
    const edited = structuredClone(signed);
    edited.jobs[0].steps[0].exitCode = 9;
    assert.ok(checkEvidence(edited).length > 0);
    // Forged and resealed (attacker recomputes the unkeyed hash): the signature no longer verifies.
    const forged = sealEvidence({ ...structuredClone(signed), status: 'passed', startedAt: '2026-01-01T00:00:00.000Z' });
    assert.deepEqual(checkEvidence(forged), [], 'the unkeyed hash alone cannot detect a reseal');
    assert.ok(signatureProblems(forged, k.allowed).length > 0);
    // Someone else's key, even with a valid signature of their own.
    const foreign = signEvidence(evidence(), other.keyPath);
    assert.ok(signatureProblems(foreign, k.allowed).length > 0);
    assert.deepEqual(signatureProblems(foreign, other.allowed), []);
    assert.deepEqual(signatureProblems(evidence(), k.allowed), ['evidence is not signed']);
    // Posting requires the signature.
    const gh = a => (a.includes('--jq') ? TREE : '{}');
    const check = ev => signatureProblems(ev, k.allowed);
    assert.equal(postStatuses({ evidence: signed, repo: 'o/r', sha: SHA, gh, signatureCheck: check }).posted.length, 2);
    assert.throws(() => postStatuses({ evidence: forged, repo: 'o/r', sha: SHA, gh, signatureCheck: check }), /signature does not verify/);
    assert.throws(() => postStatuses({ evidence: evidence(), repo: 'o/r', sha: SHA, gh, signatureCheck: check }), /not signed/);
    assert.throws(() => postStatuses({ evidence: signed, repo: 'o/r', sha: SHA, gh }), /signature check/);
  } finally {
    k.cleanup();
    other.cleanup();
  }
});

test('initSigner never overwrites and writes a private key', () => {
  const k = signerFixture();
  try {
    assert.throws(() => initSigner(k.keyPath), /already exists/);
    assert.equal(fs.statSync(k.keyPath).mode & 0o777, 0o600);
    fs.chmodSync(k.keyPath, 0o644);
    assert.throws(() => signEvidence(evidence(), k.keyPath), /must be private/);
  } finally {
    k.cleanup();
  }
});

test('step logs are re-hashed: a valid set passes, a tampered or missing log fails', () => {
  const dir = tmp('pv-logs-');
  try {
    fs.mkdirSync(path.join(dir, 'logs'));
    fs.writeFileSync(path.join(dir, 'logs', '01.log'), 'all good\n');
    const e = evidence();
    e.jobs[0].steps[0] = { name: 's', exitCode: 0, durationMs: 1, logFile: 'logs/01.log', logSha256: createHash('sha256').update('all good\n').digest('hex') };
    assert.deepEqual(logProblems(e, dir), []);
    fs.writeFileSync(path.join(dir, 'logs', '01.log'), 'all good (edited)\n');
    assert.match(logProblems(e, dir)[0], /modified/);
    fs.rmSync(path.join(dir, 'logs', '01.log'));
    assert.match(logProblems(e, dir)[0], /missing/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the lock is exclusive, owner-checked, reclaims stale locks and refuses a symlink', () => {
  const dir = tmp('pv-lock-');
  try {
    const release = acquireLock(dir);
    assert.throws(() => acquireLock(dir), /Another public-verify run is active/);
    release();
    const again = acquireLock(dir);
    again();
    const file = path.join(dir, 'saferide-public-verify.lock');
    fs.writeFileSync(file, '999999999');
    const reclaimed = acquireLock(dir);
    reclaimed();
    fs.symlinkSync('/etc/hostname', file);
    assert.throws(() => acquireLock(dir), /(not a plain file|ELOOP|EEXIST)/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('gate-related file changes block posting unless explicitly allowed (and that is recorded)', () => {
  const pr = over => evidence({ mode: 'pull-request', provenance: {}, sandbox: { tool: 'bwrap' }, pullRequest: { repo: 'o/r', number: 1, headSha: SHA, reviewedDiffConfirmed: true, headMovedDuringRun: false, gateFilesChanged: [], allowGateFileChanges: false, ...over } });
  assert.deepEqual(postBlockers(pr()), []);
  assert.ok(postBlockers(pr({ gateFilesChanged: ['package.json'] })).some(p => /define the gates/.test(p)));
  assert.deepEqual(postBlockers(pr({ gateFilesChanged: ['package.json'], allowGateFileChanges: true })), []);
  assert.equal(parseArgs(['--pr', '1', '--allow-gate-file-changes']).allowGateFileChanges, true);
  assert.throws(() => parseArgs(['--snapshot', 'd', '--allow-gate-file-changes']), /only apply with --pr/);
  assert.throws(() => parseArgs(['--evidence', 'f.json']), /only used with --post-statuses/);
});

test('sandbox paths: the Node root may not contain HOME or the checkout, nor be a broad directory', () => {
  assert.doesNotThrow(() => assertSandboxPaths({ nodeRoot: '/opt/node', home: '/tmp/h', snapshot: '/work/src' }));
  assert.throws(() => assertSandboxPaths({ nodeRoot: '/home/u', home: '/home/u/.h', snapshot: '/work/src' }), /contains HOME/);
  assert.throws(() => assertSandboxPaths({ nodeRoot: '/', home: '/tmp/h', snapshot: '/w' }), /too broad/);
  const argv = buildSandboxArgv({ command: 'true', cwd: '/w', network: false, scope: false });
  const etc = argv.flatMap((a, i) => (a === '--ro-bind' ? [argv[i + 1]] : [])).filter(b => b.startsWith('/etc'));
  assert.ok(!etc.includes('/etc'), 'all of /etc must not be bound');
});

const bwrapWorks = (() => { try { execFileSync('bwrap', ['--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64', '--proc', '/proc', '--dev', '/dev', '--', 'true'], { stdio: 'ignore' }); return true; } catch { return false; } })();

test('a real sandbox run: offline, no host secrets, no home files, writes confined', { skip: !bwrapWorks && 'bwrap is not usable here' }, () => {
  const dir = tmp('pv-box-');
  const work = path.join(dir, 'work');
  const home = path.join(dir, 'home');
  fs.mkdirSync(work);
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(dir, 'outside.txt'), 'host file');
  const nodeBin = path.dirname(process.execPath);
  const nodeRoot = path.dirname(nodeBin);
  const run = (command, network = false) => {
    const argv = buildSandboxArgv({ command, cwd: work, network, readonly: [nodeRoot], writable: [work, home], env: { HOME: home, PATH: `${nodeBin}:/usr/bin:/bin` }, scope: false });
    return spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', env: { ...process.env, PV_TEST_SECRET: 'leak-me' } });
  };
  try {
    assert.equal(run('test -z "${PV_TEST_SECRET:-}"').status, 0, 'host environment must not leak');
    assert.equal(run(`test ! -e ${dir}/outside.txt`).status, 0, 'files outside the bound directories are invisible');
    assert.equal(run('echo ok > inside.txt && echo ok > "$HOME/h.txt"').status, 0);
    assert.equal(fs.readFileSync(path.join(work, 'inside.txt'), 'utf8'), 'ok\n');
    assert.notEqual(run('echo x > /usr/pwned').status, 0, '/usr is read-only');
    run('echo x > /etc/pwned; echo x > /pwned');
    assert.equal(fs.existsSync('/etc/pwned') || fs.existsSync('/pwned'), false, 'writes to unbound paths never reach the host');
    const listing = run(`ls ${os.homedir()} 2>&1`).stdout;
    assert.ok(!/private|work|\.config|\.ssh/.test(listing), `operator home must not be visible: ${listing}`);
    const net = 'node -e "require(\'net\').connect(443,\'1.1.1.1\').on(\'connect\',()=>process.exit(3)).on(\'error\',()=>process.exit(0))"';
    assert.equal(run(net).status, 0, 'no network when offline');
    assert.equal(fs.existsSync('/usr/pwned'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the CLI refuses --post-statuses inside a test run; --check-evidence verifies signature, logs and tree', () => {
  const k = signerFixture();
  const dir = tmp('pv-cli-');
  try {
    const cli = path.resolve(here, '..', 'public-verify.mjs');
    const fakeBin = path.join(dir, 'bin');
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(path.join(fakeBin, 'gh'), `#!/bin/sh\necho called >> ${dir}/gh-calls\nexit 9\n`, { mode: 0o755 });
    const env = { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, NODE_TEST_CONTEXT: 'child-v8' };
    const snap = path.join(dir, 'snap');
    fs.mkdirSync(snap);
    fs.writeFileSync(path.join(snap, 'a.txt'), 'a');
    const e = evidence({ snapshot: { treeSha256: treeDigest(snap).sha256, gitTreeSha: TREE, unchangedByRun: true, fileCount: 1 } });
    const signed = signEvidence(e, k.keyPath);
    const file = path.join(dir, 'e.json');
    fs.writeFileSync(file, JSON.stringify(signed));
    const post = (() => { try { execFileSync('node', [cli, '--evidence', file, '--post-statuses', '--repo', 'o/r', '--sha', SHA, '--allowed-signers', k.allowed], { env, encoding: 'utf8', stdio: 'pipe' }); return null; } catch (err) { return err; } })();
    assert.ok(post, 'must fail');
    assert.match(String(post.stderr), /inside a test run/);
    const out = execFileSync('node', [cli, '--check-evidence', file, '--snapshot', snap, '--allowed-signers', k.allowed], { env, encoding: 'utf8' });
    assert.match(out, /Evidence OK/);
    assert.match(out, /signature valid/);
    assert.match(out, /tree .* matches/);
    fs.writeFileSync(path.join(snap, 'a.txt'), 'changed');
    const bad = (() => { try { execFileSync('node', [cli, '--check-evidence', file, '--snapshot', snap, '--allowed-signers', k.allowed], { env, encoding: 'utf8', stdio: 'pipe' }); return null; } catch (err) { return err; } })();
    assert.match(String(bad?.stderr), /tree sha256 differs/);
    fs.writeFileSync(file, JSON.stringify({ ...signed, status: 'failed' }));
    const tampered = (() => { try { execFileSync('node', [cli, '--check-evidence', file, '--allowed-signers', k.allowed], { env, encoding: 'utf8', stdio: 'pipe' }); return null; } catch (err) { return err; } })();
    assert.match(String(tampered?.stderr), /FAILED/);
    assert.equal(fs.existsSync(path.join(dir, 'gh-calls')), false, 'gh was never invoked');
  } finally {
    k.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
