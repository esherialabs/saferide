#!/usr/bin/env node
// Local CI: the gates GitHub Actions used to run, on any machine with Node and
// npm, or inside the pinned toolchain image (infra/ci/Dockerfile) with
// --docker. See docs/ci/local-ci.md.

import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCiBase } from './lib/local-ci-base.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const strict = process.env.LOCAL_CI_STRICT === '1';
const privateTree = fs.existsSync(path.join(root, 'public-repository'));
const STEP_TIMEOUT_MS = 30 * 60 * 1000;

const USAGE = `Usage: npm run ci -- [options]

  --only a,b     run only these stages
  --skip a,b     skip these stages
  --release      also run the release stage (offline preflight, Expo doctor)
  --no-install   reuse existing node_modules instead of npm ci
  --base REF     branch base for gitleaks (default: verified private main)
  --out DIR      logs and summary directory (default .local-ci)
  --docker       run in the pinned container (tests the committed HEAD)
  --verbose      stream every step's output
  --list         list stages and exit`;

// Signed-release baseline the Android lineage checks compare against; private evidence.
const RELEASE_BASELINE_EVIDENCE = 'docs/qa/saferide-v058-android-release-candidate-2026-08-18.json';

const STAGES = [
  {
    id: 'install',
    title: 'Install dependencies',
    steps: [
      { name: 'npm ci (mobile)', run: 'npm ci --ignore-scripts --no-audit --no-fund' },
      { name: 'npm ci (api)', run: 'npm ci --ignore-scripts --no-audit --no-fund', cwd: 'apps/api' },
      { name: 'npm ci (web)', run: 'npm ci --ignore-scripts --no-audit --no-fund', cwd: 'web' },
      { name: 'npm ci (partner web)', run: 'npm ci --ignore-scripts --no-audit --no-fund', cwd: 'apps/partner-web' },
    ],
  },
  {
    id: 'secrets',
    title: 'Secret scan',
    steps: [
      { name: 'repository secret scan', run: 'npm run secrets:scan' },
      { name: 'gitleaks (branch commits and working tree)', needs: 'gitleaks', run: runGitleaks },
    ],
  },
  {
    id: 'mobile',
    title: 'Mobile TypeScript and tests with coverage gates',
    steps: [
      { name: 'tsc --noEmit', run: 'node node_modules/typescript/bin/tsc --noEmit --pretty false' },
      { name: 'coverage:check:public (global and critical vitest gates)', run: 'npm run coverage:check:public' },
      { name: 'test:coverage:critical:node', requires: ['config/unicef', 'docs/unicef'], run: 'npm run test:coverage:critical:node' },
    ],
  },
  {
    id: 'ai',
    title: 'AI data and evaluation gates',
    steps: [
      { name: 'unicef:evidence:test', requires: ['config/unicef', 'docs/unicef'], run: 'npm run unicef:evidence:test' },
      { name: 'ai:gemma4:v04:pipeline:check', requires: ['data/ai', 'docs/security'], run: 'npm run ai:gemma4:v04:pipeline:check' },
      { name: 'ai:eval:gemma4:check', requires: ['docs/qa/safeRide-ai-safety-prompt-suite-2026-06-18.md'], run: 'npm run ai:eval:gemma4:check' },
    ],
  },
  {
    id: 'validators',
    title: 'Privacy, product, AI, security, SBOM and release validators',
    steps: [
      { name: 'release:validators', requires: ['config/unicef', 'docs/unicef', 'docs/security'], run: 'npm run release:validators' },
      { name: 'security:mobile-audit:check', run: 'npm run security:mobile-audit:check' },
      { name: 'security:api-audit:check', run: 'npm run security:api-audit:check' },
      { name: 'verify:public:test', run: 'npm run verify:public:test' },
    ],
  },
  {
    id: 'audit',
    title: 'High-severity dependency audit (needs the npm registry)',
    // Reviewed, path- and dependent-bound exceptions (config/release/*-audit-exceptions.v1.json),
    // the same checks public CI runs; the website has no exceptions and stays a raw audit.
    steps: [
      { name: 'security:mobile-audit:check', run: 'npm run security:mobile-audit:check' },
      { name: 'security:api-audit:check', run: 'npm run security:api-audit:check' },
      { name: 'web production audit (high)', run: 'npm --prefix web audit --package-lock-only --omit=dev --audit-level=high' },
    ],
  },
  {
    id: 'api',
    title: 'API typecheck, build and env examples',
    steps: [
      { name: 'typecheck', run: 'npm run typecheck', cwd: 'apps/api' },
      { name: 'build', run: 'npm run build', cwd: 'apps/api' },
      { name: 'validate:env-examples', run: 'npm run validate:env-examples', cwd: 'apps/api' },
    ],
  },
  {
    id: 'web',
    title: 'Website lint, typecheck, static export and end-to-end tests',
    steps: [
      { name: 'lint', run: 'npm run lint', cwd: 'web' },
      { name: 'typecheck', run: 'npm run typecheck', cwd: 'web' },
      { name: 'check:assets', run: 'npm run check:assets', cwd: 'web' },
      { name: 'build:static', run: 'npm run build:static', cwd: 'web' },
      { name: 'validate:static', run: 'npm run validate:static', cwd: 'web' },
      { name: 'manifest:static', run: 'npm run manifest:static', cwd: 'web' },
      { name: 'verify:static', run: 'npm run verify:static', cwd: 'web' },
      { name: 'playwright against the static export', run: runExportE2e },
    ],
  },
  {
    id: 'partner',
    title: 'Partner dashboard types, unit, production export and browser tests',
    steps: [
      { name: 'typecheck', run: 'npm run typecheck', cwd: 'apps/partner-web' },
      { name: 'unit tests', run: 'npm run test:unit', cwd: 'apps/partner-web' },
      { name: 'production export and CSP check', run: 'npm run build', cwd: 'apps/partner-web' },
      { name: 'test export', run: 'npm run build', cwd: 'apps/partner-web', env: { PARTNER_EVIDENCE_ORIGIN: 'http://localhost:4321' } },
      { name: 'browser and accessibility tests', run: 'npm run e2e', cwd: 'apps/partner-web' },
    ],
  },
  {
    id: 'mirror',
    title: 'Public mirror build and public repository checks',
    steps: [{ name: 'build and validate the public mirror', requires: ['public-repository'], run: runMirrorCheck }],
  },
  {
    id: 'compose',
    title: 'Portable stack: shell syntax and Compose configuration',
    steps: [
      {
        name: 'bash -n infra/selfhost/*.sh',
        needs: 'bash',
        requires: ['infra/selfhost', 'infra/ci'],
        run: 'for f in infra/selfhost/*.sh infra/selfhost/scripts/*.sh infra/ci/*.sh; do bash -n "$f" || exit 1; done',
      },
      {
        name: 'deploy, CD and local-CI script logic (stubs, no Docker)',
        needs: 'bash',
        requires: ['infra/selfhost', 'infra/ci'],
        run: 'bash infra/selfhost/tests/deploy.test.sh && bash infra/selfhost/tests/window.test.sh && bash infra/ci/local-ci.test.sh',
      },
      {
        name: 'compose config (infra/local)',
        needs: 'docker',
        run: 'docker compose --env-file infra/local/.env.example -f infra/local/docker-compose.yml config --quiet',
      },
      {
        name: 'compose config (infra/selfhost)',
        needs: 'docker',
        requires: ['infra/selfhost'],
        run: 'docker compose -f infra/selfhost/compose.yml --project-directory infra/selfhost config --quiet',
        env: selfhostPlaceholders,
      },
      {
        name: 'every image is pinned by digest (infra/selfhost)',
        needs: 'bash',
        requires: ['infra/selfhost'],
        run: 'bash infra/selfhost/tests/image-pins.test.sh',
      },
      {
        name: 'API-image services run under an init (infra/selfhost)',
        needs: 'docker',
        requires: ['infra/selfhost'],
        run: 'bash infra/selfhost/tests/compose-init.test.sh',
        env: selfhostPlaceholders,
      },
    ],
  },
  {
    id: 'release',
    title: 'Release configuration (opt-in with --release)',
    optIn: true,
    steps: [
      { name: 'release candidate preflight (offline)', requires: [RELEASE_BASELINE_EVIDENCE], run: 'node scripts/release-candidate-preflight.mjs --offline' },
      { name: 'release:android:check', requires: [RELEASE_BASELINE_EVIDENCE], run: 'npm run release:android:check' },
      { name: 'release:android:test', requires: [RELEASE_BASELINE_EVIDENCE, 'scripts/__tests__/saferide-android-release-lineage.test.mjs'], run: 'npm run release:android:test' },
      { name: 'expo-doctor (needs the network)', run: 'npx expo-doctor' },
    ],
  },
];

