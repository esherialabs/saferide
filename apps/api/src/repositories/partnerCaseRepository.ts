/**
 * Partner-realm access to routed cases. Every query is scoped by the
 * session's org id; another org's referral is indistinguishable from a
 * missing one. Content is only read while the referral's access is not
 * revoked and its partner_follow_up consent is still granted. Survivor
 * account identifiers (owner, case, consent ids) stay inside this module
 * and the routes never serialise them.
 */
import type { PoolClient, QueryResult, QueryResultRow } from 'pg';

import { query } from '../plugins/db.js';
import type { AttachmentRow } from './caseRepository.js';
import {
  PARTNER_ONWARD_TRANSITIONS,
  PARTNER_REFERRAL_STATUSES,
  PARTNER_STATUS_TRANSITIONS,
  SURVIVOR_STATUS_FOR_PARTNER_STATUS,
  type PartnerClosureReason,
  type PartnerOnwardStatus,
  type PartnerOnwardType,
  type PartnerReferralStatus,
} from '../services/partnerReferralStatus.js';
import { recordPartnerAccess, withPartnerTransaction, type PartnerAuditEntry } from './partnerRepository.js';

export {
  PARTNER_REFERRAL_STATUSES,
  PARTNER_STATUS_TRANSITIONS,
  SURVIVOR_STATUS_FOR_PARTNER_STATUS,
  type PartnerReferralStatus,
} from '../services/partnerReferralStatus.js';

export type PartnerPathway = 'referral' | 'escalation';

/** A partner user as other users of the same org see them: id and display name, never the email. */
export type PartnerUserRef = { id: string; name: string };

export type PartnerQueueRow = {
  id: string;
  reference: string;
  status: PartnerReferralStatus;
  pathway: PartnerPathway | null;
  receivedAt: Date;
  statusChangedAt: Date;
  revokedAt: Date | null;
  /** Null for tombstones (revocation clears the assignment). */
  assignee: PartnerUserRef | null;
  onward: { count: number; latest: { type: PartnerOnwardType; status: PartnerOnwardStatus } | null };
};

/** `user`: one assignee (the session user for `assignee=me`); `unassigned`: nobody in charge. */
export type PartnerAssigneeFilter = { kind: 'user'; userId: string } | { kind: 'unassigned' };

export type PartnerQueueCursor = { createdAt: string; id: string };

/** Internal record: caseId/ownerId are for follow-up queries only, never for responses. */
export type PartnerReferralRecord = {
  id: string;
  reference: string;
  status: PartnerReferralStatus;
  closureReason: string | null;
  pathway: PartnerPathway | null;
  receivedAt: Date;
  statusChangedAt: Date;
  revokedAt: Date | null;
  callbackShared: boolean;
  assignee: PartnerUserRef | null;
  summary: Record<string, unknown> | null;
  caseId: string;
  ownerId: string;
};

/** Partner-typed text stays partner-internal: never in survivor events, deleted when access ends. */
export type PartnerOnwardRecord = {
  id: string;
  type: PartnerOnwardType;
  organisation: string | null;
  contactRole: string | null;
  externalReference: string | null;
  note: string | null;
  status: PartnerOnwardStatus;
  createdAt: Date;
  createdBy: PartnerUserRef;
  statusChangedAt: Date;
};

/** The actor shown when SafeRide (an operator disabling or resetting a user) released a referral. */
export const SAFERIDE_ACTOR: PartnerUserRef = { id: 'saferide', name: 'SafeRide' };

export type PartnerActivityKind = 'acknowledged' | 'assigned' | 'unassigned' | 'onward_created' | 'onward_status';

/** One content-free partner_case_activity row: ids, codes, names and a time. */
export type PartnerActivityRecord = {
  kind: PartnerActivityKind;
  createdAt: Date;
  actor: PartnerUserRef;
  assignee: PartnerUserRef | null;
  onward: { id: string; type: PartnerOnwardType; status: PartnerOnwardStatus } | null;
};

export type PartnerStaffRecord = { id: string; name: string; role: 'partner_admin' | 'partner_caseworker' };

export type PartnerQueueSummary = {
  needsAttention: number;
  newTotal: number;
  inProgress: number;
  unassigned: number;
  mine: number;
};

export type PartnerNoteRecord = {
  id: string;
  body: string;
  createdAt: Date;
  authorUserId: string;
  authorDisplayName: string;
};

export type PartnerTimelineRecord = {
  eventType: 'partner_routed' | 'status_change';
  partnerStatus: PartnerReferralStatus | null;
  createdAt: Date;
};

/** The pool-level `query` helper, or one transaction's client. */
type Runner = <T extends QueryResultRow>(text: string, values: unknown[]) => Promise<QueryResult<T>>;

