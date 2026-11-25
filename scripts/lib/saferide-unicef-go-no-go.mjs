import fs from 'node:fs';
import path from 'node:path';

import Ajv2020 from 'ajv/dist/2020.js';

import { validateReleaseEvidenceRepository } from './saferide-release-evidence.mjs';
import { sha256File } from './saferide-sbom.mjs';
import { validateStructuredEvidenceRepository } from './saferide-structured-evidence.mjs';

export const UNICEF_GO_NO_GO_PATHS = Object.freeze({
  coverage: 'config/unicef/prd-coverage.v1.json',
  coverageSchema: 'schemas/unicef-prd-coverage.schema.json',
  decision: 'docs/unicef/checkpoint-2026-08/go-no-go.pending.json',
  decisionSchema: 'schemas/unicef-go-no-go-decision.schema.json',
});

export const CHECKPOINT_CRITERION_IDS = Object.freeze([
  'GO-NOGO-SAFETY',
  'GO-NOGO-JAIL',
  'GO-NOGO-AI-REVIEW',
  'GO-NOGO-ARTIFACT-TRUTH',
  'GO-NOGO-ENCRYPTED-PERSISTENCE',
  'GO-NOGO-PRIVACY-TRUTH',
  'GO-NOGO-GOVERNANCE-TRUTH',
  'GO-NOGO-PRODUCT-EVIDENCE',
  'GO-NOGO-CI-RELEASE',
  'GO-NOGO-OPEN-SOURCE',
  'GO-NOGO-BUSINESS-PILOT',
  'GO-NOGO-DEMO',
]);

export const DEFINITION_OF_DONE_IDS = Object.freeze([
  'DOD-1', 'DOD-2', 'DOD-3', 'DOD-4', 'DOD-5', 'DOD-6', 'DOD-7', 'DOD-8', 'DOD-9',
]);

const SAFE_COMMAND_PREFIXES = Object.freeze(['npm run ', 'node ', 'npx vitest ', 'npx tsc ']);
const PROHIBITED_COMMAND_PATTERN = /(?:local:reset|docker\s+compose[^\n]*\sdown|\beas(?:-cli)?\b|\baws\b|git\s+(?:push|merge|reset|clean)|rm\s+-rf|production\s+deploy)/i;
const CANDIDATE_STATUSES = new Set(['satisfied', 'satisfied-disabled']);
const RESOLVED_HANDOFF_STATUSES = new Set(['passed', 'superseded']);
export const LOCAL_VERIFICATION_OWNER_STATEMENT = 'GitHub Actions are enabled, but PR #209 jobs did not start because the organization billing or spending limit blocked hosted execution; local verification was completed.';
const REQUIREMENT_PREFIX_BY_UNIT = Object.freeze({
  'AI-GOVERNANCE': 'GOV-',
  'V04-DATA': 'DATA-',
  'V04-TRAINING': 'TRAIN-',
  'AI-EVALUATION': 'EVAL-',
  'TUNED-MOBILE': 'MOB-',
  'PRIVACY-LIFECYCLE': 'PRIV-',
  'RSI-PRIVACY': 'RSI-',
  'PRODUCT-TESTING': 'TEST-',
  LOCALIZATION: 'LANG-',
  'PROVIDER-DIRECTORY': 'DIR-',
  'OPEN-SOURCE-RELEASE': 'OSS-',
});

function readJson(rootDir, relativePath) {
  return JSON.parse(fs.readFileSync(path.join(rootDir, relativePath), 'utf8'));
}

function schemaErrors(label, validator, value) {
  if (validator(value)) return [];
  return (validator.errors ?? []).map(error => `${label}${error.instancePath || '/'}: ${error.message ?? error.keyword}`);
}

function compileSchema(rootDir, relativePath) {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    strictRequired: false,
    strictTypes: false,
    validateFormats: false,
  });
  return ajv.compile(readJson(rootDir, relativePath));
}

