/**
 * Partner auth endpoints under /partner/v1 (design section 5):
 *   POST /auth/enroll/start     {token}                 -> authenticator key for the invitee
 *   POST /auth/enroll/complete  {token, password, code} -> full session
 *   POST /auth/login            {email, password}       -> 5-minute pre-MFA session, or (org MFA off) a full session
 *   POST /auth/totp/setup                               -> authenticator key, for a user without one whose org requires MFA
 *   POST /auth/totp             {code}                  -> fresh full session (new token)
 *   POST /auth/change-password  {currentPassword, newPassword} -> fresh full session (new token)
 *   POST /auth/logout                                   -> 204, session revoked
 *   GET  /me                                            -> {user, org, role, csrfToken, session, mustChangePassword}
 * Enrolment tokens travel in the body (from the link's #fragment), never the URL path.
 *
 * Every successful sign-in step answers an AuthStep: `mfaRequired` (the
 * TOTP step comes next), `totpSetupRequired` (with it: set up an
 * authenticator first), `mustChangePassword` (an operator issued the
 * password: only /me, change-password and logout work until it is changed),
 * the CSRF token and the session window.
 */
import type { BlockList } from 'node:net';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { registerPartnerPushRoutes } from './partnerPush.js';
import { registerPartnerSafetyMapRoutes } from './partnerSafetyMap.js';
import type { PartnerPushConfig } from '../services/partnerPushProtocol.js';

import { partnerClientAddress, partnerClientNetwork } from '../config/partnerNetwork.js';
import { badRequest, conflict, notFound, serviceUnavailable, unauthorized } from '../http/errors.js';
import {
  applyPartnerScopeGuards,
  clearedPartnerSessionCookie,
  getPartnerSession,
  getPartnerSessionToken,
  requirePartnerSession,
  getPreMfaPartnerSession,
  partnerCsrfToken,
  partnerSessionCookie,
  readPartnerSessionCookie,
  requirePartnerCsrf,
  requirePartnerPreMfaSession,
  requirePartnerSessionAllowingPasswordChange,
  verifyPartnerCsrf,
} from '../middleware/partnerSession.js';
import {
  PARTNER_SESSION_POLICY,
  completePartnerEnrollment,
  completePartnerMfa,
  completePartnerPasswordChange,
  findPartnerKnownDeviceAccount,
  findPartnerEnrollment,
  getPartnerProfile,
  reservePartnerLoginAttempt,
  reservePartnerPasswordCheck,
  reservePartnerTotpAttempt,
  resolvePartnerSession,
  revokePartnerSession,
  settlePartnerAuthFailure,
  startPartnerSessionAfterPassword,
  storePendingPartnerTotpSecret,
  storeSignInTotpSecret,
  updatePartnerCoverage,
} from '../repositories/partnerAuthRepository.js';
import { recordPartnerAccess, type PartnerAuditEntry } from '../repositories/partnerRepository.js';
import {
  derivePartnerKeys,
  fingerprintPartnerAccount,
  fingerprintPartnerClient,
  hashPartnerPassword,
  openTotpSecret,
  partnerPasswordHashNeedsUpgrade,
  partnerPasswordProblem,
  sealTotpSecret,
  verifyPartnerPassword,
} from '../services/partnerCredentials.js';
import { partnerAuthGate, type PartnerAuthGate } from '../services/partnerAuthGate.js';
import {
  issueKnownDeviceToken,
  knownDeviceCookie,
  readKnownDeviceCookie,
  verifyKnownDeviceToken,
} from '../services/partnerKnownDevice.js';
import {
  enforcePartnerAuthRateLimit,
  refundPartnerClientAccountAttempt,
  reservePartnerClientAccountAttempt,
} from '../services/partnerRateLimit.js';
import { registerPartnerCaseRoutes } from './partnerCases.js';
import { generatePartnerToken, hashPartnerToken, isPartnerToken } from '../services/partnerTokens.js';
import { PARTNER_TOTP, base32Encode, generateTotpSecret, totpKeyUri, verifyTotp } from '../services/totp.js';

