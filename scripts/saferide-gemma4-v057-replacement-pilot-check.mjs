#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';
import { validateSource } from './saferide-gemma4-v057-next-pilot-check.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultPlanRelative = 'config/ai/datasets/saferide-gemma4-v057-replacement-pilot-plan.json';
const executedPilotCommit = '002d8af1a18cfdb0b04f5dc8a4e044273dc61aee';
const executedPilotPlanSha256 = '7a33b1fc1762aa5ad986dd997c12cc3de9d5c3bcc27ce2c9e980df19ae9dfbbf';
const preserved = {
  v054ResultSha256: ['docs/qa/saferide-gemma4-v054-fresh-pilot-result-2026-08-08.json', 'c5f6c3d6943202955d323327d80f98c019734cd495e8e21c7997569af5e4211d'],
  v055ResultSha256: ['docs/qa/saferide-gemma4-v055-final-targeted-result-2026-08-08.json', 'e667553a2d2664e33ff94d2906cafd26b338bece14459084a72ad4a52e9e84f0'],
  v056ResultSha256: ['docs/qa/saferide-gemma4-v056-final-targeted-result-2026-08-09.json', 'c55bf04bca6f614030aa09eaa36a31d7dd4a3f9152c1fb0341c212380cdf4ba3'],
  invalidV057AttemptResultSha256: ['docs/qa/saferide-gemma4-v057-final-targeted-result-2026-08-09.json', '1afa5ddf1de5153f8431119ca231bec86ed90152e30c455abbf36a668f1e3c90'],
};