function clientRunner(client: PoolClient): Runner {
  return (text, values) => client.query(text, values);
}

function userRef(id: string | null, name: string | null): PartnerUserRef | null {
  return id && name !== null ? { id, name } : null;
}

function toPathway(value: string | null): PartnerPathway | null {
  if (value === 'referral') return 'referral';
  if (value === 'escalate') return 'escalation';
  return null;
}

// Access holds only while the referral is not revoked and its consent is granted.
// Every `assignee` join below matches active users only: a referral whose
// assignee was disabled or reset is shown, filtered and counted as unassigned.
const ACTIVE_ACCESS = `r.access_revoked_at is null and consent.status = 'granted'`;

const JOIN_ACTIVE_ASSIGNEE = `left join saferide.partner_users assignee
  on assignee.id = r.assignee_user_id and assignee.org_id = r.org_id and assignee.status = 'active'`;

const QUEUE_SELECT = `
  select r.id, r.reference, r.status, r.created_at, r.status_changed_at,
    case when ${ACTIVE_ACCESS} then null else coalesce(r.access_revoked_at, consent.withdrawn_at) end as revoked_at,
    case when ${ACTIVE_ACCESS} then c.pathway else null end as pathway,
    case when ${ACTIVE_ACCESS} then assignee.id else null end as assignee_id,
    case when ${ACTIVE_ACCESS} then assignee.display_name else null end as assignee_name,
    case when ${ACTIVE_ACCESS} then onward.total else 0 end as onward_count,
    case when ${ACTIVE_ACCESS} then onward.latest_type else null end as onward_latest_type,
    case when ${ACTIVE_ACCESS} then onward.latest_status else null end as onward_latest_status,
    to_char(r.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_at
  from saferide.partner_referrals r
  join saferide.cases c on c.id = r.case_id and c.owner_id = r.owner_id
  join saferide.consent_records consent on consent.id = r.consent_record_id and consent.owner_id = r.owner_id
  ${JOIN_ACTIVE_ASSIGNEE}
  left join lateral (
    select count(*)::int as total,
      (array_agg(o.type order by o.created_at desc, o.id desc))[1] as latest_type,
      (array_agg(o.status order by o.created_at desc, o.id desc))[1] as latest_status
    from saferide.partner_onward_referrals o
    where o.referral_id = r.id and o.org_id = r.org_id
  ) onward on true
`;

/**
 * One page of the org's queue, newest first. `status: 'withdrawn'` lists
 * tombstones only; the pathway, priority and assignee filters match active
 * referrals only (a tombstone has none of them).
 */
export async function listPartnerReferrals(params: {
  orgId: string;
  status?: PartnerReferralStatus | 'withdrawn';
  pathway?: PartnerPathway;
  priority?: 'urgent' | 'normal';
  assignee?: PartnerAssigneeFilter;
  cursor?: PartnerQueueCursor;
  limit: number;
}): Promise<{ rows: PartnerQueueRow[]; nextCursor: PartnerQueueCursor | null }> {
  const { rows } = await query<{
    id: string; reference: string; status: PartnerReferralStatus; created_at: Date; status_changed_at: Date;
    revoked_at: Date | null; pathway: string | null; cursor_at: string;
    assignee_id: string | null; assignee_name: string | null; onward_count: number;
    onward_latest_type: PartnerOnwardType | null; onward_latest_status: PartnerOnwardStatus | null;
  }>(
    `${QUEUE_SELECT}
     where r.org_id = $1
       and (
         $2::text is null
         or ($2 = 'withdrawn' and not (${ACTIVE_ACCESS}))
         or ($2 <> 'withdrawn' and r.status = $2 and ${ACTIVE_ACCESS})
       )
       and ($3::text is null or (c.pathway = $3 and ${ACTIVE_ACCESS}))
       and ($4::timestamptz is null or (r.created_at, r.id) < ($4::timestamptz, $5::uuid))
       and (
         $7::text is null
         or ($7 = 'urgent' and c.pathway = 'escalate' and ${ACTIVE_ACCESS})
         or ($7 = 'normal' and c.pathway is distinct from 'escalate' and ${ACTIVE_ACCESS})
       )
       and (
         $8::text is null
         or ($8 = 'unassigned' and assignee.id is null and ${ACTIVE_ACCESS})
         or ($8 = 'user' and assignee.id = $9::uuid and ${ACTIVE_ACCESS})
       )
     order by r.created_at desc, r.id desc
     limit $6`,
    [
      params.orgId,
      params.status ?? null,
      params.pathway === 'escalation' ? 'escalate' : params.pathway ?? null,
      params.cursor?.createdAt ?? null,
      params.cursor?.id ?? null,
      params.limit + 1,
      params.priority ?? null,
      params.assignee?.kind ?? null,
      params.assignee?.kind === 'user' ? params.assignee.userId : null,
    ],
  );
  const page = rows.slice(0, params.limit);
  const last = page.at(-1);
  return {
    rows: page.map(row => ({
      id: row.id,
      reference: row.reference,
      status: row.status,
      pathway: toPathway(row.pathway),
      receivedAt: new Date(row.created_at),
      statusChangedAt: new Date(row.status_changed_at),
      revokedAt: row.revoked_at ? new Date(row.revoked_at) : null,
      assignee: userRef(row.assignee_id, row.assignee_name),
      onward: {
        count: Number(row.onward_count ?? 0),
        latest: row.onward_latest_type && row.onward_latest_status
          ? { type: row.onward_latest_type, status: row.onward_latest_status }
          : null,
      },
    })),
    nextCursor: rows.length > params.limit && last ? { createdAt: last.cursor_at, id: last.id } : null,
  };
}

