import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
vi.mock('../../config/env.js',()=>({env:{databaseUrl:process.env.SAFERIDE_TEST_DATABASE_URL??'postgres://unused.invalid/none'}}));
vi.mock('../privacyRetentionExecution.js',()=>({executePrivacyRetention:vi.fn()}));
vi.mock('../evidenceDerivatives.js',()=>({drainEvidenceDerivativePurges:vi.fn()}));
import { closeDb, query } from '../../plugins/db.js';
import { captureRestorePrivacyLedger, replayRestorePrivacyLedger } from '../restorePrivacyLedger.js';
describe.skipIf(!process.env.SAFERIDE_TEST_DATABASE_URL)('restore privacy replay (disposable PostgreSQL)',()=>{
  afterAll(closeDb);
  it('replays individual object tombstones without erasing their live report or unrelated evidence',async()=>{
    const owner=randomUUID(),hash='a'.repeat(64);
    const caseId=(await query<{id:string}>(`insert into saferide.cases(owner_id,pathway,status) values($1,'referral','submitted') returning id`,[owner])).rows[0].id;
    const addAttachment=async()=>{
      const key=`evidence/${randomUUID()}/${randomUUID()}`;
      const id=(await query<{id:string}>(`insert into saferide.attachments(owner_id,case_id,bucket,bucket_path,mime_type,size_bytes,sha256,expected_sha256,status,antivirus_status,quarantine_status,scan_evidence,retention_policy_id)
        values($1,$2,'synthetic-evidence',$3,'image/png',4,$4,$4,'uploaded','clean','released','{}','submitted-case-pending-legal-v1') returning id`,[owner,caseId,key,hash])).rows[0].id;
      return {id,key};
    };
    const removed=await addAttachment(),retained=await addAttachment(),unrelated=await addAttachment();
    const derivativeKey=`evidence-derivatives/${randomUUID()}/${randomUUID()}`;
    const replacementKey=`evidence-derivatives/${randomUUID()}/${randomUUID()}`;
    await query(`insert into saferide.evidence_derivatives(attachment_id,retention_policy_id,bucket,object_key,source_sha256,status,claim_token,claimed_at)
      values($1,'submitted-case-pending-legal-v1','synthetic-evidence',$2,$3,'processing',$4,now())`,[retained.id,derivativeKey,hash,randomUUID()]);
    await query(`insert into saferide.evidence_derivatives(attachment_id,retention_policy_id,bucket,object_key,source_sha256,status,claim_token,claimed_at)
      values($1,'submitted-case-pending-legal-v1','synthetic-evidence',$2,$3,'processing',$4,now())`,[unrelated.id,replacementKey,hash,randomUUID()]);
    const ledger=await captureRestorePrivacyLedger();
    ledger.objects.push(...[
      {attachmentId:removed.id,key:removed.key,kind:'original' as const},
      {attachmentId:retained.id,key:derivativeKey,kind:'derivative' as const},
      // A historic derivative key must not invalidate a replacement object.
      {attachmentId:unrelated.id,key:`evidence-derivatives/${randomUUID()}/${randomUUID()}`,kind:'derivative' as const},
    ].map(row=>({...row,ownerId:owner,caseId,bucket:'synthetic-evidence',createdAt:new Date().toISOString()})));
    await replayRestorePrivacyLedger(ledger);
    expect((await query('select id from saferide.cases where id=$1',[caseId])).rows).toHaveLength(1);
    expect((await query('select id from saferide.attachments where case_id=$1 order by id',[caseId])).rows.map(row=>row.id).sort()).toEqual([retained.id,unrelated.id].sort());
    expect((await query('select status,claim_token,outcome_reason from saferide.evidence_derivatives where attachment_id=$1',[retained.id])).rows[0]).toMatchObject({status:'failed',claim_token:null,outcome_reason:'source_unavailable'});
    expect((await query('select status,object_key from saferide.evidence_derivatives where attachment_id=$1',[unrelated.id])).rows[0]).toMatchObject({status:'processing',object_key:replacementKey});
    expect((await query('select object_key from saferide.privacy_object_purges where owner_id=$1 and completed_at is null',[owner])).rows.map(row=>row.object_key)).toEqual(expect.arrayContaining([removed.key,derivativeKey]));
  });
  it('replays consent withdrawal and disabled staff access onto older granted/invited records',async()=>{
    const owner=randomUUID(),consent=randomUUID(),referral=randomUUID(),staff=randomUUID();
    const org=(await query<{id:string}>(`insert into saferide.partner_organizations(stable_id,display_name,intake_enabled,agreement_ref,agreement_signed_at,agreement_expires_at) values($1,'Synthetic restore partner',true,'SYNTHETIC',now()-interval '1 day',now()+interval '1 day') returning id`,[`restore-${randomUUID()}`])).rows[0].id;
    const caseId=(await query<{id:string}>(`insert into saferide.cases(owner_id,pathway,status) values($1,'referral','submitted') returning id`,[owner])).rows[0].id;
    const addConsent=()=>query(`insert into saferide.consent_records(id,owner_id,purpose,consent_version,status,granted_at) values($1,$2,'partner_follow_up','synthetic.v1','granted',now())`,[consent,owner]);
    const reference=`SR-${randomUUID().slice(0,4).toUpperCase()}-${randomUUID().slice(0,4).toUpperCase()}`;
    const addReferral=()=>query(`insert into saferide.partner_referrals(id,case_id,owner_id,org_id,consent_record_id,reference) values($1,$2,$3,$4,$5,$6)`,[referral,caseId,owner,org,consent,reference]);
    const addStaff=(disabled:boolean)=>query(`insert into saferide.partner_users(id,org_id,email,display_name,role,status,disabled_at) values($1,$2,$3,'Synthetic staff','partner_caseworker',$4,$5)`,[staff,org,`${staff}@example.invalid`,disabled?'disabled':'invited',disabled?new Date():null]);
    await addConsent();await addReferral();await addStaff(true);
    await query("update saferide.consent_records set status='withdrawn',withdrawn_at=now() where id=$1",[consent]);
    const ledger=await captureRestorePrivacyLedger();
    await query('delete from saferide.consent_records where id=$1',[consent]);
    await query('delete from saferide.partner_users where id=$1',[staff]);
    await addConsent();await addReferral();await addStaff(false);
    await replayRestorePrivacyLedger(ledger);
    expect((await query('select status from saferide.consent_records where id=$1',[consent])).rows[0].status).toBe('withdrawn');
    expect((await query('select access_revoked_at from saferide.partner_referrals where id=$1',[referral])).rows[0].access_revoked_at).not.toBeNull();
    expect((await query('select status,known_device_epoch from saferide.partner_users where id=$1',[staff])).rows[0]).toMatchObject({status:'disabled',known_device_epoch:1});
  });
  it('reapplies an executed no-attachment deletion without inventing a completion receipt',async()=>{
    const owner=randomUUID(),request=randomUUID();
    await query(`insert into saferide.dsar_requests(id,owner_id,request_type,status,request_idempotency_key,due_at) values($1,$2,'deletion','executing',$3,now()+interval '29 days')`,[request,owner,randomUUID()]);
    const ledger=await captureRestorePrivacyLedger();
    // Model the older backup: it predates execution and still has a report.
    await query('delete from saferide.dsar_requests where id=$1',[request]);
    const restored=(await query<{id:string}>(`insert into saferide.cases(owner_id,pathway,status) values($1,'referral','submitted') returning id`,[owner])).rows[0].id;
    await replayRestorePrivacyLedger(ledger);
    expect((await query('select 1 from saferide.cases where id=$1',[restored])).rows).toHaveLength(0);
    const row=(await query('select status,sanitized_receipt from saferide.dsar_requests where id=$1',[request])).rows[0];
    expect(row.status).toBe('executing');expect(row.sanitized_receipt).toBeNull();
  });
  it('reopens completed object deletions after restoring storage and refuses held deletion',async()=>{
    const owner=randomUUID(),attachment=randomUUID(),key=`evidence/${randomUUID()}/${randomUUID()}`;
    await query(`insert into saferide.privacy_object_purges(owner_id,attachment_id,bucket,object_key,object_kind,completed_at) values($1,$2,'synthetic-evidence',$3,'original',now())`,[owner,attachment,key]);
    const ledger=await captureRestorePrivacyLedger();
    await replayRestorePrivacyLedger(ledger);
    expect((await query('select completed_at from saferide.privacy_object_purges where object_key=$1',[key])).rows[0].completed_at).toBeNull();
    const heldOwner=randomUUID();
    await query(`insert into saferide.cases(owner_id,pathway,status) values($1,'referral','submitted')`,[heldOwner]);
    await query(`insert into saferide.privacy_legal_holds(owner_id,authority_ref) values($1,'SYNTHETIC-RESTORE-HOLD')`,[heldOwner]);
    const heldLedger=await captureRestorePrivacyLedger();
    heldLedger.deletions.push({id:randomUUID(),ownerId:heldOwner,status:'executing',createdAt:new Date().toISOString(),dueAt:new Date().toISOString(),receipt:null,evidenceSha256:null});
    await expect(replayRestorePrivacyLedger(heldLedger)).rejects.toThrow('privacy_legal_hold');
    expect((await query('select 1 from saferide.cases where owner_id=$1',[heldOwner])).rows).toHaveLength(1);
  });
});
