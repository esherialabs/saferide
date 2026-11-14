import { beforeEach, describe, expect, it, vi } from 'vitest';

const httpMock = vi.hoisted(() => ({ request: vi.fn() }));
const ledgerMock = vi.hoisted(() => ({ recordServerConsent: vi.fn(), getConsentLedgerStatuses: vi.fn() }));
const withdrawalMock = vi.hoisted(() => ({
  withdrawConsentForFutureProcessing: vi.fn(),
  withdrawServerConsent: vi.fn(),
  listServerConsents: vi.fn(),
}));

vi.mock('../../lib/api/httpClient', () => ({ request: httpMock.request }));
vi.mock('../../utils/consentLedger', () => ledgerMock);
vi.mock('../privacyConsentService', () => withdrawalMock);

import { draftStorage, type DraftData } from '../../utils/draftStorage';
import {
  HURIA_PARTNER_STABLE_ID,
  PARTNER_CALLBACK_CONSENT_VERSION,
  PARTNER_FOLLOW_UP_CONSENT_VERSION,
  type PartnerSharingDraft,
} from '../../utils/partnerSharing';
import {
  ensurePartnerConsentRecords,
  hasWithdrawnPartnerConsent,
  PartnerSharingConsentUnknownError,
  stopAllPartnerSharing,
  stopPartnerSharing,
  withdrawConsentFromPrivacySettings,
} from '../partnerSharingService';

const FOLLOW_UP_ID = '11111111-1111-4111-8111-111111111111';
const CALLBACK_ID = '22222222-2222-4222-8222-222222222222';

function routedSharing(): PartnerSharingDraft {
  return {
    partnerStableId: HURIA_PARTNER_STABLE_ID,
    requested: true,
    followUpConsent: { version: PARTNER_FOLLOW_UP_CONSENT_VERSION, agreedAt: '2026-10-21T09:00:00.000Z', recordId: FOLLOW_UP_ID },
    callback: {
      requested: true,
      consent: { version: PARTNER_CALLBACK_CONSENT_VERSION, agreedAt: '2026-10-21T09:00:00.000Z', recordId: CALLBACK_ID },
    },
    outcome: { status: 'routed', reference: 'SR-7K3Q-9M2D', partnerStatus: 'new', callbackShared: true, at: '2026-10-21T09:05:00.000Z' },
  };
}

async function storeDraft(partnerSharing?: PartnerSharingDraft): Promise<DraftData> {
  return draftStorage.saveDraft({
    id: 'draft-huria-2',
    createdAt: new Date('2026-10-21T08:00:00.000Z'),
    updatedAt: new Date('2026-10-21T08:00:00.000Z'),
    status: 'submitted',
    caseId: '33333333-3333-4333-8333-333333333333',
    partnerSharing,
  });
}

beforeEach(async () => {
  await draftStorage.clearAll();
  httpMock.request.mockReset();
  withdrawalMock.withdrawConsentForFutureProcessing.mockReset();
  withdrawalMock.withdrawConsentForFutureProcessing.mockResolvedValue({ remote: 'confirmed' });
  withdrawalMock.withdrawServerConsent.mockReset();
  withdrawalMock.withdrawServerConsent.mockResolvedValue(undefined);
  withdrawalMock.listServerConsents.mockReset();
  ledgerMock.getConsentLedgerStatuses.mockReset();
  ledgerMock.getConsentLedgerStatuses.mockImplementation(async (ids: string[]) => Object.fromEntries(ids.map(id => [id, 'granted'])));
});

describe('creating partner consents', () => {
  it('rejects a consent record that does not match what was asked for', async () => {
    await storeDraft();
    httpMock.request.mockResolvedValue({
      consent: { id: FOLLOW_UP_ID, purpose: 'partner_follow_up', consent_version: 'partner-follow-up.test-partner.v1', status: 'granted' },
    });
    await expect(ensurePartnerConsentRecords({
      draftId: 'draft-huria-2',
      sharing: { ...routedSharing(), followUpConsent: { version: PARTNER_FOLLOW_UP_CONSENT_VERSION, agreedAt: '2026-10-21T09:00:00.000Z' }, callback: undefined },
      pathway: 'escalate',
    })).rejects.toThrow(/invalid partner consent record/);
    expect(ledgerMock.recordServerConsent).not.toHaveBeenCalled();
  });
});

