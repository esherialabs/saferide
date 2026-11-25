// Library for scripts/public-verify.mjs: the local replacement for the public
// repository's GitHub Actions gates. Pure functions where possible so the unit
// tests never touch the network, GitHub, or a real install.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';

export const REQUIRED_CONTEXTS = Object.freeze([
  'Typecheck, Test, Coverage, Public Safety',
  'Reproducible Source Archive',
]);
export const EVIDENCE_SCHEMA = 'saferide-public-verify-evidence-v1';
export const SKIPPED_USES = Object.freeze({
  'actions/checkout': 'the snapshot directory is the checkout',
  'actions/setup-node': 'Node is taken from the host and checked against the pinned version',
  'actions/upload-artifact': 'evidence is written to the output directory instead',
});

export const sha256Hex = data => createHash('sha256').update(data).digest('hex');

// ---------------------------------------------------------------- workflow --

const unquote = value => {
  const v = value.trim();
  return (v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"')) ? v.slice(1, -1) : v;
};
const indentOf = line => line.length - line.trimStart().length;

/**
 * Minimal parser for the shape of public-ci.yml: top-level env, and jobs with
 * name, timeout-minutes and a list of steps (name, uses, if, run). It is not a
 * YAML parser; anything it does not understand in a step is an error, so a new
 * kind of step can never be skipped silently.
 */
export function parseWorkflow(text) {
  const lines = text.split(/\r?\n/);
  const workflow = { env: {}, jobs: [] };
  let section = null;
  let job = null;
  let step = null;
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const ind = indentOf(raw);
    const body = raw.trim();
    if (ind === 0) {
      section = body.replace(/:.*$/, '');
      if (!['name', 'on', 'permissions', 'concurrency', 'env', 'jobs'].includes(section)) throw new Error(`Workflow has an unsupported top-level key "${section}".`);
      job = null;
      step = null;
      continue;
    }
    if (section === 'env' && ind === 2) {
      const m = /^([A-Za-z_][\w]*):\s*(.*)$/.exec(body);
      if (m) workflow.env[m[1]] = unquote(m[2]);
      continue;
    }
    if (section !== 'jobs') continue;
    if (ind === 2) {
      job = { id: body.replace(/:.*$/, ''), name: null, timeoutMinutes: null, steps: [] };
      workflow.jobs.push(job);
      step = null;
      continue;
    }
    if (!job) continue;
    if (ind === 4) {
      step = null;
      const m = /^([\w-]+):\s*(.*)$/.exec(body);
      if (!m || !['name', 'runs-on', 'timeout-minutes', 'steps'].includes(m[1])) throw new Error(`Workflow job "${job.id}" has an unsupported key "${m?.[1] ?? body}" (allowed: name, runs-on, timeout-minutes, steps).`);
      if (m[1] === 'name') job.name = unquote(m[2]);
      if (m[1] === 'timeout-minutes') job.timeoutMinutes = Number(m[2]);
      continue;
    }
    if (ind === 6 && body.startsWith('- ')) {
      step = { name: null, uses: null, run: null, if: null, withKeys: [] };
      job.steps.push(step);
    }
    if (!step) continue;
    if (!(ind === 8 || (ind === 6 && body.startsWith('- ')))) continue;
    const kv = /^(?:- )?([\w-]+):\s*(.*)$/.exec(body);
    if (!kv) continue;
    const [, key, value] = kv;
    if (key === 'name') step.name = unquote(value);
    else if (key === 'uses') step.uses = value.replace(/\s+#.*$/, '').trim();
    else if (key === 'if') step.if = value;
    else if (key === 'run') {
      if (/^[|>][+-]?$/.test(value.trim())) {
        const block = [];
        const keyIndent = ind + (body.startsWith('- ') ? 2 : 0);
        let j = i + 1;
        for (; j < lines.length; j += 1) {
          if (lines[j].trim() && indentOf(lines[j]) <= keyIndent) break;
          block.push(lines[j]);
        }
        const nonEmpty = block.filter(l => l.trim());
        const strip = nonEmpty.length ? Math.min(...nonEmpty.map(indentOf)) : 0;
        step.run = block.map(l => l.slice(strip)).join('\n').replace(/\s+$/, '');
        i = j - 1;
      } else {
        step.run = unquote(value);
      }
    } else if (key !== 'with') {
      throw new Error(`Workflow step "${step.name}" uses unsupported key "${key}".`);
    }
  }
  return workflow;
}

/**
 * Turns a parsed workflow into the list of local jobs. Steps that only exist to
 * drive GitHub (checkout, setup-node, upload-artifact) are listed as skipped
 * with the reason; every other `uses:` and every `${{ }}` expression in a run
 * command is refused.
 */
export function planFromWorkflow(workflow) {
  const jobs = workflow.jobs.map(job => {
    if (!job.name) throw new Error(`Workflow job ${job.id} has no name.`);
    const steps = job.steps.map(step => {
      if (step.uses) {
        const action = step.uses.split('@')[0];
        if (!(action in SKIPPED_USES)) throw new Error(`Unrecognised action "${step.uses}" in step "${step.name}". Update public-verify before relying on it.`);
        return { name: step.name ?? step.uses, skipped: true, reason: SKIPPED_USES[action], uses: step.uses };
      }
      if (!step.run) throw new Error(`Workflow step "${step.name}" has neither run nor uses.`);
      if (/\$\{\{/.test(step.run)) throw new Error(`Step "${step.name}" uses a \${{ }} expression, which public-verify does not evaluate.`);
      if (step.if) throw new Error(`Step "${step.name}" has a condition (if: ${step.if}); public-verify does not evaluate conditions.`);
      let run = step.run;
      let note = null;
      if (/^\s*npm install --global /m.test(run)) {
        run = run.split('\n').filter(l => !/^\s*npm install --global /.test(l)).join('\n');
        note = 'Global npm install skipped (the host must already carry the pinned versions); versions are still verified.';
      }
      return { name: step.name, command: run, note, skipped: false };
    });
    if (!steps.some(st => !st.skipped)) throw new Error(`Workflow job "${job.name}" has no runnable step.`);
    return { id: job.id, context: job.name, timeoutMinutes: job.timeoutMinutes ?? 45, steps };
  });
  return { env: workflow.env, jobs };
}

export function checkPlanContexts(plan) {
  const names = plan.jobs.map(j => j.context);
  const missing = REQUIRED_CONTEXTS.filter(c => !names.includes(c));
  if (missing.length) throw new Error(`Workflow has no job named: ${missing.join('; ')}`);
  const extra = names.filter(n => !REQUIRED_CONTEXTS.includes(n));
  if (extra.length) throw new Error(`Workflow has jobs that public-verify does not report: ${extra.join('; ')}`);
}

// ------------------------------------------------------------------- tree ---

export function treeDigest(root) {
  const entries = [];
  const walk = (dir, rel) => {
    for (const dirent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (dirent.name === 'node_modules' || dirent.name === '.git') continue;
      const relPath = rel ? `${rel}/${dirent.name}` : dirent.name;
      if (!rel && (dirent.name === 'coverage' || dirent.name === 'dist')) continue;
      const full = path.join(dir, dirent.name);
      if (dirent.isDirectory()) walk(full, relPath);
      else if (dirent.isSymbolicLink()) entries.push(`l ${sha256Hex(fs.readlinkSync(full))} ${relPath}`);
      else if (dirent.isFile()) {
        const mode = fs.statSync(full).mode & 0o111 ? 'x' : 'f';
        entries.push(`${mode} ${sha256Hex(fs.readFileSync(full))} ${relPath}`);
      }
    }
  };
  walk(root, '');
  entries.sort((a, b) => {
    const pa = a.slice(a.indexOf(' ', 2) + 1);
    const pb = b.slice(b.indexOf(' ', 2) + 1);
    return pa < pb ? -1 : pa > pb ? 1 : 0;
  });
  return { sha256: sha256Hex(`${entries.join('\n')}\n`), fileCount: entries.length };
}

export function lockfileHashes(root) {
  const out = {};
  const walk = (dir, rel) => {
    for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (dirent.name === 'node_modules' || dirent.name === '.git') continue;
      const relPath = rel ? `${rel}/${dirent.name}` : dirent.name;
      if (dirent.isDirectory()) walk(path.join(dir, dirent.name), relPath);
      else if (dirent.name === 'package-lock.json') out[relPath] = sha256Hex(safeReadFile(root, relPath));
    }
  };
  walk(root, '');
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

const hermeticGit = gitDir => ({
  ...process.env,
  GIT_DIR: gitDir,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'public-verify',
  GIT_AUTHOR_EMAIL: 'public-verify@invalid',
  GIT_COMMITTER_NAME: 'public-verify',
  GIT_COMMITTER_EMAIL: 'public-verify@invalid',
});

/**
 * Commits the snapshot into a throwaway git directory kept OUTSIDE the snapshot
 * (so the snapshot never gains a .git). The tree id equals what
 * `git add -A` would commit in a public checkout, so it can be compared with the
 * tree of the pull request head. The commit date is fixed for reproducibility.
 */
export function commitSnapshot(snapshot, gitDir, isoDate) {
  fs.rmSync(gitDir, { recursive: true, force: true });
  const env = { ...hermeticGit(gitDir), GIT_WORK_TREE: snapshot, GIT_AUTHOR_DATE: isoDate, GIT_COMMITTER_DATE: isoDate };
  const run = args => execFileSync('git', args, { env, cwd: snapshot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
  run(['init', '-q', '--initial-branch=main', gitDir]);
  run(['add', '-A']);
  const tree = run(['write-tree']);
  const commit = run(['commit-tree', tree, '-m', 'public-verify snapshot']);
  run(['update-ref', 'refs/heads/main', commit]);
  const files = run(['ls-files']).split('\n').filter(Boolean).length;
  return { tree, commit, files, env: { GIT_DIR: gitDir, GIT_WORK_TREE: snapshot, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_DATE: isoDate, GIT_COMMITTER_DATE: isoDate } };
}

// ------------------------------------------------------- untrusted reads ---

/**
 * Reads a file from a tree we do not trust, on the host. Refuses symbolic links
 * (the file itself or any directory above it) and anything that resolves outside
 * `root`, so a link in a contributor tree cannot make us read or copy host files.
 */
export function safeResolve(root, rel) {
  const realRoot = fs.realpathSync(root);
  const full = path.join(realRoot, rel);
  const parts = path.relative(realRoot, full).split(path.sep);
  if (parts[0] === '..' || path.isAbsolute(rel)) throw new Error(`Refusing path outside the snapshot: ${rel}`);
  let current = realRoot;
  for (const part of parts) {
    current = path.join(current, part);
    const st = fs.lstatSync(current);
    if (st.isSymbolicLink()) throw new Error(`Refusing symbolic link in the tree: ${rel}`);
  }
  const real = fs.realpathSync(full);
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) throw new Error(`Refusing path that resolves outside the snapshot: ${rel}`);
  if (!fs.lstatSync(full).isFile()) throw new Error(`Refusing non-regular file: ${rel}`);
  return full;
}
export const safeReadFile = (root, rel) => fs.readFileSync(safeResolve(root, rel));
export function safeCopyOut(root, rel, destination) {
  fs.copyFileSync(safeResolve(root, rel), destination);
}

// -------------------------------------------------------- workflow pinning ---

/**
 * The pin lists the workflow files (by sha256) that public-verify is known to
 * understand, with the exact step names each job must carry. It is read from the
 * trusted tool tree, never from the tree under test.
 */
export function checkWorkflowPin(workflowText, plan, pin) {
  const digest = sha256Hex(workflowText);
  const entry = (pin?.accepted ?? []).find(e => e.sha256 === digest);
  if (!entry) throw new Error(`public-ci.yml (sha256 ${digest}) is not a workflow public-verify has been reviewed for. Review it, then add it to config/release/public-verify-workflow.v1.json in the trusted tree.`);
  for (const [context, names] of Object.entries(entry.requiredSteps)) {
    const job = plan.jobs.find(j => j.context === context);
    if (!job) throw new Error(`Pinned job missing: ${context}`);
    const have = job.steps.map(st => st.name);
    if (JSON.stringify(have) !== JSON.stringify(names)) throw new Error(`Steps of "${context}" differ from the pinned list.`);
  }
  return entry;
}

export function pinEntryFor(workflowText, plan, note) {
  return {
    sha256: sha256Hex(workflowText),
    note,
    requiredSteps: Object.fromEntries(plan.jobs.map(j => [j.context, j.steps.map(st => st.name)])),
  };
}

// ----------------------------------------------------------------- signing ---

export const SIGN_NAMESPACE = 'saferide-public-verify';
export const SIGNER_PRINCIPAL = 'public-verify@esheria.org';

export function defaultKeyPath(env = process.env) {
  const base = env.SAFERIDE_STATE_DIR ? path.join(env.SAFERIDE_STATE_DIR, 'secrets') : path.join(env.HOME ?? os.homedir(), '.config', 'saferide');
  return path.join(base, 'public-verify-ed25519');
}

/** Creates the verifier key. Never prints the private key. Refuses to overwrite. */
export function initSigner(keyPath) {
  if (fs.existsSync(keyPath)) throw new Error(`A signer key already exists at ${keyPath}; refusing to overwrite it.`);
  fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(keyPath), 0o700);
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', SIGNER_PRINCIPAL, '-f', keyPath], { stdio: 'ignore' });
  fs.chmodSync(keyPath, 0o600);
  const pub = fs.readFileSync(`${keyPath}.pub`, 'utf8').trim();
  const fingerprint = execFileSync('ssh-keygen', ['-l', '-f', `${keyPath}.pub`], { encoding: 'utf8' }).trim();
  return { publicKey: pub, fingerprint, allowedSignersLine: `${SIGNER_PRINCIPAL} namespaces="${SIGN_NAMESPACE}" ${pub.split(' ').slice(0, 2).join(' ')}` };
}

function signedBytes(evidence) {
  const { signature: _s, ...rest } = evidence;
  return Buffer.from(canonicalJson(rest));
}

function withTemp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-sig-'));
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/** Seals the evidence hash, then signs the canonical bytes with an SSH signature. */
export function signEvidence(evidence, keyPath) {
  const sealed = sealEvidence({ ...evidence, signature: undefined });
  const st = fs.statSync(keyPath);
  if (st.mode & 0o077) throw new Error(`Signer key ${keyPath} must be private (mode 0600).`);
  const armored = withTemp(dir => {
    const file = path.join(dir, 'payload');
    fs.writeFileSync(file, signedBytes(sealed));
    execFileSync('ssh-keygen', ['-Y', 'sign', '-q', '-n', SIGN_NAMESPACE, '-f', keyPath, file], { stdio: 'ignore' });
    return fs.readFileSync(`${file}.sig`, 'utf8');
  });
  return { ...sealed, signature: { format: 'sshsig', namespace: SIGN_NAMESPACE, principal: SIGNER_PRINCIPAL, armored } };
}

/** Problems with the signature, checked against an allowed_signers file. Empty means valid. */
export function signatureProblems(evidence, allowedSignersPath) {
  const sig = evidence?.signature;
  if (!sig?.armored) return ['evidence is not signed'];
  if (sig.namespace !== SIGN_NAMESPACE) return [`unexpected signature namespace ${sig.namespace}`];
  if (!fs.existsSync(allowedSignersPath)) return [`allowed signers file not found: ${allowedSignersPath}`];
  return withTemp(dir => {
    const sigFile = path.join(dir, 'payload.sig');
    fs.writeFileSync(sigFile, sig.armored);
    const result = spawnSync('ssh-keygen', ['-Y', 'verify', '-f', allowedSignersPath, '-I', sig.principal ?? SIGNER_PRINCIPAL, '-n', SIGN_NAMESPACE, '-s', sigFile], { input: signedBytes(evidence), encoding: 'utf8' });
    return result.status === 0 ? [] : [`signature does not verify against ${path.basename(allowedSignersPath)}`];
  });
}

/** Re-hashes the step logs found in `logsRoot` (the evidence folder). */
export function logProblems(evidence, logsRoot) {
  const problems = [];
  for (const job of evidence?.jobs ?? []) {
    for (const step of job.steps) {
      if (step.skipped || !step.logFile) continue;
      let data;
      try { data = safeReadFile(logsRoot, step.logFile); } catch { problems.push(`log missing or unsafe: ${step.logFile}`); continue; }
      if (sha256Hex(data) !== step.logSha256) problems.push(`log was modified: ${step.logFile}`);
    }
  }
  return problems;
}

// -------------------------------------------------------------------- lock ---

export function lockDirectory(env = process.env) {
  return env.XDG_RUNTIME_DIR && fs.existsSync(env.XDG_RUNTIME_DIR) ? env.XDG_RUNTIME_DIR : path.join(env.HOME ?? os.homedir(), '.cache');
}

/** O_EXCL lock owned by this user; stale locks (dead pid) are reclaimed. */
export function acquireLock(dir = lockDirectory()) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'saferide-public-verify.lock');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return () => { try { if (fs.readFileSync(file, 'utf8') === String(process.pid)) fs.unlinkSync(file); } catch { /* gone */ } };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const st = fs.lstatSync(file);
      if (st.isSymbolicLink() || !st.isFile() || st.uid !== process.getuid()) throw new Error(`Lock path ${file} is not a plain file owned by this user; refusing.`);
      const holder = Number(fs.readFileSync(file, 'utf8'));
      let alive = false;
      if (holder) { try { process.kill(holder, 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; } }
      if (alive) throw new Error(`Another public-verify run is active (pid ${holder}). Heavy jobs must not overlap.`);
      fs.unlinkSync(file);
    }
  }
  throw new Error('Could not take the public-verify lock.');
}

