import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';

import { validateTrainingRun } from '../saferide-ai-training-run-check.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const schema = JSON.parse(fs.readFileSync(path.join(repoRoot, 'schemas/ai-training-run.schema.json'), 'utf8'));

function validator() {
  return new Ajv2020({ allErrors: true, strict: true, strictRequired: false, strictTypes: false }).compile(schema);
}

function fixture() {
  return {
    schema: 'com.saferide.ai.training-run',
    schemaVersion: 1,
    runId: 'saferide-preflight-test',
    createdAt: '2026-07-30T00:00:00.000Z',
    issue: 'ESH-4198',
    mode: 'dry-run',
    runKind: 'preflight',
    candidateRun: false,
    promotionEligible: false,
    status: 'preflight-complete',
    baseModelId: 'google/gemma-4-E2B-it',
    baseRevision: 'unresolved',
    baseModelSource: 'hugging-face-hub',
    register: 'register.json',
    registerSha256: 'a'.repeat(64),
    data: null,
    dataSha256: null,
    audit: null,
    auditSha256: null,
    dataGate: { command: 'content-free data check', exitCode: 0, passed: true },
    dataSummary: { rowCount: 0 },
    environment: { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 },
    packageVersions: {
      torch: 'not-installed', transformers: 'not-installed', datasets: 'not-installed',
      peft: 'not-installed', accelerate: 'not-installed', safetensors: 'not-installed',
    },
    runArguments: {
      seed: 419804,
      epochs: 1,
      maxSteps: null,
      maxSequenceLength: 1024,
      trainBatchSize: 1,
      evalBatchSize: 1,
      gradientAccumulationSteps: 8,
      effectiveBatchSize: 8,
      learningRate: 0.00002,
      warmupRatio: 0.03,
      scheduler: 'cosine',
      loggingSteps: 5,
      evalSteps: 5,
      saveSteps: 5,
      earlyStoppingPatience: 3,
      selectionMetric: 'eval_loss',
    },
    repeatability: { required: false, secondSeedRunId: null, status: 'not-applicable-to-non-candidate' },
    privacy: {
      rawPromptLogging: 'forbidden', rawCompletionLogging: 'forbidden',
      survivorDataUsed: false, metadataOnly: true,
    },
    failure: null,
    outputs: {},
  };
}

const hashIds = ids => crypto.createHash('sha256').update(ids.join('\n')).digest('hex');

function v05CompletedFixture(runKind = 'candidate') {
  const value = fixture();
  const trainCount = runKind === 'pilot' ? 320 : 1600;
  const trainRowIds = Array.from({ length: trainCount }, (_, index) => `v05-train-row-${String(index).padStart(4, '0')}`);
  const developmentRowIds = Array.from({ length: 300 }, (_, index) => `v05-dev-row-${String(index).padStart(4, '0')}`);
  Object.assign(value, {
    datasetProfile: 'v05', runKind, candidateRun: runKind === 'candidate',
    status: 'completed', mode: 'prototype-finetune', baseRevision: 'b'.repeat(40),
    dataFiles: {
      train: { path: '/controlled/train.jsonl', sha256: 'c'.repeat(64) },
      dev: { path: '/controlled/dev.jsonl', sha256: 'd'.repeat(64) },
    },
    audit: '/controlled/audit.json', auditSha256: 'e'.repeat(64),
    datasetManifest: '/controlled/dataset-manifest.json', datasetManifestSha256: 'f'.repeat(64),
    datasetBindings: {
      datasetId: 'saferide-synthetic-guidance-v0.5.0', planSha256: '1'.repeat(64),
      policySha256: '2'.repeat(64), systemPromptConfigSha256: '3'.repeat(64), systemPromptTextSha256: '4'.repeat(64),
      scenarioSpecSha256: '5'.repeat(64), splitManifestSha256: '6'.repeat(64), reviewLedgerSha256: '7'.repeat(64),
      pilotRowManifest: runKind === 'pilot' ? '/controlled/pilot.json' : null,
      pilotRowManifestSha256: runKind === 'pilot' ? '8'.repeat(64) : null,
    },
  });
  value.runArguments = {
    ...value.runArguments, seed: 419805, evalSteps: 25, saveSteps: 25,
    loraRank: 8, loraAlpha: 16, loraDropout: 0.05, loraRankApprovalRef: null,
  };
  value.repeatability = runKind === 'candidate'
    ? { required: true, secondSeedRunId: 'saferide-v05-seed-b', status: 'pending' }
    : { required: false, secondSeedRunId: null, status: 'not-applicable-to-non-candidate' };
  value.privacy = {
    ...value.privacy, classification: 'controlled-content-free', containsExactRowIds: true,
  };
  value.dataSummary = {
    rowCount: 1900,
    datasetIds: ['saferide-synthetic-guidance-v0.5.0'],
    splitCounts: { train: 1600, dev: 300 },
    rowIdSha256: 'e'.repeat(64),
  };
  value.environment = {
    ...value.environment, dependencyConstraintsSatisfied: true,
    requirementsSha256: '9'.repeat(64), constraintsSha256: 'a'.repeat(64),
  };
  value.outputs = {
    runKind, epochsCompleted: 1, sampleOrder: [...trainRowIds], sampleOrderSha256: hashIds(trainRowIds),
    rowsSeen: trainCount, selectionMetric: 'eval_loss', bestMetric: 0.5,
    chatTemplateSha256: 'b'.repeat(64), tokenizerRevision: 'c'.repeat(40),
    adapterFiles: [{ path: 'adapter.safetensors', sizeBytes: 1, sha256: 'd'.repeat(64) }],
    holdoutRowsRead: 0, trainRowIds, trainRowIdSha256: hashIds(trainRowIds),
    developmentRowIds, developmentRowIdSha256: hashIds(developmentRowIds),
  };
  return value;
}

