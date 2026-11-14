#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argValue = name => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? '' : null;
};
const inputIndex = process.argv.indexOf('--input');
let inputPath = inputIndex >= 0 ? path.resolve(process.argv[inputIndex + 1] ?? '') : null;
// Defaults keep the mobile check; --policy/--cwd run the same check for another workspace.
const policyPath = path.resolve(root, argValue('--policy') ?? 'config/release/mobile-audit-exceptions.v1.json');
const auditCwd = path.resolve(root, argValue('--cwd') ?? '.');
const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
const label = policy.target ?? 'mobile';

if (!inputPath) {
  const result = spawnSync('npm', ['audit', '--omit=dev', '--json'], {
    cwd: auditCwd,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (![0, 1].includes(result.status)) {
    console.error(result.stderr || `npm audit failed with exit ${result.status}`);
    process.exit(result.status ?? 2);
  }
  const coverageDir = path.join(root, 'coverage');
  fs.mkdirSync(coverageDir, { recursive: true });
  inputPath = path.join(coverageDir, `${label}-dependency-audit.json`);
  fs.writeFileSync(inputPath, result.stdout, { mode: 0o644 });
}

if (!fs.existsSync(inputPath)) {
  console.error(`${label} npm audit report is unavailable: ${inputPath}`);
  process.exit(2);
}

const report = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
const errors = [];
const allowedAdvisoryIds = new Set(policy.allowedAdvisoryIds);
const observedAdvisoryIds = new Set();
const observedRootPackages = new Set();

if (policy.status !== 'approved-public-source-ci-only') {
  errors.push(`${label} audit exception status is ${policy.status}`);
}
if (new Date().toISOString().slice(0, 10) > policy.expiresOn) {
  errors.push(`${label} audit exception expired on ${policy.expiresOn}`);
}
if ((report.metadata?.vulnerabilities?.critical ?? 0) > 0) {
  errors.push(`${label} dependency audit contains a critical finding`);
}

// Every exception is bound to what was reviewed: the install paths (npm audit
// `nodes`) and every package that depends on it through the vulnerable chain
// (`effects`, followed transitively). The same advisory on another path, or a
// new dependent, fails.
const entryById = new Map();
for (const entry of policy.advisories ?? []) {
  for (const id of entry.ids ?? []) entryById.set(id, entry);
}
for (const advisoryId of allowedAdvisoryIds) {
  const entry = entryById.get(advisoryId);
  if (!entry || !Array.isArray(entry.nodes) || entry.nodes.length === 0 || !Array.isArray(entry.dependents)) {
    errors.push(`${label} advisory exception ${advisoryId} needs an advisories[] entry with nodes and dependents`);
  }
}

const vulnerabilities = report.vulnerabilities ?? {};
function dependentsOf(packageName) {
  const seen = new Set();
  const queue = [...(vulnerabilities[packageName]?.effects ?? [])];
  while (queue.length > 0) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    queue.push(...(vulnerabilities[name]?.effects ?? []));
  }
  return seen;
}

for (const [packageName, vulnerability] of Object.entries(vulnerabilities)) {
  for (const cause of vulnerability.via ?? []) {
    if (cause && typeof cause === 'object' && Number.isInteger(cause.source)) {
      observedAdvisoryIds.add(cause.source);
      observedRootPackages.add(cause.name);
      const entry = entryById.get(cause.source);
      if (!entry || !allowedAdvisoryIds.has(cause.source)) continue;
      const allowedNodes = new Set(entry.nodes ?? []);
      for (const node of vulnerability.nodes ?? []) {
        if (!allowedNodes.has(node)) errors.push(`${label} advisory ${cause.source} found on an unreviewed path ${node}`);
      }
      const allowedDependents = new Set(entry.dependents ?? []);
      for (const dependent of dependentsOf(packageName)) {
        if (!allowedDependents.has(dependent)) errors.push(`${label} advisory ${cause.source} has an unreviewed dependent ${dependent}`);
      }
      // A direct dependency means our own code may call the vulnerable package or
      // an intermediate. Only the reviewed entry points (directDependents, e.g. minio
      // or expo) may be direct; the excused package and every other dependent may not.
      const reviewedDirect = new Set(entry.directDependents ?? []);
      if (vulnerability.isDirect) {
        errors.push(`${label} advisory ${cause.source}: ${packageName} is now a direct dependency`);
      }
      for (const dependent of dependentsOf(packageName)) {
        if (vulnerabilities[dependent]?.isDirect && !reviewedDirect.has(dependent)) {
          errors.push(`${label} advisory ${cause.source}: dependent ${dependent} is a direct dependency that was not reviewed`);
        }
      }
    }
  }
}

for (const advisoryId of observedAdvisoryIds) {
  if (!allowedAdvisoryIds.has(advisoryId)) {
    errors.push(`unreviewed ${label} advisory ${advisoryId}`);
  }
}
for (const advisoryId of allowedAdvisoryIds) {
  if (!observedAdvisoryIds.has(advisoryId)) {
    errors.push(`stale ${label} advisory exception ${advisoryId}`);
  }
}
for (const packageName of observedRootPackages) {
  if (!policy.allowedPackages.includes(packageName)) {
    errors.push(`unreviewed ${label} advisory package ${packageName}`);
  }
}

if (errors.length > 0) {
  console.error(`${label} dependency audit exception validation failed:`);
  errors.forEach(error => console.error(`- ${error}`));
  process.exit(1);
}

console.log(
  `${label} audit reviewed for public-source CI only: ${observedAdvisoryIds.size} known advisory IDs; `
  + `${report.metadata.vulnerabilities.high} high, ${report.metadata.vulnerabilities.moderate} moderate, `
  + `${report.metadata.vulnerabilities.critical} critical; expires ${policy.expiresOn}.`,
);
