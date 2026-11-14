import type { PoolClient } from 'pg';
import { pool, query } from '../plugins/db.js';
import type { PrivacyControls } from '../config/privacyControls.js';

export async function retentionTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query("set local lock_timeout = '2s'; set local statement_timeout = '10s'; set local idle_in_transaction_session_timeout = '30s'");
    const result = await work(client);
    await client.query('commit'); client.release(); return result;
  } catch (error) { client.release(error instanceof Error ? error : true); throw error; }
}

export async function verifyRecordedRetentionPolicies(controls: PrivacyControls): Promise<void> {
  for (const id of ['submitted-case-pending-legal-v1', 'partner-access-after-close-v1', 'partner-audit-v1']) {
    const policy = controls.retentionPolicies.find(p => p.policyId === id && p.scope === 'server');
    if (!policy?.executionEnabled || !policy.approvalStatus.startsWith('approved_') || !policy.durationDays) throw new Error('Retention execution is not approved');
    const { rows } = await query(`select 1 from saferide.retention_policies where policy_id = $1 and scope = 'server'
      and duration_days = $2 and execution_enabled and approval_status = $3 and policy_version = $4`,
      [id, policy.durationDays, policy.approvalStatus, controls.controlVersion]);
    if (rows.length !== 1) throw new Error('Recorded retention policy does not match the compiled controls');
  }
}

export type PurgeCounts = { cases: number; drafts: number; chat: number; abandonedUploads: number; partnerAccess: number; audit: number };
export async function purgeExpiredPrivacyRows(params: { mode: 'dry-run' | 'enforce'; caseCutoff: Date; partnerCutoff: Date; auditCutoff: Date; batch: number; onlyOwnerIds?: string[] }): Promise<PurgeCounts> {
  const counts: PurgeCounts = { cases: 0, drafts: 0, chat: 0, abandonedUploads: 0, partnerAccess: 0, audit: 0 };
  return retentionTransaction(async client => {
    // Fixed identifiers only; all values and cutoffs are bound parameters.
    const scopes = [
      ['partnerAccess', 'partner_referrals', 'status_changed_at', "status = 'closed'", params.partnerCutoff],
      ['cases', 'cases', 'created_at', 'true', params.caseCutoff],
      ['drafts', 'drafts', 'updated_at', "not exists(select 1 from saferide.cases c where c.draft_id = t.id)", params.caseCutoff],
      ['chat', 'chat_sessions', 'last_activity', 'true', params.caseCutoff],
      ['abandonedUploads', 'attachments', 'created_at', "status = 'pending_upload'", params.caseCutoff],
    ] as const;
    for (const [name, table, time, condition, cutoff] of scopes) {
      const where = `t.${time} <= $1 and ${condition} and not saferide.privacy_owner_held(t.owner_id) and ($2::uuid[] is null or t.owner_id = any($2))`;
      const result = params.mode === 'dry-run'
        ? await client.query<{ total: number }>(`select count(*)::int as total from saferide.${table} t where ${where}`, [cutoff, params.onlyOwnerIds ?? null])
        : await client.query(`delete from saferide.${table} where id in (select t.id from saferide.${table} t where ${where} order by t.${time}, t.id limit $3 for update skip locked) returning id`, [cutoff, params.onlyOwnerIds ?? null, params.batch]);
      counts[name] = params.mode === 'dry-run' ? Number(result.rows[0].total) : result.rows.length;
    }
    if (params.onlyOwnerIds) return counts; // scoped synthetic rehearsal never trims unrelated audit rows
    if (params.mode === 'dry-run') {
      counts.audit = Number((await client.query('select count(*)::int as total from saferide.partner_access_audit where created_at <= $1', [params.auditCutoff])).rows[0].total);
    } else counts.audit = Number((await client.query('select saferide.trim_expired_partner_audit($1) as removed', [params.batch])).rows[0].removed);
    return counts;
  });
}

