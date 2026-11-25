/**
 * Reproduces the #287 security-review probe against a real, disposable
 * PostgreSQL (migrations 000-008 applied): many wrong passwords in flight at
 * once, then the right one. Before the fix, the right password succeeded
 * because the lock was only recorded after each ~200 ms scrypt. Also covers
 * the pre-enablement hardening: the credential work gate, accounts stranded
 * at the limit by unsettled reservations, and rehashing older hashes.
 * Skipped unless SAFERIDE_TEST_DATABASE_URL is set. Synthetic data only.
 */
import { randomBytes, randomUUID, scrypt } from 'node:crypto';
import { promisify } from 'node:util';

import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { parseTrustedProxyCidrs } from '../../config/partnerNetwork.js';
import { PARTNER_AUTH_DB_TIMEOUTS, closeDb, partnerAuthPool, pool, query } from '../../plugins/db.js';
import { PARTNER_AUTH_GATE_POLICY, PartnerAuthGate } from '../../services/partnerAuthGate.js';
import { issueKnownDeviceToken } from '../../services/partnerKnownDevice.js';
import { derivePartnerKeys, hashPartnerPassword, sealTotpSecret, verifyPartnerPassword } from '../../services/partnerCredentials.js';
import { registerPartnerApi } from '../partnerAuth.js';

const reservations = vi.hoisted(() => ({ results: [] as Array<{ reserved: boolean }> }));

vi.mock('../../config/env.js', () => ({
  env: { databaseUrl: process.env.SAFERIDE_TEST_DATABASE_URL ?? 'postgres://unused.invalid/none' },
}));
// The per-client limiter is exercised elsewhere; here every request comes
// from a different client so only the account-level SQL reservation can stop it.
// The partner case routes (mounted by registerPartnerApi) import evidence storage, which needs S3 settings.
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
vi.mock('../../repositories/partnerAuthRepository.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../repositories/partnerAuthRepository.js')>();
  return {
    ...actual,
    reservePartnerLoginAttempt: async (email: string) => {
      const result = await actual.reservePartnerLoginAttempt(email);
      reservations.results.push(result);
      return result;
    },
  };
});

const enabled = Boolean(process.env.SAFERIDE_TEST_DATABASE_URL);
const ORIGIN = 'https://partners.example.invalid';
const HOST = 'partners.example.invalid';
const run = randomUUID().slice(0, 8);
const correctPassword = 'synthetic probe passphrase 7';
const totpKey = randomBytes(32);
let app: FastifyInstance;
let orgId: string;

async function activeUser(label: string, passwordHash?: string): Promise<{ userId: string; email: string }> {
  const email = `${label}-${run}@example.invalid`;
  const { rows } = await query<{ id: string }>(
    `insert into saferide.partner_users (org_id, email, display_name, role, status, password_hash, totp_secret_enc, totp_enrolled_at)
     values ($1, $2, 'Synthetic probe user', 'partner_caseworker', 'active', $3, 'v1.${'A'.repeat(16)}.${'B'.repeat(22)}.${'C'.repeat(27)}', now())
     returning id`,
    [orgId, email, passwordHash ?? await hashPartnerPassword(correctPassword)],
  );
  const userId = rows[0].id;
  await query(`update saferide.partner_users set totp_secret_enc = $2 where id = $1`, [
    userId, sealTotpSecret(derivePartnerKeys(totpKey), userId, randomBytes(20)),
  ]);
  return { userId, email };
}

function login(email: string, password: string, client: number, target: FastifyInstance = app) {
  return target.inject({
    method: 'POST',
    url: '/partner/v1/auth/login',
    headers: { host: HOST, origin: ORIGIN, 'x-real-ip': `203.0.113.${client}` },
    payload: { email, password },
  });
}

function totp(preMfa: { token: string; csrf: string }, code: string, client: number) {
  return app.inject({
    method: 'POST',
    url: '/partner/v1/auth/totp',
    headers: {
      host: HOST, origin: ORIGIN, 'x-real-ip': `203.0.113.${client}`,
      cookie: `__Host-saferide_partner=${preMfa.token}`, 'x-saferide-partner-csrf': preMfa.csrf,
    },
    payload: { code },
  });
}

async function accountState(userId: string) {
  const { rows } = await query<{ failed_attempts: number; locked: boolean; lockout_count: number }>(
    `select failed_attempts, coalesce(locked_until > now(), false) as locked, lockout_count
     from saferide.partner_users where id = $1`,
    [userId],
  );
  return rows[0];
}

async function auditCounts(userId: string) {
  const { rows } = await query<{ action: string; count: string }>(
    `select action, count(*)::text as count from saferide.partner_access_audit
     where partner_user_id = $1 group by action order by action`,
    [userId],
  );
  return rows;
}

