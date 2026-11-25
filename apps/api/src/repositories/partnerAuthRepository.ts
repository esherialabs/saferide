import type { PoolClient } from 'pg';

import { partnerAuthPool, query } from '../plugins/db.js';
import { recordPartnerAccess, type PartnerRole } from './partnerRepository.js';

/**
 * Session and lockout policy for the partner realm (design section 2, as
 * hardened by the #287 security review).
 *
 * Account level (database): an attempt is RESERVED, under a row lock,
 * before any scrypt or TOTP work, so concurrent requests can never evaluate
 * more than `accountMaxFailures` guesses per lock window. Ten unresolved or
 * failed attempts lock the account with exponential backoff: 5 min,
 * doubling per lockout, capped at 60 min, reset by a completed sign-in.
 * Nothing is counted while the account is locked.
 *
 * Client x account level (Redis, services/partnerRateLimit.ts): five
 * failures from one client against one account block that client for that
 * account (15 min, doubling, capped at 24 h). A single attacker is stopped
 * long before the account itself locks, which limits targeted lockout DoS
 * against the real user signing in from elsewhere.
 */
export const PARTNER_SESSION_POLICY = {
  preMfaSeconds: 5 * 60,
  idleSeconds: 30 * 60,
  absoluteSeconds: 12 * 60 * 60,
  accountMaxFailures: 10,
  accountBaseLockMinutes: 5,
  accountMaxLockMinutes: 60,
} as const;

/** Never matches a row; keeps the no-account paths doing the same statements. */
const NO_USER_ID = '00000000-0000-0000-0000-000000000000';

export type PartnerSessionKind = 'full' | 'pre_mfa' | 'any';

/**
 * A partner session as stored. `stage` says what it may do: 'pre_mfa' is
 * the 5-minute password-only step that only the TOTP routes and logout
 * accept; 'full' is signed in. `mfaVerified` says what actually happened:
 * true only when a TOTP code was checked. A full session with
 * mfaVerified false is a password-only sign-in in an org whose MFA is off
 * (migration 013: mfa_waived), and it stops resolving as full as soon as
 * the org requires MFA again.
 */
export type PartnerSessionRecord = {
  sessionId: string;
  userId: string;
  orgId: string;
  orgStableId: string;
  role: PartnerRole;
  stage: 'pre_mfa' | 'full';
  mfaVerified: boolean;
  /** An operator issued this user's password: until they choose their own, only /me, change-password and logout work. */
  mustChangePassword: boolean;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
  coverageActive?: boolean;
  coverageEpoch?: number;
};

/**
 * Result of reserving one sign-in attempt. `userId`/`orgId` identify a known
 * account (for the audit) even when no attempt was reserved; `passwordHash`
 * is returned only with a reservation.
 */
export type PartnerLoginReservation = {
  userId: string | null;
  orgId: string | null;
  reserved: boolean;
  passwordHash: string | null;
};

/** A completed sign-in: the full session plus the user's known-device epoch (migration 012). */
export type PartnerSignInRecord = PartnerSessionRecord & { knownDeviceEpoch: number };

export type PartnerTotpReservation = {
  reserved: boolean;
  totpSecretEnc: string | null;
  totpLastStep: number | null;
};

export type PartnerEnrollmentRecord = {
  userId: string;
  orgId: string;
  email: string;
  displayName: string;
  role: PartnerRole;
  orgDisplayName: string;
  totpSecretEnc: string | null;
};

export type PartnerProfile = {
  userId: string;
  email: string;
  displayName: string;
  role: PartnerRole;
  orgId: string;
  orgStableId: string;
  orgDisplayName: string;
  orgMfaRequired: boolean;
  mustChangePassword: boolean;
};

type SessionRow = {
  id: string;
  user_id: string;
  org_id: string;
  stable_id: string;
  role: PartnerRole;
  mfa_verified: boolean;
  mfa_waived: boolean;
  must_change_password: boolean;
  idle_expires_at: Date | string;
  absolute_expires_at: Date | string;
  coverage_active?: boolean;
  coverage_epoch?: number;
};

function mapSession(row: SessionRow): PartnerSessionRecord {
  return {
    sessionId: row.id,
    userId: row.user_id,
    orgId: row.org_id,
    orgStableId: row.stable_id,
    role: row.role,
    stage: row.mfa_verified || row.mfa_waived ? 'full' : 'pre_mfa',
    mfaVerified: row.mfa_verified,
    mustChangePassword: row.must_change_password,
    idleExpiresAt: new Date(row.idle_expires_at),
    absoluteExpiresAt: new Date(row.absolute_expires_at),
    coverageActive: row.coverage_active === true,
    coverageEpoch: row.coverage_epoch ?? 0,
  };
}

