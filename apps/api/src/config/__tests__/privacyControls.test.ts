import { afterEach, describe, expect, it } from 'vitest';

import {
  ACTIVE_PRIVACY_CONTROL_VERSION,
  loadPrivacyControls,
  resetPrivacyControlsForTests,
} from '../privacyControls.js';

const originalPath = process.env.SAFERIDE_PRIVACY_CONTROLS_PATH;

afterEach(() => {
  if (originalPath === undefined) delete process.env.SAFERIDE_PRIVACY_CONTROLS_PATH;
  else process.env.SAFERIDE_PRIVACY_CONTROLS_PATH = originalPath;
  resetPrivacyControlsForTests();
});

describe('privacy controls', () => {
  it('loads the checked-in manifest from the repository execution context', () => {
    const controls = loadPrivacyControls();
    expect(controls.controlVersion).toBe(ACTIVE_PRIVACY_CONTROL_VERSION);
    expect(controls.capabilities.dsar_server_processing.status).toBe('enabled');
  });

  it('records the owner-authorized adult pilot without fabricating legal-document approval', () => {
    const controls = loadPrivacyControls();
    expect(controls.consentPurposes.partner_follow_up).toEqual({ status: 'enabled', version: 'partner-follow-up.ke-coast-huria.v3' });
    expect(controls.consentPurposes.partner_callback.status).toBe('enabled');
    expect(controls.policyDocuments.every(document => document.reviewStatus === 'pending_legal' && !document.acceptanceEnabled)).toBe(true);
    expect(controls.capabilities.minor_processing.status).toBe('disabled');
    const partnerPolicies = controls.retentionPolicies.filter(policy => policy.policyId.startsWith('partner-'));
    expect(partnerPolicies).toEqual([
      { policyId: 'partner-access-after-close-v1', scope: 'server', durationDays: 90, approvalStatus: 'approved_engineering', executionEnabled: true },
      { policyId: 'partner-audit-v1', scope: 'server', durationDays: 730, approvalStatus: 'approved_engineering', executionEnabled: true },
    ]);
  });

  it('fails closed when an explicitly configured manifest is unavailable', () => {
    process.env.SAFERIDE_PRIVACY_CONTROLS_PATH = '/nonexistent/saferide/privacy-controls.json';
    resetPrivacyControlsForTests();
    expect(() => loadPrivacyControls()).toThrow('Privacy control manifest is unavailable');
  });
});
