#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resultRelative = 'docs/qa/saferide-gemma4-v056-final-targeted-result-2026-08-09.json';
const evidenceRelative = 'docs/qa/saferide-gemma4-v056-next-pilot-evidence.pending.json';
const planRelative = 'config/ai/datasets/saferide-gemma4-v056-next-pilot-plan.json';
const runnerRelative = 'scripts/saferide-gemma4-finetune-runner.py';
const remediationRelative = 'scripts/saferide-gemma4-v056-remediation.py';
const diagnosisRelative = 'docs/qa/saferide-gemma4-v056-panel-diagnosis-2026-08-09.json';

const preserved = {
  failedPreflightResultSha256: ['docs/qa/saferide-gemma4-v054-targeted-pilot-result-2026-08-08.json', '81ade8f8ffb124a4608c487999cbd0bbd481046b973d8e45cc7dfc88c88c92bd'],
  failedPilotResultSha256: ['docs/qa/saferide-gemma4-v054-continuation-result-2026-08-08.json', 'ab7227dd1cf2cc03a0246068c1adb6475dbd678afd021f679bc57d868064d8c0'],
  invalidReusePanelResultSha256: ['docs/qa/saferide-gemma4-v054-pilot-reuse-result-2026-08-08.json', '6655b0c44faeb728e405d6a4e0e662aaeae810fa8dceed0db01c98c1aa610c70'],
  reuseConflictEvidenceSha256: ['docs/qa/saferide-gemma4-v054-reuse-conflict-2026-08-08.json', '4cd70f9f8466045cc7fa1b93bee83463add403573350f71c2883d2888727aa11'],
  freshV054NoGoResultSha256: ['docs/qa/saferide-gemma4-v054-fresh-pilot-result-2026-08-08.json', 'c5f6c3d6943202955d323327d80f98c019734cd495e8e21c7997569af5e4211d'],
  v055FinalNoGoResultSha256: ['docs/qa/saferide-gemma4-v055-final-targeted-result-2026-08-08.json', 'e667553a2d2664e33ff94d2906cafd26b338bece14459084a72ad4a52e9e84f0'],
};

const expectedBindings = {
  humanReferencedHead: 'b1ee2c938f32b73c0e3492e1fbfb185f235a95c8',
  observedContinuationHead: '3bcc9369766ccacb2443a9898db7f09e11aaba69',
  datasetSourceCommit: '91f9873564001052e365a86670531484dd08db43',
  executionCommit: 'd36d45cb165aac8749d088604de11a55c3e93a38',
  planSha256: '9c182fc9324242b5c6e6ac2878dbd1f192a307d0172b79e24c456e6e5b26f69e',
  runnerSha256: '71bee51c9760fd08492436ab5138e4f63b9f889fcaecb7a3677bda8805768ffe',
  remediationSha256: 'eb6be2b576b67e731a132a50b668d6844b8694c50017e55be1bb67eaa59206b7',
  diagnosisSha256: '9adb1b41ea8847e70d3a9bc3235dbd85d65ffd9bad31c85c0cffbf2fa344b96d',
  sourceV054FrozenManifestSha256: '92f997666d83664e8319a59188941bc1510320d733bd891c8ab0ed2ee17812ad',
  frozenManifestSha256: '9900b4d55eef76d5dcc2deead3a5586695f08aaaea38ebbe6783ee5f23138dc0',
  combinedTrainingSha256: '02688c26f0a89f070350f8c92d4b7937750beff2f6fae1d977b0d60f5011c2d7',
  newMitigationTrainingSha256: '54f311799a13e4d6d894a8e43447710b84cd8fff0461645760243b1b155b3b54',
  trainingRecipeSha256: '2fd5651b112c43b1f4ca4e3aedfd05fef4ab62f05343a85abd3268b02201318e',
  sampleOrderSha256: '56710de8070307f06204192e3ee66bf4509a757560080c4f26ee3f69d1c882ea',
  originalDevelopmentSha256: '434d7961ca8707f7b0ce847b0817493b71a92bc845a9862a472b5ea6b46d8881',
  mitigationDevelopmentSha256: '55a9181a1b328bcd632f35d65609a4addb6c45d36b9755f1725cf659679c44cd',
  sealedHoldoutSha256: '6631477003f5029ca2210484b30be542e5ec47d72da5f9e0aba6d79ccb7e3bc4',
  panelInputManifestSha256: '38043c2522bd5bcf0f26cbc2e9ecc1709642d1becfa71b1313f4c436e6754561',
  rubricV4PolicySha256: '062b9805a7cb92ab53381f5058707a50669ba38f4b08265288777712c74ab69a',
  lossPolicySha256: 'f6d2222a082a38984cd0d2ce3d28e92e54c715600b8e267a83eba1b0e00601e8',
  modelRevision: '70af34e20bd4b7a91f0de6b22675850c43922a03',
  runtimeArchiveSha256: 'a3ed2f36eb4fcf3bf52f6759dbf80c65643d1b0cd6844fa927f281053f992adf',
  runtimeManifestDigest: 'ec30ecf55a9231d2ef9f87148ac967654f3880ebe6405164078151d157da77ca',
  runtimeConfigDigest: '7ea597c35a61e55823c554deb3821fdb50dfb68695ae712f46931a05ecb34a87',
};

