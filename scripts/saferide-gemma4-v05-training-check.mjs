#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';

import { fileSha256 } from './lib/saferide-gemma4-v05.mjs';
import { validateTrainingRun } from './saferide-ai-training-run-check.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultSelection = path.join(repoRoot, 'config/ai/training/saferide-gemma4-v05-training-selection.candidate.json');
const METRIC_TOLERANCE = 1e-12;

function resolve(input) {
  return path.isAbsolute(input) ? input : path.join(repoRoot, input);
}

function compile(name) {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    strictRequired: false,
    strictTypes: false,
    formats: { 'date-time': true },
  });
  if (name === 'ai-v05-development-panel-summary.schema.json') {
    ajv.addSchema(JSON.parse(fs.readFileSync(path.join(repoRoot, 'schemas', 'ai-v05-development-panel-input.schema.json'), 'utf8')));
  }
  return ajv.compile(JSON.parse(fs.readFileSync(path.join(repoRoot, 'schemas', name), 'utf8')));
}

function validationErrors(label, validator, value) {
  if (validator(value)) return [];
  return (validator.errors ?? []).map(error => `${label}${error.instancePath || '/'}: ${error.message ?? error.keyword}`);
}

export function validateSelectedRunConsistency(selection, manifests) {
  if (manifests.length !== 2) return [];
  const errors = [];
  const canonicalBindings = JSON.stringify(manifests[0].datasetBindings);
  if (JSON.stringify(manifests[1].datasetBindings) !== canonicalBindings) errors.push('two seed runs do not bind the same dataset/policy/prompt lineage');
  if (manifests[0].baseModelId !== manifests[1].baseModelId || manifests[0].baseRevision !== manifests[1].baseRevision) {
    errors.push('two seed runs do not bind the same immutable base');
  }
  if (JSON.stringify(manifests[0].dataFiles) !== JSON.stringify(manifests[1].dataFiles)
    || manifests[0].outputs?.trainRowIdSha256 !== manifests[1].outputs?.trainRowIdSha256
    || manifests[0].outputs?.developmentRowIdSha256 !== manifests[1].outputs?.developmentRowIdSha256) {
    errors.push('two seed runs do not use the same exact train/development bytes and row inventories');
  }
  const comparableArguments = manifest => Object.fromEntries(Object.entries(manifest.runArguments ?? {})
    .filter(([key]) => key !== 'seed'));
  if (JSON.stringify(comparableArguments(manifests[0])) !== JSON.stringify(comparableArguments(manifests[1]))) {
    errors.push('two seed runs differ on a hyperparameter other than seed');
  }
  if (manifests[0].outputs?.sampleOrderSha256 === manifests[1].outputs?.sampleOrderSha256) {
    errors.push('two seed runs unexpectedly use the same shuffled sample order');
  }
  const expectedBindings = {
    registerSha256: manifests[0].registerSha256,
    datasetManifestSha256: manifests[0].datasetManifestSha256,
    auditSha256: manifests[0].auditSha256,
    planSha256: manifests[0].datasetBindings?.planSha256,
    policySha256: manifests[0].datasetBindings?.policySha256,
    systemPromptTextSha256: manifests[0].datasetBindings?.systemPromptTextSha256,
    splitManifestSha256: manifests[0].datasetBindings?.splitManifestSha256,
    reviewLedgerSha256: manifests[0].datasetBindings?.reviewLedgerSha256,
  };
  for (const [field, expected] of Object.entries(expectedBindings)) {
    if (!expected || selection.bindings?.[field] !== expected) errors.push(`training selection ${field} does not bind both exact run manifests`);
  }
  return errors;
}

