#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';
import { canonicalJson, canonicalSha256 } from './saferide-gemma4-development-progression-check.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const planRelative = 'config/ai/training/saferide-gemma4-v058-development-candidate-training-plan.json';
const schemaRelative = 'schemas/ai-v058-development-candidate-training-plan.schema.json';
const policyRelative = 'config/ai/evaluation/saferide-gemma4-global-usefulness-policy.v2.json';
const reportRelative = 'docs/qa/saferide-gemma4-v058-global-usefulness-decision-2026-08-09.json';
const v05PlanRelative = 'config/ai/datasets/saferide-gemma4-v05-plan.json';
const v05PolicyRelative = 'config/ai/training/saferide-gemma4-v05-sagemaker-policy.json';
const v057LineageRelative = 'config/ai/datasets/saferide-gemma4-v057-replacement-pilot-plan.json';

const absolute = relative => path.join(repoRoot, relative);
const readBytes = relative => fs.readFileSync(absolute(relative));
const readJson = relative => JSON.parse(readBytes(relative).toString('utf8'));
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const fileSha256 = relative => sha256(readBytes(relative));

const expectedLineage = Object.freeze([
  ['v0.5.1', '6c4eb3a6a07ec5fd8775f011b02c972ee99e6a8ec0742da8fb8969f5cc8a7049', 'b499a74cb4e8346b291462cee7a3a45d9be0afedaf17d6c0ae39a7b51f665ffd', 120, 'f74f2be4fc9a19975334c3d1e0a754720a36e0ae0b4381cda716c891cf7f5521', 'selected-weight-1'],
  ['v0.5.2', '08e04d65a23172b0da54c134f61923df92e1aeac134d1181419bdcf1daea52d0', '3bbacbe8c74cb07ff0c59f64d158ead5065751f3aa2ecb9e7ca08a7bb0cbca6c', 48, '5e182744b39096324051e902bbbee0976d25e7aed1bfde0a7e9e69f0df28445a', 'selected-weight-1'],
  ['v0.5.3', 'e8db2289678138447c030457d2a7a6e6d79e037a05c9c22d2191ffb2fa9be300', '6527d563b3fbf0d7e1f67d8b5cbc374ad1d487473ea0b9e8c89d1c86dff77228', 64, '5a7bbcd7fa214c0e3c16ada53035e004fa56eceef137e4dafd1ff2317d6e4dd2', 'selected-weight-1'],
  ['v0.5.4', '5c4187cd6b367f26efbea3af6899836e4c974f4129f061c1e43e4eb7534ef5a2', '92f997666d83664e8319a59188941bc1510320d733bd891c8ab0ed2ee17812ad', 32, '3eb607e8e4fd7ab6ca5954fb676c12f98b3721f6b689ac3a0e152a69c9cd73d0', 'selected-weight-2'],
  ['v0.5.5', '2187a1e4a01f5f8728011c164c70d4f745fc623a024e089ff3960f516cde1fa2', '1c077d8cc62177afc8cbef25aa8c9d9fa85903a13d6d44a32fed9862facc91c4', 32, '2db4b3f6a30f3166d0524db527dbf539c4b257ae69fc7d888402540c57196736', 'excluded-superseded-by-v0.5.6-from-v0.5.4'],
  ['v0.5.6', '12838865c6fa8e76f45506f1fc3f51535b98064b75a17e7466b32f449e5347b1', '9900b4d55eef76d5dcc2deead3a5586695f08aaaea38ebbe6783ee5f23138dc0', 24, '54f311799a13e4d6d894a8e43447710b84cd8fff0461645760243b1b155b3b54', 'selected-weight-2'],
  ['v0.5.7', 'c25c9324bdaea400e0d5a72974ebc938c1d3552ab4aceea9f1081330d325eb80', 'f16c071a0bad06f5b425db9e2feb899c958497fcc0d0e7a59b02316e60a8e6d5', 16, '9dd1b91a5cb14c06cb52e1418dfd71f0da3aeb86108d0266d1265194a307b3c5', 'selected-weight-3'],
].map(([version, planSha256, frozenManifestSha256, nonDevelopmentMitigationRows, nonDevelopmentMitigationSha256, v058SelectionStatus]) => ({
  version,
  planPath: `config/ai/datasets/saferide-gemma4-v0${version.slice(2).replaceAll('.', '')}-mitigation-plan.json`,
  planSha256, frozenManifestSha256, nonDevelopmentMitigationRows,
  nonDevelopmentMitigationSha256, v058SelectionStatus,
})));

