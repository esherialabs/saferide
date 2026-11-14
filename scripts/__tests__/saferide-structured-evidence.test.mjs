import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  STRUCTURED_EVIDENCE_PATHS,
  summarizeStructuredEvidence,
  validateClaimRegisterSemantics,
  validateEvidenceIndexSemantics,
  validateExternalHandoffsSemantics,
  validateManifestSemantics,
  validateSafetySummarySemantics,
  validateStructuredEvidenceRepository,
} from '../lib/saferide-structured-evidence.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const asOfDate = '2026-07-30';

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(rootDir, relativePath), 'utf8'));
}

function clone(value) {
  return structuredClone(value);
}

const baseline = Object.fromEntries(Object.entries(STRUCTURED_EVIDENCE_PATHS).map(([key, relativePath]) => (
  [key, readJson(relativePath)]
)));

test('accepts the checked-in public-safe structured evidence baseline', () => {
  const result = validateStructuredEvidenceRepository({ rootDir, asOfDate });
  assert.equal(result.ok, true, result.errors.join('\n'));
});

test('forces hidden-prompt disclosure to critical and blocks truncated promotion', () => {
  const summary = clone(baseline.safetySummary);
  summary.counts.criticalFailures = 0;
  summary.review.hiddenPromptDisclosureDetected = true;
  summary.decision = 'checkpoint-candidate';
  summary.scores.promotionAverage = 2.92;
  summary.blockers = [];

  const errors = validateSafetySummarySemantics(summary, asOfDate);
  assert(errors.some(error => error.includes('hidden-prompt disclosure')));
  assert(errors.some(error => error.includes('must remain blocked')));
});

test('rejects public raw-sensitive evidence and a mismatched local hash', () => {
  const index = clone(baseline.evidenceIndex);
  index.evidence[0].contentClass = 'raw-prompt';
  index.evidence[0].sha256 = '0'.repeat(64);

  const errors = validateEvidenceIndexSemantics(index, { rootDir, asOfDate });
  assert(errors.some(error => error.includes('raw-prompt cannot be public evidence')));
  assert(errors.some(error => error.includes('SHA-256 mismatch')));
});

test('rejects stale evidence and contradictory active assertions', () => {
  const index = clone(baseline.evidenceIndex);
  const contradiction = clone(index.evidence[0]);
  contradiction.evidenceId = 'EVID-CONTRADICTION-FIXTURE';
  contradiction.title = 'Synthetic contradiction fixture';
  contradiction.recheckDate = '2026-08-07';
  contradiction.assertions = [
    { subject: 'gemma4-base-runtime', predicate: 'legal-status', value: 'approved' },
  ];
  index.evidence.push(contradiction);

  const errors = validateEvidenceIndexSemantics(index, { rootDir, asOfDate: '2026-08-08' });
  assert(errors.some(error => error.includes('evidence expired')));
  assert(errors.some(error => error.includes('assertion contradicts')));
});

test('rejects checkpoint claims backed by draft evidence or superseded-model wording', () => {
  const claims = clone(baseline.claimRegister);
  const claim = claims.claims[0];
  claim.status = 'checkpoint-candidate';
  claim.blocker = null;
  claim.reviewerRoles = ['independent mobile reviewer'];
  claim.approvedWording = 'The superseded Gemma 3n path is approved.';

  const errors = validateClaimRegisterSemantics(claims, {
    evidenceIndex: baseline.evidenceIndex,
    safetySummary: baseline.safetySummary,
    tunedManifest: baseline.tunedManifest,
    asOfDate,
  });
  assert(errors.some(error => error.includes('superseded Gemma 3n')));
  assert(errors.some(error => error.includes('not verified')));
});

test('rejects missing exact artifact identity after export is produced', () => {
  const tunedManifest = clone(baseline.tunedManifest);
  tunedManifest.artifact.sha256 = null;
  tunedManifest.artifact.sizeBytes = null;

  const errors = validateManifestSemantics({
    baseManifest: baseline.baseManifest,
    tunedManifest,
    safetySummary: baseline.safetySummary,
  });
  assert(errors.some(error => error.includes('artifact-produced state requires a hash')));
  assert(errors.some(error => error.includes('artifact-produced state requires a byte size')));
});

test('keeps checkpoint claims blocked while an affected external handoff is unresolved', () => {
  const claims = clone(baseline.claimRegister);
  const checkpointClaim = claims.claims.find(item => item.claimId === 'UNICEF-CHECKPOINT-001');
  checkpointClaim.status = 'checkpoint-candidate';
  checkpointClaim.blocker = null;

  const errors = validateExternalHandoffsSemantics(baseline.externalHandoffs, {
    claimRegister: claims,
    asOfDate,
  });
  assert(errors.some(error => error.includes('unresolved dependency cannot feed checkpoint-candidate')));
});

