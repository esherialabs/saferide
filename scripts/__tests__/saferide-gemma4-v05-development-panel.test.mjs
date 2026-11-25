import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildPanelJobSpec,
  fileSha256,
  validatePanelInput,
  validateV052PilotSummary,
} from '../saferide-gemma4-v05-development-panel.mjs';

const sha = character => character.repeat(64);

function fixture(version = 'v05') {
  const isV051 = version === 'v051';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'saferide-v05-panel-'));
  const write = (relative, value = relative) => {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, value, { mode: 0o600 });
    return { path: relative, sha256: fileSha256(target), sizeBytes: fs.statSync(target).size };
  };
  const packageFiles = [
    write('code/saferide-gemma4-v05-development-panel.py'),
    write('data/dev.jsonl'),
    write('manifests/sagemaker-input-manifest.json'),
    write('manifests/candidate-repeatability.json'),
    write('manifests/candidate-419805.json'),
    write('manifests/candidate-419806.json'),
  ];
  if (isV051) packageFiles.push(
    write('code/saferide-gemma4-v051-development-panel.py'),
    write('data/mitigation-development.jsonl'),
    write('manifests/frozen-v051-manifest.json'),
  );
  const candidate = seed => {
    const adapterFiles = [
      'README.md', 'adapter_config.json', 'adapter_model.safetensors',
      'chat_template.jinja', 'tokenizer.json', 'tokenizer_config.json',
    ].map(name => write(`adapters/${seed}/${name}`));
    packageFiles.push(...adapterFiles);
    return {
      seed,
      runId: `fixture-candidate-seed-${seed}`,
      manifest: {
        path: `manifests/candidate-${seed}.json`,
        sha256: packageFiles.find(file => file.path === `manifests/candidate-${seed}.json`).sha256,
      },
      bestCheckpoint: 'checkpoint-200',
      developmentAssistantTokenLoss: seed === 419805 ? 0.4 : 0.5,
      adapterRoot: `adapters/${seed}`,
      adapterInventorySha256: sha(seed === 419805 ? 'a' : 'b'),
      adapterFiles,
    };
  };
  const candidates = [candidate(419805), candidate(419806)];
  const modelNames = [
    '.gitattributes', 'README.md', 'chat_template.jinja', 'config.json', 'generation_config.json',
    'model.safetensors', 'processor_config.json', 'tokenizer.json', 'tokenizer_config.json',
  ];
  const scoringPolicy = {
    policyId: 'saferide-v05-development-panel-deterministic-rubric.1',
    usefulnessScale: [0, 1, 2, 3],
    alignment: { fixture: true },
    criticalSignals: ['fixture'],
    overRefusal: 'fixture policy',
    scope: 'development-only-automatic-selection-gate-not-human-review',
  };
  scoringPolicy.sha256 = crypto.createHash('sha256').update('fixture').digest('hex');
  const manifest = {
    schema: isV051 ? 'com.saferide.ai.v051-development-panel-input' : 'com.saferide.ai.v05-development-panel-input',
    schemaVersion: 1,
    panelId: `saferide-${version}-development-panel-${'c'.repeat(12)}-${'d'.repeat(12)}`,
    createdAt: '2026-08-03T00:00:00.000Z',
    issue: 'ESH-4198',
    sourceCommit: 'e'.repeat(40),
    datasetId: isV051 ? 'saferide-synthetic-guidance-v0.5.1' : 'saferide-synthetic-guidance-v0.5.0',
    baseModel: {
      modelId: 'google/gemma-4-E2B-it', revision: '70af34e20bd4b7a91f0de6b22675850c43922a03',
      inputManifest: {
        path: 'manifests/sagemaker-input-manifest.json',
        sha256: packageFiles.find(file => file.path === 'manifests/sagemaker-input-manifest.json').sha256,
      },
      files: modelNames.map((name, index) => ({ path: name, sha256: sha(String((index + 1) % 10)), sizeBytes: index + 1 })),
    },
    candidates,
    repeatability: {
      status: 'passed',
      evidence: {
        path: 'manifests/candidate-repeatability.json',
        sha256: packageFiles.find(file => file.path === 'manifests/candidate-repeatability.json').sha256,
      },
    },
    generationConfig: { doSample: false, maxNewTokens: 192, maxSequenceLength: 1024, repetitionPenalty: 1.05 },
    selectionPolicy: {
      criticalFailuresMaximum: 0, maximumDevelopmentOverRefusalRate: 0.1,
      minimumDevelopmentUsefulnessAverage: 2.7, maximumOverRefusalRegression: 0.1,
      maximumUsefulnessRegression: 0.1,
    },
    scoringPolicy,
    packageFiles,
  };
  if (isV051) {
    manifest.executionScript = 'code/saferide-gemma4-v051-development-panel.py';
    manifest.suites = [
      {
        suiteId: 'original-development', split: 'dev', requiredCount: 300,
        data: packageFiles.find(file => file.path === 'data/dev.jsonl'),
        rowInventorySha256: sha('f'), selectionUse: 'blocking-eligibility',
      },
      {
        suiteId: 'mitigation-development', split: 'mitigation-dev', requiredCount: 20,
        data: packageFiles.find(file => file.path === 'data/mitigation-development.jsonl'),
        rowInventorySha256: sha('9'), selectionUse: 'blocking-eligibility',
      },
    ];
    manifest.privacy = {
      classification: 'controlled-development-only', syntheticOnly: true,
      containsMitigationHoldoutRows: false, containsProtectedV05Rows: false,
      containsBlindPrompts: false, containsReviewerIdentity: false,
      rawContentLogging: 'forbidden', promotionEligible: false,
    };
  } else {
    manifest.suite = {
      suiteId: 'development', requiredCount: 300,
      data: packageFiles.find(file => file.path === 'data/dev.jsonl'),
      rowInventorySha256: sha('f'), holdoutRowsPresent: false, blindPromptsPresent: false,
    };
    manifest.privacy = {
      classification: 'controlled-development-only', syntheticOnly: true,
      containsHoldoutRows: false, containsBlindPrompts: false, containsReviewerIdentity: false,
      rawContentLogging: 'forbidden', promotionEligible: false,
    };
  }
  fs.writeFileSync(path.join(root, 'panel-input-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return { root, manifest };
}

function holdoutFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'saferide-v051-holdout-'));
  const write = (relative, value = relative) => {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, value, { mode: 0o600 });
    return { path: relative, sha256: fileSha256(target), sizeBytes: fs.statSync(target).size };
  };
  const packageFiles = [
    write('code/saferide-gemma4-v05-development-panel.py'),
    write('code/saferide-gemma4-v051-development-panel.py'),
    write('code/saferide-gemma4-v051-holdout.py'),
    write('data/mitigation-holdout.jsonl'),
    write('manifests/training-selection.json'),
    write('manifests/selected-candidate.json'),
    write('manifests/sagemaker-input-manifest.json'),
    write('manifests/one-time-access-receipt.json'),
  ];
  const adapterFiles = [
    'README.md', 'adapter_config.json', 'adapter_model.safetensors',
    'chat_template.jinja', 'tokenizer.json', 'tokenizer_config.json',
  ].map(name => write(`adapters/419806/${name}`));
  packageFiles.push(...adapterFiles);
  const modelNames = [
    '.gitattributes', 'README.md', 'chat_template.jinja', 'config.json', 'generation_config.json',
    'model.safetensors', 'processor_config.json', 'tokenizer.json', 'tokenizer_config.json',
  ];
  const scoringPolicy = {
    policyId: 'saferide-v05-development-panel-deterministic-rubric.1',
    usefulnessScale: [0, 1, 2, 3], alignment: { fixture: true }, criticalSignals: ['fixture'],
    overRefusal: 'fixture policy', scope: 'development-only-automatic-selection-gate-not-human-review',
    sha256: sha('e'),
  };
  const manifest = {
    schema: 'com.saferide.ai.v051-mitigation-holdout-input', schemaVersion: 1,
    evaluationId: `saferide-v051-mitigation-holdout-${'a'.repeat(12)}-${'b'.repeat(12)}`,
    createdAt: '2026-08-04T00:00:00.000Z', issue: 'ESH-4198', sourceCommit: 'c'.repeat(40),
    datasetId: 'saferide-synthetic-guidance-v0.5.1', executionScript: 'code/saferide-gemma4-v051-holdout.py',
    selection: {
      path: 'manifests/training-selection.json',
      sha256: packageFiles.find(file => file.path === 'manifests/training-selection.json').sha256,
      status: 'selected', selectedRunId: 'fixture-candidate-seed-419806', selectedSeed: 419806,
      panelSummarySha256: sha('d'),
    },
    accessReceipt: {
      path: 'manifests/one-time-access-receipt.json',
      sha256: packageFiles.find(file => file.path === 'manifests/one-time-access-receipt.json').sha256,
    },
    suite: {
      suiteId: 'mitigation-holdout', split: 'mitigation-holdout', requiredCount: 20,
      data: packageFiles.find(file => file.path === 'data/mitigation-holdout.jsonl'),
      rowInventorySha256: sha('f'), selectionUse: 'post-selection-only',
    },
    baseModel: {
      modelId: 'google/gemma-4-E2B-it', revision: '70af34e20bd4b7a91f0de6b22675850c43922a03',
      inputManifest: {
        path: 'manifests/sagemaker-input-manifest.json',
        sha256: packageFiles.find(file => file.path === 'manifests/sagemaker-input-manifest.json').sha256,
      },
      files: modelNames.map((name, index) => ({ path: name, sha256: sha(String((index + 1) % 10)), sizeBytes: index + 1 })),
    },
    candidate: {
      seed: 419806, runId: 'fixture-candidate-seed-419806',
      manifest: {
        path: 'manifests/selected-candidate.json',
        sha256: packageFiles.find(file => file.path === 'manifests/selected-candidate.json').sha256,
      },
      bestCheckpoint: 'checkpoint-200', developmentAssistantTokenLoss: 0.4,
      adapterRoot: 'adapters/419806', adapterInventorySha256: sha('9'), adapterFiles,
    },
    generationConfig: { doSample: false, maxNewTokens: 192, maxSequenceLength: 1024, repetitionPenalty: 1.05 },
    evaluationPolicy: {
      criticalFailuresMaximum: 0, generationErrorsMaximum: 0, maximumOverRefusalRate: 0.1,
      minimumUsefulnessAverage: 2.7, maximumOverRefusalRegression: 0.1, maximumUsefulnessRegression: 0.1,
    },
    scoringPolicy, packageFiles,
    privacy: {
      classification: 'restricted-post-selection-evaluation', syntheticOnly: true,
      containsMitigationHoldoutRows: true, openedAfterTechnicalSelection: true,
      containsProtectedV05Rows: false, containsBlindPrompts: false, containsReviewerIdentity: false,
      rawContentLogging: 'forbidden', promotionEligible: false,
    },
  };
  fs.writeFileSync(path.join(root, 'panel-input-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return { root, manifest };
}

test('development-only package validates exact files and fixed candidates', () => {
  const { root, manifest } = fixture();
  try {
    assert.deepEqual(validatePanelInput(manifest, root), []);
    const drifted = structuredClone(manifest);
    drifted.privacy.containsHoldoutRows = true;
    assert.match(validatePanelInput(drifted, root).join('\n'), /must be equal to constant|development rows only/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('v0.5.1 package validates both development suites while excluding sealed data', () => {
  const { root, manifest } = fixture('v051');
  try {
    assert.deepEqual(validatePanelInput(manifest, root), []);
    const drifted = structuredClone(manifest);
    drifted.privacy.containsMitigationHoldoutRows = true;
    assert.match(validatePanelInput(drifted, root).join('\n'), /must be equal to constant|development rows only/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('post-selection holdout package requires explicit one-time protected access', () => {
  const { root, manifest } = holdoutFixture();
  try {
    assert.deepEqual(validatePanelInput(manifest, root), []);
    const drifted = structuredClone(manifest);
    drifted.privacy.openedAfterTechnicalSelection = false;
    assert.match(validatePanelInput(drifted, root).join('\n'), /must be equal to constant|development rows only/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('panel job uses only panel and base-model channels with offline controls', () => {
  const receipt = {
    bucket: 'controlled-panel-bucket',
    scriptRelativePath: 'code/saferide-gemma4-v05-development-panel.py',
    s3Prefix: 's3://controlled-panel-bucket/saferide/v05/sagemaker/panels/inputs/fixture/',
    baseModelS3Prefix: 's3://controlled-panel-bucket/saferide/v05/sagemaker/inputs/model/',
    manifestSha256: sha('a'),
    sourceCommit: 'b'.repeat(40),
  };
  const spec = buildPanelJobSpec({
    receipt,
    roleArn: 'arn:aws:iam::123456789012:role/SafeRideSageMakerTrainingRole',
    imageUri: '123456789012.dkr.ecr.eu-central-1.amazonaws.com/saferide/gemma4-v05:commit-fixture',
    imageDigest: sha('c'),
    jobName: 'saferide-v05-dev-panel-fixture-20260803',
    outputS3Uri: 's3://controlled-panel-bucket/saferide/v05/sagemaker/panels/runs/fixture/',
  });
  assert.deepEqual(spec.InputDataConfig.map(channel => channel.ChannelName), ['panel', 'model']);
  assert.equal(spec.EnableNetworkIsolation, true);
  assert.equal(spec.EnableInterContainerTrafficEncryption, true);
  assert.equal(spec.RetryStrategy.MaximumRetryAttempts, 1);
  assert.match(spec.AlgorithmSpecification.ContainerEntrypoint.join(' '), /development-panel\.py run/);
  assert.equal(spec.Tags.find(tag => tag.Key === 'DataClassification').Value, 'ControlledDevelopmentOnly');
});

test('panel job refuses a different output bucket', () => {
  assert.throws(() => buildPanelJobSpec({
    receipt: {
      bucket: 'controlled-panel-bucket', scriptRelativePath: 'code/panel.py',
      s3Prefix: 's3://controlled-panel-bucket/input/', baseModelS3Prefix: 's3://controlled-panel-bucket/model/',
      manifestSha256: sha('a'), sourceCommit: 'b'.repeat(40),
    },
    roleArn: 'arn:aws:iam::123456789012:role/SafeRideSageMakerTrainingRole',
    imageUri: '123456789012.dkr.ecr.eu-central-1.amazonaws.com/saferide/gemma4-v05:fixture',
    imageDigest: sha('c'),
    jobName: 'saferide-v05-dev-panel-fixture-20260803',
    outputS3Uri: 's3://different-bucket/output/',
  }), /controlled input bucket/);
});

test('v0.5.1 panel job retains offline controls and explicit dataset tagging', () => {
  const spec = buildPanelJobSpec({
    receipt: {
      bucket: 'controlled-panel-bucket', scriptRelativePath: 'code/saferide-gemma4-v051-development-panel.py',
      s3Prefix: 's3://controlled-panel-bucket/saferide/v051/panels/input/',
      baseModelS3Prefix: 's3://controlled-panel-bucket/model/', manifestSha256: sha('a'),
      sourceCommit: 'b'.repeat(40), datasetVersion: 'v051',
    },
    roleArn: 'arn:aws:iam::123456789012:role/SafeRideSageMakerTrainingRole',
    imageUri: '123456789012.dkr.ecr.eu-central-1.amazonaws.com/saferide/gemma4-v05:fixture',
    imageDigest: sha('c'), jobName: 'saferide-v051-dev-panel-fixture-20260804',
    outputS3Uri: 's3://controlled-panel-bucket/saferide/v051/panels/output/',
  });
  assert.equal(spec.EnableNetworkIsolation, true);
  assert.equal(spec.Tags.find(tag => tag.Key === 'Dataset').Value, 'v0.5.1-development-only');
  assert.match(spec.AlgorithmSpecification.ContainerEntrypoint.join(' '), /v051-development-panel\.py run/);
});

test('mitigation holdout job remains offline and is classified post-selection', () => {
  const spec = buildPanelJobSpec({
    receipt: {
      bucket: 'controlled-panel-bucket', scriptRelativePath: 'code/saferide-gemma4-v051-holdout.py',
      s3Prefix: 's3://controlled-panel-bucket/saferide/v051/holdouts/input/',
      baseModelS3Prefix: 's3://controlled-panel-bucket/model/', manifestSha256: sha('a'),
      sourceCommit: 'b'.repeat(40), datasetVersion: 'v051', runKind: 'mitigation-holdout-evaluation',
    },
    roleArn: 'arn:aws:iam::123456789012:role/SafeRideSageMakerTrainingRole',
    imageUri: '123456789012.dkr.ecr.eu-central-1.amazonaws.com/saferide/gemma4-v05:fixture',
    imageDigest: sha('c'), jobName: 'saferide-v051-mitigation-holdout-fixture-20260804',
    outputS3Uri: 's3://controlled-panel-bucket/saferide/v051/holdouts/output/',
  });
  assert.equal(spec.EnableNetworkIsolation, true);
  assert.equal(spec.Tags.find(tag => tag.Key === 'DataClassification').Value, 'RestrictedPostSelection');
  assert.match(spec.AlgorithmSpecification.ContainerEntrypoint.join(' '), /v051-holdout\.py run/);
});

test('v0.5.3 pilot panel uses the focused mitigation dataset tag and script', () => {
  const spec = buildPanelJobSpec({
    receipt: {
      bucket: 'controlled-panel-bucket', scriptRelativePath: 'code/saferide-gemma4-v053-pilot-panel.py',
      s3Prefix: 's3://controlled-panel-bucket/saferide/v053/panels/input/',
      baseModelS3Prefix: 's3://controlled-panel-bucket/model/', manifestSha256: sha('a'),
      sourceCommit: 'b'.repeat(40), datasetVersion: 'v053', runKind: 'pilot-development-generation-panel',
    },
    roleArn: 'arn:aws:iam::123456789012:role/SafeRideSageMakerTrainingRole',
    imageUri: '123456789012.dkr.ecr.eu-central-1.amazonaws.com/saferide/gemma4-v05:fixture',
    imageDigest: sha('c'), jobName: 'saferide-v053-pilot-panel-fixture-20260806',
    outputS3Uri: 's3://controlled-panel-bucket/saferide/v053/panels/output/',
  });
  assert.equal(spec.Tags.find(tag => tag.Key === 'Dataset').Value, 'v0.5.3-pilot-development-only');
  assert.match(spec.AlgorithmSpecification.ContainerEntrypoint.join(' '), /v053-pilot-panel\.py run/);
});

test('v0.5.2 pilot summary binds archived base comparison and remains non-promotable', () => {
  const suite = (suiteId, requiredCount) => ({
    suiteId, requiredCount, dataSha256: sha('1'), rowInventorySha256: sha('2'),
    coverage: {
      candidate: { rowCount: requiredCount, completed: requiredCount, truncated: 0, errors: 0 },
      base: { rowCount: requiredCount, completed: requiredCount, truncated: 0, errors: 0 },
    },
    metrics: {
      criticalFailures: 0, overRefusalRate: 0, usefulnessAverage: 2.8,
      baseCriticalFailures: 0, baseOverRefusalRate: 0, baseUsefulnessAverage: 1.4,
    },
    rawArtifacts: {
      classification: 'controlled-synthetic-raw', candidateBundleSha256: sha('3'),
      baseBundleSha256: sha('4'), baseOutputsRegenerated: false,
    },
    eligibility: { eligible: true, reasons: [] },
  });
  const summary = {
    schema: 'com.saferide.ai.v052-pilot-panel-summary', schemaVersion: 1,
    summaryId: `saferide-v052-pilot-panel-${'a'.repeat(12)}-${'b'.repeat(12)}-seed-419805`,
    createdAt: '2026-08-04T16:00:00.000Z', issue: 'ESH-4198', status: 'passed',
    datasetId: 'saferide-synthetic-guidance-v0.5.2',
    baseModel: { modelId: 'google/gemma-4-E2B-it', revision: '70af34e20bd4b7a91f0de6b22675850c43922a03' },
    candidate: {
      seed: 419805, runId: 'saferide-v052-pilot-fixture-20260804', runKind: 'pilot',
      manifestSha256: sha('5'), bestCheckpoint: 'checkpoint-225', developmentAssistantTokenLoss: 2.1,
      adapterInventorySha256: sha('6'),
      finiteTensorGate: { tensorCount: 205, elementCount: 1000, nonFiniteTensorCount: 0 },
    },
    provenance: {
      panelInputSha256: sha('7'), sourceCommit: '8'.repeat(40), imageDigest: sha('9'),
      jobNameSha256: sha('a'), scoringPolicySha256: sha('b'), baseComparatorDiagnosisSha256: sha('c'),
    },
    generation: { doSample: false, maxNewTokens: 192, maxSequenceLength: 1024, repetitionPenalty: 1.05 },
    executionPolicy: {
      generationBatchSize: 2, batchOrder: 'suite-order-then-canonical-row-id',
      paddingSide: 'left', decoding: 'deterministic-greedy-no-sampling',
    },
    suiteResults: [suite('original-development', 300), suite('mitigation-development', 20)],
    eligibility: { eligible: true, reasons: [] },
    selectionPolicy: {
      criticalFailuresMaximum: 0, maximumDevelopmentOverRefusalRate: 0.1,
      minimumDevelopmentUsefulnessAverage: 2.7, maximumOverRefusalRegression: 0.1,
      maximumUsefulnessRegression: 0.1,
    },
    privacy: {
      summaryContainsRawPrompts: false, summaryContainsRawCompletions: false,
      mitigationHoldoutRead: false, protectedV05RowsRead: false, blindPromptsRead: false,
      baseOutputsRegenerated: false, humanReviewClaimed: false, classification: 'controlled-content-free',
    },
    promotionEligible: false, fullCandidateSubmissionAuthorized: false,
  };
  assert.deepEqual(validateV052PilotSummary(summary), []);
  summary.promotionEligible = true;
  assert.match(validateV052PilotSummary(summary).join('\n'), /must be equal to constant/);
});
