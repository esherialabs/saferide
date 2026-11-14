import { createHash } from 'node:crypto';
import { z } from 'zod';
import { query } from '../plugins/db.js';
import { retentionTransaction, purgeExpiredPrivacyRows } from '../repositories/privacyRetentionRepository.js';
import { executePrivacyRetention } from './privacyRetentionExecution.js';
import { drainEvidenceDerivativePurges } from './evidenceDerivatives.js';
import { loadPrivacyControls } from '../config/privacyControls.js';

const uuid = z.string().uuid();
const time = z.string().datetime({ offset: true });
const list = <T extends z.ZodTypeAny>(schema: T) => z.array(schema).max(100_000);
const dsarStatus = z.enum(['executing','partially_completed','completed','verified','legal_hold']);
const receipt = z.object({
  schemaVersion: z.literal('1.0'), requestId: uuid, completedAt: time, policyVersion: z.string().max(120),
  status: z.enum(['completed','partially_completed','failed','legal_hold']),
  targets: list(z.object({ targetClass: z.string().max(80), status: z.enum(['deleted','not_found','failed','legal_hold']) }).strict()),
  dataScope: z.literal('owned_report_data').optional(), accountDeletionIncluded: z.literal(false).optional(),
  pendingStorageDeletes: z.number().int().nonnegative().optional(), externalCopiesRecalled: z.literal(false).optional(), backupErasureImmediate: z.literal(false).optional(),
  retainedMetadata: z.array(z.enum(['account','audit','deletion_receipt','storage_purge_ledger'])).optional(),
}).strict();
export const restoreLedgerSchema = z.object({
  schema: z.literal('com.saferide.restore-safety-ledger'), schemaVersion: z.literal(1), exportedAt: time,
  deletions: list(z.object({ id:uuid, ownerId:uuid, status:dsarStatus, createdAt:time, dueAt:time,
    receipt:receipt.nullable(), evidenceSha256:z.string().regex(/^[a-f0-9]{64}$/).nullable() }).strict()),
  withdrawnConsents: list(z.object({ id:uuid, ownerId:uuid, withdrawnAt:time }).strict()),
  revokedReferrals: list(z.object({ id:uuid, revokedAt:time, reason:z.enum(['consent_withdrawn','case_deleted','operator']) }).strict()),
  users: list(z.object({ id:uuid, status:z.enum(['active','disabled','invited']), updatedAt:time }).strict()),
  disabledOperators: list(uuid),
  organisations: list(z.object({ id:uuid, status:z.enum(['active','suspended']), mfaRequired:z.boolean() }).strict()),
  holds: list(z.object({ id:uuid, ownerId:uuid, caseId:uuid.nullable(), releasedAt:time.nullable() }).strict()),
  heldOwners: list(uuid),
  objects: list(z.object({ ownerId:uuid, caseId:uuid.nullable(), attachmentId:uuid, bucket:z.string().min(1).max(255), key:z.string().min(1).max(2048), kind:z.enum(['original','derivative']), createdAt:time }).strict()),
  legacyDerivativePurges: list(z.object({ key:z.string().startsWith('evidence-derivatives/').max(2048), bucket:z.string().min(1).max(255) }).strict()),
}).strict();
export type RestorePrivacyLedger = z.infer<typeof restoreLedgerSchema>;
const utc = (column:string) => `to_char(${column} at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** Called with all writers stopped. No names, narratives, contact details,
 * credentials, evidence bytes or raw location fields enter this ledger. */
export async function captureRestorePrivacyLedger(): Promise<RestorePrivacyLedger> {
  const readiness = await query("select 1 from saferide.schema_migrations where version = '018'");
  if (!readiness.rows.length) throw new Error('Current database cannot provide an authoritative privacy ledger');
  const all = async (sql:string) => (await query(sql)).rows;
  const [deletions, withdrawnConsents, revokedReferrals, users, operators, organisations, holds, held, objects, legacyDerivativePurges] = await Promise.all([
    all(`select id,owner_id as "ownerId",status,${utc('created_at')} as "createdAt",${utc('due_at')} as "dueAt",sanitized_receipt as receipt,evidence_sha256 as "evidenceSha256" from saferide.dsar_requests where request_type='deletion' and status in ('verified','executing','partially_completed','completed','legal_hold')`),
    all(`select id,owner_id as "ownerId",${utc('withdrawn_at')} as "withdrawnAt" from saferide.consent_records where status='withdrawn'`),
    all(`select id,${utc('access_revoked_at')} as "revokedAt",revoke_reason as reason from saferide.partner_referrals where access_revoked_at is not null`),
    all(`select id,status,${utc('updated_at')} as "updatedAt" from saferide.partner_users`),
    all("select id from saferide.partner_operators where status='disabled'"),
    all('select id,status,mfa_required as "mfaRequired" from saferide.partner_organizations'),
    all(`select id,owner_id as "ownerId",case_id as "caseId",${utc('released_at')} as "releasedAt" from saferide.privacy_legal_holds`),
    all("select distinct owner_id as id from saferide.dsar_requests where status='legal_hold'"),
    all(`select owner_id as "ownerId",case_id as "caseId",attachment_id as "attachmentId",bucket,object_key as key,object_kind as kind,${utc('created_at')} as "createdAt" from saferide.privacy_object_purges`),
    all('select object_key as key,bucket from saferide.evidence_derivative_object_purges'),
  ]);
  return restoreLedgerSchema.parse({schema:'com.saferide.restore-safety-ledger',schemaVersion:1,exportedAt:new Date().toISOString(),deletions,withdrawnConsents,revokedReferrals,users,disabledOperators:operators.map(r=>r.id),organisations,holds,heldOwners:held.map(r=>r.id),objects,legacyDerivativePurges});
}

export function validateRestorePrivacyLedger(input:unknown, now = Date.now()): RestorePrivacyLedger {
  const ledger = restoreLedgerSchema.parse(input);
  const age = now-Date.parse(ledger.exportedAt);
  if (age < -5*60_000 || age > 24*60*60_000) throw new Error('Restore requires an authoritative ledger exported within the last 24 hours');
  if (ledger.deletions.some(r=>r.status==='completed' && (!r.receipt || !r.evidenceSha256))) throw new Error('A completed deletion lacks its original receipt');
  return ledger;
}

/** Replay happens before any ingress, API, dashboard or worker starts. The
 * caller must keep restoration quarantined until drainRestorePrivacy completes. */
export async function replayRestorePrivacyLedger(input:unknown) {
  const ledger = validateRestorePrivacyLedger(input);
  const json = JSON.stringify(ledger);
  return retentionTransaction(async client => {
    await client.query("set local statement_timeout='20s'");
    // Every restored session is revoked. Changed or unknown staff credentials
    // require operator recovery instead of resurrecting an old password.
    await client.query("update saferide.partner_sessions set revoked_at=now(),revoke_reason='operator' where revoked_at is null");
    await client.query(`update saferide.partner_users u set status='disabled',disabled_at=now(),enrollment_token_hash=null,enrollment_expires_at=null
      where not exists(select 1 from jsonb_to_recordset($1::jsonb->'users') as x(id uuid,status text,"updatedAt" timestamptz) where x.id=u.id and x.status<>'disabled' and x."updatedAt"=u.updated_at)`,[json]);
    await client.query("update saferide.partner_operators set status='disabled',disabled_at=now() where id=any($1::uuid[])",[ledger.disabledOperators]);
    await client.query(`update saferide.partner_organizations o set intake_enabled=false,
      status=case when exists(select 1 from jsonb_to_recordset($1::jsonb->'organisations') as x(id uuid,status text) where x.id=o.id and x.status='suspended') then 'suspended' else o.status end,
      mfa_required=o.mfa_required or exists(select 1 from jsonb_to_recordset($1::jsonb->'organisations') as x(id uuid,"mfaRequired" boolean) where x.id=o.id and x."mfaRequired")`,[json]);
    await client.query('update saferide.partner_users set known_device_epoch=known_device_epoch+1');
    await client.query('update saferide.auth_users set refresh_token_hash=null,refresh_token_expires_at=null');
    // Apply withdrawals before importing executing DSAR states (whose write
    // guard intentionally blocks new report-data processing).
    for(const row of ledger.withdrawnConsents) await client.query("update saferide.consent_records set status='withdrawn',withdrawn_at=$3 where id=$1 and owner_id=$2 and status='granted'",[row.id,row.ownerId,row.withdrawnAt]);
    for(const row of ledger.revokedReferrals) await client.query('update saferide.partner_referrals set access_revoked_at=$2,revoke_reason=$3 where id=$1 and access_revoked_at is null',[row.id,row.revokedAt,row.reason]);
    for(const row of ledger.holds) await client.query(`insert into saferide.privacy_legal_holds(id,owner_id,case_id,authority_ref,released_at)
      values($1,$2,$3,$4,$5) on conflict(id) do update set released_at=excluded.released_at`,[row.id,row.ownerId,row.caseId,`restore-ledger:${row.id}`,row.releasedAt]);
    for(const owner of ledger.heldOwners) await client.query(`insert into saferide.privacy_legal_holds(owner_id,authority_ref)
      select $1,'restore-ledger:dsar-hold' where not saferide.privacy_owner_held($1)`,[owner]);
    // Verified-only requests have not executed and must not erase a backup
    // automatically. Executed owners include no-attachment/no-object cases.
    const erased = ledger.deletions.filter(r=>['executing','partially_completed','completed'].includes(r.status));
    for(const row of erased) {
      await client.query('select pg_advisory_xact_lock(hashtextextended($1,3878))',[row.ownerId]);
      for(const table of ['cases','drafts','chat_sessions','policy_acceptances','consent_records']) await client.query(`delete from saferide.${table} where owner_id=$1`,[row.ownerId]);
      const old = await client.query<{status:string}>('select status from saferide.dsar_requests where id=$1 for update',[row.id]);
      if(!old.rows.length) await client.query(`insert into saferide.dsar_requests(id,owner_id,request_type,status,request_idempotency_key,due_at,created_at,sanitized_receipt,evidence_sha256)
        values($1,$2,'deletion',$3,$4,$5,$6,$7,$8)`,[row.id,row.ownerId,row.status,`restore-ledger:${row.id}`,row.dueAt,row.createdAt,row.receipt,row.evidenceSha256]);
      else {
        let status=old.rows[0].status;
        if(['requested','failed','legal_hold'].includes(status)) { await client.query("update saferide.dsar_requests set status='verified' where id=$1",[row.id]);status='verified'; }
        if(['verified','partially_completed'].includes(status)) { await client.query("update saferide.dsar_requests set status='executing' where id=$1",[row.id]);status='executing'; }
        if(status!=='completed') await client.query('update saferide.dsar_requests set status=$2,sanitized_receipt=$3,evidence_sha256=$4 where id=$1',[row.id,row.status,row.receipt,row.evidenceSha256]);
      }
    }
    for(const row of ledger.objects) {
      // caseId is provenance for one purged object, not a report-deletion
      // tombstone. Only executed DSARs/retention above authorize report erasure.
      if(row.kind==='original') await client.query(`delete from saferide.attachments
        where id=$1 and owner_id=$2 and bucket=$3 and bucket_path=$4`,[row.attachmentId,row.ownerId,row.bucket,row.key]);
      else await client.query(`update saferide.evidence_derivatives d
        set status='failed',outcome_reason='source_unavailable',claim_token=null,completed_at=now(),
          derivative_sha256=null,size_bytes=null,updated_at=now()
        from saferide.attachments a where d.attachment_id=a.id and a.owner_id=$2
          and d.attachment_id=$1 and d.bucket=$3 and d.object_key=$4`,[row.attachmentId,row.ownerId,row.bucket,row.key]);
      await client.query(`insert into saferide.privacy_object_purges(owner_id,case_id,attachment_id,bucket,object_key,object_kind,created_at)
        values($1,$2,$3,$4,$5,$6,$7) on conflict(bucket,object_key) do update set completed_at=null,next_attempt_at=now()`,[row.ownerId,row.caseId,row.attachmentId,row.bucket,row.key,row.kind,row.createdAt]);
    }
    // Legacy unlinked derivatives cannot become readable after restoration.
    // Their existing restricted trigger/queue remains the deletion authority.
    for(const row of ledger.legacyDerivativePurges) await client.query(`insert into saferide.privacy_object_purges(owner_id,attachment_id,bucket,object_key,object_kind)
      values('00000000-0000-4000-8000-000000000000','00000000-0000-4000-8000-000000000000',$2,$1,'derivative')
      on conflict(bucket,object_key) do update set completed_at=null,next_attempt_at=now()`,[row.key,row.bucket]);
    return {schemaVersion:1,sourceExportedAt:ledger.exportedAt,ledgerSha256:createHash('sha256').update(json).digest('hex'),executedDeletionOwners:erased.length,withdrawals:ledger.withdrawnConsents.length,revocations:ledger.revokedReferrals.length};
  });
}

export async function drainRestorePrivacy() {
  const retention = await executePrivacyRetention({mode:'enforce',batch:100});
  const legacy = await drainEvidenceDerivativePurges(100);
  const controls = loadPrivacyControls();
  const cutoff = (id:string)=>new Date(Date.now()-controls.retentionPolicies.find(p=>p.policyId===id)!.durationDays!*86_400_000);
  const remaining = await purgeExpiredPrivacyRows({mode:'dry-run',caseCutoff:cutoff('submitted-case-pending-legal-v1'),partnerCutoff:cutoff('partner-access-after-close-v1'),auditCutoff:cutoff('partner-audit-v1'),batch:100});
  const pending = Number((await query('select count(*)::int as total from saferide.privacy_object_purges where completed_at is null')).rows[0].total);
  const oldPending = Number((await query('select count(*)::int as total from saferide.evidence_derivative_object_purges')).rows[0].total);
  return {done:pending===0 && oldPending===0 && Object.values(remaining).every(n=>n===0) && retention.objects.retry===0 && retention.rightsRequests.failed===0 && legacy.failed===0, pendingObjects:pending+oldPending, remainingRows:remaining, failures:retention.objects.retry+retention.rightsRequests.failed+legacy.failed};
}
