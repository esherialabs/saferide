/**
 * Runs against a real, disposable PostgreSQL that already has migrations
 * 000-008, 010, 011 and runtime-role.sql applied (the selfhost init path). Skipped
 * unless SAFERIDE_TEST_DATABASE_URL is set. Synthetic data only.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, describe, expect, it, vi } from 'vitest';

import { closeDb, pool, query } from '../../plugins/db.js';
import { deriveCallbackSealKey, openPartnerCallback, sealPartnerCallback } from '../../services/partnerCallbackSeal.js';
import { generatePartnerReference } from '../../services/partnerTokens.js';
import { CaseSubmissionConflictError, PartnerRoutingRejectedError, submitCaseTransaction } from '../caseRepository.js';
import { findPartnerOrgOpenForIntake } from '../partnerRepository.js';

vi.mock('../../config/env.js', () => ({
  env: { databaseUrl: process.env.SAFERIDE_TEST_DATABASE_URL ?? 'postgres://unused.invalid/none' },
}));

const enabled = Boolean(process.env.SAFERIDE_TEST_DATABASE_URL);
const run = randomUUID().slice(0, 8);
/** Shape-valid sealed value (v1.<iv>.<tag>.<ciphertext>) for rows whose content is not under test. */
const SEALED_PLACEHOLDER = `v1.${'A'.repeat(16)}.${'B'.repeat(22)}.${'C'.repeat(27)}`;

async function expectDbError(statement: Promise<unknown>, pattern: RegExp): Promise<void> {
  await expect(statement).rejects.toThrow(pattern);
}

/** An org open for intake (migration 007 checks intake on every referral insert). */
async function syntheticOrg(label: string): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `insert into saferide.partner_organizations (
       stable_id, display_name, intake_enabled, agreement_ref, agreement_signed_at, agreement_expires_at
     ) values ($1, 'Synthetic org', true, 'SYNTHETIC-TEST', now() - interval '1 day', now() + interval '30 days')
     returning id`,
    [`test-${label}-${run}`],
  );
  return rows[0].id;
}

async function syntheticUser(orgId: string, label: string): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `insert into saferide.partner_users (
       org_id, email, display_name, role, status, password_hash, totp_secret_enc, totp_enrolled_at
     ) values ($1, $2, 'Synthetic user', 'partner_caseworker', 'active',
       'scrypt$synthetic-test-hash', $3, now())
     returning id`,
    [orgId, `${label}-${run}@example.invalid`, SEALED_PLACEHOLDER],
  );
  return rows[0].id;
}

async function grantConsent(ownerId: string, purpose: string): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `insert into saferide.consent_records (owner_id, purpose, consent_version, status, granted_at)
     values ($1, $2, 'synthetic-test.v1', 'granted', now()) returning id`,
    [ownerId, purpose],
  );
  return rows[0].id;
}

async function syntheticCase(ownerId: string): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `insert into saferide.cases (owner_id, pathway, status) values ($1, 'referral', 'submitted') returning id`,
    [ownerId],
  );
  return rows[0].id;
}

function insertReferral(params: { caseId: string; ownerId: string; orgId: string; consentId: string }) {
  return query<{ id: string }>(
    `insert into saferide.partner_referrals (case_id, owner_id, org_id, consent_record_id, reference)
     values ($1, $2, $3, $4, $5) returning id`,
    [params.caseId, params.ownerId, params.orgId, params.consentId, generatePartnerReference()],
  );
}

const FOLLOW_UP_VERSION = 'partner-follow-up.synthetic-test.v1';
const CALLBACK_VERSION = 'partner-callback.synthetic-test.v1';
const callbackKey = deriveCallbackSealKey(Buffer.alloc(32, 7));

