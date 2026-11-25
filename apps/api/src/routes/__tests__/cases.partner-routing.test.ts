import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError } from '../../http/errors.js';
import * as privacyControls from '../../config/privacyControls.js';
import { PartnerRoutingRejectedError } from '../../repositories/caseRepository.js';
import { deriveCallbackSealKey, openPartnerCallback } from '../../services/partnerCallbackSeal.js';
import { consentVersionNamesPartner, registerCaseRoutes } from '../cases.js';

// Synthetic, test-only key material.
const SYNTHETIC_PARTNER_KEY = 'ab'.repeat(32);
const SYNTHETIC_CALLBACK_KEY = 'ef'.repeat(32);

const envState = vi.hoisted(() => ({
  s3Bucket: 'test-evidence',
  appEnvironment: 'staging',
  partnerPublicOrigin: 'https://partners.example.invalid' as string | undefined,
  partnerTotpKey: undefined as string | undefined,
  partnerCallbackKey: undefined as string | undefined,
  partnerTrustedProxyCidrs: undefined as string | undefined,
}));
const consentVersions = vi.hoisted(() => ({} as Record<string, string | null>));
const repository = vi.hoisted(() => ({ submitCaseTransaction: vi.fn() }));

vi.mock('../../config/env.js', () => ({ env: envState }));
vi.mock('../../plugins/db.js', () => ({ query: vi.fn(), pool: { connect: vi.fn() } }));
vi.mock('../../plugins/metrics.js', () => ({ uploadCounter: { labels: vi.fn(() => ({ inc: vi.fn() })) } }));
vi.mock('../../storage/evidenceStorage.js', () => ({
  buildEvidenceObjectKey: vi.fn(), createPresignedDownloadUrl: vi.fn(), createPresignedUploadPolicy: vi.fn(),
  deleteEvidenceObject: vi.fn(), hashStoredObject: vi.fn(),
}));
vi.mock('../../services/auditService.js', () => ({ auditEvent: vi.fn() }));
vi.mock('../../middleware/auth.js', () => ({
  requireAuth: vi.fn(async (request: FastifyRequest) => {
    if (!request.headers.authorization) throw new AppError(401, 'unauthorized', 'Authentication required');
  }),
  getAuth: vi.fn(() => ({ userId: 'owner-user' })),
}));
vi.mock('../../config/privacyControls.js', () => ({
  getEnabledConsentVersion: vi.fn((purpose: string) => consentVersions[purpose] ?? null),
  getRetentionPolicy: vi.fn(),
  isConsentPurposeEnabled: vi.fn(() => true),
  isPrivacyCapabilityEnabled: vi.fn((capability: string) => capability === 'submitted_case_ingestion'),
  loadPrivacyControls: vi.fn(() => ({ controlVersion: 'privacy-controls.2026-07-30.2' })),
}));
vi.mock('../../repositories/caseRepository.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../repositories/caseRepository.js')>()),
  ...repository,
}));

const CONSENT_ID = '11111111-1111-4111-8111-111111111111';
const FOLLOW_UP_ID = '22222222-2222-4222-8222-222222222222';
const CALLBACK_CONSENT_ID = '33333333-3333-4333-8333-333333333333';
const CASE_ID = '44444444-4444-4444-8444-444444444444';
const SYNTHETIC_NUMBER = '0712 345 678';

const escalation = {
  schemaVersion: '1.0', workflowType: 'submitted-case', pathway: 'escalation',
  submission: {
    schemaVersion: '1.0', workflowType: 'escalation',
    packet: {
      version: '1.0', generatedAt: '2026-10-21T00:00:00.000Z', pathway: 'escalate', redactionLevel: 'heavy',
      contact: { preference: 'none', label: 'No contact identity included' },
      content: {
        timeRange: 'Synthetic', location: '[redacted]', incidentDescription: '[redacted]', statement: '[redacted]',
        tags: [], patterns: [], transportIdentifiers: [],
      },
      evidenceManifest: [],
      redaction: { appliedLabels: [], textFields: [], evidenceMetadata: 'redacted', mediaProcessing: [] },
    },
  },
};