export function developmentPanelEligibilityErrors(run, selectionPolicy) {
  const panel = run?.developmentPanel ?? {};
  const errors = [];
  if (panel.status !== 'passed') errors.push('development panel status is not passed');
  if (panel.criticalFailures !== selectionPolicy?.criticalFailuresMaximum) errors.push('development panel has critical failures');
  for (const field of ['overRefusalRate', 'usefulnessAverage', 'baseOverRefusalRate', 'baseUsefulnessAverage']) {
    if (!Number.isFinite(panel[field])) errors.push(`development panel lacks finite ${field}`);
  }
  if (Number.isFinite(panel.overRefusalRate)
    && panel.overRefusalRate > selectionPolicy?.maximumDevelopmentOverRefusalRate) {
    errors.push('development panel over-refusal rate exceeds the absolute selection ceiling');
  }
  if (Number.isFinite(panel.usefulnessAverage)
    && panel.usefulnessAverage < selectionPolicy?.minimumDevelopmentUsefulnessAverage) {
    errors.push('development panel usefulness average is below the absolute selection floor');
  }
  if (Number.isFinite(panel.overRefusalRate) && Number.isFinite(panel.baseOverRefusalRate)
    && panel.overRefusalRate - panel.baseOverRefusalRate > selectionPolicy?.maximumOverRefusalRegression + METRIC_TOLERANCE) {
    errors.push('development panel materially regresses over-refusal versus the base comparator');
  }
  if (Number.isFinite(panel.usefulnessAverage) && Number.isFinite(panel.baseUsefulnessAverage)
    && panel.baseUsefulnessAverage - panel.usefulnessAverage > selectionPolicy?.maximumUsefulnessRegression + METRIC_TOLERANCE) {
    errors.push('development panel materially regresses usefulness versus the base comparator');
  }
  return errors;
}

function canonicalSha256(value) {
  const canonical = JSON.stringify(value, (_key, entry) => (
    entry && typeof entry === 'object' && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([left], [right]) => left.localeCompare(right)))
      : entry
  ));
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

export function validateDevelopmentPanelSummary(summary, run, manifest, selection) {
  const errors = validationErrors(
    'developmentPanelSummary',
    compile('ai-v05-development-panel-summary.schema.json'),
    summary,
  );
  const panel = run.developmentPanel ?? {};
  if (summary.status !== 'passed' || summary.eligibility?.eligible !== true || summary.eligibility?.reasons?.length) {
    errors.push('development panel summary is not eligible and passed');
  }
  if (
    summary.candidate?.seed !== run.seed
    || summary.candidate?.runId !== run.runId
    || summary.candidate?.manifestSha256 !== run.manifestSha256
    || summary.candidate?.bestCheckpoint !== run.bestCheckpoint
  ) errors.push('development panel summary candidate lineage differs from the training selection');
  if (
    summary.baseModel?.modelId !== selection.baseModelId
    || summary.baseModel?.revision !== selection.baseRevision
  ) errors.push('development panel summary base lineage differs from the training selection');
  if (
    summary.suite?.dataSha256 !== manifest.dataFiles?.dev?.sha256
    || summary.suite?.rowInventorySha256 !== manifest.outputs?.developmentRowIdSha256
  ) errors.push('development panel summary does not bind the selected run development bytes and row inventory');
  const adapterInventorySha256 = canonicalSha256(manifest.outputs?.adapterFiles ?? []);
  if (summary.candidate?.adapterInventorySha256 !== adapterInventorySha256) {
    errors.push('development panel summary adapter inventory differs from the selected run');
  }
  if (
    summary.metrics?.criticalFailures !== panel.criticalFailures
    || summary.metrics?.overRefusalRate !== panel.overRefusalRate
    || summary.metrics?.usefulnessAverage !== panel.usefulnessAverage
    || summary.metrics?.baseOverRefusalRate !== panel.baseOverRefusalRate
    || summary.metrics?.baseUsefulnessAverage !== panel.baseUsefulnessAverage
  ) errors.push('development panel summary metrics differ from the training selection');
  const expectedPolicy = {
    criticalFailuresMaximum: selection.selectionPolicy?.criticalFailuresMaximum,
    maximumDevelopmentOverRefusalRate: selection.selectionPolicy?.maximumDevelopmentOverRefusalRate,
    minimumDevelopmentUsefulnessAverage: selection.selectionPolicy?.minimumDevelopmentUsefulnessAverage,
    maximumOverRefusalRegression: selection.selectionPolicy?.maximumOverRefusalRegression,
    maximumUsefulnessRegression: selection.selectionPolicy?.maximumUsefulnessRegression,
  };
  if (JSON.stringify(summary.selectionPolicy) !== JSON.stringify(expectedPolicy)) {
    errors.push('development panel summary selection policy differs from the training selection');
  }
  for (const slot of ['candidate', 'base']) {
    const coverage = summary.coverage?.[slot] ?? {};
    if (coverage.rowCount !== 300 || coverage.completed + coverage.truncated + coverage.errors !== 300) {
      errors.push(`development panel summary ${slot} coverage is incomplete`);
    }
  }
  if (
    summary.promotionEligible !== false
    || JSON.stringify(summary.remainingPromotionGates) !== JSON.stringify([
      'protected-evaluation', 'human-review', 'export', 'physical-device-proof',
    ])
  ) errors.push('development panel summary weakens downstream promotion gates');
  return errors;
}