async function intakeOrg(label: string, intakeEnabled = true): Promise<{ id: string; stableId: string }> {
  const stableId = `test-${label}-${run}`;
  const { rows } = await query<{ id: string }>(
    `insert into saferide.partner_organizations (
       stable_id, display_name, intake_enabled, agreement_ref, agreement_signed_at, agreement_expires_at
     ) values ($1, 'Synthetic intake org', $2, 'SYNTHETIC-TEST', now() - interval '1 day', now() + interval '30 days')
     returning id`,
    [stableId, intakeEnabled],
  );
  return { id: rows[0].id, stableId };
}

async function grantVersioned(ownerId: string, purpose: string, version: string): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `insert into saferide.consent_records (owner_id, purpose, consent_version, status, granted_at)
     values ($1, $2, $3, 'granted', now()) returning id`,
    [ownerId, purpose, version],
  );
  return rows[0].id;
}

function submission(params: {
  ownerId: string;
  stableId: string;
  followUpId: string;
  callback?: { consentId: string; phoneNumber: string };
  pathwayConsentId?: string;
  sharedEvidence?: Array<{ manifestIndex: number; mediaType: 'photo' | 'video' | 'audio' | 'document'; sha256: string | null }>;
}) {
  const pathwayConsentId = params.pathwayConsentId ?? randomUUID();
  return {
    ownerId: params.ownerId,
    draftId: null,
    pathway: 'escalate',
    summary: { schemaVersion: '1.0', synthetic: true, partnerRouting: { partnerStableId: params.stableId, consentRecordId: params.followUpId } },
    lifecyclePayload: { schemaVersion: '1.0', workflowType: 'submitted-case', status: 'submitted' },
    consentRecordId: pathwayConsentId,
    consentPurpose: 'pathway_submission' as const,
    consentVersion: 'pathway-consent.v1',
    idempotencyKey: pathwayConsentId,
    requestId: `db-test-${randomUUID()}`,
    policyVersion: 'privacy-controls.2026-07-30.2',
    partnerRouting: {
      partnerStableId: params.stableId,
      consentRecordId: params.followUpId,
      consentVersion: FOLLOW_UP_VERSION,
      sharedEvidence: params.sharedEvidence ?? [],
      ...(params.callback ? {
        callback: {
          consentRecordId: params.callback.consentId,
          consentVersion: CALLBACK_VERSION,
          seal: (referralId: string) => sealPartnerCallback(callbackKey, referralId, params.callback!.phoneNumber),
        },
      } : {}),
    },
  };
}

async function rejection(promise: Promise<unknown>): Promise<string> {
  const error = await promise.catch(caught => caught);
  expect(error).toBeInstanceOf(PartnerRoutingRejectedError);
  return (error as PartnerRoutingRejectedError).reason;
}

afterAll(async () => {
  if (enabled) await closeDb();
});