/**
 * One transaction on the bounded partner sign-in pool (plugins/db.ts): a
 * stalled database fails it within seconds instead of holding the caller's
 * gate slot. On any failure the connection is discarded rather than rolled
 * back over the wire (which could stall again); PostgreSQL rolls the
 * transaction back when the connection closes.
 */
export async function withPartnerAuthTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await partnerAuthPool.connect();
  try {
    await client.query('begin');
    const result = await work(client);
    await client.query('commit');
    client.release();
    return result;
  } catch (error) {
    client.release(error instanceof Error ? error : true);
    throw error;
  }
}

/**
 * The active account (active user in an active org) for an email, with its
 * known-device epoch, for checking a known-device cookie before the gate.
 */
export async function findPartnerKnownDeviceAccount(email: string): Promise<{ userId: string; epoch: number } | null> {
  const { rows } = await partnerAuthPool.query<{ id: string; known_device_epoch: number }>(
    `select u.id, u.known_device_epoch
     from saferide.partner_users u join saferide.partner_organizations o on o.id = u.org_id
     where u.email = $1 and u.status = 'active' and o.status = 'active'`,
    [email],
  );
  return rows[0] ? { userId: rows[0].id, epoch: rows[0].known_device_epoch } : null;
}

const ELIGIBLE_FOR_ATTEMPT = `
  u.status = 'active' and o.status = 'active'
  and (u.locked_until is null or u.locked_until <= now())
  and u.failed_attempts < $2::int`;

/**
 * Reserves one password attempt for this email before the password is
 * checked: under a row lock, an eligible account (active user and org, not
 * locked, fewer than the maximum unresolved/failed attempts) has
 * failed_attempts incremented. Every path runs the same two statements.
 */
export async function reservePartnerLoginAttempt(email: string): Promise<PartnerLoginReservation> {
  return withPartnerAuthTransaction(async client => {
    const { rows } = await client.query<{ id: string; org_id: string; password_hash: string | null; eligible: boolean }>(
      `select u.id, u.org_id, u.password_hash, (${ELIGIBLE_FOR_ATTEMPT}) as eligible
       from saferide.partner_users u
       join saferide.partner_organizations o on o.id = u.org_id
       where u.email = $1
       for update of u`,
      [email, PARTNER_SESSION_POLICY.accountMaxFailures],
    );
    const row = rows[0];
    const reserved = Boolean(row?.eligible);
    await client.query(
      `update saferide.partner_users set failed_attempts = failed_attempts + 1 where id = $1 and $2::boolean`,
      [row?.id ?? NO_USER_ID, reserved],
    );
    return {
      userId: row?.id ?? null,
      orgId: row?.org_id ?? null,
      reserved,
      passwordHash: reserved ? row?.password_hash ?? null : null,
    };
  });
}

/** Reserves one TOTP attempt for a password-verified user, exactly like a password attempt. */
export async function reservePartnerTotpAttempt(userId: string): Promise<PartnerTotpReservation> {
  return withPartnerAuthTransaction(async client => {
    const { rows } = await client.query<{ totp_secret_enc: string | null; totp_last_step: string | number | null; eligible: boolean }>(
      `select u.totp_secret_enc, u.totp_last_step, (${ELIGIBLE_FOR_ATTEMPT} and u.totp_secret_enc is not null) as eligible
       from saferide.partner_users u
       join saferide.partner_organizations o on o.id = u.org_id
       where u.id = $1
       for update of u`,
      [userId, PARTNER_SESSION_POLICY.accountMaxFailures],
    );
    const row = rows[0];
    const reserved = Boolean(row?.eligible);
    await client.query(
      `update saferide.partner_users set failed_attempts = failed_attempts + 1 where id = $1 and $2::boolean`,
      [row ? userId : NO_USER_ID, reserved],
    );
    return {
      reserved,
      totpSecretEnc: reserved ? row?.totp_secret_enc ?? null : null,
      totpLastStep: reserved && row?.totp_last_step != null ? Number(row.totp_last_step) : null,
    };
  });
}

/**
 * Reserves one current-password check for a signed-in user (POST
 * /auth/change-password), exactly like a sign-in attempt, so a stolen
 * session cannot guess the password faster than the sign-in form allows.
 */
