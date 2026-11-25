import { randomUUID } from 'node:crypto';
import { query } from '../plugins/db.js';
import { withPartnerAuthTransaction } from './partnerAuthRepository.js';
import { recordPartnerAccess } from './partnerRepository.js';
import type { PartnerSession } from '../middleware/partnerSession.js';
import { conflict } from '../http/errors.js';

export type PushSubscriptionStatus = { enabled: boolean; lastAcceptedAt: string | null; lastOutcome: string | null };
export async function partnerPushStatus(sessionId: string): Promise<PushSubscriptionStatus> {
  const { rows } = await query<{ last_accepted_at: Date | null; last_outcome: string | null }>(
    'select last_accepted_at, last_outcome from saferide.partner_push_subscriptions where session_id = $1', [sessionId]);
  return { enabled: rows.length > 0, lastAcceptedAt: rows[0]?.last_accepted_at?.toISOString() ?? null, lastOutcome: rows[0]?.last_outcome ?? null };
}

export async function subscribePartnerPush(session: PartnerSession, input: { hash: string; sealed: string; requestId: string }): Promise<void> {
  await withPartnerAuthTransaction(async client => {
    await client.query('select id from saferide.partner_users where id = $1 for update', [session.userId]);
    await client.query(`delete from saferide.partner_push_subscriptions p where p.user_id = $1 and not exists (
      select 1 from saferide.partner_sessions s where s.id = p.session_id and s.revoked_at is null and s.idle_expires_at > now() and s.absolute_expires_at > now())`, [session.userId]);
    await client.query('delete from saferide.partner_push_subscriptions where session_id = $1 or endpoint_hash = $2', [session.sessionId, input.hash]);
    const { rows } = await client.query<{ count: number }>('select count(*)::int as count from saferide.partner_push_subscriptions where user_id = $1', [session.userId]);
    if (rows[0].count >= 10) throw conflict('Notification device limit reached. Sign out unused devices first.');
    await client.query(`insert into saferide.partner_push_subscriptions(user_id, org_id, session_id, endpoint_hash, subscription_enc)
      values ($1, $2, $3, $4, $5)`, [session.userId, session.orgId, session.sessionId, input.hash, input.sealed]);
    await recordPartnerAccess({ orgId: session.orgId, actor: { type: 'partner_user', userId: session.userId }, action: 'partner.push.subscribe', outcome: 'success', requestId: input.requestId }, client);
  });
}

export async function unsubscribePartnerPush(session: PartnerSession, requestId: string): Promise<void> {
  await withPartnerAuthTransaction(async client => {
    await client.query('delete from saferide.partner_push_subscriptions where session_id = $1 and user_id = $2', [session.sessionId, session.userId]);
    await recordPartnerAccess({ orgId: session.orgId, actor: { type: 'partner_user', userId: session.userId }, action: 'partner.push.unsubscribe', outcome: 'success', requestId }, client);
  });
}

export async function enqueuePartnerPushTest(session: PartnerSession, requestId: string): Promise<boolean> {
  return withPartnerAuthTransaction(async client => {
    const { rows } = await client.query(`insert into saferide.partner_push_jobs(subscription_id, kind)
      select id, 'test' from saferide.partner_push_subscriptions s where session_id = $1
      and not exists(select 1 from saferide.partner_push_jobs j where j.subscription_id = s.id and j.kind = 'test') returning id`, [session.sessionId]);
    await recordPartnerAccess({ orgId: session.orgId, actor: { type: 'partner_user', userId: session.userId }, action: 'partner.push.test', outcome: 'success', requestId }, client);
    return rows.length > 0;
  });
}

const LIVE_SESSION = `s.revoked_at is null and s.idle_expires_at > now() and s.absolute_expires_at > now()
  and u.status = 'active' and not u.must_change_password and o.status = 'active'
  and (s.mfa_verified or (s.mfa_waived and not o.mfa_required))`;

export type PushJob = { id: string; subscription_id: string; user_id: string; endpoint_hash: string; subscription_enc: string; kind: 'test' | 'attention'; attempts: number; claim_token: string };

/** A withdrawal, expired session or disabled account suppresses queued delivery. */
export async function claimPartnerPushJob(): Promise<PushJob | null> {
  return withPartnerAuthTransaction(async client => {
    await client.query(`delete from saferide.partner_push_subscriptions p where not exists (
      select 1 from saferide.partner_sessions s join saferide.partner_users u on u.id = s.user_id
      join saferide.partner_organizations o on o.id = s.org_id where s.id = p.session_id and ${LIVE_SESSION})`);
    await client.query(`delete from saferide.partner_push_jobs j where attempts >= 5 or created_at < now() - interval '1 day'
      or (kind = 'attention' and not exists(select 1 from saferide.partner_referrals r
        join saferide.consent_records c on c.id = r.consent_record_id
        join saferide.partner_push_subscriptions p on p.id = j.subscription_id
        where r.id = j.referral_id and r.org_id = p.org_id and r.access_revoked_at is null and c.status = 'granted' and r.status = 'new'))`);
    const { rows } = await client.query<PushJob>(`with due as (
      select j.id from saferide.partner_push_jobs j join saferide.partner_push_subscriptions p on p.id = j.subscription_id
      where j.next_attempt_at <= now() and (j.claim_until is null or j.claim_until < now())
        and (p.last_accepted_at is null or p.last_accepted_at < now() - interval '30 seconds')
      order by j.created_at, j.id for update of j skip locked limit 1
    ) update saferide.partner_push_jobs j set claim_token = $1, claim_until = now() + interval '60 seconds', attempts = j.attempts + 1
      from due, saferide.partner_push_subscriptions p where j.id = due.id and p.id = j.subscription_id
      returning j.id, j.subscription_id, p.user_id, p.endpoint_hash, p.subscription_enc, j.kind, j.attempts, j.claim_token`, [randomUUID()]);
    return rows[0] ?? null;
  });
}

export async function settlePartnerPushJob(job: PushJob, outcome: 'accepted' | 'expired' | 'retry' | 'refused'): Promise<void> {
  await withPartnerAuthTransaction(async client => {
    const locked = await client.query('select id from saferide.partner_push_jobs where id = $1 and claim_token = $2 for update', [job.id, job.claim_token]);
    if (!locked.rows.length) return;
    if (outcome === 'expired') {
      await client.query('delete from saferide.partner_push_subscriptions where id = $1', [job.subscription_id]);
      return;
    }
    await client.query(`update saferide.partner_push_subscriptions set last_outcome = $2,
      last_accepted_at = case when $2 = 'accepted' then now() else last_accepted_at end where id = $1`, [job.subscription_id, outcome]);
    if (outcome === 'accepted' || outcome === 'refused' || job.attempts >= 5) {
      await client.query('delete from saferide.partner_push_jobs where id = $1', [job.id]);
    } else await client.query(`update saferide.partner_push_jobs set claim_token = null, claim_until = null,
      next_attempt_at = now() + make_interval(secs => $2::double precision) where id = $1`, [job.id, Math.min(3600, 30 * 2 ** job.attempts)]);
  });
}
