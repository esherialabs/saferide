/**
 * The partner dashboard's whole API layer: types, the status rules and the
 * HTTP client. Keep every request and response shape in this file so it can
 * be aligned with the API in one place.
 *
 * Auth endpoints follow P2 (`apps/api/src/routes/partnerAuth.ts`,
 * `middleware/partnerSession.ts`):
 *   POST /partner/v1/auth/login            {email, password}       -> AuthStepResponse (mfaRequired: false when the org has MFA off)
 *   POST /partner/v1/auth/totp/setup                               -> TotpSetupResponse (pre-MFA CSRF header; only when totpSetupRequired)
 *   POST /partner/v1/auth/totp             {code}                  -> AuthStepResponse (pre-MFA CSRF header)
 *   POST /partner/v1/auth/change-password  {currentPassword, newPassword} -> AuthStepResponse (a new session)
 *   POST /partner/v1/auth/logout                                   -> 204 (CSRF header)
 *   GET  /partner/v1/me                                            -> MeResponse
 * While `mustChangePassword` is set (an operator issued the password), every
 * route but /me, change-password and logout answers 403 password_change_required.
 *   POST /partner/v1/auth/enroll/start     {token}                 -> EnrollStartResponse
 *   POST /partner/v1/auth/enroll/complete  {token, password, code} -> AuthStepResponse
 *
 * Case endpoints follow P3 (`apps/api/src/routes/partnerCases.ts`,
 * `services/partnerCaseView.ts`; IDs are UUIDs):
 *   GET  /partner/v1/referrals?status=&pathway=&cursor=&limit=     -> {referrals, nextCursor}, newest first
 *   GET  /partner/v1/referrals/:id                                 -> {referral, view, attachments, timeline, notes}
 *   POST /partner/v1/referrals/:id/status {to, expectedStatus, closureReason?} -> {referral}; 409 stale/invalid
 *   POST /partner/v1/referrals/:id/notes  {body}                   -> {note}
 *   POST /partner/v1/referrals/:id/evidence/:attachmentId/url      -> {url, expiresInSeconds: 60}; 409 {details: {reason}}
 *        (off by default in P3: 409 reason 'evidence_not_shareable_yet')
 *   POST /partner/v1/referrals/:id/callback                        -> {callback: {phoneNumber}}; caseworkers only
 *
 * Case management (the contract shared with the API work on
 * codex/partner-case-management):
 *   GET  /partner/v1/referrals?assignee=me|unassigned|<userId>&priority=urgent|normal  (plus the filters above)
 *        Each row also has priority, needsAttention, assignee and an onward-referral summary.
 *   GET  /partner/v1/summary                                       -> {needsAttention, newTotal, inProgress, unassigned, mine}
 *   GET  /partner/v1/staff                                         -> {staff: [{id, name, role}]}
 *   POST /partner/v1/referrals/:id/assign {assigneeId|null, expectedAssigneeId|null} -> {referral}
 *        409 {details: {reason: 'stale', currentAssignee}}; 400 {details: {reason: 'invalid_assignee'}} (active users only)
 *   POST /partner/v1/referrals/:id/onward {type, organisation?, contactRole?, externalReference?, note?, status?} -> {onward}
 *   POST /partner/v1/referrals/:id/onward/:onwardId/status {to, expectedStatus} -> {onward}; 409 stale/invalid
 *        Each onward record carries `allowedTransitions`; the buttons follow it.
 * Acknowledging is an explicit status move (new -> acknowledged); opening a
 * case never acknowledges it.
 * Another org's referral is 404. A withdrawn referral reads as a tombstone
 * and every action on it is 410. An audit failure is 503.
 *
 * Sessions are HttpOnly cookies the browser sends by itself. The client only
 * holds the CSRF token (in memory) and sends it as `x-saferide-partner-csrf`
 * on writes. User-driven GETs send `x-saferide-partner-activity: interactive`
 * (P2), which extends the idle timer; the queue's periodic refresh (at most
 * every 60 s) sends no flag, so it does not. Bodyless POSTs send no
 * Content-Type (Fastify rejects an empty JSON body).
 */

export const PARTNER_API_BASE = '/partner/v1';
export const PARTNER_CSRF_HEADER = 'x-saferide-partner-csrf';

/**
 * P2's idle-timeout contract (partnerSession.ts PARTNER_ACTIVITY_HEADER): a
 * GET extends the 30-minute idle timer only when it sends this header with
 * the value "interactive"; writes always extend it. Every user-driven GET
 * sends it; background polling (the queue's periodic refresh) never does,
 * so an unattended screen still times out.
 */
export const PARTNER_ACTIVITY_HEADER = 'x-saferide-partner-activity';
export const PARTNER_ACTIVITY_INTERACTIVE = 'interactive';

/** Background polling never runs more often than this. */
export const BACKGROUND_REFRESH_MIN_MS = 60 * 1000;

/** Every request is abandoned after this long, so a hung call can never block the app (e.g. the idle check). */
export const REQUEST_TIMEOUT_MS = 15 * 1000;

/** Mirrors PARTNER_SESSION_POLICY in partnerAuthRepository.ts. */
export const PARTNER_SESSION_POLICY = {
  preMfaSeconds: 5 * 60,
  idleSeconds: 30 * 60,
  absoluteSeconds: 12 * 60 * 60,
} as const;

/** Mirrors PARTNER_PASSWORD_POLICY and partnerPasswordProblem in partnerCredentials.ts. */
export const PARTNER_PASSWORD_POLICY = { minLength: 12, maxLength: 256 } as const;

