import type { PoolClient } from 'pg';

import { pool, query } from '../plugins/db.js';
import { generatePartnerReference } from '../services/partnerTokens.js';
import { findPartnerOrgOpenForIntake } from './partnerRepository.js';

export type CaseRow = {
  id: string;
  owner_id: string;
  draft_id: string | null;
  pathway: string | null;
  status: string;
  summary: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};

export type AttachmentRow = {
  id: string;
  owner_id: string;
  draft_id: string | null;
  case_id: string | null;
  bucket: string;
  bucket_path: string;
  mime_type: string | null;
  size_bytes: number | null;
  sha256: string | null;
  expected_sha256: string | null;
  upload_manifest: Record<string, unknown>;
  retention: Record<string, unknown>;
  retention_policy_id: string | null;
  antivirus_status: string;
  quarantine_status: string;
  scan_evidence: Record<string, unknown> | null;
  scan_attempts?: number;
  scan_next_attempt_at?: string | null;
  status: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};

export type CaseEventRow = {
  id: string;
  case_id: string;
  owner_id: string | null;
  event_type: string;
  payload: Record<string, unknown> | null;
  request_id: string | null;
  created_at: string;
};

export class CaseSubmissionConflictError extends Error {
  constructor() {
    super('Case submission idempotency or consent identity conflicts with an existing record');
    this.name = 'CaseSubmissionConflictError';
  }
}

export type PartnerRoutingRejection = 'partner_not_accepting' | 'partner_consent_missing' | 'callback_consent_missing';

/** The survivor chose a partner, but the partner or a consent does not allow routing right now. */
export class PartnerRoutingRejectedError extends Error {
  readonly reason: PartnerRoutingRejection;

  constructor(reason: PartnerRoutingRejection) {
    super(`Partner routing rejected: ${reason}`);
    this.name = 'PartnerRoutingRejectedError';
    this.reason = reason;
  }
}

/** One entry of the packet's evidence manifest, as shared at routing time (no device ids or names). */
export type SharedEvidenceEntry = {
  manifestIndex: number;
  mediaType: 'photo' | 'video' | 'audio' | 'document';
  /** Lower-case sha256 from the packet, or null when the packet withholds it (heavy redaction). */
  sha256: string | null;
};

export type CasePartnerRouting = {
  partnerStableId: string;
  /** The evidence the survivor's packet listed; only files matching these hashes are ever shown to the partner. */
  sharedEvidence: SharedEvidenceEntry[];
  /** Granted, unused partner_follow_up consent of the same owner. */
  consentRecordId: string;
  /** The partner_follow_up version the privacy controls currently enable. */
  consentVersion: string;
  callback?: {
    /** Granted, unused partner_callback consent of the same owner. */
    consentRecordId: string;
    consentVersion: string;
    /** Seals the already-validated number for exactly this referral (services/partnerCallbackSeal.ts). */
    seal: (referralId: string) => string;
  };
};

export type RoutedPartnerReferral = {
  partnerStableId: string;
  reference: string;
  status: string;
  callbackShared: boolean;
};

export type CaseSubmissionResult = {
  caseRecord: CaseRow;
  partnerReferral: RoutedPartnerReferral | null;
};

const MAX_REFERENCE_ATTEMPTS = 5;

/**
 * Inserts the referral with a random SR- reference, drawing a new one if it
 * clashes with an existing reference (savepoint, so the submission survives).
 */
async function insertReferralWithFreshReference(
  client: PoolClient,
  values: [caseId: string, ownerId: string, orgId: string, consentRecordId: string],
): Promise<{ id: string; reference: string; status: string }> {
  for (let attempt = 1; ; attempt += 1) {
    await client.query('savepoint partner_reference');
    try {
      const { rows } = await client.query<{ id: string; reference: string; status: string }>(
        `
          insert into saferide.partner_referrals (case_id, owner_id, org_id, consent_record_id, reference)
          values ($1, $2, $3, $4, $5)
          returning id, reference, status
        `,
        [...values, generatePartnerReference()],
      );
      await client.query('release savepoint partner_reference');
      return rows[0];
    } catch (error) {
      const pgError = error as { code?: string; constraint?: string };
      if (pgError?.code === '23505' && pgError.constraint === 'partner_referrals_reference_key' && attempt < MAX_REFERENCE_ATTEMPTS) {
        await client.query('rollback to savepoint partner_reference');
        continue;
      }
      throw error;
    }
  }
}

