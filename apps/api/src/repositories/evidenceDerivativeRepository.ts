/**
 * Evidence derivative records (migration 009). Every write is guarded in the
 * statement itself: a claim only picks released evidence, and completion or
 * closure only lands for the worker that still holds the claim token.
 */
import { pool, query } from '../plugins/db.js';
import type { AttachmentRow } from './caseRepository.js';

export type EvidenceDerivativeStatus = 'processing' | 'ready' | 'unsupported' | 'failed';

export type EvidenceDerivativeRow = {
  id: string;
  attachment_id: string;
  retention_policy_id: string;
  bucket: string;
  object_key: string;
  source_sha256: string;
  status: EvidenceDerivativeStatus;
  source_format: string | null;
  method: string | null;
  mime_type: string | null;
  derivative_sha256: string | null;
  size_bytes: string | number | null;
  removed_categories: string[];
  outcome_reason: string | null;
  attempts: number;
  claim_token: string | null;
  claimed_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

export type EvidenceDerivativeClaim = {
  derivativeId: string;
  attachmentId: string;
  claimToken: string;
  objectKey: string;
  sourceSha256: string;
  attempts: number;
  attachmentBucket: string;
  attachmentObjectKey: string;
  attachmentMimeType: string | null;
  attachmentSizeBytes: number | null;
};

const RELEASED = `
  attachment.status = 'uploaded'
  and attachment.antivirus_status = 'clean'
  and attachment.quarantine_status = 'released'
  and attachment.sha256 ~ '^[a-fA-F0-9]{64}$'
`;

/** Serialises the actual storage write with report deletion and legal holds.
 * Rechecking a claim without retaining these locks would allow a late write
 * to recreate an object after the deletion outbox had finished. */
export async function withActiveEvidenceDerivativeWrite(claim: EvidenceDerivativeClaim, write: () => Promise<void>): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query("set local lock_timeout = '2s'; set local statement_timeout = '5s'; set local idle_in_transaction_session_timeout = '30s'");
    const owner = await client.query<{ owner_id: string }>('select owner_id from saferide.attachments where id = $1', [claim.attachmentId]);
    if (!owner.rows[0]) { await client.query('rollback'); client.release(); return false; }
    await client.query('select pg_advisory_xact_lock(hashtextextended($1, 3878))', [owner.rows[0].owner_id]);
    const live = await client.query(`select attachment.id from saferide.attachments attachment
      join saferide.evidence_derivatives derivative on derivative.attachment_id = attachment.id
      where attachment.id = $1 and derivative.id = $2 and derivative.claim_token = $3
        and derivative.status = 'processing' and ${RELEASED} and lower(attachment.sha256) = $4
        and not saferide.privacy_owner_held(attachment.owner_id) for update of attachment, derivative`,
      [claim.attachmentId, claim.derivativeId, claim.claimToken, claim.sourceSha256]);
    if (!live.rows.length) { await client.query('rollback'); client.release(); return false; }
    await write();
    await client.query('commit'); client.release(); return true;
  } catch (error) { client.release(error instanceof Error ? error : true); throw error; }
}

export async function withInactiveEvidenceDerivativeCleanup(objectKey: string, remove: () => Promise<void>): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query("set local lock_timeout = '2s'; set local statement_timeout = '5s'; set local idle_in_transaction_session_timeout = '30s'");
    const owner = await client.query<{ owner_id: string }>(`select a.owner_id from saferide.attachments a join saferide.evidence_derivatives d on d.attachment_id = a.id where d.object_key = $1`, [objectKey]);
    if (!owner.rows[0]) { await client.query('rollback'); client.release(); return false; }
    await client.query('select pg_advisory_xact_lock(hashtextextended($1,3878))', [owner.rows[0].owner_id]);
    const safe = await client.query(`select d.id from saferide.evidence_derivatives d join saferide.attachments a on a.id = d.attachment_id
      where d.object_key = $1 and d.status in ('failed','unsupported') and not saferide.privacy_owner_held(a.owner_id) for update of a,d`, [objectKey]);
    if (!safe.rows.length) { await client.query('rollback'); client.release(); return false; }
    await remove(); await client.query('commit'); client.release(); return true;
  } catch(error) { client.release(error instanceof Error ? error : true); throw error; }
}

