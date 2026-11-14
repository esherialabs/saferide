// Mock partner API plus a static server for out/, on one origin (as the
// partner host will be in production). For local development and the e2e
// tests only; it is never deployed.
//
// Auth follows P2 (apps/api/src/routes/partnerAuth.ts): opaque session in a
// __Host- cookie, CSRF token derived from it, Origin checks on writes, TOTP
// with replay protection, 5-minute pre-MFA session, 30 min idle, 12 h
// absolute, lockout after 5 failures. Per-org MFA and operator-issued
// passwords follow migration 013: with MFA off a password signs straight in
// (mfaVerified false); must-change-password sessions reach only /me,
// change-password and logout; users without a TOTP set one up at sign-in
// when MFA is required. Case routes follow the P3 contract the
// P3 contract (apps/api/src/routes/partnerCases.ts, partnerCaseView.ts), with
// evidence downloads off by default as in P3.
//
// Test-only control routes live under /__mock/.
import { createECDH, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ADMIN, CASEWORKER, COLLEAGUE, HURIA_ORG, INVITEE, ISSUED, MOCK_ORIGIN, MOCK_PORT, MOCK_STORAGE_ORIGIN, MOCK_STORAGE_PORT, OTHER_ORG,
  STAFF_IDS, syntheticReferrals,
} from './fixtures.mjs';
import { keyUri, newTotpKey, verifyTotp } from './totp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(process.env.PARTNER_WEB_OUT ?? path.join(here, '..', 'out'));
const HOST = new URL(MOCK_ORIGIN).host;
const API = '/partner/v1';
const COOKIE = '__Host-saferide_partner';
const CSRF_HEADER = 'x-saferide-partner-csrf';
// P2 (partnerSession.ts): only writes and GETs with this header set to
// "interactive" extend the idle timer.
const ACTIVITY_HEADER = 'x-saferide-partner-activity';
const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const isUserInitiated = req => STATE_CHANGING.has(req.method) || req.headers[ACTIVITY_HEADER] === 'interactive';
const SIGNING_KEY = randomBytes(32);

const POLICY = { preMfaSeconds: 5 * 60, idleSeconds: 30 * 60, absoluteSeconds: 12 * 60 * 60, maxFailures: 5, lockMinutes: 15 };
const STATUSES = ['new', 'acknowledged', 'in_progress', 'referred_onward', 'closed'];
// partnerReferralStatus.ts PARTNER_STATUS_TRANSITIONS (migration 007 trigger).
const TRANSITIONS = {
  new: ['acknowledged', 'closed'],
  acknowledged: ['in_progress', 'closed'],
  in_progress: ['referred_onward', 'closed'],
  referred_onward: ['closed'],
  closed: [],
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// partnerReferralStatus.ts PARTNER_CLOSURE_REASONS.
const CLOSURE_REASONS = ['support_provided', 'referred_elsewhere', 'survivor_did_not_make_contact', 'outside_mandate', 'duplicate', 'other'];
// Case management (the contract shared with codex/partner-case-management).
const ONWARD_TYPES = ['police', 'medical', 'psychosocial', 'legal_aid', 'shelter', 'child_protection', 'other'];
const ONWARD_TRANSITIONS = {
  planned: ['made', 'cancelled'],
  made: ['accepted', 'declined'],
  accepted: ['completed'],
  declined: [],
  completed: [],
  cancelled: [],
};
const ONWARD_LIMITS = { organisation: 120, contactRole: 120, externalReference: 80, note: 1000 };
// #314: partner text may hold newlines and tabs but no other control characters (400).
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B-\u001F\u007F]/;
// #314 SAFERIDE_ACTOR: history entries SafeRide made itself (not a user).
const SAFERIDE_ACTOR = { id: 'saferide', name: 'SafeRide' };
// P3 PARTNER_EVIDENCE_DOWNLOAD: 'disabled' (the live default) or 'originals' (development/test only).
const EVIDENCE_NOT_SHAREABLE_YET = 'evidence_not_shareable_yet';

/** The strict policy P7 should serve for the static export (see README). */
const PARTNER_WEB_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "worker-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const STATIC_HEADERS = {
  'content-security-policy': PARTNER_WEB_CSP,
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'x-robots-tag': 'noindex, nofollow',
};

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.png': 'image/png', '.webp': 'image/webp',
};

// --- state ----------------------------------------------------------------------

function freshState(scenario = 'default', options = {}) {
  const now = Date.now();
  return {
    // Migration 013: every org requires MFA unless a test turns it off.
    mfaRequired: { [HURIA_ORG.id]: options.mfaRequired !== false, [OTHER_ORG.id]: true },
    pageSize: 5,
    absoluteSeconds: POLICY.absoluteSeconds,
    users: [
      {
        id: 'usr_caseworker', orgId: HURIA_ORG.id, email: CASEWORKER.email, displayName: CASEWORKER.displayName,
        role: 'partner_caseworker', status: 'active', password: CASEWORKER.password, totpKey: CASEWORKER.totpKey,
        totpLastStep: null, failures: 0, lockedUntil: 0,
      },
      {
        id: STAFF_IDS.colleague, orgId: HURIA_ORG.id, email: COLLEAGUE.email, displayName: COLLEAGUE.displayName,
        role: 'partner_caseworker', status: 'active', password: COLLEAGUE.password, totpKey: COLLEAGUE.totpKey,
        totpLastStep: null, failures: 0, lockedUntil: 0,
      },
      {
        id: 'usr_invitee', orgId: HURIA_ORG.id, email: INVITEE.email, displayName: INVITEE.displayName,
        role: 'partner_caseworker', status: 'invited', password: null, totpKey: null, pendingTotpKey: null,
        enrollmentToken: INVITEE.enrollmentToken, totpLastStep: null, failures: 0, lockedUntil: 0,
      },
      {
        id: 'usr_admin', orgId: HURIA_ORG.id, email: ADMIN.email, displayName: ADMIN.displayName,
        role: 'partner_admin', status: 'active', password: ADMIN.password, totpKey: ADMIN.totpKey,
        totpLastStep: null, failures: 0, lockedUntil: 0,
      },
      {
        id: 'usr_issued', orgId: HURIA_ORG.id, email: ISSUED.email, displayName: ISSUED.displayName,
        role: 'partner_caseworker', status: 'active', password: ISSUED.password, totpKey: null, pendingTotpKey: null,
        mustChangePassword: true, totpLastStep: null, failures: 0, lockedUntil: 0,
      },
    ],
    failAudits: 0,
    refuseText: 0,
    // How far the browser's (fake) clock is ahead of real time, learned from
    // the test-only x-mock-client-time header. Sessions and the Date header
    // follow it; TOTP stays on real time.
    timeOffsetMs: 0,
    evidenceUrlOverride: null,
    // Test control: requests to these routes get no answer at all (count per route).
    hang: {},
    evidenceDownload: 'disabled',
    sessions: new Map(),
    referrals: scenario === 'empty' ? syntheticReferrals(now).filter(item => item.orgId !== HURIA_ORG.id) : syntheticReferrals(now),
    audit: [],
  };
}

const pushCurve = createECDH('prime256v1');
pushCurve.generateKeys();
const MOCK_PUSH_PUBLIC_KEY = pushCurve.getPublicKey().toString('base64url');
let state = freshState();