/**
 * Maps the database's own routing guards (migration 007) to a rejection, for
 * races the explicit checks cannot see: a concurrent submission using the
 * same consent, a withdrawal, or intake closing mid-transaction.
 */
function toPartnerRoutingRejection(error: unknown): PartnerRoutingRejectedError | null {
  const pgError = error as { code?: string; constraint?: string; message?: string };
  if (pgError?.code === '23505' && pgError.constraint === 'partner_referrals_consent_record_id_key') {
    return new PartnerRoutingRejectedError('partner_consent_missing');
  }
  if (pgError?.code === '23505' && pgError.constraint === 'partner_referral_callbacks_consent_record_id_key') {
    return new PartnerRoutingRejectedError('callback_consent_missing');
  }
  if (pgError?.code === 'P0001' && pgError.message === 'partner organisation is not open for intake') {
    return new PartnerRoutingRejectedError('partner_not_accepting');
  }
  if (pgError?.code === 'P0001' && pgError.message === 'partner referral requires granted partner_follow_up consent') {
    return new PartnerRoutingRejectedError('partner_consent_missing');
  }
  if (pgError?.code === 'P0001' && pgError.message === 'partner callback requires granted partner_callback consent') {
    return new PartnerRoutingRejectedError('callback_consent_missing');
  }
  return null;
}

/**
 * Creates the partner referral for a just-submitted case inside the
 * submission transaction. A retried submission returns the referral made
 * the first time; nothing is routed twice.
 */
async function routeCaseToPartner(client: PoolClient, params: {
  caseId: string;
  ownerId: string;
  routing: CasePartnerRouting;
  requestId: string;
  policyVersion: string;
}): Promise<RoutedPartnerReferral> {
  const { routing } = params;
  const existing = await client.query<{ consent_record_id: string; reference: string; status: string; callback_shared: boolean }>(
    `
      select referral.consent_record_id, referral.reference, referral.status,
        exists (select 1 from saferide.partner_referral_callbacks callback where callback.referral_id = referral.id) as callback_shared
      from saferide.partner_referrals referral
      join saferide.partner_organizations org on org.id = referral.org_id
      where referral.case_id = $1 and referral.owner_id = $2 and org.stable_id = $3
    `,
    [params.caseId, params.ownerId, routing.partnerStableId],
  );
  if (existing.rows[0]) {
    if (existing.rows[0].consent_record_id !== routing.consentRecordId) throw new CaseSubmissionConflictError();
    return {
      partnerStableId: routing.partnerStableId,
      reference: existing.rows[0].reference,
      status: existing.rows[0].status,
      callbackShared: existing.rows[0].callback_shared,
    };
  }

  // Locked FOR SHARE so intake cannot be switched off underneath this routing;
  // migration 007 also re-checks intake on the insert itself.
  const org = await findPartnerOrgOpenForIntake(routing.partnerStableId, client, { lockForShare: true });
  if (!org) throw new PartnerRoutingRejectedError('partner_not_accepting');
  const orgId = org.id;

  const consentQuery = `
    select consent.id from saferide.consent_records consent
    where consent.id = $1 and consent.owner_id = $2 and consent.purpose = $3
      and consent.status = 'granted' and consent.consent_version = $4
      and not exists (select 1 from saferide.partner_referrals referral where referral.consent_record_id = consent.id)
      and not exists (select 1 from saferide.partner_referral_callbacks callback where callback.consent_record_id = consent.id)
    for update
  `;
  const followUp = await client.query(consentQuery, [
    routing.consentRecordId, params.ownerId, 'partner_follow_up', routing.consentVersion,
  ]);
  if (followUp.rows.length !== 1) throw new PartnerRoutingRejectedError('partner_consent_missing');
  if (routing.callback) {
    const callbackConsent = await client.query(consentQuery, [
      routing.callback.consentRecordId, params.ownerId, 'partner_callback', routing.callback.consentVersion,
    ]);
    if (callbackConsent.rows.length !== 1) throw new PartnerRoutingRejectedError('callback_consent_missing');
  }

  const routed = await insertReferralWithFreshReference(client, [params.caseId, params.ownerId, orgId, routing.consentRecordId]);

  if (routing.sharedEvidence.length > 0) {
    await client.query(
      `
        insert into saferide.partner_referral_evidence (referral_id, org_id, manifest_index, media_type, sha256)
        select $1, $2, item.manifest_index, item.media_type, item.sha256
        from unnest($3::int[], $4::text[], $5::text[]) as item(manifest_index, media_type, sha256)
      `,
      [
        routed.id,
        orgId,
        routing.sharedEvidence.map(entry => entry.manifestIndex),
        routing.sharedEvidence.map(entry => entry.mediaType),
        routing.sharedEvidence.map(entry => entry.sha256),
      ],
    );
  }

  if (routing.callback) {
    await client.query(
      `
        insert into saferide.partner_referral_callbacks (referral_id, org_id, owner_id, consent_record_id, phone_enc)
        values ($1, $2, $3, $4, $5)
      `,
      [routed.id, orgId, params.ownerId, routing.callback.consentRecordId, routing.callback.seal(routed.id)],
    );
  }

  // The survivor's own timeline: which partner and the reference to quote. No content.
  await client.query(
    `
      insert into saferide.case_events (case_id, owner_id, event_type, payload, request_id)
      values ($1, $2, 'partner_routed', $3, $4)
    `,
    [
      params.caseId,
      params.ownerId,
      {
        schemaVersion: '1.0',
        partner: routing.partnerStableId,
        reference: routed.reference,
        partner_status: routed.status,
        callback_shared: Boolean(routing.callback),
      },
      params.requestId,
    ],
  );

  await client.query(
    `
      insert into saferide.audit_events (
        action, resource_type, request_id, outcome, policy_version
      ) values ('case.partner_route', 'partner_referral', $1, 'success', $2)
    `,
    [params.requestId, params.policyVersion],
  );

  return {
    partnerStableId: routing.partnerStableId,
    reference: routed.reference,
    status: routed.status,
    callbackShared: Boolean(routing.callback),
  };
}

