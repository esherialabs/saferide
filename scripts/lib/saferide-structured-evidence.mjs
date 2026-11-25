import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import Ajv2020 from 'ajv/dist/2020.js';

import { validateTunedArtifactDocuments } from './saferide-tuned-artifact.mjs';

export const STRUCTURED_EVIDENCE_PATHS = Object.freeze({
  baseManifest: 'config/ai/manifests/base-gemma4-e2b.json',
  tunedManifest: 'config/ai/manifests/saferide-v058-original-419806.artifact-produced.json',
  tunedControls: 'config/ai/tuned-artifact-controls.v2.json',
  tunedDeviceEvidence: 'docs/qa/saferide-tuned-artifact-device-evidence.pending.json',
  safetySummary: 'config/ai/safety-summary.v0.5.8.json',
  claimRegister: 'docs/unicef/checkpoint-2026-08/claim-register.json',
  evidenceIndex: 'docs/unicef/checkpoint-2026-08/evidence-index.json',
  externalHandoffs: 'docs/unicef/checkpoint-2026-08/external-handoffs.json',
});

const SCHEMA_PATHS = Object.freeze({
  baseManifest: 'schemas/local-ai-manifest.schema.json',
  tunedManifest: 'schemas/tuned-mobile-artifact-manifest.schema.json',
  tunedControls: 'schemas/tuned-artifact-controls.schema.json',
  tunedDeviceEvidence: 'schemas/tuned-artifact-device-evidence.schema.json',
  safetySummary: 'schemas/ai-safety-summary.schema.json',
  claimRegister: 'schemas/unicef-claim-register.schema.json',
  evidenceIndex: 'schemas/unicef-evidence-index.schema.json',
  externalHandoffs: 'schemas/external-handoff.schema.json',
});

const PUBLIC_FORBIDDEN_CONTENT_CLASSES = new Set([
  'raw-prompt',
  'raw-completion',
  'raw-transcript',
  'survivor-record',
  'exact-location',
  'credential',
  'partner-confidential',
]);

const RELEASE_LIKE_STATUSES = new Set([
  'unicef-checkpoint',
  'moderated-test',
  'release-candidate',
  'release-ready',
]);

const PROMOTION_DECISIONS = new Set(['checkpoint-candidate', 'release-candidate']);
const ACTIVE_EVIDENCE_STATUSES = new Set(['draft', 'review-pending', 'verified', 'blocked']);
const READY_WORDING = /\b(?:checkpoint-ready|production-ready|release-ready|UNICEF-approved|survivor-ready)\b/i;
const SUPERSEDED_MODEL = /(?:gemma[- ]?3n|esherialabs\/saferide-gemma-3n)/i;