export async function reservePartnerPasswordCheck(userId: string): Promise<{ reserved: boolean; passwordHash: string | null; email: string | null }> {
  return withPartnerAuthTransaction(async client => {
    const { rows } = await client.query<{ email: string; password_hash: string | null; eligible: boolean }>(
      `select u.email, u.password_hash, (${ELIGIBLE_FOR_ATTEMPT}) as eligible
       from saferide.partner_users u
       join saferide.partner_organizations o on o.id = u.org_id
       where u.id = $1
       for update of u`,
      [userId, PARTNER_SESSION_POLICY.accountMaxFailures],
    );
    const row = rows[0];
    const reserved = Boolean(row?.eligible);
    await client.query(
      `update saferide.partner_users set failed_attempts = failed_attempts + 1 where id = $1 and $2::boolean`,
      [row ? userId : NO_USER_ID, reserved],
    );
    return { reserved, passwordHash: reserved ? row?.password_hash ?? null : null, email: row?.email ?? null };
  });
}

/**
 * Settles a refused attempt: if the account has reached the maximum and is
 * not already locked, lock it with exponential backoff and clear the
 * counter. It never counts anything itself. Routes call it for every
 * refused attempt against a known account, reserved or not: a reservation
 * that is never settled (a crash or error between reserve and settle, or a
 * sign-in race) can leave the counter at the maximum with no lock, where
 * every later attempt is refused unreserved and the account would stay shut
 * with no lock to expire. Pass null for no account; the same statements run.
 */
export async function settlePartnerAuthFailure(userId: string | null): Promise<{ lockedNow: boolean }> {
  const policy = PARTNER_SESSION_POLICY;
  return withPartnerAuthTransaction(async client => {
    const { rows } = await client.query<{ failed_attempts: number; locked: boolean }>(
      `select failed_attempts, coalesce(locked_until > now(), false) as locked
       from saferide.partner_users where id = $1 for update`,
      [userId ?? NO_USER_ID],
    );
    const row = rows[0];
    const lockNow = row !== undefined && !row.locked && row.failed_attempts >= policy.accountMaxFailures;
    await client.query(
      `update saferide.partner_users
       set failed_attempts = 0, lockout_count = lockout_count + 1,
           locked_until = now() + make_interval(mins => least(
             $2::double precision * power(2, least(lockout_count, 16)), $3::double precision
           )::int)
       where id = $1 and $4::boolean`,
      [userId ?? NO_USER_ID, policy.accountBaseLockMinutes, policy.accountMaxLockMinutes, lockNow],
    );
    return { lockedNow: lockNow };
  });
}

const SESSION_INSERT = `
  insert into saferide.partner_sessions (
    token_hash, user_id, org_id, mfa_verified, mfa_waived, idle_expires_at, absolute_expires_at
  ) values ($1, $2, $3, $4, $5, now() + make_interval(secs => $6::double precision), now() + make_interval(secs => $7::double precision))
  returning id, idle_expires_at, absolute_expires_at
`;

/**
 * How a session came to be:
 *   pre_mfa  - password checked, TOTP step pending (5 minutes);
 *   totp     - password and TOTP (or enrolment) checked: full;
 *   password - password checked in an org with MFA off: full, mfa_verified false.
 */
type SessionGrant = 'pre_mfa' | 'totp' | 'password';

type Queryable = Pick<PoolClient, 'query'>;

/** Thrown inside a transaction to roll it back when a guard fails. */
class GuardRejected extends Error {}

async function guardedTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T | null> {
  try {
    return await withPartnerAuthTransaction(work);
  } catch (error) {
    if (error instanceof GuardRejected) return null;
    throw error;
  }
}

async function insertSession(
  client: Queryable,
  params: { tokenHash: string; userId: string; orgId: string; grant: SessionGrant },
): Promise<{ id: string; idleExpiresAt: Date; absoluteExpiresAt: Date }> {
  const policy = PARTNER_SESSION_POLICY;
  const full = params.grant !== 'pre_mfa';
  const lifetime = full ? policy.absoluteSeconds : policy.preMfaSeconds;
  const idle = full ? policy.idleSeconds : policy.preMfaSeconds;
  const values = [
    params.tokenHash, params.userId, params.orgId, params.grant === 'totp', params.grant === 'password', idle, lifetime,
  ];
  const result = await client.query<{ id: string; idle_expires_at: Date | string; absolute_expires_at: Date | string }>(
    SESSION_INSERT, values,
  );
  const row = result.rows[0];
  return { id: row.id, idleExpiresAt: new Date(row.idle_expires_at), absoluteExpiresAt: new Date(row.absolute_expires_at) };
}

