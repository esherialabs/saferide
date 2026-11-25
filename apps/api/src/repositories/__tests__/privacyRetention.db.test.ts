import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { closeDb, query } from '../../plugins/db.js';
import { loadPrivacyControls } from '../../config/privacyControls.js';
import { pendingOwnerObjectPurges, purgeExpiredPrivacyRows, purgeOnePrivacyObject, verifyRecordedRetentionPolicies } from '../privacyRetentionRepository.js';
import { withActiveEvidenceDerivativeWrite, type EvidenceDerivativeClaim } from '../evidenceDerivativeRepository.js';
import { executeVerifiedReportDeletion, finishPendingReportDeletions } from '../../services/privacyDeletionExecution.js';

vi.mock('../../config/env.js', () => ({ env: { databaseUrl: process.env.SAFERIDE_TEST_DATABASE_URL ?? 'postgres://unused.invalid/none' } }));
const enabled = Boolean(process.env.SAFERIDE_TEST_DATABASE_URL);
const store = new Map<string, Buffer>();

async function fixture(ageDays = 100) {
  const owner = randomUUID(); const hash = 'a'.repeat(64);
  const caseId = (await query<{ id: string }>(`insert into saferide.cases(owner_id,pathway,status,created_at) values($1,'referral','submitted',now()-make_interval(days=>$2)) returning id`, [owner, ageDays])).rows[0].id;
  const key = `evidence/${randomUUID()}/${randomUUID()}`;
  const attachmentId = (await query<{ id: string }>(`insert into saferide.attachments(owner_id,case_id,bucket,bucket_path,mime_type,size_bytes,sha256,expected_sha256,status,antivirus_status,quarantine_status,scan_evidence,retention_policy_id)
    values($1,$2,'synthetic-evidence',$3,'image/png',4,$4,$4,'uploaded','clean','released','{}','submitted-case-pending-legal-v1') returning id`, [owner,caseId,key,hash])).rows[0].id;
  const derivativeKey = `evidence-derivatives/${randomUUID()}/${randomUUID()}`;
  const claimToken = randomUUID();
  const derivativeId = (await query<{ id: string }>(`insert into saferide.evidence_derivatives(attachment_id,retention_policy_id,bucket,object_key,source_sha256,status,claim_token,claimed_at)
    values($1,'submitted-case-pending-legal-v1','synthetic-evidence',$2,$3,'processing',$4,now()) returning id`, [attachmentId,derivativeKey,hash,claimToken])).rows[0].id;
  store.set(key,Buffer.from('test')); store.set(derivativeKey,Buffer.from('safe'));
  const claim: EvidenceDerivativeClaim = { derivativeId, attachmentId, claimToken, objectKey:derivativeKey, sourceSha256:hash, attempts:1, attachmentBucket:'synthetic-evidence', attachmentObjectKey:key, attachmentMimeType:'image/png', attachmentSizeBytes:4 };
  return { owner,caseId,key,attachmentId,derivativeKey,claim };
}
const cutoffs = () => ({ caseCutoff:new Date(Date.now()-90*86_400_000),partnerCutoff:new Date(Date.now()-90*86_400_000),auditCutoff:new Date(Date.now()-730*86_400_000),batch:25 });
const remove = async (item: { object_key:string }) => { store.delete(item.object_key); };
async function settleDelay(owner: string) {
  await query(`update saferide.privacy_object_purges set created_at = now()-interval '11 minutes',next_attempt_at=now()-interval '1 second' where owner_id=$1`,[owner]);
}

