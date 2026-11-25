import { beforeEach, describe, expect, it, vi } from 'vitest';

const platform = vi.hoisted(() => ({ OS: 'android' }));
vi.mock('react-native', () => ({ Platform: platform }));
vi.mock('expo-file-system', () => ({ File: class { bytes = vi.fn(); } }));
vi.mock('expo-file-system/legacy', () => ({ getInfoAsync: vi.fn() }));

const authMock = vi.hoisted(() => ({ getSession: vi.fn() }));
const httpMock = vi.hoisted(() => ({ request: vi.fn(), setAuthToken: vi.fn() }));
const ledgerMock = vi.hoisted(() => ({
  assertActivePathwayConsent: vi.fn(),
  recordServerConsent: vi.fn(),
  getConsentLedgerStatuses: vi.fn(),
}));
const withdrawalMock = vi.hoisted(() => ({
  withdrawConsentForFutureProcessing: vi.fn(),
  withdrawServerConsent: vi.fn(),
}));

vi.mock('../../lib/auth/authClient', () => ({ authClient: authMock }));
vi.mock('../../lib/api/httpClient', () => ({
  ApiError: class ApiError extends Error {
    status?: number;
    details?: unknown;

    constructor(message: string, init: { status?: number; details?: unknown } = {}) {
      super(message);
      this.status = init.status;
      this.details = init.details;
    }
  },
  request: httpMock.request,
  setAuthToken: httpMock.setAuthToken,
}));
vi.mock('../../utils/consentLedger', () => ledgerMock);
vi.mock('../privacyConsentService', () => withdrawalMock);

import { ApiError } from '../../lib/api/httpClient';
import { draftStorage, type DraftData } from '../../utils/draftStorage';
import {
  HURIA_PARTNER_STABLE_ID,
  PARTNER_CALLBACK_CONSENT_VERSION,
  PARTNER_FOLLOW_UP_CONSENT_VERSION,
  withPartnerConsentAgreement,
  type PartnerSharingDraft,
} from '../../utils/partnerSharing';
import { buildCaseSummary, PartnerRoutingConflictError, submitCase } from '../caseService';

const PATHWAY_CONSENT_ID = '00000000-0000-4000-8000-000000000001';
const FOLLOW_UP_ID = '11111111-1111-4111-8111-111111111111';
const CALLBACK_ID = '22222222-2222-4222-8222-222222222222';
const CASE_ID = '33333333-3333-4333-8333-333333333333';

function caseRow() {
  return {
    id: CASE_ID,
    owner_id: 'owner-1',
    draft_id: 'draft-huria-1',
    pathway: 'referral',
    status: 'submitted' as const,
    summary: null,
    created_at: '2026-10-21T09:20:00.000Z',
    updated_at: '2026-10-21T09:20:00.000Z',
  };
}

function consentRow(id: string, purpose: string, version: string) {
  return { consent: { id, purpose, consent_version: version, status: 'granted', granted_at: '2026-10-21T09:19:00.000Z' } };
}

function agreed(callback = false, pathway: 'referral' | 'escalate' = 'referral'): PartnerSharingDraft {
  return withPartnerConsentAgreement({
    partnerStableId: HURIA_PARTNER_STABLE_ID,
    requested: true,
    ...(callback ? { callback: { requested: true, phoneNumber: '+254712345678' } } : {}),
  }, pathway, new Date('2026-10-21T09:18:00.000Z'));
}

const partnerUnavailable = () => new ApiError('Partner routing is not available', { status: 503, details: { reason: 'partner_unavailable' } });

function buildDraft(overrides: Partial<DraftData> = {}): DraftData {
  return {
    id: 'draft-huria-1',
    createdAt: new Date('2026-10-21T09:00:00.000Z'),
    updatedAt: new Date('2026-10-21T09:15:00.000Z'),
    selectedTags: ['harassment'],
    selectedProvider: HURIA_PARTNER_STABLE_ID,
    selectedChannel: 'call',
    includeBrief: false,
    mediaFiles: [],
    pathwayConsent: {
      recordId: PATHWAY_CONSENT_ID,
      purpose: 'pathway_submission',
      version: 'pathway-consent.v1',
      pathway: 'referral',
      grantedAt: '2026-10-21T09:19:00.000Z',
    },
    ...overrides,
  };
}