export const NOTE_MAX_LENGTH = 2000;

// ---------------------------------------------------------------------------
// P2 auth contract

import type { PartnerSafetyMap, SafetyMapWindow } from './partnerSafetyMap.ts';
export type SessionWindow = { idleExpiresAt: string; absoluteExpiresAt: string; coverageActive?: boolean; coverageEpoch?: number };
export type NotificationStatus = { configured: boolean; publicKey: string | null; enabled: boolean; lastAcceptedAt: string | null; lastOutcome: string | null };

export type AuthStepResponse = {
  /** The TOTP step comes next (the org requires MFA). */
  mfaRequired: boolean;
  /** With mfaRequired: this user has no authenticator yet and sets one up first (POST /auth/totp/setup). */
  totpSetupRequired?: boolean;
  /** An operator issued the password: choose a new one before anything else. */
  mustChangePassword?: boolean;
  csrfToken: string;
  session: SessionWindow;
};

/** The 403 code every route but /me, change-password and logout answers while the password must change. */
export const PASSWORD_CHANGE_REQUIRED = 'password_change_required';

export type TotpKey = { keyUri: string; secret: string; algorithm: string; digits: number; periodSeconds: number };

export type TotpSetupResponse = { totp: TotpKey };

export type PartnerRole = 'partner_admin' | 'partner_caseworker';

export type MeResponse = {
  user: { id: string; email: string; displayName: string };
  org: { id: string; stableId: string; displayName: string; mfaRequired?: boolean };
  role: PartnerRole;
  /** Only /me, change-password and logout work until the person chooses their own password. */
  mustChangePassword?: boolean;
  csrfToken: string;
  /** mfaVerified is false for a password-only sign-in (the org has MFA off). */
  session: SessionWindow & { mfaVerified?: boolean };
};

export type EnrollStartResponse = {
  user: { email: string; displayName: string };
  org: { displayName: string };
  role: PartnerRole;
  totp: TotpKey;
};

// ---------------------------------------------------------------------------
// P3 case contract (partnerCases.ts, partnerCaseView.ts, partnerReferralStatus.ts)

export const PARTNER_STATUSES = ['new', 'acknowledged', 'in_progress', 'referred_onward', 'closed'] as const;
export type PartnerStatus = (typeof PARTNER_STATUSES)[number];
/** Queue rows and the queue filter also know "withdrawn" (consent revoked). */
export type QueueStatus = PartnerStatus | 'withdrawn';
export const QUEUE_STATUS_FILTERS: readonly QueueStatus[] = [...PARTNER_STATUSES, 'withdrawn'];

export const PATHWAYS = ['referral', 'escalation'] as const;
export type Pathway = (typeof PATHWAYS)[number];

/**
 * Exactly P3's PARTNER_CLOSURE_REASONS (partnerReferralStatus.ts); the API
 * refuses anything else with 400. Labels are in i18n. A pre-008 row could
 * still hold free text, which is shown as it is.
 */
export const CLOSURE_REASONS = [
  'support_provided',
  'referred_elsewhere',
  'survivor_did_not_make_contact',
  'outside_mandate',
  'duplicate',
  'other',
] as const;
export type ClosureReason = (typeof CLOSURE_REASONS)[number];

/** Escalations are urgent; referrals are normal. */
export const PRIORITIES = ['urgent', 'normal'] as const;
export type Priority = (typeof PRIORITIES)[number];

/** A member of the partner's staff as other screens show them: an ID and a display name only. */
export type PersonRef = { id: string; name: string };

/** Where HURIA sent the survivor on to. Labels and icons are in the UI. */
export const ONWARD_TYPES = ['police', 'medical', 'psychosocial', 'legal_aid', 'shelter', 'child_protection', 'other'] as const;
export type OnwardType = (typeof ONWARD_TYPES)[number];

export const ONWARD_STATUSES = ['planned', 'made', 'accepted', 'declined', 'completed', 'cancelled'] as const;
export type OnwardStatus = (typeof ONWARD_STATUSES)[number];

/** The only onward-referral status moves the API accepts. */
export const ONWARD_TRANSITIONS: Readonly<Record<OnwardStatus, readonly OnwardStatus[]>> = {
  planned: ['made', 'cancelled'],
  made: ['accepted', 'declined'],
  accepted: ['completed'],
  declined: [],
  completed: [],
  cancelled: [],
};

/** A new onward referral starts as planned or as already made. */
export const ONWARD_INITIAL_STATUSES = ['planned', 'made'] as const;
export type OnwardInitialStatus = (typeof ONWARD_INITIAL_STATUSES)[number];

/** Field limits in characters (the API refuses longer values with 400). */
export const ONWARD_LIMITS = { organisation: 120, contactRole: 120, externalReference: 80, note: 1000 } as const;
export type OnwardTextField = keyof typeof ONWARD_LIMITS;

/** A queue row's onward-referral summary: how many, and the latest one's type and status. */
export type OnwardSummary = { count: number; latest: { type: OnwardType; status: OnwardStatus } | null };

/** A queue row (PartnerQueueItem): the minimum needed to pick a case. */
export type ReferralQueueItem = {
  id: string;
  reference: string;
  /** Null for a withdrawn referral. */
  pathway: Pathway | null;
  status: QueueStatus;
  withdrawn: boolean;
  receivedAt: string;
  statusChangedAt: string;
  priority: Priority;
  /** An urgent case nobody has acknowledged yet. */
  needsAttention: boolean;
  /** Who is in charge, or null when nobody is. */
  assignee: PersonRef | null;
  onward: OnwardSummary;
};