function v051CompletedFixture(runKind = 'candidate') {
  const value = v05CompletedFixture(runKind);
  const trainCount = runKind === 'pilot' ? 320 : 1720;
  const trainRowIds = Array.from({ length: trainCount }, (_, index) => `v051-train-row-${String(index).padStart(4, '0')}`);
  Object.assign(value, {
    datasetProfile: 'v051',
    dataSummary: {
      rowCount: 2020,
      datasetIds: ['saferide-synthetic-guidance-v0.5.0', 'saferide-synthetic-guidance-v0.5.1'],
      splitCounts: { train: 1720, dev: 300 },
      rowIdSha256: 'e'.repeat(64),
    },
    datasetBindings: {
      datasetId: 'saferide-synthetic-guidance-v0.5.1',
      planSha256: null, policySha256: null, systemPromptConfigSha256: null,
      systemPromptTextSha256: null, scenarioSpecSha256: null,
      splitManifestSha256: null, reviewLedgerSha256: null,
      pilotRowManifest: runKind === 'pilot' ? '/controlled/pilot.json' : null,
      pilotRowManifestSha256: runKind === 'pilot' ? '8'.repeat(64) : null,
    },
  });
  value.outputs = {
    ...value.outputs,
    sampleOrder: [...trainRowIds], sampleOrderSha256: hashIds(trainRowIds), rowsSeen: trainCount,
    trainRowIds, trainRowIdSha256: hashIds(trainRowIds),
  };
  return value;
}

function v052CompletedFixture() {
  const value = v051CompletedFixture('pilot');
  const trainRowIds = Array.from({ length: 1768 }, (_, index) => `v052-train-row-${String(index).padStart(4, '0')}`);
  const sampleOrder = [...trainRowIds, ...trainRowIds.slice(-48), ...trainRowIds.slice(-48)];
  Object.assign(value, {
    datasetProfile: 'v052',
    dataSummary: {
      rowCount: 2068,
      datasetIds: [
        'saferide-synthetic-guidance-v0.5.0',
        'saferide-synthetic-guidance-v0.5.1',
        'saferide-synthetic-guidance-v0.5.2',
      ],
      splitCounts: { train: 1768, dev: 300 },
      rowIdSha256: 'e'.repeat(64),
    },
    datasetBindings: {
      datasetId: 'saferide-synthetic-guidance-v0.5.2',
      diagnosisSummarySha256: '0'.repeat(64),
      implementationSha256: '1'.repeat(64),
      mitigationDevelopmentSha256: '2'.repeat(64),
      originalDevelopmentSha256: '3'.repeat(64),
      planSha256: '4'.repeat(64),
      scoringPolicySha256: '5'.repeat(64),
      sealedMitigationHoldoutSha256: '6'.repeat(64),
      systemPromptTextSha256: '7'.repeat(64),
      v051CombinedTrainSha256: '8'.repeat(64),
      v051FrozenManifestSha256: '9'.repeat(64),
      pilotRowManifest: '/controlled/pilot.json',
      pilotRowManifestSha256: 'a'.repeat(64),
    },
  });
  value.runArguments = { ...value.runArguments, learningRate: 0.00002 };
  value.outputs = {
    ...value.outputs,
    sampleOrder,
    sampleOrderSha256: hashIds(sampleOrder),
    rowsSeen: 1864,
    trainRowIds,
    trainRowIdSha256: hashIds(trainRowIds),
  };
  return value;
}