/** The outcome of a correct password: the TOTP step (with or without an authenticator yet), or a full session. */
export type PartnerPasswordStepResult =
  | { stage: 'pre_mfa'; totpEnrolled: boolean; session: { id: string; idleExpiresAt: Date; absoluteExpiresAt: Date } }
  | { stage: 'full'; session: PartnerSignInRecord };

/**
 * After a correct password on a reserved attempt: in one transaction, and
 * only if the account is STILL eligible (not locked by a concurrent failure,
 * user and org active), store an upgraded password hash if one is given
 * and audit, then:
 *   - org requires MFA (the default): refund the reservation and start the
 *     5-minute pre-MFA session that only the TOTP routes and logout accept.
 *     `totpEnrolled` false means the user must set up an authenticator now
 *     (POST /auth/totp/setup), e.g. after the org turned MFA back on;
 *   - org MFA off (`org:mfa --state off`): the sign-in is complete, so the
 *     failure counters reset as after a TOTP step, and a full session starts
 *     with mfa_verified false and mfa_waived true.
 * Returns null, creating nothing, if a concurrent failure locked the account.
 */
export async function startPartnerSessionAfterPassword(params: {
  tokenHash: string;
  userId: string;
  orgId: string;
  requestId: string;
  /** A rehash of the verified password at the current cost; stored only if the hash is still `from`. */
  passwordUpgrade?: { from: string; to: string };
}): Promise<PartnerPasswordStepResult | null> {
  return guardedTransaction<PartnerPasswordStepResult>(async client => {
    const { rows } = await client.query<{
      role: PartnerRole; stable_id: string; mfa_required: boolean; totp_enrolled: boolean;
      must_change_password: boolean; known_device_epoch: number;
    }>(
      `select u.role, o.stable_id, o.mfa_required, (u.totp_enrolled_at is not null) as totp_enrolled,
              u.must_change_password, u.known_device_epoch
       from saferide.partner_users u
       join saferide.partner_organizations o on o.id = u.org_id
       where u.id = $1 and u.org_id = $2
         and u.status = 'active' and o.status = 'active'
         and (u.locked_until is null or u.locked_until <= now())
       for update of u`,
      [params.userId, params.orgId],
    );
    const account = rows[0];
    if (!account) throw new GuardRejected();
    if (account.mfa_required) {
      await client.query(
        `update saferide.partner_users set failed_attempts = greatest(failed_attempts - 1, 0) where id = $1`,
        [params.userId],
      );
    } else {
      await client.query(
        `update saferide.partner_users
         set failed_attempts = 0, lockout_count = 0, locked_until = null, last_login_at = now()
         where id = $1`,
        [params.userId],
      );
    }
    if (params.passwordUpgrade) {
      // Compare-and-set: a password changed meanwhile is never overwritten.
      await client.query(
        `update saferide.partner_users set password_hash = $3 where id = $1 and password_hash = $2`,
        [params.userId, params.passwordUpgrade.from, params.passwordUpgrade.to],
      );
    }
    const grant: SessionGrant = account.mfa_required ? 'pre_mfa' : 'password';
    const session = await insertSession(client, { ...params, grant });
    await recordPartnerAccess({
      orgId: params.orgId,
      actor: { type: 'partner_user', userId: params.userId },
      action: 'auth.login',
      outcome: 'success',
      requestId: params.requestId,
    }, client);
    if (grant === 'pre_mfa') return { stage: 'pre_mfa', totpEnrolled: account.totp_enrolled, session };
    return {
      stage: 'full',
      session: {
        sessionId: session.id,
        userId: params.userId,
        orgId: params.orgId,
        orgStableId: account.stable_id,
        role: account.role,
        stage: 'full',
        mfaVerified: false,
        mustChangePassword: account.must_change_password,
        knownDeviceEpoch: account.known_device_epoch,
        idleExpiresAt: session.idleExpiresAt,
        absoluteExpiresAt: session.absoluteExpiresAt,
      },
    };
  });
}

/**
 * A full session is one with a verified TOTP, or a password-only one
 * (mfa_waived) while its org still has MFA off. A pre-MFA session is
 * neither. 'any' (logout) takes every live session.
 */
