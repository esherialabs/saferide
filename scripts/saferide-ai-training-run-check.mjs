#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const forbiddenOutputKeys = new Set([
  'content', 'messages', 'prompt', 'prompts', 'completion', 'completions', 'response', 'responses',
  'narrative', 'transcript', 'location', 'latitude', 'longitude', 'evidence', 'credential', 'token',
]);
const secretPatterns = [
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA |)?PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
];

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function sha256Text(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function scanContentFree(value, location = 'manifest', errors = []) {
  if (typeof value === 'string') {
    for (const pattern of secretPatterns) {
      if (pattern.test(value)) errors.push(`${location} contains secret-like material`);
    }
    return errors;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanContentFree(entry, `${location}[${index}]`, errors));
    return errors;
  }
  if (!value || typeof value !== 'object') return errors;
  for (const [key, entry] of Object.entries(value)) {
    if (location.startsWith('manifest.outputs') && forbiddenOutputKeys.has(key)) {
      errors.push(`${location}.${key} is forbidden in a content-free run manifest`);
    }
    scanContentFree(entry, `${location}.${key}`, errors);
  }
  return errors;
}

function validateReferencedFile(manifestPath, expectedHash, label, errors, {
  allowExternal = false,
  externalPrefix = null,
  sourceRoot = null,
} = {}) {
  if (manifestPath === null && expectedHash === null) return;
  if (typeof manifestPath !== 'string' || typeof expectedHash !== 'string') {
    errors.push(`${label} path/hash must both be set or both be null`);
    return;
  }
  let fullPath = path.resolve(repoRoot, manifestPath);
  let relative = path.relative(repoRoot, fullPath);
  if (sourceRoot && externalPrefix && path.isAbsolute(manifestPath)) {
    const sourceRelative = path.relative(externalPrefix, manifestPath);
    const resolvedSourceRoot = path.resolve(sourceRoot);
    const remapped = path.resolve(resolvedSourceRoot, sourceRelative);
    if (!sourceRelative || sourceRelative.startsWith('..') || path.isAbsolute(sourceRelative)
      || (remapped !== resolvedSourceRoot && !remapped.startsWith(`${resolvedSourceRoot}${path.sep}`))) {
      errors.push(`${label} path is outside the staged source root`);
      return;
    }
    fullPath = remapped;
    relative = path.relative(repoRoot, fullPath);
  }
  if ((!relative || relative.startsWith('..') || path.isAbsolute(relative)) && !allowExternal) {
    errors.push(`${label} path escapes the repository`);
  } else if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
    errors.push(`${label} file is unavailable: ${manifestPath}`);
  } else if (sha256File(fullPath) !== expectedHash) {
    errors.push(`${label} SHA-256 does not match current bytes`);
  }
}