async function selectReferral(run: Runner, orgId: string, referralId: string, lock: boolean): Promise<PartnerReferralRecord | null> {
  const { rows } = await run<{
    id: string; reference: string; status: PartnerReferralStatus; closure_reason: string | null;
    created_at: Date; status_changed_at: Date; revoked_at: Date | null; pathway: string | null;
    callback_shared: boolean; summary: Record<string, unknown> | null; case_id: string; owner_id: string;
    assignee_id: string | null; assignee_name: string | null;
  }>(
    `select r.id, r.reference, r.status, r.closure_reason, r.created_at, r.status_changed_at, r.case_id, r.owner_id,
       case when ${ACTIVE_ACCESS} then null else coalesce(r.access_revoked_at, consent.withdrawn_at) end as revoked_at,
       case when ${ACTIVE_ACCESS} then c.pathway else null end as pathway,
       case when ${ACTIVE_ACCESS} then c.summary else null end as summary,
       case when ${ACTIVE_ACCESS} then assignee.id else null end as assignee_id,
       case when ${ACTIVE_ACCESS} then assignee.display_name else null end as assignee_name,
       (${ACTIVE_ACCESS}) and exists (
         select 1 from saferide.partner_referral_callbacks callback
         where callback.referral_id = r.id and callback.org_id = r.org_id
       ) as callback_shared
     from saferide.partner_referrals r
     join saferide.cases c on c.id = r.case_id and c.owner_id = r.owner_id
     join saferide.consent_records consent on consent.id = r.consent_record_id and consent.owner_id = r.owner_id
     ${JOIN_ACTIVE_ASSIGNEE}
     where r.id = $1 and r.org_id = $2
     ${lock ? 'for update of r' : ''}`,
    [referralId, orgId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    reference: row.reference,
    status: row.status,
    closureReason: row.closure_reason,
    pathway: toPathway(row.pathway),
    receivedAt: new Date(row.created_at),
    statusChangedAt: new Date(row.status_changed_at),
    revokedAt: row.revoked_at ? new Date(row.revoked_at) : null,
    callbackShared: row.callback_shared,
    assignee: userRef(row.assignee_id, row.assignee_name),
    summary: row.summary,
    caseId: row.case_id,
    ownerId: row.owner_id,
  };
}

/** The referral if it belongs to this org (revoked ones come back as tombstones), else null. */
export async function getPartnerReferral(orgId: string, referralId: string): Promise<PartnerReferralRecord | null> {
  return selectReferral(query, orgId, referralId, false);
}

/**
 * Evidence of an active referral of this org: only files whose verified
 * sha256 matches an entry the survivor's packet listed at routing time
 * (partner_referral_evidence). Anything else on the case, including files
 * uploaded later, is never shown. Storage keys stay server-side.
 */
export async function listPartnerReferralAttachments(orgId: string, referralId: string): Promise<AttachmentRow[]> {
  const { rows } = await query<AttachmentRow>(
    `select a.*
     from saferide.attachments a
     join saferide.partner_referrals r on r.case_id = a.case_id and r.owner_id = a.owner_id
     join saferide.consent_records consent on consent.id = r.consent_record_id and consent.owner_id = r.owner_id
     where r.id = $1 and r.org_id = $2 and ${ACTIVE_ACCESS}
       and a.status not in ('pending_upload', 'deleted')
       and a.sha256 is not null
       and exists (
         select 1 from saferide.partner_referral_evidence shared
         where shared.referral_id = r.id and shared.org_id = r.org_id
           and shared.sha256 is not null and shared.sha256 = lower(a.sha256)
       )
     order by a.created_at asc, a.id asc`,
    [referralId, orgId],
  );
  return rows;
}

/** Partner-visible timeline: routing and partner status changes of this org only, no payload content. */
export async function listPartnerReferralTimeline(orgId: string, referralId: string): Promise<PartnerTimelineRecord[]> {
  const { rows } = await query<{ event_type: 'partner_routed' | 'status_change'; partner_status: string | null; created_at: Date }>(
    `select event.event_type, event.payload->>'partner_status' as partner_status, event.created_at
     from saferide.case_events event
     join saferide.partner_referrals r on r.case_id = event.case_id and r.owner_id = event.owner_id
     join saferide.partner_organizations org on org.id = r.org_id
     join saferide.consent_records consent on consent.id = r.consent_record_id and consent.owner_id = r.owner_id
     where r.id = $1 and r.org_id = $2 and ${ACTIVE_ACCESS}
       and event.event_type in ('partner_routed', 'status_change')
       and event.payload->>'partner' = org.stable_id
     order by event.created_at asc, event.id asc`,
    [referralId, orgId],
  );
  return rows.map(row => ({
    eventType: row.event_type,
    partnerStatus: (PARTNER_REFERRAL_STATUSES as readonly string[]).includes(row.partner_status ?? '')
      ? row.partner_status as PartnerReferralStatus
      : null,
    createdAt: new Date(row.created_at),
  }));
}

export async function listPartnerReferralNotes(orgId: string, referralId: string): Promise<PartnerNoteRecord[]> {
  const { rows } = await query<{ id: string; body: string; created_at: Date; author_user_id: string; display_name: string }>(
    `select note.id, note.body, note.created_at, note.author_user_id, author.display_name
     from saferide.partner_case_notes note
     join saferide.partner_users author on author.id = note.author_user_id and author.org_id = note.org_id
     join saferide.partner_referrals r on r.id = note.referral_id and r.org_id = note.org_id
     join saferide.consent_records consent on consent.id = r.consent_record_id and consent.owner_id = r.owner_id
     where note.referral_id = $1 and note.org_id = $2 and ${ACTIVE_ACCESS}
     order by note.created_at asc, note.id asc`,
    [referralId, orgId],
  );
  return rows.map(row => ({
    id: row.id, body: row.body, createdAt: new Date(row.created_at),
    authorUserId: row.author_user_id, authorDisplayName: row.display_name,
  }));
}

/** The sealed callback number while both the referral and its partner_callback consent hold. */
export async function getPartnerReferralCallback(orgId: string, referralId: string): Promise<{ phoneEnc: string } | null> {
  const { rows } = await query<{ phone_enc: string }>(
    `select callback.phone_enc
     from saferide.partner_referral_callbacks callback
     join saferide.partner_referrals r
       on r.id = callback.referral_id and r.org_id = callback.org_id and r.owner_id = callback.owner_id
     join saferide.consent_records consent on consent.id = r.consent_record_id and consent.owner_id = r.owner_id
     join saferide.consent_records callback_consent
       on callback_consent.id = callback.consent_record_id and callback_consent.owner_id = callback.owner_id
     where callback.referral_id = $1 and callback.org_id = $2 and ${ACTIVE_ACCESS}
       and callback_consent.purpose = 'partner_callback' and callback_consent.status = 'granted'`,
    [referralId, orgId],
  );
  return rows[0] ? { phoneEnc: rows[0].phone_enc } : null;
}

export type PartnerWriteActor = { orgId: string; userId: string; requestId: string };

export type PartnerWriteRefusal =
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'withdrawn' }
  | { ok: false; reason: 'stale' | 'invalid_transition'; currentStatus: PartnerReferralStatus };

