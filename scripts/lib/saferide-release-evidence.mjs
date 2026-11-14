import fs from 'node:fs';
import path from 'node:path';

import Ajv2020 from 'ajv/dist/2020.js';

import { validateDependencyPolicy } from './saferide-dependency-policy.mjs';
import { validateRepositorySafety } from './saferide-repository-safety.mjs';
import {
  buildSourceSbom,
  serializeSbom,
  sha256File,
  validateSourceSbom,
} from './saferide-sbom.mjs';
import { validateStructuredEvidenceRepository } from './saferide-structured-evidence.mjs';

export const RELEASE_PATHS = Object.freeze({
  controls: 'config/release/release-controls.v1.json',
  openSource: 'config/release/open-source-policy.v1.json',
  dependencyPolicy: 'config/release/dependency-policy.v1.json',
  coveragePolicy: 'config/release/coverage-policy.v1.json',
  repositoryPolicy: 'config/release/repository-safety-policy.v1.json',
  manifest: 'docs/release/saferide-unicef-release-manifest.pending.json',
  dependencyAudit: 'docs/security/dependency-audit.pending.json',
  publicationReview: 'docs/security/repository-publication-review.pending.json',
});

const SCHEMAS = Object.freeze({
  controls: 'schemas/release-controls.schema.json',
  openSource: 'schemas/open-source-policy.schema.json',
  manifest: 'schemas/release-evidence.schema.json',
  dependencyAudit: 'schemas/dependency-audit-evidence.schema.json',
  publicationReview: 'schemas/repository-publication-review.schema.json',
  dependencyPolicy: 'schemas/dependency-policy.schema.json',
  coveragePolicy: 'schemas/coverage-policy.schema.json',
  repositoryPolicy: 'schemas/repository-safety-policy.schema.json',
});

const GOVERNANCE_FILES = Object.freeze([
  'LICENSE',
  'CONTENT-LICENSE.md',
  'MODEL-DATA-LICENSES.md',
  'CONTRIBUTING.md',
  'CODE_OF_CONDUCT.md',
  'SECURITY.md',
  'GOVERNANCE.md',
  'MAINTAINERS.md',
  'TRADEMARKS.md',
  'PROJECT_CHARTER.md',
  '.github/CODEOWNERS',
  '.github/pull_request_template.md',
  '.github/ISSUE_TEMPLATE/config.yml',
  '.github/ISSUE_TEMPLATE/bug.yml',
]);

const CHECKPOINT_FILES = Object.freeze([
  'docs/unicef/checkpoint-2026-08/technical-summary.md',
  'docs/unicef/checkpoint-2026-08/ai-model-evidence.md',
  'docs/unicef/checkpoint-2026-08/privacy-and-data-governance.md',
  'docs/unicef/checkpoint-2026-08/product-testing-and-accessibility.md',
  'docs/unicef/checkpoint-2026-08/open-source-and-release.md',
  'docs/unicef/checkpoint-2026-08/live-demo-script.md',
  'docs/unicef/checkpoint-2026-08/demo-failure-and-fallback-script.md',
  'docs/unicef/checkpoint-2026-08/business-progress-links.md',
  'docs/unicef/checkpoint-2026-08/pilot-progress-links.md',
  'docs/unicef/checkpoint-2026-08/review-action-log.md',
  'docs/unicef/checkpoint-2026-08/known-limitations.md',
  'docs/unicef/checkpoint-2026-08/rollback-and-revocation.md',
  'docs/unicef/checkpoint-2026-08/go-no-go.pending.json',
]);

function readJson(rootDir, relativePath) {
  return JSON.parse(fs.readFileSync(path.join(rootDir, relativePath), 'utf8'));
}

function addIf(condition, collection, message) {
  if (condition) collection.push(message);
}

function dateAfter(left, right) {
  return Date.parse(`${left}T00:00:00Z`) > Date.parse(`${right}T00:00:00Z`);
}

function insideRoot(rootDir, candidate) {
  const relative = path.relative(rootDir, candidate);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function compileSchemas(rootDir) {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    strictRequired: false,
    strictTypes: false,
    validateFormats: false,
  });
  return Object.fromEntries(Object.entries(SCHEMAS).map(([key, schemaPath]) => {
    return [key, ajv.compile(readJson(rootDir, schemaPath))];
  }));
}

function schemaErrors(label, validator, value) {
  if (validator(value)) return [];
  return (validator.errors ?? []).map(error => `${label}${error.instancePath || '/'}: ${error.message ?? error.keyword}`);
}

export function loadReleaseDocuments(rootDir) {
  return Object.fromEntries(Object.entries(RELEASE_PATHS).map(([key, relativePath]) => [key, readJson(rootDir, relativePath)]));
}