export function validateV05TrainingSelection(selection, { verifyFiles = true } = {}) {
  const errors = validationErrors('selection', compile('ai-v05-training-selection.schema.json'), selection);
  const seeds = (selection.candidateRuns ?? []).map(run => run.seed);
  if (new Set(seeds).size !== 2 || ![419805, 419806].every(seed => seeds.includes(seed))) {
    errors.push('selection requires one run for each fixed seed');
  }
  if (selection.status === 'blocked') {
    if (selection.selected !== null) errors.push('blocked selection cannot name a selected checkpoint');
    if (!(selection.blockers?.length > 0)) errors.push('blocked selection must name blockers');
    return errors;
  }
  if (selection.blockers?.length) errors.push('selected decision cannot retain blockers');
  if (!selection.baseRevision) errors.push('selected decision requires immutable base revision');
  if (selection.repeatability?.status !== 'passed' || !selection.repeatability?.evidenceRef) {
    errors.push('selected decision requires two-seed repeatability evidence');
  }
  const completedRunIds = (selection.candidateRuns ?? []).map(run => run.runId);
  const completedManifestHashes = (selection.candidateRuns ?? []).map(run => run.manifestSha256);
  if (new Set(completedRunIds).size !== 2 || completedRunIds.some(runId => !runId)) {
    errors.push('two seed candidates require distinct non-empty run IDs');
  }
  if (new Set(completedManifestHashes).size !== 2 || completedManifestHashes.some(hash => !hash)) {
    errors.push('two seed candidates require distinct hash-bound run manifests');
  }
  const trainingSchema = compile('ai-training-run.schema.json');
  const manifests = [];
  const panelSummaries = [];
  for (const run of selection.candidateRuns ?? []) {
    if (run.status !== 'completed' || !run.manifestPath || !run.manifestSha256) {
      errors.push(`seed ${run.seed} run is not completed and hash-bound`);
      continue;
    }
    const manifestPath = resolve(run.manifestPath);
    if (!fs.existsSync(manifestPath) || fileSha256(manifestPath) !== run.manifestSha256) {
      errors.push(`seed ${run.seed} manifest is missing or hash-mismatched`);
      continue;
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifests.push(manifest);
    errors.push(...validateTrainingRun(manifest, trainingSchema, { verifyFiles }).map(error => `seed ${run.seed}: ${error}`));
    if (manifest.datasetProfile !== 'v05' || manifest.runKind !== 'candidate' || manifest.status !== 'completed') {
      errors.push(`seed ${run.seed} is not a completed v0.5 candidate manifest`);
    }
    if (manifest.runArguments?.seed !== run.seed || manifest.runId !== run.runId) errors.push(`seed ${run.seed} manifest identity mismatch`);
    if (manifest.baseRevision !== selection.baseRevision) errors.push(`seed ${run.seed} base revision mismatch`);
    if (manifest.outputs?.bestCheckpoint !== run.bestCheckpoint || manifest.outputs?.bestMetric !== run.developmentAssistantTokenLoss) {
      errors.push(`seed ${run.seed} checkpoint or development loss differs from its run manifest`);
    }
    const panel = run.developmentPanel;
    if (panel.status !== 'passed' || panel.criticalFailures !== 0 || !panel.summaryRef || !panel.summarySha256) {
      errors.push(`seed ${run.seed} development panel is not passed with zero critical failures`);
    }
    errors.push(...developmentPanelEligibilityErrors(run, selection.selectionPolicy)
      .map(error => `seed ${run.seed}: ${error}`));
    if (panel.status === 'passed' && panel.criticalFailures === 0 && panel.summaryRef && panel.summarySha256 && verifyFiles) {
      const panelPath = resolve(panel.summaryRef);
      if (!fs.existsSync(panelPath) || fileSha256(panelPath) !== panel.summarySha256) {
        errors.push(`seed ${run.seed} development panel hash is stale`);
      } else {
        const summary = JSON.parse(fs.readFileSync(panelPath, 'utf8'));
        panelSummaries.push(summary);
        errors.push(...validateDevelopmentPanelSummary(summary, run, manifest, selection)
          .map(error => `seed ${run.seed}: ${error}`));
      }
    }
  }
  errors.push(...validateSelectedRunConsistency(selection, manifests));
  if (verifyFiles && panelSummaries.length === 2) {
    const [first, second] = panelSummaries;
    if (
      first.rawArtifacts?.baseBundleSha256 !== second.rawArtifacts?.baseBundleSha256
      || first.metrics?.baseCriticalFailures !== second.metrics?.baseCriticalFailures
      || first.metrics?.baseOverRefusalRate !== second.metrics?.baseOverRefusalRate
      || first.metrics?.baseUsefulnessAverage !== second.metrics?.baseUsefulnessAverage
      || first.provenance?.panelInputSha256 !== second.provenance?.panelInputSha256
      || first.provenance?.scoringPolicySha256 !== second.provenance?.scoringPolicySha256
    ) errors.push('two development panel summaries do not bind one base comparator, panel input, and scoring policy');
  }
  const selected = selection.candidateRuns?.find(run => run.runId === selection.selected?.runId);
  if (!selected || selected.seed !== selection.selected?.seed || selected.bestCheckpoint !== selection.selected?.checkpoint) {
    errors.push('selected checkpoint does not identify one completed candidate run');
  }
  const eligible = (selection.candidateRuns ?? []).filter(run => (
    run.status === 'completed'
    && Number.isFinite(run.developmentAssistantTokenLoss)
    && developmentPanelEligibilityErrors(run, selection.selectionPolicy).length === 0
  ));
  if (eligible.length === 0) errors.push('no candidate is eligible for development-loss ranking');
  if (selected && !eligible.includes(selected)) errors.push('selected checkpoint is not safety/usefulness eligible');
  const minimumLoss = Math.min(...eligible.map(run => run.developmentAssistantTokenLoss));
  if (selected && eligible.includes(selected) && selected.developmentAssistantTokenLoss !== minimumLoss) {
    errors.push('selected checkpoint does not have the lowest eligible development assistant-token loss');
  }
  return errors;
}

function main() {
  const selectionPath = resolve(process.argv[2] && !process.argv[2].startsWith('-') ? process.argv[2] : defaultSelection);
  const strict = process.argv.includes('--strict');
  const selection = JSON.parse(fs.readFileSync(selectionPath, 'utf8'));
  const errors = validateV05TrainingSelection(selection, { verifyFiles: strict });
  console.log('SafeRide v0.5 two-seed training selection check');
  console.log(`Status: ${selection.status}`);
  if (errors.length) {
    errors.forEach(error => console.error(`- ${error}`));
    return 1;
  }
  if (strict && selection.status !== 'selected') {
    console.error('- strict selection requires status=selected');
    return 1;
  }
  console.log(selection.status === 'blocked'
    ? `PASS (truthfully blocked; ${selection.blockers.length} blocker groups remain).`
    : 'PASS (two complete seeds; development-only checkpoint selection; promotionEligible=false).');
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