/** The mock server's clock for sessions: it follows the browser's clock (never backwards). */
function mockNow() {
  return Date.now() + state.timeOffsetMs;
}

// The e2e fixture stamps every browser request with the page's Date.now(),
// so when a test moves the browser's fake clock, the server's clock moves
// with it and the two can't drift apart.
const CLIENT_TIME_HEADER = 'x-mock-client-time';

function followClientClock(req) {
  const reported = Number(req.headers[CLIENT_TIME_HEADER]);
  if (Number.isFinite(reported) && reported > 0) state.timeOffsetMs = Math.max(state.timeOffsetMs, reported - Date.now());
}

const orgs = { [HURIA_ORG.id]: HURIA_ORG, [OTHER_ORG.id]: OTHER_ORG };

// --- helpers --------------------------------------------------------------------

class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const badRequest = (message = 'Invalid request') => new HttpError(400, 'bad_request', message);
const unauthorized = (message = 'Partner sign-in required') => new HttpError(401, 'unauthorized', message);
const forbidden = message => new HttpError(403, 'forbidden', message);
const notFound = (message = 'Not found') => new HttpError(404, 'not_found', message);
// Neutral: a survivor's withdrawal and an operator's revoke (#304) answer the same way.
const withdrawnGone = () => new HttpError(410, 'withdrawn', 'This report is no longer shared with your organisation', { reason: 'withdrawn' });
const conflict = (message, details) => new HttpError(409, 'conflict', message, details);
const signInFailed = () => unauthorized('Sign-in failed. Check your details; after repeated failures sign-in pauses for a while.');

function csrfFor(token) {
  return createHmac('sha256', token).update('saferide-partner-csrf.v1').digest('base64url');
}