function v053CompletedFixture() {
  const value = v051CompletedFixture('pilot');
  const trainRowIds = Array.from({ length: 1832 }, (_, index) => `v053-train-row-${String(index).padStart(4, '0')}`);
  const sampleOrder = [...trainRowIds, ...trainRowIds.slice(-64), ...trainRowIds.slice(-64), ...trainRowIds.slice(-64), ...trainRowIds.slice(-64)];
  Object.assign(value, {
    datasetProfile: 'v053',
    dataSummary: {
      rowCount: 2132,
      datasetIds: [
        'saferide-synthetic-guidance-v0.5.0',
        'saferide-synthetic-guidance-v0.5.1',
        'saferide-synthetic-guidance-v0.5.2',
        'saferide-synthetic-guidance-v0.5.3',
      ],
      splitCounts: { train: 1832, dev: 300 },
      rowIdSha256: 'e'.repeat(64),
    },
    datasetBindings: {
      datasetId: 'saferide-synthetic-guidance-v0.5.3',
      diagnosisSummarySha256: '0'.repeat(64),
      implementationSha256: '1'.repeat(64),
      mitigationDevelopmentSha256: '2'.repeat(64),
      originalDevelopmentSha256: '3'.repeat(64),
      planSha256: '4'.repeat(64),
      scoringPolicySha256: '5'.repeat(64),
      sealedMitigationHoldoutSha256: '6'.repeat(64),
      systemPromptTextSha256: '7'.repeat(64),
      v052CombinedTrainSha256: '8'.repeat(64),
      v052FrozenManifestSha256: '9'.repeat(64),
      pilotRowManifest: '/controlled/pilot.json',
      pilotRowManifestSha256: 'a'.repeat(64),
    },
  });
  value.runArguments = { ...value.runArguments, learningRate: 0.00001 };
  value.outputs = {
    ...value.outputs,
    sampleOrder,
    sampleOrderSha256: hashIds(sampleOrder),
    rowsSeen: 2088,
    trainRowIds,
    trainRowIdSha256: hashIds(trainRowIds),
  };
  return value;
}

function v054CompletedFixture() {
  const value = v051CompletedFixture('pilot');
  const trainRowIds = Array.from({ length: 1864 }, (_, index) => `v054-train-row-${String(index).padStart(4, '0')}`);
  const sampleOrder = [...trainRowIds, ...trainRowIds.slice(-32)];
  Object.assign(value, {
    datasetProfile: 'v054',
    dataSummary: {
      rowCount: 2164,
      datasetIds: [
        'saferide-synthetic-guidance-v0.5.0',
        'saferide-synthetic-guidance-v0.5.1',
        'saferide-synthetic-guidance-v0.5.2',
        'saferide-synthetic-guidance-v0.5.3',
        'saferide-synthetic-guidance-v0.5.4',
      ],
      splitCounts: { train: 1864, dev: 300 },
      rowIdSha256: 'e'.repeat(64),
    },
    datasetBindings: {
      datasetId: 'saferide-synthetic-guidance-v0.5.4',
      diagnosisSummarySha256: '0'.repeat(64),
      implementationSha256: '1'.repeat(64),
      lossPolicySha256: '2'.repeat(64),
      mitigationDevelopmentSha256: '3'.repeat(64),
      originalDevelopmentSha256: '4'.repeat(64),
      planSha256: '5'.repeat(64),
      scoringPolicySha256: '6'.repeat(64),
      sealedMitigationHoldoutSha256: '7'.repeat(64),
      systemPromptTextSha256: '8'.repeat(64),
      v053CombinedTrainSha256: '9'.repeat(64),
      v053FrozenManifestSha256: 'a'.repeat(64),
      pilotRowManifest: '/controlled/pilot.json',
      pilotRowManifestSha256: 'b'.repeat(64),
    },
  });
  value.runArguments = { ...value.runArguments, learningRate: 0.00002, maxGradientNorm: 1 };
  value.outputs = {
    ...value.outputs,
    lossMaskPolicy: 'assistant-turns-only',
    sampleOrder,
    sampleOrderSha256: hashIds(sampleOrder),
    rowsSeen: 1896,
    trainRowIds,
    trainRowIdSha256: hashIds(trainRowIds),
    lossReport: {
      policyId: 'saferide-v054-training-loss-integrity.1',
      policySha256: 'c'.repeat(64),
      rawTrainerAccumulatedLoss: 20,
      gradientAccumulationSteps: 8,
      meanTrainingObjectiveLoss: 2.5,
      bestDevelopmentLoss: 0.4,
      finalDevelopmentLoss: 0.5,
      selectionMetric: 'minimum-finite-development-assistant-token-loss',
      finite: true,
      spikeGate: 'passed',
      divergenceGate: 'passed',
    },
  };
  return value;
}