export type PurgeObject = { id: string; owner_id: string; bucket: string; object_key: string; object_kind: 'original' | 'derivative'; attempts: number };

/** Holds the owner lock through an abortable storage request, so a legal hold
 * cannot race a delete already accepted under the same owner lock. */
export async function purgeOnePrivacyObject(remove: (object: PurgeObject) => Promise<void>, onlyOwnerIds?: string[]): Promise<'idle' | 'deleted' | 'retry' | 'held'> {
  return retentionTransaction(async client => {
    const { rows } = await client.query<PurgeObject>(`select p.id, p.owner_id, p.bucket, p.object_key, p.object_kind, p.attempts
      from saferide.privacy_object_purges p where completed_at is null and next_attempt_at <= now()
        and not saferide.privacy_owner_held(p.owner_id) and ($1::uuid[] is null or p.owner_id = any($1))
      order by created_at, id limit 1 for update skip locked`, [onlyOwnerIds ?? null]);
    const object = rows[0];
    if (!object) return 'idle';
    const lock = await client.query<{ acquired: boolean }>('select pg_try_advisory_xact_lock(hashtextextended($1, 3878)) as acquired', [object.owner_id]);
    if (!lock.rows[0].acquired || (await client.query<{ held: boolean }>('select saferide.privacy_owner_held($1) as held', [object.owner_id])).rows[0].held) return 'held';
    try {
      await remove(object);
      // Delete immediately, then once again after the five-minute upload URL
      // and gateway's five-minute upstream window have elapsed. Until that
      // second pass the durable entry remains pending, not a completed erasure.
      await client.query(`update saferide.privacy_object_purges set
        completed_at = case when now() >= created_at + interval '10 minutes' then now() else null end,
        next_attempt_at = greatest(now() + interval '1 minute', created_at + interval '10 minutes'),
        attempts = attempts + 1 where id = $1`, [object.id]);
      return 'deleted';
    } catch {
      await client.query(`update saferide.privacy_object_purges set attempts = attempts + 1,
        next_attempt_at = now() + make_interval(secs => $2::double precision) where id = $1`, [object.id, Math.min(3600, 30 * 2 ** Math.min(object.attempts, 7))]);
      return 'retry';
    }
  });
}

/** A verified deletion request removes report data, not the sign-in account.
 * Only content-free receipts remain; storage completion is checked separately. */
export async function purgeVerifiedOwnerReports(requestId: string): Promise<{ ownerId: string; held: boolean; changed: boolean }> {
  return retentionTransaction(async client => {
    const { rows } = await client.query<{ owner_id: string; status: string }>('select owner_id, status from saferide.dsar_requests where id = $1 and request_type = $2 for update', [requestId, 'deletion']);
    const request = rows[0];
    if (!request || !['verified', 'executing', 'partially_completed'].includes(request.status)) throw new Error('Deletion request is not verified for execution');
    await client.query('select pg_advisory_xact_lock(hashtextextended($1, 3878))', [request.owner_id]);
    if ((await client.query<{ held: boolean }>('select saferide.privacy_owner_held($1) as held', [request.owner_id])).rows[0].held) return { ownerId: request.owner_id, held: true, changed: false };
    await client.query("update saferide.dsar_requests set status = 'executing' where id = $1", [requestId]);
    // Cases first: cascades erase reports/events, attachments and all partner access.
    // Attachment triggers preserve every original/derivative storage key durably.
    for (const table of ['cases', 'drafts', 'chat_sessions', 'policy_acceptances', 'consent_records']) {
      await client.query(`delete from saferide.${table} where owner_id = $1`, [request.owner_id]);
    }
    return { ownerId: request.owner_id, held: false, changed: true };
  });
}

export async function pendingOwnerObjectPurges(ownerId: string): Promise<number> {
  return Number((await query('select count(*)::int as total from saferide.privacy_object_purges where owner_id = $1 and completed_at is null', [ownerId])).rows[0].total);
}