export async function submitCaseTransaction(params: {
  ownerId: string;
  draftId?: string | null;
  pathway: string;
  summary: Record<string, unknown>;
  lifecyclePayload: Record<string, unknown>;
  consentRecordId: string;
  consentPurpose: 'pathway_submission';
  consentVersion: string;
  idempotencyKey: string;
  requestId: string;
  policyVersion: string;
  partnerRouting?: CasePartnerRouting;
}): Promise<CaseSubmissionResult> {
  const client = await pool.connect();
  try {
    await client.query('begin');

    const consent = await client.query<{ id: string }>(
      `
        insert into saferide.consent_records (
          id, owner_id, purpose, consent_version, status, granted_at
        ) values ($1, $2, $3, $4, 'granted', now())
        on conflict (id) do update
          set id = excluded.id
          where saferide.consent_records.owner_id = excluded.owner_id
            and saferide.consent_records.purpose = excluded.purpose
            and saferide.consent_records.consent_version = excluded.consent_version
            and saferide.consent_records.status = 'granted'
        returning id
      `,
      [params.consentRecordId, params.ownerId, params.consentPurpose, params.consentVersion],
    );
    if (consent.rows.length !== 1) throw new CaseSubmissionConflictError();

    // The app keeps drafts on the phone and sends its local draft id. Link the
    // case only to a server draft this owner holds; otherwise keep no draft
    // link rather than refusing the report.
    const ownedDraft = params.draftId
      ? await client.query<{ id: string }>(
        'select id from saferide.drafts where owner_id = $1 and id = $2',
        [params.ownerId, params.draftId],
      )
      : null;
    const draftId = ownedDraft?.rows[0]?.id ?? null;

    let submissionSummary = params.summary;
    if (!params.partnerRouting) {
      // The first send may have committed while its response was lost. If
      // this owner retries the identical case without partner sharing, end
      // the original sharing atomically and return the existing case. Never
      // change its original consented packet or create a second referral.
      const prior = await client.query<CaseRow>(
        `select * from saferide.cases
         where owner_id = $1 and submission_idempotency_key = $2
           and draft_id is not distinct from $3::text
           and pathway is not distinct from $4::text and consent_record_id = $5
           and summary ? 'partnerRouting' and summary - 'partnerRouting' = $6::jsonb
         for update`,
        [params.ownerId, params.idempotencyKey, draftId, params.pathway, params.consentRecordId, params.summary],
      );
      if (prior.rows[0]) {
        await client.query(
          `with shared_consents as materialized (
             select referral.consent_record_id as id
             from saferide.partner_referrals referral where referral.case_id = $1 and referral.owner_id = $2
             union
             select callback.consent_record_id as id
             from saferide.partner_referral_callbacks callback
             join saferide.partner_referrals referral on referral.id = callback.referral_id
             where referral.case_id = $1 and referral.owner_id = $2
           )
           update saferide.consent_records set status = 'withdrawn', withdrawn_at = now()
           where owner_id = $2 and status = 'granted' and id in (select id from shared_consents)`,
          [prior.rows[0].id, params.ownerId],
        );
        submissionSummary = prior.rows[0].summary!;
      }
    }

    const submitted = await client.query<CaseRow>(
      `
        insert into saferide.cases (
          owner_id, draft_id, pathway, summary, consent_record_id, submission_idempotency_key
        )
        select
          $1,
          owned_draft.id,
          $3, $4, $5, $6
        from (select $2::text as requested_id) input
        left join saferide.drafts owned_draft
          on owned_draft.owner_id = $1 and owned_draft.id = input.requested_id
        where input.requested_id is null or owned_draft.id is not null
        on conflict (owner_id, submission_idempotency_key) where submission_idempotency_key is not null
        do update set submission_idempotency_key = excluded.submission_idempotency_key
          where saferide.cases.draft_id is not distinct from excluded.draft_id
            and saferide.cases.pathway is not distinct from excluded.pathway
            and saferide.cases.summary = excluded.summary
            and saferide.cases.consent_record_id = excluded.consent_record_id
        returning *
      `,
      [
        params.ownerId,
        draftId,
        params.pathway,
        submissionSummary,
        params.consentRecordId,
        params.idempotencyKey,
      ],
    );
    const caseRecord = submitted.rows[0];
    if (!caseRecord) throw new CaseSubmissionConflictError();

    await client.query(
      `
        insert into saferide.case_events (case_id, owner_id, event_type, payload, request_id)
        values ($1, $2, 'submission', $3, $4)
        on conflict (case_id, event_type) where event_type = 'submission' do nothing
      `,
      [caseRecord.id, params.ownerId, params.lifecyclePayload, params.requestId],
    );

    if (draftId) {
      await client.query(
        `
          update saferide.drafts
          set status = 'submitted', updated_at = now()
          where owner_id = $1 and id = $2
        `,
        [params.ownerId, draftId],
      );
    }

    const partnerReferral = params.partnerRouting
      ? await routeCaseToPartner(client, {
          caseId: caseRecord.id,
          ownerId: params.ownerId,
          routing: params.partnerRouting,
          requestId: params.requestId,
          policyVersion: params.policyVersion,
        })
      : null;

    await client.query(
      `
        insert into saferide.audit_events (
          action, resource_type, request_id, outcome, policy_version
        ) values ('case.create', 'case', $1, 'success', $2)
      `,
      [params.requestId, params.policyVersion],
    );

    await client.query('commit');
    return { caseRecord, partnerReferral };
  } catch (error) {
    await client.query('rollback');
    throw toPartnerRoutingRejection(error) ?? error;
  } finally {
    client.release();
  }
}

