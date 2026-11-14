import { isConsentPurposeEnabled, isPrivacyCapabilityEnabled, loadPrivacyControls } from '../config/privacyControls.js';
import { isApprovedScannerReady } from './clamav/scannerHealth.js';
import type { PrivacyControls } from '../config/privacyControls.js';

/** Explicit owner pilot decision; never describes engineering approval as legal review. */
export function isApprovedIngestionRetention(
  policy: { policyId: string; scope: string; approvalStatus: string; executionEnabled: boolean; durationDays?: number | null } | null | undefined,
  controls: PrivacyControls,
): boolean {
  if (!policy || policy.scope !== 'server' || !policy.executionEnabled) return false;
  if (policy.approvalStatus === 'approved_legal') return true;
  return policy.approvalStatus === 'approved_engineering' && policy.policyId === 'submitted-case-pending-legal-v1' && policy.durationDays === 90
    && controls.controlVersion === 'privacy-controls.2026-10-22.pilot.1'
    && controls.capabilities?.server_retention_execution?.status === 'enabled'
    && controls.capabilities.server_retention_execution.version === 'owner-authorized-pilot.2026-10-22.1';
}

/** The pathway consent version the app sends with every POST /api/cases. */
const APP_PATHWAY_CONSENT_VERSION = 'pathway-consent.v1';
/** The retention policy the app requests for submitted-case evidence. */
const APP_EVIDENCE_RETENTION_POLICY_ID = 'submitted-case-pending-legal-v1';

/**
 * `features.caseSubmission` in GET /api/config/runtime: whether the app may
 * send reports (and their evidence) to SafeRide at all. False unless every
 * server-side ingestion and policy lock that POST /api/cases and the
 * evidence routes enforce is on: case ingestion, the pathway consent at the
 * app's version, server retention execution, an approved and executing
 * retention policy for evidence, and a current approved malware scanner
 * (the policy enabled and in its window, and clamd answering as the scanner
 * it names: clamav/scannerHealth.ts).
 * Any error reading the controls counts as off.
 */
export function isCaseSubmissionAdvertised(now = Date.now()): boolean {
  try {
    const controls = loadPrivacyControls();
    if (!isPrivacyCapabilityEnabled('submitted_case_ingestion')) return false;
    if (!isConsentPurposeEnabled('pathway_submission', APP_PATHWAY_CONSENT_VERSION)) return false;
    if (!isPrivacyCapabilityEnabled('server_retention_execution')) return false;

    const retention = controls.retentionPolicies.find(policy => policy.policyId === APP_EVIDENCE_RETENTION_POLICY_ID);
    if (!isApprovedIngestionRetention(retention, controls)) {
      return false;
    }

    const scan = controls.malwareScanPolicy;
    if (
      scan.status !== 'enabled' || !scan.approvalId || !scan.scanner || !scan.definitionVersion ||
      !scan.validFrom || !scan.validUntil
    ) {
      return false;
    }
    const validFrom = new Date(scan.validFrom).getTime();
    const validUntil = new Date(scan.validUntil).getTime();
    return Number.isFinite(validFrom) && Number.isFinite(validUntil) && now >= validFrom && now < validUntil &&
      isApprovedScannerReady(scan, now);
  } catch {
    return false;
  }
}