// ------------------------------------------------------- pull request gate ---

const GATE_FILE_PATTERNS = [/^scripts\//, /^package\.json$/, /^package-lock\.json$/, /^vitest[^/]*\.mjs$/, /^config\//, /(^|\/)\.npmrc$/, /^\.github\//, /(^|\/)package(-lock)?\.json$/, /^tsconfig[^/]*\.json$/];
export const isGateFile = filename => GATE_FILE_PATTERNS.some(re => re.test(filename));

/** Printed list: a leading "!" marks a file that can change what the gates do. */
export function summarizeChangedFiles(files) {
  return files.map(f => `${isGateFile(f.filename) ? '!' : ' '} ${f.status.padEnd(9)} ${f.filename}`).join('\n');
}

const INSTALL_LINE = /^\s*npm( --prefix \S+)? ci --ignore-scripts\s*$/;
/** Network is for the fixed npm install lines only; nothing else the tree controls. */
export const needsNetwork = command => {
  const lines = command.split('\n').filter(l => l.trim());
  return lines.length > 0 && lines.every(l => INSTALL_LINE.test(l));
};

/** Snapshots we built ourselves may fetch audit data from inside their steps. */
export const needsNetworkTrustedTree = command => needsNetwork(command) || /\bnpm (--prefix \S+ )?ci\b|\baudit\b|\bsecurity:(api|mobile)-audit:check\b/.test(command);

export const AUDIT_WORKSPACES = Object.freeze({ mobile: '.', api: 'apps/api', web: 'web' });

/**
 * For pull requests the audit data is fetched by the trusted runner and the
 * tree's own check scripts read it offline from a file. Returns the rewritten
 * command, or a marker for the web audit, which the runner evaluates itself.
 */
export function offlineAuditRewrite(command, auditDir) {
  const lines = command.split('\n').map(line => {
    if (/^\s*npm run security:api-audit:check\s*$/.test(line)) return `npm run security:api-audit:check -- --input ${auditDir}/api.json`;
    if (/^\s*npm run security:mobile-audit:check\s*$/.test(line)) return `npm run security:mobile-audit:check -- --input ${auditDir}/mobile.json`;
    return line;
  });
  return lines.join('\n');
}
export const isWebAudit = command => /^\s*npm --prefix web audit --omit=dev --audit-level=(high|critical|moderate|low)\s*$/.test(command.trim());

/** npm audit exits non-zero when anything at or above `level` is present. */
export function auditExitFromReport(report, level) {
  const order = ['info', 'low', 'moderate', 'high', 'critical'];
  const counts = report?.metadata?.vulnerabilities ?? {};
  return order.slice(order.indexOf(level)).some(l => (counts[l] ?? 0) > 0) ? 1 : 0;
}

// --------------------------------------------------------------- evidence ---

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function evidenceHash(evidence) {
  const { evidenceSha256: _ignored, signature: _sig, ...rest } = evidence;
  return sha256Hex(canonicalJson(rest));
}

export function sealEvidence(evidence) {
  return { ...evidence, evidenceSha256: evidenceHash(evidence) };
}

export function jobPassed(job) {
  const real = (job.steps ?? []).filter(s => !s.skipped);
  return real.length > 0 && real.every(s => s.exitCode === 0);
}

export function overallStatus(jobs) {
  return jobs.every(jobPassed) && jobs.length === REQUIRED_CONTEXTS.length ? 'passed' : 'failed';
}

export function checkEvidence(evidence, { snapshotTree } = {}) {
  const problems = [];
  if (evidence?.schema !== EVIDENCE_SCHEMA) problems.push(`unknown schema ${evidence?.schema}`);
  if (evidence?.evidenceSha256 !== evidenceHash(evidence ?? {})) problems.push('evidenceSha256 does not match the content (file was edited)');
  const contexts = (evidence?.jobs ?? []).map(j => j.context).sort();
  if (JSON.stringify(contexts) !== JSON.stringify([...REQUIRED_CONTEXTS].sort())) problems.push(`jobs are not exactly the two required contexts: ${contexts.join('; ')}`);
  const recomputed = overallStatus(evidence?.jobs ?? []);
  if (evidence?.status !== recomputed) problems.push(`recorded status "${evidence?.status}" disagrees with the steps ("${recomputed}")`);
  if (snapshotTree && snapshotTree !== evidence?.snapshot?.treeSha256) problems.push('snapshot tree sha256 differs from the evidence');
  return problems;
}

/** Reasons the evidence must not be turned into commit statuses. Empty means OK. */
export function postBlockers(evidence, { now = Date.now(), maxAgeHours = 48 } = {}) {
  const problems = checkEvidence(evidence);
  if (evidence?.status !== 'passed') problems.push('a step failed; statuses are only posted for a fully green run');
  for (const job of evidence?.jobs ?? []) {
    if (!(job.steps ?? []).some(s => !s.skipped)) problems.push(`job has no executed step: ${job.context}`);
    for (const s of job.steps) if (!s.skipped && s.exitCode !== 0) problems.push(`step failed: ${job.context} / ${s.name} (exit ${s.exitCode})`);
  }
  const prov = evidence?.provenance ?? {};
  if (evidence?.mode === 'pull-request') {
    const pr = evidence.pullRequest ?? {};
    if (pr.reviewedDiffConfirmed !== true) problems.push('the maintainer did not confirm reviewing the diff');
    if (!/^[0-9a-f]{40}$/.test(pr.headSha ?? '')) problems.push('no pinned pull request head sha');
    if ((pr.gateFilesChanged ?? []).length && pr.allowGateFileChanges !== true) problems.push(`the pull request changes files that define the gates (${pr.gateFilesChanged.join(', ')}); re-run with --allow-gate-file-changes after reviewing them`);
    if (pr.headMovedDuringRun !== false) problems.push('the pull request head moved (or could not be re-checked) during the run');
    if (evidence.sandbox?.tool !== 'bwrap') problems.push('a contributor pull request was not run inside the sandbox');
  } else if (prov.sourceBranch !== 'main') problems.push(`source branch is "${prov.sourceBranch}", not main (a review build)`);
  if (evidence?.mode !== 'pull-request' && prov.sourceTreeState !== 'clean') problems.push(`source tree state is "${prov.sourceTreeState}", not clean`);
  if (evidence?.mode !== 'pull-request' && !/^[0-9a-f]{40}$/.test(prov.sourceCommit ?? '')) problems.push('no valid source commit in the provenance');
  if (evidence?.snapshot?.unchangedByRun !== true) problems.push('the snapshot changed while the steps ran');
  const age = (now - Date.parse(evidence?.finishedAt ?? '')) / 3_600_000;
  if (!Number.isFinite(age) || age > maxAgeHours || age < -0.1) problems.push(`evidence is not fresh (older than ${maxAgeHours} h or dated in the future)`);
  return problems;
}

export function statusDescription(evidence) {
  return `Verified on maintainers' server by public-verify. evidence sha256 ${evidence.evidenceSha256.slice(0, 16)} tree ${evidence.snapshot.gitTreeSha.slice(0, 12)}`.slice(0, 140);
}

/**
 * Posts the two commit statuses. `gh(args)` is injected: the CLI supplies the
 * real `gh`, tests supply a fake. Nothing is posted unless every blocker is
 * cleared and the target commit's tree is exactly the verified snapshot.
 */
export function postStatuses({ evidence, repo, sha, targetUrl, gh, now, signatureCheck }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo ?? '')) throw new Error('--repo must look like owner/name');
  if (!/^[0-9a-f]{40}$/.test(sha ?? '')) throw new Error('--sha must be a full 40-character commit id');
  if (typeof gh !== 'function') throw new Error('postStatuses needs an injected gh runner');
  if (typeof signatureCheck !== 'function') throw new Error('postStatuses needs a signature check');
  const blockers = [...signatureCheck(evidence), ...postBlockers(evidence, { now })];
  if (evidence?.mode === 'pull-request' && evidence.pullRequest?.headSha !== sha) blockers.push(`this evidence is for pull request head ${evidence.pullRequest?.headSha}, not ${sha}`);
  if (evidence?.mode === 'pull-request' && evidence.pullRequest?.repo !== repo) blockers.push(`this evidence is for ${evidence.pullRequest?.repo}, not ${repo}`);
  if (blockers.length) throw new Error(`Refusing to post statuses:\n- ${blockers.join('\n- ')}`);
  const remoteTree = String(gh(['api', `repos/${repo}/git/commits/${sha}`, '--jq', '.tree.sha'])).trim();
  if (remoteTree !== evidence.snapshot.gitTreeSha) {
    throw new Error(`Refusing to post: commit ${sha} has tree ${remoteTree}, but the verified snapshot is tree ${evidence.snapshot.gitTreeSha}.`);
  }
  const description = statusDescription(evidence);
  const posted = [];
  for (const context of REQUIRED_CONTEXTS) {
    const args = ['api', '--method', 'POST', `repos/${repo}/statuses/${sha}`, '-f', 'state=success', '-f', `context=${context}`, '-f', `description=${description}`];
    if (targetUrl) args.push('-f', `target_url=${targetUrl}`);
    gh(args);
    posted.push(context);
  }
  return { posted, description, tree: remoteTree };
}

