import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  RemoteConsentWithdrawalPendingError,
  withdrawConsentForFutureProcessing,
} from '../privacyConsentService';

const ledger = vi.hoisted(() => ({
  withdrawConsent: vi.fn(),
  confirmRemoteConsentWithdrawal: vi.fn(),
}));
const http = vi.hoisted(() => ({ request: vi.fn(), setAuthToken: vi.fn() }));
const auth = vi.hoisted(() => ({ getSession: vi.fn() }));

vi.mock('../../utils/consentLedger', async importOriginal => ({
  requiresRemoteWithdrawal: (await importOriginal<typeof import('../../utils/consentLedger')>()).requiresRemoteWithdrawal,
  ...ledger,
}));
vi.mock('../../lib/api/httpClient', () => http);
vi.mock('../../lib/auth/authClient', () => ({ authClient: { getSession: auth.getSession } }));

const aggregateConsent = {
  id: '11111111-1111-4111-8111-111111111111',
  recordType: 'consent',
  purpose: 'anonymous_aggregate',
  version: 'aggregate-consent.v1',
  status: 'withdrawn',
  grantedAt: '2026-07-30T10:00:00.000Z',
  withdrawnAt: '2026-07-30T11:00:00.000Z',
  remoteWithdrawalStatus: 'pending',
};

describe('consent withdrawal coordination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.getSession.mockResolvedValue({
      data: { session: { access_token: 'synthetic-token' } },
      error: null,
    });
  });

  it('keeps pathway-only withdrawal local', async () => {
    ledger.withdrawConsent.mockResolvedValue({ ...aggregateConsent, purpose: 'pathway_submission' });
    await expect(withdrawConsentForFutureProcessing(aggregateConsent.id)).resolves.toMatchObject({
      remote: 'not_applicable',
    });
    expect(auth.getSession).not.toHaveBeenCalled();
    expect(http.request).not.toHaveBeenCalled();
  });

  it('confirms authenticated remote aggregate withdrawal after stopping local processing', async () => {
    ledger.withdrawConsent.mockResolvedValue(aggregateConsent);
    http.request.mockResolvedValue({ withdrawal: { status: 'withdrawn' } });
    ledger.confirmRemoteConsentWithdrawal.mockResolvedValue({
      ...aggregateConsent,
      remoteWithdrawalStatus: 'confirmed',
    });
    await expect(withdrawConsentForFutureProcessing(aggregateConsent.id)).resolves.toMatchObject({
      remote: 'confirmed',
      consent: { remoteWithdrawalStatus: 'confirmed' },
    });
    expect(http.setAuthToken).toHaveBeenCalledWith('synthetic-token');
    expect(http.request).toHaveBeenCalledWith({
      path: `/privacy/consents/${aggregateConsent.id}/withdraw`,
      method: 'POST',
    });
  });

  it('reports a retryable remote-pending state without undoing the local withdrawal', async () => {
    ledger.withdrawConsent.mockResolvedValue(aggregateConsent);
    auth.getSession.mockResolvedValue({ data: { session: null }, error: null });
    await expect(withdrawConsentForFutureProcessing(aggregateConsent.id)).rejects.toBeInstanceOf(
      RemoteConsentWithdrawalPendingError,
    );
    expect(ledger.withdrawConsent).toHaveBeenCalledWith(aggregateConsent.id);
    expect(ledger.confirmRemoteConsentWithdrawal).not.toHaveBeenCalled();
  });

  it.each(['partner_follow_up', 'partner_callback'])('withdraws a %s consent on the server too', async purpose => {
    const partnerConsent = { ...aggregateConsent, purpose };
    ledger.withdrawConsent.mockResolvedValue(partnerConsent);
    http.request.mockResolvedValue({ withdrawal: { status: 'withdrawn' } });
    ledger.confirmRemoteConsentWithdrawal.mockResolvedValue({ ...partnerConsent, remoteWithdrawalStatus: 'confirmed' });
    await expect(withdrawConsentForFutureProcessing(partnerConsent.id)).resolves.toMatchObject({ remote: 'confirmed' });
    expect(http.request).toHaveBeenCalledWith({
      path: `/privacy/consents/${partnerConsent.id}/withdraw`,
      method: 'POST',
    });
  });
});
