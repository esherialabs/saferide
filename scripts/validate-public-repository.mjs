#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rootArgIndex = process.argv.indexOf('--root');
const root = rootArgIndex >= 0
  ? path.resolve(process.argv[rootArgIndex + 1] ?? '')
  : repositoryRoot;

const requiredFiles = [
  'LICENSE',
  'NOTICE',
  'README.md',
  'OPEN_SOURCE.md',
  'ASSET-LICENSES.md',
  'CONTENT-LICENSE.md',
  'MODEL-DATA-LICENSES.md',
  'TRADEMARKS.md',
  'CONTRIBUTING.md',
  'CODE_OF_CONDUCT.md',
  'SECURITY.md',
  'GOVERNANCE.md',
  'PROJECT_CHARTER.md',
  'MAINTAINERS.md',
  '.github/ISSUE_TEMPLATE/bug.yml',
  '.github/ISSUE_TEMPLATE/feature.yml',
  '.github/ISSUE_TEMPLATE/documentation.yml',
  '.github/workflows/public-ci.yml',
  '.github/workflows/public-docs.yml',
  '.github/workflows/public-release.yml',
  'docs/open-source/README.md',
  'docs/open-source/reproducible-builds.md',
];

const forbiddenPrefixes = [
  '.codex/',
  'data/ai/',
  'docs/agents/',
  'docs/security/',
  'docs/unicef/',
  'infra/aws/',
  'infra/web/',
  'notebooks/',
  'public-repository/',
];

const forbiddenExtensions = new Set([
  '.aab', '.apk', '.ckpt', '.gguf', '.ipa', '.jks', '.keystore', '.onnx',
  '.p12', '.p8', '.pem', '.pt', '.pth', '.safetensors', '.task', '.tflite',
]);

const errors = [];

function walk(directory, relative = '') {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    const child = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      errors.push(`public tree contains a symlink: ${childRelative}`);
    } else if (entry.isDirectory()) {
      files.push(...walk(child, childRelative));
    } else if (entry.isFile()) {
      files.push(childRelative);
    }
  }
  return files;
}

function sha256(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
  console.error(`Public repository root is unavailable: ${root}`);
  process.exit(2);
}

for (const relativePath of requiredFiles) {
  if (!fs.existsSync(path.join(root, relativePath))) {
    errors.push(`missing required public repository file: ${relativePath}`);
  }
}

const files = walk(root).sort();
for (const relativePath of files) {
  if (forbiddenPrefixes.some(prefix => relativePath.startsWith(prefix))) {
    errors.push(`restricted path is present: ${relativePath}`);
  }
  if (forbiddenExtensions.has(path.extname(relativePath).toLowerCase())) {
    errors.push(`restricted artifact extension is present: ${relativePath}`);
  }
  const base = path.basename(relativePath).toLowerCase();
  if (base === '.env' || base.startsWith('.env.') && !base.endsWith('.example')) {
    errors.push(`local environment file is present: ${relativePath}`);
  }
}

const licensePath = path.join(root, 'LICENSE');
if (fs.existsSync(licensePath)) {
  const license = fs.readFileSync(licensePath, 'utf8');
  if (!license.includes('Apache License') || !license.includes('Version 2.0, January 2004')) {
    errors.push('root LICENSE is not the complete Apache License 2.0 text');
  }
}

const textExtensions = new Set(['.md', '.json', '.yml', '.yaml', '.ts', '.tsx', '.js', '.mjs', '.html']);
const staleReferenceAllowlist = new Set([
  'scripts/validate-public-repository.mjs',
  'scripts/__tests__/saferide-validate-public-repository.test.mjs',
  'web/scripts/validate-static-export.mjs',
  'web/tests/saferide-v2.spec.ts',
]);
for (const relativePath of files) {
  if (!textExtensions.has(path.extname(relativePath).toLowerCase())) continue;
  if (staleReferenceAllowlist.has(relativePath)) continue;
  const text = fs.readFileSync(path.join(root, relativePath), 'utf8');
  if (text.includes('github.com/esherialabs/saferider')) {
    errors.push(`stale repository URL remains in ${relativePath}`);
  }
  if (text.includes('https://esheria.ai')) {
    errors.push(`commercial Esheria site linkage remains in ${relativePath}`);
  }
}

const ledgerPath = path.join(root, 'SHA256SUMS.txt');
if (fs.existsSync(ledgerPath)) {
  const ledgerLines = fs.readFileSync(ledgerPath, 'utf8').trim().split(/\r?\n/).filter(Boolean);
  for (const line of ledgerLines) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    if (!match) {
      errors.push(`invalid SHA256SUMS entry: ${line}`);
      continue;
    }
    const [, expected, relativePath] = match;
    const fullPath = path.join(root, relativePath);
    if (!fs.existsSync(fullPath) || sha256(fullPath) !== expected) {
      errors.push(`SHA256SUMS mismatch: ${relativePath}`);
    }
  }
}

const provenancePath = path.join(root, 'PUBLIC_MIRROR_PROVENANCE.json');
if (fs.existsSync(provenancePath)) {
  const provenance = JSON.parse(fs.readFileSync(provenancePath, 'utf8'));
  if (provenance.sourceTreeState !== 'clean') {
    errors.push(`public provenance source tree is ${provenance.sourceTreeState ?? 'unspecified'}`);
  }
}

if (errors.length > 0) {
  console.error('Public repository validation failed:');
  errors.forEach(error => console.error(`- ${error}`));
  process.exit(1);
}

console.log(`Public repository validation passed (${files.length} files inspected).`);