async function submit(draft: DraftData, pathway: 'referral' | 'escalate' = 'referral') {
  await draftStorage.saveDraft(draft);
  return submitCase({ draft, pathway });
}

function casePosts() {
  return httpMock.request.mock.calls.map(([options]) => options).filter(options => options.path === '/cases');
}

it('rebuilds the identical escalation packet after a lost response and queue update', () => {
  const draft = buildDraft({ pathwayConsent: {
    recordId: PATHWAY_CONSENT_ID, purpose: 'pathway_submission', version: 'pathway-consent.v1',
    pathway: 'escalate', grantedAt: '2026-10-21T09:18:00.000Z',
  } });
  const first = buildCaseSummary(draft, 'escalate');
  const retry = buildCaseSummary({ ...draft, updatedAt: new Date('2026-10-22T12:00:00Z') }, 'escalate');
  expect(retry).toEqual(first);
  expect(first.workflowType === 'submitted-case' && first.submission.packet.generatedAt).toBe(draft.pathwayConsent!.grantedAt);
});

it('adds a common referral packet only after the new explicit consent, preserving old short briefs', () => {
  const draft = buildDraft({ includeBrief: true, incidentDescription: 'Synthetic report', partnerSharing: agreed() });
  const workflow = buildCaseSummary(draft, 'referral');
  expect(workflow.workflowType === 'referral' && workflow.partnerPacket).toMatchObject({
    consentVersion: PARTNER_FOLLOW_UP_CONSENT_VERSION, packet: { content: { incidentDescription: 'Synthetic report' } },
  });
  const legacy = buildCaseSummary({ ...draft, partnerSharing: { ...agreed(), followUpConsent: { version: 'partner-follow-up.ke-coast-huria.v2', agreedAt: '2026-10-21T09:18:00Z' } } }, 'referral');
  expect(legacy).not.toHaveProperty('partnerPacket');
});

it('accepts a reviewed narrative-only HURIA packet without inventing old brief categories', () => {
  const workflow = buildCaseSummary(buildDraft({ includeBrief: true, selectedTags: [], incidentDescription: 'Synthetic narrative only', partnerSharing: agreed() }), 'referral');
  expect(workflow.workflowType === 'referral' && workflow.supportBrief).toEqual({ included: false, selectedFields: [] });
  expect(workflow.workflowType === 'referral' && workflow.partnerPacket?.packet.content.incidentDescription).toBe('Synthetic narrative only');
});

it('routes a separately consented HURIA referral without inventing an unverified phone channel', async () => {
  routeRequests({ cases: () => routedReferral(false) });
  const result = await submit(buildDraft({ selectedChannel: undefined, partnerSharing: agreed() }));
  expect(result.partnerSharing.status).toBe('routed');
  expect(casePosts()[0].body.workflow).toMatchObject({ channel: 'partner_dashboard', providerId: HURIA_PARTNER_STABLE_ID });
  expect(casePosts()[0].body).not.toHaveProperty('draftId');
});

it('keeps a digital-only HURIA referral on the phone if the recipient becomes unavailable', async () => {
  routeRequests({ cases: () => { throw partnerUnavailable(); } });
  await expect(submit(buildDraft({ selectedChannel: undefined, partnerSharing: agreed() }))).rejects.toThrow();
  expect(casePosts()).toHaveLength(1);
  expect(casePosts()[0].body).toHaveProperty('partnerRouting');
});

function consentPosts() {
  return httpMock.request.mock.calls.map(([options]) => options).filter(options => options.path === '/privacy/consents');
}

