#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resultRelative = 'docs/qa/saferide-gemma4-v054-reuse-conflict-2026-08-08.json';
const planRelative = 'config/ai/datasets/saferide-gemma4-v054-next-pilot-plan.json';
const runnerRelative = 'scripts/saferide-gemma4-finetune-runner.py';
const preserved = {
  failedPreflightResultSha256: ['docs/qa/saferide-gemma4-v054-targeted-pilot-result-2026-08-08.json', '81ade8f8ffb124a4608c487999cbd0bbd481046b973d8e45cc7dfc88c88c92bd'],
  failedPreflightEvidenceSha256: ['docs/qa/saferide-gemma4-v054-next-pilot-evidence.pending.json', 'e5d7fe880d41c7cb4b406a6c9c1563e96cdd4c029c56ea1c99bd02d7caaa6e08'],
  failedPilotResultSha256: ['docs/qa/saferide-gemma4-v054-continuation-result-2026-08-08.json', 'ab7227dd1cf2cc03a0246068c1adb6475dbd678afd021f679bc57d868064d8c0'],
  failedPilotEvidenceSha256: ['docs/qa/saferide-gemma4-v054-continuation-evidence.pending.json', 'b27398f35e3b2b3eeaac8e1bb5855e1449283716339e34ba4a690049dc2754eb'],
  reusePanelResultSha256: ['docs/qa/saferide-gemma4-v054-pilot-reuse-result-2026-08-08.json', '6655b0c44faeb728e405d6a4e0e662aaeae810fa8dceed0db01c98c1aa610c70'],
  reusePanelEvidenceSha256: ['docs/qa/saferide-gemma4-v054-reuse-evidence.pending.json', 'd1c24f8693dcc9214c34dcf03d3de11050a3bbc6c6b14264934d88c3d2f82657'],
};

const readBytes = relative => fs.readFileSync(path.join(repoRoot, relative));
const readJson = relative => JSON.parse(readBytes(relative).toString('utf8'));
const sha256File = relative => crypto.createHash('sha256').update(readBytes(relative)).digest('hex');
const close = (left, right) => Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= 1e-9;
const fileAtCommit = (commit, relative) => execFileSync('git', ['show', `${commit}:${relative}`], {
  cwd: repoRoot,
  encoding: null,
  maxBuffer: 4 * 1024 * 1024,
});

function main() {
  const result = readJson(resultRelative);
  const schema = readJson('schemas/ai-v054-reuse-conflict.schema.json');
  const validator = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, strictTypes: false, validateFormats: false }).compile(schema);
  const errors = [];
  if (!validator(result)) errors.push(...(validator.errors ?? []).map(error => `${error.instancePath || '/'}: ${error.message}`));
  for (const [key, [relative, expected]] of Object.entries(preserved)) {
    if (sha256File(relative) !== expected || result.preservedEvidence?.[key] !== expected) errors.push(`preserved evidence differs: ${key}`);
  }
  const executedRunnerSha256 = crypto.createHash('sha256')
    .update(fileAtCommit('797fce01b58790d6445127e943dc05c624cd73ac', runnerRelative))
    .digest('hex');
  if (sha256File(planRelative) !== 'cf768aec522b7cf08e57dfa5a6f203ffe127c481769d4533dd353a1a4760484d'
    || result.correction?.freshPlanSha256 !== sha256File(planRelative)
    || executedRunnerSha256 !== '04d9c597a949393dcde11f0335417684c0a8371eb4ca8e206203c728ba6479cd') {
    errors.push('fresh-pilot plan or runner binding differs');
  }
  const persisted = result.conflict?.persisted ?? {};
  const replay = result.conflict?.independentReplayRaw ?? {};
  if (persisted.step !== 237 || persisted.epoch !== 1 || replay.assignedStep !== 237 || replay.reportedEpoch !== 0
    || !close(persisted.evalLoss, 1.8524575233459473) || !close(replay.evalLoss, persisted.evalLoss)
    || !close(persisted.evalRuntime, 24.6787) || !close(replay.evalRuntime, 24.879)
    || !close(persisted.evalSamplesPerSecond, 12.156) || !close(replay.evalSamplesPerSecond, 12.058)
    || result.conflict?.sameStepEntriesEquivalent !== false
    || result.invalidAttestationBehavior?.independentEpochReplacedWithPersistedEpochBeforeComparison !== true
    || result.correction?.reuseAllowed !== false || result.correction?.freshIdenticalPilotAuthorized !== true) {
    errors.push('replay conflict or invalid coalescing evidence differs');
  }
  if (result.preservedEvidence?.reuseAttestationSha256 !== '6db423c52b12fc4bff652fc45c08e5d382e787e5f7cd1aabf175f86c6fee5c77'
    || result.preservedEvidence?.recoveredManifestSha256 !== 'cdd49c9289bc6eba4b9b5adddde8b61217f408bff84979da585d0e4d28e64366'
    || result.preservedEvidence?.checkpoint237TrainerStateSha256 !== 'e415ea7293395c9a22d714c18a1315dbf1b65e8f7b293fe94523556801bc2762') {
    errors.push('external conflict source hashes differ');
  }
  const serialized = JSON.stringify(result);
  if (/(?:\/home\/|\/opt\/|\/root\/|https?:\/\/|(?:AKIA|ASIA)[A-Z0-9]{16}|-----BEGIN [A-Z ]+PRIVATE KEY-----)/i.test(serialized)) {
    errors.push('conflict evidence contains a private path, URL, or credential-like value');
  }
  if (errors.length) {
    errors.forEach(error => console.error(`- ${error}`));
    return 1;
  }
  console.log(`SafeRide v0.5.4 reuse conflict PASS (reuse invalid; fresh identical pilot authorized; evidenceSha256=${sha256File(resultRelative)}).`);
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