function parseArgs(argv) {
  const options = { only: null, skip: new Set(), release: false, install: true, base: null, out: path.join(root, '.local-ci'), docker: false, verbose: false, list: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      if (index + 1 >= argv.length) fail(`${arg} needs a value`);
      index += 1;
      return argv[index];
    };
    if (arg === '--only') options.only = new Set(value().split(',').filter(Boolean));
    else if (arg === '--skip') value().split(',').filter(Boolean).forEach(id => options.skip.add(id));
    else if (arg === '--release') options.release = true;
    else if (arg === '--no-install') options.install = false;
    else if (arg === '--base') options.base = value();
    else if (arg === '--out') options.out = path.resolve(value());
    else if (arg === '--docker') options.docker = true;
    else if (arg === '--verbose') options.verbose = true;
    else if (arg === '--list') options.list = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else fail(`unknown option ${arg}\n\n${USAGE}`);
  }
  const known = new Set(STAGES.map(stage => stage.id));
  for (const id of [...(options.only ?? []), ...options.skip]) {
    if (!known.has(id)) fail(`unknown stage ${id} (stages: ${[...known].join(', ')})`);
  }
  return options;
}

function fail(message) {
  console.error(`local-ci: ${message}`);
  process.exit(2);
}

function selectStages(options) {
  return STAGES.filter(stage => {
    if (options.only) return options.only.has(stage.id);
    if (options.skip.has(stage.id)) return false;
    if (stage.id === 'install' && !options.install) return false;
    return !stage.optIn || options.release;
  });
}

