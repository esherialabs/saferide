/**
 * The evidence malware scan queue (migration 015): uploaded attachments
 * whose antivirus status is `pending`. The worker claims one at a time with
 * a lease, so a crashed worker's claim lapses and the item is retried.
 */
import { query } from '../plugins/db.js';

export type EvidenceScanClaim = {
  id: string;
  owner_id: string;
  bucket_path: string;
  sha256: string;
  size_bytes: number | null;
  /** This attempt's number (1 for the first). */
  scan_attempts: number;
};

export type EvidenceScanOutcome = 'clean' | 'infected' | 'error';

/**
 * Claims the next due attachment: uploaded, scan pending, not claimed (or
 * its claim lapsed) and past its retry time. Counts the attempt.
 */
export async function claimNextEvidenceScan(params: {
  claimToken: string;
  leaseSeconds: number;
  /** Restricts the claim to these attachments (tests). */
  onlyAttachmentIds?: string[];
}): Promise<EvidenceScanClaim | null> {
  const { rows } = await query<EvidenceScanClaim>(
    `
      with candidate as (
        select id
        from saferide.attachments
        where status = 'uploaded'
          and antivirus_status = 'pending'
          and sha256 ~ '^[a-f0-9]{64}$'
          and (scan_next_attempt_at is null or scan_next_attempt_at <= now())
          and (scan_claimed_at is null or scan_claimed_at < now() - make_interval(secs => $2::double precision))
          and ($3::uuid[] is null or id = any($3::uuid[]))
        order by scan_next_attempt_at nulls first, updated_at, id
        limit 1
        for no key update skip locked
      )
      update saferide.attachments attachment
      set scan_claim_token = $1::uuid,
          scan_claimed_at = now(),
          scan_attempts = attachment.scan_attempts + 1
      from candidate
      where attachment.id = candidate.id
      returning attachment.id, attachment.owner_id, attachment.bucket_path, attachment.sha256,
        attachment.size_bytes, attachment.scan_attempts
    `,
    [params.claimToken, params.leaseSeconds, params.onlyAttachmentIds ?? null],
  );
  return rows[0] ?? null;
}

/** Leaves the attachment pending and quarantined, due again at `nextAttemptAt`. */
export async function scheduleEvidenceScanRetry(params: {
  attachmentId: string;
  claimToken: string;
  nextAttemptAt: Date;
}): Promise<boolean> {
  const { rowCount } = await query(
    `
      update saferide.attachments
      set scan_next_attempt_at = $3,
          scan_claim_token = null,
          scan_claimed_at = null
      where id = $1 and scan_claim_token = $2::uuid and antivirus_status = 'pending'
    `,
    [params.attachmentId, params.claimToken, params.nextAttemptAt],
  );
  return (rowCount ?? 0) > 0;
}

/** Fail closed: no verdict after the last attempt. Stays quarantined, never released. */
export async function markEvidenceScanFailed(params: { attachmentId: string; claimToken: string }): Promise<boolean> {
  const { rowCount } = await query(
    `
      update saferide.attachments
      set antivirus_status = 'failed',
          quarantine_status = 'quarantined',
          scan_next_attempt_at = null,
          scan_claim_token = null,
          scan_claimed_at = null,
          updated_at = now()
      where id = $1 and scan_claim_token = $2::uuid and antivirus_status = 'pending'
    `,
    [params.attachmentId, params.claimToken],
  );
  return (rowCount ?? 0) > 0;
}

/** One row per attempt: who scanned, with which signatures, and what came of it. */
export async function recordEvidenceMalwareScanAttempt(params: {
  attachmentId: string;
  attempt: number;
  scanner: string | null;
  definitionVersion: string | null;
  objectSha256: string | null;
  outcome: EvidenceScanOutcome;
  signature?: string | null;
  errorCode?: string | null;
  startedAt: Date;
}): Promise<void> {
  await query(
    `
      insert into saferide.evidence_malware_scans (
        attachment_id, attempt, scanner, definition_version, object_sha256,
        outcome, signature, error_code, started_at
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `,
    [
      params.attachmentId,
      params.attempt,
      params.scanner,
      params.definitionVersion,
      params.objectSha256,
      params.outcome,
      params.signature ?? null,
      params.errorCode ?? null,
      params.startedAt,
    ],
  );
}

/** Counts for operators (saferide.sh status): never identifiers. */
export async function countEvidenceScanQueue(): Promise<{ pending: number; due: number; failed: number }> {
  const { rows } = await query<{ pending: string; due: string; failed: string }>(
    `
      select
        count(*) filter (where antivirus_status = 'pending') as pending,
        count(*) filter (where antivirus_status = 'pending'
          and (scan_next_attempt_at is null or scan_next_attempt_at <= now())) as due,
        count(*) filter (where antivirus_status = 'failed') as failed
      from saferide.attachments
      where status = 'uploaded' and antivirus_status in ('pending', 'failed')
    `,
  );
  return {
    pending: Number(rows[0]?.pending ?? 0),
    due: Number(rows[0]?.due ?? 0),
    failed: Number(rows[0]?.failed ?? 0),
  };
}