export async function listCases(ownerId: string): Promise<CaseRow[]> {
  const { rows } = await query<CaseRow>(
    `
      select *
      from saferide.cases
      where owner_id = $1
      order by created_at desc
    `,
    [ownerId],
  );
  return rows;
}

export async function createCase(params: {
  ownerId: string;
  draftId?: string | null;
  pathway?: string | null;
  summary?: Record<string, unknown> | null;
}): Promise<CaseRow> {
  const { rows } = await query<CaseRow>(
    `
      insert into saferide.cases (owner_id, draft_id, pathway, summary)
      values (
        $1,
        (select id from saferide.drafts where owner_id = $1 and id = $2),
        $3,
        $4
      )
      returning *
    `,
    [params.ownerId, params.draftId ?? null, params.pathway ?? null, params.summary ?? null],
  );
  return rows[0];
}

export async function getCase(ownerId: string, caseId: string): Promise<CaseRow | null> {
  const { rows } = await query<CaseRow>(
    `
      select *
      from saferide.cases
      where owner_id = $1 and id = $2
      limit 1
    `,
    [ownerId, caseId],
  );
  return rows[0] ?? null;
}

export async function markDraftSubmitted(ownerId: string, draftId?: string | null): Promise<void> {
  if (!draftId) return;
  await query(
    `
      update saferide.drafts
      set status = 'submitted',
          updated_at = now()
      where owner_id = $1 and id = $2
    `,
    [ownerId, draftId],
  );
}

export async function createCaseEvent(params: {
  ownerId: string;
  caseId: string;
  eventType: string;
  payload?: Record<string, unknown> | null;
  requestId?: string | null;
}): Promise<CaseEventRow> {
  const { rows } = await query<CaseEventRow>(
    `
      insert into saferide.case_events (case_id, owner_id, event_type, payload, request_id)
      values ($1, $2, $3, $4, $5)
      returning *
    `,
    [params.caseId, params.ownerId, params.eventType, params.payload ?? null, params.requestId ?? null],
  );
  return rows[0];
}

