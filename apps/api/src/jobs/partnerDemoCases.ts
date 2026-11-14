/**
 * Synthetic demo referrals for the `test-partner` organisation, run by the
 * dev/test seed (jobs/partnerSyntheticSeed.ts) only: that job refuses
 * NODE_ENV=production and any APP_ENV other than an explicit `test` or
 * `development`, and this module refuses any other organisation.
 *
 * Three referrals, so the dashboard and its end-to-end tests have data:
 *   urgent-new            an escalation still `new` and unassigned (needs attention)
 *   assigned-in-progress  an escalation, acknowledged and in progress, in the
 *                         hands of an active test-partner user, with a police
 *                         onward referral made and then accepted
 *   unassigned-referral   a referral (normal priority), `new`, nobody in charge
 *
 * Every survivor is a random id with no account, and every text is
 * invented. Idempotent: a demo referral is found by its `syntheticDemo`
 * marker in the case summary and created once. Users start invited, and only
 * an active user can be put in charge, so on a fresh seed the second
 * referral stays unassigned; run the seed again once a test-partner user has
 * enrolled and it is assigned to them.
 */
import { randomUUID } from 'node:crypto';

import type { PoolClient } from 'pg';

import { query } from '../plugins/db.js';
import { withPartnerTransaction } from '../repositories/partnerRepository.js';
import { generatePartnerReference } from '../services/partnerTokens.js';

export const DEMO_ORG_STABLE_ID = 'test-partner';
export const DEMO_CASE_KEYS = ['urgent-new', 'assigned-in-progress', 'unassigned-referral'] as const;
export type DemoCaseKey = (typeof DEMO_CASE_KEYS)[number];
const DEMO_CONSENT_VERSION = 'partner-follow-up.test-partner.synthetic-demo';
const HOUR_MS = 60 * 60 * 1000;

export type DemoSeedResult = {
  created: DemoCaseKey[];
  existing: DemoCaseKey[];
  /** The assigned-in-progress referral's assignee, or why it has none yet. */
  assignment: 'assigned' | 'already_assigned' | 'no_active_user';
};

export function demoEscalationWorkflow(generatedAt: string, variant: 'urgent' | 'in_progress'): Record<string, unknown> {
  return {
    schemaVersion: '1.0',
    workflowType: 'submitted-case',
    pathway: 'escalation',
    submission: {
      schemaVersion: '1.0',
      workflowType: 'escalation',
      packet: {
        version: '1.0',
        generatedAt,
        pathway: 'escalate',
        redactionLevel: 'light',
        contact: variant === 'urgent'
          ? { preference: 'alias', alias: 'Synthetic alias A', label: 'Alias chosen by the survivor (synthetic)' }
          : { preference: 'none', label: 'No contact identity included' },
        content: {
          timeRange: variant === 'urgent' ? 'Synthetic: this evening, about 19:00' : 'Synthetic: yesterday morning',
          location: 'Synthetic stage | public_transport',
          incidentDescription: variant === 'urgent'
            ? 'SYNTHETIC DEMO ONLY. An invented incident on a matatu for testing the partner dashboard.'
            : 'SYNTHETIC DEMO ONLY. An invented incident at a bus stage for testing the partner dashboard.',
          statement: '[redacted]',
          tags: ['harassment'],
          patterns: [],
          transportIdentifiers: [],
        },
        evidenceManifest: [],
        redaction: { appliedLabels: ['names'], textFields: ['statement'], evidenceMetadata: 'redacted', mediaProcessing: [] },
      },
    },
  };
}

export function demoReferralWorkflow(): Record<string, unknown> {
  return {
    schemaVersion: '1.0',
    workflowType: 'referral',
    providerId: DEMO_ORG_STABLE_ID,
    channel: 'whatsapp',
    supportBrief: {
      included: true,
      selectedFields: ['incident_categories', 'ongoing_status'],
      incidentCategories: ['harassment'],
      isOngoing: false,
    },
  };
}

type DemoUsers = { actorId: string; assigneeId: string | null };

async function demoUsers(client: PoolClient, orgId: string): Promise<DemoUsers | null> {
  // The seeded caseworker acts in the demo history; an active user (the
  // caseworker first) is put in charge.
  const { rows } = await client.query<{ id: string; email: string; status: string }>(
    `select id, email, status from saferide.partner_users
     where org_id = $1 and status <> 'disabled'
     order by (email = 'partner.caseworker@example.invalid') desc, (status = 'active') desc, created_at asc, id asc`,
    [orgId],
  );
  if (rows.length === 0) return null;
  const active = rows.find(row => row.status === 'active');
  return { actorId: rows[0].id, assigneeId: active?.id ?? null };
}

