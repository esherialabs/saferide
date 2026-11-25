import { createHash } from 'node:crypto';
import { isPrivacyCapabilityEnabled, loadPrivacyControls } from '../config/privacyControls.js';
import { query } from '../plugins/db.js';
import { pendingOwnerObjectPurges, purgeVerifiedOwnerReports } from '../repositories/privacyRetentionRepository.js';
import { buildDeletionReceipt, DELETION_TARGET_CLASSES } from './privacyLifecycle.js';

/** Executes only operator-verified report-data requests. It never verifies
 * identity itself and does not claim to erase copies already held elsewhere. */
export async function executeVerifiedReportDeletion(requestId: string) {
  if (!isPrivacyCapabilityEnabled('dsar_server_processing')) throw new Error('Server rights-request execution is disabled');
  const controls = loadPrivacyControls();
  const result = await purgeVerifiedOwnerReports(requestId);
  const pending = await pendingOwnerObjectPurges(result.ownerId);
  const completed = !result.held && pending === 0;
  const targetResults = DELETION_TARGET_CLASSES.map(targetClass => ({ targetClass,
    status: result.held ? 'legal_hold' as const : targetClass === 'object_storage' && pending > 0 ? 'failed' as const
      : ['caches', 'temporary_files'].includes(targetClass) ? 'not_found' as const : 'deleted' as const }));
  const built = buildDeletionReceipt({ requestId, policyVersion: controls.controlVersion, completedAt: new Date().toISOString(), targetResults });
  const receipt = { ...built.receipt, dataScope: 'owned_report_data', accountDeletionIncluded: false,
    pendingStorageDeletes: pending, externalCopiesRecalled: false, backupErasureImmediate: false,
    retainedMetadata: ['account', 'audit', 'deletion_receipt', 'storage_purge_ledger'] };
  const evidenceSha256 = createHash('sha256').update(JSON.stringify(receipt)).digest('hex');
  const status = result.held ? 'legal_hold' : completed ? 'completed' : 'partially_completed';
  await query('update saferide.dsar_requests set status = $2, sanitized_receipt = $3, evidence_sha256 = $4 where id = $1', [requestId, status, receipt, evidenceSha256]);
  return { status, receipt, evidenceSha256 };
}

export async function finishPendingReportDeletions(limit: number): Promise<{ completed: number; failed: number }> {
  const { rows } = await query<{ id: string }>(`select r.id from saferide.dsar_requests r
    where request_type = 'deletion' and status in ('executing','partially_completed')
      and not saferide.privacy_owner_held(r.owner_id)
      and not exists(select 1 from saferide.privacy_object_purges p where p.owner_id = r.owner_id and p.completed_at is null)
    order by r.created_at limit $1`, [Math.max(1, Math.min(100, limit))]);
  const counts = { completed: 0, failed: 0 };
  for (const row of rows) {
    try { if ((await executeVerifiedReportDeletion(row.id)).status === 'completed') counts.completed++; }
    catch { counts.failed++; }
  }
  return counts;
}