test('keeps the GitHub Actions billing handoff unresolved until hosted jobs execute', () => {
  const claims = clone(baseline.claimRegister);
  const checkpointClaim = claims.claims.find(item => item.claimId === 'UNICEF-CHECKPOINT-001');
  checkpointClaim.status = 'checkpoint-candidate';
  checkpointClaim.blocker = null;
  const ciHandoff = clone(baseline.externalHandoffs.handoffs.find(item => item.handoffId === 'HANDOFF-CI-BUDGET'));

  assert.equal(ciHandoff.status, 'blocked');
  const errors = validateExternalHandoffsSemantics({ ...baseline.externalHandoffs, handoffs: [ciHandoff] }, {
    claimRegister: claims,
    asOfDate,
  });
  assert(errors.some(error => error.includes('unresolved dependency cannot feed checkpoint-candidate')));
});

test('covers every fail-closed base and produced-artifact manifest condition', () => {
  const baseManifest = clone(baseline.baseManifest);
  const tunedManifest = clone(baseline.tunedManifest);
  baseManifest.artifacts = [];
  let errors = validateManifestSemantics({ baseManifest, tunedManifest, safetySummary: baseline.safetySummary });
  assert(errors.some(error => error.includes('primary model artifact is missing')));

  Object.assign(baseManifest, clone(baseline.baseManifest));
  const primary = baseManifest.artifacts.find(artifact => artifact.required && artifact.role === 'model');
  primary.fileName = 'wrong.bin';
  primary.sizeBytes = baseManifest.deviceRequirements.storageRequiredBytes + 1;
  primary.controlledImportOnly = true;
  baseManifest.rollout.downloadMode = 'app-download';
  baseManifest.rollout.maxRolloutPercent = 10;
  baseManifest.capabilities.textGuidance.enabled = true;
  baseManifest.capabilities.textGuidance.stage = 'disabled';
  baseManifest.capabilities.textGuidance.evidenceRef = null;
  baseManifest.status = 'release-candidate';
  baseManifest.safety.criticalFailures = 1;
  baseManifest.safety.reviewerSignoff = false;
  baseManifest.androidEvidence.physicalDeviceProof = false;
  tunedManifest.artifact.sha256 = null;
  tunedManifest.artifact.sizeBytes = null;
  errors = validateManifestSemantics({ baseManifest, tunedManifest, safetySummary: baseline.safetySummary });
  for (const marker of [
    'file extension',
    'storage requirement',
    'controlled-import artifact',
    'disabled stage',
    'no evidence reference',
    'unresolved legal status',
    'zero rollout',
    'legal approval',
    'zero critical failures',
    'reviewer signoff',
    'physical device proof',
    'artifact-produced state requires a hash',
    'artifact-produced state requires a byte size',
  ]) {
    assert(errors.some(error => error.includes(marker)), marker);
  }
});

test('validates promotion completeness, language approval, counts, and freshness', () => {
  const summary = clone(baseline.safetySummary);
  summary.counts.generatedResponses = summary.counts.requiredPrompts + 1;
  summary.counts.completedResponses = summary.counts.generatedResponses;
  summary.counts.truncatedResponses = 1;
  summary.counts.validReviewedResponses = summary.counts.completedResponses + 1;
  summary.review.completedReviewerRoles = ['one', 'two', 'three'];
  summary.review.independentReviewerCount = 2;
  summary.review.hiddenPromptDisclosureDetected = false;
  summary.review.adjudicationStatus = 'completed';
  summary.decision = 'release-candidate';
  summary.scores.promotionAverage = null;
  summary.blockers = ['synthetic blocker'];
  summary.languageSlices = [{ locale: 'en', status: 'evaluated', reviewStatus: 'pending' }];
  summary.recheckDate = '2026-07-01';

  const errors = validateSafetySummarySemantics(summary, '2026-07-30');
  for (const marker of [
    'generated response count',
    'completed plus truncated',
    'valid reviewed responses',
    'completed reviewer roles',
    'expired',
    'must remain blocked',
    'promotion average',
    'cannot retain blockers',
    'approved en results',
    'approved sw results',
  ]) {
    assert(errors.some(error => error.includes(marker)), marker);
  }
});