function successAudit(
  actor: PartnerWriteActor,
  action: PartnerAuditEntry['action'],
  referralId: string,
  extra: Pick<PartnerAuditEntry, 'targetUserId'> = {},
): PartnerAuditEntry {
  return {
    orgId: actor.orgId, actor: { type: 'partner_user', userId: actor.userId }, action, outcome: 'success',
    requestId: actor.requestId, referralId, ...extra,
  };
}

type ActivityInput =
  | { kind: 'acknowledged' | 'unassigned' }
  | { kind: 'assigned'; assigneeUserId: string }
  | { kind: 'onward_created' | 'onward_status'; onwardId: string; onwardType: PartnerOnwardType; onwardStatus: PartnerOnwardStatus };

/** Appends one content-free activity row (ids and codes only) in the caller's transaction. */
async function insertActivity(client: PoolClient, actor: PartnerWriteActor, referralId: string, input: ActivityInput): Promise<void> {
  await client.query(
    `insert into saferide.partner_case_activity (
       referral_id, org_id, actor_type, actor_user_id, kind, assignee_user_id, onward_id, onward_type, onward_status
     ) values ($1, $2, 'partner_user', $3, $4, $5, $6, $7, $8)`,
    [
      referralId, actor.orgId, actor.userId, input.kind,
      input.kind === 'assigned' ? input.assigneeUserId : null,
      input.kind === 'onward_created' || input.kind === 'onward_status' ? input.onwardId : null,
      input.kind === 'onward_created' || input.kind === 'onward_status' ? input.onwardType : null,
      input.kind === 'onward_created' || input.kind === 'onward_status' ? input.onwardStatus : null,
    ],
  );
}