describe.skipIf(!enabled)('owned report retention and durable object deletion (PostgreSQL)',()=>{
  afterAll(closeDb);
  it('matches the recorded policy and dry-runs without deleting rows or objects',async()=>{
    await verifyRecordedRetentionPolicies(loadPrivacyControls());
    const f=await fixture();
    const result=await purgeExpiredPrivacyRows({mode:'dry-run',...cutoffs(),onlyOwnerIds:[f.owner]});
    expect(result.cases).toBe(1);
    expect((await query('select 1 from saferide.cases where id=$1',[f.caseId])).rows).toHaveLength(1);
    expect(store.has(f.key)).toBe(true);
  });
  it('removes database access atomically, retries failed storage, then removes originals and derivatives',async()=>{
    const f=await fixture();
    expect((await purgeExpiredPrivacyRows({mode:'enforce',...cutoffs(),onlyOwnerIds:[f.owner]})).cases).toBe(1);
    expect((await query('select 1 from saferide.attachments where id=$1',[f.attachmentId])).rows).toHaveLength(0);
    expect(await pendingOwnerObjectPurges(f.owner)).toBe(2);
    expect(await purgeOnePrivacyObject(async()=>{throw new Error('synthetic outage');},[f.owner])).toBe('retry');
    expect(await pendingOwnerObjectPurges(f.owner)).toBe(2);
    await settleDelay(f.owner);
    expect(await purgeOnePrivacyObject(remove,[f.owner])).toBe('deleted');
    expect(await purgeOnePrivacyObject(remove,[f.owner])).toBe('deleted');
    expect(await pendingOwnerObjectPurges(f.owner)).toBe(0);
    expect(store.has(f.key)).toBe(false); expect(store.has(f.derivativeKey)).toBe(false);
    expect(await withActiveEvidenceDerivativeWrite(f.claim,async()=>{throw new Error('must never write');})).toBe(false);
  });
  it('keeps held content and permits retention only after the hold is explicitly released',async()=>{
    const f=await fixture();
    const hold=(await query<{id:string}>(`insert into saferide.privacy_legal_holds(owner_id,case_id,authority_ref) values($1,$2,'SYNTHETIC-HOLD') returning id`,[f.owner,f.caseId])).rows[0].id;
    expect((await purgeExpiredPrivacyRows({mode:'enforce',...cutoffs(),onlyOwnerIds:[f.owner]})).cases).toBe(0);
    await expect(query('delete from saferide.cases where id=$1',[f.caseId])).rejects.toThrow('privacy_legal_hold');
    expect(await withActiveEvidenceDerivativeWrite(f.claim,async()=>{throw new Error('must never write');})).toBe(false);
    await query('update saferide.privacy_legal_holds set released_at=now() where id=$1',[hold]);
    expect((await purgeExpiredPrivacyRows({mode:'enforce',...cutoffs(),onlyOwnerIds:[f.owner]})).cases).toBe(1);
  });
  it('serialises a storage write with deletion so its final object is captured by the outbox',async()=>{
    const f=await fixture();
    let release!:()=>void; let entered!:()=>void;
    const started=new Promise<void>(resolve=>{entered=resolve;});
    const barrier=new Promise<void>(resolve=>{release=resolve;});
    const writing=withActiveEvidenceDerivativeWrite(f.claim,async()=>{entered();await barrier;store.set(f.derivativeKey,Buffer.from('late-write'));});
    await started;
    let deleted=false;
    const deleting=purgeExpiredPrivacyRows({mode:'enforce',...cutoffs(),onlyOwnerIds:[f.owner]}).then(result=>{deleted=true;return result;});
    await new Promise(resolve=>setTimeout(resolve,40));
    expect(deleted).toBe(false);
    release(); expect(await writing).toBe(true); expect((await deleting).cases).toBe(1);
    await settleDelay(f.owner);
    await purgeOnePrivacyObject(remove,[f.owner]);await purgeOnePrivacyObject(remove,[f.owner]);
    expect(store.has(f.derivativeKey)).toBe(false);
  });
  it('does not complete a verified rights request until storage is gone, and rejects unverified requests',async()=>{
    const f=await fixture(1);
    const request=(await query<{id:string}>(`insert into saferide.dsar_requests(owner_id,request_type,status,request_idempotency_key,due_at)
      values($1,'deletion','requested',$2,now()+interval '29 days') returning id`,[f.owner,randomUUID()])).rows[0].id;
    await expect(executeVerifiedReportDeletion(request)).rejects.toThrow('not verified');
    await query("update saferide.dsar_requests set status='verified' where id=$1",[request]);
    expect((await executeVerifiedReportDeletion(request)).status).toBe('partially_completed');
    await expect(query("insert into saferide.cases(owner_id,pathway,status) values($1,'referral','submitted')",[f.owner])).rejects.toThrow('report_deletion_in_progress');
    await settleDelay(f.owner);
    await purgeOnePrivacyObject(remove,[f.owner]);await purgeOnePrivacyObject(remove,[f.owner]);
    expect((await finishPendingReportDeletions(100)).completed).toBeGreaterThanOrEqual(1);
    const receipt=(await query<{status:string;sanitized_receipt:Record<string,unknown>}>('select status,sanitized_receipt from saferide.dsar_requests where id=$1',[request])).rows[0];
    expect(receipt.status).toBe('completed');
    expect(receipt.sanitized_receipt).toMatchObject({dataScope:'owned_report_data',accountDeletionIncluded:false,backupErasureImmediate:false});
  });
});