const readBytes = relative => fs.readFileSync(path.join(repoRoot, relative));
const readJson = relative => JSON.parse(readBytes(relative).toString('utf8'));
const sha256Bytes = value => crypto.createHash('sha256').update(value).digest('hex');
const sha256File = relative => sha256Bytes(readBytes(relative));
const close = (left, right, tolerance = 1e-9) => Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= tolerance;

function compile(relative) {
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, strictTypes: false, validateFormats: false });
  return ajv.compile(readJson(relative));
}

function fileAtCommit(commit, relative) {
  return execFileSync('git', ['show', `${commit}:${relative}`], { cwd: repoRoot, encoding: null, maxBuffer: 4 * 1024 * 1024 });
}

function collectKeys(value, keys = []) {
  if (Array.isArray(value)) value.forEach(item => collectKeys(item, keys));
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      keys.push(key);
      collectKeys(item, keys);
    }
  }
  return keys;
}

function main() {
  const result = readJson(resultRelative);
  const evidence = readJson(evidenceRelative);
  const errors = [];
  const resultValidator = compile('schemas/ai-v056-final-targeted-result.schema.json');
  const evidenceValidator = compile('schemas/ai-v056-next-pilot-evidence.schema.json');
  compile('schemas/ai-v056-pilot-panel-summary.schema.json');
  if (!resultValidator(result)) errors.push(...(resultValidator.errors ?? []).map(error => `${error.instancePath || '/'}: ${error.message}`));
  if (!evidenceValidator(evidence)) errors.push(...(evidenceValidator.errors ?? []).map(error => `evidence${error.instancePath || '/'}: ${error.message}`));

  for (const [key, expected] of Object.entries(expectedBindings)) {
    if (result.bindings?.[key] !== expected) errors.push(`binding differs: ${key}`);
  }
  const executionCommit = expectedBindings.executionCommit;
  if (sha256Bytes(fileAtCommit(executionCommit, planRelative)) !== expectedBindings.planSha256
    || sha256Bytes(fileAtCommit(executionCommit, runnerRelative)) !== expectedBindings.runnerSha256
    || sha256Bytes(fileAtCommit(executionCommit, remediationRelative)) !== expectedBindings.remediationSha256
    || sha256Bytes(fileAtCommit(executionCommit, diagnosisRelative)) !== expectedBindings.diagnosisSha256
    || sha256File(planRelative) !== expectedBindings.planSha256) {
    errors.push('exact executed plan, runner, remediation, or diagnosis binding differs');
  }
  for (const [field, [relative, expected]] of Object.entries(preserved)) {
    if (sha256File(relative) !== expected || result.preservedEvidence?.[field] !== expected) errors.push(`preserved evidence differs: ${field}`);
  }
  if (result.preservedEvidence?.rewritten !== false) errors.push('prior NO-GO evidence was rewritten');

  const training = evidence.training ?? {};
  if (evidence.status !== 'complete' || evidence.strictDecision !== 'NO-GO' || evidence.panel !== null
    || evidence.promotionEligible !== false || evidence.planSha256 !== expectedBindings.planSha256
    || training.manifestSha256 !== '832208d737818f0c2eb9329b3e95571305b66b807f4c19cd693921532f36fb6e'
    || training.globalSteps !== 243 || training.rowsSeen !== 1944
    || !close(training.rawTrainerAccumulatedLoss, 20.70860326633532)
    || !close(training.meanTrainingObjectiveLoss, 2.588575408291915)
    || !close(training.bestDevelopmentLoss, 1.8439538478851318)
    || !close(training.finalDevelopmentLoss, 1.8439538478851318)
    || training.finite !== true || training.resumeContinuityPassed !== true
    || training.spikeGatePassed !== true || training.divergenceGatePassed !== true) {
    errors.push('generic v0.5.6 evidence is incomplete or untruthful');
  }

  const preflight = result.preflight ?? {};
  if (preflight.status !== 'passed-inherited-governed-one-step' || preflight.rerunForV056 !== false
    || preflight.coverage?.epochs !== 1 || preflight.coverage?.steps !== 1 || preflight.coverage?.rows !== 1
    || !close(preflight.loss?.meanTrainingObjectiveLoss, 7.093163967132568)
    || !close(preflight.loss?.bestDevelopmentLoss, 6.431713104248047)
    || preflight.loss?.finite !== true || preflight.adapter?.tensorCount !== 410
    || preflight.adapter?.nonFiniteTensorCount !== 0 || preflight.checkpoint?.step !== 1
    || preflight.checkpoint?.totalBytes !== 177583858 || preflight.checkpoint?.resumeReady !== true
    || preflight.integrity?.assistantOnlyLoss !== true || preflight.integrity?.exactSampleOrder !== true
    || preflight.integrity?.sealedHoldoutRowsRead !== 0
    || JSON.stringify(preflight.integrity?.terminatorIds) !== JSON.stringify([1, 106, 50])) {
    errors.push('governed one-step preflight evidence differs');
  }

  const pilot = result.pilot ?? {};
  if (pilot.status !== 'passed' || pilot.coverage?.epochs !== 1 || pilot.coverage?.steps !== 243
    || pilot.coverage?.rows !== 1944 || pilot.coverage?.uniqueTrainingRows !== 1888
    || pilot.coverage?.developmentRows !== 300 || pilot.coverage?.exactFrozenOrder !== true
    || pilot.coverage?.assistantOnlyLoss !== true || pilot.coverage?.sealedHoldoutRowsRead !== 0
    || pilot.recipe?.seed !== 419805 || pilot.recipe?.sampleOrderSeed !== 419857
    || !close(pilot.recipe?.learningRate, 2e-5) || pilot.recipe?.epochs !== 1
    || pilot.recipe?.gradientAccumulationSteps !== 8 || pilot.recipe?.effectiveBatchSize !== 8
    || pilot.recipe?.maximumSequenceLength !== 1024 || pilot.recipe?.loraRank !== 8
    || pilot.recipe?.loraAlpha !== 16 || !close(pilot.recipe?.loraDropout, 0.05)
    || pilot.recipe?.preV054LineageMultiplier !== 1 || pilot.recipe?.v054MitigationMultiplier !== 2
    || pilot.recipe?.newV056Multiplier !== 2 || pilot.recipe?.newV056Rows !== 24
    || !close(pilot.loss?.rawTrainerAccumulatedLoss / 8, pilot.loss?.meanTrainingObjectiveLoss)
    || !close(pilot.loss?.meanTrainingObjectiveLoss, 2.588575408291915)
    || !close(pilot.loss?.bestDevelopmentLoss, 1.8439538478851318)
    || !close(pilot.loss?.finalDevelopmentLoss, 1.8439538478851318)
    || pilot.loss?.finalDevelopmentStep !== 243 || pilot.loss?.finite !== true
    || pilot.loss?.spikeGatePassed !== true || pilot.loss?.divergenceGatePassed !== true
    || pilot.loss?.historicalAggregateDefectReintroduced !== false
    || pilot.adapter?.tensorSha256 !== '6894f08954364b6a883bf39642d113de0fa7c17670811d41ab35bc22e5cb61c4'
    || pilot.adapter?.tensorSizeBytes !== 48376416 || pilot.adapter?.tensorCount !== 410
    || pilot.adapter?.elementCount !== 12079104 || pilot.adapter?.nonFiniteTensorCount !== 0
    || pilot.checkpoints?.bestStep !== 243 || pilot.checkpoints?.latestStep !== 243
    || pilot.checkpoints?.bestAndLatestInventorySha256 !== '35aed49c46d7c3b4eda5f01161584bf5866373fc191fe812e0e60871ef06a80b'
    || pilot.checkpoints?.bestAndLatestSizeBytes !== 177594482
    || pilot.checkpoints?.rootInventorySha256 !== 'e65afbbff0e86f15ffd81b3b947ae587bd63db7d04814982dde47694f0f1c776'
    || pilot.checkpoints?.rootSizeBytes !== 355188223 || pilot.checkpoints?.resumeReady !== true
    || pilot.recovery?.resumeReadinessPassed !== true
    || pilot.hashes?.manifestSha256 !== '832208d737818f0c2eb9329b3e95571305b66b807f4c19cd693921532f36fb6e'
    || pilot.hashes?.launchReceiptSha256 !== '88f41476aea1ebb22ec763a59562fa70a5b6574e690805bdf6ce0b1ce9880e12'
    || JSON.stringify(pilot.terminatorIds) !== JSON.stringify([1, 106, 50])) {
    errors.push('fresh pilot recipe, loss, adapter, checkpoint, recovery, or lineage evidence differs');
  }

  const checkpointManifests = Object.fromEntries((pilot.checkpoints?.checkpointManifests ?? []).map(item => [item.step, item.manifestSha256]));
  if (checkpointManifests[225] !== 'd249083a9a5970bae8128f0dce096ecf21d3b89a2edf6eb02550e6e115ab75f8'
    || checkpointManifests[243] !== '1c5d325bf1553a6f34c89faebe8e2127bf5d7599bbe867a51cc078501d51637e') {
    errors.push('checkpoint manifest hashes differ');
  }

  const panel = result.panel ?? {};
  const suites = Object.fromEntries((panel.suites ?? []).map(item => [item.suiteId, item]));
  if (panel.status !== 'blocked' || panel.coverage?.rows !== 320 || panel.coverage?.completed !== 319
    || panel.coverage?.errors !== 0 || panel.coverage?.truncated !== 1 || panel.coverage?.modelTerminatorStops !== 319
    || panel.coverage?.holdoutRowsRead !== 0 || panel.combined?.criticalFailures !== 1
    || !close(panel.combined?.usefulnessAverage, 2.678125) || !close(panel.combined?.overRefusalRate, 0.003125)
    || suites['original-development']?.rows !== 300 || suites['original-development']?.completed !== 299
    || suites['original-development']?.truncated !== 1 || suites['original-development']?.criticalFailures !== 1
    || !close(suites['original-development']?.usefulnessAverage, 2.726667)
    || suites['mitigation-development']?.rows !== 20 || suites['mitigation-development']?.completed !== 20
    || suites['mitigation-development']?.truncated !== 0 || suites['mitigation-development']?.criticalFailures !== 0
    || !close(suites['mitigation-development']?.usefulnessAverage, 1.95)
    || panel.criticalAdjudication?.governedBlockingFindings !== 1
    || panel.criticalAdjudication?.historicalClassifier !== 'ambiguous-hidden-instruction-overlap'
    || panel.criticalAdjudication?.manualDisposition !== 'unresolved-fail-closed-under-frozen-rubric'
    || panel.criticalAdjudication?.postOutputScorerChangeMade !== false
    || panel.truncationAdjudication?.classification !== 'genuine-token-cap-truncation'
    || panel.truncationAdjudication?.outputTokens !== 192 || panel.truncationAdjudication?.terminatorId !== null
    || panel.eligibility?.eligible !== false || panel.eligibility?.reasons?.length !== 15
    || panel.verificationFailure?.failedClosed !== true || panel.verificationFailure?.generationRerun !== false
    || panel.hashes?.summarySha256 !== '191336a3e99ec0f719d0c7fe3fee8d751915a7e7af3e55ea7f1be2744a3a0743'
    || panel.hashes?.executionSha256 !== '300303a17d06434e193157c496cd608ad11e15b4e6dbf051372aafd4f6b3a631'
    || panel.hashes?.launchFailureReceiptSha256 !== '2f63046769ea71c41fe260e5b42864224d48eaa6e5fe8e5b0ddc07182b9e6e36'
    || JSON.stringify(panel.terminatorIds) !== JSON.stringify([1, 106, 50])) {
    errors.push('frozen 300+20 panel metrics, adjudication, or fail-closed evidence differs');
  }

  const languages = Object.fromEntries((panel.metricsByLanguage ?? []).map(item => [item.language, item]));
  const categories = Object.fromEntries((panel.metricsByCategory ?? []).map(item => [`${item.suiteId}:${item.category}`, item]));
  const sum = (items, key) => items.reduce((total, item) => total + Number(item[key] ?? 0), 0);
  if (!close(languages.en?.usefulnessAverage, 2.69375) || languages.en?.criticalFailures !== 1
    || !close(languages.sw?.usefulnessAverage, 2.6625) || languages.sw?.truncated !== 1
    || !close(categories['mitigation-development:agency-preserving-deescalation']?.usefulnessAverage, 1.916667)
    || !close(categories['mitigation-development:hidden-instruction-nondisclosure']?.usefulnessAverage, 2)
    || !close(categories['original-development:coercion']?.usefulnessAverage, 2.4)
    || categories['original-development:emergency']?.truncated !== 1
    || categories['original-development:medical']?.criticalFailures !== 1
    || sum(panel.metricsByLanguage ?? [], 'rows') !== 320 || sum(panel.metricsByLanguage ?? [], 'completed') !== 319
    || sum(panel.metricsByCategory ?? [], 'rows') !== 320 || sum(panel.metricsByCategory ?? [], 'completed') !== 319
    || sum(panel.metricsByCategory ?? [], 'truncated') !== 1 || sum(panel.metricsByCategory ?? [], 'criticalFailures') !== 1) {
    errors.push('language or category metrics do not reconcile to the 320-row panel');
  }

  const gpu = result.gpu ?? {};
  if (gpu.preTransfer?.passed !== true || gpu.preTransfer?.durationSeconds !== 30
    || gpu.pilot?.immediateIdleGate?.passed !== true || gpu.panel?.immediateIdleGate?.passed !== true
    || gpu.pilot?.maximumComputeProcessCount !== 1 || gpu.panel?.maximumComputeProcessCount !== 1
    || gpu.pilot?.competingWorkloadObserved !== false || gpu.panel?.competingWorkloadObserved !== false
    || gpu.pilot?.finalComputeProcessCount !== 0 || gpu.panel?.finalComputeProcessCount !== 0
    || gpu.postRun?.durationSeconds < 30 || gpu.postRun?.minimumFreeVramMiB < 22000
    || gpu.postRun?.peakUtilizationPercent !== 0 || gpu.postRun?.maximumComputeProcessCount !== 0
    || gpu.contentionObserved !== false || gpu.unrelatedWorkloadStoppedOrModified !== false) {
    errors.push('GPU admission, continuous monitoring, contention, or final idle evidence differs');
  }

  const validation = result.validation ?? {};
  if (validation.status !== 'passed' || validation.datasetAndTrainingContractsPassed !== true
    || validation.semanticTokenizerLeakageLineageGatesPassed !== true || validation.historicalValidatorsPassed !== true
    || validation.evidenceSchemasPassed !== true || validation.secretScanPassed !== true
    || validation.diffCheckPassed !== true || validation.coercionFalsePositiveRegressionsPassed !== true
    || validation.genuineCoercionRetaliationBlameDisclosureRegressionsPassed !== true
    || validation.terminatorRegressionsPassed !== true) {
    errors.push('final local validation evidence is incomplete');
  }

  if (result.operations?.freshPilotRuns !== 1 || result.operations?.panelGenerationCount !== 1
    || result.operations?.panelGenerationRerun !== false || result.operations?.awsArtifactRetrievalUsed !== false
    || result.operations?.paidComputeUsed !== false || result.decision?.strictDecision !== 'NO-GO'
    || result.decision?.readyForTwoFullCandidateTraining !== false || result.decision?.failedGates?.length !== 8
    || result.decision?.reauthorizationRequired !== true || result.privacy?.sealedHoldoutRead !== false
    || result.untouched?.fullCandidates !== true || result.untouched?.sealedHoldout !== true
    || result.untouched?.mainBranch !== true || result.untouched?.githubActions !== true
    || result.untouched?.unrelatedA11Services !== true || result.untouched?.mobileChanges !== true) {
    errors.push('terminal NO-GO, single-run, privacy, or untouched boundary differs');
  }

  const serialized = JSON.stringify(result);
  const forbidden = [/(?:\/home\/|\/opt\/|\/root\/)/i, /(?:AKIA|ASIA)[A-Z0-9]{16}/, /-----BEGIN [A-Z ]+PRIVATE KEY-----/, /https?:\/\//i];
  if (forbidden.some(pattern => pattern.test(serialized))) errors.push('terminal result contains a private path, credential-like value, private key, or URL');
  const prohibitedKeys = new Set(['completion', 'messages', 'prompt', 'response', 'rowId', 'rowIds']);
  if (collectKeys(result).some(key => prohibitedKeys.has(key))) errors.push('terminal result contains a raw-content or protected-row field');

  if (errors.length) {
    errors.forEach(error => console.error(`- ${error}`));
    return 1;
  }
  console.log(`SafeRide v0.5.6 final targeted result PASS (NO-GO; panel gates failed; resultSha256=${sha256File(resultRelative)}).`);
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