const absolute = relative => path.join(repoRoot, relative);
const readJson = relative => JSON.parse(fs.readFileSync(absolute(relative), 'utf8'));
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const sha256File = file => sha256(fs.readFileSync(file));
const fileAtCommit = (commit, relative) => execFileSync('git', ['show', `${commit}:${relative}`], { cwd: repoRoot, encoding: null, maxBuffer: 8 * 1024 * 1024 });
const canonicalJson = value => Array.isArray(value)
  ? `[${value.map(canonicalJson).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
    : JSON.stringify(value);

function compile(relative) {
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, strictTypes: false, validateFormats: false });
  return ajv.compile(readJson(relative));
}

function safeRepositoryFile(relative) {
  if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.includes('\\')) return null;
  const resolved = path.resolve(repoRoot, relative);
  return resolved.startsWith(`${repoRoot}${path.sep}`) ? resolved : null;
}

function main() {
  const relative = process.argv.find(value => value.endsWith('.json')) ?? defaultPlanRelative;
  const requirePanelAuthorization = process.argv.includes('--require-panel-authorization');
  const plan = readJson(relative);
  const errors = [...validateSource()];
  const validator = compile('schemas/ai-v057-replacement-pilot-plan.schema.json');
  if (!validator(plan)) errors.push(...(validator.errors ?? []).map(error => `plan${error.instancePath || '/'}: ${error.message}`));
  compile('schemas/ai-v057-pilot-panel-summary.schema.json');
  compile('schemas/ai-v057-replacement-result.schema.json');

  try {
    const pilotPlanBytes = fileAtCommit(executedPilotCommit, defaultPlanRelative);
    const pilotPlan = JSON.parse(pilotPlanBytes.toString('utf8'));
    if (sha256(pilotPlanBytes) !== executedPilotPlanSha256) errors.push('executed replacement-pilot plan differs');
    for (const binding of pilotPlan.codeBindings ?? []) {
      if (sha256(fileAtCommit(executedPilotCommit, binding.path)) !== binding.sha256) errors.push(`executed pilot code binding differs: ${binding.path}`);
    }
  } catch { errors.push('executed replacement-pilot plan is unavailable'); }

  const seen = new Set();
  for (const binding of plan.codeBindings ?? []) {
    const target = safeRepositoryFile(binding.path);
    if (!target || !fs.existsSync(target) || !fs.statSync(target).isFile()) errors.push(`code binding unavailable: ${binding.path}`);
    else if (sha256File(target) !== binding.sha256) errors.push(`code binding stale: ${binding.path}`);
    if (seen.has(binding.path)) errors.push(`duplicate code binding: ${binding.path}`);
    seen.add(binding.path);
  }
  for (const [field, [historicalRelative, expected]] of Object.entries(preserved)) {
    if (sha256File(absolute(historicalRelative)) !== expected || plan.historicalDecision?.[field] !== expected) errors.push(`preserved evidence differs: ${field}`);
  }
  if (plan.historicalDecision?.rewritten !== false || plan.invalidatedAttempt?.evidenceRewritten !== false
    || plan.invalidatedAttempt?.soleInvalidationReason !== 'post-training-wrapper-namespace-omitted-run-kind'
    || plan.invalidatedAttempt?.eligibleForReuse !== false) errors.push('prior v0.5.7 failure disposition differs');

  const authorization = plan.replacementAuthorization ?? {};
  const panelAuthorization = authorization.panelRunAuthorization;
  const pendingAuthorization = plan.status === 'code-fixed-panel-authorization-pending'
    && plan.strictDecision === 'NO-GO-PANEL-AUTHORIZATION-PENDING'
    && ((authorization.panelRunsAuthorized === 1 && authorization.panelRunsPerformed === 1)
      || (authorization.panelRunsAuthorized === 2 && authorization.panelRunsPerformed === 2)
      || (authorization.panelRunsAuthorized === 3 && authorization.panelRunsPerformed === 3))
    && authorization.panelRunsRemaining === 0 && panelAuthorization === null;
  const activeAuthorization = plan.status === 'code-fixed-panel-run-authorized'
    && plan.strictDecision === 'NO-GO-ONE-FROZEN-PANEL-AUTHORIZED'
    && authorization.panelRunsAuthorized === 3 && authorization.panelRunsPerformed === 2
    && authorization.panelRunsRemaining === 1 && panelAuthorization
    && /^saferide-v057-panel-s419805-[a-z0-9-]+$/.test(panelAuthorization.runId ?? '')
    && /^[a-f0-9]{64}$/.test(panelAuthorization.referenceSha256 ?? '')
    && typeof panelAuthorization.authorizedAt === 'string' && panelAuthorization.authorizedAt.length >= 20;
  if (authorization.pilotRunsAuthorized !== 1 || authorization.pilotRunsPerformed !== 1 || authorization.automaticRetryAllowed !== false
    || authorization.panelConditionalOnValidPilot !== true
    || authorization.fullCandidateTrainingAuthorized !== false || authorization.holdoutAccessAuthorized !== false) {
    errors.push('replacement authorization common boundary differs');
  }
  if (requirePanelAuthorization && !activeAuthorization) errors.push('panel authorization exhausted: a fresh run-specific plan binding is required');
  if (!requirePanelAuthorization && !pendingAuthorization) errors.push('post-fix panel-authorization-pending state differs');
  const pilot = plan.pilotExecution ?? {};
  if (pilot.valid !== true || pilot.attempts !== 1 || pilot.executionCommit !== executedPilotCommit
    || pilot.planSha256 !== executedPilotPlanSha256
    || pilot.launchReceiptSha256 !== 'e57c4616588494d7fd51bfb4d1ce272585ea79f51eb2e8b38d71531fb86a88bc'
    || pilot.metadataSha256 !== 'd986621b0457892e0de71f074ef85ce2f7002bdebf31ed31d9dec0a4af801d43'
    || pilot.adapterTensorSha256 !== 'd200779ec5d6e1d54e192dc645e8159dde71732da9cf480b3ddbab361470ff6d'
    || pilot.adapterInventorySha256 !== '2d66755fb9f03f18d3b29b37d45b419651c7aac770beaccc8e0e256ab4d55685'
    || pilot.checkpointInventorySha256 !== '6b3be7e948210fd06c31b8b1c668c7bfdf363df68cb25dfb6bf7e0944f5f254d'
    || pilot.globalSteps !== 13 || pilot.rowsSeen !== 104 || pilot.epochsCompleted !== 1
    || pilot.holdoutRowsRead !== 0 || pilot.metadataCompleteAndSanitized !== true) errors.push('valid replacement-pilot execution evidence differs');
  const fixed = plan.fixedSuites ?? {};
  if (fixed.originalDevelopment?.rows !== 300 || fixed.originalDevelopment?.sha256 !== '434d7961ca8707f7b0ce847b0817493b71a92bc845a9862a472b5ea6b46d8881'
    || fixed.mitigationDevelopment?.rows !== 20 || fixed.mitigationDevelopment?.sha256 !== '55a9181a1b328bcd632f35d65609a4addb6c45d36b9755f1725cf659679c44cd'
    || fixed.sealedHoldout?.sha256 !== '6631477003f5029ca2210484b30be542e5ec47d72da5f9e0aba6d79ccb7e3bc4'
    || fixed.originalDevelopment?.mutated !== false || fixed.mitigationDevelopment?.mutated !== false
    || fixed.sealedHoldout?.readDuringRemediation !== false) errors.push('frozen suites or sealed holdout binding differs');
  const recipe = plan.recipe ?? {};
  if (recipe.initialization !== 'immutable-v0.5.6-adapter'
    || recipe.initialAdapterTensorSha256 !== '6894f08954364b6a883bf39642d113de0fa7c17670811d41ab35bc22e5cb61c4'
    || recipe.initialAdapterInventorySha256 !== '7f5715a366c323bbf6da67f8e1ed5c219d697af83ab3a126c52b1366561656f1'
    || recipe.initialAdapterFileCount !== 6 || recipe.initialAdapterTotalBytes !== 80584074
    || recipe.seed !== 419805 || recipe.epochs !== 1 || recipe.learningRate !== 5e-6
    || recipe.optimizerSteps !== 13 || recipe.weightedExamples !== 104 || recipe.assistantOnlyLoss !== true
    || recipe.singlePilotOnly !== true || recipe.retryAllowed !== false) errors.push('continuation recipe differs');
  const dataset = plan.dataset ?? {};
  if (dataset.frozenManifestSha256 !== 'f16c071a0bad06f5b425db9e2feb899c958497fcc0d0e7a59b02316e60a8e6d5'
    || dataset.weightedTrainSha256 !== '795a11581895487825067c6d518d636e9091f768d285dd99f6cd49d1af170766'
    || dataset.sampleOrderSha256 !== 'c902922f16eb37cfed5e897a5922b08e3cfa973db27fb745ca752a26a0fbc76c'
    || dataset.uniqueRows !== 72 || dataset.weightedExamples !== 104 || dataset.newRows !== 16 || dataset.newFamilies !== 8) {
    errors.push('frozen v0.5.7 dataset or sample order differs');
  }
  const model = plan.runtime?.baseModel ?? {}; const image = plan.runtime?.image ?? {};
  const expectedModelPaths = ['.gitattributes', 'README.md', 'chat_template.jinja', 'config.json', 'generation_config.json', 'model.safetensors', 'processor_config.json', 'tokenizer.json', 'tokenizer_config.json'];
  const modelFiles = Array.isArray(model.files) ? model.files : [];
  const modelPaths = modelFiles.map(item => item?.path);
  const modelFilesValid = modelFiles.every(item => item && typeof item.path === 'string'
    && /^[a-f0-9]{64}$/.test(item.sha256) && Number.isInteger(item.sizeBytes) && item.sizeBytes > 0);
  if (model.modelId !== 'google/gemma-4-E2B-it'
    || model.revision !== '70af34e20bd4b7a91f0de6b22675850c43922a03'
    || model.fileCount !== 9 || model.totalBytes !== 10278846140
    || modelFiles.length !== 9 || new Set(modelPaths).size !== 9
    || JSON.stringify(modelPaths) !== JSON.stringify(expectedModelPaths)
    || !modelFilesValid || modelFiles.reduce((total, item) => total + item.sizeBytes, 0) !== 10278846140
    || sha256(canonicalJson(model)) !== 'ff7ebf6346e08ddc6c9901686b1a007ff383995a2bf15182feef5c1dbcb1d25b'
    || image.archiveSha256 !== 'a3ed2f36eb4fcf3bf52f6759dbf80c65643d1b0cd6844fa927f281053f992adf'
    || image.archiveSizeBytes !== 3350200320 || image.runtimeManifestDigest !== 'ec30ecf55a9231d2ef9f87148ac967654f3880ebe6405164078151d157da77ca'
    || image.runtimeConfigDigest !== '7ea597c35a61e55823c554deb3821fdb50dfb68695ae712f46931a05ecb34a87') errors.push('model or OCI runtime binding differs');
  const finalPanelGenerationPerformed = authorization.panelRunsAuthorized === 3
    && authorization.panelRunsPerformed === 3 && authorization.panelRunsRemaining === 0;
  if (plan.scope?.replacementGpuExecutionPerformed !== true || plan.scope?.replacementTrainingPerformed !== true
    || plan.scope?.replacementPanelAttemptPerformed !== true
    || plan.scope?.replacementPanelGenerationPerformed !== finalPanelGenerationPerformed
    || plan.scope?.fullCandidateAuthorized !== false || plan.scope?.holdoutAccessAuthorized !== false
    || plan.scope?.priorFailureEvidencePreserved !== true) errors.push('replacement panel authorization scope differs');
  if (plan.scope?.panelAuthorizationPending !== !requirePanelAuthorization) {
    errors.push(requirePanelAuthorization ? 'panel authorization is still pending' : 'panel authorization pending flag differs');
  }

  if (errors.length) { errors.forEach(error => console.error(`- ${error}`)); return 1; }
  console.log(requirePanelAuthorization
    ? 'SafeRide v0.5.7 replacement panel authorization PASS (one newly bound run; candidates false).'
    : `SafeRide v0.5.7 fail-closed panel state PASS (${authorization.panelRunsPerformed} authorization(s) consumed; zero panel runs remaining; fresh authorization required).`);
  return 0;
}

try { process.exitCode = main(); }
catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