const SESSION_RESOLVE_FILTER = `
  s.token_hash = $1
  and s.revoked_at is null
  and s.idle_expires_at > now()
  and s.absolute_expires_at > now()
  and (
    $2::text = 'any'
    or ($2::text = 'full' and (s.mfa_verified or (s.mfa_waived and not o.mfa_required)))
    or ($2::text = 'pre_mfa' and not s.mfa_verified and not s.mfa_waived)
  )
  and u.id = s.user_id and u.status = 'active'
  and o.id = s.org_id and o.status = 'active'`;
const SESSION_RESOLVE_COLUMNS = `s.id, s.user_id, s.org_id, o.stable_id, u.role, s.mfa_verified, s.mfa_waived,
  u.must_change_password, s.idle_expires_at, s.absolute_expires_at, s.coverage_active, s.coverage_epoch`;

/**
 * Resolves a session by token hash. Expired, revoked, wrong-kind sessions
 * and sessions of disabled users or suspended orgs resolve to null. Only a
 * user-initiated request (`slideIdle`) extends the idle expiry, by 30 min
 * and never past the absolute expiry; background polling does not.
 */
export async function resolvePartnerSession(
  tokenHash: string,
  kind: PartnerSessionKind,
  options: { slideIdle: boolean },
): Promise<PartnerSessionRecord | null> {
  if (!options.slideIdle) {
    const { rows } = await query<SessionRow>(
      `select ${SESSION_RESOLVE_COLUMNS}
       from saferide.partner_sessions s, saferide.partner_users u, saferide.partner_organizations o
       where ${SESSION_RESOLVE_FILTER}`,
      [tokenHash, kind],
    );
    return rows[0] ? mapSession(rows[0]) : null;
  }
  const { rows } = await query<SessionRow>(
    `update saferide.partner_sessions s
     set last_seen_at = now(),
         idle_expires_at = case when s.coverage_active then s.absolute_expires_at else least(
           now() + make_interval(secs => case when s.mfa_verified or s.mfa_waived then $3::double precision else $4::double precision end),
           s.absolute_expires_at
         ) end
     from saferide.partner_users u, saferide.partner_organizations o
     where ${SESSION_RESOLVE_FILTER}
     returning ${SESSION_RESOLVE_COLUMNS}`,
    [tokenHash, kind, PARTNER_SESSION_POLICY.idleSeconds, PARTNER_SESSION_POLICY.preMfaSeconds],
  );
  return rows[0] ? mapSession(rows[0]) : null;
}

/** Explicit monitoring mode: a live authorized session may renew a 12-hour lease.
 * Normal sessions and pre-MFA sessions retain their existing idle/absolute limits.
 * A heartbeat cannot revive an expired/revoked session or switch coverage on.
 */
export async function updatePartnerCoverage(params: { tokenHash: string; enabled?: boolean; requestId: string }): Promise<PartnerSessionRecord | null> {
  return withPartnerAuthTransaction(async client => {
    const { rows } = await client.query<SessionRow>(
      `update saferide.partner_sessions s set
         coverage_epoch = s.coverage_epoch + case when $3::boolean is not null and $3 is distinct from s.coverage_active then 1 else 0 end,
         coverage_active = coalesce($3::boolean, s.coverage_active),
         coverage_renewed_at = case when coalesce($3::boolean, s.coverage_active) then now() else s.coverage_renewed_at end,
         absolute_expires_at = case when coalesce($3::boolean, s.coverage_active) then now() + make_interval(secs => $4::double precision) else s.absolute_expires_at end,
         idle_expires_at = case when coalesce($3::boolean, s.coverage_active) then now() + make_interval(secs => $4::double precision)
           else least(now() + make_interval(secs => $5::double precision), s.absolute_expires_at) end,
         last_seen_at = now()
       from saferide.partner_users u, saferide.partner_organizations o
       where ${SESSION_RESOLVE_FILTER} and not u.must_change_password
         and ($3::boolean is not null or s.coverage_active)
       returning ${SESSION_RESOLVE_COLUMNS}`,
      [params.tokenHash, 'full', params.enabled ?? null, PARTNER_SESSION_POLICY.absoluteSeconds, PARTNER_SESSION_POLICY.idleSeconds],
    );
    if (!rows[0]) return null;
    const session = mapSession(rows[0]);
    if (params.enabled !== undefined) {
      await recordPartnerAccess({ orgId: session.orgId, actor: { type: 'partner_user', userId: session.userId },
        action: 'partner.coverage.change', outcome: 'success', requestId: params.requestId }, client);
    }
    return session;
  });
}

