#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mitigationRelative = 'config/ai/datasets/saferide-gemma4-v057-mitigation-plan.json';
const adjudicationRelative = 'docs/qa/saferide-gemma4-v057-private-adjudication-2026-08-09.json';
const defaultPlanRelative = 'config/ai/datasets/saferide-gemma4-v057-next-pilot-plan.json';
const historicalHead = 'b0daece87da497a50613dca329ca57814f20d4a7';
const preserved = {
  v054ResultSha256: ['docs/qa/saferide-gemma4-v054-fresh-pilot-result-2026-08-08.json', 'c5f6c3d6943202955d323327d80f98c019734cd495e8e21c7997569af5e4211d'],
  v055ResultSha256: ['docs/qa/saferide-gemma4-v055-final-targeted-result-2026-08-08.json', 'e667553a2d2664e33ff94d2906cafd26b338bece14459084a72ad4a52e9e84f0'],
  v056ResultSha256: ['docs/qa/saferide-gemma4-v056-final-targeted-result-2026-08-09.json', 'c55bf04bca6f614030aa09eaa36a31d7dd4a3f9152c1fb0341c212380cdf4ba3'],
};

const absolute = relative => path.join(repoRoot, relative);
const readJson = relative => JSON.parse(fs.readFileSync(absolute(relative), 'utf8'));
const sha256File = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const fileAtCommit = (commit, relative) => execFileSync('git', ['show', `${commit}:${relative}`], { cwd: repoRoot, encoding: null, maxBuffer: 8 * 1024 * 1024 });

function compile(relative) {
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, strictTypes: false, validateFormats: false });
  return ajv.compile(readJson(relative));
}

function safeRepositoryFile(relative) {
  if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.includes('\\')) return null;
  const resolved = path.resolve(repoRoot, relative);
  return resolved.startsWith(`${repoRoot}${path.sep}`) ? resolved : null;
}

function schemaErrors(value, validator, label) {
  if (validator(value)) return [];
  return (validator.errors ?? []).map(error => `${label}${error.instancePath || '/'}: ${error.message}`);
}

export function validateSource() {
  const mitigation = readJson(mitigationRelative);
  const adjudication = readJson(adjudicationRelative);
  const errors = [
    ...schemaErrors(mitigation, compile('schemas/ai-v057-mitigation-plan.schema.json'), 'mitigation'),
    ...schemaErrors(adjudication, compile('schemas/ai-v057-private-adjudication.schema.json'), 'adjudication'),
  ];
  if (mitigation.trainingHypothesis?.count !== 1
    || mitigation.trainingHypothesis?.initialization !== 'immutable-v0.5.6-adapter'
    || mitigation.trainingHypothesis?.learningRate !== 5e-6
    || mitigation.trainingHypothesis?.optimizerSteps !== 13
    || mitigation.trainingHypothesis?.retryAllowed !== false) errors.push('one bounded continuation hypothesis differs');
  if (mitigation.rowCounts?.newTrainingRows !== 16 || mitigation.rowCounts?.weightedTrainingExamples !== 104
    || mitigation.rowCounts?.continuationUniqueTrainingRows !== 72) errors.push('minimal v0.5.7 row inventory differs');
  if (mitigation.rubric?.scorerChanged !== false || mitigation.rubric?.thresholdsChanged !== false
    || adjudication.scorerDecision?.changeRequired !== false
    || adjudication.englishMedicalNondisclosure?.classification !== 'genuine-protected-instruction-disclosure') errors.push('fail-closed scorer adjudication differs');
  if (Object.values(adjudication.privacy ?? {}).some((value, index) => index > 0 && value !== false)) errors.push('sanitized adjudication privacy flags differ');
  return errors;
}

