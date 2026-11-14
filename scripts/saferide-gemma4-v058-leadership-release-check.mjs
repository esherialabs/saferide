#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const startingCommit = 'e4c5f549d12d97138e4368955061c0b7081b6fe4';
const files = {
  selection: 'config/ai/training/saferide-gemma4-v058-leadership-selection.json',
  exception: 'config/ai/training/saferide-gemma4-v058-development-exception.json',
  result: 'docs/qa/saferide-gemma4-v058-leadership-release-result-2026-08-09.json',
  handoff: 'docs/qa/saferide-gemma4-v058-leadership-release-result-2026-08-09.md',
  selectionSchema: 'schemas/ai-v058-leadership-selection.schema.json',
  exceptionSchema: 'schemas/ai-v058-development-exception.schema.json',
  resultSchema: 'schemas/ai-v058-leadership-release-result.schema.json',
  evaluator: 'scripts/saferide-gemma4-v058-leadership-release.py',
  launcher: 'scripts/saferide-gemma4-v058-holdout-a11-launcher.sh',
  v057Panel: 'scripts/saferide-gemma4-v057-pilot-panel.py',
};
const expectedHashes = {
  selection: 'af2eb900b2cd69ef8581a9aa5fcca416d3b37ece54a1ca3273a7e99d8d330dca',
  exception: 'ba542d9d5852cb7dd1ead44a779eb7f295f14bc6ee8e0f68b71ad69a2bfa64b6',
  evaluator: 'a5196f430c88397d1f24f1d27d95d0ac4ea3ca509706f03eda5d6896efc8b217',
  launcher: '67467ef545167eed354845576a9a0d6b6d9c250ccf87515333714c88b19b2084',
  v057Panel: 'de85038995e20d32dc6dd2adbb205aea43f6535719a880e29dc9e23eaeebeb01',
};
const historicalHashes = {
  'docs/qa/saferide-gemma4-v058-development-candidate-result-2026-08-09.json': '11342c22a8c4a9837f9818f9c94e46f2a569b65397113cf5c5641e063be18730',
  'docs/qa/saferide-gemma4-v058-development-candidate-result-2026-08-09.md': 'c2ac97e83b51857786ddf62ae58e68923d876a1f64dd34a07d49cbdca2f2d78e',
  'docs/qa/saferide-gemma4-v058-kiswahili-cutoff-resolution-2026-08-09.json': '60090df38fa64ff73c4cf3e6cc82fb0ce2f92a0c70bd30e95e5901627dfe4155',
  'docs/qa/saferide-gemma4-v058-kiswahili-cutoff-resolution-2026-08-09.md': 'dad08d57deddb95a6e731e5346ecc261ee5ad352b26d6f84a4bb14d0a0a3fdbd',
};

const absolute = relative => path.join(repoRoot, relative);
const readBytes = relative => fs.readFileSync(absolute(relative));
const readJson = relative => JSON.parse(readBytes(relative).toString('utf8'));
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const fileSha256 = relative => sha256(readBytes(relative));
const canonicalValue = value => {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalValue(value[key])]));
  return value;
};
const canonicalSha256 = value => sha256(Buffer.from(JSON.stringify(canonicalValue(value))));

function collectKeys(value, keys = []) {
  if (Array.isArray(value)) value.forEach(item => collectKeys(item, keys));
  else if (value && typeof value === 'object') Object.entries(value).forEach(([key, item]) => { keys.push(key); collectKeys(item, keys); });
  return keys;
}

function validateDocument(ajv, schemaPath, document, label, errors) {
  const validate = ajv.compile(readJson(schemaPath));
  if (!validate(document)) errors.push(...(validate.errors ?? []).map(error => `${label}${error.instancePath || '/'}: ${error.message}`));
}