// ---------------------------------------------------------------- summary ---

const fmtMs = ms => (ms >= 60_000 ? `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s` : `${(ms / 1000).toFixed(1)}s`);

export function renderSummary(evidence) {
  const lines = [];
  const prov = evidence.provenance;
  lines.push(`## Local verification: ${evidence.status === 'passed' ? 'PASSED' : 'FAILED'}`, '');
  lines.push('GitHub Actions is unavailable for this organisation (billing lock), so the two required checks were run on the maintainers\' own server with `scripts/public-verify.mjs` and reported as commit statuses with the same names.', '');
  lines.push(`- Source commit (private repository): \`${prov.sourceCommit}\` on \`${prov.sourceBranch}\` (${prov.sourceTreeState})`);
  lines.push(`- Snapshot tree sha256: \`${evidence.snapshot.treeSha256}\``);
  lines.push(`- Git tree id: \`${evidence.snapshot.gitTreeSha}\``);
  lines.push(`- Evidence sha256: \`${evidence.evidenceSha256}\``);
  lines.push(`- Run: ${evidence.startedAt} to ${evidence.finishedAt} (host load at start ${evidence.host.loadAverageAtStart})`);
  lines.push(`- Tools: node ${evidence.toolchain.node}, npm ${evidence.toolchain.npm}, ${evidence.toolchain.git}`);
  if (evidence.reproducibility?.archiveSha256) lines.push(`- Reproducible source archive sha256 (both builds identical): \`${evidence.reproducibility.archiveSha256}\``);
  lines.push('');
  for (const job of evidence.jobs) {
    lines.push(`### ${job.context}: ${jobPassed(job) ? 'passed' : 'FAILED'}`, '', '| Step | Result | Time |', '| --- | --- | --- |');
    for (const s of job.steps) {
      if (s.skipped) lines.push(`| ${s.name} | skipped (${s.reason}) | |`);
      else lines.push(`| ${s.name} | ${s.exitCode === 0 ? 'pass' : `FAIL (exit ${s.exitCode})`} | ${fmtMs(s.durationMs)} |`);
    }
    lines.push('');
  }
  lines.push('### Check it yourself', '', 'From a checkout of this branch:', '', '```', 'node scripts/public-verify.mjs --check-evidence public-verify-evidence.json --snapshot .', '```', '', 'That recomputes the evidence hash and the tree sha256 of your checkout and compares them. To re-run every gate: `node scripts/public-verify.mjs --snapshot <dir>` (needs Node 24.18.1 and npm 11.16.0).', '');
  return `${lines.join('\n')}`;
}