export function validatePlan(plan, { historical = false } = {}) {
  const errors = schemaErrors(plan, compile('schemas/ai-v057-next-pilot-plan.schema.json'), 'plan');
  const seen = new Set();
  for (const binding of plan.codeBindings ?? []) {
    const target = safeRepositoryFile(binding.path);
    if (historical) {
      try {
        if (sha256(fileAtCommit(historicalHead, binding.path)) !== binding.sha256) errors.push(`historical code binding stale: ${binding.path}`);
      } catch { errors.push(`historical code binding unavailable: ${binding.path}`); }
    } else if (!target || !fs.existsSync(target) || !fs.statSync(target).isFile()) errors.push(`code binding unavailable: ${binding.path}`);
    else if (sha256File(target) !== binding.sha256) errors.push(`code binding stale: ${binding.path}`);
    if (seen.has(binding.path)) errors.push(`duplicate code binding: ${binding.path}`);
    seen.add(binding.path);
  }
  for (const [field, [relative, expected]] of Object.entries(preserved)) {
    if (sha256File(absolute(relative)) !== expected || plan.historicalDecision?.[field] !== expected) errors.push(`preserved evidence differs: ${field}`);
  }
  const fixed = plan.fixedSuites ?? {};
  if (fixed.originalDevelopment?.rows !== 300 || fixed.originalDevelopment?.sha256 !== '434d7961ca8707f7b0ce847b0817493b71a92bc845a9862a472b5ea6b46d8881'
    || fixed.mitigationDevelopment?.rows !== 20 || fixed.mitigationDevelopment?.sha256 !== '55a9181a1b328bcd632f35d65609a4addb6c45d36b9755f1725cf659679c44cd'
    || fixed.sealedHoldout?.sha256 !== '6631477003f5029ca2210484b30be542e5ec47d72da5f9e0aba6d79ccb7e3bc4'
    || fixed.sealedHoldout?.readDuringRemediation !== false) errors.push('frozen suites or sealed holdout binding differs');
  const recipe = plan.recipe ?? {};
  if (recipe.initialAdapterTensorSha256 !== '6894f08954364b6a883bf39642d113de0fa7c17670811d41ab35bc22e5cb61c4'
    || recipe.initialization !== 'immutable-v0.5.6-adapter' || recipe.seed !== 419805 || recipe.learningRate !== 5e-6
    || recipe.optimizerSteps !== 13 || recipe.weightedExamples !== 104 || recipe.assistantOnlyLoss !== true || recipe.retryAllowed !== false) errors.push('continuation recipe binding differs');
  const runtime = plan.runtime ?? {}; const model = runtime.baseModel ?? {}; const image = runtime.image ?? {};
  if (model.modelId !== 'google/gemma-4-E2B-it' || model.revision !== '70af34e20bd4b7a91f0de6b22675850c43922a03'
    || model.fileCount !== 9 || model.totalBytes !== 10278846140) errors.push('pinned model binding differs');
  if (image.archiveSha256 !== 'a3ed2f36eb4fcf3bf52f6759dbf80c65643d1b0cd6844fa927f281053f992adf'
    || image.archiveSizeBytes !== 3350200320 || image.runtimeManifestDigest !== 'ec30ecf55a9231d2ef9f87148ac967654f3880ebe6405164078151d157da77ca'
    || image.runtimeConfigDigest !== '7ea597c35a61e55823c554deb3821fdb50dfb68695ae712f46931a05ecb34a87') errors.push('governed OCI runtime binding differs');
  if (plan.scope?.gpuExecutionPerformed !== false || plan.scope?.trainingPerformed !== false
    || plan.scope?.fullCandidateAuthorized !== false || plan.scope?.promotionAuthorized !== false) errors.push('pre-GPU scope differs');
  return errors;
}

function main() {
  compile('schemas/ai-v057-pilot-panel-summary.schema.json');
  compile('schemas/ai-v057-final-targeted-result.schema.json');
  const errors = validateSource();
  const sourceOnly = process.argv.includes('--source-only');
  if (!sourceOnly) {
    const arg = process.argv.find(value => value.endsWith('.json')) ?? defaultPlanRelative;
    const plan = readJson(arg);
    const historical = process.argv.includes('--historical');
    errors.push(...validatePlan(plan, { historical }));
    if (historical && sha256File(absolute(defaultPlanRelative)) !== '0f612981c8b146e0058a49df7d29c269c0c4341b481b8275fb2dd25a78052edc') {
      errors.push('historical v0.5.7 execution plan was rewritten');
    }
  }
  if (errors.length) {
    errors.forEach(error => console.error(`- ${error}`));
    return 1;
  }
  console.log(sourceOnly
    ? 'SafeRide v0.5.7 source contracts PASS (genuine findings; one bounded continuation; frozen rubric).'
    : process.argv.includes('--historical')
      ? 'SafeRide v0.5.7 historical next-pilot plan PASS (bytes and executed bindings preserved).'
      : 'SafeRide v0.5.7 next-pilot inputs PASS (VPS validated; one GPU pilot pending; promotion false).');
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
