#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resultRelative = 'docs/qa/saferide-gemma4-v058-development-candidate-result-2026-08-09.json';
const handoffRelative = 'docs/qa/saferide-gemma4-v058-development-candidate-result-2026-08-09.md';
const schemaRelative = 'schemas/ai-v058-development-candidate-result.schema.json';
const readBytes = relative => fs.readFileSync(path.join(repoRoot, relative));
const readJson = relative => JSON.parse(readBytes(relative).toString('utf8'));
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const fileSha256 = relative => sha256(readBytes(relative));
const finite = value => typeof value === 'number' && Number.isFinite(value);

function collectKeys(value, keys = []) {
  if (Array.isArray(value)) value.forEach(item => collectKeys(item, keys));
  else if (value && typeof value === 'object') Object.entries(value).forEach(([key, item]) => { keys.push(key); collectKeys(item, keys); });
  return keys;
}

function metricErrors(metric, label) {
  const errors = [];
  if (metric?.rowCount !== metric?.completed + metric?.truncated + metric?.errors
    || metric?.modelTerminatorStops !== metric?.completed) errors.push(`${label} accounting differs`);
  if (![metric?.overRefusalRate, metric?.usefulnessAverage].every(finite)) errors.push(`${label} aggregate metric is non-finite`);
  return errors;
}

