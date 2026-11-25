import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { query, closeDb } from '../../plugins/db.js';
import { generatePartnerReference } from '../../services/partnerTokens.js';
import { listPartnerSafetyMapRecords } from '../partnerSafetyMapRepository.js';

vi.mock('../../config/env.js', () => ({ env: { databaseUrl: process.env.SAFERIDE_TEST_DATABASE_URL ?? 'postgres://unused.invalid/none' } }));
async function org() {
  const { rows } = await query<{ id: string }>(`insert into saferide.partner_organizations(stable_id, display_name, intake_enabled, agreement_ref, agreement_signed_at, agreement_expires_at)
    values ($1, 'Synthetic map org', true, 'SYNTHETIC', now() - interval '1 day', now() + interval '30 days') returning id`, [`map-${randomUUID()}`]);
  return rows[0].id;
}
async function shared(orgId: string, daysAgo = 0) {
  const ownerId = randomUUID();
  const consent = await query<{ id: string }>(`insert into saferide.consent_records(owner_id, purpose, consent_version, status, granted_at)
    values ($1, 'partner_follow_up', 'synthetic.v1', 'granted', now()) returning id`, [ownerId]);
  const created = await query<{ id: string }>(`insert into saferide.cases(owner_id, pathway, status, summary) values ($1, 'referral', 'submitted', $2) returning id`, [ownerId, { schemaVersion: '1.0', syntheticMap: true }]);
  await query(`insert into saferide.partner_referrals(case_id, owner_id, org_id, consent_record_id, reference, created_at)
    values ($1, $2, $3, $4, $5, now() - make_interval(days => $6::int))`, [created.rows[0].id, ownerId, orgId, consent.rows[0].id, generatePartnerReference(), daysAgo]);
  return consent.rows[0].id;
}
describe.skipIf(!process.env.SAFERIDE_TEST_DATABASE_URL)('staff map PostgreSQL sharing boundary', () => {
  afterAll(closeDb);
  it('returns only the current organisation’s granted, unrevoked cases in the selected window', async () => {
    const own = await org(); const other = await org();
    const consent = await shared(own); await shared(own, 40); await shared(other);
    expect((await listPartnerSafetyMapRecords(own, 30)).records).toHaveLength(1);
    expect((await listPartnerSafetyMapRecords(own, 90)).records).toHaveLength(2);
    await query(`update saferide.consent_records set status = 'withdrawn', withdrawn_at = now() where id = $1`, [consent]);
    expect((await listPartnerSafetyMapRecords(own, 30)).records).toHaveLength(0);
    expect((await listPartnerSafetyMapRecords(other, 30)).records).toHaveLength(1);
  });
});