export function validateTrainingRun(manifest, validator, { verifyFiles = true, sourceRoot = null } = {}) {
  const errors = [];
  const governedProfile = ['v05', 'v051', 'v052', 'v053', 'v054', 'v055', 'v056'].includes(manifest.datasetProfile);
  const profileLabel = manifest.datasetProfile === 'v056'
    ? 'v0.5.6'
    : manifest.datasetProfile === 'v055'
    ? 'v0.5.5'
    : manifest.datasetProfile === 'v054'
    ? 'v0.5.4'
    : manifest.datasetProfile === 'v053'
    ? 'v0.5.3'
    : manifest.datasetProfile === 'v052'
      ? 'v0.5.2'
    : manifest.datasetProfile === 'v051' ? 'v0.5.1' : 'v0.5';
  if (!validator(manifest)) {
    for (const error of validator.errors ?? []) {
      errors.push(`${error.instancePath || '/'}: ${error.message ?? error.keyword}`);
    }
  }
  scanContentFree(manifest, 'manifest', errors);
  if (manifest.promotionEligible !== false) errors.push('promotionEligible must remain false; downstream safety/export/device gates decide promotion');
  if (manifest.dataGate?.passed !== true || manifest.dataGate?.exitCode !== 0) errors.push('data gate must pass before a run manifest can be accepted');
  if (manifest.runArguments?.effectiveBatchSize !== (
    manifest.runArguments?.trainBatchSize * manifest.runArguments?.gradientAccumulationSteps
  )) errors.push('effective batch size is inconsistent');
  if (manifest.runArguments?.saveSteps % manifest.runArguments?.evalSteps !== 0) {
    errors.push('saveSteps must be a multiple of evalSteps');
  }
  if (governedProfile && ['pilot', 'candidate'].includes(manifest.runKind)) {
    if (manifest.data !== null || manifest.dataSha256 !== null) {
      errors.push(`${profileLabel} manifest must use access-separated dataFiles rather than combined data`);
    }
    if (!manifest.dataFiles?.train || !manifest.dataFiles?.dev) errors.push(`${profileLabel} manifest requires train and dev file bindings`);
    if (!manifest.datasetManifest || !manifest.datasetManifestSha256) errors.push(`${profileLabel} manifest requires the content-free dataset manifest binding`);
    if (!manifest.datasetBindings) errors.push(`${profileLabel} manifest requires governed dataset bindings`);
    const fullTrainRows = manifest.datasetProfile === 'v056' ? 1888 : manifest.datasetProfile === 'v055' ? 1896 : manifest.datasetProfile === 'v054' ? 1864 : manifest.datasetProfile === 'v053' ? 1832 : manifest.datasetProfile === 'v052' ? 1768 : manifest.datasetProfile === 'v051' ? 1720 : 1600;
    const fullRowCount = fullTrainRows + 300;
    if (manifest.dataSummary?.rowCount !== fullRowCount
      || manifest.dataSummary?.splitCounts?.train !== fullTrainRows
      || manifest.dataSummary?.splitCounts?.dev !== 300
      || Object.keys(manifest.dataSummary?.splitCounts ?? {}).some(split => !['train', 'dev'].includes(split))) {
      errors.push(`${profileLabel} process input summary must contain exactly ${fullTrainRows.toLocaleString('en-US')} train and 300 development rows only`);
    }
    const expectedDatasetIds = manifest.datasetProfile === 'v056'
      ? ['saferide-synthetic-guidance-v0.5.0', 'saferide-synthetic-guidance-v0.5.1', 'saferide-synthetic-guidance-v0.5.2', 'saferide-synthetic-guidance-v0.5.3', 'saferide-synthetic-guidance-v0.5.4', 'saferide-synthetic-guidance-v0.5.6']
      : manifest.datasetProfile === 'v055'
      ? ['saferide-synthetic-guidance-v0.5.0', 'saferide-synthetic-guidance-v0.5.1', 'saferide-synthetic-guidance-v0.5.2', 'saferide-synthetic-guidance-v0.5.3', 'saferide-synthetic-guidance-v0.5.4', 'saferide-synthetic-guidance-v0.5.5']
      : manifest.datasetProfile === 'v054'
      ? ['saferide-synthetic-guidance-v0.5.0', 'saferide-synthetic-guidance-v0.5.1', 'saferide-synthetic-guidance-v0.5.2', 'saferide-synthetic-guidance-v0.5.3', 'saferide-synthetic-guidance-v0.5.4']
      : manifest.datasetProfile === 'v053'
      ? ['saferide-synthetic-guidance-v0.5.0', 'saferide-synthetic-guidance-v0.5.1', 'saferide-synthetic-guidance-v0.5.2', 'saferide-synthetic-guidance-v0.5.3']
      : manifest.datasetProfile === 'v052'
      ? ['saferide-synthetic-guidance-v0.5.0', 'saferide-synthetic-guidance-v0.5.1', 'saferide-synthetic-guidance-v0.5.2']
      : manifest.datasetProfile === 'v051'
        ? ['saferide-synthetic-guidance-v0.5.0', 'saferide-synthetic-guidance-v0.5.1']
        : ['saferide-synthetic-guidance-v0.5.0'];
    if (JSON.stringify(manifest.dataSummary?.datasetIds ?? []) !== JSON.stringify(expectedDatasetIds)
      || manifest.datasetBindings?.datasetId !== expectedDatasetIds.at(-1)) {
      errors.push(`${profileLabel} manifest dataset identity or ordered lineage differs`);
    }
    if (manifest.baseModelId !== 'google/gemma-4-E2B-it' || !/^[a-f0-9]{40,64}$/.test(manifest.baseRevision ?? '')) {
      errors.push(`${profileLabel} pilot/candidate requires the canonical base model and immutable revision`);
    }
    if (manifest.privacy?.classification !== 'controlled-content-free' || manifest.privacy?.containsExactRowIds !== true) {
      errors.push(`${profileLabel} full run manifest must be classified controlled because it contains exact row inventories`);
    }
    if (![419805, 419806].includes(manifest.runArguments?.seed)) {
      errors.push(`${profileLabel} pilot/candidate seed must be 419805 or 419806`);
    }
    if (manifest.datasetProfile === 'v054' && manifest.runArguments?.seed !== 419805) {
      errors.push('v0.5.4 authorizes one targeted pilot at seed 419805 only');
    }
    if (manifest.datasetProfile === 'v055' && manifest.runArguments?.seed !== 419805) {
      errors.push('v0.5.5 authorizes one final targeted pilot at seed 419805 only');
    }
    if (manifest.datasetProfile === 'v056' && manifest.runArguments?.seed !== 419805) {
      errors.push('v0.5.6 authorizes one bounded targeted pilot at seed 419805 only');
    }
    if (manifest.runKind === 'candidate' && (manifest.runArguments?.evalSteps !== 25 || manifest.runArguments?.saveSteps !== 25)) {
      errors.push(`${profileLabel} candidate evaluation/save cadence must be 25 steps`);
    }
    const approvedLearningRates = ['v053', 'v055'].includes(manifest.datasetProfile) ? [0.00001] : ['v052', 'v054', 'v056'].includes(manifest.datasetProfile) ? [0.00002] : [0.00001, 0.00002];
    if (manifest.runArguments?.maxSteps !== null || !approvedLearningRates.includes(manifest.runArguments?.learningRate)) {
      errors.push(`${profileLabel} pilot/candidate requires a complete epoch and an approved pilot learning rate`);
    }
    if (manifest.datasetProfile === 'v052' && manifest.runKind === 'candidate') {
      errors.push('v0.5.2 full candidate training is not authorized by the frozen pilot recipe');
    }
    if (manifest.datasetProfile === 'v053' && manifest.runKind === 'candidate') {
      errors.push('v0.5.3 full candidate training is not authorized by the frozen pilot recipe');
    }
    if (manifest.datasetProfile === 'v054' && manifest.runKind === 'candidate') {
      errors.push('v0.5.4 full candidate training is not authorized by the frozen targeted-pilot recipe');
    }
    if (manifest.datasetProfile === 'v055' && manifest.runKind === 'candidate') {
      errors.push('v0.5.5 full candidate training is not authorized by the frozen final-pilot recipe');
    }
    if (manifest.datasetProfile === 'v056' && manifest.runKind === 'candidate') {
      errors.push('v0.5.6 full candidate training is not authorized by the frozen targeted-pilot recipe');
    }
    if (manifest.runArguments?.maxSequenceLength !== 1024
      || manifest.runArguments?.trainBatchSize !== 1
      || manifest.runArguments?.gradientAccumulationSteps !== 8
      || manifest.runArguments?.effectiveBatchSize !== 8
      || manifest.runArguments?.warmupRatio !== 0.03
      || manifest.runArguments?.scheduler !== 'cosine'
      || manifest.runArguments?.earlyStoppingPatience !== 3
      || manifest.runArguments?.evalSteps !== 25
      || manifest.runArguments?.saveSteps !== 25) {
      errors.push(`${profileLabel} run differs from the fixed sequence, batch, scheduler, warmup, cadence, or early-stopping configuration`);
    }
    if (['v054', 'v055', 'v056'].includes(manifest.datasetProfile) && manifest.runArguments?.maxGradientNorm !== 1) {
      errors.push(`${profileLabel} run requires explicit maxGradientNorm 1.0`);
    }
    if (manifest.runArguments?.loraRank !== 8 && manifest.runArguments?.loraRank !== 16) {
      errors.push(`${profileLabel} run manifest lacks its LoRA rank`);
    }
    if (manifest.runArguments?.loraAlpha !== 16 || manifest.runArguments?.loraDropout !== 0.05) {
      errors.push(`${profileLabel} run manifest differs from the fixed LoRA alpha/dropout configuration`);
    }
    if (!manifest.runArguments?.loraRankApprovalRef && manifest.runArguments?.loraRank === 16) {
      errors.push(`${profileLabel} rank 16 lacks its approved pilot underfitting evidence reference`);
    }
  } else if (manifest.runKind === 'candidate' && (!manifest.data || !manifest.dataSha256)) {
    errors.push('pre-v0.5 candidate requires a combined data path and hash');
  }
  if (['pilot', 'candidate'].includes(manifest.runKind) && manifest.status === 'completed') {
    const outputs = manifest.outputs ?? {};
    if (manifest.environment?.dependencyConstraintsSatisfied !== true) {
      errors.push('completed candidate requires exact dependency-constraint verification');
    }
    if (!/^[a-f0-9]{64}$/.test(manifest.environment?.requirementsSha256 ?? '')) {
      errors.push('completed candidate requires the exact direct-requirements hash');
    }
    if (!/^[a-f0-9]{64}$/.test(manifest.environment?.constraintsSha256 ?? '')) {
      errors.push('completed candidate requires the exact dependency-constraint hash');
    }
    if (outputs.runKind !== manifest.runKind) errors.push('completed run outputs must retain the declared runKind');
    if ((outputs.epochsCompleted ?? 0) < 1) errors.push('completed pilot/candidate must cover at least one epoch');
    if (!Array.isArray(outputs.sampleOrder) || outputs.sampleOrder.length === 0) errors.push('completed pilot/candidate requires exact sample order');
    if (!outputs.sampleOrderSha256) errors.push('completed pilot/candidate requires sample-order hash');
    if (!Number.isInteger(outputs.rowsSeen) || outputs.rowsSeen < outputs.sampleOrder?.length) {
      errors.push('completed pilot/candidate requires rows-seen evidence covering at least one complete sample order');
    }
    if (outputs.selectionMetric !== 'eval_loss' || outputs.bestMetric === null || outputs.bestMetric === undefined) {
      errors.push('completed pilot/candidate requires dev-loss best-checkpoint selection evidence');
    }
    if (!outputs.chatTemplateSha256 || !outputs.tokenizerRevision) errors.push('completed pilot/candidate requires tokenizer revision and chat-template hash');
    if (!Array.isArray(outputs.adapterFiles) || outputs.adapterFiles.length === 0) errors.push('completed pilot/candidate requires hashed adapter inventory');
    if (governedProfile) {
      if (outputs.holdoutRowsRead !== 0) errors.push(`${profileLabel} training must read zero protected holdout rows`);
      const expectedTrainRows = manifest.datasetProfile === 'v056'
        ? 1888
        : manifest.datasetProfile === 'v055'
        ? 1896
        : manifest.datasetProfile === 'v054'
        ? 1864
        : manifest.datasetProfile === 'v053'
        ? 1832
        : manifest.datasetProfile === 'v052'
          ? 1768
        : manifest.runKind === 'pilot' ? 320 : (manifest.datasetProfile === 'v051' ? 1720 : 1600);
      const expectedSampleRows = manifest.datasetProfile === 'v056' ? 1944 : manifest.datasetProfile === 'v055' ? 1992 : manifest.datasetProfile === 'v054' ? 1896 : manifest.datasetProfile === 'v053' ? 2088 : manifest.datasetProfile === 'v052' ? 1864 : expectedTrainRows;
      if (!Array.isArray(outputs.trainRowIds) || outputs.trainRowIds.length !== expectedTrainRows) errors.push(`${profileLabel} ${manifest.runKind} requires exact ${expectedTrainRows} train row IDs`);
      if (!Array.isArray(outputs.developmentRowIds) || outputs.developmentRowIds.length !== 300) errors.push(`${profileLabel} candidate requires exact 300 development row IDs`);
      if (!outputs.trainRowIdSha256 || !outputs.developmentRowIdSha256) errors.push(`${profileLabel} candidate requires train/dev row inventory hashes`);
      if (new Set(outputs.trainRowIds ?? []).size !== expectedTrainRows || new Set(outputs.developmentRowIds ?? []).size !== 300) {
        errors.push(`${profileLabel} train/development row inventories must be unique`);
      }
      if ((outputs.trainRowIds ?? []).some(id => new Set(outputs.developmentRowIds ?? []).has(id))) {
        errors.push(`${profileLabel} train and development row inventories overlap`);
      }
      if (outputs.trainRowIdSha256 !== sha256Text((outputs.trainRowIds ?? []).join('\n'))
        || outputs.developmentRowIdSha256 !== sha256Text((outputs.developmentRowIds ?? []).join('\n'))) {
        errors.push(`${profileLabel} train/development row inventory hash is stale`);
      }
      const sampleOrder = outputs.sampleOrder ?? [];
      const sampleCounts = new Map();
      for (const id of sampleOrder) sampleCounts.set(id, (sampleCounts.get(id) ?? 0) + 1);
      const invalidV052Weighting = manifest.datasetProfile === 'v052' && (
        sampleOrder.length !== 1864
        || [...sampleCounts.values()].filter(count => count === 3).length !== 48
        || [...sampleCounts.values()].some(count => count < 1 || count > 3)
      );
      const invalidV053Weighting = manifest.datasetProfile === 'v053' && (
        sampleOrder.length !== 2088
        || [...sampleCounts.values()].filter(count => count === 5).length !== 64
        || [...sampleCounts.values()].some(count => count < 1 || count > 5)
      );
      const invalidV054Weighting = manifest.datasetProfile === 'v054' && (
        sampleOrder.length !== 1896
        || [...sampleCounts.values()].filter(count => count === 2).length !== 32
        || [...sampleCounts.values()].some(count => count < 1 || count > 2)
      );
      const invalidV055Weighting = manifest.datasetProfile === 'v055' && (
        sampleOrder.length !== 1992
        || [...sampleCounts.values()].filter(count => count === 4).length !== 32
        || [...sampleCounts.values()].some(count => count < 1 || count > 4)
      );
      const invalidV056Weighting = manifest.datasetProfile === 'v056' && (
        sampleOrder.length !== 1944
        || [...sampleCounts.values()].filter(count => count === 2).length !== 56
        || [...sampleCounts.values()].some(count => count < 1 || count > 2)
      );
      if (outputs.sampleOrderSha256 !== sha256Text(sampleOrder.join('\n'))
        || sampleOrder.length !== expectedSampleRows
        || new Set(sampleOrder).size !== expectedTrainRows
        || sampleOrder.some(id => !(outputs.trainRowIds ?? []).includes(id))
        || invalidV052Weighting
        || invalidV053Weighting
        || invalidV054Weighting
        || invalidV055Weighting
        || invalidV056Weighting) {
        errors.push(`${profileLabel} sample order is stale or differs from the governed train inventory/weighting`);
      }
      if (['v054', 'v055', 'v056'].includes(manifest.datasetProfile)) {
        const report = outputs.lossReport ?? {};
        const numeric = [
          report.rawTrainerAccumulatedLoss,
          report.meanTrainingObjectiveLoss,
          report.bestDevelopmentLoss,
          report.finalDevelopmentLoss,
        ];
        if (report.policyId !== 'saferide-v054-training-loss-integrity.1'
          || !numeric.every(Number.isFinite)
          || report.gradientAccumulationSteps !== 8
          || Math.abs(report.rawTrainerAccumulatedLoss / 8 - report.meanTrainingObjectiveLoss) > 1e-9
          || report.bestDevelopmentLoss > report.finalDevelopmentLoss
          || report.finite !== true
          || report.spikeGate !== 'passed'
          || report.divergenceGate !== 'passed') {
          errors.push(`${profileLabel} completed pilot lacks truthful finite raw/objective/best/final loss evidence`);
        }
        if (outputs.lossMaskPolicy !== 'assistant-turns-only') errors.push(`${profileLabel} pilot lacks assistant-only loss-mask evidence`);
      }
    }
  }
  if (['v054', 'v055', 'v056'].includes(manifest.datasetProfile) && manifest.runKind === 'preflight' && manifest.status === 'completed') {
    const outputs = manifest.outputs ?? {};
    const report = outputs.lossReport ?? {};
    const numeric = [report.rawTrainerLoss, report.meanTrainingObjectiveLoss, report.bestDevelopmentLoss, report.finalDevelopmentLoss];
    if (report.policyId !== 'saferide-v054-preflight-loss-integrity.1'
      || !numeric.every(Number.isFinite)
      || report.observedMicrobatches !== 1
      || Math.abs(report.rawTrainerLoss - report.meanTrainingObjectiveLoss) > 1e-9
      || report.finite !== true
      || report.resumeContinuity !== 'not-required') {
      errors.push(`${profileLabel} one-step preflight lacks truthful finite one-microbatch loss evidence`);
    }
    if (outputs.globalSteps !== 1 || outputs.rowsSeen !== 1 || outputs.sampleOrder?.length !== 1) {
      errors.push(`${profileLabel} preflight must execute exactly one step and one governed row`);
    }
    if (outputs.lossMaskPolicy !== 'assistant-turns-only') errors.push(`${profileLabel} preflight lacks assistant-only loss-mask evidence`);
    if (outputs.holdoutRowsRead !== 0) errors.push(`${profileLabel} preflight read a protected holdout row`);
    if (!Array.isArray(outputs.adapterFiles) || outputs.adapterFiles.length === 0) errors.push(`${profileLabel} preflight lacks a hashed adapter inventory`);
    if (!Array.isArray(outputs.checkpoints) || outputs.checkpoints.length === 0) errors.push(`${profileLabel} preflight lacks checkpoint evidence`);
  }
  if (verifyFiles) {
    const allowGovernedExternal = governedProfile;
    const externalPrefix = governedProfile && path.isAbsolute(manifest.register ?? '')
      ? path.dirname(manifest.register)
      : null;
    const externalOptions = { allowExternal: allowGovernedExternal, externalPrefix, sourceRoot };
    validateReferencedFile(manifest.register, manifest.registerSha256, 'register', errors, externalOptions);
    validateReferencedFile(manifest.data, manifest.dataSha256, 'data', errors);
    validateReferencedFile(manifest.audit, manifest.auditSha256, 'audit', errors, externalOptions);
    if (governedProfile) {
      if (manifest.dataFiles !== null && manifest.dataFiles !== undefined) {
        validateReferencedFile(manifest.dataFiles?.train?.path, manifest.dataFiles?.train?.sha256, 'train data', errors, externalOptions);
        validateReferencedFile(manifest.dataFiles?.dev?.path, manifest.dataFiles?.dev?.sha256, 'dev data', errors, externalOptions);
      }
      if ((manifest.datasetManifest !== null && manifest.datasetManifest !== undefined)
        || (manifest.datasetManifestSha256 !== null && manifest.datasetManifestSha256 !== undefined)) {
        validateReferencedFile(manifest.datasetManifest, manifest.datasetManifestSha256, 'dataset manifest', errors, externalOptions);
      }
      if (manifest.datasetBindings?.pilotRowManifest || manifest.datasetBindings?.pilotRowManifestSha256) {
        validateReferencedFile(
          manifest.datasetBindings?.pilotRowManifest,
          manifest.datasetBindings?.pilotRowManifestSha256,
          'pilot row manifest',
          errors,
          externalOptions,
        );
      }
    }
    if (manifest.environment?.requirements || manifest.environment?.requirementsSha256) {
      validateReferencedFile(
        manifest.environment.requirements,
        manifest.environment.requirementsSha256,
        'training requirements',
        errors,
      );
    }
    if (manifest.environment?.constraints || manifest.environment?.constraintsSha256) {
      validateReferencedFile(
        manifest.environment.constraints,
        manifest.environment.constraintsSha256,
        'training constraints',
        errors,
      );
    }
  }
  return errors;
}

