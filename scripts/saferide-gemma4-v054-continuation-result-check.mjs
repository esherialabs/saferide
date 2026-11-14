#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resultRelative = 'docs/qa/saferide-gemma4-v054-continuation-result-2026-08-08.json';
const evidenceRelative = 'docs/qa/saferide-gemma4-v054-continuation-evidence.pending.json';
const planRelative = 'config/ai/datasets/saferide-gemma4-v054-next-pilot-plan.json';
const priorResultRelative = 'docs/qa/saferide-gemma4-v054-targeted-pilot-result-2026-08-08.json';
const priorEvidenceRelative = 'docs/qa/saferide-gemma4-v054-next-pilot-evidence.pending.json';

const readBytes = relative => fs.readFileSync(path.join(repoRoot, relative));
const readJson = relative => JSON.parse(readBytes(relative).toString('utf8'));
const sha256Bytes = value => crypto.createHash('sha256').update(value).digest('hex');
const sha256File = relative => sha256Bytes(readBytes(relative));
const canonicalArraySha256 = value => sha256Bytes(`${JSON.stringify(value, Object.keys(value[0] ?? {}).sort())}\n`);
const close = (left, right, tolerance = 1e-9) => Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= tolerance;

function compile(relative) {
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, strictTypes: false, validateFormats: false });
  return ajv.compile(readJson(relative));
}

function planAtCommit(commit) {
  if (typeof commit !== 'string' || !/^[a-f0-9]{40}$/.test(commit)) throw new Error('Continuation execution commit is invalid.');
  return execFileSync('git', ['show', `${commit}:${planRelative}`], { cwd: repoRoot, encoding: null, maxBuffer: 4 * 1024 * 1024 });
}

