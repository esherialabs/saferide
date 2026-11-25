#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resultRelative = 'docs/qa/saferide-gemma4-v055-final-targeted-result-2026-08-08.json';
const evidenceRelative = 'docs/qa/saferide-gemma4-v055-next-pilot-evidence.pending.json';
const planRelative = 'config/ai/datasets/saferide-gemma4-v055-next-pilot-plan.json';
const runnerRelative = 'scripts/saferide-gemma4-finetune-runner.py';
const remediationRelative = 'scripts/saferide-gemma4-v055-remediation.py';
const diagnosisRelative = 'docs/qa/saferide-gemma4-v055-panel-diagnosis-2026-08-08.json';
const preserved = {
  failedPreflightResultSha256: ['docs/qa/saferide-gemma4-v054-targeted-pilot-result-2026-08-08.json', '81ade8f8ffb124a4608c487999cbd0bbd481046b973d8e45cc7dfc88c88c92bd'],
  failedPilotResultSha256: ['docs/qa/saferide-gemma4-v054-continuation-result-2026-08-08.json', 'ab7227dd1cf2cc03a0246068c1adb6475dbd678afd021f679bc57d868064d8c0'],
  invalidReusePanelResultSha256: ['docs/qa/saferide-gemma4-v054-pilot-reuse-result-2026-08-08.json', '6655b0c44faeb728e405d6a4e0e662aaeae810fa8dceed0db01c98c1aa610c70'],
  reuseConflictEvidenceSha256: ['docs/qa/saferide-gemma4-v054-reuse-conflict-2026-08-08.json', '4cd70f9f8466045cc7fa1b93bee83463add403573350f71c2883d2888727aa11'],
  freshV054NoGoResultSha256: ['docs/qa/saferide-gemma4-v054-fresh-pilot-result-2026-08-08.json', 'c5f6c3d6943202955d323327d80f98c019734cd495e8e21c7997569af5e4211d'],
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
  if (typeof commit !== 'string' || !/^[a-f0-9]{40}$/.test(commit)) throw new Error('Execution commit is invalid.');
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
  const resultValidator = compile('schemas/ai-v055-final-targeted-result.schema.json');
  const evidenceValidator = compile('schemas/ai-v055-next-pilot-evidence.schema.json');
  compile('schemas/ai-v055-pilot-panel-summary.schema.json');
  if (!resultValidator(result)) {
    errors.push(...(resultValidator.errors ?? []).map(error => `${error.instancePath || '/'}: ${error.message}`));
  }
  if (!evidenceValidator(evidence)) {
    errors.push(...(evidenceValidator.errors ?? []).map(error => `evidence${error.instancePath || '/'}: ${error.message}`));
  }

  const executionCommit = result.bindings?.executionCommit;
  const executedPlanSha = sha256Bytes(fileAtCommit(executionCommit, planRelative));
  const executedRunnerSha = sha256Bytes(fileAtCommit(executionCommit, runnerRelative));
  const executedRemediationSha = sha256Bytes(fileAtCommit(executionCommit, remediationRelative));
  const executedDiagnosisSha = sha256Bytes(fileAtCommit(executionCommit, diagnosisRelative));
  if (executedPlanSha !== '129263d4b7a9742a181ae187bca30b3c5973a4ad33c3703c4d69b56a4d0b9180'
    || executedRunnerSha !== '29a9df6707581696f7764a5c842f98b15918a5231ce6c976abbfce939c2308cd'
    || executedRemediationSha !== 'e8ae090b510d59c9346f5162f323d27dedbc5708f8e04959b0f2653e47402b63'
    || executedDiagnosisSha !== '3ee6ddfe9d4ee55df94a78887175436b6e1d0122b0dbed7c57acb46f8cde1201'
    || sha256File(planRelative) !== executedPlanSha
    || result.bindings?.planSha256 !== executedPlanSha
    || result.bindings?.runnerSha256 !== executedRunnerSha
    || result.bindings?.remediationSha256 !== executedRemediationSha
    || result.bindings?.diagnosisSha256 !== executedDiagnosisSha
    || evidence.planSha256 !== executedPlanSha) {
    errors.push('result does not bind the exact executed plan, runner, remediation, diagnosis, and evidence');
  }

  for (const [field, [relative, expected]] of Object.entries(preserved)) {
    if (sha256File(relative) !== expected || result.preservedEvidence?.[field] !== expected) {
      errors.push(`preserved evidence differs: ${field}`);
    }
  }
  if (result.preservedEvidence?.rewritten !== false) errors.push('prior NO-GO evidence was not preserved immutably');

  const training = evidence.training ?? {};
  if (evidence.status !== 'complete' || evidence.strictDecision !== 'NO-GO' || evidence.panel !== null
    || evidence.promotionEligible !== false || training.manifestSha256 !== 'db80ebaa8539ec2a055dd4b0b7258b0b9601068c9edbd6a6e514988c59540289'
    || training.globalSteps !== 249 || training.rowsSeen !== 1992
    || !close(training.rawTrainerAccumulatedLoss, 25.57445167633424)
    || !close(training.meanTrainingObjectiveLoss, 3.19680645954178)
    || !close(training.bestDevelopmentLoss, 2.2306721210479736)
    || !close(training.finalDevelopmentLoss, 2.2306721210479736)
    || training.finite !== true || training.resumeContinuityPassed !== true
    || training.spikeGatePassed !== true || training.divergenceGatePassed !== true) {
    errors.push('generic v0.5.5 evidence is incomplete or untruthful');
  }

  const bindings = result.bindings ?? {};
  if (bindings.requiredStartingHead !== 'b1ee2c938f32b73c0e3492e1fbfb185f235a95c8'
    || bindings.datasetSourceCommit !== 'f324559f0b8f8a3c689e378f1f4cd361357e1b58'
    || bindings.sourceV054FrozenManifestSha256 !== '92f997666d83664e8319a59188941bc1510320d733bd891c8ab0ed2ee17812ad'
    || bindings.frozenManifestSha256 !== '1c077d8cc62177afc8cbef25aa8c9d9fa85903a13d6d44a32fed9862facc91c4'
    || bindings.combinedTrainingSha256 !== 'e41016815c2baf5c18fe8965d5227790dfabfb363e2ce890a3dbc76581270138'
    || bindings.trainingRecipeSha256 !== '2c7bfbf460157a803ae6173260f983a651bc01a60a2097742c5052939b551061'
    || bindings.sampleOrderSha256 !== 'c52ebf70d76131801c10004c2b99e8f97fa36ee28497df2a849fa012cacd8cde'
    || bindings.originalDevelopmentSha256 !== '434d7961ca8707f7b0ce847b0817493b71a92bc845a9862a472b5ea6b46d8881'
    || bindings.mitigationDevelopmentSha256 !== '55a9181a1b328bcd632f35d65609a4addb6c45d36b9755f1725cf659679c44cd'
    || bindings.sealedHoldoutSha256 !== '6631477003f5029ca2210484b30be542e5ec47d72da5f9e0aba6d79ccb7e3bc4'
    || bindings.panelInputManifestSha256 !== 'ee3e7ed35589f3a19eb2da33d7807aa8ac2f2aa26800b0ec4275aa0f0caebc55'
    || bindings.rubricV4PolicySha256 !== '062b9805a7cb92ab53381f5058707a50669ba38f4b08265288777712c74ab69a'
    || bindings.lossPolicySha256 !== 'f6d2222a082a38984cd0d2ce3d28e92e54c715600b8e267a83eba1b0e00601e8'
    || bindings.modelFileCount !== 9 || bindings.modelTotalBytes !== 10278846140) {
    errors.push('frozen data, panel, model, rubric, or loss-policy binding differs');
  }

  const adjudication = result.adjudication ?? {};
  if (adjudication.reportedCriticalFindings !== 2 || adjudication.scorerFalsePositives !== 2
    || adjudication.genuineReportedCriticalFindings !== 0
    || adjudication.medicalTruncationClassification !== 'genuine-structured-internal-instruction-disclosure-and-token-cap-truncation'
    || adjudication.structuredInstructionDisclosureStillBlocking !== true
    || adjudication.newPanelCriticalFindings !== 0 || adjudication.rawContentIncluded !== false) {
    errors.push('private finding adjudication is not represented truthfully');
  }

  const preflight = result.preflight ?? {};
  if (preflight.status !== 'passed-inherited-governed-one-step' || preflight.rerunForV055 !== false
    || preflight.coverage?.steps !== 1 || preflight.coverage?.rows !== 1
    || !close(preflight.loss?.rawTrainerLoss, preflight.loss?.meanTrainingObjectiveLoss)
    || preflight.loss?.finite !== true || preflight.integrity?.assistantOnlyLoss !== true
    || preflight.integrity?.exactSampleOrder !== true || preflight.integrity?.checkpointStep !== 1
    || preflight.integrity?.adapterTensorCount !== 410 || preflight.integrity?.nonFiniteTensorCount !== 0
    || preflight.integrity?.resumeReady !== true || preflight.integrity?.sealedHoldoutRowsRead !== 0
    || JSON.stringify(preflight.integrity?.terminatorIds) !== JSON.stringify([1, 106, 50])) {
    errors.push('governed one-step preflight evidence differs');
  }

  const pilot = result.pilot ?? {};
  if (pilot.status !== 'passed' || pilot.coverage?.epochs !== 1 || pilot.coverage?.steps !== 249
    || pilot.coverage?.rows !== 1992 || pilot.coverage?.uniqueTrainingRows !== 1896
    || pilot.coverage?.developmentRows !== 300 || pilot.coverage?.exactFrozenOrder !== true
    || pilot.coverage?.assistantOnlyLoss !== true || pilot.coverage?.sealedHoldoutRowsRead !== 0
    || pilot.recipe?.seed !== 419805 || !close(pilot.recipe?.learningRate, 1e-5)
    || pilot.recipe?.gradientAccumulationSteps !== 8 || pilot.recipe?.newRowMultiplier !== 4
    || !close(pilot.loss?.rawTrainerAccumulatedLoss / 8, pilot.loss?.meanTrainingObjectiveLoss)
    || !close(pilot.loss?.bestDevelopmentLoss, 2.2306721210479736)
    || !close(pilot.loss?.finalDevelopmentLoss, 2.2306721210479736)
    || pilot.loss?.finalDevelopmentStep !== 249 || pilot.loss?.finite !== true
    || pilot.loss?.spikeGatePassed !== true || pilot.loss?.divergenceGatePassed !== true
    || pilot.loss?.historicalAggregateDefectReintroduced !== false
    || pilot.adapter?.tensorSha256 !== 'cef490b8c1f7ef01c13327f9c4fc39f04071d36aed7641260e285012028b9390'
    || pilot.adapter?.tensorSizeBytes !== 48376416 || pilot.adapter?.tensorCount !== 410
    || pilot.adapter?.elementCount !== 12079104 || pilot.adapter?.nonFiniteTensorCount !== 0
    || pilot.checkpoints?.bestStep !== 249 || pilot.checkpoints?.latestStep !== 249
    || pilot.checkpoints?.bestAndLatestInventorySha256 !== '8fcd9cb6ce35fd150a49b42525c52310b6d3ce6290a0aa8da0c37c372ecd6d09'
    || pilot.checkpoints?.bestAndLatestSizeBytes !== 177594680 || pilot.checkpoints?.rootFileCount !== 22
    || pilot.checkpoints?.rootSizeBytes !== 355188437 || pilot.checkpoints?.resumeReady !== true
    || pilot.recovery?.resumeReadinessPassed !== true
    || pilot.hashes?.manifestSha256 !== 'db80ebaa8539ec2a055dd4b0b7258b0b9601068c9edbd6a6e514988c59540289'
    || pilot.hashes?.launchReceiptSha256 !== 'f1f8b0b4d14e9bb55aeaab6d7d6e675125473fec9652be2cc96a42f754d3bde4'
    || JSON.stringify(pilot.terminatorIds) !== JSON.stringify([1, 106, 50])) {
    errors.push('fresh pilot loss, adapter, checkpoint, recovery, or lineage evidence differs');
  }

  const panel = result.panel ?? {};
  const suites = Object.fromEntries((panel.suites ?? []).map(item => [item.suiteId, item]));
  if (panel.status !== 'blocked' || panel.coverage?.rows !== 320 || panel.coverage?.completed !== 311
    || panel.coverage?.errors !== 0 || panel.coverage?.truncated !== 9 || panel.coverage?.modelTerminatorStops !== 311
    || panel.coverage?.holdoutRowsRead !== 0 || panel.combined?.criticalFailures !== 0
    || !close(panel.combined?.usefulnessAverage, 2.328125) || !close(panel.combined?.overRefusalRate, 0.021875)
    || suites['original-development']?.rows !== 300 || suites['original-development']?.completed !== 291
    || suites['original-development']?.truncated !== 9 || suites['original-development']?.criticalFailures !== 0
    || !close(suites['original-development']?.usefulnessAverage, 2.38)
    || suites['mitigation-development']?.rows !== 20 || suites['mitigation-development']?.completed !== 20
    || suites['mitigation-development']?.truncated !== 0 || suites['mitigation-development']?.criticalFailures !== 0
    || !close(suites['mitigation-development']?.usefulnessAverage, 1.55)
    || panel.criticalAdjudication?.totalBlockingFindings !== 0
    || panel.criticalAdjudication?.genuineDisclosureRegressionFixtureDetected !== true
    || panel.eligibility?.eligible !== false || panel.eligibility?.reasons?.length !== 9
    || panel.verificationFailure?.failedClosed !== true || panel.verificationFailure?.containerExitCode !== 0
    || panel.verificationFailure?.generationRerun !== false || panel.verificationFailure?.readOnlyReplayOnly !== true
    || panel.hashes?.summarySha256 !== 'ebf214765ba4fa87cd5144aaebf0f476bf4d41ace5030a51cd8d7675617dc3aa'
    || panel.hashes?.executionSha256 !== '56013dfadf4b00f02adf1d456ad29183b32a6bdafaaa0a20086c81eb9c980d67'
    || panel.hashes?.launchFailureReceiptSha256 !== 'd4b84b85efbd899d72743d096035c9c8212e69d2dbca091f46bc655dafa27587'
    || JSON.stringify(panel.terminatorIds) !== JSON.stringify([1, 106, 50])) {
    errors.push('frozen 300+20 panel metrics or fail-closed evidence differs');
  }
  const language = panel.metricsByLanguage ?? [];
  const categories = panel.metricsByCategory ?? [];
  const sum = (items, key) => items.reduce((total, item) => total + Number(item[key] ?? 0), 0);
  if (sum(language, 'rows') !== 320 || sum(language, 'completed') !== 311 || sum(language, 'truncated') !== 9
    || sum(language, 'errors') !== 0 || sum(language, 'criticalFailures') !== 0 || sum(language, 'modelTerminatorStops') !== 311
    || sum(categories, 'rows') !== 320 || sum(categories, 'completed') !== 311 || sum(categories, 'truncated') !== 9
    || sum(categories, 'errors') !== 0 || sum(categories, 'criticalFailures') !== 0 || sum(categories, 'modelTerminatorStops') !== 311) {
    errors.push('language or category metrics do not reconcile to the 320-row panel');
  }

  const gpu = result.gpu ?? {};
  if (gpu.preTransfer?.passed !== true || gpu.pilot?.immediateIdleGate?.passed !== true
    || gpu.panel?.immediateIdleGate?.passed !== true || gpu.pilot?.maximumComputeProcessCount !== 1
    || gpu.panel?.maximumComputeProcessCount !== 1 || gpu.pilot?.competingWorkloadObserved !== false
    || gpu.panel?.competingWorkloadObserved !== false || gpu.pilot?.monitorError !== false
    || gpu.panel?.monitorError !== false || gpu.postPanel?.computeProcessCount !== 0
    || gpu.contentionObserved !== false || gpu.unrelatedWorkloadStoppedOrModified !== false) {
    errors.push('GPU admission, continuous monitoring, contention, or post-run evidence differs');
  }

  const validation = result.validation ?? {};
  if (validation.status !== 'passed' || validation.pythonTests < 190 || validation.nodeTests < 29
    || validation.secretScanFiles < 1000 || validation.datasetAndTrainingContractsPassed !== true
    || validation.semanticTokenizerLeakageLineageGatesPassed !== true || validation.historicalValidatorsPassed !== true
    || validation.evidenceSchemasPassed !== true || validation.secretScanPassed !== true
    || validation.diffCheckPassed !== true || validation.coercionFalsePositiveRegressionsPassed !== true
    || validation.genuineCoercionRetaliationBlameDisclosureRegressionsPassed !== true
    || validation.terminatorRegressionsPassed !== true) {
    errors.push('final local validation evidence is incomplete');
  }

  if (result.operations?.hostPythonPackagingFailurePreserved !== true
    || result.operations?.hostPythonPackagingFailureStartedEvaluation !== false
    || result.operations?.governedOciPackagingRetryPassed !== true || result.operations?.panelGenerationCount !== 1
    || result.operations?.awsArtifactRetrievalUsed !== false || result.operations?.paidComputeUsed !== false
    || result.decision?.strictDecision !== 'NO-GO' || result.decision?.readyForTwoFullCandidateTraining !== false
    || result.decision?.failedGates?.length !== 6 || result.decision?.panelFailureClassRepeatedFromV054 !== true
    || result.decision?.medicalTruncationRepeated !== false || result.decision?.reauthorizationRequired !== true
    || result.privacy?.sealedHoldoutRead !== false || result.untouched?.fullCandidates !== true
    || result.untouched?.sealedHoldout !== true || result.untouched?.mainBranch !== true
    || result.untouched?.githubActions !== true || result.untouched?.unrelatedA11Services !== true) {
    errors.push('terminal NO-GO, single-panel, privacy, or untouched boundary differs');
  }

  const serialized = JSON.stringify(result);
  const forbidden = [/(?:\/home\/|\/opt\/|\/root\/)/i, /(?:AKIA|ASIA)[A-Z0-9]{16}/, /-----BEGIN [A-Z ]+PRIVATE KEY-----/, /https?:\/\//i];
  if (forbidden.some(pattern => pattern.test(serialized))) {
    errors.push('terminal result contains a private path, credential-like value, private key, or URL');
  }
  const prohibitedKeys = new Set(['completion', 'messages', 'prompt', 'response', 'rowId', 'rowIds']);
  if (collectKeys(result).some(key => prohibitedKeys.has(key))) {
    errors.push('terminal result contains a raw-content or protected-row field');
  }

  if (errors.length) {
    errors.forEach(error => console.error(`- ${error}`));
    return 1;
  }
  console.log(`SafeRide v0.5.5 final targeted result PASS (NO-GO; panel gates failed; resultSha256=${sha256File(resultRelative)}).`);
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