function git(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : '';
}

function available(tool) {
  const probes = {
    bash: ['bash', ['--version']],
    docker: ['docker', ['compose', 'version']],
    gitleaks: ['gitleaks', ['version']],
  };
  const [command, args] = probes[tool];
  const result = spawnSync(command, args, { stdio: 'ignore' });
  return !result.error && result.status === 0;
}

// Several AI gates call `python`; Debian, Ubuntu and macOS only ship `python3`.
function pythonShimEnv() {
  if (spawnSync('python', ['--version'], { stdio: 'ignore' }).status === 0) return {};
  const python3 = process.platform === 'win32' ? null : spawnSync('python3', ['--version'], { stdio: 'ignore' });
  if (!python3 || python3.status !== 0) return {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saferide-ci-python-'));
  fs.writeFileSync(path.join(dir, 'python'), '#!/bin/sh\nexec python3 "$@"\n', { mode: 0o755 });
  return { PATH: `${dir}${path.delimiter}${process.env.PATH}` };
}

function selfhostPlaceholders() {
  // Compose refuses to render without these; the values are never used.
  const names = ['SAFERIDE_API_HOST', 'SAFERIDE_API_IMAGE', 'SAFERIDE_AUTH_JWT_SECRET', 'SAFERIDE_CORS_ORIGINS', 'SAFERIDE_DATABASE_PASSWORD', 'SAFERIDE_POSTGRES_PASSWORD', 'SAFERIDE_SITE_HOSTS', 'SAFERIDE_STATE_DIR', 'SAFERIDE_STORAGE_ACCESS_KEY', 'SAFERIDE_STORAGE_HOST', 'SAFERIDE_STORAGE_ROOT_PASSWORD', 'SAFERIDE_STORAGE_ROOT_USER', 'SAFERIDE_STORAGE_SECRET_KEY', 'SAFERIDE_WEB_RELEASE'];
  return {
    ...Object.fromEntries(names.map(name => [name, `ci-placeholder-${name.toLowerCase()}`])),
    SAFERIDE_PARTNER_HOST: 'partners.example.invalid',
    SAFERIDE_STATE_DIR: '/tmp/saferide-ci-state',
    // Documentation range (RFC 5737): compose only renders it, nothing listens.
    SAFERIDE_APP_SUBNET: '192.0.2.0/24',
    SAFERIDE_GATEWAY_APP_IP: '192.0.2.10',
    SAFERIDE_APP_IP_RANGE: '192.0.2.128/25',
  };
}

function runCommand(command, { cwd = root, env = {}, log, verbose }) {
  return new Promise(resolve => {
    const child = spawn(command, { cwd, env: { ...process.env, ...env }, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => child.kill('SIGTERM'), STEP_TIMEOUT_MS);
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', chunk => {
        log.write(chunk);
        if (verbose) process.stdout.write(chunk);
      });
    }
    child.on('close', code => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
    child.on('error', error => {
      log.write(`${error.message}\n`);
      resolve(1);
    });
  });
}