async function findDemoReferral(client: PoolClient, orgId: string, key: DemoCaseKey) {
  const { rows } = await client.query<{ id: string; assignee_user_id: string | null }>(
    `select r.id, r.assignee_user_id
     from saferide.partner_referrals r
     join saferide.cases c on c.id = r.case_id and c.owner_id = r.owner_id
     where r.org_id = $1 and r.access_revoked_at is null and c.summary->>'syntheticDemo' = $2
     order by r.created_at asc limit 1`,
    [orgId, key],
  );
  return rows[0] ?? null;
}

/** Routes one synthetic case to the org as the API would (consent, case, referral, routing event). */
async function routeDemoCase(
  client: PoolClient,
  params: { orgId: string; key: DemoCaseKey; pathway: 'escalate' | 'referral'; workflow: Record<string, unknown>; receivedAt: Date },
): Promise<{ referralId: string; caseId: string; ownerId: string }> {
  const ownerId = randomUUID();
  const consent = await client.query<{ id: string }>(
    `insert into saferide.consent_records (owner_id, purpose, consent_version, status, granted_at)
     values ($1, 'partner_follow_up', $2, 'granted', $3) returning id`,
    [ownerId, DEMO_CONSENT_VERSION, params.receivedAt],
  );
  const created = await client.query<{ id: string }>(
    `insert into saferide.cases (owner_id, pathway, status, summary, created_at)
     values ($1, $2, 'submitted', $3, $4) returning id`,
    [ownerId, params.pathway, { workflow: params.workflow, syntheticDemo: params.key }, params.receivedAt],
  );
  const caseId = created.rows[0].id;
  const reference = generatePartnerReference();
  const referral = await client.query<{ id: string }>(
    `insert into saferide.partner_referrals (case_id, owner_id, org_id, consent_record_id, reference, created_at, status_changed_at)
     values ($1, $2, $3, $4, $5, $6, $6) returning id`,
    [caseId, ownerId, params.orgId, consent.rows[0].id, reference, params.receivedAt],
  );
  await client.query(
    `insert into saferide.case_events (case_id, owner_id, event_type, payload, created_at)
     values ($1, $2, 'partner_routed', $3, $4)`,
    [
      caseId, ownerId,
      { schemaVersion: '1.0', partner: DEMO_ORG_STABLE_ID, reference, partner_status: 'new', callback_shared: false },
      params.receivedAt,
    ],
  );
  return { referralId: referral.rows[0].id, caseId, ownerId };
}

/** A partner status move as the API makes it: referral, survivor case status and a content-free event. */
async function moveDemoStatus(
  client: PoolClient,
  target: { referralId: string; caseId: string; ownerId: string },
  to: 'acknowledged' | 'in_progress',
  at: Date,
): Promise<void> {
  await client.query(`update saferide.partner_referrals set status = $2 where id = $1`, [target.referralId, to]);
  await client.query(`update saferide.cases set status = 'in_review' where id = $1 and owner_id = $2`, [target.caseId, target.ownerId]);
  await client.query(
    `insert into saferide.case_events (case_id, owner_id, event_type, payload, created_at)
     values ($1, $2, 'status_change', $3, $4)`,
    [
      target.caseId, target.ownerId,
      { schemaVersion: '1.0', new_status: 'in_review', actor: 'partner', partner: DEMO_ORG_STABLE_ID, partner_status: to },
      at,
    ],
  );
}

async function assignDemo(client: PoolClient, orgId: string, referralId: string, assigneeId: string, actorId: string, at: Date) {
  await client.query(`update saferide.partner_referrals set assignee_user_id = $2 where id = $1`, [referralId, assigneeId]);
  await client.query(
    `insert into saferide.partner_case_activity (referral_id, org_id, actor_user_id, kind, assignee_user_id, created_at)
     values ($1, $2, $3, 'assigned', $4, $5)`,
    [referralId, orgId, actorId, assigneeId, at],
  );
}

/**
 * Creates the missing demo referrals for `test-partner` and assigns the
 * in-progress one when an active user exists. `orgId` must be test-partner's.
 */
