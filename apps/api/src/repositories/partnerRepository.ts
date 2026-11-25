import type { PoolClient } from 'pg';

import { pool, query } from '../plugins/db.js';
import { PARTNER_REFERRAL_STATUSES, type PartnerReferralStatus } from '../services/partnerReferralStatus.js';

/** Recorded on every partner_access_audit row written in phase 1. */
export const PARTNER_ACCESS_POLICY_VERSION = 'partner-dashboard.phase1.v1';

export const PARTNER_ROLES = ['partner_admin', 'partner_caseworker'] as const;
export type PartnerRole = (typeof PARTNER_ROLES)[number];
export type PartnerUserStatus = 'invited' | 'active' | 'disabled';

export const PARTNER_STABLE_ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const OPERATOR_HANDLE_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/;

export type PartnerAuditAction =
  | 'operator.operator.add' | 'operator.operator.disable'
  | 'operator.org.create' | 'operator.org.set_agreement' | 'operator.org.intake' | 'operator.org.mfa'
  | 'operator.user.invite' | 'operator.user.disable' | 'operator.user.reset' | 'operator.user.set_password'
  | 'operator.sessions.revoke' | 'operator.audit.export' | 'operator.seed.synthetic'
  | 'operator.referral.list' | 'operator.referral.revoke'
  | 'auth.enroll.start' | 'auth.enroll.complete' | 'auth.login' | 'auth.totp' | 'auth.totp.setup' | 'auth.logout'
  | 'auth.lockout' | 'auth.password.change'
  | 'partner.me.read' | 'partner.referral.list' | 'partner.referral.read'
  | 'partner.referral.status' | 'partner.referral.note' | 'partner.referral.callback.read'
  | 'partner.evidence.url'
  | 'partner.org.users.list' | 'partner.org.user.disable' | 'partner.org.audit.read'
  | 'partner.referral.assign' | 'partner.onward.create' | 'partner.onward.status'
  | 'partner.summary.read' | 'partner.staff.list' | 'partner.coverage.change'
  | 'partner.push.subscribe' | 'partner.push.unsubscribe' | 'partner.push.test';

export type PartnerAuditOutcome = 'success' | 'denied' | 'failed';

/**
 * Why an operator revoked one referral (referral:revoke): codes only, never
 * free text, recorded in the audit and nowhere the survivor or partner sees.
 * Matches migration 010's partner_audit_reason_code check.
 */
export const PARTNER_OPERATOR_REVOKE_REASONS = [
  'misrouted',
  'safeguarding_concern',
  'partner_compromise',
  'survivor_request_offline',
  'other',
] as const;
export type PartnerOperatorRevokeReason = (typeof PARTNER_OPERATOR_REVOKE_REASONS)[number];

export type PartnerAuditActor =
  | { type: 'partner_user'; userId: string }
  | { type: 'operator'; operatorRef: string }
  | { type: 'anonymous' };

export type PartnerAuditEntry = {
  orgId?: string | null;
  actor: PartnerAuditActor;
  action: PartnerAuditAction;
  outcome: PartnerAuditOutcome;
  requestId: string;
  referralId?: string | null;
  attachmentId?: string | null;
  targetUserId?: string | null;
  /** Only on operator.referral.revoke (migration 010). */
  reasonCode?: PartnerOperatorRevokeReason | null;
};

/** The operator and request behind a CLI change; both land in the audit row. */
export type OperatorContext = { operatorRef: string; requestId: string };

export type PartnerOperator = {
  id: string;
  handle: string;
  displayName: string;
  roleLabel: string;
  status: 'active' | 'disabled';
};

export type PartnerOrg = {
  id: string;
  stableId: string;
  displayName: string;
  status: 'active' | 'suspended';
  intakeEnabled: boolean;
  agreementRef: string | null;
  agreementSignedAt: Date | null;
  agreementExpiresAt: Date | null;
};

/** Never carries password, TOTP or enrolment-token material. */
export type PartnerUserSummary = {
  id: string;
  orgId: string;
  email: string;
  displayName: string;
  role: PartnerRole;
  status: PartnerUserStatus;
  totpEnrolled: boolean;
};

export type PartnerAuditExportRow = {
  id: string;
  createdAt: string;
  orgId: string | null;
  actorType: PartnerAuditActor['type'];
  partnerUserId: string | null;
  operatorRef: string | null;
  action: PartnerAuditAction;
  referralId: string | null;
  attachmentId: string | null;
  targetUserId: string | null;
  reasonCode: PartnerOperatorRevokeReason | null;
  outcome: PartnerAuditOutcome;
  requestId: string;
  policyVersion: string;
};

export type PartnerAdminErrorCode =
  | 'not_found' | 'conflict' | 'invalid_state' | 'agreement_required' | 'operator_unknown';

export class PartnerAdminError extends Error {
  readonly code: PartnerAdminErrorCode;

  constructor(code: PartnerAdminErrorCode, message: string) {
    super(message);
    this.name = 'PartnerAdminError';
    this.code = code;
  }
}

type Queryable = Pick<PoolClient, 'query'>;

