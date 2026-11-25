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
const METRIC_TOLERANCE = 1e-12;
const REQUIRED_SUITES = ['original-development', 'mitigation-development'];

function resolve(input) {
  return path.isAbsolute(input) ? input : path.join(repoRoot, input);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function compile(name) {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    strictRequired: false,
    strictTypes: false,
    formats: { 'date-time': true },
  });
  if (name === 'ai-v051-development-panel-summary.schema.json') {
    ajv.addSchema(readJson(path.join(repoRoot, 'schemas/ai-v051-development-panel-input.schema.json')));
  }
  return ajv.compile(readJson(path.join(repoRoot, 'schemas', name)));
}

function validationErrors(label, validator, value) {
  if (validator(value)) return [];
  return (validator.errors ?? []).map(error => `${label}${error.instancePath || '/'}: ${error.message ?? error.keyword}`);
}

function canonicalSha256(value) {
  const canonical = JSON.stringify(value, (_key, entry) => (
    entry && typeof entry === 'object' && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([left], [right]) => left.localeCompare(right)))
      : entry
  ));
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

export function suiteEligibilityErrors(suite, policy) {
  const errors = [];
  if (!REQUIRED_SUITES.includes(suite?.suiteId)) errors.push('development suite identity differs');
  if (suite?.completed + suite?.truncated + suite?.errors !== suite?.requiredCount) errors.push('development suite coverage is incomplete');
  if (suite?.errors !== policy?.generationErrorsMaximum) errors.push('development suite has generation errors');
  if (suite?.criticalFailures !== policy?.criticalFailuresMaximum) errors.push('development suite has critical failures');
  for (const field of ['overRefusalRate', 'usefulnessAverage', 'baseOverRefusalRate', 'baseUsefulnessAverage']) {
    if (!Number.isFinite(suite?.[field])) errors.push(`development suite lacks finite ${field}`);
  }
  if (Number.isFinite(suite?.overRefusalRate)
    && suite.overRefusalRate > policy?.maximumDevelopmentOverRefusalRate) {
    errors.push('development suite over-refusal rate exceeds the absolute ceiling');
  }
  if (Number.isFinite(suite?.usefulnessAverage)
    && suite.usefulnessAverage < policy?.minimumDevelopmentUsefulnessAverage) {
    errors.push('development suite usefulness average is below the absolute floor');
  }
  if (Number.isFinite(suite?.overRefusalRate) && Number.isFinite(suite?.baseOverRefusalRate)
    && suite.overRefusalRate - suite.baseOverRefusalRate > policy?.maximumOverRefusalRegression + METRIC_TOLERANCE) {
    errors.push('development suite materially regresses over-refusal versus base');
  }
  if (Number.isFinite(suite?.usefulnessAverage) && Number.isFinite(suite?.baseUsefulnessAverage)
    && suite.baseUsefulnessAverage - suite.usefulnessAverage > policy?.maximumUsefulnessRegression + METRIC_TOLERANCE) {
    errors.push('development suite materially regresses usefulness versus base');
  }
  return errors;
}

export function candidateEligibilityErrors(run, policy) {
  const errors = [];
  if (run?.developmentPanel?.status !== 'passed') errors.push('two-suite development panel status is not passed');
  const suites = run?.developmentPanel?.suites ?? [];
  if (suites.map(suite => suite.suiteId).join(',') !== REQUIRED_SUITES.join(',')) {
    errors.push('two-suite development panel inventory differs');
  }
  for (const suite of suites) {
    errors.push(...suiteEligibilityErrors(suite, policy).map(error => `${suite.suiteId}: ${error}`));
  }
  return errors;
}

