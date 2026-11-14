import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

import { AppError } from '../../http/errors.js';
import { registerCaseRoutes } from '../cases.js';

const authState = vi.hoisted(() => ({
  userId: 'owner-user',
}));

const caseRepository = vi.hoisted(() => ({
  CaseSubmissionConflictError: class CaseSubmissionConflictError extends Error {},
  completeAttachment: vi.fn(),
  createCase: vi.fn(),
  createCaseEvent: vi.fn(),
  createPendingAttachment: vi.fn(),
  deleteCase: vi.fn(),
  getCase: vi.fn(),
  listAttachments: vi.fn(),
  listCaseEvents: vi.fn(),
  listCases: vi.fn(),
  markDraftSubmitted: vi.fn(),
  submitCaseTransaction: vi.fn(),
}));

const auditService = vi.hoisted(() => ({
  auditEvent: vi.fn(),
}));

const evidenceStorage = vi.hoisted(() => ({
  buildEvidenceObjectKey: vi.fn(() => 'evidence/test/object'),
  createPresignedDownloadUrl: vi.fn(),
  createPresignedUploadPolicy: vi.fn(),
  deleteEvidenceObject: vi.fn(),
  hashStoredObject: vi.fn(),
}));

const metrics = vi.hoisted(() => ({
  uploadCounter: {
    labels: vi.fn(() => ({ inc: vi.fn() })),
  },
}));

const privacyState = vi.hoisted(() => ({
  submittedCaseIngestionEnabled: true,
  serverRetentionExecutionEnabled: true,
  malwareScanEnabled: true,
  retentionExecutionEnabled: true,
  retentionApprovalStatus: 'approved_legal',
  scannerReady: true,
}));

const scanWorker = vi.hoisted(() => ({ kickEvidenceScanWorker: vi.fn() }));

function routeError(statusCode: number, code: string, message: string): Error & { statusCode: number; code: string } {
  return Object.assign(new Error(message), {
    name: 'AppError',
    statusCode,
    code,
  });
}

vi.mock('../../config/env.js', () => ({
  env: {
    s3Bucket: 'test-evidence',
  },
}));

vi.mock('../../middleware/auth.js', () => ({
  requireAuth: vi.fn(async (request: FastifyRequest) => {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith('Bearer ')) {
      throw routeError(401, 'unauthorized', 'Authentication required');
    }
  }),
  getAuth: vi.fn(() => ({ userId: authState.userId })),
}));

vi.mock('../../repositories/caseRepository.js', () => caseRepository);
vi.mock('../../services/auditService.js', () => auditService);
vi.mock('../../storage/evidenceStorage.js', () => evidenceStorage);
vi.mock('../../plugins/metrics.js', () => metrics);
vi.mock('../../services/evidenceMalwareScan.js', () => scanWorker);
// clamd health (cached by the API's monitor): a switch here.
vi.mock('../../services/clamav/scannerHealth.js', () => ({
  isApprovedScannerReady: vi.fn((policy: { status: string }) => privacyState.scannerReady && policy.status === 'enabled'),
}));
vi.mock('../../config/privacyControls.js', () => ({
  getRetentionPolicy: vi.fn((policyId: string, scope?: string) =>
    policyId === 'submitted-case-pending-legal-v1' && (!scope || scope === 'server')
      ? {
          policyId,
          scope: 'server',
          approvalStatus: privacyState.retentionApprovalStatus,
          executionEnabled: privacyState.retentionExecutionEnabled,
        }
      : null),
  isConsentPurposeEnabled: vi.fn(() => true),
  isPrivacyCapabilityEnabled: vi.fn((capability: string) => {
    if (capability === 'submitted_case_ingestion') return privacyState.submittedCaseIngestionEnabled;
    if (capability === 'server_retention_execution') return privacyState.serverRetentionExecutionEnabled;
    return false;
  }),
  loadPrivacyControls: vi.fn(() => ({
    controlVersion: 'privacy-controls.2026-07-30.2',
    malwareScanPolicy: privacyState.malwareScanEnabled
      ? {
          status: 'enabled',
          approvalId: 'synthetic-security-approval',
          scanner: 'synthetic-scanner',
          definitionVersion: 'synthetic-definition-v1',
          validFrom: '2026-01-01T00:00:00.000Z',
          validUntil: '2099-01-01T00:00:00.000Z',
          reason: null,
        }
      : {
          status: 'disabled',
          approvalId: null,
          scanner: null,
          definitionVersion: null,
          validFrom: null,
          validUntil: null,
          reason: 'pending_scanner_and_security_approval',
        },
  })),
}));