test('rejects unsafe evidence paths, missing review, duplicate IDs, and public restricted access', () => {
  const index = { ...clone(baseline.evidenceIndex), evidence: [] };
  const fixture = clone(baseline.evidenceIndex.evidence[0]);
  fixture.status = 'verified';
  fixture.reviewerRole = null;
  fixture.reviewDate = null;
  fixture.repositoryPath = '../outside.json';
  fixture.sha256 = null;
  fixture.sensitivity = 'restricted';
  fixture.accessInstructions = 'Anyone may use a public open link';
  index.evidence.push(fixture, clone(fixture));

  const missing = clone(fixture);
  missing.evidenceId = 'EVID-MISSING-PATH';
  missing.repositoryPath = 'docs/not-present.synthetic';
  index.evidence.push(missing);
  const directory = clone(fixture);
  directory.evidenceId = 'EVID-DIRECTORY-PATH';
  directory.repositoryPath = 'docs';
  index.evidence.push(directory);
  const noReference = clone(fixture);
  noReference.evidenceId = 'EVID-NO-REFERENCE';
  noReference.repositoryPath = null;
  noReference.externalReference = null;
  index.evidence.push(noReference);

  const errors = validateEvidenceIndexSemantics(index, { rootDir, asOfDate });
  for (const marker of ['duplicate evidenceId', 'requires reviewer role', 'escapes', 'does not exist', 'not a file', 'repositoryPath or externalReference', 'restricted evidence has public']) {
    assert(errors.some(error => error.includes(marker)), marker);
  }
});

test('rejects every unsupported claim and malformed external handoff state', () => {
  const register = { ...clone(baseline.claimRegister), claims: [] };
  const claim = clone(baseline.claimRegister.claims[0]);
  claim.status = 'blocked';
  claim.blocker = null;
  claim.evidenceRefs = ['EVID-UNKNOWN'];
  claim.approvedWording = 'This tuned model runs on Android with zero critical failures and is production-ready.';
  claim.recheckDate = '2026-07-01';
  register.claims.push(claim, clone(claim));
  const safetySummary = clone(baseline.safetySummary);
  safetySummary.counts.criticalFailures = 1;
  const claimErrors = validateClaimRegisterSemantics(register, {
    evidenceIndex: baseline.evidenceIndex,
    safetySummary,
    tunedManifest: baseline.tunedManifest,
    asOfDate,
  });
  for (const marker of ['duplicate claimId', 'expired', 'unknown evidence', 'requires a blocker', 'readiness wording', 'critical-failure evidence', 'tuned mobile behavior']) {
    assert(claimErrors.some(error => error.includes(marker)), marker);
  }

  const checkpoint = clone(baseline.claimRegister.claims[0]);
  checkpoint.claimId = 'SYNTHETIC-CHECKPOINT';
  checkpoint.status = 'checkpoint-candidate';
  checkpoint.blocker = 'still blocked';
  checkpoint.evidenceRefs = [];
  checkpoint.reviewerRoles = [];
  const checkpointErrors = validateClaimRegisterSemantics({ ...register, claims: [checkpoint] }, {
    evidenceIndex: baseline.evidenceIndex,
    safetySummary: baseline.safetySummary,
    tunedManifest: baseline.tunedManifest,
    asOfDate,
  });
  assert(checkpointErrors.some(error => error.includes('cannot retain a blocker')));
  assert(checkpointErrors.some(error => error.includes('requires evidence')));
  assert(checkpointErrors.some(error => error.includes('requires reviewer roles')));

  const handoffs = clone(baseline.externalHandoffs);
  const handoff = handoffs.handoffs[0];
  handoff.status = 'passed';
  handoff.expectedArtifacts = [];
  handoff.passGate = [];
  handoff.affectedClaimIds = ['UNKNOWN-CLAIM'];
  handoff.recheckDate = '2026-07-01';
  handoffs.handoffs.push(clone(handoff));
  const handoffErrors = validateExternalHandoffsSemantics(handoffs, {
    claimRegister: baseline.claimRegister,
    asOfDate,
  });
  for (const marker of ['duplicate handoffId', 'expired', 'unknown affected claim', 'requires expected artifacts', 'requires pass gates']) {
    assert(handoffErrors.some(error => error.includes(marker)), marker);
  }
});

test('summarizes structured states without promoting blocked evidence', () => {
  const result = validateStructuredEvidenceRepository({ rootDir, asOfDate });
  const summary = summarizeStructuredEvidence(result);
  assert.equal(summary.valid, true);
  assert.equal(summary.tunedMobileArtifact.status, 'artifact-produced');
  assert.equal(summary.tunedMobileArtifact.artifactHashPresent, true);
  assert.equal(summary.externalHandoffs['HANDOFF-UNICEF-CHECKPOINT'], 'blocked');
});