/** An open referral (PartnerReferralSummary). */
export type Referral = {
  id: string;
  reference: string;
  pathway: Pathway | null;
  status: PartnerStatus;
  closureReason: string | null;
  withdrawn: false;
  receivedAt: string;
  statusChangedAt: string;
  /** The survivor consented to share a callback number with this org. */
  callbackShared: boolean;
  /** The server's allowed moves from the current status. */
  allowedTransitions: PartnerStatus[];
  priority: Priority;
  needsAttention: boolean;
  assignee: PersonRef | null;
};

/** A withdrawn referral (PartnerReferralTombstone): no content at all. */
export type ReferralTombstone = {
  id: string;
  reference: string;
  status: 'withdrawn';
  withdrawn: true;
  receivedAt: string;
  withdrawnAt: string;
};

export type ReferralBrief = {
  incidentCategories?: string[];
  timeContext?: { date: string; accuracy: 'exact' | 'approximate' | 'estimated' };
  locationType?: string;
  isOngoing?: boolean;
};

/** Referral pathway: only the brief fields the survivor selected. */
export type ReferralView = {
  kind: 'referral';
  channel: 'call' | 'whatsapp' | 'sms';
  brief: ReferralBrief | null;
};

export type RedactionLevel = 'none' | 'light' | 'heavy';

export type EvidenceType = 'photo' | 'video' | 'audio' | 'document';

export type ManifestItem = {
  type: EvidenceType;
  label: string;
  sizeBytes?: number;
  capturedAt?: string;
  description?: string;
  transcript?: string;
  metadataStatus: string;
  privacyRequests: string[];
};

/** Escalation pathway: the stored packet, already redacted on the phone. */
export type EscalationView = {
  kind: 'escalation';
  generatedAt: string;
  redactionLevel: RedactionLevel;
  contact: { preference: 'alias'; alias: string; label: string } | { preference: 'none'; label: string };
  content: {
    timeRange: string;
    location: string;
    incidentDescription: string;
    statement: string;
    impactSummary?: string;
    witnessDetails?: string;
    tags: string[];
    patterns: string[];
    transportIdentifiers: string[];
  };
  evidenceManifest: ManifestItem[];
  redaction: {
    appliedLabels: string[];
    textFields: string[];
    evidenceMetadata: string;
    mediaProcessing: string[];
  };
};

/** The stored workflow did not match a known shape. */
export type UnavailableView = { kind: 'unavailable' };

export type CaseView = ReferralView | EscalationView | UnavailableView;

/**
 * P3 keeps partner evidence downloads off until metadata-stripped
 * derivatives exist (PARTNER_EVIDENCE_DOWNLOAD=disabled): every item then
 * says this, and the URL endpoint answers 409 with it.
 */
export const EVIDENCE_NOT_SHAREABLE_YET = 'evidence_not_shareable_yet';

/** Download refusal reasons: getEvidenceDownloadDecision (evidenceQuarantine.ts) plus the partner switch. */
export type EvidenceRefusalReason =
  | typeof EVIDENCE_NOT_SHAREABLE_YET
  | 'not_uploaded' | 'hash_missing' | 'hash_mismatch' | 'unscanned' | 'scan_rejected' | 'quarantined';

/** PartnerAttachmentView. */
export type Attachment = {
  id: string;
  /** photo | video | audio | document | file */
  mediaType: string;
  /** A generic, server-made name such as `evidence-photo-1.jpg`. */
  displayName: string;
  mimeType: string | null;
  sizeBytes: number | null;
  receivedAt: string;
  download: { available: true } | { available: false; reason: string };
};

/** One onward referral on a case (contact roles only, never personal details). */
export type OnwardReferral = {
  id: string;
  type: OnwardType;
  organisation: string | null;
  contactRole: string | null;
  /** The other organisation's reference, such as a police OB number. */
  externalReference: string | null;
  note: string | null;
  status: OnwardStatus;
  createdAt: string;
  createdBy: PersonRef;
  statusChangedAt: string;
  /** The server's allowed moves from the current status. */
  allowedTransitions: OnwardStatus[];
};

export const TIMELINE_EVENTS = [
  'received', 'status_change', 'acknowledged', 'assigned', 'unassigned', 'onward_created', 'onward_status',
] as const;
export type TimelineEventKind = (typeof TIMELINE_EVENTS)[number];

/**
 * A history entry. Case-management entries name who did it (`actor`);
 * `assignee` goes with "assigned", `onward` with the two onward entries.
 * Anything missing is described without it.
 */
export type TimelineEvent = {
  event: TimelineEventKind;
  status: PartnerStatus | null;
  at: string;
  actor?: PersonRef | null;
  assignee?: PersonRef | null;
  onward?: { id?: string; type: OnwardType; status: OnwardStatus } | null;
};

export type Note = { id: string; body: string; createdAt: string; author: { id: string; displayName: string } };

export type ReferralListResponse = { referrals: ReferralQueueItem[]; nextCursor: string | null };

export type ReferralDetailResponse = {
  referral: Referral | ReferralTombstone;
  /** Null for a tombstone (with empty attachments, timeline and notes). */
  view: CaseView | null;
  attachments: Attachment[];
  timeline: TimelineEvent[];
  notes: Note[];
  /** Empty for a tombstone (onward referrals are deleted with the sharing). */
  onwardReferrals: OnwardReferral[];
};

/** GET /summary: counts for this organisation's open cases (the banner and the queue chips). */
export type CaseSummary = {
  /** Urgent cases nobody has acknowledged yet. */
  needsAttention: number;
  newTotal: number;
  inProgress: number;
  unassigned: number;
  /** Assigned to the signed-in person. */
  mine: number;
};

