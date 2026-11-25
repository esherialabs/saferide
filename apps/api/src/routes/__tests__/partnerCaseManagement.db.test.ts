/**
 * Partner case management (migration 014) end to end against a real,
 * disposable PostgreSQL with migrations 000-012 and 014 (and 013 when
 * present) plus runtime-role.sql applied. Skipped unless
 * SAFERIDE_TEST_DATABASE_URL is set. Every query, the API's included, runs
 * as the runtime role `saferide_api`, so its grants are what is tested.
 * Synthetic data only.
 */
import { randomUUID } from 'node:crypto';

import Fastify, { type FastifyInstance, type InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

import { AppError } from '../../http/errors.js';
import { REQUEST_ID_OPTIONS } from '../../http/requestId.js';
import { seedPartnerDemoCases, demoEscalationWorkflow, demoReferralWorkflow } from '../../jobs/partnerDemoCases.js';
import { disablePartnerUser, resetPartnerUserEnrollment } from '../../repositories/partnerRepository.js';
import { registerRequestContext } from '../../middleware/requestContext.js';
import { partnerCsrfToken } from '../../middleware/partnerSession.js';
import * as db from '../../plugins/db.js';
import { PARTNER_ACCESS_DELETION_SCOPE } from '../../services/privacyLifecycle.js';
import { generatePartnerReference, generatePartnerToken, hashPartnerToken } from '../../services/partnerTokens.js';
import { registerPartnerApi } from '../partnerAuth.js';

const SYNTHETIC_PARTNER_KEY = 'cd'.repeat(32);
const SEALED_PLACEHOLDER = `v1.${'A'.repeat(16)}.${'B'.repeat(22)}.${'C'.repeat(27)}`;
const ORIGIN = 'https://partners.example.invalid';
const HOST = 'partners.example.invalid';

vi.mock('../../config/env.js', () => {
  const raw = process.env.SAFERIDE_TEST_DATABASE_URL;
  let databaseUrl = 'postgres://unused.invalid/none';
  if (raw) {
    const url = new URL(raw);
    url.searchParams.set('options', '-c role=saferide_api');
    databaseUrl = url.toString();
  }
  return {
    env: {
      databaseUrl,
      authJwtSecret: 'synthetic-test-only-jwt-secret-0123456789abcdef',
      appEnvironment: 'test',
      partnerPublicOrigin: 'https://partners.example.invalid',
      partnerTotpKey: 'cd'.repeat(32),
      partnerTrustedProxyCidrs: '127.0.0.0/8',
      s3Bucket: 'synthetic-evidence',
    },
  };
});
vi.mock('../../plugins/redis.js', () => ({ redis: { incr: vi.fn(async () => 1), expire: vi.fn(async () => 1) } }));
vi.mock('../../plugins/metrics.js', () => ({ uploadCounter: { labels: vi.fn(() => ({ inc: vi.fn() })) } }));
vi.mock('../../storage/evidenceStorage.js', () => ({
  buildEvidenceObjectKey: vi.fn(), createPresignedUploadPolicy: vi.fn(), deleteEvidenceObject: vi.fn(), hashStoredObject: vi.fn(),
  createPresignedDownloadUrl: vi.fn(async () => 'https://storage.example.invalid/synthetic-presigned'),
}));

const enabled = Boolean(process.env.SAFERIDE_TEST_DATABASE_URL);
const run = randomUUID().slice(0, 8);

type Who = { userId: string; token: string };
type Routed = { referralId: string; caseId: string; ownerId: string; consentId: string };

let app: FastifyInstance;
const state = {
  orgId: '', otherOrgId: '', orgStableId: `cm-${run}`, otherStableId: `cm-other-${run}`,
  caseworker: { userId: '', token: '' } as Who,
  admin: { userId: '', token: '' } as Who,
  other: { userId: '', token: '' } as Who,
  invitedId: '', disabledId: '',
  urgent: {} as Routed, normal: {} as Routed, doomed: {} as Routed, theirs: {} as Routed,
  policeId: '', shelterId: '', theirOnwardId: '',
  eventsAfterAcknowledge: [] as unknown[],
};

function partner(who: Who, method: 'GET' | 'POST', path: string, body?: unknown) {
  const inject: InjectOptions = {
    method,
    url: `/partner/v1${path}`,
    headers: {
      host: HOST, origin: ORIGIN, cookie: `__Host-saferide_partner=${who.token}`,
      ...(method === 'POST' ? { 'x-saferide-partner-csrf': partnerCsrfToken(who.token) } : {}),
    },
  };
  if (body !== undefined) inject.payload = body as InjectOptions['payload'];
  return app.inject(inject);
}

async function partnerUser(orgId: string, label: string, role: 'partner_admin' | 'partner_caseworker', name: string): Promise<Who> {
  const { rows } = await db.query<{ id: string }>(
    `insert into saferide.partner_users (
       org_id, email, display_name, role, status, password_hash, totp_secret_enc, totp_enrolled_at
     ) values ($1, $2, $3, $4, 'active', 'scrypt$synthetic-test-hash', $5, now())
     returning id`,
    [orgId, `${label}-${run}@example.invalid`, name, role, SEALED_PLACEHOLDER],
  );
  const token = generatePartnerToken('session');
  await db.query(
    `insert into saferide.partner_sessions (token_hash, user_id, org_id, mfa_verified, idle_expires_at, absolute_expires_at)
     values ($1, $2, $3, true, now() + interval '30 minutes', now() + interval '11 hours')`,
    [hashPartnerToken(token), rows[0].id, orgId],
  );
  return { userId: rows[0].id, token };
}

async function createOrg(stableId: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into saferide.partner_organizations (
       stable_id, display_name, intake_enabled, agreement_ref, agreement_signed_at, agreement_expires_at
     ) values ($1, 'Synthetic case-management org', true, 'SYNTHETIC-TEST', now() - interval '1 day', now() + interval '30 days')
     on conflict (stable_id) do update set status = 'active', intake_enabled = true, agreement_ref = 'SYNTHETIC-TEST',
       agreement_signed_at = now() - interval '1 day', agreement_expires_at = now() + interval '30 days'
     returning id`,
    [stableId],
  );
  return rows[0].id;
}

/** Routes a synthetic case as the API does: consent, case, referral and the survivor's partner_routed event. */
async function route(orgId: string, stableId: string, pathway: 'escalate' | 'referral'): Promise<Routed> {
  const ownerId = randomUUID();
  const consent = await db.query<{ id: string }>(
    `insert into saferide.consent_records (owner_id, purpose, consent_version, status, granted_at)
     values ($1, 'partner_follow_up', 'synthetic-test.v1', 'granted', now()) returning id`,
    [ownerId],
  );
  const workflow = pathway === 'escalate' ? demoEscalationWorkflow('2026-10-22T07:00:00.000Z', 'urgent') : demoReferralWorkflow();
  const created = await db.query<{ id: string }>(
    `insert into saferide.cases (owner_id, pathway, status, summary) values ($1, $2, 'submitted', $3) returning id`,
    [ownerId, pathway, { workflow }],
  );
  const reference = generatePartnerReference();
  const referral = await db.query<{ id: string }>(
    `insert into saferide.partner_referrals (case_id, owner_id, org_id, consent_record_id, reference)
     values ($1, $2, $3, $4, $5) returning id`,
    [created.rows[0].id, ownerId, orgId, consent.rows[0].id, reference],
  );
  await db.query(
    `insert into saferide.case_events (case_id, owner_id, event_type, payload) values ($1, $2, 'partner_routed', $3)`,
    [created.rows[0].id, ownerId, { schemaVersion: '1.0', partner: stableId, reference, partner_status: 'new', callback_shared: false }],
  );
  return { referralId: referral.rows[0].id, caseId: created.rows[0].id, ownerId, consentId: consent.rows[0].id };
}

async function survivorEvents(target: Routed) {
  const { rows } = await db.query<{ event_type: string; payload: Record<string, unknown>; created_at: Date }>(
    `select event_type, payload, created_at from saferide.case_events where case_id = $1 order by created_at, id`,
    [target.caseId],
  );
  const status = await db.query<{ status: string }>(`select status from saferide.cases where id = $1`, [target.caseId]);
  return { status: status.rows[0]?.status, events: rows };
}

async function auditRows(userId: string) {
  const { rows } = await db.query<{ action: string; outcome: string; referral_id: string | null; target_user_id: string | null }>(
    `select action, outcome, referral_id, target_user_id from saferide.partner_access_audit
     where partner_user_id = $1 order by created_at, id`,
    [userId],
  );
  return rows;
}

async function expectDbError(promise: Promise<unknown>, pattern: RegExp) {
  await expect(promise).rejects.toThrow(pattern);
}

afterAll(async () => {
  await app?.close();
  if (enabled) await db.closeDb();
});

const ids = (response: { json: () => { referrals: Array<{ id: string }> } }) => response.json().referrals.map(item => item.id);

describe.skipIf(!enabled)('partner case management on PostgreSQL, as the runtime role', () => {
  beforeAll(async () => {
    const role = await db.query<{ current_user: string }>('select current_user');
    expect(role.rows[0].current_user).toBe('saferide_api');
    state.orgId = await createOrg(state.orgStableId);
    state.otherOrgId = await createOrg(state.otherStableId);
    state.caseworker = await partnerUser(state.orgId, 'cm-caseworker', 'partner_caseworker', 'Synthetic Amina (caseworker)');
    state.admin = await partnerUser(state.orgId, 'cm-admin', 'partner_admin', 'Synthetic Zawadi (admin)');
    state.other = await partnerUser(state.otherOrgId, 'cm-other', 'partner_caseworker', 'Synthetic other-org caseworker');
    const invited = await db.query<{ id: string }>(
      `insert into saferide.partner_users (org_id, email, display_name, role)
       values ($1, $2, 'Synthetic invitee', 'partner_caseworker') returning id`,
      [state.orgId, `cm-invited-${run}@example.invalid`],
    );
    state.invitedId = invited.rows[0].id;
    const disabled = await db.query<{ id: string }>(
      `insert into saferide.partner_users (org_id, email, display_name, role, status, disabled_at)
       values ($1, $2, 'Synthetic leaver', 'partner_caseworker', 'disabled', now()) returning id`,
      [state.orgId, `cm-disabled-${run}@example.invalid`],
    );
    state.disabledId = disabled.rows[0].id;

    state.urgent = await route(state.orgId, state.orgStableId, 'escalate');
    state.normal = await route(state.orgId, state.orgStableId, 'referral');
    state.doomed = await route(state.orgId, state.orgStableId, 'escalate');
    state.theirs = await route(state.otherOrgId, state.otherStableId, 'escalate');

    app = Fastify({ logger: false, ...REQUEST_ID_OPTIONS });
    await registerRequestContext(app);
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof AppError) {
        reply.status(error.statusCode).send({ code: error.code, message: error.message, details: error.details });
      } else if (error instanceof ZodError) {
        reply.status(400).send({ code: 'bad_request' });
      } else {
        reply.status(500).send({ code: 'internal_error', message: (error as Error).message });
      }
    });
    await registerPartnerApi(app, { publicOrigin: ORIGIN, totpKey: Buffer.from(SYNTHETIC_PARTNER_KEY, 'hex') });
  });

  it('marks escalations urgent and new ones as needing attention, with nobody in charge yet', async () => {
    const queue = await partner(state.caseworker, 'GET', '/referrals');
    expect(queue.statusCode).toBe(200);
    const byId = new Map(queue.json().referrals.map((item: { id: string }) => [item.id, item]));
    expect(byId.get(state.urgent.referralId)).toMatchObject({
      pathway: 'escalation', status: 'new', priority: 'urgent', needsAttention: true, assignee: null, onward: { count: 0, latest: null },
    });
    expect(byId.get(state.normal.referralId)).toMatchObject({ pathway: 'referral', priority: 'normal', needsAttention: false });
    expect(byId.has(state.theirs.referralId)).toBe(false);
    expect(ids(await partner(state.caseworker, 'GET', '/referrals?priority=urgent')).sort())
      .toEqual([state.urgent.referralId, state.doomed.referralId].sort());
    expect(ids(await partner(state.caseworker, 'GET', '/referrals?priority=normal'))).toEqual([state.normal.referralId]);
    expect(ids(await partner(state.caseworker, 'GET', '/referrals?assignee=unassigned'))).toHaveLength(3);
    expect(ids(await partner(state.caseworker, 'GET', '/referrals?assignee=me'))).toEqual([]);

    const summary = await partner(state.caseworker, 'GET', '/summary');
    expect(summary.json()).toEqual({ needsAttention: 2, newTotal: 3, inProgress: 0, unassigned: 3, mine: 0 });
    expect((await partner(state.other, 'GET', '/summary')).json()).toEqual({
      needsAttention: 1, newTotal: 1, inProgress: 0, unassigned: 1, mine: 0,
    });
  });

  it('lists only the org’s active staff, by name and role', async () => {
    const response = await partner(state.caseworker, 'GET', '/staff');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ staff: [
      { id: state.caseworker.userId, name: 'Synthetic Amina (caseworker)', role: 'partner_caseworker' },
      { id: state.admin.userId, name: 'Synthetic Zawadi (admin)', role: 'partner_admin' },
    ] });
    expect(response.body).not.toContain('@');
  });

  it('never acknowledges an urgent referral just because it was opened', async () => {
    const detail = await partner(state.admin, 'GET', `/referrals/${state.urgent.referralId}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.json().referral).toMatchObject({ status: 'new', priority: 'urgent', needsAttention: true, assignee: null });
    expect(detail.json().onwardReferrals).toEqual([]);
    const stored = await db.query(`select status from saferide.partner_referrals where id = $1`, [state.urgent.referralId]);
    expect(stored.rows[0]).toEqual({ status: 'new' });
    expect((await partner(state.admin, 'GET', '/summary')).json().needsAttention).toBe(2);
  });

  it('assigns with optimistic concurrency, to active members of the same org only', async () => {
    const self = await partner(state.caseworker, 'POST', `/referrals/${state.urgent.referralId}/assign`, {
      assigneeId: state.caseworker.userId, expectedAssigneeId: null,
    });
    expect(self.statusCode).toBe(200);
    expect(self.json().referral.assignee).toEqual({ id: state.caseworker.userId, name: 'Synthetic Amina (caseworker)' });
    const stale = await partner(state.admin, 'POST', `/referrals/${state.urgent.referralId}/assign`, {
      assigneeId: state.admin.userId, expectedAssigneeId: null,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().details).toEqual({
      reason: 'stale', currentAssignee: { id: state.caseworker.userId, name: 'Synthetic Amina (caseworker)' },
    });

    // Two people grab the same referral at once: exactly one wins.
    const race = await Promise.all([
      partner(state.caseworker, 'POST', `/referrals/${state.normal.referralId}/assign`, { assigneeId: state.caseworker.userId, expectedAssigneeId: null }),
      partner(state.admin, 'POST', `/referrals/${state.normal.referralId}/assign`, { assigneeId: state.admin.userId, expectedAssigneeId: null }),
    ]);
    expect(race.map(response => response.statusCode).sort()).toEqual([200, 409]);
    const winner = race.find(response => response.statusCode === 200)!.json().referral.assignee.id;

    for (const assigneeId of [state.invitedId, state.disabledId, state.other.userId, randomUUID()]) {
      const refused = await partner(state.admin, 'POST', `/referrals/${state.normal.referralId}/assign`, { assigneeId, expectedAssigneeId: winner });
      expect(refused.statusCode).toBe(400);
      expect(refused.json().details).toEqual({ reason: 'invalid_assignee' });
    }
    const unassigned = await partner(state.admin, 'POST', `/referrals/${state.normal.referralId}/assign`, { assigneeId: null, expectedAssigneeId: winner });
    expect(unassigned.json().referral.assignee).toBeNull();
    const handed = await partner(state.admin, 'POST', `/referrals/${state.normal.referralId}/assign`, {
      assigneeId: state.admin.userId, expectedAssigneeId: null,
    });
    expect(handed.statusCode).toBe(200);

    expect(ids(await partner(state.caseworker, 'GET', '/referrals?assignee=me'))).toEqual([state.urgent.referralId]);
    expect(ids(await partner(state.caseworker, 'GET', `/referrals?assignee=${state.admin.userId}`))).toEqual([state.normal.referralId]);
    expect(ids(await partner(state.caseworker, 'GET', '/referrals?assignee=unassigned'))).toEqual([state.doomed.referralId]);
    // The summary read is audited at most once per window, so later polls still return fresh counts.
    expect((await partner(state.caseworker, 'GET', '/summary')).json()).toMatchObject({ unassigned: 1, mine: 1 });

    // The database refuses an assignee who is not an active member, whatever the caller.
    await expectDbError(
      db.query(`update saferide.partner_referrals set assignee_user_id = $2 where id = $1`, [state.doomed.referralId, state.invitedId]),
      /active user of its organisation/,
    );
    await expectDbError(
      db.query(`update saferide.partner_referrals set assignee_user_id = $2 where id = $1`, [state.doomed.referralId, state.other.userId]),
      /active user of its organisation|partner_referral_assignee_fk/,
    );
  });

  it('clears needsAttention only by an explicit acknowledgement, recording who did it', async () => {
    const before = await survivorEvents(state.urgent);
    const acknowledged = await partner(state.caseworker, 'POST', `/referrals/${state.urgent.referralId}/status`, {
      to: 'acknowledged', expectedStatus: 'new',
    });
    expect(acknowledged.statusCode).toBe(200);
    expect(acknowledged.json().referral).toMatchObject({ status: 'acknowledged', needsAttention: false, priority: 'urgent' });
    expect((await partner(state.caseworker, 'GET', '/summary')).json()).toMatchObject({ needsAttention: 1, newTotal: 2 });

    // The survivor gets exactly the existing status_change event: no names, no actor id.
    const after = await survivorEvents(state.urgent);
    expect(after.events).toHaveLength(before.events.length + 1);
    expect(after.events.at(-1)).toMatchObject({
      event_type: 'status_change',
      payload: { schemaVersion: '1.0', new_status: 'in_review', actor: 'partner', partner: state.orgStableId, partner_status: 'acknowledged' },
    });
    expect(Object.keys(after.events.at(-1)!.payload).sort()).toEqual(['actor', 'new_status', 'partner', 'partner_status', 'schemaVersion']);
    state.eventsAfterAcknowledge = after.events;

    const timeline = (await partner(state.admin, 'GET', `/referrals/${state.urgent.referralId}`)).json().timeline;
    expect(timeline.map((item: { event: string }) => item.event)).toEqual(['received', 'assigned', 'acknowledged']);
    expect(timeline[1]).toMatchObject({
      actor: { id: state.caseworker.userId, name: 'Synthetic Amina (caseworker)' },
      assignee: { id: state.caseworker.userId, name: 'Synthetic Amina (caseworker)' },
    });
    expect(timeline[2]).toMatchObject({ status: 'acknowledged', actor: { id: state.caseworker.userId } });
  });

  it('records onward referrals and moves them only along the allowed path, one writer at a time', async () => {
    const police = await partner(state.caseworker, 'POST', `/referrals/${state.urgent.referralId}/onward`, {
      type: 'police', organisation: 'Synthetic Central Police Station', contactRole: 'Gender desk officer',
      externalReference: 'OB 12/22/10/2026', note: 'Synthetic: statement recorded.', status: 'made',
    });
    expect(police.statusCode).toBe(200);
    expect(police.json().onward).toMatchObject({
      type: 'police', status: 'made', organisation: 'Synthetic Central Police Station', externalReference: 'OB 12/22/10/2026',
      createdBy: { id: state.caseworker.userId, name: 'Synthetic Amina (caseworker)' }, allowedTransitions: ['accepted', 'declined'],
    });
    state.policeId = police.json().onward.id;
    const shelter = await partner(state.admin, 'POST', `/referrals/${state.urgent.referralId}/onward`, { type: 'shelter' });
    expect(shelter.json().onward).toMatchObject({ status: 'planned', organisation: null, note: null });
    state.shelterId = shelter.json().onward.id;

    const race = await Promise.all([
      partner(state.caseworker, 'POST', `/referrals/${state.urgent.referralId}/onward/${state.policeId}/status`, { to: 'accepted', expectedStatus: 'made' }),
      partner(state.admin, 'POST', `/referrals/${state.urgent.referralId}/onward/${state.policeId}/status`, { to: 'declined', expectedStatus: 'made' }),
    ]);
    expect(race.map(response => response.statusCode).sort()).toEqual([200, 409]);
    const won = race.find(response => response.statusCode === 200)!.json().onward.status as 'accepted' | 'declined';
    const lost = race.find(response => response.statusCode === 409)!.json();
    expect(lost.details).toEqual({ reason: 'stale', currentStatus: won });
    if (won === 'accepted') {
      const completed = await partner(state.caseworker, 'POST', `/referrals/${state.urgent.referralId}/onward/${state.policeId}/status`, {
        to: 'completed', expectedStatus: 'accepted',
      });
      expect(completed.json().onward).toMatchObject({ status: 'completed', allowedTransitions: [] });
    }
    const terminal = await partner(state.caseworker, 'POST', `/referrals/${state.urgent.referralId}/onward/${state.policeId}/status`, {
      to: 'declined', expectedStatus: won === 'accepted' ? 'completed' : 'declined',
    });
    expect(terminal.statusCode).toBe(409);
    expect(terminal.json().details.reason).toBe('invalid_transition');
    const skip = await partner(state.admin, 'POST', `/referrals/${state.urgent.referralId}/onward/${state.shelterId}/status`, {
      to: 'accepted', expectedStatus: 'planned',
    });
    expect(skip.json().details).toEqual({ reason: 'invalid_transition', currentStatus: 'planned' });
    expect((await partner(state.admin, 'POST', `/referrals/${state.urgent.referralId}/onward/${state.shelterId}/status`, {
      to: 'cancelled', expectedStatus: 'planned',
    })).statusCode).toBe(200);
    // An onward id under another referral of the same org does not exist there.
    expect((await partner(state.admin, 'POST', `/referrals/${state.normal.referralId}/onward/${state.policeId}/status`, {
      to: 'accepted', expectedStatus: 'made',
    })).statusCode).toBe(404);

    const item = (await partner(state.caseworker, 'GET', '/referrals?assignee=me')).json().referrals[0];
    expect(item.onward).toEqual({ count: 2, latest: { type: 'shelter', status: 'cancelled' } });
    const detail = (await partner(state.caseworker, 'GET', `/referrals/${state.urgent.referralId}`)).json();
    expect(detail.onwardReferrals.map((onward: { id: string; status: string }) => [onward.id, onward.status])).toEqual([
      [state.policeId, won === 'accepted' ? 'completed' : 'declined'], [state.shelterId, 'cancelled'],
    ]);
    const kinds = detail.timeline.map((entry: { event: string }) => entry.event);
    expect(kinds.filter((kind: string) => kind.startsWith('onward_'))).toEqual(
      won === 'accepted'
        ? ['onward_created', 'onward_created', 'onward_status', 'onward_status', 'onward_status']
        : ['onward_created', 'onward_created', 'onward_status', 'onward_status'],
    );
    // No free text in the timeline: the onward organisation, contact and note stay in onwardReferrals.
    const timelineText = JSON.stringify(detail.timeline);
    for (const text of ['Synthetic Central Police Station', 'Gender desk officer', 'OB 12/22', 'statement recorded']) {
      expect(timelineText).not.toContain(text);
    }
  });

  it('keeps the survivor side exactly as it was: no events, names or onward details', async () => {
    const now = await survivorEvents(state.urgent);
    expect(now.status).toBe('in_review');
    expect(now.events).toEqual(state.eventsAfterAcknowledge);
    const everything = JSON.stringify(now.events);
    for (const secret of [
      state.caseworker.userId, state.admin.userId, state.policeId, 'Synthetic Amina', 'Synthetic Zawadi', 'Police', 'police', 'OB 12',
    ]) {
      expect(everything).not.toContain(secret);
    }
    const normal = await survivorEvents(state.normal);
    expect(normal.events.map(event => event.event_type)).toEqual(['partner_routed']);
    expect(normal.status).toBe('submitted');
  });

  it('hides everything from another organisation (404) and shows it none of this org’s work', async () => {
    const theirOnward = await partner(state.other, 'POST', `/referrals/${state.theirs.referralId}/onward`, { type: 'medical' });
    expect(theirOnward.statusCode).toBe(200);
    state.theirOnwardId = theirOnward.json().onward.id;
    const target = state.urgent.referralId;
    const attempts = await Promise.all([
      partner(state.other, 'GET', `/referrals/${target}`),
      partner(state.other, 'POST', `/referrals/${target}/assign`, { assigneeId: state.other.userId, expectedAssigneeId: state.caseworker.userId }),
      partner(state.other, 'POST', `/referrals/${target}/onward`, { type: 'police' }),
      partner(state.other, 'POST', `/referrals/${target}/onward/${state.policeId}/status`, { to: 'accepted', expectedStatus: 'made' }),
      partner(state.caseworker, 'GET', `/referrals/${state.theirs.referralId}`),
      partner(state.caseworker, 'POST', `/referrals/${state.theirs.referralId}/assign`, { assigneeId: null, expectedAssigneeId: null }),
      partner(state.caseworker, 'POST', `/referrals/${state.theirs.referralId}/onward`, { type: 'police' }),
      partner(state.caseworker, 'POST', `/referrals/${state.theirs.referralId}/onward/${state.theirOnwardId}/status`, { to: 'made', expectedStatus: 'planned' }),
      // Their onward id under our referral: not found either.
      partner(state.caseworker, 'POST', `/referrals/${target}/onward/${state.theirOnwardId}/status`, { to: 'made', expectedStatus: 'planned' }),
    ]);
    expect(attempts.map(response => response.statusCode)).toEqual([404, 404, 404, 404, 404, 404, 404, 404, 404]);
    expect(ids(await partner(state.other, 'GET', `/referrals?assignee=${state.caseworker.userId}`))).toEqual([]);
    expect((await partner(state.other, 'GET', '/staff')).json().staff.map((user: { id: string }) => user.id)).toEqual([state.other.userId]);
    const theirs = await db.query(`select status from saferide.partner_onward_referrals where id = $1`, [state.theirOnwardId]);
    expect(theirs.rows[0]).toEqual({ status: 'planned' });
    const ours = await db.query(`select assignee_user_id from saferide.partner_referrals where id = $1`, [target]);
    expect(ours.rows[0]).toEqual({ assignee_user_id: state.caseworker.userId });
  });

  it('lets the runtime role change the history only through the defined paths', async () => {
    await expectDbError(
      db.query(`update saferide.partner_case_activity set kind = 'unassigned' where referral_id = $1`, [state.urgent.referralId]),
      /permission denied/,
    );
    await expectDbError(
      db.query(`update saferide.partner_onward_referrals set note = 'rewritten' where id = $1`, [state.shelterId]),
      /permission denied/,
    );
    await expectDbError(
      db.query(`update saferide.partner_onward_referrals set status = 'made' where id = $1`, [state.shelterId]),
      /invalid onward referral status transition/,
    );
    await expectDbError(db.query(`delete from saferide.partner_onward_referrals where id = $1`, [state.shelterId]), /only when the referral access ends/);
    await expectDbError(
      db.query(`delete from saferide.partner_case_activity where referral_id = $1`, [state.urgent.referralId]),
      /only when the referral access ends/,
    );
    await expectDbError(
      db.query(
        `insert into saferide.partner_onward_referrals (referral_id, org_id, type, status, created_by, status_changed_by)
         values ($1, $2, 'police', 'accepted', $3, $3)`,
        [state.urgent.referralId, state.orgId, state.caseworker.userId],
      ),
      /starts as planned or made/,
    );
  });

  it('writes one content-free audit row per action, and one summary row per polling window', async () => {
    const mine = await auditRows(state.caseworker.userId);
    const count = (action: string, outcome: string) => mine.filter(row => row.action === action && row.outcome === outcome).length;
    expect(count('partner.summary.read', 'success')).toBe(1);
    expect(count('partner.staff.list', 'success')).toBe(1);
    expect(count('partner.onward.create', 'success')).toBe(1);
    expect(count('partner.onward.status', 'success') + count('partner.onward.status', 'denied')).toBeGreaterThanOrEqual(3);
    expect(count('partner.referral.status', 'success')).toBe(1);
    const assigns = mine.filter(row => row.action === 'partner.referral.assign');
    expect(assigns[0]).toEqual({
      action: 'partner.referral.assign', outcome: 'success', referral_id: state.urgent.referralId, target_user_id: state.caseworker.userId,
    });
    // The cross-org attempts are recorded as refusals under the attempting user.
    const theirs = await auditRows(state.other.userId);
    expect(theirs.filter(row => row.outcome === 'denied').map(row => row.action).sort()).toEqual([
      'partner.onward.create', 'partner.onward.status', 'partner.referral.assign', 'partner.referral.read',
    ]);
    const admin = await auditRows(state.admin.userId);
    expect(admin.filter(row => row.action === 'partner.referral.assign' && row.outcome === 'denied').length).toBeGreaterThanOrEqual(5);
    // Nothing typed by the partner reaches the audit.
    const { rows } = await db.query<{ row: string }>(
      `select row_to_json(audit)::text as row from saferide.partner_access_audit audit where org_id = $1`,
      [state.orgId],
    );
    expect(rows.map(row => row.row).join('\n')).not.toMatch(/Police|Gender desk|OB 12/);
  });

  it('deletes onward referrals, activity and the assignment when the survivor withdraws', async () => {
    await db.query(`update saferide.consent_records set status = 'withdrawn', withdrawn_at = now() where id = $1`, [state.urgent.consentId]);
    for (const table of ['partner_onward_referrals', 'partner_case_activity', 'partner_case_notes']) {
      const left = await db.query(`select 1 from saferide.${table} where referral_id = $1`, [state.urgent.referralId]);
      expect(left.rows, table).toHaveLength(0);
    }
    const referral = await db.query(`select assignee_user_id, access_revoked_at is not null as revoked from saferide.partner_referrals where id = $1`, [state.urgent.referralId]);
    expect(referral.rows[0]).toEqual({ assignee_user_id: null, revoked: true });
    const tombstone = await partner(state.caseworker, 'GET', `/referrals/${state.urgent.referralId}`);
    expect(tombstone.json()).toMatchObject({ referral: { status: 'withdrawn', withdrawn: true }, onwardReferrals: [], timeline: [] });
    expect(tombstone.body).not.toMatch(/Police|Amina|shelter/i);
    const refused = await Promise.all([
      partner(state.caseworker, 'POST', `/referrals/${state.urgent.referralId}/assign`, { assigneeId: null, expectedAssigneeId: null }),
      partner(state.caseworker, 'POST', `/referrals/${state.urgent.referralId}/onward`, { type: 'police' }),
      partner(state.caseworker, 'POST', `/referrals/${state.urgent.referralId}/onward/${state.policeId}/status`, { to: 'accepted', expectedStatus: 'made' }),
    ]);
    expect(refused.map(response => response.statusCode)).toEqual([410, 410, 410]);
    const item = (await partner(state.caseworker, 'GET', '/referrals?status=withdrawn')).json().referrals
      .find((entry: { id: string }) => entry.id === state.urgent.referralId);
    expect(item).toMatchObject({ assignee: null, onward: { count: 0, latest: null }, priority: 'normal', needsAttention: false });
    await expectDbError(
      db.query(`update saferide.partner_referrals set assignee_user_id = $2 where id = $1`, [state.urgent.referralId, state.caseworker.userId]),
      /frozen/,
    );
    expect((await partner(state.caseworker, 'GET', '/summary')).json()).toMatchObject({ mine: 0 });
  });

  it('does the same on an operator revocation, and deleting a case takes everything with it', async () => {
    await partner(state.admin, 'POST', `/referrals/${state.normal.referralId}/onward`, { type: 'legal_aid', note: 'Synthetic legal aid note' });
    await db.query(`update saferide.partner_referrals set access_revoked_at = now(), revoke_reason = 'operator' where id = $1`, [state.normal.referralId]);
    for (const table of ['partner_onward_referrals', 'partner_case_activity']) {
      expect((await db.query(`select 1 from saferide.${table} where referral_id = $1`, [state.normal.referralId])).rows, table).toHaveLength(0);
    }
    expect((await db.query(`select assignee_user_id from saferide.partner_referrals where id = $1`, [state.normal.referralId])).rows[0])
      .toEqual({ assignee_user_id: null });

    const assigned = await partner(state.admin, 'POST', `/referrals/${state.doomed.referralId}/assign`, {
      assigneeId: state.admin.userId, expectedAssigneeId: null,
    });
    expect(assigned.statusCode).toBe(200);
    await partner(state.admin, 'POST', `/referrals/${state.doomed.referralId}/onward`, { type: 'child_protection' });
    await db.query(`delete from saferide.cases where id = $1`, [state.doomed.caseId]);
    for (const table of ['partner_referrals', 'partner_onward_referrals', 'partner_case_activity']) {
      const column = table === 'partner_referrals' ? 'id' : 'referral_id';
      expect((await db.query(`select 1 from saferide.${table} where ${column} = $1`, [state.doomed.referralId])).rows, table).toHaveLength(0);
    }
  });

  it('refuses control characters in partner text with an audited 400, never a 503', async () => {
    const before = (await auditRows(state.admin.userId)).length;
    const target = state.theirs.referralId; // any id: validation runs before the lookup
    for (const body of [
      { type: 'police', note: 'Synthetic\u0000note' },
      { type: 'police', organisation: 'Synthetic\u0007station' },
      { type: 'police', externalReference: 'OB\u001b[31m' },
    ]) {
      const refused = await partner(state.admin, 'POST', `/referrals/${target}/onward`, body);
      expect(refused.statusCode).toBe(400);
    }
    const note = await partner(state.admin, 'POST', `/referrals/${target}/notes`, { body: 'Synthetic\u0000note' });
    expect(note.statusCode).toBe(400);
    const rows = (await auditRows(state.admin.userId)).slice(before);
    expect(rows.map(row => `${row.action} ${row.outcome}`)).toEqual([
      'partner.onward.create denied', 'partner.onward.create denied', 'partner.onward.create denied', 'partner.referral.note denied',
    ]);
  });

  it('releases a disabled or reset user’s referrals, and treats any inactive assignee as nobody', async () => {
    const leaver = await partnerUser(state.orgId, 'cm-leaver', 'partner_caseworker', 'Synthetic leaver (caseworker)');
    const resetee = await partnerUser(state.orgId, 'cm-resetee', 'partner_caseworker', 'Synthetic resetee (caseworker)');
    const legacy = await partnerUser(state.orgId, 'cm-legacy', 'partner_caseworker', 'Synthetic legacy leaver');
    const ra = await route(state.orgId, state.orgStableId, 'escalate');
    const rb = await route(state.orgId, state.orgStableId, 'escalate');
    const rc = await route(state.orgId, state.orgStableId, 'escalate');
    for (const [target, who] of [[ra, leaver], [rb, resetee], [rc, legacy]] as const) {
      const assigned = await partner(state.admin, 'POST', `/referrals/${target.referralId}/assign`, { assigneeId: who.userId, expectedAssigneeId: null });
      expect(assigned.statusCode).toBe(200);
    }
    expect((await partner(state.admin, 'GET', '/summary')).json()).toMatchObject({ needsAttention: 3, unassigned: 0 });

    // A user made inactive without releasing (a row from before this fix): shown, filtered and counted as unassigned.
    await db.query(`update saferide.partner_users set status = 'disabled', disabled_at = now() where id = $1`, [legacy.userId]);
    const item = (await partner(state.admin, 'GET', '/referrals?priority=urgent')).json().referrals
      .find((entry: { id: string }) => entry.id === rc.referralId);
    expect(item).toMatchObject({ assignee: null, needsAttention: true });
    expect(ids(await partner(state.admin, 'GET', '/referrals?assignee=unassigned'))).toEqual([rc.referralId]);
    expect(ids(await partner(state.admin, 'GET', `/referrals?assignee=${legacy.userId}`))).toEqual([]);
    expect((await partner(state.admin, 'GET', '/summary')).json()).toMatchObject({ unassigned: 1 });
    const detail = await partner(state.admin, 'GET', `/referrals/${rc.referralId}`);
    expect(detail.json().referral.assignee).toBeNull();
    // Shown as unassigned, so it can be taken with expectedAssigneeId null.
    const taken = await partner(state.admin, 'POST', `/referrals/${rc.referralId}/assign`, { assigneeId: state.admin.userId, expectedAssigneeId: null });
    expect(taken.statusCode).toBe(200);

    // Disabling or resetting through the operator path releases the referrals, recorded as SafeRide.
    const operator = `cm-ops-${run}`;
    await db.query(
      `insert into saferide.partner_operators (handle, display_name, role_label) values ($1, 'Synthetic operator', 'Synthetic test')`,
      [operator],
    );
    const context = { operatorRef: operator, requestId: `cm-${randomUUID()}` };
    const disabled = await disablePartnerUser({ email: `cm-leaver-${run}@example.invalid`, context });
    expect(disabled.releasedAssignments).toBe(1);
    const reset = await resetPartnerUserEnrollment({
      email: `cm-resetee-${run}@example.invalid`, enrollmentTokenHash: randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', ''),
      enrollmentExpiresAt: new Date(Date.now() + 3_600_000), context,
    });
    expect(reset.releasedAssignments).toBe(1);
    for (const target of [ra, rb]) {
      const stored = await db.query(`select assignee_user_id from saferide.partner_referrals where id = $1`, [target.referralId]);
      expect(stored.rows[0]).toEqual({ assignee_user_id: null });
      const timeline = (await partner(state.admin, 'GET', `/referrals/${target.referralId}`)).json().timeline;
      expect(timeline.at(-1)).toEqual({ event: 'unassigned', status: null, at: expect.any(String), actor: { id: 'saferide', name: 'SafeRide' } });
    }
    expect((await partner(state.admin, 'GET', '/summary')).json()).toMatchObject({ needsAttention: 3, unassigned: 2, mine: 1 });
    expect(ids(await partner(state.admin, 'GET', '/referrals?assignee=unassigned')).sort()).toEqual([ra.referralId, rb.referralId].sort());
    // The survivor sees none of it.
    for (const target of [ra, rb, rc]) {
      expect((await survivorEvents(target)).events.map(event => event.event_type)).toEqual(['partner_routed']);
    }
  });

  it('keeps every table that references a referral under the partner_access deletion scope', async () => {
    const { rows } = await db.query<{ table_name: string }>(
      `select distinct child.relname as table_name
       from pg_constraint fk
       join pg_class child on child.oid = fk.conrelid
       join pg_class parent on parent.oid = fk.confrelid
       join pg_namespace ns on ns.oid = parent.relnamespace
       where fk.contype = 'f' and ns.nspname = 'saferide' and parent.relname = 'partner_referrals'
       order by 1`,
    );
    const scope: readonly string[] = PARTNER_ACCESS_DELETION_SCOPE.tables;
    for (const row of rows) expect(scope, row.table_name).toContain(row.table_name);
    expect(rows.map(row => row.table_name)).toEqual(expect.arrayContaining(['partner_onward_referrals', 'partner_case_activity']));
  });
});

