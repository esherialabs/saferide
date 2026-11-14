#!/usr/bin/env node
// Runs, on our own machine, the two jobs of the public repository's
// .github/workflows/public-ci.yml against a built public snapshot, writes
// evidence signed with a dedicated verifier key, and can report the result as
// the two commit statuses the public branch protection requires.
//
//   node scripts/public-verify.mjs --init-signer
//   node scripts/public-verify.mjs --snapshot <dir> [--out <dir>] [--sandbox]
//   node scripts/public-verify.mjs --check-evidence <file> [--snapshot <dir>] [--logs <dir>]
//   node scripts/public-verify.mjs --evidence <file> --post-statuses --repo owner/name --sha <40-hex>
//   node scripts/public-verify.mjs --pr <n> --i-have-reviewed-the-diff [--post-statuses]
//
// The step commands are read from the workflow file (pinned by sha256 in
// config/release/public-verify-workflow.v1.json, read from this tool's own tree),
// so the local gate cannot silently drift from the written gate. Posting
// statuses is never the default and needs a valid signature.

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  EVIDENCE_SCHEMA, acquireLock, assertSandboxPaths, auditExitFromReport, buildSandboxArgv, checkEvidence, checkPlanContexts,
  checkWorkflowPin, commitSnapshot, defaultKeyPath, hardenCommandForPr, initSigner, isGateFile, isWebAudit, jobPassed,
  lockfileHashes, logProblems, needsNetwork, needsNetworkTrustedTree, offlineAuditRewrite, overallStatus, parseArgs,
  parseWorkflow, planFromWorkflow, postBlockers, postStatuses, renderSummary, safeCopyOut, safeReadFile, safeResolve,
  scrubbedEnv, sealEvidence, sha256Hex, signEvidence, signatureProblems, summarizeChangedFiles, treeDigest, AUDIT_WORKSPACES,
} from './lib/public-verify.mjs';

const TOOL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PIN_PATH = path.join(TOOL_ROOT, 'config/release/public-verify-workflow.v1.json');
const ALLOWED_SIGNERS = path.join(TOOL_ROOT, 'config/release/public-verify-allowed-signers');
const WORKFLOW = '.github/workflows/public-ci.yml';
const MIN_FREE_BYTES = 15 * 1024 ** 3;
const PR_MAX_BYTES = 300 * 1024 ** 2;
const PR_MAX_FILES = 30_000;
const STEP_OUTPUT_TAIL = 4000;

const USAGE = `Usage:
  node scripts/public-verify.mjs --init-signer [--signer-key PATH]
  node scripts/public-verify.mjs --snapshot DIR [--out DIR] [--dry-run] [--sandbox] [--unsigned]
        [--max-load 8] [--wait-for-load MINUTES] [--ignore-load] [--signer-key PATH]
  node scripts/public-verify.mjs --pr NUMBER [--repo owner/name] --i-have-reviewed-the-diff
        [--allow-gate-file-changes] [--post-statuses] [--keep-work] [--work-root DIR] [--out DIR]
        (a contributor pull request, in a bubblewrap sandbox; docs/open-source/local-verification.md)
  node scripts/public-verify.mjs --check-evidence FILE [--snapshot DIR] [--logs DIR] [--allowed-signers FILE] [--max-age-hours N]
  node scripts/public-verify.mjs --evidence FILE --post-statuses --repo owner/name --sha FULL_SHA [--target-url URL]`;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const load1 = () => Number(fs.readFileSync('/proc/loadavg', 'utf8').split(' ')[0]);
const realGh = args => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
const ghJson = args => JSON.parse(realGh(args));
const version = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8' }).trim(); } catch { return 'unavailable'; } };

function freeBytes(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const st = fs.statfsSync(dir);
  return st.bavail * st.bsize;
}
function requireFreeDisk(...dirs) {
  for (const dir of dirs) {
    const free = freeBytes(dir);
    if (free < MIN_FREE_BYTES) throw new Error(`Only ${(free / 1024 ** 3).toFixed(1)} GB free under ${dir}; at least 15 GB are required.`);
  }
}

