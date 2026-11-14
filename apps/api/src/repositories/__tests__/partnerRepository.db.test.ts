/**
 * Runs against a real, disposable PostgreSQL that already has migrations
 * 000-008, 010 and runtime-role.sql applied (the selfhost init path). Skipped
 * unless SAFERIDE_TEST_DATABASE_URL is set. Synthetic data only.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  PartnerAdminError,
  createPartnerOrg,
  disablePartnerUser,
  exportPartnerAudit,
  findPartnerOrgOpenForIntake,
  invitePartnerUser,
  resetPartnerUserEnrollment,
  revokePartnerSessions,
  setPartnerOrgAgreement,
  setPartnerOrgIntake,
  setPartnerOrgMfa,
  setPartnerUserPassword,
} from '../partnerRepository.js';
import { findPartnerKnownDeviceAccount } from '../partnerAuthRepository.js';
import { closeDb, pool, query } from '../../plugins/db.js';
import { deriveCallbackSealKey, sealPartnerCallback } from '../../services/partnerCallbackSeal.js';
import { generatePartnerReference, hashPartnerToken } from '../../services/partnerTokens.js';

vi.mock('../../config/env.js', () => ({
  env: { databaseUrl: process.env.SAFERIDE_TEST_DATABASE_URL ?? 'postgres://unused.invalid/none' },
}));

const enabled = Boolean(process.env.SAFERIDE_TEST_DATABASE_URL);
const run = randomUUID().slice(0, 8);
const operator = `db-test-${run}`;
const context = () => ({ operatorRef: operator, requestId: `db-test-${randomUUID()}` });
const day = 24 * 60 * 60 * 1000;
/** Shape-valid sealed value (v1.<iv>.<tag>.<ciphertext>) for rows whose content is not under test. */
const SEALED_PLACEHOLDER = `v1.${'A'.repeat(16)}.${'B'.repeat(22)}.${'C'.repeat(27)}`;
const callbackKey = deriveCallbackSealKey(Buffer.alloc(32, 7));

async function expectDbError(statement: Promise<unknown>, pattern: RegExp): Promise<void> {
  await expect(statement).rejects.toThrow(pattern);
}

async function newOrg(suffix: string, withAgreement = true, openIntake = withAgreement) {
  const stableId = `test-${suffix}-${run}`;
  const org = await createPartnerOrg({ stableId, displayName: `Synthetic ${suffix}`, context: context() });
  if (withAgreement) {
    await setPartnerOrgAgreement({
      stableId, agreementRef: 'SYNTHETIC-TEST', signedAt: new Date(Date.now() - day),
      expiresAt: new Date(Date.now() + 30 * day), context: context(),
    });
  }
  if (openIntake) {
    // Direct SQL so the operator audit sequence asserted below stays create + agreement.
    await query(`update saferide.partner_organizations set intake_enabled = true where id = $1`, [org.id]);
  }
  return org;
}

