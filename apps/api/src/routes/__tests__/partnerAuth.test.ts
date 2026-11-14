import { randomBytes, scrypt } from 'node:crypto';
import { promisify } from 'node:util';

import Fastify, { type FastifyInstance, type InjectOptions } from 'fastify';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { parseTrustedProxyCidrs } from '../../config/partnerNetwork.js';
import { partnerCsrfToken } from '../../middleware/partnerSession.js';
import { PartnerAuthGate } from '../../services/partnerAuthGate.js';
import { issueKnownDeviceToken, verifyKnownDeviceToken } from '../../services/partnerKnownDevice.js';
import { derivePartnerKeys, hashPartnerPassword, openTotpSecret, sealTotpSecret, verifyPartnerPassword } from '../../services/partnerCredentials.js';
import { generatePartnerToken, hashPartnerToken } from '../../services/partnerTokens.js';
import { base32Decode, hotp, totpStep } from '../../services/totp.js';
import { registerPartnerApi } from '../partnerAuth.js';

const authRepo = vi.hoisted(() => ({
  completePartnerEnrollment: vi.fn(),
  completePartnerMfa: vi.fn(),
  completePartnerPasswordChange: vi.fn(),
  findPartnerEnrollment: vi.fn(),
  findPartnerKnownDeviceAccount: vi.fn(),
  getPartnerProfile: vi.fn(),
  reservePartnerLoginAttempt: vi.fn(),
  reservePartnerPasswordCheck: vi.fn(),
  reservePartnerTotpAttempt: vi.fn(),
  resolvePartnerSession: vi.fn(),
  updatePartnerCoverage: vi.fn(),
  revokePartnerSession: vi.fn(),
  settlePartnerAuthFailure: vi.fn(),
  startPartnerSessionAfterPassword: vi.fn(),
  storePendingPartnerTotpSecret: vi.fn(),
  storeSignInTotpSecret: vi.fn(),
}));
const partnerRepo = vi.hoisted(() => ({ recordPartnerAccess: vi.fn() }));
// In-memory stand-in for the Redis commands the limiters use.
const redisState = vi.hoisted(() => {
  const store = new Map<string, number>();
  return {
    store,
    incr: vi.fn(async (key: string) => { const value = (store.get(key) ?? 0) + 1; store.set(key, value); return value; }),
    decr: vi.fn(async (key: string) => { const value = (store.get(key) ?? 0) - 1; store.set(key, value); return value; }),
    expire: vi.fn(async () => 1),
    del: vi.fn(async (key: string) => { store.delete(key); return 1; }),
  };
});

vi.mock('../../config/env.js', () => ({ env: {} }));
vi.mock('../../plugins/db.js', () => ({ query: vi.fn(), pool: { connect: vi.fn() } }));
vi.mock('../../plugins/redis.js', () => ({ redis: redisState }));
vi.mock('../../storage/evidenceStorage.js', () => ({ createPresignedDownloadUrl: vi.fn() }));
vi.mock('../../repositories/partnerAuthRepository.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../repositories/partnerAuthRepository.js')>()),
  ...authRepo,
}));
vi.mock('../../repositories/partnerRepository.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../repositories/partnerRepository.js')>()),
  ...partnerRepo,
}));

const ORIGIN = 'https://partners.example.invalid';
const HOST = 'partners.example.invalid';
const totpKey = randomBytes(32);
const keys = derivePartnerKeys(totpKey);
const syntheticPassword = 'synthetic partner pass 42';
const userId = '22222222-2222-4222-8222-222222222222';
const orgId = '11111111-1111-4111-8111-111111111111';
const secret = randomBytes(20);
const sealedSecret = sealTotpSecret(keys, userId, secret);
const clock = new Date('2026-10-21T10:00:15.000Z');
const nowSeconds = Math.floor(clock.getTime() / 1000);
const COOKIE_PATTERN = /^__Host-saferide_partner=(srps_[A-Za-z0-9_-]{43}); Path=\/; Max-Age=(\d+); HttpOnly; Secure; SameSite=Strict$/;
let passwordHash: string;
let app: FastifyInstance;

function sessionRecord(mfaVerified: boolean, overrides: Record<string, unknown> = {}) {
  return {
    sessionId: mfaVerified ? 'session-full' : 'session-pre', userId, orgId, orgStableId: 'ke-coast-huria',
    role: 'partner_caseworker', stage: mfaVerified ? 'full' : 'pre_mfa', mfaVerified, mustChangePassword: false,
    idleExpiresAt: new Date(clock.getTime() + (mfaVerified ? 1800 : 300) * 1000),
    absoluteExpiresAt: new Date(clock.getTime() + (mfaVerified ? 43200 : 300) * 1000),
    ...overrides,
  };
}

function request(method: 'GET' | 'POST', path: string, options: { body?: unknown; headers?: Record<string, string> } = {}) {
  const injectOptions: InjectOptions = {
    method,
    url: `/partner/v1${path}`,
    headers: { host: HOST, origin: ORIGIN, ...options.headers },
  };
  if (options.body !== undefined) injectOptions.payload = options.body as InjectOptions['payload'];
  return app.inject(injectOptions);
}

/** The Set-Cookie value for one cookie name, or ''. */
function setCookie(response: { headers: Record<string, unknown> }, name = '__Host-saferide_partner'): string {
  const raw = response.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw.map(String) : raw ? [String(raw)] : [];
  return list.find(value => value.startsWith(`${name}=`)) ?? '';
}

const DEVICE_COOKIE_PATTERN = /^__Host-saferide_partner_device=(v2\.[0-9a-f-]{36}\.[0-9a-z]+\.[0-9a-z]+\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}); Path=\/; Max-Age=2592000; HttpOnly; Secure; SameSite=Strict$/;

function withSession(token: string, csrf = true): Record<string, string> {
  return { cookie: `__Host-saferide_partner=${token}`, ...(csrf ? { 'x-saferide-partner-csrf': partnerCsrfToken(token) } : {}) };
}

function auditActions(): string[] {
  return partnerRepo.recordPartnerAccess.mock.calls.map(call => `${call[0].action}:${call[0].outcome}`);
}