function routeRequests(handlers: {
  consents?: (body: { purpose: string; consentVersion: string }) => unknown;
  cases?: (body: Record<string, unknown>, attempt: number) => unknown;
}) {
  let caseAttempt = 0;
  httpMock.request.mockImplementation(async (options: { path: string; body: any }) => {
    if (options.path === '/privacy/consents') {
      if (handlers.consents) return handlers.consents(options.body);
      return options.body.purpose === 'partner_follow_up'
        ? consentRow(FOLLOW_UP_ID, 'partner_follow_up', PARTNER_FOLLOW_UP_CONSENT_VERSION)
        : consentRow(CALLBACK_ID, 'partner_callback', PARTNER_CALLBACK_CONSENT_VERSION);
    }
    if (options.path === '/cases') {
      caseAttempt += 1;
      if (handlers.cases) return handlers.cases(options.body, caseAttempt);
      return { case: caseRow() };
    }
    throw new Error(`unexpected request ${options.path}`);
  });
}

const routedReferral = (callbackShared: boolean) => ({
  case: caseRow(),
  partnerReferral: { partnerStableId: HURIA_PARTNER_STABLE_ID, reference: 'SR-7K3Q-9M2D', status: 'new', callbackShared },
});

beforeEach(async () => {
  await draftStorage.clearAll();
  httpMock.request.mockReset();
  authMock.getSession.mockResolvedValue({ data: { session: { access_token: 'owned-token' } }, error: null });
  ledgerMock.assertActivePathwayConsent.mockResolvedValue({ id: PATHWAY_CONSENT_ID, status: 'granted' });
  ledgerMock.recordServerConsent.mockResolvedValue(undefined);
  ledgerMock.getConsentLedgerStatuses.mockImplementation(async (ids: string[]) => Object.fromEntries(ids.map(id => [id, 'granted'])));
  withdrawalMock.withdrawConsentForFutureProcessing.mockResolvedValue({ remote: 'confirmed' });
  withdrawalMock.withdrawServerConsent.mockResolvedValue(undefined);
});

describe('submitting with partnerRouting', () => {
  it('sends nothing about partners when sharing was not chosen', async () => {
    routeRequests({});
    const result = await submit(buildDraft());
    expect(result.partnerSharing).toEqual({ status: 'not_requested' });
    expect(consentPosts()).toHaveLength(0);
    expect(casePosts()[0].body).not.toHaveProperty('partnerRouting');
  });

  it('ignores a HURIA choice on a referral to another provider', async () => {
    routeRequests({});
    const result = await submit(buildDraft({ selectedProvider: '1195', partnerSharing: agreed() }));
    expect(result.partnerSharing).toEqual({ status: 'not_requested' });
    expect(consentPosts()).toHaveLength(0);
    expect(casePosts()[0].body).not.toHaveProperty('partnerRouting');
  });

  it('creates both consents, then routes with the callback, and keeps no number on the phone', async () => {
    routeRequests({ cases: () => routedReferral(true) });
    const result = await submit(buildDraft({ partnerSharing: agreed(true) }));

    expect(consentPosts().map(options => options.body)).toEqual([
      { purpose: 'partner_follow_up', consentVersion: PARTNER_FOLLOW_UP_CONSENT_VERSION },
      { purpose: 'partner_callback', consentVersion: PARTNER_CALLBACK_CONSENT_VERSION },
    ]);
    expect(ledgerMock.recordServerConsent).toHaveBeenCalledWith(expect.objectContaining({ id: FOLLOW_UP_ID, purpose: 'partner_follow_up' }));
    expect(ledgerMock.recordServerConsent).toHaveBeenCalledWith(expect.objectContaining({ id: CALLBACK_ID, purpose: 'partner_callback' }));
    expect(casePosts()).toHaveLength(1);
    expect(casePosts()[0].body.partnerRouting).toEqual({
      partnerStableId: HURIA_PARTNER_STABLE_ID,
      consentRecordId: FOLLOW_UP_ID,
      callback: { phoneNumber: '+254712345678', consentRecordId: CALLBACK_ID },
    });
    expect(result.partnerSharing).toEqual({ status: 'routed', reference: 'SR-7K3Q-9M2D', partnerStatus: 'new', callbackShared: true });

    const saved = await draftStorage.getDraft('draft-huria-1');
    expect(saved?.partnerSharing?.outcome).toMatchObject({ status: 'routed', reference: 'SR-7K3Q-9M2D', callbackShared: true });
    expect(saved?.partnerSharing?.followUpConsent?.recordId).toBe(FOLLOW_UP_ID);
    expect(saved?.partnerSharing?.callback?.consent?.recordId).toBe(CALLBACK_ID);
    expect(saved?.partnerSharing?.callback?.phoneNumber).toBeUndefined();
    expect(JSON.stringify(saved)).not.toContain('712345678');
  });

  it('reuses consent records saved by an earlier attempt', async () => {
    routeRequests({ cases: () => routedReferral(false) });
    const sharing = agreed();
    sharing.followUpConsent!.recordId = FOLLOW_UP_ID;
    await submit(buildDraft({ partnerSharing: sharing }));
    expect(consentPosts()).toHaveLength(0);
    expect(casePosts()[0].body.partnerRouting).toEqual({ partnerStableId: HURIA_PARTNER_STABLE_ID, consentRecordId: FOLLOW_UP_ID });
  });

  it('also routes escalations', async () => {
    routeRequests({ cases: () => routedReferral(false) });
    const result = await submit(buildDraft({
      selectedProvider: undefined,
      selectedChannel: undefined,
      escalationData: { redactionLevel: 'heavy', contactPreference: 'none' },
      pathwayConsent: { ...buildDraft().pathwayConsent!, pathway: 'escalate' },
      partnerSharing: agreed(false, 'escalate'),
    }), 'escalate');
    expect(casePosts()[0].body.workflow.workflowType).toBe('submitted-case');
    expect(casePosts()[0].body.partnerRouting.consentRecordId).toBe(FOLLOW_UP_ID);
    expect(result.partnerSharing.status).toBe('routed');
  });
});