function v055CompletedFixture() {
  const value = v054CompletedFixture();
  const trainRowIds = Array.from({ length: 1896 }, (_, index) => `v055-train-row-${String(index).padStart(4, '0')}`);
  const focused = trainRowIds.slice(-32);
  const sampleOrder = [...trainRowIds, ...focused, ...focused, ...focused];
  Object.assign(value, {
    datasetProfile: 'v055',
    dataSummary: {
      rowCount: 2196,
      datasetIds: [
        'saferide-synthetic-guidance-v0.5.0',
        'saferide-synthetic-guidance-v0.5.1',
        'saferide-synthetic-guidance-v0.5.2',
        'saferide-synthetic-guidance-v0.5.3',
        'saferide-synthetic-guidance-v0.5.4',
        'saferide-synthetic-guidance-v0.5.5',
      ],
      splitCounts: { train: 1896, dev: 300 },
      rowIdSha256: 'e'.repeat(64),
    },
    datasetBindings: {
      datasetId: 'saferide-synthetic-guidance-v0.5.5',
      diagnosisSummarySha256: '0'.repeat(64),
      implementationSha256: '1'.repeat(64),
      lossPolicySha256: '2'.repeat(64),
      mitigationDevelopmentSha256: '3'.repeat(64),
      originalDevelopmentSha256: '4'.repeat(64),
      planSha256: '5'.repeat(64),
      scoringPolicySha256: '6'.repeat(64),
      sealedMitigationHoldoutSha256: '7'.repeat(64),
      systemPromptTextSha256: '8'.repeat(64),
      v054CombinedTrainSha256: '9'.repeat(64),
      v054FrozenManifestSha256: 'a'.repeat(64),
      pilotRowManifest: '/controlled/pilot.json',
      pilotRowManifestSha256: 'b'.repeat(64),
    },
  });
  value.runArguments = { ...value.runArguments, learningRate: 0.00001, maxGradientNorm: 1 };
  value.outputs = {
    ...value.outputs,
    sampleOrder,
    sampleOrderSha256: hashIds(sampleOrder),
    rowsSeen: 1992,
    trainRowIds,
    trainRowIdSha256: hashIds(trainRowIds),
  };
  return value;
}

function v056CompletedFixture() {
  const value = v054CompletedFixture();
  const trainRowIds = Array.from({ length: 1888 }, (_, index) => `v056-train-row-${String(index).padStart(4, '0')}`);
  const focused = trainRowIds.slice(-56);
  const sampleOrder = [...trainRowIds, ...focused];
  Object.assign(value, {
    datasetProfile: 'v056',
    dataSummary: {
      rowCount: 2188,
      datasetIds: [
        'saferide-synthetic-guidance-v0.5.0',
        'saferide-synthetic-guidance-v0.5.1',
        'saferide-synthetic-guidance-v0.5.2',
        'saferide-synthetic-guidance-v0.5.3',
        'saferide-synthetic-guidance-v0.5.4',
        'saferide-synthetic-guidance-v0.5.6',
      ],
      splitCounts: { train: 1888, dev: 300 },
      rowIdSha256: 'e'.repeat(64),
    },
    datasetBindings: {
      datasetId: 'saferide-synthetic-guidance-v0.5.6',
      diagnosisSummarySha256: '0'.repeat(64),
      implementationSha256: '1'.repeat(64),
      lossPolicySha256: '2'.repeat(64),
      mitigationDevelopmentSha256: '3'.repeat(64),
      originalDevelopmentSha256: '4'.repeat(64),
      planSha256: '5'.repeat(64),
      scoringPolicySha256: '6'.repeat(64),
      sealedMitigationHoldoutSha256: '7'.repeat(64),
      systemPromptTextSha256: '8'.repeat(64),
      v054CombinedTrainSha256: '9'.repeat(64),
      v054FrozenManifestSha256: 'a'.repeat(64),
      v054TrainingRecipeSha256: 'b'.repeat(64),
      pilotRowManifest: '/controlled/pilot.json',
      pilotRowManifestSha256: 'c'.repeat(64),
    },
  });
  value.runArguments = { ...value.runArguments, learningRate: 0.00002, maxGradientNorm: 1 };
  value.outputs = {
    ...value.outputs,
    sampleOrder,
    sampleOrderSha256: hashIds(sampleOrder),
    rowsSeen: 1944,
    trainRowIds,
    trainRowIdSha256: hashIds(trainRowIds),
  };
  return value;
}

