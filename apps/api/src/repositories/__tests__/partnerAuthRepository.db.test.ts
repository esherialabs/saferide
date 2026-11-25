/**
 * Partner auth SQL against a real, disposable PostgreSQL (migrations 000-007
 * applied). Skipped unless SAFERIDE_TEST_DATABASE_URL is set. Synthetic data only.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  completePartnerEnrollment,
  completePartnerMfa,
  completePartnerPasswordChange,
  findPartnerEnrollment,
  getPartnerProfile,
  reservePartnerLoginAttempt,
  reservePartnerPasswordCheck,
  reservePartnerTotpAttempt,
  resolvePartnerSession,
  updatePartnerCoverage,
  settlePartnerAuthFailure,
  startPartnerSessionAfterPassword,
  storePendingPartnerTotpSecret,
  storeSignInTotpSecret,
} from '../partnerAuthRepository.js';
import { closeDb, query } from '../../plugins/db.js';
import { generatePartnerToken, hashPartnerToken } from '../../services/partnerTokens.js';

vi.mock('../../config/env.js', () => ({
  env: { databaseUrl: process.env.SAFERIDE_TEST_DATABASE_URL ?? 'postgres://unused.invalid/none' },
}));

const enabled = Boolean(process.env.SAFERIDE_TEST_DATABASE_URL);
/** Shape-valid sealed value (v1.<iv>.<tag>.<ciphertext>) for rows whose secret is not under test. */
const SEALED_PLACEHOLDER = `v1.${'A'.repeat(16)}.${'B'.repeat(22)}.${'C'.repeat(27)}`;
const run = randomUUID().slice(0, 8);
let orgId: string;

async function activeUser(label: string): Promise<{ userId: string; email: string }> {
  const email = `${label}-${run}@example.invalid`;
  const { rows } = await query<{ id: string }>(
    `insert into saferide.partner_users (org_id, email, display_name, role, status, password_hash, totp_secret_enc, totp_enrolled_at)
     values ($1, $2, 'Synthetic user', 'partner_caseworker', 'active', 'scrypt$synthetic-test', $3, now())
     returning id`,
    [orgId, email, SEALED_PLACEHOLDER],
  );
  return { userId: rows[0].id, email };
}

async function fullSession(userId: string): Promise<string> {
  const token = generatePartnerToken('session');
  await query(
    `insert into saferide.partner_sessions (token_hash, user_id, org_id, mfa_verified, idle_expires_at, absolute_expires_at)
     values ($1, $2, $3, true, now() + interval '30 minutes', now() + interval '12 hours')`,
    [hashPartnerToken(token), userId, orgId],
  );
  return hashPartnerToken(token);
}

async function minutesUntil(column: 'locked_until', userId: string): Promise<number> {
  const { rows } = await query<{ minutes: string }>(
    `select extract(epoch from (${column} - now())) / 60 as minutes from saferide.partner_users where id = $1`,
    [userId],
  );
  return Number(rows[0].minutes);
}