describe('partner auth routes', () => {
  beforeAll(async () => {
    passwordHash = await hashPartnerPassword(syntheticPassword);
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    redisState.store.clear();
    partnerRepo.recordPartnerAccess.mockResolvedValue(undefined);
    // Like the real SQL: the empty email used by a blocked client matches nothing.
    authRepo.reservePartnerLoginAttempt.mockImplementation(async (email: string) => (email
      ? { userId, orgId, reserved: true, passwordHash }
      : { userId: null, orgId: null, reserved: false, passwordHash: null }));
    authRepo.settlePartnerAuthFailure.mockResolvedValue({ lockedNow: false });
    authRepo.startPartnerSessionAfterPassword.mockResolvedValue({
      stage: 'pre_mfa',
      totpEnrolled: true,
      session: { id: 'session-pre', idleExpiresAt: new Date(clock.getTime() + 300_000), absoluteExpiresAt: new Date(clock.getTime() + 300_000) },
    });
    authRepo.reservePartnerTotpAttempt.mockResolvedValue({ reserved: true, totpSecretEnc: sealedSecret, totpLastStep: null });
    authRepo.completePartnerMfa.mockResolvedValue({ ...sessionRecord(true), knownDeviceEpoch: 3 });
    authRepo.findPartnerKnownDeviceAccount.mockResolvedValue({ userId, epoch: 0 });
    app = Fastify({ logger: false });
    // inject() connects from 127.0.0.1, which plays the trusted gateway here.
    await registerPartnerApi(app, { publicOrigin: ORIGIN, totpKey, trustedProxies: parseTrustedProxyCidrs('127.0.0.0/8'), now: () => clock });
  });

  afterEach(async () => {
    await app.close();
  });

  describe('live coverage', () => {
    it('requires a full session and CSRF, renews the cookie, and returns mode generation', async () => {
      const session = generatePartnerToken('session');
      authRepo.resolvePartnerSession.mockResolvedValue(sessionRecord(true));
      authRepo.updatePartnerCoverage.mockResolvedValue(sessionRecord(true, { coverageActive: true, coverageEpoch: 1 }));
      const denied = await request('POST', '/coverage', { headers: withSession(session, false), body: { enabled: true } });
      expect(denied.statusCode).toBe(403);
      expect(authRepo.updatePartnerCoverage).not.toHaveBeenCalled();
      const response = await request('POST', '/coverage', { headers: withSession(session), body: { enabled: true } });
      expect(response.statusCode).toBe(200);
      expect(response.json().session).toMatchObject({ coverageActive: true, coverageEpoch: 1 });
      expect(setCookie(response)).toMatch(COOKIE_PATTERN);
      expect(authRepo.updatePartnerCoverage).toHaveBeenCalledWith(expect.objectContaining({ tokenHash: hashPartnerToken(session), enabled: true }));
    });

    it('an off-mode heartbeat is passive and does not opt in or renew the cookie', async () => {
      const session = generatePartnerToken('session');
      authRepo.resolvePartnerSession.mockResolvedValue(sessionRecord(true, { coverageActive: false, coverageEpoch: 2 }));
      const response = await request('POST', '/coverage/heartbeat', { headers: withSession(session), body: {} });
      expect(response.statusCode).toBe(200);
      expect(response.json().session).toMatchObject({ coverageActive: false, coverageEpoch: 2 });
      expect(authRepo.resolvePartnerSession).toHaveBeenCalledWith(hashPartnerToken(session), 'full', { slideIdle: false });
      expect(authRepo.updatePartnerCoverage).not.toHaveBeenCalled();
      expect(response.headers['set-cookie']).toBeUndefined();
    });
  });

  describe('password step', () => {
    it('issues a 5-minute pre-MFA __Host- cookie (HttpOnly, Secure, SameSite=Strict) and a bound CSRF token', async () => {
      const response = await request('POST', '/auth/login', { body: { email: 'Case.Worker@Example.Invalid', password: syntheticPassword } });
      expect(response.statusCode).toBe(200);
      const cookie = String(response.headers['set-cookie']);
      const match = COOKIE_PATTERN.exec(cookie);
      expect(match).not.toBeNull();
      const token = match?.[1] as string;
      expect(match?.[2]).toBe('300');
      expect(response.json()).toMatchObject({
        mfaRequired: true, totpSetupRequired: false, mustChangePassword: false, csrfToken: partnerCsrfToken(token),
      });
      // No known-device cookie before the sign-in is complete.
      expect(setCookie(response, '__Host-saferide_partner_device')).toBe('');
      expect(response.body).not.toContain(token);
      expect(authRepo.reservePartnerLoginAttempt).toHaveBeenCalledWith('case.worker@example.invalid');
      expect(authRepo.settlePartnerAuthFailure).not.toHaveBeenCalled();
      expect(redisState.decr).toHaveBeenCalledTimes(1);
      expect(authRepo.startPartnerSessionAfterPassword).toHaveBeenCalledWith(expect.objectContaining({
        tokenHash: hashPartnerToken(token), userId, orgId,
      }));
      expect(response.headers['cache-control']).toBe('no-store');
    });

    it('answers unknown, wrong-password, disabled and locked accounts identically and audits each', async () => {
      const notReserved = { userId, orgId, reserved: false, passwordHash: null };
      const attempts: Array<() => void> = [
        () => authRepo.reservePartnerLoginAttempt.mockResolvedValueOnce({ userId: null, orgId: null, reserved: false, passwordHash: null }),
        () => undefined,
        () => authRepo.reservePartnerLoginAttempt.mockResolvedValueOnce(notReserved), // disabled
        () => authRepo.reservePartnerLoginAttempt.mockResolvedValueOnce(notReserved), // locked
      ];
      const bodies: string[] = [];
      for (const [index, arrange] of attempts.entries()) {
        arrange();
        const password = index === 1 ? 'wrong synthetic password' : syntheticPassword;
        const response = await request('POST', '/auth/login', { body: { email: 'case.worker@example.invalid', password } });
        expect(response.statusCode).toBe(401);
        expect(response.headers['set-cookie']).toBeUndefined();
        bodies.push(response.json().message);
      }
      expect(new Set(bodies).size).toBe(1);
      expect(authRepo.startPartnerSessionAfterPassword).not.toHaveBeenCalled();
      // Same statements on every path. Every refusal against a known account settles it (settling
      // never counts; it only locks an account already at the maximum), so none can be stranded there.
      expect(authRepo.settlePartnerAuthFailure.mock.calls.map(call => call[0])).toEqual([null, userId, userId, userId]);
      expect(auditActions()).toEqual(['auth.login:denied', 'auth.login:denied', 'auth.login:denied', 'auth.login:denied']);
      expect(partnerRepo.recordPartnerAccess.mock.calls[0][0].actor).toEqual({ type: 'anonymous' });
      expect(partnerRepo.recordPartnerAccess.mock.calls[3][0].actor).toEqual({ type: 'partner_user', userId });
    });

    it('refuses the correct password when no attempt could be reserved (locked, or limit in flight), counting nothing', async () => {
      authRepo.reservePartnerLoginAttempt.mockResolvedValueOnce({ userId, orgId, reserved: false, passwordHash: null });
      const response = await request('POST', '/auth/login', { body: { email: 'case.worker@example.invalid', password: syntheticPassword } });
      expect(response.statusCode).toBe(401);
      expect(authRepo.startPartnerSessionAfterPassword).not.toHaveBeenCalled();
      // Settled against the account so one stuck at the maximum with no lock gets its lock.
      expect(authRepo.settlePartnerAuthFailure).toHaveBeenCalledWith(userId);
    });

    it('audits the lockout when an unreserved attempt locks an account stranded at the maximum', async () => {
      authRepo.reservePartnerLoginAttempt.mockResolvedValueOnce({ userId, orgId, reserved: false, passwordHash: null });
      authRepo.settlePartnerAuthFailure.mockResolvedValueOnce({ lockedNow: true });
      const response = await request('POST', '/auth/login', { body: { email: 'case.worker@example.invalid', password: syntheticPassword } });
      expect(response.statusCode).toBe(401);
      expect(auditActions()).toEqual(['auth.login:denied', 'auth.lockout:denied']);
    });

    it('rehashes a correct password stored at the #287 cost (N=2^16) with the new session', async () => {
      const salt = randomBytes(16);
      const key = await (promisify(scrypt) as (p: string, s: Buffer, l: number, o: object) => Promise<Buffer>)(
        syntheticPassword, salt, 64, { N: 2 ** 16, r: 8, p: 1, maxmem: 256 * 2 ** 16 * 8 },
      );
      const legacy = `scrypt$v1$ln=16,r=8,p=1$${salt.toString('base64url')}$${key.toString('base64url')}`;
      authRepo.reservePartnerLoginAttempt.mockResolvedValueOnce({ userId, orgId, reserved: true, passwordHash: legacy });
      const response = await request('POST', '/auth/login', { body: { email: 'case.worker@example.invalid', password: syntheticPassword } });
      expect(response.statusCode).toBe(200);
      const upgrade = authRepo.startPartnerSessionAfterPassword.mock.calls[0][0].passwordUpgrade;
      expect(upgrade.from).toBe(legacy);
      expect(upgrade.to).toMatch(/^scrypt\$v1\$ln=17,r=8,p=1\$/);
      await expect(verifyPartnerPassword(syntheticPassword, upgrade.to)).resolves.toBe(true);

      // Current-cost hashes and wrong passwords are never rewritten.
      await request('POST', '/auth/login', { body: { email: 'case.worker@example.invalid', password: syntheticPassword } });
      expect(authRepo.startPartnerSessionAfterPassword.mock.calls[1][0]).not.toHaveProperty('passwordUpgrade');
      authRepo.reservePartnerLoginAttempt.mockResolvedValueOnce({ userId, orgId, reserved: true, passwordHash: legacy });
      const wrong = await request('POST', '/auth/login', { body: { email: 'case.worker@example.invalid', password: 'wrong synthetic password' } });
      expect(wrong.statusCode).toBe(401);
      expect(authRepo.startPartnerSessionAfterPassword).toHaveBeenCalledTimes(2);
    });

    it('refuses when a concurrent failure locked the account before the session was written', async () => {
      authRepo.startPartnerSessionAfterPassword.mockResolvedValueOnce(null);
      const response = await request('POST', '/auth/login', { body: { email: 'case.worker@example.invalid', password: syntheticPassword } });
      expect(response.statusCode).toBe(401);
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(redisState.decr).not.toHaveBeenCalled();
      expect(auditActions()).toEqual(['auth.login:denied']);
    });

    it('blocks a client after five failures against one account, without blocking other clients', async () => {
      const attempt = (clientAddress: string, password = 'wrong synthetic password') => request('POST', '/auth/login', {
        body: { email: 'case.worker@example.invalid', password }, headers: { 'x-real-ip': clientAddress },
      });
      for (let failure = 1; failure <= 5; failure += 1) expect((await attempt('203.0.113.7')).statusCode).toBe(401);
      expect(authRepo.reservePartnerLoginAttempt.mock.calls.map(call => call[0])).toEqual(Array(5).fill('case.worker@example.invalid'));

      const blocked = await attempt('203.0.113.7', syntheticPassword);
      expect(blocked.statusCode).toBe(401);
      expect(authRepo.reservePartnerLoginAttempt).toHaveBeenLastCalledWith('');
      expect(authRepo.startPartnerSessionAfterPassword).not.toHaveBeenCalled();
      expect(redisState.expire).toHaveBeenCalledWith(expect.stringMatching(/^saferide:partner-auth-ca:/), 15 * 60);

      const realUser = await attempt('198.51.100.20', syntheticPassword);
      expect(realUser.statusCode).toBe(200);
      expect(authRepo.reservePartnerLoginAttempt).toHaveBeenLastCalledWith('case.worker@example.invalid');
    });

    it('audits the lockout when a failure trips it', async () => {
      authRepo.settlePartnerAuthFailure.mockResolvedValueOnce({ lockedNow: true });
      const response = await request('POST', '/auth/login', { body: { email: 'case.worker@example.invalid', password: 'wrong synthetic password' } });
      expect(response.statusCode).toBe(401);
      expect(auditActions()).toEqual(['auth.login:denied', 'auth.lockout:denied']);
    });
  });

  describe('TOTP step', () => {
    const preToken = generatePartnerToken('session');
    const codeAt = (offset = 0) => hotp(secret, totpStep(nowSeconds) + offset);

    beforeEach(() => {
      authRepo.resolvePartnerSession.mockImplementation(async (_hash: string, kind: string) => (kind === 'pre_mfa' ? sessionRecord(false) : null));
    });

    it('upgrades to a 12-hour session under a brand-new token', async () => {
      const response = await request('POST', '/auth/totp', { body: { code: codeAt() }, headers: withSession(preToken) });
      expect(response.statusCode).toBe(200);
      const match = COOKIE_PATTERN.exec(setCookie(response));
      // A full sign-in also marks this browser as a known device of this user at
      // the user's current epoch (gate priority only).
      const device = DEVICE_COOKIE_PATTERN.exec(setCookie(response, '__Host-saferide_partner_device'))?.[1] ?? null;
      expect(verifyKnownDeviceToken(keys.knownDevice, device, nowSeconds)).toEqual({ userId, epoch: 3 });
      const fullToken = match?.[1] as string;
      expect(fullToken).not.toBe(preToken);
      expect(match?.[2]).toBe('43200');
      expect(response.json()).toMatchObject({ mfaRequired: false, csrfToken: partnerCsrfToken(fullToken) });
      expect(authRepo.resolvePartnerSession).toHaveBeenCalledWith(hashPartnerToken(preToken), 'pre_mfa', { slideIdle: true });
      expect(authRepo.reservePartnerTotpAttempt).toHaveBeenCalledWith(userId);
      expect(authRepo.completePartnerMfa).toHaveBeenCalledWith(expect.objectContaining({
        preMfaSessionId: 'session-pre', userId, orgId, step: totpStep(nowSeconds), newTokenHash: hashPartnerToken(fullToken),
        verifiedTotpSecretEnc: sealedSecret,
      }));
    });

    it('counts a wrong code as a failure and audits it', async () => {
      const wrong = codeAt() === '000000' ? '111111' : '000000';
      const response = await request('POST', '/auth/totp', { body: { code: wrong }, headers: withSession(preToken) });
      expect(response.statusCode).toBe(401);
      expect(authRepo.settlePartnerAuthFailure).toHaveBeenCalledWith(userId);
      expect(authRepo.completePartnerMfa).not.toHaveBeenCalled();
      expect(auditActions()).toEqual(['auth.totp:denied']);
    });

    it('refuses a replayed code from the last accepted step', async () => {
      authRepo.reservePartnerTotpAttempt.mockResolvedValue({ reserved: true, totpSecretEnc: sealedSecret, totpLastStep: totpStep(nowSeconds) });
      const response = await request('POST', '/auth/totp', { body: { code: codeAt() }, headers: withSession(preToken) });
      expect(response.statusCode).toBe(401);
      expect(authRepo.completePartnerMfa).not.toHaveBeenCalled();
    });

    it('refuses without checking the code, and counts nothing, when no attempt could be reserved', async () => {
      authRepo.reservePartnerTotpAttempt.mockResolvedValue({ reserved: false, totpSecretEnc: null, totpLastStep: null });
      const response = await request('POST', '/auth/totp', { body: { code: codeAt() }, headers: withSession(preToken) });
      expect(response.statusCode).toBe(401);
      // Settling never counts; it locks the account only if it is stranded at the maximum.
      expect(authRepo.settlePartnerAuthFailure).toHaveBeenCalledWith(userId);
      expect(authRepo.completePartnerMfa).not.toHaveBeenCalled();
    });

    it('settles a verified code that lost the race to complete (replay or retired session)', async () => {
      authRepo.completePartnerMfa.mockResolvedValueOnce(null);
      const response = await request('POST', '/auth/totp', { body: { code: codeAt() }, headers: withSession(preToken) });
      expect(response.statusCode).toBe(401);
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(authRepo.settlePartnerAuthFailure).toHaveBeenCalledWith(userId);
      expect(redisState.decr).not.toHaveBeenCalled();
      expect(auditActions()).toEqual(['auth.totp:denied']);
    });

    it('needs the CSRF token bound to the pre-MFA cookie', async () => {
      const missing = await request('POST', '/auth/totp', { body: { code: codeAt() }, headers: withSession(preToken, false) });
      expect(missing.statusCode).toBe(403);
      const otherToken = generatePartnerToken('session');
      const mismatched = await request('POST', '/auth/totp', {
        body: { code: codeAt() },
        headers: { cookie: `__Host-saferide_partner=${preToken}`, 'x-saferide-partner-csrf': partnerCsrfToken(otherToken) },
      });
      expect(mismatched.statusCode).toBe(403);
      expect(authRepo.completePartnerMfa).not.toHaveBeenCalled();
    });

    it('is not reachable with a full session or without one', async () => {
      authRepo.resolvePartnerSession.mockResolvedValue(null);
      const response = await request('POST', '/auth/totp', { body: { code: codeAt() }, headers: withSession(preToken) });
      expect(response.statusCode).toBe(401);
      expect(authRepo.reservePartnerTotpAttempt).not.toHaveBeenCalled();
    });
  });

  describe('session use, expiry and logout', () => {
    const fullToken = generatePartnerToken('session');

    it('returns the PartnerSession view on /me and audits the read', async () => {
      authRepo.resolvePartnerSession.mockResolvedValue(sessionRecord(true));
      authRepo.getPartnerProfile.mockResolvedValue({
        userId, email: 'case.worker@example.invalid', displayName: 'Synthetic caseworker', role: 'partner_caseworker',
        orgId, orgStableId: 'ke-coast-huria', orgDisplayName: 'HURIA (synthetic)', orgMfaRequired: true, mustChangePassword: false,
      });
      const response = await request('GET', '/me', { headers: { cookie: `__Host-saferide_partner=${fullToken}` } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        user: { id: userId, email: 'case.worker@example.invalid', displayName: 'Synthetic caseworker' },
        org: { id: orgId, stableId: 'ke-coast-huria', displayName: 'HURIA (synthetic)', mfaRequired: true },
        role: 'partner_caseworker',
        mustChangePassword: false,
        csrfToken: partnerCsrfToken(fullToken),
        session: { idleExpiresAt: '2026-10-21T10:30:15.000Z', absoluteExpiresAt: '2026-10-21T22:00:15.000Z', mfaVerified: true },
      });
      expect(authRepo.resolvePartnerSession).toHaveBeenCalledWith(hashPartnerToken(fullToken), 'full', { slideIdle: false });
      expect(auditActions()).toEqual(['partner.me.read:success']);
    });

    it('extends the idle timer only for user-initiated requests, never for background polling', async () => {
      authRepo.resolvePartnerSession.mockResolvedValue(sessionRecord(true));
      authRepo.getPartnerProfile.mockResolvedValue({
        userId, email: 'e@example.invalid', displayName: 'S', role: 'partner_caseworker', orgId, orgStableId: 'ke-coast-huria', orgDisplayName: 'H',
      });
      const cookie = `__Host-saferide_partner=${fullToken}`;
      await request('GET', '/me', { headers: { cookie } });
      await request('GET', '/me', { headers: { cookie, 'x-saferide-partner-activity': 'background' } });
      await request('GET', '/me', { headers: { cookie, 'x-saferide-partner-activity': 'interactive' } });
      expect(authRepo.resolvePartnerSession.mock.calls.map(call => call[2])).toEqual([
        { slideIdle: false }, { slideIdle: false }, { slideIdle: true },
      ]);
    });

    it('treats an expired, revoked or pre-MFA session as signed out', async () => {
      authRepo.resolvePartnerSession.mockResolvedValue(null);
      const response = await request('GET', '/me', { headers: { cookie: `__Host-saferide_partner=${fullToken}` } });
      expect(response.statusCode).toBe(401);
      expect(authRepo.getPartnerProfile).not.toHaveBeenCalled();
    });

    it('logs out with CSRF, revokes the session and clears the cookie', async () => {
      authRepo.resolvePartnerSession.mockResolvedValue(sessionRecord(true));
      const refused = await request('POST', '/auth/logout', { headers: withSession(fullToken, false) });
      expect(refused.statusCode).toBe(403);
      expect(authRepo.revokePartnerSession).not.toHaveBeenCalled();

      const response = await request('POST', '/auth/logout', { headers: withSession(fullToken) });
      expect(response.statusCode).toBe(204);
      expect(authRepo.revokePartnerSession).toHaveBeenCalledWith('session-full', 'logout');
      expect(String(response.headers['set-cookie'])).toBe('__Host-saferide_partner=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict');
      expect(auditActions()).toEqual(['auth.logout:success']);
    });

    it('fails closed with 503 when the audit cannot be written', async () => {
      authRepo.resolvePartnerSession.mockResolvedValue(sessionRecord(true));
      authRepo.getPartnerProfile.mockResolvedValue({
        userId, email: 'e@example.invalid', displayName: 'S', role: 'partner_caseworker', orgId, orgStableId: 'ke-coast-huria', orgDisplayName: 'H',
      });
      partnerRepo.recordPartnerAccess.mockRejectedValue(new Error('audit down'));
      const response = await request('GET', '/me', { headers: { cookie: `__Host-saferide_partner=${fullToken}` } });
      expect(response.statusCode).toBe(503);
      expect(response.body).not.toContain('e@example.invalid');
    });
  });

  describe('password-only orgs and operator-issued passwords (013)', () => {
    const profile = {
      userId, email: 'case.worker@example.invalid', displayName: 'Synthetic caseworker', role: 'partner_caseworker',
      orgId, orgStableId: 'ke-coast-huria', orgDisplayName: 'HURIA (synthetic)', orgMfaRequired: false, mustChangePassword: true,
    };
    const newPassword = 'mango tractor velvet harbour';

    it('signs straight in when the org has MFA off, recording mfaVerified false, and mints the known-device cookie', async () => {
      authRepo.startPartnerSessionAfterPassword.mockResolvedValueOnce({
        stage: 'full',
        session: { ...sessionRecord(true), mfaVerified: false, mustChangePassword: true, knownDeviceEpoch: 2 },
      });
      const response = await request('POST', '/auth/login', { body: { email: 'case.worker@example.invalid', password: syntheticPassword } });
      expect(response.statusCode).toBe(200);
      const match = COOKIE_PATTERN.exec(setCookie(response));
      const token = match?.[1] as string;
      expect(match?.[2]).toBe('43200');
      expect(response.json()).toMatchObject({
        mfaRequired: false, totpSetupRequired: false, mustChangePassword: true, csrfToken: partnerCsrfToken(token),
      });
      const device = DEVICE_COOKIE_PATTERN.exec(setCookie(response, '__Host-saferide_partner_device'))?.[1] ?? null;
      expect(verifyKnownDeviceToken(keys.knownDevice, device, nowSeconds)).toEqual({ userId, epoch: 2 });
      // The limiter reservation is refunded like any successful sign-in.
      expect(redisState.decr).toHaveBeenCalledTimes(1);
      expect(authRepo.settlePartnerAuthFailure).not.toHaveBeenCalled();
    });

    it('asks a user without an authenticator to set one up when the org requires MFA', async () => {
      authRepo.startPartnerSessionAfterPassword.mockResolvedValueOnce({
        stage: 'pre_mfa', totpEnrolled: false,
        session: { id: 'session-pre', idleExpiresAt: new Date(clock.getTime() + 300_000), absoluteExpiresAt: new Date(clock.getTime() + 300_000) },
      });
      const response = await request('POST', '/auth/login', { body: { email: 'case.worker@example.invalid', password: syntheticPassword } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ mfaRequired: true, totpSetupRequired: true });
    });

    it('issues a sign-in authenticator key only inside a pre-MFA session, storing it sealed', async () => {
      const preToken = generatePartnerToken('session');
      authRepo.resolvePartnerSession.mockImplementation(async (_hash: string, kind: string) => (kind === 'pre_mfa' ? sessionRecord(false) : null));
      authRepo.getPartnerProfile.mockResolvedValue({ ...profile, orgMfaRequired: true, mustChangePassword: false });
      authRepo.storeSignInTotpSecret.mockResolvedValueOnce(true);
      const response = await request('POST', '/auth/totp/setup', { headers: withSession(preToken) });
      expect(response.statusCode).toBe(200);
      const { totp } = response.json();
      expect(totp).toMatchObject({ algorithm: 'SHA1', digits: 6, periodSeconds: 30 });
      expect(totp.keyUri).toMatch(/^otpauth:\/\/totp\/SafeRide%20Partners:case\.worker%40example\.invalid\?/);
      const stored = authRepo.storeSignInTotpSecret.mock.calls[0][0];
      expect(stored).toMatchObject({ userId, preMfaSessionId: 'session-pre' });
      expect(openTotpSecret(keys, userId, stored.totpSecretEnc).equals(base32Decode(totp.secret))).toBe(true);

      // An enrolled user cannot replace their authenticator this way; CSRF is required.
      authRepo.storeSignInTotpSecret.mockResolvedValueOnce(false);
      expect((await request('POST', '/auth/totp/setup', { headers: withSession(preToken) })).statusCode).toBe(409);
      expect((await request('POST', '/auth/totp/setup', { headers: withSession(preToken, false) })).statusCode).toBe(403);
      expect(auditActions()).toEqual(['auth.totp.setup:success', 'auth.totp.setup:denied']);
      // A full session (or none) never reaches it.
      authRepo.resolvePartnerSession.mockResolvedValue(null);
      expect((await request('POST', '/auth/totp/setup', { headers: withSession(preToken) })).statusCode).toBe(401);
    });

    it('lets a must-change-password session read /me and nothing else', async () => {
      const token = generatePartnerToken('session');
      authRepo.resolvePartnerSession.mockResolvedValue(sessionRecord(true, { mfaVerified: false, mustChangePassword: true }));
      authRepo.getPartnerProfile.mockResolvedValue(profile);
      const me = await request('GET', '/me', { headers: { cookie: `__Host-saferide_partner=${token}` } });
      expect(me.statusCode).toBe(200);
      expect(me.json()).toMatchObject({ mustChangePassword: true, org: { mfaRequired: false }, session: { mfaVerified: false } });
      const queue = await request('GET', '/referrals', { headers: { cookie: `__Host-saferide_partner=${token}` } });
      expect(queue.statusCode).toBe(403);
      expect(queue.json()).toMatchObject({ code: 'password_change_required' });
      const logout = await request('POST', '/auth/logout', { headers: withSession(token) });
      expect(logout.statusCode).toBe(204);
    });

    describe('POST /auth/change-password', () => {
      const token = generatePartnerToken('session');
      const change = (body: unknown, csrf = true) => request('POST', '/auth/change-password', { body, headers: withSession(token, csrf) });

      beforeEach(() => {
        authRepo.resolvePartnerSession.mockResolvedValue(sessionRecord(true, { mfaVerified: false, mustChangePassword: true }));
        authRepo.getPartnerProfile.mockResolvedValue(profile);
        authRepo.reservePartnerPasswordCheck.mockResolvedValue({ reserved: true, passwordHash, email: profile.email });
        authRepo.completePartnerPasswordChange.mockResolvedValue({
          ...sessionRecord(true), mfaVerified: false, knownDeviceEpoch: 0,
          absoluteExpiresAt: new Date(clock.getTime() + 3_600_000),
        });
      });

      it('checks the current password, stores only a hash of the new one and rotates the session', async () => {
        const response = await change({ currentPassword: syntheticPassword, newPassword });
        expect(response.statusCode).toBe(200);
        const match = COOKIE_PATTERN.exec(setCookie(response));
        const fresh = match?.[1] as string;
        expect(fresh).not.toBe(token);
        // The new session keeps the old absolute expiry (1 h left here), never a fresh 12 h.
        expect(match?.[2]).toBe('3600');
        expect(response.json()).toMatchObject({ mfaRequired: false, mustChangePassword: false, csrfToken: partnerCsrfToken(fresh) });
        expect(authRepo.reservePartnerPasswordCheck).toHaveBeenCalledWith(userId);
        const call = authRepo.completePartnerPasswordChange.mock.calls[0][0];
        expect(call).toMatchObject({
          sessionId: 'session-full', userId, orgId, currentPasswordHash: passwordHash, newTokenHash: hashPartnerToken(fresh),
        });
        await expect(verifyPartnerPassword(newPassword, call.newPasswordHash)).resolves.toBe(true);
        expect(JSON.stringify(call)).not.toContain(newPassword);
        expect(JSON.stringify(call)).not.toContain(syntheticPassword);
        expect(redisState.decr).toHaveBeenCalledTimes(1);
      });

      it('refuses weak, reused or malformed new passwords before any attempt is reserved', async () => {
        for (const body of [
          { currentPassword: syntheticPassword, newPassword: 'short' },
          { currentPassword: syntheticPassword, newPassword: 'Password2026!' },
          { currentPassword: syntheticPassword, newPassword: syntheticPassword },
          { currentPassword: syntheticPassword, newPassword, extra: 'x' },
        ]) {
          expect((await change(body)).statusCode).toBe(400);
        }
        expect(authRepo.reservePartnerPasswordCheck).not.toHaveBeenCalled();
        expect(authRepo.completePartnerPasswordChange).not.toHaveBeenCalled();
      });

      it('counts a wrong current password like a failed sign-in, without ending the session', async () => {
        const response = await change({ currentPassword: 'wrong synthetic password', newPassword });
        expect(response.statusCode).toBe(400);
        expect(response.headers['set-cookie']).toBeUndefined();
        expect(authRepo.settlePartnerAuthFailure).toHaveBeenCalledWith(userId);
        expect(authRepo.completePartnerPasswordChange).not.toHaveBeenCalled();
        expect(auditActions()).toEqual(['auth.password.change:denied']);
      });

      it('settles and refuses when the password or session changed meanwhile', async () => {
        authRepo.completePartnerPasswordChange.mockResolvedValueOnce(null);
        const response = await change({ currentPassword: syntheticPassword, newPassword });
        expect(response.statusCode).toBe(400);
        expect(authRepo.settlePartnerAuthFailure).toHaveBeenCalledWith(userId);
        expect(redisState.decr).not.toHaveBeenCalled();
      });

      it('needs CSRF and a full session', async () => {
        expect((await change({ currentPassword: syntheticPassword, newPassword }, false)).statusCode).toBe(403);
        authRepo.resolvePartnerSession.mockResolvedValue(null);
        expect((await change({ currentPassword: syntheticPassword, newPassword })).statusCode).toBe(401);
        expect(authRepo.reservePartnerPasswordCheck).not.toHaveBeenCalled();
      });
    });
  });

  describe('host, origin and CSRF guards', () => {
    it('serves partner routes only on the partner host', async () => {
      const response = await request('POST', '/auth/login', {
        body: { email: 'a@example.invalid', password: syntheticPassword },
        headers: { host: 'api.example.invalid' },
      });
      expect(response.statusCode).toBe(404);
      expect(authRepo.reservePartnerLoginAttempt).not.toHaveBeenCalled();
    });

    it.each([
      ['a foreign Origin', { origin: 'https://evil.example.invalid' }],
      ['no Origin', { origin: '' }],
      ['a cross-site fetch', { 'sec-fetch-site': 'cross-site' }],
      ['a same-site (sibling host) fetch', { 'sec-fetch-site': 'same-site' }],
    ])('refuses a state-changing request with %s', async (_label, headers) => {
      const merged: Record<string, string> = { ...headers };
      const response = await app.inject({
        method: 'POST',
        url: '/partner/v1/auth/login',
        payload: { email: 'a@example.invalid', password: syntheticPassword },
        headers: merged.origin === '' ? { host: HOST } : { host: HOST, origin: ORIGIN, ...merged },
      });
      expect(response.statusCode).toBe(403);
      expect(authRepo.reservePartnerLoginAttempt).not.toHaveBeenCalled();
    });

    it('refuses cross-origin reads', async () => {
      const response = await request('GET', '/me', {
        headers: { origin: 'https://evil.example.invalid', cookie: `__Host-saferide_partner=${generatePartnerToken('session')}` },
      });
      expect(response.statusCode).toBe(403);
      expect(authRepo.resolvePartnerSession).not.toHaveBeenCalled();
    });
  });

  describe('credential work gate', () => {
    const preToken = generatePartnerToken('session');

    async function appWithGate(gate: PartnerAuthGate): Promise<FastifyInstance> {
      const gated = Fastify({ logger: false });
      await registerPartnerApi(gated, {
        publicOrigin: ORIGIN, totpKey, trustedProxies: parseTrustedProxyCidrs('127.0.0.0/8'), now: () => clock, authGate: gate,
      });
      return gated;
    }

    it('answers 503 with Retry-After when saturated, before reserving or counting anything', async () => {
      const gate = new PartnerAuthGate({ maxConcurrent: 1, maxQueued: 0, queueTimeoutMs: 0, retryAfterSeconds: 5 });
      const gated = await appWithGate(gate);
      authRepo.resolvePartnerSession.mockImplementation(async (_hash: string, kind: string) => (kind === 'pre_mfa' ? sessionRecord(false) : null));
      const release = await gate.acquire();
      try {
        const login = await gated.inject({
          method: 'POST', url: '/partner/v1/auth/login', headers: { host: HOST, origin: ORIGIN },
          payload: { email: 'case.worker@example.invalid', password: syntheticPassword },
        });
        const totp = await gated.inject({
          method: 'POST', url: '/partner/v1/auth/totp', headers: { host: HOST, origin: ORIGIN, ...withSession(preToken) },
          payload: { code: '123456' },
        });
        for (const response of [login, totp]) {
          expect(response.statusCode).toBe(503);
          expect(response.headers['retry-after']).toBe('5');
          expect(response.json()).toMatchObject({ code: 'partner_auth_busy' });
          expect(response.headers['set-cookie']).toBeUndefined();
        }
        // Nothing reserved, settled or audited: a flood cannot push a caseworker towards a lock.
        expect(authRepo.reservePartnerLoginAttempt).not.toHaveBeenCalled();
        expect(authRepo.reservePartnerTotpAttempt).not.toHaveBeenCalled();
        expect(authRepo.settlePartnerAuthFailure).not.toHaveBeenCalled();
        expect(redisState.incr.mock.calls.map(call => call[0]).filter(key => key.startsWith('saferide:partner-auth-ca:'))).toEqual([]);
        expect(partnerRepo.recordPartnerAccess).not.toHaveBeenCalled();
      } finally {
        release();
      }
      const after = await gated.inject({
        method: 'POST', url: '/partner/v1/auth/login', headers: { host: HOST, origin: ORIGIN },
        payload: { email: 'case.worker@example.invalid', password: syntheticPassword },
      });
      expect(after.statusCode).toBe(200);
      expect(gate.stats).toEqual({ active: 0, queued: 0, priorityQueued: 0 });
      await gated.close();
    });

    it('gives a known-device cookie priority only for its own current account, one place per account', async () => {
      const gate = new PartnerAuthGate({ maxConcurrent: 1, maxQueued: 0, maxQueuedPriority: 4, queueTimeoutMs: 10_000, retryAfterSeconds: 5 });
      const gated = await appWithGate(gate);
      authRepo.resolvePartnerSession.mockImplementation(async (_hash: string, kind: string) => (kind === 'pre_mfa' ? sessionRecord(false) : null));
      const login = (cookie?: string) => gated.inject({
        method: 'POST', url: '/partner/v1/auth/login',
        headers: { host: HOST, origin: ORIGIN, ...(cookie ? { cookie: `__Host-saferide_partner_device=${cookie}` } : {}) },
        payload: { email: 'case.worker@example.invalid', password: syntheticPassword },
      });
      const totp = () => gated.inject({
        method: 'POST', url: '/partner/v1/auth/totp', headers: { host: HOST, origin: ORIGIN, ...withSession(generatePartnerToken('session')) },
        payload: { code: hotp(secret, totpStep(nowSeconds)) },
      });
      const issue = (device: { userId: string; epoch: number }, at = nowSeconds, key = keys.knownDevice) => issueKnownDeviceToken(key, device, at);
      const known = issue({ userId, epoch: 0 });
      const otherAccount = issue({ userId: '33333333-3333-4333-8333-333333333333', epoch: 0 });
      const forged = issue({ userId, epoch: 0 }, nowSeconds, derivePartnerKeys(randomBytes(32)).knownDevice);
      const expired = issue({ userId, epoch: 0 }, nowSeconds - 31 * 24 * 3600);

      const release = await gate.acquire();
      // No cookie, a forged or expired one, or one minted for another account: no priority (general queue full).
      for (const cookie of [undefined, forged, expired, otherAccount]) expect((await login(cookie)).statusCode).toBe(503);
      // The account named in the body was reset or revoked since (epoch moved on), or is disabled.
      authRepo.findPartnerKnownDeviceAccount.mockResolvedValueOnce({ userId, epoch: 1 });
      expect((await login(known)).statusCode).toBe(503);
      authRepo.findPartnerKnownDeviceAccount.mockResolvedValueOnce(null);
      expect((await login(known)).statusCode).toBe(503);
      expect(authRepo.findPartnerKnownDeviceAccount).toHaveBeenLastCalledWith('case.worker@example.invalid');

      const knownLogin = login(known);
      await vi.waitFor(() => expect(gate.stats.priorityQueued).toBe(1));
      // One priority place per account: a second valid cookie of the same user,
      // or the same user's TOTP step, waits in the (full) general queue instead.
      expect((await login(issue({ userId, epoch: 0 }))).statusCode).toBe(503);
      expect((await totp()).statusCode).toBe(503);
      expect(gate.stats.priorityQueued).toBe(1);
      release();
      expect((await knownLogin).statusCode).toBe(200);

      // With the account's place free again, a pre-MFA session jumps the queue.
      const releaseAgain = await gate.acquire();
      const totpAttempt = totp();
      await vi.waitFor(() => expect(gate.stats.priorityQueued).toBe(1));
      releaseAgain();
      expect((await totpAttempt).statusCode).toBe(200);
      expect(gate.stats).toEqual({ active: 0, queued: 0, priorityQueued: 0 });
      await gated.close();
    });

    it('queues a request behind a busy slot and serves it when the slot frees', async () => {
      const gate = new PartnerAuthGate({ maxConcurrent: 1, maxQueued: 4, queueTimeoutMs: 10_000, retryAfterSeconds: 5 });
      const gated = await appWithGate(gate);
      const release = await gate.acquire();
      const pending = gated.inject({
        method: 'POST', url: '/partner/v1/auth/login', headers: { host: HOST, origin: ORIGIN },
        payload: { email: 'case.worker@example.invalid', password: syntheticPassword },
      });
      await vi.waitFor(() => expect(gate.stats.queued).toBe(1));
      expect(authRepo.reservePartnerLoginAttempt).not.toHaveBeenCalled();
      release();
      expect((await pending).statusCode).toBe(200);
      await gated.close();
    });
  });

  describe('rate limiting', () => {
    it('throttles sign-in attempts per client and fails closed without Redis', async () => {
      redisState.incr.mockResolvedValueOnce(31);
      const limited = await request('POST', '/auth/login', { body: { email: 'a@example.invalid', password: syntheticPassword } });
      expect(limited.statusCode).toBe(429);
      redisState.incr.mockRejectedValueOnce(new Error('redis down'));
      const down = await request('POST', '/auth/login', { body: { email: 'a@example.invalid', password: syntheticPassword } });
      expect(down.statusCode).toBe(503);
      expect(authRepo.reservePartnerLoginAttempt).not.toHaveBeenCalled();
      expect(String(redisState.incr.mock.calls[0][0])).toMatch(/^saferide:partner-auth-rate:\d+:[a-f0-9]{64}$/);
    });

    it('keys limits on the gateway X-Real-IP only when the peer is a trusted proxy', async () => {
      const send = (target: FastifyInstance, clientAddress: string) => target.inject({
        method: 'POST', url: '/partner/v1/auth/login',
        headers: { host: HOST, origin: ORIGIN, 'x-real-ip': clientAddress },
        payload: { email: 'a@example.invalid', password: 'wrong synthetic password' },
      });
      const rateKeys = () => redisState.incr.mock.calls.map(call => String(call[0])).filter(key => key.startsWith('saferide:partner-auth-rate:'));

      await send(app, '203.0.113.7');
      await send(app, '198.51.100.20');
      expect(new Set(rateKeys()).size).toBe(2);

      vi.clearAllMocks();
      const untrusted = Fastify({ logger: false });
      await registerPartnerApi(untrusted, { publicOrigin: ORIGIN, totpKey, now: () => clock });
      await send(untrusted, '203.0.113.7');
      await send(untrusted, '198.51.100.20');
      expect(new Set(rateKeys()).size).toBe(1);
      expect(rateKeys().join()).not.toMatch(/203\.0\.113|198\.51\.100/);
      await untrusted.close();
    });
  });

  describe('enrolment', () => {
    const enrollToken = generatePartnerToken('enrollment');
    const enrollment = {
      userId, orgId, email: 'case.worker@example.invalid', displayName: 'Synthetic caseworker', role: 'partner_caseworker',
      orgDisplayName: 'HURIA (synthetic)', totpSecretEnc: null as string | null,
    };

    it('starts enrolment from a body token and stores only a sealed secret', async () => {
      authRepo.findPartnerEnrollment.mockResolvedValue(enrollment);
      authRepo.storePendingPartnerTotpSecret.mockResolvedValue(true);
      const response = await request('POST', '/auth/enroll/start', { body: { token: enrollToken } });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.totp).toMatchObject({ algorithm: 'SHA1', digits: 6, periodSeconds: 30 });
      expect(body.totp.keyUri).toMatch(/^otpauth:\/\/totp\/SafeRide%20Partners:case\.worker%40example\.invalid\?/);
      expect(authRepo.findPartnerEnrollment).toHaveBeenCalledWith(hashPartnerToken(enrollToken));
      const stored = authRepo.storePendingPartnerTotpSecret.mock.calls[0][0];
      expect(stored.totpSecretEnc).not.toContain(body.totp.secret);
      expect(openTotpSecret(keys, userId, stored.totpSecretEnc).equals(base32Decode(body.totp.secret))).toBe(true);
      expect(response.headers['cache-control']).toBe('no-store');
    });

    it('rejects malformed or unknown enrolment tokens', async () => {
      const malformed = await request('POST', '/auth/enroll/start', { body: { token: 'not-a-token' } });
      expect(malformed.statusCode).toBe(404);
      expect(authRepo.findPartnerEnrollment).not.toHaveBeenCalled();
      authRepo.findPartnerEnrollment.mockResolvedValue(null);
      const unknown = await request('POST', '/auth/enroll/start', { body: { token: enrollToken } });
      expect(unknown.statusCode).toBe(404);
      expect(auditActions()).toEqual(['auth.enroll.start:denied', 'auth.enroll.start:denied']);
    });

    it('completes enrolment only with a strong password and a valid code', async () => {
      authRepo.findPartnerEnrollment.mockResolvedValue({ ...enrollment, totpSecretEnc: sealedSecret });
      authRepo.completePartnerEnrollment.mockResolvedValue({ ...sessionRecord(true), knownDeviceEpoch: 0 });
      const code = hotp(secret, totpStep(nowSeconds));

      const weak = await request('POST', '/auth/enroll/complete', { body: { token: enrollToken, password: 'short', code } });
      expect(weak.statusCode).toBe(400);
      const wrongCode = await request('POST', '/auth/enroll/complete', {
        body: { token: enrollToken, password: syntheticPassword, code: code === '000000' ? '111111' : '000000' },
      });
      expect(wrongCode.statusCode).toBe(400);
      expect(authRepo.completePartnerEnrollment).not.toHaveBeenCalled();

      const response = await request('POST', '/auth/enroll/complete', { body: { token: enrollToken, password: syntheticPassword, code } });
      expect(response.statusCode).toBe(200);
      const fullToken = COOKIE_PATTERN.exec(setCookie(response))?.[1] as string;
      expect(setCookie(response, '__Host-saferide_partner_device')).toMatch(DEVICE_COOKIE_PATTERN);
      const call = authRepo.completePartnerEnrollment.mock.calls[0][0];
      expect(call).toMatchObject({
        userId, orgId, tokenHash: hashPartnerToken(enrollToken), verifiedTotpSecretEnc: sealedSecret,
        step: totpStep(nowSeconds), newTokenHash: hashPartnerToken(fullToken),
      });
      expect(call.passwordHash).toMatch(/^scrypt\$v1\$ln=17,r=8,p=1\$/);
      expect(JSON.stringify(call)).not.toContain(syntheticPassword);
    });

    it('refuses activation when the enrolled secret changed after the code was verified', async () => {
      authRepo.findPartnerEnrollment.mockResolvedValue({ ...enrollment, totpSecretEnc: sealedSecret });
      authRepo.completePartnerEnrollment.mockResolvedValue(null);
      const response = await request('POST', '/auth/enroll/complete', {
        body: { token: enrollToken, password: syntheticPassword, code: hotp(secret, totpStep(nowSeconds)) },
      });
      expect(response.statusCode).toBe(409);
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(auditActions()).toEqual(['auth.enroll.complete:denied']);
    });
  });
});
