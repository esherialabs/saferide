/**
 * Partner case endpoints under /partner/v1 (design sections 1 and 5). All
 * need an MFA-verified partner session; writes also need the CSRF header.
 * Every read and write, allowed or refused (malformed requests included),
 * appends one partner_access_audit row (who, what, which referral or
 * attachment; never content or IP), and a failed audit fails the request
 * closed with 503.
 *
 *   GET  /referrals?status=&pathway=&priority=&assignee=&cursor=&limit=   queue (newest first)
 *        assignee: me | unassigned | <user id>; priority: urgent (escalations) | normal
 *   GET  /referrals/:id                                  {referral, view, attachments, timeline, notes, onwardReferrals}
 *   GET  /summary                                        {needsAttention, newTotal, inProgress, unassigned, mine}
 *   GET  /staff                                          {staff: [{id, name, role}]}, active users of the org
 *   POST /referrals/:id/status   {to, expectedStatus, closureReason?}  closureReason: a PARTNER_CLOSURE_REASONS code
 *   POST /referrals/:id/assign   {assigneeId, expectedAssigneeId}   both a user id or null; {referral}
 *   POST /referrals/:id/onward   {type, organisation?, contactRole?, externalReference?, note?, status?}  {onward}
 *   POST /referrals/:id/onward/:onwardId/status  {to, expectedStatus}  {onward}
 *   POST /referrals/:id/notes    {body}
 *   POST /referrals/:id/evidence/:attachmentId/url       {url, expiresInSeconds: 60}; off by default (409 evidence_not_shareable_yet)
 *   POST /referrals/:id/callback                         caseworkers only: {callback: {phoneNumber}}
 *
 * GET /summary is polled (every 60 s). Its refusals are audited every time;
 * a successful read writes at most one partner.summary.read row per user per
 * PARTNER_SUMMARY_AUDIT_WINDOW_SECONDS (it returns counts only, no referral).
 *
 * Assignment, onward referrals and the activity behind the new timeline
 * entries are partner-internal: they never reach the survivor's case events.
 * Opening a referral never acknowledges it; only POST /status does.
 *
 * Another org's referral is indistinguishable from a missing one (404).
 * A referral whose sharing ended, by the survivor's withdrawal or an
 * operator's revocation, is a content-free tombstone on reads and 410 on
 * every action. Both read the same, so the partner cannot tell them apart.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { AppError, badRequest, conflict, forbidden, notFound, serviceUnavailable } from '../http/errors.js';
import {
  getPartnerSession,
  requirePartnerCsrf,
  requirePartnerRole,
  requirePartnerSession,
  type PartnerSession,
} from '../middleware/partnerSession.js';
import {
  addPartnerReferralNote,
  assignPartnerReferral,
  createPartnerOnwardReferral,
  getPartnerReferral,
  getPartnerReferralCallback,
  listPartnerCaseActivity,
  listPartnerOnwardReferrals,
  listPartnerReferralAttachments,
  listPartnerReferralNotes,
  listPartnerReferralTimeline,
  listPartnerReferrals,
  listPartnerStaff,
  summarizePartnerQueue,
  transitionPartnerOnwardReferral,
  transitionPartnerReferral,
  type PartnerAssigneeFilter,
  type PartnerQueueCursor,
  type PartnerReferralRecord,
  type PartnerWriteRefusal,
} from '../repositories/partnerCaseRepository.js';
import {
  recordPartnerAccess,
  recordPartnerAccessAtMostEvery,
  type PartnerAuditAction,
  type PartnerAuditOutcome,
} from '../repositories/partnerRepository.js';
import { deriveCallbackSealKey, openPartnerCallback } from '../services/partnerCallbackSeal.js';
import {
  buildPartnerCaseView,
  toPartnerAttachmentView,
  toPartnerNoteView,
  toPartnerOnwardView,
  toPartnerQueueItem,
  toPartnerReferralSummary,
  toPartnerReferralTombstone,
  toPartnerStaffView,
  toPartnerTimeline,
} from '../services/partnerCaseView.js';
import {
  PARTNER_CLOSURE_REASONS,
  PARTNER_ONWARD_INITIAL_STATUSES,
  PARTNER_ONWARD_LIMITS,
  PARTNER_ONWARD_STATUSES,
  PARTNER_ONWARD_TYPES,
  PARTNER_REFERRAL_STATUSES,
} from '../services/partnerReferralStatus.js';
import { getEvidenceDownloadDecision } from '../services/evidenceQuarantine.js';
import { createPresignedDownloadUrl } from '../storage/evidenceStorage.js';

export const PARTNER_EVIDENCE_URL_TTL_SECONDS = 60;
export const PARTNER_QUEUE_PAGE = { default: 25, max: 100 } as const;
export const PARTNER_NOTE_MAX_LENGTH = 2000;
/** At most one successful partner.summary.read audit row per user in this window. */
export const PARTNER_SUMMARY_AUDIT_WINDOW_SECONDS = 15 * 60;