describe('stop sharing with HURIA', () => {
  it('withdraws the follow-up consent first, then the callback, and records it', async () => {
    const draft = await storeDraft(routedSharing());
    const stopped = await stopPartnerSharing(draft);

    expect(withdrawalMock.withdrawConsentForFutureProcessing.mock.calls.map(([id]) => id)).toEqual([FOLLOW_UP_ID, CALLBACK_ID]);
    expect(stopped.withdrawnAt).toEqual(expect.any(String));
    expect((await draftStorage.getDraft('draft-huria-2'))?.partnerSharing?.withdrawnAt).toBe(stopped.withdrawnAt);
  });

  it('withdraws on the server directly when this phone lost the ledger entry', async () => {
    withdrawalMock.withdrawConsentForFutureProcessing.mockRejectedValue(new Error('Consent record not found.'));
    const draft = await storeDraft(routedSharing());
    await stopPartnerSharing(draft);
    expect(withdrawalMock.withdrawServerConsent.mock.calls.map(([id]) => id)).toEqual([FOLLOW_UP_ID, CALLBACK_ID]);
  });

  it('leaves the draft unchanged when the server has not confirmed', async () => {
    withdrawalMock.withdrawConsentForFutureProcessing.mockRejectedValue(new Error('offline'));
    const draft = await storeDraft(routedSharing());
    await expect(stopPartnerSharing(draft)).rejects.toThrow('offline');
    expect((await draftStorage.getDraft('draft-huria-2'))?.partnerSharing?.withdrawnAt).toBeUndefined();
  });

  it('needs the consent record ids held on this phone', async () => {
    const draft = await storeDraft({ partnerStableId: HURIA_PARTNER_STABLE_ID, requested: true });
    await expect(stopPartnerSharing(draft)).rejects.toBeInstanceOf(PartnerSharingConsentUnknownError);
    expect(withdrawalMock.withdrawConsentForFutureProcessing).not.toHaveBeenCalled();
  });
});

describe('withdrawal state on this phone', () => {
  it('treats a pending or confirmed local withdrawal of either consent as withdrawn', async () => {
    expect(await hasWithdrawnPartnerConsent(routedSharing())).toBe(false);
    ledgerMock.getConsentLedgerStatuses.mockResolvedValue({ [FOLLOW_UP_ID]: 'granted', [CALLBACK_ID]: 'withdrawal_pending' });
    expect(await hasWithdrawnPartnerConsent(routedSharing())).toBe(true);
    ledgerMock.getConsentLedgerStatuses.mockResolvedValue({ [FOLLOW_UP_ID]: 'withdrawn', [CALLBACK_ID]: 'granted' });
    expect(await hasWithdrawnPartnerConsent(routedSharing())).toBe(true);
    expect(await hasWithdrawnPartnerConsent({ ...routedSharing(), withdrawnAt: '2026-10-21T10:00:00.000Z' })).toBe(true);
  });

  it('marks the report withdrawn when its consent is withdrawn in Privacy & data, even before the server confirms', async () => {
    await storeDraft(routedSharing());
    withdrawalMock.withdrawConsentForFutureProcessing.mockRejectedValue(new Error('remote pending'));
    ledgerMock.getConsentLedgerStatuses.mockResolvedValue({ [FOLLOW_UP_ID]: 'withdrawal_pending' });

    await expect(withdrawConsentFromPrivacySettings(FOLLOW_UP_ID)).rejects.toThrow('remote pending');
    const saved = await draftStorage.getDraft('draft-huria-2');
    expect(saved?.partnerSharing?.withdrawnAt).toEqual(expect.any(String));
  });

  it('marks only the callback when the callback consent is withdrawn', async () => {
    await storeDraft(routedSharing());
    ledgerMock.getConsentLedgerStatuses.mockResolvedValue({ [CALLBACK_ID]: 'withdrawn' });
    await withdrawConsentFromPrivacySettings(CALLBACK_ID);
    const saved = await draftStorage.getDraft('draft-huria-2');
    expect(saved?.partnerSharing?.withdrawnAt).toBeUndefined();
    expect(saved?.partnerSharing?.callback?.withdrawnAt).toEqual(expect.any(String));
  });

  it('leaves reports alone when the local withdrawal itself failed', async () => {
    await storeDraft(routedSharing());
    withdrawalMock.withdrawConsentForFutureProcessing.mockRejectedValue(new Error('Consent record not found.'));
    ledgerMock.getConsentLedgerStatuses.mockResolvedValue({ [FOLLOW_UP_ID]: 'missing' });
    await expect(withdrawConsentFromPrivacySettings(FOLLOW_UP_ID)).rejects.toThrow();
    expect((await draftStorage.getDraft('draft-huria-2'))?.partnerSharing?.withdrawnAt).toBeUndefined();
  });
});

describe('stop sharing all reports (after a reinstall)', () => {
  it('withdraws every granted HURIA consent on the account, follow-up first', async () => {
    await storeDraft(routedSharing());
    withdrawalMock.listServerConsents.mockResolvedValue([
      { id: CALLBACK_ID, purpose: 'partner_callback', status: 'granted' },
      { id: FOLLOW_UP_ID, purpose: 'partner_follow_up', status: 'granted' },
      { id: '44444444-4444-4444-8444-444444444444', purpose: 'partner_follow_up', status: 'withdrawn' },
      { id: '55555555-5555-4555-8555-555555555555', purpose: 'pathway_submission', status: 'granted' },
    ]);
    await expect(stopAllPartnerSharing()).resolves.toBe(2);
    expect(withdrawalMock.withdrawConsentForFutureProcessing.mock.calls.map(([id]) => id)).toEqual([FOLLOW_UP_ID, CALLBACK_ID]);
    expect((await draftStorage.getDraft('draft-huria-2'))?.partnerSharing?.withdrawnAt).toEqual(expect.any(String));
  });

  it('reports when there is nothing to withdraw', async () => {
    withdrawalMock.listServerConsents.mockResolvedValue([]);
    await expect(stopAllPartnerSharing()).resolves.toBe(0);
    expect(withdrawalMock.withdrawConsentForFutureProcessing).not.toHaveBeenCalled();
  });
});
