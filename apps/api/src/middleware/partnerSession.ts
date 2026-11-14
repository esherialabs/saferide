/**
 * The partner authentication realm. It is separate from survivor auth:
 *
 * - sessions are opaque server-side tokens (sha256 stored) sent only in a
 *   `__Host-` cookie (HttpOnly, Secure, SameSite=Strict, Path=/, no Domain,
 *   so it is bound to the partner host);
 * - any request carrying an Authorization header is refused, so a survivor
 *   JWT can never reach a partner handler, and survivor `requireAuth`
 *   refuses partner tokens (see middleware/auth.ts);
 * - state-changing requests need the partner Origin and a CSRF token bound
 *   to the session cookie.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

import { sendFastifyClientError } from '../http/errorHandler.js';
import { AppError, forbidden, notFound, unauthorized } from '../http/errors.js';
import {
  resolvePartnerSession,
  type PartnerSessionKind,
  type PartnerSessionRecord,
} from '../repositories/partnerAuthRepository.js';
import type { PartnerRole } from '../repositories/partnerRepository.js';
import { hashPartnerToken, isPartnerToken } from '../services/partnerTokens.js';

export type { PartnerRole };

/**
 * The authenticated partner principal (contract for P3 handlers and the P5
 * client). Only full (signed-in), unexpired, unrevoked sessions of active
 * users in active orgs produce one: TOTP-verified, or password-only while
 * the org has MFA off (migration 013). `mfaVerified` says which, honestly.
 * Every partner data query must filter by `orgId`.
 */
export type PartnerSession = Readonly<{
  realm: 'partner';
  sessionId: string;
  userId: string;
  orgId: string;
  orgStableId: string;
  role: PartnerRole;
  /** True only when a TOTP code was verified for this sign-in; false for a password-only sign-in (org MFA off). */
  mfaVerified: boolean;
  /** An operator issued the password; until changed, only /me, change-password and logout accept the session. */
  mustChangePassword: boolean;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
  coverageActive?: boolean;
  coverageEpoch?: number;
}>;

/** The 403 code a must-change-password session gets from every route but /me, change-password and logout. */
export const PARTNER_PASSWORD_CHANGE_REQUIRED = 'password_change_required';

export const PARTNER_SESSION_COOKIE = '__Host-saferide_partner';
export const PARTNER_CSRF_HEADER = 'x-saferide-partner-csrf';
/**
 * Idle-timeout contract for P5: only user-initiated requests extend the
 * 30-minute idle timer. State-changing requests always count; a GET counts
 * only with `x-saferide-partner-activity: interactive`. Background polling
 * (the 60 s queue refresh) must NOT send it, so an unattended screen still
 * times out.
 */
export const PARTNER_ACTIVITY_HEADER = 'x-saferide-partner-activity';
const CSRF_CONTEXT = 'saferide-partner-csrf.v1';
const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const fullSessions = new WeakMap<FastifyRequest, PartnerSession>();
const preMfaSessions = new WeakMap<FastifyRequest, PartnerSessionRecord>();
const sessionTokens = new WeakMap<FastifyRequest, string>();

/** The single, well-formed partner session cookie, or null. */
export function readPartnerSessionCookie(request: FastifyRequest): string | null {
  const header = request.headers.cookie;
  if (!header) return null;
  const prefix = `${PARTNER_SESSION_COOKIE}=`;
  const values = header.split(';').map(part => part.trim()).filter(part => part.startsWith(prefix));
  if (values.length !== 1) return null;
  const value = values[0].slice(prefix.length);
  return isPartnerToken('session', value) ? value : null;
}

export function partnerSessionCookie(token: string, maxAgeSeconds: number): string {
  return `${PARTNER_SESSION_COOKIE}=${token}; Path=/; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}; HttpOnly; Secure; SameSite=Strict`;
}

