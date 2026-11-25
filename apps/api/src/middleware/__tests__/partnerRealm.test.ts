import Fastify, { type FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError } from '../../http/errors.js';
import { generatePartnerToken } from '../../services/partnerTokens.js';
import { getAuth, requireAuth } from '../auth.js';
import { getPartnerSession, requirePartnerSession } from '../partnerSession.js';

const state = vi.hoisted(() => ({ authSecret: 'test-auth-secret-with-enough-length' }));
const db = vi.hoisted(() => ({ query: vi.fn() }));
const authRepo = vi.hoisted(() => ({ resolvePartnerSession: vi.fn() }));

vi.mock('../../config/env.js', () => ({ env: { authJwtSecret: state.authSecret } }));
vi.mock('../../plugins/db.js', () => ({ query: db.query, pool: { connect: vi.fn() } }));
vi.mock('../../repositories/partnerAuthRepository.js', () => authRepo);

async function survivorJwt(role = 'partner_admin'): Promise<string> {
  // A survivor-realm token, even one claiming a partner role.
  return new SignJWT({ role, aud: 'authenticated' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('33333333-3333-4333-8333-333333333333')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(state.authSecret));
}

const fullSession = {
  sessionId: 'session-full', userId: 'u', orgId: 'o', orgStableId: 'ke-coast-huria', role: 'partner_admin',
  stage: 'full', mfaVerified: true, mustChangePassword: false, idleExpiresAt: new Date(), absoluteExpiresAt: new Date(),
};

let app: FastifyInstance;

describe('survivor and partner realms never accept each other', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    db.query.mockResolvedValue({ rows: [] });
    authRepo.resolvePartnerSession.mockResolvedValue(fullSession);
    app = Fastify({ logger: false });
    app.setErrorHandler((error, _request, reply) => {
      const status = error instanceof AppError ? error.statusCode : 500;
      reply.status(status).send({ status });
    });
    app.get('/survivor', { preHandler: requireAuth }, async request => ({ realm: 'survivor', userId: getAuth(request).userId }));
    app.get('/partner', { preHandler: requirePartnerSession }, async request => ({ realm: getPartnerSession(request).realm }));
  });

  afterEach(async () => {
    await app.close();
  });

  it('accepts each realm’s own credential (sanity)', async () => {
    const survivor = await app.inject({ method: 'GET', url: '/survivor', headers: { authorization: `Bearer ${await survivorJwt('survivor')}` } });
    expect(survivor.statusCode).toBe(200);
    const partner = await app.inject({ method: 'GET', url: '/partner', headers: { cookie: `__Host-saferide_partner=${generatePartnerToken('session')}` } });
    expect(partner.json()).toEqual({ realm: 'partner' });
  });

  it('partner routes refuse a valid survivor JWT, as a bearer or as a cookie', async () => {
    const jwt = await survivorJwt();
    const bearer = await app.inject({ method: 'GET', url: '/partner', headers: { authorization: `Bearer ${jwt}` } });
    expect(bearer.statusCode).toBe(401);
    const cookie = await app.inject({ method: 'GET', url: '/partner', headers: { cookie: `__Host-saferide_partner=${jwt}` } });
    expect(cookie.statusCode).toBe(401);
    expect(authRepo.resolvePartnerSession).not.toHaveBeenCalled();
  });

  it('partner routes refuse a request that carries any Authorization header, even with a valid partner cookie', async () => {
    const response = await app.inject({
      method: 'GET', url: '/partner',
      headers: { cookie: `__Host-saferide_partner=${generatePartnerToken('session')}`, authorization: `Bearer ${await survivorJwt()}` },
    });
    expect(response.statusCode).toBe(401);
    expect(authRepo.resolvePartnerSession).not.toHaveBeenCalled();
  });

  it('partner routes refuse duplicated or malformed partner cookies', async () => {
    const token = generatePartnerToken('session');
    for (const cookie of [
      `__Host-saferide_partner=${token}; __Host-saferide_partner=${generatePartnerToken('session')}`,
      `__Host-saferide_partner=${generatePartnerToken('enrollment')}`,
      `saferide_partner=${token}`,
    ]) {
      const response = await app.inject({ method: 'GET', url: '/partner', headers: { cookie } });
      expect(response.statusCode).toBe(401);
    }
    expect(authRepo.resolvePartnerSession).not.toHaveBeenCalled();
  });

  it('survivor requireAuth refuses a partner session token as a bearer, without touching the database', async () => {
    const response = await app.inject({
      method: 'GET', url: '/survivor', headers: { authorization: `Bearer ${generatePartnerToken('session')}` },
    });
    expect(response.statusCode).toBe(401);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('survivor requireAuth ignores the partner cookie entirely', async () => {
    const response = await app.inject({
      method: 'GET', url: '/survivor', headers: { cookie: `__Host-saferide_partner=${generatePartnerToken('session')}` },
    });
    expect(response.statusCode).toBe(401);
    expect(authRepo.resolvePartnerSession).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
  });
});