describe('503: partner sharing unavailable', () => {
  it('still sends to SafeRide, withdraws the unused consents and records the outcome', async () => {
    routeRequests({
      cases: (_body, attempt) => {
        if (attempt === 1) throw partnerUnavailable();
        return { case: caseRow() };
      },
    });
    const result = await submit(buildDraft({ partnerSharing: agreed(true) }));

    expect(result.partnerSharing).toEqual({ status: 'unavailable' });
    expect(casePosts()).toHaveLength(2);
    expect(casePosts()[1].body).not.toHaveProperty('partnerRouting');
    expect(casePosts()[1].body.idempotencyKey).toBe(PATHWAY_CONSENT_ID);
    expect(withdrawalMock.withdrawConsentForFutureProcessing.mock.calls.map(([id]) => id)).toEqual([FOLLOW_UP_ID, CALLBACK_ID]);
    const saved = await draftStorage.getDraft('draft-huria-1');
    expect(saved?.partnerSharing).toEqual({
      partnerStableId: HURIA_PARTNER_STABLE_ID,
      requested: true,
      outcome: { status: 'unavailable', at: expect.any(String) },
    });
  });

  it('treats a partner_unavailable consent purpose the same way', async () => {
    routeRequests({ consents: () => { throw partnerUnavailable(); } });
    const result = await submit(buildDraft({ partnerSharing: agreed() }));
    expect(result.partnerSharing).toEqual({ status: 'unavailable' });
    expect(casePosts()).toHaveLength(1);
    expect(casePosts()[0].body).not.toHaveProperty('partnerRouting');
  });

  it.each(['case_ingestion_disabled', 'privacy_controls_unavailable', 'pathway_consent_disabled', undefined])(
    'treats any other 503 (%s) as a retryable failure that keeps the HURIA choice',
    async reason => {
      const other = new ApiError('unavailable', { status: 503, ...(reason ? { details: { reason } } : {}) });
      routeRequests({ cases: () => { throw other; } });
      await expect(submit(buildDraft({ partnerSharing: agreed(true) }))).rejects.toBe(other);
      expect(casePosts()).toHaveLength(1);
      const saved = await draftStorage.getDraft('draft-huria-1');
      expect(saved?.partnerSharing?.outcome).toBeUndefined();
      expect(saved?.partnerSharing?.requested).toBe(true);
      expect(saved?.partnerSharing?.followUpConsent?.recordId).toBe(FOLLOW_UP_ID);
      expect(saved?.partnerSharing?.callback?.phoneNumber).toBe('+254712345678');
      expect(withdrawalMock.withdrawConsentForFutureProcessing).not.toHaveBeenCalled();
    },
  );

  it('keeps a consent-creation failure without a partner reason retryable too', async () => {
    const outage = new ApiError('This consent purpose is not available', { status: 503 });
    routeRequests({ consents: () => { throw outage; } });
    await expect(submit(buildDraft({ partnerSharing: agreed() }))).rejects.toBe(outage);
    expect(casePosts()).toHaveLength(0);
    expect((await draftStorage.getDraft('draft-huria-1'))?.partnerSharing?.requested).toBe(true);
  });

  it('keeps the choice when SafeRide refuses the report too, so a later retry can still route', async () => {
    const ingestionOff = new ApiError('Submitted-case ingestion is disabled', { status: 503, details: { reason: 'case_ingestion_disabled' } });
    routeRequests({
      cases: (_body, attempt) => {
        if (attempt === 1) throw partnerUnavailable();
        throw ingestionOff;
      },
    });
    const sharing = agreed();
    await expect(submit(buildDraft({ partnerSharing: sharing }))).rejects.toBe(ingestionOff);
    const saved = await draftStorage.getDraft('draft-huria-1');
    expect(saved?.partnerSharing?.outcome).toBeUndefined();
    expect(saved?.partnerSharing?.followUpConsent?.recordId).toBe(FOLLOW_UP_ID);
    expect(withdrawalMock.withdrawConsentForFutureProcessing).not.toHaveBeenCalled();
  });

  it('tells the survivor wherever they are when the report went to SafeRide only', async () => {
    const { notificationCenter } = await import('../../utils/notificationCenter');
    const notify = vi.spyOn(notificationCenter, 'notify');
    routeRequests({ cases: (_body, attempt) => { if (attempt === 1) throw partnerUnavailable(); return { case: caseRow() }; } });
    await submit(buildDraft({ partnerSharing: agreed() }));
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: 'Sent to SafeRide only', variant: 'warning' }));
    notify.mockRestore();
  });
});

