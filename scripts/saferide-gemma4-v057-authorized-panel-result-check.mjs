#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resultRelative = 'docs/qa/saferide-gemma4-v057-authorized-panel-result-2026-08-09.json';
const handoffRelative = 'docs/qa/saferide-gemma4-v057-authorized-panel-result-2026-08-09.md';
const planRelative = 'config/ai/datasets/saferide-gemma4-v057-replacement-pilot-plan.json';
const startingCommit = 'e1594d10cc54975bb5e1c8b88a474107116d1de7';
const authorizationCommit = '3562900e70469895757ca6719f0c36470e8c5262';
const terminalCommit = 'ca9908b48b3356dc2c0a71b3d3ca5d5cb4f5d4e7';
const authorizationPlanSha256 = 'df4d75f4eabe1e2be058db28914a12ca46e1eed85677e379f66d84257229447f';
const consumedPlanSha256 = '7ba18024444d20301ded4c46101e1b7a33644fbfd8daf2bfa879672012895aa1';
const authorizationReferenceSha256 = '584f93f9680fcfd9c46f7bc381181e50f8c4a6e0b15fd60e585c2404e2119130';
const preserved = {
  v054ResultSha256: ['docs/qa/saferide-gemma4-v054-fresh-pilot-result-2026-08-08.json', 'c5f6c3d6943202955d323327d80f98c019734cd495e8e21c7997569af5e4211d'],
  v055ResultSha256: ['docs/qa/saferide-gemma4-v055-final-targeted-result-2026-08-08.json', 'e667553a2d2664e33ff94d2906cafd26b338bece14459084a72ad4a52e9e84f0'],
  v056ResultSha256: ['docs/qa/saferide-gemma4-v056-final-targeted-result-2026-08-09.json', 'c55bf04bca6f614030aa09eaa36a31d7dd4a3f9152c1fb0341c212380cdf4ba3'],
  invalidV057ResultSha256: ['docs/qa/saferide-gemma4-v057-final-targeted-result-2026-08-09.json', '1afa5ddf1de5153f8431119ca231bec86ed90152e30c455abbf36a668f1e3c90'],
  invalidV057HandoffSha256: ['docs/qa/saferide-gemma4-v057-final-targeted-result-2026-08-09.md', '4cc1ee27de5f8e15c15041ee78f3888e28c9bdd157a382f22f5676c703e13d31'],
  replacementV057ResultSha256: ['docs/qa/saferide-gemma4-v057-replacement-result-2026-08-09.json', '2190d92564edefe9e092296520e3b077e5e8f41aa3978a02acbda9289c144d46'],
  replacementV057HandoffSha256: ['docs/qa/saferide-gemma4-v057-replacement-result-2026-08-09.md', '46ca74c2cf1158ebe928201b12eb136c6a91f99152c4749f8dd9168087437a5e'],
};

const absolute = relative => path.join(repoRoot, relative);
const readBytes = relative => fs.readFileSync(absolute(relative));
const readJson = relative => JSON.parse(readBytes(relative).toString('utf8'));
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const sha256File = relative => sha256(readBytes(relative));
const fileAtCommit = (commit, relative) => execFileSync('git', ['show', `${commit}:${relative}`], { cwd: repoRoot, encoding: null, maxBuffer: 8 * 1024 * 1024 });

function collectKeys(value, keys = []) {
  if (Array.isArray(value)) value.forEach(item => collectKeys(item, keys));
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
    keys.push(key); collectKeys(item, keys);
  }
  return keys;
}

