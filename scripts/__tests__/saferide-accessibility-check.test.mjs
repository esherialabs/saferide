import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  REQUIRED_DEVICE_SCENARIOS,
  getAccessibilityReleaseBlockers,
  readAccessibilitySources,
  runAccessibilityCheck,
  validateAccessibilitySources,
} from '../saferide-accessibility-check.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const manifest = JSON.parse(fs.readFileSync(
  path.join(repositoryRoot, 'docs/qa/saferide-accessibility-gate.json'),
  'utf8',
));
const pendingEvidence = JSON.parse(fs.readFileSync(
  path.join(repositoryRoot, 'docs/qa/saferide-accessibility-device-evidence.pending.json'),
  'utf8',
));

function approvedEvidence() {
  const evidenceHash = 'a'.repeat(64);
  return {
    schemaVersion: '1.0.0',
    evidenceId: 'esh-3953-synthetic-device-proof',
    status: 'approved',
    sourceRevision: 'b'.repeat(40),
    syntheticOnly: true,
    contentFree: true,
    noParticipantData: true,
    executedBy: 'qa-executor-1',
    generatedAt: '2026-07-30T00:00:00.000Z',
    build: {
      platform: 'android',
      artifactSha256: evidenceHash,
      version: 'synthetic-test-build',
    },
    devices: [
      { deviceId: 'device-small', deviceClass: 'small-low-end', androidVersion: 'approved-version', evidenceHash },
      { deviceId: 'device-standard', deviceClass: 'standard', androidVersion: 'approved-version', evidenceHash },
    ],
    scenarios: REQUIRED_DEVICE_SCENARIOS.map(scenarioId => ({
      scenarioId,
      status: 'pass',
      screenIds: ['synthetic-screen'],
      evidenceHash,
      sanitizedSummary: 'Content-free synthetic pass result.',
    })),
    approval: {
      status: 'approved',
      independent: true,
      reviewerId: 'qa-reviewer-2',
      reviewerRole: 'independent accessibility reviewer',
      reviewedAt: '2026-07-30T00:30:00.000Z',
    },
  };
}

test('accessibility gate passes all repository-verifiable source gates', () => {
  const result = runAccessibilityCheck({
    sources: readAccessibilitySources(repositoryRoot),
    manifest,
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result.sourceGates.every(gate => gate.passed), true);
});

test('accessibility gate fails when the shared touch target regresses below 48dp', () => {
  const sources = readAccessibilitySources(repositoryRoot);
  sources.tokens = sources.tokens.replace('minimum: 48', 'minimum: 44');
  const gate = validateAccessibilitySources(sources).find(item => item.id === 'touch-target-token');
  assert.equal(gate?.passed, false);
});

test('chat restoration gate rejects implicit preparation of missing or partial files', () => {
  for (const mutate of [
    sources => { sources.chat = sources.chat.replace("if (payload?.state !== 'downloaded' || !payload.modelDownloaded) return;", ''); },
    sources => { sources.assistantService = sources.assistantService.replace('if (!availability.downloaded) {\n    return false;', 'if (false) {\n    return false;'); },
    sources => { sources.assistantService = sources.assistantService.replaceAll('!localAssistantForegroundActive', 'false'); },
    sources => { sources.modelStorage = sources.modelStorage.replace('assertLargeDownloadAuthorized(config, file, authorization);', ''); },
  ]) {
    const sources = readAccessibilitySources(repositoryRoot);
    mutate(sources);
    const gate = validateAccessibilitySources(sources).find(item => item.id === 'chat-restoration-no-implicit-download');
    assert.equal(gate?.passed, false);
  }
});

test('accessibility gate keeps pending handoff blocked without fabricated device evidence', () => {
  const blockers = getAccessibilityReleaseBlockers(pendingEvidence);
  assert.ok(blockers.includes('sourceRevision must be a full lowercase commit SHA'));
  assert.ok(blockers.includes('small-low-end device evidence is required'));
  assert.ok(blockers.includes('independent approval must be approved'));
});

test('accessibility gate accepts complete synthetic independently approved device evidence', () => {
  assert.deepEqual(getAccessibilityReleaseBlockers(approvedEvidence()), []);
});

test('accessibility gate rejects sensitive fields even when device scenarios pass', () => {
  const evidence = approvedEvidence();
  evidence.scenarios[0].prompt = 'must never be stored';
  assert.ok(getAccessibilityReleaseBlockers(evidence).includes(
    'forbidden sensitive field at $.scenarios[0].prompt',
  ));
});

test('accessibility gate requires an approver who did not execute the test', () => {
  const evidence = approvedEvidence();
  evidence.approval.reviewerId = evidence.executedBy;
  assert.ok(getAccessibilityReleaseBlockers(evidence).includes(
    'executor and independent reviewer must differ',
  ));
});
