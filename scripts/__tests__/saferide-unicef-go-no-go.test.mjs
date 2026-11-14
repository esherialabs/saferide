import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CHECKPOINT_CRITERION_IDS,
  DEFINITION_OF_DONE_IDS,
  extractPrdRequirementIds,
  validateUnicefGoNoGo,
} from '../lib/saferide-unicef-go-no-go.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const coveragePath = path.join(rootDir, 'config/unicef/prd-coverage.v1.json');
const coverage = JSON.parse(fs.readFileSync(coveragePath, 'utf8'));

function clone(value) {
  return structuredClone(value);
}

function validate(overrides = {}) {
  return validateUnicefGoNoGo({ rootDir, coverageOverride: clone(coverage), checkDecision: false, ...overrides });
}

test('maps every table requirement and mandatory milestone while remaining fail closed', () => {
  const result = validate();
  assert.deepEqual(result.errors, []);
  assert.equal(result.structurallyValid, true);
  assert.equal(result.decision.decision, 'blocked');
  assert.equal(result.decision.checkpointCandidate, false);
  assert.equal(result.decision.repositoryCoverage.tableRequirementIdsMapped, 136);
  assert.equal(result.decision.repositoryCoverage.coverageUnitsMapped, 15);
  assert.equal(result.decision.repositoryCoverage.requirementsIndependentlyVerified, 0);
  assert.ok(coverage.coverageUnits.every(unit => unit.repositoryStatus === 'mapped-unverified'));
  assert.ok(result.decision.limitations.some(item => item.includes('not 136 independently executed')));
  assert.ok(result.blockers.length > 0);
});

test('extracts exactly the canonical PRD requirement IDs', () => {
  const markdown = fs.readFileSync(path.join(rootDir, coverage.prd.path), 'utf8');
  const ids = extractPrdRequirementIds(markdown);
  assert.equal(ids.length, 136);
  assert.equal(ids[0], 'DATA-001');
  assert.ok(ids.includes('GOV-010'));
  assert.ok(ids.includes('PRIV-031'));
  assert.ok(ids.includes('OSS-009'));
});

test('rejects missing, duplicate and unknown PRD mappings', () => {
  const missing = clone(coverage);
  missing.coverageUnits[0].requirementIds.shift();
  assert.ok(validate({ coverageOverride: missing }).errors.some(error => error.includes('PRD requirement is not mapped')));

  const duplicate = clone(coverage);
  duplicate.coverageUnits[1].requirementIds.push('GOV-001');
  assert.ok(validate({ coverageOverride: duplicate }).errors.some(error => error.includes('mapped more than once')));

  const unknown = clone(coverage);
  unknown.coverageUnits[1].requirementIds.push('FAKE-999');
  assert.ok(validate({ coverageOverride: unknown }).errors.some(error => error.includes('unknown PRD requirement')));

  const wrongUnit = clone(coverage);
  const moved = wrongUnit.coverageUnits[0].requirementIds.pop();
  wrongUnit.coverageUnits[1].requirementIds.push(moved);
  assert.ok(validate({ coverageOverride: wrongUnit }).errors.some(error => error.includes('outside DATA-')));
});

test('binds phases, workstreams and prohibited public claims to the canonical PRD', () => {
  const missingPhase = clone(coverage);
  missingPhase.requiredMilestones = missingPhase.requiredMilestones.filter(item => item !== 'PHASE-8');
  assert.ok(validate({ coverageOverride: missingPhase }).errors.some(error => error.includes('canonical PRD milestone')));

  const staleCopy = clone(coverage);
  staleCopy.copyPolicy.prohibitedClaims.pop();
  assert.ok(validate({ coverageOverride: staleCopy }).errors.some(error => error.includes('section 26')));
});

test('rejects missing paths and unknown claim, evidence, and handoff references', () => {
  const invalid = clone(coverage);
  invalid.coverageUnits[0].requiredPaths[0] = '../outside';
  invalid.coverageUnits[0].claimIds[0] = 'CLAIM-DOES-NOT-EXIST';
  invalid.coverageUnits[0].evidenceIds[0] = 'EVID-DOES-NOT-EXIST';
  invalid.coverageUnits[0].handoffIds[0] = 'HANDOFF-DOES-NOT-EXIST';
  const errors = validate({ coverageOverride: invalid }).errors.join('\n');
  assert.match(errors, /required path is missing, outside the repository/);
  assert.match(errors, /unknown claim reference/);
  assert.match(errors, /unknown evidence reference/);
  assert.match(errors, /unknown handoff reference/);
});