export async function revokePartnerSession(sessionId: string, reason: 'logout' | 'user_disabled'): Promise<boolean> {
  const { rowCount } = await query(
    `update saferide.partner_sessions set revoked_at = now(), revoke_reason = $2
     where id = $1 and revoked_at is null`,
    [sessionId, reason],
  );
  return rowCount === 1;
}

/**
 * Completes sign-in in one transaction: records the TOTP step (refusing a
 * replayed or older step and a locked account), resets the failure
 * counters, retires the pre-MFA session and issues a fresh full session
 * with a new token, then audits. The step is pinned to the exact sealed
 * secret it was verified against (`verifiedTotpSecretEnc`), so a secret
 * replaced meanwhile (POST /auth/totp/setup) activates nothing. The first
 * code for a secret set up at sign-in also marks the TOTP enrolled.
 * Returns null if any guard fails.
 */
export async function completePartnerMfa(params: {
  preMfaSessionId: string;
  userId: string;
  orgId: string;
  step: number;
  verifiedTotpSecretEnc: string;
  newTokenHash: string;
  requestId: string;
}): Promise<PartnerSignInRecord | null> {
  return guardedTransaction<PartnerSignInRecord>(async client => {
    const user = await client.query<{
      role: PartnerRole; stable_id: string; known_device_epoch: number; must_change_password: boolean;
    }>(
      `update saferide.partner_users u
       set totp_last_step = $2, totp_enrolled_at = coalesce(u.totp_enrolled_at, now()),
           failed_attempts = 0, lockout_count = 0, locked_until = null, last_login_at = now()
       from saferide.partner_organizations o
       where u.id = $1 and o.id = u.org_id and o.id = $3 and u.status = 'active' and o.status = 'active'
         and u.totp_secret_enc = $4
         and (u.totp_last_step is null or u.totp_last_step < $2)
         and (u.locked_until is null or u.locked_until <= now())
       returning u.role, o.stable_id, u.known_device_epoch, u.must_change_password`,
      [params.userId, params.step, params.orgId, params.verifiedTotpSecretEnc],
    );
    if (user.rows.length !== 1) {
      throw new GuardRejected();
    }
    const retired = await client.query(
      `update saferide.partner_sessions set revoked_at = now(), revoke_reason = 'mfa_upgrade'
       where id = $1 and user_id = $2 and mfa_verified = false and mfa_waived = false and revoked_at is null`,
      [params.preMfaSessionId, params.userId],
    );
    if (retired.rowCount !== 1) {
      throw new GuardRejected();
    }
    const session = await insertSession(client, {
      tokenHash: params.newTokenHash, userId: params.userId, orgId: params.orgId, grant: 'totp',
    });
    await recordPartnerAccess({
      orgId: params.orgId,
      actor: { type: 'partner_user', userId: params.userId },
      action: 'auth.totp',
      outcome: 'success',
      requestId: params.requestId,
    }, client);
    return {
      sessionId: session.id,
      userId: params.userId,
      orgId: params.orgId,
      orgStableId: user.rows[0].stable_id,
      knownDeviceEpoch: user.rows[0].known_device_epoch,
      role: user.rows[0].role,
      stage: 'full',
      mfaVerified: true,
      mustChangePassword: user.rows[0].must_change_password,
      idleExpiresAt: session.idleExpiresAt,
      absoluteExpiresAt: session.absoluteExpiresAt,
    };
  });
}

/**
 * Sign-in enrolment (POST /auth/totp/setup): a password-verified user
 * without a TOTP, in an org that requires MFA, stores a new pending sealed
 * secret; their next good code at POST /auth/totp enrols it. Refused for a
 * user who already has an authenticator (only `user:reset` replaces one)
 * and outside a live pre-MFA session. Restarting replaces the pending secret.
 */
export async function storeSignInTotpSecret(params: {
  userId: string;
  preMfaSessionId: string;
  totpSecretEnc: string;
}): Promise<boolean> {
  const { rowCount } = await query(
    `update saferide.partner_users u
     set totp_secret_enc = $3, totp_last_step = null
     from saferide.partner_organizations o, saferide.partner_sessions s
     where u.id = $1 and o.id = u.org_id and u.status = 'active' and o.status = 'active' and o.mfa_required
       and u.totp_enrolled_at is null
       and s.id = $2 and s.user_id = u.id and s.revoked_at is null
       and not s.mfa_verified and not s.mfa_waived
       and s.idle_expires_at > now() and s.absolute_expires_at > now()`,
    [params.userId, params.preMfaSessionId, params.totpSecretEnc],
  );
  return rowCount === 1;
}