test('a content-free preflight manifest passes schema and semantic gates', () => {
  assert.deepEqual(validateTrainingRun(fixture(), validator(), { verifyFiles: false }), []);
});

test('promotion eligibility cannot be asserted by the training runner', () => {
  const value = fixture();
  value.promotionEligible = true;
  assert.ok(validateTrainingRun(value, validator(), { verifyFiles: false }).some(error => error.includes('promotionEligible')));
});

test('raw output fields are rejected from content-free evidence', () => {
  const value = fixture();
  value.outputs = { prompt: 'synthetic but still private output' };
  assert.ok(validateTrainingRun(value, validator(), { verifyFiles: false }).some(error => error.includes('forbidden')));
});

test('a completed candidate without full lineage and training evidence fails closed', () => {
  const value = fixture();
  Object.assign(value, {
    runKind: 'candidate', candidateRun: true, status: 'completed', mode: 'prototype-finetune',
    baseRevision: 'b'.repeat(40), data: 'data.jsonl', dataSha256: 'c'.repeat(64),
    audit: 'audit.json', auditSha256: 'd'.repeat(64),
  });
  value.repeatability = { required: true, secondSeedRunId: null, status: 'pending' };
  const errors = validateTrainingRun(value, validator(), { verifyFiles: false });
  assert.ok(errors.some(error => error.includes('exact sample order')));
  assert.ok(errors.some(error => error.includes('best-checkpoint')));
  assert.ok(errors.some(error => error.includes('hashed adapter inventory')));
});

test('a complete v0.5 candidate manifest binds separate train/dev inputs and exact row inventories', () => {
  assert.deepEqual(validateTrainingRun(v05CompletedFixture(), validator(), { verifyFiles: false }), []);
});

test('a complete v0.5 pilot requires exactly the deterministic 320-row inventory', () => {
  assert.deepEqual(validateTrainingRun(v05CompletedFixture('pilot'), validator(), { verifyFiles: false }), []);
});

test('complete v0.5.1 pilot and candidate manifests enforce the 1,720/300 lineage', () => {
  assert.deepEqual(validateTrainingRun(v051CompletedFixture('pilot'), validator(), { verifyFiles: false }), []);
  assert.deepEqual(validateTrainingRun(v051CompletedFixture(), validator(), { verifyFiles: false }), []);
});

test('complete v0.5.2 pilot permits only the frozen 1,864-example weighted order over 1,768 unique rows', () => {
  assert.deepEqual(validateTrainingRun(v052CompletedFixture(), validator(), { verifyFiles: false }), []);

  const overWeighted = v052CompletedFixture();
  overWeighted.outputs.sampleOrder.push(overWeighted.outputs.sampleOrder[0]);
  overWeighted.outputs.sampleOrderSha256 = hashIds(overWeighted.outputs.sampleOrder);
  overWeighted.outputs.rowsSeen += 1;
  assert.match(validateTrainingRun(overWeighted, validator(), { verifyFiles: false }).join('\n'), /governed train inventory\/weighting/);
});

test('v0.5.2 training-run validation rejects full candidates and non-frozen learning rates', () => {
  const value = v052CompletedFixture();
  value.runKind = 'candidate';
  value.candidateRun = true;
  value.runArguments.learningRate = 0.00001;
  value.repeatability = { required: true, secondSeedRunId: 'saferide-v052-paired', status: 'pending' };
  const errors = validateTrainingRun(value, validator(), { verifyFiles: false }).join('\n');
  assert.match(errors, /full candidate training is not authorized/);
  assert.match(errors, /approved pilot learning rate/);
});

