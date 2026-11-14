import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { validateDependencyPolicy } from '../lib/saferide-dependency-policy.mjs';
import {
  loadReleaseDocuments,
  validateReleaseEvidenceRepository,
  validateReleaseSemantics,
} from '../lib/saferide-release-evidence.mjs';
import { validateRepositorySafety } from '../lib/saferide-repository-safety.mjs';
import {
  buildSourceSbom,
  serializeSbom,
  validateSourceSbom,
} from '../lib/saferide-sbom.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const asOfDate = '2026-07-30';

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(rootDir, relativePath), 'utf8'));
}

function clone(value) {
  return structuredClone(value);
}

test('builds a deterministic public-safe CycloneDX SBOM for all workspaces', () => {
  const first = buildSourceSbom(rootDir);
  const second = buildSourceSbom(rootDir);

  assert.equal(serializeSbom(first), serializeSbom(second));
  assert.deepEqual(validateSourceSbom(first), []);
  assert.equal(first.bomFormat, 'CycloneDX');
  assert.equal(first.specVersion, '1.6');
  assert(first.components.length > 1_000);
  assert.deepEqual(
    first.metadata.component.components.map(component => component.properties[0].value).sort(),
    ['api', 'mobile', 'web'],
  );
  assert(!serializeSbom(first).includes('/home/'));
});

test('rejects unknown SBOM dependency references', () => {
  const sbom = buildSourceSbom(rootDir);
  sbom.dependencies[0].dependsOn.push('urn:saferide:missing');
  assert(validateSourceSbom(sbom).some(error => error.includes('target is unknown')));
});

test('validates lock integrity, registry origins, and reviewed license evidence', () => {
  const result = validateDependencyPolicy({ rootDir });
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.equal(result.reviewedLicenseCount, 1);
  assert.equal(result.unknownLicenseCount, 0);

  const lock = clone(readJson('package-lock.json'));
  const [packagePath] = Object.keys(lock.packages).filter(Boolean);
  lock.packages[packagePath].resolved = 'http://registry.npmjs.org/example.tgz';
  delete lock.packages[packagePath].integrity;
  const mutated = validateDependencyPolicy({ rootDir, lockOverrides: { mobile: lock } });
  assert(mutated.errors.some(error => error.includes('no integrity digest')));
  assert(mutated.errors.some(error => error.includes('forbidden protocol http:')));
});

test('registers the reachable historical APK as a release blocker without hiding it', () => {
  const structural = validateRepositorySafety({ rootDir, release: false });
  assert.equal(structural.structurallyValid, true, structural.errors.join('\n'));
  assert(structural.blockers.some(blocker => blocker.includes('saferide.apk')));

  const release = validateRepositorySafety({ rootDir, release: true });
  assert.equal(release.ok, false);
  assert(release.blockers.some(blocker => blocker.includes('publication review is blocked')));
});

test('accepts the checked-in blocked release structure and exposes its blockers', () => {
  const result = validateReleaseEvidenceRepository({ rootDir, asOfDate });
  assert.equal(result.structurallyValid, true, result.errors.join('\n'));
  assert(result.blockers.length > 20);
  assert(result.blockers.some(blocker => blocker.includes('exact-artifact matrix remains incomplete')));
  assert(!result.blockers.some(blocker => blocker.includes('code license/redistribution')));
  assert(!result.blockers.some(blocker => blocker.includes('protected-branch CI run')));
  assert.equal(result.documents.manifest.verification.githubActions, 'intentionally-disabled');
});

test('rejects an enabled release action while controls remain blocked', () => {
  const documents = loadReleaseDocuments(rootDir);
  documents.controls = clone(documents.controls);
  documents.controls.actions.publishPublicRelease = true;

  const result = validateReleaseSemantics({ rootDir, documents, asOfDate });
  assert(result.errors.some(error => error.includes('publishPublicRelease cannot be enabled')));
});

test('rejects stale source-input hashes and premature publication authority', () => {
  const documents = loadReleaseDocuments(rootDir);
  documents.manifest = clone(documents.manifest);
  documents.openSource = clone(documents.openSource);
  documents.manifest.inputs.find(input => input.path === 'package.json').sha256 = '0'.repeat(64);
  documents.openSource.status = 'blocked';
  documents.openSource.publicReleaseAuthorized = true;

  const result = validateReleaseSemantics({ rootDir, documents, asOfDate });
  assert(result.errors.some(error => error.includes('SHA-256 mismatch for package.json')));
  assert(result.errors.some(error => error.includes('public release cannot be authorized')));
});

test('requires the exact owner statement for local verification mode', () => {
  const documents = loadReleaseDocuments(rootDir);
  documents.manifest = clone(documents.manifest);
  documents.manifest.verification.verificationMode = 'local-owner-authorized';
  documents.manifest.verification.githubActions = 'intentionally-disabled';
  documents.manifest.verification.ciRun = null;
  documents.manifest.verification.ownerDecisionStatement = 'Hosted CI passed.';

  const result = validateReleaseEvidenceRepository({
    rootDir,
    asOfDate,
    documentOverrides: { manifest: documents.manifest },
  });
  assert(result.errors.some(error => error.includes('ownerDecisionStatement')));
});

test('fails the release gate while external evidence and approvals are absent', () => {
  const result = validateReleaseEvidenceRepository({ rootDir, release: true, asOfDate });
  assert.equal(result.ok, false);
  assert.equal(result.structurallyValid, true, result.errors.join('\n'));
  assert(result.blockers.some(blocker => blocker.includes('HANDOFF-CI-BUDGET')));
  assert(result.blockers.some(blocker => blocker.includes('UNICEF-CHECKPOINT-001')));
});