describe.skipIf(!enabled)('routing a submitted case to a partner', () => {
  it('returns a committed case on a no-sharing retry and atomically withdraws the original partner access', async () => {
    const org = await intakeOrg('lost-response');
    const ownerId = randomUUID();
    const followUpId = await grantVersioned(ownerId, 'partner_follow_up', FOLLOW_UP_VERSION);
    const callbackId = await grantVersioned(ownerId, 'partner_callback', CALLBACK_VERSION);
    const input = submission({ ownerId, stableId: org.stableId, followUpId, callback: { consentId: callbackId, phoneNumber: '+254712345678' } });
    const first = await submitCaseTransaction(input);
    const { partnerRouting: _removed, ...retry } = input;
    const { partnerRouting: _summaryRemoved, ...summary } = input.summary;
    // A changed report must still conflict and must not withdraw anything.
    await expect(submitCaseTransaction({ ...retry, summary: { ...summary, changed: true } })).rejects.toBeInstanceOf(CaseSubmissionConflictError);
    expect((await query(`select status from saferide.consent_records where id = $1`, [followUpId])).rows[0].status).toBe('granted');
    const repeated = await submitCaseTransaction({ ...retry, summary });
    expect(repeated.caseRecord.id).toBe(first.caseRecord.id);
    expect(repeated.caseRecord.summary).toEqual(first.caseRecord.summary);
    expect(repeated.partnerReferral).toBeNull();
    expect((await query(`select status from saferide.consent_records where id = any($1::uuid[])`, [[followUpId, callbackId]])).rows.map(row => row.status)).toEqual(['withdrawn', 'withdrawn']);
    const referral = (await query(`select id, access_revoked_at from saferide.partner_referrals where case_id = $1`, [first.caseRecord.id])).rows;
    expect(referral).toHaveLength(1);
    expect(referral[0].access_revoked_at).not.toBeNull();
    expect((await query(`select 1 from saferide.partner_referral_callbacks where referral_id = $1`, [referral[0].id])).rows).toHaveLength(0);
    expect((await submitCaseTransaction({ ...retry, summary })).caseRecord.id).toBe(first.caseRecord.id);
  });

  it('routes a report sent with the phone-only draft id the app always sends, and retries it idempotently', async () => {
    const org = await intakeOrg('local-draft');
    const ownerId = randomUUID();
    const followUpId = await grantVersioned(ownerId, 'partner_follow_up', FOLLOW_UP_VERSION);
    const input = { ...submission({ ownerId, stableId: org.stableId, followUpId }), draftId: `local-draft-${randomUUID()}` };

    const first = await submitCaseTransaction(input);
    expect(first.caseRecord.draft_id).toBeNull();
    expect(first.partnerReferral).toMatchObject({ partnerStableId: org.stableId, status: 'new' });
    const retry = await submitCaseTransaction({ ...input, requestId: `db-test-${randomUUID()}` });
    expect(retry.caseRecord.id).toBe(first.caseRecord.id);
    expect(retry.partnerReferral?.reference).toBe(first.partnerReferral?.reference);
  });

  it('creates the referral, sealed callback and partner_routed event in the submission transaction, once', async () => {
    const org = await intakeOrg('route');
    const ownerId = randomUUID();
    const followUpId = await grantVersioned(ownerId, 'partner_follow_up', FOLLOW_UP_VERSION);
    const callbackConsentId = await grantVersioned(ownerId, 'partner_callback', CALLBACK_VERSION);
    const input = submission({
      ownerId, stableId: org.stableId, followUpId, callback: { consentId: callbackConsentId, phoneNumber: '+254712345678' },
      sharedEvidence: [
        { manifestIndex: 0, mediaType: 'photo', sha256: 'c'.repeat(64) },
        { manifestIndex: 1, mediaType: 'audio', sha256: null },
      ],
    });

    const first = await submitCaseTransaction(input);
    expect(first.partnerReferral).toMatchObject({ partnerStableId: org.stableId, status: 'new', callbackShared: true });
    const referral = await query<{ id: string; reference: string; org_id: string; consent_record_id: string }>(
      `select id, reference, org_id, consent_record_id from saferide.partner_referrals where case_id = $1`,
      [first.caseRecord.id],
    );
    expect(referral.rows).toHaveLength(1);
    expect(referral.rows[0]).toMatchObject({ org_id: org.id, consent_record_id: followUpId, reference: first.partnerReferral?.reference });
    const callback = await query<{ phone_enc: string }>(
      `select phone_enc from saferide.partner_referral_callbacks where referral_id = $1`,
      [referral.rows[0].id],
    );
    expect(callback.rows[0].phone_enc).not.toContain('712345678');
    expect(openPartnerCallback(callbackKey, referral.rows[0].id, callback.rows[0].phone_enc)).toBe('+254712345678');
    const shared = await query<{ manifest_index: number; media_type: string; sha256: string | null; org_id: string }>(
      `select manifest_index, media_type, sha256, org_id from saferide.partner_referral_evidence where referral_id = $1 order by manifest_index`,
      [referral.rows[0].id],
    );
    expect(shared.rows).toEqual([
      { manifest_index: 0, media_type: 'photo', sha256: 'c'.repeat(64), org_id: org.id },
      { manifest_index: 1, media_type: 'audio', sha256: null, org_id: org.id },
    ]);
    // Fixed at routing time: nobody (including the runtime role) can rewrite it.
    await expect(query(`update saferide.partner_referral_evidence set sha256 = $2 where referral_id = $1`, [referral.rows[0].id, 'd'.repeat(64)]))
      .rejects.toThrow(/append-only/);
    const client = await pool.connect();
    try {
      await client.query('begin');
      const role = await client.query(`select 1 from pg_roles where rolname = 'saferide_api'`);
      if (role.rows.length === 1) {
        await client.query('set local role saferide_api');
        await expect(client.query(`update saferide.partner_referral_evidence set sha256 = null where false`)).rejects.toThrow(/permission denied/);
      }
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
    }

    const retry = await submitCaseTransaction({ ...input, requestId: `db-test-${randomUUID()}` });
    expect(retry.caseRecord.id).toBe(first.caseRecord.id);
    expect(retry.partnerReferral?.reference).toBe(first.partnerReferral?.reference);
    const events = await query<{ event_type: string; payload: Record<string, unknown> }>(
      `select event_type, payload from saferide.case_events where case_id = $1 order by created_at`,
      [first.caseRecord.id],
    );
    expect(events.rows.map(row => row.event_type)).toEqual(['submission', 'partner_routed']);
    expect(events.rows[1].payload).toEqual({
      schemaVersion: '1.0', partner: org.stableId, reference: first.partnerReferral?.reference, partner_status: 'new', callback_shared: true,
    });
    const audits = await query(`select 1 from saferide.audit_events where action = 'case.partner_route' and request_id = $1`, [input.requestId]);
    expect(audits.rows).toHaveLength(1);
  });

  it('holds the org row FOR SHARE while routing, so intake cannot be switched off underneath it', async () => {
    const org = await intakeOrg('lock');
    const routing = await pool.connect();
    const operator = await pool.connect();
    try {
      await routing.query('begin');
      expect(await findPartnerOrgOpenForIntake(org.stableId, routing, { lockForShare: true })).toMatchObject({ id: org.id });
      await operator.query('begin');
      await operator.query(`set local lock_timeout = '300ms'`);
      await expect(operator.query(`update saferide.partner_organizations set intake_enabled = false where id = $1`, [org.id]))
        .rejects.toThrow(/lock timeout/);
    } finally {
      await operator.query('rollback').catch(() => undefined);
      await routing.query('rollback').catch(() => undefined);
      operator.release();
      routing.release();
    }
  });

  it('rejects and writes nothing when the org is not taking intake or a consent is missing, withdrawn, stale or reused', async () => {
    const closed = await intakeOrg('closed', false);
    const open = await intakeOrg('open');
    const ownerId = randomUUID();
    const countCases = async () => Number((await query<{ count: string }>(
      `select count(*)::text as count from saferide.cases where owner_id = $1`, [ownerId],
    )).rows[0].count);

    const followUpId = await grantVersioned(ownerId, 'partner_follow_up', FOLLOW_UP_VERSION);
    expect(await rejection(submitCaseTransaction(submission({ ownerId, stableId: closed.stableId, followUpId })))).toBe('partner_not_accepting');
    expect(await rejection(submitCaseTransaction(submission({ ownerId, stableId: `test-missing-${run}`, followUpId })))).toBe('partner_not_accepting');

    const stale = await grantVersioned(ownerId, 'partner_follow_up', 'partner-follow-up.superseded.v0');
    expect(await rejection(submitCaseTransaction(submission({ ownerId, stableId: open.stableId, followUpId: stale })))).toBe('partner_consent_missing');
    const wrongPurpose = await grantVersioned(ownerId, 'partner_callback', FOLLOW_UP_VERSION);
    expect(await rejection(submitCaseTransaction(submission({ ownerId, stableId: open.stableId, followUpId: wrongPurpose })))).toBe('partner_consent_missing');
    const someoneElses = await grantVersioned(randomUUID(), 'partner_follow_up', FOLLOW_UP_VERSION);
    expect(await rejection(submitCaseTransaction(submission({ ownerId, stableId: open.stableId, followUpId: someoneElses })))).toBe('partner_consent_missing');
    const withdrawn = await grantVersioned(ownerId, 'partner_follow_up', FOLLOW_UP_VERSION);
    await query(`update saferide.consent_records set status = 'withdrawn', withdrawn_at = now() where id = $1`, [withdrawn]);
    expect(await rejection(submitCaseTransaction(submission({ ownerId, stableId: open.stableId, followUpId: withdrawn })))).toBe('partner_consent_missing');
    expect(await rejection(submitCaseTransaction(submission({
      ownerId, stableId: open.stableId, followUpId, callback: { consentId: randomUUID(), phoneNumber: '+254712345678' },
    })))).toBe('callback_consent_missing');
    expect(await countCases()).toBe(0);

    await submitCaseTransaction(submission({ ownerId, stableId: open.stableId, followUpId }));
    expect(await rejection(submitCaseTransaction(submission({ ownerId, stableId: open.stableId, followUpId })))).toBe('partner_consent_missing');
    expect(await countCases()).toBe(1);
  });
});

