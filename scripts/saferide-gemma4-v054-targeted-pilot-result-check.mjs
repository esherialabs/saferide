#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resultRelative = 'docs/qa/saferide-gemma4-v054-targeted-pilot-result-2026-08-08.json';
const planRelative = 'config/ai/datasets/saferide-gemma4-v054-next-pilot-plan.json';
const pendingRelative = 'docs/qa/saferide-gemma4-v054-next-pilot-evidence.pending.json';

const readJson = relative => JSON.parse(fs.readFileSync(path.join(repoRoot, relative), 'utf8'));
const sha256Bytes = value => crypto.createHash('sha256').update(value).digest('hex');
const sha256File = relative => sha256Bytes(fs.readFileSync(path.join(repoRoot, relative)));
const canonicalSha256 = value => sha256Bytes(`${JSON.stringify(value, Object.keys(value[0] ?? {}).sort())}\n`);

function readPlanAtExecutionCommit(commit) {
  if (typeof commit !== 'string' || !/^[a-f0-9]{40}$/.test(commit)) {
    throw new Error('Historical result execution commit is invalid.');
  }
  const bytes = execFileSync('git', ['show', `${commit}:${planRelative}`], {
    cwd: repoRoot,
    encoding: null,
    maxBuffer: 4 * 1024 * 1024,
  });
  return { bytes, plan: JSON.parse(bytes.toString('utf8')) };
}

function compile(relative) {
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, strictTypes: false, validateFormats: false });
  return ajv.compile(readJson(relative));
}

function main() {
  const result = readJson(resultRelative);
  const validateResult = compile('schemas/ai-v054-targeted-pilot-result.schema.json');
  const errors = [];
  if (!validateResult(result)) {
    errors.push(...(validateResult.errors ?? []).map(error => `${error.instancePath || '/'}: ${error.message}`));
  }

  const historical = readPlanAtExecutionCommit(result.bindings?.executionCommit);
  const plan = historical.plan;
  const pending = readJson(pendingRelative);
  const validatePending = compile('schemas/ai-v054-next-pilot-evidence.schema.json');
  if (!validatePending(pending)) {
    errors.push(...(validatePending.errors ?? []).map(error => `pending${error.instancePath || '/'}: ${error.message}`));
  }
  const planSha = sha256Bytes(historical.bytes);
  if (result.bindings?.planSha256 !== planSha || pending.planSha256 !== planSha) {
    errors.push('result or terminal evidence does not bind the exact execution plan');
  }
  if (pending.status !== 'complete' || pending.strictDecision !== 'NO-GO' || pending.training !== null || pending.panel !== null) {
    errors.push('terminal next-pilot evidence does not preserve the preflight NO-GO');
  }

  const checkpoint = result.preflight?.checkpoint ?? {};
  const files = checkpoint.files ?? [];
  const names = files.map(item => item.path);
  if (names.length !== new Set(names).size || [...names].sort().join('\n') !== names.join('\n')) {
    errors.push('checkpoint inventory is not unique and canonically ordered');
  }
  const totalBytes = files.reduce((total, item) => total + item.sizeBytes, 0);
  if (totalBytes !== checkpoint.totalBytes || canonicalSha256(files) !== checkpoint.inventorySha256) {
    errors.push('checkpoint aggregate hash or size is stale');
  }
  const adapter = files.find(item => item.path === 'adapter_model.safetensors');
  if (!adapter || adapter.sha256 !== 'ec2d3ca61d9dcbd24874ed8c989dd1b5f3b621c5ec638ca223bc3d75c0052cf7' || adapter.sizeBytes !== 48376416) {
    errors.push('preflight checkpoint adapter binding differs');
  }
  if (canonicalSha256(plan.runtime?.baseModel?.files ?? []) !== result.bindings?.modelInventorySha256) {
    errors.push('pinned model inventory hash is stale');
  }
  if (result.staging?.vpsLedgerSha256 !== result.staging?.a11LedgerSha256) {
    errors.push('VPS and A11 immutable transfer ledgers differ');
  }
  if (result.preflight?.loss?.normalizedTrainObjective !== null
    || result.preflight?.loss?.gatePassed !== false
    || result.decision?.strictDecision !== 'NO-GO'
    || result.decision?.readyForTwoFullCandidateTraining !== false) {
    errors.push('failed loss evidence was incorrectly normalized or marked ready');
  }
  if (result.pilot?.status !== 'not-started' || result.panel?.status !== 'not-started' || result.panel?.metrics !== null) {
    errors.push('pilot or 300+20 panel evidence was asserted after the preflight stop');
  }

  const serialized = JSON.stringify(result);
  const forbidden = [/(?:\/home\/|\/opt\/|\/root\/)/i, /(?:AKIA|ASIA)[A-Z0-9]{16}/, /-----BEGIN [A-Z ]+PRIVATE KEY-----/, /https?:\/\//i];
  if (forbidden.some(pattern => pattern.test(serialized))) {
    errors.push('result contains a private path, credential-like value, private key, or URL');
  }
  if (errors.length) {
    errors.forEach(error => console.error(`- ${error}`));
    return 1;
  }
  console.log(`SafeRide v0.5.4 targeted-pilot result PASS (NO-GO; preflight failed closed; resultSha256=${sha256File(resultRelative)}).`);
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