function validateCoveragePolicy(policy) {
  const errors = [];
  for (const metric of ['branches', 'functions', 'lines', 'statements']) {
    addIf((policy.global?.minimumPercent?.[metric] ?? 0) < 15, errors, `coverage policy: global ${metric} threshold is below 15 percent`);
    addIf((policy.criticalTypeScript?.minimumPercent?.[metric] ?? 0) < 80, errors, `coverage policy: critical TypeScript ${metric} threshold is below 80 percent`);
  }
  for (const metric of ['branches', 'functions', 'lines']) {
    addIf((policy.criticalNode?.minimumPercent?.[metric] ?? 0) < 80, errors, `coverage policy: critical Node ${metric} threshold is below 80 percent`);
  }
  const critical = [...(policy.criticalTypeScript?.modules ?? []), ...(policy.criticalNode?.modules ?? [])].join('\n');
  for (const marker of ['consentLedger', 'localRetention', 'privacyLifecycle', 'deletionWorkflow', 'privacySuppression', 'differencingProtection', 'structured-evidence', 'tuned-artifact']) {
    addIf(!critical.includes(marker), errors, `coverage policy: missing critical module class ${marker}`);
  }
  return errors;
}

// GitHub Actions is retired for the private repository: scripts/local-ci.mjs
// runs the protected gates. The public repository's workflows live under
// public-repository/ until the mirror maps them to .github/workflows.
const WORKFLOW_DIRS = Object.freeze(['.github/workflows', 'public-repository/.github/workflows']);