/**
 * Claims one released attachment that needs a derivative: none yet, made
 * from a different sha256, a stale claim, or a storage failure older than
 * `retryAfterSeconds`, each still within `maxAttempts`. Concurrent workers
 * never claim the same attachment.
 */
export async function claimNextEvidenceDerivative(params: {
  claimToken: string;
  newObjectKey: string;
  bucket: string;
  staleAfterSeconds: number;
  retryAfterSeconds: number;
  maxAttempts: number;
  /** Restricts the claim to these attachments (on-demand runs and tests). */
  onlyAttachmentIds?: string[];
}): Promise<EvidenceDerivativeClaim | null> {
  const reclaimable = (alias: string, sha: string) => `
    ${alias}.source_sha256 <> ${sha}
    or (${alias}.status = 'processing' and ${alias}.claimed_at < now() - make_interval(secs => $4::double precision)
      and ${alias}.attempts < $5)
    or (${alias}.status = 'failed' and ${alias}.outcome_reason = 'storage_error' and ${alias}.attempts < $5
      and ${alias}.completed_at < now() - make_interval(secs => $7::double precision))
  `;
  const { rows } = await query<{
    id: string;
    attachment_id: string;
    object_key: string;
    source_sha256: string;
    attempts: number;
    attachment_bucket: string;
    bucket_path: string;
    mime_type: string | null;
    size_bytes: number | null;
  }>(
    `
      with candidate as (
        select attachment.id, attachment.retention_policy_id, lower(attachment.sha256) as sha256,
          attachment.bucket as attachment_bucket, attachment.bucket_path, attachment.mime_type, attachment.size_bytes
        from saferide.attachments attachment
        left join saferide.evidence_derivatives derivative on derivative.attachment_id = attachment.id
        where ${RELEASED}
          and ($6::uuid[] is null or attachment.id = any($6::uuid[]))
          and (derivative.id is null or ${reclaimable('derivative', 'lower(attachment.sha256)')})
        order by attachment.updated_at, attachment.id
        limit 1
        for no key update of attachment skip locked
      ),
      claimed as (
        insert into saferide.evidence_derivatives (
          attachment_id, retention_policy_id, bucket, object_key, source_sha256, status, claim_token, claimed_at, attempts
        )
        select id, retention_policy_id, $3, $2, sha256, 'processing', $1::uuid, now(), 1 from candidate
        on conflict (attachment_id) do update
          set source_sha256 = excluded.source_sha256,
              status = 'processing',
              claim_token = excluded.claim_token,
              claimed_at = now(),
              attempts = case when evidence_derivatives.source_sha256 = excluded.source_sha256
                then evidence_derivatives.attempts + 1 else 1 end,
              source_format = null, method = null, mime_type = null, derivative_sha256 = null,
              size_bytes = null, removed_categories = '{}', outcome_reason = null, completed_at = null
          where ${reclaimable('evidence_derivatives', 'excluded.source_sha256')}
        returning id, attachment_id, object_key, source_sha256, attempts
      )
      select claimed.*, candidate.attachment_bucket, candidate.bucket_path, candidate.mime_type, candidate.size_bytes
      from claimed join candidate on candidate.id = claimed.attachment_id
    `,
    [
      params.claimToken, params.newObjectKey, params.bucket, params.staleAfterSeconds, params.maxAttempts,
      params.onlyAttachmentIds ?? null, params.retryAfterSeconds,
    ],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    derivativeId: row.id,
    attachmentId: row.attachment_id,
    claimToken: params.claimToken,
    objectKey: row.object_key,
    sourceSha256: row.source_sha256,
    attempts: row.attempts,
    attachmentBucket: row.attachment_bucket,
    attachmentObjectKey: row.bucket_path,
    attachmentMimeType: row.mime_type,
    attachmentSizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
  };
}

/**
 * Marks a claimed derivative ready. Lands only for the claim holder and only
 * while the attachment is still released with the derivative's source hash.
 */
