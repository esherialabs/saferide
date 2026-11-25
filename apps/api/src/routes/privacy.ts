import { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { isPrivacyCapabilityEnabled, loadPrivacyControls } from '../config/privacyControls.js';
import { badRequest, conflict, notFound, serviceUnavailable } from '../http/errors.js';
import { getAuth, requireAuth } from '../middleware/auth.js';
import {
  createConsentRecord,
  createDsarRequest,
  createPolicyAcceptance,
  listConsentHistory,
  listDsarRequests,
  listPolicyAcceptances,
  withdrawConsent,
} from '../repositories/privacyRepository.js';
import { auditEvent } from '../services/auditService.js';
import {
  assertPolicyAcceptable,
  buildConsentWithdrawal,
  calculateDsarDueAt,
  DSAR_REQUEST_TYPES,
} from '../services/privacyLifecycle.js';

const consentSchema = z.object({
  purpose: z.enum([
    'pathway_submission', 'anonymous_aggregate', 'analytics', 'research', 'model_training',
    'partner_follow_up', 'partner_callback',
  ]),
  consentVersion: z.string().min(1).max(120),
}).strict();

const dsarSchema = z.object({
  requestType: z.enum(DSAR_REQUEST_TYPES),
  idempotencyKey: z.string().uuid(),
}).strict();

const policyAcceptanceSchema = z.object({
  documentType: z.enum(['privacy-policy', 'terms']),
  version: z.string().min(1).max(120),
  locale: z.string().min(2).max(16),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export async function registerPrivacyRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/privacy/policies', async () => {
    const controls = loadPrivacyControls();
    return {
      controlVersion: controls.controlVersion,
      documents: controls.policyDocuments.map(document => ({
        documentType: document.documentType,
        version: document.version,
        locale: document.locale,
        sha256: document.sha256,
        effectiveDate: document.effectiveDate,
        reviewStatus: document.reviewStatus,
        acceptanceEnabled: document.acceptanceEnabled,
      })),
    };
  });

  app.get('/api/privacy/consents', { preHandler: requireAuth }, async request => {
    return { consents: await listConsentHistory(getAuth(request).userId) };
  });

  app.get('/api/privacy/policy-acceptances', { preHandler: requireAuth }, async request => {
    return { acceptances: await listPolicyAcceptances(getAuth(request).userId) };
  });

  app.post('/api/privacy/policy-acceptances', { preHandler: requireAuth }, async request => {
    const auth = getAuth(request);
    const parsed = policyAcceptanceSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('Invalid policy acceptance', parsed.error.flatten());
    const controls = loadPrivacyControls();
    const acceptanceControl = controls.consentPurposes.policy_acceptance;
    const document = controls.policyDocuments.find(candidate =>
      candidate.documentType === parsed.data.documentType &&
      candidate.version === parsed.data.version &&
      candidate.locale === parsed.data.locale &&
      candidate.sha256 === parsed.data.sha256,
    );
    if (!document) throw badRequest('Policy document identity or hash does not match');
    if (acceptanceControl?.status !== 'enabled') {
      throw serviceUnavailable('Policy acceptance is disabled pending legal approval', {
        handoffId: 'HANDOFF-PRIVACY-LEGAL-REVIEW',
      });
    }
    try {
      assertPolicyAcceptable(document);
    } catch {
      throw serviceUnavailable('Policy acceptance is disabled pending legal approval', {
        handoffId: 'HANDOFF-PRIVACY-LEGAL-REVIEW',
      });
    }
    const acceptance = await createPolicyAcceptance({
      ownerId: auth.userId,
      documentType: document.documentType,
      documentVersion: document.version,
      locale: document.locale,
      contentSha256: document.sha256,
      acceptedAt: new Date(),
    });
    await auditEvent({
      action: 'policy.accept',
      resourceClass: 'policy_acceptance',
      requestId: request.id,
      outcome: 'success',
      policyVersion: controls.controlVersion,
    });
    return { acceptance };
  });

  app.post('/api/privacy/consents', { preHandler: requireAuth }, async request => {
    const auth = getAuth(request);
    const parsed = consentSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('Invalid consent payload', parsed.error.flatten());
    if (parsed.data.purpose === 'anonymous_aggregate') {
      throw badRequest('Anonymous aggregate consent must be recorded atomically with minimized RSI signals');
    }
    const controls = loadPrivacyControls();
    const purposeControl = controls.consentPurposes[parsed.data.purpose];
    if (!purposeControl || purposeControl.status !== 'enabled' || purposeControl.version !== parsed.data.consentVersion) {
      throw serviceUnavailable('This consent purpose is not available');
    }

    const consent = await createConsentRecord({
      ownerId: auth.userId,
      purpose: parsed.data.purpose,
      consentVersion: parsed.data.consentVersion,
      grantedAt: new Date(),
    });
    await auditEvent({
      action: 'consent.grant',
      resourceClass: 'consent',
      requestId: request.id,
      outcome: 'success',
      policyVersion: controls.controlVersion,
    });
    return { consent };
  });

  app.post('/api/privacy/consents/:id/withdraw', { preHandler: requireAuth }, async request => {
    const auth = getAuth(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const policyVersion = loadPrivacyControls().controlVersion;
    const withdrawnAt = new Date();
    const consent = await withdrawConsent({ ownerId: auth.userId, consentId: params.id, withdrawnAt });
    if (!consent) throw notFound('Active consent not found');
    const withdrawal = buildConsentWithdrawal({
      consentId: params.id,
      purpose: String(consent.purpose),
      withdrawnAt: withdrawnAt.toISOString(),
    });
    await auditEvent({
      action: 'consent.withdraw',
      resourceClass: 'consent',
      requestId: request.id,
      outcome: 'success',
      policyVersion,
    });
    return { consent, withdrawal };
  });

  app.get('/api/privacy/dsar', { preHandler: requireAuth }, async request => {
    return { requests: await listDsarRequests(getAuth(request).userId) };
  });

  app.post('/api/privacy/dsar', { preHandler: requireAuth }, async request => {
    const parsed = dsarSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('Invalid rights request', parsed.error.flatten());
    if (!isPrivacyCapabilityEnabled('dsar_server_processing')) {
      throw serviceUnavailable('Submitted-data rights processing is pending legal approval', {
        handoffId: 'HANDOFF-PRIVACY-LEGAL-REVIEW',
      });
    }
    const auth = getAuth(request);
    const requestedAt = new Date();
    const dsarRequest = await createDsarRequest({
      ownerId: auth.userId,
      requestType: parsed.data.requestType,
      idempotencyKey: parsed.data.idempotencyKey,
      dueAt: calculateDsarDueAt(requestedAt),
    });
    if (!dsarRequest) throw conflict('Idempotency key was already used for a different rights-request type');
    await auditEvent({
      action: 'dsar.request',
      resourceClass: 'rights_request',
      requestId: request.id,
      outcome: 'success',
      policyVersion: loadPrivacyControls().controlVersion,
    });
    return { request: dsarRequest, targetDays: 30 };
  });
}