/**
 * Moves the referral one step (or to closed), mirrors the change onto the
 * survivor's case status, adds a content-free status_change event for the
 * survivor's app, and audits it, all in one transaction. Closure reasons
 * and notes never reach the survivor's events.
 */
export async function transitionPartnerReferral(params: {
  actor: PartnerWriteActor;
  referralId: string;
  to: Exclude<PartnerReferralStatus, 'new'>;
  expectedStatus: PartnerReferralStatus;
  closureReason?: PartnerClosureReason;
}): Promise<{ ok: true; referral: PartnerReferralRecord } | PartnerWriteRefusal> {
  return withPartnerTransaction(async client => {
    const current = await selectReferral((text, values) => client.query(text, values), params.actor.orgId, params.referralId, true);
    if (!current) return { ok: false, reason: 'not_found' } as const;
    if (current.revokedAt) return { ok: false, reason: 'withdrawn' } as const;
    if (current.status !== params.expectedStatus) return { ok: false, reason: 'stale', currentStatus: current.status } as const;
    if (!PARTNER_STATUS_TRANSITIONS[current.status].includes(params.to)) {
      return { ok: false, reason: 'invalid_transition', currentStatus: current.status } as const;
    }

    await client.query(
      `update saferide.partner_referrals
       set status = $3, closure_reason = case when $3 = 'closed' then $4 else closure_reason end
       where id = $1 and org_id = $2`,
      [current.id, params.actor.orgId, params.to, params.closureReason ?? null],
    );
    const survivorStatus = SURVIVOR_STATUS_FOR_PARTNER_STATUS[params.to];
    await client.query(
      `update saferide.cases set status = $3::saferide.case_status where id = $1 and owner_id = $2`,
      [current.caseId, current.ownerId, survivorStatus],
    );
    const { rows: org } = await client.query<{ stable_id: string }>(
      `select stable_id from saferide.partner_organizations where id = $1`,
      [params.actor.orgId],
    );
    await client.query(
      `insert into saferide.case_events (case_id, owner_id, event_type, payload, request_id)
       values ($1, $2, 'status_change', $3, $4)`,
      [
        current.caseId,
        current.ownerId,
        { schemaVersion: '1.0', new_status: survivorStatus, actor: 'partner', partner: org[0]?.stable_id, partner_status: params.to },
        params.actor.requestId,
      ],
    );
    if (current.status === 'new' && params.to === 'acknowledged') {
      // Partner-internal: who acknowledged it. The survivor's event above stays content-free.
      await insertActivity(client, params.actor, current.id, { kind: 'acknowledged' });
    }
    await recordPartnerAccess(successAudit(params.actor, 'partner.referral.status', current.id), client);
    const updated = await selectReferral((text, values) => client.query(text, values), params.actor.orgId, current.id, false);
    if (!updated) throw new Error('Partner referral vanished inside its own transaction');
    return { ok: true, referral: updated } as const;
  });
}

/** Appends a note (notes are never edited) to an active referral, audited in the same transaction. */
export async function addPartnerReferralNote(params: {
  actor: PartnerWriteActor;
  referralId: string;
  body: string;
}): Promise<{ ok: true; note: PartnerNoteRecord } | PartnerWriteRefusal> {
  return withPartnerTransaction(async client => {
    const current = await selectReferral((text, values) => client.query(text, values), params.actor.orgId, params.referralId, true);
    if (!current) return { ok: false, reason: 'not_found' } as const;
    if (current.revokedAt) return { ok: false, reason: 'withdrawn' } as const;
    const { rows } = await client.query<{ id: string; body: string; created_at: Date; display_name: string }>(
      `with inserted as (
         insert into saferide.partner_case_notes (referral_id, org_id, author_user_id, body)
         values ($1, $2, $3, $4)
         returning id, body, created_at, author_user_id, org_id
       )
       select inserted.id, inserted.body, inserted.created_at, author.display_name
       from inserted
       join saferide.partner_users author on author.id = inserted.author_user_id and author.org_id = inserted.org_id`,
      [current.id, params.actor.orgId, params.actor.userId, params.body],
    );
    await recordPartnerAccess(successAudit(params.actor, 'partner.referral.note', current.id), client);
    const row = rows[0];
    return {
      ok: true,
      note: {
        id: row.id, body: row.body, createdAt: new Date(row.created_at),
        authorUserId: params.actor.userId, authorDisplayName: row.display_name,
      },
    } as const;
  });
}

