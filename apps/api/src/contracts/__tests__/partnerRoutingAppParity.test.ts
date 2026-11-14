import { describe, expect, it } from 'vitest';

import {
  HURIA_PARTNER_STABLE_ID,
  normalizeKenyanMobile as appNormalizeKenyanMobile,
} from '../../../../../src/utils/partnerSharing';
import { normalizeKenyanMobile, partnerRoutingSchema, ROUTABLE_PARTNER_STABLE_IDS } from '../caseContracts';
import { createCaseSchema } from '../caseContracts';
import { buildHuriaPacket } from '../../../../../src/utils/huriaPacket';

// The survivor app validates the callback number before it asks for consent;
// it must accept and normalise exactly what POST /api/cases accepts.
const INPUTS = [
  '0712 345 678', '0712-345-678', '(0712) 345678', '254712345678', '+254 712 345 678', '+254712345678',
  '0110 123 456', '0101123456', '0111 000 000', '0799999999',
  '', ' ', '020 123 4567', '0121234567', '0100000000x', '1195', '112', '+255712345678', '+44 7700 900123',
  '071234567', '07123456789', '0712a45678', '0712 345 678 ext 9', '+2547123456789', '2540712345678',
  `${' '.repeat(15)}0712345678`,
];

describe('app and API agree on partnerRouting', () => {
  it('accepts the new app packet only with explicit HURIA routing and its new consent version', () => {
    const packet = buildHuriaPacket({ id: 'synthetic', createdAt: new Date('2026-10-22T08:00:00Z'), updatedAt: new Date('2026-10-22T08:00:00Z'),
      incidentDescription: 'Synthetic incident', includeBrief: true, location: { description: 'Likoni', coordinates: { latitude: -4.08, longitude: 39.66 } } },
    { generatedAt: '2026-10-22T08:00:00.000Z', pathway: 'referral' });
    const workflow = { schemaVersion: '1.0', workflowType: 'referral', providerId: HURIA_PARTNER_STABLE_ID, channel: 'call',
      supportBrief: { included: false, selectedFields: [] }, partnerPacket: { consentVersion: 'partner-follow-up.ke-coast-huria.v3', packet } };
    const request = { idempotencyKey: '11111111-1111-4111-8111-111111111111',
      pathwayConsent: { recordId: '11111111-1111-4111-8111-111111111111', purpose: 'pathway_submission', version: 'pathway-consent.v1' },
      workflow, partnerRouting: { partnerStableId: HURIA_PARTNER_STABLE_ID, consentRecordId: '22222222-2222-4222-8222-222222222222' } };
    expect(createCaseSchema.safeParse(request).success).toBe(true);
    expect(createCaseSchema.safeParse({ ...request, partnerRouting: undefined }).success).toBe(false);
    expect(createCaseSchema.safeParse({ ...request, workflow: { ...workflow, partnerPacket: { ...workflow.partnerPacket, consentVersion: 'partner-follow-up.ke-coast-huria.v2' } } }).success).toBe(false);
    expect(JSON.stringify(packet)).not.toContain('39.66');
  });
  it.each(INPUTS)('normalises %j the same way', input => {
    const api = input.length <= 24 ? normalizeKenyanMobile(input) : null;
    expect(appNormalizeKenyanMobile(input)).toBe(api);
  });

  it('accepts what the app sends for a HURIA callback', () => {
    expect(ROUTABLE_PARTNER_STABLE_IDS).toContain(HURIA_PARTNER_STABLE_ID);
    const phoneNumber = appNormalizeKenyanMobile('0712 345 678');
    const parsed = partnerRoutingSchema.safeParse({
      partnerStableId: HURIA_PARTNER_STABLE_ID,
      consentRecordId: '11111111-1111-4111-8111-111111111111',
      callback: { phoneNumber, consentRecordId: '22222222-2222-4222-8222-222222222222' },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.callback?.phoneNumber).toBe('+254712345678');
  });
});