test('complete v0.5.3 pilot permits only the frozen 2,088-example order over 1,832 unique rows', () => {
  assert.deepEqual(validateTrainingRun(v053CompletedFixture(), validator(), { verifyFiles: false }), []);

  const underWeighted = v053CompletedFixture();
  underWeighted.outputs.sampleOrder.pop();
  underWeighted.outputs.sampleOrderSha256 = hashIds(underWeighted.outputs.sampleOrder);
  underWeighted.outputs.rowsSeen -= 1;
  assert.match(validateTrainingRun(underWeighted, validator(), { verifyFiles: false }).join('\n'), /governed train inventory\/weighting/);
});

test('v0.5.3 training-run validation rejects full candidates and non-frozen learning rates', () => {
  const value = v053CompletedFixture();
  value.runKind = 'candidate';
  value.candidateRun = true;
  value.runArguments.learningRate = 0.00002;
  value.repeatability = { required: true, secondSeedRunId: 'saferide-v053-paired', status: 'pending' };
  const errors = validateTrainingRun(value, validator(), { verifyFiles: false }).join('\n');
  assert.match(errors, /full candidate training is not authorized/);
  assert.match(errors, /approved pilot learning rate/);
});

test('complete v0.5.4 pilot binds the 1,896-example order and truthful loss semantics', () => {
  assert.deepEqual(validateTrainingRun(v054CompletedFixture(), validator(), { verifyFiles: false }), []);

  const overWeighted = v054CompletedFixture();
  overWeighted.outputs.sampleOrder.push(overWeighted.outputs.sampleOrder.at(-1));
  overWeighted.outputs.sampleOrderSha256 = hashIds(overWeighted.outputs.sampleOrder);
  overWeighted.outputs.rowsSeen += 1;
  assert.match(validateTrainingRun(overWeighted, validator(), { verifyFiles: false }).join('\n'), /governed train inventory\/weighting/);

  const falseLoss = v054CompletedFixture();
  falseLoss.outputs.lossReport.meanTrainingObjectiveLoss = 20;
  assert.match(validateTrainingRun(falseLoss, validator(), { verifyFiles: false }).join('\n'), /truthful finite raw\/objective\/best\/final loss/);
});

test('v0.5.4 permits one targeted pilot only and requires explicit clipping', () => {
  const value = v054CompletedFixture();
  value.runKind = 'candidate';
  value.candidateRun = true;
  value.runArguments.seed = 419806;
  value.runArguments.maxGradientNorm = 2;
  value.repeatability = { required: true, secondSeedRunId: 'saferide-v054-paired', status: 'pending' };
  const errors = validateTrainingRun(value, validator(), { verifyFiles: false }).join('\n');
  assert.match(errors, /full candidate training is not authorized/);
  assert.match(errors, /one targeted pilot/);
  assert.match(errors, /maxGradientNorm 1.0/);
});

test('complete v0.5.5 pilot binds the 1,992-example four-times focused order', () => {
  assert.deepEqual(validateTrainingRun(v055CompletedFixture(), validator(), { verifyFiles: false }), []);

  const wrongWeight = v055CompletedFixture();
  wrongWeight.outputs.sampleOrder.pop();
  wrongWeight.outputs.sampleOrderSha256 = hashIds(wrongWeight.outputs.sampleOrder);
  wrongWeight.outputs.rowsSeen -= 1;
  assert.match(validateTrainingRun(wrongWeight, validator(), { verifyFiles: false }).join('\n'), /governed train inventory\/weighting/);
});

test('v0.5.5 preserves truthful loss and forbids full candidates', () => {
  const falseLoss = v055CompletedFixture();
  falseLoss.outputs.lossReport.meanTrainingObjectiveLoss = 20;
  assert.match(validateTrainingRun(falseLoss, validator(), { verifyFiles: false }).join('\n'), /truthful finite raw\/objective\/best\/final loss/);

  const candidate = v055CompletedFixture();
  candidate.runKind = 'candidate';
  candidate.candidateRun = true;
  candidate.repeatability = { required: true, secondSeedRunId: 'saferide-v055-paired', status: 'pending' };
  assert.match(validateTrainingRun(candidate, validator(), { verifyFiles: false }).join('\n'), /full candidate training is not authorized/);
});