/** Active users of the org, by name: who can be put in charge of a referral. Never emails. */
export async function listPartnerStaff(orgId: string): Promise<PartnerStaffRecord[]> {
  const { rows } = await query<{ id: string; display_name: string; role: PartnerStaffRecord['role'] }>(
    `select id, display_name, role from saferide.partner_users
     where org_id = $1 and status = 'active'
     order by display_name asc, id asc`,
    [orgId],
  );
  return rows.map(row => ({ id: row.id, name: row.display_name, role: row.role }));
}

/**
 * Counts for the dashboard header (active referrals only; withdrawn and
 * revoked ones never count). needsAttention: escalations still `new`;
 * newTotal: every `new`; inProgress: status `in_progress` exactly (as the
 * status filter); unassigned and mine: open (not closed) referrals with
 * nobody active, or the session user, in charge.
 */
export async function summarizePartnerQueue(orgId: string, userId: string): Promise<PartnerQueueSummary> {
  const { rows } = await query<{
    needs_attention: number; new_total: number; in_progress: number; unassigned: number; mine: number;
  }>(
    `select
       count(*) filter (where r.status = 'new' and c.pathway = 'escalate')::int as needs_attention,
       count(*) filter (where r.status = 'new')::int as new_total,
       count(*) filter (where r.status = 'in_progress')::int as in_progress,
       count(*) filter (where r.status <> 'closed' and assignee.id is null)::int as unassigned,
       count(*) filter (where r.status <> 'closed' and assignee.id = $2)::int as mine
     from saferide.partner_referrals r
     join saferide.cases c on c.id = r.case_id and c.owner_id = r.owner_id
     join saferide.consent_records consent on consent.id = r.consent_record_id and consent.owner_id = r.owner_id
     ${JOIN_ACTIVE_ASSIGNEE}
     where r.org_id = $1 and ${ACTIVE_ACCESS}`,
    [orgId, userId],
  );
  const row = rows[0];
  return {
    needsAttention: Number(row?.needs_attention ?? 0),
    newTotal: Number(row?.new_total ?? 0),
    inProgress: Number(row?.in_progress ?? 0),
    unassigned: Number(row?.unassigned ?? 0),
    mine: Number(row?.mine ?? 0),
  };
}

type OnwardRow = {
  id: string; type: PartnerOnwardType; organisation: string | null; contact_role: string | null;
  external_reference: string | null; note: string | null; status: PartnerOnwardStatus; created_at: Date;
  created_by: string; created_by_name: string; status_changed_at: Date;
};

const ONWARD_COLUMNS = `onward.id, onward.type, onward.organisation, onward.contact_role, onward.external_reference,
  onward.note, onward.status, onward.created_at, onward.created_by, creator.display_name as created_by_name,
  onward.status_changed_at`;

function mapOnward(row: OnwardRow): PartnerOnwardRecord {
  return {
    id: row.id,
    type: row.type,
    organisation: row.organisation,
    contactRole: row.contact_role,
    externalReference: row.external_reference,
    note: row.note,
    status: row.status,
    createdAt: new Date(row.created_at),
    createdBy: { id: row.created_by, name: row.created_by_name },
    statusChangedAt: new Date(row.status_changed_at),
  };
}

/** Onward referrals of an active referral of this org, oldest first. */
export async function listPartnerOnwardReferrals(orgId: string, referralId: string): Promise<PartnerOnwardRecord[]> {
  const { rows } = await query<OnwardRow>(
    `select ${ONWARD_COLUMNS}
     from saferide.partner_onward_referrals onward
     join saferide.partner_users creator on creator.id = onward.created_by and creator.org_id = onward.org_id
     join saferide.partner_referrals r on r.id = onward.referral_id and r.org_id = onward.org_id
     join saferide.consent_records consent on consent.id = r.consent_record_id and consent.owner_id = r.owner_id
     where onward.referral_id = $1 and onward.org_id = $2 and ${ACTIVE_ACCESS}
     order by onward.created_at asc, onward.id asc`,
    [referralId, orgId],
  );
  return rows.map(mapOnward);
}