/** A case event as the survivor sees it: never the request id (internal correlation only). */
export type SurvivorCaseEventRow = Omit<CaseEventRow, 'request_id'>;

export async function listCaseEvents(ownerId: string, caseId: string): Promise<SurvivorCaseEventRow[]> {
  const { rows } = await query<SurvivorCaseEventRow>(
    `
      select event.id, event.case_id, event.owner_id, event.event_type, event.payload, event.created_at
      from saferide.case_events event
      join saferide.cases case_record on case_record.id = event.case_id
      where case_record.owner_id = $1 and event.case_id = $2
      order by event.created_at asc
    `,
    [ownerId, caseId],
  );
  return rows;
}

export async function listAttachments(ownerId: string, caseId: string): Promise<AttachmentRow[]> {
  const { rows } = await query<AttachmentRow>(
    `
      select *
      from saferide.attachments
      where owner_id = $1 and case_id = $2
      order by created_at asc
    `,
    [ownerId, caseId],
  );
  return rows;
}

export async function createPendingAttachment(params: {
  ownerId: string;
  caseId: string;
  draftId?: string | null;
  bucket: string;
  objectKey: string;
  mimeType: string;
  sizeBytes: number;
  expectedSha256?: string | null;
  uploadManifest: Record<string, unknown>;
  retentionPolicyId: string;
  metadata?: Record<string, unknown> | null;
}): Promise<AttachmentRow> {
  const { rows } = await query<AttachmentRow>(
    `
      insert into saferide.attachments (
        owner_id, case_id, draft_id, bucket, bucket_path, mime_type, size_bytes,
        expected_sha256, upload_manifest, retention, retention_policy_id,
        quarantine_status, antivirus_status, metadata
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, '{}'::jsonb, $10,
        'quarantined', 'not_scanned', $11)
      returning *
    `,
    [
      params.ownerId,
      params.caseId,
      params.draftId ?? null,
      params.bucket,
      params.objectKey,
      params.mimeType,
      params.sizeBytes,
      params.expectedSha256 ?? null,
      params.uploadManifest,
      params.retentionPolicyId,
      params.metadata ?? null,
    ],
  );
  return rows[0];
}

export async function completeAttachment(params: {
  ownerId: string;
  attachmentId: string;
  sha256: string;
  sizeBytes: number;
  status: 'uploaded' | 'hash_mismatch' | 'rejected';
}): Promise<AttachmentRow | null> {
  const { rows } = await query<AttachmentRow>(
    `
      update saferide.attachments
      set sha256 = $3,
          size_bytes = $4,
          status = $5::saferide.attachment_status,
          antivirus_status = case when $5::saferide.attachment_status = 'uploaded' then 'pending' else 'not_scanned' end,
          quarantine_status = case when $5::saferide.attachment_status = 'uploaded' then 'quarantined' else 'rejected' end,
          scan_attempts = 0,
          scan_next_attempt_at = null,
          scan_claim_token = null,
          scan_claimed_at = null,
          updated_at = now()
      where owner_id = $1 and id = $2
      returning *
    `,
    [params.ownerId, params.attachmentId, params.sha256, params.sizeBytes, params.status],
  );
  return rows[0] ?? null;
}

export async function recordAttachmentMalwareScan(params: {
  ownerId: string;
  attachmentId: string;
  result: 'clean' | 'rejected';
  objectSha256: string;
  scanEvidence: Record<string, unknown>;
  claimToken?: string;
}): Promise<AttachmentRow | null> {
  const { rows } = await query<AttachmentRow>(
    `
      update saferide.attachments
      set antivirus_status = $3,
          quarantine_status = case when $3 = 'clean' then 'released' else 'rejected' end,
          scan_evidence = $4,
          scan_next_attempt_at = null,
          scan_claim_token = null,
          scan_claimed_at = null,
          updated_at = now()
      where owner_id = $1 and id = $2 and status = 'uploaded' and sha256 = $5
        and ($6::uuid is null or (scan_claim_token = $6::uuid and antivirus_status = 'pending'))
      returning *
    `,
    [params.ownerId, params.attachmentId, params.result, params.scanEvidence, params.objectSha256, params.claimToken ?? null],
  );
  return rows[0] ?? null;
}
