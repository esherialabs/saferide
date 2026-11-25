import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The exact sequence from review: consents created, the first send fails
 * (offline), the survivor withdraws while offline, the queued retry runs.
 * The real consent ledger, withdrawal service and draft storage are used;
 * only the network and session are faked.
 */

const platform = vi.hoisted(() => ({ OS: 'android' }));
vi.mock('react-native', () => ({ Platform: platform }));
vi.mock('expo-file-system', () => ({ File: class { bytes = vi.fn(); } }));
vi.mock('expo-file-system/legacy', () => ({ getInfoAsync: vi.fn() }));

const authMock = vi.hoisted(() => ({ getSession: vi.fn() }));
const httpMock = vi.hoisted(() => ({ request: vi.fn(), setAuthToken: vi.fn() }));

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

import { getConsentLedgerStatuses, recordPathwayConsent, withdrawConsent } from '../../utils/consentLedger';
import { draftStorage, type DraftData } from '../../utils/draftStorage';
import {
  HURIA_PARTNER_STABLE_ID,
  PARTNER_CALLBACK_CONSENT_VERSION,
  PARTNER_FOLLOW_UP_CONSENT_VERSION,
  withPartnerConsentAgreement,
} from '../../utils/partnerSharing';
import { submitCase } from '../caseService';
import { withdrawConsentFromPrivacySettings } from '../partnerSharingService';
import { RemoteConsentWithdrawalPendingError } from '../privacyConsentService';

const FOLLOW_UP_ID = '11111111-1111-4111-8111-111111111111';
const CALLBACK_ID = '22222222-2222-4222-8222-222222222222';

let online = true;
const sentCases: Array<Record<string, any>> = [];

function caseRow() {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    owner_id: 'owner-1',
    draft_id: 'draft-withdraw-1',
    pathway: 'escalate',
    status: 'submitted' as const,
    summary: null,
    created_at: '2026-10-21T09:20:00.000Z',
    updated_at: '2026-10-21T09:20:00.000Z',
  };
}

async function buildQueuedDraft(): Promise<DraftData> {
  const pathwayConsent = await recordPathwayConsent({ pathway: 'escalate' });
  return draftStorage.saveDraft({
    id: 'draft-withdraw-1',
    createdAt: new Date('2026-10-21T09:00:00.000Z'),
    updatedAt: new Date('2026-10-21T09:15:00.000Z'),
    status: 'queued',
    escalationData: { redactionLevel: 'heavy', contactPreference: 'none' },
    mediaFiles: [],
    pathwayConsent: {
      recordId: pathwayConsent.id,
      purpose: 'pathway_submission',
      version: 'pathway-consent.v1',
      pathway: 'escalate',
      grantedAt: pathwayConsent.grantedAt,
    },
    partnerSharing: withPartnerConsentAgreement({
      partnerStableId: HURIA_PARTNER_STABLE_ID,
      requested: true,
      callback: { requested: true, phoneNumber: '+254712345678' },
    }, 'escalate'),
  });
}

async function retry(): Promise<Awaited<ReturnType<typeof submitCase>>> {
  const draft = await draftStorage.getDraft('draft-withdraw-1');
  return submitCase({ draft: draft!, pathway: 'escalate' });
}

beforeEach(async () => {
  await draftStorage.clearAll();
  online = true;
  sentCases.length = 0;
  authMock.getSession.mockResolvedValue({ data: { session: { access_token: 'owned-token' } }, error: null });
  httpMock.request.mockReset();
  httpMock.request.mockImplementation(async (options: { path: string; method?: string; body?: any }) => {
    if (!online) throw new TypeError('Network request failed');
    if (options.path === '/privacy/consents') {
      const callback = options.body.purpose === 'partner_callback';
      return {
        consent: {
          id: callback ? CALLBACK_ID : FOLLOW_UP_ID,
          purpose: options.body.purpose,
          consent_version: callback ? PARTNER_CALLBACK_CONSENT_VERSION : PARTNER_FOLLOW_UP_CONSENT_VERSION,
          status: 'granted',
          granted_at: '2026-10-21T09:19:00.000Z',
        },
      };
    }
    if (options.path === '/cases') {
      sentCases.push(options.body);
      // The first send with routing never arrives (the phone drops off).
      if (sentCases.length === 1) {
        online = false;
        throw new TypeError('Network request failed');
      }
      return { case: caseRow() };
    }
    if (options.path.endsWith('/withdraw')) return { withdrawal: { status: 'withdrawn' } };
    throw new Error(`unexpected request ${options.path}`);
  });
});

describe('a queued retry after an offline withdrawal', () => {
  it('sends to SafeRide only and never to HURIA when withdrawn from Privacy & data', async () => {
    await buildQueuedDraft();
    await expect(retry()).rejects.toThrow('Network request failed');
    expect(sentCases[0].partnerRouting).toMatchObject({ consentRecordId: FOLLOW_UP_ID, callback: { consentRecordId: CALLBACK_ID } });

    // Offline: the local withdrawal is recorded, the server one is pending.
    await expect(withdrawConsentFromPrivacySettings(FOLLOW_UP_ID)).rejects.toBeInstanceOf(RemoteConsentWithdrawalPendingError);
    expect((await getConsentLedgerStatuses([FOLLOW_UP_ID]))[FOLLOW_UP_ID]).toBe('withdrawal_pending');
    expect((await draftStorage.getDraft('draft-withdraw-1'))?.partnerSharing?.withdrawnAt).toEqual(expect.any(String));

    online = true;
    const result = await retry();

    expect(result.partnerSharing).toEqual({ status: 'withdrawn' });
    expect(sentCases).toHaveLength(2);
    expect(sentCases[1]).not.toHaveProperty('partnerRouting');
    expect(JSON.stringify(sentCases[1])).not.toContain('712345678');
    expect(JSON.stringify(await draftStorage.getDraft('draft-withdraw-1'))).not.toContain('712345678');
  });

  it('relies on the ledger alone: a withdrawn callback consent stops routing even if the draft was not updated', async () => {
    await buildQueuedDraft();
    await expect(retry()).rejects.toThrow('Network request failed');

    // Only the ledger knows (for example the draft update failed).
    await withdrawConsent(CALLBACK_ID);
    expect((await draftStorage.getDraft('draft-withdraw-1'))?.partnerSharing?.withdrawnAt).toBeUndefined();

    online = true;
    const result = await retry();

    expect(result.partnerSharing).toEqual({ status: 'withdrawn' });
    expect(sentCases[1]).not.toHaveProperty('partnerRouting');
    expect((await draftStorage.getDraft('draft-withdraw-1'))?.partnerSharing?.withdrawnAt).toEqual(expect.any(String));
  });

  it('still routes on retry when nothing was withdrawn', async () => {
    await buildQueuedDraft();
    await expect(retry()).rejects.toThrow('Network request failed');
    online = true;
    httpMock.request.mockImplementationOnce(async (options: { path: string; body?: any }) => {
      sentCases.push(options.body);
      return {
        case: caseRow(),
        partnerReferral: { partnerStableId: HURIA_PARTNER_STABLE_ID, reference: 'SR-7K3Q-9M2D', status: 'new', callbackShared: true },
      };
    });
    const result = await retry();
    expect(result.partnerSharing).toMatchObject({ status: 'routed', reference: 'SR-7K3Q-9M2D' });
    expect(sentCases[1].partnerRouting).toEqual(sentCases[0].partnerRouting);
  });
});