describe.skipIf(!enabled)('partner auth SQL against PostgreSQL', () => {
  beforeAll(async () => {
    const { rows } = await query<{ id: string }>(
      `insert into saferide.partner_organizations (stable_id, display_name) values ($1, 'Synthetic auth org') returning id`,
      [`auth-test-${run}`],
    );
    orgId = rows[0].id;
  });

  afterAll(async () => {
    await closeDb();
  });

  it('explicit coverage renews the lease, stops normally and cannot be revived by a heartbeat', async () => {
    const { userId } = await activeUser('coverage');
    const tokenHash = await fullSession(userId);
    const on = await updatePartnerCoverage({ tokenHash, enabled: true, requestId: randomUUID() });
    expect(on).toMatchObject({ coverageActive: true, coverageEpoch: 1 });
    expect(on!.absoluteExpiresAt.getTime() - Date.now()).toBeGreaterThan(11.9 * 60 * 60_000);
    await query(`update saferide.partner_sessions set idle_expires_at = now() + interval '1 minute', absolute_expires_at = now() + interval '1 minute' where token_hash = $1`, [tokenHash]);
    const renewed = await updatePartnerCoverage({ tokenHash, requestId: randomUUID() });
    expect(renewed!.absoluteExpiresAt.getTime() - Date.now()).toBeGreaterThan(11.9 * 60 * 60_000);
    const off = await updatePartnerCoverage({ tokenHash, enabled: false, requestId: randomUUID() });
    expect(off).toMatchObject({ coverageActive: false, coverageEpoch: 2 });
    expect(off!.idleExpiresAt.getTime() - Date.now()).toBeLessThanOrEqual(30 * 60_000);
    expect(await updatePartnerCoverage({ tokenHash, requestId: randomUUID() })).toBeNull();
    await updatePartnerCoverage({ tokenHash, enabled: true, requestId: randomUUID() });
    await query(`update saferide.partner_sessions set idle_expires_at = now() - interval '1 second' where token_hash = $1`, [tokenHash]);
    expect(await updatePartnerCoverage({ tokenHash, requestId: randomUUID() })).toBeNull();
    expect(await updatePartnerCoverage({ tokenHash, enabled: true, requestId: randomUUID() })).toBeNull();
  });

  it('coverage respects operator revocation and disabled accounts', async () => {
    const { userId } = await activeUser('coverage-disabled');
    const tokenHash = await fullSession(userId);
    await updatePartnerCoverage({ tokenHash, enabled: true, requestId: randomUUID() });
    await query(`update saferide.partner_users set status = 'disabled', disabled_at = now() where id = $1`, [userId]);
    expect(await updatePartnerCoverage({ tokenHash, requestId: randomUUID() })).toBeNull();
    const other = await activeUser('coverage-revoked');
    const revokedHash = await fullSession(other.userId);
    await query(`update saferide.partner_sessions set revoked_at = now(), revoke_reason = 'logout' where token_hash = $1`, [revokedHash]);
    expect(await updatePartnerCoverage({ tokenHash: revokedHash, enabled: true, requestId: randomUUID() })).toBeNull();
  });

  async function failedAttempt(email: string): Promise<{ reserved: boolean; lockedNow: boolean }> {
    const reservation = await reservePartnerLoginAttempt(email);
    const { lockedNow } = await settlePartnerAuthFailure(reservation.reserved ? reservation.userId : null);
    return { reserved: reservation.reserved, lockedNow };
  }

  async function counters(userId: string) {
    const { rows } = await query<{ failed_attempts: number; lockout_count: number; locked: boolean }>(
      `select failed_attempts, lockout_count, coalesce(locked_until > now(), false) as locked
       from saferide.partner_users where id = $1`,
      [userId],
    );
    return rows[0];
  }

  it('locks after ten failures for 5 minutes, doubling per lockout, capped at 60', async () => {
    const { userId, email } = await activeUser('lockout');
    for (let attempt = 1; attempt <= 9; attempt += 1) {
      await expect(failedAttempt(email)).resolves.toEqual({ reserved: true, lockedNow: false });
    }
    await expect(failedAttempt(email)).resolves.toEqual({ reserved: true, lockedNow: true });
    expect(await counters(userId)).toEqual({ failed_attempts: 0, lockout_count: 1, locked: true });
    expect(await minutesUntil('locked_until', userId)).toBeCloseTo(5, 0);

    await query(`update saferide.partner_users set locked_until = now() - interval '1 second' where id = $1`, [userId]);
    for (let attempt = 1; attempt <= 10; attempt += 1) await failedAttempt(email);
    expect(await minutesUntil('locked_until', userId)).toBeCloseTo(10, 0);

    await query(`update saferide.partner_users set locked_until = now() - interval '1 second', lockout_count = 8 where id = $1`, [userId]);
    for (let attempt = 1; attempt <= 10; attempt += 1) await failedAttempt(email);
    expect(await minutesUntil('locked_until', userId)).toBeCloseTo(60, 0);
  });

  it('counts nothing while locked and reserves nothing for unknown, disabled or suspended accounts', async () => {
    const { userId, email } = await activeUser('locked-idle');
    await query(`update saferide.partner_users set locked_until = now() + interval '5 minutes' where id = $1`, [userId]);
    for (let attempt = 1; attempt <= 20; attempt += 1) {
      await expect(failedAttempt(email)).resolves.toEqual({ reserved: false, lockedNow: false });
    }
    expect(await counters(userId)).toEqual({ failed_attempts: 0, lockout_count: 0, locked: true });
    await expect(reservePartnerTotpAttempt(userId)).resolves.toMatchObject({ reserved: false, totpSecretEnc: null });

    await expect(reservePartnerLoginAttempt(`nobody-${run}@example.invalid`)).resolves.toEqual({
      userId: null, orgId: null, reserved: false, passwordHash: null,
    });
    const disabled = await activeUser('disabled');
    await query(`update saferide.partner_users set status = 'disabled', disabled_at = now() where id = $1`, [disabled.userId]);
    await expect(reservePartnerLoginAttempt(disabled.email)).resolves.toMatchObject({ userId: disabled.userId, reserved: false, passwordHash: null });
  });

  it('never grants more than ten concurrent reservations, so parallel guesses cannot exceed the limit', async () => {
    const { userId, email } = await activeUser('concurrent');
    const results = await Promise.all(Array.from({ length: 25 }, () => reservePartnerLoginAttempt(email)));
    expect(results.filter(result => result.reserved)).toHaveLength(10);
    expect(results.filter(result => result.passwordHash !== null)).toHaveLength(10);
    expect((await counters(userId)).failed_attempts).toBe(10);
  });

  it('writes no pre-MFA session once a concurrent failure has locked the account', async () => {
    const { userId, email } = await activeUser('guarded-session');
    for (let attempt = 1; attempt <= 9; attempt += 1) await failedAttempt(email);
    const correct = await reservePartnerLoginAttempt(email);
    expect(correct.reserved).toBe(true);
    // Another in-flight wrong guess settles first and trips the lock.
    await query(`update saferide.partner_users set failed_attempts = 10 where id = $1`, [userId]);
    await expect(settlePartnerAuthFailure(userId)).resolves.toEqual({ lockedNow: true });
    await expect(startPartnerSessionAfterPassword({
      tokenHash: hashPartnerToken(generatePartnerToken('session')), userId, orgId, requestId: `test-${run}`,
    })).resolves.toBeNull();
    const sessions = await query(`select 1 from saferide.partner_sessions where user_id = $1`, [userId]);
    expect(sessions.rows).toHaveLength(0);

    const { userId: freshId, email: freshEmail } = await activeUser('refund');
    await reservePartnerLoginAttempt(freshEmail);
    await expect(startPartnerSessionAfterPassword({
      tokenHash: hashPartnerToken(generatePartnerToken('session')), userId: freshId, orgId, requestId: `test-${run}`,
    })).resolves.toMatchObject({ stage: 'pre_mfa', totpEnrolled: true, session: { id: expect.any(String) } });
    expect((await counters(freshId)).failed_attempts).toBe(0);
  });

  it('locks an account stranded at ten by reservations that never settled, on its next refused attempt', async () => {
    const { userId, email } = await activeUser('stranded');
    // Ten attempts reserved, then lost before settling (a crash, an error, a sign-in race).
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      await expect(reservePartnerLoginAttempt(email)).resolves.toMatchObject({ reserved: true });
    }
    expect(await counters(userId)).toEqual({ failed_attempts: 10, lockout_count: 0, locked: false });
    // Every further attempt is refused unreserved: with no lock, nothing would ever expire.
    const refused = await reservePartnerLoginAttempt(email);
    expect(refused).toMatchObject({ userId, reserved: false, passwordHash: null });
    await expect(reservePartnerTotpAttempt(userId)).resolves.toMatchObject({ reserved: false });
    // The routes settle refused attempts against the known account, which locks it with backoff.
    await expect(settlePartnerAuthFailure(refused.userId)).resolves.toEqual({ lockedNow: true });
    expect(await counters(userId)).toEqual({ failed_attempts: 0, lockout_count: 1, locked: true });
    expect(await minutesUntil('locked_until', userId)).toBeCloseTo(5, 0);
    // Settling again while locked changes nothing, and never counts.
    await expect(settlePartnerAuthFailure(userId)).resolves.toEqual({ lockedNow: false });
    expect(await counters(userId)).toEqual({ failed_attempts: 0, lockout_count: 1, locked: true });

    await query(`update saferide.partner_users set locked_until = now() - interval '1 second' where id = $1`, [userId]);
    await expect(reservePartnerLoginAttempt(email)).resolves.toMatchObject({ reserved: true });
  });

  it('stores an upgraded password hash with the pre-MFA session only if the stored hash is unchanged', async () => {
    const { userId, email } = await activeUser('rehash');
    const original = 'scrypt$synthetic-test';
    const createSession = (passwordUpgrade: { from: string; to: string }) => startPartnerSessionAfterPassword({
      tokenHash: hashPartnerToken(generatePartnerToken('session')), userId, orgId, requestId: `test-${run}`, passwordUpgrade,
    });
    const storedHash = async () => (await query<{ password_hash: string }>(
      `select password_hash from saferide.partner_users where id = $1`, [userId],
    )).rows[0].password_hash;

    await reservePartnerLoginAttempt(email);
    await expect(createSession({ from: 'scrypt$changed-meanwhile', to: 'scrypt$synthetic-upgraded' })).resolves.toMatchObject({ stage: 'pre_mfa', session: { id: expect.any(String) } });
    expect(await storedHash()).toBe(original);

    await reservePartnerLoginAttempt(email);
    await expect(createSession({ from: original, to: 'scrypt$synthetic-upgraded' })).resolves.toMatchObject({ stage: 'pre_mfa', session: { id: expect.any(String) } });
    expect(await storedHash()).toBe('scrypt$synthetic-upgraded');
    expect((await counters(userId)).failed_attempts).toBe(0);
  });

  it('resolves sessions only of the requested kind and only while unexpired, unrevoked and active', async () => {
    const { userId } = await activeUser('sessions');
    const fullHash = await fullSession(userId);
    expect(await resolvePartnerSession(fullHash, 'full', { slideIdle: true })).toMatchObject({ userId, orgId, mfaVerified: true, role: 'partner_caseworker' });
    expect(await resolvePartnerSession(fullHash, 'pre_mfa', { slideIdle: true })).toBeNull();

    const preToken = generatePartnerToken('session');
    await startPartnerSessionAfterPassword({ tokenHash: hashPartnerToken(preToken), userId, orgId, requestId: `test-${run}` });
    expect(await resolvePartnerSession(hashPartnerToken(preToken), 'full', { slideIdle: true })).toBeNull();
    expect(await resolvePartnerSession(hashPartnerToken(preToken), 'pre_mfa', { slideIdle: true })).toMatchObject({ mfaVerified: false });
    const audit = await query(`select 1 from saferide.partner_access_audit where partner_user_id = $1 and action = 'auth.login'`, [userId]);
    expect(audit.rows).toHaveLength(1);

    await query(`update saferide.partner_sessions set idle_expires_at = now() - interval '1 second' where token_hash = $1`, [fullHash]);
    expect(await resolvePartnerSession(fullHash, 'full', { slideIdle: true })).toBeNull();

    const absoluteHash = await fullSession(userId);
    await query(
      `update saferide.partner_sessions
       set created_at = now() - interval '13 hours', absolute_expires_at = now() - interval '1 hour', idle_expires_at = now() - interval '1 hour'
       where token_hash = $1`,
      [absoluteHash],
    );
    expect(await resolvePartnerSession(absoluteHash, 'any', { slideIdle: false })).toBeNull();

    const revokedHash = await fullSession(userId);
    await query(`update saferide.partner_sessions set revoked_at = now(), revoke_reason = 'logout' where token_hash = $1`, [revokedHash]);
    expect(await resolvePartnerSession(revokedHash, 'any', { slideIdle: false })).toBeNull();

    const disabledHash = await fullSession(userId);
    await query(`update saferide.partner_users set status = 'disabled', disabled_at = now() where id = $1`, [userId]);
    expect(await resolvePartnerSession(disabledHash, 'full', { slideIdle: true })).toBeNull();
  });

  it('slides the idle expiry by 30 minutes but never past the absolute expiry', async () => {
    const { userId } = await activeUser('sliding');
    const hash = await fullSession(userId);
    await query(`update saferide.partner_sessions set idle_expires_at = now() + interval '1 minute' where token_hash = $1`, [hash]);
    const slid = await resolvePartnerSession(hash, 'full', { slideIdle: true });
    expect(((slid?.idleExpiresAt.getTime() ?? 0) - Date.now()) / 60_000).toBeCloseTo(30, 0);

    await query(
      `update saferide.partner_sessions set absolute_expires_at = now() + interval '10 minutes',
         idle_expires_at = now() + interval '1 minute' where token_hash = $1`,
      [hash],
    );
    const capped = await resolvePartnerSession(hash, 'full', { slideIdle: true });
    expect(capped?.idleExpiresAt.getTime()).toBe(capped?.absoluteExpiresAt.getTime());

    // Background polling resolves the session but never extends it.
    await query(`update saferide.partner_sessions set idle_expires_at = now() + interval '1 minute' where token_hash = $1`, [hash]);
    const before = await query<{ idle_expires_at: Date; last_seen_at: Date }>(
      `select idle_expires_at, last_seen_at from saferide.partner_sessions where token_hash = $1`, [hash],
    );
    expect(await resolvePartnerSession(hash, 'full', { slideIdle: false })).toMatchObject({ userId });
    const after = await query<{ idle_expires_at: Date; last_seen_at: Date }>(
      `select idle_expires_at, last_seen_at from saferide.partner_sessions where token_hash = $1`, [hash],
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it('upgrades a pre-MFA session once, refuses a replayed step and a locked account', async () => {
    const { userId } = await activeUser('mfa');
    await query(`update saferide.partner_users set failed_attempts = 3 where id = $1`, [userId]);
    const started = await startPartnerSessionAfterPassword({
      tokenHash: hashPartnerToken(generatePartnerToken('session')), userId, orgId, requestId: `test-${run}`,
    });
    const pre = started!.session as { id: string };
    const newToken = generatePartnerToken('session');
    const upgraded = await completePartnerMfa({
      preMfaSessionId: pre.id, userId, orgId, step: 1000, verifiedTotpSecretEnc: SEALED_PLACEHOLDER,
      newTokenHash: hashPartnerToken(newToken), requestId: `test-${run}`,
    });
    expect(upgraded).toMatchObject({ userId, orgId, mfaVerified: true });
    const retired = await query<{ revoke_reason: string }>(`select revoke_reason from saferide.partner_sessions where id = $1`, [pre.id]);
    expect(retired.rows[0].revoke_reason).toBe('mfa_upgrade');
    const counters = await query<{ failed_attempts: number; totp_last_step: string }>(
      `select failed_attempts, totp_last_step from saferide.partner_users where id = $1`, [userId],
    );
    expect(counters.rows[0]).toEqual({ failed_attempts: 0, totp_last_step: '1000' });

    const second = (await startPartnerSessionAfterPassword({
      tokenHash: hashPartnerToken(generatePartnerToken('session')), userId, orgId, requestId: `test-${run}`,
    }))!.session as { id: string };
    const replayToken = generatePartnerToken('session');
    await expect(completePartnerMfa({
      preMfaSessionId: second.id, userId, orgId, step: 1000, verifiedTotpSecretEnc: SEALED_PLACEHOLDER,
      newTokenHash: hashPartnerToken(replayToken), requestId: `test-${run}`,
    })).resolves.toBeNull();
    const untouched = await query(`select revoked_at from saferide.partner_sessions where id = $1`, [second.id]);
    expect(untouched.rows[0].revoked_at).toBeNull();
    expect(await resolvePartnerSession(hashPartnerToken(replayToken), 'any', { slideIdle: false })).toBeNull();

    await query(`update saferide.partner_users set locked_until = now() + interval '10 minutes' where id = $1`, [userId]);
    await expect(completePartnerMfa({
      preMfaSessionId: second.id, userId, orgId, step: 1001, verifiedTotpSecretEnc: SEALED_PLACEHOLDER,
      newTokenHash: hashPartnerToken(generatePartnerToken('session')), requestId: `test-${run}`,
    })).resolves.toBeNull();
    // A step verified against a secret that was replaced meanwhile activates nothing.
    await query(`update saferide.partner_users set locked_until = null where id = $1`, [userId]);
    await expect(completePartnerMfa({
      preMfaSessionId: second.id, userId, orgId, step: 1002, verifiedTotpSecretEnc: `v1.${'D'.repeat(16)}.${'E'.repeat(22)}.${'F'.repeat(27)}`,
      newTokenHash: hashPartnerToken(generatePartnerToken('session')), requestId: `test-${run}`,
    })).resolves.toBeNull();
  });

  it('consumes an enrolment token exactly once and only before it expires', async () => {
    const token = generatePartnerToken('enrollment');
    const tokenHash = hashPartnerToken(token);
    const { rows } = await query<{ id: string }>(
      `insert into saferide.partner_users (org_id, email, display_name, role, enrollment_token_hash, enrollment_expires_at)
       values ($1, $2, 'Synthetic invitee', 'partner_admin', $3, now() + interval '1 day') returning id`,
      [orgId, `invitee-${run}@example.invalid`, tokenHash],
    );
    const userId = rows[0].id;
    expect(await findPartnerEnrollment(tokenHash)).toMatchObject({ userId, totpSecretEnc: null, role: 'partner_admin' });
    await expect(completePartnerEnrollment({
      userId, orgId, tokenHash, verifiedTotpSecretEnc: SEALED_PLACEHOLDER, passwordHash: 'scrypt$synthetic', step: 5, newTokenHash: hashPartnerToken(generatePartnerToken('session')), requestId: `test-${run}`,
    })).resolves.toBeNull();

    const verifiedSecret = SEALED_PLACEHOLDER;
    const replacedSecret = `v1.${'D'.repeat(16)}.${'E'.repeat(22)}.${'F'.repeat(27)}`;
    await expect(storePendingPartnerTotpSecret({ userId, tokenHash, totpSecretEnc: verifiedSecret })).resolves.toBe(true);
    // A concurrent enrol/start replaces the secret after the code was verified against the first one.
    await expect(storePendingPartnerTotpSecret({ userId, tokenHash, totpSecretEnc: replacedSecret })).resolves.toBe(true);
    await expect(completePartnerEnrollment({
      userId, orgId, tokenHash, verifiedTotpSecretEnc: verifiedSecret, passwordHash: 'scrypt$synthetic', step: 5,
      newTokenHash: hashPartnerToken(generatePartnerToken('session')), requestId: `test-${run}`,
    })).resolves.toBeNull();
    const session = await completePartnerEnrollment({
      userId, orgId, tokenHash, verifiedTotpSecretEnc: replacedSecret, passwordHash: 'scrypt$synthetic', step: 5,
      newTokenHash: hashPartnerToken(generatePartnerToken('session')), requestId: `test-${run}`,
    });
    expect(session).toMatchObject({ userId, mfaVerified: true, role: 'partner_admin' });
    const user = await query<{ status: string; enrollment_token_hash: string | null }>(
      `select status, enrollment_token_hash from saferide.partner_users where id = $1`, [userId],
    );
    expect(user.rows[0]).toEqual({ status: 'active', enrollment_token_hash: null });
    expect(await findPartnerEnrollment(tokenHash)).toBeNull();
    await expect(completePartnerEnrollment({
      userId, orgId, tokenHash, verifiedTotpSecretEnc: SEALED_PLACEHOLDER, passwordHash: 'scrypt$synthetic', step: 6, newTokenHash: hashPartnerToken(generatePartnerToken('session')), requestId: `test-${run}`,
    })).resolves.toBeNull();
    const audit = await query(`select 1 from saferide.partner_access_audit where partner_user_id = $1 and action = 'auth.enroll.complete'`, [userId]);
    expect(audit.rows).toHaveLength(1);

    const expiredToken = hashPartnerToken(generatePartnerToken('enrollment'));
    await query(
      `insert into saferide.partner_users (org_id, email, display_name, role, enrollment_token_hash, enrollment_expires_at)
       values ($1, $2, 'Synthetic expired invitee', 'partner_caseworker', $3, now() - interval '1 minute')`,
      [orgId, `expired-${run}@example.invalid`, expiredToken],
    );
    expect(await findPartnerEnrollment(expiredToken)).toBeNull();
  });

  describe('password-only orgs and operator-issued passwords (013)', () => {
    let openOrgId: string;

    beforeAll(async () => {
      const { rows } = await query<{ id: string }>(
        `insert into saferide.partner_organizations (stable_id, display_name, mfa_required)
         values ($1, 'Synthetic password-only org', false) returning id`,
        [`auth-pw-${run}`],
      );
      openOrgId = rows[0].id;
    });

    async function passwordUser(label: string, mustChange = true): Promise<{ userId: string; email: string }> {
      const email = `${label}-${run}@example.invalid`;
      const { rows } = await query<{ id: string }>(
        `insert into saferide.partner_users (org_id, email, display_name, role, status, password_hash, must_change_password)
         values ($1, $2, 'Synthetic password user', 'partner_caseworker', 'active', 'scrypt$synthetic-test', $3)
         returning id`,
        [openOrgId, email, mustChange],
      );
      return { userId: rows[0].id, email };
    }

    const start = (userId: string, org = openOrgId) => startPartnerSessionAfterPassword({
      tokenHash: hashPartnerToken(generatePartnerToken('session')), userId, orgId: org, requestId: `test-${run}`,
    });

    it('defaults every org to MFA required and lets an active user exist without a TOTP', async () => {
      const defaults = await query<{ mfa_required: boolean }>(`select mfa_required from saferide.partner_organizations where id = $1`, [orgId]);
      expect(defaults.rows[0].mfa_required).toBe(true);
      const { userId } = await passwordUser('no-totp');
      expect(await getPartnerProfile(userId)).toMatchObject({ orgMfaRequired: false, mustChangePassword: true });
      // An enrolled TOTP still needs its sealed secret.
      await expect(query(`update saferide.partner_users set totp_enrolled_at = now() where id = $1`, [userId]))
        .rejects.toThrow(/partner_user_totp_pair/);
    });

    it('starts a full, honestly unverified session for a correct password when the org has MFA off', async () => {
      const { userId, email } = await passwordUser('direct');
      await reservePartnerLoginAttempt(email);
      await query(`update saferide.partner_users set lockout_count = 2 where id = $1`, [userId]);
      const tokenHash = hashPartnerToken(generatePartnerToken('session'));
      const started = await startPartnerSessionAfterPassword({ tokenHash, userId, orgId: openOrgId, requestId: `test-${run}` });
      expect(started).toMatchObject({
        stage: 'full', session: { userId, orgId: openOrgId, stage: 'full', mfaVerified: false, mustChangePassword: true, knownDeviceEpoch: 0 },
      });
      const stored = await query<{ mfa_verified: boolean; mfa_waived: boolean; hours: string }>(
        `select mfa_verified, mfa_waived, extract(epoch from (absolute_expires_at - created_at)) / 3600 as hours
         from saferide.partner_sessions where token_hash = $1`,
        [tokenHash],
      );
      expect(stored.rows[0]).toMatchObject({ mfa_verified: false, mfa_waived: true });
      expect(Number(stored.rows[0].hours)).toBeCloseTo(12, 1);
      // A completed sign-in resets the counters, as after a TOTP step.
      expect(await counters(userId)).toEqual({ failed_attempts: 0, lockout_count: 0, locked: false });
      expect(await resolvePartnerSession(tokenHash, 'full', { slideIdle: true })).toMatchObject({ stage: 'full', mfaVerified: false });
      expect(await resolvePartnerSession(tokenHash, 'pre_mfa', { slideIdle: true })).toBeNull();

      // Turning MFA back on ends it at once, even before any revocation.
      await query(`update saferide.partner_organizations set mfa_required = true where id = $1`, [openOrgId]);
      expect(await resolvePartnerSession(tokenHash, 'full', { slideIdle: true })).toBeNull();
      expect(await resolvePartnerSession(tokenHash, 'pre_mfa', { slideIdle: true })).toBeNull();
      expect(await resolvePartnerSession(tokenHash, 'any', { slideIdle: false })).toMatchObject({ userId });
      await query(`update saferide.partner_organizations set mfa_required = false where id = $1`, [openOrgId]);
    });

    it('refuses a session that claims both a verified and a waived MFA', async () => {
      const { userId } = await passwordUser('both');
      await expect(query(
        `insert into saferide.partner_sessions (token_hash, user_id, org_id, mfa_verified, mfa_waived, idle_expires_at, absolute_expires_at)
         values ($1, $2, $3, true, true, now() + interval '30 minutes', now() + interval '12 hours')`,
        [hashPartnerToken(generatePartnerToken('session')), userId, openOrgId],
      )).rejects.toThrow(/partner_session_mfa_waiver/);
    });

    it('makes a user without a TOTP enrol one at sign-in once the org requires MFA again', async () => {
      const { userId } = await passwordUser('re-enable', false);
      await query(`update saferide.partner_organizations set mfa_required = true where id = $1`, [openOrgId]);
      try {
        const started = await start(userId);
        expect(started).toMatchObject({ stage: 'pre_mfa', totpEnrolled: false });
        const preId = (started!.session as { id: string }).id;
        // No secret yet: the TOTP step reserves nothing.
        await expect(reservePartnerTotpAttempt(userId)).resolves.toMatchObject({ reserved: false });
        await expect(storeSignInTotpSecret({ userId, preMfaSessionId: preId, totpSecretEnc: SEALED_PLACEHOLDER })).resolves.toBe(true);
        await expect(reservePartnerTotpAttempt(userId)).resolves.toMatchObject({ reserved: true, totpSecretEnc: SEALED_PLACEHOLDER });
        const done = await completePartnerMfa({
          preMfaSessionId: preId, userId, orgId: openOrgId, step: 500, verifiedTotpSecretEnc: SEALED_PLACEHOLDER,
          newTokenHash: hashPartnerToken(generatePartnerToken('session')), requestId: `test-${run}`,
        });
        expect(done).toMatchObject({ mfaVerified: true, stage: 'full' });
        const enrolled = await query<{ enrolled: boolean }>(
          `select totp_enrolled_at is not null as enrolled from saferide.partner_users where id = $1`, [userId],
        );
        expect(enrolled.rows[0].enrolled).toBe(true);
        // Enrolled now: the next sign-in asks for a code, and setup is refused (only user:reset replaces it).
        const next = await start(userId);
        expect(next).toMatchObject({ stage: 'pre_mfa', totpEnrolled: true });
        await expect(storeSignInTotpSecret({
          userId, preMfaSessionId: (next!.session as { id: string }).id, totpSecretEnc: SEALED_PLACEHOLDER,
        })).resolves.toBe(false);
      } finally {
        await query(`update saferide.partner_organizations set mfa_required = false where id = $1`, [openOrgId]);
      }
    });

    it('changes the password once, clears the flag, revokes every session and keeps the absolute expiry', async () => {
      const { userId } = await passwordUser('change');
      const first = await start(userId);
      const other = await start(userId);
      const sessionId = (first!.session as { sessionId: string }).sessionId;
      await query(`update saferide.partner_sessions set absolute_expires_at = now() + interval '2 hours' where id = $1`, [sessionId]);
      const check = await reservePartnerPasswordCheck(userId);
      expect(check).toMatchObject({ reserved: true, passwordHash: 'scrypt$synthetic-test' });
      expect((await counters(userId)).failed_attempts).toBe(1);

      // A stale current hash (changed meanwhile) changes nothing.
      await expect(completePartnerPasswordChange({
        sessionId, userId, orgId: openOrgId, currentPasswordHash: 'scrypt$other', newPasswordHash: 'scrypt$synthetic-new',
        newTokenHash: hashPartnerToken(generatePartnerToken('session')), requestId: `test-${run}`,
      })).resolves.toBeNull();

      const newTokenHash = hashPartnerToken(generatePartnerToken('session'));
      const changed = await completePartnerPasswordChange({
        sessionId, userId, orgId: openOrgId, currentPasswordHash: 'scrypt$synthetic-test', newPasswordHash: 'scrypt$synthetic-new',
        newTokenHash, requestId: `test-${run}`,
      });
      expect(changed).toMatchObject({ stage: 'full', mfaVerified: false, mustChangePassword: false });
      expect(((changed?.absoluteExpiresAt.getTime() ?? 0) - Date.now()) / 3_600_000).toBeCloseTo(2, 1);
      const user = await query<{ password_hash: string; must_change_password: boolean; failed_attempts: number }>(
        `select password_hash, must_change_password, failed_attempts from saferide.partner_users where id = $1`, [userId],
      );
      expect(user.rows[0]).toEqual({ password_hash: 'scrypt$synthetic-new', must_change_password: false, failed_attempts: 0 });
      const sessions = await query<{ id: string; revoke_reason: string | null; mfa_waived: boolean }>(
        `select id, revoke_reason, mfa_waived from saferide.partner_sessions where user_id = $1 order by created_at`, [userId],
      );
      const otherId = (other!.session as { sessionId: string }).sessionId;
      expect(sessions.rows.find(row => row.id === sessionId)?.revoke_reason).toBe('password_change');
      expect(sessions.rows.find(row => row.id === otherId)?.revoke_reason).toBe('password_change');
      expect(sessions.rows.filter(row => row.revoke_reason === null)).toEqual([expect.objectContaining({ mfa_waived: true })]);
      expect(await resolvePartnerSession(newTokenHash, 'full', { slideIdle: false })).toMatchObject({ mustChangePassword: false });
      const audit = await query(`select 1 from saferide.partner_access_audit where partner_user_id = $1 and action = 'auth.password.change'`, [userId]);
      expect(audit.rows).toHaveLength(1);

      // The revoked session cannot change it again.
      await expect(completePartnerPasswordChange({
        sessionId, userId, orgId: openOrgId, currentPasswordHash: 'scrypt$synthetic-new', newPasswordHash: 'scrypt$synthetic-third',
        newTokenHash: hashPartnerToken(generatePartnerToken('session')), requestId: `test-${run}`,
      })).resolves.toBeNull();
    });
  });
});
