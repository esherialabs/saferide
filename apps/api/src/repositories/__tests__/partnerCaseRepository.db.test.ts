/**
 * Runs against a real, disposable PostgreSQL with migrations 000-008 and
 * runtime-role.sql applied. Skipped unless SAFERIDE_TEST_DATABASE_URL is
 * set. Synthetic data only.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { closeDb, query } from '../../plugins/db.js';
import { generatePartnerReference } from '../../services/partnerTokens.js';
import { listCaseEvents, getCase } from '../caseRepository.js';
import {
  addPartnerReferralNote,
  getPartnerReferral,
  getPartnerReferralCallback,
  listPartnerReferralAttachments,
  listPartnerReferralNotes,
  listPartnerReferralTimeline,
  listPartnerReferrals,
  transitionPartnerReferral,
} from '../partnerCaseRepository.js';

vi.mock('../../config/env.js', () => ({
  env: { databaseUrl: process.env.SAFERIDE_TEST_DATABASE_URL ?? 'postgres://unused.invalid/none' },
}));

const enabled = Boolean(process.env.SAFERIDE_TEST_DATABASE_URL);
const run = randomUUID().slice(0, 8);
/** Shape-valid sealed value (v1.<iv>.<tag>.<ciphertext>) for rows whose content is not under test. */
const SEALED_PLACEHOLDER = `v1.${'A'.repeat(16)}.${'B'.repeat(22)}.${'C'.repeat(27)}`;

const SHARED_SHA256 = 'e'.repeat(64);

async function attach(subject: { ownerId: string; caseId: string }, label: string, sha256: string | null, status = 'uploaded') {
  const { rows } = await query<{ id: string }>(
    `insert into saferide.attachments (owner_id, case_id, bucket, bucket_path, retention_policy_id, status, sha256, expected_sha256)
     values ($1, $2, 'synthetic', $3, 'submitted-case-pending-legal-v1', $4::saferide.attachment_status, $5, $5) returning id`,
    [subject.ownerId, subject.caseId, `evidence/synthetic/${run}/${label}`, status, sha256],
  );
  return rows[0].id;
}

type Subject = { orgId: string; stableId: string; userId: string; ownerId: string; caseId: string; referralId: string; consentId: string };

async function subject(label: string): Promise<Subject> {
  const stableId = `test-repo-${label}-${run}`;
  const org = await query<{ id: string }>(
    `insert into saferide.partner_organizations (
       stable_id, display_name, intake_enabled, agreement_ref, agreement_signed_at, agreement_expires_at
     ) values ($1, 'Synthetic org', true, 'SYNTHETIC-TEST', now() - interval '1 day', now() + interval '30 days')
     returning id`,
    [stableId],
  );
  const orgId = org.rows[0].id;
  const user = await query<{ id: string }>(
    `insert into saferide.partner_users (
       org_id, email, display_name, role, status, password_hash, totp_secret_enc, totp_enrolled_at
     ) values ($1, $2, 'Synthetic caseworker', 'partner_caseworker', 'active',
       'scrypt$synthetic-test-hash', $3, now())
     returning id`,
    [orgId, `repo-${label}-${run}@example.invalid`, SEALED_PLACEHOLDER],
  );
  const ownerId = randomUUID();
  const kase = await query<{ id: string }>(
    `insert into saferide.cases (owner_id, pathway, status, summary) values ($1, 'escalate', 'submitted', '{}') returning id`,
    [ownerId],
  );
  const consents: string[] = [];
  for (const purpose of ['partner_follow_up', 'partner_callback']) {
    const consent = await query<{ id: string }>(
      `insert into saferide.consent_records (owner_id, purpose, consent_version, status, granted_at)
       values ($1, $2, 'synthetic-test.v1', 'granted', now()) returning id`,
      [ownerId, purpose],
    );
    consents.push(consent.rows[0].id);
  }
  const referral = await query<{ id: string }>(
    `insert into saferide.partner_referrals (case_id, owner_id, org_id, consent_record_id, reference)
     values ($1, $2, $3, $4, $5) returning id`,
    [kase.rows[0].id, ownerId, orgId, consents[0], generatePartnerReference()],
  );
  const referralId = referral.rows[0].id;
  await query(
    `insert into saferide.partner_referral_callbacks (referral_id, org_id, owner_id, consent_record_id, phone_enc)
     values ($1, $2, $3, $4, $5)`,
    [referralId, orgId, ownerId, consents[1], SEALED_PLACEHOLDER],
  );
  // The packet listed one photo; the matching file was uploaded after routing.
  await query(
    `insert into saferide.partner_referral_evidence (referral_id, org_id, manifest_index, media_type, sha256)
     values ($1, $2, 0, 'photo', $3)`,
    [referralId, orgId, SHARED_SHA256],
  );
  await query(
    `insert into saferide.attachments (owner_id, case_id, bucket, bucket_path, retention_policy_id, status, sha256, expected_sha256)
     values ($1, $2, 'synthetic', $3, 'submitted-case-pending-legal-v1', 'uploaded', $4, $4)`,
    [ownerId, kase.rows[0].id, `evidence/synthetic/${run}/${label}`, SHARED_SHA256],
  );
  await query(
    `insert into saferide.case_events (case_id, owner_id, event_type, payload)
     values ($1, $2, 'partner_routed', $3)`,
    [kase.rows[0].id, ownerId, { schemaVersion: '1.0', partner: stableId, partner_status: 'new' }],
  );
  return { orgId, stableId, userId: user.rows[0].id, ownerId, caseId: kase.rows[0].id, referralId, consentId: consents[0] };
}