export type PartnerApiConfig = {
  push?: PartnerPushConfig | null;
  publicOrigin: string;
  totpKey: Buffer;
  /** Gateway range whose X-Real-IP is trusted (config/partnerNetwork.ts). Null: socket peer. */
  trustedProxies?: BlockList | null;
  /** Decoded PARTNER_CALLBACK_KEY, for caseworkers' audited callback reveals. Null: none can be shown. */
  callbackKey?: Buffer | null;
  /** PARTNER_EVIDENCE_DOWNLOAD; anything but `originals` keeps partner evidence downloads off. */
  evidenceDownload?: 'disabled' | 'originals';
  /** Cap on concurrent credential work; defaults to the process-wide gate (services/partnerAuthGate.ts). */
  authGate?: PartnerAuthGate;
  now?: () => Date;
};

export const PARTNER_API_PREFIX = '/partner/v1';
const TOTP_ISSUER = 'SafeRide Partners';

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().min(3).max(254),
  password: z.string().min(1).max(1024),
}).strict();
const totpSchema = z.object({ code: z.string().regex(/^\d{6}$/) }).strict();
const enrollStartSchema = z.object({ token: z.string().max(128) }).strict();
const enrollCompleteSchema = z.object({
  token: z.string().max(128),
  password: z.string().max(1024),
  code: z.string().regex(/^\d{6}$/),
}).strict();
const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(1024),
  newPassword: z.string().max(1024),
}).strict();

const signInFailed = () => unauthorized('Sign-in failed. Check your details; after repeated failures sign-in pauses for a while.');
const enrollmentInvalid = () => notFound('This enrolment link is invalid or has expired. Ask SafeRide for a new one.');
const currentPasswordRefused = () => badRequest(
  'Your current password was not accepted. Check it and try again; after repeated failures, sign-in pauses for a while.',
);

function iso(date: Date): string {
  return date.toISOString();
}

type SessionWindowSource = { idleExpiresAt: Date; absoluteExpiresAt: Date; coverageActive?: boolean; coverageEpoch?: number };

function sessionWindow(session: SessionWindowSource): { idleExpiresAt: string; absoluteExpiresAt: string; coverageActive?: boolean; coverageEpoch?: number } {
  return { idleExpiresAt: iso(session.idleExpiresAt), absoluteExpiresAt: iso(session.absoluteExpiresAt),
    ...(session.coverageEpoch ? { coverageActive: session.coverageActive === true, coverageEpoch: session.coverageEpoch } : {}) };
}

