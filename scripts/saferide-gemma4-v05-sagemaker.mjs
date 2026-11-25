#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultPolicyPath = path.join(repoRoot, 'config/ai/training/saferide-gemma4-v05-sagemaker-policy.json');
const v051PolicyPath = path.join(repoRoot, 'config/ai/training/saferide-gemma4-v051-sagemaker-policy.json');
const v052PolicyPath = path.join(repoRoot, 'config/ai/training/saferide-gemma4-v052-sagemaker-policy.json');
const v053PolicyPath = path.join(repoRoot, 'config/ai/training/saferide-gemma4-v053-sagemaker-policy.json');
const policySchemaPath = path.join(repoRoot, 'schemas/ai-v05-sagemaker-policy.schema.json');
const inputSchemaPath = path.join(repoRoot, 'schemas/ai-v05-sagemaker-input-manifest.schema.json');
const launchSchemaPath = path.join(repoRoot, 'schemas/ai-v05-sagemaker-launch-plan.schema.json');
const shaPattern = /^[a-f0-9]{64}$/;
const commitPattern = /^[a-f0-9]{40}$/;
const forbiddenTrainingPath = /(?:^|\/)(?:quality-holdout|safety-holdout|blind|reviews?|candidates?|approvals?)(?:\/|$)/i;
const expectedModelFiles = [
  '.gitattributes', 'README.md', 'chat_template.jinja', 'config.json', 'generation_config.json',
  'model.safetensors', 'processor_config.json', 'tokenizer.json', 'tokenizer_config.json',
];

function datasetVersion(datasetId) {
  if (datasetId.endsWith('0.5.3')) return 'v053';
  if (datasetId.endsWith('0.5.2')) return 'v052';
  if (datasetId.endsWith('0.5.1')) return 'v051';
  return 'v05';
}

function expectedTrainRows(datasetId) {
  if (datasetId.endsWith('0.5.3')) return 1832;
  if (datasetId.endsWith('0.5.2')) return 1768;
  if (datasetId.endsWith('0.5.1')) return 1720;
  return 1600;
}

function datasetTag(datasetId) {
  if (datasetId.endsWith('0.5.3')) return 'v0.5.3';
  if (datasetId.endsWith('0.5.2')) return 'v0.5.2';
  if (datasetId.endsWith('0.5.1')) return 'v0.5.1';
  return 'v0.5';
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

export function fileSha256(file) {
  return sha256(fs.readFileSync(file));
}

function compiler(schemaPath) {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    strictRequired: false,
    strictTypes: false,
    formats: { 'date-time': true },
  });
  return ajv.compile(readJson(schemaPath));
}

const validatePolicySchema = compiler(policySchemaPath);
const validateInputSchema = compiler(inputSchemaPath);
const validateLaunchSchema = compiler(launchSchemaPath);

function schemaFindings(label, validator, value) {
  if (validator(value)) return [];
  return (validator.errors ?? []).map(error => `${label}${error.instancePath || '/'}: ${error.message ?? error.keyword}`);
}

function safeRelative(relative) {
  return typeof relative === 'string'
    && relative.length > 0
    && !path.isAbsolute(relative)
    && !relative.split(/[\\/]/).includes('..')
    && !relative.includes('\\');
}

function parseS3Uri(uri) {
  if (typeof uri !== 'string' || !uri.startsWith('s3://')) throw new Error('Expected an S3 URI');
  const [bucket, ...parts] = uri.slice(5).split('/');
  if (!bucket || parts.length === 0 || !parts.join('/')) throw new Error('S3 URI must include a bucket and key');
  return { bucket, key: parts.join('/') };
}

function s3Parent(uri) {
  const index = uri.lastIndexOf('/');
  return `${uri.slice(0, index + 1)}`;
}

function s3Bucket(uri) {
  try {
    return parseS3Uri(uri).bucket;
  } catch {
    return '';
  }
}