// ---------------------------------------------------------- sandbox / PR ---

/**
 * Contributor pull requests are untrusted: install may not run lifecycle
 * scripts. (The commands themselves come from the trusted base branch.)
 */
export function hardenCommandForPr(command) {
  return command.split('\n').map(line => {
    if (/^\s*npm (--prefix \S+ )?ci\b/.test(line) && !/--ignore-scripts/.test(line)) return `${line.trimEnd()} --ignore-scripts`;
    return line;
  }).join('\n');
}

/** The only /etc entries visible in the sandbox (DNS, TLS roots, user names, loader cache). */
export const SANDBOX_ETC = Object.freeze(['/etc/resolv.conf', '/etc/hosts', '/etc/nsswitch.conf', '/etc/passwd', '/etc/group', '/etc/ssl', '/etc/ca-certificates', '/etc/ld.so.cache', '/etc/localtime']);

export function assertSandboxPaths({ nodeRoot, home, snapshot }) {
  const inside = (parent, child) => { const rel = path.relative(parent, child); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };
  if (['/', '/usr', '/home', '/etc', '/tmp'].includes(nodeRoot)) throw new Error(`Node root ${nodeRoot} is too broad to bind into the sandbox.`);
  if (inside(nodeRoot, home) || inside(nodeRoot, snapshot)) throw new Error('The Node root contains HOME or the checkout; refusing to bind it read-only into the sandbox.');
}

