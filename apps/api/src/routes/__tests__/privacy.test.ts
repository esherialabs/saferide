import Fastify, { type FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

import { AppError } from '../../http/errors.js';
import { registerPrivacyRoutes } from '../privacy.js';

const repository = vi.hoisted(() => ({
  createConsentRecord: vi.fn(), createDsarRequest: vi.fn(), createPolicyAcceptance: vi.fn(),
  listConsentHistory: vi.fn(), listDsarRequests: vi.fn(), listPolicyAcceptances: vi.fn(), withdrawConsent: vi.fn(),
}));
const audit = vi.hoisted(() => ({ auditEvent: vi.fn() }));

vi.mock('../../middleware/auth.js', () => ({
  requireAuth: vi.fn(async (request: FastifyRequest) => {
    if (!request.headers.authorization) throw new AppError(401, 'unauthorized', 'Authentication required');
  }),
  getAuth: vi.fn(() => ({ userId: '11111111-1111-4111-8111-111111111111' })),
}));
vi.mock('../../repositories/privacyRepository.js', () => repository);
vi.mock('../../services/auditService.js', () => audit);

async function buildApp() {
  const app = Fastify({ logger: false, genReqId: () => 'request-1' });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      reply.status(error.statusCode).send({ code: error.code, message: error.message, details: error.details, requestId: request.id });
    } else if (error instanceof ZodError) {
      reply.status(400).send({ code: 'bad_request', requestId: request.id });
    } else {
      reply.status(500).send({ code: 'internal_error', requestId: request.id });
    }
  });
  await registerPrivacyRoutes(app);
  return app;
}

describe('privacy policy, consent, and rights routes', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeEach(async () => {
    vi.clearAllMocks();
    repository.listConsentHistory.mockResolvedValue([]);
    repository.listDsarRequests.mockResolvedValue([]);
    repository.listPolicyAcceptances.mockResolvedValue([]);
    app = await buildApp();
  });
  afterEach(async () => app.close());

  it('publishes version/hash/review state without publishing draft content or paths', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/privacy/policies' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.documents).toHaveLength(2);
    expect(body.documents[0]).toMatchObject({ reviewStatus: 'pending_legal', effectiveDate: null, acceptanceEnabled: false });
    expect(JSON.stringify(body)).not.toContain('content/legal');
    expect(JSON.stringify(body)).not.toContain('engineering review draft');
  });

  it('keeps policy acceptance and non-pathway purposes disabled independently', async () => {
    const document = (await app.inject({ method: 'GET', url: '/api/privacy/policies' })).json().documents[0];
    const policy = await app.inject({
      method: 'POST', url: '/api/privacy/policy-acceptances', headers: { authorization: 'Bearer synthetic' },
      payload: { documentType: document.documentType, version: document.version, locale: document.locale, sha256: document.sha256 },
    });
    expect(policy.statusCode).toBe(503);
    expect(repository.createPolicyAcceptance).not.toHaveBeenCalled();

    const research = await app.inject({
      method: 'POST', url: '/api/privacy/consents', headers: { authorization: 'Bearer synthetic' },
      payload: { purpose: 'research', consentVersion: 'pathway-consent.v1' },
    });
    expect(research.statusCode).toBe(503);
    const aggregate = await app.inject({
      method: 'POST', url: '/api/privacy/consents', headers: { authorization: 'Bearer synthetic' },
      payload: { purpose: 'anonymous_aggregate', consentVersion: 'synthetic-unapproved-version' },
    });
    expect(aggregate.statusCode).toBe(400);
    expect(aggregate.json().message).toContain('atomically');
    expect(repository.createConsentRecord).not.toHaveBeenCalled();
  });

  it('accepts both partner consent purposes but keeps them off until the privacy controls enable them', async () => {
    for (const purpose of ['partner_follow_up', 'partner_callback']) {
      const response = await app.inject({
        method: 'POST', url: '/api/privacy/consents', headers: { authorization: 'Bearer synthetic' },
        payload: { purpose, consentVersion: 'partner-follow-up.ke-coast-huria.v1' },
      });
      expect(response.statusCode).toBe(503);
    }
    expect(repository.createConsentRecord).not.toHaveBeenCalled();
  });

  it('records the current pilot pathway consent independently from policy-document approval', async () => {
    repository.createConsentRecord.mockResolvedValueOnce({ id: 'pilot-consent', purpose: 'pathway_submission', status: 'granted' });
    const response = await app.inject({
      method: 'POST', url: '/api/privacy/consents', headers: { authorization: 'Bearer synthetic' },
      payload: { purpose: 'pathway_submission', consentVersion: 'pathway-consent.v1' },
    });
    expect(response.statusCode).toBe(200);
    expect(repository.createConsentRecord).toHaveBeenCalledOnce();
  });

  it('accepts all six rights-request types under the engineering pilot while preserving status history', async () => {
    repository.listDsarRequests.mockResolvedValueOnce([{ id: 'existing', request_type: 'access', status: 'requested', due_at: '2026-08-29T00:00:00Z' }]);
    const list = await app.inject({ method: 'GET', url: '/api/privacy/dsar', headers: { authorization: 'Bearer synthetic' } });
    expect(list.json().requests[0]).toMatchObject({ status: 'requested' });
    for (const requestType of ['access', 'export', 'correction', 'restriction', 'objection', 'deletion']) {
      repository.createDsarRequest.mockResolvedValueOnce({ id: 'pilot-rights-request', request_type: requestType, status: 'requested' });
      const response = await app.inject({
        method: 'POST', url: '/api/privacy/dsar', headers: { authorization: 'Bearer synthetic' },
        payload: { requestType, idempotencyKey: '22222222-2222-4222-8222-222222222222' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().request).toMatchObject({ request_type: requestType, status: 'requested' });
    }
    expect(repository.createDsarRequest).toHaveBeenCalledTimes(6);
  });

  it('records withdrawal as future-only with the external-sharing limitation', async () => {
    repository.withdrawConsent.mockResolvedValue({ id: '33333333-3333-4333-8333-333333333333', purpose: 'pathway_submission' });
    const response = await app.inject({
      method: 'POST', url: '/api/privacy/consents/33333333-3333-4333-8333-333333333333/withdraw',
      headers: { authorization: 'Bearer synthetic' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().withdrawal).toMatchObject({ status: 'withdrawn', effect: 'future_processing_only' });
    expect(response.json().withdrawal.externalSharingEffect).toContain('cannot be recalled');
  });
});
