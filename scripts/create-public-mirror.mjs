#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { resolveReleaseRecord, resolveSourceBranch } from './lib/public-mirror-provenance.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const policyPath = path.join(root, 'config/release/public-mirror.v1.json');
const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
const outArg = process.argv.find((value, index, args) => args[index - 1] === '--out');
const allowDirty = process.argv.includes('--allow-dirty');
const allowNonMain = process.argv.includes('--allow-non-main');
const explicitSourceBranch = process.argv.find((value, index, args) => args[index - 1] === '--source-branch');

if (!outArg) {
  console.error('Usage: node scripts/create-public-mirror.mjs --out /tmp/saferide-public-mirror [--source-branch NAME] [--allow-non-main] [--allow-dirty]');
  process.exit(2);
}

const output = path.resolve(outArg);
if (output === root || output.startsWith(`${root}${path.sep}`)) {
  console.error('Public mirror output must remain outside the private repository.');
  process.exit(1);
}
if (!path.basename(output).includes('saferide-public')) {
  console.error('Public mirror output directory must contain "saferide-public".');
  process.exit(1);
}

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

const trackedStatus = git(['status', '--porcelain', '--untracked-files=no']);
if (trackedStatus && !allowDirty) {
  console.error('Public publication requires a clean tracked working tree. Commit or restore tracked changes first.');
  process.exit(1);
}

function headBranches() {
  const current = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (current && current !== 'HEAD') return [current];
  return git(['branch', '-r', '--points-at', 'HEAD', '--format=%(refname:lstrip=3)'])
    .split('\n')
    .map(name => name.trim())
    .filter(name => name && name !== 'HEAD');
}

let sourceBranch;
try {
  sourceBranch = resolveSourceBranch({
    headBranches: headBranches(),
    explicit: explicitSourceBranch,
    policyBranch: policy.sourceBranch,
    allowNonMain,
    headShort: git(['rev-parse', '--short=12', 'HEAD']),
  });
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

function sha256(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function included(relativePath) {
  if (policy.excludeFiles.includes(relativePath)) return false;
  if (policy.forbiddenExtensions.includes(path.extname(relativePath).toLowerCase())) return false;
  if (policy.includeFiles.includes(relativePath)) return true;
  if (policy.excludePrefixes.some(prefix => relativePath.startsWith(prefix))) return false;
  return policy.includePrefixes.some(prefix => relativePath.startsWith(prefix));
}

const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root })
  .toString('utf8')
  .split('\0')
  .filter(Boolean);
const selected = tracked.filter(included).sort();

if (selected.length < 100) {
  console.error(`Mirror allowlist selected too few files: ${selected.length}`);
  process.exit(1);
}

fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true, mode: 0o755 });

let totalBytes = 0;
const copiedFiles = new Set();

function copyPublicFile(sourceRelativePath, destinationRelativePath) {
  const source = path.join(root, sourceRelativePath);
  if (!fs.existsSync(source)) {
    console.error(`Required public source file is missing: ${sourceRelativePath}`);
    process.exit(1);
  }
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    console.error(`Refusing non-regular public source file: ${sourceRelativePath}`);
    process.exit(1);
  }
  if (policy.forbiddenExtensions.includes(path.extname(destinationRelativePath).toLowerCase())) {
    console.error(`Refusing forbidden public output extension: ${destinationRelativePath}`);
    process.exit(1);
  }

  const destination = path.join(output, destinationRelativePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  fs.chmodSync(destination, stat.mode & 0o777);
  totalBytes += stat.size;
  copiedFiles.add(destinationRelativePath);
}

for (const relativePath of selected) {
  copyPublicFile(relativePath, relativePath);
}

for (const mapping of policy.outputMappings ?? []) {
  if (copiedFiles.has(mapping.destination)) {
    console.error(`Public output mapping collides with an allowlisted file: ${mapping.destination}`);
    process.exit(1);
  }
  copyPublicFile(mapping.source, mapping.destination);
}

const publicOpenSourcePolicyPath = path.join(output, 'config/release/open-source-policy.v1.json');
if (fs.existsSync(publicOpenSourcePolicyPath)) {
  const publicOpenSourcePolicy = JSON.parse(fs.readFileSync(publicOpenSourcePolicyPath, 'utf8'));
  const codeTerms = publicOpenSourcePolicy.artifactClasses?.find(item => item.class === 'code');
  if (codeTerms?.licenseFile === 'public-repository/LICENSE') {
    codeTerms.licenseFile = 'LICENSE';
  }
  fs.writeFileSync(
    publicOpenSourcePolicyPath,
    `${JSON.stringify(publicOpenSourcePolicy, null, 2)}\n`,
    { mode: 0o644 },
  );
}

totalBytes = [...copiedFiles]
  .reduce((sum, relativePath) => sum + fs.statSync(path.join(output, relativePath)).size, 0);

const sourceCommit = git(['rev-parse', 'HEAD']);
const sourceCommittedAt = git(['show', '-s', '--format=%cI', 'HEAD']);
if (sourceBranch !== policy.sourceBranch) {
  console.warn(`Review build: source branch ${sourceBranch} is not the publication branch ${policy.sourceBranch}.`);
}
// The current Android release record is the JSON the website imports.
const releaseImporter = 'web/src/lib/android-release.ts';
let releaseMetadata;
try {
  releaseMetadata = resolveReleaseRecord({
    importerPath: releaseImporter,
    importerText: fs.readFileSync(path.join(root, releaseImporter), 'utf8'),
    published: copiedFiles,
  });
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
const provenance = {
  schemaVersion: 1,
  mirrorPolicyId: policy.policyId,
  repositoryUrl: policy.repositoryUrl,
  sourceRepository: policy.sourceRepository,
  sourceBranch,
  sourceCommit,
  sourceCommittedAt,
  publicationModel: policy.publicationModel,
  sourceTreeState: trackedStatus ? 'dirty-test-only' : 'clean',
  fileCount: selected.length,
  totalBytes,
  licenseBoundary: policy.licenseBoundary,
  releaseMetadata,
};

fs.writeFileSync(
  path.join(output, 'PUBLIC_MIRROR_PROVENANCE.json'),
  `${JSON.stringify(provenance, null, 2)}\n`,
  { mode: 0o644 },
);
copiedFiles.add('PUBLIC_MIRROR_PROVENANCE.json');

const ledger = [...copiedFiles]
  .sort()
  .map(relativePath => `${sha256(path.join(output, relativePath))}  ${relativePath}`);
fs.writeFileSync(path.join(output, 'SHA256SUMS.txt'), `${ledger.join('\n')}\n`, { mode: 0o644 });

console.log(
  `Created SafeRide public mirror at ${output} (${selected.length} source files; ${totalBytes} bytes; ${sourceCommit}).`,
);