export function clearedPartnerSessionCookie(): string {
  return `${PARTNER_SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

/** Derived from the session token, so it cannot be computed without the cookie. */
export function partnerCsrfToken(sessionToken: string): string {
  return createHmac('sha256', sessionToken).update(CSRF_CONTEXT).digest('base64url');
}

export function verifyPartnerCsrf(request: FastifyRequest, sessionToken: string): void {
  const header = request.headers[PARTNER_CSRF_HEADER];
  const given = Buffer.from(typeof header === 'string' ? header : '', 'utf8');
  const expected = Buffer.from(partnerCsrfToken(sessionToken), 'utf8');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw forbidden('Partner request verification failed');
  }
}

/** True for requests that should extend the idle timer (see PARTNER_ACTIVITY_HEADER). */
export function isUserInitiatedPartnerRequest(request: FastifyRequest): boolean {
  // A stale coverage heartbeat must not extend a normal session after coverage is stopped.
  if (request.routeOptions.url?.endsWith('/coverage/heartbeat')) return false;
  return STATE_CHANGING_METHODS.has(request.method) || request.headers[PARTNER_ACTIVITY_HEADER] === 'interactive';
}

async function loadSession(request: FastifyRequest, kind: PartnerSessionKind): Promise<PartnerSessionRecord | null> {
  if (request.headers.authorization !== undefined) return null;
  const token = readPartnerSessionCookie(request);
  if (!token) return null;
  const record = await resolvePartnerSession(hashPartnerToken(token), kind, { slideIdle: isUserInitiatedPartnerRequest(request) });
  if (!record) return null;
  sessionTokens.set(request, token);
  return record;
}

function toPartnerSession(record: PartnerSessionRecord): PartnerSession {
  if (record.stage !== 'full') throw unauthorized('Partner sign-in required');
  return Object.freeze({
    realm: 'partner',
    sessionId: record.sessionId,
    userId: record.userId,
    orgId: record.orgId,
    orgStableId: record.orgStableId,
    role: record.role,
    mfaVerified: record.mfaVerified,
    mustChangePassword: record.mustChangePassword,
    idleExpiresAt: record.idleExpiresAt,
    absoluteExpiresAt: record.absoluteExpiresAt,
    ...(record.coverageEpoch ? { coverageActive: record.coverageActive, coverageEpoch: record.coverageEpoch } : {}),
  });
}

/**
 * preHandler: a full partner session from the partner cookie, never a
 * bearer token. A session whose user must change an operator-issued
 * password is refused with 403 `password_change_required`.
 */
export async function requirePartnerSession(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const record = await loadSession(request, 'full');
  if (!record) throw unauthorized('Partner sign-in required');
  if (record.mustChangePassword) {
    throw new AppError(403, PARTNER_PASSWORD_CHANGE_REQUIRED, 'Choose a new password before you continue');
  }
  fullSessions.set(request, toPartnerSession(record));
}

/** preHandler for GET /me and POST /auth/change-password only: a full session, even one that must change its password. */
export async function requirePartnerSessionAllowingPasswordChange(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const record = await loadSession(request, 'full');
  if (!record) throw unauthorized('Partner sign-in required');
  fullSessions.set(request, toPartnerSession(record));
}

/** preHandler for POST /auth/totp and /auth/totp/setup only: a password-verified, not yet MFA-verified session. */
export async function requirePartnerPreMfaSession(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const record = await loadSession(request, 'pre_mfa');
  if (!record) throw unauthorized('Sign in again');
  preMfaSessions.set(request, record);
}

/** preHandler after a session check: the CSRF header must match this session's cookie. */
export async function requirePartnerCsrf(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const token = sessionTokens.get(request);
  if (!token) throw unauthorized('Partner sign-in required');
  verifyPartnerCsrf(request, token);
}

export function requirePartnerRole(...roles: PartnerRole[]) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    if (!roles.includes(getPartnerSession(request).role)) throw forbidden('Your partner role cannot do this');
  };
}

export function getPartnerSession(request: FastifyRequest): PartnerSession {
  const session = fullSessions.get(request);
  if (!session) throw unauthorized('Partner sign-in required');
  return session;
}

export function getPreMfaPartnerSession(request: FastifyRequest): PartnerSessionRecord {
  const session = preMfaSessions.get(request);
  if (!session) throw unauthorized('Sign in again');
  return session;
}

/** The raw cookie token of the resolved session (to derive the CSRF token for responses). */
export function getPartnerSessionToken(request: FastifyRequest): string {
  const token = sessionTokens.get(request);
  if (!token) throw unauthorized('Partner sign-in required');
  return token;
}

/**
 * Scope-wide guards for every /partner/v1 route: only the partner host is
 * served (others get 404), bearer credentials are refused, cross-origin and
 * cross-site requests are refused, writes need the exact partner Origin,
 * responses are never cached or indexed, and any unexpected failure
 * (including an audit write) fails closed with 503.
 */
export function applyPartnerScopeGuards(scope: FastifyInstance, config: { publicOrigin: string }): void {
  const partnerHost = new URL(config.publicOrigin).host;

  scope.addHook('onRequest', async request => {
    if (request.headers.host !== partnerHost) throw notFound();
    if (request.headers.authorization !== undefined) {
      throw unauthorized('Partner requests must not carry bearer credentials');
    }
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== config.publicOrigin) throw forbidden('Cross-origin partner requests are refused');
    const fetchSite = request.headers['sec-fetch-site'];
    if (fetchSite === 'cross-site' || fetchSite === 'same-site') throw forbidden('Cross-site partner requests are refused');
    if (STATE_CHANGING_METHODS.has(request.method) && origin !== config.publicOrigin) {
      throw forbidden('Partner changes need the partner site origin');
    }
  });

  scope.addHook('onSend', async (_request, reply, payload) => {
    reply.header('cache-control', 'no-store');
    reply.header('pragma', 'no-cache');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-robots-tag', 'noindex, nofollow');
    return payload;
  });

  scope.setErrorHandler((error: FastifyError | Error, request, reply) => {
    if (error instanceof AppError) {
      if (error.retryAfterSeconds !== undefined) reply.header('retry-after', String(error.retryAfterSeconds));
      reply.status(error.statusCode).send({
        code: error.code, message: error.message, details: error.details, requestId: request.id,
      });
      return;
    }
    // Fastify's own 4xx refusals (empty or malformed JSON, wrong content
    // type, body over the limit) answer like the root handler, logged at warn.
    if (sendFastifyClientError(error, request, reply)) return;
    if (error instanceof ZodError || (error as FastifyError).validation || (error as FastifyError).statusCode === 400) {
      reply.status(400).send({ code: 'bad_request', message: 'Invalid request', requestId: request.id });
      return;
    }
    request.log.error({ err: error }, 'Partner request failed closed');
    reply.status(503).send({ code: 'service_unavailable', message: 'The partner service is unavailable', requestId: request.id });
  });
}