type OperatorRow = {
  id: string;
  handle: string;
  display_name: string;
  role_label: string;
  status: 'active' | 'disabled';
};

type OrgRow = {
  id: string;
  stable_id: string;
  display_name: string;
  status: 'active' | 'suspended';
  intake_enabled: boolean;
  agreement_ref: string | null;
  agreement_signed_at: Date | string | null;
  agreement_expires_at: Date | string | null;
};

type UserRow = {
  id: string;
  org_id: string;
  email: string;
  display_name: string;
  role: PartnerRole;
  status: PartnerUserStatus;
  totp_enrolled: boolean;
};

const OPERATOR_COLUMNS = 'id, handle, display_name, role_label, status';
const ORG_COLUMNS = `id, stable_id, display_name, status, intake_enabled, agreement_ref,
  agreement_signed_at, agreement_expires_at`;
const USER_COLUMNS = `id, org_id, email, display_name, role, status,
  (totp_enrolled_at is not null) as totp_enrolled`;

function toDate(value: Date | string | null): Date | null {
  return value === null ? null : new Date(value);
}

function mapOperator(row: OperatorRow): PartnerOperator {
  return {
    id: row.id,
    handle: row.handle,
    displayName: row.display_name,
    roleLabel: row.role_label,
    status: row.status,
  };
}

function mapOrg(row: OrgRow): PartnerOrg {
  return {
    id: row.id,
    stableId: row.stable_id,
    displayName: row.display_name,
    status: row.status,
    intakeEnabled: row.intake_enabled,
    agreementRef: row.agreement_ref,
    agreementSignedAt: toDate(row.agreement_signed_at),
    agreementExpiresAt: toDate(row.agreement_expires_at),
  };
}

function mapUser(row: UserRow): PartnerUserSummary {
  return {
    id: row.id,
    orgId: row.org_id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    status: row.status,
    totpEnrolled: row.totp_enrolled,
  };
}

export function normalizePartnerEmail(email: string): string {
  return email.trim().toLowerCase();
}

const AUDIT_COLUMNS = `org_id, actor_type, partner_user_id, operator_ref, action, referral_id,
    attachment_id, target_user_id, outcome, request_id, policy_version`;
const AUDIT_INSERT = `
  insert into saferide.partner_access_audit (${AUDIT_COLUMNS})
  values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
`;
// reason_code (migration 010) is named only on rows that carry one, so every
// other audit write keeps working on a database that does not have 010 yet.
const AUDIT_INSERT_WITH_REASON = `
  insert into saferide.partner_access_audit (${AUDIT_COLUMNS}, reason_code)
  values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
`;

/**
 * Appends one partner access audit row. Pass the transaction client so the
 * audit commits (or fails) together with the change it records.
 */
export async function recordPartnerAccess(entry: PartnerAuditEntry, client?: Queryable): Promise<void> {
  const values = [
    entry.orgId ?? null,
    entry.actor.type,
    entry.actor.type === 'partner_user' ? entry.actor.userId : null,
    entry.actor.type === 'operator' ? entry.actor.operatorRef : null,
    entry.action,
    entry.referralId ?? null,
    entry.attachmentId ?? null,
    entry.targetUserId ?? null,
    entry.outcome,
    entry.requestId,
    PARTNER_ACCESS_POLICY_VERSION,
  ];
  const sql = entry.reasonCode ? AUDIT_INSERT_WITH_REASON : AUDIT_INSERT;
  const params = entry.reasonCode ? [...values, entry.reasonCode] : values;
  if (client) {
    await client.query(sql, params);
  } else {
    await query(sql, params);
  }
}

/**
 * Appends a success row for a polled read at most once per `windowSeconds`
 * per user and action (partner.summary.read, polled every 60 s). The read
 * shows counts only, so one row per window still says who looked and when
 * without filling the audit with a row a minute. Refusals are never
 * throttled: callers record them with recordPartnerAccess. Two polls racing
 * inside the same window can both write a row; that only over-records.
 * Returns whether a row was written.
 */
export async function recordPartnerAccessAtMostEvery(
  entry: PartnerAuditEntry & { actor: { type: 'partner_user'; userId: string }; outcome: 'success' },
  windowSeconds: number,
): Promise<boolean> {
  const { rowCount } = await query(
    `insert into saferide.partner_access_audit (${AUDIT_COLUMNS})
     select $1::uuid, 'partner_user'::text, $2::uuid, null::text, $3::text, $4::uuid, null::uuid, null::uuid,
       'success'::text, $5::text, $6::text
     where not exists (
       select 1 from saferide.partner_access_audit recent
       where recent.org_id = $1::uuid and recent.partner_user_id = $2::uuid and recent.action = $3::text
         and recent.outcome = 'success' and recent.created_at > now() - make_interval(secs => $7::int)
     )`,
    [
      entry.orgId ?? null, entry.actor.userId, entry.action, entry.referralId ?? null, entry.requestId,
      PARTNER_ACCESS_POLICY_VERSION, Math.max(1, Math.floor(windowSeconds)),
    ],
  );
  return (rowCount ?? 0) > 0;
}