function readJson(rootDir, relativePath) {
  const fullPath = path.join(rootDir, relativePath);
  try {
    return JSON.parse(fs.readFileSync(fullPath, 'utf8'));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${relativePath}: cannot read valid JSON (${reason})`);
  }
}

function compileSchemas(rootDir) {
  // JSON Schema permits conditional subschemas to rely on a parent object's
  // declared type. Ajv's strictTypes extension requires repeating that type in
  // every if/then branch, so keep strict schema checking while disabling only
  // that non-standard repetition rule.
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    strictRequired: false,
    strictTypes: false,
    validateFormats: false,
  });
  return Object.fromEntries(Object.entries(SCHEMA_PATHS).map(([key, schemaPath]) => {
    const schema = readJson(rootDir, schemaPath);
    return [key, ajv.compile(schema)];
  }));
}

function schemaErrors(label, validator, value) {
  if (validator(value)) return [];
  return (validator.errors ?? []).map(error => {
    const location = error.instancePath || '/';
    return `${label}${location}: ${error.message ?? error.keyword}`;
  });
}

function dateIsAfter(left, right) {
  return Date.parse(`${left}T00:00:00Z`) > Date.parse(`${right}T00:00:00Z`);
}

function isStale(recheckDate, asOfDate) {
  return dateIsAfter(asOfDate, recheckDate);
}

function addIf(condition, errors, message) {
  if (condition) errors.push(message);
}

function ensureUnique(records, key, label, errors) {
  const seen = new Set();
  for (const record of records) {
    const value = record[key];
    if (seen.has(value)) errors.push(`${label}: duplicate ${key} ${value}`);
    seen.add(value);
  }
}

function isInsideRoot(rootDir, candidate) {
  const relative = path.relative(rootDir, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export function sha256File(fullPath) {
  return createHash('sha256').update(fs.readFileSync(fullPath)).digest('hex');
}

export function validateManifestSemantics({ baseManifest, tunedManifest, safetySummary }) {
  const errors = [];
  const primary = baseManifest.artifacts?.find(artifact => artifact.required && artifact.role === 'model');

  addIf(!primary, errors, 'base manifest: required primary model artifact is missing');
  if (primary) {
    addIf(!primary.fileName.endsWith(baseManifest.runtime.modelFileExtension), errors, 'base manifest: primary file extension does not match runtime');
    addIf(primary.sizeBytes > baseManifest.deviceRequirements.storageRequiredBytes, errors, 'base manifest: storage requirement is smaller than the primary artifact');
    addIf(baseManifest.rollout.downloadMode === 'app-download' && primary.controlledImportOnly, errors, 'base manifest: controlled-import artifact cannot use app-download rollout');
  }

  const enabledCapabilities = Object.entries(baseManifest.capabilities)
    .filter(([, capability]) => capability.enabled);
  for (const [name, capability] of enabledCapabilities) {
    addIf(capability.stage === 'disabled', errors, `base manifest: enabled capability ${name} has disabled stage`);
    addIf(!capability.evidenceRef, errors, `base manifest: enabled capability ${name} has no evidence reference`);
  }

  if (baseManifest.license.legalStatus !== 'approved') {
    addIf(!['controlled-import', 'disabled'].includes(baseManifest.rollout.downloadMode), errors, 'base manifest: unresolved legal status must disable app/network download');
    addIf((baseManifest.rollout.maxRolloutPercent ?? 0) !== 0, errors, 'base manifest: unresolved legal status requires zero rollout');
  }

  if (RELEASE_LIKE_STATUSES.has(baseManifest.status)) {
    addIf(baseManifest.license.legalStatus !== 'approved', errors, 'base manifest: release-like status requires legal approval');
    addIf(baseManifest.safety.criticalFailures !== 0, errors, 'base manifest: release-like status requires zero critical failures');
    addIf(!baseManifest.safety.reviewerSignoff, errors, 'base manifest: release-like status requires reviewer signoff');
    addIf(!baseManifest.androidEvidence.physicalDeviceProof, errors, 'base manifest: release-like status requires physical device proof');
  }

  addIf(tunedManifest.safetyReport.summaryId !== safetySummary.summaryId, errors, 'tuned manifest: safety summary reference does not match the registered summary');
  if (tunedManifest.status === 'export-blocked') {
    addIf(tunedManifest.artifact.sha256 !== null, errors, 'tuned manifest: export-blocked state cannot contain an artifact hash');
    addIf(tunedManifest.artifact.sizeBytes !== null, errors, 'tuned manifest: export-blocked state cannot contain an artifact size');
    addIf(tunedManifest.androidProof.tunedArtifactPhysicalDeviceProof, errors, 'tuned manifest: export-blocked state cannot claim tuned Android proof');
  }
  if (tunedManifest.status === 'artifact-produced') {
    addIf(!tunedManifest.artifact.sha256, errors, 'tuned manifest: artifact-produced state requires a hash');
    addIf(!tunedManifest.artifact.sizeBytes, errors, 'tuned manifest: artifact-produced state requires a byte size');
  }

  return errors;
}

export function validateSafetySummarySemantics(summary, asOfDate) {
  const errors = [];
  const { counts, review } = summary;
  addIf(counts.generatedResponses > counts.requiredPrompts, errors, 'safety summary: generated response count exceeds required prompts');
  addIf(counts.completedResponses + counts.truncatedResponses > counts.generatedResponses, errors, 'safety summary: completed plus truncated responses exceeds generated responses');
  addIf(counts.validReviewedResponses > counts.completedResponses, errors, 'safety summary: valid reviewed responses exceed completed responses');
  addIf(review.completedReviewerRoles.length > review.independentReviewerCount, errors, 'safety summary: completed reviewer roles exceed reviewer count');
  addIf(review.hiddenPromptDisclosureDetected && counts.criticalFailures < 1, errors, 'safety summary: hidden-prompt disclosure must force at least one critical failure');
  addIf(isStale(summary.recheckDate, asOfDate), errors, `safety summary: evidence expired on ${summary.recheckDate}`);

  const requiresBlocked = (
    counts.completedResponses !== counts.requiredPrompts
    || counts.validReviewedResponses !== counts.requiredPrompts
    || counts.truncatedResponses > 0
    || counts.criticalFailures > 0
    || counts.unresolvedScoreOneFindings > 0
    || review.hiddenPromptDisclosureDetected
    || review.independentReviewerCount < 2
    || review.adjudicationStatus === 'pending'
  );
  addIf(requiresBlocked && summary.decision !== 'blocked', errors, 'safety summary: incomplete, critical, singly reviewed, or unresolved evidence must remain blocked');

  if (PROMOTION_DECISIONS.has(summary.decision)) {
    addIf(summary.scores.promotionAverage === null, errors, 'safety summary: promotion decision requires a promotion average');
    addIf(summary.blockers.length > 0, errors, 'safety summary: promotion decision cannot retain blockers');
    for (const locale of ['en', 'sw']) {
      const slice = summary.languageSlices.find(item => item.locale === locale);
      addIf(!slice || slice.status !== 'evaluated' || slice.reviewStatus !== 'approved', errors, `safety summary: promotion requires approved ${locale} results`);
    }
  }
  return errors;
}

export function validateEvidenceIndexSemantics(index, { rootDir, asOfDate }) {
  const errors = [];
  ensureUnique(index.evidence, 'evidenceId', 'evidence index', errors);
  const assertionValues = new Map();

  for (const evidence of index.evidence) {
    const label = `evidence ${evidence.evidenceId}`;
    if (isStale(evidence.recheckDate, asOfDate) && evidence.status !== 'superseded') {
      errors.push(`${label}: evidence expired on ${evidence.recheckDate}`);
    }
    if (evidence.sensitivity === 'public' && PUBLIC_FORBIDDEN_CONTENT_CLASSES.has(evidence.contentClass)) {
      errors.push(`${label}: ${evidence.contentClass} cannot be public evidence`);
    }
    if (evidence.status === 'verified' && (!evidence.reviewerRole || !evidence.reviewDate)) {
      errors.push(`${label}: verified evidence requires reviewer role and review date`);
    }

    if (evidence.repositoryPath) {
      const fullPath = path.resolve(rootDir, evidence.repositoryPath);
      if (!isInsideRoot(rootDir, fullPath)) {
        errors.push(`${label}: repository path escapes the repository root`);
      } else if (!fs.existsSync(fullPath)) {
        errors.push(`${label}: repository path does not exist (${evidence.repositoryPath})`);
      } else if (!fs.statSync(fullPath).isFile()) {
        errors.push(`${label}: repository path is not a file (${evidence.repositoryPath})`);
      } else if (evidence.sha256 && sha256File(fullPath) !== evidence.sha256) {
        errors.push(`${label}: SHA-256 mismatch for ${evidence.repositoryPath}`);
      }
    }

    if (!evidence.repositoryPath && !evidence.externalReference) {
      errors.push(`${label}: repositoryPath or externalReference is required`);
    }
    if (evidence.sensitivity === 'restricted' && /public|open link|anyone/i.test(evidence.accessInstructions)) {
      errors.push(`${label}: restricted evidence has public access instructions`);
    }

    if (ACTIVE_EVIDENCE_STATUSES.has(evidence.status)) {
      for (const assertion of evidence.assertions) {
        const key = `${assertion.subject}\u0000${assertion.predicate}`;
        const current = assertionValues.get(key);
        if (current && current.value !== assertion.value) {
          errors.push(`${label}: assertion contradicts ${current.evidenceId} for ${assertion.subject}/${assertion.predicate}`);
        } else if (!current) {
          assertionValues.set(key, { value: assertion.value, evidenceId: evidence.evidenceId });
        }
      }
    }
  }
  return errors;
}

export function validateClaimRegisterSemantics(register, { evidenceIndex, safetySummary, tunedManifest, asOfDate }) {
  const errors = [];
  const evidenceById = new Map(evidenceIndex.evidence.map(item => [item.evidenceId, item]));
  ensureUnique(register.claims, 'claimId', 'claim register', errors);

  for (const claim of register.claims) {
    const label = `claim ${claim.claimId}`;
    if (isStale(claim.recheckDate, asOfDate) && claim.status !== 'withdrawn') {
      errors.push(`${label}: claim expired on ${claim.recheckDate}`);
    }
    for (const evidenceRef of claim.evidenceRefs) {
      if (!evidenceById.has(evidenceRef)) errors.push(`${label}: unknown evidence reference ${evidenceRef}`);
    }
    if (claim.status === 'blocked' && !claim.blocker) errors.push(`${label}: blocked claim requires a blocker`);
    if (claim.status !== 'blocked' && claim.status !== 'withdrawn' && claim.blocker && claim.status === 'checkpoint-candidate') {
      errors.push(`${label}: checkpoint candidate cannot retain a blocker`);
    }
    if (claim.status !== 'checkpoint-candidate' && READY_WORDING.test(claim.approvedWording)) {
      errors.push(`${label}: readiness wording is forbidden before checkpoint-candidate status`);
    }
    if (claim.status !== 'withdrawn' && SUPERSEDED_MODEL.test(claim.approvedWording)) {
      errors.push(`${label}: active wording references the superseded Gemma 3n path`);
    }
    if (/zero critical failures/i.test(claim.approvedWording) && safetySummary.counts.criticalFailures !== 0) {
      errors.push(`${label}: wording contradicts structured critical-failure evidence`);
    }
    const tunedMobileBehaviorClaimed = /tuned[^.]{0,80}(?:runs|running|phone|android)/i.test(claim.approvedWording);
    const artifactProduced = !['training-complete', 'adapter-evaluated', 'export-blocked'].includes(tunedManifest.status);
    if (tunedMobileBehaviorClaimed && !artifactProduced) {
      errors.push(`${label}: wording presents tuned mobile behavior without a produced artifact`);
    }
    if (tunedMobileBehaviorClaimed && !tunedManifest.androidProof.tunedArtifactPhysicalDeviceProof) {
      errors.push(`${label}: wording presents tuned mobile behavior without physical Android evidence`);
    }

    if (claim.status === 'checkpoint-candidate') {
      addIf(claim.evidenceRefs.length === 0, errors, `${label}: checkpoint candidate requires evidence`);
      addIf(claim.reviewerRoles.length === 0, errors, `${label}: checkpoint candidate requires reviewer roles`);
      for (const evidenceRef of claim.evidenceRefs) {
        const evidence = evidenceById.get(evidenceRef);
        if (evidence && evidence.status !== 'verified') {
          errors.push(`${label}: checkpoint candidate evidence ${evidenceRef} is ${evidence.status}, not verified`);
        }
      }
    }
  }
  return errors;
}

export function validateExternalHandoffsSemantics(register, { claimRegister, asOfDate }) {
  const errors = [];
  const claims = new Map(claimRegister.claims.map(claim => [claim.claimId, claim]));
  ensureUnique(register.handoffs, 'handoffId', 'external handoffs', errors);

  for (const handoff of register.handoffs) {
    const label = `handoff ${handoff.handoffId}`;
    if (isStale(handoff.recheckDate, asOfDate) && !['expired', 'superseded'].includes(handoff.status)) {
      errors.push(`${label}: handoff expired on ${handoff.recheckDate}`);
    }
    for (const claimId of handoff.affectedClaimIds) {
      const claim = claims.get(claimId);
      if (!claim) {
        errors.push(`${label}: unknown affected claim ${claimId}`);
      } else if (!['passed', 'superseded'].includes(handoff.status) && claim.status === 'checkpoint-candidate') {
        errors.push(`${label}: unresolved dependency cannot feed checkpoint-candidate claim ${claimId}`);
      }
    }
    if (handoff.status === 'passed') {
      addIf(handoff.expectedArtifacts.length === 0, errors, `${label}: passed handoff requires expected artifacts`);
      addIf(handoff.passGate.length === 0, errors, `${label}: passed handoff requires pass gates`);
    }
  }
  return errors;
}

export function validateStructuredEvidenceRepository({ rootDir, asOfDate = new Date().toISOString().slice(0, 10) }) {
  const documents = Object.fromEntries(Object.entries(STRUCTURED_EVIDENCE_PATHS).map(([key, relativePath]) => (
    [key, readJson(rootDir, relativePath)]
  )));
  const validators = compileSchemas(rootDir);
  const errors = [];

  for (const key of Object.keys(STRUCTURED_EVIDENCE_PATHS)) {
    errors.push(...schemaErrors(key, validators[key], documents[key]));
  }
  if (errors.length > 0) return { ok: false, asOfDate, errors, documents };

  errors.push(...validateManifestSemantics(documents));
  errors.push(...validateTunedArtifactDocuments({
    manifest: documents.tunedManifest,
    controls: documents.tunedControls,
    deviceEvidence: documents.tunedDeviceEvidence,
    controlsSha256: sha256File(path.join(rootDir, STRUCTURED_EVIDENCE_PATHS.tunedControls)),
    asOfDate,
  }).errors);
  errors.push(...validateSafetySummarySemantics(documents.safetySummary, asOfDate));
  errors.push(...validateEvidenceIndexSemantics(documents.evidenceIndex, { rootDir, asOfDate }));
  errors.push(...validateClaimRegisterSemantics(documents.claimRegister, {
    evidenceIndex: documents.evidenceIndex,
    safetySummary: documents.safetySummary,
    tunedManifest: documents.tunedManifest,
    asOfDate,
  }));
  errors.push(...validateExternalHandoffsSemantics(documents.externalHandoffs, {
    claimRegister: documents.claimRegister,
    asOfDate,
  }));

  return { ok: errors.length === 0, asOfDate, errors, documents };
}

export function summarizeStructuredEvidence(result) {
  const { documents } = result;
  return {
    asOfDate: result.asOfDate,
    valid: result.ok,
    errorCount: result.errors.length,
    baseRuntime: {
      manifestId: documents.baseManifest.manifestId,
      status: documents.baseManifest.status,
      downloadMode: documents.baseManifest.rollout.downloadMode,
      legalStatus: documents.baseManifest.license.legalStatus,
      physicalDeviceProof: documents.baseManifest.androidEvidence.physicalDeviceProof,
    },
    adapter: {
      summaryId: documents.safetySummary.summaryId,
      decision: documents.safetySummary.decision,
      criticalFailures: documents.safetySummary.counts.criticalFailures,
      completedResponses: documents.safetySummary.counts.completedResponses,
      requiredPrompts: documents.safetySummary.counts.requiredPrompts,
      reviewerCount: documents.safetySummary.review.independentReviewerCount,
    },
    tunedMobileArtifact: {
      manifestId: documents.tunedManifest.manifestId,
      status: documents.tunedManifest.status,
      artifactHashPresent: Boolean(documents.tunedManifest.artifact.sha256),
      physicalDeviceProof: documents.tunedManifest.androidProof.tunedArtifactPhysicalDeviceProof,
      activationEnabled: documents.tunedControls.activation.enabled,
      deviceEvidenceStatus: documents.tunedDeviceEvidence.status,
    },
    claims: Object.fromEntries(documents.claimRegister.claims.map(claim => [claim.claimId, claim.status])),
    externalHandoffs: Object.fromEntries(documents.externalHandoffs.handoffs.map(handoff => [handoff.handoffId, handoff.status])),
  };
}
