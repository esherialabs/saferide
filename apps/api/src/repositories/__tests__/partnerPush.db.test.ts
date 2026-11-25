import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { closeDb, query } from '../../plugins/db.js';
import { resolvePartnerSession } from '../partnerAuthRepository.js';
import { claimPartnerPushJob, enqueuePartnerPushTest, partnerPushStatus, settlePartnerPushJob, subscribePartnerPush, unsubscribePartnerPush } from '../partnerPushRepository.js';
import { generatePartnerReference, generatePartnerToken, hashPartnerToken } from '../../services/partnerTokens.js';
import { openPushSubscription, pushEndpointHash, sealPushSubscription } from '../../services/partnerPushProtocol.js';
import type { PartnerSession } from '../../middleware/partnerSession.js';

vi.mock('../../config/env.js', () => ({ env: { databaseUrl: process.env.SAFERIDE_TEST_DATABASE_URL ?? 'postgres://unused.invalid/none' } }));
const enabled = Boolean(process.env.SAFERIDE_TEST_DATABASE_URL);
const sealKey = randomBytes(32);
async function fixture() {
  const run = randomUUID();
  const org = await query<{ id: string }>(`insert into saferide.partner_organizations(stable_id, display_name, intake_enabled, agreement_ref, agreement_signed_at, agreement_expires_at)
    values ($1, 'Synthetic push org', true, 'SYNTHETIC', now() - interval '1 day', now() + interval '30 days') returning id`, [`push-${run}`]);
  const orgId = org.rows[0].id;
  const user = await query<{ id: string }>(`insert into saferide.partner_users(org_id, email, display_name, role, status, password_hash, totp_secret_enc, totp_enrolled_at)
    values ($1, $2, 'Synthetic push staff', 'partner_caseworker', 'active', 'scrypt$synthetic', $3, now()) returning id`, [orgId, `${run}@example.invalid`, `v1.${'A'.repeat(16)}.${'B'.repeat(22)}.${'C'.repeat(27)}`]);
  const userId = user.rows[0].id;
  const credential = generatePartnerToken('session');
  await query(`insert into saferide.partner_sessions(token_hash, user_id, org_id, mfa_verified, idle_expires_at, absolute_expires_at)
    values ($1, $2, $3, true, now() + interval '30 minutes', now() + interval '11 hours')`, [hashPartnerToken(credential), userId, orgId]);
  const record = (await resolvePartnerSession(hashPartnerToken(credential), 'full', { slideIdle: false }))!;
  const session: PartnerSession = { ...record, realm: 'partner' };
  const curve = createECDH('prime256v1'); curve.generateKeys();
  const subscription = { endpoint: `https://updates.push.services.mozilla.com/wpush/v2/${run}`, keys: { p256dh: curve.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
  const hash = pushEndpointHash(subscription.endpoint);
  const sealed = sealPushSubscription(sealKey, userId, hash, subscription);
  await subscribePartnerPush(session, { hash, sealed, requestId: run });
  return { session, subscription, run, orgId, userId };
}
async function referral(orgId: string) {
  const ownerId = randomUUID();
  const consent = await query<{ id: string }>(`insert into saferide.consent_records(owner_id, purpose, consent_version, status, granted_at)
    values ($1, 'partner_follow_up', 'synthetic-test.v1', 'granted', now()) returning id`, [ownerId]);
  const created = await query<{ id: string }>(`insert into saferide.cases(owner_id, pathway, status) values ($1, 'referral', 'submitted') returning id`, [ownerId]);
  await query(`insert into saferide.partner_referrals(case_id, owner_id, org_id, consent_record_id, reference) values ($1, $2, $3, $4, $5)`, [created.rows[0].id, ownerId, orgId, consent.rows[0].id, generatePartnerReference()]);
  return consent.rows[0].id;
}
describe.skipIf(!enabled)('durable generic partner notifications in PostgreSQL', () => {
  afterAll(closeDb);
  it('atomically queues a new referral and consumes a successful delivery without exposing credentials', async () => {
    const f = await fixture();
    await referral(f.orgId);
    const job = (await claimPartnerPushJob())!;
    expect(job.kind).toBe('attention');
    expect(job.user_id).toBe(f.userId);
    expect(openPushSubscription(sealKey, job.user_id, job.endpoint_hash, job.subscription_enc)).toEqual(f.subscription);
    await settlePartnerPushJob(job, 'accepted');
    expect(await partnerPushStatus(f.session.sessionId)).toMatchObject({ enabled: true, lastOutcome: 'accepted' });
    expect((await partnerPushStatus(f.session.sessionId)).lastAcceptedAt).not.toBeNull();
    await unsubscribePartnerPush(f.session, f.run);
  });
  it('suppresses withdrawn referrals and all delivery after a session is revoked', async () => {
    const f = await fixture();
    const consentId = await referral(f.orgId);
    await query(`update saferide.consent_records set status = 'withdrawn', withdrawn_at = now() where id = $1`, [consentId]);
    const pending = await query<{ total: number }>(`select count(*)::int as total from saferide.partner_push_jobs j
      join saferide.partner_push_subscriptions p on p.id = j.subscription_id where p.session_id = $1`, [f.session.sessionId]);
    expect(pending.rows[0].total).toBe(0); // same transaction, before the worker's cleanup
    expect(await claimPartnerPushJob()).toBeNull();
    expect(await enqueuePartnerPushTest(f.session, f.run)).toBe(true);
    await query(`update saferide.partner_sessions set revoked_at = now(), revoke_reason = 'logout' where id = $1`, [f.session.sessionId]);
    expect(await claimPartnerPushJob()).toBeNull();
    expect(await partnerPushStatus(f.session.sessionId)).toMatchObject({ enabled: false });
  });
  it('retries provider failures and removes an expired browser subscription', async () => {
    const f = await fixture();
    await enqueuePartnerPushTest(f.session, f.run);
    const job = (await claimPartnerPushJob())!;
    await settlePartnerPushJob({ ...job, claim_token: randomUUID() }, 'expired');
    expect((await partnerPushStatus(f.session.sessionId)).enabled).toBe(true);
    await settlePartnerPushJob(job, 'retry');
    expect(await claimPartnerPushJob()).toBeNull();
    await query(`update saferide.partner_push_jobs set next_attempt_at = now() - interval '1 second' where id = $1`, [job.id]);
    const retry = (await claimPartnerPushJob())!;
    expect(retry.attempts).toBe(2);
    await settlePartnerPushJob(retry, 'expired');
    expect((await partnerPushStatus(f.session.sessionId)).enabled).toBe(false);
  });
});