const uuid = z.string().uuid();
const referralParams = z.object({ id: uuid }).strict();
const evidenceParams = z.object({ id: uuid, attachmentId: uuid }).strict();
const onwardParams = z.object({ id: uuid, onwardId: uuid }).strict();
const emptyQuery = z.object({}).strict();
const queueQuery = z.object({
  status: z.enum([...PARTNER_REFERRAL_STATUSES, 'withdrawn']).optional(),
  pathway: z.enum(['referral', 'escalation']).optional(),
  priority: z.enum(['urgent', 'normal']).optional(),
  assignee: z.union([z.enum(['me', 'unassigned']), uuid]).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(PARTNER_QUEUE_PAGE.max).default(PARTNER_QUEUE_PAGE.default),
}).strict();
const assignBody = z.object({
  assigneeId: uuid.nullable(),
  expectedAssigneeId: uuid.nullable(),
}).strict();

/**
 * Partner-typed text may hold newlines and tabs but no other control
 * characters: a NUL would otherwise reach PostgreSQL, fail there and answer
 * 503 instead of an audited 400.
 */
const NO_CONTROL_CHARACTERS = /^[^\u0000-\u0008\u000B-\u001F\u007F]*$/;
const partnerText = (max: number) => z.string().trim().max(max).regex(NO_CONTROL_CHARACTERS, 'control characters are not allowed');

/** Optional partner-typed text: trimmed, blank means none. */
function optionalText(max: number) {
  return partnerText(max).nullable().optional().transform(value => (value ? value : null));
}
const onwardBody = z.object({
  type: z.enum(PARTNER_ONWARD_TYPES),
  organisation: optionalText(PARTNER_ONWARD_LIMITS.organisation),
  contactRole: optionalText(PARTNER_ONWARD_LIMITS.contactRole),
  externalReference: optionalText(PARTNER_ONWARD_LIMITS.externalReference),
  note: optionalText(PARTNER_ONWARD_LIMITS.note),
  status: z.enum(PARTNER_ONWARD_INITIAL_STATUSES).default('planned'),
}).strict();
const onwardStatusBody = z.object({
  to: z.enum(PARTNER_ONWARD_STATUSES).refine(status => status !== 'planned', 'an onward referral never moves back to planned'),
  expectedStatus: z.enum(PARTNER_ONWARD_STATUSES),
}).strict();
const statusBody = z.object({
  to: z.enum(['acknowledged', 'in_progress', 'referred_onward', 'closed']),
  expectedStatus: z.enum(PARTNER_REFERRAL_STATUSES),
  closureReason: z.enum(PARTNER_CLOSURE_REASONS).optional(),
}).strict().superRefine((body, ctx) => {
  if ((body.to === 'closed') !== (body.closureReason !== undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['closureReason'], message: 'closing needs a reason; other moves take none' });
  }
});
const noteBody = z.object({
  body: z.string().trim().min(1).max(PARTNER_NOTE_MAX_LENGTH).regex(NO_CONTROL_CHARACTERS, 'control characters are not allowed'),
}).strict();

const CURSOR_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

export function encodePartnerCursor(cursor: PartnerQueueCursor): string {
  return Buffer.from(JSON.stringify([cursor.createdAt, cursor.id]), 'utf8').toString('base64url');
}