/** Who acknowledged, assigned or moved onward referrals, for the partner timeline. */
export async function listPartnerCaseActivity(orgId: string, referralId: string): Promise<PartnerActivityRecord[]> {
  const { rows } = await query<{
    kind: PartnerActivityKind; created_at: Date; actor_type: 'partner_user' | 'saferide';
    actor_user_id: string | null; actor_name: string | null;
    assignee_user_id: string | null; assignee_name: string | null;
    onward_id: string | null; onward_type: PartnerOnwardType | null; onward_status: PartnerOnwardStatus | null;
  }>(
    `select activity.kind, activity.created_at, activity.actor_type, activity.actor_user_id, actor.display_name as actor_name,
       activity.assignee_user_id, assignee.display_name as assignee_name,
       activity.onward_id, activity.onward_type, activity.onward_status
     from saferide.partner_case_activity activity
     left join saferide.partner_users actor on actor.id = activity.actor_user_id and actor.org_id = activity.org_id
     left join saferide.partner_users assignee
       on assignee.id = activity.assignee_user_id and assignee.org_id = activity.org_id
     join saferide.partner_referrals r on r.id = activity.referral_id and r.org_id = activity.org_id
     join saferide.consent_records consent on consent.id = r.consent_record_id and consent.owner_id = r.owner_id
     where activity.referral_id = $1 and activity.org_id = $2 and ${ACTIVE_ACCESS}
     order by activity.created_at asc, activity.id asc`,
    [referralId, orgId],
  );
  return rows.map(row => ({
    kind: row.kind,
    createdAt: new Date(row.created_at),
    actor: row.actor_type === 'saferide' || !row.actor_user_id
      ? SAFERIDE_ACTOR
      : { id: row.actor_user_id, name: row.actor_name ?? '' },
    assignee: userRef(row.assignee_user_id, row.assignee_name),
    onward: row.onward_id && row.onward_type && row.onward_status
      ? { id: row.onward_id, type: row.onward_type, status: row.onward_status }
      : null,
  }));
}

export type PartnerAssignRefusal =
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'withdrawn' }
  | { ok: false; reason: 'stale'; currentAssignee: PartnerUserRef | null }
  | { ok: false; reason: 'invalid_assignee' };

/**
 * Puts one active user of the org in charge of a referral (or nobody), if
 * the referral is still assigned as the caller last saw it. Any org user
 * may assign, themselves included. Records a content-free activity row when
 * the assignee changes and audits it, all in one transaction. Nothing here
 * reaches the survivor.
 */
export async function assignPartnerReferral(params: {
  actor: PartnerWriteActor;
  referralId: string;
  assigneeId: string | null;
  expectedAssigneeId: string | null;
}): Promise<{ ok: true; referral: PartnerReferralRecord } | PartnerAssignRefusal> {
  return withPartnerTransaction(async client => {
    const run = clientRunner(client);
    const current = await selectReferral(run, params.actor.orgId, params.referralId, true);
    if (!current) return { ok: false, reason: 'not_found' } as const;
    if (current.revokedAt) return { ok: false, reason: 'withdrawn' } as const;
    // Re-read after taking the row lock: a waiting `for update` re-checks the
    // referral row itself but keeps the joined assignee row it first saw.
    const { rows: held } = await client.query<{ assignee_user_id: string | null; display_name: string | null }>(
      `select assignee.id as assignee_user_id, assignee.display_name
       from saferide.partner_referrals r
       ${JOIN_ACTIVE_ASSIGNEE}
       where r.id = $1 and r.org_id = $2`,
      [current.id, params.actor.orgId],
    );
    const currentAssigneeId = held[0]?.assignee_user_id ?? null;
    if (currentAssigneeId !== params.expectedAssigneeId) {
      return { ok: false, reason: 'stale', currentAssignee: userRef(currentAssigneeId, held[0]?.display_name ?? null) } as const;
    }
    if (params.assigneeId !== currentAssigneeId) {
      if (params.assigneeId !== null) {
        const { rows } = await client.query<{ id: string }>(
          `select id from saferide.partner_users where id = $1 and org_id = $2 and status = 'active' for share`,
          [params.assigneeId, params.actor.orgId],
        );
        if (rows.length !== 1) return { ok: false, reason: 'invalid_assignee' } as const;
      }
      await client.query(
        `update saferide.partner_referrals set assignee_user_id = $3 where id = $1 and org_id = $2`,
        [current.id, params.actor.orgId, params.assigneeId],
      );
      await insertActivity(client, params.actor, current.id, params.assigneeId === null
        ? { kind: 'unassigned' }
        : { kind: 'assigned', assigneeUserId: params.assigneeId });
    }
    await recordPartnerAccess(
      successAudit(params.actor, 'partner.referral.assign', current.id, { targetUserId: params.assigneeId }),
      client,
    );
    const updated = await selectReferral(run, params.actor.orgId, current.id, false);
    if (!updated) throw new Error('Partner referral vanished inside its own transaction');
    return { ok: true, referral: updated } as const;
  });
}