export type StaffMember = { id: string; name: string; role: PartnerRole };

export type OnwardInput = {
  type: OnwardType;
  organisation?: string;
  contactRole?: string;
  externalReference?: string;
  note?: string;
  status?: OnwardInitialStatus;
};

export type EvidenceLinkResponse = { url: string; expiresInSeconds: number };

export type CallbackResponse = { callback: { phoneNumber: string } };

/** `me`, `unassigned`, or a staff member's ID. */
export type AssigneeFilter = 'me' | 'unassigned' | (string & {});

export type ReferralFilter = {
  status?: QueueStatus;
  pathway?: Pathway;
  assignee?: AssigneeFilter;
  priority?: Priority;
  cursor?: string;
  limit?: number;
};

// ---------------------------------------------------------------------------
// Rules

/**
 * Status moves come from the server (`referral.allowedTransitions`, which
 * mirrors the migration 007 trigger: one step forward or close; closed is
 * final). Only known, forward statuses are offered.
 */
export function nextStatuses(referral: Referral): PartnerStatus[] {
  const allowed = Array.isArray(referral.allowedTransitions) ? referral.allowedTransitions : [];
  return PARTNER_STATUSES.filter(status => status !== 'new' && allowed.includes(status));
}

/**
 * The onward-referral statuses allowed next: the server's
 * `allowedTransitions`, limited to moves the contract knows (nothing after
 * declined, completed or cancelled). Without the field, the contract table.
 */
export function nextOnwardStatuses(onward: Pick<OnwardReferral, 'status'> & { allowedTransitions?: unknown }): OnwardStatus[] {
  const known = ONWARD_TRANSITIONS[onward.status] ?? [];
  if (!Array.isArray(onward.allowedTransitions)) return [...known];
  return known.filter(status => (onward.allowedTransitions as unknown[]).includes(status));
}

/** Who holds a case now, from a stale-assignment 409 (`details.currentAssignee`). */
export function currentAssigneeOf(error: unknown): PersonRef | null | undefined {
  if (!(error instanceof PartnerApiError) || error.kind !== 'conflict') return undefined;
  const details = error.details && typeof error.details === 'object' ? (error.details as Record<string, unknown>) : {};
  if (!('currentAssignee' in details)) return undefined;
  return personRef(details.currentAssignee);
}

/** The reason code in an error's details, if any (e.g. 'stale', 'invalid_assignee'). */
export function errorReason(error: unknown): string | undefined {
  if (!(error instanceof PartnerApiError) || !error.details || typeof error.details !== 'object') return undefined;
  const reason = (error.details as Record<string, unknown>).reason;
  return typeof reason === 'string' ? reason : undefined;
}

export function isOnwardType(value: unknown): value is OnwardType {
  return typeof value === 'string' && (ONWARD_TYPES as readonly string[]).includes(value);
}

export function isOnwardStatus(value: unknown): value is OnwardStatus {
  return typeof value === 'string' && (ONWARD_STATUSES as readonly string[]).includes(value);
}

export function isPriority(value: unknown): value is Priority {
  return typeof value === 'string' && (PRIORITIES as readonly string[]).includes(value);
}

/**
 * The actor of history entries SafeRide itself made (e.g. releasing the
 * cases of a user an operator disabled or reset). Not a user: never matched
 * against the signed-in person or offered as an assignee.
 */
export const SAFERIDE_ACTOR_ID = 'saferide';

export function isSafeRideActor(person: PersonRef | null | undefined): boolean {
  return person?.id === SAFERIDE_ACTOR_ID;
}

/**
 * Control characters the API refuses in partner text (400): everything in
 * C0 and DEL except newline and tab. Carriage returns go too.
 */
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B-\u001F\u007F]/g;

/** Removes the control characters the API refuses, keeping newlines and tabs. */
export function stripControlCharacters(text: string): string {
  return text.replace(CONTROL_CHARACTERS, '');
}

export type OnwardProblem = { field: 'type' | OnwardTextField; problem: 'required' | 'too_long' };

/** Client-side check of a new onward referral; the server stays authoritative. */
export function onwardInputProblems(input: { type: string; status?: string } & Partial<Record<OnwardTextField, string>>): OnwardProblem[] {
  const problems: OnwardProblem[] = [];
  if (!isOnwardType(input.type)) problems.push({ field: 'type', problem: 'required' });
  for (const field of Object.keys(ONWARD_LIMITS) as OnwardTextField[]) {
    const value = input[field];
    if (typeof value === 'string' && [...value.trim()].length > ONWARD_LIMITS[field]) problems.push({ field, problem: 'too_long' });
  }
  return problems;
}

/** The request body for a new onward referral: trimmed, with empty optional fields left out. */
export function onwardRequestBody(input: OnwardInput): Record<string, string> {
  const body: Record<string, string> = { type: input.type };
  for (const field of Object.keys(ONWARD_LIMITS) as OnwardTextField[]) {
    const value = input[field] === undefined ? undefined : stripControlCharacters(input[field]!).trim();
    if (value) body[field] = value;
  }
  if (input.status) body.status = input.status;
  return body;
}

function personRef(value: unknown): PersonRef | null {
  if (!value || typeof value !== 'object') return null;
  const { id, name } = value as Record<string, unknown>;
  return typeof id === 'string' && typeof name === 'string' ? { id, name } : null;
}

