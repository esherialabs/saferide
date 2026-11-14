import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  capabilities: {} as Record<string, boolean>,
  pathwayVersion: 'pathway-consent.v1' as string | null,
  controls: null as null | Record<string, any>,
  throwControls: false,
  scannerReady: true,
}));

vi.mock('../../config/privacyControls', () => ({
  isPrivacyCapabilityEnabled: (capability: string) => state.capabilities[capability] === true,
  isConsentPurposeEnabled: (purpose: string, version: string) => purpose === 'pathway_submission' && state.pathwayVersion === version,
  loadPrivacyControls: () => {
    if (state.throwControls) throw new Error('controls unavailable');
    return state.controls;
  },
}));

// clamd's health is cached by the API's monitor; here it is a switch.
vi.mock('../clamav/scannerHealth', () => ({
  isApprovedScannerReady: (policy: { status: string; scanner: string | null }) =>
    state.scannerReady && policy.status === 'enabled' && policy.scanner === 'clamav 1.5.4',
}));

import { isApprovedIngestionRetention, isCaseSubmissionAdvertised } from '../caseSubmissionFeature';

const NOW = Date.parse('2026-10-22T10:00:00.000Z');

function openAllLocks() {
  state.capabilities = { submitted_case_ingestion: true, server_retention_execution: true };
  state.pathwayVersion = 'pathway-consent.v1';
  state.throwControls = false;
  state.scannerReady = true;
  state.controls = {
    retentionPolicies: [
      { policyId: 'submitted-case-pending-legal-v1', scope: 'server', approvalStatus: 'approved_legal', executionEnabled: true },
    ],
    malwareScanPolicy: {
      status: 'enabled',
      approvalId: 'scan-approval-1',
      scanner: 'clamav 1.5.4',
      definitionVersion: 'freshclam:max-age=48h',
      validFrom: '2026-10-01T00:00:00.000Z',
      validUntil: '2026-11-01T00:00:00.000Z',
    },
  };
}

describe('caseSubmission runtime flag', () => {
  beforeEach(openAllLocks);

  it('is on only when every ingestion and policy lock is on', () => {
    expect(isCaseSubmissionAdvertised(NOW)).toBe(true);
  });

  it('accepts only the explicitly versioned 90-day engineering pilot decision', () => {
    const policy = { policyId: 'submitted-case-pending-legal-v1', scope: 'server', durationDays: 90, executionEnabled: true, approvalStatus: 'approved_engineering' };
    const controls = { controlVersion: 'privacy-controls.2026-10-22.pilot.1', capabilities: { server_retention_execution: { status: 'enabled', version: 'owner-authorized-pilot.2026-10-22.1' } } } as any;
    expect(isApprovedIngestionRetention(policy, controls)).toBe(true);
    expect(isApprovedIngestionRetention({ ...policy, durationDays: 365 }, controls)).toBe(false);
    expect(isApprovedIngestionRetention(policy, { ...controls, controlVersion: 'unreviewed' })).toBe(false);
    expect(isApprovedIngestionRetention({ ...policy, approvalStatus: 'pending_legal' }, controls)).toBe(false);
  });

  it.each([
    ['case ingestion is off', () => { state.capabilities.submitted_case_ingestion = false; }],
    ['the pathway consent is off', () => { state.pathwayVersion = null; }],
    ['the pathway consent is at another version', () => { state.pathwayVersion = 'pathway-consent.v2'; }],
    ['server retention execution is off', () => { state.capabilities.server_retention_execution = false; }],
    ['the evidence retention policy is pending legal', () => { state.controls!.retentionPolicies[0].approvalStatus = 'pending_legal'; }],
    ['the evidence retention policy does not execute', () => { state.controls!.retentionPolicies[0].executionEnabled = false; }],
    ['the evidence retention policy is missing', () => { state.controls!.retentionPolicies = []; }],
    ['the scanner is not approved', () => { state.controls!.malwareScanPolicy.status = 'disabled'; }],
    ['the scanner approval expired', () => { state.controls!.malwareScanPolicy.validUntil = '2026-10-21T00:00:00.000Z'; }],
    ['the scanner approval has not started', () => { state.controls!.malwareScanPolicy.validFrom = '2026-10-23T00:00:00.000Z'; }],
    ['clamd is not answering (or not as the approved scanner)', () => { state.scannerReady = false; }],
    ['the policy names a different scanner', () => { state.controls!.malwareScanPolicy.scanner = 'clamav 1.4.6'; }],
    ['the privacy controls cannot be read', () => { state.throwControls = true; }],
  ])('is off when %s', (_label, close) => {
    close();
    expect(isCaseSubmissionAdvertised(NOW)).toBe(false);
  });
});