export async function registerPartnerAuthRoutes(scope: FastifyInstance, config: PartnerApiConfig): Promise<void> {
  const keys = derivePartnerKeys(config.totpKey);
  const now = config.now ?? (() => new Date());
  const authGate = config.authGate ?? partnerAuthGate;
  /** Accounts holding a priority place in the gate (queued or running): at most one each. */
  const priorityAccounts = new Set<string>();

  /**
   * Runs `work` under the gate, in the priority queue when `userId` is an
   * account that has earned it and holds no other priority place.
   */
  async function runGated<T>(userId: string | null, work: () => Promise<T>): Promise<T> {
    const priority = userId !== null && !priorityAccounts.has(userId);
    if (!priority) return authGate.run(work);
    priorityAccounts.add(userId);
    try {
      return await authGate.run(work, { priority: true });
    } finally {
      priorityAccounts.delete(userId);
    }
  }

  /**
   * The account a known-device cookie earns priority for in this password
   * step: only the account named in the body, only while that user and org
   * are active and the cookie's epoch is current. Otherwise null.
   */
  async function knownDeviceAccount(request: FastifyRequest, email: string): Promise<string | null> {
    const device = verifyKnownDeviceToken(keys.knownDevice, readKnownDeviceCookie(request), unixSeconds());
    if (!device) return null;
    const account = await findPartnerKnownDeviceAccount(email).catch(() => null);
    return account && account.userId === device.userId && account.epoch === device.epoch ? account.userId : null;
  }

  async function audit(entry: Omit<PartnerAuditEntry, 'requestId'>, request: FastifyRequest): Promise<void> {
    try {
      await recordPartnerAccess({ ...entry, requestId: request.id });
    } catch {
      throw serviceUnavailable('The partner service is unavailable');
    }
  }

  function clientFingerprint(request: FastifyRequest): string {
    return fingerprintPartnerClient(keys, partnerClientNetwork(partnerClientAddress(request, config.trustedProxies ?? null)));
  }

  async function rateLimit(request: FastifyRequest): Promise<void> {
    await enforcePartnerAuthRateLimit({ clientFingerprint: clientFingerprint(request) });
  }

  function issueSessionCookie(reply: FastifyReply, token: string, absoluteExpiresAt: Date): void {
    const maxAge = Math.ceil((absoluteExpiresAt.getTime() - now().getTime()) / 1000);
    reply.header('set-cookie', partnerSessionCookie(token, Math.min(maxAge, PARTNER_SESSION_POLICY.absoluteSeconds)));
  }

  function unixSeconds(): number {
    return Math.floor(now().getTime() / 1000);
  }

  for (const heartbeat of [false, true]) {
    scope.post(heartbeat ? '/coverage/heartbeat' : '/coverage', { preHandler: [requirePartnerSession, requirePartnerCsrf] }, async (request, reply) => {
      const enabled = heartbeat
        ? (z.object({}).strict().parse(request.body ?? {}), undefined)
        : z.object({ enabled: z.boolean() }).strict().parse(request.body).enabled;
      const current = getPartnerSession(request);
      if (heartbeat && !current.coverageActive) return { session: sessionWindow(current) };
      const raw = getPartnerSessionToken(request);
      const updated = await updatePartnerCoverage({ tokenHash: hashPartnerToken(raw), enabled, requestId: request.id });
      if (!updated) {
        const remaining = await resolvePartnerSession(hashPartnerToken(raw), 'full', { slideIdle: false });
        if (!remaining) throw unauthorized('Sign in again');
        return { session: sessionWindow(remaining) };
      }
      issueSessionCookie(reply, raw, updated.absoluteExpiresAt);
      return { session: sessionWindow(updated) };
    });
  }

  /** Marks this browser as recently signed in by this user, for gate priority (services/partnerKnownDevice.ts). */
  function issueKnownDevice(reply: FastifyReply, userId: string, epoch: number): void {
    reply.header('set-cookie', knownDeviceCookie(issueKnownDeviceToken(keys.knownDevice, { userId, epoch }, unixSeconds())));
  }

  /**
   * Password step. Order matters (#287 review): take a slot in the partner
   * auth gate, then reserve the attempt for this client x account (Redis)
   * and for the account (row-locked SQL) BEFORE scrypt, so concurrency can
   * never evaluate more guesses than the limits allow; then settle. A full
   * gate refuses with 503 before anything is reserved, so it never counts
   * against an account. Every refusal path runs one reservation statement,
   * one scrypt, one settle statement and one audit insert, and returns the
   * same answer. A correct password stored at an older scrypt cost is
   * rehashed at the current cost with the new session.
   */
  scope.post('/auth/login', { preHandler: rateLimit }, async (request, reply) => {
    const body = loginSchema.parse(request.body ?? {});
    const limiterKeys = {
      clientFingerprint: clientFingerprint(request),
      accountFingerprint: fingerprintPartnerAccount(keys, { email: body.email }),
    };
    // A current known-device cookie of the account named in the body (an
    // earlier full sign-in by that user on this browser) earns a priority place.
    const priorityAccount = await knownDeviceAccount(request, body.email);
    const { reservation, passwordOk, passwordUpgrade } = await runGated(priorityAccount, async () => {
      const clientAllowed = await reservePartnerClientAccountAttempt(limiterKeys);
      // An empty email never matches, so a blocked client still runs the same statements.
      const reserved = await reservePartnerLoginAttempt(clientAllowed ? body.email : '');
      const ok = await verifyPartnerPassword(body.password, reserved.passwordHash);
      let upgrade: { from: string; to: string } | undefined;
      if (ok && reserved.reserved && reserved.passwordHash && partnerPasswordHashNeedsUpgrade(reserved.passwordHash)) {
        // Best effort: a failed rehash keeps the old hash for the next sign-in.
        const to = await hashPartnerPassword(body.password).catch(() => null);
        if (to) upgrade = { from: reserved.passwordHash, to };
      }
      return { reservation: reserved, passwordOk: ok, passwordUpgrade: upgrade };
    });
    const actor = reservation.userId
      ? { type: 'partner_user' as const, userId: reservation.userId }
      : { type: 'anonymous' as const };

    if (reservation.reserved && passwordOk && reservation.userId && reservation.orgId) {
      const token = generatePartnerToken('session');
      const started = await startPartnerSessionAfterPassword({
        tokenHash: hashPartnerToken(token), userId: reservation.userId, orgId: reservation.orgId, requestId: request.id,
        ...(passwordUpgrade ? { passwordUpgrade } : {}),
      });
      if (started) {
        await refundPartnerClientAccountAttempt(limiterKeys);
        issueSessionCookie(reply, token, started.session.absoluteExpiresAt);
        if (started.stage === 'full') {
          // The org has MFA off: the password completed the sign-in, so this
          // browser earns the known-device cookie like any full sign-in.
          issueKnownDevice(reply, reservation.userId, started.session.knownDeviceEpoch);
          return {
            mfaRequired: false,
            totpSetupRequired: false,
            mustChangePassword: started.session.mustChangePassword,
            csrfToken: partnerCsrfToken(token),
            session: sessionWindow(started.session),
          };
        }
        return {
          mfaRequired: true,
          totpSetupRequired: !started.totpEnrolled,
          mustChangePassword: false,
          csrfToken: partnerCsrfToken(token),
          session: sessionWindow(started.session),
        };
      }
      // A concurrent failure locked the account first: refuse like any other failure.
      await audit({ orgId: reservation.orgId, actor, action: 'auth.login', outcome: 'denied' }, request);
      throw signInFailed();
    }

    // Settle against the known account even when nothing was reserved: that
    // locks an account stuck at the maximum by unsettled reservations.
    const { lockedNow } = await settlePartnerAuthFailure(reservation.userId);
    await audit({ orgId: reservation.orgId, actor, action: 'auth.login', outcome: 'denied' }, request);
    if (lockedNow) await audit({ orgId: reservation.orgId, actor, action: 'auth.lockout', outcome: 'denied' }, request);
    throw signInFailed();
  });

  /**
   * TOTP step: the same gate-then-reserve-then-verify-then-settle order as
   * the password step. The code check itself is cheap HMAC work, but it
   * shares the gate so the whole credential path stays bounded.
   */
  scope.post('/auth/totp', { preHandler: [rateLimit, requirePartnerPreMfaSession, requirePartnerCsrf] }, async (request, reply) => {
    const pending = getPreMfaPartnerSession(request);
    const actor = { type: 'partner_user' as const, userId: pending.userId };
    const { code } = totpSchema.parse(request.body ?? {});
    const limiterKeys = {
      clientFingerprint: clientFingerprint(request),
      accountFingerprint: fingerprintPartnerAccount(keys, { userId: pending.userId }),
    };
    const refuse = async (settle: boolean): Promise<never> => {
      const { lockedNow } = settle ? await settlePartnerAuthFailure(pending.userId) : { lockedNow: false };
      await audit({ orgId: pending.orgId, actor, action: 'auth.totp', outcome: 'denied' }, request);
      if (lockedNow) await audit({ orgId: pending.orgId, actor, action: 'auth.lockout', outcome: 'denied' }, request);
      throw signInFailed();
    };
    // A pre-MFA session already proves the password: priority for its account.
    const { clientAllowed, reserved, step, sealedSecret } = await runGated(pending.userId, async () => {
      const allowed = await reservePartnerClientAccountAttempt(limiterKeys);
      const reservation = allowed
        ? await reservePartnerTotpAttempt(pending.userId)
        : { reserved: false, totpSecretEnc: null, totpLastStep: null };
      if (!reservation.reserved || !reservation.totpSecretEnc) {
        return { clientAllowed: allowed, reserved: false, step: null, sealedSecret: null };
      }
      const secret = openTotpSecret(keys, pending.userId, reservation.totpSecretEnc);
      const verified = verifyTotp(secret, code, {
        unixSeconds: unixSeconds(), window: PARTNER_TOTP.window, afterStep: reservation.totpLastStep,
      });
      return { clientAllowed: allowed, reserved: true, step: verified, sealedSecret: reservation.totpSecretEnc };
    });
    // Unreserved (locked, at the limit, or no secret): nothing is counted, but
    // settling locks an account stuck at the maximum. A blocked client touches no SQL.
    if (!reserved || !sealedSecret) return refuse(clientAllowed);
    if (step === null) return refuse(true);
    const token = generatePartnerToken('session');
    const session = await completePartnerMfa({
      preMfaSessionId: pending.sessionId, userId: pending.userId, orgId: pending.orgId,
      step, verifiedTotpSecretEnc: sealedSecret, newTokenHash: hashPartnerToken(token), requestId: request.id,
    });
    // A replayed step or a pre-MFA session retired meanwhile leaves this
    // reservation unsettled; settle so it can never strand the account.
    if (!session) return refuse(true);
    await refundPartnerClientAccountAttempt(limiterKeys);
    issueSessionCookie(reply, token, session.absoluteExpiresAt);
    issueKnownDevice(reply, pending.userId, session.knownDeviceEpoch);
    return {
      mfaRequired: false,
      totpSetupRequired: false,
      mustChangePassword: session.mustChangePassword,
      csrfToken: partnerCsrfToken(token),
      session: sessionWindow(session),
    };
  });

  /**
   * Sign-in enrolment: in an org that requires MFA, a user without an
   * authenticator (created by `user:set-password`, or MFA was turned back
   * on) gets a new key here, inside the 5-minute pre-MFA session; the next
   * good code at POST /auth/totp enrols it and completes the sign-in. A user
   * who already has an authenticator is refused (409): only an operator's
   * `user:reset` replaces one. Each call issues a new key.
   */
  scope.post('/auth/totp/setup', { preHandler: [rateLimit, requirePartnerPreMfaSession, requirePartnerCsrf] }, async request => {
    const pending = getPreMfaPartnerSession(request);
    const actor = { type: 'partner_user' as const, userId: pending.userId };
    const profile = await getPartnerProfile(pending.userId);
    if (!profile || profile.orgId !== pending.orgId) throw unauthorized('Sign in again');
    const secret = generateTotpSecret();
    const stored = await storeSignInTotpSecret({
      userId: pending.userId, preMfaSessionId: pending.sessionId,
      totpSecretEnc: sealTotpSecret(keys, pending.userId, secret),
    });
    if (!stored) {
      await audit({ orgId: pending.orgId, actor, action: 'auth.totp.setup', outcome: 'denied' }, request);
      throw conflict('Your account already has an authenticator. Enter its code, or ask SafeRide to reset it.');
    }
    await audit({ orgId: pending.orgId, actor, action: 'auth.totp.setup', outcome: 'success' }, request);
    return {
      totp: {
        keyUri: totpKeyUri({ secret, issuer: TOTP_ISSUER, account: profile.email }),
        secret: base32Encode(secret),
        algorithm: PARTNER_TOTP.algorithm.toUpperCase(),
        digits: PARTNER_TOTP.digits,
        periodSeconds: PARTNER_TOTP.periodSeconds,
      },
    };
  });

  /**
   * Changes the signed-in user's password. It accepts a session that must
   * change its password (that is what it is for) and any other full
   * session. The current password is checked like a sign-in attempt
   * (gate, client x account limit, row-locked reservation before scrypt,
   * settle on failure), so a stolen session cannot guess it faster. The new
   * password follows partnerPasswordProblem and must differ from the
   * current one. On success every session of the user ends and a fresh one
   * (new token, same kind, same absolute expiry) replaces this one.
   */
  scope.post('/auth/change-password', {
    preHandler: [rateLimit, requirePartnerSessionAllowingPasswordChange, requirePartnerCsrf],
  }, async (request, reply) => {
    const current = getPartnerSession(request);
    const actor = { type: 'partner_user' as const, userId: current.userId };
    const body = changePasswordSchema.parse(request.body ?? {});
    const profile = await getPartnerProfile(current.userId);
    if (!profile || profile.orgId !== current.orgId) throw unauthorized('Partner sign-in required');
    const problem = partnerPasswordProblem(body.newPassword, profile.email);
    if (problem) throw badRequest(problem);
    if (body.newPassword.normalize('NFKC') === body.currentPassword.normalize('NFKC')) {
      throw badRequest('Choose a password different from your current one');
    }
    const limiterKeys = {
      clientFingerprint: clientFingerprint(request),
      accountFingerprint: fingerprintPartnerAccount(keys, { userId: current.userId }),
    };
    const refuse = async (settle: boolean): Promise<never> => {
      const { lockedNow } = settle ? await settlePartnerAuthFailure(current.userId) : { lockedNow: false };
      await audit({ orgId: current.orgId, actor, action: 'auth.password.change', outcome: 'denied' }, request);
      if (lockedNow) await audit({ orgId: current.orgId, actor, action: 'auth.lockout', outcome: 'denied' }, request);
      throw currentPasswordRefused();
    };
    // A full session already proves the account: priority for it, as at the TOTP step.
    const checked = await runGated(current.userId, async () => {
      const allowed = await reservePartnerClientAccountAttempt(limiterKeys);
      const reservation = allowed
        ? await reservePartnerPasswordCheck(current.userId)
        : { reserved: false, passwordHash: null, email: null };
      const ok = await verifyPartnerPassword(body.currentPassword, reservation.passwordHash);
      const newHash = ok && reservation.reserved ? await hashPartnerPassword(body.newPassword) : null;
      return { clientAllowed: allowed, reserved: reservation.reserved, currentHash: reservation.passwordHash, ok, newHash };
    });
    if (!checked.reserved) return refuse(checked.clientAllowed);
    if (!checked.ok || !checked.currentHash || !checked.newHash) return refuse(true);
    const token = generatePartnerToken('session');
    const session = await completePartnerPasswordChange({
      sessionId: current.sessionId, userId: current.userId, orgId: current.orgId,
      currentPasswordHash: checked.currentHash, newPasswordHash: checked.newHash,
      newTokenHash: hashPartnerToken(token), requestId: request.id,
    });
    // The password or session changed meanwhile: settle the reservation and refuse.
    if (!session) return refuse(true);
    await refundPartnerClientAccountAttempt(limiterKeys);
    issueSessionCookie(reply, token, session.absoluteExpiresAt);
    return {
      mfaRequired: false,
      totpSetupRequired: false,
      mustChangePassword: false,
      csrfToken: partnerCsrfToken(token),
      session: sessionWindow(session),
    };
  });

  scope.post('/auth/logout', async (request, reply) => {
    const token = readPartnerSessionCookie(request);
    const session = token ? await resolvePartnerSession(hashPartnerToken(token), 'any', { slideIdle: false }) : null;
    if (token && session) {
      verifyPartnerCsrf(request, token);
      await revokePartnerSession(session.sessionId, 'logout');
      await audit({
        orgId: session.orgId, actor: { type: 'partner_user', userId: session.userId }, action: 'auth.logout', outcome: 'success',
      }, request);
    }
    reply.header('set-cookie', clearedPartnerSessionCookie());
    reply.status(204);
    return reply.send();
  });

  // /me also answers a session that must change its password, so the dashboard can send the person to that screen.
  scope.get('/me', { preHandler: requirePartnerSessionAllowingPasswordChange }, async request => {
    const session = getPartnerSession(request);
    const profile = await getPartnerProfile(session.userId);
    if (!profile || profile.orgId !== session.orgId) throw unauthorized('Partner sign-in required');
    await audit({
      orgId: session.orgId, actor: { type: 'partner_user', userId: session.userId }, action: 'partner.me.read', outcome: 'success',
    }, request);
    return {
      user: { id: profile.userId, email: profile.email, displayName: profile.displayName },
      org: {
        id: profile.orgId, stableId: profile.orgStableId, displayName: profile.orgDisplayName, mfaRequired: profile.orgMfaRequired,
      },
      role: session.role,
      mustChangePassword: session.mustChangePassword,
      csrfToken: partnerCsrfToken(getPartnerSessionToken(request)),
      session: { ...sessionWindow(session), mfaVerified: session.mfaVerified },
    };
  });

  scope.post('/auth/enroll/start', { preHandler: rateLimit }, async request => {
    const { token } = enrollStartSchema.parse(request.body ?? {});
    const enrollment = isPartnerToken('enrollment', token) ? await findPartnerEnrollment(hashPartnerToken(token)) : null;
    if (!enrollment) {
      await audit({ actor: { type: 'anonymous' }, action: 'auth.enroll.start', outcome: 'denied' }, request);
      throw enrollmentInvalid();
    }
    const secret = generateTotpSecret();
    const stored = await storePendingPartnerTotpSecret({
      userId: enrollment.userId, tokenHash: hashPartnerToken(token),
      totpSecretEnc: sealTotpSecret(keys, enrollment.userId, secret),
    });
    if (!stored) throw enrollmentInvalid();
    await audit({
      orgId: enrollment.orgId, actor: { type: 'partner_user', userId: enrollment.userId },
      action: 'auth.enroll.start', outcome: 'success',
    }, request);
    return {
      user: { email: enrollment.email, displayName: enrollment.displayName },
      org: { displayName: enrollment.orgDisplayName },
      role: enrollment.role,
      totp: {
        keyUri: totpKeyUri({ secret, issuer: TOTP_ISSUER, account: enrollment.email }),
        secret: base32Encode(secret),
        algorithm: PARTNER_TOTP.algorithm.toUpperCase(),
        digits: PARTNER_TOTP.digits,
        periodSeconds: PARTNER_TOTP.periodSeconds,
      },
    };
  });

  scope.post('/auth/enroll/complete', { preHandler: rateLimit }, async (request, reply) => {
    const body = enrollCompleteSchema.parse(request.body ?? {});
    const tokenHash = isPartnerToken('enrollment', body.token) ? hashPartnerToken(body.token) : null;
    const enrollment = tokenHash ? await findPartnerEnrollment(tokenHash) : null;
    if (!tokenHash || !enrollment) {
      await audit({ actor: { type: 'anonymous' }, action: 'auth.enroll.complete', outcome: 'denied' }, request);
      throw enrollmentInvalid();
    }
    const actor = { type: 'partner_user' as const, userId: enrollment.userId };
    if (!enrollment.totpSecretEnc) {
      await audit({ orgId: enrollment.orgId, actor, action: 'auth.enroll.complete', outcome: 'denied' }, request);
      throw conflict('Start enrolment first to get your authenticator key');
    }
    const problem = partnerPasswordProblem(body.password, enrollment.email);
    if (problem) throw badRequest(problem);
    const sealedSecret = enrollment.totpSecretEnc;
    // The enrolment link is a one-time secret: priority for its account.
    const { step, passwordHash } = await runGated(enrollment.userId, async () => {
      const secret = openTotpSecret(keys, enrollment.userId, sealedSecret);
      const verified = verifyTotp(secret, body.code, { unixSeconds: unixSeconds(), window: PARTNER_TOTP.window });
      return { step: verified, passwordHash: verified === null ? null : await hashPartnerPassword(body.password) };
    });
    if (step === null || passwordHash === null) {
      await audit({ orgId: enrollment.orgId, actor, action: 'auth.enroll.complete', outcome: 'denied' }, request);
      throw badRequest('That code did not match. Check the time on your phone and try the newest code.');
    }
    const token = generatePartnerToken('session');
    const session = await completePartnerEnrollment({
      userId: enrollment.userId, orgId: enrollment.orgId, tokenHash,
      verifiedTotpSecretEnc: sealedSecret,
      passwordHash, step,
      newTokenHash: hashPartnerToken(token), requestId: request.id,
    });
    if (!session) {
      await audit({ orgId: enrollment.orgId, actor, action: 'auth.enroll.complete', outcome: 'denied' }, request);
      throw conflict('Enrolment changed or was already completed. Open your link again to restart.');
    }
    issueSessionCookie(reply, token, session.absoluteExpiresAt);
    issueKnownDevice(reply, enrollment.userId, session.knownDeviceEpoch);
    return {
      mfaRequired: false,
      totpSetupRequired: false,
      mustChangePassword: false,
      csrfToken: partnerCsrfToken(token),
      session: sessionWindow(session),
    };
  });
}

/**
 * Mounts the partner realm under /partner/v1 in its own encapsulated scope
 * with the host, origin, cache and fail-closed guards: the auth routes and
 * the case routes (routes/partnerCases.ts).
 */
export async function registerPartnerApi(app: FastifyInstance, config: PartnerApiConfig): Promise<void> {
  await app.register(async scope => {
    applyPartnerScopeGuards(scope, { publicOrigin: config.publicOrigin });
    await registerPartnerAuthRoutes(scope, config);
    await registerPartnerPushRoutes(scope, config.push ?? null);
    await registerPartnerSafetyMapRoutes(scope);
    await registerPartnerCaseRoutes(scope, {
      callbackKey: config.callbackKey ?? null,
      evidenceDownload: config.evidenceDownload ?? 'disabled',
    });
  }, { prefix: PARTNER_API_PREFIX });
}