function payload(partnerRouting: unknown, workflow: unknown = escalation) {
  return {
    idempotencyKey: CONSENT_ID,
    pathwayConsent: { recordId: CONSENT_ID, purpose: 'pathway_submission', version: 'pathway-consent.v1' },
    workflow,
    partnerRouting,
  };
}

const withCallback = {
  partnerStableId: 'ke-coast-huria',
  consentRecordId: FOLLOW_UP_ID,
  callback: { phoneNumber: SYNTHETIC_NUMBER, consentRecordId: CALLBACK_CONSENT_ID },
};

describe('POST /api/cases partner routing', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    envState.partnerPublicOrigin = 'https://partners.example.invalid';
    envState.partnerTotpKey = SYNTHETIC_PARTNER_KEY;
    envState.partnerCallbackKey = SYNTHETIC_CALLBACK_KEY;
    envState.partnerTrustedProxyCidrs = '192.0.2.10/32';
    envState.appEnvironment = 'staging';
    consentVersions.partner_follow_up = 'partner-follow-up.ke-coast-huria.v1';
    consentVersions.partner_callback = 'partner-callback.ke-coast-huria.v1';
    repository.submitCaseTransaction.mockResolvedValue({
      caseRecord: { id: CASE_ID, status: 'submitted' },
      partnerReferral: { partnerStableId: 'ke-coast-huria', reference: 'SR-7K3Q-9M2D', status: 'new', callbackShared: true },
    });
    app = Fastify({ logger: false, genReqId: () => 'req-routing-1' });
    app.setErrorHandler((error, request, reply) => {
      const appError = error as AppError;
      if (appError instanceof AppError) {
        reply.status(appError.statusCode).send({ code: appError.code, message: appError.message, details: appError.details });
        return;
      }
      reply.status(500).send({ code: 'internal_error' });
    });
    await registerCaseRoutes(app);
  });

  it('requires the actual recorded v3 consent version for an expanded referral packet', async () => {
    const workflow = { schemaVersion: '1.0', workflowType: 'referral', providerId: 'ke-coast-huria', channel: 'call',
      supportBrief: { included: false, selectedFields: [] }, partnerPacket: {
        consentVersion: 'partner-follow-up.ke-coast-huria.v3', packet: escalation.submission.packet,
      } };
    const send = () => app.inject({ method: 'POST', url: '/api/cases', headers: { authorization: 'Bearer synthetic' }, payload: payload({ partnerStableId: 'ke-coast-huria', consentRecordId: FOLLOW_UP_ID }, workflow) });
    expect((await send()).statusCode).toBe(409);
    expect(repository.submitCaseTransaction).not.toHaveBeenCalled();
    consentVersions.partner_follow_up = 'partner-follow-up.ke-coast-huria.v3';
    expect((await send()).statusCode).toBe(200);
    expect(repository.submitCaseTransaction).toHaveBeenCalledWith(expect.objectContaining({ partnerRouting: expect.objectContaining({ consentVersion: 'partner-follow-up.ke-coast-huria.v3' }) }));
  });

  afterEach(async () => {
    await app.close();
  });

  function post(body: unknown) {
    return app.inject({ method: 'POST', url: '/api/cases', headers: { authorization: 'Bearer synthetic' }, payload: body as object });
  }

  it('creates the referral with the enabled consent version, binds the choice to the case and seals the number', async () => {
    const response = await post(payload(withCallback));
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      case: { id: CASE_ID, status: 'submitted' },
      partnerReferral: { partnerStableId: 'ke-coast-huria', reference: 'SR-7K3Q-9M2D', status: 'new', callbackShared: true },
    });

    const call = repository.submitCaseTransaction.mock.calls[0][0];
    expect(call.partnerRouting).toMatchObject({
      partnerStableId: 'ke-coast-huria',
      consentRecordId: FOLLOW_UP_ID,
      consentVersion: 'partner-follow-up.ke-coast-huria.v1',
      callback: { consentRecordId: CALLBACK_CONSENT_ID, consentVersion: 'partner-callback.ke-coast-huria.v1' },
    });
    expect(call.summary.partnerRouting).toEqual({
      partnerStableId: 'ke-coast-huria', consentRecordId: FOLLOW_UP_ID, callbackConsentRecordId: CALLBACK_CONSENT_ID,
    });
    const referralId = '66666666-6666-4666-8666-666666666666';
    const sealed = call.partnerRouting.callback.seal(referralId);
    const sealKey = deriveCallbackSealKey(Buffer.from(SYNTHETIC_CALLBACK_KEY, 'hex'));
    expect(openPartnerCallback(sealKey, referralId, sealed)).toBe('+254712345678');
    // Sealed under the dedicated callback key, not the partner realm key.
    expect(() => openPartnerCallback(deriveCallbackSealKey(Buffer.from(SYNTHETIC_PARTNER_KEY, 'hex')), referralId, sealed)).toThrow();

    // The number never appears in clear anywhere but the seal input.
    const { partnerRouting: _routing, ...rest } = call;
    expect(JSON.stringify(rest)).not.toMatch(/345\s?678/);
    expect(sealed).not.toMatch(/345\s?678/);
    expect(response.body).not.toMatch(/345\s?678/);
  });

  it('fixes the shareable evidence from the packet manifest at routing time; referrals share none', async () => {
    const withManifest = structuredClone(escalation);
    withManifest.submission.packet.evidenceManifest = [
      { id: 'device-file-1', type: 'photo', label: 'Photo 1', sizeBytes: 10, checksum: 'AB'.repeat(32), metadataStatus: 'synthetic', privacyRequests: [] },
      { id: 'video-2', type: 'video', label: 'Video 2', metadataStatus: 'synthetic', privacyRequests: [] },
    ] as never;
    expect((await post(payload({ partnerStableId: 'ke-coast-huria', consentRecordId: FOLLOW_UP_ID }, withManifest))).statusCode).toBe(200);
    expect(repository.submitCaseTransaction.mock.calls[0][0].partnerRouting.sharedEvidence).toEqual([
      { manifestIndex: 0, mediaType: 'photo', sha256: 'ab'.repeat(32) },
      { manifestIndex: 1, mediaType: 'video', sha256: null },
    ]);
    expect(JSON.stringify(repository.submitCaseTransaction.mock.calls[0][0].partnerRouting.sharedEvidence)).not.toContain('device-file-1');

    const referral = {
      schemaVersion: '1.0', workflowType: 'referral', providerId: 'ke-coast-huria', channel: 'call',
      supportBrief: { included: false, selectedFields: [] },
    };
    expect((await post(payload({ partnerStableId: 'ke-coast-huria', consentRecordId: FOLLOW_UP_ID }, referral))).statusCode).toBe(200);
    expect(repository.submitCaseTransaction.mock.calls[1][0].partnerRouting.sharedEvidence).toEqual([]);
  });

  it('routes to the synthetic test-partner only with APP_ENV development or test', async () => {
    const toTestPartner = { partnerStableId: 'test-partner', consentRecordId: FOLLOW_UP_ID };
    for (const appEnvironment of ['staging', 'production', 'local']) {
      envState.appEnvironment = appEnvironment;
      const refused = await post(payload(toTestPartner));
      expect(refused.statusCode, appEnvironment).toBe(503);
      expect(refused.json().details).toEqual({ reason: 'partner_unavailable' });
    }
    expect(repository.submitCaseTransaction).not.toHaveBeenCalled();
    envState.appEnvironment = 'test';
    consentVersions.partner_follow_up = 'partner-follow-up.test-partner.v1';
    expect((await post(payload(toTestPartner))).statusCode).toBe(200);
  });

  it('binds the consent to the partner: the enabled version must name it', async () => {
    expect(consentVersionNamesPartner('partner-follow-up.ke-coast-huria.v1', 'partner-follow-up', 'ke-coast-huria')).toBe(true);
    expect(consentVersionNamesPartner('partner-follow-up.ke-coast-huria.v12', 'partner-follow-up', 'ke-coast-huria')).toBe(true);
    for (const version of [
      'partner-follow-up.test-partner.v1', 'partner-follow-up.v1', 'partner-callback.ke-coast-huria.v1',
      'partner-follow-up.ke-coast-huria.v1.extra', 'partner-follow-up.ke-coast-huriaX.v1',
    ]) {
      expect(consentVersionNamesPartner(version, 'partner-follow-up', 'ke-coast-huria'), version).toBe(false);
    }
    consentVersions.partner_follow_up = 'partner-follow-up.another-partner.v1';
    const followUp = await post(payload(withCallback));
    expect(followUp.statusCode).toBe(503);
    expect(followUp.json().message).toBe('Partner follow-up consent is not enabled for this partner');
    expect(followUp.json().details).toEqual({ reason: 'partner_unavailable' });
    consentVersions.partner_follow_up = 'partner-follow-up.ke-coast-huria.v1';
    consentVersions.partner_callback = 'partner-callback.another-partner.v1';
    const callback = await post(payload(withCallback));
    expect(callback.statusCode).toBe(503);
    expect(callback.json().message).toBe('Partner callback consent is not enabled for this partner');
    expect(callback.json().details).toEqual({ reason: 'partner_callback_unavailable' });
    expect(repository.submitCaseTransaction).not.toHaveBeenCalled();
  });

  it('leaves submissions without a partner choice untouched', async () => {
    repository.submitCaseTransaction.mockResolvedValueOnce({ caseRecord: { id: CASE_ID }, partnerReferral: null });
    const response = await post(payload(undefined));
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ case: { id: CASE_ID } });
    const call = repository.submitCaseTransaction.mock.calls[0][0];
    expect(call.partnerRouting).toBeUndefined();
    expect(call.summary).not.toHaveProperty('partnerRouting');
  });

  it.each([
    ['the partner realm is not configured', () => { envState.partnerTotpKey = undefined; }, 'Partner routing is not available'],
    ['the partner origin is not configured', () => { envState.partnerPublicOrigin = undefined; }, 'Partner routing is not available'],
    ['the trusted gateway range is not configured (realm refused)', () => { envState.partnerTrustedProxyCidrs = undefined; }, 'Partner routing is not available'],
    ['partner_follow_up is disabled', () => { consentVersions.partner_follow_up = null; }, 'Partner follow-up consent is not enabled'],
  ])('fails closed with 503 partner_unavailable when %s', async (_label, arrange, message) => {
    arrange();
    const response = await post(payload(withCallback));
    expect(response.statusCode).toBe(503);
    expect(response.json().message).toBe(message);
    expect(response.json().details).toEqual({ reason: 'partner_unavailable' });
    expect(repository.submitCaseTransaction).not.toHaveBeenCalled();
  });

  it.each([
    ['partner_callback is disabled', () => { consentVersions.partner_callback = null; }, 'Partner callback consent is not enabled'],
    ['PARTNER_CALLBACK_KEY is not set', () => { envState.partnerCallbackKey = undefined; }, 'Partner callback numbers are not available'],
  ])('answers 503 partner_callback_unavailable when only the callback is off (%s), and routes without it', async (_label, arrange, message) => {
    arrange();
    const withNumber = await post(payload(withCallback));
    expect(withNumber.statusCode).toBe(503);
    expect(withNumber.json().message).toBe(message);
    expect(withNumber.json().details).toEqual({ reason: 'partner_callback_unavailable' });
    expect(repository.submitCaseTransaction).not.toHaveBeenCalled();

    // The app resends to the partner without the callback; that goes through.
    const { callback: _callback, ...withoutCallback } = withCallback;
    const resent = await post(payload(withoutCallback));
    expect(resent.statusCode).toBe(200);
    expect(repository.submitCaseTransaction.mock.calls[0][0].partnerRouting).toMatchObject({ partnerStableId: 'ke-coast-huria' });
    expect(repository.submitCaseTransaction.mock.calls[0][0].partnerRouting.callback).toBeUndefined();
  });

  it('reports the partner first: with the partner and the callback both off, the reason is partner_unavailable', async () => {
    consentVersions.partner_follow_up = null;
    consentVersions.partner_callback = null;
    envState.partnerCallbackKey = undefined;
    expect((await post(payload(withCallback))).json().details).toEqual({ reason: 'partner_unavailable' });
  });

  it('answers a partner whose intake is off (even mid-request) with 503 partner_unavailable', async () => {
    repository.submitCaseTransaction.mockRejectedValueOnce(new PartnerRoutingRejectedError('partner_not_accepting'));
    const response = await post(payload(withCallback));
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      code: 'service_unavailable', message: 'This partner is not accepting referrals right now', details: { reason: 'partner_unavailable' },
    });
  });

  it('keeps the other 503s distinct: ingestion, privacy controls and pathway consent each have their own reason', async () => {
    vi.mocked(privacyControls.isPrivacyCapabilityEnabled).mockReturnValueOnce(false);
    const ingestion = await post(payload(withCallback));
    expect(ingestion.statusCode).toBe(503);
    expect(ingestion.json().details).toEqual({ handoffId: 'HANDOFF-PRIVACY-LEGAL-REVIEW', reason: 'case_ingestion_disabled' });

    vi.mocked(privacyControls.loadPrivacyControls).mockImplementationOnce(() => { throw new Error('synthetic manifest outage'); });
    const controls = await post(payload(withCallback));
    expect(controls.statusCode).toBe(503);
    expect(controls.json().details).toEqual({ reason: 'privacy_controls_unavailable' });

    vi.mocked(privacyControls.isConsentPurposeEnabled).mockReturnValueOnce(false);
    const pathway = await post(payload(withCallback));
    expect(pathway.statusCode).toBe(503);
    expect(pathway.json().details).toEqual({ reason: 'pathway_consent_disabled' });

    // The same three apply without any partner choice, and none says partner_unavailable.
    vi.mocked(privacyControls.isPrivacyCapabilityEnabled).mockReturnValueOnce(false);
    expect((await post(payload(undefined))).json().details.reason).toBe('case_ingestion_disabled');
    expect(repository.submitCaseTransaction).not.toHaveBeenCalled();
  });

  it.each([
    ['partner_consent_missing', 'partner_follow_up consent'],
    ['callback_consent_missing', 'partner_callback consent'],
  ] as const)('rejects with 409 %s', async (reason, message) => {
    repository.submitCaseTransaction.mockRejectedValueOnce(new PartnerRoutingRejectedError(reason));
    const response = await post(payload(withCallback));
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'conflict', details: { reason } });
    expect(response.json().message).toContain(message);
  });

  it('rejects a non-Kenyan or landline callback number and a referral routed elsewhere with 400', async () => {
    const landline = await post(payload({ ...withCallback, callback: { ...withCallback.callback, phoneNumber: '041 222 3333' } }));
    expect(landline.statusCode).toBe(400);
    expect(landline.body).not.toContain('222');
    const referral = await post(payload(
      { partnerStableId: 'ke-coast-huria', consentRecordId: FOLLOW_UP_ID },
      { schemaVersion: '1.0', workflowType: 'referral', providerId: 'provider-1', channel: 'call', supportBrief: { included: false, selectedFields: [] } },
    ));
    expect(referral.statusCode).toBe(400);
    expect(repository.submitCaseTransaction).not.toHaveBeenCalled();
  });
});