export function validateRunConsistency(selection, manifests) {
  const errors = [];
  if (manifests.length !== 2) return errors;
  const [first, second] = manifests;
  if (first.baseModelId !== second.baseModelId || first.baseRevision !== second.baseRevision) {
    errors.push('candidate runs do not bind the same immutable base');
  }
  if (JSON.stringify(first.dataFiles) !== JSON.stringify(second.dataFiles)
    || first.outputs?.trainRowIdSha256 !== second.outputs?.trainRowIdSha256
    || first.outputs?.developmentRowIdSha256 !== second.outputs?.developmentRowIdSha256) {
    errors.push('candidate runs do not bind the same train/development bytes and inventories');
  }
  const comparable = manifest => Object.fromEntries(Object.entries(manifest.runArguments ?? {})
    .filter(([key]) => key !== 'seed'));
  if (JSON.stringify(comparable(first)) !== JSON.stringify(comparable(second))) {
    errors.push('candidate runs differ on a hyperparameter other than seed');
  }
  if (first.outputs?.sampleOrderSha256 === second.outputs?.sampleOrderSha256) {
    errors.push('candidate runs unexpectedly use the same shuffled sample order');
  }
  const bindings = selection.bindings ?? {};
  const expected = {
    registerSha256: first.registerSha256,
    frozenManifestSha256: first.datasetManifestSha256,
    combinedTrainSha256: first.dataFiles?.train?.sha256,
    originalDevelopmentSha256: first.dataFiles?.dev?.sha256,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (!value || bindings[key] !== value) errors.push(`training selection ${key} differs from the candidate manifests`);
  }
  return errors;
}

function summarySuiteMetrics(result) {
  return {
    suiteId: result.suiteId,
    requiredCount: result.requiredCount,
    completed: result.coverage?.candidate?.completed,
    truncated: result.coverage?.candidate?.truncated,
    errors: result.coverage?.candidate?.errors,
    criticalFailures: result.metrics?.criticalFailures,
    overRefusalRate: result.metrics?.overRefusalRate,
    usefulnessAverage: result.metrics?.usefulnessAverage,
    baseCriticalFailures: result.metrics?.baseCriticalFailures,
    baseOverRefusalRate: result.metrics?.baseOverRefusalRate,
    baseUsefulnessAverage: result.metrics?.baseUsefulnessAverage,
  };
}

export function validatePanelSummary(summary, run, manifest, selection) {
  const errors = validationErrors(
    'developmentPanelSummary',
    compile('ai-v051-development-panel-summary.schema.json'),
    summary,
  );
  if (summary.status !== 'passed' || summary.eligibility?.eligible !== true || summary.eligibility?.reasons?.length) {
    errors.push('two-suite panel summary is not eligible and passed');
  }
  if (summary.candidate?.seed !== run.seed
    || summary.candidate?.runId !== run.runId
    || summary.candidate?.manifestSha256 !== run.manifestSha256
    || summary.candidate?.bestCheckpoint !== run.bestCheckpoint
    || summary.candidate?.developmentAssistantTokenLoss !== run.developmentAssistantTokenLoss) {
    errors.push('two-suite panel summary candidate lineage differs');
  }
  if (summary.candidate?.adapterInventorySha256 !== canonicalSha256(manifest.outputs?.adapterFiles ?? [])) {
    errors.push('two-suite panel summary adapter inventory differs from the candidate manifest');
  }
  if (summary.baseModel?.modelId !== selection.baseModelId || summary.baseModel?.revision !== selection.baseRevision) {
    errors.push('two-suite panel summary base lineage differs');
  }
  const results = summary.suiteResults ?? [];
  if (results.map(result => result.suiteId).join(',') !== REQUIRED_SUITES.join(',')) {
    errors.push('two-suite panel summary suite order differs');
  }
  const original = results.find(result => result.suiteId === 'original-development');
  const mitigation = results.find(result => result.suiteId === 'mitigation-development');
  if (original?.dataSha256 !== manifest.dataFiles?.dev?.sha256
    || original?.rowInventorySha256 !== manifest.outputs?.developmentRowIdSha256) {
    errors.push('original development panel does not bind candidate training evidence');
  }
  if (mitigation?.dataSha256 !== selection.bindings?.mitigationDevelopmentSha256) {
    errors.push('mitigation development panel does not bind the frozen selection input');
  }
  const recorded = run.developmentPanel?.suites ?? [];
  if (JSON.stringify(results.map(summarySuiteMetrics)) !== JSON.stringify(recorded)) {
    errors.push('two-suite panel summary metrics differ from the training selection');
  }
  for (const result of results) {
    const count = result.requiredCount;
    for (const slot of ['candidate', 'base']) {
      const coverage = result.coverage?.[slot] ?? {};
      if (coverage.rowCount !== count || coverage.completed + coverage.truncated + coverage.errors !== count) {
        errors.push(`${result.suiteId} ${slot} coverage is incomplete`);
      }
    }
    if (result.eligibility?.eligible !== true || result.eligibility?.reasons?.length) {
      errors.push(`${result.suiteId} is not independently eligible`);
    }
  }
  const expectedPolicy = {
    criticalFailuresMaximum: selection.selectionPolicy?.criticalFailuresMaximum,
    maximumDevelopmentOverRefusalRate: selection.selectionPolicy?.maximumDevelopmentOverRefusalRate,
    minimumDevelopmentUsefulnessAverage: selection.selectionPolicy?.minimumDevelopmentUsefulnessAverage,
    maximumOverRefusalRegression: selection.selectionPolicy?.maximumOverRefusalRegression,
    maximumUsefulnessRegression: selection.selectionPolicy?.maximumUsefulnessRegression,
  };
  if (JSON.stringify(summary.selectionPolicy) !== JSON.stringify(expectedPolicy)) {
    errors.push('two-suite panel summary selection policy differs');
  }
  if (summary.promotionEligible !== false
    || JSON.stringify(summary.remainingPromotionGates) !== JSON.stringify([
      'protected-evaluation', 'consolidated-human-review', 'export', 'physical-device-proof',
    ])) {
    errors.push('two-suite panel summary weakens downstream promotion gates');
  }
  return errors;
}