function readCookie(req) {
  const values = (req.headers.cookie ?? '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${COOKIE}=`));
  return values.length === 1 ? values[0].slice(COOKIE.length + 1) : null;
}

function sessionCookie(token, maxAge) {
  return `${COOKIE}=${token}; Path=/; Max-Age=${Math.max(0, Math.floor(maxAge))}; HttpOnly; Secure; SameSite=Strict`;
}

function clearedCookie() {
  return `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

function audit(entry) {
  state.audit.push({ at: new Date().toISOString(), ...entry });
}

/**
 * `mfa` true: a full session. `mfaWaived`: full without a TOTP (org MFA off,
 * migration 013), which stops counting as full if the org requires MFA again.
 */
function createSession(user, mfa, { mfaWaived = false, absoluteExpiresAt = null } = {}) {
  const token = `srps_${randomBytes(32).toString('base64url')}`;
  const now = mockNow();
  const idle = (mfa ? POLICY.idleSeconds : POLICY.preMfaSeconds) * 1000;
  const lifetime = (mfa ? state.absoluteSeconds : POLICY.preMfaSeconds) * 1000;
  const absolute = absoluteExpiresAt ?? now + lifetime;
  const session = {
    token, userId: user.id, orgId: user.orgId, mfa, mfaWaived, idleExpiresAt: Math.min(now + idle, absolute), absoluteExpiresAt: absolute, revoked: false,
  };
  state.sessions.set(token, session);
  return session;
}

function sessionWindow(session) {
  return { idleExpiresAt: new Date(session.idleExpiresAt).toISOString(), absoluteExpiresAt: new Date(session.absoluteExpiresAt).toISOString(),
    ...(session.coverageEpoch ? { coverageActive: session.coverageActive === true, coverageEpoch: session.coverageEpoch } : {}) };
}

/** Resolves and slides the session like resolvePartnerSession. */
function resolveSession(req, kind) {
  if (req.headers.authorization !== undefined) return null;
  const token = readCookie(req);
  const session = token ? state.sessions.get(token) : null;
  const now = mockNow();
  if (!session || session.revoked || session.idleExpiresAt <= now || session.absoluteExpiresAt <= now) return null;
  if (kind === 'full' && !session.mfa) return null;
  if (kind === 'full' && session.mfaWaived && state.mfaRequired[session.orgId]) return null;
  if (kind === 'pre_mfa' && session.mfa) return null;
  const user = state.users.find(item => item.id === session.userId);
  if (!user || user.status !== 'active') return null;
  // Background polling (no activity flag) does not extend the idle timer.
  if (isUserInitiated(req) && !req.url?.split('?')[0].endsWith('/coverage/heartbeat')) {
    const idle = (session.mfa ? POLICY.idleSeconds : POLICY.preMfaSeconds) * 1000;
    session.idleExpiresAt = session.coverageActive ? session.absoluteExpiresAt : Math.min(now + idle, session.absoluteExpiresAt);
  }
  return { session, user };
}

function requireCsrf(req, token) {
  const given = Buffer.from(String(req.headers[CSRF_HEADER] ?? ''), 'utf8');
  const expected = Buffer.from(csrfFor(token), 'utf8');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw forbidden('Partner request verification failed');
}

function requireFull(req, { csrf = false, allowPasswordChange = false } = {}) {
  const resolved = resolveSession(req, 'full');
  if (!resolved) throw unauthorized();
  if (resolved.user.mustChangePassword && !allowPasswordChange) {
    throw new HttpError(403, 'password_change_required', 'Choose a new password before you continue');
  }
  if (csrf) requireCsrf(req, resolved.session.token);
  return resolved;
}

function authStep(session, { mfaRequired = false, totpSetupRequired = false, mustChangePassword = false } = {}) {
  return { mfaRequired, totpSetupRequired, mustChangePassword, csrfToken: csrfFor(session.token), session: sessionWindow(session) };
}

function strictBody(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest();
  for (const key of Object.keys(body)) if (!allowed.includes(key)) throw badRequest();
  return body;
}

function passwordProblem(password, email) {
  const length = [...password].length;
  if (length < 12) return 'Use at least 12 characters';
  if (length > 256) return 'Use at most 256 characters';
  const lowered = password.toLowerCase();
  const local = email.toLowerCase().split('@')[0] ?? '';
  if (lowered === email.toLowerCase() || (local.length >= 4 && lowered.includes(local))) return 'Do not use your email address in the password';
  if (new Set(password).size < 5) return 'Use a less repetitive password';
  if (unpredictableChars(password) < 8) {
    return 'That password is too easy to guess. Avoid common words, runs like 1234 or abcd, and repeats; a few unrelated words work well';
  }
  return null;
}

// partnerCredentials.ts partnerPasswordUnpredictableChars.
const COMMON_FRAGMENTS = [
  'password', 'passw0rd', 'p@ssw0rd', 'saferide', 'esheria', 'huria', 'qwerty', 'azerty', 'asdf', 'zxcv',
  'letmein', 'welcome', 'changeme', 'iloveyou', 'admin', 'nairobi', 'mombasa', 'kenya',
];
function unpredictableChars(password) {
  let rest = password.normalize('NFKC').toLowerCase();
  for (const fragment of COMMON_FRAGMENTS) rest = rest.split(fragment).join('\u0000');
  let count = 0;
  let previous = null;
  for (const char of rest) {
    if (char === '\u0000') {
      previous = null;
      continue;
    }
    const code = char.codePointAt(0) ?? 0;
    if (previous === null || Math.abs(code - previous) > 1) count += 1;
    previous = code;
  }
  return count;
}

function recordFailure(user) {
  user.failures += 1;
  if (user.failures >= POLICY.maxFailures) {
    user.lockedUntil = Date.now() + POLICY.lockMinutes * 60 * 1000;
    user.failures = 0;
    return true;
  }
  return false;
}

// Projections, as in partnerCaseView.ts.

/** A staff member as other screens see them: ID and display name only. */
function personRef(userId) {
  if (userId === SAFERIDE_ACTOR.id) return { ...SAFERIDE_ACTOR };
  const user = userId ? state.users.find(entry => entry.id === userId) : null;
  return user ? { id: user.id, name: user.displayName } : null;
}

/** As #314: only an active user counts as the assignee; anyone else reads as nobody. */
function assigneeRef(userId) {
  const user = userId ? state.users.find(entry => entry.id === userId) : null;
  return user && user.status === 'active' ? { id: user.id, name: user.displayName } : null;
}

const activeAssigneeId = item => assigneeRef(item.assigneeId)?.id ?? null;

/** A one-shot test switch: the next note or onward referral is refused with 400. */
function refuseTextIfAsked() {
  if (state.refuseText > 0) {
    state.refuseText -= 1;
    throw badRequest();
  }
}

const priorityOf = item => (item.pathway === 'escalation' ? 'urgent' : 'normal');
/** Urgent and nobody has acknowledged it yet (acknowledging moves it out of "new"). */
const needsAttention = item => item.revokedAt === null && priorityOf(item) === 'urgent' && item.status === 'new';

function onwardView(onward) {
  return {
    id: onward.id,
    type: onward.type,
    organisation: onward.organisation,
    contactRole: onward.contactRole,
    externalReference: onward.externalReference,
    note: onward.note,
    status: onward.status,
    createdAt: onward.createdAt,
    createdBy: personRef(onward.createdById),
    statusChangedAt: onward.statusChangedAt,
    allowedTransitions: ONWARD_TRANSITIONS[onward.status],
  };
}

function onwardSummary(item) {
  if (item.onward.length === 0) return { count: 0, latest: null };
  const newest = [...item.onward].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  return { count: item.onward.length, latest: { type: newest.type, status: newest.status } };
}

function queueItem(item) {
  const withdrawn = item.revokedAt !== null;
  if (withdrawn) {
    // A row no longer shared says nothing more: no priority, assignee or onward referrals.
    return {
      id: item.id, reference: item.reference, pathway: null, status: 'withdrawn', withdrawn, receivedAt: item.receivedAt,
      statusChangedAt: item.revokedAt, priority: 'normal', needsAttention: false, assignee: null, onward: { count: 0, latest: null },
    };
  }
  return {
    id: item.id,
    reference: item.reference,
    pathway: item.pathway,
    status: item.status,
    withdrawn,
    receivedAt: item.receivedAt,
    statusChangedAt: item.statusChangedAt,
    priority: priorityOf(item),
    needsAttention: needsAttention(item),
    assignee: assigneeRef(item.assigneeId),
    onward: onwardSummary(item),
  };
}

function referralSummary(item) {
  return {
    id: item.id,
    reference: item.reference,
    pathway: item.pathway,
    status: item.status,
    closureReason: item.closureReason,
    withdrawn: false,
    receivedAt: item.receivedAt,
    statusChangedAt: item.statusChangedAt,
    callbackShared: item.callbackNumber !== null,
    allowedTransitions: TRANSITIONS[item.status],
    priority: priorityOf(item),
    needsAttention: needsAttention(item),
    assignee: assigneeRef(item.assigneeId),
  };
}

/** History entries with their actor (and assignee or onward referral) resolved. */
function timelineView(item) {
  return item.timeline.map(entry => {
    const view = { event: entry.event, status: entry.status ?? null, at: entry.at };
    if (entry.actorId !== undefined) view.actor = personRef(entry.actorId);
    if (entry.event === 'assigned') view.assignee = personRef(entry.assigneeId);
    if (entry.onwardId) {
      const onward = item.onward.find(candidate => candidate.id === entry.onwardId);
      view.onward = onward
        ? { id: onward.id, type: onward.type, status: entry.onwardStatus ?? (entry.event === 'onward_created' ? entry.createdStatus ?? onward.status : onward.status) }
        : null;
    }
    return view;
  });
}

function isActiveStaff(user, orgId) {
  return user.orgId === orgId && user.status === 'active';
}

function attachmentView(attachment) {
  if (state.evidenceDownload !== 'originals') {
    return { ...attachment, download: { available: false, reason: EVIDENCE_NOT_SHAREABLE_YET } };
  }
  return attachment;
}

function tombstone(item) {
  return { id: item.id, reference: item.reference, status: 'withdrawn', withdrawn: true, receivedAt: item.receivedAt, withdrawnAt: item.revokedAt };
}

/** One audit row per case access; a failed audit fails the request with 503 (P3). */
function caseAudit(entry) {
  if (state.failAudits > 0) {
    state.failAudits -= 1;
    throw new HttpError(503, 'service_unavailable', 'The partner service is unavailable');
  }
  audit(entry);
}

function uuidParam(value) {
  if (!UUID.test(value)) throw badRequest();
  return value;
}

/** This org's referral for an action: 404 if missing, 410 if withdrawn (both audited). */
function activeReferral(user, id, action, extra = {}) {
  const item = state.referrals.find(referral => referral.id === id && referral.orgId === user.orgId);
  if (!item) {
    caseAudit({ action, outcome: 'denied', userId: user.id, referralId: id, ...extra });
    throw notFound('Referral not found');
  }
  if (item.revokedAt) {
    caseAudit({ action, outcome: 'denied', userId: user.id, referralId: id, ...extra });
    throw withdrawnGone();
  }
  return item;
}

function signStorage(attachmentId, expires) {
  return createHmac('sha256', SIGNING_KEY).update(`${attachmentId}:${expires}`).digest('base64url');
}

// --- request plumbing -------------------------------------------------------------

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new HttpError(413, 'bad_request', 'Invalid request');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  const type = req.headers['content-type'] ?? '';
  if (!raw) {
    // Fastify rejects an empty body declared as JSON.
    if (type.includes('application/json')) throw badRequest();
    return undefined;
  }
  if (!type.includes('application/json')) throw new HttpError(415, 'bad_request', 'Invalid request');
  try {
    return JSON.parse(raw);
  } catch {
    throw badRequest();
  }
}

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, {
    date: new Date(mockNow()).toUTCString(),
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    pragma: 'no-cache',
    'referrer-policy': 'no-referrer',
    'x-robots-tag': 'noindex, nofollow',
    ...headers,
  });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

// --- partner API -------------------------------------------------------------------

async function handleApi(req, res, url) {
  followClientClock(req);
  // Scope guards (applyPartnerScopeGuards).
  if (req.headers.host !== HOST) throw notFound();
  if (req.headers.authorization !== undefined) throw unauthorized('Partner requests must not carry bearer credentials');
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== MOCK_ORIGIN) throw forbidden('Cross-origin partner requests are refused');
  const site = req.headers['sec-fetch-site'];
  if (site === 'cross-site' || site === 'same-site') throw forbidden('Cross-site partner requests are refused');
  if (req.method === 'POST' && origin !== MOCK_ORIGIN) throw forbidden('Partner changes need the partner site origin');

  const route = url.pathname.slice(API.length);
  if (state.hang[route] > 0) {
    state.hang[route] -= 1;
    return; // never answer: the client must give up by itself
  }
  const body = req.method === 'POST' ? await readJson(req) : undefined;

  if (req.method === 'POST' && route === '/auth/login') {
    const { email, password } = strictBody(body, ['email', 'password']);
    if (typeof email !== 'string' || typeof password !== 'string') throw badRequest();
    const user = state.users.find(item => item.email === email.trim().toLowerCase());
    if (!user || user.status !== 'active' || user.lockedUntil > Date.now()) {
      audit({ action: 'auth.login', outcome: 'denied', userId: user?.id ?? null });
      throw signInFailed();
    }
    if (password !== user.password) {
      const locked = recordFailure(user);
      audit({ action: 'auth.login', outcome: 'denied', userId: user.id });
      if (locked) audit({ action: 'auth.lockout', outcome: 'denied', userId: user.id });
      throw signInFailed();
    }
    audit({ action: 'auth.login', outcome: 'success', userId: user.id });
    if (!state.mfaRequired[user.orgId]) {
      // Org MFA off: the password completes the sign-in (mfaVerified false).
      user.failures = 0;
      const session = createSession(user, true, { mfaWaived: true });
      return sendJson(res, 200, authStep(session, { mustChangePassword: Boolean(user.mustChangePassword) }), {
        'set-cookie': sessionCookie(session.token, state.absoluteSeconds),
      });
    }
    const session = createSession(user, false);
    return sendJson(res, 200, authStep(session, { mfaRequired: true, totpSetupRequired: !user.totpKey }), {
      'set-cookie': sessionCookie(session.token, POLICY.preMfaSeconds),
    });
  }

  if (req.method === 'POST' && route === '/auth/totp/setup') {
    const resolved = resolveSession(req, 'pre_mfa');
    if (!resolved) throw unauthorized('Sign in again');
    requireCsrf(req, resolved.session.token);
    if (body !== undefined) throw badRequest();
    const { user } = resolved;
    if (user.totpKey || !state.mfaRequired[user.orgId]) {
      audit({ action: 'auth.totp.setup', outcome: 'denied', userId: user.id });
      throw conflict('Your account already has an authenticator. Enter its code, or ask SafeRide to reset it.');
    }
    user.pendingTotpKey = newTotpKey();
    user.totpLastStep = null;
    audit({ action: 'auth.totp.setup', outcome: 'success', userId: user.id });
    return sendJson(res, 200, {
      totp: {
        keyUri: keyUri({ key: user.pendingTotpKey, issuer: 'SafeRide Partners', account: user.email }),
        secret: user.pendingTotpKey, algorithm: 'SHA1', digits: 6, periodSeconds: 30,
      },
    });
  }

  if (req.method === 'POST' && route === '/auth/change-password') {
    const { user, session: current } = requireFull(req, { csrf: true, allowPasswordChange: true });
    const { currentPassword, newPassword } = strictBody(body, ['currentPassword', 'newPassword']);
    if (typeof currentPassword !== 'string' || typeof newPassword !== 'string' || !currentPassword) throw badRequest();
    const problem = passwordProblem(newPassword, user.email);
    if (problem) throw badRequest(problem);
    if (newPassword === currentPassword) throw badRequest('Choose a password different from your current one');
    if (user.lockedUntil > Date.now() || currentPassword !== user.password) {
      const locked = recordFailure(user);
      audit({ action: 'auth.password.change', outcome: 'denied', userId: user.id });
      if (locked) audit({ action: 'auth.lockout', outcome: 'denied', userId: user.id });
      throw badRequest('Your current password was not accepted. Check it and try again; after repeated failures, sign-in pauses for a while.');
    }
    Object.assign(user, { password: newPassword, mustChangePassword: false, failures: 0 });
    for (const other of state.sessions.values()) if (other.userId === user.id) other.revoked = true;
    const session = createSession(user, true, { mfaWaived: current.mfaWaived, absoluteExpiresAt: current.absoluteExpiresAt });
    audit({ action: 'auth.password.change', outcome: 'success', userId: user.id });
    return sendJson(res, 200, authStep(session), {
      'set-cookie': sessionCookie(session.token, (session.absoluteExpiresAt - mockNow()) / 1000),
    });
  }

  if (req.method === 'POST' && route === '/auth/totp') {
    const resolved = resolveSession(req, 'pre_mfa');
    if (!resolved) throw unauthorized('Sign in again');
    requireCsrf(req, resolved.session.token);
    const { code } = strictBody(body, ['code']);
    if (typeof code !== 'string' || !/^\d{6}$/.test(code)) throw badRequest();
    const { user, session: pending } = resolved;
    if (user.lockedUntil > Date.now()) throw signInFailed();
    // A key set up at this sign-in (POST /auth/totp/setup) is enrolled by its first good code.
    const key = user.totpKey ?? user.pendingTotpKey;
    if (!key) {
      audit({ action: 'auth.totp', outcome: 'denied', userId: user.id });
      throw signInFailed();
    }
    const step = verifyTotp(key, code, { afterStep: user.totpLastStep });
    if (step === null) {
      const locked = recordFailure(user);
      audit({ action: 'auth.totp', outcome: 'denied', userId: user.id });
      if (locked) audit({ action: 'auth.lockout', outcome: 'denied', userId: user.id });
      throw signInFailed();
    }
    Object.assign(user, { totpKey: key, pendingTotpKey: null, totpLastStep: step, failures: 0 });
    pending.revoked = true;
    const session = createSession(user, true);
    audit({ action: 'auth.totp', outcome: 'success', userId: user.id });
    return sendJson(res, 200, authStep(session, { mustChangePassword: Boolean(user.mustChangePassword) }), {
      'set-cookie': sessionCookie(session.token, state.absoluteSeconds),
    });
  }

  if (req.method === 'POST' && route === '/auth/logout') {
    const token = readCookie(req);
    const session = token ? state.sessions.get(token) : null;
    if (token && session && !session.revoked) {
      requireCsrf(req, token);
      session.revoked = true;
      audit({ action: 'auth.logout', outcome: 'success', userId: session.userId });
    }
    return sendJson(res, 204, undefined, { 'set-cookie': clearedCookie() });
  }

  if (req.method === 'POST' && (route === '/coverage' || route === '/coverage/heartbeat')) {
    const { session, user } = requireFull(req, { csrf: true });
    const heartbeat = route.endsWith('/heartbeat');
    strictBody(body, heartbeat ? [] : ['enabled']);
    if (!heartbeat && typeof body.enabled !== 'boolean') throw badRequest();
    if (!heartbeat) {
      if (Boolean(session.coverageActive) !== body.enabled) session.coverageEpoch = (session.coverageEpoch ?? 0) + 1;
      session.coverageActive = body.enabled;
      audit({ action: 'partner.coverage.change', outcome: 'success', userId: user.id });
    }
    if (session.coverageActive) session.idleExpiresAt = session.absoluteExpiresAt = mockNow() + POLICY.absoluteSeconds * 1000;
    else if (!heartbeat) session.idleExpiresAt = Math.min(mockNow() + POLICY.idleSeconds * 1000, session.absoluteExpiresAt);
    return sendJson(res, 200, { session: sessionWindow(session) }, { 'set-cookie': sessionCookie(session.token, POLICY.absoluteSeconds) });
  }

  if (req.method === 'GET' && route === '/notifications') {
    const { session } = requireFull(req);
    return sendJson(res, 200, { configured: Boolean(state.pushConfigured), publicKey: state.pushConfigured ? MOCK_PUSH_PUBLIC_KEY : null, enabled: Boolean(session.pushEnabled), lastAcceptedAt: null, lastOutcome: null });
  }
  if (req.method === 'POST' && route.startsWith('/notifications/')) {
    const { session } = requireFull(req, { csrf: true });
    if (route === '/notifications/subscribe') {
      strictBody(body, ['endpoint', 'keys']);
      if (!state.pushConfigured || typeof body.endpoint !== 'string' || !body.keys?.p256dh || !body.keys?.auth) throw badRequest();
      session.pushEnabled = true;
      return sendJson(res, 200, { enabled: true });
    }
    strictBody(body, []);
    if (route === '/notifications/unsubscribe') { session.pushEnabled = false; return sendJson(res, 200, { enabled: false }); }
    if (route === '/notifications/test' && session.pushEnabled) return sendJson(res, 202, { queued: true });
    throw badRequest();
  }

  if (req.method === 'GET' && route === '/me') {
    const { session, user } = requireFull(req, { allowPasswordChange: true });
    audit({ action: 'partner.me.read', outcome: 'success', userId: user.id, background: !isUserInitiated(req) });
    const org = orgs[user.orgId];
    return sendJson(res, 200, {
      user: { id: user.id, email: user.email, displayName: user.displayName },
      org: { id: org.id, stableId: org.stableId, displayName: org.displayName, mfaRequired: state.mfaRequired[user.orgId] },
      role: user.role,
      mustChangePassword: Boolean(user.mustChangePassword),
      csrfToken: csrfFor(session.token),
      session: { ...sessionWindow(session), mfaVerified: !session.mfaWaived },
    });
  }

  if (req.method === 'POST' && route === '/auth/enroll/start') {
    const { token } = strictBody(body, ['token']);
    const user = state.users.find(item => item.status === 'invited' && item.enrollmentToken === token);
    if (!user) {
      audit({ action: 'auth.enroll.start', outcome: 'denied', userId: null });
      throw notFound('This enrolment link is invalid or has expired. Ask SafeRide for a new one.');
    }
    user.pendingTotpKey = newTotpKey();
    audit({ action: 'auth.enroll.start', outcome: 'success', userId: user.id });
    return sendJson(res, 200, {
      user: { email: user.email, displayName: user.displayName },
      org: { displayName: orgs[user.orgId].displayName },
      role: user.role,
      totp: {
        keyUri: keyUri({ key: user.pendingTotpKey, issuer: 'SafeRide Partners', account: user.email }),
        secret: user.pendingTotpKey, algorithm: 'SHA1', digits: 6, periodSeconds: 30,
      },
    });
  }

  if (req.method === 'POST' && route === '/auth/enroll/complete') {
    const { token, password, code } = strictBody(body, ['token', 'password', 'code']);
    if (typeof password !== 'string' || typeof code !== 'string' || !/^\d{6}$/.test(code)) throw badRequest();
    const user = state.users.find(item => item.status === 'invited' && item.enrollmentToken === token);
    if (!user) throw notFound('This enrolment link is invalid or has expired. Ask SafeRide for a new one.');
    if (!user.pendingTotpKey) throw conflict('Start enrolment first to get your authenticator key');
    const problem = passwordProblem(password, user.email);
    if (problem) throw badRequest(problem);
    const step = verifyTotp(user.pendingTotpKey, code);
    if (step === null) {
      audit({ action: 'auth.enroll.complete', outcome: 'denied', userId: user.id });
      throw badRequest('That code did not match. Check the time on your phone and try the newest code.');
    }
    Object.assign(user, { status: 'active', password, totpKey: user.pendingTotpKey, pendingTotpKey: null, enrollmentToken: null, totpLastStep: step });
    const session = createSession(user, true);
    audit({ action: 'auth.enroll.complete', outcome: 'success', userId: user.id });
    return sendJson(res, 200, authStep(session), {
      'set-cookie': sessionCookie(session.token, state.absoluteSeconds),
    });
  }

  // --- cases (P3 contract) ---
  if (req.method === 'GET' && route === '/referrals') {
    const { user } = requireFull(req);
    const allowed = ['status', 'pathway', 'cursor', 'limit', 'assignee', 'priority'];
    for (const key of url.searchParams.keys()) if (!allowed.includes(key)) throw badRequest();
    const status = url.searchParams.get('status');
    const pathway = url.searchParams.get('pathway');
    const assignee = url.searchParams.get('assignee');
    const priority = url.searchParams.get('priority');
    if (priority && !['urgent', 'normal'].includes(priority)) throw badRequest();
    if (assignee !== null && (assignee === '' || assignee.length > 64)) throw badRequest();
    const cursor = url.searchParams.get('cursor');
    const limitParam = url.searchParams.get('limit');
    if (status && ![...STATUSES, 'withdrawn'].includes(status)) throw badRequest();
    if (pathway && !['referral', 'escalation'].includes(pathway)) throw badRequest();
    const limit = limitParam === null ? state.pageSize : Number(limitParam);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw badRequest();
    const offset = cursor ? Number(Buffer.from(cursor, 'base64url').toString('utf8')) : 0;
    if (!Number.isInteger(offset) || offset < 0) throw badRequest();
    const rows = state.referrals
      .filter(item => item.orgId === user.orgId)
      .filter(item => {
        const active = item.revokedAt === null;
        if (status === 'withdrawn' && active) return false;
        if (status && status !== 'withdrawn' && (!active || item.status !== status)) return false;
        if (pathway && (!active || item.pathway !== pathway)) return false;
        // The case-management filters list only cases still shared.
        if (priority && (!active || priorityOf(item) !== priority)) return false;
        if (assignee === 'me' && (!active || activeAssigneeId(item) !== user.id)) return false;
        if (assignee === 'unassigned' && (!active || activeAssigneeId(item) !== null)) return false;
        if (assignee && assignee !== 'me' && assignee !== 'unassigned' && (!active || activeAssigneeId(item) !== assignee)) return false;
        return true;
      })
      .sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt));
    const page = rows.slice(offset, offset + limit);
    const next = offset + limit < rows.length ? Buffer.from(String(offset + limit)).toString('base64url') : null;
    caseAudit({ action: 'partner.referral.list', outcome: 'success', userId: user.id, background: !isUserInitiated(req) });
    return sendJson(res, 200, { referrals: page.map(queueItem), nextCursor: next });
  }

  if (req.method === 'GET' && route === '/summary') {
    const { user } = requireFull(req);
    if ([...url.searchParams.keys()].length > 0) throw badRequest();
    const open = state.referrals.filter(item => item.orgId === user.orgId && item.revokedAt === null && item.status !== 'closed');
    // Logged without the audit-failure switch, so a test's injected 503 hits the request it targets, not a poll.
    audit({ action: 'partner.summary.read', outcome: 'success', userId: user.id, background: !isUserInitiated(req) });
    return sendJson(res, 200, {
      needsAttention: open.filter(needsAttention).length,
      newTotal: open.filter(item => item.status === 'new').length,
      inProgress: open.filter(item => item.status === 'in_progress').length,
      unassigned: open.filter(item => activeAssigneeId(item) === null).length,
      mine: open.filter(item => activeAssigneeId(item) === user.id).length,
    });
  }

  if (req.method === 'GET' && route === '/staff') {
    const { user } = requireFull(req);
    caseAudit({ action: 'partner.staff.list', outcome: 'success', userId: user.id });
    const staff = state.users
      .filter(entry => isActiveStaff(entry, user.orgId))
      .map(entry => ({ id: entry.id, name: entry.displayName, role: entry.role }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return sendJson(res, 200, { staff });
  }

  const detail = route.match(/^\/referrals\/([^/]+)(\/.*)?$/);
  if (detail) {
    const [, rawId, rest = ''] = detail;

    if (req.method === 'GET' && rest === '') {
      const { user } = requireFull(req);
      const id = uuidParam(rawId);
      const item = state.referrals.find(referral => referral.id === id && referral.orgId === user.orgId);
      if (!item) {
        caseAudit({ action: 'partner.referral.read', outcome: 'denied', userId: user.id, referralId: id });
        throw notFound('Referral not found');
      }
      caseAudit({ action: 'partner.referral.read', outcome: 'success', userId: user.id, referralId: id });
      if (item.revokedAt) {
        return sendJson(res, 200, { referral: tombstone(item), view: null, attachments: [], timeline: [], notes: [], onwardReferrals: [] });
      }
      return sendJson(res, 200, {
        referral: referralSummary(item),
        view: item.view,
        attachments: item.attachments.map(attachmentView),
        timeline: timelineView(item),
        notes: item.notes,
        onwardReferrals: item.onward.map(onwardView),
      });
    }

    if (req.method === 'POST' && rest === '/status') {
      const { user } = requireFull(req, { csrf: true });
      const id = uuidParam(rawId);
      const { to, expectedStatus, closureReason } = strictBody(body, ['to', 'expectedStatus', 'closureReason']);
      if (!['acknowledged', 'in_progress', 'referred_onward', 'closed'].includes(to) || !STATUSES.includes(expectedStatus)) throw badRequest();
      const reason = closureReason;
      if (reason !== undefined && !CLOSURE_REASONS.includes(reason)) throw badRequest();
      if ((to === 'closed') !== (reason !== undefined)) throw badRequest();
      const item = activeReferral(user, id, 'partner.referral.status');
      if (item.status !== expectedStatus) {
        caseAudit({ action: 'partner.referral.status', outcome: 'denied', userId: user.id, referralId: id });
        throw conflict('This referral changed since you loaded it; reload and try again', { reason: 'stale', currentStatus: item.status });
      }
      if (!TRANSITIONS[item.status].includes(to)) {
        caseAudit({ action: 'partner.referral.status', outcome: 'denied', userId: user.id, referralId: id });
        throw conflict('That status change is not allowed from the current status', { reason: 'invalid_transition', currentStatus: item.status });
      }
      const now = new Date().toISOString();
      Object.assign(item, { status: to, statusChangedAt: now, closureReason: to === 'closed' ? reason : null });
      // As #314: an acknowledgement is one `acknowledged` entry with its actor; other status events name no actor.
      item.timeline.push(to === 'acknowledged'
        ? { event: 'acknowledged', status: to, at: now, actorId: user.id }
        : { event: 'status_change', status: to, at: now });
      caseAudit({ action: 'partner.referral.status', outcome: 'success', userId: user.id, referralId: id });
      return sendJson(res, 200, { referral: referralSummary(item) });
    }

    if (req.method === 'POST' && rest === '/assign') {
      const { user } = requireFull(req, { csrf: true });
      const id = uuidParam(rawId);
      const input = strictBody(body, ['assigneeId', 'expectedAssigneeId']);
      const { assigneeId, expectedAssigneeId } = input;
      if (!('assigneeId' in input) || !('expectedAssigneeId' in input)) throw badRequest();
      if (assigneeId !== null && typeof assigneeId !== 'string') throw badRequest();
      if (expectedAssigneeId !== null && typeof expectedAssigneeId !== 'string') throw badRequest();
      const item = activeReferral(user, id, 'partner.referral.assign');
      if (assigneeId !== null) {
        const target = state.users.find(entry => entry.id === assigneeId);
        if (!target || !isActiveStaff(target, user.orgId)) {
          caseAudit({ action: 'partner.referral.assign', outcome: 'denied', userId: user.id, referralId: id });
          throw new HttpError(400, 'bad_request', 'Only an active member of your organisation can be assigned', { reason: 'invalid_assignee' });
        }
      }
      if (activeAssigneeId(item) !== expectedAssigneeId) {
        caseAudit({ action: 'partner.referral.assign', outcome: 'denied', userId: user.id, referralId: id });
        throw conflict('This referral was reassigned since you loaded it; reload and try again', { reason: 'stale', currentAssignee: assigneeRef(item.assigneeId) });
      }
      if (activeAssigneeId(item) !== assigneeId) {
        item.assigneeId = assigneeId;
        const at = new Date().toISOString();
        item.timeline.push(assigneeId === null
          ? { event: 'unassigned', status: null, at, actorId: user.id }
          : { event: 'assigned', status: null, at, actorId: user.id, assigneeId });
      }
      caseAudit({ action: 'partner.referral.assign', outcome: 'success', userId: user.id, referralId: id });
      return sendJson(res, 200, { referral: referralSummary(item) });
    }

    if (req.method === 'POST' && rest === '/onward') {
      const { user } = requireFull(req, { csrf: true });
      const id = uuidParam(rawId);
      const input = strictBody(body, ['type', 'organisation', 'contactRole', 'externalReference', 'note', 'status']);
      if (!ONWARD_TYPES.includes(input.type)) throw badRequest();
      if (input.status !== undefined && !['planned', 'made'].includes(input.status)) throw badRequest();
      const text = {};
      for (const [field, limit] of Object.entries(ONWARD_LIMITS)) {
        const value = input[field];
        if (value === undefined || value === null) {
          text[field] = null;
          continue;
        }
        if (typeof value !== 'string' || CONTROL_CHARACTERS.test(value)) throw badRequest();
        const trimmed = value.trim();
        if ([...trimmed].length > limit) throw badRequest();
        text[field] = trimmed || null;
      }
      refuseTextIfAsked();
      const item = activeReferral(user, id, 'partner.onward.create');
      const now = new Date().toISOString();
      const onward = {
        id: `0e0e${randomBytes(2).toString('hex')}-0000-4000-8000-${randomBytes(6).toString('hex')}`,
        type: input.type, ...text, status: input.status ?? 'planned', createdAt: now, createdById: user.id, statusChangedAt: now,
      };
      item.onward.push(onward);
      item.timeline.push({ event: 'onward_created', status: null, at: now, actorId: user.id, onwardId: onward.id, createdStatus: onward.status });
      caseAudit({ action: 'partner.onward.create', outcome: 'success', userId: user.id, referralId: id });
      return sendJson(res, 200, { onward: onwardView(onward) });
    }

    const onwardStatus = rest.match(/^\/onward\/([^/]+)\/status$/);
    if (req.method === 'POST' && onwardStatus) {
      const { user } = requireFull(req, { csrf: true });
      const id = uuidParam(rawId);
      const onwardIdParam = uuidParam(onwardStatus[1]);
      const { to, expectedStatus } = strictBody(body, ['to', 'expectedStatus']);
      if (!Object.keys(ONWARD_TRANSITIONS).includes(to) || !Object.keys(ONWARD_TRANSITIONS).includes(expectedStatus)) throw badRequest();
      const item = activeReferral(user, id, 'partner.onward.status');
      const onward = item.onward.find(entry => entry.id === onwardIdParam);
      if (!onward) {
        caseAudit({ action: 'partner.onward.status', outcome: 'denied', userId: user.id, referralId: id });
        throw notFound('Onward referral not found');
      }
      if (onward.status !== expectedStatus) {
        caseAudit({ action: 'partner.onward.status', outcome: 'denied', userId: user.id, referralId: id });
        throw conflict('This onward referral changed since you loaded it; reload and try again', { reason: 'stale', currentStatus: onward.status });
      }
      if (!ONWARD_TRANSITIONS[onward.status].includes(to)) {
        caseAudit({ action: 'partner.onward.status', outcome: 'denied', userId: user.id, referralId: id });
        throw conflict('That status change is not allowed from the current status', { reason: 'invalid_transition', currentStatus: onward.status });
      }
      const now = new Date().toISOString();
      Object.assign(onward, { status: to, statusChangedAt: now });
      item.timeline.push({ event: 'onward_status', status: null, at: now, actorId: user.id, onwardId: onward.id, onwardStatus: to });
      caseAudit({ action: 'partner.onward.status', outcome: 'success', userId: user.id, referralId: id });
      return sendJson(res, 200, { onward: onwardView(onward) });
    }

    if (req.method === 'POST' && rest === '/notes') {
      const { user } = requireFull(req, { csrf: true });
      const id = uuidParam(rawId);
      const { body: raw } = strictBody(body, ['body']);
      const text = typeof raw === 'string' ? raw.trim() : '';
      if (!text || [...text].length > 2000 || CONTROL_CHARACTERS.test(text)) throw badRequest();
      refuseTextIfAsked();
      const item = activeReferral(user, id, 'partner.referral.note');
      const note = {
        id: `b0b0${randomBytes(2).toString('hex')}-0000-4000-8000-${randomBytes(6).toString('hex')}`,
        body: text, createdAt: new Date().toISOString(), author: { id: user.id, displayName: user.displayName },
      };
      item.notes.push(note);
      caseAudit({ action: 'partner.referral.note', outcome: 'success', userId: user.id, referralId: id });
      return sendJson(res, 200, { note });
    }

    const evidence = rest.match(/^\/evidence\/([^/]+)\/url$/);
    if (req.method === 'POST' && evidence) {
      const { user } = requireFull(req, { csrf: true });
      const id = uuidParam(rawId);
      const attachmentId = uuidParam(evidence[1]);
      const ids = { referralId: id, attachmentId };
      const item = activeReferral(user, id, 'partner.evidence.url', { attachmentId });
      const attachment = item.attachments.find(entry => entry.id === attachmentId);
      if (!attachment) {
        caseAudit({ action: 'partner.evidence.url', outcome: 'denied', userId: user.id, ...ids });
        throw notFound('Evidence not found');
      }
      if (state.evidenceDownload !== 'originals') {
        caseAudit({ action: 'partner.evidence.url', outcome: 'denied', userId: user.id, ...ids });
        throw conflict('Evidence downloads are not available to partners yet', { reason: EVIDENCE_NOT_SHAREABLE_YET });
      }
      if (!attachment.download.available) {
        caseAudit({ action: 'partner.evidence.url', outcome: 'denied', userId: user.id, ...ids });
        throw conflict('Evidence is not available for download', { reason: attachment.download.reason });
      }
      const expires = Date.now() + 60 * 1000;
      caseAudit({ action: 'partner.evidence.url', outcome: 'success', userId: user.id, ...ids });
      return sendJson(res, 200, {
        url: state.evidenceUrlOverride
          ?? `${MOCK_STORAGE_ORIGIN}/storage/${attachment.id}?expires=${expires}&signature=${signStorage(attachment.id, expires)}`,
        expiresInSeconds: 60,
      });
    }

    if (req.method === 'POST' && rest === '/callback') {
      const { user } = requireFull(req, { csrf: true });
      const id = uuidParam(rawId);
      if (user.role !== 'partner_caseworker') {
        caseAudit({ action: 'partner.referral.callback.read', outcome: 'denied', userId: user.id, referralId: id });
        throw forbidden('Only caseworkers can see a callback number');
      }
      const item = activeReferral(user, id, 'partner.referral.callback.read');
      if (!item.callbackNumber) {
        caseAudit({ action: 'partner.referral.callback.read', outcome: 'denied', userId: user.id, referralId: id });
        throw notFound('No callback number is shared for this referral');
      }
      caseAudit({ action: 'partner.referral.callback.read', outcome: 'success', userId: user.id, referralId: id });
      return sendJson(res, 200, { callback: { phoneNumber: item.callbackNumber } });
    }
  }

  throw notFound();
}

// --- test control and fake storage -----------------------------------------------

async function handleMock(req, res, url) {
  const route = url.pathname.slice('/__mock'.length);
  if (req.method === 'POST' && route === '/reset') {
    const body = await readJson(req);
    state = freshState(body?.scenario ?? 'default', { mfaRequired: body?.mfaRequired });
    if (Number.isInteger(body?.pageSize)) state.pageSize = body.pageSize;
    if (Number.isInteger(body?.absoluteSeconds)) state.absoluteSeconds = body.absoluteSeconds;
    if (body?.evidenceDownload === 'originals' || body?.evidenceDownload === 'disabled') state.evidenceDownload = body.evidenceDownload;
    state.pushConfigured = body?.pushConfigured === true;
    return sendJson(res, 204);
  }
  if (req.method === 'POST' && route === '/expire-sessions') {
    for (const session of state.sessions.values()) session.revoked = true;
    return sendJson(res, 204);
  }
  if (req.method === 'GET' && route === '/audit') return sendJson(res, 200, { entries: state.audit });
  if (req.method === 'GET' && route === '/sessions') {
    const sessions = [...state.sessions.values()].filter(session => !session.revoked && session.mfa)
      .map(session => ({ userId: session.userId, idleExpiresAt: session.idleExpiresAt, absoluteExpiresAt: session.absoluteExpiresAt }));
    return sendJson(res, 200, { sessions });
  }
  const status = route.match(/^\/referrals\/([A-Za-z0-9_-]+)\/status$/);
  if (req.method === 'POST' && status) {
    const body = await readJson(req);
    const item = state.referrals.find(entry => entry.id === status[1]);
    if (!item || !STATUSES.includes(body?.status)) throw notFound();
    Object.assign(item, { status: body.status, statusChangedAt: new Date().toISOString() });
    return sendJson(res, 204);
  }
  const withdraw = route.match(/^\/referrals\/([A-Za-z0-9_-]+)\/withdraw$/);
  if (req.method === 'POST' && withdraw) {
    const item = state.referrals.find(entry => entry.id === withdraw[1]);
    if (!item) throw notFound();
    // As the withdrawal hook does: revoke access and delete the notes and onward referrals.
    Object.assign(item, { revokedAt: new Date().toISOString(), notes: [], onward: [] });
    return sendJson(res, 204);
  }
  // Test-only: someone else changes the assignee or an onward referral behind the page's back.
  const assign = route.match(/^\/referrals\/([A-Za-z0-9_-]+)\/assign$/);
  if (req.method === 'POST' && assign) {
    const body = await readJson(req);
    const item = state.referrals.find(entry => entry.id === assign[1]);
    if (!item || (body?.assigneeId !== null && !state.users.some(user => user.id === body?.assigneeId))) throw notFound();
    item.assigneeId = body.assigneeId;
    item.timeline.push({ event: body.assigneeId ? 'assigned' : 'unassigned', status: null, at: new Date().toISOString(), actorId: STAFF_IDS.admin, assigneeId: body.assigneeId });
    return sendJson(res, 204);
  }
  // Test-only: a staff account stops being active (it can no longer be assigned).
  const disable = route.match(/^\/users\/([A-Za-z0-9_-]+)\/disable$/);
  if (req.method === 'POST' && disable) {
    const user = state.users.find(entry => entry.id === disable[1]);
    if (!user) throw notFound();
    user.status = 'disabled';
    // As #314's user:disable: release the user's referrals still shared, recorded as SafeRide's.
    const at = new Date().toISOString();
    for (const item of state.referrals) {
      if (item.assigneeId !== user.id || item.revokedAt !== null) continue;
      item.assigneeId = null;
      item.timeline.push({ event: 'unassigned', status: null, at, actorId: SAFERIDE_ACTOR.id });
    }
    return sendJson(res, 204);
  }
  if (req.method === 'POST' && route === '/refuse-text') {
    const body = await readJson(req);
    state.refuseText = Number.isInteger(body?.count) ? body.count : 1;
    return sendJson(res, 204);
  }
  const onwardControl = route.match(/^\/referrals\/([A-Za-z0-9_-]+)\/onward-status$/);
  if (req.method === 'POST' && onwardControl) {
    const body = await readJson(req);
    const item = state.referrals.find(entry => entry.id === onwardControl[1]);
    const onward = item?.onward.find(entry => entry.id === body?.onwardId) ?? item?.onward.at(-1);
    if (!onward || !Object.keys(ONWARD_TRANSITIONS).includes(body?.status)) throw notFound();
    Object.assign(onward, { status: body.status, statusChangedAt: new Date().toISOString() });
    return sendJson(res, 204);
  }
  if (req.method === 'POST' && route === '/evidence-download') {
    const body = await readJson(req);
    if (body?.mode !== 'originals' && body?.mode !== 'disabled') throw badRequest();
    state.evidenceDownload = body.mode;
    return sendJson(res, 204);
  }
  if (req.method === 'POST' && route === '/hang') {
    const body = await readJson(req);
    if (typeof body?.route !== 'string' || !Number.isInteger(body?.count)) throw badRequest();
    state.hang[body.route] = body.count;
    return sendJson(res, 204);
  }
  if (req.method === 'POST' && route === '/evidence-url-override') {
    // Test-only: make the next evidence links point somewhere else.
    const body = await readJson(req);
    state.evidenceUrlOverride = typeof body?.url === 'string' ? body.url : null;
    return sendJson(res, 204);
  }
  if (req.method === 'POST' && route === '/fail-audit') {
    const body = await readJson(req);
    state.failAudits = Number.isInteger(body?.count) ? body.count : 1;
    return sendJson(res, 204);
  }
  throw notFound();
}

function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, STATIC_HEADERS);
    res.end();
    return;
  }
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    pathname = '/';
  }
  // nginx: try_files $uri $uri.html $uri/index.html =404
  const candidates = pathname.endsWith('/')
    ? [path.join(pathname, 'index.html')]
    : [pathname, `${pathname}.html`, path.join(pathname, 'index.html')];
  for (const candidate of candidates) {
    const file = path.resolve(OUT_DIR, `.${candidate}`);
    if (file.startsWith(OUT_DIR + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      const ext = path.extname(file);
      const cache = pathname.startsWith('/_next/static/') ? 'public, max-age=31536000, immutable' : 'no-store';
      res.writeHead(200, { ...STATIC_HEADERS, 'content-type': MIME[ext] ?? 'application/octet-stream', 'cache-control': cache });
      res.end(req.method === 'HEAD' ? undefined : fs.readFileSync(file));
      return;
    }
  }
  res.writeHead(404, { ...STATIC_HEADERS, 'content-type': MIME['.html'], 'cache-control': 'no-store' });
  res.end(req.method === 'HEAD' ? undefined : fs.readFileSync(path.join(OUT_DIR, '404.html')));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', MOCK_ORIGIN);
  try {
    if (url.pathname === API || url.pathname.startsWith(`${API}/`)) await handleApi(req, res, url);
    else if (url.pathname.startsWith('/__mock/')) await handleMock(req, res, url);
    else serveStatic(req, res, url);
  } catch (error) {
    if (error instanceof HttpError) {
      sendJson(res, error.status, { code: error.code, message: error.message, details: error.details, requestId: `req_mock_${randomBytes(4).toString('hex')}` });
    } else {
      console.error('mock failure', error instanceof Error ? error.message : 'unknown');
      sendJson(res, 503, { code: 'service_unavailable', message: 'The partner service is unavailable' });
    }
  }
});

// The fake presigned storage host, on its own origin.
const storageServer = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', MOCK_STORAGE_ORIGIN);
  const match = url.pathname.match(/^\/storage\/([A-Za-z0-9_-]+)$/);
  const expires = Number(url.searchParams.get('expires'));
  const signature = url.searchParams.get('signature') ?? '';
  if (req.method !== 'GET' || !match || !(expires > Date.now()) || signature !== signStorage(match[1], expires)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end('Link expired or invalid\n');
    return;
  }
  res.writeHead(200, {
    'content-type': 'text/plain; charset=utf-8',
    'content-disposition': `attachment; filename="evidence-${match[1]}.txt"`,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(`Synthetic evidence file ${match[1]} for tests.\n`);
});

if (!fs.existsSync(path.join(OUT_DIR, 'index.html'))) {
  console.error(`No static export at ${OUT_DIR}. Run \`npm run build:e2e\` first.`);
  process.exit(1);
}

/** The export must allow the mock storage origin (npm run build:e2e), or downloads can't be tested. */
function exportAllowsMockStorage() {
  const dir = path.join(OUT_DIR, '_next', 'static', 'chunks');
  const files = fs.readdirSync(dir, { recursive: true }).filter(name => String(name).endsWith('.js'));
  return files.some(name => fs.readFileSync(path.join(dir, String(name)), 'utf8').includes(MOCK_STORAGE_ORIGIN));
}

if (!exportAllowsMockStorage()) {
  console.error(`The export at ${OUT_DIR} does not allow ${MOCK_STORAGE_ORIGIN} for evidence. Run \`npm run build:e2e\` first.`);
  process.exit(1);
}

storageServer.listen(MOCK_STORAGE_PORT, '127.0.0.1');

server.listen(MOCK_PORT, '127.0.0.1', () => {
  console.log(`Partner web + mock API on ${MOCK_ORIGIN} (synthetic data only)`);
});