function main() {
  const result = readJson(resultRelative);
  const evidence = readJson(evidenceRelative);
  const errors = [];
  const validateResult = compile('schemas/ai-v054-continuation-result.schema.json');
  const validateEvidence = compile('schemas/ai-v054-next-pilot-evidence.schema.json');
  if (!validateResult(result)) {
    errors.push(...(validateResult.errors ?? []).map(error => `${error.instancePath || '/'}: ${error.message}`));
  }
  if (!validateEvidence(evidence)) {
    errors.push(...(validateEvidence.errors ?? []).map(error => `evidence${error.instancePath || '/'}: ${error.message}`));
  }

  const executionPlanBytes = planAtCommit(result.bindings?.executionCommit);
  const executionPlan = JSON.parse(executionPlanBytes.toString('utf8'));
  const executionPlanSha = sha256Bytes(executionPlanBytes);
  if (executionPlanSha !== '4e502eae6ccd25a7dcb1e9b92b8b33e8173056e992ac7e4191fed0547eeb2dcf'
    || result.bindings?.planSha256 !== executionPlanSha
    || evidence.planSha256 !== executionPlanSha) {
    errors.push('continuation result or terminal evidence does not bind the exact execution plan');
  }
  if (evidence.status !== 'complete' || evidence.strictDecision !== 'NO-GO'
    || evidence.training !== null || evidence.panel !== null || evidence.promotionEligible !== false) {
    errors.push('terminal continuation evidence does not preserve the pilot NO-GO');
  }
  if (sha256File(resultRelative) !== 'ab7227dd1cf2cc03a0246068c1adb6475dbd678afd021f679bc57d868064d8c0'
    || sha256File(evidenceRelative) !== 'b27398f35e3b2b3eeaac8e1bb5855e1449283716339e34ba4a690049dc2754eb'
    || sha256File(priorResultRelative) !== '81ade8f8ffb124a4608c487999cbd0bbd481046b973d8e45cc7dfc88c88c92bd'
    || sha256File(priorEvidenceRelative) !== 'e5d7fe880d41c7cb4b406a6c9c1563e96cdd4c029c56ea1c99bd02d7caaa6e08') {
    errors.push('prior failed-preflight evidence changed during the continuation');
  }
  if (canonicalArraySha256(executionPlan.runtime?.baseModel?.files ?? []) !== result.bindings?.modelInventorySha256) {
    errors.push('pinned model inventory binding differs');
  }

  const preflight = result.preflight ?? {};
  if (preflight.status !== 'passed'
    || !close(preflight.loss?.rawTrainerLoss, preflight.loss?.meanTrainingObjectiveLoss)
    || preflight.loss?.gatePassed !== true
    || preflight.integrity?.sealedHoldoutRowsRead !== 0
    || preflight.adapter?.nonFiniteTensorCount !== 0
    || preflight.checkpoint?.resumeReadiness !== 'resume-ready') {
    errors.push('fresh one-step preflight pass evidence is incomplete or stale');
  }

  const pilot = result.pilot ?? {};
  const history = pilot.developmentHistory ?? [];
  const expectedSteps = [25, 50, 75, 100, 125, 150, 175, 200, 225, 237];
  if (pilot.status !== 'failed-closed'
    || pilot.failure?.message !== 'Development loss history contains duplicate evaluation steps.'
    || pilot.observedCoverage?.globalSteps !== 237
    || pilot.observedCoverage?.rowsSeen !== 1896
    || pilot.loss?.normalizedTrainObjective !== null
    || pilot.loss?.gatePassed !== false
    || pilot.integrity?.sealedHoldoutRead !== false
    || JSON.stringify(history.map(item => item.step)) !== JSON.stringify(expectedSteps)
    || history.some(item => !Number.isFinite(item.loss))
    || !close(Math.min(...history.map(item => item.loss)), pilot.loss?.bestDevelopmentLossObserved)
    || !close(pilot.loss?.rawTerminalTrainLossDisplayed / 8, pilot.loss?.unattestedDisplayedQuotient)) {
    errors.push('pilot failure, loss truthfulness, or observed coverage evidence differs');
  }
  if (result.panel?.status !== 'not-started'
    || result.panel?.metricsByLanguage !== null
    || result.panel?.metricsByCategory !== null
    || result.panel?.criticalAdjudication !== null
    || result.decision?.strictDecision !== 'NO-GO'
    || result.decision?.readyForTwoFullCandidateTraining !== false) {
    errors.push('panel or final NO-GO boundary was incorrectly asserted');
  }
  if (result.gpu?.preTransferIdleGate?.passed !== true
    || result.gpu?.preflight?.competingWorkloadObserved !== false
    || result.gpu?.pilot?.competingWorkloadObserved !== false
    || result.gpu?.postFailure?.computeProcessCount !== 0
    || result.gpu?.unrelatedWorkloadStoppedOrModified !== false) {
    errors.push('GPU isolation or contention evidence differs');
  }

  const expectedHashes = {
    preflightReceipt: '2b9c3172a3553e147660bd4a023c48c447ef092aa9f8aae4b9873ddf2803fe5d',
    preflightManifest: '3d7a0aaea967992601734ef81e26a882175337c46b499487c84a7c0b696f4f80',
    pilotFailureReceipt: '31c7632adb681133717db7679888118600378bf1cb9a72248f019ae544fa1ef3',
    pilotBlockedManifest: 'b68b7fb208694c8e0e2a50a8de7f99f4a12cfab3d9c0eab4b59bb3489e9d13e4',
    pilotCheckpoint: '91ab22058111e14e9129d5df2d18290517d4a6dbdfe387d3661c1ce0732cb307',
    pilotAdapter: '2f1f760cbc3e84835a0ff6309a3cfa6ba26ccb0009dcb6f921c56a84d2d2431d',
  };
  if (preflight.hashes?.launchReceiptSha256 !== expectedHashes.preflightReceipt
    || preflight.hashes?.trainingManifestSha256 !== expectedHashes.preflightManifest
    || pilot.hashes?.failureReceiptSha256 !== expectedHashes.pilotFailureReceipt
    || pilot.hashes?.blockedTrainingManifestSha256 !== expectedHashes.pilotBlockedManifest
    || pilot.checkpoint?.latestCheckpointInventorySha256 !== expectedHashes.pilotCheckpoint
    || pilot.checkpoint?.adapterTensorSha256 !== expectedHashes.pilotAdapter) {
    errors.push('hash-bound launch, checkpoint, or adapter evidence differs');
  }

  const serialized = JSON.stringify(result);
  const forbidden = [/(?:\/home\/|\/opt\/|\/root\/)/i, /(?:AKIA|ASIA)[A-Z0-9]{16}/, /-----BEGIN [A-Z ]+PRIVATE KEY-----/, /https?:\/\//i];
  if (forbidden.some(pattern => pattern.test(serialized))) {
    errors.push('continuation result contains a private path, credential-like value, private key, or URL');
  }
  if (errors.length) {
    errors.forEach(error => console.error(`- ${error}`));
    return 1;
  }
  console.log(`SafeRide v0.5.4 continuation result PASS (NO-GO; pilot loss evidence failed closed; resultSha256=${sha256File(resultRelative)}).`);
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