/**
 * Completes POST /auth/change-password in one transaction, after the
 * current password was verified on a reserved attempt: stores the new hash
 * (only if the hash is still the one verified), clears must_change_password,
 * refunds the reservation, revokes EVERY session of the user (reason
 * password_change) and issues a fresh session that keeps the old one's
 * kind (TOTP-verified or password-only) and its absolute expiry, so a
 * password change never extends a sign-in. Audits. Returns null, changing
 * nothing, if any guard fails.
 */
export async function completePartnerPasswordChange(params: {
  sessionId: string;
  userId: string;
  orgId: string;
  currentPasswordHash: string;
  newPasswordHash: string;
  newTokenHash: string;
  requestId: string;
}): Promise<PartnerSignInRecord | null> {
  return guardedTransaction<PartnerSignInRecord>(async client => {
    const user = await client.query<{ role: PartnerRole; stable_id: string; known_device_epoch: number }>(
      `update saferide.partner_users u
       set password_hash = $4, must_change_password = false, failed_attempts = greatest(u.failed_attempts - 1, 0)
       from saferide.partner_organizations o
       where u.id = $1 and u.org_id = $2 and o.id = u.org_id and u.status = 'active' and o.status = 'active'
         and u.password_hash = $3
         and (u.locked_until is null or u.locked_until <= now())
       returning u.role, o.stable_id, u.known_device_epoch`,
      [params.userId, params.orgId, params.currentPasswordHash, params.newPasswordHash],
    );
    if (user.rows.length !== 1) throw new GuardRejected();
    const current = await client.query<{ mfa_verified: boolean; mfa_waived: boolean; absolute_expires_at: Date | string }>(
      `update saferide.partner_sessions
       set revoked_at = now(), revoke_reason = 'password_change'
       where id = $1 and user_id = $2 and revoked_at is null and (mfa_verified or mfa_waived)
         and idle_expires_at > now() and absolute_expires_at > now()
       returning mfa_verified, mfa_waived, absolute_expires_at`,
      [params.sessionId, params.userId],
    );
    if (current.rows.length !== 1) throw new GuardRejected();
    await client.query(
      `update saferide.partner_sessions set revoked_at = now(), revoke_reason = 'password_change'
       where user_id = $1 and revoked_at is null`,
      [params.userId],
    );
    const old = current.rows[0];
    const inserted = await client.query<{ id: string; idle_expires_at: Date | string; absolute_expires_at: Date | string }>(
      `insert into saferide.partner_sessions (
         token_hash, user_id, org_id, mfa_verified, mfa_waived, idle_expires_at, absolute_expires_at
       ) values ($1, $2, $3, $4, $5, least(now() + make_interval(secs => $6::double precision), $7::timestamptz), $7::timestamptz)
       returning id, idle_expires_at, absolute_expires_at`,
      [
        params.newTokenHash, params.userId, params.orgId, old.mfa_verified, old.mfa_waived,
        PARTNER_SESSION_POLICY.idleSeconds, new Date(old.absolute_expires_at),
      ],
    );
    await recordPartnerAccess({
      orgId: params.orgId,
      actor: { type: 'partner_user', userId: params.userId },
      action: 'auth.password.change',
      outcome: 'success',
      requestId: params.requestId,
    }, client);
    const row = inserted.rows[0];
    return {
      sessionId: row.id,
      userId: params.userId,
      orgId: params.orgId,
      orgStableId: user.rows[0].stable_id,
      knownDeviceEpoch: user.rows[0].known_device_epoch,
      role: user.rows[0].role,
      stage: 'full',
      mfaVerified: old.mfa_verified,
      mustChangePassword: false,
      idleExpiresAt: new Date(row.idle_expires_at),
      absoluteExpiresAt: new Date(row.absolute_expires_at),
    };
  });
}