describe.skipIf(!enabled)('synthetic demo referrals for test-partner (PostgreSQL)', () => {
  it('seeds an urgent new escalation, an assigned in-progress case with a police onward referral, and an unassigned referral', async () => {
    const orgId = await createOrg('test-partner');
    await db.query(
      `insert into saferide.partner_users (org_id, email, display_name, role)
       values ($1, 'partner.caseworker@example.invalid', 'Synthetic caseworker (test)', 'partner_caseworker')
       on conflict (email) do nothing`,
      [orgId],
    );
    await expect(seedPartnerDemoCases({ orgId: state.orgId || randomUUID() })).rejects.toThrow(/test-partner/);
    const first = await seedPartnerDemoCases({ orgId });
    expect([...first.created, ...first.existing].sort()).toEqual(['assigned-in-progress', 'unassigned-referral', 'urgent-new']);

    // Once the caseworker has enrolled (active), a second run puts someone in charge and creates nothing new.
    await db.query(
      `update saferide.partner_users set status = 'active', password_hash = 'scrypt$synthetic-test-hash', totp_secret_enc = $2,
         totp_enrolled_at = now()
       where email = 'partner.caseworker@example.invalid' and org_id = $1 and status = 'invited'`,
      [orgId, SEALED_PLACEHOLDER],
    );
    const second = await seedPartnerDemoCases({ orgId });
    expect(second.created).toEqual([]);
    expect(['assigned', 'already_assigned']).toContain(second.assignment);

    const token = generatePartnerToken('session');
    const user = await db.query<{ id: string }>(`select id from saferide.partner_users where email = 'partner.caseworker@example.invalid'`);
    await db.query(
      `insert into saferide.partner_sessions (token_hash, user_id, org_id, mfa_verified, idle_expires_at, absolute_expires_at)
       values ($1, $2, $3, true, now() + interval '30 minutes', now() + interval '11 hours')`,
      [hashPartnerToken(token), user.rows[0].id, orgId],
    );
    const who = { userId: user.rows[0].id, token };
    const demo = await db.query<{ id: string; key: string }>(
      `select r.id, c.summary->>'syntheticDemo' as key from saferide.partner_referrals r
       join saferide.cases c on c.id = r.case_id where r.org_id = $1 and c.summary ? 'syntheticDemo'`,
      [orgId],
    );
    const byKey = Object.fromEntries(demo.rows.map(row => [row.key, row.id]));
    expect(Object.keys(byKey).sort()).toEqual(['assigned-in-progress', 'unassigned-referral', 'urgent-new']);

    const items = new Map((await partner(who, 'GET', '/referrals?limit=100')).json().referrals.map((item: { id: string }) => [item.id, item]));
    expect(items.get(byKey['urgent-new'])).toMatchObject({ status: 'new', priority: 'urgent', needsAttention: true, assignee: null });
    expect(items.get(byKey['unassigned-referral'])).toMatchObject({ status: 'new', pathway: 'referral', priority: 'normal', assignee: null });
    const inProgress = items.get(byKey['assigned-in-progress']) as Record<string, unknown>;
    expect(inProgress).toMatchObject({
      status: 'in_progress', priority: 'urgent', needsAttention: false, onward: { count: 1, latest: { type: 'police', status: 'accepted' } },
    });
    expect(inProgress.assignee).not.toBeNull();
    const detail = (await partner(who, 'GET', `/referrals/${byKey['assigned-in-progress']}`)).json();
    expect(detail.view.kind).toBe('escalation');
    expect(detail.onwardReferrals).toEqual([expect.objectContaining({ type: 'police', status: 'accepted', externalReference: 'OB 00/00/2026 (synthetic)' })]);
    expect(detail.timeline.map((entry: { event: string }) => entry.event)).toEqual(expect.arrayContaining([
      'received', 'acknowledged', 'assigned', 'status_change', 'onward_created', 'onward_status',
    ]));
  });
});