// Restore the repository's historical filename convention (v051, not v0051).
for (const item of expectedLineage) item.planPath = `config/ai/datasets/saferide-gemma4-v0${item.version.slice(3).replace('.', '')}-mitigation-plan.json`;

const expectedFreeze = Object.freeze({
  selectionInventorySha256: '149ee517ffa67422c85a5ab507f3ff02b47385ca7c799382112f9a51faf0f483',
  exclusionsSha256: 'c7f00ea269e5768d283bdce1369101cb86a603162588c419ddd179b1b1f9f43c',
  deduplicationReportSha256: '67bbc1818e11081866cd994769bac4388bb100f592914b11a1c73c489e1d3875',
  weightingRecipeSha256: '15dd6fd1a370180ac536f0f97d568a8d54c65433bf14a1bcd33f1566db1123e8',
  sampleOrderContractSha256: '64430fb53bbae804d87c3164208e7442d1b48c836c01b0e016ace3bb585040b1',
  combinedUniqueTrainRows: 1904, combinedWeightedExamples: 1992,
  combinedUniqueTrainSha256: '669835b5f680b2198cf06d8c23a02d2e9aba2acba816c6283a0cdbbf8586a15e',
  combinedWeightedTrainSha256: 'b6fd044f9e7854d358200288b195787fc9ed6e8eea52925eea9aa0d48783689e',
  frozenManifestSha256: '0ad58d367f1ef1b6e46d57a741aef75f573734d024f9e4dc9318bbda281df272',
  registerSha256: '0d4c82eb632b58a0973ce22b3d135b80a844129e15052e01b9404d80e513841f',
  datasetAuditSha256: 'c2b6d08d517c9aa9e9091e56eec04cf50ff1ee3abe9b7ef2429c71ee9304e610',
  semanticReportSha256: '5acce5a9031fd97c0026b2074f2f5a4c43a459667a2d429b82a3ed48a733d722',
  tokenizationReportSha256: '6b49e00db441d2ad86ddd2e0067c218c3cfff18010aa1822821be44c50392888',
  leakageReportSha256: '387ff3ffad4861aceeee9a3b2135b73cc2472af060d6ae911ab0636605c1d0f1',
  trainingRecipeSha256: 'c83cd34159b3cef8814bcb85124ae54609b76f6b0bf51e706b40f6f621895512',
  a11InputManifestSha256: 'a32e49e7000dc8e0576a8987a38f8b2b58a67d9ffa17f03e967d67b91a59a115',
  a11TrainingArchiveSha256: '913b08085604139cf8af13bfab86694e571e869404af96b3e79eb23755d8ecc3',
  a11TrainingArchiveSizeBytes: 1439683,
});

export function authorizationBoundaryErrors(plan) {
  const errors = [];
  const authorization = plan.authorization ?? {};
  if (authorization.fullCandidateTrainingAuthorized !== true
    || authorization.authorizedCandidateCount !== 2
    || authorization.candidateRunsPerformed !== 0
    || authorization.candidateRunsRemaining !== 2
    || authorization.fullCandidateTrainingStarted !== false
    || authorization.automaticRetryAuthorized !== false) errors.push('candidate authorization state differs');
  for (const operation of ['holdout', 'selection', 'promotion', 'export', 'deployment', 'publication', 'release']) {
    if (authorization[`${operation}Authorized`] !== false) errors.push(`${operation} authorization must remain false`);
  }
  for (const operation of ['holdoutAccessed', 'selectionPerformed', 'promotionPerformed', 'exportPerformed', 'deploymentPerformed', 'publicationPerformed', 'releasePerformed', 'awsOrSageMakerOperationPerformed']) {
    if (plan.executionBoundary?.[operation] !== false) errors.push(`execution boundary ${operation} must remain false`);
  }
  if (plan.executionBoundary?.candidateTrainingStarted !== false
    || plan.executionBoundary?.candidateTrainingCompleted !== false) errors.push('candidate execution must remain not-started in the runnable plan');
  return errors;
}

