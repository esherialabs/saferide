#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha256File = filePath => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');

function readJson(relative) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relative), 'utf8'));
}

function compile(relative) {
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, strictTypes: false });
  return ajv.compile(readJson(relative));
}

function safeRepositoryFile(relative) {
  if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.includes('\\')) return null;
  const resolved = path.resolve(repoRoot, relative);
  return resolved.startsWith(`${repoRoot}${path.sep}`) ? resolved : null;
}

export function validatePlan(plan, planValidator) {
  const errors = [];
  if (!planValidator(plan)) {
    errors.push(...(planValidator.errors ?? []).map(error => `${error.instancePath || '/'}: ${error.message}`));
  }
  const paths = new Set();
  for (const binding of plan.codeBindings ?? []) {
    const resolved = safeRepositoryFile(binding.path);
    if (!resolved || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      errors.push(`code binding is unavailable or outside the repository: ${binding.path}`);
    } else if (sha256File(resolved) !== binding.sha256) {
      errors.push(`code binding SHA-256 is stale: ${binding.path}`);
    }
    if (paths.has(binding.path)) errors.push(`duplicate code binding: ${binding.path}`);
    paths.add(binding.path);
  }
  if (plan.historicalDecision?.immutableResultSha256 !== 'df42e46e1b4ef73402ab7356bea23df001bba44f64ad9cd08756ee41ae271dd4') {
    errors.push('immutable v0.5.3 result binding differs');
  }
  if (plan.fixedSuites?.originalDevelopment?.sha256 !== '434d7961ca8707f7b0ce847b0817493b71a92bc845a9862a472b5ea6b46d8881'
    || plan.fixedSuites?.mitigationDevelopment?.sha256 !== '55a9181a1b328bcd632f35d65609a4addb6c45d36b9755f1725cf659679c44cd'
    || plan.fixedSuites?.sealedHoldout?.sha256 !== '6631477003f5029ca2210484b30be542e5ec47d72da5f9e0aba6d79ccb7e3bc4') {
    errors.push('frozen suite or sealed holdout binding differs');
  }
  const runtime = plan.runtime ?? {};
  const model = runtime.baseModel ?? {};
  const expectedModelFiles = [
    ['.gitattributes', '34448b82c17d60fec9b65b1f093c115ddbaadc04beb1b0140b6bfed2e012a930', 1570],
    ['README.md', 'be82a1570493c695dd2da37dcf80f2c3fca7e7d5bdf25eacebb0acef0c3a3758', 26744],
    ['chat_template.jinja', '2f1b4d75d067bae3fe44e676721c7f077d243bc007156cb9c2f8b5836613d082', 17336],
    ['config.json', '1b28f3d2c3100f6c594754b81107428bd7b822a7f48272ca681dae9d2ec38330', 4954],
    ['generation_config.json', 'd4226bbe3117d2d253ba4609720ba82c6c4ce4627a9a6ae05387c78983ac03de', 208],
    ['model.safetensors', '2db5482b20d746879bb3ef79b5203e9075a2e2b98f54ec7c2f281c1477ddc550', 10246621918],
    ['processor_config.json', '32bdf45d2ad4cc29a0822ddd157a182de76644f0419a6228d151495256e9813c', 1689],
    ['tokenizer.json', 'cc8d3a0ce36466ccc1278bf987df5f71db1719b9ca6b4118264f45cb627bfe0f', 32169626],
    ['tokenizer_config.json', '90c3a3ba5bf53818383a58e1a776cbcacd2a038d4812eaa373e1522f2d06f3df', 2095],
  ];
  const actualModelFiles = (model.files ?? []).map(item => [item.path, item.sha256, item.sizeBytes]);
  if (model.modelId !== 'google/gemma-4-E2B-it'
    || model.revision !== '70af34e20bd4b7a91f0de6b22675850c43922a03'
    || model.fileCount !== 9
    || model.totalBytes !== 10278846140
    || JSON.stringify(actualModelFiles) !== JSON.stringify(expectedModelFiles)) {
    errors.push('pinned nine-file model snapshot binding differs');
  }
  const image = runtime.image ?? {};
  if (image.archiveSha256 !== 'a3ed2f36eb4fcf3bf52f6759dbf80c65643d1b0cd6844fa927f281053f992adf'
    || image.archiveSizeBytes !== 3350200320
    || image.runtimeManifestDigest !== 'ec30ecf55a9231d2ef9f87148ac967654f3880ebe6405164078151d157da77ca'
    || image.runtimeConfigDigest !== '7ea597c35a61e55823c554deb3821fdb50dfb68695ae712f46931a05ecb34a87'
    || image.platform !== 'linux/amd64') {
    errors.push('governed OCI runtime binding differs');
  }
  return errors;
}

function main() {
  const planRelative = process.argv[2] ?? 'config/ai/datasets/saferide-gemma4-v054-next-pilot-plan.json';
  const evidenceRelative = process.argv[3] ?? 'docs/qa/saferide-gemma4-v054-next-pilot-evidence.pending.json';
  const plan = readJson(planRelative);
  compile('schemas/ai-v054-pilot-panel-summary.schema.json');
  const planErrors = validatePlan(plan, compile('schemas/ai-v054-next-pilot-plan.schema.json'));
  const evidence = readJson(evidenceRelative);
  const evidenceValidator = compile('schemas/ai-v054-next-pilot-evidence.schema.json');
  const errors = [...planErrors];
  if (!evidenceValidator(evidence)) {
    errors.push(...(evidenceValidator.errors ?? []).map(error => `evidence${error.instancePath || '/'}: ${error.message}`));
  }
  const planPath = safeRepositoryFile(planRelative);
  if (!planPath || evidence.planSha256 !== sha256File(planPath)) errors.push('pending evidence does not bind the exact next-pilot plan');
  if (errors.length) {
    errors.forEach(error => console.error(`- ${error}`));
    return 1;
  }
  console.log('SafeRide v0.5.4 next-pilot inputs PASS (VPS validated; GPU pilot pending; promotion false).');
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