const CASE_ID = '11111111-1111-4111-8111-111111111111';
const NOW = '2026-06-09T12:00:00.000Z';

async function buildRouteApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    genReqId: () => 'req-test-1',
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError || 'statusCode' in error) {
      const appError = error as AppError;
      reply.status(appError.statusCode).send({
        code: appError.code,
        message: appError.message,
        details: appError.details,
        requestId: request.id,
      });
      return;
    }

    if (error instanceof ZodError) {
      reply.status(400).send({
        code: 'bad_request',
        message: 'Invalid request',
        details: error.flatten(),
        requestId: request.id,
      });
      return;
    }

    reply.status(500).send({
      code: 'internal_error',
      message: 'Internal server error',
      requestId: request.id,
    });
  });

  await registerCaseRoutes(app);
  return app;
}

describe('case deletion request route', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    authState.userId = 'owner-user';
    privacyState.submittedCaseIngestionEnabled = true;
    privacyState.serverRetentionExecutionEnabled = true;
    privacyState.malwareScanEnabled = true;
    privacyState.retentionExecutionEnabled = true;
    privacyState.retentionApprovalStatus = 'approved_legal';
    privacyState.scannerReady = true;
    app = await buildRouteApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('rejects unauthenticated deletion requests before touching case data', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/cases/${CASE_ID}/deletion-request`,
    });

    expect(response.statusCode).toBe(401);
    expect(caseRepository.getCase).not.toHaveBeenCalled();
    expect(caseRepository.createCaseEvent).not.toHaveBeenCalled();
    expect(auditService.auditEvent).not.toHaveBeenCalled();
  });

  it('returns not found for non-owned cases without writing events or audit records', async () => {
    caseRepository.getCase.mockResolvedValueOnce(null);

    const response = await app.inject({
      method: 'POST',
      url: `/api/cases/${CASE_ID}/deletion-request`,
      headers: { authorization: 'Bearer test-token' },
    });

    expect(response.statusCode).toBe(404);
    expect(caseRepository.getCase).toHaveBeenCalledWith('owner-user', CASE_ID);
    expect(caseRepository.createCaseEvent).not.toHaveBeenCalled();
    expect(auditService.auditEvent).not.toHaveBeenCalled();
  });

  it('fails closed without legal approval and writes only a coarse denied audit event', async () => {
    caseRepository.getCase.mockResolvedValueOnce({
      id: CASE_ID,
      owner_id: 'owner-user',
      draft_id: 'draft-1',
      pathway: 'support',
      status: 'submitted',
      summary: null,
      created_at: NOW,
      updated_at: NOW,
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/cases/${CASE_ID}/deletion-request`,
      headers: { authorization: 'Bearer test-token' },
    });

    expect(response.statusCode).toBe(503);
    expect(caseRepository.createCaseEvent).not.toHaveBeenCalled();
    expect(auditService.auditEvent).toHaveBeenCalledWith({
      action: 'case.deletion_request',
      resourceClass: 'rights_request',
      requestId: 'req-test-1',
      outcome: 'denied',
      policyVersion: 'privacy-controls.2026-07-30.2',
    });
    expect(response.json()).toMatchObject({
      code: 'service_unavailable',
      details: {
        handoffId: 'HANDOFF-PRIVACY-LEGAL-REVIEW',
      },
    });
  });

  it('does not physically delete case rows, attachments, or evidence objects', async () => {
    caseRepository.getCase.mockResolvedValueOnce({
      id: CASE_ID,
      owner_id: 'owner-user',
      draft_id: null,
      pathway: 'support',
      status: 'submitted',
      summary: null,
      created_at: NOW,
      updated_at: NOW,
    });
    caseRepository.createCaseEvent.mockResolvedValueOnce({
      id: '22222222-2222-4222-8222-222222222222',
      case_id: CASE_ID,
      owner_id: 'owner-user',
      event_type: 'deletion_requested',
      payload: null,
      request_id: 'req-test-1',
      created_at: NOW,
    });

    await app.inject({
      method: 'POST',
      url: `/api/cases/${CASE_ID}/deletion-request`,
      headers: { authorization: 'Bearer test-token' },
    });

    expect(caseRepository.deleteCase).not.toHaveBeenCalled();
    expect(caseRepository.listAttachments).not.toHaveBeenCalled();
    expect(caseRepository.completeAttachment).not.toHaveBeenCalled();
    expect(evidenceStorage.deleteEvidenceObject).not.toHaveBeenCalled();
  });

  it('rejects legacy generic case summaries before any repository write', async () => {
    const response = await app.inject({
      method: 'POST', url: '/api/cases', headers: { authorization: 'Bearer test-token' },
      payload: { draftId: 'draft-1', pathway: 'referral', summary: { narrative: 'synthetic' } },
    });
    expect(response.statusCode).toBe(400);
    expect(caseRepository.createCase).not.toHaveBeenCalled();
  });

  it('blocks new submitted-case ingestion while retention and deletion approval is pending', async () => {
    privacyState.submittedCaseIngestionEnabled = false;
    const response = await app.inject({
      method: 'POST',
      url: '/api/cases',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        idempotencyKey: CASE_ID,
        draftId: 'draft-1',
        pathwayConsent: {
          recordId: CASE_ID,
          purpose: 'pathway_submission',
          version: 'pathway-consent.v1',
        },
        workflow: {
          schemaVersion: '1.0',
          workflowType: 'referral',
          providerId: 'provider-1',
          channel: 'call',
          supportBrief: { included: false, selectedFields: [] },
        },
      },
    });

    expect(response.statusCode).toBe(503);
    expect(caseRepository.createCase).not.toHaveBeenCalled();
    expect(caseRepository.createCaseEvent).not.toHaveBeenCalled();
  });

  it('stores a schema-valid referral but keeps lifecycle and audit records content-free', async () => {
    const workflow = {
      schemaVersion: '1.0', workflowType: 'referral', providerId: 'provider-1', channel: 'call',
      supportBrief: { included: false, selectedFields: [] },
    };
    caseRepository.submitCaseTransaction.mockResolvedValueOnce({
      caseRecord: {
        id: CASE_ID, owner_id: 'owner-user', draft_id: 'draft-1', pathway: 'referral', status: 'submitted',
        summary: workflow, created_at: NOW, updated_at: NOW,
      },
      partnerReferral: null,
    });

    const response = await app.inject({
      method: 'POST', url: '/api/cases', headers: { authorization: 'Bearer test-token' },
      payload: {
        idempotencyKey: CASE_ID,
        draftId: 'draft-1',
        pathwayConsent: { recordId: CASE_ID, purpose: 'pathway_submission', version: 'pathway-consent.v1' },
        workflow,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ case: expect.objectContaining({ id: CASE_ID }) });
    expect(caseRepository.submitCaseTransaction).toHaveBeenCalledWith(expect.objectContaining({
      ownerId: 'owner-user', draftId: 'draft-1', pathway: 'referral',
      consentRecordId: CASE_ID,
      idempotencyKey: CASE_ID,
      summary: expect.objectContaining({ schemaVersion: '1.0', workflow }),
      lifecyclePayload: { schemaVersion: '1.0', workflowType: 'referral', status: 'submitted' },
      requestId: 'req-test-1',
      policyVersion: 'privacy-controls.2026-07-30.2',
    }));
    expect(auditService.auditEvent).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'case.create' }));
  });

  it('rejects arbitrary retention and incomplete processed evidence before signing upload', async () => {
    caseRepository.getCase.mockResolvedValue({ id: CASE_ID, owner_id: 'owner-user' });
    const arbitrary = await app.inject({
      method: 'POST', url: `/api/cases/${CASE_ID}/evidence`, headers: { authorization: 'Bearer test-token' },
      payload: { fileName: 'evidence-photo.jpg', mimeType: 'image/jpeg', sizeBytes: 12, retention: { forever: true } },
    });
    expect(arbitrary.statusCode).toBe(400);
    const incomplete = await app.inject({
      method: 'POST', url: `/api/cases/${CASE_ID}/evidence`, headers: { authorization: 'Bearer test-token' },
      payload: {
        fileName: 'evidence-photo.jpg', mimeType: 'image/jpeg', sizeBytes: 12,
        sha256: 'a'.repeat(64),
        retentionPolicyId: 'submitted-case-pending-legal-v1',
        metadata: { privacyStatus: { faceBlur: { status: 'processed' } } },
      },
    });
    expect(incomplete.statusCode).toBe(400);
    expect(evidenceStorage.createPresignedUploadPolicy).not.toHaveBeenCalled();
    expect(caseRepository.createPendingAttachment).not.toHaveBeenCalled();
  });

  it.each([
    ['submitted-case ingestion', () => { privacyState.submittedCaseIngestionEnabled = false; }],
    ['server retention execution', () => { privacyState.serverRetentionExecutionEnabled = false; }],
    ['approved malware scanning', () => { privacyState.malwareScanEnabled = false; }],
    ['a healthy approved scanner (clamd)', () => { privacyState.scannerReady = false; }],
    ['retention policy execution', () => { privacyState.retentionExecutionEnabled = false; }],
    ['legal retention approval', () => { privacyState.retentionApprovalStatus = 'pending_legal'; }],
  ])('does not issue upload credentials when %s is unavailable', async (_gate, disableGate) => {
    disableGate();
    caseRepository.getCase.mockResolvedValue({ id: CASE_ID, owner_id: 'owner-user' });

    const response = await app.inject({
      method: 'POST', url: `/api/cases/${CASE_ID}/evidence`, headers: { authorization: 'Bearer test-token' },
      payload: {
        fileName: 'evidence-photo.jpg', mimeType: 'image/jpeg', sizeBytes: 12,
        sha256: 'a'.repeat(64), retentionPolicyId: 'submitted-case-pending-legal-v1',
      },
    });

    expect(response.statusCode).toBe(503);
    expect(evidenceStorage.createPresignedUploadPolicy).not.toHaveBeenCalled();
    expect(caseRepository.createPendingAttachment).not.toHaveBeenCalled();
  });

  it('signs a quarantined upload only when ingestion, retention, and scanning are approved', async () => {
    caseRepository.getCase.mockResolvedValue({ id: CASE_ID, owner_id: 'owner-user' });
    evidenceStorage.createPresignedUploadPolicy.mockResolvedValue({
      url: 'https://upload.invalid/synthetic',
      fields: { policy: 'signed-policy' },
    });
    caseRepository.createPendingAttachment.mockResolvedValue({
      id: '22222222-2222-4222-8222-222222222222', owner_id: 'owner-user', draft_id: null, case_id: CASE_ID,
      bucket: 'test-evidence', bucket_path: 'evidence/test/object', mime_type: 'image/jpeg', size_bytes: 12,
      sha256: null, expected_sha256: 'a'.repeat(64), upload_manifest: {}, retention: {},
      retention_policy_id: 'submitted-case-pending-legal-v1', antivirus_status: 'not_scanned',
      quarantine_status: 'quarantined', scan_evidence: null, status: 'pending_upload',
      metadata: { privacyStatus: {} }, created_at: NOW, updated_at: NOW,
    });
    const response = await app.inject({
      method: 'POST', url: `/api/cases/${CASE_ID}/evidence`, headers: { authorization: 'Bearer test-token' },
      payload: {
        fileName: 'evidence-photo.jpg', mimeType: 'image/jpeg', sizeBytes: 12,
        sha256: 'a'.repeat(64), retentionPolicyId: 'submitted-case-pending-legal-v1',
        metadata: {
          displayName: 'evidence-photo.jpg', mediaType: 'photo',
          privacyStatus: {
            faceBlur: { status: 'not_requested' },
            metadataRemoval: { status: 'not_requested' },
            fileEncryption: { status: 'not_requested' },
          },
        },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(caseRepository.createPendingAttachment).toHaveBeenCalledWith(expect.objectContaining({
      expectedSha256: 'a'.repeat(64),
      retentionPolicyId: 'submitted-case-pending-legal-v1',
    }));
    expect(response.json().attachment).toMatchObject({
      antivirus_status: 'not_scanned', quarantine_status: 'quarantined', status: 'pending_upload',
    });
    expect(response.json().upload).toMatchObject({
      method: 'POST',
      fields: { policy: 'signed-policy' },
    });
  });

  it('rejects and removes an object whose stored size differs from the signed declaration', async () => {
    const attachment = {
      id: '22222222-2222-4222-8222-222222222222', owner_id: 'owner-user', draft_id: null, case_id: CASE_ID,
      bucket: 'test-evidence', bucket_path: 'evidence/test/object', mime_type: 'image/jpeg', size_bytes: 12,
      sha256: null, expected_sha256: 'a'.repeat(64), upload_manifest: {}, retention: {},
      retention_policy_id: 'submitted-case-pending-legal-v1', antivirus_status: 'not_scanned',
      quarantine_status: 'quarantined', scan_evidence: null, status: 'pending_upload',
      metadata: {}, created_at: NOW, updated_at: NOW,
    };
    caseRepository.listAttachments.mockResolvedValueOnce([attachment]);
    evidenceStorage.hashStoredObject.mockResolvedValueOnce({ sha256: 'a'.repeat(64), sizeBytes: 13 });
    caseRepository.completeAttachment.mockResolvedValueOnce({
      ...attachment,
      size_bytes: 13,
      sha256: 'a'.repeat(64),
      status: 'rejected',
      quarantine_status: 'rejected',
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/cases/${CASE_ID}/evidence/${attachment.id}/complete`,
      headers: { authorization: 'Bearer test-token' },
    });

    expect(response.statusCode).toBe(200);
    expect(evidenceStorage.deleteEvidenceObject).toHaveBeenCalledWith('evidence/test/object');
    expect(caseRepository.completeAttachment).toHaveBeenCalledWith(expect.objectContaining({
      sizeBytes: 13,
      status: 'rejected',
    }));
    expect(response.json().attachment).toMatchObject({ status: 'rejected', quarantine_status: 'rejected' });
    expect(scanWorker.kickEvidenceScanWorker).not.toHaveBeenCalled();
  });

  it('completes a matching upload as scan pending and quarantined, and wakes the scan worker without waiting', async () => {
    const attachment = {
      id: '22222222-2222-4222-8222-222222222222', owner_id: 'owner-user', draft_id: null, case_id: CASE_ID,
      bucket: 'test-evidence', bucket_path: 'evidence/test/object', mime_type: 'image/jpeg', size_bytes: 12,
      sha256: null, expected_sha256: 'a'.repeat(64), upload_manifest: {}, retention: {},
      retention_policy_id: 'submitted-case-pending-legal-v1', antivirus_status: 'not_scanned',
      quarantine_status: 'quarantined', scan_evidence: null, status: 'pending_upload',
      metadata: {}, created_at: NOW, updated_at: NOW,
    };
    caseRepository.listAttachments.mockResolvedValueOnce([attachment]);
    evidenceStorage.hashStoredObject.mockResolvedValueOnce({ sha256: 'a'.repeat(64), sizeBytes: 12 });
    caseRepository.completeAttachment.mockResolvedValueOnce({
      ...attachment, sha256: 'a'.repeat(64), status: 'uploaded', antivirus_status: 'pending',
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/cases/${CASE_ID}/evidence/${attachment.id}/complete`,
      headers: { authorization: 'Bearer test-token' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().attachment).toMatchObject({
      status: 'uploaded', antivirus_status: 'pending', quarantine_status: 'quarantined',
    });
    expect(scanWorker.kickEvidenceScanWorker).toHaveBeenCalledTimes(1);
    expect(evidenceStorage.deleteEvidenceObject).not.toHaveBeenCalled();
  });

  it('does not complete an upload while an ingestion prerequisite is disabled', async () => {
    const attachment = {
      id: '22222222-2222-4222-8222-222222222222', owner_id: 'owner-user', draft_id: null, case_id: CASE_ID,
      bucket: 'test-evidence', bucket_path: 'evidence/test/object', mime_type: 'image/jpeg', size_bytes: 12,
      sha256: null, expected_sha256: 'a'.repeat(64), upload_manifest: {}, retention: {},
      retention_policy_id: 'submitted-case-pending-legal-v1', antivirus_status: 'not_scanned',
      quarantine_status: 'quarantined', scan_evidence: null, status: 'pending_upload',
      metadata: {}, created_at: NOW, updated_at: NOW,
    };
    privacyState.malwareScanEnabled = false;
    caseRepository.listAttachments.mockResolvedValueOnce([attachment]);

    const response = await app.inject({
      method: 'POST',
      url: `/api/cases/${CASE_ID}/evidence/${attachment.id}/complete`,
      headers: { authorization: 'Bearer test-token' },
    });

    expect(response.statusCode).toBe(503);
    expect(evidenceStorage.hashStoredObject).not.toHaveBeenCalled();
    expect(evidenceStorage.deleteEvidenceObject).not.toHaveBeenCalled();
    expect(caseRepository.completeAttachment).not.toHaveBeenCalled();
  });

  it('blocks unscanned downloads and permits only clean released attachments', async () => {
    const baseAttachment = {
      id: '22222222-2222-4222-8222-222222222222', owner_id: 'owner-user', draft_id: null, case_id: CASE_ID,
      bucket: 'bucket', bucket_path: 'synthetic/object', mime_type: 'image/jpeg', size_bytes: 12,
      sha256: 'a'.repeat(64), expected_sha256: 'a'.repeat(64), upload_manifest: {}, retention: {},
      retention_policy_id: 'submitted-case-pending-legal-v1', status: 'uploaded', metadata: {},
      scan_evidence: null, created_at: NOW, updated_at: NOW,
    };
    caseRepository.listAttachments.mockResolvedValueOnce([{ ...baseAttachment, antivirus_status: 'pending', quarantine_status: 'quarantined' }]);
    const blocked = await app.inject({
      method: 'GET', url: `/api/cases/${CASE_ID}/evidence/${baseAttachment.id}/download`,
      headers: { authorization: 'Bearer test-token' },
    });
    expect(blocked.statusCode).toBe(409);
    expect(evidenceStorage.createPresignedDownloadUrl).not.toHaveBeenCalled();

    caseRepository.listAttachments.mockResolvedValueOnce([{ ...baseAttachment, antivirus_status: 'clean', quarantine_status: 'released' }]);
    evidenceStorage.createPresignedDownloadUrl.mockResolvedValueOnce('https://download.invalid/synthetic');
    const allowed = await app.inject({
      method: 'GET', url: `/api/cases/${CASE_ID}/evidence/${baseAttachment.id}/download`,
      headers: { authorization: 'Bearer test-token' },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toMatchObject({ url: 'https://download.invalid/synthetic', expiresInSeconds: 60 });
  });
});