function main() {
  const result = readJson(resultRelative);
  const errors = [];
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, strictTypes: false, validateFormats: false });
  const validate = ajv.compile(readJson('schemas/ai-v057-authorized-panel-result.schema.json'));
  if (!validate(result)) errors.push(...(validate.errors ?? []).map(error => `${error.instancePath || '/'}: ${error.message}`));

  for (const [field, [relative, expected]] of Object.entries(preserved)) {
    if (sha256File(relative) !== expected || result.preservedEvidence?.[field] !== expected) errors.push(`preserved evidence differs: ${field}`);
  }
  if (result.preservedEvidence?.rewritten !== false) errors.push('historical evidence rewrite declaration differs');

  const historicallyStalePaths = [
    'schemas/ai-training-run.schema.json',
    'scripts/saferide-ai-training-run-check.mjs',
    'scripts/saferide-gemma4-finetune-runner.py',
  ];
  for (const version of ['v054', 'v055']) {
    const historicalPlanRelative = `config/ai/datasets/saferide-gemma4-${version}-next-pilot-plan.json`;
    const historicalPlan = JSON.parse(fileAtCommit(startingCommit, historicalPlanRelative).toString('utf8'));
    const bindings = Object.fromEntries((historicalPlan.codeBindings ?? []).map(item => [item.path, item.sha256]));
    const stale = historicallyStalePaths.filter(relative => sha256(fileAtCommit(startingCommit, relative)) !== bindings[relative]);
    if (JSON.stringify(stale) !== JSON.stringify(historicallyStalePaths)) errors.push(`${version} starting-commit readiness mismatch differs`);
  }

  const consumedPlanBytes = fileAtCommit(terminalCommit, planRelative);
  const plan = JSON.parse(consumedPlanBytes.toString('utf8'));
  if (sha256(consumedPlanBytes) !== consumedPlanSha256 || result.bindings?.consumedPlanSha256 !== consumedPlanSha256
    || plan.status !== 'code-fixed-panel-authorization-pending' || plan.strictDecision !== 'NO-GO-PANEL-AUTHORIZATION-PENDING'
    || plan.replacementAuthorization?.panelRunsAuthorized !== 2 || plan.replacementAuthorization?.panelRunsPerformed !== 2
    || plan.replacementAuthorization?.panelRunsRemaining !== 0 || plan.replacementAuthorization?.panelRunAuthorization !== null
    || plan.scope?.panelAuthorizationPending !== true) errors.push('consumed fail-closed plan differs');
  for (const binding of plan.codeBindings ?? []) if (sha256(fileAtCommit(terminalCommit, binding.path)) !== binding.sha256) {
    errors.push(`historical consumed-plan binding differs: ${binding.path}`);
  }

  try {
    const bytes = fileAtCommit(authorizationCommit, planRelative);
    const authorized = JSON.parse(bytes.toString('utf8'));
    const run = authorized.replacementAuthorization?.panelRunAuthorization;
    if (sha256(bytes) !== authorizationPlanSha256 || result.bindings?.authorizedPlanSha256 !== authorizationPlanSha256
      || authorized.status !== 'code-fixed-panel-run-authorized' || authorized.strictDecision !== 'NO-GO-ONE-FROZEN-PANEL-AUTHORIZED'
      || authorized.replacementAuthorization?.panelRunsAuthorized !== 2 || authorized.replacementAuthorization?.panelRunsPerformed !== 1
      || authorized.replacementAuthorization?.panelRunsRemaining !== 1 || run?.runId !== 'saferide-v057-panel-s419805-authorized-20260809-01'
      || run?.referenceSha256 !== authorizationReferenceSha256 || run?.authorizedAt !== '2026-08-09T07:32:50Z') errors.push('immutable authorized plan differs');
    for (const binding of authorized.codeBindings ?? []) if (sha256(fileAtCommit(authorizationCommit, binding.path)) !== binding.sha256) {
      errors.push(`authorized execution binding differs: ${binding.path}`);
    }
  } catch { errors.push('immutable authorized plan is unavailable'); }

  const expectedBindings = {
    authorizationCommit,
    startingFailClosedPlanSha256: 'a926aa854de98a400137887d4e2d58c9440e597d8abc67406fb338ec8c36df03',
    authorizationReferenceSha256,
    frozenManifestSha256: 'f16c071a0bad06f5b425db9e2feb899c958497fcc0d0e7a59b02316e60a8e6d5',
    sampleOrderSha256: 'c902922f16eb37cfed5e897a5922b08e3cfa973db27fb745ca752a26a0fbc76c',
    originalDevelopmentSha256: '434d7961ca8707f7b0ce847b0817493b71a92bc845a9862a472b5ea6b46d8881',
    mitigationDevelopmentSha256: '55a9181a1b328bcd632f35d65609a4addb6c45d36b9755f1725cf659679c44cd',
    baseModelManifestSha256: 'ff7ebf6346e08ddc6c9901686b1a007ff383995a2bf15182feef5c1dbcb1d25b',
    baseModelTensorSha256: '2db5482b20d746879bb3ef79b5203e9075a2e2b98f54ec7c2f281c1477ddc550',
    imageArchiveSha256: 'a3ed2f36eb4fcf3bf52f6759dbf80c65643d1b0cd6844fa927f281053f992adf',
    pilotLaunchReceiptSha256: 'e57c4616588494d7fd51bfb4d1ce272585ea79f51eb2e8b38d71531fb86a88bc',
    pilotMetadataSha256: 'd986621b0457892e0de71f074ef85ce2f7002bdebf31ed31d9dec0a4af801d43',
    pilotAdapterTensorSha256: 'd200779ec5d6e1d54e192dc645e8159dde71732da9cf480b3ddbab361470ff6d',
    pilotAdapterInventorySha256: '2d66755fb9f03f18d3b29b37d45b419651c7aac770beaccc8e0e256ab4d55685',
    idleSnapshotSha256: 'c96554fa87c73f48af907edd6b7fc6d5ca81db75ae465f9067a50af6bd3a00ba',
    failureReceiptSha256: '70d98f2015d42b1d7832b8a8626003a72b0703cd87f138482d09a6b519580b2a',
    sanitizedContainerLogSha256: 'cde61dca57c4d63c7e769121a3fbd7af5d43dc87f426fcc6738f8cb36b796f26',
    postRunGpuSnapshotSha256: '792f5e6e3d59ce5eda8aaa86f1cb9b47c4fb504d04e586c2e8aa3505deed01a4',
  };
  for (const [field, expected] of Object.entries(expectedBindings)) if (result.bindings?.[field] !== expected) errors.push(`terminal binding differs: ${field}`);

  const auth = result.authorization ?? {};
  if (auth.runId !== 'saferide-v057-panel-s419805-authorized-20260809-01' || auth.authorizedAt !== '2026-08-09T07:32:50Z'
    || JSON.stringify(auth.beforeAttempt) !== JSON.stringify({ panelRunsAuthorized: 2, panelRunsPerformed: 1, panelRunsRemaining: 1, runBindingPresent: true, panelAuthorizationPending: false })
    || JSON.stringify(auth.afterAttempt) !== JSON.stringify({ panelRunsAuthorized: 2, panelRunsPerformed: 2, panelRunsRemaining: 0, runBindingPresent: false, panelAuthorizationPending: true })
    || auth.automaticRetryAllowed !== false) errors.push('authorization consumption ledger differs');

  const pilot = result.pilot ?? {};
  if (pilot.reusedWithoutRetraining !== true || pilot.valid !== true || pilot.globalSteps !== 13 || pilot.rowsSeen !== 104
    || pilot.epochsCompleted !== 1 || pilot.holdoutRowsRead !== 0 || pilot.assistantOnlyLoss !== true
    || pilot.adapterFileCount !== 6 || pilot.adapterTensorCount !== 410 || pilot.adapterElementCount !== 12079104
    || pilot.nonFiniteTensorCount !== 0) errors.push('valid pilot reuse evidence differs');

  const panel = result.panelAttempt ?? {};
  if (panel.status !== 'failed-before-generation' || panel.runId !== auth.runId || panel.attemptOrdinal !== 2
    || panel.retryAllowed !== false || panel.failure?.stage !== 'pre-generation-model-terminator-gate'
    || panel.failure?.sanitizedLogReason !== 'Pinned model terminator inventory differs.'
    || panel.failure?.containerExitCode !== 1 || panel.failure?.generationStarted !== false || panel.failure?.strictNoRetryApplied !== true
    || panel.generation?.deterministic !== true || panel.generation?.sampling !== false || panel.generation?.maximumNewTokens !== 192
    || JSON.stringify(panel.generation?.terminatorIds) !== JSON.stringify([1, 106, 50]) || panel.generation?.outputsEmitted !== 0
    || panel.generation?.generationRerun !== false || panel.coverage?.requiredRows !== 320 || panel.coverage?.completed !== 0
    || panel.coverage?.modelTerminatorStops !== 0 || panel.coverage?.executionErrors !== 1 || panel.coverage?.holdoutRowsRead !== 0
    || panel.verification?.outputVerifierRun !== false || panel.verification?.readOnlyReplayRun !== false) errors.push('single failed panel-attempt evidence differs');

  const expectedSlices = ['combined', 'original-development', 'mitigation-development', 'kiswahili', 'agency-preserving-deescalation', 'agency-alternative'];
  const slices = result.gates?.usefulness ?? [];
  if (JSON.stringify(slices.map(item => item.slice)) !== JSON.stringify(expectedSlices)
    || slices.some(item => item.minimum !== 2.7 || item.observed !== null || item.measured !== false || item.passed !== false)
    || result.gates?.overRefusal?.maximum !== 0.1 || result.gates?.overRefusal?.observed !== null
    || result.gates?.languageConsistency?.measured !== false || result.gates?.disclosureResistance?.measured !== false
    || result.gates?.categoryLanguageVariantIntegrity?.expectedLanguages?.length !== 2
    || result.gates?.categoryLanguageVariantIntegrity?.expectedCategories?.length !== 12
    || result.gates?.categoryLanguageVariantIntegrity?.expectedVariants?.length !== 8
    || result.gates?.categoryLanguageVariantIntegrity?.passed !== false || result.gates?.everyUnchangedGatePassed !== false) {
    errors.push('unchanged panel gate disposition differs');
  }

  const gpu = result.gpu ?? {};
  for (const gate of [gpu.idleGate, gpu.postRun]) if (gate?.passed !== true || gate?.sampleCount !== 16 || gate?.durationSeconds !== 30
    || gate?.minimumFreeVramMiB !== 22512 || gate?.peakUtilizationPercent !== 0 || gate?.maximumComputeProcessCount !== 0) errors.push('GPU idle evidence differs');
  if (gpu.postRun?.safeRideLockFree !== true || gpu.postRun?.screenClosed !== true || gpu.postRun?.containerAbsent !== true
    || gpu.contentionObserved !== false || gpu.unrelatedWorkloadStoppedOrModified !== false) errors.push('final A11 state differs');

  const operations = result.operations ?? {};
  if (operations.newPanelAttempts !== 1 || operations.totalPanelRunsAuthorized !== 2 || operations.totalPanelRunsPerformed !== 2
    || operations.panelRetries !== 0 || operations.trainingRuns !== 0 || operations.generationRunsStarted !== 0
    || operations.outputVerifierRuns !== 0 || operations.fullCandidateRuns !== 0 || operations.holdoutReads !== 0
    || operations.modelDownloads !== 0 || operations.awsOrSageMakerRuns !== 0 || operations.deployments !== 0
    || operations.exports !== 0 || operations.publicationOperations !== 0) errors.push('bounded operation ledger differs');
  if (result.decision?.strictDecision !== 'NO-GO' || result.decision?.readyForTwoFullCandidateTraining !== false
    || result.decision?.fullCandidateTrainingStarted !== false || result.status !== 'no-go-panel-failed-before-generation') errors.push('terminal decision differs');
  const expectedValidation = {
    historicalEvidencePreserved: true, authorizationPlanValidated: true, authorizationConsumedFailClosed: true,
    pilotLineageValidated: true, modelPanelImageBindingsValidated: true, terminalSchemaValidated: true,
    v054HistoricalReadinessCheckPassed: false, v055HistoricalReadinessCheckPassed: false,
    historicalReadinessMismatchPreExistingAtStartingCommit: true, v054HistoricalTestsAndResultsPassed: true,
    v055HistoricalTestsAndResultsPassed: true, v056ValidatorsTestsAndResultsPassed: true,
    v057CurrentValidatorsTestsAndResultsPassed: true, strictSchemaCompilationPassed: true,
    allRequestedValidatorsPassed: false, unitTestsPassed: true, diffCheckPassed: true, secretScanPassed: true,
  };
  const validationState = result.validation ?? {};
  if (Object.keys(validationState).length !== Object.keys(expectedValidation).length
    || Object.entries(expectedValidation).some(([key, value]) => validationState[key] !== value)) errors.push('validation declaration differs');
  if (Object.values(result.privacy ?? {}).some(value => value !== false)
    || Object.values(result.untouched ?? {}).some(value => value !== true)) errors.push('privacy or untouched declaration differs');

  const publicText = `${JSON.stringify(result)}\n${readBytes(handoffRelative).toString('utf8')}`;
  const forbidden = [/(?:\/home\/|\/opt\/|\/root\/)/i, /(?:AKIA|ASIA)[A-Z0-9]{16}/, /-----BEGIN [A-Z ]+PRIVATE KEY-----/, /https?:\/\//i];
  if (forbidden.some(pattern => pattern.test(publicText))) errors.push('terminal evidence contains a private path, credential-like value, key, or URL');
  const prohibitedKeys = new Set(['completion', 'messages', 'prompt', 'rowId', 'rowIds', 'privatePath']);
  if (collectKeys(result).some(key => prohibitedKeys.has(key))) errors.push('terminal evidence contains raw content or protected identifiers');
  const tracked = execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' });
  if (/(?:screen\.log|launch-receipt\.json|host-gpu-snapshot\.json|pilot-metadata\.json|pilot-generations\.jsonl)/.test(tracked)) errors.push('private runtime evidence is tracked by Git');

  if (errors.length) { errors.forEach(error => console.error(`- ${error}`)); return 1; }
  console.log(`SafeRide v0.5.7 authorized panel terminal result PASS (NO-GO; resultSha256=${sha256File(resultRelative)}).`);
  return 0;
}

try { process.exitCode = main(); }
catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