export function fullCandidateInputErrors(plan) {
  const errors = [];
  const base = plan.authoritativeBaseCorpusLineage ?? {};
  const freeze = plan.requiredV058CombinedInputFreeze ?? {};
  const recipe = plan.governedCandidateRecipeBoundary ?? {};
  if (plan.status !== 'authorized-runnable-a11-candidates'
    || plan.executionReadiness !== 'runnable-a11-two-sequential-candidates') errors.push('v0.5.8 runnable state differs');
  if (base.trainRows !== 1600 || base.trainSha256 !== 'dd8b09648f4af001202787309ad8aefc5f23d67d028b6d5c655cd7b0fbec1f6f'
    || base.legacyPackageRunnableForV058 !== false) errors.push('legacy 1,600-row package must remain non-runnable lineage');
  if (freeze.status !== 'frozen-runnable' || freeze.blockers?.length !== 0
    || Object.entries(expectedFreeze).some(([key, value]) => freeze[key] !== value)) errors.push('frozen v0.5.8 A11 bindings differ');
  const composition = freeze.composition ?? {};
  if (composition.baseTrainRows !== 1600
    || canonicalJson(composition.selectedMitigationVersions) !== canonicalJson(['v0.5.1', 'v0.5.2', 'v0.5.3', 'v0.5.4', 'v0.5.6', 'v0.5.7'])
    || canonicalJson(composition.excludedHistoricalMitigationVersions) !== canonicalJson(['v0.5.5'])
    || composition.originalDevelopmentRowsExcluded !== 300 || composition.allBaseHoldoutRowsExcluded !== 700
    || composition.explicitSelectionInventoryRequired !== true || composition.explicitDeduplicationRequired !== true
    || composition.explicitWeightingRequired !== true) errors.push('frozen selection/exclusion composition differs');
  if (canonicalJson(plan.mitigationLineageSources) !== canonicalJson(expectedLineage)) errors.push('v0.5.1-v0.5.7 selected/excluded lineage differs');
  if (recipe.backend !== 'A11-only' || recipe.runKind !== 'candidate' || recipe.runnable !== true
    || recipe.finalCombinedTrainRows !== 1904 || recipe.finalWeightedExamples !== 1992
    || recipe.maximumOptimizerStepsPerCandidate !== 249 || recipe.finalRecipeSha256 !== expectedFreeze.trainingRecipeSha256
    || recipe.maxSteps !== null || recipe.epochs !== 1 || recipe.learningRate !== 2e-5
    || recipe.saveAllCheckpoints !== true || canonicalJson(recipe.seeds) !== canonicalJson([419805, 419806])) errors.push('runnable full-candidate recipe boundary differs');
  if (plan.candidates?.[0]?.status !== 'authorized-runnable'
    || plan.candidates?.[1]?.status !== 'authorized-runnable-paired-predecessor-required'
    || plan.candidates?.[0]?.seed !== 419805 || plan.candidates?.[1]?.seed !== 419806
    || plan.candidates?.[0]?.pairedRunBindingRequired !== false
    || plan.candidates?.[1]?.pairedRunBindingRequired !== true) errors.push('candidate seed/pair ordering differs');
  const pilot = plan.remediationPilotLineage ?? {};
  if (pilot.weightedExamples !== 104 || pilot.optimizerSteps !== 13
    || pilot.usedAsFullCandidateInput !== false || pilot.authorizedAsFullCandidateRecipe !== false) errors.push('v0.5.7 pilot must remain diagnostic lineage only');
  return errors;
}