function main() {
  const result = readJson(resultRelative); const errors = [];
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, strictTypes: false, validateFormats: false });
  const validate = ajv.compile(readJson(schemaRelative));
  if (!validate(result)) errors.push(...(validate.errors ?? []).map(error => `result${error.instancePath || '/'}: ${error.message}`));

  const expectedBindings = {
    currentPlanSha256: ['config/ai/training/saferide-gemma4-v058-development-candidate-training-plan.json', '504df04be4f98ad75f22da8577f203923149348a8acbe93e41cdc0c1753f28bb'],
    currentRunnerSha256: ['scripts/saferide-gemma4-v058-finetune-runner.py', 'b4929f26b9b896abe121a5289598a99876d696011438b6265f7064d611655eb3'],
    shellLauncherSha256: ['scripts/saferide-gemma4-v058-a11-shell-launcher.sh', 'bf900ae9c0e3ec8c919f235c33a280a91df4ea66417e156fe71cc79ec98bbfa1'],
    developmentPanelSha256: ['scripts/saferide-gemma4-v058-development-panel.py', 'b969bb171fc50088685c686e0102be611ea1a3ecd13b8c3a7f3aba911b8afba1'],
  };
  for (const [field, [relative, expected]] of Object.entries(expectedBindings)) {
    if (fileSha256(relative) !== expected || result.bindings?.[field] !== expected) errors.push(`repository result binding differs: ${field}`);
  }
  const expectedModelFiles = [
    ['.gitattributes', 1570, '34448b82c17d60fec9b65b1f093c115ddbaadc04beb1b0140b6bfed2e012a930'],
    ['README.md', 26744, 'be82a1570493c695dd2da37dcf80f2c3fca7e7d5bdf25eacebb0acef0c3a3758'],
    ['chat_template.jinja', 17336, '2f1b4d75d067bae3fe44e676721c7f077d243bc007156cb9c2f8b5836613d082'],
    ['config.json', 4954, '1b28f3d2c3100f6c594754b81107428bd7b822a7f48272ca681dae9d2ec38330'],
    ['generation_config.json', 208, 'd4226bbe3117d2d253ba4609720ba82c6c4ce4627a9a6ae05387c78983ac03de'],
    ['model.safetensors', 10246621918, '2db5482b20d746879bb3ef79b5203e9075a2e2b98f54ec7c2f281c1477ddc550'],
    ['processor_config.json', 1689, '32bdf45d2ad4cc29a0822ddd157a182de76644f0419a6228d151495256e9813c'],
    ['tokenizer.json', 32169626, 'cc8d3a0ce36466ccc1278bf987df5f71db1719b9ca6b4118264f45cb627bfe0f'],
    ['tokenizer_config.json', 2095, '90c3a3ba5bf53818383a58e1a776cbcacd2a038d4812eaa373e1522f2d06f3df'],
  ].map(([path, sizeBytes, digest]) => ({ path, sizeBytes, sha256: digest }));
  if (JSON.stringify(result.bindings?.modelFiles) !== JSON.stringify(expectedModelFiles)) errors.push('nine-file model rehash evidence differs');

  const candidates = result.candidates ?? [];
  if (JSON.stringify(candidates.map(item => item.seed)) !== JSON.stringify([419805, 419806])) errors.push('candidate order differs');
  const first = candidates[0] ?? {}; const second = candidates[1] ?? {};
  if (first.predecessorMetadataSha256 !== null || second.predecessorMetadataSha256 !== first.metadataSha256) errors.push('sequential predecessor binding differs');
  if (first.recovery?.performed !== true || second.recovery?.performed !== false) errors.push('candidate recovery ledger differs');
  for (const candidate of candidates) {
    if (![candidate.loss?.rawTrainerAccumulatedLoss, candidate.loss?.meanTrainingObjectiveLoss, candidate.loss?.bestDevelopmentLoss, candidate.loss?.finalDevelopmentLoss].every(finite)) errors.push(`candidate ${candidate.seed} loss is non-finite`);
    if (candidate.loss?.meanTrainingObjectiveLoss !== candidate.loss?.rawTrainerAccumulatedLoss / 8) errors.push(`candidate ${candidate.seed} accumulated-loss normalization differs`);
  }

  const panels = result.developmentPanels ?? [];
  if (JSON.stringify(panels.map(item => item.seed)) !== JSON.stringify([419805, 419806])) errors.push('development-panel order differs');
  for (const panel of panels) {
    errors.push(...metricErrors(panel.combined, `candidate ${panel.seed} combined`));
    for (const [index, metric] of (panel.suiteResults ?? []).entries()) errors.push(...metricErrors(metric, `candidate ${panel.seed} suite ${index}`));
    for (const [group, values] of [['language', panel.byLanguage], ['category', panel.byCategory], ['track', panel.byTrack], ['variant', panel.byVariant]]) {
      for (const metric of values ?? []) errors.push(...metricErrors(metric, `candidate ${panel.seed} ${group}`));
    }
    if (panel.combined?.rowCount !== 320 || panel.holdoutRowsRead !== 0) errors.push(`candidate ${panel.seed} panel boundary differs`);
    if ((panel.eligibility?.reasons?.length === 0) !== (panel.eligibility?.developmentGatePassed === true)) errors.push(`candidate ${panel.seed} eligibility reason state differs`);
    if ((panel.status === 'passed') !== (panel.eligibility?.developmentGatePassed === true)) errors.push(`candidate ${panel.seed} summary status differs`);
  }

  const publicText = `${JSON.stringify(result)}\n${readBytes(handoffRelative).toString('utf8')}`;
  const forbidden = [/(?:\/home\/|\/opt\/|\/root\/)/i, /(?:AKIA|ASIA)[A-Z0-9]{16}/, /-----BEGIN [A-Z ]+PRIVATE KEY-----/, /https?:\/\//i];
  if (forbidden.some(pattern => pattern.test(publicText))) errors.push('result evidence contains a private path, credential-like value, key, or URL');
  const prohibitedKeys = new Set(['completion', 'messages', 'prompt', 'rowId', 'rowIds', 'privatePath', 'excerpt', 'encoded']);
  if (collectKeys(result).some(key => prohibitedKeys.has(key))) errors.push('result evidence contains raw content or protected identifiers');
  if (Object.values(result.privacy ?? {}).some(value => value !== false)) errors.push('result privacy declaration differs');
  if (errors.length) { errors.forEach(error => console.error(`- ${error}`)); return 1; }
  console.log(`SafeRide v0.5.8 candidate/result evidence PASS (2 candidates; 640 development responses; holdout/selection/promotion=false; resultSha256=${fileSha256(resultRelative)}).`);
  return 0;
}

process.exitCode = main();