function validateWorkflowPins(rootDir) {
  const errors = [];
  const workflowFiles = WORKFLOW_DIRS
    .filter(dir => fs.existsSync(path.join(rootDir, dir)))
    .flatMap(dir => fs.readdirSync(path.join(rootDir, dir)).filter(name => /\.ya?ml$/.test(name)).sort().map(name => `${dir}/${name}`));
  for (const relativePath of workflowFiles) {
    const contents = fs.readFileSync(path.join(rootDir, relativePath), 'utf8');
    for (const match of contents.matchAll(/^\s*uses:\s*([^\s#]+)/gm)) {
      const reference = match[1];
      if (reference.startsWith('./')) continue;
      const at = reference.lastIndexOf('@');
      if (at < 1 || !/^[0-9a-f]{40}$/.test(reference.slice(at + 1))) {
        errors.push(`${relativePath}: action is not pinned to a full commit SHA (${reference})`);
      }
    }
    for (const [runtime, pattern] of [
      ['NODE_VERSION', /^\d+\.\d+\.\d+$/],
      ['NPM_VERSION', /^\d+\.\d+\.\d+$/],
      ['PYTHON_VERSION', /^\d+\.\d+\.\d+$/],
      ['JAVA_VERSION', /^\d+\.\d+\.\d+\+\d+$/],
    ]) {
      const match = contents.match(new RegExp(`^\\s*${runtime}:\\s*['"]([^'"]+)['"]`, 'm'));
      if (match && !pattern.test(match[1])) {
        errors.push(`${relativePath}: ${runtime} is not pinned to an exact version`);
      }
    }
  }

  const requiredMarkers = {
    'scripts/local-ci.mjs': [
      'npm run coverage:check',
      'npm run release:validators',
      'npm run security:audit:high',
      'npm run secrets:scan',
      'npm run typecheck',
      'npm run build',
      'docker compose',
      'gitleaks git',
      'release-candidate-preflight.mjs',
      'npx expo-doctor',
    ],
  };
  for (const [relativePath, markers] of Object.entries(requiredMarkers)) {
    const contents = fs.readFileSync(path.join(rootDir, relativePath), 'utf8');
    for (const marker of markers) {
      if (!contents.includes(marker)) errors.push(`${relativePath}: missing required protected-gate marker ${marker}`);
    }
  }
  return errors;
}

function validateRequiredFiles(rootDir) {
  const errors = [];
  for (const relativePath of [...GOVERNANCE_FILES, ...CHECKPOINT_FILES]) {
    const fullPath = path.join(rootDir, relativePath);
    if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile() || fs.statSync(fullPath).size < 20) {
      errors.push(`required release/governance file is missing or empty: ${relativePath}`);
    }
  }
  return errors;
}

export function validateReleaseSemantics({
  rootDir,
  documents,
  asOfDate = new Date().toISOString().slice(0, 10),
}) {
  const errors = [];
  const blockers = [];
  const { controls, openSource, manifest, dependencyAudit, publicationReview, coveragePolicy } = documents;

  addIf(fs.readFileSync(path.join(rootDir, '.nvmrc'), 'utf8').trim() !== manifest.versions.node, errors, 'release manifest: Node version differs from .nvmrc');
  addIf(fs.readFileSync(path.join(rootDir, '.python-version'), 'utf8').trim() !== manifest.versions.python, errors, 'release manifest: Python version differs from .python-version');

  addIf(dateAfter(asOfDate, controls.expiresOn), errors, `release controls expired on ${controls.expiresOn}`);
  if (controls.status !== 'approved') blockers.push(`release controls are ${controls.status}`);
  if (controls.status !== 'approved') {
    for (const [action, enabled] of Object.entries(controls.actions)) {
      addIf(enabled, errors, `release controls: ${action} cannot be enabled while controls are ${controls.status}`);
    }
  }

  const artifactClasses = new Map(openSource.artifactClasses.map(item => [item.class, item]));
  for (const requiredClass of ['code', 'content', 'model', 'dataset', 'evaluation']) {
    addIf(!artifactClasses.has(requiredClass), errors, `open-source policy: missing ${requiredClass} license class`);
  }
  if (openSource.status !== 'approved') {
    addIf(openSource.publicReleaseAuthorized, errors, 'open-source policy: public release cannot be authorized before approval');
    blockers.push(`open-source policy is ${openSource.status}`);
  }
  for (const item of openSource.artifactClasses) {
    if (item.approvalStatus !== 'approved' || !item.redistributionAuthorized) {
      blockers.push(`${item.class} license/redistribution is ${item.approvalStatus}`);
    }
  }
  for (const [name, value] of Object.entries(openSource.governance)) {
    if (!value) blockers.push(`open-source governance ${name} is unconfirmed`);
  }
  if (!openSource.repository.visibilityVerified) blockers.push('repository visibility is unverified');
  if (!openSource.repository.unicefReviewerAccess) blockers.push('UNICEF repository access is unverified');
  if (!openSource.repository.authoritativeUrl) blockers.push('authoritative repository URL is unapproved');

  if (manifest.state === 'blocked') {
    addIf(manifest.blockers.length === 0, errors, 'release manifest: blocked state requires blockers');
    addIf(Object.values(manifest.publication).some(Boolean), errors, 'release manifest: blocked state cannot authorize publication');
  }
  for (const input of manifest.inputs) {
    const fullPath = path.resolve(rootDir, input.path);
    if (!insideRoot(rootDir, fullPath) || !fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
      errors.push(`release manifest: invalid input path ${input.path}`);
    } else if (sha256File(fullPath) !== input.sha256) {
      errors.push(`release manifest: SHA-256 mismatch for ${input.path}`);
    }
  }
  for (const relativePath of [manifest.sbom.path, manifest.releaseNotes, manifest.knownLimitations, manifest.rollback.procedure]) {
    const fullPath = path.resolve(rootDir, relativePath);
    if (!insideRoot(rootDir, fullPath) || !fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
      errors.push(`release manifest: referenced file is unavailable or outside the repository (${relativePath})`);
    }
  }
  const sbomPath = path.join(rootDir, manifest.sbom.path);
  if (fs.existsSync(sbomPath) && sha256File(sbomPath) !== manifest.sbom.sha256) {
    errors.push('release manifest: SBOM SHA-256 does not match');
  }
  const generatedSbom = buildSourceSbom(rootDir);
  errors.push(...validateSourceSbom(generatedSbom));
  if (fs.existsSync(sbomPath) && fs.readFileSync(sbomPath, 'utf8') !== serializeSbom(generatedSbom)) {
    errors.push('release manifest: checked-in SBOM is stale for the lockfiles');
  }

  addIf(dependencyAudit.workspaces.some(item => {
    const total = Object.entries(item.vulnerabilities)
      .filter(([key]) => key !== 'total')
      .reduce((sum, [, count]) => sum + count, 0);
    return total !== item.vulnerabilities.total;
  }), errors, 'dependency audit: severity totals do not add up');
  if (dependencyAudit.status !== 'passed') blockers.push(`dependency audit is ${dependencyAudit.status}`);
  if (!dependencyAudit.sourceCommit || !dependencyAudit.databaseRevision) blockers.push('dependency audit lacks exact commit or database revision');
  if (documents.dependencyPolicy.unknownLicenseInventory.length > 0) {
    blockers.push(`${documents.dependencyPolicy.unknownLicenseInventory.length} dependency package(s) have unresolved license metadata`);
  }
  for (const workspace of dependencyAudit.workspaces) {
    if (workspace.vulnerabilities.total > 0) blockers.push(`${workspace.workspace} dependency audit has ${workspace.vulnerabilities.total} unresolved finding(s)`);
  }

  if (publicationReview.status !== 'passed') blockers.push(`repository publication review is ${publicationReview.status}`);
  if (!publicationReview.sourceCommit || !publicationReview.reviewedAt || !publicationReview.reviewerRole) {
    blockers.push('repository publication review lacks exact-commit independent evidence');
  }
  for (const [name, status] of Object.entries(publicationReview.checks)) {
    if (status !== 'passed') blockers.push(`repository publication check ${name} is ${status}`);
  }

  errors.push(...validateCoveragePolicy(coveragePolicy));
  errors.push(...validateRequiredFiles(rootDir));
  errors.push(...validateWorkflowPins(rootDir));

  if (!manifest.sourceCommit) blockers.push('release manifest has no source commit');
  if (!manifest.releaseTag) blockers.push('release manifest has no tag');
  if (!manifest.versions.androidVersionCode) blockers.push('release manifest has no Android version code');
  if (!manifest.artifacts.android) blockers.push('release manifest has no Android artifact');
  if (!manifest.artifacts.tunedModel) blockers.push('release manifest has no tuned model artifact');
  if (manifest.verification.verificationMode === 'github-actions' && !manifest.verification.ciRun) {
    blockers.push('release manifest has no protected-branch CI run');
  }
  if (!manifest.verification.testReportSha256) blockers.push('release manifest has no test report hash');
  if (!manifest.verification.coverageReportSha256) blockers.push('release manifest has no coverage report hash');
  if (manifest.verification.rollbackRehearsal !== 'passed' || !manifest.rollback.verified) blockers.push('rollback rehearsal is unverified');
  for (const [role, approved] of Object.entries(manifest.approvals)) {
    if (!approved) blockers.push(`release approval ${role} is absent`);
  }
  for (const [action, published] of Object.entries(manifest.publication)) {
    if (!published) blockers.push(`release publication action ${action} is not authorized`);
  }
  blockers.push(...manifest.blockers.map(item => `release manifest blocker: ${item}`));

  return { errors, blockers: [...new Set(blockers)] };
}

export function validateReleaseEvidenceRepository({
  rootDir,
  release = false,
  asOfDate = new Date().toISOString().slice(0, 10),
  documentOverrides = {},
} = {}) {
  const documents = { ...loadReleaseDocuments(rootDir), ...documentOverrides };
  const validators = compileSchemas(rootDir);
  const errors = [];
  for (const key of Object.keys(SCHEMAS)) {
    errors.push(...schemaErrors(key, validators[key], documents[key]));
  }
  if (errors.length === 0) {
    const semantic = validateReleaseSemantics({ rootDir, documents, asOfDate });
    errors.push(...semantic.errors);
    var blockers = semantic.blockers;
  } else {
    var blockers = [];
  }

  const dependencyResult = validateDependencyPolicy({
    rootDir,
    policy: documents.dependencyPolicy,
  });
  errors.push(...dependencyResult.errors);

  const repositoryResult = validateRepositorySafety({
    rootDir,
    release: false,
    review: documents.publicationReview,
  });
  errors.push(...repositoryResult.errors);

  const structuredResult = validateStructuredEvidenceRepository({ rootDir, asOfDate });
  errors.push(...structuredResult.errors.map(error => `structured evidence: ${error}`));
  const evidenceIds = new Set(structuredResult.documents.evidenceIndex.evidence.map(item => item.evidenceId));
  for (const evidenceRef of documents.manifest.evidenceRefs) {
    if (!evidenceIds.has(evidenceRef)) errors.push(`release manifest: unknown evidence reference ${evidenceRef}`);
  }

  if (release) {
    const publicationResult = validateRepositorySafety({
      rootDir,
      release: true,
      review: documents.publicationReview,
    });
    blockers.push(...publicationResult.blockers);
    for (const handoff of structuredResult.documents.externalHandoffs.handoffs) {
      if (!['passed', 'superseded'].includes(handoff.status)) blockers.push(`external handoff ${handoff.handoffId} is ${handoff.status}`);
    }
    for (const claim of structuredResult.documents.claimRegister.claims) {
      if (claim.status !== 'checkpoint-candidate' && claim.claimId === 'UNICEF-CHECKPOINT-001') {
        blockers.push(`claim ${claim.claimId} is ${claim.status}`);
      }
    }
  }

  const uniqueErrors = [...new Set(errors)];
  const uniqueBlockers = [...new Set(blockers)];
  return {
    ok: uniqueErrors.length === 0 && (!release || uniqueBlockers.length === 0),
    structurallyValid: uniqueErrors.length === 0,
    release,
    errors: uniqueErrors,
    blockers: uniqueBlockers,
    documents,
  };
}