export function validatePlanSemantics(plan, { policy, report, v05Plan, v05Policy, v057Lineage, hashes }) {
  const errors = [...authorizationBoundaryErrors(plan), ...fullCandidateInputErrors(plan)];
  const gate = plan.developmentGateBinding ?? {};
  if (gate.policySha256 !== hashes.policy || gate.decisionReportSha256 !== hashes.report
    || gate.decisionSha256 !== canonicalSha256(report.decision)
    || report.decision?.fullCandidateTrainingAuthorized !== true
    || report.decision?.authorizedCandidateCount !== 2
    || report.decision?.strictPromotionPassed !== false || report.decision?.releaseReady !== false
    || plan.supersedesPendingPlanSha256 !== '591efdd8f0092592756aa676e03b6ff4e9c9f6e930ec41306a2c3ca4030cedcb') errors.push('v2 decision or superseded pending-plan binding differs');

  const base = plan.authoritativeBaseCorpusLineage ?? {};
  if (base.datasetPlanSha256 !== hashes.v05Plan || fileSha256(base.datasetPlanPath) !== hashes.v05Plan) errors.push('authoritative v0.5 plan binding differs');
  for (const source of plan.mitigationLineageSources ?? []) {
    if (fileSha256(source.planPath) !== source.planSha256) errors.push(`mitigation plan binding differs: ${source.version}`);
  }
  const recipe = plan.governedCandidateRecipeBoundary ?? {};
  const bindings = [
    ['datasetBuilder', recipe.datasetBuilderPath, recipe.datasetBuilderSha256],
    ['trainingValidator', recipe.trainingValidatorPath, recipe.trainingValidatorSha256],
    ['fullRunner', recipe.fullFinetuneRunnerPath, recipe.fullFinetuneRunnerSha256],
    ['candidateRunner', recipe.candidateRunnerPath, recipe.candidateRunnerSha256],
    ['candidateLauncher', recipe.candidateLauncherPath, recipe.candidateLauncherSha256],
    ['developmentPanel', recipe.developmentPanelPath, recipe.developmentPanelSha256],
    ['developmentLauncher', recipe.developmentLauncherPath, recipe.developmentLauncherSha256],
  ];
  for (const [label, relative, bound] of bindings) {
    if (!relative || fileSha256(relative) !== bound || hashes[label] !== bound) errors.push(`repository recipe binding differs: ${label}`);
  }
  if (fileSha256(plan.remediationPilotLineage?.sourcePlanPath) !== plan.remediationPilotLineage?.sourcePlanSha256
    || hashes.v057Lineage !== plan.remediationPilotLineage?.sourcePlanSha256) errors.push('v0.5.7 remediation lineage binding differs');

  const fixed = v05Policy.training?.fixed ?? {};
  const pairs = {
    maxSequenceLength: recipe.maximumSequenceLength, trainBatchSize: recipe.trainBatchSize,
    evalBatchSize: recipe.evaluationBatchSize, gradientAccumulationSteps: recipe.gradientAccumulationSteps,
    loraRank: recipe.lora?.rank, loraAlpha: recipe.lora?.alpha, loraDropout: recipe.lora?.dropout,
    warmupRatio: recipe.warmupRatio, scheduler: recipe.scheduler, evalSteps: recipe.evaluationSteps,
    saveSteps: recipe.saveSteps, earlyStoppingPatience: recipe.earlyStoppingPatience,
    gradientCheckpointing: recipe.gradientCheckpointing,
  };
  for (const [key, value] of Object.entries(pairs)) if (fixed[key] !== value) errors.push(`fixed candidate recipe differs: ${key}`);
  if (canonicalJson(v05Plan.training?.candidateSeeds) !== canonicalJson(recipe.seeds)) errors.push('candidate seed lineage differs');

  const model = recipe.baseModel ?? {}; const sourceModel = v057Lineage.runtime?.baseModel ?? {};
  if (model.modelId !== sourceModel.modelId || model.revision !== sourceModel.revision
    || model.fileCount !== sourceModel.fileCount || model.totalBytes !== sourceModel.totalBytes
    || model.inventorySha256 !== canonicalSha256(sourceModel)
    || model.modelTensorSha256 !== sourceModel.files?.find(item => item.path === 'model.safetensors')?.sha256
    || model.chatTemplateSha256 !== sourceModel.files?.find(item => item.path === 'chat_template.jinja')?.sha256) errors.push('immutable base-model artifacts differ');

  const excluded = plan.excludedEvaluationInputs ?? {};
  if (excluded.originalDevelopment?.sha256 !== v057Lineage.fixedSuites?.originalDevelopment?.sha256
    || excluded.mitigationDevelopment?.sha256 !== v057Lineage.fixedSuites?.mitigationDevelopment?.sha256
    || excluded.sealedMitigationHoldout?.sha256 !== v057Lineage.fixedSuites?.sealedHoldout?.sha256
    || Object.values(excluded).some(item => item?.excludedFromTraining !== true)
    || [excluded.qualityHoldout, excluded.safetyHoldout, excluded.sealedMitigationHoldout].some(item => item?.accessAuthorized !== false)) errors.push('development/holdout exclusion boundary differs');

  const gates = policy.unchangedGates ?? {}; const thresholds = plan.globalUsefulnessAndSafetyThresholds ?? {};
  if (Object.values(thresholds.minimumUsefulnessByTier ?? {}).some(value => value !== 2)
    || thresholds.usefulnessMinimumInclusive !== true
    || thresholds.tinyVariantsDiagnosticForUsefulnessAcrossEveryTier !== true
    || thresholds.nonUsefulnessGateExemptionAllowedForTinyVariants !== false
    || thresholds.maximumCriticalFindings !== gates.maximumCriticalFindingsForDownstreamReleasePath
    || thresholds.maximumExecutionErrors !== gates.maximumExecutionErrors
    || thresholds.maximumTruncations !== gates.maximumTruncations
    || thresholds.maximumOverRefusalRate !== gates.maximumOverRefusalRate) errors.push('v2 usefulness or unchanged safety thresholds differ');
  return errors;
}

