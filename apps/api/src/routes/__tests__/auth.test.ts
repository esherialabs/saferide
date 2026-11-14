import Fastify, { type FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

import { AppError } from '../../http/errors.js';
import { indicatesMinor, registerAuthRoutes } from '../auth.js';

const testState = vi.hoisted(() => ({
  authSecret: 'test-auth-secret-with-enough-length',
}));

const db = vi.hoisted(() => ({
  query: vi.fn(),
}));

const privacyState = vi.hoisted(() => ({
  minorProcessingEnabled: false,
  submittedCaseIngestionEnabled: false,
}));
const testPassword = 'test-password-placeholder';

vi.mock('../../config/env.js', () => ({
  env: {
    authJwtSecret: testState.authSecret,
  },
}));

vi.mock('../../plugins/db.js', () => db);
vi.mock('../../config/privacyControls.js', () => ({
  isPrivacyCapabilityEnabled: vi.fn((capability: string) => capability === 'submitted_case_ingestion' ? privacyState.submittedCaseIngestionEnabled : privacyState.minorProcessingEnabled),
}));

async function buildRouteApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    genReqId: () => 'req-auth-test-1',
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      reply.status(error.statusCode).send({
        code: error.code,
        message: error.message,
        details: error.details,
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

  await registerAuthRoutes(app);
  return app;
}

describe('auth user route', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    privacyState.minorProcessingEnabled = false;
    privacyState.submittedCaseIngestionEnabled = false;
    app = await buildRouteApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns a clean unauthorized response for malformed bearer tokens', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/auth/user',
      headers: { authorization: 'Bearer not-a-jwt' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      code: 'unauthorized',
      message: 'Invalid or expired token',
      requestId: 'req-auth-test-1',
    });
    expect(db.query).not.toHaveBeenCalled();
  });

  it('returns unauthorized for valid tokens that do not resolve to an owned user', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const token = await new SignJWT({ aud: 'authenticated' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('missing-user')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(testState.authSecret));

    const response = await app.inject({
      method: 'GET',
      url: '/auth/user',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      code: 'unauthorized',
      message: 'Invalid or expired token',
      requestId: 'req-auth-test-1',
    });
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it('keeps signup disabled while report submission is unavailable', async () => {
    expect(indicatesMinor({ age: 17 }, new Date('2026-07-30'))).toBe(true);
    expect(indicatesMinor({ dateOfBirth: '2010-01-01' }, new Date('2026-07-30'))).toBe(true);
    expect(indicatesMinor({ age: 18 }, new Date('2026-07-30'))).toBe(false);
    const response = await app.inject({
      method: 'POST', url: '/auth/signup',
      payload: { email: 'synthetic@example.invalid', password: testPassword, data: { isMinor: true } },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().message).toContain('Remote account creation is disabled');
    expect(db.query).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    {},
    { isMinor: false },
    { isMinor: 'false' },
    { age: 18 },
  ])('blocks signup while submission is disabled regardless of adult metadata: %j', async data => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { email: 'synthetic@example.invalid', password: testPassword, data },
    });

    expect(response.statusCode).toBe(503);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('creates an anonymous adult session while minor processing remains disabled', async () => {
    privacyState.submittedCaseIngestionEnabled = true;
    expect(privacyState.minorProcessingEnabled).toBe(false);
    db.query.mockResolvedValueOnce({ rows: [{
      id: '00000000-0000-4000-8000-000000000001', email: null, password_hash: null,
      role: 'survivor', user_metadata: { age: 18 }, is_anonymous: true,
      created_at: '2026-10-22T00:00:00.000Z',
    }] }).mockResolvedValue({ rows: [] });
    const response = await app.inject({ method: 'POST', url: '/auth/signup', payload: { data: { age: 18 } } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ token_type: 'bearer', user: { app_metadata: { is_anonymous: true } } });
    expect(response.json().access_token).toEqual(expect.any(String));
    expect(db.query).toHaveBeenCalledTimes(3);
  });

  it('rejects a declared minor while adult pilot signup is enabled', async () => {
    privacyState.submittedCaseIngestionEnabled = true;
    const response = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { email: 'synthetic@example.invalid', password: testPassword, data: { isMinor: true } },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().message).toContain('minors is unavailable');
    expect(db.query).not.toHaveBeenCalled();
  });
});
