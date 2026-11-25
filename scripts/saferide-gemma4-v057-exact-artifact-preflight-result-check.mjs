#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resultRelative = 'docs/qa/saferide-gemma4-v057-exact-artifact-preflight-2026-08-09.json';
const handoffRelative = 'docs/qa/saferide-gemma4-v057-exact-artifact-preflight-2026-08-09.md';
const planRelative = 'config/ai/datasets/saferide-gemma4-v057-replacement-pilot-plan.json';
const correctionCommit = '5da6f652c82605f13948d76846603fed774635a2';
const pendingPlanSha256 = 'e773bb30b757741d36d9bfa827a43cfc5e8bc49039e9e337e27ad917e6796c5f';

const absolute = relative => path.join(repoRoot, relative);
const bytes = relative => fs.readFileSync(absolute(relative));
const json = relative => JSON.parse(bytes(relative).toString('utf8'));
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const fileAtCommit = (commit, relative) => execFileSync('git', ['show', `${commit}:${relative}`], { cwd: repoRoot, encoding: null, maxBuffer: 8 * 1024 * 1024 });

function collectKeys(value, keys = []) {
  if (Array.isArray(value)) value.forEach(item => collectKeys(item, keys));
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
    keys.push(key); collectKeys(item, keys);
  }
  return keys;
}

function main() {
  const result = json(resultRelative);
  const errors = [];
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, strictTypes: false, validateFormats: false });
  const validate = ajv.compile(json('schemas/ai-v057-exact-artifact-preflight-result.schema.json'));
  if (!validate(result)) errors.push(...(validate.errors ?? []).map(error => `${error.instancePath || '/'}: ${error.message}`));

  const planBytes = fileAtCommit(correctionCommit, planRelative);
  const plan = JSON.parse(planBytes.toString('utf8'));
  if (sha256(planBytes) !== pendingPlanSha256 || result.bindings?.pendingPlanSha256 !== pendingPlanSha256
    || plan.status !== 'code-fixed-panel-authorization-pending'
    || plan.replacementAuthorization?.panelRunsAuthorized !== 2
    || plan.replacementAuthorization?.panelRunsPerformed !== 2
    || plan.replacementAuthorization?.panelRunsRemaining !== 0
    || plan.replacementAuthorization?.panelRunAuthorization !== null) errors.push('preflight fail-closed plan binding differs');
  for (const binding of plan.codeBindings ?? []) if (sha256(fileAtCommit(correctionCommit, binding.path)) !== binding.sha256) {
    errors.push(`preflight execution binding differs: ${binding.path}`);
  }

  const runtime = result.preflight?.effectiveRuntime ?? {};
  const coverage = result.preflight?.coverage ?? {};
  if (runtime.tokenizerEosTokenId !== 1 || runtime.padTokenId !== 0 || runtime.paddingSide !== 'left'
    || JSON.stringify(runtime.terminatorIds) !== JSON.stringify([1, 106, 50])
    || runtime.chatTemplateSha256 !== '2f1b4d75d067bae3fe44e676721c7f077d243bc007156cb9c2f8b5836613d082'
    || [runtime.tokenizerLoaded, runtime.modelLoaded, runtime.adapterLoaded, runtime.unloadedCleanly].some(value => value !== true)) {
    errors.push('effective tokenizer/model/adapter preflight differs');
  }
  if (JSON.stringify(coverage) !== JSON.stringify({ panelRowsRead: 0, modelCompletionsEmitted: 0, generationCalls: 0, sealedHoldoutRowsRead: 0 })) {
    errors.push('preflight zero-output boundary differs');
  }
  const idle = result.preflight?.idleGate ?? {}; const final = result.preflight?.finalState ?? {};
  if (idle.passed !== true || idle.sampleCount !== 16 || idle.durationSeconds < 30
    || idle.minimumFreeVramMiB < 22000 || idle.peakUtilizationPercent > 1 || idle.maximumComputeProcessCount !== 0
    || final.freeVramMiB < 22000 || final.utilizationPercent > 1 || final.computeProcessCount !== 0
    || final.safeRideLockFree !== true || final.screenClosed !== true || final.containerAbsent !== true) {
    errors.push('preflight admission or final A11 state differs');
  }
  if (result.authorization?.boundDuringPreflight !== false || result.authorization?.consumedByPreflight !== false
    || result.authorization?.eligibleForOneUnchangedPanelAfterPreflight !== true
    || result.decision?.preflightPassed !== true || result.decision?.oneUnchangedPanelMayProceed !== true
    || result.decision?.readyForTwoFullCandidateTraining !== false || result.decision?.fullCandidateTrainingStarted !== false) {
    errors.push('preflight authorization or decision boundary differs');
  }

  const publicText = `${JSON.stringify(result)}\n${bytes(handoffRelative).toString('utf8')}`;
  if (/(?:\/home\/|\/opt\/|\/root\/)/i.test(publicText) || /(?:AKIA|ASIA)[A-Z0-9]{16}/.test(publicText)
    || /-----BEGIN [A-Z ]+PRIVATE KEY-----/.test(publicText) || /https?:\/\//i.test(publicText)) {
    errors.push('preflight evidence contains a private path, credential-like value, key, or URL');
  }
  const prohibited = new Set(['completion', 'messages', 'prompt', 'rowId', 'rowIds', 'privatePath']);
  if (collectKeys(result).some(key => prohibited.has(key))) errors.push('preflight evidence contains raw content or protected identifiers');
  if (Object.values(result.privacy ?? {}).some(value => value !== false)
    || Object.values(result.untouched ?? {}).some(value => value !== true)) errors.push('preflight privacy or untouched declaration differs');

  if (errors.length) { errors.forEach(error => console.error(`- ${error}`)); return 1; }
  console.log(`SafeRide v0.5.7 exact-artifact preflight result PASS (zero outputs; resultSha256=${sha256(bytes(resultRelative))}).`);
  return 0;
}

try { process.exitCode = main(); }
catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