function collectKeys(value, keys = []) {
  if (Array.isArray(value)) value.forEach(item => collectKeys(item, keys));
  else if (value && typeof value === 'object') Object.entries(value).forEach(([key, item]) => { keys.push(key); collectKeys(item, keys); });
  return keys;
}

function main() {
  const plan = readJson(planRelative); const policy = readJson(policyRelative);
  const report = readJson(reportRelative); const v05Plan = readJson(v05PlanRelative);
  const v05Policy = readJson(v05PolicyRelative); const v057Lineage = readJson(v057LineageRelative);
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, strictTypes: false, validateFormats: false });
  const validate = ajv.compile(readJson(schemaRelative)); const errors = [];
  if (!validate(plan)) errors.push(...(validate.errors ?? []).map(error => `plan${error.instancePath || '/'}: ${error.message}`));
  const hashes = {
    policy: fileSha256(policyRelative), report: fileSha256(reportRelative), v05Plan: fileSha256(v05PlanRelative),
    v05Policy: fileSha256(v05PolicyRelative), v057Lineage: fileSha256(v057LineageRelative),
    datasetBuilder: fileSha256('scripts/saferide-gemma4-v058-dataset.py'),
    trainingValidator: fileSha256('scripts/saferide-gemma4-v058-training.py'),
    fullRunner: fileSha256('scripts/saferide-gemma4-finetune-runner.py'),
    candidateRunner: fileSha256('scripts/saferide-gemma4-v058-finetune-runner.py'),
    candidateLauncher: fileSha256('scripts/saferide-gemma4-v058-a11-shell-launcher.sh'),
    developmentPanel: fileSha256('scripts/saferide-gemma4-v058-development-panel.py'),
    developmentLauncher: fileSha256('scripts/saferide-gemma4-v058-a11-shell-launcher.sh'),
  };
  errors.push(...validatePlanSemantics(plan, { policy, report, v05Plan, v05Policy, v057Lineage, hashes }));
  const publicText = JSON.stringify(plan);
  const forbidden = [/(?:\/home\/|\/opt\/|\/root\/)/i, /(?:AKIA|ASIA)[A-Z0-9]{16}/, /-----BEGIN [A-Z ]+PRIVATE KEY-----/, /https?:\/\//i];
  if (forbidden.some(pattern => pattern.test(publicText))) errors.push('candidate plan contains a private path, credential-like value, key, or URL');
  const prohibitedKeys = new Set(['completion', 'messages', 'prompt', 'rowId', 'rowIds', 'privatePath', 'excerpt', 'encoded']);
  if (collectKeys(plan).some(key => prohibitedKeys.has(key))) errors.push('candidate plan contains raw content or protected identifiers');
  if (errors.length) { errors.forEach(error => console.error(`- ${error}`)); return 1; }
  console.log(`SafeRide v0.5.8 runnable candidate plan PASS (1,904 unique; 1,992 weighted; 249 steps; A11 only; 2 candidates; holdout/selection/promotion=false; planSha256=${fileSha256(planRelative)}).`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