/**
 * argv for running one step inside bubblewrap: an allow-listed read-only view of
 * the system, no HOME, no other users' files, a private /tmp, only the
 * given directories writable, a cleared environment, new PID/IPC/UTS namespaces,
 * and (unless network is allowed) no network. Wrapped in a systemd user scope
 * with memory and task caps when asked.
 */
export function buildSandboxArgv({ command, cwd, writable = [], readonly = [], env = {}, network = false, memoryMax, tasksMax, scope = true }) {
  const args = ['--die-with-parent', '--new-session', '--unshare-pid', '--unshare-ipc', '--unshare-uts'];
  if (!network) args.push('--unshare-net');
  args.push('--ro-bind', '/usr', '/usr');
  for (const entry of SANDBOX_ETC) if (fs.existsSync(entry)) args.push('--ro-bind', entry, entry);
  if (fs.existsSync('/run/systemd/resolve')) args.push('--ro-bind', '/run/systemd/resolve', '/run/systemd/resolve');
  for (const [link, target] of [['/bin', 'usr/bin'], ['/sbin', 'usr/sbin'], ['/lib', 'usr/lib'], ['/lib64', 'usr/lib64']]) args.push('--symlink', target, link);
  args.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp');
  for (const dir of readonly) args.push('--ro-bind', dir, dir);
  for (const dir of writable) args.push('--bind', dir, dir);
  args.push('--chdir', cwd, '--clearenv');
  for (const [k, v] of Object.entries(env)) args.push('--setenv', k, String(v));
  args.push('--', 'bash', '-e', '-c', command);
  const bwrap = ['bwrap', ...args];
  if (!scope) return bwrap;
  const props = [];
  if (memoryMax) props.push('-p', `MemoryMax=${memoryMax}`);
  if (tasksMax) props.push('-p', `TasksMax=${tasksMax}`);
  return ['systemd-run', '--user', '--scope', '--quiet', ...props, '--', ...bwrap];
}