describe.skipIf(!enabled)('routing invariants from 007 and partner retention from 008', () => {

  it('is recorded as applied', async () => {
    const version = await query(`select 1 from saferide.schema_migrations where version = '008'`);
    expect(version.rows).toHaveLength(1);
  });

  it('lets one partner_follow_up consent route exactly one report', async () => {
    const orgId = await syntheticOrg('per-report');
    const ownerId = randomUUID();
    const consentId = await grantConsent(ownerId, 'partner_follow_up');
    await insertReferral({ caseId: await syntheticCase(ownerId), ownerId, orgId, consentId });
    await expectDbError(
      insertReferral({ caseId: await syntheticCase(ownerId), ownerId, orgId, consentId }),
      /partner_referrals_consent_record_id_key/,
    );
  });

  it('revokes the referral, deletes its notes and callback and tells the survivor when partner_follow_up is withdrawn', async () => {
    const orgId = await syntheticOrg('withdrawal');
    const author = await syntheticUser(orgId, 'withdrawal-author');
    const ownerId = randomUUID();
    const followUp = await grantConsent(ownerId, 'partner_follow_up');
    const callbackConsent = await grantConsent(ownerId, 'partner_callback');
    const keptConsent = await grantConsent(ownerId, 'partner_follow_up');
    const referralCase = await syntheticCase(ownerId);
    const keptCase = await syntheticCase(ownerId);
    const referral = (await insertReferral({ caseId: referralCase, ownerId, orgId, consentId: followUp })).rows[0].id;
    const kept = (await insertReferral({ caseId: keptCase, ownerId, orgId, consentId: keptConsent })).rows[0].id;
    // As if the partner had acknowledged both.
    await query(`update saferide.cases set status = 'in_review' where id = any($1)`, [[referralCase, keptCase]]);
    for (const id of [referral, kept]) {
      await query(
        `insert into saferide.partner_case_notes (referral_id, org_id, author_user_id, body) values ($1, $2, $3, 'Synthetic note')`,
        [id, orgId, author],
      );
    }
    await query(
      `insert into saferide.partner_referral_callbacks (referral_id, org_id, owner_id, consent_record_id, phone_enc)
       values ($1, $2, $3, $4, $5)`,
      [referral, orgId, ownerId, callbackConsent, SEALED_PLACEHOLDER],
    );

    const client = await pool.connect();
    try {
      // The runtime role withdraws through the same single UPDATE as routes/privacy.ts.
      await client.query('begin');
      const role = await client.query(`select 1 from pg_roles where rolname = 'saferide_api'`);
      if (role.rows.length === 1) await client.query('set local role saferide_api');
      await client.query(
        `update saferide.consent_records set status = 'withdrawn', withdrawn_at = now() where owner_id = $1 and id = $2`,
        [ownerId, followUp],
      );
      await client.query('commit');
    } finally {
      client.release();
    }

    const after = await query<{ id: string; access_revoked_at: Date | null; revoke_reason: string | null }>(
      `select id, access_revoked_at, revoke_reason from saferide.partner_referrals where id = any($1) order by id = $2 desc`,
      [[referral, kept], referral],
    );
    expect(after.rows[0]).toMatchObject({ id: referral, revoke_reason: 'consent_withdrawn' });
    expect(after.rows[0].access_revoked_at).not.toBeNull();
    expect(after.rows[1]).toMatchObject({ id: kept, access_revoked_at: null, revoke_reason: null });
    const notes = await query<{ referral_id: string }>(
      `select referral_id from saferide.partner_case_notes where referral_id = any($1)`,
      [[referral, kept]],
    );
    expect(notes.rows.map(row => row.referral_id)).toEqual([kept]);
    const callbacks = await query(`select 1 from saferide.partner_referral_callbacks where referral_id = $1`, [referral]);
    expect(callbacks.rows).toHaveLength(0);

    // Migration 011: the survivor's case goes back to submitted with one content-free event.
    const survivorEvents = () => query<{ case_id: string; payload: Record<string, unknown>; request_id: string | null }>(
      `select case_id, payload, request_id from saferide.case_events where case_id = any($1) and event_type = 'status_change'`,
      [[referralCase, keptCase]],
    );
    const ended = {
      case_id: referralCase, request_id: null,
      payload: {
        schemaVersion: '1.0', new_status: 'submitted', actor: 'survivor', partner: `test-withdrawal-${run}`,
        partner_status: 'new', partner_access: 'ended',
      },
    };
    expect((await survivorEvents()).rows).toEqual([ended]);
    const statuses = await query<{ id: string; status: string }>(
      `select id, status::text as status from saferide.cases where id = any($1)`, [[referralCase, keptCase]],
    );
    expect(Object.fromEntries(statuses.rows.map(row => [row.id, row.status]))).toEqual({ [referralCase]: 'submitted', [keptCase]: 'in_review' });

    // Withdrawing again changes nothing (no second event), and the tombstone stays frozen.
    await query(`update saferide.consent_records set status = 'withdrawn' where id = $1`, [followUp]);
    expect((await survivorEvents()).rows).toEqual([ended]);
    await expectDbError(
      query(`update saferide.partner_referrals set status = 'acknowledged' where id = $1`, [referral]),
      /frozen/,
    );
  });

  it('records the owner-authorized engineering retention policies and partner_access deletion class', async () => {
    const policies = await query<{ policy_id: string; duration_days: number; approval_status: string; execution_enabled: boolean }>(
      `select policy_id, duration_days, approval_status, execution_enabled from saferide.retention_policies
       where policy_id like 'partner-%' order by policy_id`,
    );
    expect(policies.rows).toEqual([
      { policy_id: 'partner-access-after-close-v1', duration_days: 90, approval_status: 'approved_engineering', execution_enabled: true },
      { policy_id: 'partner-audit-v1', duration_days: 730, approval_status: 'approved_engineering', execution_enabled: true },
    ]);
    const dsar = await query<{ id: string }>(
      `insert into saferide.dsar_requests (owner_id, request_type, status, request_idempotency_key, due_at)
       values ($1, 'deletion', 'requested', $2, now() + interval '1 day') returning id`,
      [randomUUID(), randomUUID()],
    );
    await query(
      `insert into saferide.deletion_targets (dsar_request_id, target_class, status) values ($1, 'partner_access', 'pending')`,
      [dsar.rows[0].id],
    );
    await expectDbError(
      query(`insert into saferide.deletion_targets (dsar_request_id, target_class, status) values ($1, 'partner_notes', 'pending')`, [dsar.rows[0].id]),
      /deletion_targets_target_class_check/,
    );
  });
});
