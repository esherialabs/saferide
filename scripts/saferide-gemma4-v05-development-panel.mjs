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
const inputSchemaPaths = new Map([
  ['com.saferide.ai.v05-development-panel-input', path.join(repoRoot, 'schemas/ai-v05-development-panel-input.schema.json')],
  ['com.saferide.ai.v051-development-panel-input', path.join(repoRoot, 'schemas/ai-v051-development-panel-input.schema.json')],
  ['com.saferide.ai.v051-mitigation-holdout-input', path.join(repoRoot, 'schemas/ai-v051-mitigation-holdout-input.schema.json')],
  ['com.saferide.ai.v052-pilot-panel-input', path.join(repoRoot, 'schemas/ai-v052-pilot-panel-input.schema.json')],
  ['com.saferide.ai.v053-pilot-panel-input', path.join(repoRoot, 'schemas/ai-v053-pilot-panel-input.schema.json')],
]);
const region = 'eu-central-1';
const shaPattern = /^[a-f0-9]{64}$/;
const jobPattern = /^saferide-v05(?:1|2|3)?-(?:dev-panel|pilot-panel|mitigation-holdout)-[a-z0-9](?:[a-z0-9-]{6,35}[a-z0-9])$/;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function fileSha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function compileInputSchemas() {
  const options = {
    allErrors: true, strict: true, strictRequired: false, strictTypes: false,
    formats: { 'date-time': true },
  };
  return new Map([...inputSchemaPaths].map(([schema, schemaPath]) => {
    const ajv = new Ajv2020(options);
    if (schema === 'com.saferide.ai.v051-mitigation-holdout-input'
      || schema === 'com.saferide.ai.v052-pilot-panel-input'
      || schema === 'com.saferide.ai.v053-pilot-panel-input') {
      ajv.addSchema(readJson(inputSchemaPaths.get('com.saferide.ai.v051-development-panel-input')));
    }
    return [schema, ajv.compile(readJson(schemaPath))];
  }));
}

const validateInputSchemas = compileInputSchemas();
const summaryAjv = new Ajv2020({
  allErrors: true, strict: true, strictRequired: false, strictTypes: false,
  formats: { 'date-time': true },
});
summaryAjv.addSchema(readJson(inputSchemaPaths.get('com.saferide.ai.v051-development-panel-input')));
summaryAjv.addSchema(readJson(inputSchemaPaths.get('com.saferide.ai.v052-pilot-panel-input')));
summaryAjv.addSchema(readJson(inputSchemaPaths.get('com.saferide.ai.v053-pilot-panel-input')));
const validateV052SummarySchema = summaryAjv.compile(readJson(path.join(repoRoot, 'schemas/ai-v052-pilot-panel-summary.schema.json')));
const validateV053SummarySchema = summaryAjv.compile(readJson(path.join(repoRoot, 'schemas/ai-v053-pilot-panel-summary.schema.json')));

export function validateV052PilotSummary(summary) {
  if (validateV052SummarySchema(summary)) return [];
  return (validateV052SummarySchema.errors ?? []).map(error => `pilotSummary${error.instancePath || '/'}: ${error.message ?? error.keyword}`);
}

export function validateV053PilotSummary(summary) {
  if (validateV053SummarySchema(summary)) return [];
  return (validateV053SummarySchema.errors ?? []).map(error => `pilotSummary${error.instancePath || '/'}: ${error.message ?? error.keyword}`);
}

