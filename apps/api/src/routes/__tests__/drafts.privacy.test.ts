import Fastify, { type FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError } from '../../http/errors.js';
import { registerDraftRoutes } from '../drafts.js';

const repository = vi.hoisted(() => ({
  deleteDraft: vi.fn(),
  getDraft: vi.fn(),
  listDrafts: vi.fn(),
  upsertDraft: vi.fn(),
}));
const audit = vi.hoisted(() => ({ auditEvent: vi.fn() }));

vi.mock('../../middleware/auth.js', () => ({
  requireAuth: vi.fn(async (request: FastifyRequest) => {
    if (!request.headers.authorization) throw new AppError(401, 'unauthorized', 'Authentication required');
  }),
  getAuth: vi.fn(() => ({ userId: '11111111-1111-4111-8111-111111111111' })),
}));
vi.mock('../../repositories/draftRepository.js', () => repository);
vi.mock('../../services/auditService.js', () => audit);

async function buildApp() {
  const app = Fastify({ logger: false, genReqId: () => 'request-1' });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      reply.status(error.statusCode).send({ code: error.code, message: error.message, details: error.details, requestId: request.id });
      return;
    }
    reply.status(500).send({ code: 'internal_error', requestId: request.id });
  });
  await registerDraftRoutes(app);
  return app;
}

describe('remote draft privacy gate', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });
  afterEach(async () => app.close());

  it('rejects generic remote draft payloads before persistence and audits only the denial', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/drafts',
      headers: { authorization: 'Bearer synthetic' },
      payload: { id: 'draft-1', payload: { narrative: 'synthetic sensitive fixture' } },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().message).toContain('remain encrypted on this device');
    expect(repository.upsertDraft).not.toHaveBeenCalled();
    expect(audit.auditEvent).toHaveBeenCalledWith({
      action: 'draft.remote_write', resourceClass: 'draft', requestId: 'request-1', outcome: 'denied',
      policyVersion: 'privacy-controls.2026-10-22.pilot.1',
    });
  });
});