const routeConfig = () => ({ publicOrigin: ORIGIN, totpKey, trustedProxies: parseTrustedProxyCidrs('127.0.0.0/8') });

// One gate slot serialises the probes' N=2^17 hashes (about 0.4 s each), so
// a dozen in flight need longer than the default 5 s.
describe.skipIf(!enabled)('partner login under concurrent guessing (PostgreSQL)', { timeout: 30_000 }, () => {
  beforeAll(async () => {
    const { rows } = await query<{ id: string }>(
      `insert into saferide.partner_organizations (stable_id, display_name) values ($1, 'Synthetic probe org') returning id`,
      [`probe-${run}`],
    );
    orgId = rows[0].id;
    app = Fastify({ logger: false });
    // Production concurrency and queue length; a long queue wait so a slow
    // shared runner cannot turn these account-level probes into gate 503s.
    await registerPartnerApi(app, { ...routeConfig(), authGate: new PartnerAuthGate({ ...PARTNER_AUTH_GATE_POLICY, queueTimeoutMs: 60_000 }) });
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  it('refuses the right password sent while 11 wrong ones are still being checked', async () => {
    const { userId, email } = await activeUser('probe');
    reservations.results.length = 0;
    const wrong = Array.from({ length: 11 }, (_, index) => login(email, `wrong synthetic guess ${index}`, index + 1));
    // Wait until every wrong attempt has been reserved or refused (they are now inside scrypt).
    await vi.waitFor(() => expect(reservations.results.length).toBe(11), { timeout: 10_000, interval: 5 });
    const right = await login(email, correctPassword, 200);
    const wrongResponses = await Promise.all(wrong);

    expect(right.statusCode).toBe(401);
    expect(right.headers['set-cookie']).toBeUndefined();
    expect(wrongResponses.map(response => response.statusCode)).toEqual(Array(11).fill(401));
    // Ten guesses are evaluated per lock window, no matter how many arrive at once.
    expect(reservations.results.filter(result => result.reserved)).toHaveLength(10);
    expect(reservations.results.at(-1)).toMatchObject({ reserved: false });

    const state = await query<{ locked: boolean; lockout_count: number }>(
      `select coalesce(locked_until > now(), false) as locked, lockout_count from saferide.partner_users where id = $1`,
      [userId],
    );
    expect(state.rows[0]).toEqual({ locked: true, lockout_count: 1 });
    const sessions = await query(`select 1 from saferide.partner_sessions where user_id = $1`, [userId]);
    expect(sessions.rows).toHaveLength(0);
    expect(await auditCounts(userId)).toEqual([{ action: 'auth.lockout', count: '1' }, { action: 'auth.login', count: '12' }]);
  });

  it('evaluates at most ten guesses when all twelve arrive at once', async () => {
    const { userId, email } = await activeUser('burst');
    reservations.results.length = 0;
    const responses = await Promise.all([
      ...Array.from({ length: 11 }, (_, index) => login(email, `wrong synthetic guess ${index}`, index + 1)),
      login(email, correctPassword, 200),
    ]);
    expect(reservations.results.filter(result => result.reserved).length).toBeLessThanOrEqual(10);
    // Whatever the interleaving, at most one sign-in can succeed, and only within the first ten reservations.
    expect(responses.filter(response => response.statusCode === 200).length).toBeLessThanOrEqual(1);
    const state = await query<{ failed_attempts: number; locked: boolean }>(
      `select failed_attempts, coalesce(locked_until > now(), false) as locked from saferide.partner_users where id = $1`,
      [userId],
    );
    expect(state.rows[0].locked || state.rows[0].failed_attempts < 10).toBe(true);
  });
  it('refuses with 503 and Retry-After before reserving when the gate is full, so a flood cannot lock a caseworker', async () => {
    const gate = new PartnerAuthGate({ maxConcurrent: 1, maxQueued: 2, queueTimeoutMs: 200, retryAfterSeconds: 5 });
    const gated = Fastify({ logger: false });
    await registerPartnerApi(gated, { ...routeConfig(), authGate: gate });
    const { userId, email } = await activeUser('flooded');
    const release = await gate.acquire();
    let flood: Awaited<ReturnType<typeof login>>[];
    try {
      flood = await Promise.all(Array.from({ length: 20 }, (_, index) => login(email, `wrong synthetic guess ${index}`, 100 + index, gated)));
    } finally {
      release();
    }
    expect(flood.map(response => response.statusCode)).toEqual(Array(20).fill(503));
    expect(new Set(flood.map(response => response.headers['retry-after']))).toEqual(new Set(['5']));
    expect(flood.map(response => response.json().code)).toEqual(Array(20).fill('partner_auth_busy'));
    // Nothing was reserved, counted or audited against the account.
    expect(await accountState(userId)).toEqual({ failed_attempts: 0, locked: false, lockout_count: 0 });
    expect(await auditCounts(userId)).toEqual([]);
    expect(gate.stats).toEqual({ active: 0, queued: 0, priorityQueued: 0 });

    const caseworker = await login(email, correctPassword, 150, gated);
    expect(caseworker.statusCode).toBe(200);
    await gated.close();
  });

  it('locks, instead of stranding, an account left at ten by reservations that never settled', async () => {
    const { userId, email } = await activeUser('stranded');
    // A TOTP secret sealed for another user cannot be opened (as after a key
    // mix-up): each TOTP attempt reserves, then fails closed with 503 before
    // it can settle, exactly like a crash between reserve and settle.
    await query(`update saferide.partner_users set totp_secret_enc = $2 where id = $1`, [
      userId, sealTotpSecret(derivePartnerKeys(totpKey), randomUUID(), randomBytes(20)),
    ]);
    const signedIn = await login(email, correctPassword, 50);
    expect(signedIn.statusCode).toBe(200);
    const preMfa = {
      token: /__Host-saferide_partner=([^;]+)/.exec(String(signedIn.headers['set-cookie']))?.[1] as string,
      csrf: signedIn.json().csrfToken as string,
    };
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect((await totp(preMfa, '123456', 60 + attempt)).statusCode).toBe(503);
    }
    expect(await accountState(userId)).toEqual({ failed_attempts: 10, locked: false, lockout_count: 0 });

    // Before this fix every later attempt was refused unreserved and never
    // settled, so the account stayed shut with no lock to expire.
    const refused = await login(email, correctPassword, 80);
    expect(refused.statusCode).toBe(401);
    expect(await accountState(userId)).toEqual({ failed_attempts: 0, locked: true, lockout_count: 1 });
    expect(await auditCounts(userId)).toEqual([
      { action: 'auth.lockout', count: '1' }, { action: 'auth.login', count: '2' },
    ]);

    // The lock expires like any other, and the right password works again.
    await query(`update saferide.partner_users set locked_until = now() - interval '1 second' where id = $1`, [userId]);
    expect((await login(email, correctPassword, 81)).statusCode).toBe(200);
  });

  it('rehashes an N=2^16 password at N=2^17 on the next successful sign-in', async () => {
    const salt = randomBytes(16);
    const key = await (promisify(scrypt) as (p: string, s: Buffer, l: number, o: object) => Promise<Buffer>)(
      correctPassword, salt, 64, { N: 2 ** 16, r: 8, p: 1, maxmem: 256 * 2 ** 16 * 8 },
    );
    const legacy = `scrypt$v1$ln=16,r=8,p=1$${salt.toString('base64url')}$${key.toString('base64url')}`;
    const { userId, email } = await activeUser('legacy-hash', legacy);
    const storedHash = async () => (await query<{ password_hash: string }>(
      `select password_hash from saferide.partner_users where id = $1`, [userId],
    )).rows[0].password_hash;

    expect((await login(email, 'wrong synthetic guess', 90)).statusCode).toBe(401);
    expect(await storedHash()).toBe(legacy);

    expect((await login(email, correctPassword, 91)).statusCode).toBe(200);
    const upgraded = await storedHash();
    expect(upgraded).toMatch(/^scrypt\$v1\$ln=17,r=8,p=1\$/);
    await expect(verifyPartnerPassword(correctPassword, upgraded)).resolves.toBe(true);
    expect((await login(email, correctPassword, 92)).statusCode).toBe(200);
    expect(await storedHash()).toBe(upgraded);
  });
  it('times out a slow statement on the partner sign-in pool', async () => {
    const started = Date.now();
    await expect(partnerAuthPool.query('select pg_sleep(10)')).rejects.toMatchObject({ code: '57014' });
    expect(Date.now() - started).toBeLessThan(PARTNER_AUTH_DB_TIMEOUTS.statementMs + 1_000);
  });

  it('gives the gate slot back within seconds when a stalled transaction holds the account row', async () => {
    const gate = new PartnerAuthGate({ ...PARTNER_AUTH_GATE_POLICY, maxConcurrent: 1, queueTimeoutMs: 60_000 });
    const gated = Fastify({ logger: false });
    await registerPartnerApi(gated, { ...routeConfig(), authGate: gate });
    const stuck = await activeUser('row-locked');
    const other = await activeUser('queued-behind');
    const blocker = await pool.connect();
    try {
      await blocker.query('begin');
      await blocker.query('select 1 from saferide.partner_users where id = $1 for update', [stuck.userId]);
      const started = Date.now();
      const [stalled, queued] = await Promise.all([
        login(stuck.email, correctPassword, 170, gated),
        (async () => {
          await vi.waitFor(() => expect(gate.stats.active).toBe(1));
          const behind = login(other.email, correctPassword, 171, gated);
          await vi.waitFor(() => expect(gate.stats.queued).toBe(1));
          return behind;
        })(),
      ]);
      const elapsed = Date.now() - started;
      // The reservation waited on the row lock until statement_timeout, failed
      // closed, and released the only slot to the sign-in queued behind it.
      expect(stalled.statusCode).toBe(503);
      expect(queued.statusCode).toBe(200);
      expect(elapsed).toBeLessThan(PARTNER_AUTH_DB_TIMEOUTS.connectMs + PARTNER_AUTH_DB_TIMEOUTS.queryMs + 2_000);
    } finally {
      await blocker.query('rollback');
      blocker.release();
    }
    expect(gate.stats).toEqual({ active: 0, queued: 0, priorityQueued: 0 });
    // The timed-out reservation rolled back: nothing was counted.
    expect(await accountState(stuck.userId)).toEqual({ failed_attempts: 0, locked: false, lockout_count: 0 });
    expect((await login(stuck.email, correctPassword, 172, gated)).statusCode).toBe(200);
    await gated.close();
  });

  it('fails a sign-in closed within the connect timeout when the partner pool is exhausted', async () => {
    const { email } = await activeUser('pool-exhausted');
    const held = await Promise.all(Array.from({ length: 4 }, () => partnerAuthPool.connect()));
    try {
      const started = Date.now();
      const response = await login(email, correctPassword, 180);
      expect(response.statusCode).toBe(503);
      expect(Date.now() - started).toBeLessThan(PARTNER_AUTH_DB_TIMEOUTS.connectMs + 1_500);
    } finally {
      held.forEach(client => client.release());
    }
    expect((await login(email, correctPassword, 181)).statusCode).toBe(200);
  });
  it('honours a known-device cookie only for its own active account at the current epoch', async () => {
    const gate = new PartnerAuthGate({ maxConcurrent: 1, maxQueued: 0, maxQueuedPriority: 4, queueTimeoutMs: 60_000, retryAfterSeconds: 5 });
    const gated = Fastify({ logger: false });
    await registerPartnerApi(gated, { ...routeConfig(), authGate: gate });
    const a = await activeUser('device-a');
    const b = await activeUser('device-b');
    const key = derivePartnerKeys(totpKey).knownDevice;
    const cookieFor = (userId: string, epoch: number) => `__Host-saferide_partner_device=${issueKnownDeviceToken(key, { userId, epoch }, Math.floor(Date.now() / 1000))}`;
    const signIn = (email: string, cookie: string, client: number) => gated.inject({
      method: 'POST', url: '/partner/v1/auth/login',
      headers: { host: HOST, origin: ORIGIN, 'x-real-ip': `203.0.113.${client}`, cookie },
      payload: { email, password: correctPassword },
    });
    const prioritised = async (email: string, cookie: string, client: number) => {
      const release = await gate.acquire();
      const attempt = signIn(email, cookie, client);
      // Either it takes a priority place, or it is refused at once (general queue 0).
      const outcome = await Promise.race([
        vi.waitFor(() => expect(gate.stats.priorityQueued).toBe(1), { timeout: 3_000 }).then(() => 'queued', () => 'timeout'),
        attempt.then(response => `refused ${response.statusCode}`),
      ]);
      release();
      const response = await attempt;
      return outcome === 'queued' ? `priority ${response.statusCode}` : outcome;
    };

    expect(await prioritised(a.email, cookieFor(a.userId, 0), 200)).toBe('priority 200');
    // A's cookie gives nothing on B's account.
    expect(await prioritised(b.email, cookieFor(a.userId, 0), 201)).toBe('refused 503');
    // sessions:revoke, user:reset and user:disable bump the epoch: old cookies stop working.
    await query(`update saferide.partner_users set known_device_epoch = known_device_epoch + 1 where id = $1`, [a.userId]);
    expect(await prioritised(a.email, cookieFor(a.userId, 0), 202)).toBe('refused 503');
    expect(await prioritised(a.email, cookieFor(a.userId, 1), 203)).toBe('priority 200');
    // A disabled user's cookie earns nothing, even at the current epoch.
    await query(`update saferide.partner_users set status = 'disabled', disabled_at = now() where id = $1`, [a.userId]);
    expect(await prioritised(a.email, cookieFor(a.userId, 1), 204)).toBe('refused 503');
    expect(gate.stats).toEqual({ active: 0, queued: 0, priorityQueued: 0 });
    await gated.close();
  });
});