function mapDatabaseError(error: unknown): unknown {
  const pgError = error as { code?: string; constraint?: string };
  if (pgError?.code === '23505') {
    return new PartnerAdminError('conflict', 'A record with that identifier already exists');
  }
  if (pgError?.code === '23514' && pgError.constraint === 'partner_org_intake_requires_agreement') {
    return new PartnerAdminError('agreement_required', 'Intake needs an active organisation with a recorded agreement');
  }
  if (pgError?.code === '23514') {
    return new PartnerAdminError('invalid_state', 'The change violates a partner data constraint');
  }
  return error;
}

/** Runs `work` in one transaction; any failure (including the audit write) rolls back. */
export async function withPartnerTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await work(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw mapDatabaseError(error);
  } finally {
    client.release();
  }
}

function operatorAudit(
  context: OperatorContext,
  action: PartnerAuditAction,
  extra: Partial<PartnerAuditEntry> = {},
): PartnerAuditEntry {
  return {
    actor: { type: 'operator', operatorRef: context.operatorRef },
    action,
    outcome: 'success',
    requestId: context.requestId,
    ...extra,
  };
}

async function requireActiveOperator(client: Queryable, handle: string): Promise<void> {
  const { rows } = await client.query<{ id: string }>(
    `select id from saferide.partner_operators where handle = $1 and status = 'active'`,
    [handle],
  );
  if (rows.length !== 1) {
    throw new PartnerAdminError('operator_unknown', 'The --operator handle is not an active registered operator');
  }
}

export async function countPartnerOperators(): Promise<number> {
  const { rows } = await query<{ count: string }>(`select count(*)::text as count from saferide.partner_operators`);
  return Number(rows[0]?.count ?? 0);
}

/**
 * Registers an operator. Only an explicit bootstrap on an empty registry
 * lets the first operator register themselves; it is refused once any
 * operator exists. After that an existing active operator must act.
 */
export async function addPartnerOperator(params: {
  handle: string;
  displayName: string;
  roleLabel: string;
  bootstrap?: boolean;
  context: OperatorContext;
}): Promise<PartnerOperator> {
  return withPartnerTransaction(async client => {
    await client.query(`lock table saferide.partner_operators in share row exclusive mode`);
    const { rows: existing } = await client.query<{ count: string }>(
      `select count(*)::text as count from saferide.partner_operators`,
    );
    const registryEmpty = Number(existing[0]?.count ?? 0) === 0;
    if (params.bootstrap) {
      if (!registryEmpty) throw new PartnerAdminError('invalid_state', 'Bootstrap is only possible while no operator exists');
      if (params.context.operatorRef !== params.handle) {
        throw new PartnerAdminError('operator_unknown', 'The bootstrap operator must register themselves (--operator equal to --handle)');
      }
    } else if (registryEmpty) {
      throw new PartnerAdminError('operator_unknown', 'No operator exists yet; register the first one with --bootstrap');
    } else {
      await requireActiveOperator(client, params.context.operatorRef);
    }
    const { rows } = await client.query<OperatorRow>(
      `insert into saferide.partner_operators (handle, display_name, role_label)
       values ($1, $2, $3) returning ${OPERATOR_COLUMNS}`,
      [params.handle, params.displayName, params.roleLabel],
    );
    await recordPartnerAccess(operatorAudit(params.context, 'operator.operator.add'), client);
    return mapOperator(rows[0]);
  });
}

export async function disablePartnerOperator(params: {
  handle: string;
  context: OperatorContext;
}): Promise<PartnerOperator> {
  return withPartnerTransaction(async client => {
    await requireActiveOperator(client, params.context.operatorRef);
    if (params.handle === params.context.operatorRef) {
      throw new PartnerAdminError('invalid_state', 'Operators cannot disable themselves');
    }
    const { rows } = await client.query<OperatorRow>(
      `update saferide.partner_operators set status = 'disabled', disabled_at = now()
       where handle = $1 and status = 'active' returning ${OPERATOR_COLUMNS}`,
      [params.handle],
    );
    if (rows.length !== 1) throw new PartnerAdminError('not_found', 'No active operator with that handle');
    await recordPartnerAccess(operatorAudit(params.context, 'operator.operator.disable'), client);
    return mapOperator(rows[0]);
  });
}

export async function getPartnerOrgByStableId(stableId: string): Promise<PartnerOrg | null> {
  const { rows } = await query<OrgRow>(
    `select ${ORG_COLUMNS} from saferide.partner_organizations where stable_id = $1`,
    [stableId],
  );
  return rows[0] ? mapOrg(rows[0]) : null;
}

/**
 * The org only if it is open for intake right now: active, intake on and
 * the agreement in force at query time. P3 calls this inside the routing
 * transaction; the database enforces the same rule on every referral insert.
 */
export async function findPartnerOrgOpenForIntake(
  stableId: string,
  client?: Queryable,
  options: { lockForShare?: boolean } = {},
): Promise<PartnerOrg | null> {
  // lockForShare (inside a transaction): a concurrent intake-off or suspension
  // waits for this transaction, and one already in flight makes this return null.
  const sql = `select ${ORG_COLUMNS} from saferide.partner_organizations
    where stable_id = $1 and status = 'active' and intake_enabled
      and agreement_signed_at <= now() and agreement_expires_at > now()${options.lockForShare ? '\n    for share' : ''}`;
  const { rows } = client ? await client.query<OrgRow>(sql, [stableId]) : await query<OrgRow>(sql, [stableId]);
  return rows[0] ? mapOrg(rows[0]) : null;
}

