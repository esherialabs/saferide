import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../config/env.js',()=>({env:{databaseUrl:'postgres://unused.invalid/none'}}));
vi.mock('../privacyRetentionExecution.js',()=>({executePrivacyRetention:vi.fn()}));
vi.mock('../evidenceDerivatives.js',()=>({drainEvidenceDerivativePurges:vi.fn()}));
import { validateRestorePrivacyLedger } from '../restorePrivacyLedger.js';

const empty = () => ({schema:'com.saferide.restore-safety-ledger',schemaVersion:1,exportedAt:new Date().toISOString(),deletions:[],withdrawnConsents:[],revokedReferrals:[],users:[],disabledOperators:[],organisations:[],holds:[],heldOwners:[],objects:[],legacyDerivativePurges:[]});
describe('restore ledger trust boundary',()=>{
  it('accepts an empty recent authoritative ledger but rejects stale and future exports',()=>{
    expect(validateRestorePrivacyLedger(empty()).schemaVersion).toBe(1);
    expect(()=>validateRestorePrivacyLedger({...empty(),exportedAt:new Date(Date.now()-86_400_001).toISOString()})).toThrow('24 hours');
    expect(()=>validateRestorePrivacyLedger({...empty(),exportedAt:new Date(Date.now()+360_000).toISOString()})).toThrow('24 hours');
  });
  it('rejects unexpected credentials or report content instead of exporting them',()=>{
    expect(()=>validateRestorePrivacyLedger({...empty(),passwordHash:'must-not-enter-ledger'})).toThrow();
    expect(()=>validateRestorePrivacyLedger({...empty(),users:[{id:randomUUID(),status:'active',updatedAt:new Date().toISOString(),email:'private@example.invalid'}]})).toThrow();
  });
  it('never treats a completed request without its original receipt as proof of deletion',()=>{
    expect(()=>validateRestorePrivacyLedger({...empty(),deletions:[{id:randomUUID(),ownerId:randomUUID(),status:'completed',createdAt:new Date().toISOString(),dueAt:new Date().toISOString(),receipt:null,evidenceSha256:null}]})).toThrow('original receipt');
  });
});