function assertValid(label, errors) {
  if (errors.length) throw new Error(`${label} failed:\n- ${errors.join('\n- ')}`);
}

export function validateSageMakerPolicy(policy) {
  const errors = schemaFindings('policy', validatePolicySchema, policy);
  const trainRows = policy.training?.candidate?.trainRows;
  const expectedPilotRates = trainRows === 1832 ? '0.00001' : trainRows === 1768 ? '0.00002' : '0.00001,0.00002';
  const expectedQuotaCodes = { 'ml.g5.xlarge': 'L-B6D80D9C' };
  if (policy.training?.pilot?.learningRates?.join(',') !== expectedPilotRates) errors.push('policy pilot learning-rate recipe differs from its governed dataset version');
  if (![1600, 1720, 1768, 1832].includes(trainRows) || policy.training?.candidate?.devRows !== 300) errors.push('policy must bind a governed v0.5-series train count and evaluate on 300 development rows');
  if (policy.instance?.count !== 1) errors.push('single-GPU deterministic training requires exactly one instance');
  if (policy.instance?.quotaCode !== expectedQuotaCodes[policy.instance?.type]) errors.push('policy quota code must identify the governed SageMaker training-job quota for the instance type');
  return errors;
}

export function validateInputManifest(manifest, options = {}) {
  const errors = schemaFindings('inputManifest', validateInputSchema, manifest);
  const files = manifest.baseModel?.files ?? [];
  const paths = files.map(file => file.path);
  if (new Set(paths).size !== paths.length) errors.push('base-model file paths must be unique');
  if (JSON.stringify(paths) !== JSON.stringify(expectedModelFiles)) errors.push('base-model inventory must match the exact pinned nine-file snapshot in canonical order');
  if (files.reduce((total, file) => total + (file.sizeBytes ?? 0), 0) !== manifest.baseModel?.totalBytes) errors.push('base-model totalBytes differs from the file inventory');
  if (files.length !== manifest.baseModel?.fileCount) errors.push('base-model fileCount differs from the file inventory');
  for (const required of ['config.json', 'model.safetensors', 'tokenizer_config.json']) {
    if (!paths.includes(required)) errors.push(`base-model inventory is missing ${required}`);
  }
  if (!paths.some(file => ['tokenizer.json', 'tokenizer.model'].includes(file))) errors.push('base-model inventory lacks tokenizer bytes');
  for (const file of files) {
    if (!safeRelative(file.path)) errors.push(`base-model path is unsafe: ${file.path}`);
    if (forbiddenTrainingPath.test(file.path)) errors.push(`base-model path uses a forbidden training classification: ${file.path}`);
    if (s3Bucket(file.s3Uri ?? 's3://invalid/key') !== manifest.storage?.bucket) errors.push(`base-model object uses a different bucket: ${file.path}`);
    if (!(file.s3Uri ?? '').startsWith(manifest.baseModel?.s3Prefix ?? 'missing')) errors.push(`base-model object is outside the frozen model prefix: ${file.path}`);
  }
  if (forbiddenTrainingPath.test(manifest.trainingArchive?.s3Uri ?? '')) errors.push('training archive URI contains a forbidden restricted-data path');
  if (s3Bucket(manifest.trainingArchive?.s3Uri ?? 's3://invalid/key') !== manifest.storage?.bucket) errors.push('training archive uses a different bucket');
  if (!manifest.trainingArchive?.s3Uri?.startsWith(`s3://${manifest.storage?.bucket}/${manifest.storage?.prefix}handoff/`)) errors.push('training archive is outside the immutable handoff prefix');
  if (options.archivePath) {
    const archive = path.resolve(options.archivePath);
    if (!fs.existsSync(archive) || !fs.statSync(archive).isFile()) errors.push('training archive is unavailable');
    else if (fileSha256(archive) !== manifest.trainingArchive.sha256 || fs.statSync(archive).size !== manifest.trainingArchive.sizeBytes) errors.push('training archive bytes differ from the manifest');
  }
  if (options.modelRoot) {
    const root = path.resolve(options.modelRoot);
    for (const file of files) {
      const target = path.resolve(root, file.path);
      if (!target.startsWith(`${root}${path.sep}`)) {
        errors.push(`base-model file escapes the model root: ${file.path}`);
        continue;
      }
      if (!fs.existsSync(target) || !fs.statSync(target).isFile()) errors.push(`base-model file is unavailable: ${file.path}`);
      else if (fs.statSync(target).size !== file.sizeBytes || fileSha256(target) !== file.sha256) errors.push(`base-model file bytes differ: ${file.path}`);
    }
  }
  return errors;
}