export async function createPartnerOrg(params: {
  stableId: string;
  displayName: string;
  context: OperatorContext;
}): Promise<PartnerOrg> {
  if (looksLikeUuid(params.stableId)) {
    throw new PartnerAdminError('invalid_state', 'A stable id cannot look like a UUID; it would be confused with an organisation id');
  }
  return withPartnerTransaction(async client => {
    await requireActiveOperator(client, params.context.operatorRef);
    const { rows } = await client.query<OrgRow>(
      `insert into saferide.partner_organizations (stable_id, display_name)
       values ($1, $2) returning ${ORG_COLUMNS}`,
      [params.stableId, params.displayName],
    );
    const org = mapOrg(rows[0]);
    await recordPartnerAccess(operatorAudit(params.context, 'operator.org.create', { orgId: org.id }), client);
    return org;
  });
}

export async function setPartnerOrgAgreement(params: {
  stableId: string;
  agreementRef: string;
  signedAt: Date;
  expiresAt: Date;
  context: OperatorContext;
}): Promise<PartnerOrg> {
  return withPartnerTransaction(async client => {
    await requireActiveOperator(client, params.context.operatorRef);
    const { rows } = await client.query<OrgRow>(
      `update saferide.partner_organizations
       set agreement_ref = $2, agreement_signed_at = $3, agreement_expires_at = $4
       where stable_id = $1 returning ${ORG_COLUMNS}`,
      [params.stableId, params.agreementRef, params.signedAt, params.expiresAt],
    );
    if (rows.length !== 1) throw new PartnerAdminError('not_found', 'No partner organisation with that stable id');
    const org = mapOrg(rows[0]);
    await recordPartnerAccess(operatorAudit(params.context, 'operator.org.set_agreement', { orgId: org.id }), client);
    return org;
  });
}

/** Intake can only be switched on while the recorded agreement is in force. */
export async function setPartnerOrgIntake(params: {
  stableId: string;
  enabled: boolean;
  context: OperatorContext;
}): Promise<PartnerOrg> {
  return withPartnerTransaction(async client => {
    await requireActiveOperator(client, params.context.operatorRef);
    const { rows } = await client.query<OrgRow>(
      `update saferide.partner_organizations
       set intake_enabled = $2
       where stable_id = $1
         and ($2 = false or (agreement_expires_at > now() and agreement_signed_at <= now()))
       returning ${ORG_COLUMNS}`,
      [params.stableId, params.enabled],
    );
    if (rows.length !== 1) {
      const exists = await client.query(`select 1 from saferide.partner_organizations where stable_id = $1`, [params.stableId]);
      if (exists.rows.length === 0) throw new PartnerAdminError('not_found', 'No partner organisation with that stable id');
      throw new PartnerAdminError('agreement_required', 'Intake needs a recorded agreement that is currently in force');
    }
    const org = mapOrg(rows[0]);
    await recordPartnerAccess(operatorAudit(params.context, 'operator.org.intake', { orgId: org.id }), client);
    return org;
  });
}

export async function findPartnerUserByEmail(email: string): Promise<PartnerUserSummary | null> {
  const { rows } = await query<UserRow>(
    `select ${USER_COLUMNS} from saferide.partner_users where email = $1`,
    [normalizePartnerEmail(email)],
  );
  return rows[0] ? mapUser(rows[0]) : null;
}

/** Creates an invited user; only the enrolment token's sha256 is stored. */
export async function invitePartnerUser(params: {
  orgStableId: string;
  email: string;
  displayName: string;
  role: PartnerRole;
  enrollmentTokenHash: string;
  enrollmentExpiresAt: Date;
  context: OperatorContext;
}): Promise<PartnerUserSummary> {
  return withPartnerTransaction(async client => {
    await requireActiveOperator(client, params.context.operatorRef);
    const { rows } = await client.query<UserRow>(
      `insert into saferide.partner_users (
         org_id, email, display_name, role, enrollment_token_hash, enrollment_expires_at
       )
       select id, $2, $3, $4, $5, $6 from saferide.partner_organizations
       where stable_id = $1 and status = 'active'
       returning ${USER_COLUMNS}`,
      [
        params.orgStableId, normalizePartnerEmail(params.email), params.displayName, params.role,
        params.enrollmentTokenHash, params.enrollmentExpiresAt,
      ],
    );
    if (rows.length !== 1) throw new PartnerAdminError('not_found', 'No active partner organisation with that stable id');
    const user = mapUser(rows[0]);
    await recordPartnerAccess(operatorAudit(params.context, 'operator.user.invite', {
      orgId: user.orgId, targetUserId: user.id,
    }), client);
    return user;
  });
}