async function waitForQuietHost(opts, label) {
  if (opts.ignoreLoad) return;
  const deadline = Date.now() + opts.waitMinutes * 60_000;
  while (load1() >= opts.maxLoad) {
    if (Date.now() >= deadline) throw new Error(`Host load ${load1()} is not below ${opts.maxLoad} before "${label}". Retry later or use --wait-for-load MINUTES.`);
    await sleep(30_000);
  }
}

function runStep({ argv, label, cwd, env, logFile, timeoutMs }) {
  return new Promise(resolve => {
    const started = Date.now();
    const log = fs.openSync(logFile, 'w', 0o600);
    fs.writeSync(log, `$ ${label}\n`);
    const child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ['ignore', log, log], detached: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }, timeoutMs);
    child.on('close', code => {
      clearTimeout(timer);
      fs.closeSync(log);
      resolve({ exitCode: timedOut ? 124 : (code ?? 1), durationMs: Date.now() - started, timedOut });
    });
    child.on('error', () => { clearTimeout(timer); fs.closeSync(log); resolve({ exitCode: 127, durationMs: Date.now() - started, timedOut: false }); });
  });
}

const tail = file => { const t = fs.readFileSync(file, 'utf8'); return t.length > STEP_OUTPUT_TAIL ? `...${t.slice(-STEP_OUTPUT_TAIL)}` : t; };

let scopeCache;
function scopeAvailable() {
  if (scopeCache === undefined) {
    try { execFileSync('systemd-run', ['--user', '--scope', '--quiet', 'true'], { stdio: 'ignore' }); scopeCache = true; } catch { scopeCache = false; }
  }
  return scopeCache;
}

/** Trusted-runner fetch of npm audit data for the pull request's lockfiles. No tree-controlled code runs. */
function fetchAuditData(snapshot, auditDir) {
  fs.mkdirSync(auditDir, { recursive: true, mode: 0o700 });
  const hashes = {};
  for (const [name, workspace] of Object.entries(AUDIT_WORKSPACES)) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `pv-audit-${name}-`));
    try {
      for (const file of ['package.json', 'package-lock.json']) safeCopyOut(snapshot, path.posix.join(workspace === '.' ? '' : workspace, file), path.join(tmp, file));
      const result = (() => {
        try {
          return { status: 0, stdout: execFileSync('npm', ['audit', '--omit=dev', '--json'], { cwd: tmp, encoding: 'utf8', timeout: 180_000, maxBuffer: 64 * 1024 * 1024, env: { PATH: process.env.PATH, HOME: tmp, npm_config_userconfig: '/dev/null', npm_config_globalconfig: '/dev/null', npm_config_registry: 'https://registry.npmjs.org/', npm_config_update_notifier: 'false' } }) };
        } catch (e) { return { status: e.status, stdout: e.stdout ?? '' }; }
      })();
      if (![0, 1].includes(result.status)) throw new Error(`npm audit for ${name} failed`);
      JSON.parse(result.stdout);
      fs.writeFileSync(path.join(auditDir, `${name}.json`), result.stdout, { mode: 0o600 });
      hashes[name] = sha256Hex(result.stdout);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  return hashes;
}

function removeNpmrc(root) {
  const removed = [];
  const walk = (dir, rel) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (d.name === 'node_modules' || d.name === '.git') continue;
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) walk(path.join(dir, d.name), r);
      else if (d.name === '.npmrc') { fs.rmSync(path.join(dir, d.name), { force: true }); removed.push(r); }
    }
  };
  walk(root, '');
  return removed;
}

function sandboxArgv({ command, snapshot, home, gitDir, nodeRoot, readonlyExtra = [], network, env }) {
  return buildSandboxArgv({
    command, cwd: snapshot, network, env,
    readonly: [nodeRoot, ...readonlyExtra],
    writable: [snapshot, home, gitDir],
    memoryMax: '10G', tasksMax: 768, scope: scopeAvailable(),
  });
}

function loadPin() {
  return JSON.parse(fs.readFileSync(PIN_PATH, 'utf8'));
}

