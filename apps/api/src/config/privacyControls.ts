import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { z } from 'zod';

const statusSchema = z.object({
  status: z.enum(['enabled', 'disabled']),
  reason: z.string().min(1).optional(),
  version: z.string().min(1).optional(),
}).strict().superRefine((control, ctx) => {
  if (control.status === 'enabled' && !control.version) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['version'], message: 'enabled controls require a version' });
  }
  if (control.status === 'disabled' && !control.reason) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['reason'], message: 'disabled controls require a reason' });
  }
});

const privacyControlsSchema = z.object({
  schema: z.literal('com.saferide.privacy-controls'),
  schemaVersion: z.literal(1),
  controlVersion: z.string().min(1),
  policyDocuments: z.array(z.object({
    documentType: z.enum(['privacy-policy', 'terms']),
    version: z.string().min(1),
    locale: z.string().min(2),
    path: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    effectiveDate: z.string().date().nullable(),
    reviewStatus: z.enum(['pending_legal', 'approved', 'retired']),
    acceptanceEnabled: z.boolean(),
  }).strict()).min(2),
  consentPurposes: z.record(z.string(), statusSchema),
  capabilities: z.record(z.string(), statusSchema),
  retentionPolicies: z.array(z.object({
    policyId: z.string().regex(/^[a-z0-9-]+$/),
    scope: z.enum(['local', 'server']),
    durationDays: z.number().int().positive().nullable(),
    approvalStatus: z.enum(['approved_engineering', 'approved_legal', 'pending_legal', 'retired']),
    executionEnabled: z.boolean(),
  }).strict()),
  malwareScanPolicy: z.object({
    status: z.enum(['enabled', 'disabled']),
    approvalId: z.string().min(1).nullable(),
    scanner: z.string().min(1).nullable(),
    definitionVersion: z.string().min(1).nullable(),
    validFrom: z.string().datetime().nullable(),
    validUntil: z.string().datetime().nullable(),
    reason: z.string().min(1).nullable(),
  }).strict(),
  evidenceDownloadGate: z.object({
    allowedAttachmentStatus: z.literal('uploaded'),
    allowedMalwareStatus: z.literal('clean'),
    quarantineOnUpload: z.literal(true),
    hashRequired: z.literal(true),
  }).strict(),
}).strict();

export type PrivacyControls = z.infer<typeof privacyControlsSchema>;
export type PrivacyCapability = keyof PrivacyControls['capabilities'];
export const ACTIVE_PRIVACY_CONTROL_VERSION = 'privacy-controls.2026-10-22.pilot.1';

let cachedControls: PrivacyControls | null = null;

export function loadPrivacyControls(): PrivacyControls {
  if (cachedControls) return cachedControls;

  const configuredPath = process.env.SAFERIDE_PRIVACY_CONTROLS_PATH;
  const candidatePaths = configuredPath
    ? [resolve(configuredPath)]
    : [
        resolve(process.cwd(), 'config/privacy/privacy-controls.v1.json'),
        resolve(process.cwd(), '../../config/privacy/privacy-controls.v1.json'),
      ];
  const controlsPath = candidatePaths.find(existsSync);
  if (!controlsPath) {
    throw new Error('Privacy control manifest is unavailable');
  }
  const parsed = privacyControlsSchema.parse(JSON.parse(readFileSync(controlsPath, 'utf8')));
  if (parsed.controlVersion !== ACTIVE_PRIVACY_CONTROL_VERSION) {
    throw new Error('Privacy control version does not match the compiled API contract');
  }

  for (const document of parsed.policyDocuments) {
    if (document.acceptanceEnabled && (document.reviewStatus !== 'approved' || !document.effectiveDate)) {
      throw new Error(`Privacy document ${document.documentType}/${document.locale} cannot accept without approval`);
    }
  }
  for (const policy of parsed.retentionPolicies) {
    if (policy.executionEnabled && !policy.approvalStatus.startsWith('approved_')) {
      throw new Error(`Retention policy ${policy.policyId} cannot execute without approval`);
    }
  }
  const scanPolicy = parsed.malwareScanPolicy;
  if (scanPolicy.status === 'enabled') {
    if (!scanPolicy.approvalId || !scanPolicy.scanner || !scanPolicy.definitionVersion || !scanPolicy.validFrom || !scanPolicy.validUntil) {
      throw new Error('Enabled malware scanning requires an approved scanner, definition, and validity window');
    }
    if (new Date(scanPolicy.validUntil).getTime() <= new Date(scanPolicy.validFrom).getTime()) {
      throw new Error('Malware scan approval validity window is invalid');
    }
  }

  cachedControls = parsed;
  return parsed;
}

export function isPrivacyCapabilityEnabled(capability: PrivacyCapability): boolean {
  try {
    return loadPrivacyControls().capabilities[capability]?.status === 'enabled';
  } catch {
    return false;
  }
}

export function getRetentionPolicy(policyId: string, scope?: 'local' | 'server') {
  const policy = loadPrivacyControls().retentionPolicies.find(candidate => candidate.policyId === policyId);
  if (!policy || (scope && policy.scope !== scope)) return null;
  return policy;
}

export function isConsentPurposeEnabled(purpose: string, version: string): boolean {
  try {
    const control = loadPrivacyControls().consentPurposes[purpose];
    return control?.status === 'enabled' && control.version === version;
  } catch {
    return false;
  }
}

/** The version an enabled consent purpose currently accepts, or null when it is off or unavailable. */
export function getEnabledConsentVersion(purpose: string): string | null {
  try {
    const control = loadPrivacyControls().consentPurposes[purpose];
    return control?.status === 'enabled' && control.version ? control.version : null;
  } catch {
    return null;
  }
}

export function resetPrivacyControlsForTests(): void {
  cachedControls = null;
}