test('complete v0.5.6 pilot preserves the 1,944-example v0.5.4 control weighting', () => {
  assert.deepEqual(validateTrainingRun(v056CompletedFixture(), validator(), { verifyFiles: false }), []);

  const wrongWeight = v056CompletedFixture();
  wrongWeight.outputs.sampleOrder.push(wrongWeight.outputs.sampleOrder.at(-1));
  wrongWeight.outputs.sampleOrderSha256 = hashIds(wrongWeight.outputs.sampleOrder);
  wrongWeight.outputs.rowsSeen += 1;
  assert.match(validateTrainingRun(wrongWeight, validator(), { verifyFiles: false }).join('\n'), /governed train inventory\/weighting/);
});

test('v0.5.6 preserves truthful loss and forbids full candidates', () => {
  const falseLoss = v056CompletedFixture();
  falseLoss.outputs.lossReport.meanTrainingObjectiveLoss = 20;
  assert.match(validateTrainingRun(falseLoss, validator(), { verifyFiles: false }).join('\n'), /truthful finite raw\/objective\/best\/final loss/);

  const candidate = v056CompletedFixture();
  candidate.runKind = 'candidate';
  candidate.candidateRun = true;
  candidate.repeatability = { required: true, secondSeedRunId: 'saferide-v056-paired', status: 'pending' };
  assert.match(validateTrainingRun(candidate, validator(), { verifyFiles: false }).join('\n'), /full candidate training is not authorized/);
});

test('recovered v0.5.1 container paths verify against an explicit staged package root', () => {
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'saferide-v051-source-'));
  const value = v051CompletedFixture();
  const externalRoot = '/opt/ml/input/data/saferide-v05-extracted/fixture-package';
  value.environment.requirements = 'requirements-ai-smoke.txt';
  value.environment.requirementsSha256 = crypto.createHash('sha256')
    .update(fs.readFileSync(path.join(repoRoot, 'requirements-ai-smoke.txt'))).digest('hex');
  value.environment.constraints = 'constraints-ai-training.txt';
  value.environment.constraintsSha256 = crypto.createHash('sha256')
    .update(fs.readFileSync(path.join(repoRoot, 'constraints-ai-training.txt'))).digest('hex');
  const files = {
    'register.json': 'register',
    'artifacts/audit/dataset-audit.json': 'audit',
    'artifacts/dataset/controlled/train.jsonl': 'train',
    'artifacts/dataset/controlled/dev.jsonl': 'dev',
    'artifacts/dataset/public-safe/dataset-manifest.json': 'manifest',
  };
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(sourceRoot, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  value.register = `${externalRoot}/register.json`;
  value.registerSha256 = crypto.createHash('sha256').update(files['register.json']).digest('hex');
  value.audit = `${externalRoot}/artifacts/audit/dataset-audit.json`;
  value.auditSha256 = crypto.createHash('sha256').update(files['artifacts/audit/dataset-audit.json']).digest('hex');
  value.dataFiles.train = {
    path: `${externalRoot}/artifacts/dataset/controlled/train.jsonl`,
    sha256: crypto.createHash('sha256').update(files['artifacts/dataset/controlled/train.jsonl']).digest('hex'),
  };
  value.dataFiles.dev = {
    path: `${externalRoot}/artifacts/dataset/controlled/dev.jsonl`,
    sha256: crypto.createHash('sha256').update(files['artifacts/dataset/controlled/dev.jsonl']).digest('hex'),
  };
  value.datasetManifest = `${externalRoot}/artifacts/dataset/public-safe/dataset-manifest.json`;
  value.datasetManifestSha256 = crypto.createHash('sha256').update(files['artifacts/dataset/public-safe/dataset-manifest.json']).digest('hex');
  assert.deepEqual(validateTrainingRun(value, validator(), { sourceRoot }), []);
});

test('v0.5 manifest rejects holdout access, stale sample order, wrong seed, and unapproved rank 16', () => {
  const value = v05CompletedFixture();
  value.outputs.holdoutRowsRead = 1;
  value.outputs.sampleOrder[0] = 'different-row';
  value.runArguments.seed = 1;
  value.runArguments.loraRank = 16;
  const errors = validateTrainingRun(value, validator(), { verifyFiles: false }).join('\n');
  assert.match(errors, /holdout rows/);
  assert.match(errors, /sample order/);
  assert.match(errors, /seed/);
  assert.match(errors, /rank 16/);
});