export async function seedPartnerDemoCases(params: { orgId: string; now?: Date }): Promise<DemoSeedResult> {
  const { rows: org } = await query<{ stable_id: string }>(
    `select stable_id from saferide.partner_organizations where id = $1`,
    [params.orgId],
  );
  if (org[0]?.stable_id !== DEMO_ORG_STABLE_ID) {
    throw new Error('Demo referrals are only ever seeded for the synthetic test-partner organisation');
  }
  const now = params.now ?? new Date();
  const created: DemoCaseKey[] = [];
  const existing: DemoCaseKey[] = [];
  let assignment: DemoSeedResult['assignment'] = 'no_active_user';

  await withPartnerTransaction(async client => {
    const users = await demoUsers(client, params.orgId);
    if (!users) throw new Error('Seed the test-partner users before the demo referrals');

    if (await findDemoReferral(client, params.orgId, 'urgent-new')) {
      existing.push('urgent-new');
    } else {
      await routeDemoCase(client, {
        orgId: params.orgId, key: 'urgent-new', pathway: 'escalate',
        workflow: demoEscalationWorkflow(new Date(now.getTime() - 0.25 * HOUR_MS).toISOString(), 'urgent'),
        receivedAt: new Date(now.getTime() - 0.2 * HOUR_MS),
      });
      created.push('urgent-new');
    }

    const inProgress = await findDemoReferral(client, params.orgId, 'assigned-in-progress');
    if (inProgress) {
      existing.push('assigned-in-progress');
      if (inProgress.assignee_user_id) {
        assignment = 'already_assigned';
      } else if (users.assigneeId) {
        await assignDemo(client, params.orgId, inProgress.id, users.assigneeId, users.actorId, now);
        assignment = 'assigned';
      }
    } else {
      const receivedAt = new Date(now.getTime() - 26 * HOUR_MS);
      const target = await routeDemoCase(client, {
        orgId: params.orgId, key: 'assigned-in-progress', pathway: 'escalate',
        workflow: demoEscalationWorkflow(new Date(receivedAt.getTime() - 0.1 * HOUR_MS).toISOString(), 'in_progress'),
        receivedAt,
      });
      const step = (hours: number) => new Date(receivedAt.getTime() + hours * HOUR_MS);
      await moveDemoStatus(client, target, 'acknowledged', step(0.2));
      await client.query(
        `insert into saferide.partner_case_activity (referral_id, org_id, actor_user_id, kind, created_at)
         values ($1, $2, $3, 'acknowledged', $4)`,
        [target.referralId, params.orgId, users.actorId, step(0.2)],
      );
      if (users.assigneeId) {
        await assignDemo(client, params.orgId, target.referralId, users.assigneeId, users.actorId, step(0.3));
        assignment = 'assigned';
      }
      await moveDemoStatus(client, target, 'in_progress', step(1));
      const onward = await client.query<{ id: string }>(
        `insert into saferide.partner_onward_referrals (
           referral_id, org_id, type, organisation, contact_role, external_reference, note, status,
           created_by, status_changed_by, created_at
         ) values ($1, $2, 'police', $3, $4, $5, $6, 'made', $7, $7, $8) returning id`,
        [
          target.referralId, params.orgId, 'Synthetic Central Police Station (test)', 'Gender desk officer (synthetic)',
          'OB 00/00/2026 (synthetic)', 'SYNTHETIC DEMO ONLY. Statement recorded at the gender desk.', users.actorId, step(2),
        ],
      );
      await client.query(
        `insert into saferide.partner_case_activity (
           referral_id, org_id, actor_user_id, kind, onward_id, onward_type, onward_status, created_at
         ) values ($1, $2, $3, 'onward_created', $4, 'police', 'made', $5)`,
        [target.referralId, params.orgId, users.actorId, onward.rows[0].id, step(2)],
      );
      await client.query(
        `update saferide.partner_onward_referrals set status = 'accepted', status_changed_by = $2 where id = $1`,
        [onward.rows[0].id, users.actorId],
      );
      // The status move stamps status_changed_at with the database clock; the activity matches it.
      await client.query(
        `insert into saferide.partner_case_activity (
           referral_id, org_id, actor_user_id, kind, onward_id, onward_type, onward_status, created_at
         ) values ($1, $2, $3, 'onward_status', $4, 'police', 'accepted', now())`,
        [target.referralId, params.orgId, users.actorId, onward.rows[0].id],
      );
      created.push('assigned-in-progress');
    }

    if (await findDemoReferral(client, params.orgId, 'unassigned-referral')) {
      existing.push('unassigned-referral');
    } else {
      await routeDemoCase(client, {
        orgId: params.orgId, key: 'unassigned-referral', pathway: 'referral',
        workflow: demoReferralWorkflow(),
        receivedAt: new Date(now.getTime() - 3 * HOUR_MS),
      });
      created.push('unassigned-referral');
    }
  });
  return { created, existing, assignment };
}