async function activeUser(orgId: string, label: string): Promise<string> {
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

async function caseWithConsent(purposes: string[]) {
  const ownerId = randomUUID();
  const { rows } = await query<{ id: string }>(
    `insert into saferide.cases (owner_id, pathway, status) values ($1, 'referral', 'submitted') returning id`,
    [ownerId],
  );
  const consents: Record<string, string> = {};
  for (const purpose of purposes) {
    const consent = await query<{ id: string }>(
      `insert into saferide.consent_records (owner_id, purpose, consent_version, status, granted_at)
       values ($1, $2, 'synthetic-test.v1', 'granted', now()) returning id`,
      [ownerId, purpose],
    );
    consents[purpose] = consent.rows[0].id;
  }
  return { ownerId, caseId: rows[0].id, consents };
}

async function newReferral(orgId: string, consentPurpose = 'partner_follow_up') {
  const subject = await caseWithConsent([consentPurpose, 'partner_callback']);
  const { rows } = await query<{ id: string }>(
    `insert into saferide.partner_referrals (case_id, owner_id, org_id, consent_record_id, reference)
     values ($1, $2, $3, $4, $5) returning id`,
    [subject.caseId, subject.ownerId, orgId, subject.consents[consentPurpose], generatePartnerReference()],
  );
  return { ...subject, referralId: rows[0].id };
}

describe.skipIf(!enabled)('partner data model against PostgreSQL', () => {
  beforeAll(async () => {
    await query(
      `insert into saferide.partner_operators (handle, display_name, role_label)
       values ($1, 'Synthetic DB test operator', 'Synthetic test') on conflict (handle) do nothing`,
      [operator],
    );
  });

  afterAll(async () => {
    await closeDb();
  });

  it('records migration 007 and audits every operator change', async () => {
    const version = await query(`select 1 from saferide.schema_migrations where version = '007'`);
    expect(version.rows).toHaveLength(1);
    const org = await newOrg('audit');
    const { rows } = await query<{ action: string; actor_type: string; operator_ref: string }>(
      `select action, actor_type, operator_ref from saferide.partner_access_audit where org_id = $1 order by created_at`,
      [org.id],
    );
    expect(rows.map(row => row.action)).toEqual(['operator.org.create', 'operator.org.set_agreement']);
    expect(rows.every(row => row.actor_type === 'operator' && row.operator_ref === operator)).toBe(true);
  });

  it('keeps intake off until an agreement is in force', async () => {
    const org = await newOrg('intake', false);
    expect(org.intakeEnabled).toBe(false);
    const refused = await setPartnerOrgIntake({ stableId: org.stableId, enabled: true, context: context() }).catch(e => e);
    expect(refused).toBeInstanceOf(PartnerAdminError);
    expect(refused.code).toBe('agreement_required');
    await expectDbError(
      query(`update saferide.partner_organizations set intake_enabled = true where id = $1`, [org.id]),
      /partner_org_intake_requires_agreement/,
    );
    await setPartnerOrgAgreement({
      stableId: org.stableId, agreementRef: 'SYNTHETIC-TEST', signedAt: new Date(Date.now() - day),
      expiresAt: new Date(Date.now() + day), context: context(),
    });
    await expect(setPartnerOrgIntake({ stableId: org.stableId, enabled: true, context: context() }))
      .resolves.toMatchObject({ intakeEnabled: true });
  });

  it('refuses referrals unless intake is on and the agreement is in force at write time', async () => {
    const org = await newOrg('intake-time', true, false);
    const subject = await caseWithConsent(['partner_follow_up']);
    const route = () => query(
      `insert into saferide.partner_referrals (case_id, owner_id, org_id, consent_record_id, reference)
       values ($1, $2, $3, $4, $5)`,
      [subject.caseId, subject.ownerId, org.id, subject.consents.partner_follow_up, generatePartnerReference()],
    );
    expect(await findPartnerOrgOpenForIntake(org.stableId)).toBeNull();
    await expectDbError(route(), /not open for intake/);

    await setPartnerOrgIntake({ stableId: org.stableId, enabled: true, context: context() });
    expect(await findPartnerOrgOpenForIntake(org.stableId)).toMatchObject({ id: org.id, intakeEnabled: true });

    // The agreement lapses while intake is still switched on.
    await query(
      `update saferide.partner_organizations
       set agreement_signed_at = now() - interval '2 days', agreement_expires_at = now() - interval '1 second'
       where id = $1`,
      [org.id],
    );
    expect(await findPartnerOrgOpenForIntake(org.stableId)).toBeNull();
    await expectDbError(route(), /not open for intake/);

    await query(`update saferide.partner_organizations set agreement_expires_at = now() + interval '1 day' where id = $1`, [org.id]);
    await route();
  });

  it('invites, resets and disables users, revoking their sessions each time', async () => {
    const org = await newOrg('users');
    const email = `invitee-${run}@example.invalid`;
    const user = await invitePartnerUser({
      orgStableId: org.stableId, email, displayName: 'Synthetic invitee', role: 'partner_caseworker',
      enrollmentTokenHash: hashPartnerToken(`srpe_${randomUUID()}`), enrollmentExpiresAt: new Date(Date.now() + day),
      context: context(),
    });
    expect(user.status).toBe('invited');
    await expectDbError(
      query(`update saferide.partner_users set status = 'active' where id = $1`, [user.id]),
      /partner_user_active_credentials/,
    );

    await query(
      `update saferide.partner_users set status = 'active', password_hash = 'scrypt$synthetic', totp_secret_enc = $2,
         totp_enrolled_at = now(), totp_last_step = 5, failed_attempts = 3, locked_until = now() + interval '1 hour',
         enrollment_token_hash = null, enrollment_expires_at = null where id = $1`,
      [user.id, SEALED_PLACEHOLDER],
    );
    await query(
      `insert into saferide.partner_sessions (token_hash, user_id, org_id, mfa_verified, idle_expires_at, absolute_expires_at)
       values ($1, $2, $3, true, now() + interval '30 minutes', now() + interval '12 hours')`,
      [hashPartnerToken(`srps_${randomUUID()}`), user.id, org.id],
    );
    const reset = await resetPartnerUserEnrollment({
      email, enrollmentTokenHash: hashPartnerToken(`srpe_${randomUUID()}`),
      enrollmentExpiresAt: new Date(Date.now() + day), context: context(),
    });
    expect(reset).toMatchObject({ revokedSessions: 1, user: { status: 'invited', totpEnrolled: false } });
    const cleared = await query(
      `select password_hash, totp_secret_enc, failed_attempts, locked_until from saferide.partner_users where id = $1`,
      [user.id],
    );
    expect(cleared.rows[0]).toEqual({ password_hash: null, totp_secret_enc: null, failed_attempts: 0, locked_until: null });

    const disabled = await disablePartnerUser({ email, context: context() });
    expect(disabled.user.status).toBe('disabled');
    const pending = await query(`select enrollment_token_hash from saferide.partner_users where id = $1`, [user.id]);
    expect(pending.rows[0].enrollment_token_hash).toBeNull();
    const again = await disablePartnerUser({ email, context: context() }).catch(e => e);
    expect(again.code).toBe('invalid_state');
  });

  it('bumps the known-device epoch on user:disable, user:reset and sessions:revoke', async () => {
    const org = await newOrg('epoch');
    const idA = await activeUser(org.id, 'epoch-a');
    const idB = await activeUser(org.id, 'epoch-b');
    const emailA = `epoch-a-${run}@example.invalid`;
    const emailB = `epoch-b-${run}@example.invalid`;
    const epochs = async () => (await query<{ id: string; known_device_epoch: number }>(
      `select id, known_device_epoch from saferide.partner_users where id = any($1::uuid[])`, [[idA, idB]],
    )).rows.reduce<Record<string, number>>((acc, row) => ({ ...acc, [row.id === idA ? 'a' : 'b']: row.known_device_epoch }), {});
    expect(await epochs()).toEqual({ a: 0, b: 0 });
    await expect(findPartnerKnownDeviceAccount(emailA)).resolves.toEqual({ userId: idA, epoch: 0 });

    await revokePartnerSessions({ target: { email: emailA }, context: context() });
    expect(await epochs()).toEqual({ a: 1, b: 0 });
    await revokePartnerSessions({ target: { orgStableId: org.stableId }, context: context() });
    expect(await epochs()).toEqual({ a: 2, b: 1 });
    await resetPartnerUserEnrollment({
      email: emailA, enrollmentTokenHash: hashPartnerToken(`srpe_${randomUUID()}`),
      enrollmentExpiresAt: new Date(Date.now() + day), context: context(),
    });
    expect(await epochs()).toEqual({ a: 3, b: 1 });
    // An invited (reset) user earns no priority until they enrol again.
    await expect(findPartnerKnownDeviceAccount(emailA)).resolves.toBeNull();
    await disablePartnerUser({ email: emailB, context: context() });
    expect(await epochs()).toEqual({ a: 3, b: 2 });
    await expect(findPartnerKnownDeviceAccount(emailB)).resolves.toBeNull();
  });

  it('sets an operator-issued password: keeps an enrolled TOTP, lifts the lock, revokes sessions, never stores the secret', async () => {
    const org = await newOrg('set-password');
    const userId = await activeUser(org.id, 'set-password');
    const email = `set-password-${run}@example.invalid`;
    await query(
      `update saferide.partner_users set failed_attempts = 4, lockout_count = 2, locked_until = now() + interval '1 hour', totp_last_step = 9
       where id = $1`,
      [userId],
    );
    await query(
      `insert into saferide.partner_sessions (token_hash, user_id, org_id, mfa_verified, idle_expires_at, absolute_expires_at)
       values ($1, $2, $3, true, now() + interval '30 minutes', now() + interval '12 hours')`,
      [hashPartnerToken(`srps_${randomUUID()}`), userId, org.id],
    );
    const result = await setPartnerUserPassword({ email, passwordHash: 'scrypt$synthetic-issued', context: context() });
    expect(result).toMatchObject({ revokedSessions: 1, wasInvited: false, orgMfaRequired: true, user: { status: 'active', totpEnrolled: true } });
    const row = await query(
      `select password_hash, must_change_password, failed_attempts, lockout_count, locked_until, totp_secret_enc, totp_last_step,
              known_device_epoch
       from saferide.partner_users where id = $1`,
      [userId],
    );
    expect(row.rows[0]).toEqual({
      password_hash: 'scrypt$synthetic-issued', must_change_password: true, failed_attempts: 0, lockout_count: 0,
      locked_until: null, totp_secret_enc: SEALED_PLACEHOLDER, totp_last_step: '9', known_device_epoch: 1,
    });
    const audit = await query<{ action: string; target_user_id: string }>(
      `select action, target_user_id from saferide.partner_access_audit where org_id = $1 and action = 'operator.user.set_password'`, [org.id],
    );
    expect(audit.rows).toEqual([{ action: 'operator.user.set_password', target_user_id: userId }]);

    // An invited user is activated, their link and half-finished authenticator setup cancelled.
    const inviteEmail = `set-password-invitee-${run}@example.invalid`;
    const invited = await invitePartnerUser({
      orgStableId: org.stableId, email: inviteEmail, displayName: 'Synthetic invitee', role: 'partner_admin',
      enrollmentTokenHash: hashPartnerToken(`srpe_${randomUUID()}`), enrollmentExpiresAt: new Date(Date.now() + day), context: context(),
    });
    await query(`update saferide.partner_users set totp_secret_enc = $2 where id = $1`, [invited.id, SEALED_PLACEHOLDER]);
    await expect(setPartnerUserPassword({ email: inviteEmail, passwordHash: 'scrypt$synthetic-issued', context: context() }))
      .resolves.toMatchObject({ wasInvited: true, user: { status: 'active', totpEnrolled: false } });
    const activated = await query(
      `select enrollment_token_hash, totp_secret_enc from saferide.partner_users where id = $1`, [invited.id],
    );
    expect(activated.rows[0]).toEqual({ enrollment_token_hash: null, totp_secret_enc: null });

    await disablePartnerUser({ email, context: context() });
    await expect(setPartnerUserPassword({ email, passwordHash: 'scrypt$synthetic-issued', context: context() }))
      .rejects.toMatchObject({ code: 'invalid_state' });
    await expect(setPartnerUserPassword({ email: `nobody-${run}@example.invalid`, passwordHash: 'scrypt$x', context: context() }))
      .rejects.toMatchObject({ code: 'not_found' });
  });

  it('switches org MFA by stable id or id, revoking password-only sessions when it comes back on', async () => {
    const org = await newOrg('mfa');
    const userId = await activeUser(org.id, 'mfa-user');
    await expect(setPartnerOrgMfa({ org: org.stableId, required: true, context: context() }))
      .resolves.toMatchObject({ changed: false, revokedSessions: 0, org: { stableId: org.stableId, intakeEnabled: true } });
    await expect(setPartnerOrgMfa({ org: org.id, required: false, context: context() })).resolves.toMatchObject({ changed: true });
    await query(
      `insert into saferide.partner_sessions (token_hash, user_id, org_id, mfa_verified, mfa_waived, idle_expires_at, absolute_expires_at)
       values ($1, $2, $3, false, true, now() + interval '30 minutes', now() + interval '12 hours'),
              ($4, $2, $3, true, false, now() + interval '30 minutes', now() + interval '12 hours')`,
      [hashPartnerToken(`srps_${randomUUID()}`), userId, org.id, hashPartnerToken(`srps_${randomUUID()}`)],
    );
    // Only the password-only session ends; the TOTP-verified one stays.
    await expect(setPartnerOrgMfa({ org: org.stableId, required: true, context: context() }))
      .resolves.toMatchObject({ changed: true, revokedSessions: 1, usersWithoutTotp: 0 });
    const reasons = await query<{ revoke_reason: string | null }>(
      `select revoke_reason from saferide.partner_sessions where user_id = $1 order by mfa_waived`, [userId],
    );
    expect(reasons.rows.map(row => row.revoke_reason)).toEqual([null, 'mfa_policy']);
    const audit = await query(`select 1 from saferide.partner_access_audit where org_id = $1 and action = 'operator.org.mfa'`, [org.id]);
    expect(audit.rows).toHaveLength(3);
    await expect(setPartnerOrgMfa({ org: `missing-${run}`, required: false, context: context() })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('bounds session lifetimes and binds sessions to the user’s own org', async () => {
    const org = await newOrg('sessions');
    const other = await newOrg('sessions-other');
    const userId = await activeUser(org.id, 'session-user');
    await expectDbError(
      query(
        `insert into saferide.partner_sessions (token_hash, user_id, org_id, mfa_verified, idle_expires_at, absolute_expires_at)
         values ($1, $2, $3, false, now() + interval '5 minutes', now() + interval '10 minutes')`,
        [hashPartnerToken(`srps_${randomUUID()}`), userId, org.id],
      ),
      /partner_session_pre_mfa_lifetime/,
    );
    await expectDbError(
      query(
        `insert into saferide.partner_sessions (token_hash, user_id, org_id, mfa_verified, idle_expires_at, absolute_expires_at)
         values ($1, $2, $3, true, now() + interval '30 minutes', now() + interval '13 hours')`,
        [hashPartnerToken(`srps_${randomUUID()}`), userId, org.id],
      ),
      /partner_session_max_lifetime/,
    );
    await expectDbError(
      query(
        `insert into saferide.partner_sessions (token_hash, user_id, org_id, mfa_verified, idle_expires_at, absolute_expires_at)
         values ($1, $2, $3, true, now() + interval '30 minutes', now() + interval '12 hours')`,
        [hashPartnerToken(`srps_${randomUUID()}`), userId, other.id],
      ),
      /foreign key/,
    );
    await query(
      `insert into saferide.partner_sessions (token_hash, user_id, org_id, mfa_verified, idle_expires_at, absolute_expires_at)
       values ($1, $2, $3, true, now() + interval '30 minutes', now() + interval '12 hours')`,
      [hashPartnerToken(`srps_${randomUUID()}`), userId, org.id],
    );
    await expect(revokePartnerSessions({ target: { orgStableId: org.stableId }, context: context() })).resolves.toBe(1);
  });

  it('routes a case only under the survivor’s own granted partner_follow_up consent', async () => {
    const org = await newOrg('routing');
    const subject = await caseWithConsent(['partner_follow_up', 'pathway_submission']);
    const insert = (consentId: string, ownerId = subject.ownerId) => query(
      `insert into saferide.partner_referrals (case_id, owner_id, org_id, consent_record_id, reference)
       values ($1, $2, $3, $4, $5)`,
      [subject.caseId, ownerId, org.id, consentId, generatePartnerReference()],
    );
    await expectDbError(insert(subject.consents.pathway_submission), /partner_follow_up consent/);
    await expectDbError(insert(subject.consents.partner_follow_up, randomUUID()), /partner_follow_up consent/);
    // Another survivor's valid consent cannot route this survivor's case.
    const stranger = await caseWithConsent(['partner_follow_up']);
    await expectDbError(insert(stranger.consents.partner_follow_up, stranger.ownerId), /foreign key/);
    await query(
      `update saferide.consent_records set status = 'withdrawn', withdrawn_at = now() where id = $1`,
      [subject.consents.partner_follow_up],
    );
    await expectDbError(insert(subject.consents.partner_follow_up), /partner_follow_up consent/);
  });

  it('revokes the referral, deletes its notes and callback when partner_follow_up is withdrawn', async () => {
    const org = await newOrg('withdrawal');
    const subject = await newReferral(org.id);
    const other = await newReferral(org.id);
    const author = await activeUser(org.id, 'withdrawal-author');
    for (const referral of [subject, other]) {
      await query(
        `insert into saferide.partner_case_notes (referral_id, org_id, author_user_id, body) values ($1, $2, $3, 'Synthetic note')`,
        [referral.referralId, org.id, author],
      );
    }
    await query(
      `insert into saferide.partner_referral_callbacks (referral_id, org_id, owner_id, consent_record_id, phone_enc)
       values ($1, $2, $3, $4, $5)`,
      [subject.referralId, org.id, subject.ownerId, subject.consents.partner_callback,
        sealPartnerCallback(callbackKey, subject.referralId, '+254700000001')],
    );
    await expectDbError(
      query(
        `insert into saferide.partner_referrals (case_id, owner_id, org_id, consent_record_id, reference)
         values ($1, $2, $3, $4, $5)`,
        [(await caseWithConsent([])).caseId, subject.ownerId, (await newOrg('withdrawal-second')).id,
          subject.consents.partner_follow_up, generatePartnerReference()],
      ),
      /partner_referrals_consent_record_id_key|foreign key/,
    );

    await query(
      `update saferide.consent_records set status = 'withdrawn', withdrawn_at = now() where id = $1`,
      [subject.consents.partner_follow_up],
    );
    const revoked = await query<{ revoke_reason: string; access_revoked_at: Date | null }>(
      `select revoke_reason, access_revoked_at from saferide.partner_referrals where id = $1`, [subject.referralId],
    );
    expect(revoked.rows[0].revoke_reason).toBe('consent_withdrawn');
    expect(revoked.rows[0].access_revoked_at).not.toBeNull();
    const notes = await query(`select referral_id from saferide.partner_case_notes where org_id = $1`, [org.id]);
    expect(notes.rows.map(row => row.referral_id)).toEqual([other.referralId]);
    const callbacks = await query(`select 1 from saferide.partner_referral_callbacks where referral_id = $1`, [subject.referralId]);
    expect(callbacks.rows).toHaveLength(0);
    const untouched = await query(`select access_revoked_at from saferide.partner_referrals where id = $1`, [other.referralId]);
    expect(untouched.rows[0].access_revoked_at).toBeNull();
  });

  it('lets one partner_follow_up consent back only one referral', async () => {
    const org = await newOrg('one-consent');
    const otherOrg = await newOrg('one-consent-other');
    const subject = await newReferral(org.id);
    const secondCase = await query<{ id: string }>(
      `insert into saferide.cases (owner_id, pathway, status) values ($1, 'referral', 'submitted') returning id`,
      [subject.ownerId],
    );
    await expectDbError(
      query(
        `insert into saferide.partner_referrals (case_id, owner_id, org_id, consent_record_id, reference)
         values ($1, $2, $3, $4, $5)`,
        [secondCase.rows[0].id, subject.ownerId, otherOrg.id, subject.consents.partner_follow_up, generatePartnerReference()],
      ),
      /partner_referrals_consent_record_id_key/,
    );
  });

  it('enforces the referral status path, closure reasons and frozen revocations', async () => {
    const org = await newOrg('status');
    const { referralId } = await newReferral(org.id);
    const setStatus = (status: string, reason: string | null = null) => query(
      `update saferide.partner_referrals set status = $2, closure_reason = $3 where id = $1`,
      [referralId, status, reason],
    );
    await expectDbError(setStatus('in_progress'), /invalid partner referral status transition/);
    await setStatus('acknowledged');
    await setStatus('in_progress');
    await expectDbError(setStatus('closed'), /partner_referral_closure/);
    await expectDbError(
      query(`update saferide.partner_referrals set org_id = $2 where id = $1`, [referralId, (await newOrg('status-other')).id]),
      /identity is immutable/,
    );
    await query(
      `update saferide.partner_referrals set access_revoked_at = now(), revoke_reason = 'consent_withdrawn' where id = $1`,
      [referralId],
    );
    await expectDbError(setStatus('closed', 'Synthetic closure'), /frozen/);
  });

  it('keeps notes append-only and authored within the referral’s org', async () => {
    const org = await newOrg('notes');
    const other = await newOrg('notes-other');
    const { referralId } = await newReferral(org.id);
    const author = await activeUser(org.id, 'note-author');
    const outsider = await activeUser(other.id, 'note-outsider');
    const { rows } = await query<{ id: string }>(
      `insert into saferide.partner_case_notes (referral_id, org_id, author_user_id, body)
       values ($1, $2, $3, 'Synthetic note') returning id`,
      [referralId, org.id, author],
    );
    await expectDbError(
      query(`update saferide.partner_case_notes set body = 'edited' where id = $1`, [rows[0].id]),
      /append-only/,
    );
    await expectDbError(
      query(
        `insert into saferide.partner_case_notes (referral_id, org_id, author_user_id, body) values ($1, $2, $3, 'x')`,
        [referralId, org.id, outsider],
      ),
      /foreign key/,
    );
    await expectDbError(
      query(
        `insert into saferide.partner_case_notes (referral_id, org_id, author_user_id, body) values ($1, $2, $3, $4)`,
        [referralId, org.id, author, 'x'.repeat(2001)],
      ),
      /check constraint/,
    );
  });

  it('stores a callback only under partner_callback consent and removes it on withdrawal or revocation', async () => {
    const org = await newOrg('callback');
    const first = await newReferral(org.id);
    const addCallback = (subject: typeof first, consentId: string, sealed?: string) => query(
      `insert into saferide.partner_referral_callbacks (referral_id, org_id, owner_id, consent_record_id, phone_enc)
       values ($1, $2, $3, $4, $5)`,
      [subject.referralId, org.id, subject.ownerId, consentId, sealed ?? sealPartnerCallback(callbackKey, subject.referralId, '+254700000001')],
    );
    await expectDbError(addCallback(first, first.consents.partner_callback, '+254700000001'), /phone_enc_check/);
    await expectDbError(addCallback(first, first.consents.partner_callback, 'v2.unversioned-or-plain'), /phone_enc_check/);
    await expectDbError(addCallback(first, first.consents.partner_follow_up), /partner_callback consent/);
    await addCallback(first, first.consents.partner_callback);
    await query(
      `update saferide.consent_records set status = 'withdrawn', withdrawn_at = now() where id = $1`,
      [first.consents.partner_callback],
    );
    const afterWithdrawal = await query(`select 1 from saferide.partner_referral_callbacks where referral_id = $1`, [first.referralId]);
    expect(afterWithdrawal.rows).toHaveLength(0);

    const second = await newReferral(org.id);
    await addCallback(second, second.consents.partner_callback);
    await query(
      `update saferide.partner_referrals set access_revoked_at = now(), revoke_reason = 'consent_withdrawn' where id = $1`,
      [second.referralId],
    );
    const afterRevocation = await query(`select 1 from saferide.partner_referral_callbacks where referral_id = $1`, [second.referralId]);
    expect(afterRevocation.rows).toHaveLength(0);
    await expectDbError(addCallback(second, second.consents.partner_callback), /revoked referral/);
  });

  it('keeps the audit append-only, and the runtime role cannot delete it or edit notes', async () => {
    const org = await newOrg('runtime-role');
    const rows = await exportPartnerAudit({
      orgStableId: org.stableId, since: new Date(Date.now() - day), until: new Date(Date.now() + day), context: context(),
    });
    expect(rows.map(row => row.action)).toEqual(['operator.org.create', 'operator.org.set_agreement']);
    expect(Object.keys(rows[0]).sort()).toEqual([
      'action', 'actorType', 'attachmentId', 'createdAt', 'id', 'operatorRef', 'orgId', 'outcome',
      'partnerUserId', 'policyVersion', 'reasonCode', 'referralId', 'requestId', 'targetUserId',
    ]);
    await expectDbError(
      query(`update saferide.partner_access_audit set outcome = 'failed' where org_id = $1`, [org.id]),
      /append-only/,
    );

    const role = await query(`select 1 from pg_roles where rolname = 'saferide_api'`);
    if (role.rows.length === 0) return;
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('set local role saferide_api');
      await client.query(`select count(*) from saferide.partner_access_audit`);
      await expect(client.query(`delete from saferide.partner_access_audit where org_id = $1`, [org.id]))
        .rejects.toThrow(/permission denied/);
      await client.query('rollback');
      await client.query('begin');
      await client.query('set local role saferide_api');
      await expect(client.query(`update saferide.partner_case_notes set body = 'x' where false`))
        .rejects.toThrow(/permission denied/);
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
    }
  });
});