export function validateV051TrainingSelection(selection, { verifyFiles = true, sourceRoot = null } = {}) {
  const errors = validationErrors('selection', compile('ai-v051-training-selection.schema.json'), selection);
  const seeds = (selection.candidateRuns ?? []).map(run => run.seed);
  if (new Set(seeds).size !== 2 || seeds.join(',') !== '419805,419806') {
    errors.push('selection requires the two fixed seeds in canonical order');
  }
  if (selection.status === 'blocked') {
    if (selection.selected !== null) errors.push('blocked selection cannot name a selected checkpoint');
    if (!(selection.blockers?.length > 0)) errors.push('blocked selection must name blockers');
    return errors;
  }
  if (selection.blockers?.length) errors.push('selected decision cannot retain blockers');
  if (selection.repeatability?.status !== 'passed' || !selection.repeatability?.evidenceRef) {
    errors.push('selected decision requires passed two-seed repeatability evidence');
  }
  const trainingSchema = compile('ai-training-run.schema.json');
  const manifests = [];
  const summaries = [];
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
    const manifest = readJson(manifestPath);
    manifests.push(manifest);
    errors.push(...validateTrainingRun(manifest, trainingSchema, { verifyFiles, sourceRoot })
      .map(error => `seed ${run.seed}: ${error}`));
    if (manifest.datasetProfile !== 'v051' || manifest.runKind !== 'candidate' || manifest.status !== 'completed') {
      errors.push(`seed ${run.seed} is not a completed v0.5.1 candidate manifest`);
    }
    if (manifest.runArguments?.seed !== run.seed || manifest.runId !== run.runId) {
      errors.push(`seed ${run.seed} manifest identity differs`);
    }
    if (manifest.baseRevision !== selection.baseRevision) errors.push(`seed ${run.seed} base revision differs`);
    if (manifest.outputs?.bestCheckpoint !== run.bestCheckpoint
      || manifest.outputs?.bestMetric !== run.developmentAssistantTokenLoss) {
      errors.push(`seed ${run.seed} checkpoint or development loss differs`);
    }
    errors.push(...candidateEligibilityErrors(run, selection.selectionPolicy).map(error => `seed ${run.seed}: ${error}`));
    const panel = run.developmentPanel ?? {};
    if (verifyFiles && panel.summaryRef && panel.summarySha256) {
      const summaryPath = resolve(panel.summaryRef);
      if (!fs.existsSync(summaryPath) || fileSha256(summaryPath) !== panel.summarySha256) {
        errors.push(`seed ${run.seed} panel summary hash is stale`);
      } else {
        const summary = readJson(summaryPath);
        summaries.push(summary);
        errors.push(...validatePanelSummary(summary, run, manifest, selection).map(error => `seed ${run.seed}: ${error}`));
      }
    } else if (verifyFiles) {
      errors.push(`seed ${run.seed} panel summary binding is unavailable`);
    }
  }
  errors.push(...validateRunConsistency(selection, manifests));
  if (verifyFiles && summaries.length === 2) {
    const [first, second] = summaries;
    if (first.provenance?.panelInputSha256 !== second.provenance?.panelInputSha256
      || first.provenance?.scoringPolicySha256 !== second.provenance?.scoringPolicySha256) {
      errors.push('candidate summaries do not bind one panel input and scoring policy');
    }
    for (const suiteId of REQUIRED_SUITES) {
      const firstSuite = first.suiteResults?.find(result => result.suiteId === suiteId);
      const secondSuite = second.suiteResults?.find(result => result.suiteId === suiteId);
      if (firstSuite?.rawArtifacts?.baseBundleSha256 !== secondSuite?.rawArtifacts?.baseBundleSha256
        || firstSuite?.metrics?.baseCriticalFailures !== secondSuite?.metrics?.baseCriticalFailures
        || firstSuite?.metrics?.baseOverRefusalRate !== secondSuite?.metrics?.baseOverRefusalRate
        || firstSuite?.metrics?.baseUsefulnessAverage !== secondSuite?.metrics?.baseUsefulnessAverage) {
        errors.push(`${suiteId} summaries do not bind one base comparator`);
      }
    }
  }
  const eligible = (selection.candidateRuns ?? []).filter(run => (
    run.status === 'completed'
    && Number.isFinite(run.developmentAssistantTokenLoss)
    && candidateEligibilityErrors(run, selection.selectionPolicy).length === 0
  ));
  if (!eligible.length) errors.push('no candidate is eligible for development-loss ranking');
  const selected = selection.candidateRuns?.find(run => run.runId === selection.selected?.runId);
  if (!selected
    || selected.seed !== selection.selected?.seed
    || selected.bestCheckpoint !== selection.selected?.checkpoint
    || selected.manifestSha256 !== selection.selected?.candidateManifestSha256
    || selected.developmentPanel?.summarySha256 !== selection.selected?.panelSummarySha256) {
    errors.push('selected checkpoint does not bind one exact candidate and panel summary');
  }
  if (selected && !eligible.includes(selected)) errors.push('selected checkpoint is not eligible on both development suites');
  const minimumLoss = Math.min(...eligible.map(run => run.developmentAssistantTokenLoss));
  if (selected && eligible.includes(selected) && selected.developmentAssistantTokenLoss !== minimumLoss) {
    errors.push('selected checkpoint does not have the lowest eligible development assistant-token loss');
  }
  return errors;
}