/** A minimal environment: no tokens, no HOME of the operator. */
export function scrubbedEnv({ nodeBin, home, tmp, extra = {}, untrusted = false }) {
  return {
    PATH: `${nodeBin}:/usr/local/bin:/usr/bin:/bin`,
    HOME: home,
    TMPDIR: tmp,
    LANG: 'C.UTF-8',
    CI: 'true',
    npm_config_cache: `${home}/.npm`,
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    ...(untrusted ? {
      npm_config_ignore_scripts: 'true',
      npm_config_userconfig: '/dev/null',
      npm_config_globalconfig: '/dev/null',
      npm_config_registry: 'https://registry.npmjs.org/',
    } : {}),
    ...extra,
  };
}


// ------------------------------------------------------------------- args ---

export function parseArgs(argv) {
  const opts = { postStatuses: false, dryRun: false, maxLoad: 8, waitMinutes: 0, ignoreLoad: false, sandbox: false, reviewedDiff: false, keepWork: false, allowGateFileChanges: false, initSigner: false };
  const need = (i, flag) => {
    if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new Error(`${flag} needs a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    switch (a) {
      case '--snapshot': opts.snapshot = need(i, a); i += 1; break;
      case '--out': opts.out = need(i, a); i += 1; break;
      case '--repo': opts.repo = need(i, a); i += 1; break;
      case '--sha': opts.sha = need(i, a); i += 1; break;
      case '--target-url': opts.targetUrl = need(i, a); i += 1; break;
      case '--evidence': opts.evidence = need(i, a); i += 1; break;
      case '--check-evidence': opts.checkEvidence = need(i, a); i += 1; break;
      case '--max-load': opts.maxLoad = Number(need(i, a)); i += 1; break;
      case '--wait-for-load': opts.waitMinutes = Number(need(i, a)); i += 1; break;
      case '--pr': opts.pr = Number(need(i, a)); i += 1; break;
      case '--work-root': opts.workRoot = need(i, a); i += 1; break;
      case '--i-have-reviewed-the-diff': opts.reviewedDiff = true; break;
      case '--sandbox': opts.sandbox = true; break;
      case '--keep-work': opts.keepWork = true; break;
      case '--allow-gate-file-changes': opts.allowGateFileChanges = true; break;
      case '--init-signer': opts.initSigner = true; break;
      case '--signer-key': opts.signerKey = need(i, a); i += 1; break;
      case '--allowed-signers': opts.allowedSigners = need(i, a); i += 1; break;
      case '--logs': opts.logs = need(i, a); i += 1; break;
      case '--unsigned': opts.unsigned = true; break;
      case '--max-age-hours': opts.maxAgeHours = Number(need(i, a)); i += 1; break;
      case '--post-statuses': opts.postStatuses = true; break;
      case '--dry-run': opts.dryRun = true; break;
      case '--ignore-load': opts.ignoreLoad = true; break;
      case '--help': case '-h': opts.help = true; break;
      default: throw new Error(`Unknown argument: ${a}`);
    }
  }
  if (opts.pr !== undefined) {
    if (!Number.isInteger(opts.pr) || opts.pr <= 0) throw new Error('--pr needs a pull request number');
    if (opts.snapshot) throw new Error('--pr and --snapshot are exclusive');
    opts.repo = opts.repo ?? 'esherialabs/saferide';
    if (opts.sha) throw new Error('--sha is not used with --pr: the head is pinned when the diff is shown');
    if (opts.sandbox === false) opts.sandbox = true;
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(opts.repo)) throw new Error('--repo must look like owner/name');
  } else {
    if (opts.reviewedDiff || opts.workRoot || opts.keepWork || opts.allowGateFileChanges) throw new Error('--i-have-reviewed-the-diff, --work-root, --keep-work and --allow-gate-file-changes only apply with --pr');
    if (opts.postStatuses && (!opts.repo || !opts.sha)) throw new Error('--post-statuses needs --repo owner/name and --sha <40-hex>');
    if ((opts.repo || opts.sha || opts.targetUrl) && !opts.postStatuses) throw new Error('--repo/--sha/--target-url only apply with --post-statuses');
  }
  if (opts.evidence && !opts.postStatuses) throw new Error('--evidence is only used with --post-statuses (use --check-evidence to inspect a file)');
  if (opts.pr !== undefined && opts.targetUrl && !opts.postStatuses) throw new Error('--target-url only applies with --post-statuses');
  if (opts.postStatuses && opts.dryRun) throw new Error('--post-statuses cannot be combined with --dry-run');
  if (!Number.isFinite(opts.maxLoad) || !Number.isFinite(opts.waitMinutes)) throw new Error('--max-load and --wait-for-load must be numbers');
  return opts;
}