function insideRoot(rootDir, candidate) {
  const relative = path.relative(rootDir, candidate);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function uniqueDuplicates(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort();
}

function sameMembers(actual, expected) {
  return actual.length === expected.length && [...actual].sort().every((value, index) => value === [...expected].sort()[index]);
}

function jsonPointer(document, pointer) {
  return pointer
    .slice(1)
    .split('/')
    .map(token => token.replace(/~1/g, '/').replace(/~0/g, '~'))
    .reduce((value, token) => value?.[token], document);
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function extractPrdRequirementIds(markdown) {
  return [...new Set([...markdown.matchAll(/^\|\s*([A-Z]+-[0-9]{3})\s*\|/gm)].map(match => match[1]))].sort();
}

function extractPrdPhaseRefs(markdown) {
  return [...markdown.matchAll(/^### Phase ([0-8]):/gm)].map(match => `PHASE-${match[1]}`);
}

function extractPrdWorkstreamRefs(markdown) {
  return [...markdown.matchAll(/^## \d+\. Workstream ([1-7]):/gm)].map(match => `WORKSTREAM-${match[1]}`);
}

function extractPrdProhibitedClaims(markdown) {
  const section = markdown.match(/## 26\. Approved progress wording until gates pass[\s\S]*?Do not use:\s*\n([\s\S]*?)\n## 27\./)?.[1] ?? '';
  return [...section.matchAll(/^- (.+)$/gm)].map(match => match[1].trim());
}

export function buildUnicefGoNoGoDecision({ coverage, structuredDocuments }) {
  const blockingHandoffIds = structuredDocuments.externalHandoffs.handoffs
    .filter(handoff => !RESOLVED_HANDOFF_STATUSES.has(handoff.status))
    .map(handoff => handoff.handoffId)
    .sort();
  const blockingClaimIds = structuredDocuments.claimRegister.claims
    .filter(claim => claim.status === 'blocked')
    .map(claim => claim.claimId)
    .sort();

  return {
    schema: 'com.saferide.unicef-go-no-go-decision',
    schemaVersion: 1,
    decisionId: `${coverage.coverageId}.decision`,
    asOfDate: coverage.asOfDate,
    sourceRevision: coverage.sourceRevision,
    prd: { path: coverage.prd.path, sha256: coverage.prd.sha256 },
    decision: coverage.decision.state,
    checkpointCandidate: coverage.decision.checkpointCandidate,
    repositoryCoverage: {
      tableRequirementIdsMapped: coverage.coverageUnits.flatMap(unit => unit.requirementIds).length,
      coverageUnitsMapped: coverage.coverageUnits.length,
      requiredMilestonesMapped: coverage.requiredMilestones.length,
      requirementsIndependentlyVerified: 0,
    },
    checkpointCriteria: coverage.checkpointCriteria.map(criterion => ({
      criterionId: criterion.criterionId,
      status: criterion.status,
      blockers: criterion.blockers,
    })),
    definitionOfDone: coverage.definitionOfDone.map(criterion => ({
      criterionId: criterion.criterionId,
      status: criterion.status,
      blockers: criterion.blockers,
    })),
    blockingHandoffIds,
    blockingClaimIds,
    prohibitedClaims: coverage.copyPolicy.prohibitedClaims,
    limitations: [
      'The 136 value is a count of canonical requirement IDs mapped to coverage units, not 136 independently executed, accepted, or passed requirements.',
      'Every coverage unit is mapped-unverified until requirement-level proof and review exist.',
      LOCAL_VERIFICATION_OWNER_STATEMENT,
      'No model weight, signed Android artifact, device matrix, participant session, legal approval, partnership, release, submission, production deployment, survivor-readiness, or UNICEF approval is asserted.',
      'Every externally unverified capability remains disabled and release/publication actions remain false.',
    ],
    rollbackTarget: coverage.decision.rollbackTarget,
  };
}

export function validateUnicefGoNoGo({
  rootDir,
  release = false,
  asOfDate,
  coverageOverride,
  controlOverrides = {},
  decisionOverride,
  checkDecision = true,
} = {}) {
  const coverage = coverageOverride ?? readJson(rootDir, UNICEF_GO_NO_GO_PATHS.coverage);
  const coverageValidator = compileSchema(rootDir, UNICEF_GO_NO_GO_PATHS.coverageSchema);
  const decisionValidator = compileSchema(rootDir, UNICEF_GO_NO_GO_PATHS.decisionSchema);
  const errors = schemaErrors('coverage', coverageValidator, coverage);
  const blockers = [];
  const candidateRequestedForRelease = coverage?.decision?.state === 'checkpoint-candidate' || coverage?.decision?.checkpointCandidate === true;

  const structured = validateStructuredEvidenceRepository({ rootDir, asOfDate: asOfDate ?? coverage.asOfDate });
  errors.push(...structured.errors.map(error => `structured evidence: ${error}`));
  const releaseResult = validateReleaseEvidenceRepository({
    rootDir,
    release: release || candidateRequestedForRelease,
    asOfDate: asOfDate ?? coverage.asOfDate,
  });
  errors.push(...releaseResult.errors.map(error => `release evidence: ${error}`));
  if (release) blockers.push(...releaseResult.blockers.map(blocker => `release: ${blocker}`));

  if (errors.length === 0) {
    const prdPath = path.resolve(rootDir, coverage.prd.path);
    if (!insideRoot(rootDir, prdPath) || !fs.existsSync(prdPath) || !fs.statSync(prdPath).isFile()) {
      errors.push(`PRD path is unavailable or outside the repository: ${coverage.prd.path}`);
    } else {
      if (sha256File(prdPath) !== coverage.prd.sha256) errors.push('PRD SHA-256 does not match the coverage contract');
      const prdMarkdown = fs.readFileSync(prdPath, 'utf8');
      const prdIds = extractPrdRequirementIds(prdMarkdown);
      const mappedIds = coverage.coverageUnits.flatMap(unit => unit.requirementIds);
      if (prdIds.length !== coverage.prd.expectedTableRequirementCount) {
        errors.push(`PRD table requirement count is ${prdIds.length}, expected ${coverage.prd.expectedTableRequirementCount}`);
      }
      for (const duplicate of uniqueDuplicates(mappedIds)) errors.push(`requirement ID is mapped more than once: ${duplicate}`);
      for (const missing of prdIds.filter(id => !mappedIds.includes(id))) errors.push(`PRD requirement is not mapped: ${missing}`);
      for (const extra of mappedIds.filter(id => !prdIds.includes(id))) errors.push(`coverage maps unknown PRD requirement: ${extra}`);
      for (const reference of [...extractPrdPhaseRefs(prdMarkdown), ...extractPrdWorkstreamRefs(prdMarkdown)]) {
        if (!coverage.requiredMilestones.includes(reference)) errors.push(`canonical PRD milestone is not required: ${reference}`);
      }
      if (!sameMembers(extractPrdProhibitedClaims(prdMarkdown), coverage.copyPolicy.prohibitedClaims)) {
        errors.push('copy policy does not exactly match the PRD section 26 prohibited claims');
      }
    }

    for (const duplicate of uniqueDuplicates(coverage.coverageUnits.map(unit => unit.unitId))) errors.push(`duplicate coverage unit: ${duplicate}`);
    for (const [unitId, prefix] of Object.entries(REQUIREMENT_PREFIX_BY_UNIT)) {
      const unit = coverage.coverageUnits.find(item => item.unitId === unitId);
      if (!unit) errors.push(`required table-coverage unit is missing: ${unitId}`);
      else if (unit.requirementIds.some(id => !id.startsWith(prefix))) errors.push(`${unitId}: requirement mapping contains an ID outside ${prefix}`);
    }
    for (const unit of coverage.coverageUnits.filter(item => item.requirementIds.length > 0 && !Object.hasOwn(REQUIREMENT_PREFIX_BY_UNIT, item.unitId))) {
      errors.push(`${unit.unitId}: table requirements are mapped by an undeclared coverage unit`);
    }
    const mappedMilestones = coverage.coverageUnits.flatMap(unit => unit.milestoneRefs);
    for (const milestone of coverage.requiredMilestones) {
      if (!mappedMilestones.includes(milestone)) errors.push(`required milestone is not mapped: ${milestone}`);
    }
    for (const milestone of mappedMilestones) {
      if (!coverage.requiredMilestones.includes(milestone)) errors.push(`coverage unit maps undeclared milestone: ${milestone}`);
    }

    const evidenceIds = new Set(structured.documents.evidenceIndex.evidence.map(item => item.evidenceId));
    const claimIds = new Set(structured.documents.claimRegister.claims.map(item => item.claimId));
    const handoffById = new Map(structured.documents.externalHandoffs.handoffs.map(item => [item.handoffId, item]));
    for (const unit of coverage.coverageUnits) {
      for (const relativePath of unit.requiredPaths) {
        const fullPath = path.resolve(rootDir, relativePath);
        if (!insideRoot(rootDir, fullPath) || !fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
          errors.push(`${unit.unitId}: required path is missing, outside the repository, or not a file (${relativePath})`);
        }
      }
      for (const command of unit.validatorCommands) {
        if (!SAFE_COMMAND_PREFIXES.some(prefix => command.startsWith(prefix))) errors.push(`${unit.unitId}: validator command is not allowlisted (${command})`);
        if (PROHIBITED_COMMAND_PATTERN.test(command)) errors.push(`${unit.unitId}: validator command is destructive or externally mutating (${command})`);
      }
      for (const evidenceId of unit.evidenceIds) if (!evidenceIds.has(evidenceId)) errors.push(`${unit.unitId}: unknown evidence reference ${evidenceId}`);
      for (const claimId of unit.claimIds) if (!claimIds.has(claimId)) errors.push(`${unit.unitId}: unknown claim reference ${claimId}`);
      for (const handoffId of unit.handoffIds) if (!handoffById.has(handoffId)) errors.push(`${unit.unitId}: unknown handoff reference ${handoffId}`);
      if (unit.promotionStatus === 'blocked-external' && unit.handoffIds.length === 0) errors.push(`${unit.unitId}: blocked external state requires an executable handoff`);
      if (unit.promotionStatus === 'blocked-external' && unit.handoffIds.every(id => RESOLVED_HANDOFF_STATUSES.has(handoffById.get(id)?.status))) {
        errors.push(`${unit.unitId}: promotion remains blocked even though every referenced handoff is resolved`);
      }
    }

    for (const duplicate of uniqueDuplicates(coverage.controlAssertions.map(item => item.controlId))) errors.push(`duplicate control assertion: ${duplicate}`);
    for (const assertion of coverage.controlAssertions) {
      const fullPath = path.resolve(rootDir, assertion.path);
      if (!insideRoot(rootDir, fullPath) || !fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
        errors.push(`${assertion.controlId}: control document is unavailable (${assertion.path})`);
        continue;
      }
      const document = Object.hasOwn(controlOverrides, assertion.path)
        ? controlOverrides[assertion.path]
        : readJson(rootDir, assertion.path);
      const actual = jsonPointer(document, assertion.pointer);
      if (!sameJson(actual, assertion.expected)) {
        errors.push(`${assertion.controlId}: fail-closed assertion ${assertion.pointer} expected ${JSON.stringify(assertion.expected)}, received ${JSON.stringify(actual)}`);
      }
    }

    if (!sameMembers(coverage.checkpointCriteria.map(item => item.criterionId), CHECKPOINT_CRITERION_IDS)) {
      errors.push('checkpoint criteria do not exactly cover PRD section 24');
    }
    if (!sameMembers(coverage.definitionOfDone.map(item => item.criterionId), DEFINITION_OF_DONE_IDS)) {
      errors.push('definition-of-done criteria do not exactly cover PRD section 23');
    }
    const gates = [...coverage.checkpointCriteria, ...coverage.definitionOfDone];
    for (const gate of gates) {
      for (const evidenceId of gate.evidenceIds) if (!evidenceIds.has(evidenceId)) errors.push(`${gate.criterionId}: unknown evidence reference ${evidenceId}`);
      for (const claimId of gate.claimIds) if (!claimIds.has(claimId)) errors.push(`${gate.criterionId}: unknown claim reference ${claimId}`);
      for (const handoffId of gate.handoffIds) if (!handoffById.has(handoffId)) errors.push(`${gate.criterionId}: unknown handoff reference ${handoffId}`);
      if (gate.status === 'blocked-external' && gate.handoffIds.length === 0) errors.push(`${gate.criterionId}: blocked criterion requires an executable handoff`);
      if (gate.status === 'satisfied' && gate.blockers.length > 0) errors.push(`${gate.criterionId}: satisfied criterion cannot retain blockers`);
      if (gate.status === 'implemented-unverified' && gate.blockers.length === 0) errors.push(`${gate.criterionId}: unverified criterion must state its blocker`);
    }

    const candidateRequested = coverage.decision.state === 'checkpoint-candidate' || coverage.decision.checkpointCandidate;
    if (candidateRequested && (coverage.decision.state !== 'checkpoint-candidate' || !coverage.decision.checkpointCandidate)) {
      errors.push('checkpoint-candidate state and boolean must advance together');
    }
    if (candidateRequested) {
      for (const gate of gates.filter(item => item.requiredForCandidate && !CANDIDATE_STATUSES.has(item.status))) {
        errors.push(`checkpoint candidate cannot pass while ${gate.criterionId} is ${gate.status}`);
      }
      const checkpointClaim = structured.documents.claimRegister.claims.find(claim => claim.claimId === 'UNICEF-CHECKPOINT-001');
      if (checkpointClaim?.status !== 'checkpoint-candidate') errors.push('checkpoint candidate requires UNICEF-CHECKPOINT-001 to be checkpoint-candidate');
      if (!releaseResult.ok) errors.push('checkpoint candidate requires the full release evidence gate to pass');
    } else {
      for (const gate of gates.filter(item => !CANDIDATE_STATUSES.has(item.status))) blockers.push(`${gate.criterionId} is ${gate.status}`);
    }

    const allowedClaim = structured.documents.claimRegister.claims.find(claim => claim.claimId === coverage.copyPolicy.allowedProgressClaimId);
    if (!allowedClaim || !allowedClaim.approvedWording) errors.push('allowed progress wording claim is unavailable');
    for (const claim of structured.documents.claimRegister.claims) {
      if (coverage.copyPolicy.prohibitedClaims.includes(claim.approvedWording)) errors.push(`${claim.claimId}: approved wording exactly matches a prohibited claim`);
      if (!candidateRequested && claim.claimId === 'UNICEF-CHECKPOINT-001' && claim.status === 'checkpoint-candidate') {
        errors.push('blocked decision cannot retain a checkpoint-candidate UNICEF claim');
      }
    }
  }

  const decision = buildUnicefGoNoGoDecision({ coverage, structuredDocuments: structured.documents });
  errors.push(...schemaErrors('decision', decisionValidator, decision));
  if (checkDecision) {
    const checkedDecision = decisionOverride ?? (fs.existsSync(path.join(rootDir, UNICEF_GO_NO_GO_PATHS.decision))
      ? readJson(rootDir, UNICEF_GO_NO_GO_PATHS.decision)
      : null);
    if (!checkedDecision) errors.push(`checked-in go/no-go decision is missing: ${UNICEF_GO_NO_GO_PATHS.decision}`);
    else {
      errors.push(...schemaErrors('checked decision', decisionValidator, checkedDecision));
      if (!sameJson(checkedDecision, decision)) errors.push('checked-in go/no-go decision is stale or does not match the coverage contract');
    }
  }

  if (release) {
    for (const handoff of structured.documents.externalHandoffs.handoffs) {
      if (!RESOLVED_HANDOFF_STATUSES.has(handoff.status)) blockers.push(`external handoff ${handoff.handoffId} is ${handoff.status}`);
    }
    if (coverage.decision.state !== 'checkpoint-candidate' || !coverage.decision.checkpointCandidate) blockers.push('program decision is not checkpoint-candidate');
  }

  const uniqueErrors = [...new Set(errors)];
  const uniqueBlockers = [...new Set(blockers)];
  return {
    ok: uniqueErrors.length === 0 && (!release || uniqueBlockers.length === 0),
    structurallyValid: uniqueErrors.length === 0,
    release,
    errors: uniqueErrors,
    blockers: uniqueBlockers,
    coverage,
    decision,
    structuredDocuments: structured.documents,
  };
}

export function serializeUnicefGoNoGoDecision(decision) {
  return `${JSON.stringify(decision, null, 2)}\n`;
}