function schemaErrors(value) {
  const validator = validateInputSchemas.get(value?.schema);
  if (!validator) return ['panelInput/: unsupported panel schema'];
  if (validator(value)) return [];
  return (validator.errors ?? []).map(error => `panelInput${error.instancePath || '/'}: ${error.message ?? error.keyword}`);
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
  const key = parts.join('/');
  if (!bucket || !key) throw new Error('S3 URI must include a bucket and key');
  return { bucket, key };
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

export function validatePanelInput(manifest, packageRoot) {
  const errors = schemaErrors(manifest);
  if (manifest.generationConfig?.doSample !== false) errors.push('generation must remain deterministic');
  const isV051 = manifest.schema === 'com.saferide.ai.v051-development-panel-input';
  const isV052 = manifest.schema === 'com.saferide.ai.v052-pilot-panel-input';
  const isV053 = manifest.schema === 'com.saferide.ai.v053-pilot-panel-input';
  const isHoldout = manifest.schema === 'com.saferide.ai.v051-mitigation-holdout-input';
  const containsHoldout = isV051 || isV052 || isV053 || isHoldout
    ? manifest.privacy?.containsMitigationHoldoutRows
    : manifest.privacy?.containsHoldoutRows;
  if ((!isHoldout && containsHoldout !== false)
    || (isHoldout && (containsHoldout !== true || manifest.privacy?.openedAfterTechnicalSelection !== true))
    || manifest.privacy?.containsBlindPrompts !== false
    || ((isV051 || isV052 || isV053 || isHoldout) && manifest.privacy?.containsProtectedV05Rows !== false)) {
    errors.push('panel package may contain development rows only');
  }
  const candidates = isHoldout || isV052 || isV053 ? [manifest.candidate] : (manifest.candidates ?? []);
  if (isHoldout) {
    if (![419805, 419806].includes(manifest.candidate?.seed)) errors.push('holdout candidate must be the selected fixed seed');
  } else if (isV052 || isV053) {
    const version = isV053 ? 'v0.5.3' : 'v0.5.2';
    if (manifest.candidate?.seed !== 419805 || manifest.candidate?.runKind !== 'pilot') errors.push(`${version} panel must evaluate only the governed seed-419805 pilot`);
    if (manifest.archivedBaseComparator?.outputsRegenerated !== false) errors.push(`${version} pilot panel must reuse the archived base comparator`);
  } else if (candidates.map(candidate => candidate.seed).join(',') !== '419805,419806') {
    errors.push('panel candidates must remain in fixed seed order');
  }
  const files = manifest.packageFiles ?? [];
  const relativePaths = files.map(file => file.path);
  if (new Set(relativePaths).size !== relativePaths.length) errors.push('panel package paths must be unique');
  for (const relative of relativePaths) if (!safeRelative(relative)) errors.push(`panel package path is unsafe: ${relative}`);
  if (packageRoot) {
    const root = path.resolve(packageRoot);
    const actual = [];
    const walk = directory => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(target);
        else if (entry.isFile() && entry.name !== 'panel-input-manifest.json') actual.push(path.relative(root, target).split(path.sep).join('/'));
      }
    };
    walk(root);
    actual.sort();
    if (JSON.stringify(actual) !== JSON.stringify([...relativePaths].sort())) errors.push('panel package actual inventory differs from its manifest');
    for (const file of files) {
      const target = path.resolve(root, file.path);
      if (!target.startsWith(`${root}${path.sep}`)) errors.push(`panel package file escapes root: ${file.path}`);
      else if (!fs.existsSync(target) || !fs.statSync(target).isFile()) errors.push(`panel package file is missing: ${file.path}`);
      else if (fs.statSync(target).size !== file.sizeBytes || fileSha256(target) !== file.sha256) errors.push(`panel package file bytes differ: ${file.path}`);
    }
  }
  return errors;
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

function awsJson(profile, args) {
  const result = spawnSync('aws', [...args, '--profile', profile, '--region', region, '--output', 'json'], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`AWS panel command failed: aws ${args.slice(0, 2).join(' ')}`);
  return result.stdout.trim() ? JSON.parse(result.stdout) : {};
}

function headObject(profile, bucket, key, versionId) {
  const args = ['s3api', 'head-object', '--bucket', bucket, '--key', key];
  if (versionId) args.push('--version-id', versionId);
  return awsJson(profile, args);
}