function metricErrors(metric, label) {
  const errors = [];
  if (metric.rowCount !== metric.completed + metric.truncated + metric.errors) errors.push(`${label} accounting differs`);
  if (metric.modelTerminatorStops > metric.completed) errors.push(`${label} terminator accounting differs`);
  if (![metric.overRefusalRate, metric.usefulnessAverage].every(value => typeof value === 'number' && Number.isFinite(value))) errors.push(`${label} has a non-finite aggregate`);
  return errors;
}

function main() {
  const errors = [];
  const selection = readJson(files.selection);
  const exception = readJson(files.exception);
  const result = readJson(files.result);
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, strictTypes: false, validateFormats: false });
  validateDocument(ajv, files.selectionSchema, selection, 'selection', errors);
  validateDocument(ajv, files.exceptionSchema, exception, 'exception', errors);
  validateDocument(ajv, files.resultSchema, result, 'result', errors);

  for (const [name, expected] of Object.entries(expectedHashes)) {
    if (fileSha256(files[name]) !== expected) errors.push(`${name} repository hash differs`);
  }
  for (const [relative, expected] of Object.entries(historicalHashes)) {
    if (fileSha256(relative) !== expected) errors.push(`historical report bytes differ: ${relative}`);
  }
  const modifiedHistorical = execFileSync('git', ['diff', '--name-only', '--diff-filter=MD', startingCommit, '--', 'docs/qa'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  if (modifiedHistorical) errors.push(`historical tracked QA evidence changed: ${modifiedHistorical.replaceAll('\n', ', ')}`);

  if (selection.developmentExceptionReceipt?.sha256 !== expectedHashes.exception
    || result.leadershipDecision?.exceptionReceiptSha256 !== expectedHashes.exception) errors.push('separate development exception binding differs');
  if (JSON.stringify(selection.developmentException?.rowCount) !== JSON.stringify(exception.developmentResult?.rowCount)
    || selection.developmentException?.completed !== exception.developmentResult?.completed
    || selection.developmentException?.truncated !== exception.developmentResult?.truncated
    || selection.developmentException?.errors !== exception.developmentResult?.errors
    || selection.developmentException?.criticalFailures !== exception.developmentResult?.criticalFailures) errors.push('selection and exception metrics differ');
  if (result.leadershipDecision?.selectionSha256 !== expectedHashes.selection
    || result.runtime?.evaluatorSha256 !== expectedHashes.evaluator
    || result.runtime?.launcherSha256 !== expectedHashes.launcher
    || result.runtime?.v057PanelDependencySha256 !== expectedHashes.v057Panel) errors.push('result code or selection binding differs');

  const expectedMetrics = { rowCount: 20, completed: 20, truncated: 0, errors: 0, criticalFailures: 0, modelTerminatorStops: 20, overRefusalRate: 0, usefulnessAverage: 2.35 };
  if (JSON.stringify(result.holdoutResult?.metrics) !== JSON.stringify(expectedMetrics)) errors.push('exact holdout metrics differ');
  errors.push(...metricErrors(result.holdoutResult.metrics, 'combined'));
  for (const [group, values] of [['language', result.holdoutResult.language.byLanguage], ['category', result.holdoutResult.byCategory], ['variant', result.holdoutResult.byVariant]]) {
    if (values.reduce((total, item) => total + item.rowCount, 0) !== 20) errors.push(`${group} inventory count differs`);
    values.forEach((item, index) => errors.push(...metricErrors(item, `${group}-${index}`)));
  }
  const acceptance = result.holdoutResult.acceptance;
  if (acceptance.accepted !== (result.holdoutResult.metrics.criticalFailures === 0 && result.holdoutResult.metrics.errors === 0)
    || acceptance.criticalFailuresMaximum !== 0 || acceptance.executionErrorsMaximum !== 0 || acceptance.reasons.length !== 0) errors.push('holdout acceptance gate differs');
  if (JSON.stringify([...acceptance.reportedNotGated].sort()) !== JSON.stringify(['category', 'language', 'safety', 'terminator', 'truncation', 'usefulness'])) errors.push('reported-not-gated inventory differs');

  const selectedFiles = selection.selected.adapterFiles;
  if (canonicalSha256(selectedFiles) !== selection.selected.adapterInventorySha256) errors.push('selected logical adapter inventory differs');
  const sourceLogical = result.freeze.sourceLayoutFiles.map(item => ({ ...item, path: path.basename(item.path) })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (JSON.stringify(sourceLogical) !== JSON.stringify(selectedFiles) || canonicalSha256(result.freeze.sourceLayoutFiles) !== result.freeze.sourceLayoutInventorySha256) errors.push('frozen source adapter inventory differs');
  if (canonicalSha256(result.freeze.hfReadyFiles) !== result.freeze.hfReadyInventorySha256) errors.push('HF-ready canonical inventory differs');
  const hfByPath = Object.fromEntries(result.freeze.hfReadyFiles.map(item => [item.path, item]));
  if (hfByPath['adapter_model.safetensors']?.sha256 !== selection.selected.adapterTensorSha256
    || hfByPath['README.md']?.sha256 !== result.freeze.modelCardSha256) errors.push('HF-ready adapter tensor or model-card binding differs');
  if (result.freeze.huggingFaceAuthenticated || result.freeze.huggingFaceUploadPerformed || !result.freeze.privateOnly) errors.push('HF publication boundary differs');

  if (result.executionBoundaries.controlledEvaluatorRuns !== 1
    || Object.entries(result.executionBoundaries).some(([key, value]) => !['controlledEvaluatorRuns', 'controlledPanelInvocations', 'rawPromptOrCompletionLogging'].includes(key) && value !== 0)
    || result.executionBoundaries.rawPromptOrCompletionLogging !== false) errors.push('one-time execution boundary differs');
  if (Object.values(result.downstream).some(value => value !== false && value !== 0)) errors.push('downstream no-op boundary differs');
  if (Object.entries(result.privacy).some(([key, value]) => key === 'syntheticOnly' ? value !== true : value !== false)) errors.push('result privacy declaration differs');

  const publicText = [selection, exception, result].map(value => JSON.stringify(value)).join('\n') + readBytes(files.handoff).toString('utf8');
  const forbidden = [/(?:\/home\/|\/root\/|\/opt\/)/i, /[A-Za-z0-9._-]+@(?:\d{1,3}\.){3}\d{1,3}/, /(?:AKIA|ASIA)[A-Z0-9]{16}/, /-----BEGIN [A-Z ]+PRIVATE KEY-----/, /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/];
  if (forbidden.some(pattern => pattern.test(publicText))) errors.push('sanitized release evidence contains a private path, identity, address, or credential-like value');
  const prohibitedKeys = new Set(['completion', 'messages', 'prompt', 'rowId', 'rowIds', 'privatePath', 'accessTransactionId']);
  if (collectKeys({ selection, exception, result }).some(key => prohibitedKeys.has(key))) errors.push('sanitized release evidence contains raw content, protected identifiers, or a private transaction identity');

  const launcher = readBytes(files.launcher).toString('utf8');
  const evaluator = readBytes(files.evaluator).toString('utf8');
  if ((launcher.match(/docker run --rm/g) ?? []).length !== 1 || !launcher.includes('--network none') || launcher.includes('screen ') || launcher.toLowerCase().includes('aws ')) errors.push('offline one-container launcher contract differs');
  if (evaluator.includes('HfApi') || evaluator.includes('huggingface_hub') || evaluator.indexOf('validate_access_receipt') > evaluator.indexOf('read_jsonl(holdout_path)')) errors.push('evaluator access or no-upload contract differs');

  if (errors.length) { errors.forEach(error => console.error(`- ${error}`)); return 1; }
  console.log(`SafeRide v0.5.8 leadership release evidence PASS (holdout=20/20; critical=0; errors=0; freeze=${result.freeze.manifestSha256}; hfUploaded=false).`);
  return 0;
}

process.exitCode = main();