describe.skipIf(!enabled)('partner case repository (org-scoped)', () => {
  let a: Subject;
  let b: Subject;

  beforeAll(async () => {
    a = await subject('a');
    b = await subject('b');
  });

  afterAll(async () => {
    await closeDb();
  });

  it('scopes every read to the caller’s org', async () => {
    expect((await getPartnerReferral(a.orgId, a.referralId))?.id).toBe(a.referralId);
    expect(await getPartnerReferral(a.orgId, b.referralId)).toBeNull();
    expect(await listPartnerReferralAttachments(a.orgId, b.referralId)).toEqual([]);
    expect(await listPartnerReferralTimeline(a.orgId, b.referralId)).toEqual([]);
    expect(await listPartnerReferralNotes(a.orgId, b.referralId)).toEqual([]);
    expect(await getPartnerReferralCallback(a.orgId, b.referralId)).toBeNull();
    expect(await getPartnerReferralCallback(b.orgId, b.referralId)).toEqual({ phoneEnc: SEALED_PLACEHOLDER });
    expect((await listPartnerReferralAttachments(b.orgId, b.referralId))).toHaveLength(1);
    expect(await listPartnerReferralTimeline(b.orgId, b.referralId)).toEqual([
      { eventType: 'partner_routed', partnerStatus: 'new', createdAt: expect.any(Date) },
    ]);
    const queue = await listPartnerReferrals({ orgId: a.orgId, limit: 10 });
    expect(queue.rows.map(row => row.id)).toEqual([a.referralId]);
    expect(queue.nextCursor).toBeNull();
  });

  it('scopes every write to the caller’s org and leaves the other org’s data untouched', async () => {
    const actor = { orgId: a.orgId, userId: a.userId, requestId: `db-test-${randomUUID()}` };
    expect(await transitionPartnerReferral({ actor, referralId: b.referralId, to: 'acknowledged', expectedStatus: 'new' }))
      .toEqual({ ok: false, reason: 'not_found' });
    expect(await addPartnerReferralNote({ actor, referralId: b.referralId, body: 'Synthetic' })).toEqual({ ok: false, reason: 'not_found' });
    const other = await query(`select status from saferide.partner_referrals where id = $1`, [b.referralId]);
    expect(other.rows[0]).toEqual({ status: 'new' });
    const audit = await query(`select 1 from saferide.partner_access_audit where request_id = $1`, [actor.requestId]);
    expect(audit.rows).toHaveLength(0);
  });

  it('mirrors a status change onto the survivor case and timeline, audited in the same transaction', async () => {
    const actor = { orgId: a.orgId, userId: a.userId, requestId: `db-test-${randomUUID()}` };
    const moved = await transitionPartnerReferral({ actor, referralId: a.referralId, to: 'acknowledged', expectedStatus: 'new' });
    expect(moved).toMatchObject({ ok: true, referral: { status: 'acknowledged' } });
    expect((await getCase(a.ownerId, a.caseId))?.status).toBe('in_review');
    const events = await listCaseEvents(a.ownerId, a.caseId);
    expect(events.at(-1)).toMatchObject({
      event_type: 'status_change',
      payload: { schemaVersion: '1.0', new_status: 'in_review', actor: 'partner', partner: a.stableId, partner_status: 'acknowledged' },
    });
    // The request id is kept for correlation in the database but never shown to the survivor.
    expect(events.at(-1)).not.toHaveProperty('request_id');
    const stored = await query<{ request_id: string }>(
      `select request_id from saferide.case_events where case_id = $1 and event_type = 'status_change' order by created_at desc limit 1`,
      [a.caseId],
    );
    expect(stored.rows[0].request_id).toBe(actor.requestId);
    const audit = await query<{ action: string; partner_user_id: string; referral_id: string }>(
      `select action, partner_user_id, referral_id from saferide.partner_access_audit where request_id = $1`,
      [actor.requestId],
    );
    expect(audit.rows).toEqual([{ action: 'partner.referral.status', partner_user_id: a.userId, referral_id: a.referralId }]);

    const closed = await transitionPartnerReferral({
      actor: { ...actor, requestId: `db-test-${randomUUID()}` }, referralId: a.referralId, to: 'closed',
      expectedStatus: 'acknowledged', closureReason: 'survivor_did_not_make_contact',
    });
    expect(closed).toMatchObject({ ok: true, referral: { status: 'closed', closureReason: 'survivor_did_not_make_contact' } });
    expect((await getCase(a.ownerId, a.caseId))?.status).toBe('closed');
    // The survivor's events carry the status only, never the closure reason.
    const survivorEvents = await listCaseEvents(a.ownerId, a.caseId);
    expect(JSON.stringify(survivorEvents)).not.toContain('survivor_did_not_make_contact');
    expect(survivorEvents.at(-1)?.payload).toEqual({
      schemaVersion: '1.0', new_status: 'closed', actor: 'partner', partner: a.stableId, partner_status: 'closed',
    });
    // The database refuses free text too.
    await expect(query(
      `update saferide.partner_referrals set closure_reason = 'Synthetic free text' where id = $1`, [a.referralId],
    )).rejects.toThrow(/partner_referral_closure_reason_code|closure reason changes only when closing|frozen/);
    await expect(query(
      `insert into saferide.partner_referrals (case_id, owner_id, org_id, consent_record_id, reference, status, closure_reason)
       select case_id, owner_id, org_id, gen_random_uuid(), 'SR-0000-0000', 'closed', 'Synthetic free text'
       from saferide.partner_referrals where id = $1`, [a.referralId],
    )).rejects.toThrow(/partner_referral_closure_reason_code|consent/);
    expect(await transitionPartnerReferral({ actor, referralId: a.referralId, to: 'in_progress', expectedStatus: 'closed' }))
      .toEqual({ ok: false, reason: 'invalid_transition', currentStatus: 'closed' });
  });

  it('appends notes with their author and audits them; revoked referrals become tombstones', async () => {
    const actor = { orgId: b.orgId, userId: b.userId, requestId: `db-test-${randomUUID()}` };
    const added = await addPartnerReferralNote({ actor, referralId: b.referralId, body: 'Synthetic note' });
    expect(added).toMatchObject({ ok: true, note: { body: 'Synthetic note', authorDisplayName: 'Synthetic caseworker' } });
    expect(await listPartnerReferralNotes(b.orgId, b.referralId)).toHaveLength(1);

    await query(`update saferide.consent_records set status = 'withdrawn', withdrawn_at = now() where id = $1`, [b.consentId]);
    const tombstone = await getPartnerReferral(b.orgId, b.referralId);
    expect(tombstone).toMatchObject({ id: b.referralId, summary: null, pathway: null, callbackShared: false });
    expect(tombstone?.revokedAt).toBeInstanceOf(Date);
    expect(await listPartnerReferralNotes(b.orgId, b.referralId)).toEqual([]);
    expect(await listPartnerReferralAttachments(b.orgId, b.referralId)).toEqual([]);
    expect(await listPartnerReferralTimeline(b.orgId, b.referralId)).toEqual([]);
    expect(await getPartnerReferralCallback(b.orgId, b.referralId)).toBeNull();
    expect(await addPartnerReferralNote({ actor, referralId: b.referralId, body: 'Late' })).toEqual({ ok: false, reason: 'withdrawn' });
    const withdrawn = await listPartnerReferrals({ orgId: b.orgId, status: 'withdrawn', limit: 10 });
    expect(withdrawn.rows).toEqual([expect.objectContaining({ id: b.referralId, pathway: null, revokedAt: expect.any(Date) })]);
    expect((await listPartnerReferrals({ orgId: b.orgId, status: 'new', limit: 10 })).rows).toEqual([]);
  });

  it('lists only evidence the survivor’s packet listed at routing time, matched by verified sha256', async () => {
    const c = await subject('evidence');
    const bound = (await listPartnerReferralAttachments(c.orgId, c.referralId)).map(row => row.id);
    expect(bound).toHaveLength(1);
    // A heavy-redaction entry (no checksum in the packet) can never match anything.
    await query(
      `insert into saferide.partner_referral_evidence (referral_id, org_id, manifest_index, media_type, sha256)
       values ($1, $2, 1, 'video', null)`,
      [c.referralId, c.orgId],
    );
    const later = await attach(c, 'evidence-later', 'f'.repeat(64));
    const upperCase = await attach(c, 'evidence-upper', SHARED_SHA256.toUpperCase());
    await attach(c, 'evidence-pending', null, 'pending_upload');
    const ids = (await listPartnerReferralAttachments(c.orgId, c.referralId)).map(row => row.id);
    expect(ids).toEqual([...bound, upperCase]);
    expect(ids).not.toContain(later);
    // Another org's referral to the same file content shares nothing with this one.
    expect(await listPartnerReferralAttachments(a.orgId, c.referralId)).toEqual([]);
  });

  it('pages the queue newest first with a stable cursor', async () => {
    const org = await subject('page');
    for (let index = 0; index < 2; index += 1) {
      const ownerId = randomUUID();
      const kase = await query<{ id: string }>(
        `insert into saferide.cases (owner_id, pathway, status) values ($1, 'referral', 'submitted') returning id`, [ownerId],
      );
      const consent = await query<{ id: string }>(
        `insert into saferide.consent_records (owner_id, purpose, consent_version, status, granted_at)
         values ($1, 'partner_follow_up', 'synthetic-test.v1', 'granted', now()) returning id`, [ownerId],
      );
      await query(
        `insert into saferide.partner_referrals (case_id, owner_id, org_id, consent_record_id, reference)
         values ($1, $2, $3, $4, $5)`,
        [kase.rows[0].id, ownerId, org.orgId, consent.rows[0].id, generatePartnerReference()],
      );
    }
    const first = await listPartnerReferrals({ orgId: org.orgId, limit: 2 });
    expect(first.rows).toHaveLength(2);
    expect(first.nextCursor?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    const second = await listPartnerReferrals({ orgId: org.orgId, limit: 2, cursor: first.nextCursor ?? undefined });
    expect(second.rows).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    const all = [...first.rows, ...second.rows];
    expect(new Set(all.map(row => row.id)).size).toBe(3);
    expect(all.map(row => row.receivedAt.getTime())).toEqual([...all.map(row => row.receivedAt.getTime())].sort((x, y) => y - x));
    expect((await listPartnerReferrals({ orgId: org.orgId, pathway: 'escalation', limit: 10 })).rows.map(row => row.id)).toEqual([org.referralId]);
  });
});