export async function completeEvidenceDerivative(params: {
  derivativeId: string;
  claimToken: string;
  derivativeSha256: string;
  sizeBytes: number;
  method: string;
  mimeType: string;
  sourceFormat: string;
  removedCategories: string[];
}): Promise<boolean> {
  const { rowCount } = await query(
    `
      update saferide.evidence_derivatives derivative
      set status = 'ready', claim_token = null, completed_at = now(), outcome_reason = null,
          derivative_sha256 = $3, size_bytes = $4, method = $5, mime_type = $6, source_format = $7,
          removed_categories = $8::text[]
      where derivative.id = $1 and derivative.claim_token = $2::uuid and derivative.status = 'processing'
        and exists (
          select 1 from saferide.attachments attachment
          where attachment.id = derivative.attachment_id and ${RELEASED}
            and lower(attachment.sha256) = derivative.source_sha256
        )
    `,
    [
      params.derivativeId, params.claimToken, params.derivativeSha256, params.sizeBytes, params.method,
      params.mimeType, params.sourceFormat, params.removedCategories,
    ],
  );
  return rowCount === 1;
}

/** Closes a claim as unsupported or failed (never shareable). Lands only for the claim holder. */
export async function closeEvidenceDerivative(params: {
  derivativeId: string;
  claimToken: string;
  status: 'unsupported' | 'failed';
  reason: string;
  sourceFormat: string | null;
}): Promise<boolean> {
  const { rowCount } = await query(
    `
      update saferide.evidence_derivatives
      set status = $3, outcome_reason = $4, source_format = $5, claim_token = null, completed_at = now(),
          method = null, mime_type = null, derivative_sha256 = null, size_bytes = null, removed_categories = '{}'
      where id = $1 and claim_token = $2::uuid and status = 'processing'
    `,
    [params.derivativeId, params.claimToken, params.status, params.reason, params.sourceFormat],
  );
  return rowCount === 1;
}

/**
 * Stale claims that will not be retried: out of attempts (a worker kept
 * dying on the file) or the evidence is no longer released.
 */
export async function expireStaleEvidenceDerivativeClaims(params: {
  staleAfterSeconds: number;
  maxAttempts: number;
}): Promise<string[]> {
  const { rows } = await query<{ object_key: string }>(
    `
      update saferide.evidence_derivatives derivative
      set status = 'failed', claim_token = null, completed_at = now(),
          outcome_reason = case when exists (
            select 1 from saferide.attachments attachment
            where attachment.id = derivative.attachment_id and ${RELEASED}
          ) then 'processing_timeout' else 'source_unavailable' end
      where derivative.status = 'processing'
        and derivative.claimed_at < now() - make_interval(secs => $1::double precision)
        and (
          derivative.attempts >= $2
          or not exists (
            select 1 from saferide.attachments attachment
            where attachment.id = derivative.attachment_id and ${RELEASED}
          )
        )
      returning derivative.object_key
    `,
    [params.staleAfterSeconds, params.maxAttempts],
  );
  return rows.map(row => row.object_key);
}

export async function listEvidenceDerivativePurges(limit: number): Promise<Array<{ objectKey: string; bucket: string }>> {
  const { rows } = await query<{ object_key: string; bucket: string }>(
    `select object_key, bucket from saferide.evidence_derivative_object_purges order by queued_at, object_key limit $1`,
    [limit],
  );
  return rows.map(row => ({ objectKey: row.object_key, bucket: row.bucket }));
}

export async function deleteEvidenceDerivativePurge(objectKey: string): Promise<void> {
  await query(`delete from saferide.evidence_derivative_object_purges where object_key = $1`, [objectKey]);
}

/** The attachments and their derivative rows, for the shareability decision. */
export async function findAttachmentsWithDerivatives(attachmentIds: string[]): Promise<{
  attachments: AttachmentRow[];
  derivatives: EvidenceDerivativeRow[];
}> {
  if (attachmentIds.length === 0) return { attachments: [], derivatives: [] };
  const [attachments, derivatives] = await Promise.all([
    query<AttachmentRow>(`select * from saferide.attachments where id = any($1::uuid[])`, [attachmentIds]),
    query<EvidenceDerivativeRow>(`select * from saferide.evidence_derivatives where attachment_id = any($1::uuid[])`, [attachmentIds]),
  ]);
  return { attachments: attachments.rows, derivatives: derivatives.rows };
}