function runShape(runKind, seed, learningRate, pairedRunId) {
  if (!['preflight', 'pilot', 'candidate'].includes(runKind)) throw new Error('run kind must be preflight, pilot, or candidate');
  if (![419805, 419806].includes(seed)) throw new Error('seed must be 419805 or 419806');
  if (![1e-5, 2e-5].includes(learningRate)) throw new Error('learning rate must be 1e-5 or 2e-5');
  if (runKind === 'preflight' && (seed !== 419805 || learningRate !== 1e-5 || pairedRunId)) throw new Error('preflight requires seed 419805, learning rate 1e-5, and no paired run');
  if (runKind === 'pilot' && (seed !== 419805 || pairedRunId)) throw new Error('pilot requires seed 419805 and no paired run');
  if (runKind === 'candidate' && seed === 419805 && pairedRunId) throw new Error('first candidate seed must not name a paired run');
  if (runKind === 'candidate' && seed === 419806 && !pairedRunId) throw new Error('second candidate seed must bind the first candidate run');
  return { maxSteps: runKind === 'preflight' ? 1 : null, pairedRunId: pairedRunId ?? null };
}

export function buildLaunchPlan({
  policy,
  inputManifest,
  inputManifestPath,
  inputManifestSha256,
  inputManifestS3Uri,
  inputManifestVersionId,
  datasetSourceCommit,
  launcherSourceCommit,
  runKind,
  runId,
  seed,
  learningRate,
  pairedRunId = null,
  roleArn,
  imageUri,
  imageDigest,
  outputS3Uri,
  checkpointS3Uri,
  createdAt = new Date().toISOString(),
}) {
  assertValid('SageMaker policy', validateSageMakerPolicy(policy));
  assertValid('SageMaker input manifest', validateInputManifest(inputManifest));
  const requiredTrainRows = expectedTrainRows(inputManifest.datasetId);
  if (policy.training?.candidate?.trainRows !== requiredTrainRows) throw new Error(`SageMaker policy train-row count must be ${requiredTrainRows} for the staged dataset`);
  if (inputManifest.datasetId.endsWith('0.5.2') && runKind === 'candidate') throw new Error('v0.5.2 full candidate submission is not authorized');
  if (inputManifest.datasetId.endsWith('0.5.2') && runKind === 'pilot' && Number(learningRate) !== 2e-5) throw new Error('v0.5.2 pilot must use the frozen 2e-5 learning rate');
  if (inputManifest.datasetId.endsWith('0.5.3') && runKind === 'candidate') throw new Error('v0.5.3 full candidate submission is not authorized');
  if (inputManifest.datasetId.endsWith('0.5.3') && runKind === 'pilot' && Number(learningRate) !== 1e-5) throw new Error('v0.5.3 pilot must use the frozen 1e-5 learning rate');
  if (datasetSourceCommit !== inputManifest.sourceCommit || !commitPattern.test(datasetSourceCommit)) throw new Error('dataset source commit must equal the staged input source commit');
  if (!commitPattern.test(launcherSourceCommit)) throw new Error('launcher source commit must be an immutable 40-character Git commit');
  if (!shaPattern.test(inputManifestSha256) || fileSha256(inputManifestPath) !== inputManifestSha256) throw new Error('input-manifest file hash is missing or stale');
  if (!shaPattern.test(imageDigest)) throw new Error('training image digest must be a lowercase SHA-256');
  if (!inputManifestS3Uri.startsWith(s3Parent(inputManifest.trainingArchive.s3Uri))) throw new Error('input manifest and training archive must share the immutable handoff prefix');
  if (s3Bucket(outputS3Uri) !== inputManifest.storage.bucket || s3Bucket(checkpointS3Uri) !== inputManifest.storage.bucket) throw new Error('outputs and checkpoints must use the controlled input bucket');
  if (!outputS3Uri.endsWith('/') || !checkpointS3Uri.endsWith('/')) throw new Error('output and checkpoint S3 URIs must end with /');
  const shape = runShape(runKind, Number(seed), Number(learningRate), pairedRunId);
  const plan = {
    schema: 'com.saferide.ai.v05-sagemaker-launch-plan',
    schemaVersion: 1,
    launchId: `saferide-${datasetVersion(inputManifest.datasetId)}-sagemaker-launch-${runId.replace(/^saferide-v05(?:1|2|3)?-/, '')}`,
    createdAt,
    launcherSourceCommit,
    datasetSourceCommit,
    datasetId: inputManifest.datasetId,
    status: 'ready',
    runKind,
    runId,
    region: policy.region,
    roleArn,
    image: { uri: imageUri, digest: imageDigest },
    inputManifest: {
      path: inputManifestPath,
      sha256: inputManifestSha256,
      s3Uri: inputManifestS3Uri,
      versionId: inputManifestVersionId,
    },
    instance: {
      type: policy.instance.type,
      count: policy.instance.count,
      volumeSizeGb: policy.instance.volumeSizeGb,
      maxRuntimeSeconds: runKind === 'preflight' ? 3600 : runKind === 'pilot' ? 14400 : 21600,
    },
    hyperparameters: {
      seed: Number(seed),
      learningRate: Number(learningRate),
      epochs: 1,
      maxSteps: shape.maxSteps,
      pairedRunId: shape.pairedRunId,
    },
    output: { s3Uri: outputS3Uri, checkpointS3Uri },
    security: {
      networkIsolation: policy.security.networkIsolation,
      interContainerTrafficEncryption: policy.security.interContainerTrafficEncryption,
      trainingChannels: ['handoff', 'model'],
    },
    privacy: {
      containsHoldouts: false,
      containsBlindPrompts: false,
      containsReviewerIdentity: false,
      containsCredentials: false,
      rawContentLogging: 'forbidden',
    },
  };
  assertValid('SageMaker launch plan', schemaFindings('launchPlan', validateLaunchSchema, plan));
  return plan;
}

