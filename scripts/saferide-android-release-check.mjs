#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLineageInputs, validateAndroidCandidate, validateLineageConfiguration } from './lib/saferide-android-release-lineage.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const value = flag => args.find(arg => arg.startsWith(`${flag}=`))?.slice(flag.length + 1);
if (args.includes('--help')) {
  console.log('Usage: node scripts/saferide-android-release-check.mjs [--candidate=file --purpose=ui-test|canonical-preview|play-internal --source=sha --eas-floor=n --play-floor=n]\nRead-only local gate. Never builds, signs, uploads, deploys or submits.');
  process.exit(0);
}
const supportedFlags = new Set(['--candidate', '--purpose', '--source', '--eas-floor', '--play-floor']);
const argumentErrors = [];
const seen = new Set();
for (const arg of args) {
  const separator = arg.indexOf('=');
  const flag = separator === -1 ? arg : arg.slice(0, separator);
  if (!supportedFlags.has(flag) || separator === -1 || arg.slice(separator + 1) === '') argumentErrors.push('Unknown or incomplete release-check argument; use --help.');
  if (seen.has(flag)) argumentErrors.push('Duplicate release-check argument; use one explicit value per flag.');
  seen.add(flag);
}
const candidateFile = value('--candidate');
if (!candidateFile && args.length) argumentErrors.push('Artifact arguments require --candidate; configuration-only mode takes no arguments.');
for (const flag of ['--eas-floor', '--play-floor']) {
  if (value(flag) !== undefined && !/^\d+$/.test(value(flag))) argumentErrors.push('Version floors must be non-negative decimal integers.');
}
let errors = argumentErrors;
let candidateResult;
if (!errors.length) {
  try {
    const inputs = loadLineageInputs(root);
    errors.push(...validateLineageConfiguration(inputs));
    if (candidateFile) {
      const candidate = JSON.parse(fs.readFileSync(path.resolve(candidateFile), 'utf8').replace(/^\uFEFF/, ''));
      const number = flag => value(flag) === undefined ? undefined : Number(value(flag));
      candidateResult = validateAndroidCandidate({ candidate, contract: inputs.contract, purpose: value('--purpose'), expectedSource: value('--source'), versionFloors: { eas: number('--eas-floor'), play: number('--play-floor') } });
      errors.push(...candidateResult.errors);
    }
  } catch {
    // Do not echo receipt contents or filesystem paths from parser errors.
    errors.push('Cannot read or validate release inputs. Check the contract and candidate JSON.');
  }
}
console.log(JSON.stringify({ status: errors.length ? 'blocked' : 'pass', gate: candidateFile ? 'artifact-lineage' : 'configuration-only', errors, warnings: candidateResult?.warnings ?? [], upgradeIdentityCompatible: candidateResult?.upgradeIdentityCompatible, releaseOrDeploymentAuthorized: false }, null, 2));
process.exitCode = errors.length ? 1 : 0;
