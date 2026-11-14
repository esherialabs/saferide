#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resultRelative = 'docs/qa/saferide-gemma4-v057-final-targeted-result-2026-08-09.json';
const handoffRelative = 'docs/qa/saferide-gemma4-v057-final-targeted-result-2026-08-09.md';
const planRelative = 'config/ai/datasets/saferide-gemma4-v057-next-pilot-plan.json';
const executionCommit = '83d66a8af1de5a5d90eb2e94813449dd955af2c1';
const sourceCommit = 'c2d8afc6f392b90c81ebbbef3856406ccc299902';
const historicalResultSha256 = '1afa5ddf1de5153f8431119ca231bec86ed90152e30c455abbf36a668f1e3c90';
const historicalHandoffSha256 = '4cc1ee27de5f8e15c15041ee78f3888e28c9bdd157a382f22f5676c703e13d31';

const expectedBindings = {
  startingHead: 'cad44291d6c08fc605e9d0b94956177e60b8206b',
  datasetSourceCommit: sourceCommit,
  executionCommit,
  planSha256: '0f612981c8b146e0058a49df7d29c269c0c4341b481b8275fb2dd25a78052edc',
  mitigationPlanSha256: 'c25c9324bdaea400e0d5a72974ebc938c1d3552ab4aceea9f1081330d325eb80',
  adjudicationSha256: 'ccad955cc6654a003eedcb554faa15b1b872087fa30878bbcae59a4ba73770bd',
  frozenDatasetBuilderSha256: '31ac8dc0e1d97f89afaf48a7597c068cd8c88840bc767a8abed989b6680d7a9a',
  remediationSha256: 'd9b5d94949416a55abc2868b7fb2966ef9f0db778a2eb4d99c4c9c09a8704321',
  runnerSha256: '4c1687aaa4bb902eeb93fd5887b3c6d921fd7994e30f258e67ec19b2c5bc3ed3',
  panelSha256: '5d3411afe305e69d612bc3411ecdfcd5b52accfed6b63722bea31d7e01ce0485',
  launcherSha256: '6a4f7d620b8be862a5516e6364078685b32daedcbc276169c82f04214cb55d94',
  frozenManifestSha256: 'f16c071a0bad06f5b425db9e2feb899c958497fcc0d0e7a59b02316e60a8e6d5',
  weightedTrainingSha256: '795a11581895487825067c6d518d636e9091f768d285dd99f6cd49d1af170766',
  uniqueTrainingSha256: '8e9dd7892bcacfc636282d3bfd2fe7e222216f9daa443ee21ce5e268b776edb1',
  newMitigationTrainingSha256: '9dd1b91a5cb14c06cb52e1418dfd71f0da3aeb86108d0266d1265194a307b3c5',
  trainingRecipeSha256: '27fc238c2086f75b0159dd599c9ddcea9aafa87db4a45b91c4c13459bc7f32f3',
  sampleOrderSha256: 'c902922f16eb37cfed5e897a5922b08e3cfa973db27fb745ca752a26a0fbc76c',
  initialAdapterTensorSha256: '6894f08954364b6a883bf39642d113de0fa7c17670811d41ab35bc22e5cb61c4',
  initialAdapterInventorySha256: '7f5715a366c323bbf6da67f8e1ed5c219d697af83ab3a126c52b1366561656f1',
  initialAdapterInventoryFileCount: 6,
  initialAdapterInventorySizeBytes: 80584074,
  originalDevelopmentSha256: '434d7961ca8707f7b0ce847b0817493b71a92bc845a9862a472b5ea6b46d8881',
  mitigationDevelopmentSha256: '55a9181a1b328bcd632f35d65609a4addb6c45d36b9755f1725cf659679c44cd',
  sealedHoldoutSha256: '6631477003f5029ca2210484b30be542e5ec47d72da5f9e0aba6d79ccb7e3bc4',
  modelRevision: '70af34e20bd4b7a91f0de6b22675850c43922a03',
  modelTensorSha256: '2db5482b20d746879bb3ef79b5203e9075a2e2b98f54ec7c2f281c1477ddc550',
  runtimeArchiveSha256: 'a3ed2f36eb4fcf3bf52f6759dbf80c65643d1b0cd6844fa927f281053f992adf',
  runtimeManifestDigest: 'ec30ecf55a9231d2ef9f87148ac967654f3880ebe6405164078151d157da77ca',
  runtimeConfigDigest: '7ea597c35a61e55823c554deb3821fdb50dfb68695ae712f46931a05ecb34a87',
  codeInventorySha256: '2809c811fd7641f26fd1b0ddb936e74469fed8553f2e563d162aca30896ed9db',
  codeInventoryFileCount: 31,
  codeInventorySizeBytes: 813959,
};