describe('503 partner_callback_unavailable', () => {
  it('resends to HURIA without the number, withdraws the callback consent and says so', async () => {
    const { notificationCenter } = await import('../../utils/notificationCenter');
    const notify = vi.spyOn(notificationCenter, 'notify');
    routeRequests({
      cases: (body, attempt) => {
        if (attempt === 1) {
          expect((body.partnerRouting as { callback?: unknown }).callback).toBeDefined();
          throw new ApiError('Partner callback numbers are not available', { status: 503, details: { reason: 'partner_callback_unavailable' } });
        }
        return routedReferral(false);
      },
    });
    const result = await submit(buildDraft({ partnerSharing: agreed(true) }));

    expect(casePosts()).toHaveLength(2);
    expect(casePosts()[1].body.partnerRouting).toEqual({ partnerStableId: HURIA_PARTNER_STABLE_ID, consentRecordId: FOLLOW_UP_ID });
    expect(withdrawalMock.withdrawConsentForFutureProcessing.mock.calls.map(([id]) => id)).toEqual([CALLBACK_ID]);
    expect(result.partnerSharing).toEqual({
      status: 'routed', reference: 'SR-7K3Q-9M2D', partnerStatus: 'new', callbackShared: false, callbackNotShared: true,
    });
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: 'Callback number not shared' }));
    const saved = await draftStorage.getDraft('draft-huria-1');
    expect(saved?.partnerSharing?.callback).toBeUndefined();
    expect(saved?.partnerSharing?.outcome).toMatchObject({ status: 'routed', callbackNotShared: true });
    expect(JSON.stringify(saved)).not.toContain('712345678');
    notify.mockRestore();
  });
});