test('accepts a blocked-external unit whose hosted-CI handoff is unresolved', () => {
  const candidate = clone(coverage);
  candidate.coverageUnits[0].handoffIds = ['HANDOFF-CI-BUDGET'];
  const errors = validate({ coverageOverride: candidate }).errors;
  assert.ok(!errors.some(error => error.includes('every referenced handoff is resolved')));
});

test('rejects missing section 23 or section 24 criteria', () => {
  const checkpoint = clone(coverage);
  checkpoint.checkpointCriteria.pop();
  assert.ok(validate({ coverageOverride: checkpoint }).errors.some(error => error.includes('section 24')));
  assert.deepEqual(CHECKPOINT_CRITERION_IDS.length, 12);

  const done = clone(coverage);
  done.definitionOfDone.pop();
  assert.ok(validate({ coverageOverride: done }).errors.some(error => error.includes('section 23')));
  assert.deepEqual(DEFINITION_OF_DONE_IDS.length, 9);
});

test('rejects activation drift in any fail-closed control document', () => {
  const tunedPath = 'config/ai/tuned-artifact-controls.v1.json';
  const tuned = JSON.parse(fs.readFileSync(path.join(rootDir, tunedPath), 'utf8'));
  tuned.activation.enabled = true;
  tuned.activation.rolloutPercent = 100;
  const errors = validate({ controlOverrides: { [tunedPath]: tuned } }).errors.join('\n');
  assert.match(errors, /tuned-activation/);
  assert.match(errors, /tuned-rollout/);
});

test('rejects checkpoint promotion while mandatory criteria, handoffs, claims, or release gates are blocked', () => {
  const promoted = clone(coverage);
  promoted.decision = { ...promoted.decision, state: 'checkpoint-candidate', checkpointCandidate: true };
  const errors = validate({ coverageOverride: promoted }).errors.join('\n');
  assert.match(errors, /checkpoint candidate cannot pass/);
  assert.match(errors, /UNICEF-CHECKPOINT-001/);
  assert.match(errors, /full release evidence gate/);

  const mismatched = clone(coverage);
  mismatched.decision.state = 'checkpoint-candidate';
  mismatched.decision.checkpointCandidate = false;
  assert.ok(validate({ coverageOverride: mismatched }).errors.some(error => error.includes('advance together')));
});

test('rejects stale PRD identity and stale checked-in decisions', () => {
  const stalePrd = clone(coverage);
  stalePrd.prd.sha256 = '0'.repeat(64);
  assert.ok(validate({ coverageOverride: stalePrd }).errors.some(error => error.includes('PRD SHA-256')));

  const baseline = validate();
  const staleDecision = clone(baseline.decision);
  staleDecision.decisionId = 'stale-decision';
  const checked = validateUnicefGoNoGo({
    rootDir,
    coverageOverride: clone(coverage),
    decisionOverride: staleDecision,
    checkDecision: true,
  });
  assert.ok(checked.errors.some(error => error.includes('stale')));
});

test('emits only aggregate decision metadata and explicit prohibited claims', () => {
  const result = validate();
  const serialized = JSON.stringify(result.decision);
  for (const forbiddenKey of ['rawPrompt', 'rawCompletion', 'survivorNarrative', 'exactLocation', 'credential', 'participantSession']) {
    assert.equal(serialized.includes(forbiddenKey), false);
  }
  assert.ok(result.decision.prohibitedClaims.includes('SafeRide is UNICEF-ready or production-ready.'));
  assert.ok(result.decision.blockingHandoffIds.includes('HANDOFF-UNICEF-CHECKPOINT'));
  assert.ok(result.decision.blockingHandoffIds.includes('HANDOFF-CI-BUDGET'));
  assert.ok(result.decision.blockingClaimIds.includes('UNICEF-CHECKPOINT-001'));
});

test('release mode fails closed and reports external gates rather than converting them to code failures', () => {
  const result = validateUnicefGoNoGo({ rootDir, release: true, coverageOverride: clone(coverage), checkDecision: false });
  assert.equal(result.ok, false);
  assert.equal(result.structurallyValid, true);
  assert.ok(result.blockers.some(blocker => blocker.includes('HANDOFF-UNICEF-CHECKPOINT')));
  assert.ok(result.blockers.some(blocker => blocker.includes('program decision is not checkpoint-candidate')));
});