export function buildTrainingJobSpec(plan, inputManifest, inputManifestSha256, policy = readJson(defaultPolicyPath)) {
  assertValid('SageMaker launch plan', schemaFindings('launchPlan', validateLaunchSchema, plan));
  assertValid('SageMaker input manifest', validateInputManifest(inputManifest));
  if (plan.inputManifest.sha256 !== inputManifestSha256) throw new Error('launch plan input-manifest hash is stale');
  if (plan.datasetSourceCommit !== inputManifest.sourceCommit) throw new Error('launch plan dataset source commit is stale');
  const requiredTrainRows = expectedTrainRows(inputManifest.datasetId);
  if (policy.training?.candidate?.trainRows !== requiredTrainRows) throw new Error(`SageMaker policy train-row count must be ${requiredTrainRows} for the staged dataset`);
  const fixed = policy.training.fixed;
  const hyperParameters = {
    'run-kind': plan.runKind,
    'run-id': plan.runId,
    seed: String(plan.hyperparameters.seed),
    'learning-rate': String(plan.hyperparameters.learningRate),
    epochs: String(plan.hyperparameters.epochs),
    'max-seq-length': String(fixed.maxSequenceLength),
    'train-batch-size': String(fixed.trainBatchSize),
    'eval-batch-size': String(fixed.evalBatchSize),
    'gradient-accumulation-steps': String(fixed.gradientAccumulationSteps),
    'lora-r': String(fixed.loraRank),
    'lora-alpha': String(fixed.loraAlpha),
    'lora-dropout': String(fixed.loraDropout),
    'warmup-ratio': String(fixed.warmupRatio),
    'lr-scheduler-type': fixed.scheduler,
    'eval-steps': String(plan.runKind === 'preflight' ? 1 : fixed.evalSteps),
    'save-steps': String(plan.runKind === 'preflight' ? 1 : fixed.saveSteps),
    'early-stopping-patience': String(fixed.earlyStoppingPatience),
  };
  if (plan.hyperparameters.maxSteps !== null) hyperParameters['max-steps'] = String(plan.hyperparameters.maxSteps);
  if (plan.hyperparameters.pairedRunId) hyperParameters['paired-run-id'] = plan.hyperparameters.pairedRunId;
  return {
    TrainingJobName: plan.runId,
    AlgorithmSpecification: {
      TrainingImage: plan.image.uri,
      TrainingInputMode: 'File',
      EnableSageMakerMetricsTimeSeries: true,
      MetricDefinitions: [
        { Name: 'train:loss', Regex: "'loss': ([0-9.eE+-]+)" },
        { Name: 'validation:loss', Regex: "'eval_loss': ([0-9.eE+-]+)" },
      ],
    },
    RoleArn: plan.roleArn,
    InputDataConfig: [
      {
        ChannelName: 'handoff',
        DataSource: { S3DataSource: { S3DataType: 'S3Prefix', S3Uri: s3Parent(inputManifest.trainingArchive.s3Uri), S3DataDistributionType: 'FullyReplicated' } },
        InputMode: 'File',
      },
      {
        ChannelName: 'model',
        DataSource: { S3DataSource: { S3DataType: 'S3Prefix', S3Uri: inputManifest.baseModel.s3Prefix, S3DataDistributionType: 'FullyReplicated' } },
        InputMode: 'File',
      },
    ],
    OutputDataConfig: { S3OutputPath: plan.output.s3Uri },
    CheckpointConfig: { S3Uri: plan.output.checkpointS3Uri, LocalPath: '/opt/ml/checkpoints' },
    ResourceConfig: { InstanceType: plan.instance.type, InstanceCount: plan.instance.count, VolumeSizeInGB: plan.instance.volumeSizeGb },
    StoppingCondition: { MaxRuntimeInSeconds: plan.instance.maxRuntimeSeconds },
    RetryStrategy: { MaximumRetryAttempts: 1 },
    EnableManagedSpotTraining: false,
    EnableNetworkIsolation: true,
    EnableInterContainerTrafficEncryption: true,
    HyperParameters: hyperParameters,
    Environment: {
      SAFERIDE_SAGEMAKER_INPUT_MANIFEST_SHA256: plan.inputManifest.sha256,
      SAFERIDE_SAGEMAKER_IMAGE_DIGEST: plan.image.digest,
      SAFERIDE_LAUNCHER_SOURCE_COMMIT: plan.launcherSourceCommit,
      SAFERIDE_DATASET_SOURCE_COMMIT: plan.datasetSourceCommit,
    },
    Tags: [
      { Key: 'Project', Value: 'SafeRide' },
      { Key: 'Issue', Value: 'ESH-4198' },
      { Key: 'Dataset', Value: datasetTag(plan.datasetId) },
      { Key: 'RunKind', Value: plan.runKind },
      { Key: 'DataClassification', Value: 'ControlledTrainingInput' },
    ],
  };
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    options[token.slice(2)] = rest[++index];
  }
  return { command, options };
}

