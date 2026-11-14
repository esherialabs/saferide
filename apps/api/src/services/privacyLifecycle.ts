import { createHash } from 'node:crypto';

export const DSAR_REQUEST_TYPES = [
  'access',
  'export',
  'correction',
  'restriction',
  'objection',
  'deletion',
] as const;
export type DsarRequestType = typeof DSAR_REQUEST_TYPES[number];

export const DELETION_STATUSES = [
  'requested',
  'verified',
  'executing',
  'completed',
  'partially_completed',
  'failed',
  'legal_hold',
] as const;
export type DeletionStatus = typeof DELETION_STATUSES[number];

export const DELETION_TARGET_CLASSES = [
  'case_rows',
  'attachments',
  'object_storage',
  'chat',
  'indexes',
  'caches',
  'derived_linkable_records',
  'temporary_files',
  'abandoned_uploads',
  'partner_access',
] as const;
export type DeletionTargetClass = typeof DELETION_TARGET_CLASSES[number];

/**
 * What the `partner_access` deletion class and the
 * `partner-access-after-close-v1` retention policy (008, privacy manifest)
 * cover: every partner-side table keyed by a referral. All of it is deleted
 * with the case (cascade); on any revocation of the referral's access the
 * partner-internal rows (notes, callback, onward referrals, activity) are
 * deleted and the assignment cleared, leaving the tombstone and the audit.
 * A new table that references partner_referrals must be added here (a
 * database test checks the list against the schema).
 */
export const PARTNER_ACCESS_DELETION_SCOPE = {
  targetClass: 'partner_access',
  retentionPolicyId: 'partner-access-after-close-v1',
  tables: [
    'partner_referrals',
    'partner_referral_evidence',
    'partner_referral_callbacks',
    'partner_case_notes',
    'partner_onward_referrals',
    'partner_case_activity',
    'partner_push_jobs',
  ],
} as const satisfies { targetClass: DeletionTargetClass; retentionPolicyId: string; tables: readonly string[] };

const transitions: Record<DeletionStatus, ReadonlySet<DeletionStatus>> = {
  requested: new Set(['verified', 'failed', 'legal_hold']),
  verified: new Set(['executing', 'failed', 'legal_hold']),
  executing: new Set(['completed', 'partially_completed', 'failed', 'legal_hold']),
  completed: new Set(),
  partially_completed: new Set(['executing', 'failed', 'legal_hold']),
  failed: new Set(['verified', 'legal_hold']),
  legal_hold: new Set(['verified']),
};

export function calculateDsarDueAt(requestedAt: Date): Date {
  const dueAt = new Date(requestedAt);
  dueAt.setUTCDate(dueAt.getUTCDate() + 30);
  return dueAt;
}

export function canTransitionDeletion(from: DeletionStatus, to: DeletionStatus): boolean {
  return from === to || transitions[from].has(to);
}

export function assertDeletionTransition(from: DeletionStatus, to: DeletionStatus): void {
  if (!canTransitionDeletion(from, to)) {
    throw new Error(`Invalid deletion transition: ${from} -> ${to}`);
  }
}

export type DeletionTargetResult = {
  targetClass: DeletionTargetClass;
  status: 'deleted' | 'not_found' | 'failed' | 'legal_hold';
};

export function buildDeletionReceipt(params: {
  requestId: string;
  completedAt: string;
  policyVersion: string;
  targetResults: DeletionTargetResult[];
}): { receipt: Record<string, unknown>; evidenceSha256: string; status: 'completed' | 'partially_completed' | 'failed' | 'legal_hold' } {
  const byClass = new Map(params.targetResults.map(result => [result.targetClass, result.status]));
  const normalizedTargets = DELETION_TARGET_CLASSES.map(targetClass => ({
    targetClass,
    status: byClass.get(targetClass) ?? 'failed',
  }));
  const statuses = normalizedTargets.map(target => target.status);
  const status = statuses.includes('legal_hold')
    ? 'legal_hold'
    : statuses.every(targetStatus => targetStatus === 'deleted' || targetStatus === 'not_found')
      ? 'completed'
      : statuses.every(targetStatus => targetStatus === 'failed')
        ? 'failed'
        : 'partially_completed';

  const receipt = {
    schemaVersion: '1.0',
    requestId: params.requestId,
    completedAt: params.completedAt,
    policyVersion: params.policyVersion,
    status,
    targets: normalizedTargets,
  };
  const evidenceSha256 = createHash('sha256').update(JSON.stringify(receipt)).digest('hex');
  return { receipt, evidenceSha256, status };
}

export function buildConsentWithdrawal(params: {
  consentId: string;
  purpose: string;
  withdrawnAt: string;
}): Record<string, unknown> {
  return {
    consentId: params.consentId,
    purpose: params.purpose,
    status: 'withdrawn',
    withdrawnAt: params.withdrawnAt,
    effect: 'future_processing_only',
    externalSharingEffect: 'Information already shared with another organisation cannot be recalled by this withdrawal.',
  };
}

export function assertPolicyAcceptable(document: {
  reviewStatus: string;
  acceptanceEnabled: boolean;
  effectiveDate: string | null;
}): void {
  if (!document.acceptanceEnabled || document.reviewStatus !== 'approved' || !document.effectiveDate) {
    throw new Error('Policy document is not approved for acceptance');
  }
}

export type RetentionCandidate = {
  resourceClass: DeletionTargetClass;
  resourceId: string;
  createdAt: string;
  policyId: string;
};

export function planRetentionRun(params: {
  now: Date;
  policy: { policyId: string; durationDays: number | null; executionEnabled: boolean; approvalStatus: string };
  candidates: RetentionCandidate[];
}): { executable: boolean; blockedReason?: string; targets: RetentionCandidate[] } {
  if (!params.policy.executionEnabled || !params.policy.approvalStatus.startsWith('approved_')) {
    return { executable: false, blockedReason: 'retention_policy_not_approved', targets: [] };
  }
  if (params.policy.durationDays === null) return { executable: true, targets: [] };
  const cutoff = params.now.getTime() - params.policy.durationDays * 24 * 60 * 60 * 1000;
  return {
    executable: true,
    targets: params.candidates.filter(candidate =>
      candidate.policyId === params.policy.policyId && new Date(candidate.createdAt).getTime() <= cutoff,
    ),
  };
}