function onwardSummary(value: unknown): OnwardSummary {
  if (!value || typeof value !== 'object') return { count: 0, latest: null };
  const { count, latest } = value as Record<string, unknown>;
  const safeCount = typeof count === 'number' && Number.isInteger(count) && count > 0 ? count : 0;
  const last = latest && typeof latest === 'object' ? (latest as Record<string, unknown>) : null;
  return {
    count: safeCount,
    latest: last && isOnwardType(last.type) && isOnwardStatus(last.status) ? { type: last.type, status: last.status } : null,
  };
}

/**
 * Fills in case-management fields a row may lack (an older API, or a row
 * no longer shared), so the queue never breaks on them. A row no longer
 * shared never shows a priority, an assignee or onward referrals: those
 * would say more than "no longer shared".
 */
export function normaliseQueueItem(row: ReferralQueueItem): ReferralQueueItem {
  const raw = row as Partial<ReferralQueueItem>;
  if (row.withdrawn) {
    return { ...row, priority: 'normal', needsAttention: false, assignee: null, onward: { count: 0, latest: null } };
  }
  return {
    ...row,
    priority: isPriority(raw.priority) ? raw.priority : row.pathway === 'escalation' ? 'urgent' : 'normal',
    needsAttention: raw.needsAttention === true,
    assignee: personRef(raw.assignee),
    onward: onwardSummary(raw.onward),
  };
}

