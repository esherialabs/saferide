import { query } from '../plugins/db.js';
import type { PartnerReferralStatus } from '../services/partnerReferralStatus.js';

/** Bounded operational view; a larger queue is explicitly reported as truncated. */
export const SAFETY_MAP_CASE_LIMIT = 200;
export type PartnerSafetyMapRecord = {
  status: PartnerReferralStatus;
  pathway: 'referral' | 'escalate';
  summary: Record<string, unknown> | null;
};

export async function listPartnerSafetyMapRecords(orgId: string, days: number): Promise<{ records: PartnerSafetyMapRecord[]; truncated: boolean }> {
  const { rows } = await query<PartnerSafetyMapRecord>(
    `select r.status, c.pathway, c.summary
     from saferide.partner_referrals r
     join saferide.cases c on c.id = r.case_id and c.owner_id = r.owner_id
     join saferide.consent_records consent on consent.id = r.consent_record_id and consent.owner_id = r.owner_id
     where r.org_id = $1 and r.access_revoked_at is null and consent.status = 'granted'
       and r.created_at >= now() - make_interval(days => $2::int)
     order by r.created_at desc, r.id desc limit $3`,
    [orgId, days, SAFETY_MAP_CASE_LIMIT + 1],
  );
  return { records: rows.slice(0, SAFETY_MAP_CASE_LIMIT), truncated: rows.length > SAFETY_MAP_CASE_LIMIT };
}