function main() {
  const manifestArgument = process.argv[2];
  if (!manifestArgument || ['--help', '-h'].includes(manifestArgument)) {
    console.log('Usage: node scripts/saferide-ai-training-run-check.mjs <metadata.json> [--source-root <staged-package-root>]');
    return manifestArgument ? 0 : 1;
  }
  const extra = process.argv.slice(3);
  if (extra.length !== 0 && (extra.length !== 2 || extra[0] !== '--source-root')) {
    throw new Error('Expected only --source-root <staged-package-root> after the manifest path.');
  }
  const sourceRoot = extra.length === 2 ? path.resolve(extra[1]) : null;
  if (sourceRoot && (!fs.existsSync(sourceRoot) || !fs.statSync(sourceRoot).isDirectory())) {
    throw new Error('Staged package source root is unavailable.');
  }
  const manifestPath = path.resolve(manifestArgument);
  const schema = JSON.parse(fs.readFileSync(path.join(repoRoot, 'schemas/ai-training-run.schema.json'), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, strictTypes: false });
  const errors = validateTrainingRun(manifest, ajv.compile(schema), { sourceRoot });
  console.log('SafeRide content-free training-run manifest check');
  console.log(`Manifest: ${path.relative(repoRoot, manifestPath) || manifestPath}`);
  if (errors.length > 0) {
    errors.forEach(error => console.error(`- ${error}`));
    return 1;
  }
  console.log(`PASS (${manifest.runKind}; ${manifest.status}; promotionEligible=false)`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
