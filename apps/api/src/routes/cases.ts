import { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { env } from '../config/env.js';
import { decodePartnerKey } from '../config/partnerKey.js';
import { parseTrustedProxyCidrs, partnerRealmRefusal } from '../config/partnerNetwork.js';
import {
  getEnabledConsentVersion,
  getRetentionPolicy,
  isConsentPurposeEnabled,
  isPrivacyCapabilityEnabled,
  loadPrivacyControls,
} from '../config/privacyControls.js';
import { buildLifecyclePayload, createCaseSchema, HURIA_PACKET_CONSENT_VERSION, type CaseWorkflow, type PartnerRoutingInput } from '../contracts/caseContracts.js';
import { badRequest, conflict, notFound, serviceUnavailable } from '../http/errors.js';
import { isApprovedIngestionRetention } from '../services/caseSubmissionFeature.js';
import { getAuth, requireAuth } from '../middleware/auth.js';
import {
  type AttachmentRow,
  type CasePartnerRouting,
  CaseSubmissionConflictError,
  type SharedEvidenceEntry,
  PartnerRoutingRejectedError,
  type PartnerRoutingRejection,
  completeAttachment,
  createPendingAttachment,
  getCase,
  listAttachments,
  listCaseEvents,
  listCases,
  submitCaseTransaction,
} from '../repositories/caseRepository.js';
import { auditEvent } from '../services/auditService.js';
import { isApprovedScannerReady } from '../services/clamav/scannerHealth.js';
import { kickEvidenceScanWorker } from '../services/evidenceMalwareScan.js';
import { deriveCallbackSealKey, sealPartnerCallback } from '../services/partnerCallbackSeal.js';
import { getEvidenceCompletionStatus, MAX_EVIDENCE_SIZE_BYTES } from '../services/evidenceUploadPolicy.js';
import { buildSafeEvidenceMetadata, getEvidenceProcessingErrors } from '../services/evidenceMetadata.js';
import { getEvidenceDownloadDecision } from '../services/evidenceQuarantine.js';
import {
  buildEvidenceObjectKey,
  createPresignedDownloadUrl,
  createPresignedUploadPolicy,
  deleteEvidenceObject,
  hashStoredObject,
} from '../storage/evidenceStorage.js';
import { uploadCounter } from '../plugins/metrics.js';

const evidenceRequestSchema = z.object({
  fileName: z.string().min(1).max(180),
  mimeType: z.string().min(1).max(120),
  sizeBytes: z.number().int().positive().max(MAX_EVIDENCE_SIZE_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i),
  retentionPolicyId: z.string().regex(/^[a-z0-9-]+$/),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

type PublicAttachmentRow = Pick<
  AttachmentRow,
  'id' | 'case_id' | 'mime_type' | 'size_bytes' | 'metadata' | 'created_at' | 'status' |
  'antivirus_status' | 'quarantine_status' | 'retention_policy_id'
>;

function toPublicAttachment(row: AttachmentRow): PublicAttachmentRow {
  return {
    id: row.id,
    case_id: row.case_id,
    mime_type: row.mime_type,
    size_bytes: row.size_bytes,
    metadata: buildSafeEvidenceMetadata(row.metadata, row.mime_type ?? 'application/octet-stream'),
    created_at: row.created_at,
    status: row.status,
    antivirus_status: row.antivirus_status,
    quarantine_status: row.quarantine_status,
    retention_policy_id: row.retention_policy_id,
  };
}

/**
 * `details.reason` on 503s from POST /api/cases, so the app can tell them
 * apart:
 * - `partner_unavailable`: send to SafeRide only instead. The partner
 *   realm or its key, partner_follow_up (or its version for this partner),
 *   or the partner's intake is off.
 * - `partner_callback_unavailable`: the partner can take the report but a
 *   callback number cannot be shared (partner_callback, its version for
 *   this partner, or PARTNER_CALLBACK_KEY is off). Resend to the partner
 *   without the callback and tell the survivor their number was not shared.
 * - the others: SafeRide itself cannot take the report.
 */
export const CASE_UNAVAILABLE_REASONS = {
  privacyControls: 'privacy_controls_unavailable',
  caseIngestion: 'case_ingestion_disabled',
  pathwayConsent: 'pathway_consent_disabled',
  partner: 'partner_unavailable',
  partnerCallback: 'partner_callback_unavailable',
} as const;

function partnerUnavailable(message: string) {
  return serviceUnavailable(message, { reason: CASE_UNAVAILABLE_REASONS.partner });
}

function partnerCallbackUnavailable(message: string) {
  return serviceUnavailable(message, { reason: CASE_UNAVAILABLE_REASONS.partnerCallback });
}

function requirePrivacyPolicyVersion(): string {
  try {
    return loadPrivacyControls().controlVersion;
  } catch {
    throw serviceUnavailable('Privacy controls are unavailable', { reason: CASE_UNAVAILABLE_REASONS.privacyControls });
  }
}

function requireSubmittedCaseIngestion(): void {
  if (!isPrivacyCapabilityEnabled('submitted_case_ingestion')) {
    throw serviceUnavailable('Submitted-case ingestion is disabled pending privacy and legal approval', {
      handoffId: 'HANDOFF-PRIVACY-LEGAL-REVIEW',
      reason: CASE_UNAVAILABLE_REASONS.caseIngestion,
    });
  }
}

const PARTNER_ROUTING_REJECTIONS: Record<PartnerRoutingRejection, string> = {
  partner_not_accepting: 'This partner is not accepting referrals right now',
  partner_consent_missing: 'Sharing with this partner needs a granted partner_follow_up consent for this report',
  callback_consent_missing: 'Sharing a callback number needs a granted partner_callback consent for this report',
};

/**
 * The evidence a partner may ever be shown, fixed now from the packet the
 * survivor consented to: escalations list their manifest (with each file's
 * sha256 when the packet carries it); referrals share no evidence.
 */
export function sharedEvidenceFromWorkflow(workflow: CaseWorkflow): SharedEvidenceEntry[] {
  if (workflow.workflowType !== 'submitted-case') return [];
  return workflow.submission.packet.evidenceManifest.map((item, index) => ({
    manifestIndex: index,
    mediaType: item.type,
    sha256: item.checksum ? item.checksum.toLowerCase() : null,
  }));
}

// The synthetic org exists only where P1's seed may run.
const SYNTHETIC_PARTNER_STABLE_ID = 'test-partner';
const SYNTHETIC_PARTNER_ENVIRONMENTS = new Set(['development', 'test']);

/**
 * consent_records has no partner column, so a consent is bound to its
 * partner by its version, which must name the partner:
 * `partner-follow-up.<stableId>.v<n>` / `partner-callback.<stableId>.v<n>`
 * (design section 1.2). The controls enable one version per purpose, so
 * only that partner can receive routed cases, and the consent record's own
 * version (checked in the routing transaction) proves which partner the
 * survivor agreed to.
 */
export function consentVersionNamesPartner(version: string, purposePrefix: 'partner-follow-up' | 'partner-callback', partnerStableId: string): boolean {
  const escaped = partnerStableId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${purposePrefix}\\.${escaped}\\.v\\d+$`).test(version);
}

/**
 * Turns the survivor's explicit partner choice into a routing request, or
 * fails closed (503) while the partner realm, either consent purpose or
 * (for a callback) PARTNER_CALLBACK_KEY is off. The callback number is only
 * ever handled sealed from here on.
 */
function preparePartnerRouting(input: PartnerRoutingInput, workflow: CaseWorkflow): CasePartnerRouting {
  const partnerKey = decodePartnerKey(env.partnerTotpKey);
  // The same rule as the realm itself (server.ts): never route a case to a
  // partner whose dashboard the API refuses to serve.
  const realmRefused = partnerRealmRefusal({
    publicOrigin: env.partnerPublicOrigin,
    totpKey: partnerKey,
    trustedProxies: parseTrustedProxyCidrs(env.partnerTrustedProxyCidrs),
  });
  if (!env.partnerPublicOrigin || !partnerKey || realmRefused) {
    throw partnerUnavailable('Partner routing is not available');
  }
  if (input.partnerStableId === SYNTHETIC_PARTNER_STABLE_ID && !SYNTHETIC_PARTNER_ENVIRONMENTS.has(env.appEnvironment)) {
    throw partnerUnavailable(PARTNER_ROUTING_REJECTIONS.partner_not_accepting);
  }
  const consentVersion = getEnabledConsentVersion('partner_follow_up');
  if (!consentVersion) throw partnerUnavailable('Partner follow-up consent is not enabled');
  if (!consentVersionNamesPartner(consentVersion, 'partner-follow-up', input.partnerStableId)) {
    throw partnerUnavailable('Partner follow-up consent is not enabled for this partner');
  }
  if (workflow.workflowType === 'referral' && workflow.partnerPacket && consentVersion !== HURIA_PACKET_CONSENT_VERSION) {
    throw conflict(PARTNER_ROUTING_REJECTIONS.partner_consent_missing, { reason: 'partner_consent_missing' });
  }
  const routing: CasePartnerRouting = {
    partnerStableId: input.partnerStableId,
    consentRecordId: input.consentRecordId,
    consentVersion,
    sharedEvidence: sharedEvidenceFromWorkflow(workflow),
  };
  if (input.callback) {
    const callbackVersion = getEnabledConsentVersion('partner_callback');
    if (!callbackVersion) throw partnerCallbackUnavailable('Partner callback consent is not enabled');
    if (!consentVersionNamesPartner(callbackVersion, 'partner-callback', input.partnerStableId)) {
      throw partnerCallbackUnavailable('Partner callback consent is not enabled for this partner');
    }
    const callbackKey = decodePartnerKey(env.partnerCallbackKey);
    if (!callbackKey) throw partnerCallbackUnavailable('Partner callback numbers are not available');
    const sealKey = deriveCallbackSealKey(callbackKey);
    const phoneNumber = input.callback.phoneNumber;
    routing.callback = {
      consentRecordId: input.callback.consentRecordId,
      consentVersion: callbackVersion,
      seal: referralId => sealPartnerCallback(sealKey, referralId, phoneNumber),
    };
  }
  return routing;
}

type ServerRetentionPolicy = NonNullable<ReturnType<typeof getRetentionPolicy>>;

function requireEvidenceIngestionPrerequisites(retentionPolicyId: string | null): {
  policyVersion: string;
  retentionPolicy: ServerRetentionPolicy;
} {
  requireSubmittedCaseIngestion();
  if (!isPrivacyCapabilityEnabled('server_retention_execution')) {
    throw serviceUnavailable('Evidence ingestion is disabled pending server retention approval', {
      handoffId: 'HANDOFF-PRIVACY-LEGAL-REVIEW',
    });
  }
  if (!retentionPolicyId) {
    throw serviceUnavailable('Evidence ingestion is disabled without an approved retention policy', {
      handoffId: 'HANDOFF-PRIVACY-LEGAL-REVIEW',
    });
  }

  let controls: ReturnType<typeof loadPrivacyControls>;
  let retentionPolicy: ReturnType<typeof getRetentionPolicy>;
  try {
    controls = loadPrivacyControls();
    retentionPolicy = getRetentionPolicy(retentionPolicyId, 'server');
  } catch {
    throw serviceUnavailable('Privacy controls are unavailable');
  }

  const scanPolicy = controls.malwareScanPolicy;
  const now = Date.now();
  if (
    scanPolicy.status !== 'enabled' ||
    !scanPolicy.approvalId ||
    !scanPolicy.scanner ||
    !scanPolicy.definitionVersion ||
    !scanPolicy.validFrom ||
    !scanPolicy.validUntil ||
    now < new Date(scanPolicy.validFrom).getTime() ||
    now >= new Date(scanPolicy.validUntil).getTime() ||
    // clamd answered recently as the scanner the policy names, with signatures it accepts.
    !isApprovedScannerReady(scanPolicy, now)
  ) {
    throw serviceUnavailable('Evidence ingestion is disabled pending a current approved malware scanner', {
      handoffId: 'HANDOFF-SECURITY-SCAN-APPROVAL',
    });
  }

  if (!retentionPolicy || retentionPolicy.approvalStatus === 'retired') {
    throw badRequest('Unknown or retired retention policy');
  }
  if (!isApprovedIngestionRetention(retentionPolicy, controls)) {
    throw serviceUnavailable('Evidence ingestion is disabled pending retention policy approval', {
      handoffId: 'HANDOFF-PRIVACY-LEGAL-REVIEW',
    });
  }

  return { policyVersion: controls.controlVersion, retentionPolicy };
}

export async function registerCaseRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/cases', { preHandler: requireAuth }, async request => {
    const auth = getAuth(request);
    return { cases: await listCases(auth.userId) };
  });

  app.post('/api/cases', { preHandler: requireAuth }, async request => {
    const auth = getAuth(request);
    const parsed = createCaseSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('Invalid case payload', parsed.error.flatten());
    requireSubmittedCaseIngestion();
    const policyVersion = requirePrivacyPolicyVersion();
    if (!isConsentPurposeEnabled(parsed.data.pathwayConsent.purpose, parsed.data.pathwayConsent.version)) {
      throw serviceUnavailable('Pathway submission consent is not enabled for this version', {
        reason: CASE_UNAVAILABLE_REASONS.pathwayConsent,
      });
    }
    const partnerRouting = parsed.data.partnerRouting
      ? preparePartnerRouting(parsed.data.partnerRouting, parsed.data.workflow)
      : undefined;

    let submission;
    try {
      submission = await submitCaseTransaction({
        ownerId: auth.userId,
        draftId: parsed.data.draftId,
        pathway: parsed.data.workflow.workflowType === 'referral' ? 'referral' : 'escalate',
        summary: {
          schemaVersion: '1.0',
          pathwayConsent: {
            recordId: parsed.data.pathwayConsent.recordId,
            purpose: parsed.data.pathwayConsent.purpose,
            version: parsed.data.pathwayConsent.version,
          },
          workflow: parsed.data.workflow,
          // Binds a retry to the same partner choice; the callback number is never stored here.
          ...(parsed.data.partnerRouting ? {
            partnerRouting: {
              partnerStableId: parsed.data.partnerRouting.partnerStableId,
              consentRecordId: parsed.data.partnerRouting.consentRecordId,
              callbackConsentRecordId: parsed.data.partnerRouting.callback?.consentRecordId ?? null,
            },
          } : {}),
        },
        lifecyclePayload: buildLifecyclePayload(parsed.data.workflow),
        consentRecordId: parsed.data.pathwayConsent.recordId,
        consentPurpose: parsed.data.pathwayConsent.purpose,
        consentVersion: parsed.data.pathwayConsent.version,
        idempotencyKey: parsed.data.idempotencyKey,
        requestId: request.id,
        policyVersion,
        partnerRouting,
      });
    } catch (error) {
      if (error instanceof CaseSubmissionConflictError) {
        throw conflict('Case submission idempotency or consent record conflicts with an existing submission');
      }
      if (error instanceof PartnerRoutingRejectedError) {
        // Intake off (or lapsed mid-request) is the partner being unavailable; consent problems stay 409.
        if (error.reason === 'partner_not_accepting') throw partnerUnavailable(PARTNER_ROUTING_REJECTIONS.partner_not_accepting);
        throw conflict(PARTNER_ROUTING_REJECTIONS[error.reason], { reason: error.reason });
      }
      throw error;
    }

    return submission.partnerReferral
      ? { case: submission.caseRecord, partnerReferral: submission.partnerReferral }
      : { case: submission.caseRecord };
  });

  app.get('/api/cases/:id', { preHandler: requireAuth }, async request => {
    const auth = getAuth(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const caseRecord = await getCase(auth.userId, params.id);
    if (!caseRecord) throw notFound('Case not found');
    requireSubmittedCaseIngestion();
    const attachments = await listAttachments(auth.userId, params.id);
    // Explicit projection: survivor-facing events never carry a request id or other internal columns.
    const events = (await listCaseEvents(auth.userId, params.id)).map(event => ({
      id: event.id,
      case_id: event.case_id,
      owner_id: event.owner_id,
      event_type: event.event_type,
      payload: event.payload,
      created_at: event.created_at,
    }));
    return { case: caseRecord, attachments: attachments.map(toPublicAttachment), events };
  });

  app.post('/api/cases/:id/deletion-request', { preHandler: requireAuth }, async request => {
    const auth = getAuth(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const caseRecord = await getCase(auth.userId, params.id);
    if (!caseRecord) throw notFound('Case not found');
    const policyVersion = requirePrivacyPolicyVersion();

    await auditEvent({
      action: 'case.deletion_request',
      resourceClass: 'rights_request',
      requestId: request.id,
      outcome: 'denied',
      policyVersion,
    });
    throw serviceUnavailable('Submitted-case deletion intake is pending legal approval', {
      handoffId: 'HANDOFF-PRIVACY-LEGAL-REVIEW',
      replacementEndpoint: '/api/privacy/dsar',
    });
  });

  app.post('/api/cases/:id/evidence', { preHandler: requireAuth }, async request => {
    const auth = getAuth(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const parsed = evidenceRequestSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('Invalid evidence payload', parsed.error.flatten());
    const { policyVersion, retentionPolicy } = requireEvidenceIngestionPrerequisites(parsed.data.retentionPolicyId);

    const caseRecord = await getCase(auth.userId, params.id);
    if (!caseRecord) throw notFound('Case not found');

    const metadata = buildSafeEvidenceMetadata(parsed.data.metadata, parsed.data.mimeType);
    const processingErrors = getEvidenceProcessingErrors(parsed.data.metadata, {
      allowProcessedClaims: isPrivacyCapabilityEnabled('evidence_transform_processing'),
    });
    if (processingErrors.length > 0) {
      throw badRequest('Evidence processing claims are incomplete', { errors: processingErrors });
    }
    const objectKey = buildEvidenceObjectKey();
    const expiresInSeconds = 300;
    const uploadPolicy = await createPresignedUploadPolicy({
      objectKey,
      expirySeconds: expiresInSeconds,
      mimeType: parsed.data.mimeType,
      maxSizeBytes: MAX_EVIDENCE_SIZE_BYTES,
    });

    const attachment = await createPendingAttachment({
      ownerId: auth.userId,
      caseId: params.id,
      draftId: null,
      bucket: env.s3Bucket,
      objectKey,
      mimeType: parsed.data.mimeType,
      sizeBytes: parsed.data.sizeBytes,
      expectedSha256: parsed.data.sha256,
      uploadManifest: {
        displayName: metadata.displayName,
        mimeType: parsed.data.mimeType,
        sizeBytes: parsed.data.sizeBytes,
        expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
      },
      retentionPolicyId: retentionPolicy.policyId,
      metadata,
    });

    uploadCounter.labels('signed').inc();

    await auditEvent({
      action: 'evidence.signed_upload',
      resourceClass: 'attachment',
      requestId: request.id,
      outcome: 'success',
      policyVersion,
    });

    return {
      attachment: toPublicAttachment(attachment),
      upload: {
        method: 'POST',
        url: uploadPolicy.url,
        expiresInSeconds,
        fields: uploadPolicy.fields,
      },
    };
  });

  app.post('/api/cases/:caseId/evidence/:attachmentId/complete', { preHandler: requireAuth }, async request => {
    const auth = getAuth(request);
    const params = z.object({ caseId: z.string().uuid(), attachmentId: z.string().uuid() }).parse(request.params);
    const attachments = await listAttachments(auth.userId, params.caseId);
    const attachment = attachments.find(item => item.id === params.attachmentId);
    if (!attachment) throw notFound('Attachment not found');
    const { policyVersion } = requireEvidenceIngestionPrerequisites(attachment.retention_policy_id);

    const hashed = await hashStoredObject(attachment.bucket_path);
    const status = getEvidenceCompletionStatus({
      declaredSizeBytes: attachment.size_bytes,
      actualSizeBytes: hashed.sizeBytes,
      expectedSha256: attachment.expected_sha256,
      actualSha256: hashed.sha256,
    });

    if (status !== 'uploaded') {
      await deleteEvidenceObject(attachment.bucket_path);
    }

    const completed = await completeAttachment({
      ownerId: auth.userId,
      attachmentId: params.attachmentId,
      sha256: hashed.sha256,
      sizeBytes: hashed.sizeBytes,
      status,
    });

    if (!completed) throw notFound('Attachment not found');

    uploadCounter.labels(status).inc();
    // The scan runs in the background worker; the attachment stays quarantined until it ends.
    if (status === 'uploaded') kickEvidenceScanWorker();

    await auditEvent({
      action: 'evidence.complete_upload',
      resourceClass: 'attachment',
      requestId: request.id,
      outcome: status === 'uploaded' ? 'success' : 'failed',
      policyVersion,
    });

    return { attachment: toPublicAttachment(completed) };
  });

  app.get('/api/cases/:caseId/evidence/:attachmentId/download', { preHandler: requireAuth }, async request => {
    const auth = getAuth(request);
    const params = z.object({ caseId: z.string().uuid(), attachmentId: z.string().uuid() }).parse(request.params);
    const policyVersion = requirePrivacyPolicyVersion();
    const attachments = await listAttachments(auth.userId, params.caseId);
    const attachment = attachments.find(item => item.id === params.attachmentId);
    if (!attachment) throw notFound('Attachment not found');

    const downloadDecision = getEvidenceDownloadDecision(attachment);
    if (!downloadDecision.allowed) {
      await auditEvent({
        action: 'evidence.signed_download',
        resourceClass: 'attachment',
        requestId: request.id,
        outcome: 'denied',
        policyVersion,
      });
      throw conflict('Evidence is not available for download', { reason: downloadDecision.reason });
    }

    const expiresInSeconds = 60;
    const url = await createPresignedDownloadUrl({
      objectKey: attachment.bucket_path,
      expirySeconds: expiresInSeconds,
    });

    await auditEvent({
      action: 'evidence.signed_download',
      resourceClass: 'attachment',
      requestId: request.id,
      outcome: 'success',
      policyVersion,
    });

    return { url, expiresInSeconds };
  });
}
