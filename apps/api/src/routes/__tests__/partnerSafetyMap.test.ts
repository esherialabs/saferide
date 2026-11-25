import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerPartnerSafetyMapRoutes } from '../partnerSafetyMap.js';
import { registerErrorHandler } from '../../http/errorHandler.js';

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), list: vi.fn(), audit: vi.fn() }));
vi.mock('../../repositories/partnerAuthRepository.js', () => ({ resolvePartnerSession: mocks.resolve }));
vi.mock('../../repositories/partnerSafetyMapRepository.js', () => ({ listPartnerSafetyMapRecords: mocks.list, SAFETY_MAP_CASE_LIMIT: 200 }));
vi.mock('../../repositories/partnerRepository.js', () => ({ recordPartnerAccess: mocks.audit }));
vi.mock('../../config/env.js', () => ({ env: { databaseUrl: 'postgres://unused.invalid/none' } }));
const session = { sessionId: 'synthetic-session', userId: 'synthetic-staff', orgId: 'synthetic-org', orgStableId: 'test-org', role: 'partner_caseworker', stage: 'full', mfaVerified: true, mustChangePassword: false, idleExpiresAt: new Date('2026-10-22T10:30:00Z'), absoluteExpiresAt: new Date('2026-10-22T20:00:00Z') };
const headers = { cookie: `__Host-saferide_partner=srps_${'A'.repeat(43)}` };
let app: ReturnType<typeof Fastify>;
describe('guarded staff safety-map route', () => {
  beforeEach(async () => {
    vi.resetAllMocks(); mocks.resolve.mockResolvedValue(session); mocks.list.mockResolvedValue({ records: [], truncated: false }); mocks.audit.mockResolvedValue(undefined);
    app = Fastify({ logger: false }); registerErrorHandler(app); await registerPartnerSafetyMapRoutes(app);
  });
  afterEach(async () => { await app.close(); });
  it('requires a full authorized session before reading data', async () => {
    mocks.resolve.mockResolvedValue(null);
    expect((await app.inject({ method: 'GET', url: '/safety-map', headers })).statusCode).toBe(401);
    expect(mocks.list).not.toHaveBeenCalled();
  });
  it('uses the session org, records summary access and does not slide passive polling', async () => {
    const result = await app.inject({ method: 'GET', url: '/safety-map?days=7', headers });
    expect(result.statusCode).toBe(200); expect(result.json()).toMatchObject({ windowDays: 7, mapped: 0, unmapped: 0, truncated: false });
    expect(mocks.list).toHaveBeenCalledWith('synthetic-org', 7);
    expect(mocks.resolve).toHaveBeenCalledWith(expect.any(String), 'full', { slideIdle: false });
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ orgId: 'synthetic-org', action: 'partner.summary.read', outcome: 'success' }));
  });
  it('rejects unsupported windows and foreign-org query parameters', async () => {
    for (const query of ['days=1', 'days=999', 'orgId=another-org']) expect((await app.inject({ method: 'GET', url: `/safety-map?${query}`, headers })).statusCode).toBe(400);
    expect(mocks.list).not.toHaveBeenCalled();
  });
  it('fails closed when the audit cannot be written', async () => {
    mocks.audit.mockRejectedValue(new Error('synthetic audit failure'));
    expect((await app.inject({ method: 'GET', url: '/safety-map', headers })).statusCode).toBe(503);
  });
});
