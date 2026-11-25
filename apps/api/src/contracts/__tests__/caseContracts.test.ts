import { describe, expect, it } from 'vitest';

import {
  anonymousSignalSchema,
  buildLifecyclePayload,
  createCaseSchema,
  normalizeKenyanMobile,
  savePrivateLocalRecordSchema,
} from '../caseContracts.js';

describe('case API contracts', () => {
  const consentRecordId = '11111111-1111-4111-8111-111111111111';

  it('keeps save-private explicitly local and anonymous signals free of direct identifiers', () => {
    expect(savePrivateLocalRecordSchema.parse({ schemaVersion: '1.0', workflowType: 'save-private', storage: 'local-only' })).toBeTruthy();
    expect(createCaseSchema.safeParse({
      idempotencyKey: consentRecordId,
      pathwayConsent: { recordId: consentRecordId, purpose: 'pathway_submission', version: 'pathway-consent.v1' },
      workflow: { schemaVersion: '1.0', workflowType: 'save-private', storage: 'local-only' },
    }).success).toBe(false);
    expect(anonymousSignalSchema.safeParse({
      schemaVersion: '1.0', configVersion: 'synthetic-test', policyVersion: 'synthetic-test',
      consentVersion: 'synthetic-consent-v1', area: { type: 'coarse_cell', id: 'cell-10-20' },
      timeBucket: '2026-07-30T10:00:00.000Z', category: 'harassment',
    }).success).toBe(true);
    expect(anonymousSignalSchema.safeParse({
      schemaVersion: '1.0', configVersion: 'synthetic-test', policyVersion: 'synthetic-test',
      consentVersion: 'synthetic-consent-v1', area: { type: 'coarse_cell', id: 'cell-10-20' },
      timeBucket: '2026-07-30T10:00:00.000Z', category: 'harassment', latitude: -1.2,
    }).success).toBe(false);
  });

  it('accepts a minimized referral and emits a content-free lifecycle event', () => {
    const parsed = createCaseSchema.parse({
      idempotencyKey: consentRecordId,
      draftId: 'synthetic-draft',
      pathwayConsent: { recordId: consentRecordId, purpose: 'pathway_submission', version: 'pathway-consent.v1' },
      workflow: {
        schemaVersion: '1.0',
        workflowType: 'referral',
        providerId: 'provider-1',
        channel: 'call',
        supportBrief: {
          included: true,
          selectedFields: ['incident_categories', 'location_type'],
          incidentCategories: ['harassment'],
          locationType: 'public_transport',
        },
      },
    });
    expect(buildLifecyclePayload(parsed.workflow)).toEqual({
      schemaVersion: '1.0',
      workflowType: 'referral',
      status: 'submitted',
    });
  });

  it('rejects generic summaries, extra fields, and mismatched referral selections', () => {
    expect(createCaseSchema.safeParse({ pathway: 'referral', summary: { narrative: 'synthetic' } }).success).toBe(false);
    expect(createCaseSchema.safeParse({
      workflow: {
        schemaVersion: '1.0',
        workflowType: 'referral',
        providerId: 'provider-1',
        channel: 'sms',
        supportBrief: { included: false, selectedFields: [], narrative: 'synthetic' },
      },
    }).success).toBe(false);
    expect(createCaseSchema.safeParse({
      workflow: {
        schemaVersion: '1.0',
        workflowType: 'referral',
        providerId: 'provider-1',
        channel: 'sms',
        supportBrief: { included: true, selectedFields: ['location_type'] },
      },
    }).success).toBe(false);
  });

  it('accepts the submitted-case envelope only with a schema-valid escalation', () => {
    const result = createCaseSchema.safeParse({
      idempotencyKey: consentRecordId,
      pathwayConsent: { recordId: consentRecordId, purpose: 'pathway_submission', version: 'pathway-consent.v1' },
      workflow: {
        schemaVersion: '1.0',
        workflowType: 'submitted-case',
        pathway: 'escalation',
        submission: {
          schemaVersion: '1.0',
          workflowType: 'escalation',
          packet: {
            version: '1.0',
            generatedAt: '2026-07-30T00:00:00.000Z',
            pathway: 'escalate',
            redactionLevel: 'heavy',
            contact: { preference: 'none', label: 'No contact identity included' },
            content: {
              timeRange: 'Not provided', location: 'Exact location redacted',
              incidentDescription: '[redacted]', statement: '[redacted]', tags: [], patterns: [], transportIdentifiers: [],
            },
            evidenceManifest: [],
            redaction: { appliedLabels: [], textFields: [], evidenceMetadata: 'redacted', mediaProcessing: [] },
          },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('binds submission idempotency to the exact consent record', () => {
    const result = createCaseSchema.safeParse({
      idempotencyKey: '22222222-2222-4222-8222-222222222222',
      pathwayConsent: { recordId: consentRecordId, purpose: 'pathway_submission', version: 'pathway-consent.v1' },
      workflow: {
        schemaVersion: '1.0',
        workflowType: 'referral',
        providerId: 'provider-1',
        channel: 'call',
        supportBrief: { included: false, selectedFields: [] },
      },
    });
    expect(result.success).toBe(false);
  });

  describe('partner routing', () => {
    const followUpId = '33333333-3333-4333-8333-333333333333';
    const callbackId = '44444444-4444-4444-8444-444444444444';
    const referral = (providerId = 'ke-coast-huria') => ({
      schemaVersion: '1.0', workflowType: 'referral', providerId, channel: 'call',
      supportBrief: { included: false, selectedFields: [] },
    });
    const escalation = {
      schemaVersion: '1.0', workflowType: 'submitted-case', pathway: 'escalation',
      submission: {
        schemaVersion: '1.0', workflowType: 'escalation',
        packet: {
          version: '1.0', generatedAt: '2026-07-30T00:00:00.000Z', pathway: 'escalate', redactionLevel: 'light',
          contact: { preference: 'none', label: 'No contact identity included' },
          content: {
            timeRange: 'Synthetic', location: 'Synthetic', incidentDescription: 'Synthetic', statement: 'Synthetic',
            tags: [], patterns: [], transportIdentifiers: [],
          },
          evidenceManifest: [],
          redaction: { appliedLabels: [], textFields: [], evidenceMetadata: 'redacted', mediaProcessing: [] },
        },
      },
    };
    const submission = (workflow: unknown, partnerRouting: unknown) => ({
      idempotencyKey: consentRecordId,
      pathwayConsent: { recordId: consentRecordId, purpose: 'pathway_submission', version: 'pathway-consent.v1' },
      workflow,
      partnerRouting,
    });

    it('accepts Kenyan mobile numbers only, normalised to E.164 by the P1 helper', () => {
      for (const input of ['0712 345 678', '+254712345678', '254-712-345-678', '(0712) 345.678']) {
        expect(normalizeKenyanMobile(input)).toBe('+254712345678');
      }
      expect(normalizeKenyanMobile('0110 123 456')).toBe('+254110123456');
      expect(normalizeKenyanMobile('+254101234567')).toBe('+254101234567');
      for (const input of [
        '020 1234567', '041 2223333', '0769', '112', '+255712345678', '+44 20 7946 0000', '07123456789',
        '071234567', '+2540712345678', '0121234567', 'not a number', '0712345678 ext 2', '',
      ]) {
        expect(normalizeKenyanMobile(input)).toBeNull();
      }
    });

    it('routes only to HURIA or the synthetic test partner', () => {
      expect(createCaseSchema.safeParse(submission(escalation, { partnerStableId: 'test-partner', consentRecordId: followUpId })).success).toBe(true);
      expect(createCaseSchema.safeParse(submission(escalation, { partnerStableId: 'ke-coast-other', consentRecordId: followUpId })).success).toBe(false);
    });

    it('stays optional, so existing submissions are unchanged', () => {
      expect(createCaseSchema.parse(submission(referral('provider-1'), undefined)).partnerRouting).toBeUndefined();
    });

    it('accepts a digital channel only for a reviewed packet explicitly routed to HURIA', () => {
      const digital = { ...referral(), channel: 'partner_dashboard', partnerPacket: {
        consentVersion: 'partner-follow-up.ke-coast-huria.v3', packet: escalation.submission.packet,
      } };
      const routing = { partnerStableId: 'ke-coast-huria', consentRecordId: followUpId };
      expect(createCaseSchema.safeParse(submission(digital, routing)).success).toBe(true);
      expect(createCaseSchema.safeParse(submission(digital, undefined)).success).toBe(false);
      expect(createCaseSchema.safeParse(submission({ ...digital, partnerPacket: undefined }, routing)).success).toBe(false);
      expect(createCaseSchema.safeParse(submission({ ...digital, providerId: 'test-partner' }, { ...routing, partnerStableId: 'test-partner' })).success).toBe(false);
      expect(createCaseSchema.safeParse(submission({ ...digital, partnerPacket: { ...digital.partnerPacket, consentVersion: 'partner-follow-up.ke-coast-huria.v2' } }, routing)).success).toBe(false);
    });

    it('routes a referral only to the provider it names, and an escalation to HURIA', () => {
      expect(createCaseSchema.safeParse(submission(referral(), { partnerStableId: 'ke-coast-huria', consentRecordId: followUpId })).success).toBe(true);
      expect(createCaseSchema.safeParse(submission(referral('provider-1'), { partnerStableId: 'ke-coast-huria', consentRecordId: followUpId })).success).toBe(false);
      expect(createCaseSchema.safeParse(submission(escalation, { partnerStableId: 'ke-coast-huria', consentRecordId: followUpId })).success).toBe(true);
      expect(createCaseSchema.safeParse(submission(escalation, { partnerStableId: 'provider-1', consentRecordId: followUpId })).success).toBe(false);
      expect(createCaseSchema.safeParse(submission(escalation, { partnerStableId: 'ke-coast-huria' })).success).toBe(false);
      expect(createCaseSchema.safeParse(submission(escalation, {
        partnerStableId: 'ke-coast-huria', consentRecordId: followUpId, survivorName: 'Synthetic',
      })).success).toBe(false);
    });

    it('needs a distinct consent record for each purpose', () => {
      expect(createCaseSchema.safeParse(submission(escalation, { partnerStableId: 'ke-coast-huria', consentRecordId })).success).toBe(false);
      expect(createCaseSchema.safeParse(submission(escalation, {
        partnerStableId: 'ke-coast-huria', consentRecordId: followUpId,
        callback: { phoneNumber: '0712345678', consentRecordId: followUpId },
      })).success).toBe(false);
    });

    it('normalises an optional Kenyan mobile callback number and never echoes a rejected one', () => {
      const parsed = createCaseSchema.parse(submission(escalation, {
        partnerStableId: 'ke-coast-huria', consentRecordId: followUpId,
        callback: { phoneNumber: '0712 345 678', consentRecordId: callbackId },
      }));
      expect(parsed.partnerRouting?.callback).toEqual({ phoneNumber: '+254712345678', consentRecordId: callbackId });

      const rejected = createCaseSchema.safeParse(submission(escalation, {
        partnerStableId: 'ke-coast-huria', consentRecordId: followUpId,
        callback: { phoneNumber: '020 765 4321', consentRecordId: callbackId },
      }));
      expect(rejected.success).toBe(false);
      expect(JSON.stringify(rejected.error?.flatten())).not.toContain('765');
      expect(createCaseSchema.safeParse(submission(escalation, {
        partnerStableId: 'ke-coast-huria', consentRecordId: followUpId, callback: { phoneNumber: '0712345678' },
      })).success).toBe(false);
    });
  });
});