export function decodePartnerCursor(value: string): PartnerQueueCursor | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [createdAt, id] = parsed;
    if (typeof createdAt !== 'string' || !CURSOR_TIME.test(createdAt) || !uuid.safeParse(id).success) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

const referralNotFound = () => notFound('Referral not found');
// Neutral on purpose: the same words after a survivor withdrawal and an operator revocation.
export const REFERRAL_NO_LONGER_SHARED = 'This report is no longer shared with your organisation';
const referralWithdrawn = () => new AppError(410, 'withdrawn', REFERRAL_NO_LONGER_SHARED, { reason: 'withdrawn' });

/**
 * Partner evidence downloads are OFF unless PARTNER_EVIDENCE_DOWNLOAD=originals
 * (development and test only). Stored files are raw originals that can carry
 * EXIF GPS and device make/model. Follow-up before turning this on for real
 * partners: server-side derivatives that strip EXIF/XMP/IPTC from JPEG, PNG
 * and HEIC, location atoms from MP4/MOV and metadata from PDF, with partner
 * downloads served only from those derivatives.
 */
export const EVIDENCE_NOT_SHAREABLE_YET = 'evidence_not_shareable_yet';

/**
 * `callbackKey` is the decoded PARTNER_CALLBACK_KEY; without it no callback
 * can be revealed. `evidenceDownload` is PARTNER_EVIDENCE_DOWNLOAD.
 */
export type PartnerCaseRoutesConfig = { callbackKey?: Buffer | null; evidenceDownload?: 'disabled' | 'originals' };