async function lockUserByEmail(client: Queryable, email: string): Promise<UserRow> {
  const { rows } = await client.query<UserRow>(
    `select ${USER_COLUMNS} from saferide.partner_users where email = $1 for update`,
    [normalizePartnerEmail(email)],
  );
  if (rows.length !== 1) throw new PartnerAdminError('not_found', 'No partner user with that email');
  return rows[0];
}

async function revokeUserSessions(
  client: Queryable,
  userId: string,
  reason: 'operator' | 'user_disabled' | 'credential_reset',
): Promise<number> {
  // credential_reset also covers user:set-password (013).
  const { rowCount } = await client.query(
    `update saferide.partner_sessions set revoked_at = now(), revoke_reason = $2
     where user_id = $1 and revoked_at is null`,
    [userId, reason],
  );
  // Also revokes the user's known-device cookies (sign-in gate priority, 012).
  await client.query(
    `update saferide.partner_users set known_device_epoch = known_device_epoch + 1 where id = $1`,
    [userId],
  );
  return rowCount ?? 0;
}

/**
 * Clears the user's assignments on active referrals (migration 014) and
 * records each as `unassigned` by SafeRide in the partner activity, so the
 * referral shows up as unassigned instead of in the hands of a leaver.
 * Returns how many referrals were released.
 */
async function releaseUserAssignments(client: Queryable, userId: string, orgId: string): Promise<number> {
  const { rowCount } = await client.query(
    `with released as (
       update saferide.partner_referrals set assignee_user_id = null
       where org_id = $2 and assignee_user_id = $1 and access_revoked_at is null
       returning id, org_id
     )
     insert into saferide.partner_case_activity (referral_id, org_id, actor_type, actor_user_id, kind)
     select id, org_id, 'saferide', null, 'unassigned' from released`,
    [userId, orgId],
  );
  return rowCount ?? 0;
}

/** Disables the user, cancels any pending enrolment, revokes every session and releases their referrals. */
export async function disablePartnerUser(params: {
  email: string;
  context: OperatorContext;
}): Promise<{ user: PartnerUserSummary; revokedSessions: number; releasedAssignments: number }> {
  return withPartnerTransaction(async client => {
    await requireActiveOperator(client, params.context.operatorRef);
    const current = await lockUserByEmail(client, params.email);
    if (current.status === 'disabled') throw new PartnerAdminError('invalid_state', 'The partner user is already disabled');
    const { rows } = await client.query<UserRow>(
      `update saferide.partner_users
       set status = 'disabled', disabled_at = now(),
           enrollment_token_hash = null, enrollment_expires_at = null
       where id = $1 returning ${USER_COLUMNS}`,
      [current.id],
    );
    const revokedSessions = await revokeUserSessions(client, current.id, 'user_disabled');
    const releasedAssignments = await releaseUserAssignments(client, current.id, current.org_id);
    await recordPartnerAccess(operatorAudit(params.context, 'operator.user.disable', {
      orgId: current.org_id, targetUserId: current.id,
    }), client);
    return { user: mapUser(rows[0]), revokedSessions, releasedAssignments };
  });
}

/**
 * Resets enrolment: clears the password and TOTP secret, lifts any lockout,
 * revokes every session, releases the user's referrals and issues a new
 * one-time enrolment token. The user then sets a new password and enrols a
 * new authenticator from the link.
 */
export async function resetPartnerUserEnrollment(params: {
  email: string;
  enrollmentTokenHash: string;
  enrollmentExpiresAt: Date;
  context: OperatorContext;
}): Promise<{ user: PartnerUserSummary; revokedSessions: number; releasedAssignments: number }> {
  return withPartnerTransaction(async client => {
    await requireActiveOperator(client, params.context.operatorRef);
    const current = await lockUserByEmail(client, params.email);
    if (current.status === 'disabled') throw new PartnerAdminError('invalid_state', 'Disabled partner users cannot be reset');
    const { rows } = await client.query<UserRow>(
      `update saferide.partner_users
       set status = 'invited', password_hash = null, totp_secret_enc = null,
           totp_enrolled_at = null, totp_last_step = null, failed_attempts = 0,
           lockout_count = 0, locked_until = null,
           enrollment_token_hash = $2, enrollment_expires_at = $3
       where id = $1 returning ${USER_COLUMNS}`,
      [current.id, params.enrollmentTokenHash, params.enrollmentExpiresAt],
    );
    const revokedSessions = await revokeUserSessions(client, current.id, 'credential_reset');
    const releasedAssignments = await releaseUserAssignments(client, current.id, current.org_id);
    await recordPartnerAccess(operatorAudit(params.context, 'operator.user.reset', {
      orgId: current.org_id, targetUserId: current.id,
    }), client);
    return { user: mapUser(rows[0]), revokedSessions, releasedAssignments };
  });
}

