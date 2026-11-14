/**
 * The operator-issued password path (migration 013) end to end against a
 * real, disposable PostgreSQL with migrations 000-013 applied: an org with
 * MFA off, `user:set-password` (repository level), a password-only sign-in
 * that must change the password first, then MFA turned back on, which ends
 * the password-only session and makes the user enrol an authenticator at
 * the next sign-in. Redis is an in-memory stand-in. Skipped unless
 * SAFERIDE_TEST_DATABASE_URL is set. Synthetic data only.
 */
import { randomBytes, randomUUID } from 'node:crypto';

import Fastify, { type FastifyInstance, type LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { parseTrustedProxyCidrs } from '../../config/partnerNetwork.js';
import { closeDb, query } from '../../plugins/db.js';
import { setPartnerOrgMfa, setPartnerUserPassword } from '../../repositories/partnerRepository.js';
import { derivePartnerKeys, generatePartnerPassword, hashPartnerPassword } from '../../services/partnerCredentials.js';
import { verifyKnownDeviceToken } from '../../services/partnerKnownDevice.js';
import { base32Decode, hotp, totpStep } from '../../services/totp.js';
import { registerPartnerApi } from '../partnerAuth.js';

vi.mock('../../config/env.js', () => ({
  env: { databaseUrl: process.env.SAFERIDE_TEST_DATABASE_URL ?? 'postgres://unused.invalid/none' },
}));
vi.mock('../../storage/evidenceStorage.js', () => ({ createPresignedDownloadUrl: vi.fn() }));
vi.mock('../../plugins/redis.js', () => {
  const store = new Map<string, number>();
  return {
    redis: {
      incr: async (key: string) => { const value = (store.get(key) ?? 0) + 1; store.set(key, value); return value; },
      decr: async (key: string) => { const value = (store.get(key) ?? 0) - 1; store.set(key, value); return value; },
      expire: async () => 1,
      del: async (key: string) => { store.delete(key); return 1; },
    },
  };
});

const enabled = Boolean(process.env.SAFERIDE_TEST_DATABASE_URL);
const ORIGIN = 'https://partners.example.invalid';
const HOST = 'partners.example.invalid';
const run = randomUUID().slice(0, 8);
const operator = `pw-test-${run}`;
const context = () => ({ operatorRef: operator, requestId: `pw-test-${randomUUID()}` });
const totpKey = randomBytes(32);
const email = `pw-user-${run}@example.invalid`;
const chosenPassword = 'blue kettle river stone 7';
let app: FastifyInstance;
let orgId: string;
let stableId: string;

type Session = { token: string; csrf: string };

function cookieValue(response: LightMyRequestResponse, name: string): string | null {
  const raw = response.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw.map(String) : raw ? [String(raw)] : [];
  const found = list.find(value => value.startsWith(`${name}=`));
  return found ? found.slice(name.length + 1).split(';')[0] : null;
}

function send(method: 'GET' | 'POST', path: string, options: { session?: Session; body?: unknown } = {}) {
  return app.inject({
    method,
    url: `/partner/v1${path}`,
    headers: {
      host: HOST, origin: ORIGIN,
      ...(options.session ? { cookie: `__Host-saferide_partner=${options.session.token}`, 'x-saferide-partner-csrf': options.session.csrf } : {}),
    },
    ...(options.body !== undefined ? { payload: options.body as object } : {}),
  });
}

function sessionOf(response: LightMyRequestResponse): Session {
  const token = cookieValue(response, '__Host-saferide_partner');
  if (!token) throw new Error('no session cookie');
  return { token, csrf: response.json().csrfToken };
}

describe.skipIf(!enabled)('operator-issued passwords and per-org MFA (PostgreSQL)', { timeout: 30_000 }, () => {
  beforeAll(async () => {
    await query(
      `insert into saferide.partner_operators (handle, display_name, role_label)
       values ($1, 'Synthetic password test operator', 'Synthetic test') on conflict (handle) do nothing`,
      [operator],
    );
    stableId = `pw-org-${run}`;
    const { rows } = await query<{ id: string }>(
      `insert into saferide.partner_organizations (stable_id, display_name) values ($1, 'Synthetic password org') returning id`,
      [stableId],
    );
    orgId = rows[0].id;
    await query(
      `insert into saferide.partner_users (org_id, email, display_name, role, enrollment_token_hash, enrollment_expires_at)
       values ($1, $2, 'Synthetic invitee', 'partner_caseworker', $3, now() + interval '1 day')`,
      [orgId, email, randomBytes(32).toString('hex')],
    );
    app = Fastify({ logger: false });
    await registerPartnerApi(app, { publicOrigin: ORIGIN, totpKey, trustedProxies: parseTrustedProxyCidrs('127.0.0.0/8') });
  });

  afterAll(async () => {
    await app?.close();
    await closeDb();
  });

  it('runs the password-only path, then brings MFA back with enrolment at the next sign-in', async () => {
    // Operator: MFA off for the org, then a generated password for the invited user.
    await expect(setPartnerOrgMfa({ org: stableId, required: false, context: context() }))
      .resolves.toMatchObject({ changed: true, revokedSessions: 0 });
    const issued = generatePartnerPassword(email);
    const result = await setPartnerUserPassword({ email, passwordHash: await hashPartnerPassword(issued), context: context() });
    expect(result).toMatchObject({ wasInvited: true, orgMfaRequired: false, user: { status: 'active', totpEnrolled: false } });
    const audit = await query<{ action: string }>(
      `select action from saferide.partner_access_audit where org_id = $1 and actor_type = 'operator' order by created_at`, [orgId],
    );
    expect(audit.rows.map(row => row.action)).toEqual(['operator.org.mfa', 'operator.user.set_password']);
    const userId = result.user.id;

    // The password alone signs in, with the known-device cookie, but only to change it.
    const login = await send('POST', '/auth/login', { body: { email, password: issued } });
    expect(login.statusCode).toBe(200);
    expect(login.json()).toMatchObject({ mfaRequired: false, totpSetupRequired: false, mustChangePassword: true });
    const device = cookieValue(login, '__Host-saferide_partner_device');
    expect(verifyKnownDeviceToken(derivePartnerKeys(totpKey).knownDevice, device, Math.floor(Date.now() / 1000)))
      .toEqual({ userId, epoch: expect.any(Number) });
    const first = sessionOf(login);
    expect((await send('GET', '/me', { session: first })).json()).toMatchObject({
      mustChangePassword: true, org: { mfaRequired: false }, session: { mfaVerified: false },
    });
    const blocked = await send('GET', '/referrals', { session: first });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json()).toMatchObject({ code: 'password_change_required' });

    const changed = await send('POST', '/auth/change-password', {
      session: first, body: { currentPassword: issued, newPassword: chosenPassword },
    });
    expect(changed.statusCode).toBe(200);
    const second = sessionOf(changed);
    expect(second.token).not.toBe(first.token);
    expect((await send('GET', '/me', { session: first })).statusCode).toBe(401);
    expect((await send('GET', '/referrals', { session: second })).statusCode).toBe(200);
    expect((await send('POST', '/auth/login', { body: { email, password: issued } })).statusCode).toBe(401);

    // MFA back on: the password-only session ends now; the next sign-in enrols an authenticator.
    await expect(setPartnerOrgMfa({ org: orgId, required: true, context: context() }))
      .resolves.toMatchObject({ changed: true, revokedSessions: 1, usersWithoutTotp: 1 });
    expect((await send('GET', '/me', { session: second })).statusCode).toBe(401);
    const again = await send('POST', '/auth/login', { body: { email, password: chosenPassword } });
    expect(again.json()).toMatchObject({ mfaRequired: true, totpSetupRequired: true });
    expect(cookieValue(again, '__Host-saferide_partner_device')).toBeNull();
    const pre = sessionOf(again);
    const setup = await send('POST', '/auth/totp/setup', { session: pre });
    expect(setup.statusCode).toBe(200);
    const secret = base32Decode(setup.json().totp.secret);
    const done = await send('POST', '/auth/totp', { session: pre, body: { code: hotp(secret, totpStep(Math.floor(Date.now() / 1000))) } });
    expect(done.statusCode).toBe(200);
    const full = sessionOf(done);
    expect((await send('GET', '/me', { session: full })).json()).toMatchObject({ session: { mfaVerified: true }, mustChangePassword: false });

    // Enrolled now: a later sign-in asks for the code and refuses a second setup.
    const later = sessionOf(await send('POST', '/auth/login', { body: { email, password: chosenPassword } }));
    expect((await send('POST', '/auth/totp/setup', { session: later })).statusCode).toBe(409);
    const actions = await query<{ action: string; outcome: string }>(
      `select action, outcome from saferide.partner_access_audit where partner_user_id = $1 order by created_at`, [userId],
    );
    expect(actions.rows.map(row => `${row.action}:${row.outcome}`)).toEqual(expect.arrayContaining([
      'auth.login:success', 'auth.password.change:success', 'auth.totp.setup:success', 'auth.totp:success', 'auth.totp.setup:denied',
    ]));
    // No audit row carries a password.
    const dump = await query<{ row: string }>(`select row_to_json(a)::text as row from saferide.partner_access_audit a where org_id = $1`, [orgId]);
    for (const { row } of dump.rows) {
      expect(row).not.toContain(issued);
      expect(row).not.toContain(chosenPassword);
    }
  });
});