function parseArgs(argv) {
  const options = { strict: false, sourceRoot: null, selection: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--strict') options.strict = true;
    else if (argument === '--source-root') options.sourceRoot = path.resolve(argv[++index]);
    else if (!argument.startsWith('-') && !options.selection) options.selection = path.resolve(argument);
    else throw new Error(`Unexpected argument: ${argument}`);
  }
  if (!options.selection) throw new Error('Usage: node scripts/saferide-gemma4-v051-training-check.mjs <selection.json> [--strict --source-root <staged-package-root>]');
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const selection = readJson(options.selection);
  const errors = validateV051TrainingSelection(selection, {
    verifyFiles: options.strict,
    sourceRoot: options.sourceRoot,
  });
  console.log('SafeRide v0.5.1 two-seed training selection check');
  console.log(`Status: ${selection.status}`);
  if (errors.length) {
    errors.forEach(error => console.error(`- ${error}`));
    return 1;
  }
  if (options.strict && selection.status !== 'selected') {
    console.error('- strict selection requires status=selected');
    return 1;
  }
  console.log(selection.status === 'blocked'
    ? `PASS (truthfully blocked; ${selection.blockers.length} blocker groups remain).`
    : 'PASS (two complete seeds; both development suites eligible; lowest-loss checkpoint selected; promotionEligible=false).');
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