export async function revokePartnerSessions(params: {
  target: { email: string } | { orgStableId: string };
  context: OperatorContext;
}): Promise<number> {
  return withPartnerTransaction(async client => {
    await requireActiveOperator(client, params.context.operatorRef);
    if ('email' in params.target) {
      const user = await lockUserByEmail(client, params.target.email);
      const revoked = await revokeUserSessions(client, user.id, 'operator');
      await recordPartnerAccess(operatorAudit(params.context, 'operator.sessions.revoke', {
        orgId: user.org_id, targetUserId: user.id,
      }), client);
      return revoked;
    }
    const { rows } = await client.query<{ id: string }>(
      `select id from saferide.partner_organizations where stable_id = $1`,
      [params.target.orgStableId],
    );
    if (rows.length !== 1) throw new PartnerAdminError('not_found', 'No partner organisation with that stable id');
    const { rowCount } = await client.query(
      `update saferide.partner_sessions set revoked_at = now(), revoke_reason = 'operator'
       where org_id = $1 and revoked_at is null`,
      [rows[0].id],
    );
    await client.query(
      `update saferide.partner_users set known_device_epoch = known_device_epoch + 1 where org_id = $1`,
      [rows[0].id],
    );
    await recordPartnerAccess(operatorAudit(params.context, 'operator.sessions.revoke', { orgId: rows[0].id }), client);
    return rowCount ?? 0;
  });
}

/**
 * Sets an operator-issued password (user:set-password, migration 013):
 * stores the scrypt hash, sets must_change_password, activates an invited
 * user (cancelling their enrolment link and any half-finished authenticator
 * setup), lifts any lockout and revokes every session and known-device
 * cookie of the user. An authenticator the user already enrolled is kept.
 * The password itself never reaches this function or the audit.
 */
export async function setPartnerUserPassword(params: {
  email: string;
  passwordHash: string;
  context: OperatorContext;
}): Promise<{ user: PartnerUserSummary; revokedSessions: number; wasInvited: boolean; orgMfaRequired: boolean }> {
  return withPartnerTransaction(async client => {
    await requireActiveOperator(client, params.context.operatorRef);
    const current = await lockUserByEmail(client, params.email);
    if (current.status === 'disabled') throw new PartnerAdminError('invalid_state', 'Disabled partner users cannot get a password');
    const { rows } = await client.query<UserRow>(
      `update saferide.partner_users
       set password_hash = $2, must_change_password = true, status = 'active',
           enrollment_token_hash = null, enrollment_expires_at = null,
           totp_secret_enc = case when totp_enrolled_at is null then null else totp_secret_enc end,
           totp_last_step = case when totp_enrolled_at is null then null else totp_last_step end,
           failed_attempts = 0, lockout_count = 0, locked_until = null
       where id = $1 returning ${USER_COLUMNS}`,
      [current.id, params.passwordHash],
    );
    const revokedSessions = await revokeUserSessions(client, current.id, 'credential_reset');
    const org = await client.query<{ mfa_required: boolean }>(
      `select mfa_required from saferide.partner_organizations where id = $1`,
      [current.org_id],
    );
    await recordPartnerAccess(operatorAudit(params.context, 'operator.user.set_password', {
      orgId: current.org_id, targetUserId: current.id,
    }), client);
    return {
      user: mapUser(rows[0]),
      revokedSessions,
      wasInvited: current.status === 'invited',
      orgMfaRequired: org.rows[0]?.mfa_required ?? true,
    };
  });
}

/**
 * Sets whether an org requires TOTP at sign-in (org:mfa, migration 013).
 * Turning it on also revokes the org's live password-only sessions (reason
 * mfa_policy), which stop resolving as full anyway; users without an
 * authenticator then set one up at their next sign-in.
 */
export async function setPartnerOrgMfa(params: {
  org: string;
  required: boolean;
  context: OperatorContext;
}): Promise<{ org: { id: string; stableId: string; intakeEnabled: boolean }; changed: boolean; revokedSessions: number; usersWithoutTotp: number }> {
  return withPartnerTransaction(async client => {
    await requireActiveOperator(client, params.context.operatorRef);
    const target = await resolvePartnerOrg(client, params.org);
    const { rows } = await client.query<{ mfa_required: boolean; intake_enabled: boolean }>(
      `select mfa_required, intake_enabled from saferide.partner_organizations where id = $1 for update`,
      [target.id],
    );
    await client.query(`update saferide.partner_organizations set mfa_required = $2 where id = $1`, [target.id, params.required]);
    let revokedSessions = 0;
    if (params.required) {
      const revoked = await client.query(
        `update saferide.partner_sessions set revoked_at = now(), revoke_reason = 'mfa_policy'
         where org_id = $1 and mfa_waived and revoked_at is null`,
        [target.id],
      );
      revokedSessions = revoked.rowCount ?? 0;
    }
    const without = await client.query<{ count: string }>(
      `select count(*)::text as count from saferide.partner_users
       where org_id = $1 and status = 'active' and totp_enrolled_at is null`,
      [target.id],
    );
    await recordPartnerAccess(operatorAudit(params.context, 'operator.org.mfa', { orgId: target.id }), client);
    return {
      org: { id: target.id, stableId: target.stableId, intakeEnabled: rows[0].intake_enabled },
      changed: rows[0].mfa_required !== params.required,
      revokedSessions,
      usersWithoutTotp: Number(without.rows[0]?.count ?? 0),
    };
  });
}