async function runGitleaks(context) {
  const base = resolveCiBase(root, context.options.base);
  const head = git(['rev-parse', 'HEAD']);
  let range = base && base !== head ? `${base}..HEAD` : 'HEAD^..HEAD';
  if (!git(['rev-parse', '--verify', '-q', 'HEAD^'])) range = 'HEAD';
  context.log.write(`gitleaks commit range: ${range}\n`);
  let code = await runCommand(`gitleaks git --redact --no-banner --exit-code 1 --log-opts="${range}" .`, context);
  if (git(['status', '--porcelain', '--untracked-files=no'])) {
    context.log.write('gitleaks: scanning uncommitted changes\n');
    code = (await runCommand('gitleaks git --redact --no-banner --exit-code 1 --pre-commit .', context)) || code;
  }
  return code;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return true;
    } catch {
      // not listening yet
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return false;
}

// Serves web/out the way production does (scripts/serve-static-export.mjs) and
// runs the whole Playwright suite against it.
async function runExportE2e(context) {
  const port = await freePort();
  const webDir = path.join(root, 'web');
  const server = spawn(process.execPath, ['scripts/serve-static-export.mjs'], { cwd: webDir, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', chunk => context.log.write(chunk));
  server.stderr.on('data', chunk => context.log.write(chunk));
  try {
    if (!(await waitForHttp(`http://127.0.0.1:${port}/`, 30_000))) {
      context.log.write('static export server did not start\n');
      return 1;
    }
    const code = await runCommand('npx playwright test --reporter=line', { ...context, cwd: webDir, env: { ...context.env, PLAYWRIGHT_BASE_URL: `http://127.0.0.1:${port}` } });
    if (code !== 0) context.log.write('\nIf Chromium is missing: npx --prefix web playwright install chromium (or use npm run ci:docker)\n');
    return code;
  } finally {
    server.kill('SIGTERM');
  }
}

// Public provenance requires a clean tracked tree, so a dirty run skips this.
async function runMirrorCheck(context) {
  if (git(['status', '--porcelain', '--untracked-files=no'])) return { status: 'skip', note: 'needs a clean tracked tree; commit first' };
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'saferide-public-ci-'));
  try {
    // A check, not a publication: any branch may build the review mirror.
    const built = await runCommand(`node scripts/create-public-mirror.mjs --out "${out}" --allow-non-main`, context);
    if (built !== 0) return built;
    return await runCommand(`node scripts/validate-public-repository.mjs --root "${out}"`, context);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
}

function formatSeconds(ms) {
  return `${Math.round(ms / 1000)}s`;
}

function tail(file, lines) {
  return fs.readFileSync(file, 'utf8').split('\n').slice(-lines).join('\n');
}

async function runStages(stages, options) {
  fs.mkdirSync(options.out, { recursive: true });
  const baseEnv = { CI: '1', NEXT_TELEMETRY_DISABLED: '1', npm_config_update_notifier: 'false', ...pythonShimEnv() };
  const results = [];
  for (const stage of stages) {
    console.log(`\n== ${stage.id}: ${stage.title}`);
    const logPath = path.join(options.out, `${stage.id}.log`);
    const log = fs.createWriteStream(logPath);
    for (const step of stage.steps) {
      const started = Date.now();
      let status;
      let note = '';
      // Private-only directories (infra/selfhost, infra/ci, public-repository) are
      // not in the public mirror; their steps skip there instead of failing.
      const absent = (step.requires ?? []).filter(dir => !fs.existsSync(path.join(root, dir)));
      if (absent.length > 0) {
        // public-repository/ exists only in the private tree, where nothing may be
        // missing: LOCAL_CI_STRICT=1 turns such a skip into a failure there.
        status = strict && privateTree ? 'fail' : 'skip';
        note = `${absent.join(', ')} not in this tree`;
      } else if (step.needs && !available(step.needs)) {
        status = strict ? 'fail' : 'skip';
        note = `${step.needs} is not installed`;
      } else {
        log.write(`\n### ${step.name}\n`);
        const context = { options, log, verbose: options.verbose, cwd: path.join(root, step.cwd ?? ''), env: { ...baseEnv, ...(typeof step.env === 'function' ? step.env() : step.env) } };
        const outcome = typeof step.run === 'function' ? await step.run(context) : await runCommand(step.run, context);
        if (typeof outcome === 'object') ({ status, note } = outcome);
        else status = outcome === 0 ? 'pass' : 'fail';
      }
      const duration = Date.now() - started;
      results.push({ stage: stage.id, step: step.name, status, note, durationMs: duration });
      console.log(`  ${status.toUpperCase().padEnd(4)} ${step.name} (${formatSeconds(duration)})${note ? ` - ${note}` : ''}`);
      if (status === 'fail' && !note && !options.verbose) {
        await new Promise(resolve => log.write('', resolve));
        console.log(tail(logPath, 25).replace(/^/gm, '       | '));
      }
    }
    await new Promise(resolve => log.end(resolve));
  }
  return results;
}

function writeSummary(results, options, extra = {}) {
  const head = git(['rev-parse', 'HEAD']);
  const summary = {
    commit: head,
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
    dirty: Boolean(git(['status', '--porcelain', '--untracked-files=no'])),
    node: process.version,
    nodeExpected: fs.existsSync(path.join(root, '.nvmrc')) ? `v${fs.readFileSync(path.join(root, '.nvmrc'), 'utf8').trim()}` : null,
    platform: `${process.platform}-${process.arch}`,
    strict,
    finishedAt: new Date().toISOString(),
    ...extra,
    results,
  };
  fs.writeFileSync(path.join(options.out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  const failed = results.filter(result => result.status === 'fail').length;
  const lines = [
    `## Local CI: ${failed ? `${failed} failed` : 'passed'}`,
    '',
    `- Commit: \`${summary.commit}\`${summary.dirty ? ' (with uncommitted changes)' : ''} on \`${summary.branch}\``,
    `- Runtime: Node ${summary.node}${summary.nodeExpected && summary.nodeExpected !== summary.node ? ` (expected ${summary.nodeExpected})` : ''}, ${summary.platform}${summary.container ? `, container ${summary.container}` : ''}${summary.strict ? ', strict' : ''}`,
    `- Finished: ${summary.finishedAt}`,
    '',
    '| Stage | Step | Result | Time |',
    '| --- | --- | --- | --- |',
    ...results.map(result => `| ${result.stage} | ${result.step} | ${result.status}${result.note ? ` (${result.note})` : ''} | ${formatSeconds(result.durationMs)} |`),
    '',
  ];
  fs.writeFileSync(path.join(options.out, 'summary.md'), lines.join('\n'));
  return summary;
}

async function runInDocker(options, argv) {
  if (spawnSync('docker', ['version'], { stdio: 'ignore' }).status !== 0) fail('docker is not available (or this user cannot reach the daemon)');
  const dockerfile = path.join(root, 'infra/ci/Dockerfile');
  const tag = `saferide-ci:${crypto.createHash('sha256').update(fs.readFileSync(dockerfile)).digest('hex').slice(0, 12)}`;
  if (spawnSync('docker', ['image', 'inspect', tag], { stdio: 'ignore' }).status !== 0) {
    console.log(`Building ${tag} from infra/ci/Dockerfile`);
    if (spawnSync('docker', ['build', '-t', tag, '-f', dockerfile, path.dirname(dockerfile)], { stdio: 'inherit' }).status !== 0) fail('image build failed');
  }
  if (git(['status', '--porcelain', '--untracked-files=no'])) {
    console.log('Note: the container tests the committed HEAD; uncommitted changes are not included.');
  }

  // The host owns the Docker CLI, so Compose validation runs here.
  const hostResults = (options.only && !options.only.has('compose')) || options.skip.has('compose')
    ? []
    : await runStages(STAGES.filter(stage => stage.id === 'compose'), options);
  if (options.only && [...options.only].every(id => id === 'compose')) {
    writeSummary(hostResults, options);
    return hostResults.every(result => result.status !== 'fail') ? 0 : 1;
  }

  const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'saferide-ci-src-'));
  try {
    // The merge-base is already in HEAD's history. Never bundle an unrelated
    // public origin or lose a caller-selected private base inside Docker.
    const base = resolveCiBase(root, options.base);
    const refs = ['HEAD'];
    if (spawnSync('git', ['bundle', 'create', path.join(bundleDir, 'src.bundle'), ...refs], { cwd: root, stdio: 'ignore' }).status !== 0) fail('git bundle failed');
    fs.mkdirSync(options.out, { recursive: true });
    const passArgs = argv.filter(arg => arg !== '--docker');
    const outIndex = passArgs.indexOf('--out');
    if (outIndex >= 0) passArgs.splice(outIndex, 2);
    const baseIndex = passArgs.indexOf('--base');
    if (baseIndex >= 0) passArgs.splice(baseIndex, 2);
    passArgs.push('--base', base);
    const script = [
      'set -e',
      'git init -q /work && cd /work',
      'git fetch -q /in/src.bundle "+HEAD:refs/ci/head"',
      'git checkout -q --detach refs/ci/head',
      'set +e',
      'node scripts/local-ci.mjs --out /out --skip compose "$@"',
      'code=$?',
      '[ -n "${HOST_UID:-}" ] && chown -R "$HOST_UID:$HOST_GID" /out',
      'exit $code',
    ].join('\n');
    const ids = typeof process.getuid === 'function' ? ['-e', `HOST_UID=${process.getuid()}`, '-e', `HOST_GID=${process.getgid()}`] : [];
    const run = spawnSync('docker', ['run', '--rm', '--init', '--cpus', '3', '--memory', '6g', '--pids-limit', '1024', '-v', `${bundleDir}:/in:ro`, '-v', `${options.out}:/out`, '-v', 'saferide-ci-npm-cache:/root/.npm', ...ids, tag, 'bash', '-c', script, 'bash', ...passArgs], { stdio: 'inherit' });
    const summaryPath = path.join(options.out, 'summary.json');
    const inner = fs.existsSync(summaryPath) ? JSON.parse(fs.readFileSync(summaryPath, 'utf8')) : { results: [] };
    const summary = writeSummary([...hostResults, ...inner.results], options, { container: tag, dirty: false, node: inner.node ?? process.version, platform: inner.platform ?? 'unknown', strict: true });
    console.log(`\nSummary: ${path.join(options.out, 'summary.md')}`);
    return run.status === 0 && summary.results.every(result => result.status !== 'fail') ? 0 : 1;
  } finally {
    fs.rmSync(bundleDir, { recursive: true, force: true });
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const options = parseArgs(argv);
  if (options.list) {
    for (const stage of STAGES) console.log(`${stage.id.padEnd(11)} ${stage.title}`);
    return 0;
  }
  if (options.docker) return runInDocker(options, argv);

  const summary = { nodeExpected: fs.existsSync(path.join(root, '.nvmrc')) ? fs.readFileSync(path.join(root, '.nvmrc'), 'utf8').trim() : null };
  if (summary.nodeExpected && process.version !== `v${summary.nodeExpected}`) {
    console.log(`Note: Node ${process.version} differs from .nvmrc v${summary.nodeExpected}; npm run ci:docker uses the pinned runtime.`);
  }
  const results = await runStages(selectStages(options), options);
  writeSummary(results, options);
  const failed = results.filter(result => result.status === 'fail');
  const skipped = results.filter(result => result.status === 'skip');
  console.log(`\n${failed.length ? `FAILED: ${failed.length} step(s)` : 'PASSED'}${skipped.length ? `, ${skipped.length} skipped` : ''}. Logs and summary: ${path.relative(process.cwd(), options.out) || '.'}`);
  return failed.length ? 1 : 0;
}

process.exitCode = await main();