export type PartnerOnwardInput = {
  type: PartnerOnwardType;
  organisation: string | null;
  contactRole: string | null;
  externalReference: string | null;
  note: string | null;
  status: 'planned' | 'made';
};

/** Records where the partner sent the survivor next, with a content-free activity row and the audit. */
export async function createPartnerOnwardReferral(params: {
  actor: PartnerWriteActor;
  referralId: string;
  input: PartnerOnwardInput;
}): Promise<{ ok: true; onward: PartnerOnwardRecord } | { ok: false; reason: 'not_found' | 'withdrawn' }> {
  return withPartnerTransaction(async client => {
    const current = await selectReferral(clientRunner(client), params.actor.orgId, params.referralId, true);
    if (!current) return { ok: false, reason: 'not_found' } as const;
    if (current.revokedAt) return { ok: false, reason: 'withdrawn' } as const;
    const { input } = params;
    const { rows } = await client.query<OnwardRow>(
      `with onward as (
         insert into saferide.partner_onward_referrals (
           referral_id, org_id, type, organisation, contact_role, external_reference, note, status,
           created_by, status_changed_by
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
         returning *
       )
       select ${ONWARD_COLUMNS}
       from onward
       join saferide.partner_users creator on creator.id = onward.created_by and creator.org_id = onward.org_id`,
      [
        current.id, params.actor.orgId, input.type, input.organisation, input.contactRole,
        input.externalReference, input.note, input.status, params.actor.userId,
      ],
    );
    const onward = mapOnward(rows[0]);
    await insertActivity(client, params.actor, current.id, {
      kind: 'onward_created', onwardId: onward.id, onwardType: onward.type, onwardStatus: onward.status,
    });
    await recordPartnerAccess(successAudit(params.actor, 'partner.onward.create', current.id), client);
    return { ok: true, onward } as const;
  });
}

export type PartnerOnwardRefusal =
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'withdrawn' }
  | { ok: false; reason: 'onward_not_found' }
  | { ok: false; reason: 'stale' | 'invalid_transition'; currentStatus: PartnerOnwardStatus };

/** Moves one onward referral a step, if it is still in the status the caller last saw. */
export async function transitionPartnerOnwardReferral(params: {
  actor: PartnerWriteActor;
  referralId: string;
  onwardId: string;
  to: PartnerOnwardStatus;
  expectedStatus: PartnerOnwardStatus;
}): Promise<{ ok: true; onward: PartnerOnwardRecord } | PartnerOnwardRefusal> {
  return withPartnerTransaction(async client => {
    const current = await selectReferral(clientRunner(client), params.actor.orgId, params.referralId, true);
    if (!current) return { ok: false, reason: 'not_found' } as const;
    if (current.revokedAt) return { ok: false, reason: 'withdrawn' } as const;
    const { rows: found } = await client.query<{ status: PartnerOnwardStatus }>(
      `select status from saferide.partner_onward_referrals
       where id = $1 and referral_id = $2 and org_id = $3
       for update`,
      [params.onwardId, current.id, params.actor.orgId],
    );
    const onwardStatus = found[0]?.status;
    if (!onwardStatus) return { ok: false, reason: 'onward_not_found' } as const;
    if (onwardStatus !== params.expectedStatus) return { ok: false, reason: 'stale', currentStatus: onwardStatus } as const;
    if (!PARTNER_ONWARD_TRANSITIONS[onwardStatus].includes(params.to)) {
      return { ok: false, reason: 'invalid_transition', currentStatus: onwardStatus } as const;
    }
    // Only these two columns are writable by the runtime role (migration 014).
    const { rows } = await client.query<OnwardRow>(
      `with onward as (
         update saferide.partner_onward_referrals set status = $4, status_changed_by = $5
         where id = $1 and referral_id = $2 and org_id = $3
         returning *
       )
       select ${ONWARD_COLUMNS}
       from onward
       join saferide.partner_users creator on creator.id = onward.created_by and creator.org_id = onward.org_id`,
      [params.onwardId, current.id, params.actor.orgId, params.to, params.actor.userId],
    );
    const onward = mapOnward(rows[0]);
    await insertActivity(client, params.actor, current.id, {
      kind: 'onward_status', onwardId: onward.id, onwardType: onward.type, onwardStatus: onward.status,
    });
    await recordPartnerAccess(successAudit(params.actor, 'partner.onward.status', current.id), client);
    return { ok: true, onward } as const;
  });
}
