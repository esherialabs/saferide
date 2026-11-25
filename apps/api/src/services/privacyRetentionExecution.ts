import { loadPrivacyControls, isPrivacyCapabilityEnabled } from '../config/privacyControls.js';
import { purgeExpiredPrivacyRows, purgeOnePrivacyObject, verifyRecordedRetentionPolicies, type PurgeObject } from '../repositories/privacyRetentionRepository.js';
import { deleteRetainedEvidenceObject } from '../storage/evidenceStorage.js';
import { finishPendingReportDeletions } from './privacyDeletionExecution.js';

export async function executePrivacyRetention(params: { mode: 'dry-run' | 'enforce'; now?: Date; batch?: number; removeObject?: (object: PurgeObject) => Promise<void> }) {
  const controls = loadPrivacyControls();
  if (!isPrivacyCapabilityEnabled('server_retention_execution')) throw new Error('Server retention execution is disabled');
  await verifyRecordedRetentionPolicies(controls);
  const now = params.now ?? new Date();
  const batch = Math.min(100, Math.max(1, params.batch ?? 25));
  const cutoff = (id: string) => new Date(now.getTime() - controls.retentionPolicies.find(p => p.policyId === id)!.durationDays! * 86_400_000);
  const counts = await purgeExpiredPrivacyRows({ mode: params.mode, caseCutoff: cutoff('submitted-case-pending-legal-v1'), partnerCutoff: cutoff('partner-access-after-close-v1'), auditCutoff: cutoff('partner-audit-v1'), batch });
  const objects = { deleted: 0, retry: 0, held: 0 };
  if (params.mode === 'enforce') {
    const remove = params.removeObject ?? (object => deleteRetainedEvidenceObject(object.bucket, object.object_key, object.object_kind));
    for (let i = 0; i < batch; i++) {
      const result = await purgeOnePrivacyObject(remove);
      if (result === 'idle') break;
      objects[result]++;
    }
  }
  const rightsRequests = params.mode === 'enforce' ? await finishPendingReportDeletions(batch) : { completed: 0, failed: 0 };
  return { schemaVersion: '1.0', policyVersion: controls.controlVersion, mode: params.mode, counts, objects, rightsRequests };
}