/** The same for an open referral's summary. */
export function normaliseReferral(referral: Referral): Referral {
  const raw = referral as Partial<Referral>;
  return {
    ...referral,
    priority: isPriority(raw.priority) ? raw.priority : referral.pathway === 'escalation' ? 'urgent' : 'normal',
    needsAttention: raw.needsAttention === true,
    assignee: personRef(raw.assignee),
  };
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** Missing or malformed counts are unavailable, never a false all-clear. */
export function normaliseSummary(value: unknown): CaseSummary {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  for (const key of ['needsAttention', 'newTotal', 'inProgress', 'unassigned', 'mine']) {
    if (typeof raw[key] !== 'number' || !Number.isSafeInteger(raw[key]) || (raw[key] as number) < 0) {
      throw new PartnerApiError({ kind: 'unavailable', status: 200 });
    }
  }
  return {
    needsAttention: count(raw.needsAttention),
    newTotal: count(raw.newTotal),
    inProgress: count(raw.inProgress),
    unassigned: count(raw.unassigned),
    mine: count(raw.mine),
  };
}

export function isTombstone(referral: Referral | ReferralTombstone): referral is ReferralTombstone {
  return referral.withdrawn === true;
}

export function isPartnerStatus(value: unknown): value is PartnerStatus {
  return typeof value === 'string' && (PARTNER_STATUSES as readonly string[]).includes(value);
}

export function isPathway(value: unknown): value is Pathway {
  return typeof value === 'string' && (PATHWAYS as readonly string[]).includes(value);
}

export function isClosureReasonCode(value: unknown): value is ClosureReason {
  return typeof value === 'string' && (CLOSURE_REASONS as readonly string[]).includes(value);
}

/** P3 IDs are UUIDs; anything else never reaches a request path. */
export function isReferralId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/** Enrolment tokens look like `srpe_` plus 43 base64url characters (partnerTokens.ts). */
export function isEnrollmentToken(value: unknown): value is string {
  return typeof value === 'string' && /^srpe_[A-Za-z0-9_-]{43}$/.test(value);
}

export const DEFAULT_EVIDENCE_ORIGIN = 'https://storage.saferide.esheria.org';

/**
 * The only origin evidence links may point at: P3's presigned storage host.
 * Set at build time (PARTNER_EVIDENCE_ORIGIN, validated in next.config.mjs);
 * the e2e build uses the mock's storage origin.
 */
export const EVIDENCE_ORIGIN: string = process.env.PARTNER_EVIDENCE_ORIGIN || DEFAULT_EVIDENCE_ORIGIN;

/**
 * An evidence link must be an absolute URL on exactly the allowed storage
 * origin (https; http only for a localhost test origin), with no
 * credentials. Anything else (another host, a subdomain, javascript:, data:,
 * a relative path) is refused.
 */
export function isSafeDownloadUrl(url: string, allowedOrigin: string): boolean {
  try {
    const parsed = new URL(url);
    const localHttp = parsed.protocol === 'http:' && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');
    return parsed.origin === allowedOrigin && (parsed.protocol === 'https:' || localHttp) && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

/** Mirrors COMMON_PASSWORD_FRAGMENTS and PARTNER_PASSWORD_MIN_UNPREDICTABLE in partnerCredentials.ts. */
const COMMON_PASSWORD_FRAGMENTS = [
  'password', 'passw0rd', 'p@ssw0rd', 'saferide', 'esheria', 'huria', 'qwerty', 'azerty', 'asdf', 'zxcv',
  'letmein', 'welcome', 'changeme', 'iloveyou', 'admin', 'nairobi', 'mombasa', 'kenya',
];
const MIN_UNPREDICTABLE = 8;

/** Mirror of partnerPasswordUnpredictableChars: common words dropped, each run (aaaa, abcd, 4321) counted once. */
export function unpredictableChars(password: string): number {
  let rest = password.normalize('NFKC').toLowerCase();
  for (const fragment of COMMON_PASSWORD_FRAGMENTS) rest = rest.split(fragment).join('\u0000');
  let count = 0;
  let previous: number | null = null;
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

export type PasswordProblem = 'too_short' | 'too_long' | 'contains_email' | 'repetitive' | 'predictable';

/** Client-side mirror of partnerPasswordProblem; the server stays authoritative. */
export function passwordProblem(password: string, email: string): PasswordProblem | null {
  const length = [...password].length;
  if (length < PARTNER_PASSWORD_POLICY.minLength) return 'too_short';
  if (length > PARTNER_PASSWORD_POLICY.maxLength) return 'too_long';
  const lowered = password.toLowerCase();
  const localPart = email.toLowerCase().split('@')[0] ?? '';
  if (lowered === email.toLowerCase() || (localPart.length >= 4 && lowered.includes(localPart))) return 'contains_email';
  if (new Set(password).size < 5) return 'repetitive';
  if (unpredictableChars(password) < MIN_UNPREDICTABLE) return 'predictable';
  return null;
}

// ---------------------------------------------------------------------------
// Errors

export type PartnerApiErrorKind =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'gone'
  | 'rate_limited'
  | 'unavailable'
  | 'timeout'
  | 'network';

export class PartnerApiError extends Error {
  readonly kind: PartnerApiErrorKind;
  readonly status: number;
  readonly code: string | undefined;
  readonly requestId: string | undefined;
  readonly details: unknown;
  /** The server's message; shown only where it carries no case content (auth and enrolment). */
  readonly serverMessage: string | undefined;

  constructor(init: { kind: PartnerApiErrorKind; status: number; code?: string; message?: string; requestId?: string; details?: unknown }) {
    super(`Partner API ${init.kind} (${init.status})`);
    this.name = 'PartnerApiError';
    this.kind = init.kind;
    this.status = init.status;
    this.code = init.code;
    this.serverMessage = init.message;
    this.requestId = init.requestId;
    this.details = init.details;
  }
}

export function errorKindForStatus(status: number): PartnerApiErrorKind {
  if (status === 400 || status === 413 || status === 415 || status === 422) return 'bad_request';
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 410) return 'gone';
  if (status === 429) return 'rate_limited';
  return 'unavailable';
}

// ---------------------------------------------------------------------------
// Client

export type PartnerApiOptions = {
  fetch?: typeof fetch;
  /** The current CSRF token (memory only), or null when signed out. */
  getCsrfToken: () => string | null;
  /** A signed-in request got 401: the session ended on the server. */
  onSessionExpired: () => void;
  /** Any successful request from a signed-in session (it slides the server idle timer). */
  onServerTouch?: () => void;
  now?: () => number;
  /** Defaults to EVIDENCE_ORIGIN. */
  evidenceOrigin?: string;
  /** Any successful request made with the session, background or not: the session still exists. */
  onSessionConfirmed?: () => void;
  /** Defaults to REQUEST_TIMEOUT_MS. */
  timeoutMs?: number;
};

type RequestOptions = {
  method?: 'GET' | 'POST';
  body?: unknown;
  csrf?: boolean;
  /** 401 means "your session ended" (true for everything after sign-in). */
  sessionRequired?: boolean;
  /** Made by the app, not the person: sent without the activity flag, so it does not extend the idle timer. */
  background?: boolean;
};

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function segment(id: string): string {
  if (!isReferralId(id)) throw new PartnerApiError({ kind: 'not_found', status: 404 });
  return encodeURIComponent(id);
}

export function referralListQuery(filter: ReferralFilter): string {
  const params = new URLSearchParams();
  if (filter.status) params.set('status', filter.status);
  if (filter.pathway) params.set('pathway', filter.pathway);
  if (filter.assignee) params.set('assignee', filter.assignee);
  if (filter.priority) params.set('priority', filter.priority);
  if (filter.cursor) params.set('cursor', filter.cursor);
  if (filter.limit) params.set('limit', String(filter.limit));
  const query = params.toString();
  return query ? `?${query}` : '';
}

export function createPartnerApi(options: PartnerApiOptions) {
  const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const clientNow = options.now ?? (() => Date.now());
  const evidenceOrigin = options.evidenceOrigin ?? EVIDENCE_ORIGIN;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  let lastServerDate: { server: number; client: number } | null = null;

  async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const sessionAtStart = options.getCsrfToken();
    const method = opts.method ?? 'GET';
    const headers: Record<string, string> = { accept: 'application/json' };
    if (method === 'GET' && !opts.background) headers[PARTNER_ACTIVITY_HEADER] = PARTNER_ACTIVITY_INTERACTIVE;
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
    if (opts.csrf) {
      const token = options.getCsrfToken();
      if (!token) {
        if (opts.sessionRequired) options.onSessionExpired();
        throw new PartnerApiError({ kind: 'unauthorized', status: 401 });
      }
      headers[PARTNER_CSRF_HEADER] = token;
    }

    // Abandon the request (and its body) after timeoutMs, so it never hangs.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const failed = (fallback: PartnerApiErrorKind, status: number) =>
      new PartnerApiError({ kind: controller.signal.aborted ? 'timeout' : fallback, status: controller.signal.aborted ? 0 : status });
    async function finish(): Promise<T> {
      let response: Response;
      try {
        response = await doFetch(`${PARTNER_API_BASE}${path}`, {
          method,
          headers,
          body,
          mode: 'same-origin',
          credentials: 'same-origin',
          cache: 'no-store',
          redirect: 'error',
          referrerPolicy: 'no-referrer',
          signal: controller.signal,
        });
      } catch {
        throw failed('network', 0);
      }

      const serverDate = Date.parse(response.headers.get('date') ?? '');
      if (Number.isFinite(serverDate)) lastServerDate = { server: serverDate, client: clientNow() };

      if (response.ok) {
        let result: T;
        if (response.status === 204) {
          result = undefined as T;
        } else {
          try {
            result = (await response.json()) as T;
          } catch {
            throw failed('unavailable', response.status);
          }
        }
        const sameSession = options.getCsrfToken() === sessionAtStart;
        if ((opts.sessionRequired || opts.background) && sameSession) options.onSessionConfirmed?.();
        // A background request does not slide the server's idle timer.
        if (opts.sessionRequired && !opts.background && sameSession) options.onServerTouch?.();
        return result;
      }

      return failure(response);
    }

    async function failure(response: Response): Promise<never> {
      let payload: Record<string, unknown> = {};
      try {
        const parsed: unknown = await response.json();
        if (parsed && typeof parsed === 'object') payload = parsed as Record<string, unknown>;
      } catch {
        // Not JSON (for example a gateway page); keep only the status.
      }
      const error = new PartnerApiError({
        kind: errorKindForStatus(response.status),
        status: response.status,
        code: readString(payload.code),
        message: readString(payload.message),
        requestId: readString(payload.requestId),
        details: payload.details,
      });
      if (error.kind === 'unauthorized' && opts.sessionRequired && options.getCsrfToken() === sessionAtStart) options.onSessionExpired();
      throw error;
    }

    try {
      return await finish();
    } finally {
      clearTimeout(timer);
    }
  }

  function requireAuthStep(value: AuthStepResponse): AuthStepResponse {
    if (!value || typeof value.csrfToken !== 'string' || !value.session) {
      throw new PartnerApiError({ kind: 'unavailable', status: 200 });
    }
    return value;
  }

  return {
    /** The server's current time, from the last response's Date header (for session deadlines). */
    serverNow(): number | undefined {
      return lastServerDate ? lastServerDate.server + (clientNow() - lastServerDate.client) : undefined;
    },
    async coverage(enabled: boolean): Promise<{ session: SessionWindow }> {
      return request('/coverage', { method: 'POST', body: { enabled }, csrf: true, sessionRequired: true });
    },
    async notifications(): Promise<NotificationStatus> {
      return request('/notifications', { sessionRequired: true, background: true });
    },
    async safetyMap(days: SafetyMapWindow = 30, options: { background?: boolean } = {}): Promise<PartnerSafetyMap> {
      return request(`/safety-map?days=${days}`, { sessionRequired: true, background: options.background });
    },
    async subscribeNotifications(subscription: { endpoint: string; keys: { p256dh: string; auth: string } }): Promise<{ enabled: boolean }> {
      return request('/notifications/subscribe', { method: 'POST', body: subscription, csrf: true, sessionRequired: true });
    },
    async unsubscribeNotifications(): Promise<{ enabled: boolean }> {
      return request('/notifications/unsubscribe', { method: 'POST', body: {}, csrf: true, sessionRequired: true });
    },
    async testNotifications(): Promise<{ queued: boolean }> {
      return request('/notifications/test', { method: 'POST', body: {}, csrf: true, sessionRequired: true });
    },
    async coverageHeartbeat(): Promise<{ session: SessionWindow }> {
      return request('/coverage/heartbeat', { method: 'POST', body: {}, csrf: true, sessionRequired: true, background: true });
    },

    // P2 auth
    async login(email: string, password: string): Promise<AuthStepResponse> {
      return requireAuthStep(await request<AuthStepResponse>('/auth/login', { method: 'POST', body: { email, password } }));
    },
    async verifyTotp(code: string): Promise<AuthStepResponse> {
      return requireAuthStep(await request<AuthStepResponse>('/auth/totp', { method: 'POST', body: { code }, csrf: true }));
    },
    /** Sign-in enrolment: a new authenticator key inside the pre-MFA session (each call issues a new key). */
    async totpSetup(): Promise<TotpSetupResponse> {
      const result = await request<TotpSetupResponse>('/auth/totp/setup', { method: 'POST', csrf: true });
      if (!result || typeof result.totp?.keyUri !== 'string' || typeof result.totp.secret !== 'string') {
        throw new PartnerApiError({ kind: 'unavailable', status: 200 });
      }
      return result;
    },
    /** Answers a new session (new cookie and CSRF token); every other session of the person ends. */
    async changePassword(currentPassword: string, newPassword: string): Promise<AuthStepResponse> {
      return requireAuthStep(await request<AuthStepResponse>('/auth/change-password', {
        method: 'POST', body: { currentPassword, newPassword }, csrf: true, sessionRequired: true,
      }));
    },
    async logout(): Promise<void> {
      await request<void>('/auth/logout', { method: 'POST', csrf: true });
    },
    async me(): Promise<MeResponse> {
      return request<MeResponse>('/me', { sessionRequired: true });
    },
    /**
     * Reads the session without extending it (no activity flag) and without
     * treating a 401 as "ended": the caller decides why it ended. Used to
     * check, storage-free, whether another tab kept the session active or
     * signed it out.
     */
    async checkSession(): Promise<MeResponse> {
      return request<MeResponse>('/me', { background: true });
    },
    async enrollStart(token: string): Promise<EnrollStartResponse> {
      return request<EnrollStartResponse>('/auth/enroll/start', { method: 'POST', body: { token } });
    },
    async enrollComplete(token: string, password: string, code: string): Promise<AuthStepResponse> {
      return requireAuthStep(
        await request<AuthStepResponse>('/auth/enroll/complete', { method: 'POST', body: { token, password, code } }),
      );
    },

    // P3 cases (assumed contract)
    /** `background: true` for the periodic refresh: no activity flag (see PARTNER_ACTIVITY_HEADER). */
    async listReferrals(filter: ReferralFilter = {}, mode: { background?: boolean } = {}): Promise<ReferralListResponse> {
      const page = await request<ReferralListResponse>(`/referrals${referralListQuery(filter)}`, {
        sessionRequired: true, background: mode.background === true,
      });
      const rows = Array.isArray(page?.referrals) ? page.referrals.map(normaliseQueueItem) : [];
      return { referrals: rows, nextCursor: typeof page?.nextCursor === 'string' ? page.nextCursor : null };
    },
    async getReferral(id: string): Promise<ReferralDetailResponse> {
      const detail = await request<ReferralDetailResponse>(`/referrals/${segment(id)}`, { sessionRequired: true });
      return {
        ...detail,
        referral: isTombstone(detail.referral) ? detail.referral : normaliseReferral(detail.referral),
        onwardReferrals: Array.isArray(detail.onwardReferrals) ? detail.onwardReferrals : [],
      };
    },
    /**
     * The attention counts. Always a background read (no activity flag): it
     * is polled for the banner, so it must never keep an unattended session
     * alive.
     */
    async summary(): Promise<CaseSummary> {
      return normaliseSummary(await request<unknown>('/summary', { sessionRequired: true, background: true }));
    },
    /** Who a case can be assigned to (asked for when the person opens the picker). */
    async staff(): Promise<StaffMember[]> {
      const result = await request<{ staff: StaffMember[] }>('/staff', { sessionRequired: true });
      return Array.isArray(result?.staff)
        ? result.staff.filter(member => typeof member?.id === 'string' && typeof member?.name === 'string' && member.id !== SAFERIDE_ACTOR_ID)
        : [];
    },
    /**
     * Puts someone in charge (or nobody, with null). `expectedAssigneeId` is
     * who the person saw in charge; the API answers 409 if that changed.
     */
    async assign(id: string, change: { assigneeId: string | null; expectedAssigneeId: string | null }): Promise<{ referral: Referral }> {
      const result = await request<{ referral: Referral }>(`/referrals/${segment(id)}/assign`, {
        method: 'POST', body: { assigneeId: change.assigneeId, expectedAssigneeId: change.expectedAssigneeId }, csrf: true, sessionRequired: true,
      });
      return { referral: normaliseReferral(result.referral) };
    },
    /** The explicit "Acknowledge" action: new -> acknowledged (opening a case never does this). */
    async acknowledge(id: string): Promise<{ referral: Referral }> {
      const result = await request<{ referral: Referral }>(`/referrals/${segment(id)}/status`, {
        method: 'POST', body: { to: 'acknowledged', expectedStatus: 'new' }, csrf: true, sessionRequired: true,
      });
      return { referral: normaliseReferral(result.referral) };
    },
    async addOnward(id: string, input: OnwardInput): Promise<{ onward: OnwardReferral }> {
      return request<{ onward: OnwardReferral }>(`/referrals/${segment(id)}/onward`, {
        method: 'POST', body: onwardRequestBody(input), csrf: true, sessionRequired: true,
      });
    },
    async changeOnwardStatus(
      id: string,
      onwardId: string,
      change: { to: OnwardStatus; expectedStatus: OnwardStatus },
    ): Promise<{ onward: OnwardReferral }> {
      return request<{ onward: OnwardReferral }>(`/referrals/${segment(id)}/onward/${segment(onwardId)}/status`, {
        method: 'POST', body: { to: change.to, expectedStatus: change.expectedStatus }, csrf: true, sessionRequired: true,
      });
    },
    async changeStatus(
      id: string,
      change: { to: Exclude<PartnerStatus, 'new'>; expectedStatus: PartnerStatus; closureReason?: ClosureReason },
    ): Promise<{ referral: Referral }> {
      // P3: closing needs a reason; other moves must not send one.
      const body = change.to === 'closed'
        ? { to: change.to, expectedStatus: change.expectedStatus, closureReason: change.closureReason }
        : { to: change.to, expectedStatus: change.expectedStatus };
      const result = await request<{ referral: Referral }>(`/referrals/${segment(id)}/status`, {
        method: 'POST', body, csrf: true, sessionRequired: true,
      });
      return { referral: normaliseReferral(result.referral) };
    },
    async addNote(id: string, body: string): Promise<{ note: Note }> {
      return request<{ note: Note }>(`/referrals/${segment(id)}/notes`, {
        method: 'POST', body: { body: stripControlCharacters(body) }, csrf: true, sessionRequired: true,
      });
    },
    async evidenceLink(id: string, attachmentId: string): Promise<EvidenceLinkResponse> {
      const link = await request<EvidenceLinkResponse>(`/referrals/${segment(id)}/evidence/${segment(attachmentId)}/url`, {
        method: 'POST', csrf: true, sessionRequired: true,
      });
      if (!link || typeof link.url !== 'string' || !isSafeDownloadUrl(link.url, evidenceOrigin)) {
        throw new PartnerApiError({ kind: 'unavailable', status: 200 });
      }
      return link;
    },
    /** Caseworkers only (admins get 403); the caller should not offer it to admins. */
    async revealCallback(id: string): Promise<CallbackResponse> {
      const result = await request<CallbackResponse>(`/referrals/${segment(id)}/callback`, {
        method: 'POST', csrf: true, sessionRequired: true,
      });
      if (!result || typeof result.callback?.phoneNumber !== 'string') {
        throw new PartnerApiError({ kind: 'unavailable', status: 200 });
      }
      return result;
    },
  };
}

export type PartnerApi = ReturnType<typeof createPartnerApi>;