const preserved = {
  v054ResultSha256: ['docs/qa/saferide-gemma4-v054-fresh-pilot-result-2026-08-08.json', 'c5f6c3d6943202955d323327d80f98c019734cd495e8e21c7997569af5e4211d'],
  v055ResultSha256: ['docs/qa/saferide-gemma4-v055-final-targeted-result-2026-08-08.json', 'e667553a2d2664e33ff94d2906cafd26b338bece14459084a72ad4a52e9e84f0'],
  v056ResultSha256: ['docs/qa/saferide-gemma4-v056-final-targeted-result-2026-08-09.json', 'c55bf04bca6f614030aa09eaa36a31d7dd4a3f9152c1fb0341c212380cdf4ba3'],
};

const absolute = relative => path.join(repoRoot, relative);
const readBytes = relative => fs.readFileSync(absolute(relative));
const readJson = relative => JSON.parse(readBytes(relative).toString('utf8'));
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const sha256File = relative => sha256(readBytes(relative));
const fileAtCommit = (commit, relative) => execFileSync('git', ['show', `${commit}:${relative}`], { cwd: repoRoot, encoding: null, maxBuffer: 4 * 1024 * 1024 });
const close = (left, right, tolerance = 1e-9) => Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= tolerance;

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
  const errors = [];
  if (sha256File(resultRelative) !== historicalResultSha256 || sha256File(handoffRelative) !== historicalHandoffSha256) {
    errors.push('historical v0.5.7 failure evidence was rewritten');
  }
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, strictTypes: false, validateFormats: false });
  const validator = ajv.compile(readJson('schemas/ai-v057-final-targeted-result.schema.json'));
  if (!validator(result)) errors.push(...(validator.errors ?? []).map(error => `${error.instancePath || '/'}: ${error.message}`));

  for (const [field, expected] of Object.entries(expectedBindings)) {
    if (result.bindings?.[field] !== expected) errors.push(`binding differs: ${field}`);
  }
  const executed = {
    [planRelative]: expectedBindings.planSha256,
    'scripts/saferide-gemma4-v057-finetune-runner.py': expectedBindings.runnerSha256,
    'scripts/saferide-gemma4-v057-pilot-panel.py': expectedBindings.panelSha256,
    'scripts/saferide-gemma4-v057-gpu-launcher.py': expectedBindings.launcherSha256,
    'scripts/saferide-gemma4-v057-remediation.py': expectedBindings.remediationSha256,
  };
  for (const [relative, expected] of Object.entries(executed)) {
    if (sha256(fileAtCommit(executionCommit, relative)) !== expected) {
      errors.push(`historical executed file binding differs: ${relative}`);
    }
  }
  const source = {
    'scripts/saferide-gemma4-v057-dataset.py': expectedBindings.frozenDatasetBuilderSha256,
    'config/ai/datasets/saferide-gemma4-v057-mitigation-plan.json': expectedBindings.mitigationPlanSha256,
    'docs/qa/saferide-gemma4-v057-private-adjudication-2026-08-09.json': expectedBindings.adjudicationSha256,
  };
  for (const [relative, expected] of Object.entries(source)) {
    if (sha256(fileAtCommit(sourceCommit, relative)) !== expected || sha256File(relative) !== expected) {
      errors.push(`frozen source binding differs: ${relative}`);
    }
  }
  for (const [field, [relative, expected]] of Object.entries(preserved)) {
    if (sha256File(relative) !== expected || result.preservedEvidence?.[field] !== expected) errors.push(`preserved evidence differs: ${field}`);
  }
  if (result.preservedEvidence?.rewritten !== false) errors.push('historical NO-GO evidence was rewritten');

  const pilot = result.pilot ?? {};
  if (result.status !== 'no-go-pilot-failed' || pilot.status !== 'blocked' || pilot.valid !== false
    || pilot.attempt !== 1 || pilot.retryAllowed !== false || pilot.failure?.phase !== 'one-targeted-continuation'
    || pilot.failure?.errorType !== 'AttributeError' || pilot.failure?.message !== "'Namespace' object has no attribute 'run_kind'"
    || pilot.failure?.containerExitCode !== 1 || pilot.failure?.failedClosed !== true
    || pilot.trainerState?.globalStepObserved !== 13 || pilot.trainerState?.epochObserved !== 1
    || !close(pilot.trainerState?.bestDevelopmentMetricObserved, 1.8445898294448853)
    || pilot.trainerState?.metadataStatus !== 'blocked' || pilot.trainerState?.metadataOutputsRecorded !== false
    || pilot.trainerState?.lossReportCompleted !== false || pilot.trainerState?.adapterFiniteValidationCompleted !== false
    || pilot.artifacts?.eligibleForPanel !== false || pilot.artifacts?.eligibleForReuse !== false
    || pilot.artifacts?.eligibleForPromotion !== false || pilot.privacy?.sealedHoldoutRead !== false) {
    errors.push('pilot failure evidence or fail-closed disposition differs');
  }
  if (pilot.hashes?.hostGpuSnapshotSha256 !== 'f0dcc34933396a66ae164f48f0d68326bc2fc96e79bf45c497d595cd0bec64db'
    || pilot.hashes?.failureReceiptSha256 !== '7413803e11fcc66c9ca0825c31a03ab9d5456a45d76f77ab29d853f9858016c1'
    || pilot.hashes?.metadataSha256 !== '76babc42a5c470a86d0dfe1bead3bd5ade1a89a49a55671ac902cbaf978bfe36'
    || pilot.hashes?.a11ScreenLogSha256 !== '171036c9a75a971302f47b4218c23c1813ab31ba089475a3e62d87472177d1a4'
    || pilot.artifacts?.checkpointInventorySha256 !== 'fbdcc3829e5184f2d5e08bde9cfe477951ac129189beaee264d5b1386bdd06a4'
    || pilot.artifacts?.partialModelOutputInventorySha256 !== '77cc5f3c66e06ee3e24f444b42f56b76e07cac7e43b1bf054f45f27350ab304e') {
    errors.push('private pilot hash ledger differs');
  }

  const gpu = result.gpu ?? {};
  if (result.panel !== null || gpu.immediatePilotIdleGate?.passed !== true
    || gpu.immediatePilotIdleGate?.sampleCount !== 16 || gpu.immediatePilotIdleGate?.durationSeconds !== 30
    || gpu.immediatePilotIdleGate?.maximumComputeProcessCount !== 0
    || gpu.pilotMonitor?.maximumComputeProcessCount !== 1 || gpu.pilotMonitor?.competingWorkloadObserved !== false
    || gpu.pilotMonitor?.monitorError !== false || gpu.postRunIdleGate?.passed !== true
    || gpu.postRunIdleGate?.sampleCount !== 16 || gpu.postRunIdleGate?.durationSeconds !== 30
    || gpu.postRunIdleGate?.peakUtilizationPercent !== 0 || gpu.postRunIdleGate?.maximumComputeProcessCount !== 0
    || gpu.pilotScreenClosed !== true || gpu.pilotContainerAbsent !== true
    || gpu.contentionObserved !== false || gpu.unrelatedWorkloadStoppedOrModified !== false) {
    errors.push('GPU admission, monitoring, terminal idle, or panel boundary differs');
  }

  const operations = result.operations ?? {};
  if (operations.pilotAttempts !== 1 || operations.pilotRetries !== 0 || operations.successfulPilotRuns !== 0
    || operations.panelGenerationCount !== 0 || operations.panelReplayCount !== 0 || operations.fullCandidateRuns !== 0
    || operations.modelDownloads !== 0 || operations.awsDeployments !== 0 || operations.easBuilds !== 0
    || operations.publicationOperations !== 0 || operations.generationRerun !== false) {
    errors.push('single-attempt or out-of-scope operation boundary differs');
  }
  const validation = result.validation ?? {};
  if (validation.status !== 'passed-terminal-no-go' || validation.sourceContractsPassed !== true
    || validation.unitTestsPassed !== true || validation.unitTestCount !== 19
    || validation.frozenDatasetGatePassed !== true || validation.historicalValidatorsPassed !== true
    || validation.secretScanPassed !== true || validation.secretScanFileCount !== 1164
    || validation.diffCheckPassed !== true || validation.a11HostCompatibilityPassed !== true
    || validation.transferBindingsPassed !== true || validation.modelAndRuntimeIntegrityPassed !== true
    || validation.initialAdapterIntegrityPassed !== true || validation.resultSchemaPassed !== true
    || validation.pilotSuccessGatesPassed !== false || validation.panelGatesEvaluated !== false) {
    errors.push('terminal validation ledger differs');
  }
  const decision = result.decision ?? {};
  if (decision.strictDecision !== 'NO-GO' || decision.reasonCode !== 'pilot-wrapper-contract-failed'
    || decision.pilotRerunAuthorized !== false || decision.panelAuthorized !== false
    || decision.readyForTwoFullCandidateTraining !== false || decision.promotionEligible !== false
    || decision.modelFixedClaimed !== false || decision.reauthorizationRequired !== true
    || decision.failedGates?.length !== 5
    || decision.implementationConversion?.remainingBlocker !== 'A new GPU attempt requires explicit human reauthorization because the one permitted pilot was consumed.') {
    errors.push('terminal NO-GO or implementation handoff differs');
  }
  if (Object.values(result.privacy ?? {}).some(value => value !== false)
    || Object.values(result.untouched ?? {}).some(value => value !== true)) {
    errors.push('privacy or untouched declaration differs');
  }

  const publicText = `${JSON.stringify(result)}\n${readBytes(handoffRelative).toString('utf8')}`;
  const forbidden = [/(?:\/home\/|\/opt\/|\/root\/)/i, /(?:AKIA|ASIA)[A-Z0-9]{16}/, /-----BEGIN [A-Z ]+PRIVATE KEY-----/, /https?:\/\//i];
  if (forbidden.some(pattern => pattern.test(publicText))) errors.push('public result contains a private path, credential-like value, key, or URL');
  const prohibitedKeys = new Set(['completion', 'messages', 'prompt', 'response', 'rowId', 'rowIds']);
  if (collectKeys(result).some(key => prohibitedKeys.has(key))) errors.push('public result contains a raw-content or protected-row field');
  const tracked = execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' });
  if (/(?:pilot-screen\.log|launch-failure-receipt\.json|host-gpu-snapshot\.json|pilot-metadata\.json)/.test(tracked)) {
    errors.push('private runtime evidence is tracked by Git');
  }

  if (errors.length) {
    errors.forEach(error => console.error(`- ${error}`));
    return 1;
  }
  console.log(`SafeRide v0.5.7 final targeted result PASS (NO-GO; pilot failed closed; resultSha256=${sha256File(resultRelative)}).`);
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