function required(options, key) {
  if (!options[key]) throw new Error(`Missing --${key}`);
  return options[key];
}

function writePrivateJson(target, value) {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(target, 0o600);
}

function awsJson(profile, region, args) {
  const result = spawnSync('aws', [...args, '--profile', profile, '--region', region, '--output', 'json'], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`AWS verification command failed: aws ${args.slice(0, 2).join(' ')}`);
  return result.stdout.trim() ? JSON.parse(result.stdout) : {};
}

function verifyRemoteObject(profile, region, expected) {
  const { bucket, key } = parseS3Uri(expected.s3Uri);
  const head = awsJson(profile, region, [
    's3api', 'head-object', '--bucket', bucket, '--key', key, '--version-id', expected.versionId,
  ]);
  if (Number(head.ContentLength) !== expected.sizeBytes) throw new Error(`Remote object size differs: ${path.basename(key)}`);
  if (head.Metadata?.sha256 !== expected.sha256) throw new Error(`Remote object SHA-256 metadata differs: ${path.basename(key)}`);
  if (head.VersionId !== expected.versionId) throw new Error(`Remote object version differs: ${path.basename(key)}`);
  if (head.ServerSideEncryption !== 'AES256') throw new Error(`Remote object encryption differs: ${path.basename(key)}`);
}