function optionalHeadObject(profile, bucket, key) {
  const result = spawnSync('aws', [
    's3api', 'head-object', '--bucket', bucket, '--key', key,
    '--profile', profile, '--region', region, '--output', 'json',
  ], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (result.status === 0) return result.stdout.trim() ? JSON.parse(result.stdout) : {};
  if (/(Not Found|404|NoSuchKey)/i.test(result.stderr ?? '')) return null;
  throw new Error('Unable to verify immutable panel object availability');
}

function verifyBucket(profile, bucket) {
  const versioning = awsJson(profile, ['s3api', 'get-bucket-versioning', '--bucket', bucket]);
  if (versioning.Status !== 'Enabled') throw new Error('Panel bucket versioning is not enabled');
  const publicAccess = awsJson(profile, ['s3api', 'get-public-access-block', '--bucket', bucket]).PublicAccessBlockConfiguration ?? {};
  for (const key of ['BlockPublicAcls', 'IgnorePublicAcls', 'BlockPublicPolicy', 'RestrictPublicBuckets']) {
    if (publicAccess[key] !== true) throw new Error('Panel bucket public access block is incomplete');
  }
  const encryption = awsJson(profile, ['s3api', 'get-bucket-encryption', '--bucket', bucket]);
  const algorithms = (encryption.ServerSideEncryptionConfiguration?.Rules ?? [])
    .map(rule => rule.ApplyServerSideEncryptionByDefault?.SSEAlgorithm);
  if (!algorithms.some(value => ['AES256', 'aws:kms'].includes(value))) throw new Error('Panel bucket lacks server-side encryption');
}

function uploadImmutable(profile, bucket, key, source, sha256) {
  const existing = optionalHeadObject(profile, bucket, key);
  if (existing) {
    if (
      Number(existing.ContentLength) !== fs.statSync(source).size
      || existing.Metadata?.sha256 !== sha256
      || !existing.VersionId
      || !['AES256', 'aws:kms'].includes(existing.ServerSideEncryption)
    ) throw new Error(`Immutable panel object differs: ${path.basename(key)}`);
    return existing;
  }
  const upload = spawnSync('aws', [
    's3', 'cp', source, `s3://${bucket}/${key}`,
    '--sse', 'AES256',
    '--metadata', `sha256=${sha256}`,
    '--only-show-errors',
    '--profile', profile,
    '--region', region,
  ], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (upload.status !== 0) throw new Error(`Panel object upload failed: ${path.basename(source)}`);
  const head = headObject(profile, bucket, key);
  if (
    Number(head.ContentLength) !== fs.statSync(source).size
    || head.Metadata?.sha256 !== sha256
    || !head.VersionId
    || !['AES256', 'aws:kms'].includes(head.ServerSideEncryption)
  ) throw new Error(`Panel object verification failed: ${path.basename(source)}`);
  return head;
}

export function buildPanelJobSpec({ receipt, roleArn, imageUri, imageDigest, jobName, outputS3Uri }) {
  if (!jobPattern.test(jobName)) throw new Error('Panel job name is invalid');
  if (!/^arn:aws:iam::[0-9]{12}:role\/[A-Za-z0-9+=,.@_/-]{1,128}$/.test(roleArn)) throw new Error('Panel role ARN is invalid');
  if (!/^[0-9]{12}\.dkr\.ecr\.eu-central-1\.amazonaws\.com\/[a-z0-9._/-]+:[A-Za-z0-9._-]+$/.test(imageUri)) throw new Error('Panel image URI is invalid');
  if (!shaPattern.test(imageDigest)) throw new Error('Panel image digest is invalid');
  if (!outputS3Uri.endsWith('/') || s3Bucket(outputS3Uri) !== receipt.bucket) throw new Error('Panel output must use the controlled input bucket and end with /');
  return {
    TrainingJobName: jobName,
    AlgorithmSpecification: {
      TrainingImage: imageUri,
      TrainingInputMode: 'File',
      ContainerEntrypoint: [
        'python',
        `/opt/ml/input/data/panel/code/${path.basename(receipt.scriptRelativePath)}`,
        'run',
        '--input-root', '/opt/ml/input/data/panel',
        '--model-root', '/opt/ml/input/data/model',
        '--output-root', '/opt/ml/model',
      ],
      EnableSageMakerMetricsTimeSeries: false,
    },
    RoleArn: roleArn,
    InputDataConfig: [
      {
        ChannelName: 'panel',
        DataSource: { S3DataSource: { S3DataType: 'S3Prefix', S3Uri: receipt.s3Prefix, S3DataDistributionType: 'FullyReplicated' } },
        InputMode: 'File',
      },
      {
        ChannelName: 'model',
        DataSource: { S3DataSource: { S3DataType: 'S3Prefix', S3Uri: receipt.baseModelS3Prefix, S3DataDistributionType: 'FullyReplicated' } },
        InputMode: 'File',
      },
    ],
    OutputDataConfig: { S3OutputPath: outputS3Uri },
    ResourceConfig: { InstanceType: 'ml.g5.xlarge', InstanceCount: 1, VolumeSizeInGB: 80 },
    StoppingCondition: { MaxRuntimeInSeconds: 21600 },
    RetryStrategy: { MaximumRetryAttempts: 1 },
    EnableManagedSpotTraining: false,
    EnableNetworkIsolation: true,
    EnableInterContainerTrafficEncryption: true,
    Environment: {
      SAFERIDE_PANEL_INPUT_SHA256: receipt.manifestSha256,
      SAFERIDE_PANEL_IMAGE_DIGEST: imageDigest,
      SAFERIDE_PANEL_SOURCE_COMMIT: receipt.sourceCommit,
    },
    Tags: [
      { Key: 'Project', Value: 'SafeRide' },
      { Key: 'Issue', Value: 'ESH-4198' },
      { Key: 'Dataset', Value: receipt.runKind === 'mitigation-holdout-evaluation' ? 'v0.5.1-mitigation-holdout' : receipt.datasetVersion === 'v053' ? 'v0.5.3-pilot-development-only' : receipt.datasetVersion === 'v052' ? 'v0.5.2-pilot-development-only' : receipt.datasetVersion === 'v051' ? 'v0.5.1-development-only' : 'v0.5-development-only' },
      { Key: 'RunKind', Value: receipt.runKind ?? 'development-generation-panel' },
      { Key: 'DataClassification', Value: receipt.runKind === 'mitigation-holdout-evaluation' ? 'RestrictedPostSelection' : 'ControlledDevelopmentOnly' },
    ],
  };
}

function parseEcrImage(uri) {
  const match = uri.match(/^([0-9]{12})\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com\/(.+):([^/:]+)$/);
  if (!match) throw new Error('Panel image URI is not a tagged private ECR image');
  return { account: match[1], imageRegion: match[2], repository: match[3], tag: match[4] };
}

function verifyRemote({ profile, receipt, spec, imageDigest }) {
  verifyBucket(profile, receipt.bucket);
  for (const object of receipt.objects) {
    const head = headObject(profile, receipt.bucket, object.key, object.versionId);
    if (
      Number(head.ContentLength) !== object.sizeBytes
      || head.Metadata?.sha256 !== object.sha256
      || head.VersionId !== object.versionId
      || !['AES256', 'aws:kms'].includes(head.ServerSideEncryption)
    ) throw new Error(`Remote panel object differs: ${path.basename(object.key)}`);
  }
  const baseInput = readJson(receipt.localInputManifestPath);
  for (const file of baseInput.baseModel.files) {
    const { bucket, key } = parseS3Uri(file.s3Uri);
    const head = headObject(profile, bucket, key, file.versionId);
    if (
      Number(head.ContentLength) !== file.sizeBytes
      || head.Metadata?.sha256 !== file.sha256
      || head.VersionId !== file.versionId
    ) throw new Error(`Remote base-model object differs: ${file.path}`);
  }
  const image = parseEcrImage(spec.AlgorithmSpecification.TrainingImage);
  if (image.imageRegion !== region) throw new Error('Panel image region differs');
  const imageDescription = awsJson(profile, [
    'ecr', 'describe-images', '--registry-id', image.account, '--repository-name', image.repository,
    '--image-ids', `imageTag=${image.tag}`,
  ]);
  const remoteDigest = imageDescription.imageDetails?.[0]?.imageDigest?.replace(/^sha256:/, '');
  if (remoteDigest !== imageDigest) throw new Error('Panel image tag no longer resolves to the approved digest');
  const roleName = spec.RoleArn.split('/').at(-1);
  const role = awsJson(profile, ['iam', 'get-role', '--role-name', roleName]);
  if (role.Role?.Arn !== spec.RoleArn || !JSON.stringify(role.Role?.AssumeRolePolicyDocument ?? {}).includes('sagemaker.amazonaws.com')) {
    throw new Error('Panel execution role identity/trust differs');
  }
  const existing = spawnSync('aws', [
    'sagemaker', 'describe-training-job', '--training-job-name', spec.TrainingJobName,
    '--profile', profile, '--region', region, '--output', 'json',
  ], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (existing.status === 0) throw new Error('A SageMaker job already uses this immutable panel run ID');
  if (!/(ValidationException|Could not find|does not exist)/i.test(existing.stderr ?? '')) throw new Error('Unable to verify panel run-ID availability');
  return { panelObjects: receipt.objects.length, modelObjects: baseInput.baseModel.files.length };
}

function stage(options) {
  const packageRoot = path.resolve(required(options, 'package-root'));
  const manifestPath = path.join(packageRoot, 'panel-input-manifest.json');
  const manifest = readJson(manifestPath);
  assertValid('development-panel input', validatePanelInput(manifest, packageRoot));
  const profile = required(options, 'profile');
  const bucket = required(options, 'bucket');
  verifyBucket(profile, bucket);
  const isHoldout = manifest.schema === 'com.saferide.ai.v051-mitigation-holdout-input';
  const isV052 = manifest.schema === 'com.saferide.ai.v052-pilot-panel-input';
  const isV053 = manifest.schema === 'com.saferide.ai.v053-pilot-panel-input';
  const isV051 = manifest.schema === 'com.saferide.ai.v051-development-panel-input' || isHoldout;
  const datasetVersion = isV053 ? 'v053' : isV052 ? 'v052' : isV051 ? 'v051' : 'v05';
  const immutableId = manifest.panelId ?? manifest.evaluationId;
  const family = isHoldout ? 'holdouts' : 'panels';
  const prefix = `saferide/${datasetVersion}/sagemaker/${family}/inputs/${immutableId}/`;
  const localFiles = [
    ...manifest.packageFiles.map(file => ({ ...file, source: path.join(packageRoot, file.path) })),
    { path: 'panel-input-manifest.json', source: manifestPath, sha256: fileSha256(manifestPath), sizeBytes: fs.statSync(manifestPath).size },
  ];
  const objects = localFiles.map(file => {
    const key = `${prefix}${file.path}`;
    const head = uploadImmutable(profile, bucket, key, file.source, file.sha256);
    return {
      path: file.path,
      key,
      sha256: file.sha256,
      sizeBytes: file.sizeBytes,
      versionId: head.VersionId,
      etag: head.ETag,
      serverSideEncryption: head.ServerSideEncryption,
    };
  });
  const inputManifestRelative = manifest.baseModel.inputManifest.path;
  const inputManifest = readJson(path.join(packageRoot, inputManifestRelative));
  const scriptRelativePath = manifest.executionScript
    ?? manifest.packageFiles.find(file => file.path.startsWith('code/'))?.path;
  if (!scriptRelativePath) throw new Error('Panel package lacks its execution script');
  const receipt = {
    schema: isHoldout
      ? 'com.saferide.ai.private-v051-mitigation-holdout-staging-receipt'
      : isV053
        ? 'com.saferide.ai.private-v053-pilot-panel-staging-receipt'
      : isV052
        ? 'com.saferide.ai.private-v052-pilot-panel-staging-receipt'
      : isV051
        ? 'com.saferide.ai.private-v051-development-panel-staging-receipt'
      : 'com.saferide.ai.private-v05-development-panel-staging-receipt',
    schemaVersion: 1,
    panelId: immutableId,
    createdAt: new Date().toISOString(),
    sourceCommit: manifest.sourceCommit,
    datasetVersion,
    runKind: isHoldout ? 'mitigation-holdout-evaluation' : (isV052 || isV053) ? 'pilot-development-generation-panel' : 'development-generation-panel',
    bucket,
    s3Prefix: `s3://${bucket}/${prefix}`,
    manifestSha256: fileSha256(manifestPath),
    manifestVersionId: objects.find(object => object.path === 'panel-input-manifest.json').versionId,
    objects,
    scriptRelativePath,
    baseModelS3Prefix: inputManifest.baseModel.s3Prefix,
    localInputManifestPath: path.join(packageRoot, inputManifestRelative),
    developmentRows: isHoldout ? 0 : (isV051 || isV052 || isV053) ? 320 : 300,
    holdoutRows: isHoldout ? 20 : 0,
    candidateSeeds: isHoldout || isV052 || isV053 ? [manifest.candidate.seed] : [419805, 419806],
    holdoutsUploaded: isHoldout,
    protectedV05RowsUploaded: false,
    blindPromptsUploaded: false,
    promotionEligible: false,
  };
  const output = path.resolve(required(options, 'output'));
  writePrivateJson(output, receipt);
  console.log(isHoldout
    ? `SafeRide one-time mitigation-holdout staging PASS (${objects.length} immutable objects; post-selection only).`
    : `SafeRide development-panel staging PASS (${objects.length} immutable objects; protected suites absent).`);
}

function contractCheck() {
  for (const relative of [
    'scripts/saferide-gemma4-v05-development-panel.py',
    'scripts/saferide-gemma4-v051-development-panel.py',
    'scripts/saferide-gemma4-v051-holdout.py',
    'scripts/saferide-gemma4-v052-pilot-panel.py',
    'scripts/saferide-gemma4-v053-pilot-panel.py',
    'schemas/ai-v05-development-panel-input.schema.json',
    'schemas/ai-v05-development-panel-summary.schema.json',
    'schemas/ai-v051-development-panel-input.schema.json',
    'schemas/ai-v051-development-panel-summary.schema.json',
    'schemas/ai-v051-mitigation-holdout-input.schema.json',
    'schemas/ai-v051-mitigation-holdout-summary.schema.json',
    'schemas/ai-v052-pilot-panel-input.schema.json',
    'schemas/ai-v052-pilot-panel-summary.schema.json',
    'schemas/ai-v053-pilot-panel-input.schema.json',
    'schemas/ai-v053-pilot-panel-summary.schema.json',
  ]) if (!fs.existsSync(path.join(repoRoot, relative))) throw new Error(`Missing development-panel contract file: ${relative}`);
  for (const schemaPath of inputSchemaPaths.values()) readJson(schemaPath);
  console.log('SafeRide v0.5-series development-panel launcher contracts PASS.');
}

function usage() {
  return [
    'Usage:',
    '  node scripts/saferide-gemma4-v05-development-panel.mjs contract-check',
    '  node scripts/saferide-gemma4-v05-development-panel.mjs verify-package --package-root <dir>',
    '  node scripts/saferide-gemma4-v05-development-panel.mjs verify-summary --summary <json>',
    '  node scripts/saferide-gemma4-v05-development-panel.mjs stage --package-root <dir> --bucket <name> --profile <name> --output <json>',
    '  node scripts/saferide-gemma4-v05-development-panel.mjs build-job-spec --receipt <json> --role-arn <arn> --image-uri <uri> --image-digest <sha> --job-name <name> --output-s3-uri <s3> --output <json>',
    '  node scripts/saferide-gemma4-v05-development-panel.mjs verify-remote --receipt <json> --job-spec <json> --image-digest <sha> --profile <name>',
    '  node scripts/saferide-gemma4-v05-development-panel.mjs submit --receipt <json> --job-spec <json> --image-digest <sha> --profile <name>',
  ].join('\n');
}

function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (['--help', '-h', 'help', undefined].includes(command)) return console.log(usage()), 0;
  if (command === 'contract-check') return contractCheck(), 0;
  if (command === 'verify-package') {
    const packageRoot = path.resolve(required(options, 'package-root'));
    const manifest = readJson(path.join(packageRoot, 'panel-input-manifest.json'));
    assertValid('development-panel input', validatePanelInput(manifest, packageRoot));
    console.log(manifest.schema === 'com.saferide.ai.v051-mitigation-holdout-input'
      ? 'SafeRide mitigation-holdout package PASS (post-selection one-time access).'
      : 'SafeRide development-panel package PASS (development only; protected suites absent).');
    return 0;
  }
  if (command === 'verify-summary') {
    const summary = readJson(path.resolve(required(options, 'summary')));
    const isV053 = summary.schema === 'com.saferide.ai.v053-pilot-panel-summary';
    assertValid(isV053 ? 'v0.5.3 pilot summary' : 'v0.5.2 pilot summary', isV053 ? validateV053PilotSummary(summary) : validateV052PilotSummary(summary));
    console.log(`SafeRide ${isV053 ? 'v0.5.3' : 'v0.5.2'} pilot summary schema PASS.`);
    return 0;
  }
  if (command === 'stage') return stage(options), 0;
  if (command === 'build-job-spec') {
    const receipt = readJson(path.resolve(required(options, 'receipt')));
    const spec = buildPanelJobSpec({
      receipt,
      roleArn: required(options, 'role-arn'),
      imageUri: required(options, 'image-uri'),
      imageDigest: required(options, 'image-digest'),
      jobName: required(options, 'job-name'),
      outputS3Uri: required(options, 'output-s3-uri'),
    });
    const output = path.resolve(required(options, 'output'));
    writePrivateJson(output, spec);
    console.log(`SafeRide development-panel job specification written (sha256=${fileSha256(output)}).`);
    return 0;
  }
  if (command === 'verify-remote' || command === 'submit') {
    const receipt = readJson(path.resolve(required(options, 'receipt')));
    const specPath = path.resolve(required(options, 'job-spec'));
    const spec = readJson(specPath);
    const imageDigest = required(options, 'image-digest');
    const profile = required(options, 'profile');
    const result = verifyRemote({ profile, receipt, spec, imageDigest });
    console.log(`SafeRide development-panel remote preflight PASS (${result.panelObjects} panel and ${result.modelObjects} base-model objects).`);
    if (command === 'verify-remote') return 0;
    const submit = spawnSync('aws', [
      'sagemaker', 'create-training-job', '--profile', profile, '--region', region,
      '--cli-input-json', `file://${specPath}`,
    ], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    if (submit.status !== 0) throw new Error(`Development-panel submission failed (${submit.status ?? 'signal'})`);
    console.log('SafeRide development-panel job submitted (identifier retained in controlled evidence).');
    return 0;
  }
  throw new Error(`Unknown command: ${command}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message.replaceAll(os.homedir(), '~'));
    process.exitCode = 1;
  }
}