/** Whether the partner can still open a referral, and if not, who ended it. */
export type PartnerReferralAccess = 'active' | 'withdrawn' | 'revoked';

/**
 * referral:list --status: a partner status lists active referrals in that
 * status (as the partner's own queue does); `withdrawn` lists those the
 * survivor ended (consent withdrawal or case deletion) and `revoked` those
 * an operator ended.
 */
export const PARTNER_OPERATOR_REFERRAL_FILTERS = [...PARTNER_REFERRAL_STATUSES, 'withdrawn', 'revoked'] as const;
export type PartnerOperatorReferralFilter = (typeof PARTNER_OPERATOR_REFERRAL_FILTERS)[number];

/**
 * What an operator sees of a referral: metadata only. Never case content,
 * survivor, case or consent ids, the callback number or partner notes.
 */
export type PartnerOperatorReferralRow = {
  reference: string;
  pathway: 'referral' | 'escalation' | null;
  status: PartnerReferralStatus;
  access: PartnerReferralAccess;
  receivedAt: Date;
  statusChangedAt: Date;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for a UUID-shaped value: never a valid org stable id (migration 011), so --org can take either. */
export function looksLikeUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/** An org by stable id or by id; a value matching two different orgs is refused (011 makes that impossible for new orgs). */
async function resolvePartnerOrg(client: Queryable, orgRef: string): Promise<{ id: string; stableId: string }> {
  const { rows } = await client.query<{ id: string; stable_id: string }>(
    `select id, stable_id from saferide.partner_organizations where stable_id = $1 or id = $2::uuid`,
    [orgRef, looksLikeUuid(orgRef) ? orgRef.toLowerCase() : null],
  );
  if (rows.length === 0) throw new PartnerAdminError('not_found', 'No partner organisation with that stable id or id');
  if (rows.length > 1) throw new PartnerAdminError('conflict', 'That value matches more than one organisation; use the stable id');
  return { id: rows[0].id, stableId: rows[0].stable_id };
}

/** One org's referrals, newest first, as metadata only; the listing itself is audited. */
export async function listPartnerReferralsForOperator(params: {
  org: string;
  status?: PartnerOperatorReferralFilter;
  limit: number;
  context: OperatorContext;
}): Promise<{ org: { id: string; stableId: string }; rows: PartnerOperatorReferralRow[]; more: boolean }> {
  return withPartnerTransaction(async client => {
    await requireActiveOperator(client, params.context.operatorRef);
    const org = await resolvePartnerOrg(client, params.org);
    const { rows } = await client.query<{
      reference: string; status: PartnerReferralStatus; access: PartnerReferralAccess; pathway: string | null;
      created_at: Date; status_changed_at: Date;
    }>(
      `with listed as (
         select r.reference, r.status, r.created_at, r.status_changed_at, c.pathway,
           case
             when r.access_revoked_at is null and consent.status = 'granted' then 'active'
             when r.revoke_reason = 'operator' then 'revoked'
             else 'withdrawn'
           end as access
         from saferide.partner_referrals r
         join saferide.cases c on c.id = r.case_id and c.owner_id = r.owner_id
         join saferide.consent_records consent on consent.id = r.consent_record_id and consent.owner_id = r.owner_id
         where r.org_id = $1
       )
       select reference, status, access, pathway, created_at, status_changed_at from listed
       where $2::text is null
         or ($2 in ('withdrawn', 'revoked') and access = $2)
         or ($2 not in ('withdrawn', 'revoked') and access = 'active' and status = $2)
       order by created_at desc, reference desc
       limit $3`,
      [org.id, params.status ?? null, params.limit + 1],
    );
    await recordPartnerAccess(operatorAudit(params.context, 'operator.referral.list', { orgId: org.id }), client);
    return {
      org,
      rows: rows.slice(0, params.limit).map(row => ({
        reference: row.reference,
        pathway: row.pathway === 'referral' ? 'referral' : row.pathway === 'escalate' ? 'escalation' : null,
        status: row.status,
        access: row.access,
        receivedAt: new Date(row.created_at),
        statusChangedAt: new Date(row.status_changed_at),
      })),
      more: rows.length > params.limit,
    };
  });
}

/** What referral:revoke found, before or after acting. */
export type PartnerOperatorRevokeResult =
  | {
    confirmed: false; reference: string; orgStableId: string;
    status: PartnerReferralStatus; access: PartnerReferralAccess;
  }
  | {
    confirmed: true; reference: string; orgStableId: string;
    revokedAt: Date; alreadyRevoked: boolean;
  };

/**
 * Safeguarding kill switch for one referral. It takes the same database
 * path as a survivor's consent withdrawal: access_revoked_at is set (here
 * with revoke_reason 'operator'). The 007/010/011 triggers then delete the
 * callback and the partner's notes and give the survivor's case the same
 * content-free status_change (`partner_access: 'ended'`, no reason code, no
 * operator) a withdrawal gives, so the partner sees the same tombstone and
 * 410s. `org`, when given, must be the referral's org. Without `confirm`
 * nothing changes: the referral's org and state come back for the operator
 * to check, and the look-up is audited as a revoke that was not carried out
 * (outcome denied). Running it again changes nothing but is audited again.
 */
export async function revokePartnerReferralByOperator(params: {
  reference: string;
  reason: PartnerOperatorRevokeReason;
  org?: string;
  confirm: boolean;
  context: OperatorContext;
}): Promise<PartnerOperatorRevokeResult> {
  return withPartnerTransaction(async client => {
    await requireActiveOperator(client, params.context.operatorRef);
    const { rows } = await client.query<{
      id: string; org_id: string; status: PartnerReferralStatus; access_revoked_at: Date | null;
      access: PartnerReferralAccess; stable_id: string;
    }>(
      `select r.id, r.org_id, r.status, r.access_revoked_at, org.stable_id,
         case
           when r.access_revoked_at is null and consent.status = 'granted' then 'active'
           when r.revoke_reason = 'operator' then 'revoked'
           else 'withdrawn'
         end as access
       from saferide.partner_referrals r
       join saferide.partner_organizations org on org.id = r.org_id
       join saferide.consent_records consent on consent.id = r.consent_record_id and consent.owner_id = r.owner_id
       where r.reference = $1
       for update of r`,
      [params.reference],
    );
    const referral = rows[0];
    if (!referral) throw new PartnerAdminError('not_found', 'No partner referral with that reference');
    if (params.org !== undefined && (await resolvePartnerOrg(client, params.org)).id !== referral.org_id) {
      throw new PartnerAdminError('conflict', 'That referral is not with the organisation given in --org');
    }
    const audit = (outcome: PartnerAuditOutcome) => recordPartnerAccess({
      ...operatorAudit(params.context, 'operator.referral.revoke', {
        orgId: referral.org_id, referralId: referral.id, reasonCode: params.reason,
      }),
      outcome,
    }, client);

    if (!params.confirm) {
      await audit('denied');
      return {
        confirmed: false, reference: params.reference, orgStableId: referral.stable_id,
        status: referral.status, access: referral.access,
      } as const;
    }

    let revokedAt = referral.access_revoked_at;
    if (revokedAt === null) {
      // Correlates the survivor event the 011 trigger writes; never shown to the survivor.
      await client.query(`select set_config('saferide.request_id', $1, true)`, [params.context.requestId]);
      const revoked = await client.query<{ access_revoked_at: Date }>(
        `update saferide.partner_referrals set access_revoked_at = now(), revoke_reason = 'operator'
         where id = $1 and access_revoked_at is null
         returning access_revoked_at`,
        [referral.id],
      );
      revokedAt = revoked.rows[0].access_revoked_at;
    }
    await audit('success');
    return {
      confirmed: true, reference: params.reference, orgStableId: referral.stable_id,
      revokedAt: new Date(revokedAt), alreadyRevoked: referral.access_revoked_at !== null,
    } as const;
  });
}

type AuditRow = {
  id: string;
  created_at: Date | string;
  org_id: string | null;
  actor_type: PartnerAuditActor['type'];
  partner_user_id: string | null;
  operator_ref: string | null;
  action: PartnerAuditAction;
  referral_id: string | null;
  attachment_id: string | null;
  target_user_id: string | null;
  reason_code: PartnerOperatorRevokeReason | null;
  outcome: PartnerAuditOutcome;
  request_id: string;
  policy_version: string;
};

export const PARTNER_AUDIT_EXPORT_LIMIT = 100_000;

/** Exports one org's audit rows for [since, until); the export itself is audited. */
export async function exportPartnerAudit(params: {
  orgStableId: string;
  since: Date;
  until: Date;
  context: OperatorContext;
}): Promise<PartnerAuditExportRow[]> {
  return withPartnerTransaction(async client => {
    await requireActiveOperator(client, params.context.operatorRef);
    const org = await client.query<{ id: string }>(
      `select id from saferide.partner_organizations where stable_id = $1`,
      [params.orgStableId],
    );
    if (org.rows.length !== 1) throw new PartnerAdminError('not_found', 'No partner organisation with that stable id');
    const { rows } = await client.query<AuditRow>(
      `select id, created_at, org_id, actor_type, partner_user_id, operator_ref, action, referral_id,
         attachment_id, target_user_id, reason_code, outcome, request_id, policy_version
       from saferide.partner_access_audit
       where org_id = $1 and created_at >= $2 and created_at < $3
       order by created_at, id
       limit $4`,
      [org.rows[0].id, params.since, params.until, PARTNER_AUDIT_EXPORT_LIMIT],
    );
    await recordPartnerAccess(operatorAudit(params.context, 'operator.audit.export', { orgId: org.rows[0].id }), client);
    return rows.map(row => ({
      id: row.id,
      createdAt: new Date(row.created_at).toISOString(),
      orgId: row.org_id,
      actorType: row.actor_type,
      partnerUserId: row.partner_user_id,
      operatorRef: row.operator_ref,
      action: row.action,
      referralId: row.referral_id,
      attachmentId: row.attachment_id,
      targetUserId: row.target_user_id,
      reasonCode: row.reason_code,
      outcome: row.outcome,
      requestId: row.request_id,
      policyVersion: row.policy_version,
    }));
  });
}