function parseEcrImage(uri) {
  const match = uri.match(/^([0-9]{12})\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com\/(.+):([^/:]+)$/);
  if (!match) throw new Error('Training image URI is not a tagged private ECR image');
  return { account: match[1], region: match[2], repository: match[3], tag: match[4] };
}

export function remotePreflight({ profile, plan, inputManifest, policy }) {
  assertValid('SageMaker launch plan', schemaFindings('launchPlan', validateLaunchSchema, plan));
  assertValid('SageMaker input manifest', validateInputManifest(inputManifest));
  verifyRemoteObject(profile, plan.region, inputManifest.trainingArchive);
  for (const file of inputManifest.baseModel.files) verifyRemoteObject(profile, plan.region, file);
  const manifestObject = { ...plan.inputManifest, sizeBytes: undefined };
  const { bucket, key } = parseS3Uri(manifestObject.s3Uri);
  const manifestHead = awsJson(profile, plan.region, [
    's3api', 'head-object', '--bucket', bucket, '--key', key, '--version-id', manifestObject.versionId,
  ]);
  if (
    manifestHead.Metadata?.sha256 !== manifestObject.sha256
    || manifestHead.ServerSideEncryption !== 'AES256'
    || manifestHead.VersionId !== manifestObject.versionId
  ) throw new Error('Remote input manifest hash, version, or encryption differs');

  const image = parseEcrImage(plan.image.uri);
  if (image.region !== plan.region) throw new Error('Training image region differs from launch region');
  const imageDescription = awsJson(profile, plan.region, [
    'ecr', 'describe-images', '--registry-id', image.account, '--repository-name', image.repository,
    '--image-ids', `imageTag=${image.tag}`,
  ]);
  const remoteDigest = imageDescription.imageDetails?.[0]?.imageDigest?.replace(/^sha256:/, '');
  if (remoteDigest !== plan.image.digest) throw new Error('Training image tag no longer resolves to the approved digest');

  const quota = awsJson(profile, plan.region, [
    'service-quotas', 'get-service-quota', '--service-code', 'sagemaker', '--quota-code', policy.instance.quotaCode,
  ]);
  if (Number(quota.Quota?.Value ?? 0) < plan.instance.count) throw new Error('Applied SageMaker training quota is below the requested instance count');

  const roleName = plan.roleArn.split('/').at(-1);
  const role = awsJson(profile, plan.region, ['iam', 'get-role', '--role-name', roleName]);
  if (role.Role?.Arn !== plan.roleArn) throw new Error('SageMaker execution role ARN differs');
  const trust = JSON.stringify(role.Role?.AssumeRolePolicyDocument ?? {});
  if (!trust.includes('sagemaker.amazonaws.com')) throw new Error('Execution role does not trust SageMaker');

  const existing = spawnSync('aws', [
    'sagemaker', 'describe-training-job', '--training-job-name', plan.runId,
    '--profile', profile, '--region', plan.region, '--output', 'json',
  ], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (existing.status === 0) throw new Error('A SageMaker training job already uses this immutable run ID');
  if (!/(ValidationException|Could not find|does not exist)/i.test(existing.stderr ?? '')) {
    throw new Error('Unable to verify SageMaker run-ID availability');
  }

  return {
    remoteObjectsVerified: inputManifest.baseModel.files.length + 2,
    imageDigestVerified: true,
    quotaVerified: true,
    executionRoleVerified: true,
    runIdAvailable: true,
  };
}

function contractCheck() {
  const policy = readJson(defaultPolicyPath);
  assertValid('SageMaker policy', validateSageMakerPolicy(policy));
  assertValid('SageMaker v0.5.1 policy', validateSageMakerPolicy(readJson(v051PolicyPath)));
  assertValid('SageMaker v0.5.2 policy', validateSageMakerPolicy(readJson(v052PolicyPath)));
  assertValid('SageMaker v0.5.3 policy', validateSageMakerPolicy(readJson(v053PolicyPath)));
  const requiredFiles = [
    'scripts/saferide-gemma4-v05-sagemaker-entrypoint.py',
    'scripts/saferide-gemma4-v05-sagemaker-stage.py',
    'infra/ai/sagemaker/gemma4-v05/Dockerfile',
  ];
  for (const relative of requiredFiles) if (!fs.existsSync(path.join(repoRoot, relative))) throw new Error(`Missing SageMaker implementation file: ${relative}`);
  if (fs.existsSync(path.join(repoRoot, 'notebooks/saferide-gemma4-e2b-colab-v05-candidate.ipynb'))) throw new Error('The retired v0.5 notebook must not remain in the active training path');
  const dockerfile = fs.readFileSync(path.join(repoRoot, requiredFiles[2]), 'utf8');
  for (const marker of [
    'ARG PYTHON_BASE_IMAGE',
    'requirements-ai-smoke.txt',
    'constraints-ai-training.txt',
    'dpkg --purge --force-depends --force-remove-essential perl-base',
    'test ! -e /usr/bin/perl',
    'ENTRYPOINT',
  ]) {
    if (!dockerfile.includes(marker)) throw new Error(`SageMaker Dockerfile is missing ${marker}`);
  }
  console.log('SafeRide Gemma 4 v0.5 SageMaker contracts PASS.');
}

function usage() {
  return [
    'Usage:',
    '  node scripts/saferide-gemma4-v05-sagemaker.mjs contract-check',
    '  node scripts/saferide-gemma4-v05-sagemaker.mjs verify-inputs --manifest <json> [--archive <tar.gz>] [--model-root <dir>]',
    '  node scripts/saferide-gemma4-v05-sagemaker.mjs build-plan --policy <json> --manifest <json> --manifest-s3-uri <s3> --manifest-version-id <id> --dataset-source-commit <sha> --launcher-source-commit <sha> --run-kind <kind> --run-id <id> --seed <n> --learning-rate <n> --role-arn <arn> --image-uri <uri> --image-digest <sha> --output-s3-uri <s3> --checkpoint-s3-uri <s3> --output <json>',
    '  node scripts/saferide-gemma4-v05-sagemaker.mjs build-job-spec --policy <json> --plan <json> --manifest <json> --output <json>',
    '  node scripts/saferide-gemma4-v05-sagemaker.mjs verify-remote --plan <json> --manifest <json> --profile <name>',
    '  node scripts/saferide-gemma4-v05-sagemaker.mjs submit --plan <json> --manifest <json> --job-spec <json> --profile <name>',
  ].join('\n');
}

function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (['--help', '-h', 'help', undefined].includes(command)) {
    console.log(usage());
    return 0;
  }
  if (command === 'contract-check') return contractCheck(), 0;
  if (command === 'verify-inputs') {
    const manifest = readJson(path.resolve(required(options, 'manifest')));
    assertValid('SageMaker input manifest', validateInputManifest(manifest, {
      archivePath: options.archive ? path.resolve(options.archive) : undefined,
      modelRoot: options['model-root'] ? path.resolve(options['model-root']) : undefined,
    }));
    console.log(`SafeRide SageMaker input manifest PASS (${manifest.baseModel.fileCount} model files; restricted evaluation bytes absent).`);
    return 0;
  }
  if (command === 'build-plan') {
    const manifestPath = path.resolve(required(options, 'manifest'));
    const manifest = readJson(manifestPath);
    const plan = buildLaunchPlan({
      policy: readJson(path.resolve(options.policy ?? defaultPolicyPath)),
      inputManifest: manifest,
      inputManifestPath: manifestPath,
      inputManifestSha256: fileSha256(manifestPath),
      inputManifestS3Uri: required(options, 'manifest-s3-uri'),
      inputManifestVersionId: required(options, 'manifest-version-id'),
      datasetSourceCommit: required(options, 'dataset-source-commit'),
      launcherSourceCommit: required(options, 'launcher-source-commit'),
      runKind: required(options, 'run-kind'),
      runId: required(options, 'run-id'),
      seed: Number(required(options, 'seed')),
      learningRate: Number(required(options, 'learning-rate')),
      pairedRunId: options['paired-run-id'] ?? null,
      roleArn: required(options, 'role-arn'),
      imageUri: required(options, 'image-uri'),
      imageDigest: required(options, 'image-digest'),
      outputS3Uri: required(options, 'output-s3-uri'),
      checkpointS3Uri: required(options, 'checkpoint-s3-uri'),
      createdAt: options['created-at'],
    });
    const output = path.resolve(required(options, 'output'));
    writePrivateJson(output, plan);
    console.log(`SageMaker launch plan written (${plan.runKind}; sha256=${fileSha256(output)}).`);
    return 0;
  }
  if (command === 'build-job-spec') {
    const plan = readJson(path.resolve(required(options, 'plan')));
    const manifestPath = path.resolve(required(options, 'manifest'));
    const manifest = readJson(manifestPath);
    const spec = buildTrainingJobSpec(plan, manifest, fileSha256(manifestPath), readJson(path.resolve(options.policy ?? defaultPolicyPath)));
    const output = path.resolve(required(options, 'output'));
    writePrivateJson(output, spec);
    console.log(`SageMaker training-job specification written (sha256=${fileSha256(output)}).`);
    return 0;
  }
  if (command === 'verify-remote' || command === 'submit') {
    const plan = readJson(path.resolve(required(options, 'plan')));
    const manifest = readJson(path.resolve(required(options, 'manifest')));
    const profile = required(options, 'profile');
    const result = remotePreflight({ profile, plan, inputManifest: manifest, policy: readJson(path.resolve(options.policy ?? defaultPolicyPath)) });
    console.log(`SageMaker remote preflight PASS (${result.remoteObjectsVerified} immutable S3 objects, image digest, quota, role, and run ID).`);
    if (command === 'verify-remote') return 0;
    const specPath = path.resolve(required(options, 'job-spec'));
    const spec = readJson(specPath);
    if (spec.TrainingJobName !== plan.runId) throw new Error('Training-job specification run ID differs from the launch plan');
    const submit = spawnSync('aws', [
      'sagemaker', 'create-training-job', '--profile', profile, '--region', plan.region, '--cli-input-json', `file://${specPath}`,
    ], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    if (submit.status !== 0) throw new Error(`SageMaker submission failed (${submit.status ?? 'signal'})`);
    console.log(`SageMaker training job submitted: ${spec.TrainingJobName}`);
    return 0;
  }
  throw new Error(`Unknown command: ${command}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message.replace(os.homedir(), '~'));
    process.exitCode = 1;
  }
}