export async function findPartnerEnrollment(tokenHash: string): Promise<PartnerEnrollmentRecord | null> {
  const { rows } = await query<{
    id: string; org_id: string; email: string; display_name: string; role: PartnerRole;
    org_display_name: string; totp_secret_enc: string | null;
  }>(
    `select u.id, u.org_id, u.email, u.display_name, u.role, o.display_name as org_display_name, u.totp_secret_enc
     from saferide.partner_users u
     join saferide.partner_organizations o on o.id = u.org_id
     where u.enrollment_token_hash = $1 and u.status = 'invited'
       and u.enrollment_expires_at > now() and o.status = 'active'`,
    [tokenHash],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    userId: row.id, orgId: row.org_id, email: row.email, displayName: row.display_name, role: row.role,
    orgDisplayName: row.org_display_name, totpSecretEnc: row.totp_secret_enc,
  };
}

/** Stores the sealed secret the invitee is enrolling; restarting replaces it. */
export async function storePendingPartnerTotpSecret(params: {
  userId: string;
  tokenHash: string;
  totpSecretEnc: string;
}): Promise<boolean> {
  const { rowCount } = await query(
    `update saferide.partner_users set totp_secret_enc = $3, totp_last_step = null
     where id = $1 and enrollment_token_hash = $2 and status = 'invited' and enrollment_expires_at > now()`,
    [params.userId, params.tokenHash, params.totpSecretEnc],
  );
  return rowCount === 1;
}

/**
 * Activates the invitee and consumes the one-time token in one transaction,
 * then issues a full session and audits. Activation is pinned to the exact
 * sealed secret the code was verified against (`verifiedTotpSecretEnc`):
 * if a concurrent enrol/start replaced it, nothing is activated. Returns
 * null if the token was already used, expired, or the secret changed.
 */
export async function completePartnerEnrollment(params: {
  userId: string;
  orgId: string;
  tokenHash: string;
  verifiedTotpSecretEnc: string;
  passwordHash: string;
  step: number;
  newTokenHash: string;
  requestId: string;
}): Promise<PartnerSignInRecord | null> {
  return guardedTransaction<PartnerSignInRecord>(async client => {
    const user = await client.query<{ role: PartnerRole; stable_id: string; known_device_epoch: number }>(
      `update saferide.partner_users u
       set password_hash = $3, totp_enrolled_at = now(), totp_last_step = $4, status = 'active',
           enrollment_token_hash = null, enrollment_expires_at = null,
           failed_attempts = 0, lockout_count = 0, locked_until = null, last_login_at = now()
       from saferide.partner_organizations o
       where u.id = $1 and o.id = u.org_id and o.status = 'active' and u.enrollment_token_hash = $2
         and u.status = 'invited' and u.enrollment_expires_at > now() and u.totp_secret_enc = $5
       returning u.role, o.stable_id, u.known_device_epoch`,
      [params.userId, params.tokenHash, params.passwordHash, params.step, params.verifiedTotpSecretEnc],
    );
    if (user.rows.length !== 1) {
      throw new GuardRejected();
    }
    const session = await insertSession(client, {
      tokenHash: params.newTokenHash, userId: params.userId, orgId: params.orgId, grant: 'totp',
    });
    await recordPartnerAccess({
      orgId: params.orgId,
      actor: { type: 'partner_user', userId: params.userId },
      action: 'auth.enroll.complete',
      outcome: 'success',
      requestId: params.requestId,
    }, client);
    return {
      sessionId: session.id,
      userId: params.userId,
      orgId: params.orgId,
      orgStableId: user.rows[0].stable_id,
      knownDeviceEpoch: user.rows[0].known_device_epoch,
      role: user.rows[0].role,
      stage: 'full',
      mfaVerified: true,
      mustChangePassword: false,
      idleExpiresAt: session.idleExpiresAt,
      absoluteExpiresAt: session.absoluteExpiresAt,
    };
  });
}

export async function getPartnerProfile(userId: string): Promise<PartnerProfile | null> {
  const { rows } = await query<{
    id: string; email: string; display_name: string; role: PartnerRole; org_id: string;
    stable_id: string; org_display_name: string; mfa_required: boolean; must_change_password: boolean;
  }>(
    `select u.id, u.email, u.display_name, u.role, o.id as org_id, o.stable_id, o.display_name as org_display_name,
            o.mfa_required, u.must_change_password
     from saferide.partner_users u join saferide.partner_organizations o on o.id = u.org_id
     where u.id = $1 and u.status = 'active'`,
    [userId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    userId: row.id, email: row.email, displayName: row.display_name, role: row.role,
    orgId: row.org_id, orgStableId: row.stable_id, orgDisplayName: row.org_display_name,
    orgMfaRequired: row.mfa_required, mustChangePassword: row.must_change_password,
  };
}