export async function registerPartnerCaseRoutes(scope: FastifyInstance, config: PartnerCaseRoutesConfig): Promise<void> {
  const callbackSealKey = config.callbackKey ? deriveCallbackSealKey(config.callbackKey) : null;
  const evidenceDownloadsEnabled = config.evidenceDownload === 'originals';
  const anyPartnerRole = requirePartnerRole('partner_caseworker', 'partner_admin');
  const read = { preHandler: [requirePartnerSession, anyPartnerRole] };
  const write = { preHandler: [requirePartnerSession, requirePartnerCsrf, anyPartnerRole] };

  async function audit(
    request: FastifyRequest,
    session: PartnerSession,
    action: PartnerAuditAction,
    outcome: PartnerAuditOutcome,
    ids: { referralId?: string; attachmentId?: string } = {},
  ): Promise<void> {
    try {
      await recordPartnerAccess({
        orgId: session.orgId,
        actor: { type: 'partner_user', userId: session.userId },
        action,
        outcome,
        requestId: request.id,
        referralId: ids.referralId ?? null,
        attachmentId: ids.attachmentId ?? null,
      });
    } catch {
      throw serviceUnavailable('The partner service is unavailable');
    }
  }

  /** A malformed id is audited without it (the audit columns hold uuids only). */
  function auditIds(params: unknown): { referralId?: string; attachmentId?: string } {
    const raw = (params ?? {}) as Record<string, unknown>;
    return {
      ...(uuid.safeParse(raw.id).success ? { referralId: raw.id as string } : {}),
      ...(uuid.safeParse(raw.attachmentId).success ? { attachmentId: raw.attachmentId as string } : {}),
    };
  }

  /** Parses one part of the request; a malformed one is audited as a refusal, then 400. */
  async function parseOrRefuse<S extends z.ZodTypeAny>(
    schema: S,
    value: unknown,
    request: FastifyRequest,
    session: PartnerSession,
    action: PartnerAuditAction,
  ): Promise<z.output<S>> {
    const parsed = schema.safeParse(value);
    if (parsed.success) return parsed.data;
    await audit(request, session, action, 'denied', auditIds(request.params));
    throw badRequest('Invalid request');
  }

  /** Loads this org's referral for an action, auditing a refusal; tombstones refuse with 410. */
  async function activeReferral(
    request: FastifyRequest,
    session: PartnerSession,
    action: PartnerAuditAction,
    ids: { referralId: string; attachmentId?: string },
  ): Promise<PartnerReferralRecord> {
    const referral = await getPartnerReferral(session.orgId, ids.referralId);
    if (!referral) {
      await audit(request, session, action, 'denied', ids);
      throw referralNotFound();
    }
    if (referral.revokedAt) {
      await audit(request, session, action, 'denied', ids);
      throw referralWithdrawn();
    }
    return referral;
  }

  async function refuseWrite(
    request: FastifyRequest,
    session: PartnerSession,
    action: PartnerAuditAction,
    referralId: string,
    refusal: PartnerWriteRefusal,
  ): Promise<never> {
    await audit(request, session, action, 'denied', { referralId });
    if (refusal.reason === 'not_found') throw referralNotFound();
    if (refusal.reason === 'withdrawn') throw referralWithdrawn();
    throw conflict(
      refusal.reason === 'stale'
        ? 'This referral changed since you loaded it; reload and try again'
        : 'That status change is not allowed from the current status',
      { reason: refusal.reason, currentStatus: refusal.currentStatus },
    );
  }

  scope.get('/referrals', read, async request => {
    const session = getPartnerSession(request);
    const filters = await parseOrRefuse(queueQuery, request.query ?? {}, request, session, 'partner.referral.list');
    const cursor = filters.cursor === undefined ? undefined : decodePartnerCursor(filters.cursor);
    if (cursor === null) {
      await audit(request, session, 'partner.referral.list', 'denied');
      throw badRequest('Invalid request');
    }
    const assignee: PartnerAssigneeFilter | undefined = filters.assignee === undefined
      ? undefined
      : filters.assignee === 'unassigned'
        ? { kind: 'unassigned' }
        : { kind: 'user', userId: filters.assignee === 'me' ? session.userId : filters.assignee };
    const page = await listPartnerReferrals({
      orgId: session.orgId, status: filters.status, pathway: filters.pathway, priority: filters.priority, assignee,
      cursor, limit: filters.limit,
    });
    await audit(request, session, 'partner.referral.list', 'success');
    return {
      referrals: page.rows.map(toPartnerQueueItem),
      nextCursor: page.nextCursor ? encodePartnerCursor(page.nextCursor) : null,
    };
  });

  scope.get('/referrals/:id', read, async request => {
    const session = getPartnerSession(request);
    const { id } = await parseOrRefuse(referralParams, request.params, request, session, 'partner.referral.read');
    const referral = await getPartnerReferral(session.orgId, id);
    if (!referral) {
      await audit(request, session, 'partner.referral.read', 'denied', { referralId: id });
      throw referralNotFound();
    }
    if (referral.revokedAt) {
      await audit(request, session, 'partner.referral.read', 'success', { referralId: id });
      return {
        referral: toPartnerReferralTombstone({ ...referral, revokedAt: referral.revokedAt }),
        view: null, attachments: [], timeline: [], notes: [], onwardReferrals: [],
      };
    }
    // A read only: opening an urgent `new` referral does not acknowledge it.
    const [attachments, timeline, notes, onward, activity] = await Promise.all([
      listPartnerReferralAttachments(session.orgId, id),
      listPartnerReferralTimeline(session.orgId, id),
      listPartnerReferralNotes(session.orgId, id),
      listPartnerOnwardReferrals(session.orgId, id),
      listPartnerCaseActivity(session.orgId, id),
    ]);
    const body = {
      referral: toPartnerReferralSummary(referral),
      view: buildPartnerCaseView(referral.summary),
      attachments: attachments.map(row => toPartnerAttachmentView(row, { downloadsEnabled: evidenceDownloadsEnabled })),
      timeline: toPartnerTimeline(timeline, activity),
      notes: notes.map(toPartnerNoteView),
      onwardReferrals: onward.map(toPartnerOnwardView),
    };
    await audit(request, session, 'partner.referral.read', 'success', { referralId: id });
    return body;
  });

  scope.post('/referrals/:id/status', write, async request => {
    const session = getPartnerSession(request);
    const { id } = await parseOrRefuse(referralParams, request.params, request, session, 'partner.referral.status');
    const body = await parseOrRefuse(statusBody, request.body ?? {}, request, session, 'partner.referral.status');
    const result = await transitionPartnerReferral({
      actor: { orgId: session.orgId, userId: session.userId, requestId: request.id },
      referralId: id, to: body.to, expectedStatus: body.expectedStatus, closureReason: body.closureReason,
    });
    if (!result.ok) return refuseWrite(request, session, 'partner.referral.status', id, result);
    return { referral: toPartnerReferralSummary(result.referral) };
  });

  scope.get('/summary', read, async request => {
    const session = getPartnerSession(request);
    await parseOrRefuse(emptyQuery, request.query ?? {}, request, session, 'partner.summary.read');
    const summary = await summarizePartnerQueue(session.orgId, session.userId);
    try {
      await recordPartnerAccessAtMostEvery({
        orgId: session.orgId, actor: { type: 'partner_user', userId: session.userId },
        action: 'partner.summary.read', outcome: 'success', requestId: request.id,
      }, PARTNER_SUMMARY_AUDIT_WINDOW_SECONDS);
    } catch {
      throw serviceUnavailable('The partner service is unavailable');
    }
    return summary;
  });

  scope.get('/staff', read, async request => {
    const session = getPartnerSession(request);
    await parseOrRefuse(emptyQuery, request.query ?? {}, request, session, 'partner.staff.list');
    const staff = await listPartnerStaff(session.orgId);
    await audit(request, session, 'partner.staff.list', 'success');
    return { staff: staff.map(toPartnerStaffView) };
  });

  scope.post('/referrals/:id/assign', write, async request => {
    const session = getPartnerSession(request);
    const { id } = await parseOrRefuse(referralParams, request.params, request, session, 'partner.referral.assign');
    const body = await parseOrRefuse(assignBody, request.body ?? {}, request, session, 'partner.referral.assign');
    const result = await assignPartnerReferral({
      actor: { orgId: session.orgId, userId: session.userId, requestId: request.id },
      referralId: id, assigneeId: body.assigneeId, expectedAssigneeId: body.expectedAssigneeId,
    });
    if (result.ok) return { referral: toPartnerReferralSummary(result.referral) };
    await audit(request, session, 'partner.referral.assign', 'denied', { referralId: id });
    if (result.reason === 'not_found') throw referralNotFound();
    if (result.reason === 'withdrawn') throw referralWithdrawn();
    if (result.reason === 'invalid_assignee') {
      throw badRequest('Only an active member of your organisation can be assigned', { reason: 'invalid_assignee' });
    }
    throw conflict('This referral was reassigned since you loaded it; reload and try again', {
      reason: 'stale',
      currentAssignee: result.currentAssignee ? { id: result.currentAssignee.id, name: result.currentAssignee.name } : null,
    });
  });

  scope.post('/referrals/:id/onward', write, async request => {
    const session = getPartnerSession(request);
    const { id } = await parseOrRefuse(referralParams, request.params, request, session, 'partner.onward.create');
    const body = await parseOrRefuse(onwardBody, request.body ?? {}, request, session, 'partner.onward.create');
    const result = await createPartnerOnwardReferral({
      actor: { orgId: session.orgId, userId: session.userId, requestId: request.id },
      referralId: id,
      input: {
        type: body.type, organisation: body.organisation, contactRole: body.contactRole,
        externalReference: body.externalReference, note: body.note, status: body.status,
      },
    });
    if (result.ok) return { onward: toPartnerOnwardView(result.onward) };
    await audit(request, session, 'partner.onward.create', 'denied', { referralId: id });
    throw result.reason === 'withdrawn' ? referralWithdrawn() : referralNotFound();
  });

  scope.post('/referrals/:id/onward/:onwardId/status', write, async request => {
    const session = getPartnerSession(request);
    const { id, onwardId } = await parseOrRefuse(onwardParams, request.params, request, session, 'partner.onward.status');
    const body = await parseOrRefuse(onwardStatusBody, request.body ?? {}, request, session, 'partner.onward.status');
    const result = await transitionPartnerOnwardReferral({
      actor: { orgId: session.orgId, userId: session.userId, requestId: request.id },
      referralId: id, onwardId, to: body.to, expectedStatus: body.expectedStatus,
    });
    if (result.ok) return { onward: toPartnerOnwardView(result.onward) };
    await audit(request, session, 'partner.onward.status', 'denied', { referralId: id });
    if (result.reason === 'not_found') throw referralNotFound();
    if (result.reason === 'withdrawn') throw referralWithdrawn();
    if (result.reason === 'onward_not_found') throw notFound('Onward referral not found');
    throw conflict(
      result.reason === 'stale'
        ? 'This onward referral changed since you loaded it; reload and try again'
        : 'That status change is not allowed from the current status',
      { reason: result.reason, currentStatus: result.currentStatus },
    );
  });

  scope.post('/referrals/:id/notes', write, async request => {
    const session = getPartnerSession(request);
    const { id } = await parseOrRefuse(referralParams, request.params, request, session, 'partner.referral.note');
    const body = await parseOrRefuse(noteBody, request.body ?? {}, request, session, 'partner.referral.note');
    const result = await addPartnerReferralNote({
      actor: { orgId: session.orgId, userId: session.userId, requestId: request.id }, referralId: id, body: body.body,
    });
    if (!result.ok) return refuseWrite(request, session, 'partner.referral.note', id, result);
    return { note: toPartnerNoteView(result.note) };
  });

  scope.post('/referrals/:id/evidence/:attachmentId/url', write, async request => {
    const session = getPartnerSession(request);
    const { id, attachmentId } = await parseOrRefuse(evidenceParams, request.params, request, session, 'partner.evidence.url');
    const ids = { referralId: id, attachmentId };
    await activeReferral(request, session, 'partner.evidence.url', ids);
    const attachment = (await listPartnerReferralAttachments(session.orgId, id)).find(item => item.id === attachmentId);
    if (!attachment) {
      await audit(request, session, 'partner.evidence.url', 'denied', ids);
      throw notFound('Evidence not found');
    }
    if (!evidenceDownloadsEnabled) {
      await audit(request, session, 'partner.evidence.url', 'denied', ids);
      throw conflict('Evidence downloads are not available to partners yet', { reason: EVIDENCE_NOT_SHAREABLE_YET });
    }
    const decision = getEvidenceDownloadDecision(attachment);
    if (!decision.allowed) {
      await audit(request, session, 'partner.evidence.url', 'denied', ids);
      throw conflict('Evidence is not available for download', { reason: decision.reason });
    }
    const url = await createPresignedDownloadUrl({
      objectKey: attachment.bucket_path, expirySeconds: PARTNER_EVIDENCE_URL_TTL_SECONDS, forceDownload: true,
    });
    await audit(request, session, 'partner.evidence.url', 'success', ids);
    return { url, expiresInSeconds: PARTNER_EVIDENCE_URL_TTL_SECONDS };
  });

  scope.post('/referrals/:id/callback', { preHandler: [requirePartnerSession, requirePartnerCsrf] }, async request => {
    const session = getPartnerSession(request);
    const { id } = await parseOrRefuse(referralParams, request.params, request, session, 'partner.referral.callback.read');
    if (session.role !== 'partner_caseworker') {
      await audit(request, session, 'partner.referral.callback.read', 'denied', { referralId: id });
      throw forbidden('Only caseworkers can see a callback number');
    }
    await activeReferral(request, session, 'partner.referral.callback.read', { referralId: id });
    const callback = await getPartnerReferralCallback(session.orgId, id);
    if (!callback) {
      await audit(request, session, 'partner.referral.callback.read', 'denied', { referralId: id });
      throw notFound('No callback number is shared for this referral');
    }
    let phoneNumber: string;
    try {
      if (!callbackSealKey) throw new Error('PARTNER_CALLBACK_KEY is not configured');
      phoneNumber = openPartnerCallback(callbackSealKey, id, callback.phoneEnc);
    } catch {
      await audit(request, session, 'partner.referral.callback.read', 'failed', { referralId: id });
      throw serviceUnavailable('The callback number cannot be read');
    }
    await audit(request, session, 'partner.referral.callback.read', 'success', { referralId: id });
    return { callback: { phoneNumber } };
  });
}