function signIfWanted(evidence, opts) {
  if (opts.unsigned) return evidence;
  const keyPath = opts.signerKey ?? defaultKeyPath();
  if (!fs.existsSync(keyPath)) throw new Error(`No signer key at ${keyPath}. Run: node scripts/public-verify.mjs --init-signer (or pass --unsigned for an unusable, unsigned report).`);
  return signEvidence(evidence, keyPath);
}

async function runGates({ opts, snapshot, plan, workflowText, provenance, outDir, mode, pullRequest, commitDate, scratch }) {
  const pins = { node: plan.env.NODE_VERSION, npm: plan.env.NPM_VERSION };
  const untrusted = mode === 'pull-request';
  const sandboxed = opts.sandbox || untrusted;
  if (sandboxed) {
    try { execFileSync('bwrap', ['--version'], { stdio: 'ignore' }); } catch { throw new Error('bubblewrap (bwrap) is required for sandboxed runs.'); }
    if (!scopeAvailable()) {
      if (untrusted) throw new Error('systemd user scope (memory and task caps) is unavailable; refusing to run contributor code without resource limits.');
      console.warn('systemd user scope unavailable: memory and task caps are NOT applied.');
    }
  }
  requireFreeDisk(outDir, scratch ?? os.tmpdir());
  fs.mkdirSync(path.join(outDir, 'logs'), { recursive: true, mode: 0o700 });
  const release = acquireLock();
  const gitDirParent = fs.mkdtempSync(path.join(scratch ?? os.tmpdir(), 'public-verify-git-'));
  const home = fs.mkdtempSync(path.join(scratch ?? os.tmpdir(), 'public-verify-home-'));
  try {
    const startedAt = new Date().toISOString();
    const loadAtStart = load1();
    const removedNpmrc = untrusted ? removeNpmrc(snapshot) : [];
    const before = treeDigest(snapshot);
    const committed = commitSnapshot(snapshot, path.join(gitDirParent, 'repo.git'), commitDate);
    const nodeRoot = path.dirname(path.dirname(process.execPath));
    if (sandboxed) assertSandboxPaths({ nodeRoot, home, snapshot });
    const auditDir = path.join(home, '..', `audit-${path.basename(home)}`);
    let auditHashes;
    if (untrusted) auditHashes = fetchAuditData(snapshot, auditDir);
    // Execution tuning only (does not change any gate): recorded in the evidence.
    const tuning = process.env.VITEST_MAX_WORKERS ? { VITEST_MAX_WORKERS: process.env.VITEST_MAX_WORKERS } : {};
    const baseEnv = sandboxed
      ? scrubbedEnv({ nodeBin: path.dirname(process.execPath), home, tmp: '/tmp', untrusted, extra: { ...committed.env, NODE_VERSION: pins.node, NPM_VERSION: pins.npm, ...tuning } })
      : { ...process.env, ...committed.env, CI: 'true', NODE_VERSION: pins.node, NPM_VERSION: pins.npm, npm_config_update_notifier: 'false' };
    const toolchain = { node: process.version, npm: version('npm', ['--version']), git: version('git', ['--version']), os: `${os.type()} ${os.release()} ${os.arch()}` };

    const jobs = [];
    let seq = 0;
    for (const job of plan.jobs) {
      const record = { context: job.context, id: job.id, steps: [] };
      jobs.push(record);
      const jobStart = Date.now();
      for (const step of job.steps) {
        if (step.skipped) { record.steps.push({ name: step.name, skipped: true, reason: step.reason }); continue; }
        seq += 1;
        const logName = `${String(seq).padStart(2, '0')}-${step.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)}.log`;
        const logFile = path.join(outDir, 'logs', logName);
        let command = untrusted ? hardenCommandForPr(step.command) : step.command;
        const network = sandboxed && (untrusted ? needsNetwork(command) : needsNetworkTrustedTree(command));
        if (/\bnpm (--prefix \S+ )?ci\b|coverage/.test(command)) await waitForQuietHost(opts, step.name);
        const remaining = job.timeoutMinutes * 60_000 - (Date.now() - jobStart);
        console.log(`[${job.context}] ${step.name}${sandboxed ? (network ? ' (sandbox, network)' : ' (sandbox, offline)') : ''} ...`);
        let result;
        if (untrusted && isWebAudit(command)) {
          // Evaluated by the trusted runner from the fetched report; no tree code runs.
          const level = /--audit-level=(\w+)/.exec(command)[1];
          const report = JSON.parse(fs.readFileSync(path.join(auditDir, 'web.json'), 'utf8'));
          const code = auditExitFromReport(report, level);
          fs.writeFileSync(logFile, `$ ${command}\n(trusted runner) npm audit data fetched for web/package-lock.json; vulnerabilities: ${JSON.stringify(report.metadata?.vulnerabilities ?? {})}\nexit ${code}\n`, { mode: 0o600 });
          result = { exitCode: code, durationMs: 0, timedOut: false };
        } else {
          const runCommand = untrusted ? offlineAuditRewrite(command, auditDir) : command;
          const argv = sandboxed
            ? sandboxArgv({ command: runCommand, snapshot, home, gitDir: gitDirParent, nodeRoot, readonlyExtra: untrusted ? [auditDir] : [], network, env: baseEnv })
            : ['bash', '-e', '-c', runCommand];
          result = await runStep({ argv, label: runCommand, cwd: snapshot, env: sandboxed ? process.env : baseEnv, logFile, timeoutMs: Math.max(remaining, 1000) });
        }
        record.steps.push({
          name: step.name, command, note: step.note ?? undefined, exitCode: result.exitCode, durationMs: result.durationMs,
          network: sandboxed ? network : undefined,
          timedOut: result.timedOut || undefined, logFile: `logs/${logName}`, logSha256: sha256Hex(fs.readFileSync(logFile)),
        });
        console.log(`    exit ${result.exitCode} in ${(result.durationMs / 1000).toFixed(1)}s`);
        // Keep going after a failure, so the evidence shows every failing gate (CI also reports each job).
        if (result.exitCode !== 0) console.log(tail(logFile));
      }
    }
    const after = treeDigest(snapshot);
    let archiveSha256;
    const copyIfSafe = (rel, name) => { try { safeCopyOut(snapshot, rel, path.join(outDir, name)); return true; } catch { return false; } };
    try {
      archiveSha256 = safeReadFile(snapshot, 'dist/repro-a/SHA256SUMS.txt').toString('utf8').split(/\s+/)[0];
      if (!/^[0-9a-f]{64}$/.test(archiveSha256)) archiveSha256 = undefined;
      copyIfSafe('dist/repro-a/SHA256SUMS.txt', 'repro-a-SHA256SUMS.txt');
      copyIfSafe('dist/repro-a/reproducible-source-build.json', 'repro-a-reproducible-source-build.json');
    } catch { /* job did not produce one */ }
    copyIfSafe('coverage/coverage-summary.json', 'coverage-summary.json');
    fs.rmSync(auditDir, { recursive: true, force: true });

    return sealEvidence({
      schema: EVIDENCE_SCHEMA,
      mode,
      startedAt,
      finishedAt: new Date().toISOString(),
      host: { loadAverageAtStart: loadAtStart, cpus: os.cpus().length, tuning },
      toolchain,
      pins,
      provenance,
      workflow: { path: WORKFLOW, sha256: sha256Hex(workflowText), pinned: true, source: untrusted ? 'trusted base commit' : 'snapshot' },
      lockfiles: lockfileHashes(snapshot),
      snapshot: {
        treeSha256: before.sha256,
        fileCount: before.fileCount,
        gitTreeSha: committed.tree,
        gitTrackedFiles: committed.files,
        unchangedByRun: before.sha256 === after.sha256,
        treeSha256After: after.sha256,
      },
      sandbox: sandboxed ? {
        tool: 'bwrap',
        network: untrusted ? 'npm install lines only; audit data fetched by the trusted runner; everything else offline' : 'install and audit steps only; everything else offline',
        home: 'private, empty at start, writable', gitDir: 'writable', limits: scopeAvailable() ? 'MemoryMax=10G TasksMax=768 per step (systemd user scope)' : 'none (systemd user scope unavailable)',
        npmrcRemoved: removedNpmrc, auditDataSha256: auditHashes,
      } : undefined,
      pullRequest,
      reproducibility: archiveSha256 ? { archiveSha256 } : undefined,
      jobs,
      status: overallStatus(jobs),
    });
  } finally {
    fs.rmSync(gitDirParent, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
    release();
  }
}

function writeOutputs(evidence, outDir) {
  fs.writeFileSync(path.join(outDir, 'public-verify-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(outDir, 'public-verify-summary.md'), renderSummary(evidence), { mode: 0o600 });
  console.log(`\nStatus: ${evidence.status}${evidence.signature ? ' (signed)' : ' (UNSIGNED, not usable for statuses)'}\nEvidence: ${path.join(outDir, 'public-verify-evidence.json')}\nEvidence sha256: ${evidence.evidenceSha256}`);
  for (const job of evidence.jobs) console.log(`  ${jobPassed(job) ? 'PASS' : 'FAIL'}  ${job.context}`);
}

async function verify(opts) {
  const snapshot = path.resolve(opts.snapshot);
  const provenance = JSON.parse(safeReadFile(snapshot, 'PUBLIC_MIRROR_PROVENANCE.json').toString('utf8'));
  safeResolve(snapshot, 'package-lock.json');
  const workflowText = safeReadFile(snapshot, WORKFLOW).toString('utf8');
  const plan = planFromWorkflow(parseWorkflow(workflowText));
  checkPlanContexts(plan);
  checkWorkflowPin(workflowText, plan, loadPin());

  const outDir = path.resolve(opts.out ?? path.join(path.dirname(snapshot), `public-verify-${String(provenance.sourceCommit).slice(0, 12)}`));
  if (outDir === snapshot || outDir.startsWith(`${snapshot}${path.sep}`)) throw new Error('--out must be outside the snapshot.');
  if (opts.dryRun) {
    console.log(`Snapshot: ${snapshot}\nSource commit: ${provenance.sourceCommit} (${provenance.sourceBranch})\nPins: node ${plan.env.NODE_VERSION}, npm ${plan.env.NPM_VERSION}; workflow sha256 matches the reviewed pin`);
    for (const job of plan.jobs) {
      console.log(`\n[${job.context}]`);
      for (const s of job.steps) console.log(s.skipped ? `  - skip: ${s.name} (${s.reason})` : `  - ${s.name}\n      ${s.command.split('\n').join('\n      ')}`);
    }
    return null;
  }
  if (!opts.unsigned && !fs.existsSync(opts.signerKey ?? defaultKeyPath())) throw new Error(`No signer key at ${opts.signerKey ?? defaultKeyPath()}. Run --init-signer first (or pass --unsigned).`);
  let evidence = await runGates({ opts, snapshot, plan, workflowText, provenance, outDir, mode: 'snapshot', commitDate: provenance.sourceCommittedAt });
  evidence = signIfWanted(evidence, opts);
  writeOutputs(evidence, outDir);
  return evidence;
}

const SAFE_GIT = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'protocol.ext.allow=never', '-c', 'protocol.file.allow=never', '-c', 'submodule.recurse=false'];
const gitEnv = { PATH: process.env.PATH, HOME: os.tmpdir(), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_TERMINAL_PROMPT: '0', LANG: 'C.UTF-8' };

async function verifyPullRequest(opts) {
  const repo = opts.repo;
  const pr = ghJson(['api', `repos/${repo}/pulls/${opts.pr}`]);
  if (pr.state !== 'open') throw new Error(`Pull request #${opts.pr} is ${pr.state}.`);
  const files = realGh(['api', '--paginate', `repos/${repo}/pulls/${opts.pr}/files`, '--jq', '.[] | [.status, .filename] | @json']).split('\n').filter(Boolean).map(l => { const [status, filename] = JSON.parse(l); return { status, filename }; });
  const gateFilesChanged = files.filter(f => isGateFile(f.filename)).map(f => f.filename);
  const headSha = pr.head.sha;
  const baseSha = pr.base.sha;
  console.log(`Pull request #${opts.pr}: ${pr.title}\nAuthor: ${pr.user.login}   head ${headSha}   base ${pr.base.ref} ${baseSha}\nChanged files (${files.length}; "!" marks files that can change what the gates do):\n${summarizeChangedFiles(files)}\n`);
  if (gateFilesChanged.length) console.log(`WARNING: ${gateFilesChanged.length} gate-related file(s) changed. Statuses will not be posted unless you re-run with --allow-gate-file-changes after reading them.\n`);
  if (!opts.reviewedDiff) {
    console.error(`Not running. The code in a pull request is untrusted and its tests execute it.\nRead the full diff (gh pr diff ${opts.pr} -R ${repo}), then re-run with --i-have-reviewed-the-diff (an assertion by you, which the tool cannot check).`);
    return { stopped: true };
  }
  if (opts.dryRun) return { stopped: true };
  if (!scopeAvailable()) throw new Error('systemd user scope (memory and task caps) is unavailable; refusing to run contributor code without resource limits.');
  const workRoot = path.resolve(opts.workRoot ?? os.tmpdir());
  requireFreeDisk(workRoot);
  const work = fs.mkdtempSync(path.join(workRoot, `public-verify-pr${opts.pr}-`));
  fs.chmodSync(work, 0o700);
  const src = path.join(work, 'src');
  const git = (args, cwd) => execFileSync('git', [...SAFE_GIT, ...args], { cwd, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 }).trim();
  try {
    git(['clone', '--quiet', '--no-checkout', `https://github.com/${repo}.git`, src], work);
    git(['fetch', '--quiet', 'origin', `pull/${opts.pr}/head`], src);
    if (git(['rev-parse', 'FETCH_HEAD'], src) !== headSha) throw new Error('The pull request head moved after the diff was listed. Re-run and review again.');
    const listing = git(['ls-tree', '-r', '-l', headSha], src).split('\n').filter(Boolean);
    const bytes = listing.reduce((sum, line) => sum + (Number(line.split(/\s+/)[3]) || 0), 0);
    if (bytes > PR_MAX_BYTES || listing.length > PR_MAX_FILES) throw new Error(`The pull request tree is too large (${listing.length} files, ${(bytes / 1024 ** 2).toFixed(0)} MB; caps ${PR_MAX_FILES} files, ${PR_MAX_BYTES / 1024 ** 2} MB).`);
    const workflowText = git(['show', `${baseSha}:${WORKFLOW}`], src);
    let provenance = {};
    try { provenance = JSON.parse(git(['show', `${baseSha}:PUBLIC_MIRROR_PROVENANCE.json`], src)); } catch { /* base has none */ }
    git(['checkout', '--quiet', '--detach', headSha], src);
    const commitDate = git(['show', '-s', '--format=%cI', headSha], src);
    fs.rmSync(path.join(src, '.git'), { recursive: true, force: true });
    const plan = planFromWorkflow(parseWorkflow(workflowText));
    checkPlanContexts(plan);
    checkWorkflowPin(workflowText, plan, loadPin());
    safeResolve(src, 'package-lock.json');
    if (!opts.unsigned && !fs.existsSync(opts.signerKey ?? defaultKeyPath())) throw new Error(`No signer key at ${opts.signerKey ?? defaultKeyPath()}. Run --init-signer first.`);
    const outDir = path.resolve(opts.out ?? path.join(process.cwd(), `public-verify-pr${opts.pr}-${headSha.slice(0, 12)}`));
    const evidence = await runGates({
      opts, snapshot: src, plan, workflowText, provenance, outDir, mode: 'pull-request', commitDate, scratch: work,
      pullRequest: { repo, number: opts.pr, title: pr.title, author: pr.user.login, headSha, baseSha, baseRef: pr.base.ref, changedFiles: files, gateFilesChanged, allowGateFileChanges: opts.allowGateFileChanges, reviewedDiffConfirmed: true, headMovedDuringRun: undefined },
    });
    const now = ghJson(['api', `repos/${repo}/pulls/${opts.pr}`]).head.sha;
    evidence.pullRequest.headMovedDuringRun = now !== headSha;
    const final = signIfWanted(sealEvidence({ ...evidence, evidenceSha256: undefined, signature: undefined }), opts);
    writeOutputs(final, outDir);
    return { evidence: final };
  } finally {
    if (opts.keepWork) console.log(`Work directory kept: ${work}`);
    else fs.rmSync(work, { recursive: true, force: true });
  }
}

function checkEvidenceCommand(opts) {
  const file = path.resolve(opts.checkEvidence);
  const evidence = JSON.parse(fs.readFileSync(file, 'utf8'));
  const tree = opts.snapshot ? treeDigest(path.resolve(opts.snapshot)).sha256 : undefined;
  const signers = opts.allowedSigners ?? (opts.snapshot && fs.existsSync(path.join(opts.snapshot, 'config/release/public-verify-allowed-signers')) ? path.join(path.resolve(opts.snapshot), 'config/release/public-verify-allowed-signers') : ALLOWED_SIGNERS);
  const problems = [...checkEvidence(evidence, { snapshotTree: tree }), ...signatureProblems(evidence, signers)];
  const logsRoot = path.resolve(opts.logs ?? path.dirname(file));
  const haveLogs = fs.existsSync(path.join(logsRoot, 'logs'));
  if (haveLogs) problems.push(...logProblems(evidence, logsRoot));
  if (opts.maxAgeHours !== undefined) {
    const age = (Date.now() - Date.parse(evidence.finishedAt)) / 3_600_000;
    if (!(age <= opts.maxAgeHours)) problems.push(`evidence is ${age.toFixed(1)} h old (limit ${opts.maxAgeHours} h)`);
  }
  if (problems.length) { console.error(`Evidence check FAILED:\n- ${problems.join('\n- ')}`); return 1; }
  console.log(`Evidence OK: status ${evidence.status}, sha256 ${evidence.evidenceSha256}\n  signature valid against ${path.relative(process.cwd(), signers) || signers}\n  ${tree ? `tree ${tree} matches` : 'tree not compared (pass --snapshot)'}\n  ${haveLogs ? 'step logs match their hashes' : 'step logs not found next to the file (pass --logs DIR); log hashes not checked'}`);
  return evidence.status === 'passed' ? 0 : 1;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || process.argv.length <= 2) { console.log(USAGE); return 0; }

  if (opts.initSigner) {
    const keyPath = opts.signerKey ?? defaultKeyPath();
    const info = initSigner(keyPath);
    console.log(`Created the verifier key at ${keyPath} (private key not shown; keep it outside the repository, mode 0600).\nFingerprint: ${info.fingerprint}\nAdd this line to config/release/public-verify-allowed-signers (commit it in a reviewed pull request):\n${info.allowedSignersLine}`);
    return 0;
  }
  if (opts.checkEvidence) return checkEvidenceCommand(opts);

  let evidence;
  if (opts.pr !== undefined) {
    const result = await verifyPullRequest(opts);
    if (result.stopped) return opts.dryRun ? 0 : 2;
    evidence = result.evidence;
    if (evidence.status !== 'passed' && !opts.postStatuses) return 1;
    if (opts.postStatuses) opts.sha = evidence.pullRequest.headSha;
  } else if (opts.evidence) {
    evidence = JSON.parse(fs.readFileSync(opts.evidence, 'utf8'));
  } else {
    if (!opts.snapshot) { console.error(USAGE); return 2; }
    evidence = await verify(opts);
    if (opts.dryRun) return 0;
    if (evidence.status !== 'passed' && !opts.postStatuses) return 1;
  }

  if (opts.postStatuses) {
    if (process.env.NODE_TEST_CONTEXT || process.env.VITEST) throw new Error('Refusing to post statuses from inside a test run.');
    const signers = opts.allowedSigners ?? ALLOWED_SIGNERS;
    const result = postStatuses({ evidence, repo: opts.repo, sha: opts.sha, targetUrl: opts.targetUrl, gh: realGh, signatureCheck: ev => signatureProblems(ev, signers) });
    console.log(`Posted ${result.posted.length} commit statuses on ${opts.repo}@${opts.sha}:\n  - ${result.posted.join('\n  - ')}\n  description: ${result.description}`);
  }
  return evidence.status === 'passed' ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then(code => process.exit(code), error => { console.error(error.message); process.exit(2); });
}