describe('withdrawal before a retry', () => {
  it.each(['withdrawal_pending', 'withdrawn'])('never routes once a partner consent is %s on this phone', async status => {
    routeRequests({ cases: () => ({ case: caseRow() }) });
    const sharing = agreed(true);
    sharing.followUpConsent!.recordId = FOLLOW_UP_ID;
    sharing.callback!.consent!.recordId = CALLBACK_ID;
    ledgerMock.getConsentLedgerStatuses.mockImplementation(async (ids: string[]) => Object.fromEntries(
      ids.map(id => [id, id === CALLBACK_ID ? status : 'granted']),
    ));

    const result = await submit(buildDraft({ partnerSharing: sharing }));

    expect(result.partnerSharing).toEqual({ status: 'withdrawn' });
    expect(consentPosts()).toHaveLength(0);
    expect(casePosts()).toHaveLength(1);
    expect(casePosts()[0].body).not.toHaveProperty('partnerRouting');
    const saved = await draftStorage.getDraft('draft-huria-1');
    expect(saved?.partnerSharing?.withdrawnAt).toEqual(expect.any(String));
    expect(JSON.stringify(saved)).not.toContain('712345678');
  });


  it('sends a later retry to SafeRide only once the outcome is recorded', async () => {
    routeRequests({});
    await submit(buildDraft({
      partnerSharing: { partnerStableId: HURIA_PARTNER_STABLE_ID, requested: true, outcome: { status: 'unavailable', at: '2026-10-21T09:30:00.000Z' } },
    }));
    expect(consentPosts()).toHaveLength(0);
    expect(casePosts()[0].body).not.toHaveProperty('partnerRouting');
  });
});

describe('409: partner or consent changed', () => {
  it.each([
    ['partner_not_accepting', /not accepting new reports/],
    ['partner_consent_missing', /permission to share with HURIA changed/],
    ['callback_consent_missing', /permission for HURIA to call you changed/],
  ])('sends nothing on %s and asks the survivor to confirm again', async (reason, message) => {
    routeRequests({ cases: () => { throw new ApiError('conflict', { status: 409, details: { reason } }); } });
    const error = await submit(buildDraft({ partnerSharing: agreed(true) })).catch(caught => caught);

    expect(error).toBeInstanceOf(PartnerRoutingConflictError);
    expect(error.reason).toBe(reason);
    expect(error.message).toMatch(message);
    expect(casePosts()).toHaveLength(1);
    expect(withdrawalMock.withdrawConsentForFutureProcessing).toHaveBeenCalledTimes(2);

    const saved = await draftStorage.getDraft('draft-huria-1');
    expect(saved?.caseId).toBeUndefined();
    expect(saved?.caseSubmissionError).toMatch(message);
    expect(saved?.partnerSharing).toEqual({
      partnerStableId: HURIA_PARTNER_STABLE_ID,
      requested: true,
      callback: { requested: true, phoneNumber: '+254712345678' },
      outcome: { status: 'needs_confirmation', reason, at: expect.any(String) },
    });
  });

  it('does not create consents or send while the survivor has not agreed', async () => {
    routeRequests({});
    await expect(submit(buildDraft({ partnerSharing: { partnerStableId: HURIA_PARTNER_STABLE_ID, requested: true } })))
      .rejects.toMatchObject({ name: 'PartnerRoutingConflictError', reason: 'confirmation_required' });
    expect(httpMock.request).not.toHaveBeenCalled();
  });

  it('passes other conflicts through unchanged', async () => {
    const idempotencyConflict = new ApiError('Case submission idempotency conflicts', { status: 409 });
    routeRequests({ cases: () => { throw idempotencyConflict; } });
    await expect(submit(buildDraft({ partnerSharing: agreed() }))).rejects.toBe(idempotencyConflict);
  });
});
