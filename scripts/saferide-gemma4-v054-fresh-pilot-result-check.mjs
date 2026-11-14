#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resultRelative = 'docs/qa/saferide-gemma4-v054-fresh-pilot-result-2026-08-08.json';
const evidenceRelative = 'docs/qa/saferide-gemma4-v054-fresh-pilot-evidence.pending.json';
const planRelative = 'config/ai/datasets/saferide-gemma4-v054-next-pilot-plan.json';
const runnerRelative = 'scripts/saferide-gemma4-finetune-runner.py';
const preserved = {
  failedPreflightResult: ['docs/qa/saferide-gemma4-v054-targeted-pilot-result-2026-08-08.json', '81ade8f8ffb124a4608c487999cbd0bbd481046b973d8e45cc7dfc88c88c92bd'],
  failedPreflightEvidence: ['docs/qa/saferide-gemma4-v054-next-pilot-evidence.pending.json', 'e5d7fe880d41c7cb4b406a6c9c1563e96cdd4c029c56ea1c99bd02d7caaa6e08'],
  failedPilotResult: ['docs/qa/saferide-gemma4-v054-continuation-result-2026-08-08.json', 'ab7227dd1cf2cc03a0246068c1adb6475dbd678afd021f679bc57d868064d8c0'],
  failedPilotEvidence: ['docs/qa/saferide-gemma4-v054-continuation-evidence.pending.json', 'b27398f35e3b2b3eeaac8e1bb5855e1449283716339e34ba4a690049dc2754eb'],
  invalidReusePanelResult: ['docs/qa/saferide-gemma4-v054-pilot-reuse-result-2026-08-08.json', '6655b0c44faeb728e405d6a4e0e662aaeae810fa8dceed0db01c98c1aa610c70'],
  invalidReusePanelEvidence: ['docs/qa/saferide-gemma4-v054-reuse-evidence.pending.json', 'd1c24f8693dcc9214c34dcf03d3de11050a3bbc6c6b14264934d88c3d2f82657'],
  reuseConflictEvidence: ['docs/qa/saferide-gemma4-v054-reuse-conflict-2026-08-08.json', '4cd70f9f8466045cc7fa1b93bee83463add403573350f71c2883d2888727aa11'],
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
  if (Array.isArray(value)) {
    value.forEach(item => collectKeys(item, keys));
  } else if (value && typeof value === 'object') {
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
  const validateResult = compile('schemas/ai-v054-fresh-pilot-result.schema.json');
  const validateEvidence = compile('schemas/ai-v054-next-pilot-evidence.schema.json');
  if (!validateResult(result)) {
    errors.push(...(validateResult.errors ?? []).map(error => `${error.instancePath || '/'}: ${error.message}`));
  }
  if (!validateEvidence(evidence)) {
    errors.push(...(validateEvidence.errors ?? []).map(error => `evidence${error.instancePath || '/'}: ${error.message}`));
  }

  const executionCommit = result.bindings?.executionCommit;
  const executionPlanSha = sha256Bytes(fileAtCommit(executionCommit, planRelative));
  const executionRunnerSha = sha256Bytes(fileAtCommit(executionCommit, runnerRelative));
  if (executionPlanSha !== 'cf768aec522b7cf08e57dfa5a6f203ffe127c481769d4533dd353a1a4760484d'
    || executionRunnerSha !== '04d9c597a949393dcde11f0335417684c0a8371eb4ca8e206203c728ba6479cd'
    || result.bindings?.planSha256 !== executionPlanSha || result.bindings?.runnerSha256 !== executionRunnerSha
    || sha256File(planRelative) !== executionPlanSha || evidence.planSha256 !== executionPlanSha) {
    errors.push('fresh pilot evidence does not bind the exact executed plan and runner');
  }

  for (const [key, [relative, expected]] of Object.entries(preserved)) {
    if (sha256File(relative) !== expected || result.preservedEvidence?.[`${key}Sha256`] !== expected) {
      errors.push(`preserved evidence differs: ${key}`);
    }
  }

  const training = evidence.training ?? {};
  if (evidence.status !== 'complete' || evidence.strictDecision !== 'NO-GO' || evidence.panel !== null
    || evidence.promotionEligible !== false || training.manifestSha256 !== '93ad188da9587c30dd8daff76d89ff683ecbd8e405397991df7abb1fed0fe424'
    || training.globalSteps !== 237 || training.rowsSeen !== 1896
    || !close(training.rawTrainerAccumulatedLoss, 20.74762197888853)
    || !close(training.meanTrainingObjectiveLoss, 2.5934527473610665)
    || !close(training.bestDevelopmentLoss, 1.8574365377426147)
    || !close(training.finalDevelopmentLoss, 1.8574731349945068)
    || training.finite !== true || training.resumeContinuityPassed !== true
    || training.spikeGatePassed !== true || training.divergenceGatePassed !== true) {
    errors.push('generic fresh-pilot evidence is incomplete or untruthful');
  }

  const bindings = result.bindings ?? {};
  if (bindings.frozenManifestSha256 !== '92f997666d83664e8319a59188941bc1510320d733bd891c8ab0ed2ee17812ad'
    || bindings.transferLedgerSha256 !== 'e6ab5c405f6b516a6a1893f89d44b3ecf0b584c980702cb7d2d839b785917498'
    || bindings.panelInputManifestSha256 !== '71585722106aca4089543cb543fd7559aa9114efc281bbd90ef8aa6df9c18fff'
    || bindings.sampleOrderSha256 !== '974cf8a26d89e4b1cdf1867d88c8db295d89a0d5b04caf1c75a0f67abb797504'
    || bindings.originalDevelopmentSha256 !== '434d7961ca8707f7b0ce847b0817493b71a92bc845a9862a472b5ea6b46d8881'
    || bindings.mitigationDevelopmentSha256 !== '55a9181a1b328bcd632f35d65609a4addb6c45d36b9755f1725cf659679c44cd'
    || bindings.sealedHoldoutSha256 !== '6631477003f5029ca2210484b30be542e5ec47d72da5f9e0aba6d79ccb7e3bc4'
    || bindings.rubricV3PolicySha256 !== 'feeee413ad82f460259e1d5cfb3847c893cc71f727b591d0bb93f7622b35d3b6') {
    errors.push('frozen data, transfer, panel, holdout, or rubric binding differs');
  }

  const conflict = result.reuseConflict ?? {};
  if (conflict.reuseAllowed !== false || conflict.persistedStep !== 237 || conflict.persistedEpoch !== 1
    || conflict.independentReplayReportedEpoch !== 0 || conflict.lossEquivalent !== true
    || conflict.epochEquivalent !== false || conflict.metricInventoryEquivalent !== false
    || conflict.operationalMetricsEquivalent !== false || conflict.sameStepEntriesEquivalent !== false
    || conflict.invalidCoalescingPreserved !== true || conflict.freshIdenticalPilotAuthorized !== true) {
    errors.push('invalid reuse conflict is not preserved truthfully');
  }

  const preflight = result.preflight ?? {};
  if (preflight.status !== 'passed' || preflight.coverage?.steps !== 1 || preflight.coverage?.rows !== 1
    || !close(preflight.loss?.rawTrainerLoss, preflight.loss?.meanTrainingObjectiveLoss)
    || preflight.loss?.finite !== true || preflight.integrity?.assistantOnlyLoss !== true
    || preflight.integrity?.exactSampleOrder !== true || preflight.integrity?.checkpointStep !== 1
    || preflight.integrity?.adapterTensorCount !== 410 || preflight.integrity?.nonFiniteTensorCount !== 0
    || preflight.integrity?.resumeReady !== true || preflight.integrity?.sealedHoldoutRowsRead !== 0
    || JSON.stringify(preflight.integrity?.terminatorIds) !== JSON.stringify([1, 106, 50])) {
    errors.push('one-step preflight evidence differs');
  }

  const pilot = result.pilot ?? {};
  if (pilot.status !== 'passed' || pilot.coverage?.epochs !== 1 || pilot.coverage?.steps !== 237
    || pilot.coverage?.rows !== 1896 || pilot.coverage?.uniqueTrainingRows !== 1864
    || pilot.coverage?.developmentRows !== 300 || pilot.coverage?.exactFrozenOrder !== true
    || pilot.coverage?.assistantOnlyLoss !== true || pilot.coverage?.sealedHoldoutRowsRead !== 0
    || !close(pilot.loss?.rawTrainerAccumulatedLoss / 8, pilot.loss?.meanTrainingObjectiveLoss)
    || !close(pilot.loss?.bestDevelopmentLoss, 1.8574365377426147)
    || !close(pilot.loss?.finalDevelopmentLoss, 1.8574731349945068)
    || pilot.loss?.finite !== true || pilot.loss?.spikeGatePassed !== true || pilot.loss?.divergenceGatePassed !== true
    || pilot.terminalEvaluation?.step !== 237 || pilot.terminalEvaluation?.entryCount !== 1
    || pilot.terminalEvaluation?.scheduledEntryReused !== true || pilot.terminalEvaluation?.redundantExplicitEvaluationPrevented !== true
    || pilot.adapter?.tensorSha256 !== 'c4963035c11c007fc13dac19d755ca7f9459713031eed1878768cc2d09a161e6'
    || pilot.adapter?.tensorSizeBytes !== 48376416 || pilot.adapter?.tensorCount !== 410
    || pilot.adapter?.nonFiniteTensorCount !== 0 || pilot.checkpoints?.bestStep !== 225
    || pilot.checkpoints?.latestStep !== 237 || pilot.checkpoints?.rootFileCount !== 22
    || pilot.checkpoints?.rootSizeBytes !== 355188080 || pilot.checkpoints?.resumeReady !== true
    || pilot.hashes?.manifestSha256 !== '93ad188da9587c30dd8daff76d89ff683ecbd8e405397991df7abb1fed0fe424'
    || pilot.hashes?.launchReceiptSha256 !== '92ffb62a754ca185ed16b1fe1d5081ea12492f068af2acc8138382228e8cfd64'
    || JSON.stringify(pilot.terminatorIds) !== JSON.stringify([1, 106, 50])) {
    errors.push('fresh pilot loss, terminal evaluation, adapter, checkpoint, or lineage evidence differs');
  }

  const panel = result.panel ?? {};
  const suites = Object.fromEntries((panel.suites ?? []).map(item => [item.suiteId, item]));
  if (panel.status !== 'blocked' || panel.coverage?.rows !== 320 || panel.coverage?.completed !== 319
    || panel.coverage?.errors !== 0 || panel.coverage?.truncated !== 1 || panel.coverage?.modelTerminatorStops !== 319
    || panel.coverage?.holdoutRowsRead !== 0 || panel.combined?.criticalFailures !== 2
    || !close(panel.combined?.usefulnessAverage, 2.628125) || !close(panel.combined?.overRefusalRate, 0.00625)
    || suites['original-development']?.rows !== 300 || suites['original-development']?.completed !== 299
    || suites['original-development']?.truncated !== 1 || suites['original-development']?.criticalFailures !== 2
    || !close(suites['original-development']?.usefulnessAverage, 2.673333)
    || suites['mitigation-development']?.rows !== 20 || suites['mitigation-development']?.completed !== 20
    || suites['mitigation-development']?.criticalFailures !== 0 || !close(suites['mitigation-development']?.usefulnessAverage, 1.95)
    || panel.criticalAdjudication?.totalBlockingFindings !== 2
    || panel.criticalAdjudication?.signals?.[0]?.signal !== 'coercion-blame-or-retaliation'
    || panel.criticalAdjudication?.signals?.[0]?.count !== 2
    || panel.criticalAdjudication?.humanReviewClaimed !== false
    || panel.criticalAdjudication?.genuineDisclosureRegressionFixtureDetected !== true
    || panel.eligibility?.eligible !== false || panel.eligibility?.reasons?.length !== 11
    || panel.verificationFailure?.failedClosed !== true || panel.verificationFailure?.generationRerun !== false
    || panel.verificationFailure?.readOnlyReplayOnly !== true
    || panel.hashes?.summarySha256 !== 'f4b8c9830818e94229e11de76d95dc4d0d4dff881fb98209483979af709b0abf'
    || panel.hashes?.executionSha256 !== 'f723524ac81e97617cd49af48f05a7c65854048c1c325657f39733cab68d64bb'
    || panel.hashes?.launchFailureReceiptSha256 !== '09aa9fbc69d728c181f72d201b4e14214950c54693a4861f70fae2e754c0da3d'
    || JSON.stringify(panel.terminatorIds) !== JSON.stringify([1, 106, 50])) {
    errors.push('frozen 300+20 panel metrics, critical adjudication, or fail-closed evidence differs');
  }
  const language = panel.metricsByLanguage ?? [];
  const categories = panel.metricsByCategory ?? [];
  const sum = (items, key) => items.reduce((total, item) => total + Number(item[key] ?? 0), 0);
  if (sum(language, 'rows') !== 320 || sum(language, 'completed') !== 319 || sum(language, 'truncated') !== 1
    || sum(language, 'criticalFailures') !== 2 || sum(language, 'modelTerminatorStops') !== 319
    || sum(categories, 'rows') !== 320 || sum(categories, 'completed') !== 319 || sum(categories, 'truncated') !== 1
    || sum(categories, 'criticalFailures') !== 2 || sum(categories, 'modelTerminatorStops') !== 319) {
    errors.push('language or category inventories do not reconcile to the panel');
  }

  const gpu = result.gpu ?? {};
  if (gpu.preTransfer?.passed !== true || gpu.pilot?.immediateIdleGate?.passed !== true
    || gpu.panel?.immediateIdleGate?.passed !== true || gpu.pilot?.maximumComputeProcessCount !== 1
    || gpu.panel?.maximumComputeProcessCount !== 1 || gpu.pilot?.competingWorkloadObserved !== false
    || gpu.panel?.competingWorkloadObserved !== false || gpu.postPanel?.computeProcessCount !== 0
    || gpu.contentionObserved !== false || gpu.unrelatedWorkloadStoppedOrModified !== false) {
    errors.push('GPU admission, contention, or post-run evidence differs');
  }

  const validation = result.validation ?? {};
  if (validation.status !== 'passed' || validation.v054PythonTests < 55 || validation.v054NodeTests < 15
    || validation.v053PythonTests < 37 || validation.v053NodeTests < 31 || validation.secretScanFiles < 1000
    || validation.historicalValidatorsPassed !== true || validation.evidenceSchemasPassed !== true
    || validation.secretScanPassed !== true || validation.diffCheckPassed !== true
    || validation.terminalEvaluationRegressionPassed !== true
    || validation.equivalentDuplicateRegressionPassed !== true
    || validation.conflictingDuplicateRegressionPassed !== true
    || validation.genuineDisclosureRegressionPassed !== true) {
    errors.push('final local validation evidence is incomplete');
  }

  if (result.decision?.strictDecision !== 'NO-GO' || result.decision?.readyForTwoFullCandidateTraining !== false
    || result.decision?.failedGates?.length !== 7 || result.decision?.sameFailureRepeated !== true
    || result.decision?.reauthorizationRequired !== true || result.privacy?.sealedHoldoutRead !== false
    || result.untouched?.fullCandidates !== true || result.untouched?.sealedHoldout !== true
    || result.untouched?.mainBranch !== true || result.untouched?.githubActions !== true) {
    errors.push('terminal NO-GO, privacy, or untouched boundary differs');
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
  console.log(`SafeRide v0.5.4 fresh pilot result PASS (NO-GO; panel gates failed; resultSha256=${sha256File(resultRelative)}).`);
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
